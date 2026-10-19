# herdr-broadcast

A [Herdr](https://herdr.dev) plugin that sends **one prompt to many agents at once** and keeps a list of every broadcast, so you can see how each agent is doing and jump straight to it.

- **Broadcast** a prompt to agents that are already running, to agents it starts for you, or to both, on the local machine or on saved SSH machines.
- **Quick picker** (terminal): a popup summoned by a key. One row per broadcast; open one to see the agents running it, and `Enter` on an agent brings it to the front. A quick broadcast sends one prompt to the idle agents of this workspace or machine.
- **Web page** (browser and phone): the task list, each agent's live screen, replies, and a form for new broadcasts.
- **Runs in the background**: queued prompts go out, finished turns are recorded and new agents start with nothing open.
- **Parallel broadcasts**: any number can run at the same time. If two target the same agent, they are queued so they don't land in one conversation together.
- **SSH machines**: list, add, remove, enable/disable, rename and reconnect Herdr's saved machines (`herdr machine`).
- **Command line**: `send` broadcasts from a script.

The picker and the background work follow [herdr-plus](https://github.com/cloudmanic/herdr-plus): summoned with a key, a picker does its job and gets out of the way, while Herdr's event hooks and a short-lived worker carry the broadcasts.

## Install

Requires Herdr 0.9.0+ and [Bun](https://bun.sh) 1.1+.

```bash
herdr plugin link /path/to/herdr-broadcast      # local checkout
# or, once published:
herdr plugin install <owner>/herdr-broadcast
```

Bind keys in Herdr's `config.toml` (Herdr has no action menu of its own), then reload it with `prefix+shift+r`:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "herdr-broadcast.quick"
description = "broadcast picker"
```

The SSH machines page is `herdr-broadcast.machines`; bind it the same way if you like.

### Quick picker

`herdr-broadcast.quick` opens a popup in the manner of herdr-plus's Quick Actions: type to filter, `↑↓` to move, `Enter` to run, `Esc` to go back or close. Typing is the filter's, so actions take Ctrl:

- **广播任务**: one row per broadcast. `Enter` lists the agents running it (`#3 claude · ✓ 已完成 · 修登录 bug`); `Enter` on one brings it to the front and closes the popup. On a broadcast: `Ctrl+X` cancels its queued executions, `Ctrl+D` deletes the record. On an agent: `Ctrl+O` full output, `Ctrl+R` retry, `Ctrl+X` cancel (queued) or stop tracking (running).
- **快速广播**: send one prompt to the idle agents of the current workspace, or of this machine (`Enter` sends, `Alt+Enter` adds a line); or **新建广播…** to choose agents yourself, busy, remote or new ones included.

A popup has no pane id, so herdr-web-ui may not show it; in the browser use the web page, or `quick_placement = "zoomed"`.

In herdr-web-ui, the same actions are in the command palette (`Mod+Shift+K`, search "Broadcast"). From a shell: `herdr plugin action invoke herdr-broadcast.quick`.

### Web page

A page of its own for the browser and the phone, next to herdr-web-ui: **http://127.0.0.1:7318**. It starts with Herdr (the startup hook); **Broadcast: 网页** starts it by hand, **Broadcast: 网页状态** reports whether it is running and answering, and **Broadcast: 停止网页** stops it.

The server is a process of its own, as herdr-web-ui's is: the startup hook (and the action) starts it detached, leaves a copy of the plugin under its state directory to run, and waits until the page answers. Start is idempotent. If the default port is taken it serves on the next free one (7325 and up), remembers it in `web-port` beside the database, and prints the address; a `web_port` you set is used as is. Stop sends SIGTERM and then SIGKILL.

- **新建广播**: two tabs, new agents (the default) and agents already running, then the prompt in the box at the bottom (`Enter` sends, `Shift+Enter` adds a line). New agents start in a fresh session: pick the type, then `+` beside a folder where agents run now, or type another folder (on this machine, the folders under what you type are suggested). Running agents are ticked, busy ones queue.
- **Task list**: every broadcast, and in it every agent's screen, live and read-only, side by side.
- **Using an agent** happens where it runs: **在 Herdr 里打开** brings it to the front in Herdr; with [herdr-web-ui](https://github.com/devswha/herdr-web-ui) running, **打开对话 / 打开终端** open its chat or terminal there, always in the same browser tab. herdr-web-ui is optional: the page notices whether it is running.

Who gets in: it listens on 127.0.0.1, accepts only its own Host names (`localhost`, `127.0.0.1`, and `web_hosts`), and takes changes only from its own page. To reach it from a phone, set `web_token` first, then serve the port through Tailscale (`tailscale serve --bg --https=8443 http://127.0.0.1:7318`, adding the Tailscale name to `web_hosts`) or an SSH tunnel, and open `/?token=…` once on each device.

## Using it

| Screen | Keys |
|---|---|
| New broadcast · prompt | type (Enter = newline) · `Ctrl+O` edit in `$EDITOR` · `Tab` next |
| New broadcast · agents | `Space` select an agent (on a machine row: all its agents) · `a` add new agents · `x` remove · `Tab` next |
| New broadcast · confirm | edit the title · `Enter` send |
| SSH machines | `a` add · `x` remove · `e` enable/disable · `n` rename · `c` reconnect · `s` check status |

### How an execution runs

| State | Meaning |
|---|---|
| queued | waiting: the agent is busy, waiting for approval, or busy with another broadcast |
| starting | creating the workspace / tab and starting the agent |
| sent → running | prompt submitted; the agent has started its turn |
| needs input | the agent is waiting for approval or a question |
| done | the agent finished the turn this prompt started |
| lost | the agent left the pane before finishing |

Completion uses Herdr's `completion_seq`: a finished turn numbered after the prompt went in belongs to this execution, so a turn that starts and ends between two polls still counts.

A prompt for an existing agent is typed into its input box, as if from the keyboard: an unsent draft already in that box goes out with it. Check the box is empty before broadcasting to an agent you were typing into.

New agents get names like `bc12-claude-1`. A broadcast's new agents on one machine share one workspace (`📡12 <title>`), one tab each, every tab in its agent's own folder and named for it (`claude-1 · app`): one broadcast is one workspace to find and to close.

### What runs in the background

Nothing has to stay open:

- **Event hook** (`pane.agent_status_changed`, `pane.exited`): when a local agent that carries a broadcast changes state, a short-lived process sends its next queued prompt and records a finished turn, then exits. Other panes are skipped without calling Herdr.
- **Worker** (the `worker` action): started when a broadcast is sent, and at Herdr startup when something is pending. It starts new agents and follows SSH machines, whose agent events fire on that machine's Herdr, where this plugin is not installed. It exits 20 seconds after the last execution ends. One worker runs at a time.
- **The pickers** only show and edit. They never start agents themselves, so closing one mid-way leaves nothing half-made.

State is in SQLite under the plugin's state directory, one database per Herdr session (`broadcast.sqlite`, `broadcast-<session>.sqlite`). Every step that writes to an agent is claimed in the database first, so the hook, the worker and any open picker never send a prompt twice.

### Settings

`config.toml` in `herdr plugin config-dir herdr-broadcast`:

```toml
quick_placement = "popup"       # the quick picker: popup (default) | overlay | split | tab | zoomed
placement = "zoomed"            # the SSH machines page: zoomed (default) | overlay | popup | split | tab
web_url = "http://localhost:7317/"  # herdr-web-ui's address, for the links (e.g. your Tailscale URL)

web_port = 7318                 # the broadcast web page
web_host = "127.0.0.1"          # what it listens on
web_token = "…"                 # required from every browser once set
web_hosts = ["mypc.tail1234.ts.net"]  # Host names to accept besides localhost
web_autostart = true            # start it with Herdr
```

### Command line

```bash
bun src/main.ts send --prompt "Review the diff" --to w2:p1 --to gpu-box/w1:p3
bun src/main.ts send --prompt "Fix the flaky test" --new claude@~/src/app*2
bun src/main.ts list
```

`--to` names a running agent's pane, `--new KIND@DIR[*COUNT]` starts agents; prefix either with a saved machine's id or label and `/` for an SSH machine.

## Browser links (herdr-web-ui)

The web page's **在 herdr-web-ui 打开** uses herdr-web-ui's own address format:

```
http://localhost:7317/?ws=w12-12-check-login&pane=w12:p1&view=chat
```

(`?machine=&ws=&pane=&view=`; for SSH machines, `machine` is herdr-web-ui's id for the saved Herdr profile.)

Known limits:

- herdr-web-ui's chat shows the **current** conversation in a pane. If the pane later starts another conversation, the link opens that one. The execution keeps the session id it ran in.
- Machines added through herdr-web-ui's own "Add PC" are not Herdr saved machines. This plugin only uses `herdr machine` profiles.

## SSH machines

The machines page wraps `herdr machine`. Adding a machine and reconnecting are interactive (host keys, passwords, picking a remote session, approving a server install), so the picker steps aside and runs them in the terminal. Removing a machine only forgets the connection: remote sessions and agents keep running.

On a remote machine, Herdr resolves folders there: use an absolute path or `~/…`.

## Development

```bash
bun install          # dev dependencies (types, tsc) only; the plugin has no runtime dependencies
bun test             # runs against a fake herdr CLI (test/fake-herdr.ts)
bun run typecheck
HERDR_BROADCAST_SESSION=test bun src/main.ts tui   # against `herdr --session test`
```

`scripts/e2e-real.ts` runs against an isolated `herdr --session <name> server` with `scripts/fake-agent.ts` standing in for an agent, so it spends no tokens. Note: starting a named session's server also runs every installed plugin's startup hook in it. herdr-web-ui's hook moves the web UI over to that session; afterwards restart it in your normal session (`herdr plugin action invoke devswha.herdr-web-ui.stop`, then `.start`).
