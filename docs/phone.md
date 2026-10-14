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

## Build and run

```sh
npm ci --ignore-scripts
npm run build
pi-remote serve --help
```

Use an HTTPS origin belonging to this device's Tailscale DNS name, and your actual Tailscale login,
not the tagged server's owner. The default web state directory is separate from daemon metadata.
Do not run `deploy` or restart the daemon merely to start the web server.

For example, from the checkout on the devbox (replace the hostname and login):

```sh
node bin/pi-remote serve --origin https://devbox.your-tailnet.ts.net --allow-user you@example.com
# In a second terminal; --bg persists the Serve configuration:
tailscale serve --bg --https=443 "unix:$HOME/.pi/remote/web/web.sock"
node bin/pi-remote serve pair
node bin/pi-remote serve devices
node bin/pi-remote serve revoke DEVICE_ID
```

Use a user service to keep `serve` running without a terminal. Pairing and revocation commands must
use the same `--web-state-dir` as the service. Do not reset the whole Tailscale Serve configuration
or change unrelated existing handlers. The server expects Serve's Unix-proxy header shape
(`Host: localhost`, exact `X-Forwarded-Host`, and `X-Forwarded-Proto: https`), not a generic proxy.

Open the origin in Safari over Tailscale. Install on the Home Screen **before pairing**: iOS can
isolate the installed app's browser storage from the Safari tab. Generate a pairing code on the
same devbox and with the same web state directory as the running service, then enter it in the
installed app. Do not paste pairing codes into shared logs or commit them.

## Compatibility

The browser uses the pinned Pi 1.0.4 transcript components, not an agent in the browser. No provider
credentials, model calls, tool execution, or Pi session persistence move to the phone. Accepted or
uncertain commands are never replayed after reconnect.

Some shared laptop modules import Node APIs. The web build selects display modules directly and
provides narrow read-only browser replacements for themes, paths, and terminal operations.
Unsupported local filesystem/process operations throw rather than attempting remote execution.
Dynamic Node presentation adapters, external editors, local path attachments, and Ghostty splits
are not supported by the browser. Built-in renderers and remote text widgets remain available.

Run `npm run test:mobile` after installing Playwright's Chromium and WebKit browsers. The smoke
check uses an isolated daemon, a deterministic Pi-shaped child, and a loopback-only TLS test proxy
into the Unix listener. It checks pairing, local painting, prompts, work while disconnected,
reconnect/reload, and no prompt replay. It never accesses real sessions or model credentials.

Browser emulation does not prove iOS keyboard/autocorrect behavior, Home Screen installation, or
real Apple push delivery. Those require a physical iPhone acceptance check.
