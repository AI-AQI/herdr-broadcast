/**
 * Starting, stopping and watching the web page's server.
 *
 * Herdr's startup hooks are one-shot initialization commands, not supervised daemons
 * (https://herdr.dev/docs/plugins/), so this module owns the process the way herdr-web-ui does:
 * `start` detaches the server and waits until it answers, `stop` takes it down, `status` reports.
 * Start is idempotent — a server already answering is left alone — which is what makes it safe as
 * both the startup hook and a hand-invoked action.
 *
 * The server runs the plugin's files, and Herdr may remove an installation's files once the
 * commands launched from it have exited, which a detached server has not. So it runs a copy of
 * `src` under the plugin's state directory, keyed by a hash of it: an update writes a new copy,
 * and the server a start before it is already running stays where it was.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { loadConfig } from "../config.ts";
import { pidAlive, type Store } from "../db.ts";
import { DEFAULT_WEB_PORT, startWebServer, WEB_LOCK, webOptions, webRunning } from "./server.ts";

const STALE_MS = 20_000;
/** how long a start waits for the server to answer before saying it did not */
const READY_TIMEOUT_MS = 20_000;
/** how long a stop waits after SIGTERM before it kills */
const STOP_TIMEOUT_MS = 10_000;
/** the next ports a start tries when the default one is taken */
const FALLBACK_PORTS = [7325, 7326, 7327, 7328];

/** The plugin's state directory, where the server's log, port and runtime copy live. */
export function stateDir(store: Store): string {
  return dirname(store.path);
}

/** The port a start settled on because the default could not be opened; absent while the default serves. */
function savedPort(store: Store): number | null {
  try {
    const port = Number(readFileSync(join(stateDir(store), "web-port"), "utf8").trim());
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

/** What the running server wrote about itself: its pid, port and address. */
interface WebInfo {
  pid: number;
  port: number;
  url: string;
}

function webInfoFile(store: Store): string {
  return join(stateDir(store), "web.json");
}

/** The server's own note, if the process it names is still there. */
function readWebInfo(store: Store): WebInfo | null {
  try {
    const info = JSON.parse(readFileSync(webInfoFile(store), "utf8")) as WebInfo;
    return Number.isInteger(info.port) && typeof info.url === "string" && pidAlive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export function webUrl(store?: Store): string {
  const options = webOptions();
  const host = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
  // a port the user set is the only one they mean; otherwise the running server, then a saved one
  const configured = loadConfig().webPort;
  const info = store && !configured ? readWebInfo(store) : null;
  if (info) return info.url;
  const port = configured ?? (store ? savedPort(store) : null) ?? DEFAULT_WEB_PORT;
  return `http://${host}:${port}/`;
}

/** The ports a start tries, in order: a port the user set is theirs alone; the default gives way to the next free one. */
function candidates(store: Store): number[] {
  const configured = loadConfig().webPort;
  if (configured) return [configured];
  const saved = savedPort(store);
  return [...new Set([saved ?? DEFAULT_WEB_PORT, DEFAULT_WEB_PORT, ...FALLBACK_PORTS])];
}

/** A hash of the plugin's source: the name of the runtime copy that runs it. */
function sourceHash(): string {
  const root = join(import.meta.dir, "..");
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js|html|svg|toml)$/.test(entry.name)) hash.update(relative(root, full)).update(readFileSync(full));
    }
  };
  walk(root);
  return hash.digest("hex").slice(0, 12);
}

/** The copy of `src` the server should run, made if this version has none yet. */
function runtimeCopy(store: Store): string {
  const dir = join(stateDir(store), "runtime", sourceHash());
  const entry = join(dir, "src", "main.ts");
  if (!existsSync(entry)) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(import.meta.dir, ".."), join(dir, "src"), { recursive: true });
  }
  // older copies served earlier versions; this start's is the one to keep
  const keep = basename(dir);
  for (const other of readdirSync(join(stateDir(store), "runtime"))) {
    if (other !== keep) rmSync(join(stateDir(store), "runtime", other), { recursive: true, force: true });
  }
  return entry;
}

/** Whether the page answers at `url`: this plugin's own answer, not another program's. */
export async function webAnswers(url: string = webUrl()): Promise<boolean> {
  const token = loadConfig().webToken;
  try {
    const response = await fetch(new URL("api/state", url), {
      signal: AbortSignal.timeout(1_500),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { app?: unknown; state?: unknown };
    // another plugin's page, or the herdr-web-ui on the same port, answers differently
    return body.app === "herdr-broadcast" && typeof body.state === "object" && body.state !== null;
  } catch {
    return false;
  }
}

/** Runs the server in this process until it is told to stop. */
export async function runWeb(store: Store, log: (line: string) => void = (l) => console.log(l)): Promise<void> {
  if (!store.acquireLock(WEB_LOCK, pidAlive, STALE_MS)) {
    log(`already running: ${webUrl(store)}`);
    return;
  }
  const base = webOptions();
  let web: ReturnType<typeof startWebServer> | null = null;
  let port = 0;
  let lastError: unknown = null;
  for (const candidate of candidates(store)) {
    try {
      web = startWebServer(store, { ...base, port: candidate });
      port = candidate;
      break;
    } catch (error) {
      lastError = error;
      // a port someone else holds: the next candidate may be free. Another failure is not a port's
      const code = (error as { code?: string }).code;
      if (code !== "EADDRINUSE" && !/address already in use|is port .* in use/i.test(String(error))) {
        store.releaseLock(WEB_LOCK);
        throw error;
      }
    }
  }
  if (!web) {
    store.releaseLock(WEB_LOCK);
    throw lastError ?? new Error("no port to serve on");
  }
  // remembered only when the default gave way, so a later start, status or stop finds this one
  if (!loadConfig().webPort && port !== DEFAULT_WEB_PORT) writeFileSync(join(stateDir(store), "web-port"), String(port));
  const url = web.url;
  writeFileSync(webInfoFile(store), JSON.stringify({ pid: process.pid, port, url }));
  writeFileSync(join(stateDir(store), "web.pid"), String(process.pid));
  log(`broadcast web page: ${url}`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.on("SIGHUP", stop);
  });
  await web.stop();
  store.releaseLock(WEB_LOCK);
  rmSync(webInfoFile(store), { force: true });
  rmSync(join(stateDir(store), "web.pid"), { force: true });
}

/**
 * Starts the server detached unless one is running and answering; waits until the server it
 * started says where it is and answers there. Its output goes to web.log beside the database.
 */
export async function startWebDetached(store: Store): Promise<{ how: "running" | "started" | "failed"; url: string; error?: string }> {
  const running = webRunning(store);
  if (running && (await webAnswers(webUrl(store)))) return { how: "running", url: webUrl(store) };
  // a lock with no answer: the server is starting, wedged, or the port changed under it
  if (running) return { how: "failed", url: webUrl(store), error: `a server holds the lock but does not answer: run web-stop, then web-start (log: ${join(stateDir(store), "web.log")})` };
  // a note from a server that has since exited
  rmSync(webInfoFile(store), { force: true });
  const log = openSync(join(stateDir(store), "web.log"), "a");
  const child = spawn(process.execPath, [runtimeCopy(store), "web"], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // its own note, once it has bound: the port is the child's to settle
    const info = readWebInfo(store);
    if (info && (await webAnswers(info.url))) return { how: "started", url: info.url };
    if (child.exitCode !== null) break;
    await Bun.sleep(300);
  }
  return { how: "failed", url: webUrl(store), error: `the server did not answer within ${READY_TIMEOUT_MS / 1000} s: see ${join(stateDir(store), "web.log")}` };
}

/** Stops a running server: SIGTERM, then SIGKILL if it will not go. */
export async function stopWeb(store: Store): Promise<"stopped" | "not-running" | "failed"> {
  const pid = store.lockHolder(WEB_LOCK, pidAlive, STALE_MS);
  if (pid === null) return "not-running";
  // the group where there is one: the detached server and anything it started
  const target = process.platform === "win32" ? pid : -pid;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(target, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone between the check and the signal */
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      rmSync(webInfoFile(store), { force: true });
      return "stopped";
    }
    await Bun.sleep(200);
  }
  signal("SIGKILL");
  for (let i = 0; i < 10; i += 1) {
    if (!pidAlive(pid)) {
      rmSync(webInfoFile(store), { force: true });
      return "stopped";
    }
    await Bun.sleep(200);
  }
  return "failed";
}

/** What the server is doing, in words. */
export async function webStatus(store: Store): Promise<{ running: boolean; url: string; pid: number | null; answering: boolean; port: number | null }> {
  const pid = store.lockHolder(WEB_LOCK, pidAlive, STALE_MS);
  const info = readWebInfo(store);
  const configured = loadConfig().webPort;
  const url = webUrl(store);
  return {
    running: pid !== null,
    url,
    pid,
    answering: pid !== null && (await webAnswers(url)),
    port: configured ?? info?.port ?? savedPort(store) ?? DEFAULT_WEB_PORT,
  };
}
