import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices, type Page } from 'playwright';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { Connection, handshake } from '../../src/client/connection.js';
import { socketPath } from '../../src/protocol/paths.js';
import type { RemoteEvent } from '../../src/protocol/types.js';
import { startWebServer } from '../../src/web-server/server.js';
import { PushService } from '../../src/web-server/push.js';
import { startActivityMonitor, type ActivityMonitor } from '../../src/web-server/activity-monitor.js';
import { testProxy } from '../web-browser/proxy.js';

/** Real browser → TLS test proxy → web Unix socket → isolated daemon → deterministic Pi child.
 * No credentials, live daemon, Tailscale configuration, or real model calls are involved. */
const dir = await mkdtemp('/tmp/pi-phone-smoke-');
const stateDir = join(dir, 'daemon');
const webState = join(dir, 'web');
const commandsLog = join(dir, 'commands.jsonl');
const daemon = new Supervisor({ stateDir, executable: process.execPath, skipVersionCheck: true,
  prefixArgs: [fileURLToPath(new URL('../fixtures/fixture-pi.mjs', import.meta.url))],
  env: { PI_FIXTURE_COMMANDS_LOG: commandsLog, PI_OFFLINE: '1' } });
const connect = async () => { const socket = createConnection(socketPath(stateDir)); await once(socket, 'connect'); return socket; };
let control: Connection | undefined;
let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
let proxy: Awaited<ReturnType<typeof testProxy>> | undefined;
let push: PushService | undefined;
let monitor: ActivityMonitor | undefined;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function barrier(promise: Promise<void>, description: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 20_000); })]);
  } finally { clearTimeout(timer); }
}
let daemonGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
const deliveries = new EventEmitter();
interface CapturedPush { endpoint: string; payload: Record<string, unknown> }
const sent: CapturedPush[] = [];
function pushed(endpoint: string, kind: string, after = sent.length): Promise<CapturedPush> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = sent.slice(after).find(value => value.endpoint === endpoint && value.payload.kind === kind);
      if (found) { clearTimeout(timer); deliveries.off('sent', check); resolve(found); }
    };
    const timer = setTimeout(() => { deliveries.off('sent', check); reject(new Error(`No automatic ${kind} push from daemon activity`)); }, 15_000);
    deliveries.on('sent', check); check();
  });
}

/** Poll committed read transactions, not an async waitForFunction predicate (a Promise is truthy). */
async function cached(page: Page, slotId: string, text?: string) {
  return page.evaluate(async ({ slotId, text }) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const records = await new Promise<any[]>((resolve, reject) => {
        const open = indexedDB.open('pi-remote-transcripts', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('snapshots')) { db.close(); resolve([]); return; }
          const tx = db.transaction('snapshots', 'readonly');
          const request = tx.objectStore('snapshots').getAll();
          tx.oncomplete = () => { db.close(); resolve(request.result); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
      const record = records.find(value => value.slotId === slotId);
      if (text === undefined ? records.length === 0 : record?.snapshot?.historyComplete === true && JSON.stringify(record.snapshot).includes(text)) return records;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(text === undefined ? 'Saved transcripts were not cleared' : `Transcript was not persisted: ${text}`);
  }, { slotId, text });
}

async function shellReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('This browser runner has no service-worker support');
    await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Service worker did not activate')), 15_000))]);
    const expected = ['/', '/app.js', '/app.css', '/xterm.css', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].sort();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const names = (await caches.keys()).filter(name => name.startsWith('pi-remote-shell-'));
      for (const name of names) {
        const paths = (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname).sort();
        if (navigator.serviceWorker.controller && JSON.stringify(paths) === JSON.stringify(expected)) return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('The controlling service worker did not finish the fixed app-shell cache');
  });
}

function event(connection: Connection, predicate: (event: RemoteEvent) => boolean): Promise<RemoteEvent> {
  return new Promise((resolve, reject) => {
    const off = connection.onEvent(value => { if (predicate(value)) { clearTimeout(timer); off(); resolve(value); } });
    const timer = setTimeout(() => { off(); reject(new Error('Timed out waiting for fixture event')); }, 15_000);
  });
}
try {
  await daemon.start();
  const socket = await connect();
  control = new Connection(socket, socket, () => socket.destroy()); await handshake(control);
  const slot = await control.request('create', { cwd: dir });
  await control.request('attach', { slotId: slot.id });
  const seed = Array.from({ length: 90 }, (_, index) => `History row ${index + 1}: local transcript scrolling`).join('\n');
  const seeded = event(control, value => value.event.type === 'agent_settled');
  await control.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: seed } }); await seeded;

  proxy = await testProxy(join(webState, 'web.sock'));
  web = await startWebServer({ origin: proxy.origin, allowedLogins: ['rowan@example.test'], stateDir: webState,
    daemonStateDir: stateDir, openDaemon: async () => {
      const gate = daemonGate;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      return connect();
    }, checkTailscale: async () => {},
    handleApi: (request, response, context) => push?.handleApi(request, response, context) ?? false,
    staticDir: fileURLToPath(new URL('../../dist/web/', import.meta.url)) });
  push = await PushService.open({ stateDir: webState, origin: proxy.origin, devices: web.devices, allowedLogins: ['rowan@example.test'],
    send: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(String(payload)) }); deliveries.emit('sent');
      return { statusCode: 201, body: '', headers: {} };
    } });
  const monitoring = deferred();
  monitor = startActivityMonitor({
    // Never share the browser gate, attachment, or control connection with the read-only monitor.
    connect: async () => { const socket = await connect(); const connection = new Connection(socket, socket, () => socket.destroy()); await handshake(connection); return connection; },
    onBell: notice => push!.notify(notice),
    onStatus: status => { push!.setMonitorStatus(status); if (status === 'active') monitoring.resolve(); },
  });
  await barrier(monitoring.promise, 'the read-only activity monitor');
  for (const browserType of [chromium, webkit]) {
    // Keep the original long-history assertion visible in each engine. The first
    // engine's new offline/reconnect turns otherwise push the seed out of view.
    if (browserType === webkit) {
      await control.request('rpc', { slotId: slot.id, command: { type: 'new_session' } });
      const seeded = event(control, value => value.event.type === 'agent_settled');
      await control.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: seed } }); await seeded;
    }
    // Chromium's service-worker loader does not inherit the page's self-signed TLS override.
    const browser = await browserType.launch({ headless: true, ...(browserType === chromium ? { args: ['--ignore-certificate-errors'] } : {}) });
    const context = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true, serviceWorkers: 'allow' });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !/401|Failed to load resource/.test(message.text())) console.error(`${browserType.name()}: ${message.text()}`); });
    try {
      const { code } = await web.devices.issuePairingCode();
      await page.goto(proxy.origin);
      await page.locator('#pair-dialog').waitFor({ state: 'visible' });
      await page.locator('#pair-code').fill(code);
      await page.locator('#device-name').fill(`${browserType.name()} mobile smoke`);
      await page.locator('#pair-form button[type=submit]').click();
      await page.locator('#slot-list button').first().waitFor();
      await page.locator('#slot-list button').first().click();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
      await page.locator('.xterm-rows').getByText('local transcript scrolling', { exact: false }).first().waitFor();

      const curve = createECDH('prime256v1'); curve.generateKeys();
      const endpoint = `https://web.push.apple.com/synthetic-${browserType.name()}`;
      const subscription = { endpoint, expirationTime: null, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
      const registered = await page.request.post(`${proxy.origin}/api/push/subscribe`, { headers: { Origin: proxy.origin }, data: { subscription } });
      assert.equal(registered.status(), 200, await registered.text());
      const pushStatus = await page.request.get(`${proxy.origin}/api/push`);
      assert.equal(pushStatus.status(), 200);
      assert.equal((await pushStatus.json()).monitor, 'active');
      assert.equal((await pushStatus.json()).subscribed, true);
      const sessionName = `Mobile\n${browserType.name()} smoke`;
      await control.request('rpc', { slotId: slot.id, command: { type: 'set_session_name', name: sessionName } });
      const assertPush = (delivery: CapturedPush, kind: string) => {
        assert.deepEqual(Object.keys(delivery.payload).sort(), ['version', 'id', 'slotId', 'slotNumber', 'sessionName', 'kind'].sort());
        assert.deepEqual({ ...delivery.payload, id: 'opaque' }, { version: 1, id: 'opaque', slotId: slot.id, slotNumber: slot.number, sessionName: sessionName.replace('\n', ' '), kind });
        assert.equal(typeof delivery.payload.id, 'string');
        assert.doesNotMatch(JSON.stringify(delivery.payload), /History row|Native second line|Native answer|Completed while|Remote update|answer:|\/tmp\/|credentials|transcript|prompt/);
      };

      const prompt = page.locator('#prompt');
      assert.equal(await prompt.getAttribute('autocorrect'), 'on');
      assert.equal(await page.locator('.xterm-helper-textarea').getAttribute('readonly'), '');
      // Native composition must not become terminal keystrokes or an early submission.
      const message = `Phone prompt from ${browserType.name()}\nNative second line 🐈 ${browserType.name()}`;
      await prompt.dispatchEvent('compositionstart');
      await prompt.fill(message);
      assert.equal(await page.locator('#send').isDisabled(), true);
      await prompt.dispatchEvent('compositionend');
      const settled = event(control, value => value.event.type === 'agent_settled');
      const completionPush = pushed(endpoint, 'done');
      await page.locator('#send-mode').selectOption('followUp');
      await page.locator('#send').click();
      await settled;
      assertPush(await completionPush, 'done');
      await page.locator('.xterm-rows').getByText(`Native second line 🐈 ${browserType.name()} complete`, { exact: false }).first().waitFor();
      await page.screenshot({ path: join(dir, `${browserType.name()}-attached.png`) });

      const viewportBefore = await page.locator('.xterm-rows').textContent();
      await page.locator('#terminal').evaluate(target => {
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        // WebKit's desktop runner does not expose a constructible Touch. Exercise the
        // same touch-handler boundary with independent coordinates in both engines.
        const first = { identifier: 1, clientX: x, clientY: rect.top + 35 };
        const last = { identifier: 1, clientX: x, clientY: rect.top + Math.min(rect.height - 20, 260) };
        const start = new Event('touchstart', { bubbles: true, cancelable: true });
        Object.defineProperty(start, 'touches', { value: [first] }); target.dispatchEvent(start);
        const move = new Event('touchmove', { bubbles: true, cancelable: true });
        Object.defineProperty(move, 'touches', { value: [last] }); target.dispatchEvent(move);
        const end = new Event('touchend', { bubbles: true, cancelable: true });
        Object.defineProperty(end, 'touches', { value: [] }); target.dispatchEvent(end);
      });
      await page.waitForFunction(before => document.querySelector('.xterm-rows')?.textContent !== before, viewportBefore);
      await page.locator('[data-key=latest]').click();
      await page.locator('.xterm-rows').getByText(`Native second line 🐈 ${browserType.name()} complete`, { exact: false }).first().waitFor();

      await prompt.fill('/di');
      await page.locator('#completions button').getByText('/dialog', { exact: true }).click();
      assert.equal(await prompt.inputValue(), '/dialog ');
      await prompt.fill('/dialog');
      const questionPush = pushed(endpoint, 'blocked');
      await page.locator('#send').click();
      await page.locator('#action-dialog').waitFor({ state: 'visible' });
      assertPush(await questionPush, 'blocked');
      await page.locator('#dialog-input').fill(`Native answer ${browserType.name()}`);
      const answered = event(control, value => value.event.type === 'remote_dialog_resolved');
      await page.locator('#action-content button').getByText('Submit answer', { exact: true }).click();
      await answered;
      await page.locator('#action-dialog').waitFor({ state: 'hidden' });

      await context.setOffline(true);
      const backgroundMessage = `Completed while phone offline ${browserType.name()}`;
      const finished = event(control, value => value.event.type === 'agent_settled');
      const backgroundPush = pushed(endpoint, 'done');
      await control.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: backgroundMessage } }); await finished;
      assertPush(await backgroundPush, 'done');
      await context.setOffline(false);
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
      await page.locator('.xterm-rows').getByText(`${backgroundMessage} complete`, { exact: false }).first().waitFor();
      const persisted = await cached(page, slot.id, `${backgroundMessage} complete`);
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].slotId, slot.id);
      assert.equal(typeof persisted[0].savedAt, 'number');
      assert.equal(persisted[0].snapshot.historyComplete, true);
      assert.equal(persisted[0].snapshot.ui.some((record: any) => ['input', 'editor', 'confirm', 'select', 'set_editor_text'].includes(record.method)), false);
      const unsent = `Unsent native draft ${browserType.name()}`;
      const reconnectDraft = `${unsent} edited while reconnecting`;
      const offlineDraft = `${unsent} edited while offline`;
      await prompt.fill(unsent);

      // Hold the new browser daemon transport, not time: the saved preview must be
      // observable before the authoritative attach can possibly finish.
      const gate = { entered: deferred(), release: deferred() };
      daemonGate = gate;
      try {
        await page.reload();
        await barrier(gate.entered.promise, 'the gated browser daemon connection');
        await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Saved · reconnecting');
        await page.locator('.xterm-rows').getByText(`${backgroundMessage} complete`, { exact: false }).first().waitFor();
        assert.equal(await prompt.inputValue(), unsent);
        assert.equal(await page.locator('#send').isDisabled(), true);
        assert.equal(await prompt.isEditable(), true);
        await prompt.fill(reconnectDraft);
        assert.equal(await prompt.inputValue(), reconnectDraft);
        assert.equal(await page.locator('#send').isDisabled(), true);
        const authoritative = `Remote update during saved preview ${browserType.name()}`;
        const remoteFinished = event(control, value => value.event.type === 'agent_settled');
        const remotePush = pushed(endpoint, 'done');
        await control.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: authoritative } }); await remoteFinished;
        assertPush(await remotePush, 'done');
        assert.equal(await page.locator('.xterm-rows').getByText(`${authoritative} complete`, { exact: false }).count(), 0);
        await page.screenshot({ path: join(dir, `${browserType.name()}-saved-reconnecting.png`) });
        daemonGate = undefined; gate.release.resolve();
        await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
        await page.locator('.xterm-rows').getByText(`${authoritative} complete`, { exact: false }).first().waitFor();
        assert.equal(await prompt.inputValue(), reconnectDraft);
        assert.equal(await page.locator('#send').isDisabled(), false);
        await cached(page, slot.id, `${authoritative} complete`);
        await shellReady(page);

        // The actual worker supplies only the shell. The application loads the
        // transcript from IndexedDB and cannot send a draft while offline.
        await context.setOffline(true);
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Saved · offline');
        await page.locator('.xterm-rows').getByText(`${authoritative} complete`, { exact: false }).first().waitFor();
        assert.equal(await prompt.inputValue(), reconnectDraft);
        assert.equal(await page.locator('#send').isDisabled(), true);
        assert.equal(await prompt.isEditable(), true);
        await prompt.fill(offlineDraft);
        assert.equal(await prompt.inputValue(), offlineDraft);
        assert.equal(await page.locator('#send').isDisabled(), true);
        await page.screenshot({ path: join(dir, `${browserType.name()}-saved-offline.png`) });

        const offlineWork = `Remote update after offline reload ${browserType.name()}`;
        const offlineFinished = event(control, value => value.event.type === 'agent_settled');
        const offlineCompletionPush = pushed(endpoint, 'done');
        await control.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: offlineWork } }); await offlineFinished;
        assertPush(await offlineCompletionPush, 'done');
        assert.equal(await page.locator('.xterm-rows').getByText(`${offlineWork} complete`, { exact: false }).count(), 0);
        const offlineQuestion = event(control, value => value.event.type === 'extension_ui_request' && value.event.method === 'input');
        const offlineQuestionPush = pushed(endpoint, 'blocked');
        const pendingQuestion = control.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: '/dialog' } });
        const question = await offlineQuestion;
        assertPush(await offlineQuestionPush, 'blocked');
        // The phone has no socket after its offline reload; answer from the independent client.
        await control.request('answer', { slotId: slot.id, response: { id: question.event.id, value: `Other client answer ${browserType.name()}` } });
        await pendingQuestion;
        assert.equal(await page.locator('#action-dialog').isVisible(), false);
        await context.setOffline(false);
        await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
        await page.locator('.xterm-rows').getByText(`${offlineWork} complete`, { exact: false }).first().waitFor();
        assert.equal(await prompt.inputValue(), offlineDraft);
        assert.equal(await page.locator('#send').isDisabled(), false);
        await cached(page, slot.id, `${offlineWork} complete`);
      } finally { daemonGate = undefined; gate.release.resolve(); }

      const log = (await readFile(commandsLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const submissions = log.filter(record => record.command.type === 'prompt' && record.command.message === message);
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].command.streamingBehavior, 'followUp');
      for (const draft of [unsent, reconnectDraft, offlineDraft]) assert.equal(log.filter(record => record.command.type === 'prompt' && record.command.message === draft).length, 0);
      assert.equal(log.filter(record => record.command.type === 'extension_ui_response' && record.command.value === `Native answer ${browserType.name()}`).length, 1);
      // An online authorization failure must never fall back to private saved text.
      // WebKit routes controlled-page network requests outside Playwright's route
      // interception. Unregister only after its real worker/offline checks; the
      // next navigation can then receive the injected HTTP 403, not a fake fetch.
      if (browserType === webkit) await page.evaluate(async () => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      });
      await page.route('**/api/status', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Device revoked for smoke test' }) }));
      const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/status' && response.status() === 403);
      await page.reload();
      await denied;
      await page.locator('#pair-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.xterm-rows').count(), 0);
      assert.equal(await page.locator('#terminal').textContent(), '');
      assert.doesNotMatch(await page.locator('body').textContent() ?? '', /History row|Completed while phone offline|Remote update during saved preview|Remote update after offline reload/);
      assert.equal((await cached(page, slot.id)).length, 0);
      await page.screenshot({ path: join(dir, `${browserType.name()}-revoked.png`) });
      const unsubscribed = await page.request.post(`${proxy.origin}/api/push/unsubscribe`, { headers: { Origin: proxy.origin }, data: {} });
      assert.equal(unsubscribed.status(), 200);
      assert.deepEqual(errors, []);
      console.log(`${browserType.name()}: pairing, native multiline/IME input, follow-up, touch scroll, completion, native dialog, automatic done/blocked push online and offline, IndexedDB persistence, gated saved reconnect, worker-backed offline reload, editable drafts, authoritative replacement, no replay, 403 cache clearing passed`);
    } catch (error) {
      await page.screenshot({ path: join(dir, `${browserType.name()}-failure.png`) }).catch(() => {});
      console.error(`${browserType.name()} failed; screenshots: ${dir}; status: ${await page.locator('#status').textContent().catch(() => 'unavailable')}`);
      throw error;
    } finally { daemonGate?.release.resolve(); daemonGate = undefined; await context.close(); await browser.close(); }
  }
  console.log(`Screenshots: ${dir}`);
} finally {
  daemonGate?.release.resolve(); monitor?.close(); await push?.close();
  control?.close(); await web?.close(); await proxy?.close(); await daemon.stop();
  // Retain screenshots on success or failure; all runtime resources have been stopped.
  await rm(join(dir, 'daemon'), { recursive: true, force: true });
}
