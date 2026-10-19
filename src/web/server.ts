/**
 * The broadcast web page: a small HTTP server for the browser and phone, next to herdr-web-ui.
 * It shows agents' screens but never types into them except to deliver a broadcast.
 *
 * Who gets in still matters:
 * - it listens on 127.0.0.1 unless told otherwise;
 * - a request must name this server in its Host (no DNS rebinding) and, when it changes
 *   anything, come from this page's own origin (no other site posting to localhost);
 * - with `web_token` set, every request needs the token (cookie after `?token=` once, or a
 *   Bearer header): set it before exposing the port through Tailscale or a proxy.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { pidAlive, type Execution, type NewExecution, type Store } from "../db.ts";
import { Engine, READY, resolveCwd, type Machine } from "../engine.ts";
import { agentRead, herdrJson, LOCAL } from "../herdr.ts";
import { isDir, listDirs } from "./dirs.ts";
import { sanitizeKeepStyle } from "../tui/text.ts";
import { AGENT_KINDS, validCwd } from "../tui/draft.ts";
import { DEFAULT_WEB_URL, webLinkQuery } from "../weblink.ts";
import { kickWorker } from "../worker.ts";

export const WEB_LOCK = "web";
export const DEFAULT_WEB_PORT = 7318;
const HEARTBEAT_MS = 5_000;
const PUSH_EVERY_MS = 1_000;
const WEB_UI_CHECK_MS = 30_000;
const WEB_UI_PLUGIN = "devswha.herdr-web-ui";
/** how far back an agent's panel reaches */
const SCREEN_LINES = 300;
/** the page's own script and styles only; nothing frames it */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Whether herdr-web-ui is there to open an agent's conversation in. It is optional: without it
 * the page offers to show the agent in Herdr instead. Installed is read from Herdr's plugin list;
 * running from its health check, which is what decides whether links are offered.
 */
export interface WebUiStatus {
  installed: boolean;
  running: boolean;
}

export async function detectWebUi(baseUrl: string = loadConfig().webUrl ?? DEFAULT_WEB_URL): Promise<WebUiStatus> {
  let installed = false;
  try {
    const list = await herdrJson<{ result?: { plugins?: { plugin_id?: string }[] } }>(["plugin", "list", "--json"], { timeoutMs: 5_000 });
    installed = (list.result?.plugins ?? []).some((p) => p.plugin_id === WEB_UI_PLUGIN);
  } catch {
    /* an older herdr or a failed call: running still decides */
  }
  let running = false;
  try {
    // a token-protected herdr-web-ui answers 401 and is running all the same
    const response = await fetch(new URL("api/health", baseUrl), { signal: AbortSignal.timeout(1_500) });
    running = response.ok || response.status === 401;
  } catch {
    running = false;
  }
  return { installed, running };
}

export interface WebOptions {
  host: string;
  port: number;
  token: string | null;
  /** extra Host names to accept, e.g. a Tailscale name */
  hosts: string[];
}

export function webOptions(): WebOptions {
  const config = loadConfig();
  return {
    host: config.webHost ?? "127.0.0.1",
    port: config.webPort ?? DEFAULT_WEB_PORT,
    token: config.webToken,
    hosts: config.webHosts,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** For browsers that send no Sec-Fetch-Site: the Origin must be this very host. "null" never is. */
function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The page's view of everything: machines, broadcasts and each one's executions. */
export function snapshot(store: Store, engine: Engine) {
  return {
    machines: engine.machines.map((m) => ({ id: m.id, label: m.label, enabled: m.enabled, target: m.target })),
    machinesError: engine.machinesError,
    broadcasts: store.listBroadcasts().map((b) => ({
      ...b,
      executions: store.executions(b.id).map((e) => ({
        id: e.id, machine_id: e.machine_id, machine_label: engine.machineLabel(e.machine_id), target_kind: e.target_kind, agent_kind: e.agent_kind,
        agent_name: e.agent_name, cwd: e.cwd, pane_id: e.pane_id, workspace_label: e.workspace_label, state: e.state,
        note: e.note, error: e.error, session_value: e.session_value, sent_at: e.sent_at, finished_at: e.finished_at,
        web_link: e.pane_id ? webLinkQuery({ machineId: e.machine_id, workspaceId: e.workspace_id, workspaceLabel: e.workspace_label, paneId: e.pane_id }) : null,
      })),
    })),
  };
}

/**
 * Agents the form can choose, per enabled machine, and the folders new agents could start in:
 * where agents run now, most agents first. Only those: a folder used once is not offered for good.
 */
export function agentsSnapshot(_store: Store, engine: Engine) {
  const home = process.env.HOME ?? "";
  return engine.machines.filter((m) => m.enabled).map((m: Machine) => {
    const view = engine.view(m.id);
    const agents = view?.agents ?? [];
    const running = new Map<string, number>();
    for (const a of agents) {
      const cwd = a.foreground_cwd ?? a.cwd;
      if (cwd) running.set(cwd, (running.get(cwd) ?? 0) + 1);
    }
    const folders = [...running.entries()].sort((a, b) => b[1] - a[1]).map(([path, count]) => ({
      path,
      display: m.id === "local" && home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path,
      name: path.replace(/\/+$/, "").split("/").pop() || path,
      agents: count,
    }));
    return {
      machine: { id: m.id, label: m.label },
      loading: !view || view.at === 0,
      error: view?.error ?? null,
      folders,
      agents: agents.map((a) => ({
        pane_id: a.pane_id, kind: a.agent ?? a.display_agent ?? "agent", name: a.name ?? null, status: a.agent_status, ready: READY.includes(a.agent_status),
        workspace_id: a.workspace_id, workspace: view?.workspaces.find((w) => w.workspace_id === a.workspace_id)?.label ?? a.workspace_id, cwd: a.foreground_cwd ?? a.cwd ?? null, title: a.terminal_title_stripped ?? null,
      })),
    };
  });
}

interface NewBroadcastBody {
  title?: unknown;
  prompt?: unknown;
  targets?: { machine?: unknown; pane?: unknown }[];
  new?: { machine?: unknown; kind?: unknown; cwd?: unknown; count?: unknown }[];
}

/** Turns the form's answer into executions, checked against what the machines have now. */
export function executionsFrom(body: NewBroadcastBody, engine: Engine): NewExecution[] {
  const executions: NewExecution[] = [];
  for (const target of body.targets ?? []) {
    const machine = engine.machine(String(target.machine ?? ""));
    if (!machine) throw new Error(`没有这台机器：${String(target.machine)}`);
    const agent = engine.view(machine.id)?.agents.find((a) => a.pane_id === target.pane);
    if (!agent) throw new Error(`${machine.label} 上已经没有 ${String(target.pane)} 这个 agent`);
    executions.push({
      machine_id: machine.id, machine_label: machine.label, target_kind: "existing", agent_kind: agent.agent ?? agent.display_agent ?? "agent", agent_name: agent.name ?? null,
      cwd: agent.foreground_cwd ?? agent.cwd ?? null, pane_id: agent.pane_id, terminal_id: agent.terminal_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id,
      workspace_label: engine.view(machine.id)?.workspaces.find((w) => w.workspace_id === agent.workspace_id)?.label ?? null,
    });
  }
  let slot = 0;
  for (const spec of body.new ?? []) {
    const machine = engine.machine(String(spec.machine ?? ""));
    if (!machine || !machine.enabled) throw new Error(`没有可用的机器：${String(spec.machine)}`);
    const kind = String(spec.kind ?? "");
    if (!AGENT_KINDS.includes(kind)) throw new Error(`不支持的 agent 类型：${kind}`);
    const cwd = String(spec.cwd ?? "").trim();
    const problem = validCwd(machine.id, cwd);
    if (problem) throw new Error(problem);
    const count = Math.max(1, Math.min(20, Math.floor(Number(spec.count ?? 1)) || 1));
    if (machine.id === LOCAL && !isDir(resolveCwd(LOCAL, cwd))) throw new Error(`本机没有这个目录：${cwd}`);
    for (let n = 0; n < count; n += 1) {
      slot += 1;
      executions.push({ machine_id: machine.id, machine_label: machine.label, target_kind: "new", agent_kind: kind, cwd, slot });
    }
  }
  return executions;
}

/**
 * What an agent has shown lately: its history and the screen below it, not the screen alone. A
 * TUI like Claude Code clears the screen when its terminal is resized and leaves the conversation
 * in the history above, so the screen by itself can be an empty box. Unwrapped lines, so the page
 * wraps them to its own width. A Herdr that cannot read history with styles gives the screen.
 */
async function screenOf(e: Execution): Promise<string> {
  try {
    return await agentRead(e.machine_id, e.pane_id!, SCREEN_LINES, "recent-unwrapped", "ansi");
  } catch (error) {
    if (/not found/i.test(error instanceof Error ? error.message : "")) throw error;
    return agentRead(e.machine_id, e.pane_id!, 0, "visible", "ansi");
  }
}

export function startWebServer(store: Store, options: WebOptions = webOptions(), timing?: ConstructorParameters<typeof Engine>[2]) {
  const engine = new Engine(store, () => {}, timing, { startAgents: false });
  engine.start();
  try {
    return serve(store, engine, options);
  } catch (error) {
    // the port is someone else's: leave no polling engine behind, it would outlive the store
    engine.stop();
    throw error;
  }
}

function serve(store: Store, engine: Engine, options: WebOptions) {
  const page = readFileSync(join(import.meta.dir, "page.html"), "utf8");
  const script = readFileSync(join(import.meta.dir, "page.js"), "utf8");
  const icon = readFileSync(join(import.meta.dir, "icon.svg"), "utf8");
  const streams = new Set<ReadableStreamDefaultController<string>>();
  const unwatch = new Map<string, () => void>();
  let lastPushed = "";
  let webUi: WebUiStatus = { installed: false, running: false };
  const payload = () => JSON.stringify({ app: "herdr-broadcast", state: snapshot(store, engine), agents: agentsSnapshot(store, engine), webUi });
  const checkWebUi = async () => {
    webUi = await detectWebUi();
    push();
  };
  void checkWebUi();
  const webUiTimer = setInterval(() => void checkWebUi(), WEB_UI_CHECK_MS);

  /** while a page is open, keep every enabled machine's agents fresh */
  const syncWatches = () => {
    const wanted = streams.size > 0 ? new Set(engine.machines.filter((m) => m.enabled).map((m) => m.id)) : new Set<string>();
    for (const [id, stop] of unwatch) if (!wanted.has(id)) {
      stop();
      unwatch.delete(id);
    }
    for (const id of wanted) if (!unwatch.has(id)) unwatch.set(id, engine.watch(id));
  };

  const push = () => {
    syncWatches();
    if (streams.size === 0) return;
    const body = payload();
    if (body === lastPushed) return;
    lastPushed = body;
    for (const stream of streams) {
      try {
        stream.enqueue(`data: ${body}\n\n`);
      } catch {
        streams.delete(stream);
      }
    }
  };
  const pusher = setInterval(push, PUSH_EVERY_MS);
  const beat = setInterval(() => store.heartbeat(WEB_LOCK), HEARTBEAT_MS);

  const allowedHost = (host: string | null): boolean => {
    if (!host) return false;
    const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return ["localhost", "127.0.0.1", "::1", ...options.hosts].includes(name);
  };

  const execution = (id: string): Execution => {
    const e = store.execution(Number(id));
    if (!e) throw Object.assign(new Error("没有这个执行"), { status: 404 });
    if (!e.pane_id) throw Object.assign(new Error("这个执行还没有 pane"), { status: 409 });
    return e;
  };

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!allowedHost(request.headers.get("host"))) return fail(421, "bad_host", "Host 不被允许；在 web_hosts 里加上它");
      // the token, once in the address, becomes a cookie and leaves the address
      if (options.token) {
        const given = url.searchParams.get("token") ?? cookie(request, "broadcast_token") ?? request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (!sameSecret(given, options.token)) return fail(401, "token_required", "需要 token：打开 /?token=…");
        if (url.searchParams.has("token")) {
          url.searchParams.delete("token");
          return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}`, "set-cookie": `broadcast_token=${encodeURIComponent(options.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` } });
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        const site = request.headers.get("sec-fetch-site");
        if (site ? site !== "same-origin" : !sameOrigin(request.headers.get("origin"), request.headers.get("host"))) return fail(403, "cross_site", "只接受本页面发出的请求");
      }
      try {
        return await route(request, url);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return fail(status, "failed", error instanceof Error ? error.message : String(error));
      }
    },
  });

  async function route(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/" || path === "/index.html") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP } });
    }
    if (path === "/page.js") {
      return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "content-security-policy": CSP } });
    }
    if (path === "/icon.svg" || path === "/favicon.ico") {
      return new Response(icon, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=86400" } });
    }
    if (path === "/api/config") {
      const config = loadConfig();
      return json({ webUiUrl: config.webUrl, kinds: AGENT_KINDS });
    }
    if (path === "/api/state") return new Response(payload(), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    if (path === "/api/dirs") {
      // folder completion for the form; only this machine's folders are read
      if ((url.searchParams.get("machine") ?? LOCAL) !== LOCAL) return json({ suggestions: [], target: null });
      return json(listDirs(url.searchParams.get("q") ?? ""));
    }
    if (path === "/api/events") {
      let controller: ReadableStreamDefaultController<string>;
      const stream = new ReadableStream<string>({
        start(c) {
          controller = c;
          streams.add(c);
          lastPushed = "";
          c.enqueue(`data: ${payload()}\n\n`);
          syncWatches();
        },
        cancel() {
          streams.delete(controller);
          syncWatches();
        },
      });
      request.signal.addEventListener("abort", () => {
        streams.delete(controller);
        syncWatches();
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
    }
    if (path === "/api/broadcasts" && request.method === "POST") {
      const body = (await request.json()) as NewBroadcastBody;
      const prompt = typeof body.prompt === "string" ? body.prompt.replace(/\s+$/, "") : "";
      if (!prompt.trim()) throw new Error("prompt 不能为空");
      // the chosen agents are checked against a fresh read of their machines
      const named = new Set((body.targets ?? []).map((t) => String(t.machine ?? "")));
      await Promise.all([...named].filter((id) => engine.machine(id)).map((id) => engine.refresh(id)));
      const executions = executionsFrom(body, engine);
      if (executions.length === 0) throw new Error("至少选择一个 agent，或添加一个新 agent");
      const firstLine = prompt.split("\n").find((l) => l.trim())!.trim();
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : Array.from(firstLine).slice(0, 60).join("");
      const id = store.createBroadcast({ title, prompt, executions });
      // existing agents get it now; new ones and remote machines are the worker's
      for (const machine of new Set(executions.filter((e) => e.target_kind === "existing").map((e) => e.machine_id))) void engine.refresh(machine);
      const worker = await kickWorker(store);
      push();
      return json({ id, executions: executions.length, worker });
    }
    let match = /^\/api\/broadcasts\/(\d+)$/.exec(path);
    if (match && request.method === "DELETE") {
      store.deleteBroadcast(Number(match[1]));
      push();
      return json({ ok: true });
    }
    match = /^\/api\/executions\/(\d+)\/(screen|focus|cancel|retry)$/.exec(path);
    if (match) {
      const [, id, what] = match;
      if (what === "screen") {
        const e = execution(id!);
        // with its colors, as the agent drew it; only the styles survive, never a cursor move
        return json({ text: sanitizeKeepStyle(await screenOf(e)), ansi: true, at: Date.now() });
      }
      if (request.method !== "POST") return fail(405, "method", "POST only");
      if (what === "focus") {
        // the page only watches; an agent is used where it runs, here brought to the front in Herdr
        return json({ ok: true, message: await engine.focus(execution(id!)) });
      }
      const e = store.execution(Number(id));
      if (!e) return fail(404, "not_found", "没有这个执行");
      if (what === "cancel") {
        if (!engine.cancel(e)) throw new Error("这个执行现在不能取消");
      } else {
        // a turn that finished is not sent again from the page: only one that most likely never got through
        if (e.state !== "failed" && e.state !== "lost") throw new Error("只有失败或已丢失的执行可以重试");
        await engine.retry(e);
        await kickWorker(store);
      }
      push();
      return json({ ok: true });
    }
    return fail(404, "not_found", "not found");
  }

  return {
    server,
    engine,
    url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${server.port}/`,
    /** Stops serving and waits for reads and sends in flight, so the store can close after. */
    async stop() {
      clearInterval(pusher);
      clearInterval(beat);
      clearInterval(webUiTimer);
      for (const stop of unwatch.values()) stop();
      engine.stop();
      server.stop(true);
      await engine.settle();
    },
  };
}

/** Whether a web server for this database is running. */
export function webRunning(store: Store): boolean {
  return store.lockHolder(WEB_LOCK, pidAlive, HEARTBEAT_MS * 4) !== null;
}
