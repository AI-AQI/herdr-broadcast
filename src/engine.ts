/**
 * Drives executions from the dashboard process: starts new agents, sends prompts when their agent
 * is free, and follows each agent's lifecycle until its turn ends.
 *
 * There is no daemon. Everything an execution needs to resume is in SQLite and Herdr itself, so
 * any open dashboard picks up where another left off; while none is open, agents keep working and
 * the next dashboard catches up. Completion is read from Herdr's `completion_seq`: a completed idle
 * transition numbered after the prompt went in belongs to this execution's turn.
 */
import { ACTIVE_STATES, pidAlive, type Execution, type ExecState, type Store } from "./db.ts";
import {
  agentFocus, agentGet, agentList, agentPrompt, agentStart, HerdrError, LOCAL, machineList, paneSendKeys, paneSendText, tabCreate, tabFocus, tabRename,
  workspaceCreate, workspaceFocus, workspaceList, type Created, type MachineProfile,
} from "./herdr.ts";
import type { AgentInfo, WorkspaceInfo } from "./herdr-types.ts";

export interface Machine {
  /** LOCAL or a saved profile id */
  id: string;
  label: string;
  enabled: boolean;
  target: string | null;
}

export interface MachineView {
  agents: AgentInfo[];
  workspaces: WorkspaceInfo[];
  /** when the last successful read finished */
  at: number;
  error: string | null;
  loading: boolean;
}

const LOCAL_POLL_MS = 2_000;
const REMOTE_POLL_MS = 4_000;
const MACHINES_REFRESH_MS = 30_000;
const RECOVER_EVERY_MS = 10_000;
/** a prompt sent this long ago that never showed a turn starting gets a note */
const STALL_NOTE_MS = 30_000;

export const READY: readonly string[] = ["idle", "done"];

export function localLabel(): string {
  return "本机";
}

/** Herdr agent names: [a-z][a-z0-9_-]{0,31}. */
export function agentNameFor(broadcastId: number, kind: string, slot: number): string {
  const safeKind = kind.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 12) || "agent";
  return `bc${broadcastId}-${safeKind}-${slot}`.slice(0, 32);
}

export function workspaceLabelFor(broadcastId: number, title: string): string {
  const short = title.replace(/\s+/g, " ").trim();
  return Array.from(`📡${broadcastId} ${short}`).slice(0, 36).join("");
}

/** A new agent's tab: its kind and number, and the folder it works in, since a broadcast's tabs share a workspace. */
export function tabLabelFor(kind: string, slot: number, cwd: string): string {
  const folder = cwd.replace(/\/+$/, "").split("/").pop() || cwd;
  return Array.from(`${kind}-${slot} · ${folder}`).slice(0, 40).join("");
}

/** Herdr does not expand ~ in a local --cwd; a remote one is resolved on that machine. */
export function resolveCwd(machineId: string, cwd: string): string {
  if (machineId !== LOCAL) return cwd;
  const home = process.env.HOME ?? "";
  if (cwd === "~") return home;
  if (cwd.startsWith("~/")) return `${home}${cwd.slice(1)}`;
  return cwd;
}

function message(error: unknown): string {
  if (error instanceof HerdrError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The gap between a typed prompt and its Enter, so a TUI still taking the paste does not read Enter as a newline. */
const SUBMIT_DELAY_MS = 300;

/**
 * A prompt ending in an `@file` mention leaves the agent's file suggestions open, and the Enter
 * would pick a suggestion instead of sending (herdr-web-ui hit this with Claude Code): a trailing
 * space closes them.
 */
export function shapePrompt(text: string): string {
  return /(?:^|\s)@\S+$/.test(text) ? `${text} ` : text;
}

/**
 * Herdr's agent prompt (paste, then Enter) for the agents it has a manifest for. An agent that
 * reports itself through `pane report-agent` has none, and Herdr refuses it as "not an active
 * named agent"; that one is typed into the pane instead, as herdr-web-ui does.
 */
export async function submitPrompt(machine: string, pane: string, text: string): Promise<void> {
  const shaped = shapePrompt(text);
  try {
    await agentPrompt(machine, pane, shaped);
  } catch (error) {
    if (!(error instanceof HerdrError) || (error.code !== "agent_not_ready" && error.code !== "agent_not_found")) throw error;
    const agent = await agentGet(machine, pane).catch(() => null);
    if (!agent || !READY.includes(agent.agent_status)) throw error;
    // several lines go in as one paste, or the first newline would send a fragment
    await paneSendText(machine, pane, shaped.includes("\n") ? `\x1b[200~${shaped}\x1b[201~` : shaped);
    await sleep(SUBMIT_DELAY_MS);
    await paneSendKeys(machine, pane, ["enter"]);
  }
}

export class Engine {
  machines: Machine[] = [{ id: LOCAL, label: localLabel(), enabled: true, target: null }];
  machinesError: string | null = null;
  private machinesAt = 0;
  private views = new Map<string, MachineView>();
  private polling = new Set<string>();
  private lastPoll = new Map<string, number>();
  private watched = new Map<string, number>();
  /** executions this process is starting or sending right now */
  private busy = new Set<number>();
  /** serializes workspace creation per broadcast + machine + folder */
  private groupLocks = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private recoveredAt = 0;
  private readonly timing: { tickMs: number; localPollMs: number; remotePollMs: number };
  /** reads, sends and starts in flight, so a process can wait for them before it lets go of its database */
  private pending = new Set<Promise<unknown>>();
  /** set by stop(): a read that answers afterwards moves nothing along */
  private stopped = false;

  /**
   * `startAgents: false` leaves starting new agents to the worker: a picker that closes
   * mid-start would leave a half-made agent behind.
   */
  constructor(readonly store: Store, private readonly changed: () => void, timing: Partial<Engine["timing"]> = {}, private readonly options: { startAgents?: boolean } = {}) {
    this.timing = { tickMs: 500, localPollMs: LOCAL_POLL_MS, remotePollMs: REMOTE_POLL_MS, ...timing };
  }

  private track(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  /** Waits until nothing this process started is still in flight. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Executions this process is starting or sending right now: quitting would interrupt them. */
  get busyCount(): number {
    return this.busy.size;
  }

  start(): void {
    this.stopped = false;
    this.recoveredAt = Date.now();
    this.store.recoverAbandoned(pidAlive);
    void this.refreshMachines();
    this.timer = setInterval(() => void this.tick(), this.timing.tickMs);
    void this.tick();
  }

  /** Stops polling. Work already in flight finishes; await settle() before closing the store. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  machine(id: string): Machine | undefined {
    return this.machines.find((m) => m.id === id);
  }

  machineLabel(id: string): string {
    return this.machine(id)?.label ?? id;
  }

  view(machineId: string): MachineView | undefined {
    return this.views.get(machineId);
  }

  /** Keeps a machine's agents fresh while a screen shows them (target picker). */
  watch(machineId: string): () => void {
    this.watched.set(machineId, (this.watched.get(machineId) ?? 0) + 1);
    this.lastPoll.delete(machineId);
    void this.tick();
    return () => {
      const n = (this.watched.get(machineId) ?? 1) - 1;
      if (n <= 0) this.watched.delete(machineId);
      else this.watched.set(machineId, n);
    };
  }

  async refreshMachines(): Promise<void> {
    this.machinesAt = Date.now();
    try {
      const profiles: MachineProfile[] = await machineList();
      this.machines = [
        { id: LOCAL, label: localLabel(), enabled: true, target: null },
        ...profiles.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled, target: p.target })),
      ];
      this.machinesError = null;
    } catch (error) {
      this.machinesError = message(error);
    }
    this.changed();
  }

  /** Re-read one machine now. */
  async refresh(machineId: string): Promise<void> {
    this.lastPoll.delete(machineId);
    const read = this.poll(machineId);
    this.track(read);
    await read;
  }

  private async tick(): Promise<void> {
    // stopped between two ticks: the store may be closed by the time this would read it
    if (this.stopped) return;
    if (Date.now() - this.machinesAt > MACHINES_REFRESH_MS) void this.refreshMachines();
    // another dashboard may have exited in the middle of a step
    if (Date.now() - this.recoveredAt > RECOVER_EVERY_MS) {
      this.recoveredAt = Date.now();
      if (this.store.recoverAbandoned(pidAlive) > 0) this.changed();
    }
    const active = this.store.executionsIn(ACTIVE_STATES);
    const wanted = new Set<string>([...this.watched.keys(), ...active.map((e) => e.machine_id)]);
    const now = Date.now();
    for (const machineId of wanted) {
      const every = machineId === LOCAL ? this.timing.localPollMs : this.timing.remotePollMs;
      if (now - (this.lastPoll.get(machineId) ?? 0) < every) continue;
      this.track(this.poll(machineId));
    }
    // new agents need no reading first: start them at once
    if (this.options.startAgents !== false) {
      for (const e of active) if (e.state === "queued" && e.target_kind === "new" && e.pane_id === null) this.track(this.startAgent(e));
    }
  }

  private async poll(machineId: string): Promise<void> {
    if (this.polling.has(machineId)) return;
    this.polling.add(machineId);
    this.lastPoll.set(machineId, Date.now());
    const previous = this.views.get(machineId);
    if (!previous) this.views.set(machineId, { agents: [], workspaces: [], at: 0, error: null, loading: true });
    try {
      const [agents, workspaces] = await Promise.all([agentList(machineId), workspaceList(machineId)]);
      // stopped while herdr answered: the store may be on its way out
      if (this.stopped) return;
      this.views.set(machineId, { agents, workspaces, at: Date.now(), error: null, loading: false });
      this.advance(machineId, agents, workspaces);
    } catch (error) {
      if (this.stopped) return;
      const view = this.views.get(machineId)!;
      this.views.set(machineId, { ...view, error: message(error), loading: false });
    } finally {
      this.polling.delete(machineId);
      this.lastPoll.set(machineId, Date.now());
      if (!this.stopped) this.changed();
    }
  }

  /** Moves every active execution on a machine along, from a fresh agent list. */
  private advance(machineId: string, agents: AgentInfo[], workspaces: WorkspaceInfo[]): void {
    const byPane = new Map(agents.map((a) => [a.pane_id, a]));
    const labels = new Map(workspaces.map((w) => [w.workspace_id, w.label]));
    for (const e of this.store.executionsIn(ACTIVE_STATES)) {
      if (e.machine_id !== machineId || e.pane_id === null || this.busy.has(e.id)) continue;
      const agent = byPane.get(e.pane_id);
      const label = e.workspace_id ? labels.get(e.workspace_id) : undefined;
      if (label && label !== e.workspace_label) this.store.update(e.id, { workspace_label: label });
      // the session the prompt went into; a later session in the same pane is not this run's
      const inFlight = e.state === "sent" || e.state === "working" || e.state === "blocked";
      if (inFlight && agent?.agent_session?.value && e.session_value === null) {
        this.store.update(e.id, { session_kind: agent.agent_session.kind, session_value: agent.agent_session.value });
      }
      switch (e.state) {
        case "queued":
          this.advanceQueued(e, agent);
          break;
        case "sent":
        case "working":
        case "blocked":
          this.advanceInFlight(e, agent);
          break;
        default:
          break;
      }
    }
  }

  private advanceQueued(e: Execution, agent: AgentInfo | undefined): void {
    if (!agent || (e.terminal_id && agent.terminal_id !== e.terminal_id)) {
      this.store.update(e.id, { state: "lost", error: "目标 pane 里已没有这个 agent", note: null });
      return;
    }
    const others = this.store.inFlightOn(e.machine_id, e.pane_id!, e.id);
    if (others.length > 0) {
      this.note(e, `排队中：等待广播 #${others[0]!.broadcast_id} 在这个 agent 上完成`);
      return;
    }
    if (READY.includes(agent.agent_status)) {
      this.track(this.send(e));
      return;
    }
    const why = agent.agent_status === "working" ? "排队中：agent 正忙，空闲后发送"
      : agent.agent_status === "blocked" ? "排队中：agent 在等待确认，处理后自动发送"
      : `排队中：agent 状态为 ${agent.agent_status}`;
    this.note(e, why);
  }

  private advanceInFlight(e: Execution, agent: AgentInfo | undefined): void {
    if (!agent || (e.terminal_id && agent.terminal_id !== e.terminal_id)) {
      this.store.update(e.id, { state: "lost", error: "agent 在完成前退出了", note: null });
      return;
    }
    const status = agent.agent_status;
    const finished = e.seq_before !== null && typeof agent.completion_seq === "number" && agent.completion_seq > e.seq_before;
    if (READY.includes(status) && (finished || e.saw_working === 1)) {
      this.store.update(e.id, { state: "completed", note: null });
      return;
    }
    if (status === "working") {
      if (e.state !== "working" || e.saw_working !== 1) this.store.update(e.id, { state: "working", saw_working: 1, note: null });
      return;
    }
    if (status === "blocked") {
      if (e.state !== "blocked") this.store.update(e.id, { state: "blocked", saw_working: 1, note: null });
      return;
    }
    if (e.state === "sent" && e.sent_at !== null && Date.now() - e.sent_at > STALL_NOTE_MS) {
      this.note(e, "已发送，但没看到 agent 开始工作；可打开 pane 查看");
    }
  }

  private note(e: Execution, note: string): void {
    if (e.note !== note) this.store.update(e.id, { note });
  }

  /** Writes the prompt into an idle agent. */
  private async send(e: Execution): Promise<void> {
    if (this.busy.has(e.id)) return;
    if (!this.store.claim(e.id, ["queued"], "sending")) return;
    this.busy.add(e.id);
    try {
      const broadcast = this.store.getBroadcast(e.broadcast_id);
      if (!broadcast) return;
      // a fresh read: the poll is a moment old, and its state_change_seq numbers the turn
      const agent = await agentGet(e.machine_id, e.pane_id!);
      if (e.terminal_id && agent.terminal_id !== e.terminal_id) {
        this.store.update(e.id, { state: "lost", error: "目标 pane 里已没有这个 agent", note: null });
        return;
      }
      if (!READY.includes(agent.agent_status)) {
        this.store.update(e.id, { state: "queued", note: "排队中：agent 刚刚变忙，空闲后发送" });
        return;
      }
      this.store.update(e.id, {
        seq_before: agent.state_change_seq ?? null,
        terminal_id: agent.terminal_id,
        workspace_id: agent.workspace_id,
        tab_id: agent.tab_id,
        session_kind: agent.agent_session?.kind ?? null,
        session_value: agent.agent_session?.value ?? null,
      });
      await submitPrompt(e.machine_id, e.pane_id!, broadcast.prompt);
      this.store.update(e.id, { state: "sent", sent_at: Date.now(), note: null, error: null });
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_blocked") {
        this.store.update(e.id, { state: "queued", note: "排队中：agent 在等待确认，处理后自动发送" });
      } else if (error instanceof HerdrError && error.code === "timeout") {
        // a timeout does not prove nothing was written: follow it as sent rather than send twice
        this.store.update(e.id, { state: "sent", sent_at: Date.now(), note: "发送超时，可能已送达；请打开 pane 确认" });
      } else {
        this.store.update(e.id, { state: "failed", error: message(error), note: null });
      }
    } finally {
      this.busy.delete(e.id);
      this.changed();
    }
  }

  /** Creates the place for a new agent, starts it, then hands it to the queue to be prompted. */
  private async startAgent(e: Execution): Promise<void> {
    if (this.busy.has(e.id)) return;
    if (!this.store.claim(e.id, ["queued"], "starting")) return;
    this.busy.add(e.id);
    this.changed();
    try {
      const broadcast = this.store.getBroadcast(e.broadcast_id);
      if (!broadcast) return;
      const kind = e.agent_kind ?? "claude";
      const cwd = resolveCwd(e.machine_id, e.cwd ?? "~");
      this.store.update(e.id, { note: "正在创建工作区…" });
      const created = await this.placeFor(e, broadcast.title, cwd);
      const pane = created.root_pane?.pane_id;
      if (!pane) throw new Error("Herdr 没有返回新 pane 的 ID");
      this.store.update(e.id, {
        workspace_id: created.workspace?.workspace_id ?? created.root_pane?.workspace_id ?? null,
        workspace_label: created.workspace?.label ?? null,
        tab_id: created.tab?.tab_id ?? created.root_pane?.tab_id ?? null,
        pane_id: pane,
        note: `正在启动 ${kind}…`,
      });
      const name = e.agent_name ?? agentNameFor(e.broadcast_id, kind, e.slot);
      let blockedAtStart = false;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await agentStart(e.machine_id, { name, kind, pane, timeoutMs: 90_000 });
          break;
        } catch (error) {
          if (error instanceof HerdrError && error.code === "agent_not_ready") {
            blockedAtStart = true;
            break;
          }
          // a pane made a moment ago may not be at its shell prompt yet
          const retryable = !(error instanceof HerdrError && (error.code === "usage" || error.code === "timeout")) && attempt < 6;
          if (!retryable) throw error;
          await sleep(1_500);
        }
      }
      const agent = await agentGet(e.machine_id, pane).catch(() => null);
      this.store.update(e.id, {
        state: "queued",
        agent_name: name,
        terminal_id: agent?.terminal_id ?? created.root_pane?.terminal_id ?? null,
        note: blockedAtStart ? "agent 启动时在等待确认（例如信任目录），请在 pane 中处理，之后自动发送" : "agent 已启动，等待空闲后发送",
      });
    } catch (error) {
      this.store.update(e.id, { state: "failed", error: message(error), note: null });
    } finally {
      this.busy.delete(e.id);
      this.lastPoll.delete(e.machine_id);
      this.changed();
    }
  }

  /**
   * A broadcast's new agents on one machine share one workspace, a tab each, every tab in its own
   * agent's folder: one broadcast is one workspace to find and to close.
   */
  private async placeFor(e: Execution, title: string, cwd: string): Promise<Created> {
    const label = workspaceLabelFor(e.broadcast_id, title);
    const key = `${e.broadcast_id}\0${e.machine_id}`;
    const previous = this.groupLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const sibling = this.store.executions(e.broadcast_id).find((other) =>
        other.id !== e.id && other.machine_id === e.machine_id && other.target_kind === "new" && other.workspace_id !== null);
      const tabLabel = tabLabelFor(e.agent_kind ?? "agent", e.slot, cwd);
      if (sibling?.workspace_id) {
        try {
          const tab = await tabCreate(e.machine_id, { workspace: sibling.workspace_id, cwd, label: tabLabel });
          return { ...tab, workspace: tab.workspace ?? ({ workspace_id: sibling.workspace_id, label: sibling.workspace_label ?? label } as WorkspaceInfo) };
        } catch (error) {
          // the shared workspace was closed: open a new one
          if (!(error instanceof HerdrError)) throw error;
        }
      }
      const created = await workspaceCreate(e.machine_id, { cwd, label });
      // the workspace's root tab carries the first agent; name it like the others
      if (created.tab?.tab_id) await tabRename(e.machine_id, created.tab.tab_id, tabLabel).catch(() => undefined);
      // recorded now so the next agent in this group finds it
      this.store.update(e.id, { workspace_id: created.workspace?.workspace_id ?? null, workspace_label: created.workspace?.label ?? label });
      return created;
    });
    this.groupLocks.set(key, run);
    return run;
  }

  // ---- user actions ----------------------------------------------------------------------

  cancel(e: Execution): boolean {
    if (e.state === "queued" && this.store.claim(e.id, ["queued"], "cancelled")) {
      this.store.update(e.id, { state: "cancelled", note: null, error: "已取消，prompt 未发送" });
      this.changed();
      return true;
    }
    if (e.state === "sent" || e.state === "working" || e.state === "blocked") {
      this.store.update(e.id, { state: "cancelled", note: null, error: "已停止追踪；agent 本身没有被中断" });
      this.changed();
      return true;
    }
    return false;
  }

  /** Runs a finished execution again: in the same agent when it is still there, else in a new one. */
  async retry(e: Execution): Promise<void> {
    const reset: Partial<Execution> = { state: "queued" as ExecState, seq_before: null, saw_working: 0, error: null, note: null, sent_at: null, finished_at: null, session_kind: null, session_value: null };
    if (e.target_kind === "new" && e.pane_id) {
      const alive = await agentGet(e.machine_id, e.pane_id).then((a) => !e.terminal_id || a.terminal_id === e.terminal_id).catch(() => false);
      if (!alive) Object.assign(reset, { pane_id: null, tab_id: null, terminal_id: null, workspace_id: null, workspace_label: null });
    }
    this.store.update(e.id, reset);
    this.lastPoll.delete(e.machine_id);
    this.changed();
  }

  /** Shows the execution's agent in Herdr's own UI. */
  async focus(e: Execution): Promise<string> {
    if (!e.pane_id) throw new Error("这个执行还没有 pane");
    try {
      await agentFocus(e.machine_id, e.pane_id);
    } catch {
      if (e.workspace_id) await workspaceFocus(e.machine_id, e.workspace_id);
      if (e.tab_id) await tabFocus(e.machine_id, e.tab_id);
    }
    return e.machine_id === LOCAL ? "已切换到该 agent" : `已在 ${this.machineLabel(e.machine_id)} 上聚焦该 agent；在 Herdr 侧栏切到这台机器即可看到`;
  }
}
