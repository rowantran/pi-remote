# pi-remote

Use **Pi's own interface** on a laptop while Pi runs on a remote machine. Typing and scrolling stay local and instant; closing the terminal, detaching, or losing SSH does not stop the remote Pi.

## How it works

The remote daemon runs the normal interactive `pi` program in a terminal (PTY) it owns, with **pi-remote's Pi extension** loaded (`src/pi-extension/pi-remote.ts`; Pi lists it as `pi-remote.ts`). Pi draws its interface as usual. The extension sends each of Pi's seven screen sections (transcript, pending messages, status, widgets, editor, widgets, footer) to the laptop as line changes.

The laptop client arranges those sections in Pi's fullscreen layout and keeps two parts local:

- **Scrolling:** the transcript scrolls in a local view, with no network round trip.
- **Typing:** a local copy of Pi's editor shows each key at once. Every key also goes to Pi, which reports its exact editor state; the local copy follows Pi when they differ (for example after Pi clears the editor on submit).

Everything else is Pi itself: pickers (`/model`, `/tree`, `/resume`, settings), dialogs, extension UI, the footer and tool output. Those keys go straight to Pi and show Pi's result one round trip later. While Pi's autocomplete list is open, its navigation keys also go to Pi.

Pi draws at one terminal width. The client that typed or resized most recently sets that width (and light or dark theme); other attached clients cut or pad lines until they type.

## Phone client

The browser client shows the same interface through the daemon, at the phone's width, with a native text box for prompts. `pi-remote serve` has only a private Unix socket, requires your Tailscale identity and device pairing, and never opens a public TCP port. See [phone setup, configuration, and security](docs/phone.md).

## Quick start

Requires Node.js 22.19+ on both machines, working SSH authentication, and **Pi 1.4.0** installed and configured on the remote host. Local dependencies are pinned to the same Pi version; a separate local Pi CLI is not required. Replace `devbox` with your SSH host alias and `/remote/project` with an existing remote directory.

From this checkout on your local machine:

```sh
npm ci --ignore-scripts
npm link                     # puts pi-remote on PATH, linked to this checkout
npm run deploy -- devbox      # installs on the remote host; see "Deployment"

# Set the default SSH host once (see "Configuration" below).
mkdir -p ~/.config/pi-remote
echo '{"host": "devbox"}' > ~/.config/pi-remote/config.json

# Start a remote Pi and attach.
pi-remote new --cwd /remote/project
```

Remote Pi loads its normal settings, credentials, providers, extensions, skills, and trusted project resources. Deployment copies application files, not your Pi configuration.

```sh
pi-remote ls                         # list slots; --all includes stopped ones, --json for scripts
pi-remote attach 1                   # attach by number, full UUID, or unique UUID prefix
pi-remote attach                     # the only active slot, or a picker
pi-remote                            # picker: attach, start a new session, or resume
pi-remote new --cwd /remote/project --no-attach
pi-remote new --cwd /remote/project -- --model PROVIDER/MODEL   # Pi options after --
pi-remote resume                     # search stored sessions; or `resume 4` for stopped slot 4
pi-remote new --cwd /remote/project --session /remote/session.jsonl
pi-remote kill 1                     # stop a remote Pi; detaching never does this
```

Use `--host HOST` with any command to select another SSH host. For local testing, use `--local` with a local `--cwd`. Every command accepts an unambiguous prefix: `n` = `new`, `a` = `attach`, `k` = `kill`, `l` = `ls`, `r` = `resume`, `rest` = `restart-daemon`.

## Commands and keys

Inside a slot, every key and slash command is Pi's own, with these additions:

| Key or command | Effect |
|---|---|
| Ctrl+D (empty editor), `/detach` | Close the client. Pi keeps running. Prints `Detached from slot NUMBER / UUID`. |
| Ctrl+/, `/status` | Status panel: host, latency, daemon, slot, Pi session and file, editor and layout state. |
| Ctrl+\ | Close the client immediately. |
| Pi's `/quit` | Stop Pi. Prints `Stopped slot NUMBER / UUID. Resume it with: pi-remote resume NUMBER`. |
| Pi's external-editor key (Ctrl+G) | Edit the prompt in your **local** `$VISUAL`/`$EDITOR`. |
| Pi's paste key (Ctrl+V) | Paste from the **local** clipboard. Images and copied files are uploaded to the remote host, and Pi gets their paths, as with a local Pi. |

Ctrl+/ needs a terminal with the kitty keyboard protocol (Ghostty, kitty, WezTerm, recent iTerm2); elsewhere it is the same key as Ctrl+-, Pi's undo. `/status` always works. Pi in a slot always uses the kitty keyboard protocol; keys from other terminals are converted.

Pi's bell, window title, desktop notifications, progress, and clipboard writes (`/copy`, OSC 52) reach your local terminal. `--no-bell` or `"bell": false` mutes the bell.

### Picking a session

Run `pi-remote` with no command to open the home picker. It lists active slots with exactly the rows of `pi-remote ls`: number, status, session name (side slots indented under their parent), workspace, attached clients, age, and the first 8 characters of the UUID, with any slot error on the line below. Its header is the same summary line that `ls` prints on a terminal (`devbox · 3 running · 1 stopped`). Type to filter: the search is fuzzy over the session name, number, and directory, and typing a slot number such as `3` or `#3` puts that slot first. Use ↑/↓ (or Ctrl+P/Ctrl+N) to move, Enter to open, and Esc, Ctrl+C, or Ctrl+D to cancel. The last row, **+ New session**, starts a slot in the default directory (`--cwd`, `PI_REMOTE_CWD`, or the config file) and attaches to it. Options such as `--host` work as with other commands: `pi-remote --host otherbox`.

With a default directory, the picker also offers **↺ Resume a session…**, which opens the resume picker described below; Esc there returns to the home picker.

`pi-remote attach` without a slot opens the same picker, limited to active slots, when more than one is active. The picker draws below your prompt and erases itself when you choose or cancel; it never clears the screen or scrollback. Without a terminal, `pi-remote` prints help and `attach` asks for a slot number.

### Resuming sessions

`pi-remote resume` (or `pi-remote r`) lists the sessions stored for a directory and opens one in a new slot. The directory is the default one (`--cwd`, `PI_REMOTE_CWD`, or the config file). Rows are in Pi's order, newest first, and show the session name or first message, message count, age, and the slot that has or had the session:

- `● open in #2`: a running slot has it open. Enter attaches to that slot instead of opening the session twice.
- `○ stopped #4`: the session's most recent slot was stopped. Typing `4` jumps to that row.
Enter opens the chosen session in a **new slot** and attaches to it. `-- PI_OPTIONS` go to the new Pi process as with `new`; a `--session-dir` among them selects the same session directory that `/resume` in such a slot lists. Inside a slot, Pi's own `/resume` switches that slot's session.

`pi-remote resume SLOT` skips the picker and reopens that stopped slot's session, in any directory. If the slot is still running, it attaches. `--no-attach` prints the slot UUID without opening the UI. Slot completion after `pi-remote resume ` offers stopped slots with a saved session. Pi saves a session after its first response, so a slot stopped before that has nothing to resume.

Listing without a slot needs a daemon from this release; an older daemon reports that you should deploy and run `pi-remote restart-daemon`.

### Connection status

`pi-remote ls` (on a terminal) and the pickers start with a summary line: host, the round trip of the list request, and slot counts, for example `devbox · 38 ms · 3 running · 2 stopped`. In the pickers, Ctrl+S opens a status panel; in a slot, use Ctrl+/ or `/status`. The slot panel adds Pi's own report of where it runs (host, PID, session ID and file), which confirms that you are looking at the remote session.

### Session names

`pi-remote ls`, the pickers, and slot completion show each slot's Pi session name. This is Pi's own session name: the one `/name` sets and `/resume` shows. Set it with Pi's `/name NAME`.

The terminal's window title is the one remote Pi sets, so it follows Pi's own format and any extension that changes it.

To name sessions automatically, install a Pi extension that does this **on the remote host**. Remote Pi loads it like any other extension, and pi-remote shows the name as soon as the extension sets it. For example, [`pi-auto-session-name`](https://github.com/patlux/pi-auto-session-name) names an unnamed session after its first run and keeps names set with `/name`:

```sh
ssh devbox pi install npm:pi-auto-session-name
```

Choose a cheap naming model in the remote `~/.pi/agent/extensions/auto-session-name.json`, for example `{"provider": "anthropic", "model": "claude-haiku-4-5"}`. Do not set `"reasoning": "off"` with that extension (version 0.1.1): Anthropic models then reject the request. Leave the option out to use its default. Extensions load when Pi starts, so slots that are already running do not get the extension.

### Configuration

The local client reads `$XDG_CONFIG_HOME/pi-remote/config.json` (default `~/.config/pi-remote/config.json`). All settings are optional:

```json
{
  "host": "devbox",
  "cwd": "~/workplace/project",
  "extensions": ["./my-editor.ts"],
  "theme": "dark",
  "bell": true,
  "web": { "allowUsers": ["you@example.com"] }
}
```

- `host`: default SSH host. Precedence: `--host`, then `PI_REMOTE_HOST`, then this file. `--local` ignores all three.
- `cwd`: default remote directory for `new` and `resume`. Precedence: `--cwd`, then `PI_REMOTE_CWD`, then this file. `~` is the remote home.
- `extensions`: local copies of Pi extensions that **replace Pi's editor** (for example a prompt caret). With a local copy, typing in that editor stays local; without one, Pi draws the editor and every key waits for the remote. The client runs only the editor part; all other extension behavior runs in remote Pi. Relative paths resolve beside the config file. `--ui-extension PATH` adds more.
- `theme`: theme for the local parts (editor, scrollbar, search). Defaults to Pi's `theme` setting on this machine. `--theme` overrides it.
- `bell`: pass Pi's bell to the terminal (default true).
- `web`: opt in to installing the phone web service on deploy. See [phone setup](docs/phone.md#install-and-run).

`--ui-config PATH` selects another file for `extensions`, `theme`, and `bell` only.

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

Type `pi-remote new --cwd /remote/` and press Tab to list **remote directories**, not local ones. Slot completion after `pi-remote attach ` includes numbers, status, session name, and workspace; after `pi-remote resume ` it offers stopped slots instead. `--session` completes remote files and directories, relative to `--cwd` or the default directory when one is set.

Remote `~` and relative completion prefixes use the remote home directory unless a completion base is supplied. Quote remote tilde paths, for example `--cwd '~/workplace/project'`, so your shell does not expand them to your **local** home. Prefer absolute paths for `--session` when launching. Completion is read-only: it may start the on-demand daemon, but never creates or attaches a Pi slot, sends a prompt, or runs an agent tool. An unavailable host produces no suggestions.

For zsh or bash, put `pi-remote` on `PATH` with `npm link`, then install the matching script:

- **zsh:** `mkdir -p ~/.zsh/completions; pi-remote completion zsh > ~/.zsh/completions/_pi-remote`. Add `fpath=(~/.zsh/completions $fpath)` before `autoload -Uz compinit; compinit` in `~/.zshrc`.
- **bash:** `pi-remote completion bash > ~/.pi-remote-completion.bash`, then add `source ~/.pi-remote-completion.bash` to `~/.bashrc`.

`completion` only prints a script; it does not edit shell configuration.

## What survives disconnect

Pi runs in the daemon's terminal, not in your SSH session. Detaching, closing the terminal, or losing the network leaves Pi running, including any work in progress. The client reconnects automatically (disable with `--no-reconnect`) and shows Pi's current screen. Keys typed while disconnected are dropped, never sent late; nothing is replayed.

### Daemon crash versus client disconnect

Client disconnect is supported; daemon/host crash recovery of in-flight work is **not**. If the daemon dies, the terminals it owns close and Pi exits. On daemon restart, known slots are listed as stopped, without rerunning tasks automatically. Only a deliberate [`restart-daemon`](#deployment) reopens slots. Open the recorded session file in a new slot to resume manually. Pi may defer creation of a new session file until the first assistant response.

An exclusive startup lock serializes stale-daemon reclamation. If the launcher itself crashes leaving `start.lock`, startup fails closed; inspect its PID and `daemon.log` before manually removing it. Never remove a live daemon's lock/socket. A reused PID also fails closed.

## Extensions

Remote Pi loads every extension as usual, and they run there: tools, commands, renderers, widgets, footers, overlays, and dialogs. You see their output because Pi draws it. Only an extension that **replaces Pi's editor** benefits from a local copy (`extensions` above).

Pi and its extensions can detect pi-remote: the daemon sets `PI_REMOTE_SESSION=1`, `PI_REMOTE_SESSION_HOST` (the remote hostname), `PI_REMOTE_SESSION_SLOT` and `PI_REMOTE_SESSION_SLOT_NUMBER` in each Pi process. A footer extension can use these to show the host.

## Process and security boundaries

```text
laptop                                 remote host
pi-remote client -> SSH stdio -> bridge -> private Unix socket
                                                |
                                         detached daemon
                                          /           \
                         PTY: pi + pi-remote.ts   PTY: pi + pi-remote.ts
                                 slot A                   slot B
```

- One on-demand detached daemon per remote state directory. No network listener or systemd unit.
- Only the SSH bridge and `--local` commands start the daemon. It passes its environment to every Pi slot, so it must start from your shell environment, which includes provider settings such as `OPENAI_BASE_URL`. The phone web server only connects to a running daemon.
- Default installation: `~/.local/share/pi-remote/`. Default daemon state: `~/.pi/remote/`.
- SSH uses your existing host config with batch authentication and keepalives.
- A `0700` state directory and `0600` Unix socket restrict local access. This is not a sandbox: attached clients have the same authority as the remote Pi user, including uploading pasted files to the remote temporary directory.
- The daemon validates protocol/Pi versions on connection and rechecks the remote Pi executable before starting each slot.
- `slots.json` contains process metadata and session paths, not credentials or transcripts. `daemon.log` contains stderr and is private but not rotated.

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
2. Runs `npm ci --omit=dev --ignore-scripts` there, compiles `node-pty` for the host (`npm rebuild node-pty`; this needs `python3`, `make` and a C++ compiler), and checks that the release starts.
3. Switches `bin/pi-remote` to the new release in one atomic rename. When the deploying machine's config contains `web`, installs/updates, enables, and starts/restarts [the phone web service](docs/phone.md#install-and-run) on that release. It discovers the target's Tailscale origin unless configured explicitly, preserves private web state, and prints any missing routing/linger setup commands without changing them. Web setup failures skip old-release cleanup. This only reconnects phones and runs even with `--no-restart`. Without `web`, it leaves systemd untouched.
4. Deletes old releases. It keeps the new release, the previous one, and any release a running process uses. A release never changes after install, because a running daemon loads modules from its own release.
5. Runs `pi-remote restart-daemon`, which waits until no slot is busy. If you stop the wait with Ctrl-C, the new release stays installed and the old daemon keeps running; run `pi-remote restart-daemon` later. `npm run deploy -- --force` interrupts busy slots instead of waiting; `npm run deploy -- --no-restart` skips this step.

### Restart the daemon without losing slots

```sh
pi-remote restart-daemon           # waits until no slot is busy, and says which slots it waits for
pi-remote restart-daemon --force   # interrupts busy slots
```

This reopens every slot from its session file in a new daemon:

- A slot that is starting or reloading blocks the restart, and a busy slot (Pi working, compacting, or waiting on an extension dialog) blocks it unless `--force` is given. It checks all slots and commits in one step, so a prompt cannot start in between. A refusal locks and stops nothing; the client asks again every 2 seconds until the daemon accepts or you press Ctrl-C.
- When it accepts, it marks each running slot `reopen` in `slots.json` and exits. The next daemon starts from the installed release and starts those slots again from their session files, with the same slot IDs, numbers and launch arguments.
- Attached clients reconnect automatically and show the same slots. Persisted history remains; in-memory state such as model or thinking-level changes that Pi did not save is discarded.
- Slots that were already stopped stay stopped. A crashed daemon never reopens anything.

Daemons deployed before `restart-daemon` existed do not support it. Stop such a daemon once by hand when its slots are idle (`kill` the PID in `~/.pi/remote/daemon.lock/pid`), then reopen sessions with `pi-remote new --session`.

## Development and verification

Locally, `pi-remote` runs from `src/` through `tsx`, so source edits take effect on the next run. Deployed releases run the compiled `dist/`.

```sh
npm run verify          # type check, tests, build
npm run test:mobile     # phone smoke in Chromium (builds first)

# Try local changes without deploying: a local daemon runs Pi from this machine.
pi-remote new --local --cwd ~/project
```

`test/tui/stock-screen.test.ts` runs stock Pi and `pi-remote new --local` side by side in headless terminals and compares them cell by cell (text, colors, attributes). `test/daemon/real-pi.test.ts` runs the real pinned Pi CLI in a daemon; `test/daemon/daemon.test.ts` uses a fast deterministic stand-in (`test/fixtures/fixture-pi.mjs`).

### Source map

Each directory is a separate TypeScript project:

```text
cli ──→ daemon ──→ protocol
    ├─→ client ──→ protocol
    ├─→ tui    ──→ protocol, config
    └────────────→ config
pi-extension ──→ protocol   (loaded into each remote Pi process)

cli ──→ web/server ──→ daemon, client, protocol, config, web/shared
        web/build ──→ tui, protocol, web/shared
        web/client ─→ client, tui, protocol, web/shared
```

- `src/pi-extension/pi-remote.ts`: pi-remote's Pi extension, loaded into each slot's Pi. Sends Pi's screen sections, editor state, session facts and lifecycle events; registers `/detach` and `/status`.
- `src/protocol/pi-extension.ts`, `screen.ts`: the extension's messages, input barriers and line diffs; a screen copy that rebuilds a client from nothing. `types.ts`, `methods.ts`: daemon wire records and methods.
- `src/daemon/supervisor.ts`: slots, persistence, attachments, input, size ownership, activity, reload and daemon restart. `pi-terminal.ts`, `terminal-output.ts`: runs Pi in a PTY, answers its terminal queries, and forwards bell, title, notification and clipboard output. `launch.ts`, `bridge.ts`, `files.ts`: daemon startup, socket bridging, remote filesystem requests.
- `src/client/`: SSH transport, reconnect without replay, legacy filesystem fallback, daemon replacement.
- `src/tui/pi-screen.ts`: Pi's screen rebuilt locally (layout, scrolling, local editor, status panel). `terminal-session.ts`: connects PiScreen to the daemon and this terminal for one slot (the phone's counterpart is `src/web/client/session-view.ts`). `kitty-keys.ts`: converts legacy key sequences to the kitty keyboard protocol Pi uses. `local-editor.ts`: local copies of editor extensions. `fuzzy-picker.ts`, `slot-table.ts`, `session-table.ts`, `host-status.ts`: pickers, lists and status rows.
- `src/web/client/session-view.ts`: PiScreen in the phone's browser terminal.
- `src/cli/`: commands, connection wiring, shell completion.
