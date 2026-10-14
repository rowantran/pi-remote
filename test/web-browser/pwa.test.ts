import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { buildWeb } from '../../scripts/build-web.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://remote.example';
const slotId = '24c18191-7909-42ab-aefc-14e16adcf33c';
const shell = ['/', '/app.js', '/app.css', '/xterm.css', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
const worker = await readFile(join(root, 'src/web/sw.js'), 'utf8');
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function harness() {
  const listeners = new Map<string, (event: any) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const notifications: { title: string; options: Record<string, any> }[] = [];
  const fetches: { url: string; method: string }[] = [];
  const opened: string[] = [], deleted: string[] = [];
  const state = {
    claimed: 0, skipped: 0, closed: 0, cacheFailure: false, failRenotify: false,
    windows: [] as any[],
    network: async (request: Request | string): Promise<Response> => new Response(`online:${new URL(typeof request === 'string' ? request : request.url).pathname}`),
  };
  const cacheStorage = {
    keys: async () => [...stores.keys()],
    delete: async (key: string) => { deleted.push(key); return stores.delete(key); },
    open: async (key: string) => {
      if (state.cacheFailure) throw new Error('cache storage unavailable');
      if (!stores.has(key)) stores.set(key, new Map());
      const store = stores.get(key)!;
      return {
        put: async (request: string, response: Response) => { store.set(request, response.clone()); },
        match: async (request: string) => store.get(request)?.clone(),
      };
    },
  };
  const scope = {
    location: { origin },
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    skipWaiting: async () => { state.skipped++; },
    clients: {
      claim: async () => { state.claimed++; }, matchAll: async () => state.windows,
      openWindow: async (url: string) => { opened.push(url); return null; },
    },
    registration: { showNotification: async (title: string, options: Record<string, any>) => {
      notifications.push({ title, options: plain(options) });
      if (state.failRenotify && options.renotify) throw new TypeError('renotify unsupported');
    } },
  };
  runInNewContext(worker.replaceAll('__BUILD_ID__', 'test-build'), {
    self: scope, URL, caches: cacheStorage,
    fetch: async (request: Request | string) => {
      fetches.push({ url: typeof request === 'string' ? request : request.url, method: typeof request === 'string' ? 'GET' : request.method });
      return state.network(request);
    },
  }, { filename: 'sw.js' });
  const dispatch = async (name: string, payload: Record<string, any> = {}) => {
    const promises: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners.get(name)!({ ...payload,
      waitUntil: (promise: Promise<unknown>) => promises.push(Promise.resolve(promise)),
      respondWith: (promise: Promise<Response>) => { response = Promise.resolve(promise); },
    });
    await Promise.all(promises);
    return response ? await response : undefined;
  };
  return {
    state, stores, notifications, fetches, opened, deleted,
    install: () => dispatch('install'), activate: () => dispatch('activate'),
    request: (path: string, options?: RequestInit) => dispatch('fetch', { request: new Request(new URL(path, origin), options) }),
    push: (value?: unknown) => dispatch('push', { data: value === undefined ? undefined : { json: () => value } }),
    malformedPush: () => dispatch('push', { data: { json: () => { throw new SyntaxError('not JSON'); } } }),
    click: (data: unknown) => dispatch('notificationclick', { notification: { data, close: () => { state.closed++; } } }),
  };
}
function client(url: string, fail = false) {
  return { url, focused: 0, navigated: [] as string[],
    async focus() { this.focused++; if (fail) throw new Error('window closed'); return this; },
    async navigate(target: string) { this.navigated.push(target); if (fail) throw new Error('window closed'); this.url = target; return this; },
  };
}
const payload = (extra: Record<string, unknown> = {}) => ({ version: 1, id: 'notification-id', slotId, kind: 'done', ...extra });

test('service worker installs only the fixed shell and removes only its own old caches', async () => {
  const h = harness();
  await h.install();
  assert.equal(h.state.skipped, 1);
  assert.deepEqual(h.fetches.map(item => new URL(item.url).pathname).sort(), [...shell].sort());
  assert.deepEqual([...h.stores.get('pi-remote-shell-test-build')!.keys()].sort(), [...shell].sort());
  h.stores.set('pi-remote-shell-old', new Map()); h.stores.set('another-app-cache', new Map());
  await h.activate();
  assert.deepEqual(h.deleted, ['pi-remote-shell-old']);
  assert.ok(h.stores.has('another-app-cache')); assert.ok(h.stores.has('pi-remote-shell-test-build'));
  assert.equal(h.state.claimed, 1); assert.deepEqual(h.opened, []);
});

test('only rejected network fetches use the cached shell; online authorization failures stay failures', async () => {
  const h = harness(); await h.install();
  h.state.network = async () => new Response('fresh shell');
  assert.equal(await (await h.request('/app.js'))!.text(), 'fresh shell');
  for (const status of [401, 403, 404, 500]) {
    h.state.network = async () => new Response(`online:${status}`, { status });
    const response = (await h.request('/app.js'))!;
    assert.equal(response.status, status); assert.equal(await response.text(), `online:${status}`);
  }
  h.state.network = async () => { throw new Error('offline'); };
  assert.equal(await (await h.request('/app.js'))!.text(), 'fresh shell');
  assert.equal(await (await h.request('/'))!.text(), 'online:/');
  const empty = harness(); empty.state.network = h.state.network;
  await assert.rejects(empty.request('/'), /offline/);
});

test('API, pairing, transcripts, WebSockets, cross-origin, query, range, and non-GET requests bypass the worker', async () => {
  const h = harness(); await h.install(); h.fetches.length = 0;
  for (const [path, options] of [
    ['/api/config', undefined], ['/api/status', undefined], ['/api/presentation.js', undefined], ['/api/presentation.js?v=HASH', undefined],
    ['/api/pair', { method: 'POST', body: 'SECRET_PAIR_CODE' }],
    ['/api/push/subscribe', { method: 'POST', body: 'SECRET_SUBSCRIPTION' }], ['/session/transcript.json', undefined],
    ['/ws', undefined], ['wss://remote.example/ws', undefined], ['/sw.js', undefined],
    ['/app.js?token=SECRET_TOKEN', undefined], ['/?pair=SECRET_PAIR_CODE', undefined],
    ['https://foreign.example/app.js', undefined], ['/', { method: 'POST', body: 'SECRET_PAIR_BODY' }],
    ['/app.js', { headers: { Range: 'bytes=0-20' } }],
  ] as [string, RequestInit | undefined][]) assert.equal(await h.request(path, options), undefined, path);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual([...h.stores.get('pi-remote-shell-test-build')!.keys()].sort(), [...shell].sort());
});

test('failed/redirected/partial shell responses are never cached and storage failures do not hide online responses', async () => {
  const h = harness();
  h.state.network = async request => {
    const path = new URL(typeof request === 'string' ? request : request.url).pathname;
    if (path === '/') return new Response('UNAUTHORIZED', { status: 401 });
    if (path === '/app.js') return new Response('PARTIAL', { status: 206 });
    const redirected = new Response('SECRET_API_BODY');
    Object.defineProperties(redirected, { redirected: { value: true }, url: { value: `${origin}/api/config` } });
    return redirected;
  };
  await h.install(); assert.equal([...h.stores.values()].reduce((count, store) => count + store.size, 0), 0);
  h.state.network = async () => new Response('network success'); h.state.cacheFailure = true;
  assert.equal(await (await h.request('/'))!.text(), 'network success');
  h.state.network = async () => { throw new Error('actual network failure'); };
  await assert.rejects(h.request('/'), /actual network failure/);
});

test('each valid push shows a visible fixed-title notification containing only the bounded session label and kind', async () => {
  const h = harness();
  for (const kind of ['done', 'blocked', 'error']) {
    await h.push(payload({ kind, slotNumber: 7, sessionName: '  work\n\0\x1b\u202e session  ',
      title: 'UNTRUSTED_TITLE', body: 'SECRET_TRANSCRIPT', url: 'https://attacker.example/UNTRUSTED_URL', silent: true }));
    const { title, options } = h.notifications.at(-1)!;
    assert.equal(title, 'Pi Remote');
    assert.equal(options.body, `Session 7 · work session · ${kind[0].toUpperCase()}${kind.slice(1)}`);
    assert.equal(options.icon, '/icon-192.png');
    assert.equal(options.tag, `pi-remote-slot-${slotId}`); assert.equal(options.renotify, true);
    assert.notEqual(options.silent, true); assert.deepEqual(options.data, { slotId });
    assert.doesNotMatch(JSON.stringify(options), /SECRET_TRANSCRIPT|UNTRUSTED_URL|UNTRUSTED_TITLE/);
  }
  await h.push(payload({ sessionName: '😀'.repeat(100) }));
  assert.equal(h.notifications.at(-1)!.options.body, `Session · ${'😀'.repeat(80)} · Done`);
  assert.equal(h.notifications.length, 4); assert.deepEqual(h.fetches, []);
});

test('malformed and empty push payloads still request a generic visible notification whose click opens the root', async () => {
  const malformed = [undefined, null, [], 'text', payload({ version: 2 }), payload({ id: 1 }), payload({ id: '' }),
    payload({ kind: 'other' }), payload({ slotId: '//attacker.example' }), payload({ slotId: `${slotId}?url=evil` }),
    payload({ slotNumber: 1.5 }), payload({ sessionName: { text: 'SECRET' } })];
  for (const value of malformed) {
    const h = harness(); await h.push(value);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].title, 'Pi Remote'); assert.equal(h.notifications[0].options.body, 'Session update');
    await h.click(h.notifications[0].options.data);
    assert.deepEqual(h.opened, [`${origin}/`]);
  }
  const h = harness(); await h.malformedPush();
  assert.equal(h.notifications.length, 1); assert.equal(h.notifications[0].options.body, 'Session update');
});

test('unsupported renotify gets a second visible-notification request without that option', async () => {
  const h = harness(); h.state.failRenotify = true;
  await h.push(payload()); assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[0].options.renotify, true); assert.equal(h.notifications[1].options.renotify, undefined);
  assert.equal(h.notifications[1].title, 'Pi Remote'); assert.equal(h.notifications[1].options.body, 'Session · Done');
});

test('notification clicks navigate/focus only same-origin app windows using a trusted UUID route', async () => {
  const h = harness();
  const foreign = client('https://attacker.example/');
  const exportPage = client(`${origin}/api/export`);
  const app = client(`${origin}/#slot=old-slot`);
  h.state.windows = [foreign, exportPage, app];
  await h.click({ slotId: slotId.toUpperCase(), url: 'https://attacker.example/ignored' });
  assert.equal(h.state.closed, 1); assert.equal(app.focused, 1);
  assert.deepEqual(app.navigated, [`${origin}/#slot=${slotId}`]);
  assert.deepEqual(foreign.navigated, []); assert.deepEqual(exportPage.navigated, []); assert.deepEqual(h.opened, []);
  await h.click({ slotId }); assert.equal(app.focused, 2); assert.equal(app.navigated.length, 1);
});

test('closed windows fall back to opening the trusted route and forged notification URLs cannot escape the origin', async () => {
  const h = harness(); h.state.windows = [client(`${origin}/`, true)];
  await h.click({ slotId, url: 'javascript:alert(1)' });
  assert.deepEqual(h.opened, [`${origin}/#slot=${slotId}`]);
  for (const data of [{ url: 'https://attacker.example/' }, { slotId: '//attacker.example/' }, { slotId: `${slotId}/../api/pair` }, null]) {
    h.state.windows = []; await h.click(data);
    assert.equal(h.opened.at(-1), `${origin}/`);
  }
});

test('the standalone manifest and opaque PNG icons have fixed same-origin install paths', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'src/web/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.id, '/'); assert.equal(manifest.start_url, '/'); assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.name, 'Pi Remote');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((entry: any) => entry.sizes === `${size}x${size}`);
    assert.equal(icon.src, `/icon-${size}.png`); assert.equal(icon.type, 'image/png');
    const png = await readFile(join(root, 'src/web', `icon-${size}.png`));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 2, 'Apple touch icons use opaque RGB PNGs');
  }
});

test('browser builds copy PWA assets and embed a deterministic content version that changes with app bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-pwa-build-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'entry.ts'); await writeFile(entry, "console.log('version one');\n");
  const buildId = async (name: string) => {
    const outdir = join(dir, name); await buildWeb({ entry, outdir });
    const sw = await readFile(join(outdir, 'sw.js'), 'utf8'); assert.ok(!sw.includes('__BUILD_ID__'));
    const id = /const BUILD_ID = '([a-f0-9]{64})'/.exec(sw)?.[1]; assert.ok(id);
    for (const file of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
      assert.deepEqual(await readFile(join(outdir, file)), await readFile(join(root, 'src/web', file)));
    }
    return id;
  };
  const first = await buildId('first'), second = await buildId('second'); assert.equal(first, second);
  await writeFile(entry, "console.log('version two');\n"); assert.notEqual(await buildId('third'), first);
});
