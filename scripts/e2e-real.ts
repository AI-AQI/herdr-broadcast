/**
 * End-to-end check against a real herdr server, without spending tokens on a real agent.
 * Two panes run scripts/fake-agent.ts (it reports its own states the way an agent integration
 * does); the engine broadcasts to both, and a second broadcast to one of them has to wait its turn.
 *
 *   herdr --session bctest server &          # an isolated server
 *   HERDR_BROADCAST_SESSION=bctest bun scripts/e2e-real.ts
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type NewExecution } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { agentList, herdrResult, runHerdr } from "../src/herdr.ts";
import type { AgentInfo } from "../src/herdr-types.ts";

if (!process.env.HERDR_BROADCAST_SESSION) {
  console.error("set HERDR_BROADCAST_SESSION to an isolated herdr session (see the comment at the top)");
  process.exit(2);
}

const say = (...a: unknown[]) => console.log("[e2e]", ...a);
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}

interface Created {
  workspace: { workspace_id: string };
  root_pane: { pane_id: string };
}

const fakeAgent = join(import.meta.dir, "fake-agent.ts");
const workspaces: string[] = [];
async function fake(label: string): Promise<AgentInfo> {
  const created = await herdrResult<Created>(["workspace", "create", "--cwd", tmpdir(), "--label", label, "--no-focus"]);
  workspaces.push(created.workspace.workspace_id);
  const pane = created.root_pane.pane_id;
  await Bun.sleep(500);
  await herdrResult(["pane", "run", pane, `${process.execPath} ${fakeAgent} fakebot 2`]);
  let agent: AgentInfo | undefined;
  await until(async () => {
    agent = (await agentList("local")).find((a) => a.pane_id === pane && a.agent_status === "idle");
    return !!agent;
  }, `fake agent in ${pane}`);
  return agent!;
}

const existing = (a: AgentInfo): NewExecution => ({ machine_id: "local", machine_label: "本机", target_kind: "existing", agent_kind: a.agent ?? "claude", pane_id: a.pane_id, terminal_id: a.terminal_id, workspace_id: a.workspace_id, tab_id: a.tab_id });

const dbPath = join(tmpdir(), `herdr-broadcast-e2e-${process.pid}.sqlite`);
const store = new Store(dbPath);
const engine = new Engine(store, () => {}, { tickMs: 100, localPollMs: 300 });
try {
  const one = await fake("e2e one");
  const two = await fake("e2e two");
  say("fake agents:", one.pane_id, two.pane_id);

  const a = store.createBroadcast({ title: "A", prompt: "broadcast A", executions: [existing(one), existing(two)] });
  const b = store.createBroadcast({ title: "B", prompt: "broadcast B", executions: [existing(one)] });
  engine.start();
  const states = (id: number) => store.executions(id).map((e) => e.state);
  const show = () => say("A:", states(a).join(","), " B:", states(b).join(","), store.executions(b)[0]!.note ?? "");

  await until(() => states(a).every((s) => s === "sent" || s === "working" || s === "completed"), "A sent to both").catch((error) => {
    for (const e of store.executions(a)) say(e.pane_id, e.state, e.note ?? "", e.error ?? "");
    throw error;
  });
  show();
  if (states(b)[0] !== "queued") throw new Error("B should wait for A on agent one");
  await until(() => states(a).every((s) => s === "completed"), "A completed");
  show();
  await until(() => states(b)[0] === "completed", "B completed after A");
  show();

  const text = (await runHerdr(["pane", "read", one.pane_id, "--source", "recent", "--lines", "12"])).stdout;
  say("agent one saw:\n" + text.split("\n").filter((l) => l.includes("received") || l.includes("done")).join("\n"));
  if (!(text.indexOf("received: broadcast A") < text.indexOf("received: broadcast B"))) throw new Error("agent one did not get A before B");
  for (const e of [...store.executions(a), ...store.executions(b)]) say(`#${e.broadcast_id} ${e.pane_id} seq_before=${e.seq_before} ${e.state} ${e.sent_at && e.finished_at ? `${e.finished_at - e.sent_at}ms` : ""}`);
  say("OK");
} finally {
  engine.stop();
  store.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  for (const ws of workspaces) await herdrResult(["workspace", "close", ws]).catch(() => undefined);
}
process.exit(0);
