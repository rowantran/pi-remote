/* Fixed app shell and visible push notifications only. No session data or background socket. */
const BUILD_ID = '__BUILD_ID__';
const CACHE_PREFIX = 'pi-remote-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const SHELL_ASSETS = new Set([
  '/', '/app.js', '/app.css', '/xterm.css', '/icon.svg',
  '/icon-192.png', '/icon-512.png', '/manifest.webmanifest',
]);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function shellURL(request) {
  if (request.method !== 'GET' || request.headers.has('range')) return undefined;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || !SHELL_ASSETS.has(url.pathname)) return undefined;
  return url;
}

function cacheable(response, url) {
  // A redirect could return an API or pairing body under an otherwise safe shell pathname.
  return response.ok && response.status === 200 && !response.redirected
    && (!response.url || response.url === url.href);
}

async function remember(url, response) {
  if (!cacheable(response, url)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url.pathname, response.clone());
  } catch {
    // Storage failure must not turn a successful online response into an offline response.
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await Promise.allSettled([...SHELL_ASSETS].map(async path => {
      const url = new URL(path, self.location.origin);
      const response = await fetch(url.href, { cache: 'reload', credentials: 'same-origin' });
      await remember(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function networkFirst(request, url) {
  let response;
  try {
    response = await fetch(request, { cache: 'no-store' });
  } catch (error) {
    // Only a rejected fetch is offline. An online 401/403/404/500 is always returned unchanged.
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
    } catch { /* If storage is unavailable, preserve the original network error. */ }
    throw error;
  }
  await remember(url, response);
  return response;
}

self.addEventListener('fetch', event => {
  const url = shellURL(event.request);
  if (url) event.respondWith(networkFirst(event.request, url));
});

function pushRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 256
    || typeof value.slotId !== 'string' || !UUID.test(value.slotId)
    || !['done', 'blocked', 'error'].includes(value.kind)
    || (value.slotNumber !== undefined && (!Number.isSafeInteger(value.slotNumber) || value.slotNumber < 1))
    || (value.sessionName !== undefined && typeof value.sessionName !== 'string')) return undefined;
  const name = Array.from((value.sessionName ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
  return { slotId: value.slotId.toLowerCase(), slotNumber: value.slotNumber, name, kind: value.kind };
}

async function showPush(record) {
  const label = record ? `Session${record.slotNumber ? ` ${record.slotNumber}` : ''}${record.name ? ` · ${record.name}` : ''}` : '';
  const kind = record && { done: 'Done', blocked: 'Blocked', error: 'Error' }[record.kind];
  const options = {
    body: record ? `${label} · ${kind}` : 'Session update',
    icon: '/icon-192.png',
    tag: record ? `pi-remote-slot-${record.slotId}` : 'pi-remote-update',
    renotify: true,
    data: record ? { slotId: record.slotId } : {},
  };
  try {
    await self.registration.showNotification('Pi Remote', options);
  } catch {
    // Some platforms do not support renotify. Still request a visible notification.
    const { renotify, ...fallback } = options;
    await self.registration.showNotification('Pi Remote', fallback);
  }
}

self.addEventListener('push', event => {
  let record;
  try { record = pushRecord(event.data?.json()); } catch { /* Malformed payloads still notify. */ }
  event.waitUntil(showPush(record));
});

function notificationTarget(data) {
  const target = new URL('/', self.location.origin);
  if (typeof data?.slotId === 'string' && UUID.test(data.slotId)) target.hash = `slot=${data.slotId.toLowerCase()}`;
  return target;
}

async function openNotification(data) {
  const target = notificationTarget(data);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    let url;
    try { url = new URL(client.url); } catch { continue; }
    // Do not repurpose other same-origin documents, such as a downloaded session export.
    if (url.origin !== target.origin || url.pathname !== '/' || url.search) continue;
    try {
      if (url.href === target.href) { await client.focus(); return; }
      if (typeof client.navigate !== 'function') continue;
      const navigated = await client.navigate(target.href);
      if (navigated) { await navigated.focus(); return; }
    } catch { /* A closed or unfocusable window must not prevent opening the app. */ }
  }
  await self.clients.openWindow(target.href);
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(openNotification(event.notification.data));
});
