import assert from 'node:assert/strict';
import { webRequest } from './http.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startWebServer } from '../../src/web/server/server.js';

const ORIGIN = 'https://presentation.example.ts.net';
const LOGIN = 'rowan@example.com';

// Contract: only paired, identity-checked devices receive code from the server's
// configured extension files, bound to the exact config generation. Regressions
// include unauthenticated code disclosure, stale-hash substitution, and serving
// old code after a failed build. Provider unit tests do not own HTTP authorization.
test('server config and hash-bound JavaScript routes require pairing, identity, and trusted Host/Origin', async t => {
  const root = await mkdtemp('/tmp/pi-presentation-route-');
  const configPath = join(root, 'config.json');
  const extension = join(root, 'extension.ts');
  const marker = join(root, 'build-marker');
  let daemonOpens = 0;
  await writeFile(configPath, JSON.stringify({ theme: 'light/dark', bell: false, extensions: ['./extension.ts'], host: 'PRIVATE_HOST', cwd: '/PRIVATE_CWD' }));
  await writeFile(extension, `import { appendFileSync } from 'node:fs'; export default function(pi) {
    appendFileSync(${JSON.stringify(marker)}, 'built');
    pi.on("session_start", () => { console.log("FIRST_RENDERER"); });
  }`);
  const server = await startWebServer({
    origin: ORIGIN, allowedLogins: [LOGIN], stateDir: join(root, 'state'), uiConfig: configPath,
    checkTailscale: async () => {},
    openDaemon: async () => { daemonOpens++; throw new Error('HTTP presentation must not open a daemon'); },
  });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    webRequest(server.socketPath, path, { method, headers: {
      Host: 'localhost', 'X-Forwarded-Host': new URL(ORIGIN).host, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': LOGIN, ...headers,
    } });
  assert.equal((await get('/api/config', { 'Tailscale-User-Login': '' })).status, 403);
  assert.equal((await get('/api/config')).status, 401);
  assert.equal((await get('/api/presentation.js?v=anything')).status, 401);
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'No extension setup may run before identity and device pairing');
  const code = await server.devices.issuePairingCode();
  const paired = await server.devices.pair(code.code, 'Presentation test phone', LOGIN);
  assert.ok(paired);
  const auth = { Cookie: `__Host-pi-remote-device=${paired.token}` };
  const configResult = await get('/api/config', auth);
  assert.equal(configResult.status, 200, configResult.body);
  const config = JSON.parse(configResult.body);
  const hash = config.presentation.hash;
  assert.equal(await readFile(marker, 'utf8'), 'built');
  for (const name of ['dark', 'light']) assert.ok(config.files[join(config.home, '.pi', 'agent', 'themes', `${name}.json`)]);
  assert.equal(configResult.headers['cache-control'], 'no-store');
  assert.deepEqual(config.presentation.extensions, [extension]);
  assert.deepEqual(JSON.parse(config.files[join(config.home, '.config', 'pi-remote', 'config.json')]), { theme: 'light/dark', bell: false });
  assert.doesNotMatch(configResult.body, /PRIVATE_HOST|PRIVATE_CWD|FIRST_RENDERER/);
  for (const headers of [
    { Host: 'evil.example' }, { 'X-Forwarded-Host': 'evil.example' }, { 'X-Forwarded-Proto': 'http' },
    { Origin: 'https://evil.example' }, { 'Tailscale-User-Login': 'someone-else@example.com' }, { 'Tailscale-User-Login': '' },
  ]) assert.equal((await get(`/api/presentation.js?v=${hash}`, { ...auth, ...headers })).status, 403);
  const bundle = await get(`/api/presentation.js?v=${hash}`, auth);
  assert.equal(bundle.status, 200);
  assert.match(bundle.body, /FIRST_RENDERER/);
  assert.equal(bundle.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(bundle.headers['content-length'], String(Buffer.byteLength(bundle.body)));
  assert.equal(config.presentation.bundleBytes, Buffer.byteLength(bundle.body));
  assert.equal(bundle.headers['cache-control'], 'no-store');
  assert.equal(bundle.headers['x-content-type-options'], 'nosniff');
  assert.match(bundle.headers['content-security-policy']!, /script-src 'self';/);
  assert.doesNotMatch(bundle.headers['content-security-policy']!, /unsafe-eval|script-src[^;]*unsafe-inline/);
  for (const path of ['/api/presentation.js', '/api/presentation.js?v=stale', `/api/presentation.js?v=${hash}&v=${hash}`]) assert.equal((await get(path, auth)).status, 404);
  assert.equal((await get(`/api/presentation.js?v=${hash}`, auth, 'HEAD')).status, 405);
  assert.equal((await get(`/api/presentation.js?v=${hash}`, { ...auth, Origin: ORIGIN }, 'POST')).status, 405);

  await writeFile(extension, 'export default function(pi) { pi.on("session_start", () => { console.log("REPLACED_RENDERER"); }); }');
  assert.equal((await get(`/api/presentation.js?v=${hash}`, auth)).status, 404);
  const updatedConfig = JSON.parse((await get('/api/config', auth)).body);
  assert.notEqual(updatedConfig.presentation.hash, hash);
  const updated = await get(`/api/presentation.js?v=${updatedConfig.presentation.hash}`, auth);
  assert.match(updated.body, /REPLACED_RENDERER/);
  assert.doesNotMatch(updated.body, /FIRST_RENDERER/);

  const diagnostics = t.mock.method(console, 'error', () => {});
  await writeFile(extension, 'export default invalid syntax PRIVATE_SOURCE');
  const failedConfig = await get('/api/config', auth);
  assert.equal(failedConfig.status, 200, 'Optional renderers cannot block the app');
  const fallback = JSON.parse(failedConfig.body);
  assert.equal(fallback.presentation, undefined, 'Never advertise stale renderer code');
  assert.match(fallback.presentationError, /built-in display.*server logs/);
  assert.deepEqual(JSON.parse(fallback.files[join(fallback.home, '.config', 'pi-remote', 'config.json')]), { theme: 'light/dark', bell: false });
  assert.doesNotMatch(failedConfig.body, /PRIVATE_SOURCE|extension\.ts/);
  assert.ok(diagnostics.mock.calls.some(call => call.arguments.some(value => String(value).includes('extension.ts'))), 'Build diagnostics go to the local service log');
  const failedBundle = await get(`/api/presentation.js?v=${updatedConfig.presentation.hash}`, auth);
  assert.equal(failedBundle.status, 500);
  assert.deepEqual(JSON.parse(failedBundle.body), { error: 'Web server request failed' });
  assert.doesNotMatch(failedBundle.body, /PRIVATE_SOURCE|extension\.ts/);
  // Removing the configured extension recovers immediately, without a server restart.
  await writeFile(configPath, JSON.stringify({ theme: 'dark', extensions: [] }));
  const cleared = JSON.parse((await get('/api/config', auth)).body);
  assert.equal(cleared.presentation, undefined);
  assert.equal((await get(`/api/presentation.js?v=${updatedConfig.presentation.hash}`, auth)).status, 404);
  assert.equal(daemonOpens, 0);
});
