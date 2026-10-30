import { constants, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { Connection, handshake } from '../../client/connection.js';
import { ensureDaemon } from '../../daemon/launch.js';
import { MAX_FRAME_BYTES } from '../../protocol/jsonl.js';
import type { DaemonMethod } from '../../protocol/methods.js';
import { defaultBrowserConfig, type BrowserConfig } from './browser-config.js';
import { DEVICE_COOKIE, DEVICE_FILE, DeviceStore, deviceCookie, deviceToken, type Device } from './devices.js';
import { listenPrivate, privateDirectory } from './private-state.js';
import { TabError, TabStore, handleTabsApi } from './tabs.js';
import { checkTailscale } from './tailscale.js';

export const MAX_WEB_BYTES = MAX_FRAME_BYTES;
export const MAX_API_BYTES = 16 * 1024;
export function defaultWebStateDir(): string { return join(homedir(), '.pi', 'remote', 'web'); }
export function defaultStaticDir(moduleUrl = import.meta.url): string {
  // src/web/server/*.ts in a checkout; dist/web/server/*.js in a deployed release.
  return fileURLToPath(new URL(moduleUrl.endsWith('.ts') ? '../../../dist/web/' : '../', moduleUrl));
}
interface WebServerContext {
  readonly origin: string;
  readonly devices: DeviceStore;
  /** Per-device open sessions; push notifications follow these. */
  readonly tabs: TabStore;
}
export interface AuthenticatedContext extends WebServerContext { device: Device; login: string }
export interface WebServerOptions {
  origin: string;
  allowedLogins: readonly string[];
  /** Dedicated web state only. Never share it with the daemon's state directory. */
  stateDir?: string;
  socketPath?: string;
  daemonStateDir?: string;
  staticDir?: string;
  /** Normal pi-remote config on this server; defaults to the XDG client config path. */
  uiConfig?: string;
  /** Explicit test seams; there is deliberately no TCP listener option. */
  allowHttpLocalhostForTests?: boolean;
  checkTailscale?: (origin: URL) => Promise<void>;
  openDaemon?: () => Promise<Socket>;
  handshakeTimeoutMs?: number;
  now?: () => number;
  /** Called only for paired, identity-checked requests with verified Host/Origin. */
  handleApi?: (request: IncomingMessage, response: ServerResponse, context: AuthenticatedContext) => boolean | Promise<boolean>;
}
export interface WebServerHandle extends WebServerContext {
  readonly socketPath: string;
  readonly stateDir: string;
  close(): Promise<void>;
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/xterm.css', ['xterm.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
]);
function configuredOrigin(value: string, allowHttp: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Configure an exact HTTPS origin'); }
  if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Configure an exact HTTPS origin (HTTP localhost is available only through the test option)');
  }
  return url;
}
function header(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) count++;
  if (count > 1) throw new HttpError(400, 'Duplicate security header');
  const value = request.headers[name];
  if (Array.isArray(value)) throw new HttpError(400, 'Invalid security header');
  return value;
}
function securityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}
export async function readJsonBody(request: IncomingMessage, limit = MAX_API_BYTES): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json');
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new HttpError(413, 'Request body exceeds limit');
  return new Promise((accept, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const aborted = () => error(new HttpError(400, 'Request aborted'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { cleanup(); request.resume(); reject(new HttpError(413, 'Request body exceeds limit')); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        accept(value);
      } catch { reject(new HttpError(400, 'Expected a JSON object')); }
    };
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
}

interface Peer { ws: WebSocket; device: Device; token: string; login: string; connection?: Connection }

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const origin = configuredOrigin(options.origin, options.allowHttpLocalhostForTests === true);
  if (!options.allowedLogins.length || options.allowedLogins.length > 100 || options.allowedLogins.some(login => !login || login.length > 256 || /[\s*\x00-\x1f\x7f]/.test(login))) throw new Error('Provide an explicit, non-wildcard Tailscale user allowlist');
  const allowed = new Set(options.allowedLogins);
  await (options.checkTailscale ?? checkTailscale)(origin); // fail closed before opening any listener
  const stateDir = await privateDirectory(options.stateDir ?? defaultWebStateDir());
  const socketPath = resolve(options.socketPath ?? join(stateDir, 'web.sock'));
  const devices = new DeviceStore(stateDir, options.now);
  await devices.list(); // validate existing state before serving anything
  const tabs = await TabStore.open(stateDir, devices);
  const now = options.now ?? Date.now;
  const peers = new Set<Peer>();
  const sockets = new Set<Socket>();
  const attempts = new Map<string, { count: number; until: number }>(); // keys are bounded by the allowlist
  let closing = false;
  let upgrades = 0;
  let pendingBytes = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WEB_BYTES, perMessageDeflate: false, clientTracking: false });

  function validate(request: IncomingMessage, mutation = false): string {
    if (closing) throw new HttpError(503, 'Server is stopping');
    // Tailscale's Unix backend rewrites Host to localhost and overwrites these
    // forwarded headers with the original HTTPS host/protocol. Require that exact
    // shape; neither an arbitrary backend Host nor a client-supplied chain is trusted.
    if (header(request, 'host') !== 'localhost') throw new HttpError(403, 'Untrusted Host');
    if (header(request, 'x-forwarded-host') !== origin.host) throw new HttpError(403, 'Untrusted forwarded Host');
    if (header(request, 'x-forwarded-proto') !== origin.protocol.slice(0, -1)) throw new HttpError(403, 'Untrusted forwarded protocol');
    // This server does not use RFC 7239 Forwarded. Reject it rather than trust an ambiguous chain.
    if (header(request, 'forwarded') !== undefined) throw new HttpError(403, 'Untrusted Forwarded header');
    const requestOrigin = header(request, 'origin');
    if ((requestOrigin !== undefined && requestOrigin !== origin.origin) || (mutation && requestOrigin !== origin.origin)) throw new HttpError(403, 'Untrusted Origin');
    const login = header(request, 'tailscale-user-login');
    if (!login || !allowed.has(login)) throw new HttpError(403, 'Tailscale identity is not allowed');
    return login;
  }
  function closeDeviceConnections(id: string): void {
    for (const peer of peers) if (peer.device.id === id) {
      peer.ws.close(1008, 'Device revoked');
      peer.connection?.close();
      const timer = setTimeout(() => peer.ws.terminate(), 1000);
      timer.unref();
      peer.ws.once('close', () => clearTimeout(timer));
    }
  }
  const context: WebServerContext = { origin: origin.origin, devices, tabs };
  const getDevice = (request: IncomingMessage, login: string) => devices.authenticate(deviceToken(header(request, 'cookie')), login);
  const authenticatedContext = (device: Device, login: string): AuthenticatedContext => ({ ...context, device, login });

  async function serveStatic(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const entry = STATIC.get(path);
    if (!entry) throw new HttpError(404, 'Not found');
    let file;
    try { file = await open(join(options.staticDir ?? defaultStaticDir(), entry[0]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error: any) { if (['ENOENT', 'ELOOP'].includes(error.code)) throw new HttpError(404, 'Not found'); throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_WEB_BYTES) throw new HttpError(404, 'Not found');
      response.setHeader('Content-Type', entry[1]);
      response.setHeader('Content-Length', stat.size);
      if (path === '/sw.js') response.setHeader('Service-Worker-Allowed', '/');
      if (request.method === 'HEAD') { response.end(); return; }
      // pipe() respects HTTP backpressure; the open descriptor prevents symlink races.
      const stream = file.createReadStream({ autoClose: false });
      await new Promise<void>((accept, reject) => {
        const cleanup = () => { response.off('close', closed); stream.off('error', error); stream.off('end', end); };
        const closed = () => { cleanup(); stream.destroy(); accept(); };
        const end = () => { cleanup(); accept(); };
        const error = (cause: Error) => { cleanup(); stream.destroy(); reject(cause); };
        response.once('close', closed); stream.once('error', error); stream.once('end', end);
        stream.pipe(response);
      });
    } finally { await file.close(); }
  }
  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response);
    try {
      const login = validate(request, !['GET', 'HEAD'].includes(request.method ?? ''));
      const path = (request.url ?? '').split('?')[0];
      if (request.method === 'GET' && path === '/api/status') {
        const device = await getDevice(request, login);
        json(response, 200, { authenticated: !!device, ...(device ? { device, label: device.label } : {}) });
      } else if (request.method === 'POST' && path === '/api/pair') {
        const previous = attempts.get(login);
        const bucket = previous && previous.until > now() ? previous : { count: 0, until: now() + 60_000 };
        attempts.set(login, bucket);
        if (++bucket.count > 5) { response.setHeader('Retry-After', '60'); throw new HttpError(429, 'Too many pairing attempts'); }
        const body = await readJsonBody(request);
        const paired = await devices.pair(body.code, body.label, login);
        if (!paired) throw new HttpError(401, 'Invalid or expired pairing code');
        response.setHeader('Set-Cookie', deviceCookie(paired.token));
        json(response, 200, { authenticated: true, device: paired.device, label: paired.device.label });
      } else if (path.startsWith('/api/')) {
        const device = await getDevice(request, login);
        if (!device) throw new HttpError(401, 'Device pairing required');
        if (path === '/api/config' && request.method === 'GET') {
          // Theme files and safe settings only: Pi renders sessions itself.
          const config: BrowserConfig = await defaultBrowserConfig({ uiConfig: options.uiConfig });
          if (Buffer.byteLength(JSON.stringify(config)) > MAX_WEB_BYTES) throw new Error('Browser config exceeds limit');
          json(response, 200, config);
        } else if (path === '/api/tabs' || path.startsWith('/api/tabs/')) {
          if (!await handleTabsApi(tabs, request, response, device.id, readJsonBody)) throw new HttpError(404, 'Not found');
        } else if (path === '/api/logout' && request.method === 'POST') {
          await devices.revoke(device.id);
          await tabs.forget(device.id);
          closeDeviceConnections(device.id);
          response.setHeader('Set-Cookie', `${DEVICE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
          json(response, 200, { authenticated: false });
        } else if (!options.handleApi || !await options.handleApi(request, response, authenticatedContext(device, login))) throw new HttpError(404, 'Not found');
      } else await serveStatic(request, response, path);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else {
        // Never reflect request bodies, codes, tokens, daemon diagnostics, or internal paths.
        response.setHeader('Connection', 'close');
        const known = error instanceof HttpError || error instanceof TabError;
        json(response, known ? error.status : 500, { error: known ? error.message : 'Web server request failed' });
      }
    }
  }
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5000 }, (request, response) => { void handleHttp(request, response); });
  server.maxHeadersCount = 64;
  server.maxConnections = 128;
  server.maxRequestsPerSocket = 100;
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('error', () => {}); // request/listen promises report errors without dumping sensitive data
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

  function startProxy(ws: WebSocket, device: Device, token: string, login: string): void {
    const peer: Peer = { ws, device, token, login };
    peers.add(peer);
    let ordered = Promise.resolve();
    const ids = new Set<string>();
    let peerPending = 0;
    const fail = (reason: string, code = 1008) => { ws.close(code, reason); peer.connection?.close(); };
    function send(value: unknown) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const text = JSON.stringify(value);
      const bytes = Buffer.byteLength(text);
      let buffered = 0;
      for (const item of peers) buffered += item.ws.bufferedAmount;
      if (bytes > MAX_WEB_BYTES || buffered + bytes > MAX_WEB_BYTES) { fail('WebSocket output exceeds limit', 1009); return; }
      ws.send(text, error => { if (error) fail('WebSocket output failed', 1011); });
    }
    const connected = (async () => {
      const socket = await (options.openDaemon ?? (() => ensureDaemon(options.daemonStateDir)))();
      const connection = new Connection(socket, socket, () => socket.destroy());
      peer.connection = connection;
      if (closing || ws.readyState !== WebSocket.OPEN) { connection.close(); throw new Error('WebSocket closed'); }
      await handshake(connection, options.handshakeTimeoutMs);
      if (ws.readyState !== WebSocket.OPEN) { connection.close(); throw new Error('WebSocket closed'); }
      connection.onEvent(send);
      connection.onDisconnect(() => fail('Daemon disconnected; commands were not retried', 1011));
      return connection;
    })();
    void connected.catch(() => fail('Daemon connection failed; commands were not retried', 1011));
    ws.on('message', (data: RawData, binary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = Array.isArray(data) ? data.reduce((sum, item) => sum + item.length, 0) : data.byteLength;
      if (binary || bytes > MAX_WEB_BYTES || pendingBytes + bytes > MAX_WEB_BYTES || peerPending >= 256) { fail('WebSocket input exceeds limit', 1009); return; }
      pendingBytes += bytes;
      peerPending++;
      let released = false;
      const release = () => { if (!released) { released = true; pendingBytes -= bytes; peerPending--; } };
      ordered = ordered.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) { release(); return; }
        if (!await devices.authenticate(token, login)) { release(); closeDeviceConnections(device.id); return; }
        let message: any;
        try { message = JSON.parse(data.toString()); }
        catch { release(); fail('Expected a JSON request'); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { release(); fail('Expected a JSON request'); return; }
        if (message.type !== 'request') { release(); fail('Invalid WebSocket message'); return; }
        if (typeof message.id !== 'string' || !message.id || message.id.length > 128 || ids.has(message.id)
          || typeof message.method !== 'string' || !message.method || message.method.length > 128
          || (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))) {
          release(); fail('Invalid or duplicate request'); return;
        }
        const connection = await connected;
        if (ws.readyState !== WebSocket.OPEN) { release(); return; }
        ids.add(message.id);
        // Exactly one daemon request. Never reconnect or replay mutations.
        void connection.request(message.method as DaemonMethod, message.params).then(
          result => send({ type: 'result', id: message.id, success: true, data: result }),
          error => send({ type: 'result', id: message.id, success: false, error: error instanceof Error ? error.message : 'Daemon request failed; it was not retried' }),
        ).finally(() => { ids.delete(message.id); release(); });
      }).catch(() => { release(); fail('WebSocket request failed', 1011); });
    });
    ws.on('error', () => {});
    ws.once('close', () => { peers.delete(peer); peer.connection?.close(); });
  }
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    if (++upgrades > 32) { upgrades--; socket.destroy(); return; }
    void (async () => {
      try {
        const login = validate(request, true);
        if (request.method !== 'GET' || request.url !== '/ws') throw new HttpError(404, 'Not found');
        if (peers.size >= 64) throw new HttpError(503, 'Connection limit reached');
        const token = deviceToken(header(request, 'cookie'));
        const device = await devices.authenticate(token, login);
        if (!device) throw new HttpError(401, 'Device pairing required');
        if (closing || socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, ws => startProxy(ws, device, token!, login));
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
      } finally { upgrades--; }
    })();
  });

  const cleanupSocket = await listenPrivate(server, stateDir, socketPath);
  let checking = false;
  async function checkRevocations() {
    if (checking || closing || !peers.size) return;
    checking = true;
    try {
      const valid = new Set((await devices.list()).map(device => device.id));
      for (const peer of peers) if (!valid.has(peer.device.id)) closeDeviceConnections(peer.device.id);
    } catch { for (const peer of peers) closeDeviceConnections(peer.device.id); }
    finally { checking = false; }
  }
  const watcher = watch(stateDir, (_event, filename) => { if (!filename || filename.toString() === DEVICE_FILE) void checkRevocations(); });
  watcher.on('error', () => { for (const peer of peers) closeDeviceConnections(peer.device.id); });
  const poll = setInterval(() => { void checkRevocations(); }, 1000);
  poll.unref();
  let stopped: Promise<void> | undefined;
  return {
    ...context, stateDir, socketPath,
    close() {
      stopped ??= (async () => {
        closing = true;
        watcher.close(); clearInterval(poll);
        for (const peer of peers) { peer.connection?.close(); peer.ws.terminate(); }
        for (const socket of sockets) socket.destroy();
        wss.close();
        await new Promise<void>(accept => server.close(() => accept()));
        await cleanupSocket();
        await tabs.flush();
      })();
      return stopped;
    },
  };
}
