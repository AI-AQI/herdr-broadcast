/**
 * The quick picker, a popup summoned by a key:
 *
 *   广播任务   one row per broadcast; Enter lists the agents running it, and Enter on one of
 *              those ("#3 claude · ✓ 已完成 · 修登录 bug") brings it to the front and closes
 *   快速广播   type a prompt once and send it to the idle agents of this workspace, or of this
 *              machine; or compose a broadcast in full
 */
import type { NewExecution } from "../../db.ts";
import { READY } from "../../engine.ts";
import { LOCAL } from "../../herdr.ts";
import type { AgentInfo } from "../../herdr-types.ts";
import { kickWorker } from "../../worker.ts";
import type { App, Screen } from "../app.ts";
import { TextArea } from "../input.ts";
import type { Key } from "../keys.ts";
import type { Line } from "../term.ts";
import { statePlain, summaryPlain } from "../states.ts";
import { duration, relativeTime, style, truncate, wrap } from "../text.ts";
import { PromptScreen } from "./compose.ts";
import { OutputScreen } from "./output.ts";
import { PickerScreen, type PickerItem } from "./picker.ts";

/** The workspace the picker was summoned over. */
export function currentWorkspace(): string | null {
  if (process.env.HERDR_WORKSPACE_ID) return process.env.HERDR_WORKSPACE_ID;
  try {
    const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as Record<string, unknown>;
    if (typeof context.workspace_id === "string") return context.workspace_id;
    const workspace = context.workspace as Record<string, unknown> | undefined;
    return typeof workspace?.workspace_id === "string" ? workspace.workspace_id : null;
  } catch {
    return null;
  }
}

const agentText = (a: AgentInfo) => `${a.agent ?? a.display_agent ?? "agent"} ${a.name ?? a.pane_id}`;

export class QuickRoot extends PickerScreen {
  private unwatch: (() => void) | null = null;

  constructor(app: App) {
    super(app);
    // a broadcast composed in full ends here, opened
    app.showBroadcast = (id) => app.push(new QuickTask(app, id));
  }

  title(): string {
    return "⚡ 广播";
  }

  enter(): void {
    this.unwatch = this.app.engine.watch(LOCAL);
  }

  leave(): void {
    this.unwatch?.();
  }

  protected back(): void {
    this.app.quit();
  }

  hints(): string {
    return "↑↓ 移动 · Enter 打开/执行 · 输入过滤 · ^X 取消排队中的 · ^D 删除记录 · Esc 关闭";
  }

  protected items(): PickerItem[] {
    const items: PickerItem[] = [];
    const broadcasts = this.app.store.listBroadcasts();
    for (const b of broadcasts) {
      items.push({
        section: "广播任务",
        label: `#${b.id} ${b.title}`,
        detail: `${summaryPlain(b)} · ${relativeTime(b.created_at)}`,
        run: () => this.app.push(new QuickTask(this.app, b.id)),
        actions: {
          x: () => {
            const queued = this.app.store.executions(b.id).filter((e) => e.state === "queued");
            if (queued.length === 0) throw new Error(`#${b.id} 没有排队中的执行`);
            this.app.confirm(`取消 #${b.id} 里 ${queued.length} 个排队中的执行？`, () => {
              for (const e of queued) this.app.engine.cancel(e);
            });
          },
          d: () => this.app.confirm(`删除广播 #${b.id} 的记录？排队中的执行会一并取消；agent 和 pane 不会被关闭`, () => {
            this.app.store.deleteBroadcast(b.id);
            this.app.say(`已删除 #${b.id}`);
          }),
        },
      });
    }
    if (broadcasts.length === 0) items.push({ section: "广播任务", label: "还没有广播任务", detail: "用下面的快速广播发一条", disabled: true, run: () => {} });

    const view = this.app.engine.view(LOCAL);
    const idle = (view?.agents ?? []).filter((a) => READY.includes(a.agent_status));
    const workspace = currentWorkspace();
    const here = idle.filter((a) => a.workspace_id === workspace);
    const loading = !view || view.at === 0;
    const describe = (agents: AgentInfo[]) => loading ? "读取中…" : agents.length === 0 ? "没有空闲的 agent" : `${agents.length} 个：${agents.map(agentText).join("，")}`;
    const quick = (label: string, agents: AgentInfo[], scope: string): PickerItem => ({
      section: "快速广播",
      label,
      detail: describe(agents),
      disabled: loading || agents.length === 0,
      note: !loading && agents.length === 0 ? `${scope}没有空闲的 agent（忙的 agent 请用「新建广播…」选择，它会排队）` : undefined,
      run: () => this.app.push(new QuickSend(this.app, `${scope}的 ${agents.length} 个空闲 agent`, agents)),
    });
    if (workspace) {
      const label = view?.workspaces.find((w) => w.workspace_id === workspace)?.label ?? workspace;
      items.push(quick(`发给本 workspace 的空闲 agent`, here, `「${label}」`));
    }
    items.push(quick("发给本机所有空闲 agent", idle, "本机"));
    items.push({ section: "快速广播", label: "新建广播…", detail: "自己挑选 agent（包括忙的、远程的），或新启动 agent", run: () => this.app.push(new PromptScreen(this.app)) });
    return items;
  }
}

/** The agents running one broadcast. */
export class QuickTask extends PickerScreen {
  constructor(app: App, private readonly broadcastId: number) {
    super(app);
  }

  title(): string {
    const b = this.app.store.getBroadcast(this.broadcastId);
    return b ? `⚡ 广播 › #${b.id} ${b.title}` : "⚡ 广播";
  }

  hints(): string {
    return "↑↓ 移动 · Enter 跳到该 agent · 输入过滤 · ^O 完整输出 · ^R 重试 · ^X 取消/停止追踪 · Esc 返回";
  }

  protected items(): PickerItem[] {
    const b = this.app.store.getBroadcast(this.broadcastId);
    if (!b) return [{ section: "这条广播已被删除", label: "—", disabled: true, run: () => {} }];
    const section = `#${b.id} ${b.title}`;
    return this.app.store.executions(b.id).map((e): PickerItem => {
      const machine = e.machine_id === LOCAL ? "" : ` · ${this.app.engine.machineLabel(e.machine_id)}`;
      const elapsed = e.sent_at ? duration((e.finished_at ?? Date.now()) - e.sent_at) : "";
      return {
        section,
        label: `#${b.id} ${e.agent_kind ?? "agent"} · ${statePlain(e.state)} · ${b.title}`,
        detail: [e.pane_id ? `${e.pane_id}${machine}` : null, e.agent_name, elapsed].filter(Boolean).join(" · "),
        note: e.error ?? e.note ?? undefined,
        disabled: !e.pane_id,
        run: async () => {
          const said = await this.app.engine.focus(e);
          // a local agent is in front now: the popup's job is done
          if (e.machine_id === LOCAL) this.app.quit();
          else this.app.say(said);
        },
        actions: {
          o: () => {
            if (!e.pane_id) throw new Error("这个执行还没有 pane");
            this.app.push(new OutputScreen(this.app, e));
          },
          r: () => {
            // only where the prompt most likely never got through: a turn that finished is not retried
            if (e.state !== "failed" && e.state !== "lost") throw new Error("只有失败或已丢失的执行可以重试");
            this.app.confirm(`重新发送到 ${e.agent_kind ?? "agent"} ${e.pane_id ?? ""}？`, async () => {
              await this.app.engine.retry(e);
              const worker = await kickWorker(this.app.store);
              this.app.say(worker === "failed" ? "已重新排队，但后台 worker 没能启动" : "已重新排队");
            });
          },
          x: () => {
            const what = e.state === "queued" ? "取消这个执行（prompt 不会发送）" : "停止追踪这个执行（agent 不会被中断）";
            this.app.confirm(`${what}？`, () => {
              if (!this.app.engine.cancel(e)) this.app.say("这个执行现在不能取消", true);
            });
          },
        },
      };
    });
  }
}

/** One prompt for a fixed set of agents: Enter sends, Alt+Enter is a new line. */
export class QuickSend implements Screen {
  private area = new TextArea("");
  private sending = false;

  constructor(private readonly app: App, private readonly scope: string, private readonly agents: AgentInfo[]) {}

  title(): string {
    return "⚡ 快速广播";
  }

  hints(): string {
    return "Enter 发送 · Alt+Enter 换行 · Esc 返回";
  }

  render(cols: number, rows: number): Line[] {
    const out: Line[] = [` 发给${style.bold(this.scope)}：`];
    for (const row of wrap(this.agents.map(agentText).join("，"), cols - 4).slice(0, 3)) out.push(style.dim(`   ${row}`));
    out.push("");
    const height = Math.max(3, Math.min(12, rows - out.length - 3));
    for (const row of this.area.render(cols - 6, height, !this.sending)) out.push(`  ${style.magenta("│")} ${row}`);
    out.push(style.dim("  这些 agent 的输入框里如果有没发出去的草稿，prompt 会接在后面一起发出，请先确认输入框是空的。"));
    if (this.sending) out.push(style.cyan("  发送中…"));
    return out;
  }

  async key(key: Key): Promise<void> {
    if (this.sending) return;
    if (key.name === "escape") {
      this.app.pop();
      return;
    }
    if (key.name === "enter") {
      await this.send();
      return;
    }
    this.area.key(key);
  }

  private async send(): Promise<void> {
    const prompt = this.area.value.replace(/\s+$/, "");
    if (prompt.trim() === "") throw new Error("prompt 不能为空");
    this.sending = true;
    this.app.redraw();
    try {
      const workspaces = this.app.engine.view(LOCAL)?.workspaces ?? [];
      const executions: NewExecution[] = this.agents.map((a) => ({
        machine_id: LOCAL, machine_label: "本机", target_kind: "existing", agent_kind: a.agent ?? a.display_agent ?? "agent", agent_name: a.name ?? null,
        cwd: a.foreground_cwd ?? a.cwd ?? null, pane_id: a.pane_id, terminal_id: a.terminal_id, workspace_id: a.workspace_id, tab_id: a.tab_id,
        workspace_label: workspaces.find((w) => w.workspace_id === a.workspace_id)?.label ?? null,
      }));
      const title = truncate(prompt.split("\n").find((l) => l.trim())!.trim(), 60);
      const id = this.app.store.createBroadcast({ title, prompt, executions });
      // send now, before the popup may close: the hook and the worker carry it from here
      await this.app.engine.refresh(LOCAL);
      await this.app.engine.settle();
      void kickWorker(this.app.store);
      this.app.pop();
      this.app.push(new QuickTask(this.app, id));
      this.app.say(`广播 #${id} 已发给 ${executions.length} 个 agent`);
    } finally {
      this.sending = false;
    }
  }
}
