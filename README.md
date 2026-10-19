# herdr-broadcast

A [Herdr](https://herdr.dev) plugin that sends **one prompt to many agents at once** from a web page, and shows every agent's screen while it works.

- **Broadcast** a prompt to agents that are already running, to agents it starts for you, or to both, on the local machine or on Herdr's saved SSH machines.
- **Watch** every broadcast: each agent's live screen, read-only, side by side, with who is running, waiting for input, done or failed.
- **Runs in the background**: queued prompts go out, finished turns are recorded and new agents start with no page open.
- **Parallel broadcasts**: any number can run at the same time. If two target the same agent, they are queued so they don't land in one conversation together.

## Install

Requires Herdr 0.9.0+ and [Bun](https://bun.sh) 1.1+ (the plugin runs its TypeScript with Bun; it has no other dependencies).

```bash
herdr plugin install AI-AQI/herdr-broadcast
```

Then open **http://127.0.0.1:7318**. The page starts with Herdr; after installing, start it once by hand (or restart Herdr):

```bash
herdr plugin action invoke herdr-broadcast.web
```

## The web page

- **新建广播**: two tabs, new agents (the default) and agents already running, then the prompt in the box at the bottom (`Enter` sends, `Shift+Enter` adds a line). New agents start in a fresh session: pick the type, then `+` beside a folder where agents run now, or type another folder (on this machine, the folders under what you type are suggested). Running agents are ticked; busy ones queue.
- **A broadcast**: its prompt, a count of agents by state (click one to jump to them), and every agent's screen, live and read-only. The screens' text size is yours to set.
- **Using an agent** happens where it runs: **在 Herdr 里打开** brings it to the front in Herdr; with [herdr-web-ui](https://github.com/devswha/herdr-web-ui) running, **打开对话 / 打开终端** open its chat or terminal there. herdr-web-ui is optional: the page notices whether it is running.
- **Machines**: the sidebar names every machine; one that does not answer turns red, with what to do.
- Keys: `N` new broadcast, `/` search, `J` / `K` next and previous broadcast, `Esc` puts a zoomed screen back.

Who gets in: it listens on 127.0.0.1, accepts only its own Host names (`localhost`, `127.0.0.1`, and `web_hosts`), and takes changes only from its own page. To reach it from a phone, set `web_token` first, then serve the port through Tailscale (`tailscale serve --bg --https=8443 http://127.0.0.1:7318`, adding the Tailscale name to `web_hosts`) or an SSH tunnel, and open `/?token=…` once on each device.

### The server

It is a process of its own, as herdr-web-ui's is. Herdr's startup hook starts it detached; it runs a copy of the plugin kept under the plugin's state directory, so updating the plugin does not pull files out from under it. Start is idempotent and waits until the page answers. If port 7318 is taken it serves on the next free one (7325 and up) and remembers it; a `web_port` you set is used as is.

| Action | |
|---|---|
| `herdr-broadcast.web` | start it (a running one is left alone) |
| `herdr-broadcast.web-status` | whether it is running and answering, and where |
| `herdr-broadcast.web-stop` | stop it (SIGTERM, then SIGKILL) |

It does not stop when Herdr does: a machine whose Herdr is down shows as such on the page, and comes back by itself.

## How an execution runs

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

On a remote machine, Herdr resolves folders there: use an absolute path or `~/…`. The plugin uses Herdr's saved machines (`herdr machine`); machines added through herdr-web-ui's own "Add PC" are not among them.

### What runs in the background

- **Event hook** (`pane.agent_status_changed`, `pane.exited`): when a local agent that carries a broadcast changes state, a short-lived process sends its next queued prompt and records a finished turn, then exits. Other panes are skipped without calling Herdr.
- **Worker** (the `worker` action): started when a broadcast is sent, and at Herdr startup when something is pending. It starts new agents and follows SSH machines, whose agent events fire on that machine's Herdr, where this plugin is not installed. It exits 20 seconds after the last execution ends. One worker runs at a time.

State is in SQLite under the plugin's state directory, one database per Herdr session (`broadcast.sqlite`, `broadcast-<session>.sqlite`). Every step that writes to an agent is claimed in the database first, so the hook, the worker and the web server never send a prompt twice.

## Settings

`config.toml` in `herdr plugin config-dir herdr-broadcast`:

```toml
web_port = 7318                 # the broadcast web page
web_host = "127.0.0.1"          # what it listens on
web_token = "…"                 # required from every browser once set
web_hosts = ["mypc.tail1234.ts.net"]  # Host names to accept besides localhost
web_autostart = true            # start it with Herdr
web_url = "http://localhost:7317/"  # herdr-web-ui's address, for the links to it
```

## Command line

For scripts, from the plugin's directory:

```bash
bun src/main.ts send --prompt "Review the diff" --to w2:p1 --to gpu-box/w1:p3
bun src/main.ts send --prompt "Fix the flaky test" --new claude@~/src/app*2
bun src/main.ts list
```

`--to` names a running agent's pane, `--new KIND@DIR[*COUNT]` starts agents; prefix either with a saved machine's id or label and `/` for an SSH machine.

## Development

```bash
bun install          # dev dependencies (types, tsc) only
bun test             # runs against a fake herdr CLI (test/fake-herdr.ts)
bun run typecheck
herdr plugin link .  # use the working tree as the installed plugin
```

`scripts/e2e-real.ts` runs against an isolated `herdr --session <name> server` with `scripts/fake-agent.ts` standing in for an agent, so it spends no tokens. Note: starting a named session's server also runs every installed plugin's startup hook in it. herdr-web-ui's hook moves the web UI over to that session; afterwards restart it in your normal session (`herdr plugin action invoke devswha.herdr-web-ui.stop`, then `.start`).

## License

MIT
