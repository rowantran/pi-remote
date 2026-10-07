# Real Pi terminal golden comparison

This harness runs the **actual stock Pi 1.0.4 CLI** beside the current `pi-remote` CLI. Pi owns both agent runs: one uses the stock terminal UI; the other is an unmodified stock RPC process started by an isolated `pi-remote --local` daemon. Neither side needs credentials or a live model service.

## Reference behavior follows Pi

The **correct rendering is the behavior of stock Pi at the version being tested**, not a permanent requirement to preserve today's screenshots. Future Pi releases can intentionally change layout, colors, spacing, tool output, or keyboard hints. Those changes can become the new expected behavior for pi-remote.

The harness captures its stock reference on every run; saved artifacts document a particular version, not a timeless baseline. It currently requires Pi **1.0.4**, matching the pinned client dependencies. When upgrading Pi:

1. Update the client dependency pins, supported-version checks, and golden harness version check together.
2. Run both the standard and `--rowan` comparisons against that same Pi version.
3. Review the new stock output and diffs. Adapt pi-remote through public Pi APIs where needed; do not force the new Pi to reproduce the old screenshots.
4. Retain fresh captures and record the tested versions. Do not hide real differences by broadening normalization just to make the tests pass.

With `--rowan`, the reference also includes the selected local extension files, so updates to those extensions can change the expected appearance too.

## Run

Requires Node 22.19+, the project's installed dependencies, `tmux`, `diff`, Bash, and stock `pi` 1.0.4 on `PATH`.

```sh
node --import tsx test/golden-transcript.ts

# Shorter iteration
node --import tsx test/golden-transcript.ts --widths 80 --themes dark

# Compare an unchanged checkout, without modifying it
node --import tsx test/golden-transcript.ts \
  --remote-bin /path/to/original/pi-remote/bin/pi-remote

# Explicit, unmodified local presentation factories on both terminals
node --import tsx test/golden-transcript.ts --rowan

# Override the local extension repository or stock CLI
node --import tsx test/golden-transcript.ts --rowan \
  --rowan-root /path/to/pi-extensions --pi-bin /path/to/pi

# Narrow wrapping (extra rows keep the expanded transcript visible)
node --import tsx test/golden-transcript.ts --widths 40 --rows 200
node --import tsx test/golden-transcript.ts --rowan --widths 40 --rows 200

# Choose a new or empty artifact directory
node --import tsx test/golden-transcript.ts --output /tmp/my-golden-run

# Test ANSI comparison/cropping independently
node --import tsx --test test/golden-terminal.test.ts
```

The same commands are available through `npm run test:golden -- [options]`.

Exit status:

- **0:** every compared transcript matches.
- **1:** at least one transcript differs. Differences are not accepted or silently updated.
- **2:** a runtime/setup/capture failure prevented a valid comparison.

The default matrix is **80 and 120 columns**, **160 rows**, and the stock **dark and light themes**. The tall panes expose the complete expanded transcript without scrolling or viewport clipping. Each side receives the same dimensions and keyboard actions. `--help` lists all options.

## What runs

`fixture-provider.ts` registers `golden-local/transcript` through the documented `ExtensionAPI.registerProvider({ streamSimple })` API and is loaded with `--extension`. It emits balanced thinking, text, and tool-call stream events using the public Pi AI event stream. It does not replace Pi's agent loop, RPC protocol, message components, or tool executors.

Pi executes real Bash tools. One prints partial output, waits at a filesystem gate, then succeeds with long output. The other writes to stderr and exits with status 7. Gates make the live comparison checkpoints deterministic; neither side advances until both captures are complete. The gate path is supplied through a separate environment variable on each side, so rendered command text is identical.

Each scenario captures these checkpoints:

1. Live assistant Markdown and thinking, paused before `text_end`.
2. Live partial Bash tool output, before the tool finishes.
3. Completed success/error tools with output collapsed.
4. The same transcript after **Ctrl+O** expands tools.
5. The same transcript after **Ctrl+T** hides thinking.
6. The same keys restore visible thinking and collapsed tools.
7. A user-entered `!printf` Bash command and its completed output.
8. A second user prompt and response, including inter-message spacing and escaped literal characters.
9. Restored history: **Ctrl+D** exits stock Pi and detaches the remote client; stock restarts with the same command plus `--continue`, and the remote client reattaches to the same slot. No prompt or tool is submitted.

The restoration checkpoint verifies that each side still uses its original isolated session file and ID, that persisted messages are unchanged, and that no new provider call occurred. It also checks that the remote RPC PID is unchanged. This catches clocks incorrectly added to historical tools and client timers that prevent detach from exiting. Extra or missing `Took`/`Elapsed` rows are compared normally; only their numeric values are normalized.

Content covers headings, bold/italic/strike, inline code, links, quotes, lists, tables, syntax-highlighted code, Unicode, user Markdown, backslash escapes, thinking, tool success/error colors, output truncation, and user Bash panels. Stock Pi renders user Markdown; the harness does not assume user messages are plain text.

`--rowan` is a golden-test option, not a Pi model/provider or a general pi-remote mode. Without it, the comparison uses standard Pi presentation. With it, both sides load these original local files, with no copies or adapters:

- `compact-tools.ts`
- `assistant-background.ts`
- `prompt-caret.ts`

The default directory is `~/.pi/agent/git/github.com/rowantran/pi-extensions`; `--rowan-root PATH` overrides it. This is a selected presentation compatibility check, not a test of Rowan's entire extension setup.

Stock Pi loads them with `--extension`. The local remote client loads the same paths with `--ui-extension`; its RPC process receives only the deterministic provider. No provider, worker, credential, or other execution factories from the user's extension collection are loaded.

## Comparison and artifacts

Each pane is captured with **`tmux capture-pane -p -e -N`**. The harness keeps foreground/background colors, bold, dim, italic, underline, strike, inverse, and colored padding. It resolves inherited SGR state before cropping, then compares canonical terminal text/style runs. Equivalent ANSI encodings compare equal; actual color, style, text, wrapping, and panel-padding differences fail.

Only these items are excluded or normalized:

- Startup headers and warnings before the first user message.
- The editor, footer, and the separate working status above the editor (Pi's custom-editor spinner or the remote client's `Working…` label).
- Stock's temporary `Tool output: ...` and `Thinking blocks: ...` notifications.
- Invisible trailing spaces with no background, inverse, underline, or strike style.
- The numeric value in standalone `Took 0.0s` / `Elapsed 0.0s` Bash clock labels. The short fixture runs below ten seconds. The label and its styles remain compared. Original values remain in the raw captures and text diffs.

The first user's colored padding and all user-Bash panel borders remain inside the transcript. Missing boundaries or a clipped prompt fail the test rather than producing a false pass.

Each checkpoint directory contains:

| File | Contents |
|---|---|
| `stock.screen.ansi`, `remote.screen.ansi` | Complete, unmodified tmux screen captures |
| `stock.ansi`, `remote.ansi` | Cropped transcript with self-contained ANSI styles per row |
| `stock.txt`, `remote.txt` | Human-readable transcript |
| `stock.canonical`, `remote.canonical` | Compared text/style runs, with clock values normalized |
| `text.diff` | Unified, unnormalized plain-text diff |
| `style.diff` | Unified diff of the compared text/style runs |
| `side-by-side.txt`, `side-by-side.ansi` | Stock on the left, remote on the right |

Use `less -R path/to/side-by-side.ansi` to inspect colors. A clock-only difference can appear in `text.diff` while `style.diff` is empty and the checkpoint passes.

The artifact root also retains `manifest.json`, exact initial/restart commands in `commands.json`, `summary.json`, separate agent homes/settings, persisted stock/RPC sessions, gates, final screen captures, and daemon logs. Each scenario's `restoration.json` records the preserved session IDs, paths, message counts and RPC PID. Provider-request logs contain only model IDs and timestamps and prove restoration made no model calls. Failed runtime comparisons retain `error.txt`. Artifacts are not deleted automatically.

## Isolation and cleanup

- A unique **private tmux server** is started with `-f /dev/null`; the user's tmux configuration and sessions are not used.
- Both applications run through `env -i` with separate `HOME`, XDG directories, `PI_CODING_AGENT_DIR`, sessions, and gate directories. Provider credentials are not inherited.
- Both use `--offline`, no discovered extensions/skills/templates/themes/context files, and an explicit local provider/model.
- The daemon has its own `--state-dir`; only its slot and daemon PID are stopped.
- Every created tmux session and the private server are stopped in `finally` blocks. Gates are released first so failed captures cannot leave fixture Bash commands waiting.
- Existing Pi configs, auth files, extensions, sessions, and daemons are not changed.
- An existing nonempty output directory is rejected to prevent stale gates from making a later run pass.

## Recorded development runs

Artifacts from the implementation session are retained outside the repository:

| Run | Result | Artifacts |
|---|---|---|
| Original unchanged checkout, initial 7-checkpoint matrix | **0/28 matched**, exit 1 | `/tmp/pi-remote-golden-baseline-v3` |
| Public-component rewrite, before app-keybinding fix | **16/28 matched**, exit 1; remaining differences were the missing `ctrl+o` collapsed-tool hint | `/tmp/pi-remote-golden-current-v2` |
| Unmodified Rowan factories, initial full 8-checkpoint matrix | **32/32 matched**, exit 0 | `/tmp/pi-remote-golden-rowan-matrix-v3` |
| Before restoration coverage, standard presentation, 80/120 columns, dark/light | **32/32 matched**, exit 0 | `/tmp/pi-remote-golden-final-stock` |
| Before restoration coverage, unmodified Rowan factories, 80/120 columns, dark/light | **32/32 matched**, exit 0 | `/tmp/pi-remote-golden-final-rowan` |
| Before restoration coverage, standard presentation, 40 columns, dark/light | **16/16 matched**, exit 0 | `/tmp/pi-remote-golden-narrow-stock` |
| Before restoration coverage, unmodified Rowan factories, 40 columns, dark/light | **16/16 matched**, exit 0 | `/tmp/pi-remote-golden-narrow-rowan` |
| With restored history, standard presentation, 80/120 columns, dark/light | **36/36 matched**, exit 0 | `/tmp/pi-remote-golden-history-stock-final` |
| With restored history, unmodified Rowan factories, 80/120 columns, dark/light | **36/36 matched**, exit 0 | `/tmp/pi-remote-golden-history-rowan-final` |
| With restored history, standard presentation, 40 columns, dark/light | **18/18 matched**, exit 0 | `/tmp/pi-remote-golden-history-narrow-stock` |
| With restored history, unmodified Rowan factories, 40 columns, dark/light | **18/18 matched**, exit 0 | `/tmp/pi-remote-golden-history-narrow-rowan` |

The golden capture helper has eight unit tests, including a regression check that synthetic clock rows cannot be hidden by normalization. The harness, provider, and helpers also pass standalone strict TypeScript checking.

## Limits

This is a real terminal/CLI comparison, not a renderer mock, but it samples fixed streaming states rather than every animation frame. It does not test small-height scrolling, images, OSC hyperlinks, arbitrary custom tools, MCP, provider networking, SSH transport, or every Rowan extension. The tall terminal is deliberate. Tool clock values are metadata, not a claim that two independent processes have identical elapsed time. The original working directory is shared only for identical path metadata; mutable homes, sessions, daemon state, and gate files remain separate.
