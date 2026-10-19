/** What a new broadcast will send, and to whom, while it is being composed. */
import { LOCAL } from "../herdr.ts";
import type { AgentInfo } from "../herdr-types.ts";

export interface ExistingPick {
  machineId: string;
  machineLabel: string;
  paneId: string;
  terminalId: string;
  tabId: string;
  workspaceId: string;
  workspaceLabel: string | null;
  kind: string;
  name: string | null;
  cwd: string | null;
}

export interface NewSpec {
  machineId: string;
  machineLabel: string;
  kind: string;
  cwd: string;
  count: number;
}

export const AGENT_KINDS = ["claude", "codex", "pi", "opencode", "gemini", "cursor", "copilot", "droid", "amp", "omp", "kimi", "qwen", "grok", "devin", "cline", "kiro", "kilo", "hermes", "agy", "mastracode", "qodercli", "letta", "maki", "muse"];

export class Draft {
  prompt = "";
  title = "";
  picks = new Map<string, ExistingPick>();
  specs: NewSpec[] = [];

  static pickKey(machineId: string, paneId: string): string {
    return `${machineId}\0${paneId}`;
  }

  toggle(machineId: string, machineLabel: string, agent: AgentInfo, workspaceLabel: string | null): void {
    const key = Draft.pickKey(machineId, agent.pane_id);
    if (this.picks.has(key)) this.picks.delete(key);
    else this.picks.set(key, {
      machineId, machineLabel, paneId: agent.pane_id, terminalId: agent.terminal_id, tabId: agent.tab_id, workspaceId: agent.workspace_id,
      workspaceLabel, kind: agent.agent ?? agent.display_agent ?? "agent", name: agent.name ?? null, cwd: agent.foreground_cwd ?? agent.cwd ?? null,
    });
  }

  get targetCount(): number {
    return this.picks.size + this.specs.reduce((n, s) => n + s.count, 0);
  }

  defaultTitle(): string {
    const first = this.prompt.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "广播";
    return first.length > 60 ? `${first.slice(0, 60)}…` : first;
  }
}

/** The folder a new agent starts in by default: the dashboard's own context, else a local agent's, else home. */
export function defaultCwd(machineId: string, localAgents: AgentInfo[]): string {
  if (machineId !== LOCAL) return "~";
  const fromContext = contextCwd();
  if (fromContext) return fromContext;
  const agent = localAgents.find((a) => a.foreground_cwd || a.cwd);
  return agent?.foreground_cwd ?? agent?.cwd ?? process.env.HOME ?? "~";
}

function contextCwd(): string | null {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (!raw) return null;
  try {
    const context = JSON.parse(raw) as Record<string, unknown>;
    const candidates: unknown[] = [
      (context.worktree as Record<string, unknown> | undefined)?.checkout_path,
      (context.focused_pane as Record<string, unknown> | undefined)?.foreground_cwd,
      (context.focused_pane as Record<string, unknown> | undefined)?.cwd,
      (context.pane as Record<string, unknown> | undefined)?.cwd,
      context.cwd,
    ];
    const found = candidates.find((c): c is string => typeof c === "string" && c.length > 0);
    return found ?? null;
  } catch {
    return null;
  }
}

/** Remote folders must be absolute or start with ~ (Herdr resolves them on that machine). */
export function validCwd(machineId: string, cwd: string): string | null {
  const trimmed = cwd.trim();
  if (trimmed === "") return "请填写目录";
  if (machineId !== LOCAL && !(trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/"))) return "远程机器的目录必须是绝对路径或以 ~ 开头";
  return null;
}
