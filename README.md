# pi-remote

Type locally while an **unmodified Pi coding agent runs on a remote machine**. Closing the terminal, detaching, or losing SSH does not stop the remote agent.

This is an initial implementation, not full Pi TUI parity. It uses Pi's documented JSONL RPC interface, not `InteractiveMode`, a fake `AgentSession`, or Pi Durable.

## Quick start

Requires Node.js 22.19+ on both machines, SSH authentication configured, and **Pi 1.0.4** installed and configured on the remote host. Dependencies are pinned to that Pi version.

From this checkout:

```sh
npm ci --ignore-scripts
npm run build
./scripts/deploy.sh rowan-v2-dev

# Start a fresh, independent remote Pi process and attach the local terminal UI.
./bin/pi-remote new rowan-v2-dev --cwd /home/ubuntu/workplace/YOUR_PROJECT
```

Use an existing remote directory. Remote Pi loads its normal settings, credentials, providers, extensions, skills, and trusted project resources there. Nothing is copied from your local Pi configuration.

```sh
# List running and stopped slots.
./bin/pi-remote ls rowan-v2-dev

# Reattach to a slot (the full ID or a unique prefix works).
./bin/pi-remote attach rowan-v2-dev SLOT_ID

# Create without opening the UI.
./bin/pi-remote new rowan-v2-dev --cwd /remote/project --no-attach

# Pi options after -- are forwarded to the stock remote CLI.
./bin/pi-remote new rowan-v2-dev --cwd /remote/project -- --model PROVIDER/MODEL

# Resume a stored Pi session in a NEW slot.
./bin/pi-remote new rowan-v2-dev --cwd /remote/project --session /remote/session.jsonl

# Explicitly stop a remote Pi process. Ordinary detach never does this.
./bin/pi-remote kill rowan-v2-dev SLOT_ID
```

`Ctrl+D` or `/detach` closes the local client without aborting Pi or answering an open dialog. After a connection failure, detach and run `attach` again. Automatic reconnect is not implemented yet. Accepted or uncertain commands are **never replayed automatically**.

For local testing, replace the SSH host with `--local` and use a local `--cwd`. `PI_REMOTE_HOST` can supply a default SSH host.

## Commands and keys

| Command/key | Behaviour |
|---|---|
| Enter | Send a prompt; during a run, queue steering for the next tool boundary |
| Alt+Enter | Queue a follow-up after the current run finishes |
| Shift+Enter / Ctrl+J | Newline |
| Esc | Cancel the current dialog, or clear queued input then abort; cleared queue text returns to the editor |
| Ctrl+D / `/detach` | Detach only, including while a dialog is open |
| Ctrl+O | Expand/collapse tool output |
| Ctrl+T | Show/hide thinking |
| PageUp/PageDown | Scroll transcript |
| Ctrl+End | Follow new output |
| Ctrl+Shift+F | Search transcript |
| `/model` | Local searchable picker populated by remote `get_available_models`; selection calls `set_model` |
| `/new` | Stock Pi `new_session` in the same slot |
| `/fork` | Pick an earlier user message; Pi forks it and the local editor receives its original text |
| `/resume` | Pick a stored remote session in the slot's workspace; Pi switches to it |
| `/session` | Show authoritative remote usage and session statistics |
| `/copy` | Copy the last assistant text to the **local** clipboard |
| `/name NAME` | Set the current session name |
| `/compact [instructions]` | Ask remote Pi to compact |
| `/help` | Show local controls |

Unknown slash commands are passed to Pi's `prompt` RPC, so remote extension commands, skills, and prompt templates still work. Unsupported built-in TUI commands are not implemented by RPC and should not be assumed to work.

A **slot** is a running Pi process, like a tmux pane. A **Pi session** is its current conversation file. `/new`, `/fork`, and `/resume` change the file inside that process; `pi-remote new` creates another process. Every attached client sees a slot's session changes. Two clients can attach at once; the first valid dialog answer wins.

The daemon rejects attempts through its create/resume commands to open a file already owned by another of its slots. This is not a system-wide lock: Pi instances outside this daemon and extension-internal session switches cannot be fenced through stock RPC. Do not open the same file in a separate normal Pi process.

## What survives disconnect

- Model generation and remote tool execution.
- Steering and follow-up queues held by Pi.
- A partial streamed assistant message and currently running tools.
- Open extension `select`, `confirm`, `input`, and `editor` dialogs.
- Extension status entries and text widgets.

Dialogs have **no client-imposed timeout**. If an extension explicitly supplies a timeout, Pi keeps its normal timeout semantics. Disconnect is never converted to cancellation.

On attach, the daemon obtains the current branch entries through RPC and combines them with display-only live state. Snapshot sequence numbers and buffered events close the snapshot/live-stream race. Reconstructed display state is never supplied back to the model or written into Pi's session file.

## Extension compatibility

The remote Pi process loads extensions normally. The wrapper does not load extension factories a second time and does not change their agent hooks, tools, or provider logic.

Supported presentation calls: dialogs, notifications, status text, string-array widgets, terminal title, and editor text.

**Not implemented yet:** local extension tool renderers, custom footer/header, custom editor, message/entry renderers, custom component widgets, or `ctx.ui.custom()`. The client currently uses its own basic tool display, editor, and footer. The next UI milestone is opt-in presentation adapters; blindly executing all extensions twice would cause side effects.

Stock Pi RPC itself ignores several terminal-only hooks. Some extensions explicitly require `ctx.mode === "tui"`; those features remain unavailable. This is a limitation of the selected public API, not a remote loading fix.

### Upstream RPC limitations

- Pi 1.0.4 waits for initial `session_start` hooks before it starts reading RPC stdin. An extension that **awaits a dialog during initial startup** can therefore block startup before its answer can be read. The daemon retains the process and shows its starting state; it does not invent a timeout or patch the harness. Dialogs from commands or running tools were tested successfully.
- RPC does not report cancellation of a dialog by an extension's abort signal. Explicit timeout expiry and client answers are tracked, but a signal-cancelled dialog can remain displayed until the user dismisses it.
- There is no in-place `/tree` navigation RPC, remote file autocomplete, or built-in TUI `/login`/`settings` support here yet. Use normal remote Pi for configuration. File/image attachment UI and `!bash` UI are not implemented; the headless RPC command can invoke `bash`.

## Process and security boundaries

```text
laptop                                 remote host
local pi-tui client -> SSH stdio -> bridge -> private Unix socket
                                                |
                                         detached daemon
                                          /           \
                                  stock pi RPC    stock pi RPC
                                    slot A          slot B
```

- One on-demand detached daemon per remote state directory. No network listener or systemd unit.
- Default installation: `~/.local/share/pi-remote/`. Default daemon state: `~/.pi/remote/`.
- SSH uses your existing host config with batch authentication and keepalives. Log in using regular SSH first if authentication needs interaction.
- A `0700` state directory and `0600` Unix socket restrict local access. This is not a sandbox: attached clients have the same tool authority as the remote Pi user.
- `--state-dir` selects a **dedicated, private, user-owned** directory; do not use a project root or home directory. `--remote-bin` overrides the installed remote launcher.
- The daemon validates protocol/Pi versions on connection and rechecks the remote Pi executable before starting each slot.
- Only explicit slot kill or daemon shutdown closes Pi's stdin. A display parser/reducer failure does not kill a healthy Pi process.
- Output queues/JSONL frames are bounded at 64 MiB. A slow client is disconnected rather than stalling Pi. Extremely large history records can fail attachment; pagination is not implemented.
- `slots.json` contains process metadata and session paths, not credentials or a second transcript. `daemon.log` contains stderr, which may include sensitive extension diagnostics. It is private but not rotated automatically yet.

Pi's exported `RpcClient` is not used for transport ownership: in 1.0.4 it has no public dialog-response method and imposes a fixed request timeout. `src/pi-process.ts` implements the documented stdio framing directly, with unique request IDs and no deadlines on agent commands that may await a dialog. This changes no Pi code.

### Daemon crash versus client disconnect

Client disconnect is supported; daemon/host crash recovery of in-flight work is **not**. If the daemon dies, its pipes close and stock Pi exits. On daemon restart, known slots are listed as stopped, without rerunning tasks automatically. Open the recorded session file in a new slot to resume manually. Pi may defer creation of a new session file until the first assistant response.

An exclusive startup lock serializes stale-daemon reclamation. If the launcher itself crashes leaving `start.lock`, startup fails closed; inspect its PID and `daemon.log` before manually removing it. Never remove a live daemon's lock/socket. A reused PID also fails closed.

Updating application files does not restart the daemon or existing slots. For an upgrade, stop the slots you no longer need, then stop the daemon deliberately using the PID in its `daemon.lock/pid`. This interrupts any remaining work. Do not do it merely to detach.

## Development and verification

```sh
npm run verify

# Exercise concurrent on-demand startup and crash/stale-lock recovery with the built CLI.
# Uses an isolated local daemon with no Pi slots or model calls.
node --import tsx test/startup-smoke.ts

# Offline tests use a deterministic child that speaks Pi-shaped RPC.
# This optional test runs real Pi and existing extensions on an isolated remote workspace.
PI_REMOTE_TEST_HOST=rowan-v2-dev node --import tsx test/remote-smoke.ts

# Also make one real model request using the host's existing credentials/configuration.
PI_REMOTE_TEST_MODEL=1 node --import tsx test/remote-smoke.ts
```

The remote smoke test uses a separate `/tmp/pi-remote-smoke.*` state directory, starts only its own slots, and stops those slots and its daemon afterward. It leaves test files/logs for inspection. It does not change global Pi settings or credentials.

Headless inspection:

```sh
./bin/pi-remote rpc rowan-v2-dev SLOT_ID '{"type":"get_state"}'
./bin/pi-remote watch rowan-v2-dev SLOT_ID
```

`rpc` waits for command acceptance/result, not necessarily agent completion. `watch` prints a snapshot followed by events; `agent_settled` means Pi has no automatic work left.

### Source map

- `src/daemon.ts`: slots, attachment snapshots, dialogs, private socket, persistence.
- `src/pi-process.ts`: stock Pi RPC child ownership, correlation, output draining.
- `src/client.ts`: SSH/local transport, on-demand startup, no automatic mutation replay.
- `src/live.ts`: display-only streaming reconstruction on the daemon.
- `src/tui.ts`, `src/view.ts`: local terminal UI and transcript projection.
- `src/cli.ts`: commands and launch options.

Pi references: [RPC](https://pi.dev/docs/latest/rpc), [extension UI](https://pi.dev/docs/latest/rpc-extension-ui), [JSON events](https://pi.dev/docs/latest/json).
