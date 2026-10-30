/**
 * Phone client on a native slot: real browser → TLS test proxy → web socket → daemon →
 * stock pinned Pi (offline fixture provider) in a PTY. Requires `npm run build` first.
 *
 *   npm run build && node --import tsx test/smoke/phone.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { Connection, handshake } from '../../src/client/connection.js';
import { socketPath } from '../../src/protocol/paths.js';
import type { SlotInfo } from '../../src/protocol/types.js';
import { startWebServer } from '../../src/web/server/server.js';
import { PushService } from '../../src/web/server/push.js';
import { startActivityMonitor, type ActivityMonitor } from '../../src/web/server/activity-monitor.js';
import { createECDH, randomBytes } from 'node:crypto';
import { testProxy } from '../web-browser/proxy.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dir = await mkdtemp(join(await realpath('/tmp'), 'pi-remote-phone-'));
const stateDir = join(dir, 'daemon'), webState = join(dir, 'web'), agent = join(dir, 'agent'), gates = join(dir, 'gates'), workspace = join(dir, 'workspace');
await Promise.all([mkdir(agent, { recursive: true }), mkdir(gates), mkdir(workspace)]);
await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'dark', quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } }));
const daemon = new Supervisor({ stateDir, executable: process.execPath,
  prefixArgs: [join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')],
  env: { HOME: dir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', GOLDEN_GATE_DIR: gates } });
const connect = async () => { const socket = createConnection(socketPath(stateDir)); await once(socket, 'connect'); return socket; };
let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
let proxy: Awaited<ReturnType<typeof testProxy>> | undefined;
let control: Connection | undefined;
let push: PushService | undefined;
let monitor: ActivityMonitor | undefined;
const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
try {
  await daemon.start();
  const socket = await connect();
  control = new Connection(socket, socket, () => socket.destroy()); await handshake(control);
  const args = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
    '--extension', join(repo, 'test/golden/fixture-provider.ts'), '--model', 'golden-local/transcript', '--tools', 'bash', '--session-dir', join(dir, 'sessions')];
  const slot: SlotInfo = await control.request('create', { cwd: workspace, args, native: true });
  for (let n = 0; (await control.request('list')).find(info => info.id === slot.id)?.status !== 'running'; n++) {
    assert.ok(n < 200, 'slot starts'); await new Promise(resolve => setTimeout(resolve, 100));
  }
  proxy = await testProxy(join(webState, 'web.sock'));
  web = await startWebServer({ origin: proxy.origin, allowedLogins: ['rowan@example.test'], stateDir: webState,
    uiConfig: join(dir, 'config.json'), daemonStateDir: stateDir, openDaemon: connect, checkTailscale: async () => {},
    handleApi: (request, response, context) => push?.handleApi(request, response, context) ?? false,
    staticDir: join(repo, 'dist/web/') });
  push = await PushService.open({ stateDir: webState, origin: proxy.origin, devices: web.devices, tabs: web.tabs, allowedLogins: ['rowan@example.test'],
    send: async (subscription, payload) => { sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(String(payload)) }); return { statusCode: 201, body: '', headers: {} }; } });
  // Notifications come from the companion's lifecycle events through the read-only activity stream.
  let active!: () => void;
  const monitoring = new Promise<void>(resolve => { active = resolve; });
  monitor = startActivityMonitor({
    connect: async () => { const socket = await connect(); const connection = new Connection(socket, socket, () => socket.destroy()); await handshake(connection); return connection; },
    onBell: notice => push!.notify(notice),
    onStatus: status => { push!.setMonitorStatus(status); if (status === 'active') active(); },
  });
  await monitoring;
  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const { code } = await web.devices.issuePairingCode();
    await page.goto(proxy.origin);
    await page.locator('#pair-code').fill(code);
    await page.locator('#device-name').fill('phone smoke');
    await page.locator('#pair-form button[type=submit]').click();
    await page.locator('#slot-list button').first().click();
    try { await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected'); }
    catch (error) {
      console.error('status:', await page.locator('#status').textContent(), 'notice:', await page.locator('#notice').textContent(), 'errors:', errors);
      throw error;
    }
    // Pi renders at the phone's width: the footer model name fits the narrow screen.
    await page.locator('.xterm-rows').getByText('transcript', { exact: false }).first().waitFor();
    // Pi's full-width rules show the width it rendered at.
    const columns = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.xterm-rows > div')]
      .map(row => (row.textContent ?? '').replace(/\s+$/, '')).filter(text => /^─+$/.test(text)).map(text => text.length)));
    assert.ok(columns > 20 && columns < 70, `phone width, got ${columns} columns`);

    // Subscribing for notifications: the open tab gets a 'done' push when Pi finishes.
    const curve = createECDH('prime256v1'); curve.generateKeys();
    const endpoint = 'https://web.push.apple.com/synthetic-phone';
    const subscription = { endpoint, expirationTime: null, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const registered = await page.request.post(`${proxy.origin}/api/push/subscribe`, { headers: { Origin: proxy.origin }, data: { subscription } });
    assert.equal(registered.status(), 200, await registered.text());

    // The text box replaces Pi's editor text and presses Enter.
    await page.locator('#prompt').fill('GOLDEN_SECOND_USER from the phone');
    await page.locator('#send').click();
    await page.locator('.xterm-rows').getByText('GOLDEN_SECOND_DONE', { exact: false }).first().waitFor();
    assert.equal(await page.locator('#prompt').inputValue(), '', 'the text box clears after sending');
    for (let n = 0; !sent.some(item => item.endpoint === endpoint && item.payload.kind === 'done' && item.payload.slotId === slot.id); n++) {
      assert.ok(n < 200, 'a done notification for the open tab'); await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Pi's own picker: the choice buttons appear and drive it.
    await page.locator('#prompt').fill('/model');
    await page.locator('#send').click();
    await page.locator('#picker-keys').waitFor({ state: 'visible' });
    await page.locator('.xterm-rows').getByText('golden-local', { exact: false }).first().waitFor();
    await page.locator('#picker-keys [data-key=escape]').click();
    await page.locator('#picker-keys').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('PASS phone: pairing, phone-width rendering, text box prompt, done notification, Pi picker with choice buttons');
  } finally { await browser.close(); }
} finally {
  monitor?.close();
  control?.close();
  await web?.close?.();
  await proxy?.close?.();
  await daemon.stop();
  await rm(dir, { recursive: true, force: true });
}
