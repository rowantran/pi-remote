# pi-remote

Type locally while an **unmodified Pi coding agent runs on a remote machine**. Closing the terminal, detaching, or losing SSH does not stop the remote agent.

Version 0.2 adds automatic client reconnect, numbered slots, remote path completion, file/image attachments, and opt-in local presentation adapters. It is not full Pi TUI parity. It uses Pi's documented JSONL RPC interface, not `InteractiveMode`, a fake `AgentSession`, or Pi Durable.

## Quick start

Requires Node.js 22.19+ on both machines, working SSH authentication, and **Pi 1.0.4** installed and configured on the remote host. Local dependencies are pinned to the same Pi version; a separate local Pi CLI is not required. Replace `devbox` with your SSH host alias and `/remote/project` with an existing remote directory.

From this checkout on your local machine:

```sh
npm ci --ignore-scripts
npm link            # puts pi-remote on PATH, linked to this checkout
./scripts/deploy.sh devbox

# Set the default SSH host once (see "Configuration" below).
mkdir -p ~/.config/pi-remote
echo '{"host": "devbox"}' > ~/.config/pi-remote/config.json

# Start an independent remote Pi process and attach the local terminal UI.
pi-remote new --cwd /remote/project
```

Remote Pi loads its normal settings, credentials, providers, extension factories, skills, and trusted project resources. Deployment copies application files, not your local Pi configuration, and does not restart existing daemons or slots.

```sh
# List running and stopped slots, including their short numbers.
pi-remote ls

# Attach by number, full UUID, or unique nonnumeric UUID prefix.
pi-remote attach 1

# Omit the slot: attach to the only active slot, or open a local picker.
pi-remote attach

# Create without opening the UI.
pi-remote new --cwd /remote/project --no-attach

# Pi options after -- are forwarded to the stock remote CLI.
pi-remote new --cwd /remote/project -- --model PROVIDER/MODEL

# Resume a stored Pi session in a NEW slot.
pi-remote new --cwd /remote/project --session /remote/session.jsonl

# Explicitly stop a remote Pi process. Ordinary detach never does this.
pi-remote kill 1
```

The 0.2 daemon persists stable slot numbers in `slots.json`, including stopped slots. A still-running 0.1 daemon uses insertion-order numeric aliases until a later daemon startup migrates its metadata. UUIDs remain valid in both cases. Numeric input always means a slot number, never a UUID prefix.

`Ctrl+D` or `/detach` closes only the client. An attached terminal UI automatically reconnects to the same slot after transport loss; use `--no-reconnect` to disable this. The power-user/debug commands `rpc` and `watch` do not reconnect. Accepted or uncertain commands are **never replayed automatically**. Check the restored session before resending an uncertain request.

Use `--host HOST` with any command to select another SSH host, for example `pi-remote attach --host otherbox 1`. For local testing, use `--local` instead of a host and use a local `--cwd`.

Every command also accepts an unambiguous prefix: `pi-remote n --cwd /remote/project` runs `new`, `pi-remote a 1` runs `attach`, `pi-remote k 1` runs `kill`, and `pi-remote l` runs `ls`. The internal commands `bridge`, `daemon`, `complete`, and `fs` need their full names.

### Configuration

The local client reads `$XDG_CONFIG_HOME/pi-remote/config.json`. If `XDG_CONFIG_HOME` is unset or not an absolute path, it reads `~/.config/pi-remote/config.json`. The file is optional and supports one key:

```json
{ "host": "devbox" }
```

The host comes from the first of these that is set: `--host`, the `PI_REMOTE_HOST` environment variable, then the config file. `--local` ignores all three. Invalid JSON or unknown keys cause an error, so a typo does not go unnoticed. This file is separate from the presentation config `~/.pi/remote-client.json` described below.

### Shell completion (fish, zsh, bash)

Put `pi-remote` on `PATH` first (run `npm link` once from the checkout). Then add this line to **`~/.config/fish/config.fish`**, after your PATH setup:

```fish
pi-remote completion fish | source
```

The command prints the versioned [`completions/pi-remote.fish`](completions/pi-remote.fish) script shipped with the repo. Sourcing it registers completions in the current shell; it does not install files, edit your config, or contact a remote host. Reloading the config does not register duplicate rules. Remote directories and slots are queried only when completion runs.

If you prefer fish's automatic file loading, install the same script instead of adding the config line:

```fish
mkdir -p ~/.config/fish/completions
pi-remote completion fish > ~/.config/fish/completions/pi-remote.fish
```

Choose one setup method. Remove a previously installed completion file if you switch to the config line. Completion uses the same default host as the CLI (`--host`, `PI_REMOTE_HOST`, then the config file).

Type `pi-remote new --cwd /remote/` and press Tab to list **remote directories**, not local ones. Slot completion after `pi-remote attach ` includes numbers, status, session name, and workspace. `--session` completes remote files and directories, relative to `--cwd` when supplied.

Remote `~` and relative completion prefixes use the remote home directory unless a completion base is supplied. Quote remote tilde paths, for example `--cwd '~/workplace/project'`, so your shell does not expand them to your **local** home. Prefer absolute paths for `--session` when launching. Completion is read-only: it may start the on-demand daemon, but never creates or attaches a Pi slot, sends a prompt, or runs an agent tool. An unavailable host produces no suggestions.

For zsh or bash, put `pi-remote` on `PATH` with `npm link`, then install the matching script:

- **zsh:** `mkdir -p ~/.zsh/completions; pi-remote completion zsh > ~/.zsh/completions/_pi-remote`. Add `fpath=(~/.zsh/completions $fpath)` before `autoload -Uz compinit; compinit` in `~/.zshrc`.
- **bash:** `pi-remote completion bash > ~/.pi-remote-completion.bash`, then add `source ~/.pi-remote-completion.bash` to `~/.bashrc`.

`completion` only prints a script; it does not edit shell configuration.

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
| `/model` / Ctrl+L | Searchable picker of remote models |
| Ctrl+P | Cycle the remote model |
| `/thinking [LEVEL]` / Shift+Tab | Choose/set the remote thinking level, or cycle it with Shift+Tab |
| `/new` | Stock Pi `new_session` in the same slot |
| `/fork` | Pick an earlier user message; Pi forks it and the local editor receives its original text |
| `/resume` | Pick a stored remote session in the slot's workspace; Pi switches to it |
| `/session` | Show authoritative remote usage and session statistics |
| `/copy` | Copy the last assistant text to the **local** clipboard |
| `/name NAME` | Set the current session name |
| `/compact [instructions]` | Ask remote Pi to compact |
| `/export [REMOTE_PATH]` | Export HTML on the remote host; the client reports its path |
| `/attach LOCAL_PATH` | Queue a local text file or image for the next prompt |
| Ctrl+V / `/paste` | Paste local clipboard files, an image, or text, where supported |
| `/clear-attachments` | Remove pending local attachments |
| Ctrl+G / `/editor` | Edit the draft with local `$VISUAL`, `$EDITOR`, or `nano` |
| `!command` / `!!command` | Run a remote shell command; `!!` excludes its output from model context |
| `/reload-ui` | Reload local presentation adapters and theme, not remote Pi |
| `/theme [NAME]` | Show or change the local theme for this client |
| `/help` | Show local controls |

The editor completes local built-in commands and remote extension/skill/template commands after `/`, and remote paths after `@`. Unknown slash commands pass to Pi's `prompt` RPC unless an explicitly loaded local adapter handles them. Unsupported built-in TUI commands should not be assumed to work.

### Files, clipboard, and shell commands

Use `Review @src/cli.ts` to include a file from the slot's remote workspace, or `Describe @"images/screen shot.png"` for a path with spaces. Absolute paths and `~/` are supported. Email addresses and references inside code spans/blocks are not attachments; a missing simple `@mention` stays literal, while a missing explicit path fails the submission.

`/attach /local/path.txt` and clipboard files are read on the local machine; relative local paths use the directory where you launched the client. Text is appended to the prompt. Supported images are sent as **model input**, not just filenames; the selected model must support images. Tool-result images use labels, **not inline image previews**. User messages render their text content, as in Pi. File reads are limited to regular UTF-8 text files up to 1 MiB or supported images up to 8 MiB. There can be eight pending local attachments, 32 distinct remote references, and at most 24 MiB in the combined prompt. Oversized or unsupported files fail rather than being silently truncated.

Clipboard access occurs only on an explicit paste action. On Linux, image paste can use `wl-paste` on Wayland or `xclip` on X11. The external editor runs locally and returns its contents to the draft; it does not submit them.

`!git status` runs through remote Pi and includes its output in model context on the next prompt. `!!git status` still runs remotely and is recorded in the session, but excludes its output from model context. Neither form starts a model turn by itself.

### Slots and sessions

A **slot** is a running Pi process, like a tmux pane. A **Pi session** is its current conversation file. `/new`, `/fork`, and `/resume` change the file inside that process; `pi-remote new` creates another process. Every attached client sees a slot's session changes. Two clients can attach at once; the first valid dialog answer wins.

The daemon rejects attempts through its create/resume commands to open a file already owned by another of its slots. This is not a system-wide lock: Pi instances outside this daemon and extension-internal session switches cannot be fenced through stock RPC. Do not open the same file in a separate normal Pi process.

## What survives disconnect

Automatic reconnect applies after a terminal client has attached successfully. It retries transport connections with backoff, obtains a fresh snapshot, and resumes display of the same slot. It does not create a replacement process or repeat prompts, shell commands, dialog answers, or session changes. Missing/exited slots and incompatible versions stop recovery. Draft text and pending local attachments remain in the same open client, not in durable storage.

Remote state survives client disconnect:

- Model generation, remote tool execution, and remote shell commands.
- Steering and follow-up queues held by Pi.
- A partial streamed assistant message and currently running tools.
- Open extension `select`, `confirm`, `input`, and `editor` dialogs.
- Extension status entries and text widgets.

Dialogs have **no client-imposed timeout**. If an extension explicitly supplies a timeout, Pi keeps its normal timeout semantics. Disconnect is never converted to cancellation.

On attach, the daemon obtains the current branch entries through RPC and combines them with display-only live state. Snapshot sequence numbers and buffered events close the snapshot/live-stream race. Reconstructed display state is never supplied back to the model or written into Pi's session file.

## Extension compatibility and local presentation

The **stock remote harness is unchanged**. Remote Pi loads extension factories normally; their agent hooks, tools, providers, and credentials stay remote. Its RPC UI forwards dialogs, notifications, status text, string-array widgets, terminal title, and editor text. It cannot transfer executable terminal components to the client.

The transcript composes Pi's public `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`, shell, custom-message, skill, and summary components. Built-in tool renderers come from Pi's public tool factories; their executors are not retained or called locally. Pi owns Markdown, thinking styles, spacing, tool backgrounds, expansion, and renderer state. The client only reconciles remote messages and strips terminal controls from wire content. Thinking is visible by default, as in Pi. Detach, reconnect, and UI reload retire local renderer timers without stopping remote tools; restored results do not invent new execution times.

Edit diffs use the remote result's `details`. The built-in edit renderer's pre-execution filesystem preview is disabled locally, so a remote path cannot accidentally preview a file on the client machine. No Pi internals or fake session are needed for transcript rendering.

The local client can separately load trusted presentation adapters for tool call/result renderers, custom message/entry renderers, Markdown transforms, custom footer/header/editor components, widgets, display events, commands, and shortcuts. Local adapters use snapshot data; they are not another `AgentSession`. Without an adapter, the client uses its built-in display. Renderer failures produce local warnings rather than stopping the remote agent.

### Opt in explicitly

Use repeatable `--ui-extension PATH` flags, or create **local** `~/.pi/remote-client.json` with an explicit allowlist of trusted files:

```json
{
  "extensions": ["/absolute/path/to/trusted-ui.ts"],
  "theme": "dark"
}
```

`--ui-config PATH` selects another config file. Config-relative extension paths resolve beside that file; command-line paths resolve from the local working directory. `~/` means local home here. CLI extension paths are added to the config allowlist and deduplicated. Only exact files are selected: the client does **not** automatically load local Pi extension directories, project resources, or packages. Explicit adapters can still import other modules.

```sh
pi-remote attach 1 --ui-extension ./my-ui.ts --theme dark
pi-remote attach 1 --ui-config ./remote-ui.json --no-reconnect
```

`--theme NAME` overrides the config theme. Available themes include `system`, `dark`, `light`, and JSON themes from local `~/.pi/agent/themes/` (or `$PI_CODING_AGENT_DIR/themes/`). Use `/theme NAME` to change the current client and `/reload-ui` to reread its selected adapters/config. Neither command changes remote settings or restarts Pi; theme files are not watched automatically.

[`examples/rowan-ui.ts`](examples/rowan-ui.ts) is a **user-specific selective adapter**, not a portable default. It expects Rowan's extension repository locally at `~/.pi/agent/git/github.com/rowantran/pi-extensions`, or at `$PI_REMOTE_RENDERER_REPO`. It loads the original footer, caret, assistant-background, and compact-tool factories unchanged, selects the existing codemode renderers, and renders persisted worked-for data without loading the original worked-for factory. That factory writes session entries and patches private Pi internals, so it remains a narrow data-rendering adapter. It avoids the provider, background-worker, MCP, Slack, and codemode execution factories. Review its imports and adapt paths before selecting it with `--ui-extension ./examples/rowan-ui.ts` or your config allowlist.

### Trust boundary

**Adapters are trusted arbitrary JavaScript, not a sandbox.** Imports and factories run with the local process's normal file, network, credential, and subprocess privileges. Custom editors receive submission callbacks and therefore have **input authority**: they can submit prompts or commands, not merely change their appearance. Load only code you trust with that authority.

The presentation API omits tool execution, provider registration, credential lookup, remote session mutation, and `ctx.ui.custom()`/local dialogs. Blocked API calls are a **compatibility guard, not a security boundary**; they do not constrain arbitrary JavaScript or custom-editor submission. Tool registration retains rendering fields, not executors. Select visual modules deliberately rather than running every remote extension factory again locally.

Remote RPC still ignores terminal-only hooks such as footer/editor factories, and remote extensions see `ctx.mode === "rpc"`. Local presentation support does not make remote TUI-only code run or provide complete `ExtensionAPI` compatibility.

### Upstream RPC limitations

- Pi 1.0.4 waits for initial `session_start` hooks before it starts reading RPC stdin. An extension that **awaits a dialog during initial startup** can therefore block startup before its answer can be read. The daemon retains the process and shows its starting state; it does not invent a timeout or patch the harness. Dialogs from commands or running tools were tested successfully.
- RPC does not report cancellation of a dialog by an extension's abort signal. Explicit timeout expiry and client answers are tracked, but a signal-cancelled dialog can remain displayed until the user dismisses it.
- In-place `/tree` navigation is unavailable; use `/fork` to branch from an earlier prompt. `/login` and `/settings` are unavailable here; configure the remote harness with normal Pi over SSH.
- Remote `/reload` is unavailable through stock RPC. `/reload-ui` reloads only local presentation; it does not reload remote extensions or settings.
- Custom overlays through `ctx.ui.custom()` and built-in inline image display are not implemented.

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

### Upgrade without interrupting active work

`deploy.sh` stages each release and its dependencies under `~/.local/share/pi-remote/releases/release.XXXXXX`, validates it, then atomically switches the stable `~/.local/share/pi-remote/bin/pi-remote` launcher symlink. Prior releases and legacy installation files/dependencies remain untouched because live daemons may still import them. **Do not remove them until all old processes have stopped.** Deployment does not clean them up automatically.

Deploying 0.2 application files does **not** require restarting a live 0.1 daemon. The new client falls back to the newly installed remote filesystem helper when the old daemon does not support path completion, attachment reads, or filesystem metadata. These read-only calls use a separate SSH process; prompts and other mutations still go through the existing daemon. A transport error never triggers this fallback or mutation replay.

Keep the old daemon running while its slots are active. To adopt new daemon code later, finish or explicitly stop its slots, then deliberately stop the daemon using the PID in `daemon.lock/pid`. This interrupts any remaining work. The next connection starts the installed daemon and migrates stored slot numbers; it does not resume stopped tasks. Never restart merely to detach or enable the compatibility helper.

## Development and verification

Locally, `pi-remote` runs from `src/` through the `tsx` devDependency, so source edits take effect on the next run without `npm run build`. `npm link` creates a symlink to this checkout in npm's global bin directory; `npm unlink -g pi-remote` removes it. Deployed releases contain no `src/` and run the compiled `dist/`; `deploy.sh` builds it.

```sh
npm run verify

# Golden master: real stock Pi versus pi-remote in paired tmux terminals.
# Requires tmux and Pi 1.0.4 on PATH. Uses a deterministic local provider, no credentials.
npm run test:golden

# Repeat with the unchanged Rowan compact-tools, assistant-background and caret factories.
npm run test:golden -- --rowan

# Exercise concurrent on-demand startup and crash/stale-lock recovery with the built CLI.
# Uses an isolated local daemon with no Pi slots or model calls.
node --import tsx test/startup-smoke.ts

# Offline tests use a deterministic child that speaks Pi-shaped RPC.
# This optional test runs real Pi and existing extensions on an isolated remote workspace.
PI_REMOTE_TEST_HOST=devbox node --import tsx test/remote-smoke.ts

# Also make one real model request using the host's existing credentials/configuration.
PI_REMOTE_TEST_HOST=devbox PI_REMOTE_TEST_MODEL=1 node --import tsx test/remote-smoke.ts

# Test completion, attachments, numeric slots and exactly-once shell execution across reconnect.
PI_REMOTE_TEST_HOST=devbox node --import tsx test/remote-features-smoke.ts

# Test actual local terminal input/reconnect in an isolated tmux server.
# Requires tmux and the user-specific Rowan presentation adapter dependencies.
PI_REMOTE_TEST_HOST=devbox node --import tsx test/terminal-smoke.ts
```

The remote smoke tests use separate `/tmp/pi-remote-{smoke,features,terminal}.*` state directories, start only their own slots, and stop those slots and their daemons afterward. The terminal test uses the separate `pi-remote-test` tmux server. It leaves test files/logs for inspection. It does not change global Pi settings or credentials.

The golden test starts a normal Pi TUI and a pi-remote client backed by stock Pi RPC. It submits the same prompts, waits at deterministic streaming/tool checkpoints, toggles tools and thinking, runs a shell command, submits a second prompt, and compares resumed/restored histories. Restoration also checks that no messages or provider calls were added and the remote Pi process stayed alive. The default matrix covers 80/120 columns and dark/light themes. `--widths`, `--themes`, `--rows`, and `--pi-bin` select other configurations; `--remote-bin` can compare an older checkout.

**Golden expectations follow the tested Pi version.** Future Pi updates may intentionally change the correct appearance; the goal is to match the new stock Pi, not preserve old screenshots forever. Upgrade the pinned dependencies and version checks together, then review new captures. See [reference behavior and upgrade guidance](test/golden/README.md#reference-behavior-follows-pi).

Each checkpoint saves both raw ANSI screens, transcript text, resolved foreground/background/attribute runs, diffs, and side-by-side views. The test fails on text or style differences after normalizing wall-clock duration labels. Startup/editor/footer UI and transient toggle notifications are outside this transcript comparison. It checks neither inline images nor terminal palette auto-detection. Isolated homes, sessions, workspaces, daemons, and a private tmux server keep tests separate from active work. Only test processes are stopped; the printed artifact directory is retained for inspection.

### Power-user / debugging commands

`rpc` and `watch` are optional interfaces for scripts and debugging. **You do not need them for normal interactive use; use `attach` instead.**

- `rpc` sends one JSON command to an existing Pi process, prints its response, and exits. It supports both queries and actions.
- `watch` prints the current session snapshot, then streams live events as JSON. It does not submit prompts or answer dialogs.

```sh
pi-remote rpc 1 '{"type":"get_state"}'
pi-remote watch 1
```

`rpc` waits for command acceptance/result, not necessarily agent completion. In `watch` output, `agent_settled` means Pi has no automatic work left. Ctrl+C stops watching without stopping Pi. Neither command reconnects automatically.

### Source map

- `src/daemon.ts`: slots, attachment snapshots, dialogs, private socket, persistence.
- `src/pi-process.ts`: stock Pi RPC child ownership, correlation, output draining.
- `src/client.ts`, `src/reconnect.ts`: SSH/local transport, startup, snapshot-based reconnect without mutation replay.
- `src/compat-client.ts`: read-only filesystem fallback for running legacy daemons.
- `src/live.ts`: display-only streaming reconstruction on the daemon.
- `src/tui.ts`, `src/view.ts`: local terminal UI and transcript projection.
- `src/transcript.ts`, `src/keybindings.ts`: public Pi transcript components and application shortcut hints.
- `src/presentation.ts`, `src/local-theme.ts`: explicit adapter loading and local themes.
- `src/files.ts`, `src/local-input.ts`, `src/editor-completion.ts`: attachments, clipboard/editor integration, and remote editor completion.
- `src/cli.ts`, `src/completion.ts`, `completions/`: launch options, command prefixes, slot selection, and shell completion.
- `src/config.ts`: XDG config file and default host.
- `bin/pi-remote`, `src/node-entry.ts`: launcher that runs `src/` via tsx in a checkout or `dist/` in a release, and Node arguments for child processes started from either.
- `examples/rowan-ui.ts`: selective, user-specific presentation adapter.

Pi references: [RPC](https://pi.dev/docs/latest/rpc), [extension UI](https://pi.dev/docs/latest/rpc-extension-ui), [JSON events](https://pi.dev/docs/latest/json).
