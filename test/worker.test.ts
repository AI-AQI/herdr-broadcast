import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pidAlive, Store, type NewExecution } from "../src/db.ts";
import { eventPane, kickWorker, runHook, runWorker, WORKER_LOCK } from "../src/worker.ts";
import { FakeHerdr, until, type FakeAgent } from "./helpers.ts";

let fake: FakeHerdr;
let store: Store;

const existing = (agent: FakeAgent): NewExecution => ({ machine_id: "local", machine_label: "本机", target_kind: "existing", agent_kind: agent.agent, pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id });
const event = (pane: string) => JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: pane, agent_status: "idle" } });

beforeEach(() => {
  fake = new FakeHerdr();
  store = new Store(fake.dbFile);
});

afterEach(() => {
  store.close();
  fake.cleanup();
});

describe("event hook", () => {
  test("a status change on a broadcast pane sends what is due and records what finished, then exits", async () => {
    const agent = fake.addAgent("local", "claude");
    const first = store.createBroadcast({ title: "a", prompt: "first", executions: [existing(agent)] });
    const second = store.createBroadcast({ title: "b", prompt: "second", executions: [existing(agent)] });

    expect(await runHook(store, "pane.agent_status_changed", event(agent.pane_id))).toContain("advanced");
    expect(store.executions(first)[0]!.state).toBe("sent");
    expect(store.executions(second)[0]!.state).toBe("queued");

    // the agent works through the first prompt; its settling is the next event
    fake.setStatus("local", agent.pane_id, "working");
    fake.setStatus("local", agent.pane_id, "done");
    await runHook(store, "pane.agent_status_changed", event(agent.pane_id));
    expect(store.executions(first)[0]!.state).toBe("completed");
    expect(store.executions(second)[0]!.state).toBe("sent");
    expect(fake.server().prompts.map((p) => p.text)).toEqual(["first", "second"]);
  });

  test("other panes are ignored without reading herdr", async () => {
    const before = fake.calls().length;
    expect(await runHook(store, "pane.agent_status_changed", event("w9:p9"))).toContain("not a broadcast pane");
    expect(fake.calls().length).toBe(before);
  });

  test("the hook never starts new agents (that is the worker's)", async () => {
    store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "new", agent_kind: "claude", cwd: "/src", slot: 1 }] });
    await runHook(store, "pane.agent_status_changed", event("w1:p1"));
    expect(fake.calls().some((c) => c.includes('"workspace","create"'))).toBe(false);
  });

  test("startup starts a worker only when something is pending", async () => {
    expect(await runHook(store, "startup", undefined)).toContain("nothing pending");
    const agent = fake.addAgent("local", "claude", "working");
    store.createBroadcast({ title: "t", prompt: "p", executions: [existing(agent)] });
    expect(await runHook(store, "startup", undefined)).toContain("worker started");
    expect(fake.calls().some((c) => c.includes('"plugin","action","invoke","herdr-broadcast.worker"'))).toBe(true);
  });

  test("pane ids are found anywhere in the payload", () => {
    expect(eventPane('{"data":{"pane":{"pane_id":"w2:p3"}}}')).toBe("w2:p3");
    expect(eventPane("not json")).toBeNull();
  });
});

describe("worker", () => {
  test("starts new agents, follows them to the end, then exits and lets go of its lock", async () => {
    const id = store.createBroadcast({ title: "t", prompt: "go", executions: [1, 2].map((slot) => ({ machine_id: "local", machine_label: "本机", target_kind: "new" as const, agent_kind: "codex", cwd: "/src", slot })) });
    const done = runWorker(store, () => {}, { heartbeatMs: 50, lingerMs: 200, engine: { tickMs: 30, localPollMs: 60, remotePollMs: 60 } });
    await until(() => store.executions(id).every((e) => e.state === "sent"), 15000, "sent");
    expect(store.lockHolder(WORKER_LOCK, pidAlive, 15_000)).toBe(process.pid);
    for (const e of store.executions(id)) fake.quickTurn("local", e.pane_id!);
    await done;
    expect(store.executions(id).map((e) => e.state)).toEqual(["completed", "completed"]);
    expect(store.lockHolder(WORKER_LOCK, pidAlive, 15_000)).toBeNull();
  });

  test("a second worker leaves when one is running, and kick does not start another", async () => {
    expect(store.acquireLock(WORKER_LOCK, pidAlive, 15_000)).toBe(true);
    const lines: string[] = [];
    // a live pid that is not ours holds it: this process stands in for the other worker
    const other = new Store(fake.dbFile);
    other.db.query("UPDATE locks SET pid = ? WHERE name = ?").run(process.ppid, WORKER_LOCK);
    await runWorker(store, (l) => lines.push(l));
    expect(lines).toEqual(["another worker is running"]);
    expect(await kickWorker(store)).toBe("running");
    other.close();
  });
});
