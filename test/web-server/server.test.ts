import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { webRequest, type WebRequestOptions } from './http.js';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { readJsonl, writeJsonl } from '../../src/protocol/jsonl.js';
import { PI_VERSION, PROTOCOL_VERSION } from '../../src/protocol/types.js';
import { DeviceStore, DEVICE_COOKIE, deviceToken } from '../../src/web/server/devices.js';
import { serveMain } from '../../src/web/server/main.js';
import { MAX_API_BYTES, MAX_WEB_BYTES, defaultStaticDir, startWebServer, type WebServerOptions } from '../../src/web/server/server.js';
import { assertNoFunnel } from '../../src/web/server/tailscale.js';

const ORIGIN = 'https://phone.example.ts.net';
const LOGIN = 'rowan@isara.io';
const HOST = new URL(ORIGIN).host;
const proxyHeaders = { Host: 'localhost', 'X-Forwarded-Host': HOST, 'X-Forwarded-Proto': 'https' };
const standard = { ...proxyHeaders, 'Tailscale-User-Login': LOGIN };

async function fixture(t: TestContext, overrides: Partial<WebServerOptions> = {}) {
  const root = await mkdtemp('/tmp/pi-web-');
  const stateDir = join(root, 'state');
  const staticDir = join(root, 'static');
  await mkdir(staticDir, { mode: 0o700 });
  for (const [file, content] of Object.entries({ 'index.html': '<!doctype html><script src="/app.js"></script>', 'app.js': 'export {};', 'app.css': 'body{}', 'xterm.css': '.xterm{}', 'sw.js': 'export {};', 'icon.svg': '<svg/>', 'manifest.webmanifest': '{}' })) await writeFile(join(staticDir, file), content);
  const transports = new Set<Socket>();
  const requests: any[] = [];
  let handler: ((record: any, socket: Socket) => void) | undefined;
  let opens = 0;
  const daemon = createServer(socket => {
    transports.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => transports.delete(socket));
    readJsonl(socket, record => {
      requests.push(record);
      if (record.method === 'hello') writeJsonl(socket, { type: 'result', id: record.id, success: true, data: { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION, pid: 123 } });
      else if (handler) handler(record, socket);
      else writeJsonl(socket, { type: 'result', id: record.id, success: true, data: { method: record.method, params: record.params } });
    }, () => socket.destroy());
  });
  await new Promise<void>(accept => daemon.listen(join(root, 'fake-daemon.sock'), accept));
  const server = await startWebServer({
    origin: ORIGIN, allowedLogins: [LOGIN], stateDir, staticDir,
    checkTailscale: async () => {},
    openDaemon: async () => {
      opens++;
      const socket = createConnection(join(root, 'fake-daemon.sock'));
      await once(socket, 'connect');
      return socket;
    },
    ...overrides,
  });
  const clients = new Set<WebSocket>();
  t.after(async () => {
    for (const client of clients) client.terminate();
    await server.close();
    for (const transport of transports) transport.destroy();
    await new Promise<void>(accept => daemon.close(() => accept()));
    await rm(root, { recursive: true, force: true });
  });
  const request = (path: string, options: WebRequestOptions & { omitIdentity?: boolean } = {}) =>
    webRequest(server.socketPath, path, { ...options, headers: { ...(options.omitIdentity ? proxyHeaders : standard), ...options.headers } });
  async function pair(label = 'Phone') {
    const { code } = await server.devices.issuePairingCode();
    const response = await request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, body: { code, label } });
    assert.equal(response.status, 200, response.body);
    const cookie = response.headers['set-cookie']![0].split(';')[0];
    return { cookie, device: response.json.device, code, response };
  }
  function ws(headers: Record<string, string> = {}, path = '/ws', omitIdentity = false) {
    const client = new WebSocket(`ws://${HOST}${path}`, {
      headers: { ...(omitIdentity ? proxyHeaders : standard), Origin: ORIGIN, ...headers },
      createConnection: () => createConnection(server.socketPath),
    });
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    return client;
  }
  return { root, stateDir: server.stateDir, server, staticDir, request, pair, ws, requests, transports, opens: () => opens, setHandler: (value: typeof handler) => { handler = value; } };
}
async function rejectedUpgrade(client: WebSocket): Promise<number> {
  return new Promise((accept, reject) => {
    client.once('open', () => reject(new Error('Unexpected successful upgrade')));
    client.once('unexpected-response', (_request, response) => { response.resume(); accept(response.statusCode!); client.terminate(); });
    client.once('error', error => { if (!error.message.includes('closed before')) reject(error); });
  });
}
async function waitFor(predicate: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await delay(10); }
}

test('Unix listener and private state have exact modes; static assets require an exact identity', async t => {
  const f = await fixture(t);
  assert.equal((await lstat(f.stateDir)).mode & 0o7777, 0o700);
  assert.equal((await lstat(f.server.socketPath)).mode & 0o7777, 0o600);
  for (const path of ['/', '/app.js', '/app.css', '/xterm.css', '/icon.svg', '/manifest.webmanifest', '/sw.js', '/api/status']) {
    assert.equal((await f.request(path, { omitIdentity: true })).status, 403, path);
    assert.equal((await f.request(path, { headers: { 'Tailscale-User-Login': 'other@example.com' } })).status, 403, path);
    const response = await f.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.match(String(response.headers['content-security-policy']), /script-src 'self'/);
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.match(String(response.headers['content-security-policy']), /style-src 'self' 'unsafe-inline'/);
    assert.doesNotMatch(String(response.headers['content-security-policy']).match(/script-src[^;]*/)?.[0] ?? '', /unsafe-inline|unsafe-eval/);
  }
  assert.equal((await f.request('/sw.js')).headers['service-worker-allowed'], '/');
  assert.equal((await f.request('/')).headers['content-type'], 'text/html; charset=utf-8');
  assert.equal((await f.request('/app.js', { method: 'HEAD' })).body, '');
  assert.deepEqual((await f.request('/api/status')).json, { authenticated: false });
  assert.equal((await f.request('/api/config')).status, 401);
  assert.equal(f.opens(), 0);
});

test('pairing is one-time, hashed at rest, bound to identity, and uses a secure host-only cookie', async t => {
  const f = await fixture(t, { allowedLogins: [LOGIN, 'second@example.com'] });
  const p = await f.pair('My phone');
  const setCookie = p.response.headers['set-cookie']![0];
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(setCookie.includes(flag));
  assert.ok(setCookie.startsWith(`${DEVICE_COOKIE}=`));
  assert.doesNotMatch(setCookie, /Domain=/i);
  const file = await readFile(join(f.stateDir, 'devices.json'), 'utf8');
  assert.ok(!file.includes(p.code));
  assert.ok(!file.includes(p.cookie.split('=')[1]));
  assert.equal((await lstat(join(f.stateDir, 'devices.json'))).mode & 0o7777, 0o600);
  assert.equal((await f.request('/api/status', { headers: { Cookie: p.cookie } })).json.label, 'My phone');
  assert.equal((await f.request('/api/status', { headers: { Cookie: p.cookie, 'Tailscale-User-Login': 'second@example.com' } })).json.authenticated, false);
  assert.equal((await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, body: { code: p.code, label: 'Replay' } })).status, 401);
  assert.equal((await f.server.devices.list()).length, 1);
});

test('expired pairing cannot be used; simultaneous consumers can redeem a code only once', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  const expired = await f.server.devices.issuePairingCode(10);
  now += 11;
  assert.equal((await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, body: { code: expired.code, label: 'Expired' } })).status, 401);
  const valid = await f.server.devices.issuePairingCode();
  const results = await Promise.all(['A', 'B'].map(label => f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, body: { code: valid.code, label } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
});

test('pair guesses are rate-limited and expire from the bounded identity bucket', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, body: { code: 'bad', label: 'Guess' } })).status, 401);
  const blocked = await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, body: { code: 'bad', label: 'Guess' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '60');
  now += 60_001;
  assert.equal((await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, body: { code: 'bad', label: 'Guess' } })).status, 401);
});

test('all supplied origins, mutation origins, Host, and forwarded hosts are checked exactly', async t => {
  const f = await fixture(t);
  const badHeaders: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `${ORIGIN}/` }, { Host: 'evil.example' }, { Host: HOST }, { 'X-Forwarded-Host': '' }, { 'X-Forwarded-Proto': '' }, { 'X-Forwarded-Host': 'evil.example' }, { 'X-Forwarded-Host': `${HOST},evil.example` }, { 'X-Forwarded-Proto': 'http' }, { Forwarded: `host=${HOST}` }];
  for (const headers of badHeaders) {
    assert.equal((await f.request('/', { headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await f.request('/', { headers: { Origin: ORIGIN, 'X-Forwarded-Host': HOST, 'X-Forwarded-Proto': 'https' } })).status, 200);
  assert.equal((await f.request('/api/pair', { method: 'POST', body: { code: 'bad', label: 'Bad' } })).status, 403);
  assert.equal((await f.request('/api/pair', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { code: 'bad', label: 'Bad' } })).status, 403);
});

test('WebSocket upgrade requires identity, a paired cookie, exact origin, and a fixed path', async t => {
  const f = await fixture(t);
  const p = await f.pair();
  assert.equal(await rejectedUpgrade(f.ws({}, '/ws', true)), 403);
  assert.equal(await rejectedUpgrade(f.ws({ 'Tailscale-User-Login': 'wrong' })), 403);
  assert.equal(await rejectedUpgrade(f.ws()), 401);
  assert.equal(await rejectedUpgrade(f.ws({ Cookie: p.cookie, Origin: 'https://evil.example' })), 403);
  assert.equal(await rejectedUpgrade(f.ws({ Cookie: p.cookie, Origin: '' })), 403);
  assert.equal(await rejectedUpgrade(f.ws({ Cookie: p.cookie, Host: 'evil.example' })), 403);
  assert.equal(await rejectedUpgrade(f.ws({ Cookie: p.cookie }, '/not-ws')), 404);
  assert.equal(f.opens(), 0);
});

test('JSON requests/results/events proxy through a verified private daemon connection without mutation retries', async t => {
  const f = await fixture(t);
  const p = await f.pair();
  const client = f.ws({ Cookie: p.cookie });
  const messages: any[] = [];
  client.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(client, 'open');
  client.send(JSON.stringify({ type: 'request', id: 'client-id', method: 'rpc', params: { slotId: 'slot', command: { type: 'prompt', message: 'Do work' } } }));
  await waitFor(() => messages.length === 1);
  assert.deepEqual(messages[0], { type: 'result', id: 'client-id', success: true, data: { method: 'rpc', params: { slotId: 'slot', command: { type: 'prompt', message: 'Do work' } } } });
  assert.equal(f.requests[0].method, 'hello');
  assert.deepEqual(f.requests[0].params, { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
  const event = { type: 'event', slotId: 'slot', seq: 1, event: { type: 'message_update', text: 'Hello' } };
  writeJsonl([...f.transports][0], event);
  await waitFor(() => messages.length === 2);
  assert.deepEqual(messages[1], event);
  f.setHandler((record, socket) => writeJsonl(socket, { type: 'result', id: record.id, success: false, error: 'Remote Pi is busy' }));
  client.send(JSON.stringify({ type: 'request', id: 'failure', method: 'kill', params: { slotId: 'slot' } }));
  await waitFor(() => messages.length === 3);
  assert.equal(messages[2].error, 'Remote Pi is busy');
  f.setHandler(() => {});
  client.send(JSON.stringify({ type: 'request', id: 'pending', method: 'rpc', params: { slotId: 'slot', command: { type: 'prompt' } } }));
  await waitFor(() => f.requests.length === 4);
  const closed = once(client, 'close');
  [...f.transports][0].destroy();
  await closed;
  await delay(30);
  assert.equal(f.opens(), 1);
  assert.equal(f.requests.filter(record => record.method === 'rpc').length, 2);
});

test('revocation from a different CLI store invalidates sessions and closes active WebSockets', async t => {
  const f = await fixture(t);
  const p = await f.pair();
  const client = f.ws({ Cookie: p.cookie });
  await once(client, 'open');
  const closed = once(client, 'close');
  const cliStore = new DeviceStore(f.stateDir);
  assert.equal(await cliStore.revoke(p.device.id), true);
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal((await f.request('/api/status', { headers: { Cookie: p.cookie } })).json.authenticated, false);
  assert.equal(await rejectedUpgrade(f.ws({ Cookie: p.cookie })), 401);
});

test('own logout revokes a device and clears its secure cookie', async t => {
  const f = await fixture(t);
  const p = await f.pair();
  const result = await f.request('/api/logout', { method: 'POST', headers: { Cookie: p.cookie, Origin: ORIGIN } });
  assert.equal(result.status, 200);
  assert.match(result.headers['set-cookie']![0], /Secure; HttpOnly; SameSite=Strict; Max-Age=0/);
  assert.equal((await f.request('/api/status', { headers: { Cookie: p.cookie } })).json.authenticated, false);
});

test('cookie parser rejects duplicate, encoded, quoted, malformed, and oversized tokens', () => {
  const token = 'a'.repeat(43);
  assert.equal(deviceToken(`unrelated=1; ${DEVICE_COOKIE}=${token}; another=a=b`), token);
  for (const cookie of [`${DEVICE_COOKIE}=${token}; ${DEVICE_COOKIE}=${token}`, `${DEVICE_COOKIE}="${token}"`, `${DEVICE_COOKIE}=%61${token.slice(1)}`, `${DEVICE_COOKIE}=${token}\n`, `${DEVICE_COOKIE}=${token}; ${DEVICE_COOKIE}`, `${DEVICE_COOKIE}=${token}; ${'x'.repeat(8192)}`, `${DEVICE_COOKIE}=bad; ${DEVICE_COOKIE}=${token}`]) assert.equal(deviceToken(cookie), undefined, cookie.slice(0, 100));
});

test('API bodies, WebSocket frames, and pending requests are bounded', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const tooBig = await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, rawBody: JSON.stringify({ code: 'a'.repeat(MAX_API_BYTES), label: 'Large' }) });
  assert.equal(tooBig.status, 413);
  const chunked = await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, rawBody: 'x'.repeat(MAX_API_BYTES + 1), chunked: true });
  assert.equal(chunked.status, 413);
  assert.equal((await f.request('/api/pair', { method: 'POST', headers: { Origin: ORIGIN }, rawBody: '[' })).status, 400);
  const p = await f.pair();
  const large = f.ws({ Cookie: p.cookie });
  await once(large, 'open');
  const largeClosed = once(large, 'close');
  large.send(Buffer.alloc(MAX_WEB_BYTES + 1, 32), { binary: false });
  assert.equal((await largeClosed)[0], 1009);
  const pending = f.ws({ Cookie: p.cookie });
  await once(pending, 'open');
  f.setHandler(() => {});
  const pendingClosed = once(pending, 'close');
  for (let i = 0; i < 257; i++) pending.send(JSON.stringify({ type: 'request', id: String(i), method: 'list' }));
  assert.equal((await pendingClosed)[0], 1009);
});

test('static allowlist rejects traversal, unknown files, symlinks, and non-GET methods', async t => {
  const f = await fixture(t);
  for (const path of ['/../package.json', '/%2e%2e/index.html', '/app.js/extra', '//app.js', '/secret.json', '/api/unknown']) assert.notEqual((await f.request(path)).status, 200, path);
  assert.equal((await f.request('/app.js', { method: 'POST', headers: { Origin: ORIGIN } })).status, 405);
  await rm(join(f.staticDir, 'app.js'));
  await symlink(join(f.staticDir, 'index.html'), join(f.staticDir, 'app.js'));
  assert.equal((await f.request('/app.js')).status, 404);
});

test('listener never unlinks an existing live socket, unsafe state, or replacement socket path', async t => {
  const f = await fixture(t);
  const options = { origin: ORIGIN, allowedLogins: [LOGIN], stateDir: f.stateDir, checkTailscale: async () => {} };
  const original = await lstat(f.server.socketPath);
  await assert.rejects(startWebServer(options), /already exists/);
  assert.equal((await lstat(f.server.socketPath)).ino, original.ino);
  const alias = join(f.root, 'alias');
  await symlink(f.stateDir, alias);
  await assert.rejects(startWebServer({ ...options, stateDir: alias }), /symlinks/);
  const unsafe = join(f.root, 'unsafe');
  await mkdir(unsafe, { mode: 0o755 });
  await assert.rejects(startWebServer({ ...options, stateDir: unsafe }), /0700/);
  await assert.rejects(startWebServer({ ...options, socketPath: join(f.root, 'outside.sock') }), /inside/);
  const replacement = join(f.root, 'replacement.sock');
  const other = createServer(socket => socket.end());
  await new Promise<void>(accept => other.listen(replacement, accept));
  await rename(f.server.socketPath, join(f.stateDir, 'old.sock'));
  await rename(replacement, f.server.socketPath);
  const replacementInode = (await lstat(f.server.socketPath)).ino;
  await f.server.close();
  assert.equal((await lstat(f.server.socketPath)).ino, replacementInode);
  await new Promise<void>(accept => other.close(() => accept()));
});

test('wrong ownership, state-file symlinks, shared state files, and socket symlinks fail closed', async t => {
  const root = await mkdtemp('/tmp/pi-web-unsafe-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { origin: ORIGIN, allowedLogins: [LOGIN], stateDir: root, checkTailscale: async () => {} };
  await symlink('/tmp/missing-web-socket', join(root, 'web.sock'));
  await assert.rejects(startWebServer(options), /already exists/);
  await rm(join(root, 'web.sock'));
  await symlink('/tmp/missing-web-state', join(root, 'devices.json'));
  await assert.rejects(startWebServer(options));
  await rm(join(root, 'devices.json'));
  await writeFile(join(root, 'devices.json'), JSON.stringify({ version: 1, devices: [], pairings: [] }), { mode: 0o644 });
  await assert.rejects(startWebServer(options), /0600/);
  await chmod(join(root, 'devices.json'), 0o600);
  const uid = process.getuid!();
  t.mock.method(process as NodeJS.Process & { getuid: () => number }, 'getuid', () => uid + 123);
  await assert.rejects(startWebServer(options), /owner|0700/);
});

test('startup rejects Funnel, inspection failures, wildcard identities, and non-HTTPS production origins', async t => {
  const root = await mkdtemp('/tmp/pi-web-policy-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { origin: ORIGIN, allowedLogins: [LOGIN], stateDir: root, checkTailscale: async () => {} };
  await assert.rejects(startWebServer({ ...base, allowedLogins: [] }), /allowlist/);
  await assert.rejects(startWebServer({ ...base, allowedLogins: ['*@isara.io'] }), /allowlist/);
  for (const origin of ['http://localhost', 'http://phone.example.ts.net', `${ORIGIN}/`, `${ORIGIN}/path`, 'https://user:secret@phone.example.ts.net']) await assert.rejects(startWebServer({ ...base, origin }), /HTTPS origin/);
  await assert.rejects(startWebServer({ ...base, checkTailscale: async () => { throw new Error('inspection failed'); } }), /inspection failed/);
  await assert.rejects(startWebServer({ ...base, checkTailscale: async () => assertNoFunnel({ AllowFunnel: { [`${HOST}:443`]: true } }, 443) }), /Funnel/);
  await assert.rejects(lstat(join(root, 'web.sock')), { code: 'ENOENT' });
  const local = await startWebServer({ ...base, origin: 'http://localhost:12345', allowHttpLocalhostForTests: true });
  await local.close();
});

test('Funnel inspection includes foreground configs and rejects malformed/ambiguous status', () => {
  assertNoFunnel({}, 443);
  assertNoFunnel({ AllowFunnel: { 'other.example:8443': true, [`${HOST}:443`]: false } }, 443);
  assert.throws(() => assertNoFunnel({ Foreground: { x: { AllowFunnel: { 'other.example:443': true } } } }, 443), /Funnel/);
  for (const value of [null, [], 'bad', { AllowFunnel: true }, { AllowFunnel: { 'bad-host-port': true } }, { AllowFunnel: { [`${HOST}:443`]: 'true' } }, { Foreground: { x: null } }]) assert.throws(() => assertNoFunnel(value, 443));
});

test('source/release static bundle paths both point at dist/web, not src/web', () => {
  assert.equal(defaultStaticDir('file:///checkout/src/web/server/server.ts'), '/checkout/dist/web/');
  assert.equal(defaultStaticDir('file:///release/dist/web/server/server.js'), '/release/dist/web/');
});

test('CLI pair/list/revoke commands share private state and print a code only for explicit pairing', async t => {
  const root = await mkdtemp('/tmp/pi-web-cli-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => { output.push(String(text)); return true; });
  await serveMain(['pair', '--web-state-dir', root]);
  const code = /Pairing code: ([A-Za-z0-9_-]{32})/.exec(output.join(''))![1];
  const store = new DeviceStore(root);
  const paired = await store.pair(code, 'CLI test', LOGIN);
  assert.ok(paired);
  output.length = 0;
  await serveMain(['devices', '--web-state-dir', root]);
  assert.ok(output.join('').includes('CLI test'));
  assert.ok(!output.join('').includes(paired.token));
  assert.ok(!output.join('').includes(code));
  await serveMain(['revoke', paired.device.id, '--web-state-dir', root]);
  assert.equal((await store.list()).length, 0);
  await assert.rejects(serveMain(['--listen', '0.0.0.0:3000']), /Unknown serve option/);
});
