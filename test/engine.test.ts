import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store, type Execution, type NewExecution } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { FakeHerdr, until, type FakeAgent } from "./helpers.ts";

let fake: FakeHerdr;
let store: Store;
let engines: Engine[];

function engine(): Engine {
  const e = new Engine(store, () => {}, { tickMs: 30, localPollMs: 60, remotePollMs: 60 });
  engines.push(e);
  e.start();
  return e;
}

function existing(machine: string, agent: FakeAgent, label = "本机"): NewExecution {
  return { machine_id: machine, machine_label: label, target_kind: "existing", agent_kind: agent.agent, pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id };
}

function exec(id: number): Execution {
  return store.execution(id)!;
}

function execs(broadcast: number): Execution[] {
  return store.executions(broadcast);
}

beforeEach(() => {
  fake = new FakeHerdr();
  store = new Store(fake.dbFile);
  engines = [];
});

afterEach(async () => {
  for (const e of engines) e.stop();
  // nothing in flight may outlive this test's database and fake herdr
  for (const e of engines) await e.settle();
  store.close();
  fake.cleanup();
});

describe("existing agents", () => {
  test("an idle agent gets the prompt, and the execution completes when its turn ends", async () => {
    const agent = fake.addAgent("local", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "检查登录模块", executions: [existing("local", agent)] });
    engine();
    const [e] = execs(id);
    await until(() => exec(e!.id).state === "sent", 8000, "sent");
    expect(fake.server().prompts).toEqual([{ pane_id: agent.pane_id, text: "检查登录模块" }]);
    expect(exec(e!.id).seq_before).toBe(10);

    fake.setStatus("local", agent.pane_id, "working");
    await until(() => exec(e!.id).state === "working", 8000, "working");
    fake.setStatus("local", agent.pane_id, "done");
    await until(() => exec(e!.id).state === "completed", 8000, "completed");
    expect(exec(e!.id).finished_at).not.toBeNull();
  });

  test("a turn that starts and ends between two polls still counts, by completion_seq", async () => {
    const agent = fake.addAgent("local", "codex");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [existing("local", agent)] });
    const eng = engine();
    const [e] = execs(id);
    await until(() => exec(e!.id).state === "sent", 8000, "sent");
    eng.stop();
    fake.quickTurn("local", agent.pane_id);
    engine();
    await until(() => exec(e!.id).state === "completed", 8000, "completed");
    expect(exec(e!.id).saw_working).toBe(0);
  });

  test("a busy agent is queued, and gets the prompt once it is idle", async () => {
    const agent = fake.addAgent("local", "claude", "working");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [existing("local", agent)] });
    engine();
    const [e] = execs(id);
    await until(() => exec(e!.id).note?.includes("agent 正忙") === true, 8000, "busy note");
    expect(fake.server().prompts).toHaveLength(0);
    fake.setStatus("local", agent.pane_id, "idle");
    await until(() => exec(e!.id).state === "sent", 8000, "sent");
    expect(fake.server().prompts).toHaveLength(1);
  });

  test("two broadcasts to one agent run one after the other", async () => {
    const agent = fake.addAgent("local", "claude");
    const first = store.createBroadcast({ title: "a", prompt: "first", executions: [existing("local", agent)] });
    const second = store.createBroadcast({ title: "b", prompt: "second", executions: [existing("local", agent)] });
    engine();
    await until(() => execs(first)[0]!.state === "sent", 8000, "first sent");
    await Bun.sleep(300);
    expect(execs(second)[0]!.state).toBe("queued");
    expect(execs(second)[0]!.note).toContain(`#${first}`);
    expect(fake.server().prompts.map((p) => p.text)).toEqual(["first"]);

    fake.setStatus("local", agent.pane_id, "working");
    fake.setStatus("local", agent.pane_id, "idle");
    await until(() => execs(first)[0]!.state === "completed", 8000, "first completed");
    await until(() => execs(second)[0]!.state === "sent", 8000, "second sent");
    expect(fake.server().prompts.map((p) => p.text)).toEqual(["first", "second"]);
  });

  test("an agent that goes away is marked lost", async () => {
    const agent = fake.addAgent("local", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [existing("local", agent)] });
    engine();
    const [e] = execs(id);
    await until(() => exec(e!.id).state === "sent", 8000, "sent");
    fake.removeAgent("local", agent.pane_id);
    await until(() => exec(e!.id).state === "lost", 8000, "lost");
  });

  test("a different agent in the same pane is not the one chosen", async () => {
    const agent = fake.addAgent("local", "claude", "working");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ ...existing("local", agent), terminal_id: "term_other" }] });
    engine();
    await until(() => execs(id)[0]!.state === "lost", 8000, "lost");
    expect(fake.server().prompts).toHaveLength(0);
  });

  test("an agent Herdr's prompt refuses (self-reported, no manifest) is typed into instead", async () => {
    const agent = fake.addAgent("local", "fakebot", "idle", null, true);
    const id = store.createBroadcast({ title: "t", prompt: "line one\nline two", executions: [existing("local", agent)] });
    engine();
    await until(() => execs(id)[0]!.state === "sent", 8000, "sent");
    expect(fake.server().prompts).toEqual([{ pane_id: agent.pane_id, text: "\x1b[200~line one\nline two\x1b[201~" }]);
  });

  test("two dashboards on one database send the prompt once", async () => {
    const agent = fake.addAgent("local", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "once", executions: [existing("local", agent)] });
    const other = new Store(fake.dbFile);
    const second = new Engine(other, () => {}, { tickMs: 30, localPollMs: 60, remotePollMs: 60 });
    engines.push(second);
    engine();
    second.start();
    await until(() => execs(id)[0]!.state === "sent", 8000, "sent");
    await Bun.sleep(400);
    expect(fake.server().prompts).toHaveLength(1);
    second.stop();
    await second.settle();
    other.close();
  });
});

describe("new agents", () => {
  test("new agents of one broadcast share a workspace, a tab each, and each gets the prompt", async () => {
    const id = store.createBroadcast({
      title: "并行检查", prompt: "go",
      executions: [1, 2].map((slot) => ({ machine_id: "local", machine_label: "本机", target_kind: "new" as const, agent_kind: "claude", cwd: "/src/app", slot })),
    });
    engine();
    await until(() => execs(id).every((e) => e.state === "sent"), 15000, "all sent");
    const server = fake.server();
    expect(server.workspaces.filter((w) => w.label.startsWith(`📡${id}`))).toHaveLength(1);
    expect(server.agents.map((a) => a.name).sort()).toEqual([`bc${id}-claude-1`, `bc${id}-claude-2`]);
    expect(server.prompts.map((p) => p.text)).toEqual(["go", "go"]);
    const calls = fake.calls();
    expect(calls.filter((c) => c.includes('"workspace","create"'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('"tab","create"'))).toHaveLength(1);
    const [a, b] = execs(id);
    expect(a!.workspace_id).toBe(b!.workspace_id);
    expect(a!.pane_id).not.toBe(b!.pane_id);
  });

  test("new agents in different folders still share the broadcast's one workspace, each tab in its own folder", async () => {
    const id = store.createBroadcast({
      title: "两个目录", prompt: "go",
      executions: [
        { machine_id: "local", machine_label: "本机", target_kind: "new", agent_kind: "claude", cwd: "/src/app", slot: 1 },
        { machine_id: "local", machine_label: "本机", target_kind: "new", agent_kind: "pi", cwd: "/src/api", slot: 2 },
      ],
    });
    engine();
    await until(() => execs(id).every((e) => e.state === "sent"), 15000, "all sent");
    const calls = fake.calls();
    expect(calls.filter((c) => c.includes('"workspace","create"'))).toHaveLength(1);
    const tabs = calls.filter((c) => c.includes('"tab","create"'));
    expect(tabs).toHaveLength(1);
    // whichever started second opened its tab, in its own folder, named for it
    const tab = tabs[0]!;
    const second = tab.includes('"/src/api"') ? ['"--cwd","/src/api"', '"pi-2 · api"'] : ['"--cwd","/src/app"', '"claude-1 · app"'];
    for (const part of second) expect(tab).toContain(part);
    const [a, b] = execs(id);
    expect(a!.workspace_id).toBe(b!.workspace_id);
  });

  test("on a remote machine, every call goes through --machine and the agents share one workspace", async () => {
    fake.addMachine("m-1", "gpu-box");
    const id = store.createBroadcast({
      title: "remote", prompt: "remote go",
      executions: [1, 2].map((slot) => ({ machine_id: "m-1", machine_label: "gpu-box", target_kind: "new" as const, agent_kind: "codex", cwd: "~/repo", slot })),
    });
    engine();
    await until(() => execs(id).every((e) => e.state === "sent"), 15000, "all sent");
    expect(fake.server("m-1").prompts).toHaveLength(2);
    expect(fake.server("local").prompts).toHaveLength(0);
    const placing = fake.calls().filter((c) => c.includes('"workspace","create"') || c.includes('"tab","create"'));
    expect(placing).toHaveLength(2);
    expect(placing.every((c) => c.startsWith("m-1 "))).toBe(true);
    // a remote ~ is the remote machine's to resolve
    expect(placing.every((c) => c.includes('"~/repo"'))).toBe(true);
  });

  test("an agent blocked at startup (e.g. a trust prompt) waits, then gets the prompt", async () => {
    process.env.FAKE_START_BLOCKED = "1";
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "new", agent_kind: "claude", cwd: "/src", slot: 1 }] });
    engine();
    await until(() => execs(id)[0]!.state === "queued" && execs(id)[0]!.pane_id !== null, 15000, "started blocked");
    delete process.env.FAKE_START_BLOCKED;
    expect(execs(id)[0]!.note).toContain("等待确认");
    const pane = execs(id)[0]!.pane_id!;
    fake.setStatus("local", pane, "idle");
    await until(() => execs(id)[0]!.state === "sent", 8000, "sent");
  });

  test("a failed start is reported with Herdr's error", async () => {
    fake.mutate((s) => {
      s.servers.local!.failNext = { "workspace create": ["cwd_not_found"] };
    });
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "new", agent_kind: "claude", cwd: "/nope", slot: 1 }] });
    engine();
    await until(() => execs(id)[0]!.state === "failed", 8000, "failed");
    expect(execs(id)[0]!.error).toContain("cwd_not_found");
  });
});

describe("machines", () => {
  test("an unreachable machine leaves its executions as they were", async () => {
    fake.addMachine("m-2", "flaky");
    const agent = fake.addAgent("m-2", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [existing("m-2", agent, "flaky")] });
    const eng = engine();
    await until(() => execs(id)[0]!.state === "sent", 8000, "sent");
    fake.mutate((s) => {
      s.servers["m-2"]!.unreachable = true;
    });
    await until(() => eng.view("m-2")?.error !== null && eng.view("m-2")?.error !== undefined, 8000, "error seen");
    expect(execs(id)[0]!.state).toBe("sent");
  });

  test("the machine list comes from herdr machine list", async () => {
    fake.addMachine("m-3", "build");
    const eng = engine();
    await until(() => eng.machines.length === 2, 8000, "machines");
    expect(eng.machines[1]).toMatchObject({ id: "m-3", label: "build", enabled: true });
  });
});
