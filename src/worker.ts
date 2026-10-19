/**
 * Everything that has to keep going while no picker is open.
 *
 * - The worker is a plugin action process: it starts new agents, follows remote machines (their
 *   agent events fire on that machine's Herdr, where this plugin is not installed), and exits
 *   once nothing is left to do. One runs at a time, held by a lock in the database.
 * - The event hook runs once per local agent status change: when the pane carries a broadcast
 *   execution it reads the agents, sends what is due and records what finished, then exits.
 *   A local broadcast moves along even with no worker and no picker running.
 */
import { pidAlive, type Store } from "./db.ts";
import { Engine } from "./engine.ts";
import { herdrBin, LOCAL } from "./herdr.ts";

export const WORKER_LOCK = "worker";
const HEARTBEAT_MS = 2_000;
const STALE_MS = 15_000;
/** how long the worker stays after the last active execution, for a broadcast made right after */
const LINGER_MS = 20_000;

export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "herdr-broadcast";

export async function runWorker(store: Store, log: (line: string) => void = (l) => console.log(l), timing: { heartbeatMs?: number; lingerMs?: number; engine?: ConstructorParameters<typeof Engine>[2] } = {}): Promise<void> {
  const heartbeatMs = timing.heartbeatMs ?? HEARTBEAT_MS;
  const lingerMs = timing.lingerMs ?? LINGER_MS;
  if (!store.acquireLock(WORKER_LOCK, pidAlive, STALE_MS)) {
    log("another worker is running");
    return;
  }
  const engine = new Engine(store, () => {}, timing.engine);
  engine.start();
  log(`worker ${process.pid} started, ${store.activeCount()} active`);
  let idleSince: number | null = null;
  try {
    for (;;) {
      await Bun.sleep(heartbeatMs);
      store.heartbeat(WORKER_LOCK);
      if (store.activeCount() > 0 || engine.busyCount > 0) {
        idleSince = null;
        continue;
      }
      idleSince ??= Date.now();
      if (Date.now() - idleSince < lingerMs) continue;
      // let go, then look once more: a broadcast made in between found the lock still held
      engine.stop();
      await engine.settle();
      store.releaseLock(WORKER_LOCK);
      if (store.activeCount() > 0 && store.acquireLock(WORKER_LOCK, pidAlive, STALE_MS)) {
        idleSince = null;
        engine.start();
        continue;
      }
      log("nothing left to do");
      return;
    }
  } finally {
    engine.stop();
    await engine.settle();
    store.releaseLock(WORKER_LOCK);
  }
}

/** Makes sure a worker runs: Herdr starts one as a plugin action, unless one holds the lock. */
export async function kickWorker(store: Store): Promise<"running" | "started" | "failed"> {
  if (store.lockHolder(WORKER_LOCK, pidAlive, STALE_MS) !== null) return "running";
  const args = ["plugin", "action", "invoke", `${PLUGIN_ID}.worker`];
  const session = process.env.HERDR_BROADCAST_SESSION;
  const proc = Bun.spawn([herdrBin(), ...(session ? ["--session", session] : []), ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: process.env });
  const code = await proc.exited;
  return code === 0 ? "started" : "failed";
}

/** Finds a pane id anywhere in an event payload. */
export function eventPane(json: string | undefined): string | null {
  if (!json) return null;
  try {
    const find = (value: unknown): string | null => {
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      if (typeof record.pane_id === "string") return record.pane_id;
      for (const nested of Object.values(record)) {
        const found = find(nested);
        if (found) return found;
      }
      return null;
    };
    return find(JSON.parse(json));
  } catch {
    return null;
  }
}

/** The plugin's [[startup]] and [[events]] hooks. */
export async function runHook(store: Store, event: string | undefined, eventJson: string | undefined): Promise<string> {
  if (event === "startup") {
    store.recoverAbandoned(pidAlive);
    if (store.activeCount() === 0) return "startup: nothing pending";
    return `startup: worker ${await kickWorker(store)}`;
  }
  const pane = eventPane(eventJson);
  if (!pane || !store.activeOnPane(LOCAL, pane)) return `${event ?? "event"}: not a broadcast pane`;
  const engine = new Engine(store, () => {}, {}, { startAgents: false });
  await engine.refresh(LOCAL);
  await engine.settle();
  return `${event}: advanced executions on ${pane}`;
}
