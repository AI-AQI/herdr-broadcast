import { describe, expect, test } from "bun:test";
import { sanitizeKeepStyle } from "../src/text.ts";
import { slugOf, webLink, webMachineId } from "../src/weblink.ts";
import { agentNameFor, resolveCwd, shapePrompt, tabLabelFor, workspaceLabelFor } from "../src/engine.ts";
import { defaultDbPath, sessionName, Store } from "../src/db.ts";
import { listDirs } from "../src/web/dirs.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

describe("folders for the form", () => {
  test("suggests the folders under what is typed, hidden ones only when a dot is typed", () => {
    const root = mkdtempSync(join(tmpdir(), "bcast-dirs-"));
    try {
      for (const dir of ["app/src", "api", "docs", ".cache"]) mkdirSync(join(root, dir), { recursive: true });
      expect(listDirs(`${root}/`).suggestions.map((s) => s.value)).toEqual([`${root}/api/`, `${root}/app/`, `${root}/docs/`]);
      expect(listDirs(`${root}/a`).suggestions.map((s) => s.value)).toEqual([`${root}/api/`, `${root}/app/`]);
      expect(listDirs(`${root}/.`).suggestions.map((s) => s.value)).toEqual([`${root}/.cache/`]);
      expect(listDirs(`${root}/app/`).suggestions.map((s) => s.value)).toEqual([`${root}/app/src/`]);
      expect(listDirs(`${root}/app`).target).toEqual({ exists: true });
      expect(listDirs(`${root}/nope`).target).toEqual({ exists: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("~ is the home folder", () => {
    expect(listDirs("~").suggestions.every((s) => s.value.startsWith("~/"))).toBe(true);
  });
});

describe("text", () => {
  test("a screen keeps its colors and styles, and loses everything that would move a cursor", () => {
    const styled = "\x1b[1;38;2;215;119;87m✻ Claude\x1b[0m \x1b[38;5;244mready\x1b[39m";
    expect(sanitizeKeepStyle(styled)).toBe(styled);
    expect(sanitizeKeepStyle("\x1b[2J\x1b[Ha\x1b[?25lb\x1b]0;title\x07c\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\\r\nd\x1b(B\x1b7e")).toBe("abclink\nde");
  });
});

describe("herdr-web-ui links", () => {
  test("local links name the workspace and pane; remote ones the derived machine id", () => {
    const local = new URL(webLink({ machineId: "local", workspaceId: "w3", workspaceLabel: "📡12 Check login", paneId: "w3:p2" }, "http://localhost:7317/"));
    expect(local.searchParams.get("machine")).toBeNull();
    expect(local.searchParams.get("ws")).toBe("w3-12-check-login");
    expect(local.searchParams.get("pane")).toBe("w3:p2");
    expect(local.searchParams.get("view")).toBe("chat");

    const remote = new URL(webLink({ machineId: "prof-1", workspaceId: "w1", paneId: "w1:p1", view: "terminal" }, "http://localhost:7317/"));
    expect(remote.searchParams.get("machine")).toBe(webMachineId("prof-1"));
    expect(remote.searchParams.get("view")).toBe("terminal");
  });

  test("the machine id matches herdr-web-ui's herdrMachineId", () => {
    // sha256("herdr-profile:abc") = 2d1c3c3b...; shape is a UUID
    expect(webMachineId("abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("slugs follow herdr-web-ui", () => {
    expect(slugOf("Café API")).toBe("cafe-api");
    expect(slugOf("检查登录")).toBe("");
    expect(slugOf("a very long workspace name that goes on")).toBe("a-very-long-workspace");
  });
});

describe("the database", () => {
  test("an older database loses its worktree columns and keeps its broadcasts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcast-db-"));
    const path = join(dir, "old.sqlite");
    try {
      // a version 3 database, as an older plugin left it
      const old = new Database(path, { create: true });
      old.exec(`
        CREATE TABLE broadcasts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
          machine_id TEXT NOT NULL, machine_label TEXT NOT NULL, target_kind TEXT NOT NULL, agent_kind TEXT, agent_name TEXT, cwd TEXT,
          worktree_branch TEXT, trust_repository INTEGER NOT NULL DEFAULT 0, slot INTEGER NOT NULL DEFAULT 0,
          workspace_id TEXT, workspace_label TEXT, tab_id TEXT, pane_id TEXT, terminal_id TEXT, session_kind TEXT, session_value TEXT,
          state TEXT NOT NULL, seq_before INTEGER, saw_working INTEGER NOT NULL DEFAULT 0, error TEXT, note TEXT, owner_pid INTEGER,
          created_at INTEGER NOT NULL, sent_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL);
        CREATE TABLE locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, heartbeat INTEGER NOT NULL);
        INSERT INTO broadcasts (title, prompt, created_at) VALUES ('旧广播', 'p', 1);
        INSERT INTO executions (broadcast_id, machine_id, machine_label, target_kind, cwd, worktree_branch, state, created_at, updated_at)
          VALUES (1, 'local', '本机', 'new', '/src', 'broadcast/1-claude-1', 'completed', 1, 1);
        PRAGMA user_version = 3;
      `);
      old.close();
      const store = new Store(path);
      try {
        const columns = new Set(store.db.query<{ name: string }, []>("PRAGMA table_info(executions)").all().map((c) => c.name));
        expect(columns.has("worktree_branch")).toBe(false);
        expect(columns.has("trust_repository")).toBe(false);
        expect(store.listBroadcasts().map((b) => b.title)).toEqual(["旧广播"]);
        expect(store.executions(1)[0]!.cwd).toBe("/src");
        // and a new one writes the same schema
        store.createBroadcast({ title: "新", prompt: "p", executions: [{ machine_id: "local", machine_label: "本机", target_kind: "new", cwd: "/src", slot: 1 }] });
        expect(store.executions(2)[0]!.state).toBe("queued");
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("names", () => {
  test("each herdr session has its own database", () => {
    const saved = { ...process.env };
    delete process.env.HERDR_BROADCAST_SESSION;
    process.env.HERDR_SOCKET_PATH = "/Users/x/.config/herdr/herdr.sock";
    expect(sessionName()).toBe("default");
    process.env.HERDR_SOCKET_PATH = "/Users/x/.config/herdr/sessions/bctest/herdr.sock";
    expect(sessionName()).toBe("bctest");
    process.env.HERDR_PLUGIN_STATE_DIR = "/tmp/herdr-broadcast-session-test";
    expect(defaultDbPath()).toBe("/tmp/herdr-broadcast-session-test/broadcast-bctest.sqlite");
    process.env = saved;
  });

  test("agent names fit Herdr's pattern", () => {
    const name = agentNameFor(12345, "Claude Code!", 3);
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(name).toBe("bc12345-claudecode-3");
  });

  test("a prompt ending in an @mention gets a space so Enter sends it", () => {
    expect(shapePrompt("look at @src/app.ts")).toBe("look at @src/app.ts ");
    expect(shapePrompt("mail me@example.com please")).toBe("mail me@example.com please");
  });

  test("workspace and tab labels", () => {
    expect(Array.from(workspaceLabelFor(7, "x".repeat(100))).length).toBe(36);
    expect(tabLabelFor("codex", 2, "/src/app/")).toBe("codex-2 · app");
  });

  test("local ~ is expanded, remote ~ is left for the remote machine", () => {
    expect(resolveCwd("local", "~/repo")).toBe(`${process.env.HOME}/repo`);
    expect(resolveCwd("m-1", "~/repo")).toBe("~/repo");
  });
});
