import assert from 'node:assert/strict';
import { webRequest } from './http.js';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startWebServer } from '../../src/web/server/server.js';

const ORIGIN = 'https://presentation.example.ts.net';
const LOGIN = 'rowan@example.com';

// Contract: only paired, identity-checked devices receive code from the server's
// configured extension files, bound to the exact config generation. Regressions
// include unauthenticated code disclosure, stale-hash substitution, and serving
// old code after a failed build. Provider unit tests do not own HTTP authorization.
test('the browser config route requires pairing and identity, and shares only theme files and safe settings', async t => {
  const root = await mkdtemp(join(await realpath('/tmp'), 'pi-config-route-'));
  const configPath = join(root, 'config.json');
  let daemonOpens = 0;
  await writeFile(configPath, JSON.stringify({ theme: 'light/dark', bell: false, extensions: ['./extension.ts'], host: 'PRIVATE_HOST', cwd: '/PRIVATE_CWD' }));
  const server = await startWebServer({
    origin: ORIGIN, allowedLogins: [LOGIN], stateDir: join(root, 'state'), uiConfig: configPath,
    checkTailscale: async () => {},
    openDaemon: async () => { daemonOpens++; throw new Error('The config route must not open a daemon'); },
  });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    webRequest(server.socketPath, path, { method, headers: {
      Host: 'localhost', 'X-Forwarded-Host': new URL(ORIGIN).host, 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': LOGIN, ...headers,
    } });
  assert.equal((await get('/api/config', { 'Tailscale-User-Login': '' })).status, 403);
  assert.equal((await get('/api/config')).status, 401);
  const code = await server.devices.issuePairingCode();
  const paired = await server.devices.pair(code.code, 'Config test phone', LOGIN);
  assert.ok(paired);
  const auth = { Cookie: `__Host-pi-remote-device=${paired.token}` };
  const configResult = await get('/api/config', auth);
  assert.equal(configResult.status, 200, configResult.body);
  const config = JSON.parse(configResult.body);
  for (const name of ['dark', 'light']) assert.ok(config.files[join(config.home, '.pi', 'agent', 'themes', `${name}.json`)]);
  assert.equal(configResult.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(config).sort(), ['files', 'home']);
  assert.deepEqual(JSON.parse(config.files[join(config.home, '.config', 'pi-remote', 'config.json')]), { theme: 'light/dark', bell: false });
  assert.doesNotMatch(configResult.body, /PRIVATE_HOST|PRIVATE_CWD|extension\.ts/);
  for (const headers of [
    { Host: 'evil.example' }, { 'X-Forwarded-Host': 'evil.example' }, { 'X-Forwarded-Proto': 'http' },
    { Origin: 'https://evil.example' }, { 'Tailscale-User-Login': 'someone-else@example.com' },
  ]) assert.equal((await get('/api/config', { ...auth, ...headers })).status, 403);
  // The removed presentation bundle route no longer exists.
  assert.equal((await get('/api/presentation.js?v=anything', auth)).status, 404);
  assert.equal(daemonOpens, 0);
});
