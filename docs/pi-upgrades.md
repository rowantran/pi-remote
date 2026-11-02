# Upgrading Pi

pi-remote supports exactly one Pi version: `PI_VERSION` in `src/protocol/types.ts`, the same version as the three `@earendil-works/*` packages in `package.json`. pi-remote uses parts of Pi that are not public API (the screen layout, private fields, and copies of Pi's own code), and semver does not cover those. This page lists every such assumption and what checks it, so an upgrade is a version change, a test run, and a few manual checks.

There are two copies of Pi:

- **The host's Pi** (`pi` on the remote host, or `PI_REMOTE_PI_BIN`) runs each slot, and loads pi-remote's Pi extension.
- **The pinned packages** in `node_modules` are used by the laptop client, the daemon, the phone build, and the tests. The tests run the pinned Pi CLI as the slot's Pi, so after you change the pins, the tests run the new version.

The daemon refuses to start slots when the host's Pi is not `PI_VERSION`. `npm run deploy` and `pi-remote restart-daemon` check the host's Pi first and stop before they change anything (`pi-remote check-pi`), so a mismatch never leaves slots stopped.

## Steps

1. In a branch, set the three `@earendil-works/*` versions in `package.json` and `PI_VERSION` to the new version, and run `npm install`. Update the version in `README.md` ("Quick start"), `docs/phone.md`, and the code comments that name a Pi version (`grep -rn "Pi 1\." src`).
2. Run `npm run check`. The compiler catches changes to the public API that pi-remote uses: `CustomEditor` options, event names and payloads for `pi.on`, `ExtensionUIContext`, `SessionManager`, and the TUI types.
3. Run `npm run verify` on Linux (the deploy installer tests need GNU `mv`), and `npm run test:mobile`.
4. Go through the [checklist](#checklist). Fix or update every item that changed.
5. Roll out the three parts together. In between, clients fail to connect with a version error, but running slots keep running:
   1. On the laptop: `git pull && npm ci` in the checkout that `pi-remote` is linked to. The client refuses a daemon built for another Pi version.
   2. On the host: upgrade Pi (`pi update`). Running slots keep their Pi process. Until the next step, the old daemon refuses to start or reload slots.
   3. On the laptop: `npm run deploy`. It checks the host's Pi, installs the release, and restarts the daemon, which reopens the slots with the new Pi.

## Checklist

"Test" means the item fails a named test when the assumption breaks. "Manual" means no test covers it: check it by hand in a slot on the host after deploying.

### pi-remote's Pi extension (runs in the host's Pi)

`src/pi-extension/pi-remote.ts`.

| Assumption | Checked by |
|---|---|
| Pi's screen has exactly 7 top-level children, in this order: transcript, pending messages, status, widgets above, editor container, widgets below, footer (`mountInteractiveTui` in Pi's `modes/interactive/interactive-mode.js`). The editor is the first child of the 5th. `SECTION_NAMES` and `EDITOR_SECTION` in `src/protocol/pi-extension.ts` encode this. | Test: `test/daemon/real-pi.test.ts`, "slots run Pi in a PTY…", which requires a frame with the editor section. The extension sends that only when it recognizes the layout. |
| Replacing `render()` on each top-level child captures everything Pi draws. | Test: `test/tui/stock-screen.test.ts` compares the screen with stock Pi cell by cell. |
| `ui.setEditorComponent` and `ui.getEditorComponent` are on one UI object that Pi shares with every extension, and `CustomEditor` accepts `{ embedWorkingStatus: true }`. | `npm run check`; test: `stock-screen.test.ts`. |
| `ctx.ui.onTerminalInput` handlers run before the focused component and can consume input (the client's input barriers and set-text sequences). | Test: `real-pi.test.ts`, "the terminal client attaches to a slot, edits locally…". |
| `TUI.getFocusedComponent()` exists, so the extension can tell when the editor has focus. Without it, pi-remote never handles Ctrl+D itself, and Pi exits instead of the client detaching. | Test: `real-pi.test.ts`, "the terminal client…", which detaches with Ctrl+D. |
| The editor's private `renderedAutocompleteHeight` field, and the optional methods `isShowingAutocomplete`, `getAutocompleteMaxVisible`, `getPaddingX`, `getCursor`, `borderColor` and `addToHistory`. | Manual: type `/` and part of a command. The dropdown shows below the editor, and arrow keys and Tab act on it. Submit a prompt, then press Up: the local editor shows the previous prompt. |
| `keybindings.getResolvedBindings()` and these binding IDs: `app.exit`, `app.clear`, `app.editor.external`, `app.clipboard.pasteImage`, `tui.select.up`, `tui.select.down`, `tui.select.cancel`, `tui.select.confirm`, `tui.input.tab`. | Test: Ctrl+D in "the terminal client…". Manual: Ctrl+C clears the editor at once; Ctrl+G opens the laptop's `$EDITOR`; Ctrl+V pastes from the laptop clipboard. |
| Events and their fields: `session_start` (`ctx.mode`), `session_info_changed`, `agent_start`, `agent_end` (`messages`), `agent_settled` (`aborted`), `message_end`, `session_before_compact` (`reason`), `session_compact`, `session_compact_failed` (`aborted`, `errorMessage`), `ui_prompt_start` (`kind`, `title`), `ui_prompt_end`. The daemon uses these to decide whether a slot is busy, which `restart-daemon` and reload wait for. | `npm run check`; test: `real-pi.test.ts` checks `agent_start` and `agent_settled`. Manual: run `/compact`, and open an extension dialog. During each, `pi-remote restart-daemon` prints `Waiting: slot N: …` instead of restarting; press Ctrl-C to stop it. |
| `ctx.sessionManager` has `getSessionId`, `getSessionFile`, `getSessionName` and `getEntries`. | `npm run check`; test: `real-pi.test.ts` checks the session facts. |
| `pi.sendUserMessage` sends a child slot's first prompt. | Test: `real-pi.test.ts`, "another extension forks into a child slot…". |
| `pi.events` delivers synchronously, so other extensions get the extension API from one `emit` (`src/protocol/extension-api.ts`). | Test: "another extension forks into a child slot…". |

### Pi's command line (the daemon starts Pi)

`src/daemon/pi-terminal.ts`, `src/daemon/supervisor.ts`.

| Assumption | Checked by |
|---|---|
| `pi --version` prints only the version. | Test: `test/integration/entrypoints.test.ts` (`check-pi`). |
| Pi accepts `--tui-mode regular`, `-e PATH`, `--session`, `--session-dir`, and the other options in `RESERVED_ARGS`. | Test: every test in `real-pi.test.ts` starts Pi this way. |
| Pi answers terminal queries and writes the bell, title, notifications, progress and OSC 52 clipboard as `src/daemon/terminal-output.ts` expects. | Test: `real-pi.test.ts` checks the window title. Manual: `/copy` reaches the laptop clipboard. |

### Session files (written by the host's Pi, read by the pinned packages)

| Assumption | Checked by |
|---|---|
| The pinned `SessionManager.list` reads the session files the host's Pi writes (the `sessions` method in `src/daemon/supervisor.ts`). | Manual: `pi-remote resume` lists recent sessions with their first messages. |
| `src/daemon/side-fork.ts` writes a session file the way `pi --fork` does: a `session` header with `version`, `id` and `parentSession`, entries linked by `id` and `parentId`, and a `custom_message` entry. This is the daemon's `create` method with `parentSlotId`. The daemon tests use a stand-in Pi, and no client in this repository sends that request. | Manual: compare with the fork code in Pi's `SessionManager`, including the header `version`. |
| Reopening a slot with `--session` restores its history. | Test: `real-pi.test.ts`, "restart_daemon reopens slots from their session files". |

### Laptop client (pinned packages)

`src/tui/`.

| Assumption | Checked by |
|---|---|
| `chatViewport` in `src/tui/pi-screen.ts` is a copy of Pi's `createChatViewport`, and `rendererOptions` copies the options of Pi's `createInteractiveTui`. Update the Pi version in both comments. | Test: `stock-screen.test.ts`. |
| The editor's private `state` field (`setEditorState` in `pi-screen.ts`), and `CustomEditor`'s `actionHandlers`, `onEscape`, `onCtrlD` and `onPasteImage`. | Test: `test/tui/pi-screen.test.ts`. |
| Pi's built-in themes are JSON files in `modes/interactive/theme/` (`src/tui/local-theme.ts`). | Manual: attach with `theme` set in the client config; the local editor and scrollbar use its colors. |
| Local copies of extensions that replace the editor still load with the API stand-in in `src/tui/local-editor.ts`. | Manual: with `extensions` in the client config, attach and type. |

### Phone (pinned packages, bundled for the browser)

`src/web/`.

| Assumption | Checked by |
|---|---|
| The browser build imports files from deep inside the pinned packages' `dist/` (`src/web/client/shims/pi-coding-agent.ts`, `pi-ai.ts`, `vfs.ts`). | `npm run build` fails when a file moved. Test: `test/web-browser/bundle.test.ts` runs the bundle in Chromium and WebKit. |
| `src/web/client/shims/` replaces parts of Pi for the browser: `pi-config.ts` and `parseSkillBlock` copy Pi code (their comments name the version they copy). | Manual: compare each with the new Pi. Test: `npm run test:mobile` shows a slot on the phone. |
| `src/web/server/browser-config.ts` sends Pi's built-in theme files to the phone. | Test: `test/web-server/config-route.test.ts`. |
