import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { detectWebUi, startWebServer } from "../src/web/server.ts";
import { FakeHerdr, until } from "./helpers.ts";

let fake: FakeHerdr;
let store: Store;
let web: ReturnType<typeof startWebServer>;
let base: string;

function start(token: string | null = null) {
  web = startWebServer(store, { host: "127.0.0.1", port: 0, token, hosts: [] }, { tickMs: 30, localPollMs: 60, remotePollMs: 60 });
  base = `http://127.0.0.1:${web.server.port}`;
}

/** A request as the page itself sends it: same origin. */
const send = (path: string, body: unknown, method = "POST") =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

beforeEach(() => {
  fake = new FakeHerdr();
  store = new Store(fake.dbFile);
});

afterEach(async () => {
  await web?.stop();
  store.close();
  fake.cleanup();
});

describe("web page", () => {
  test("serves the page and its script under a strict policy", async () => {
    start();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<script src="/page.js">');
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect((await fetch(`${base}/page.js`)).status).toBe(200);
  });

  test("a broadcast from the form reaches an idle agent", async () => {
    const agent = fake.addAgent("local", "claude");
    start();
    const response = await send("/api/broadcasts", { prompt: "从网页发的", targets: [{ machine: "local", pane: agent.pane_id }] });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: number };
    await until(() => store.executions(id)[0]?.state === "sent", 8000, "sent");
    expect(fake.server().prompts).toEqual([{ pane_id: agent.pane_id, text: "从网页发的" }]);

    const state = (await (await fetch(`${base}/api/state`)).json()) as { state: { broadcasts: { id: number; executions: { web_link: string }[] }[] } };
    expect(state.state.broadcasts[0]!.id).toBe(id);
    expect(state.state.broadcasts[0]!.executions[0]!.web_link).toContain(`pane=${encodeURIComponent(agent.pane_id)}`);
  });

  test("new agents in the form are checked: a remote folder must be absolute or ~", async () => {
    fake.addMachine("m-1", "gpu-box");
    start();
    await until(() => web.engine.machines.length === 2, 8000, "machines");
    const response = await send("/api/broadcasts", { prompt: "p", new: [{ machine: "m-1", kind: "codex", cwd: "repo", count: 1 }] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("绝对路径");
  });

  test("a new local agent needs a folder that exists", async () => {
    start();
    const missing = await send("/api/broadcasts", { prompt: "p", new: [{ machine: "local", kind: "claude", cwd: "/no/such/folder/here", count: 1 }] });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain("本机没有这个目录");
    const plain = mkdtempSync(join(tmpdir(), "bcast-plain-"));
    try {
      const dirs = (await (await fetch(`${base}/api/dirs?machine=local&q=${encodeURIComponent(plain)}`)).json()) as { target: { exists: boolean } };
      expect(dirs.target).toEqual({ exists: true });
      const sent = await send("/api/broadcasts", { prompt: "p", new: [{ machine: "local", kind: "claude", cwd: plain, count: 1 }] });
      expect(sent.status).toBe(200);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("other sites cannot post, and unknown Host names are refused", async () => {
    start();
    const cross = await fetch(`${base}/api/broadcasts`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "{}" });
    expect(cross.status).toBe(403);
    const noOrigin = await fetch(`${base}/api/broadcasts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    const rebound = await fetch(`${base}/api/state`, { headers: { host: "attacker.example" } });
    expect(rebound.status).toBe(421);
  });

  test("with a token, nothing works without it; ?token= once sets a cookie", async () => {
    start("s3cret");
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    const login = await fetch(`${base}/?token=s3cret`, { redirect: "manual" });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${base}/api/state`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  test("retry: a failed or lost execution goes out again, a completed one does not", async () => {
    const agent = fake.addAgent("local", "claude", "working");
    const id = store.createBroadcast({ title: "t", prompt: "again", executions: [
      { machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id },
      { machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id },
    ] });
    const [lost, done] = store.executions(id);
    store.update(lost!.id, { state: "lost", error: "agent 在完成前退出了" });
    store.update(done!.id, { state: "completed" });
    start();
    expect((await send(`/api/executions/${done!.id}/retry`, {})).status).toBe(400);
    expect((await send(`/api/executions/${lost!.id}/retry`, {})).status).toBe(200);
    expect(store.execution(lost!.id)!.state).toBe("queued");
    expect(store.execution(lost!.id)!.error).toBeNull();
  });

  test("the page cannot type into an agent: there is no keys endpoint", async () => {
    const agent = fake.addAgent("local", "claude", "blocked");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
    start();
    const exec = store.executions(id)[0]!.id;
    expect((await send(`/api/executions/${exec}/keys`, { keys: ["1"] })).status).toBe(404);
    expect(fake.calls().some((c) => c.includes('"send-keys"'))).toBe(false);
  });

  test("the selected agent's screen is read through herdr, with the history above it", async () => {
    const agent = fake.addAgent("local", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
    start();
    const response = await fetch(`${base}/api/executions/${store.executions(id)[0]!.id}/screen`);
    expect(((await response.json()) as { text: string }).text).toContain("fake output");
    // a TUI that cleared its screen on a resize left its conversation in the history
    expect(fake.calls().some((c) => c.includes('"--source","recent-unwrapped"') && c.includes('"--format","ansi"'))).toBe(true);
  });

  test("without herdr-web-ui, an agent is shown in Herdr itself", async () => {
    const agent = fake.addAgent("local", "claude");
    const id = store.createBroadcast({ title: "t", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "existing", pane_id: agent.pane_id, terminal_id: agent.terminal_id }] });
    start();
    const response = await send(`/api/executions/${store.executions(id)[0]!.id}/focus`, {});
    expect(response.status).toBe(200);
    expect(fake.calls().some((c) => c.includes(`"agent","focus","${agent.pane_id}"`))).toBe(true);
  });

  test("the page learns whether herdr-web-ui is there", async () => {
    start();
    const state = (await (await fetch(`${base}/api/state`)).json()) as { webUi: { installed: boolean; running: boolean } };
    expect(typeof state.webUi.installed).toBe("boolean");
    expect(typeof state.webUi.running).toBe("boolean");
  });

  test("detection: not installed and nothing answering", async () => {
    // the fake herdr knows no plugin list, and nothing listens on this port
    expect(await detectWebUi("http://127.0.0.1:9/")).toEqual({ installed: false, running: false });
  });
});
