/**
 * Broadcasts and their executions, in SQLite under the plugin's state directory.
 *
 * A broadcast is one prompt sent to several agents; an execution is that prompt in one agent.
 * Several dashboards may be open at once (the TUI, the same pane in a browser, a second tab),
 * so every step that writes to an agent is claimed with a conditional UPDATE first.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExecState =
  | "queued" // waiting for its agent to be free (existing agents) or to be started (new ones)
  | "starting" // creating the workspace/tab/worktree and starting the agent
  | "sending" // claimed by a dashboard that is writing the prompt
  | "sent" // prompt submitted, agent not yet seen working
  | "working"
  | "blocked" // the agent asks for approval or input
  | "completed"
  | "failed"
  | "cancelled"
  | "lost"; // the agent went away before finishing

export const ACTIVE_STATES: readonly ExecState[] = ["queued", "starting", "sending", "sent", "working", "blocked"];
export const FINAL_STATES: readonly ExecState[] = ["completed", "failed", "cancelled", "lost"];
/** states in which the prompt is in the agent and its turn has not been seen to end */
export const IN_FLIGHT_STATES: readonly ExecState[] = ["sending", "sent", "working", "blocked"];

export type TargetKind = "existing" | "new";

export interface Broadcast {
  id: number;
  title: string;
  prompt: string;
  created_at: number;
}

export interface BroadcastSummary extends Broadcast {
  total: number;
  counts: Partial<Record<ExecState, number>>;
}

export interface Execution {
  id: number;
  broadcast_id: number;
  /** "local" or a saved machine profile id */
  machine_id: string;
  machine_label: string;
  target_kind: TargetKind;
  agent_kind: string | null;
  agent_name: string | null;
  cwd: string | null;
  /** new agents: the agent's place among the broadcast's new agents on this machine (1-based) */
  slot: number;
  workspace_id: string | null;
  workspace_label: string | null;
  tab_id: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  session_kind: string | null;
  session_value: string | null;
  state: ExecState;
  /** the agent's state_change_seq when the prompt went in; a completion after it is this run's */
  seq_before: number | null;
  saw_working: number;
  error: string | null;
  /** why a queued or sent execution is waiting, for the list */
  note: string | null;
  owner_pid: number | null;
  created_at: number;
  sent_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

export type NewExecution = Pick<Execution, "machine_id" | "machine_label" | "target_kind"> &
  Partial<Pick<Execution, "agent_kind" | "agent_name" | "cwd" | "slot" | "workspace_id" | "workspace_label" | "tab_id" | "pane_id" | "terminal_id">>;

const SCHEMA_VERSION = 4;

/**
 * One database per Herdr session: pane ids and "local" mean that session's server, and a hook
 * running in another session must not take this one's panes for gone.
 */
export function sessionName(): string {
  if (process.env.HERDR_BROADCAST_SESSION) return process.env.HERDR_BROADCAST_SESSION;
  const match = /[/\\]sessions[/\\]([^/\\]+)[/\\]herdr\.sock$/.exec(process.env.HERDR_SOCKET_PATH ?? "");
  return match?.[1] ?? "default";
}

export function defaultDbPath(): string {
  // outside Herdr (a shell, a script), the same directory Herdr gives the plugin
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr", "plugins", "herdr-broadcast");
  mkdirSync(dir, { recursive: true });
  const session = sessionName();
  return join(dir, session === "default" ? "broadcast.sqlite" : `broadcast-${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.sqlite`);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export class Store {
  readonly db: Database;

  constructor(readonly path: string = defaultDbPath()) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
    if (user_version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
        machine_id TEXT NOT NULL,
        machine_label TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        agent_kind TEXT,
        agent_name TEXT,
        cwd TEXT,
        slot INTEGER NOT NULL DEFAULT 0,
        workspace_id TEXT,
        workspace_label TEXT,
        tab_id TEXT,
        pane_id TEXT,
        terminal_id TEXT,
        session_kind TEXT,
        session_value TEXT,
        state TEXT NOT NULL,
        seq_before INTEGER,
        saw_working INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        note TEXT,
        owner_pid INTEGER,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS executions_broadcast ON executions(broadcast_id);
      CREATE INDEX IF NOT EXISTS executions_state ON executions(state);
      CREATE TABLE IF NOT EXISTS locks (
        name TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        heartbeat INTEGER NOT NULL
      );
    `);
    // version 3 and before started agents in git worktrees too: those columns go
    const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(executions)").all().map((c) => c.name));
    for (const column of ["worktree_branch", "trust_repository"]) {
      if (columns.has(column)) this.db.exec(`ALTER TABLE executions DROP COLUMN ${column}`);
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Takes a named lock for this process, unless a live process holds it with a fresh heartbeat.
   * A holder that died, or stopped beating for `staleMs`, loses it.
   */
  acquireLock(name: string, isAlive: (pid: number) => boolean, staleMs: number, pid: number = process.pid): boolean {
    const take = this.db.transaction(() => {
      const held = this.db.query<{ pid: number; heartbeat: number }, [string]>("SELECT pid, heartbeat FROM locks WHERE name = ?").get(name);
      if (held && held.pid !== pid && isAlive(held.pid) && Date.now() - held.heartbeat < staleMs) return false;
      this.db.query("INSERT INTO locks (name, pid, heartbeat) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET pid = excluded.pid, heartbeat = excluded.heartbeat").run(name, pid, Date.now());
      return true;
    });
    return take.immediate();
  }

  heartbeat(name: string, pid: number = process.pid): void {
    this.db.query("UPDATE locks SET heartbeat = ? WHERE name = ? AND pid = ?").run(Date.now(), name, pid);
  }

  releaseLock(name: string, pid: number = process.pid): void {
    this.db.query("DELETE FROM locks WHERE name = ? AND pid = ?").run(name, pid);
  }

  /** The live holder of a lock, if any. */
  lockHolder(name: string, isAlive: (pid: number) => boolean, staleMs: number): number | null {
    const held = this.db.query<{ pid: number; heartbeat: number }, [string]>("SELECT pid, heartbeat FROM locks WHERE name = ?").get(name);
    return held && isAlive(held.pid) && Date.now() - held.heartbeat < staleMs ? held.pid : null;
  }

  activeCount(): number {
    return this.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM executions WHERE state IN (${placeholders(ACTIVE_STATES)})`).get(...ACTIVE_STATES)!.n;
  }

  /** Whether any active execution waits on this pane of this machine. */
  activeOnPane(machineId: string, paneId: string): boolean {
    return this.db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM executions WHERE machine_id = ? AND pane_id = ? AND state IN (${placeholders(ACTIVE_STATES)})`)
      .get(machineId, paneId, ...ACTIVE_STATES)!.n > 0;
  }

  close(): void {
    this.db.close();
  }

  createBroadcast(input: { title: string; prompt: string; executions: NewExecution[] }): number {
    const now = Date.now();
    const insert = this.db.transaction(() => {
      const { id } = this.db.query<{ id: number }, [string, string, number]>("INSERT INTO broadcasts (title, prompt, created_at) VALUES (?, ?, ?) RETURNING id").get(input.title, input.prompt, now)!;
      const row = this.db.prepare(`INSERT INTO executions (broadcast_id, machine_id, machine_label, target_kind, agent_kind, agent_name, cwd, slot,
        workspace_id, workspace_label, tab_id, pane_id, terminal_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`);
      for (const e of input.executions) {
        row.run(id, e.machine_id, e.machine_label, e.target_kind, e.agent_kind ?? null, e.agent_name ?? null, e.cwd ?? null, e.slot ?? 0,
          e.workspace_id ?? null, e.workspace_label ?? null, e.tab_id ?? null, e.pane_id ?? null, e.terminal_id ?? null, now, now);
      }
      return id;
    });
    return insert();
  }

  listBroadcasts(): BroadcastSummary[] {
    const broadcasts = this.db.query<Broadcast, []>("SELECT id, title, prompt, created_at FROM broadcasts ORDER BY id DESC").all();
    const counts = this.db.query<{ broadcast_id: number; state: ExecState; n: number }, []>("SELECT broadcast_id, state, COUNT(*) AS n FROM executions GROUP BY broadcast_id, state").all();
    const byId = new Map<number, BroadcastSummary>(broadcasts.map((b) => [b.id, { ...b, total: 0, counts: {} }]));
    for (const c of counts) {
      const summary = byId.get(c.broadcast_id);
      if (!summary) continue;
      summary.counts[c.state] = c.n;
      summary.total += c.n;
    }
    return [...byId.values()];
  }

  getBroadcast(id: number): Broadcast | null {
    return this.db.query<Broadcast, [number]>("SELECT id, title, prompt, created_at FROM broadcasts WHERE id = ?").get(id) ?? null;
  }

  deleteBroadcast(id: number): void {
    this.db.query("DELETE FROM broadcasts WHERE id = ?").run(id);
  }

  executions(broadcastId: number): Execution[] {
    return this.db.query<Execution, [number]>("SELECT * FROM executions WHERE broadcast_id = ? ORDER BY id").all(broadcastId);
  }

  execution(id: number): Execution | null {
    return this.db.query<Execution, [number]>("SELECT * FROM executions WHERE id = ?").get(id) ?? null;
  }

  executionsIn(states: readonly ExecState[]): Execution[] {
    return this.db.query<Execution, string[]>(`SELECT * FROM executions WHERE state IN (${placeholders(states)}) ORDER BY id`).all(...states);
  }

  /** Executions whose prompt is in this pane and not finished, other than `except`. */
  inFlightOn(machineId: string, paneId: string, except: number): Execution[] {
    return this.db.query<Execution, (string | number)[]>(`SELECT * FROM executions WHERE machine_id = ? AND pane_id = ? AND id != ? AND state IN (${placeholders(IN_FLIGHT_STATES)})`)
      .all(machineId, paneId, except, ...IN_FLIGHT_STATES);
  }

  /** Moves an execution from one of `from` to `to` only if nobody else moved it first. */
  claim(id: number, from: readonly ExecState[], to: ExecState, ownerPid: number = process.pid): boolean {
    const now = Date.now();
    const result = this.db.query(`UPDATE executions SET state = ?, owner_pid = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders(from)})`).run(to, ownerPid, now, id, ...from);
    return result.changes === 1;
  }

  update(id: number, patch: Partial<Omit<Execution, "id" | "broadcast_id">>): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const now = Date.now();
    const state = patch.state;
    if (state && (FINAL_STATES as readonly string[]).includes(state) && patch.finished_at === undefined) entries.push(["finished_at", now]);
    entries.push(["updated_at", now]);
    const sql = `UPDATE executions SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`;
    this.db.query(sql).run(...(entries.map(([, value]) => value) as (string | number | null)[]), id);
  }

  /** Steps a dashboard was in the middle of when it exited: they can not be resumed blindly. */
  recoverAbandoned(isAlive: (pid: number) => boolean): number {
    let recovered = 0;
    for (const e of this.executionsIn(["starting", "sending"])) {
      if (e.owner_pid !== null && isAlive(e.owner_pid)) continue;
      const error = e.state === "starting" ? "启动过程中仪表盘退出了；请检查对应 pane 后重试" : "发送过程中仪表盘退出了，无法确认 prompt 是否已送达";
      this.update(e.id, { state: "failed", error });
      recovered += 1;
    }
    return recovered;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
