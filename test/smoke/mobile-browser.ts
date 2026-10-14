import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { Connection, handshake } from '../../src/client/connection.js';
import { socketPath } from '../../src/protocol/paths.js';
import type { RemoteEvent } from '../../src/protocol/types.js';
import { startWebServer } from '../../src/web-server/server.js';
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
    daemonStateDir: stateDir, openDaemon: connect, checkTailscale: async () => {},
    staticDir: fileURLToPath(new URL('../../dist/web/', import.meta.url)) });
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
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
      await page.locator('#send-mode').selectOption('followUp');
      await page.locator('#send').click();
      await settled;
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
      await page.locator('#send').click();
      await page.locator('#action-dialog').waitFor({ state: 'visible' });
      await page.locator('#dialog-input').fill(`Native answer ${browserType.name()}`);
      const answered = event(control, value => value.event.type === 'remote_dialog_resolved');
      await page.locator('#action-content button').getByText('Submit answer', { exact: true }).click();
      await answered;
      await page.locator('#action-dialog').waitFor({ state: 'hidden' });

      await context.setOffline(true);
      const backgroundMessage = `Completed while phone offline ${browserType.name()}`;
      const finished = event(control, value => value.event.type === 'agent_settled');
      await control.request('rpc', { slotId: slot.id, command: { type: 'prompt', message: backgroundMessage } }); await finished;
      await context.setOffline(false);
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
      await page.locator('.xterm-rows').getByText(`${backgroundMessage} complete`, { exact: false }).first().waitFor();
      const unsent = `Unsent native draft ${browserType.name()}`;
      await prompt.fill(unsent);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
      await page.locator('.xterm-rows').getByText(`${backgroundMessage} complete`, { exact: false }).first().waitFor();
      assert.equal(await page.locator('#prompt').inputValue(), unsent);
      const log = (await readFile(commandsLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const submissions = log.filter(record => record.command.type === 'prompt' && record.command.message === message);
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].command.streamingBehavior, 'followUp');
      assert.equal(log.filter(record => record.command.type === 'prompt' && record.command.message === unsent).length, 0);
      assert.equal(log.filter(record => record.command.type === 'extension_ui_response' && record.command.value === `Native answer ${browserType.name()}`).length, 1);
      assert.deepEqual(errors, []);
      console.log(`${browserType.name()}: pairing, native multiline/IME input, follow-up, touch scroll, completion, native dialog, offline work, reconnect, saved draft, no replay passed`);
    } finally { await context.close(); await browser.close(); }
  }
  console.log(`Screenshots: ${dir}`);
} finally {
  control?.close(); await web?.close(); await proxy?.close(); await daemon.stop();
  // Retain screenshots on success or failure; all runtime resources have been stopped.
  await rm(join(dir, 'daemon'), { recursive: true, force: true });
}
