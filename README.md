# pi-remote

Type locally while an **unmodified Pi coding agent runs on a remote machine**. Closing the terminal, detaching, or losing SSH does not stop the remote agent.

Version 0.2 adds automatic client reconnect, numbered slots, remote path completion, file/image attachments, and opt-in local presentation adapters. It is not full Pi TUI parity. It uses Pi's documented JSONL RPC interface, not `InteractiveMode`, a fake `AgentSession`, or Pi Durable.

## Phone client

A browser client renders the Pi transcript locally and connects to the devbox through Tailscale
Serve. `pi-remote serve` has only a private Unix socket, requires your Tailscale identity and device
pairing, and never opens a public TCP port. The web client uses the normal pi-remote config on
the server for themes and trusted presentation extensions; `serve --ui-config PATH` selects
another config file. See [phone setup, configuration, and security](docs/phone.md).

## Quick start

Requires Node.js 22.19+ on both machines, working SSH authentication, and **Pi 1.0.4** installed and configured on the remote host. Local dependencies are pinned to the same Pi version; a separate local Pi CLI is not required. Replace `devbox` with your SSH host alias and `/remote/project` with an existing remote directory.

From this checkout on your local machine:

```sh
npm ci --ignore-scripts
npm link                     # puts pi-remote on PATH, linked to this checkout
npm run deploy -- devbox      # installs on the remote host; see "Deployment"

# Set the default SSH host once (see "Configuration" below).
# If XDG_CONFIG_HOME is an absolute path, use it instead of ~/.config.
mkdir -p ~/.config/pi-remote
echo '{"host": "devbox"}' > ~/.config/pi-remote/config.json

# Start an independent remote Pi process and attach the local terminal UI.
pi-remote new --cwd /remote/project
```

Remote Pi loads its normal settings, credentials, providers, extension factories, skills, and trusted project resources. Deployment copies application files, not your local Pi configuration.

```sh
# List running slots: number, status, session name, workspace, clients, age,
# and short UUID. Add --all to include stopped slots, --json for scripts.
pi-remote ls

# Attach by number, full UUID, or unique nonnumeric UUID prefix.
pi-remote attach 1

# Omit the slot: attach to the only active slot, or open a searchable picker.
pi-remote attach

# No command: one searchable picker to attach to a running slot or start a
# new session in the default directory.
pi-remote

# Create without opening the UI.
pi-remote new --cwd /remote/project --no-attach

# Pi options after -- are forwarded to the stock remote CLI.
pi-remote new --cwd /remote/project -- --model PROVIDER/MODEL

# Resume a stored Pi session in a NEW slot.
pi-remote new --cwd /remote/project --session /remote/session.jsonl

# Explicitly stop a remote Pi process. Ordinary detach never does this.
pi-remote kill 1
```

From an attached client, `/quit` does the same as `pi-remote kill` for the current slot, then closes the client and prints `Stopped slot NUMBER / UUID`. If Pi is running, compacting, running a shell command, or has queued prompts, `/quit` asks for confirmation first, because stopping Pi interrupts that work. The session file stays on disk; open it in a new slot with `--session` to continue. The stopped slot stays in `pi-remote ls --all`; plain `pi-remote ls` hides stopped slots and prints how many it hid.

The 0.2 daemon persists stable slot numbers in `slots.json`, including stopped slots. A still-running 0.1 daemon uses insertion-order numeric aliases until a later daemon startup migrates its metadata. UUIDs remain valid in both cases. Numeric input always means a slot number, never a UUID prefix.

`Ctrl+D` or `/detach` closes only the client and prints `Detached from slot NUMBER / UUID`. An attached terminal UI automatically reconnects to the same slot after transport loss; use `--no-reconnect` to disable this. The power-user/debug commands `rpc` and `watch` do not reconnect. Accepted or uncertain commands are **never replayed automatically**. Check the restored session before resending an uncertain request.

Use `--host HOST` with any command to select another SSH host, for example `pi-remote attach --host otherbox 1`. For local testing, use `--local` instead of a host and use a local `--cwd`.

Every command also accepts an unambiguous prefix: `pi-remote n --cwd /remote/project` runs `new`, `pi-remote a 1` runs `attach`, `pi-remote k 1` runs `kill`, and `pi-remote l` runs `ls`. The internal commands `bridge`, `daemon`, `complete`, and `fs` need their full names.

### Picking a session

Run `pi-remote` with no command to open the home picker. It lists active slots with exactly the rows of `pi-remote ls`: number, status, session name (side slots indented under their parent), workspace, attached clients, age, and the first 8 characters of the UUID, with any slot error on the line below. Its header is the same summary line that `ls` prints on a terminal (`devbox · 3 running · 1 stopped`). Type to filter: the search is fuzzy over the session name, number, and directory, and typing a slot number such as `3` or `#3` puts that slot first. Use ↑/↓ (or Ctrl+P/Ctrl+N) to move, Enter to open, and Esc, Ctrl+C, or Ctrl+D to cancel. The last row, **+ New session**, starts a slot in the default directory (`--cwd`, `PI_REMOTE_CWD`, or the config file) and attaches to it. Options such as `--host` work as with other commands: `pi-remote --host otherbox`.

`pi-remote attach` without a slot opens the same picker, limited to active slots, when more than one is active. The picker draws below your prompt and erases itself when you choose or cancel; it never clears the screen or scrollback. Without a terminal, `pi-remote` prints help and `attach` asks for a slot number.

### Session names

`pi-remote ls`, the pickers, and slot completion show each slot's Pi session name. This is Pi's own session name: the one `/name` sets and `/resume` shows. Set it with `/name NAME` in the attached UI.

The attached terminal's window/tab title follows native Pi's format: `π - SESSION NAME - DIRECTORY`, or `π - DIRECTORY` for an unnamed session. `DIRECTORY` is the remote workspace's basename, not the local directory. The title follows session renames, refreshes, and reconnects. The phone/browser tab uses the same title. Extensions can still set a custom title; a remote extension's title stays in effect until replaced or remote Pi restarts.

To name sessions automatically, install a Pi extension that does this **on the remote host**. Remote Pi loads it like any other extension, and pi-remote shows the name as soon as the extension sets it. For example, [`pi-auto-session-name`](https://github.com/patlux/pi-auto-session-name) names an unnamed session after its first run and keeps names set with `/name`:

```sh
ssh devbox pi install npm:pi-auto-session-name
```

Choose a cheap naming model in the remote `~/.pi/agent/extensions/auto-session-name.json`, for example `{"provider": "anthropic", "model": "claude-haiku-4-5"}`. Do not set `"reasoning": "off"` with that extension (version 0.1.1): Anthropic models then reject the request. Leave the option out to use its default. Extensions load when Pi starts, so slots that are already running do not get the extension.

### Configuration

The local client reads `$XDG_CONFIG_HOME/pi-remote/config.json`. If `XDG_CONFIG_HOME` is unset or not an absolute path, it reads `~/.config/pi-remote/config.json`. This optional file holds connection defaults and local UI settings. All settings are optional:

```json
{
  "host": "devbox",
  "cwd": "~/workplace/project",
  "extensions": ["./my-ui.ts"],
  "theme": "dark",
  "bell": true,
  "sideSplit": "auto",
  "web": { "allowUsers": ["you@example.com"] }
}
```

Keep your own trusted adapter at `my-ui.ts` beside `config.json`. The relative path works on both the laptop and devbox when each has those files. Adapters are user-owned files, not part of the pi-remote release; manage them with your dotfiles or copy them separately. See [local presentation](#opt-in-explicitly) before enabling one. Omit `extensions` to use the built-in display, unless you select adapters with `--ui-extension`.

The host comes from the first of these that is set: `--host`, the `PI_REMOTE_HOST` environment variable, then the config file. `--local` ignores all three.

`cwd` is the default remote working directory for `pi-remote new`. It comes from the first of these that is set: `--cwd`, the `PI_REMOTE_CWD` environment variable, then the config file. With a default, `pi-remote new` needs no `--cwd`. The value is a path on the remote host: `~` means the remote home, and the remote daemon checks that the directory exists. The default applies to every host, including one selected with `--host`. `--local` ignores it, so `new --local` still needs `--cwd`. `--session` completion also uses this default as its base when `--cwd` is not given.

`web` opts deployments into automatic installation and updates of the phone's systemd user service. It requires exact `allowUsers` Tailscale logins and accepts an optional HTTPS `origin`; otherwise the origin is discovered on the devbox. Omit `web` to leave systemd alone. See [phone setup](docs/phone.md#install-and-run). Deployment does not upload your UI config or adapter files.

`extensions` is an allowlist of trusted local adapter files. `theme` selects the local theme, `bell` enables or disables the terminal bell, and `sideSplit` selects `auto`, `right`, `down`, `left`, or `up`. Relative extension paths resolve beside the config file that supplies them; `~/` means local home. Invalid JSON, unknown keys, or invalid values cause an error, so a typo does not go unnoticed.

`--ui-config PATH` overrides **only UI settings** (`extensions`, `theme`, `bell`, and `sideSplit`). It replaces the default config for those settings. It does not change where `host` and `cwd` defaults come from, even if the selected file contains those keys. Repeatable `--ui-extension PATH` flags add to the selected allowlist and deduplicate resolved paths; their relative paths use the local working directory. `--theme NAME` and `--no-bell` override config values. `/reload-ui` reads the configuration again and reloads local adapters, theme, bell, and split settings; it does not reconnect, change connection defaults, or restart remote Pi.

#### Removed UI configuration path

The old default path `~/.pi/remote-client.json` is no longer read. There is no fallback, detection, or warning. UI settings must be in the XDG config or a file explicitly selected with `--ui-config`.

To migrate, merge your old UI keys into the XDG config, keeping any existing connection defaults, then remove the old file. Preserve absolute extension paths, or adjust relative paths for the new config directory. Each relative path is resolved beside its originating file, so copying it unchanged from `~/.pi/remote-client.json` to `~/.config/pi-remote/config.json` can select a different file. If your allowlist points into the checkout's old `examples/` or `example-configs/` directory, move your adapter beside `config.json` and select it with a relative path such as `./my-ui.ts`.

### Shell completion (fish, zsh, bash)

Put `pi-remote` on `PATH` first (run `npm link` once from the checkout). Then add this line to **`~/.config/fish/config.fish`**, after your PATH setup:

```fish
command -q pi-remote; and pi-remote completion fish | source
```

The `command -q` guard skips machines where `pi-remote` is not installed. Keep it if you share one fish config between your laptop and the remote host: the host needs no `pi-remote` on `PATH`, because the client reaches the deployed release by its full path (see [Deployment](#deployment)).

The command prints the versioned [`completions/pi-remote.fish`](completions/pi-remote.fish) script shipped with the repo. Sourcing it registers completions in the current shell; it does not install files, edit your config, or contact a remote host. Reloading the config does not register duplicate rules. Remote directories and slots are queried only when completion runs.

If you prefer fish's automatic file loading, install the same script instead of adding the config line:

```fish
mkdir -p ~/.config/fish/completions
pi-remote completion fish > ~/.config/fish/completions/pi-remote.fish
```

Choose one setup method. Remove a previously installed completion file if you switch to the config line. Completion uses the same default host as the CLI (`--host`, `PI_REMOTE_HOST`, then the config file), and the same default directory for `--session` (`--cwd`, `PI_REMOTE_CWD`, then the config file).

Type `pi-remote new --cwd /remote/` and press Tab to list **remote directories**, not local ones. Slot completion after `pi-remote attach ` includes numbers, status, session name, and workspace. `--session` completes remote files and directories, relative to `--cwd` or the default directory when one is set.

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
| Alt+Up | Restore all queued messages to the editor without aborting the run |
| Shift+Enter / Ctrl+J | Newline |
| Ctrl+C | Clear the prompt (pending attachments stay) |
| Esc | Cancel the current dialog, or clear queued input then abort; cleared queue text returns to the editor. In the fork picker, the first Esc clears an active search |
| Esc Esc | With an empty editor while idle, open the tree-style fork picker. Press twice within 500 ms. Follows local Pi's `doubleEscapeAction`; `tree` and `fork` both open this picker, and `none` disables it |
| Ctrl+D / `/detach` | Detach only, including while a dialog is open |
| `/quit` | Stop the remote Pi process for this slot, then close the client. Asks first if work is in progress |
| Ctrl+O | Expand/collapse tool output |
| Ctrl+T | Show/hide thinking. The starting state follows `hideThinkingBlock` in your local `~/.pi/agent/settings.json`; Ctrl+T changes only the current view |
| PageUp/PageDown | Scroll transcript |
| Ctrl+End | Follow new output. While scrolled up, a `↓ Jump to latest message` pill shows at the bottom of the transcript; click it to do the same |
| Ctrl+Shift+F | Search transcript |
| `/model` / Ctrl+L | Searchable picker of remote models |
| Ctrl+P | Cycle the remote model |
| `/thinking [LEVEL]` / Shift+Tab | Choose/set the remote thinking level, or cycle it with Shift+Tab |
| `/new` | Stock Pi `new_session` in the same slot |
| `/fork` / `/tree` | Browse user and assistant messages in a tree-style picker. Choose a user prompt to fork **before** it into a new session file; its original text returns to the editor |
| `/side [prompt]` | Fork the saved conversation into a side slot and open a local Ghostty split; send the optional prompt once in the side conversation |
| `/resume` | Pick a stored remote session in the slot's workspace; Pi switches to it |
| `/resume --side` | Pick a stored side conversation in the workspace; Pi switches to it |
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
| `/reload` | Restart remote Pi in the same slot and session; asks before interrupting work or discarding queued prompts |
| `/reload-ui` | Reread local UI config and reload adapters, theme, bell, and split settings, not remote Pi |
| `/theme [NAME]` | Show or change the local theme for this client |
| `/help` | Show local controls |

The fork picker builds its tree from verified history already held by the client, including branches and labels. It does not download the full tree again. If a turn's history refresh is still running, the picker shows a **Loading session tree…** spinner until that refresh finishes. Esc stops waiting and ignores any late result; Ctrl+D detaches without changing the remote session. Daemons without verified history support use the existing full-tree read.

The fork picker uses Pi's own tree rows, role colors, selected-row background, search, filters, and branch folding. It starts with tools hidden and the most recent user prompt selected. Use ↑/↓ to move, ←/→ to page, Alt+←/→ to fold/unfold branches, and Ctrl+X to copy the selected message. PageUp/PageDown still scroll the transcript. Ctrl+T/U/L/A toggle the no-tools/user-only/labeled-only/all filters; Ctrl+O and Shift+Ctrl+O cycle filters. Alt+D selects Pi's default filter (shows tools) because Ctrl+D always detaches. Labels are shown but cannot be edited through stock RPC. Assistant messages and other entries are context only, not fork points.

Double-Esc reads `doubleEscapeAction` from your **local** `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) at startup; it defaults to `tree`. Esc still cancels dialogs and interrupts remote work before it can count toward a double-Esc. Draft text, a pending command, or a disconnect prevents the shortcut from opening the picker. These controls do not change remote Pi settings.

The editor completes local built-in commands and remote extension/skill/template commands after `/`, and remote paths after `@`. Slash command suggestions use case-insensitive fuzzy matching, so `/pseude` can suggest `/skill:pseudocode`. Unknown slash commands pass to Pi's `prompt` RPC unless an explicitly loaded local adapter handles them. Unsupported built-in TUI commands should not be assumed to work.

### Files, clipboard, and shell commands

Use `Review @src/cli/main.ts` to include a file from the slot's remote workspace, or `Describe @"images/screen shot.png"` for a path with spaces. Absolute paths and `~/` are supported. Email addresses and references inside code spans/blocks are not attachments; a missing simple `@mention` stays literal, while a missing explicit path fails the submission.

`/attach /local/path.txt` and clipboard files are read on the local machine; relative local paths use the directory where you launched the client. Text is appended to the prompt. Supported images are sent as **model input**, not just filenames; the selected model must support images. Tool-result images use labels, **not inline image previews**. User messages render their text content, as in Pi. File reads are limited to regular UTF-8 text files up to 1 MiB or supported images up to 8 MiB. There can be eight pending local attachments, 32 distinct remote references, and at most 24 MiB in the combined prompt. Oversized or unsupported files fail rather than being silently truncated.

Clipboard access occurs only on an explicit paste action. On Linux, image paste can use `wl-paste` on Wayland or `xclip` on X11. The external editor runs locally and returns its contents to the draft; it does not submit them.

`!git status` runs through remote Pi and includes its output in model context on the next prompt. `!!git status` still runs remotely and is recorded in the session, but excludes its output from model context. Neither form starts a model turn by itself.

### Slots and sessions

A **slot** is a running Pi process, like a tmux pane. A **Pi session** is its current conversation file. `/new`, `/fork`, and `/resume` change the file inside that process; `pi-remote new` creates another process. Every attached client sees a slot's session changes. Two clients can attach at once; the first valid dialog answer wins.

The daemon rejects attempts through its create/resume commands to open a file already owned by another of its slots. This is not a system-wide lock: Pi instances outside this daemon and extension-internal session switches cannot be fenced through stock RPC. Do not open the same file in a separate normal Pi process.

### Side conversations

`/side` copies the current saved conversation into a **new Pi process and session file**, without switching or interrupting the main conversation. `/side Explain this design` also sends that text as the side conversation's first prompt. The daemon sends the prompt once; opening the split, attaching again, or reloading never resends it. Local pending attachments stay with the main editor.

The new process uses the same remote working directory and launch options. This isolates the conversation, not the filesystem: both agents can read and change the same files. It uses stock Pi's `--fork`, which copies the persisted session tree with a new session ID and a `parentSession` link to the source file. If the main agent is running, the side starts from the messages already saved to disk, not partial streamed output or pending prompts. Pi handles incomplete tool-call history when it prepares the next model request. If the main session file has not been written yet, `/side` reports that there is nothing saved to fork.

Side files stay under `~/.pi/agent/side-sessions/`, grouped by workspace like normal Pi sessions. `PI_CODING_AGENT_DIR` relocates this directory with the rest of Pi's agent data. They do **not** appear in the main conversation's normal `/resume`. Use `/resume --side` to open an old side conversation in the current slot, or `pi-remote new --session /remote/path/to/side.jsonl` to open it in a new slot. Inside a side slot, `/new`, `/fork`, and ordinary `/resume` use the side directory too.

Each side gets a normal slot number. The slot list groups it under its parent, and the footer shows `side of #N`, including when a custom footer is installed. `parentSlotId` in the daemon catalogue refers to the **parent slot**, not a Pi session ID. Changing the parent's session with `/new`, `/fork`, or `/resume` does not change this relationship.

**Cleanup:** when a side slot has no attached clients for 90 seconds, the daemon stops it once it is idle. This also applies to a side slot whose split never opened. Reattaching during the grace period keeps it alive. Active agent turns, queues, shell commands, startup, and open dialogs prevent idle cleanup. The daemon uses Pi's reported activity; it does not independently track extension-internal background jobs. Stopping or losing the parent Pi process stops its side slots and their descendants, even if they are busy; `/reload` and deliberate daemon restarts preserve them. Stopped side slots leave the catalogue, but their session files remain available. Ordinary slots retain their existing detach behavior.

**Ghostty:** automatic splits require macOS, Ghostty 1.3 or newer, `macos-applescript = true` in Ghostty's configuration, and macOS Automation permission. The client captures the original pane before requesting the side slot, then opens a split running this installation's `pi-remote attach` with the same host, daemon and local UI options. No terminal keystrokes are simulated. Because the attach command bypasses shell startup files, the split receives only five explicit environment overrides from the current client: `PATH`, `SSH_AUTH_SOCK`, `PI_CODING_AGENT_DIR`, `PI_REMOTE_RENDERER_REPO`, and `XDG_CONFIG_HOME`, when set. It otherwise uses Ghostty's normal environment; credentials and other shell exports are not copied. If Ghostty is unavailable or splitting fails, the side slot remains available and the client prints the full attach command. Attach before idle cleanup stops it.

By default, the split follows the current pane's longer pixel dimension: wide panes split right; tall or square panes split down. Cell dimensions reported by the terminal are used when available, with a 9×18-pixel estimate otherwise. Set `sideSplit` in your [local config](#configuration) (or the file selected by `--ui-config`) to override it:

```json
{ "sideSplit": "auto" }
```

Allowed values are `auto`, `right`, `down`, `left`, and `up`. `/reload-ui` rereads the setting. Both the client and daemon must be updated to use `/side` and `/resume --side`; an older daemon is rejected before any side slot is created.

### Reload remote Pi

Use `/reload` to stop and launch remote Pi again in the **same slot and stored session file**, so it reads remote extensions and configuration again. The original launch arguments are reapplied. The client stays attached and the daemon is not restarted. Persisted conversation history remains; running work, steering/follow-up queues, open dialogs, in-memory model or thinking-level changes, and other unpersisted process state are discarded. Before the first prompt is persisted, the session path can stay the same while the new process creates a different session ID. Busy reloads require confirmation, with **Cancel** selected by default. The server can also require confirmation when work starts before the client sees it.

While Pi starts, the client blocks remote submissions and retains your draft and pending local attachments. The client can send startup dialog answers, but Pi 1.0.4 cannot read them while an initial `session_start` hook awaits a dialog; the [upstream RPC limitation](#upstream-rpc-limitations) still applies. When Pi is ready, a fresh snapshot restores authoritative history, widgets, and command suggestions. `/reload-ui` remains separate: it rereads local UI configuration and reloads adapters, theme, bell, and split settings without restarting remote Pi.

Reload requests are never replayed after a disconnect. Check the slot before trying again. Only an explicit force confirmation after the server's busy refusal sends a second request; that refusal did not accept a restart.

Existing deployed daemons must be upgraded before they support `/reload`; installing a newer client alone does not add the method to a running daemon. See [Deployment](#deployment). `pi-remote restart-daemon` applies the same reload to every slot at once while replacing the daemon. Pi's version is pinned and checked **before** stopping the old process, so an incompatible Pi executable leaves the old process running instead of killing it.

## What survives disconnect

Automatic reconnect applies after a terminal client has attached successfully. It retries transport connections with backoff, obtains a fresh snapshot, and resumes display of the same slot. It does not create a replacement process or repeat prompts, shell commands, dialog answers, session changes, or reload requests. Missing/exited slots and incompatible versions stop recovery. Draft text and pending local attachments remain in the same open client, not in durable storage.

Local notices stay beside the message they followed, so later messages push them up rather than leaving them at the transcript's bottom. Startup notices appear before the conversation. Successful reconnect removes old connection notices and adds one current reattachment notice; unrelated warnings remain. Notices are display-only, bounded to 50, and cleared when the slot's session changes or their message or tool row is no longer in the displayed history.

Remote state survives client disconnect:

- Model generation, remote tool execution, and remote shell commands.
- Steering and follow-up queues held by Pi.
- A partial streamed assistant message and currently running tools.
- Open extension `select`, `confirm`, `input`, and `editor` dialogs.
- Extension status entries and text widgets.

Dialogs have **no client-imposed timeout**. If an extension explicitly supplies a timeout, Pi keeps its normal timeout semantics. Disconnect is never converted to cancellation.

On attach or refresh, a successful history snapshot replaces completed live messages with saved branch entries. Its live buffer contains only unfinished messages; the client then applies events newer than the snapshot's sequence number. Completion comes from `message_end`, not timestamps or task IDs, so queued background notices do not appear again after the final answer. Failed queries and incomplete startup/session-transition snapshots do not retire live messages. A slot with no client attached keeps completed live messages until the next successful attach or snapshot. Reconstructed display state is never supplied back to the model or written into Pi's session file.

The snapshot's optional `historyComplete` marker identifies this contract: `true` means saved history is current through the snapshot boundary; `false` means startup or a session transition is using cached history and an uncheckpointed live buffer. Neither form merges messages by timestamp. Unmarked snapshots from older daemons retain their legacy merge behavior. Both the client and daemon need this update to fix duplicate background notices. The daemon runs new code only after [`restart-daemon`](#deployment).

## Terminal status, bell, and workspace urgency

The local TUI reports one root record through the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status). It starts `idle`, reports `working` during a run or compaction, and reports `done` or `error` when the operation settles. `agent_end` is not completion: retries and queued work can follow it. Cancellation returns to `idle`. An unanswered remote RPC dialog reports `blocked`: `confirm` uses `kind=permission`; `input`, `select`, and `editor` use `kind=question`. Local command pickers and custom presentation widgets are not remote RPC dialogs. Detaching clears the terminal record without stopping remote work. There are no child-task records.

Reporting uses terminal capability detection. The client sends `OSC 7501 ; ?` followed by a primary device-attributes query; it sends status reports only if the support reply arrives first, within one second. Set **local** `PI_PROGRAM_STATUS=1` to force reports, or `PI_PROGRAM_STATUS=0` to disable reports and detection. Other values use detection. Unsupported terminals still receive ordinary UI output and bells. The environment setting does not control the bell.

When a run settles normally, it reports `working`, with message `Waiting on background task`, instead of ringing if its last tool call was a successful `background_wait`. The check starts at the later of the run's start or its latest delivered user message. Steering and follow-up messages therefore clear an earlier wait decision; another successful wait can restore it. Background notices and assistant reply text do not affect the decision. Tool-call order determines the last call, including sibling calls in one assistant message; tool-result arrival order does not matter. A successful result must name `background_wait`, match the call ID, and have `isError: false`. The client checks this only at `agent_settled` or an authoritative idle snapshot, never while the run is active. Retry starts remain part of the same logical run. Failed attempts that Pi omits during automatic retry or overflow recovery do not change the decision; an exhausted retry still reports `error`, and cancellation reports `idle`. A successful `background_wait` call returns immediately; it does not mean the background task is complete. The root stays `working` through background completion until the wake-up run finishes. Each new run starts without a wait decision, so a wake-up that ends without calling `background_wait` rings even if other background tasks remain. Extension statuses remain ordinary footer data; no status key, widget, or background notice controls waiting.

The local terminal bell (BEL) is built in and enabled by default; no presentation adapter or remote bell extension is needed. It rings once when an observed run or compaction settles `done` or `error`, and immediately when a new remote question or permission dialog opens, even mid-run or while waiting for background work. A completed run with the waiting ending does not ring. Background completion notices do not ring or end the waiting state. Each successive completed run can ring, even if both finish `done`.

Attaching, starting work, retries, cancellation, and detaching are quiet. An idle attach can recover a valid waiting ending without ringing. Existing dialogs on attach or reconnect do not ring again. A reconnect or snapshot refresh that finds previously observed active work complete can ring once; an active slot exiting can also ring. An idle snapshot with a new final assistant message can prove that a background wake-up run completed while disconnected. The client tracks the current run's tool-call metadata and starting assistant checkpoint so an old wait cannot suppress a new empty run or standalone compaction. Saved history has no run-start records; attach, refresh, and reconnect recovery therefore use only the latest assistant completion segment. Ambiguous history can ring more often than the live event path rather than reuse an earlier wait. A busy snapshot taken after a new run starts but before its first message cannot distinguish that new run from the previous run's pending settlement; its wait decision can remain stale until new user input or a tool call arrives. Duplicate events and snapshot journal replay do not repeat notifications.

Pi 1.0.4 has no general RPC abort event. The client tracks its own abort requests and recognizes assistant `stopReason: "aborted"`, compaction's `aborted` flag, retry's `finalError: "Retry cancelled"`, and newer Pi's `agent_settled.aborted: true`. With Pi 1.0.4, an abort from another client that produces none of these signals cannot be distinguished from ordinary settlement.

Automatic compaction before a prompt is part of that prompt, so it stays `working` until the following run settles. If a prompt from another client, the daemon, or an extension fails after that compaction but before `agent_start`, Pi 1.0.4 sends the error only to the requester. Other clients stay `working`; reconnecting returns them quietly to `idle`. The client does not use a timeout because model routing and `before_agent_start` hooks can legitimately be slow.

Ghostty's default `bell-features = attention,title` behavior adds a 🔔 title marker and requests attention. SketchyBar can mark a workspace urgent when a Ghostty window title starts with `🔔 `. Ghostty clears the marker on focus or keyboard input. Window titles do not aggregate all Ghostty split panes.

Use `--no-bell` with `new` or `attach` to disable the built-in bell for that client. To disable it by default, set `"bell": false` in your [local config](#configuration) (or the file selected by `--ui-config`). `/reload-ui` rereads the setting; `--no-bell` always wins. The bell still rings when work settles in a focused window; focus-aware suppression is not implemented.

Invalid unified configuration stops commands that read connection defaults. An invalid alternate UI config produces a warning and rejects the whole file, even if its `bell` value is valid. At startup, the bell then uses its default (on), unless `--no-bell` was supplied. A failed `/reload-ui` retains the previous bell setting.

Do not also load a terminal-bell presentation adapter unless you want a second bell. Remote Pi's TUI-only `emit-terminal-bel.ts` remains inactive in RPC mode; native Pi can still use it.

## Extension compatibility and local presentation

The **stock remote harness is unchanged**. Remote Pi loads extension factories normally; their agent hooks, tools, providers, and credentials stay remote. Its RPC UI forwards dialogs, notifications, status text, string-array widgets, terminal title, and editor text. It cannot transfer executable terminal components to the client.

The transcript composes Pi's public `UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`, shell, custom-message, skill, and summary components. Built-in tool renderers come from Pi's public tool factories; their executors are not retained or called locally. Pi owns Markdown, thinking styles, spacing, tool backgrounds, expansion, and renderer state. The client only reconciles remote messages and strips terminal controls from wire content. Thinking is visible by default, as in Pi. Detach, reconnect, and UI reload retire local renderer timers without stopping remote tools; restored results do not invent new execution times.

Edit diffs use the remote result's `details`. The built-in edit renderer's pre-execution filesystem preview is disabled locally, so a remote path cannot accidentally preview a file on the client machine. No Pi internals or fake session are needed for transcript rendering.

The local client can separately load trusted presentation adapters for tool call/result renderers, custom message/entry renderers, Markdown transforms, custom footer/header/editor components, widgets, display events, commands, and shortcuts. Local adapters use snapshot data; they are not another `AgentSession`. Without an adapter, the client uses its built-in display. Renderer failures produce local warnings rather than stopping the remote agent.

### Opt in explicitly

Keep your trusted adapter beside your **local** `$XDG_CONFIG_HOME/pi-remote/config.json` (default `~/.config/pi-remote/config.json`) and add `"extensions": ["./my-ui.ts"]`. Keep the same layout on the devbox for the phone client. Each machine needs its own copy of the adapter and its display dependencies; deployment does not install them. You can also use repeatable `--ui-extension PATH` flags. See the [unified config example](#configuration) and [migration instructions](#removed-ui-configuration-path).

`--ui-config PATH` selects another file for UI settings only and replaces the default UI config, without overriding connection defaults. Config-relative extension paths resolve beside their originating file; command-line paths resolve from the local working directory. `~/` means local home here. CLI extension paths are added to the config allowlist and deduplicated. Only exact files are selected: the client does **not** automatically load local Pi extension directories, project resources, or packages. Explicit adapters can still import other modules.

```sh
pi-remote attach 1 --ui-extension ./my-ui.ts --theme dark
pi-remote attach 1 --ui-config ./remote-ui.json --no-reconnect
```

`--theme NAME` overrides the config theme. Without either, the client uses the `theme` setting from local `~/.pi/agent/settings.json`, then `system`. Available themes include `system`, `dark`, `light`, and JSON themes from local `~/.pi/agent/themes/` (or `$PI_CODING_AGENT_DIR/themes/`). A `LIGHT/DARK` pair, such as `light/dark` or `gruvbox-light/gruvbox-dark`, selects the member for the local terminal, like Pi. The client asks the terminal for its background color (OSC 11) at startup, then falls back to the terminal's light/dark report and `COLORFGBG`, then dark. Pairs also follow live light/dark switches from terminals that send mode 2031 reports. A single theme name, such as `gruvbox-dark`, is always used as given, even in a light terminal. Use `/theme NAME` to change the current client and `/reload-ui` to reread its selected adapters/config. Neither command changes remote settings or restarts Pi; theme files are not watched automatically.

Adapters outside the checkout must not import pi-remote source files. Import public display APIs and types from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` instead. The presentation host resolves these packages, and `jiti`, to its installed copies. Keep any extra display modules available on each machine and select only visual factories, not providers, workers, or tool executors. Missing or incompatible imports produce a load warning.

Use `/reload-ui` or reattach after updating a laptop adapter. Reload the phone after updating the devbox copy. Changes to remote Pi extension factories require a new slot or `/reload`; changing a presentation adapter does not reload remote extensions.

### Read remote widgets in a local adapter

`ctx.ui.getRemoteWidget(key)` is a **pi-remote-only** read API, not a stock Pi method. It returns an immutable object with `key`, `lines`, and `placement`, or `undefined` for an absent, cleared, empty, or malformed widget. The lines have terminal escape codes removed. Embedded newlines become separate rows, and tabs become spaces, so each string is safe to return as one component row. Reading sends no requests, runs no tools, and cannot change remote state.

Call the getter from `render()` to read the current state after each remote update or reconnect. A local widget with the same key replaces the plain remote display, but the getter still reads the remote lines. Return `[]` when the remote widget is absent. If the local component fails, the client removes it and shows the plain remote copy; `/reload-ui` can restore the local renderer. Declare the small read API locally in your `my-ui.ts`; no pi-remote source import is needed:

```ts
import type { ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

type RemoteWidgetUI = ExtensionUIContext & {
  getRemoteWidget(key: string): {
    readonly key: string;
    readonly lines: readonly string[];
    readonly placement: 'aboveEditor' | 'belowEditor';
  } | undefined;
};

export default function myUi(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    const ui = ctx.ui as RemoteWidgetUI;
    if (typeof ui.getRemoteWidget !== 'function') return; // Stock Pi has no such method.
    ui.setWidget('my-widget', () => ({
      invalidate() {},
      render(width) {
        const remote = ui.getRemoteWidget('my-widget');
        return remote ? remote.lines.map(line =>
          truncateToWidth(ui.theme.fg('accent', line), width)) : [];
      },
    }), { placement: 'belowEditor' });
  });
}
```

Use the local theme for colour and the supplied width for layout. Choose the same placement as the remote widget. This lets a local adapter render remote task status without loading the worker factory.

### Trust boundary

**Adapters are trusted arbitrary JavaScript, not a sandbox.** Imports and factories run with the local process's normal file, network, credential, and subprocess privileges. Custom editors receive submission callbacks and therefore have **input authority**: they can submit prompts or commands, not merely change their appearance. Load only code you trust with that authority.

The presentation API omits tool execution, provider registration, credential lookup, remote session mutation, and `ctx.ui.custom()`/local dialogs. Blocked API calls are a **compatibility guard, not a security boundary**; they do not constrain arbitrary JavaScript or custom-editor submission. Tool registration retains rendering fields, not executors. Select visual modules deliberately rather than running every remote extension factory again locally.

Remote RPC still ignores terminal-only hooks such as footer/editor factories, and remote extensions see `ctx.mode === "rpc"`. Local presentation support does not make remote TUI-only code run or provide complete `ExtensionAPI` compatibility.

### Detect a pi-remote session

Extensions can read these environment variables to detect pi-remote. The daemon sets them on each remote Pi process. The local client sets the same variables in its own process before it loads presentation adapters.

| Variable | Value |
|---|---|
| `PI_REMOTE_SESSION` | `1` |
| `PI_REMOTE_SESSION_HOST` | Remote host name. Remote Pi gets the remote `hostname`; the local client uses the SSH host, or the local hostname with `--local`. |
| `PI_REMOTE_SESSION_SLOT` | Slot UUID |
| `PI_REMOTE_SESSION_SLOT_NUMBER` | Stable slot number, or empty when unknown |

For example, a local footer adapter can show `PI_REMOTE_SESSION_HOST` to indicate a remote session. The built-in footer shows the host after the Nerd Fonts remote glyph (`nf-cod-remote`, U+EB3A). `PI_REMOTE_HOST` is a different variable: it selects the CLI's default SSH host.

### Upstream RPC limitations

- Pi 1.0.4 waits for initial `session_start` hooks before it starts reading RPC stdin. An extension that **awaits a dialog during initial startup** can therefore block startup before its answer can be read. The daemon retains the process and shows its starting state; it does not invent a timeout or patch the harness. Dialogs from commands or running tools were tested successfully.
- RPC does not report cancellation of a dialog by an extension's abort signal. Explicit timeout expiry and client answers are tracked, but a signal-cancelled dialog can remain displayed until the user dismisses it.
- In-place tree navigation is unavailable. `/tree` and double-Esc fall back to the tree-style `/fork` picker: they create a **new session file**, not another branch inside the existing file. Stock RPC can fork only before user prompts, so assistant entries are shown for context but cannot be selected as fork points. `/login` and `/settings` are unavailable here; configure the remote harness with normal Pi over SSH.
- Stock RPC has no harness reload command. This client's `/reload` uses the daemon to stop and launch Pi again; it is not an in-process RPC reload. `/reload-ui` changes only local presentation.
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
- Explicit slot kill (`pi-remote kill` or `/quit`), `/reload`, or daemon shutdown closes Pi's stdin. A display parser/reducer failure does not kill a healthy Pi process.
- Output queues/JSONL frames are bounded at 64 MiB. A slow client is disconnected rather than stalling Pi. Extremely large history records can fail attachment; pagination is not implemented.
- `slots.json` contains process metadata and session paths, not credentials or a second transcript. `slots-counter.json` keeps the next slot number so deleting stopped side slots never reuses a number after a restart. `daemon.log` contains stderr, which may include sensitive extension diagnostics. It is private but not rotated automatically yet.

Pi's exported `RpcClient` is not used for transport ownership: in 1.0.4 it has no public dialog-response method and imposes a fixed request timeout. `src/daemon/pi-process.ts` implements the documented stdio framing directly, with unique request IDs and no deadlines on agent commands that may await a dialog. This changes no Pi code.

### Transcript filtering

Interactive `attach` and `new` request transcript filtering with the `filterTranscript` protocol flag, including reconnects. This omits opaque assistant `thinkingSignature` and `textSignature` fields from outgoing snapshots and live events. All history entries, visible text/thinking, content positions, and history checkpoints remain intact. Pi's session files, the daemon's history cache, raw RPC replies, `watch`, and headless output are unchanged. Both an updated client and daemon are needed for this transfer reduction; older daemons still work and send the full fields. This does not add compression.

### Incremental history refreshes

Attach and reconnect still download the full session history. After a turn, the client requests only entries after its last verified history checkpoint. The checkpoint follows session-file order, not the active branch's leaf. Live events never advance it. The daemon combines the new entries with its cached history and preserves the same saved-history/live-message boundary as a full snapshot.

Session changes, missing checkpoints, and missed events use a full snapshot. Older clients continue to receive full snapshots; newer clients also accept full replies from older daemons. Both an updated client and daemon are needed to reduce refresh traffic. The local fork picker can reuse verified history from existing daemons that send `historyComplete`. Forking still downloads a full snapshot of the new session; reusing the copied history across session files is not implemented.

### Daemon crash versus client disconnect

Client disconnect is supported; daemon/host crash recovery of in-flight work is **not**. If the daemon dies, its pipes close and stock Pi exits. On daemon restart, known slots are listed as stopped, without rerunning tasks automatically. Only a deliberate [`restart-daemon`](#deployment) reopens slots. Open the recorded session file in a new slot to resume manually. Pi may defer creation of a new session file until the first assistant response.

An exclusive startup lock serializes stale-daemon reclamation. If the launcher itself crashes leaving `start.lock`, startup fails closed; inspect its PID and `daemon.log` before manually removing it. Never remove a live daemon's lock/socket. A reused PID also fails closed.

## Deployment

The remote host runs a copy of this checkout's compiled code. There is no package install, git checkout, or `PATH` entry on the host:

```text
~/.local/share/pi-remote/
  releases/20261008T153000Z-9f6e91e/   one directory per deploy: dist/, node_modules/, bin/, completions/
  bin/pi-remote -> ../releases/<current>/bin/pi-remote
~/.pi/remote/                          daemon state: socket, slots.json, daemon.log; never touched by deploy
```

The client runs `ssh HOST ~/.local/share/pi-remote/bin/pi-remote bridge`, so that symlink alone decides which release new connections use. If the daemon is not running, the bridge starts it from the same release. Use `--remote-bin` to point the client at another launcher.

`npm run deploy -- [HOST]` (default host: `PI_REMOTE_HOST`, then the config file) does this:

1. Builds `dist/` locally, including the phone app, and copies it with `package.json`, the lockfile, `bin/` and `completions/` to a new release directory, named after the UTC time and git commit (`-dirty` with uncommitted changes).
2. Runs `npm ci --omit=dev --ignore-scripts` there and checks that the release starts.
3. Switches `bin/pi-remote` to the new release in one atomic rename. When the deploying machine's config contains `web`, installs/updates, enables, and starts/restarts [the phone web service](docs/phone.md#install-and-run) on that release. It discovers the target's Tailscale origin unless configured explicitly, preserves private web state, and prints any missing routing/linger setup commands without changing them. Web setup failures skip old-release cleanup. This only reconnects phones and runs even with `--no-restart`. Without `web`, it leaves systemd untouched.
4. Deletes old releases. It keeps the new release, the previous one, and any release a running process uses. A release never changes after install, because a running daemon loads modules from its own release.
5. Runs `pi-remote restart-daemon`, which waits until no slot is busy. If you stop the wait with Ctrl-C, the new release stays installed and the old daemon keeps running; run `pi-remote restart-daemon` later. `npm run deploy -- --force` interrupts busy slots instead of waiting; `npm run deploy -- --no-restart` skips this step.

### Restart the daemon without losing slots

```sh
pi-remote restart-daemon           # waits until no slot is busy, and says which slots it waits for
pi-remote restart-daemon --force   # interrupts busy slots
```

This is [`/reload`](#reload-remote-pi) applied to every slot at once, plus a new daemon:

- The daemon uses `/reload`'s rules for every slot: a slot that is starting, reloading or changing session blocks the restart, and a busy slot blocks it unless `--force` is given. It checks all slots and commits in one step, so a prompt cannot start in between. A refusal locks and stops nothing; the client asks again every 2 seconds until the daemon accepts or you press Ctrl-C.
- When it accepts, it marks each running slot `reopen` in `slots.json` and exits. The next daemon starts from the installed release and starts those slots again from their session files, with the same slot IDs, numbers and launch arguments.
- Attached clients reconnect automatically and show the same slots. As with `/reload`, persisted history remains; in-memory state such as model or thinking-level changes is discarded.
- Slots that were already stopped stay stopped. A crashed daemon never reopens anything.

Daemons deployed before `restart-daemon` existed do not support it. Stop such a daemon once by hand when its slots are idle (`kill` the PID in `~/.pi/remote/daemon.lock/pid`), then reopen sessions with `pi-remote new --session`.

A 0.2 client also works with a running 0.1 daemon: it uses the installed release's filesystem helper, over a separate SSH process, for path completion and attachment reads. Prompts and other mutations still go through the existing daemon, and a transport error never triggers this fallback.

## Development and verification

Locally, `pi-remote` runs from `src/` through the `tsx` devDependency, so source edits take effect on the next run without `npm run build`. `npm link` creates a symlink to this checkout in npm's global bin directory; `npm unlink -g pi-remote` removes it. Deployed releases contain no `src/` and run the compiled `dist/`; `npm run deploy` builds it. To try daemon changes on the remote host, run `npm run deploy`: attached clients reconnect to the same slots on the new code.

```sh
npm run verify

# Golden master: real stock Pi versus pi-remote in paired tmux terminals.
# Requires tmux and Pi 1.0.4 on PATH. Uses a deterministic local provider, no credentials.
npm run test:golden

# Repeat with the unchanged Rowan compact-tools, assistant-background and caret factories.
npm run test:golden -- --rowan

# Exercise concurrent on-demand startup and crash/stale-lock recovery with the built CLI.
# Uses an isolated local daemon with no Pi slots or model calls.
node --import tsx test/smoke/startup-smoke.ts

# Offline tests use a deterministic child that speaks Pi-shaped RPC.
# This optional test runs real Pi and existing extensions on an isolated remote workspace.
PI_REMOTE_TEST_HOST=devbox node --import tsx test/smoke/remote-smoke.ts

# Also make one real model request using the host's existing credentials/configuration.
PI_REMOTE_TEST_HOST=devbox PI_REMOTE_TEST_MODEL=1 node --import tsx test/smoke/remote-smoke.ts

# Test completion, attachments, numeric slots and exactly-once shell execution across reconnect.
PI_REMOTE_TEST_HOST=devbox node --import tsx test/smoke/remote-features-smoke.ts

# Test actual local terminal input/reconnect in an isolated tmux server.
# Requires tmux and the user-specific Rowan presentation adapter dependencies.
PI_REMOTE_TEST_HOST=devbox node --import tsx test/smoke/terminal-smoke.ts --real /path/to/my-ui.ts
```

The remote smoke tests use separate `/tmp/pi-remote-{smoke,features,terminal}.*` state directories, start only their own slots, and stop those slots and their daemons afterward. The terminal test uses the separate `pi-remote-test` tmux server. It leaves test files/logs for inspection. It does not change global Pi settings or credentials.

The golden test starts a normal Pi TUI and a pi-remote client backed by stock Pi RPC. It submits the same prompts, waits at deterministic streaming/tool checkpoints, toggles tools and thinking, runs a shell command, submits a second prompt, and compares resumed/restored histories. Restoration also checks that no messages or provider calls were added and the remote Pi process stayed alive. The default matrix covers 80/120 columns and dark/light themes. `--widths`, `--themes`, `--rows`, and `--pi-bin` select other configurations; `--remote-bin` can compare an older checkout.

**Golden expectations follow the tested Pi version.** Future Pi updates may intentionally change the correct appearance; the goal is to match the new stock Pi, not preserve old screenshots forever. Upgrade the pinned dependencies and version checks together, then review new captures. See [reference behavior and upgrade guidance](test/golden/README.md#reference-behavior-follows-pi).

Each checkpoint saves both raw ANSI screens, transcript text, resolved foreground/background/attribute runs, diffs, and side-by-side views. The test fails on text or style differences after normalizing wall-clock duration labels. Startup/editor/footer UI and transient toggle notifications are outside this transcript comparison. It checks neither inline images nor terminal palette auto-detection. Isolated homes, sessions, workspaces, daemons, and a private tmux server keep tests separate from active work. Only test processes are stopped; the printed artifact directory is retained for inspection.

### Scrolling benchmark

Capture an existing slot once, then measure local scrolling without a remote connection:

```sh
npm run test:scroll -- --capture /tmp/pi-scroll.json --host devbox --slot 2 \
  --scenario idle-scroll --iterations 10
npm run test:scroll -- --snapshot /tmp/pi-scroll.json \
  --scenario assistant-delta-scroll --iterations 10
```

Capture uses only read-only slot/history queries. The new snapshot file is private (`0600`); it contains conversation and tool output, so do not commit or share it. Replay uses a memory terminal and reports frame/render timings and output hashes, not transcript text. Streaming and metadata events are simulated locally; they never change the real slot.

For before/after comparisons, use the same snapshot, dimensions, theme and adapter code in both worktrees. To benchmark a real adapter, pass `--real /path/to/my-ui.ts` and an absent `--ui-config` path to bypass configured adapters. Use the same user-owned adapter outside both worktrees; no adapter path is built into the runner. Compare the reported transcript hashes and renderer-patch flags. Run each scenario separately (`idle-scroll`, `metadata-update-scroll`, `assistant-delta-scroll`) and alternate baseline/fixed runs. Startup is excluded; normal renderer timers remain active. See [`test/bench/scroll-benchmark.ts`](test/bench/scroll-benchmark.ts) for complete commands and limitations.

Compare the actual stock Pi terminal UI using a real, isolated SDK session:

```sh
npm run test:native-scroll -- --snapshot /tmp/pi-scroll.json --presentation vanilla
npm run test:native-scroll -- --snapshot /tmp/pi-scroll.json --real /path/to/my-ui.ts
```

Native startup selects compaction-aware history. Use `--history full` for a diagnostic full-history comparison, or [`test/bench/context-scroll-snapshot.ts`](test/bench/context-scroll-snapshot.ts) to select the same compacted entries for remote replay while retaining all entries for footer totals. Pin the same theme in both runners (`--theme-file` for native, `--theme` for remote). Optional `--profile FILE` captures only measured frames; profiling runs should be separate from timing comparisons. The explicit idle-only `--experiment` modes test potential cache savings and are **not production behavior**. CPU frame cost is not delivered FPS. pi-remote uses a local 8 ms minimum interval between normal frame starts; focused keyboard input stays immediate. Stock native Pi still uses its 16 ms throttle. Add `--render-interval 16 --scheduled-duration 2000` to an idle replay for a scheduler control, or use `--render-interval 8` for the current default. The scheduled measurement counts moving frames written to a memory terminal, not frames displayed by a terminal emulator. See [the original investigation](test/bench/scroll-performance.md) and [production fixes](test/bench/render-budget.md) for measurements and limitations.

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

Each directory is a separate TypeScript project:

```text
cli ──→ daemon ──→ protocol
    ├─→ client ──→ protocol
    ├─→ tui    ──→ protocol
    │       └────→ config
    └────────────→ config

cli ──→ web/server ──→ daemon, client, protocol, config, web/shared
        web/build ──→ tui, protocol, web/shared
        web/client ─→ client, tui, protocol, web/shared
        web/shared   (no project dependencies)
```

The daemon owns remote Pi processes. The client owns connections and reconnection,
without terminal rendering. The TUI accepts the protocol's connection interface;
it does not import the client implementation. The CLI connects these pieces and
owns local-connection startup and the legacy filesystem fallback.

- `src/protocol/types.ts`, `methods.ts`: wire records and the method-to-parameters/result map. Request results are inferred from the method name. Pi's inner RPC payloads still pass through unchanged.
- `src/protocol/jsonl.ts`, `live.ts`: bounded JSON-line framing and shared live-state reconstruction.
- `src/protocol/files.ts`, `attachments.ts`: filesystem result types, limits, and safe attachment reading on either host.
- `src/protocol/remote-session.ts`, `paths.ts`: session environment contract and socket locations.
- `src/config/client.ts`, `presentation.ts`: shared local config parsing, XDG paths, and presentation-path resolution. This module has no dependency on protocol or application runtime projects.
- `src/protocol/notification-stream.ts`: the read-only daemon event contract used by background notifications, not the attached TUI transcript stream.
- `src/web/shared/`: web-only module-name normalization, presentation worker result types, and bounded source reading/hashing. This project has no project dependencies; Node-only file helpers are separate from the browser-safe normalizer.
- `src/daemon/supervisor.ts`, `pi-process.ts`, `side-sessions.ts`: slots, snapshots, dialogs, Pi RPC child ownership, persistence, and side-session storage.
- `src/daemon/launch.ts`, `bridge.ts`, `files.ts`: private daemon startup, socket/stdin bridging, and remote filesystem requests.
- `src/client/connection.ts`, `reconnect.ts`, `compat-client.ts`: SSH transport, correlation, snapshot-based reconnect without mutation replay, and legacy read-only fallback.
- `src/client/restart-daemon.ts`, `scripts/deploy.ts`: daemon replacement and release installation; see [Deployment](#deployment).
- `src/tui/tui.ts`, `view.ts`, `transcript.ts`: terminal interaction and transcript projection.
- `src/tui/presentation.ts`, `presentation-history.ts`, `local-theme.ts`: explicit adapter loading, read-only history, and local themes.
- `src/tui/local-input.ts`, `editor-completion.ts`, `side-launcher.ts`: local attachments, editor completion, and terminal splits.
- `src/tui/session-labels.ts`: display labels and detach/stop messages.
- `src/cli/main.ts`, `connections.ts`, `completion.ts`: commands, connection wiring, and shell completion.
- `src/cli/config.ts`: connection-default wrappers for `host` and `cwd`, using the shared config schema and path.
- `bin/pi-remote`, `src/protocol/node-entry.ts`: source/compiled launch selection and child-process module arguments.

Presentation adapters are user-owned files beside `config.json` (for example `my-ui.ts`), not repository source or deployed release files.

Project references enforce these dependencies: a layer cannot import another
layer's source unless it declares that project as a reference. `npm run build`
clears old output and uses `tsc -b` to build dependencies in order into matching
`dist/` directories. This also prevents deployment from copying stale modules.
`npm run check` builds the projects and checks the protocol's compile-time
contract tests and the deployment tool. It writes ignored build output because dependent projects need
declarations. Network input is still validated at runtime; static request types
do not replace validation.

Tests mirror the layers under `test/`. Cross-layer behavior is in
`test/integration/`, optional host tests in `test/smoke/`, and performance and
golden drivers in `test/bench/`. Deterministic unit/integration tests do not need
SSH credentials or model calls.

Pi references: [RPC](https://pi.dev/docs/latest/rpc), [extension UI](https://pi.dev/docs/latest/rpc-extension-ui), [JSON events](https://pi.dev/docs/latest/json).
