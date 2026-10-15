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

The web server uses the same installed release as the daemon. The devbox needs no checkout or
build, and you do not need to write a systemd unit. Add this to the normal `config.json` on the
machine you deploy from:

```json
{
  "host": "devbox",
  "web": {
    "allowUsers": ["you@example.com"]
  }
}
```

Use your exact Tailscale login, not the tagged devbox's owner. The list must be nonempty and
cannot contain wildcards. Deployment discovers the target devbox's HTTPS origin from its own
Tailscale DNS name. To use a fixed origin or non-default HTTPS port, set
`"origin": "https://devbox.your-tailnet.ts.net:8443"` inside `web` (no trailing slash).

From your laptop checkout:

```sh
npm run deploy
```

The remote host needs systemd 246 or later and Tailscale 1.50 or later.
When `web` is present, deploy writes/updates `pi-remote-web.service` in the remote user's
systemd configuration directory, reloads systemd, enables the unit, and starts/restarts it.
Its command names the installed release directly so old-release cleanup can identify running
code. It uses the remote Node executable, an absolute-only copy of the remote PATH, and
`~/.pi-remote-web` for private state. Systemd waits for the server's readiness notification before
reporting success; a startup failure fails the deploy rather than silently leaving the app down.

The web service owns no Pi sessions: restarting it only reconnects phones. It is managed even
with `--no-restart`, which skips only the daemon restart. Setup errors fail the deploy and skip
old-release cleanup and the later daemon restart; the new release remains installed. Missing or
inaccessible systemd/Tailscale prerequisites produce an error, rather than silently omitting
configured web service setup.

Without `web`, deploy does not install, enable, restart, stop, or remove a web service. To stop
using an already enabled service, first run `systemctl --user disable --now pi-remote-web.service`
on the devbox, then remove `web` from your config. Deploy owns the generated unit; use systemd
drop-ins for local customization instead of editing it. There is no skip flag.

If an older hand-written unit runs through the unversioned `bin/pi-remote` link, add `web` before
further deploys or stop/disable that unit first. Otherwise cleanup cannot identify its running
release from the command line and may eventually delete it. A configured deploy replaces that
unit with the release-pinned command while keeping private web state.

The `web` settings apply to every deploy target, including an explicit `HOST` argument. If you
set `web.origin`, make sure it belongs to that target; discovery is safer when using several hosts.

### One-time private routing and pairing

Deploy checks existing Tailscale Serve routing and user-service linger status and prints setup
commands if needed. It never changes routes, enables Funnel, enables linger, or pairs a phone.
If systemd's user manager is unavailable, log into the devbox and enable linger before retrying.
On the devbox, use the port from your origin (443 by default):

```sh
loginctl enable-linger "$USER"   # may require administrator approval; keeps the service after logout
# Review existing handlers first; do not replace an unrelated / route.
tailscale serve status
tailscale serve --bg --https=443 "unix:$HOME/.pi-remote-web/web.sock"
PI=~/.local/share/pi-remote/bin/pi-remote
"$PI" serve pair --web-state-dir ~/.pi-remote-web
"$PI" serve devices --web-state-dir ~/.pi-remote-web
"$PI" serve revoke DEVICE_ID --web-state-dir ~/.pi-remote-web
```

Keep existing private web state when migrating from a checkout-based service: the generated unit
uses the same `~/.pi-remote-web` directory, preserving device pairing and push keys. Configs and
adapters remain user-owned files; deployment sends only the web service settings, not your
presentation code or the rest of your config. The web server also works with an older daemon
(notification support still requires an upgraded daemon).

For development, `node bin/pi-remote serve --origin HTTPS_ORIGIN --allow-user LOGIN` still works
from a checkout after `npm run build`. Manually launched servers are not managed by deploy.

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
- `src/web/server/`: private HTTP/WebSocket listener, device pairing, open-session tabs, push, and config delivery.
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

### Sessions and tabs

The sessions you are interested in on this device appear as **tabs** below the header. Opening a
session from **Sessions** (or from a notification) adds it as a tab; tap a tab to switch to it. The
app shows one tab's transcript at a time. Tap **×** to close a tab. This only removes it from this
device: the session keeps running, and you can open it again from **Sessions**. Tabs whose session
no longer exists close automatically; a stopped session's tab stays until you close it.

**Notifications follow tabs.** Each device gets notifications only for the sessions open as its tabs.
Tabs are stored per paired device in private `tabs.json` on the devbox (at most 24 per device), so
they survive reloads and apply while the app is closed. **Unpair this device** removes its tabs. A
device paired before tabs existed reopens its last session, which becomes its first tab.

To start a session from the phone, open **Sessions**, enter a directory on the devbox under **New
session**, and tap **Start session**. This is the same as `pi-remote new --cwd DIRECTORY`: the
daemon resolves `~` and checks the directory. The field suggests recent directories, directories of
running sessions, and devbox directory completions. The new session opens as the active tab. The
request is sent once; if the app cannot confirm the result, refresh the list before trying again
rather than risk a duplicate session.

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
2. Open the installed app, pair that installation, and open a session (it becomes a tab).
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
busy process exits, to each subscribed device that has the session open as a tab. Closing a tab also
cancels pending retries for that session's notifications. **Send test notification** ignores tabs. Retries and automatic compaction belong to the same run. Aborted runs and
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
