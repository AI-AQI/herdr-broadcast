/**
 * Herdr's saved SSH machines: list, add, remove, enable/disable, rename, reconnect.
 *
 * `machine add` and `machine reconnect` are interactive (host keys, passwords, picking a remote
 * session, approving a server install), so the dashboard steps aside and runs them on the real
 * terminal. Everything else is a plain CLI call.
 */
import { machineAddArgv, machineReconnectArgv, machineRemove, machineRename, machineSetEnabled, machineStatus } from "../../herdr.ts";
import type { Machine } from "../../engine.ts";
import { LOCAL } from "../../herdr.ts";
import { ListCursor, isChar, type App, type Screen } from "../app.ts";
import type { Key } from "../keys.ts";
import { runInteractive, type Line } from "../term.ts";
import { pad, style, truncate } from "../text.ts";
import { FormScreen } from "./form.ts";

export class MachinesScreen implements Screen {
  private cursor = new ListCursor();
  private status = new Map<string, string>();
  private checking = false;

  constructor(private readonly app: App) {}

  title(): string {
    return "SSH 机器";
  }

  hints(): string {
    return "↑↓ 选择  a 添加  x 删除  e 启用/停用  n 重命名  c 重新连接（SSH 认证）  s 检查状态  Esc 返回";
  }

  enter(): void {
    void this.app.engine.refreshMachines().then(() => this.check());
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.app.redraw();
    try {
      const parsed = await machineStatus();
      this.status = summarizeStatus(parsed, this.app.engine.machines);
    } catch (error) {
      this.app.fail(error);
    } finally {
      this.checking = false;
      this.app.redraw();
    }
  }

  render(cols: number, rows: number): Line[] {
    const machines = this.app.engine.machines;
    const out: Line[] = [
      style.dim(" 这里管理的是 Herdr 自己保存的 SSH 机器（herdr machine）。广播会通过这些连接在远程机器上启动 agent、发送 prompt。"),
      style.dim(" 删除只会让本机忘记这个连接；远程的 Herdr 服务、会话和 agent 会继续运行。"),
      "",
    ];
    if (this.app.engine.machinesError) out.push(style.red(` 读取机器列表失败：${this.app.engine.machinesError}`));
    const labelW = 18;
    const targetW = 26;
    const stateW = 8;
    out.push(style.dim(`   ${pad("名称", labelW)} ${pad("SSH 目标", targetW)} ${pad("启用", stateW)} 状态${this.checking ? "（检查中…）" : ""}`));
    const [start, end] = this.cursor.window(machines.length, rows - out.length - 2);
    for (let i = start; i < end; i += 1) {
      const m = machines[i]!;
      const selected = i === this.cursor.index;
      const enabled = m.id === LOCAL ? style.dim("—") : m.enabled ? style.green("启用") : style.gray("停用");
      const status = m.id === LOCAL ? style.green("本机") : this.status.get(m.id) ?? style.dim("未检查");
      const line = `${selected ? style.cyan("›") : " "} ${pad(truncate(m.label, labelW), labelW)} ${pad(truncate(m.id === LOCAL ? "" : m.target ?? "", targetW), targetW)} ${pad(enabled, stateW)} ${truncate(status, Math.max(10, cols - labelW - targetW - stateW - 8))}`;
      out.push(selected ? style.bold(line) : line);
    }
    if (machines.length === 1) {
      out.push("");
      out.push(`   还没有保存的 SSH 机器。按 ${style.bold("a")} 添加（目标可以是 ~/.ssh/config 里的 Host，或 user@host、ssh://user@host:2222）。`);
    }
    return out;
  }

  async key(key: Key): Promise<void> {
    const machines = this.app.engine.machines;
    if (this.cursor.key(key, machines.length)) return;
    const m: Machine | undefined = machines[this.cursor.index];
    if (key.name === "escape" || key.name === "left" || isChar(key, "q", "b")) {
      this.app.pop();
      return;
    }
    if (isChar(key, "a")) {
      this.app.push(new FormScreen(this.app, "添加 SSH 机器", [
        { label: "SSH 目标", placeholder: "workbox 或 user@host 或 ssh://user@host:2222", help: "先确认 `ssh <目标>` 本身能连上" },
        { label: "显示名称", placeholder: "可选，默认用主机名", help: "可选" },
        { label: "远程会话", placeholder: "可选，默认自动发现 / default", help: "远程有多个 Herdr 会话时，不填会在下一步让你选" },
      ], async ([target, label, remoteSession]) => {
        if (!target) throw new Error("请填写 SSH 目标");
        await this.runOnTerminal(machineAddArgv(target, { label: label || undefined, remoteSession: remoteSession || undefined }), `添加 ${target}`);
      }, ["Herdr 会通过 SSH 连接、检查远程 Herdr，必要时询问是否安装或替换（默认不替换）。", "这一步需要在终端里交互，仪表盘会暂时让出屏幕。"]));
      return;
    }
    if (isChar(key, "s", "r")) {
      await this.app.engine.refreshMachines();
      await this.check();
      return;
    }
    if (!m || m.id === LOCAL) {
      if (isChar(key, "x", "e", "n", "c")) this.app.say("本机不能被修改", true);
      return;
    }
    if (isChar(key, "x")) {
      this.app.confirm(`删除机器「${m.label}」？远程的会话和 agent 不受影响`, async () => {
        await machineRemove(m.id);
        await this.app.engine.refreshMachines();
        this.app.say(`已删除 ${m.label}`);
      });
    } else if (isChar(key, "e")) {
      await machineSetEnabled(m.id, !m.enabled);
      await this.app.engine.refreshMachines();
      this.app.say(`${m.label} 已${m.enabled ? "停用" : "启用"}`);
    } else if (isChar(key, "n")) {
      this.app.push(new FormScreen(this.app, `重命名 ${m.label}`, [{ label: "新名称", value: m.label }], async ([label]) => {
        if (!label) throw new Error("名称不能为空");
        await machineRename(m.id, label);
        await this.app.engine.refreshMachines();
        this.app.say(`已重命名为 ${label}`);
      }));
    } else if (isChar(key, "c")) {
      await this.runOnTerminal(machineReconnectArgv(m.id), `重新连接 ${m.label}`);
    }
  }

  /** Runs an interactive herdr command on the real terminal, waits for Enter, then comes back. */
  private async runOnTerminal(argv: string[], what: string): Promise<void> {
    const code = await this.app.term.suspend(async () => {
      process.stdout.write(`\x1b[1m▶ ${what}\x1b[0m\n$ ${argv.map(quote).join(" ")}\n\n`);
      const exit = await runInteractive(argv);
      process.stdout.write(`\n${exit === 0 ? "\x1b[32m完成\x1b[0m" : `\x1b[31m退出码 ${exit}\x1b[0m`}。按 Enter 返回仪表盘…`);
      await waitForEnter();
      return exit;
    });
    await this.app.engine.refreshMachines();
    void this.check();
    this.app.say(code === 0 ? `${what}：完成` : `${what}：退出码 ${code}`, code !== 0);
  }
}

function quote(arg: string): string {
  return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      if (!chunk.toString().includes("\n") && !chunk.toString().includes("\r")) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

/**
 * `herdr machine status --json` → a short state per machine id. The output shape is read
 * defensively: an array of entries, or an object holding one, matched by id or label.
 */
export function summarizeStatus(parsed: unknown, machines: Machine[]): Map<string, string> {
  const result = new Map<string, string>();
  const root = (parsed && typeof parsed === "object" && "result" in parsed ? (parsed as { result: unknown }).result : parsed) as unknown;
  const entries: Record<string, unknown>[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.id === "string" || typeof record.profile_id === "string" || typeof record.label === "string") entries.push(record);
      else for (const nested of Object.values(record)) if (Array.isArray(nested)) collect(nested);
    }
  };
  collect(root);
  for (const entry of entries) {
    const id = (entry.profile_id ?? entry.id) as string | undefined;
    const machine = machines.find((m) => m.id === id) ?? machines.find((m) => m.label === entry.label);
    if (!machine) continue;
    result.set(machine.id, describe(entry));
  }
  return result;
}

function describe(entry: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => entry[k]).find((v) => typeof v === "string" && v.length > 0) as string | undefined;
  const state = pick("state", "status", "health", "connection");
  const error = pick("error", "message", "detail");
  const reachable = entry.reachable;
  const ok = reachable === true || /^(ok|online|reachable|connected|ready)$/i.test(state ?? "");
  const head = state ?? (reachable === true ? "reachable" : reachable === false ? "unreachable" : "unknown");
  const text = error && !ok ? `${head}: ${error}` : head;
  return ok ? style.green(text) : /auth/i.test(text) ? style.yellow(text) : style.red(text);
}
