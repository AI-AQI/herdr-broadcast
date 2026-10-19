#!/usr/bin/env bun
/**
 * A stand-in for the herdr CLI, for tests: keeps a tiny server state in $FAKE_HERDR_STATE (JSON)
 * and answers the commands the plugin uses with Herdr's JSON shapes. Tests drive agent states by
 * editing the same file. `--machine <id>` selects a separate state per machine.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

interface Agent {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  agent: string;
  name: string | null;
  agent_status: string;
  state_change_seq: number;
  completion_seq: number | null;
  cwd: string;
  agent_session?: { agent: string; kind: string; source: string; value: string } | null;
  /** reports itself through `pane report-agent`: Herdr's agent prompt refuses it */
  custom?: boolean;
}

interface ServerState {
  next: number;
  workspaces: { workspace_id: string; label: string; active_tab_id: string }[];
  tabs: { tab_id: string; workspace_id: string; label: string }[];
  panes: { pane_id: string; tab_id: string; workspace_id: string; terminal_id: string; cwd: string }[];
  agents: Agent[];
  prompts: { pane_id: string; text: string }[];
  /** text written with pane send-text */
  typed?: { pane_id: string; text: string }[];
  /** error codes the next calls of a command answer with, e.g. {"agent start": ["pane_busy"]} */
  failNext?: Record<string, string[]>;
  unreachable?: boolean;
}

interface State {
  machines: { id: string; label: string; target: string; session: string; enabled: boolean }[];
  servers: Record<string, ServerState>;
}

const file = process.env.FAKE_HERDR_STATE!;
let args = process.argv.slice(2);
let machine = "local";
if (args[0] === "--machine") {
  machine = args[1]!;
  args = args.slice(2);
}
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, `${machine} ${JSON.stringify(args)}\n`);
const command = `${args[0]} ${args[1]}`;

/** Reads must not write: concurrent calls would put back a stale copy over another's change. */
const MUTATING = new Set(["agent prompt", "agent start", "workspace create", "tab create", "pane send-text", "pane send-keys"]);
const lockDir = `${file}.lock`;
let locked = false;
/** Mutations (and any call that may consume an injected failure) hold a lock from read to write. */
function lock(): void {
  for (let i = 0; i < 2000; i += 1) {
    try {
      mkdirSync(lockDir);
      locked = true;
      return;
    } catch {
      Bun.sleepSync(2);
    }
  }
  throw new Error("fake herdr: lock timeout");
}
function unlock(): void {
  if (locked) rmSync(lockDir, { recursive: true, force: true });
  locked = false;
}
lock();
const state: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { machines: [], servers: {} };
const server: ServerState = (state.servers[machine] ??= { next: 1, workspaces: [], tabs: [], panes: [], agents: [], prompts: [] });
const injected = server.failNext?.[command];
const injectedNow = !!injected && injected.length > 0;
if (!MUTATING.has(command) && !injectedNow) unlock();

function save(): void {
  if (MUTATING.has(command) || injectedNow) writeFileSync(file, JSON.stringify(state, null, 2));
  unlock();
}

function ok(result: unknown): never {
  save();
  process.stdout.write(JSON.stringify({ id: `cli:${args[0]}:${args[1]}`, result }) + "\n");
  process.exit(0);
}

function fail(code: string, message = code): never {
  save();
  process.stderr.write(JSON.stringify({ id: `cli:${args[0]}:${args[1]}`, error: { code, message } }) + "\n");
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

if (injectedNow) fail(injected!.shift()!);
if (machine !== "local" && server.unreachable) fail("machine_unreachable", "ssh: connect to host failed");

function newPane(workspace_id: string, tab_id: string, cwd: string) {
  const n = server.next++;
  const pane = { pane_id: `${workspace_id}:p${n}`, tab_id, workspace_id, terminal_id: `term_${machine}_${n}`, cwd };
  server.panes.push(pane);
  return pane;
}

function findAgent(target: string): Agent {
  const agent = server.agents.find((a) => a.pane_id === target || a.name === target);
  if (!agent) fail("agent_not_found", `no agent ${target}`);
  return agent;
}

switch (command) {
  case "machine list":
    process.stdout.write(JSON.stringify(state.machines) + "\n");
    process.exit(0);
  case "agent list":
    ok({ type: "agent_list", agents: server.agents.map((a) => ({ ...a, focused: false })) });
  case "agent get":
    ok({ type: "agent_info", agent: { ...findAgent(args[2]!), focused: false } });
  case "agent prompt": {
    const agent = findAgent(args[2]!);
    if (agent.agent_status === "blocked") fail("agent_blocked");
    if (agent.custom) fail("agent_not_ready", `agent ${agent.pane_id} is not an active named agent`);
    server.prompts.push({ pane_id: agent.pane_id, text: args[3]! });
    ok({ type: "agent_prompt" });
  }
  case "pane send-text": {
    const pane = server.panes.find((p) => p.pane_id === args[2]) ?? fail("pane_not_found");
    (server.typed ??= []).push({ pane_id: pane.pane_id, text: args[3]! });
    ok({ type: "ok" });
  }
  case "pane send-keys": {
    const pane = server.panes.find((p) => p.pane_id === args[2]) ?? fail("pane_not_found");
    const typed = (server.typed ??= []).filter((t) => t.pane_id === pane.pane_id).pop();
    if (args.slice(3).includes("enter") && typed) server.prompts.push({ pane_id: pane.pane_id, text: typed.text });
    ok({ type: "ok" });
  }
  case "agent focus":
  case "agent send-keys":
    findAgent(args[2]!);
    ok({ type: "ok" });
  case "agent read":
    findAgent(args[2]!);
    ok({ type: "pane_read", read: { text: "fake output\nline 2\n" } });
  case "agent start": {
    const name = args[2]!;
    const pane = server.panes.find((p) => p.pane_id === flag("--pane"));
    if (!pane) fail("pane_not_found");
    const n = server.next++;
    const agent: Agent = { pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id, agent: flag("--kind")!, name, agent_status: process.env.FAKE_START_BLOCKED ? "blocked" : "idle", state_change_seq: n, completion_seq: null, cwd: pane.cwd };
    server.agents.push(agent);
    if (process.env.FAKE_START_BLOCKED) fail("agent_not_ready");
    ok({ type: "agent_started", agent: { ...agent, focused: false } });
  }
  case "workspace list":
    ok({ type: "workspace_list", workspaces: server.workspaces });
  case "workspace create": {
    const id = `w${server.next++}`;
    const tab = { tab_id: `${id}:t1`, workspace_id: id, label: "1" };
    const workspace = { workspace_id: id, label: flag("--label") ?? id, active_tab_id: tab.tab_id };
    server.workspaces.push(workspace);
    server.tabs.push(tab);
    const root = newPane(id, tab.tab_id, flag("--cwd") ?? "/");
    ok({ type: "workspace_created", workspace, tab, root_pane: { ...root, agent_status: "unknown" } });
  }
  case "tab create": {
    const workspace = server.workspaces.find((w) => w.workspace_id === flag("--workspace"));
    if (!workspace) fail("workspace_not_found");
    const tab = { tab_id: `${workspace.workspace_id}:t${server.next++}`, workspace_id: workspace.workspace_id, label: flag("--label") ?? "" };
    server.tabs.push(tab);
    const root = newPane(workspace.workspace_id, tab.tab_id, flag("--cwd") ?? "/");
    ok({ type: "tab_created", tab, root_pane: { ...root, agent_status: "unknown" } });
  }
  case "tab rename":
  case "tab focus":
  case "workspace focus":
    ok({ type: "ok" });
  case "plugin action":
    ok({ type: "plugin_action_invoked" });
  default:
    fail("usage", `fake herdr does not know: ${args.join(" ")}`);
}
