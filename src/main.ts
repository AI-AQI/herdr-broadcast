#!/usr/bin/env bun
/**
 * herdr-broadcast entry point. The plugin's interface is its web page; these are what the
 * manifest runs, and a command line for scripts.
 *
 *   worker             start new agents and follow remote machines until nothing is left (an action)
 *   web                the broadcast web page's server, in the foreground
 *   web-start/web-stop start it detached (the startup hook and an action) / stop it
 *   web-status         whether it is running and answering
 *   hook               the [[startup]] and [[events]] hook
 *   send ...           broadcast from the command line (see usage)
 *   list               print broadcasts and their executions
 */
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Store, type NewExecution } from "./db.ts";
import { agentGet, HerdrError, LOCAL, machineList } from "./herdr.ts";
import { kickWorker, runHook, runWorker } from "./worker.ts";
import { runWeb, startWebDetached, stateDir, stopWeb, webStatus } from "./web/launch.ts";

const USAGE = `usage:
  main.ts web | web-start | web-stop | web-status
  main.ts worker
  main.ts hook
  main.ts list
  main.ts send --prompt TEXT [--title TEXT] [--to [MACHINE/]PANE]... [--new [MACHINE/]KIND@DIR[*COUNT]]...
      --to     an agent already running, e.g. --to w2:p1 or --to gpu-box/w1:p3
      --new    agents to start, e.g. --new claude@~/src/app*2 or --new gpu-box/codex@~/repo
      MACHINE is a saved machine's id or label; without one it is this machine.`;

function list(): void {
  const store = new Store();
  for (const b of store.listBroadcasts()) {
    console.log(`#${b.id}  ${b.title}  (${b.total})  ${JSON.stringify(b.counts)}`);
    for (const e of store.executions(b.id)) {
      console.log(`    ${e.id}  ${e.machine_label}  ${e.agent_kind ?? "?"}  ${e.pane_id ?? "-"}  ${e.state}${e.note ? `  · ${e.note}` : ""}${e.error ? `  ! ${e.error}` : ""}`);
    }
  }
  store.close();
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === name && args[i + 1] !== undefined) values.push(args[++i]!);
  return values;
}

async function send(args: string[]): Promise<void> {
  const prompt = flagValues(args, "--prompt")[0];
  if (!prompt) throw new Error(`--prompt is required\n${USAGE}`);
  const profiles = await machineList().catch(() => []);
  const machineOf = (spec: string): { id: string; label: string; rest: string } => {
    const slash = spec.indexOf("/");
    // a local folder may hold slashes: a machine prefix is the part before the first one, if it names a machine
    const head = slash > 0 ? spec.slice(0, slash) : "";
    const profile = head ? profiles.find((p) => p.id === head || p.label === head) : undefined;
    if (profile) return { id: profile.id, label: profile.label, rest: spec.slice(slash + 1) };
    if (head === LOCAL) return { id: LOCAL, label: "本机", rest: spec.slice(slash + 1) };
    return { id: LOCAL, label: "本机", rest: spec };
  };
  const executions: NewExecution[] = [];
  for (const spec of flagValues(args, "--to")) {
    const { id, label, rest } = machineOf(spec);
    const agent = await agentGet(id, rest);
    executions.push({ machine_id: id, machine_label: label, target_kind: "existing", agent_kind: agent.agent ?? "agent", agent_name: agent.name ?? null, cwd: agent.foreground_cwd ?? agent.cwd ?? null,
      pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id });
  }
  let slot = 0;
  for (const spec of flagValues(args, "--new")) {
    const { id, label, rest } = machineOf(spec);
    const match = /^([a-z0-9_-]+)@(.+?)(?:\*(\d+))?$/.exec(rest);
    if (!match) throw new Error(`--new ${spec}: expected KIND@DIR[*COUNT]`);
    for (let n = 0; n < Number(match[3] ?? "1"); n += 1) {
      slot += 1;
      executions.push({ machine_id: id, machine_label: label, target_kind: "new", agent_kind: match[1]!, cwd: match[2]!, slot });
    }
  }
  if (executions.length === 0) throw new Error(`no targets: give --to or --new\n${USAGE}`);
  const store = new Store();
  const title = flagValues(args, "--title")[0] ?? prompt.split("\n").find((l) => l.trim())!.trim().slice(0, 60);
  const id = store.createBroadcast({ title, prompt, executions });
  const worker = await kickWorker(store);
  console.log(`broadcast #${id}: ${executions.length} execution(s), worker ${worker}`);
  store.close();
}

const [command = "", ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "worker": {
      const store = new Store();
      await runWorker(store);
      store.close();
      break;
    }
    case "web": {
      const store = new Store();
      await runWeb(store);
      store.close();
      break;
    }
    case "web-start": {
      const store = new Store();
      const result = await startWebDetached(store);
      console.log(result.how === "running" ? `already running: ${result.url}` : result.how === "started" ? `started: ${result.url}` : `could not start: ${result.error}`);
      store.close();
      if (result.how === "failed") process.exit(1);
      break;
    }
    case "web-stop": {
      const store = new Store();
      const how = await stopWeb(store);
      console.log(how === "stopped" ? "stopped" : how === "not-running" ? "not running" : "could not stop it: it is still running");
      store.close();
      break;
    }
    case "web-status": {
      const store = new Store();
      const status = await webStatus(store);
      console.log(
        status.pid === null
          ? `not running (${status.url})`
          : status.answering
            ? `running, pid ${status.pid}: ${status.url}`
            : `running, pid ${status.pid}, but ${status.url} does not answer: see ${join(stateDir(store), "web.log")}`,
      );
      store.close();
      break;
    }
    case "hook": {
      const store = new Store();
      console.log(await runHook(store, process.env.HERDR_PLUGIN_EVENT, process.env.HERDR_PLUGIN_EVENT_JSON));
      // the web page comes up with Herdr, as herdr-web-ui does
      if (process.env.HERDR_PLUGIN_EVENT === "startup" && loadConfig().webAutostart) {
        const result = await startWebDetached(store);
        console.log(`web page ${result.how}: ${result.url}${result.error ? ` (${result.error})` : ""}`);
      }
      store.close();
      break;
    }
    case "send":
      await send(rest);
      break;
    case "list":
      list();
      break;
    default:
      console.error(USAGE);
      process.exit(2);
  }
} catch (error) {
  console.error(error instanceof HerdrError ? `herdr-broadcast: ${error.code}: ${error.message}` : `herdr-broadcast: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
