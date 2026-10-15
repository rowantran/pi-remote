# Phone client

The browser client paints the existing Pi transcript locally. It connects over WebSocket to a
`pi-remote serve` process on the devbox; that process connects to the same daemon as the laptop
client. Closing a tab or losing the network detaches the client, not the remote Pi process.

## Security model

**A paired device has the authority of the devbox user, including arbitrary shell commands.**
Do not publish this service with Tailscale Funnel, a public reverse proxy, or a public TCP listener.

```
iPhone → authenticated Tailscale connection → Tailscale Serve HTTPS
                                              ↓ trusted identity header
                                        private web Unix socket
                                              ↓
                                        private daemon socket → Pi
```

- The application has **no TCP listener**. Its Unix socket is user-owned, mode `0600`, inside a
  dedicated user-owned `0700` directory. Other processes running as that user (and root) remain
  trusted, just as they are for the existing daemon socket.
- `tailscale serve` is the only network entry point. Unlike Funnel, it serves only tailnet peers.
  The server checks the current Serve configuration and refuses Funnel on its configured port.
- Tailnet membership alone is insufficient. Every HTTP request and WebSocket upgrade requires an
  exact allowed `Tailscale-User-Login`, set by Tailscale Serve after stripping client-supplied identity
  headers. Missing identities, tagged peers without user identities, and other users are rejected.
  An additional tailnet policy rule restricting this devbox's HTTPS port to you is recommended.
- A permitted user must also pair the browser installation using an expiring, single-use random
  code generated on the devbox. The device receives an `HttpOnly; Secure; SameSite=Strict` cookie.
  Only hashes of tokens and pairing codes are stored on disk. Revoking a device invalidates its
  cookie and closes its WebSockets.
- Mutations and WebSocket upgrades require the exact configured Origin. Host validation, a
  self-only Content Security Policy, no CORS, and no third-party scripts limit browser attacks.
- The app serves only fixed build assets and reduced display configuration (themes and a few
  presentation preferences), never arbitrary devbox files or credentials. Remote file reads and
  agent commands require a paired device.

Tests use a separate loopback proxy into the Unix socket, standing in for Tailscale Serve. This
proxy lives in test code; there is no production flag to turn the application into a TCP server.

## Install and run

The web server runs from the same installed release as the daemon, so the devbox needs no
checkout, package install, or build. From your laptop checkout, install a release:

```sh
npm run deploy -- --wait
```

Then, once on the devbox, create `~/.config/systemd/user/pi-remote-web.service`. Use an HTTPS
origin belonging to this device's Tailscale DNS name, and your actual Tailscale login, not the
tagged server's owner. Replace `/usr/bin/node` with the output of `command -v node`.

```ini
[Unit]
Description=Pi Remote phone client (private Unix socket)
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.local/share/pi-remote/bin/pi-remote serve --origin https://devbox.your-tailnet.ts.net --allow-user you@example.com --web-state-dir %h/.pi-remote-web
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
# Pi sessions belong to the daemon. Stopping the web service must not stop them.
KillMode=process

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now pi-remote-web.service
loginctl enable-linger "$USER"   # keep the service running while you are logged out
# --bg persists the Serve configuration; use the same state directory as the service.
tailscale serve --bg --https=443 "unix:$HOME/.pi-remote-web/web.sock"
PI=~/.local/share/pi-remote/bin/pi-remote
$PI serve pair --web-state-dir ~/.pi-remote-web
$PI serve devices --web-state-dir ~/.pi-remote-web
$PI serve revoke DEVICE_ID --web-state-dir ~/.pi-remote-web
```

Every later `npm run deploy` restarts an active `pi-remote-web.service` onto the new release,
even with `--no-restart`, which applies only to the daemon. The web service owns no Pi sessions:
the restart reconnects phones and leaves sessions running. A `serve` process started by hand is
not restarted; restart it after a deploy, because release cleanup can delete the release it runs
from. The web server also works with an older running daemon, so you need not restart the daemon
just to update or start the web server. For development, run the same commands with
`node bin/pi-remote` from a checkout after `npm run build`.

Pairing and revocation commands must use the same `--web-state-dir` as the service. Do not reset the whole Tailscale Serve configuration
or change unrelated existing handlers. State directory ancestors must not be symlinks or writable
by other users. If the default path fails because `~/.pi` is group-writable, use a dedicated
`~/.pi-remote-web` directory as above; do not loosen the checks or change unrelated permissions.
The server expects Serve's Unix-proxy header shape
(`Host: localhost`, exact `X-Forwarded-Host`, and `X-Forwarded-Proto: https`), not a generic proxy.

Open the origin in Safari over Tailscale. Install on the Home Screen **before pairing**: iOS can
isolate the installed app's browser storage from the Safari tab. Generate a pairing code on the
same devbox and with the same web state directory as the running service, then enter it in the
installed app. Do not paste pairing codes into shared logs or commit them.

## Code layout

- `src/web/client/`: browser app, native input, offline cache, and browser compatibility shims.
- `src/web/server/`: private HTTP/WebSocket listener, device pairing, push, and config delivery.
- `src/web/build/`: app bundler and isolated presentation-build worker.
- `src/web/shared/`: web-only worker result types, bounded source-file helpers, and browser-safe module-name normalization. The browser imports only the normalizer; the Node-only file helpers remain server/build code.

The built browser assets remain in `dist/web/`. The server and builder have separate TypeScript
projects: the listener cannot import TUI/build code, and the browser cannot import server/build code.

## Use a normal pi-remote config

The web client reads a normal pi-remote `config.json` **on the devbox**. The default is
`$XDG_CONFIG_HOME/pi-remote/config.json`, or `~/.config/pi-remote/config.json` when XDG is unset.
Use the same schema as the terminal client:

```json
{
  "theme": "gruvbox-light/gruvbox-dark",
  "extensions": ["./my-ui.ts"],
  "bell": true
}
```

To use a different file, add `--ui-config /path/to/config.json` to the existing `serve` command.
There is no upload protocol, sync command, or saved presentation JSON in web state. Copy the
normal config and your user-owned `my-ui.ts` with `scp`, manage them with dotfiles, or edit them
on the devbox. Keep the adapter beside `config.json` on both machines; the same relative path
then works for the laptop and phone. Deployment does not install adapters.

Extension paths resolve on the devbox: `~/` uses its home directory, and relative paths use the
config file's directory. A laptop-only absolute path will not work on Linux. Extension files and
their dependencies must already exist on the devbox. Adapters must not import pi-remote source
files; use public Pi display packages and declare the small
[`getRemoteWidget` type locally](../README.md#read-remote-widgets-in-a-local-adapter) if needed.
Update display dependencies separately; editing an extension only on the laptop does not update the phone.
The web client does not use `host` or `cwd` from the config to select another server or session.

Themes and Pi display preferences (`hideThinkingBlock`, `doubleEscapeAction`, and the theme
fallback) come from the devbox's `~/.pi/agent`, or `PI_CODING_AGENT_DIR` if set. The phone chooses
the light or dark member of a theme pair from its appearance setting. Theme colors also set the
terminal and page colors. Only display settings and sanitized theme data are sent to the browser,
not the complete config or Pi settings. Do not embed credentials in presentation code.

The server builds the configured extensions into a browser JavaScript module with esbuild,
which is included as a runtime dependency. It runs their setup in a bounded, short-lived child
process to trace dynamic `jiti` imports. This creates no Pi session and makes no daemon request.
The generated module stays in memory. Config, theme, and bundled source changes are picked up
when the phone reloads; unchanged sources reuse the bundle. Normal config and loaded-source
edits need no daemon or web-service restart. Remove an extension from the normal config to turn
it off. A missing config means default display settings and no extensions. Restart the web service
if you change package/TypeScript resolution settings or add a competing file that changes which
module an unchanged import resolves to; these are not loaded-source edits.

Import display modules during factory initialization: dynamic imports performed only later by
an event handler cannot be traced. Browser Node API support is limited to display helpers and
read-only virtual theme/config files. Unsupported filesystem, process, editor, or worker
operations throw when called. Runtime agent/provider/tool executor imports fail the build.
The native phone composer still replaces extension-provided editors such as `prompt-caret`.

**Only configure extensions you trust.** Setup runs with your ordinary devbox privileges. A
separate child process limits build lifetime, not access to files or credentials. In the browser,
the extension runs with the paired device's full authority, including authenticated session
commands. This is trusted same-user code, not a sandbox.

Both `/api/config` and the hash-bound `/api/presentation.js` require identity, trusted Host/Origin,
and device pairing. Responses are no-store and the service worker never caches the module.
CSP remains `script-src 'self'`: no eval or inline scripts. Invalid config or a failed server build
shows a warning and uses the built-in display, never stale renderer code. Safe themes and settings
remain available; local service logs contain build diagnostics. Fix the source and reload to recover.
Listing and attaching sessions remain available, and remote work continues independently. A
browser-side extension load failure also shows a warning and uses the normal display.

## Phone controls

The message bar works like a chat app. It is a one-line bar at the bottom of the screen. Tap it to
open the iOS keyboard; the bar moves up and stays directly above the keyboard. It grows to a few lines
as you type. The bar is an ordinary native text field, not the terminal's hidden input, so iOS owns
autocorrect, dictation, selection, composition, and cursor movement. Return inserts a newline. Tap the
round **↑** button to send; the keyboard closes and the compact bar returns. With a hardware keyboard,
Command/Ctrl+Enter also sends.

Sending works like Enter in the laptop client: an idle session starts a run, and a running session
receives the message as steering. While Pi works and the bar is empty, the send button becomes **■
Stop**, which does what Escape does on the laptop (it interrupts the run and restores queued messages
to the draft). Type anything and the send button returns. A hardware keyboard's Escape key keeps its
laptop meaning. iOS web apps cannot add keys to the system keyboard, so there is no separate Esc row.

Drafts are stored locally per slot and restored after a reload. They are never submitted merely
because the app reconnects. Send and dialog answers are disabled while disconnected, but you can
keep editing the draft. A failed/uncertain submission restores its text for inspection, not replay.

Drag the transcript to scroll it locally, with momentum. When you are not at the end, the transcript
shows a **Jump to latest message** pill; tap it to follow new output again. Tool output expansion and
thinking visibility are in the **⋯** menu. Typing `/` or `@` shows native suggestion buttons for
commands and remote files. Remote questions and simple choices use native input sheets. The complex
fork/tree picker still uses the terminal; while it is open, **↑ ↓ Choose Cancel** buttons appear above
the bar.

This app keeps prompt drafts on the device. Use a device passcode and revoke lost devices. Removing
a device's authorization cannot erase information it already downloaded or copied while authorized.

## Home Screen app and notifications

On iOS 16.4 or later:

1. Connect Tailscale, open the HTTPS origin in Safari, and use **Share → Add to Home Screen**.
2. Open the installed app, pair that installation, and select a session.
3. In the app menu, tap **Enable notifications** and accept the iOS permission prompt.
4. Tap **Send test notification**, then verify a real notification with the app backgrounded.

No Apple Developer account, native app signing, or APNs certificate is needed. The devbox generates
its own VAPID key pair (the standard Web Push server identity) and stores it with device subscriptions
in private `push.json`. Back up that file securely to preserve subscriptions; deleting or replacing
its keys requires enabling notifications again. Outbound HTTPS to the browser's push service is
required. Subscription registration accepts only the known Apple, Chrome, and Firefox push hosts,
not arbitrary callback URLs. See [Apple's Web Push requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
and [WebKit's iPhone guide](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

A lightweight server-side activity monitor observes all slots without attaching transcript clients
or keeping side slots alive. It sends notifications for completed runs, new blocking questions, and
busy process exits. Retries and automatic compaction belong to the same run. Aborted runs and
intentional background waits do not notify. Existing idle state and old questions do not ring at
startup. Notifications include only a session label and outcome, not transcript text or tool output.
Session names can still be sensitive on a Lock Screen; configure iOS previews accordingly.

The monitor requires the daemon's `activity_stream` capability. A web server connected to an older
running daemon remains usable but reports notifications as unsupported. Upgrade/restart the daemon
at a safe time; starting the web service does **not** restart it. Do not interrupt an active session
just to enable push. The monitor probes again automatically after a daemon upgrade.

Push does not depend on the browser WebSocket staying alive. Every received push requests a visible
notification, even with the page open; there are no silent pushes or background socket workarounds.
Tapping it opens the relevant session after normal Tailscale and device authentication. Delivery is
best-effort: three bounded attempts for transient failures, no indefinite queue, and at most one hour
of push-service retention. Focus mode, notification settings, network conditions, and OS policy can
delay or suppress alerts. Revocation and unsubscribe prevent future sends/retries; an already-sent
notification cannot be recalled. Use **Disable notifications**, **Unpair this device**, or the CLI
revocation command to stop future delivery.

## Saved transcripts and resume

The service worker caches only the fixed app shell. It never caches API responses, pairing requests,
or WebSocket messages. Online authentication failures are never replaced with cached successes.
The browser separately keeps up to three verified transcript snapshots in IndexedDB, up to 8 MiB
each, and per-session drafts in local storage. These bytes can contain private conversation text;
use a passcode on the phone. **Clear saved transcripts** removes transcript snapshots; **Unpair this
device** also clears drafts. Revocation cannot erase information already downloaded while authorized.

A saved transcript is a read-only preview while the daemon reconnects, including after an offline
reload. Sending and answering old questions are disabled. Once authenticated, the daemon's current
snapshot replaces the preview; neither cached messages nor unsent drafts are submitted to Pi.
Quota/private-browsing errors only disable caching. iOS can evict local storage; the remote session
remains authoritative and continues running on the devbox. Server-built presentation bundles and
settings are not persisted with snapshots; an offline reload uses built-in presentation until
online authentication and configuration loading succeed again.

## Compatibility

The browser uses the pinned Pi 1.0.4 transcript components, not an agent in the browser. No provider
credentials, model calls, tool execution, or Pi session persistence move to the phone. Accepted or
uncertain commands are never replayed after reconnect.

Some shared laptop modules import Node APIs. The web build selects display modules directly and
provides narrow read-only browser replacements for themes, paths, and terminal operations.
Unsupported local filesystem/process operations throw rather than attempting remote execution.
Server-configured presentation adapters can use traced dynamic imports and the browser's shared Pi display
modules. Arbitrary Node module loading, external editors, local path attachments, and Ghostty
splits are not supported. Built-in renderers and remote text widgets remain available.

Run `npm run test:mobile` after installing Playwright's Chromium and WebKit browsers. The smoke
check uses an isolated daemon, a deterministic Pi-shaped child, and a loopback-only TLS test proxy
into the Unix listener. It checks pairing, local painting, prompts, work while disconnected,
reconnect/reload, and no prompt replay. It never accesses real sessions or model credentials.
`npm run test:presentation` checks server-configured static/dynamic display adapters and light/dark page
colors in Chromium and WebKit. After building, run
`node --import tsx test/smoke/presentation-browser.ts --real /path/to/my-ui.ts` on a machine with
your trusted Rowan adapter's display dependencies and gruvbox themes to check its real presentation.
The real-adapter smoke requires the explicit path; it has no repository default.
`npm run test:push` injects real Chromium service-worker push events through the browser debugging
protocol and checks displayed notification requests and offline-shell behavior. This is not external
Web Push or APNs delivery.

Browser emulation does not prove iOS keyboard/autocorrect behavior, Home Screen installation, or
real Apple push delivery. Those require a physical iPhone acceptance check.
