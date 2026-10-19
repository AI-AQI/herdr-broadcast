/**
 * Composing a broadcast: the prompt, then the targets (existing agents and/or new ones on any
 * machine), then a last look before it goes out.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewExecution } from "../../db.ts";
import { READY, type Machine } from "../../engine.ts";
import { LOCAL } from "../../herdr.ts";
import type { AgentInfo } from "../../herdr-types.ts";
import { ListCursor, isChar, type App, type Screen } from "../app.ts";
import { AGENT_KINDS, Draft, defaultCwd, validCwd, type NewSpec } from "../draft.ts";
import { TextArea, TextInput } from "../input.ts";
import type { Key } from "../keys.ts";
import { runInteractive, type Line } from "../term.ts";
import { pad, style, truncate, wrap } from "../text.ts";
import { kickWorker } from "../../worker.ts";

const isNext = (key: Key) => key.name === "tab" || (key.name === "d" && key.ctrl);

// ---- 1. prompt ------------------------------------------------------------------------------

export class PromptScreen implements Screen {
  private area: TextArea;

  constructor(private readonly app: App, private readonly draft: Draft = new Draft()) {
    this.area = new TextArea(draft.prompt);
  }

  title(): string {
    return "新建广播 1/3 · 写 prompt";
  }

  hints(): string {
    return "Enter 换行  Tab 下一步：选择 agent  Ctrl+O 用 $EDITOR 编辑  Esc 放弃";
  }

  render(cols: number, rows: number): Line[] {
    const out: Line[] = [style.dim(" 这段 prompt 会原样发给每个选中的 agent。"), ""];
    const height = Math.max(3, Math.min(16, rows - out.length - 2));
    const box = this.area.render(cols - 4, height, true);
    for (const row of box) out.push(`  ${style.dim("│")} ${row}`);
    out.push("");
    out.push(style.dim(`  ${this.area.value.length} 个字符`));
    return out;
  }

  async key(key: Key): Promise<void> {
    if (key.name === "escape") {
      if (this.area.value.trim() === "") this.app.pop();
      else this.app.confirm("放弃这条广播？", () => this.app.pop());
      return;
    }
    if (isNext(key)) {
      if (this.area.value.trim() === "") throw new Error("prompt 不能为空");
      this.draft.prompt = this.area.value.replace(/\s+$/, "");
      this.app.push(new TargetsScreen(this.app, this.draft));
      return;
    }
    if (key.name === "o" && key.ctrl) {
      this.area.value = await editInEditor(this.app, this.area.value);
      return;
    }
    this.area.key(key);
  }
}

async function editInEditor(app: App, text: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-broadcast-"));
  const file = join(dir, "prompt.md");
  writeFileSync(file, text);
  try {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    // $EDITOR may carry arguments ("code -w"): let sh split it, the file stays one argument
    const code = await app.term.suspend(() => runInteractive(["sh", "-c", `${editor} "$1"`, "sh", file]));
    if (code !== 0) app.say(`编辑器退出码 ${code}，内容按文件现状读取`, true);
    return readFileSync(file, "utf8").replace(/\s+$/, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2. targets -----------------------------------------------------------------------------

type Row =
  | { type: "machine"; machine: Machine }
  | { type: "agent"; machine: Machine; agent: AgentInfo }
  | { type: "note"; text: string }
  | { type: "specs" }
  | { type: "spec"; index: number }
  | { type: "add" };

export class TargetsScreen implements Screen {
  private cursor = new ListCursor();
  private rows: Row[] = [];
  private unwatch = new Map<string, () => void>();

  constructor(private readonly app: App, private readonly draft: Draft) {}

  title(): string {
    return "新建广播 2/3 · 选择 agent";
  }

  hints(): string {
    return "↑↓ 选择  空格 勾选已有 agent（在机器行上：全选）  a 添加新 agent  x 删除新 agent  r 刷新  Tab 下一步  Esc 上一步";
  }

  enter(): void {
    this.watchMachines();
  }

  leave(): void {
    for (const stop of this.unwatch.values()) stop();
    this.unwatch.clear();
  }

  private watchMachines(): void {
    for (const m of this.app.engine.machines) {
      if (!m.enabled || this.unwatch.has(m.id)) continue;
      this.unwatch.set(m.id, this.app.engine.watch(m.id));
    }
  }

  private buildRows(): Row[] {
    const rows: Row[] = [];
    for (const machine of this.app.engine.machines) {
      rows.push({ type: "machine", machine });
      if (!machine.enabled) continue;
      const view = this.app.engine.view(machine.id);
      if (!view || (view.loading && view.at === 0)) {
        rows.push({ type: "note", text: "读取中…" });
        continue;
      }
      if (view.error) rows.push({ type: "note", text: style.red(`读取失败：${view.error}`) });
      if (view.agents.length === 0 && !view.error) rows.push({ type: "note", text: "没有正在运行的 agent" });
      for (const agent of view.agents) rows.push({ type: "agent", machine, agent });
    }
    rows.push({ type: "specs" });
    this.draft.specs.forEach((_, index) => rows.push({ type: "spec", index }));
    rows.push({ type: "add" });
    return rows;
  }

  render(cols: number, rows: number): Line[] {
    this.watchMachines();
    this.rows = this.buildRows();
    const out: Line[] = [` 已选 ${style.bold(String(this.draft.picks.size))} 个已有 agent，${style.bold(String(this.draft.specs.reduce((n, s) => n + s.count, 0)))} 个新 agent`, ""];
    const [start, end] = this.cursor.window(this.rows.length, rows - out.length);
    for (let i = start; i < end; i += 1) {
      const row = this.rows[i]!;
      const selected = i === this.cursor.index;
      const mark = selected ? style.cyan("›") : " ";
      out.push(`${mark} ${this.renderRow(row, cols - 3)}`);
    }
    return out;
  }

  private renderRow(row: Row, cols: number): string {
    switch (row.type) {
      case "machine": {
        const m = row.machine;
        const where = m.id === LOCAL ? "" : style.dim(` ${m.target ?? ""}`);
        return style.bold(`${m.id === LOCAL ? "🖥 " : "🌐 "}${m.label}`) + where + (m.enabled ? "" : style.gray("  （已停用，在 SSH 机器页启用）"));
      }
      case "agent": {
        const a = row.agent;
        const checked = this.draft.picks.has(Draft.pickKey(row.machine.id, a.pane_id));
        const box = checked ? style.green("[x]") : "[ ]";
        const status = READY.includes(a.agent_status) ? style.green(a.agent_status) : a.agent_status === "working" ? style.cyan(a.agent_status) : a.agent_status === "blocked" ? style.magenta(a.agent_status) : style.gray(a.agent_status);
        const kind = a.agent ?? a.display_agent ?? "agent";
        const folder = (a.foreground_cwd ?? a.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
        const label = this.app.engine.view(row.machine.id)?.workspaces.find((w) => w.workspace_id === a.workspace_id)?.label ?? a.workspace_id;
        const text = `   ${box} ${pad(kind, 9)} ${pad(a.name ?? a.pane_id, 14)} ${pad(status, 8)} ${pad(truncate(label, 18), 18)} ${style.dim(truncate(`${folder}  ${a.terminal_title_stripped ?? ""}`, Math.max(0, cols - 60)))}`;
        return text;
      }
      case "note":
        return `   ${style.dim(row.text)}`;
      case "specs":
        return style.bold("✚ 新启动的 agent");
      case "spec": {
        const s = this.draft.specs[row.index]!;
        const where = `${s.machineLabel} · ${s.cwd}`;
        return `   ${style.green("+")} ${s.kind} × ${s.count}  ${style.dim(where)}`;
      }
      case "add":
        return `   ${style.cyan("＋ 添加新 agent…")}`;
    }
  }

  key(key: Key): void {
    if (this.cursor.key(key, this.rows.length)) return;
    const row = this.rows[this.cursor.index];
    if (key.name === "escape" || key.name === "left") {
      this.app.pop();
      return;
    }
    if (isNext(key)) {
      if (this.draft.targetCount === 0) throw new Error("至少选择一个 agent，或添加一个新 agent");
      this.app.push(new ConfirmScreen(this.app, this.draft));
      return;
    }
    if (isChar(key, "r")) {
      void this.app.engine.refreshMachines();
      for (const m of this.app.engine.machines) if (m.enabled) void this.app.engine.refresh(m.id);
      return;
    }
    const preferred = row && (row.type === "machine" || row.type === "agent") && row.machine.enabled ? row.machine.id : LOCAL;
    if (isChar(key, "a") || (key.name === "enter" && row?.type === "add")) {
      this.app.push(new NewAgentScreen(this.app, this.draft, preferred));
      return;
    }
    if (!row) return;
    if (row.type === "spec" && (isChar(key, "x") || key.name === "delete" || key.name === "backspace")) {
      this.draft.specs.splice(row.index, 1);
      return;
    }
    if (row.type === "spec" && key.name === "enter") {
      this.app.push(new NewAgentScreen(this.app, this.draft, row.index));
      return;
    }
    if (isChar(key, " ") || key.name === "enter") {
      const labels = (machineId: string, workspaceId: string) => this.app.engine.view(machineId)?.workspaces.find((w) => w.workspace_id === workspaceId)?.label ?? null;
      if (row.type === "agent") this.draft.toggle(row.machine.id, row.machine.label, row.agent, labels(row.machine.id, row.agent.workspace_id));
      else if (row.type === "machine") {
        const agents = this.app.engine.view(row.machine.id)?.agents ?? [];
        const all = agents.length > 0 && agents.every((a) => this.draft.picks.has(Draft.pickKey(row.machine.id, a.pane_id)));
        for (const a of agents) {
          const has = this.draft.picks.has(Draft.pickKey(row.machine.id, a.pane_id));
          if (all ? has : !has) this.draft.toggle(row.machine.id, row.machine.label, a, labels(row.machine.id, a.workspace_id));
        }
      }
    }
  }
}

// ---- 2b. a new agent ------------------------------------------------------------------------

type Field = "machine" | "kind" | "cwd" | "count";

export class NewAgentScreen implements Screen {
  private field: Field = "kind";
  private machineIndex: number;
  private kindIndex = 0;
  private cwd: TextInput;
  private count = 1;
  private editing: number | null;

  /** `target` is the machine to preselect, or the index of a spec to edit. */
  constructor(private readonly app: App, private readonly draft: Draft, target: string | number) {
    const machines = this.machines();
    if (typeof target === "number") {
      const spec = draft.specs[target]!;
      this.editing = target;
      this.machineIndex = Math.max(0, machines.findIndex((m) => m.id === spec.machineId));
      this.kindIndex = Math.max(0, AGENT_KINDS.indexOf(spec.kind));
      this.cwd = new TextInput(spec.cwd);
      this.count = spec.count;
    } else {
      this.editing = null;
      this.machineIndex = Math.max(0, machines.findIndex((m) => m.id === target));
      this.cwd = new TextInput(this.cwdFor(machines[this.machineIndex]!.id));
    }
  }

  private machines(): Machine[] {
    return this.app.engine.machines.filter((m) => m.enabled);
  }

  private cwdFor(machineId: string): string {
    return defaultCwd(machineId, this.app.engine.view(LOCAL)?.agents ?? []);
  }

  private fields(): Field[] {
    return ["machine", "kind", "cwd", "count"];
  }

  title(): string {
    return this.editing === null ? "添加新 agent" : "修改新 agent";
  }

  hints(): string {
    return "↑↓ 切换字段  ←→ 选择  Enter 确定  Esc 取消";
  }

  render(cols: number): Line[] {
    const machines = this.machines();
    const machine = machines[this.machineIndex];
    const out: Line[] = [style.dim(" 一条广播的新 agent 在每台机器上共用一个 Herdr 工作区，各占一个 tab，就绪后收到 prompt。"), ""];
    const line = (field: Field, label: string, value: string) => {
      const focused = this.field === field;
      out.push(`${focused ? style.cyan("›") : " "} ${pad(label, 14)} ${focused ? style.bold(value) : value}`);
    };
    const choice = (value: string) => `${style.dim("‹")} ${value} ${style.dim("›")}`;
    line("machine", "机器", choice(machine ? `${machine.label}${machine.id === LOCAL ? "" : style.dim(`  ${machine.target ?? ""}`)}` : "—"));
    line("kind", "Agent 类型", choice(AGENT_KINDS[this.kindIndex]!));
    line("cwd", "目录", this.cwd.render(cols - 20, this.field === "cwd"));
    line("count", "数量", choice(String(this.count)));
    const problem = machine ? validCwd(machine.id, this.cwd.value) : "没有可用的机器";
    out.push("");
    if (problem) out.push(style.yellow(`  ${problem}`));
    else if (machine && machine.id !== LOCAL) out.push(style.dim("  远程机器上的目录按那台机器解析；Herdr 会通过已保存的 SSH 连接执行。"));
    return out;
  }

  key(key: Key): void {
    const fields = this.fields();
    const at = fields.indexOf(this.field);
    if (key.name === "escape") {
      this.app.pop();
      return;
    }
    if (key.name === "up" || key.name === "backtab") {
      this.field = fields[Math.max(0, at - 1)]!;
      return;
    }
    if (key.name === "down" || key.name === "tab") {
      this.field = fields[Math.min(fields.length - 1, at + 1)]!;
      return;
    }
    if (key.name === "enter") {
      this.submit();
      return;
    }
    const step = key.name === "left" ? -1 : key.name === "right" ? 1 : 0;
    const machines = this.machines();
    switch (this.field) {
      case "machine":
        if (step && machines.length > 0) {
          const before = machines[this.machineIndex]?.id;
          this.machineIndex = (this.machineIndex + step + machines.length) % machines.length;
          const after = machines[this.machineIndex]!.id;
          // a folder typed for one machine means nothing on another
          if (before !== after && (this.cwd.value === this.cwdFor(before ?? LOCAL) || after !== LOCAL)) this.cwd.value = this.cwdFor(after);
        }
        break;
      case "kind":
        if (step) this.kindIndex = (this.kindIndex + step + AGENT_KINDS.length) % AGENT_KINDS.length;
        break;
      case "count":
        if (step) this.count = Math.max(1, Math.min(20, this.count + step));
        else if (key.name === "char" && /^[0-9]$/.test(key.text ?? "")) this.count = Math.max(1, Math.min(20, Number(key.text)));
        break;
      case "cwd":
        this.cwd.key(key);
        break;
    }
  }

  private submit(): void {
    const machine = this.machines()[this.machineIndex];
    if (!machine) throw new Error("没有可用的机器");
    const problem = validCwd(machine.id, this.cwd.value);
    if (problem) throw new Error(problem);
    const spec: NewSpec = {
      machineId: machine.id,
      machineLabel: machine.label,
      kind: AGENT_KINDS[this.kindIndex]!,
      cwd: this.cwd.value.trim(),
      count: this.count,
    };
    if (this.editing === null) this.draft.specs.push(spec);
    else this.draft.specs[this.editing] = spec;
    this.app.pop();
  }
}

// ---- 3. confirm -----------------------------------------------------------------------------

export class ConfirmScreen implements Screen {
  private titleInput: TextInput;

  constructor(private readonly app: App, private readonly draft: Draft) {
    this.titleInput = new TextInput(draft.title || draft.defaultTitle());
  }

  title(): string {
    return "新建广播 3/3 · 确认";
  }

  hints(): string {
    return "Enter 发送  Esc 上一步（标题可直接编辑）";
  }

  render(cols: number, rows: number): Line[] {
    const out: Line[] = [];
    out.push(` 标题  ${this.titleInput.render(cols - 10, true)}`);
    out.push("");
    out.push(style.bold(` 发送给 ${this.draft.targetCount} 个 agent：`));
    for (const p of this.draft.picks.values()) {
      out.push(`   • ${pad(p.kind, 9)} ${pad(p.name ?? p.paneId, 14)} ${style.dim(`${p.machineLabel} · ${p.workspaceLabel ?? p.workspaceId}`)}`);
    }
    for (const s of this.draft.specs) {
      out.push(`   + ${pad(s.kind, 9)} ${pad(`× ${s.count}（新）`, 14)} ${style.dim(`${s.machineLabel} · ${s.cwd}`)}`);
    }
    out.push("");
    out.push(style.bold(" Prompt："));
    const promptRows = wrap(this.draft.prompt, cols - 6);
    const room = Math.max(2, rows - out.length - 3);
    for (const row of promptRows.slice(0, room)) out.push(style.dim(`   │ ${row}`));
    if (promptRows.length > room) out.push(style.dim(`   │ …共 ${promptRows.length} 行`));
    out.push("");
    out.push(style.dim(" 忙碌中的已有 agent 会排队，空闲后自动发送；同一个 agent 上的多个广播按先后顺序执行。"));
    if (this.draft.picks.size > 0) out.push(style.yellow(" 已有 agent 的输入框里如果有没发出去的草稿，prompt 会接在草稿后面一起发出，发送前请确认输入框是空的。"));
    return out;
  }

  key(key: Key): void {
    if (key.name === "escape") {
      this.draft.title = this.titleInput.value;
      this.app.pop();
      return;
    }
    if (key.name === "enter") {
      this.send();
      return;
    }
    this.titleInput.key(key);
  }

  private send(): void {
    const title = this.titleInput.value.trim() || this.draft.defaultTitle();
    const executions: NewExecution[] = [];
    for (const p of this.draft.picks.values()) {
      executions.push({
        machine_id: p.machineId, machine_label: p.machineLabel, target_kind: "existing", agent_kind: p.kind, agent_name: p.name, cwd: p.cwd,
        workspace_id: p.workspaceId, workspace_label: p.workspaceLabel, tab_id: p.tabId, pane_id: p.paneId, terminal_id: p.terminalId,
      });
    }
    let slot = 0;
    for (const s of this.draft.specs) {
      for (let n = 0; n < s.count; n += 1) {
        slot += 1;
        executions.push({
          machine_id: s.machineId, machine_label: s.machineLabel, target_kind: "new", agent_kind: s.kind, cwd: s.cwd, slot,
        });
      }
    }
    const id = this.app.store.createBroadcast({ title, prompt: this.draft.prompt, executions });
    this.app.popToRoot();
    this.app.showBroadcast?.(id);
    this.app.say(`广播 #${id} 已创建，正在发送到 ${executions.length} 个 agent`);
    // the worker starts new agents and follows remote machines after this picker closes
    void kickWorker(this.app.store).then((worker) => {
      if (worker === "failed") this.app.say(`广播 #${id} 已创建，但后台 worker 没能启动：新 agent 和远程机器只在本窗口开着时推进`, true);
    });
  }
}
