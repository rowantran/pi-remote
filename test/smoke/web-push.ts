/** Real Chromium service-worker events and notification registration, not external Web Push/APNs. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { buildWeb } from '../../src/web/build/app.js';

const dir = await mkdtemp(join(tmpdir(), 'remote-push-browser-'));
const outdir = join(dir, 'web'), entry = join(dir, 'entry.ts');
await writeFile(entry, `
navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  .then(() => navigator.serviceWorker.ready).then(() => { window.__workerReady = true; });
`);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const status = new Map<string, number>();
const files: Record<string, string> = {
  '/': 'index.html', '/sw.js': 'sw.js', '/app.js': 'app.js', '/app.css': 'app.css', '/xterm.css': 'xterm.css',
  '/icon.svg': 'icon.svg', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/manifest.webmanifest': 'manifest.webmanifest',
};
const server = createServer((request, response) => {
  void (async () => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url?.startsWith('/api/')) { response.end('SECRET_API_OR_PAIR_BODY'); return; }
    const name = files[request.url ?? ''];
    if (!name) { response.writeHead(404).end(); return; }
    if (status.has(request.url!)) { response.writeHead(status.get(request.url!)!).end('online authorization failure'); return; }
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css'
      : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.png') ? 'image/png'
        : name.endsWith('.svg') ? 'image/svg+xml' : 'application/manifest+json');
    response.end(await readFile(join(outdir, name)));
  })().catch(error => { response.writeHead(500).end(String(error)); });
});
try {
  await buildWeb({ entry, outdir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let executablePath = chromium.executablePath();
  if (!existsSync(executablePath)) {
    const cache = join(homedir(), '.cache/ms-playwright');
    for (const version of (await readdir(cache).catch(() => [])).filter(name => /^chromium-/.test(name)).sort().reverse()) {
      for (const platform of ['chrome-linux64', 'chrome-linux']) {
        const candidate = join(cache, version, platform, 'chrome');
        if (existsSync(candidate)) { executablePath = candidate; break; }
      }
      if (existsSync(executablePath)) break;
    }
  }
  if (!existsSync(executablePath)) throw new Error('Install Playwright Chromium before running test/smoke/web-push.ts');
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  await context.grantPermissions(['notifications'], { origin });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const cdp = await context.newCDPSession(page);
  const registrations = new Map<string, { registrationId: string; scopeURL: string; isDeleted: boolean }>();
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: updated }) => {
    for (const registration of updated) registrations.set(registration.registrationId, registration);
  });
  cdp.on('ServiceWorker.workerErrorReported', ({ errorMessage }) => errors.push(errorMessage.errorMessage));
  await cdp.send('ServiceWorker.enable');
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).__workerReady && navigator.serviceWorker.controller, undefined, { timeout: 20_000 });
  const registration = [...registrations.values()].find(value => value.scopeURL === `${origin}/` && !value.isDeleted);
  assert.ok(registration, 'CDP did not report the real service worker registration');

  const cachedPaths = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith('pi-remote-shell-'));
    const cache = await caches.open(names[0]);
    return (await cache.keys()).map(request => new URL(request.url).pathname).sort();
  });
  assert.deepEqual(cachedPaths, ['/', '/app.css', '/app.js', '/icon-192.png', '/icon-512.png', '/icon.svg', '/manifest.webmanifest', '/xterm.css'].sort());
  const pathsAfterPrivateRequests = await page.evaluate(async () => {
    await fetch('/api/secret'); await fetch('/api/pair', { method: 'POST', body: 'SECRET_PAIRING_CODE' });
    const names = (await caches.keys()).filter(name => name.startsWith('pi-remote-shell-'));
    return (await (await caches.open(names[0])).keys()).map(request => new URL(request.url).pathname).sort();
  });
  assert.deepEqual(pathsAfterPrivateRequests, cachedPaths);
  for (const code of [401, 403]) {
    status.set('/app.css', code);
    assert.equal(await page.evaluate(async () => (await fetch('/app.css')).status), code);
  }
  status.clear();
  await context.setOffline(true);
  assert.deepEqual(await page.evaluate(async () => {
    const shell = await fetch('/app.css');
    let apiFailed = false;
    try { await fetch('/api/secret'); } catch { apiFailed = true; }
    return { shell: shell.status, apiFailed };
  }), { shell: 200, apiFailed: true });
  await context.setOffline(false);

  const notificationsWithBody = (body: string) => page.evaluate(async expected => {
    const registration = await navigator.serviceWorker.ready;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const visible = (await registration.getNotifications()).map(notification => ({ title: notification.title, body: notification.body, tag: notification.tag, data: notification.data }));
      if (visible.some(notification => notification.body === expected)) return visible;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`The real service worker did not register a notification: ${expected}`);
  }, body);
  const slotId = '24c18191-7909-42ab-aefc-14e16adcf33c';
  for (const [kind, word] of [['done', 'Done'], ['blocked', 'Blocked'], ['error', 'Error']] as const) {
    const data = { version: 1, id: `smoke-${kind}`, slotId, slotNumber: 7, sessionName: 'Browser smoke', kind,
      body: 'MUST_NOT_APPEAR', url: 'https://attacker.example/MUST_NOT_APPEAR' };
    await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: registration.registrationId, data: JSON.stringify(data) });
    const expectedBody = `Session 7 · Browser smoke · ${word}`;
    const visible = await notificationsWithBody(expectedBody);
    assert.ok(visible.some(notification => notification.title === 'Pi Remote' && notification.body === expectedBody
      && notification.tag === `pi-remote-slot-${slotId}` && notification.data.slotId === slotId), JSON.stringify(visible));
    assert.doesNotMatch(JSON.stringify(visible), /MUST_NOT_APPEAR/);
    console.log(`Chromium CDP push → registered notification: ${kind}`);
  }
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: registration.registrationId, data: '{not-json' });
  const generic = await notificationsWithBody('Session update');
  assert.ok(generic.some(notification => notification.body === 'Session update' && notification.data.slotId === undefined));
  assert.deepEqual(errors, []);
  await page.evaluate(async () => { for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) notification.close(); });
  console.log('Chromium shell cache: offline shell only; online 401/403 preserved; API/pair bodies not cached.');
  console.log('PASS: real Chromium service worker and CDP push injection. This does not test external Web Push, APNs, or iOS Home Screen delivery.');
} finally {
  await browser?.close();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
