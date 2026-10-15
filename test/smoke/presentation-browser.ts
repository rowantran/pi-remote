import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit, type Page } from 'playwright';
import { Connection, handshake } from '../../src/client/connection.js';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { socketPath } from '../../src/protocol/paths.js';
import { ServerPresentation } from '../../src/web/server/presentation.js';
import { startWebServer } from '../../src/web/server/server.js';
import { testProxy } from '../web-browser/proxy.js';

/** Browser → test-only TLS proxy → private web socket → fixture daemon. No live Pi,
 * providers, credentials, service changes, or model calls. Run after building dist/web.
 * --real selects the trusted rowan-ui adapter and local gruvbox themes instead of
 * the deterministic adapter. It still uses only the isolated fixture daemon. */
const real = process.argv.slice(2).includes('--real');
assert.ok(process.argv.slice(2).every(arg => arg === '--real'), 'Only --real is supported');
const dir = await mkdtemp('/tmp/pi-presentation-smoke-');
const sourceDir = await mkdtemp(join(homedir(), '.pi-phone-presentation-'));
const browserHome = homedir();
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const stateDir = join(dir, 'daemon');
const webState = join(dir, 'web');
const commandsLog = join(dir, 'commands.jsonl');
const uiConfig = join(sourceDir, 'config.json');
const daemon = new Supervisor({ stateDir, executable: process.execPath, skipVersionCheck: true,
  prefixArgs: [fileURLToPath(new URL('../fixtures/fixture-pi.mjs', import.meta.url))],
  env: { PI_FIXTURE_COMMANDS_LOG: commandsLog, PI_OFFLINE: '1' } });
let control: Connection | undefined;
let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
let proxy: Awaited<ReturnType<typeof testProxy>> | undefined;
const connect = async () => {
  const socket = createConnection(socketPath(stateDir));
  await once(socket, 'connect'); return socket;
};

async function fixturePresentation(): Promise<void> {
  const homeKey = basename(sourceDir);
  await writeFile(join(sourceDir, 'static.ts'), `
    export const staticMarker = 'Fixture static';
    export const widget = ['Fixture widget'];
  `);
  await writeFile(join(sourceDir, 'extension.ts'), `
    import { createJiti } from 'jiti';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    import { Text } from '@earendil-works/pi-tui';
    import { staticMarker, widget } from './static.ts';
    export default async function(pi) {
      const loader = createJiti(import.meta.url, { moduleCache: false });
      const nested = await loader.import(join(homedir(), ${JSON.stringify(homeKey)}, 'nested.ts'), { default: true });
      const renderer = await nested();
      pi.registerToolRenderer((name, next) => name === 'read' ? renderer : next());
      pi.on('session_start', (_, ctx) => {
        ctx.ui.setFooter(() => new Text(ctx.ui.theme.fg('accent', 'Fixture footer'), 0, 0));
        ctx.ui.setWidget('fixture-static', [staticMarker, ...widget], { placement: 'belowEditor' });
      });
    }
  `);
  await writeFile(join(sourceDir, 'nested.ts'), `
    import { createJiti } from 'jiti';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    export default async function() {
      return createJiti(import.meta.url).import(join(homedir(), ${JSON.stringify(homeKey)}, 'leaf.ts'), { default: true });
    }
  `);
  await writeFile(join(sourceDir, 'leaf.ts'), `
    import { Text } from '@earendil-works/pi-tui';
    export default {
      renderCall: (_args, theme) => new Text(theme.fg('accent', 'Fixture dynamic call'), 0, 0),
      renderResult: (_result, _options, theme) => new Text(theme.fg('success', 'Fixture nested result'), 0, 0),
    };
  `);
  const agentDir = join(sourceDir, 'agent');
  await mkdir(join(agentDir, 'themes'), { recursive: true });
  const builtins = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'modes/interactive/theme');
  for (const appearance of ['light', 'dark']) {
    const theme = JSON.parse(await readFile(join(builtins, `${appearance}.json`), 'utf8'));
    theme.name = `smoke-${appearance}`;
    theme.appearance = appearance;
    theme.export = { pageBg: appearance === 'light' ? '#fcf9ee' : '#121820', cardBg: appearance === 'light' ? '#f4f0e4' : '#202630', infoBg: appearance === 'light' ? '#eae5d8' : '#283040' };
    theme.colors.text = appearance === 'light' ? '#202020' : '#e0e0e0';
    theme.colors.accent = appearance === 'light' ? '#125a8a' : '#65b9ec';
    await writeFile(join(agentDir, 'themes', `${theme.name}.json`), JSON.stringify(theme));
  }
  await writeFile(uiConfig, JSON.stringify({ theme: 'smoke-light/smoke-dark', bell: false, extensions: ['./extension.ts'] }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
}

async function seedSession(): Promise<string> {
  const sessionPath = join(dir, 'presentation.jsonl');
  const timestamp = 1_700_000_000_000;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const records: Record<string, unknown>[] = [
    { type: 'session', version: 3, id: randomUUID(), timestamp: new Date(timestamp).toISOString(), cwd: dir },
    { type: 'session_info', name: 'Phone presentation smoke' },
    { type: 'message', message: { role: 'user', content: 'Show the saved tool result', timestamp } },
    { type: 'message', message: { role: 'assistant', api: 'fixture', provider: 'fixture', model: 'fixture',
      usage, stopReason: 'toolUse', timestamp: timestamp + 1,
      content: [{ type: 'toolCall', id: 'presentation-read', name: 'read', arguments: { path: 'presentation-proof.txt' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'presentation-read', toolName: 'read',
      content: [{ type: 'text', text: 'First deterministic line\nSecond deterministic line' }],
      isError: false, timestamp: timestamp + 2 } },
  ];
  if (real) records.push({ type: 'custom', customType: 'worked-for', data: { elapsedSeconds: 538 } });
  await writeFile(sessionPath, records.map((record, index) => JSON.stringify(index === 0 ? record : {
    id: `entry-${index}`, parentId: index === 1 ? null : `entry-${index - 1}`,
    timestamp: new Date(timestamp + index).toISOString(), ...record,
  })).join('\n') + '\n');
  return sessionPath;
}

/** Wait for the worker's activation/controller event, not an arbitrary delay. The
 * worker's install transaction populates its fixed shell before it can activate. */
async function assertShellCache(page: Page): Promise<void> {
  await page.waitForFunction(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null);
  const entries = await page.evaluate(async () => Promise.all((await caches.keys()).map(async name => ({
    name, paths: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname).sort(),
  }))));
  const shells = entries.filter(entry => entry.name.startsWith('pi-remote-shell-'));
  assert.ok(shells.length > 0, 'The service worker has installed a real app-shell cache');
  const expected = ['/', '/app.js', '/app.css', '/xterm.css', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].sort();
  for (const shell of shells) assert.deepEqual(shell.paths, expected);
  for (const cache of entries) assert.ok(cache.paths.every(path => !path.startsWith('/api/')), 'No presentation bundle or private API response is cached');
}

async function assertAppearance(page: Page, scheme: 'light' | 'dark', checkFooter = true): Promise<void> {
  const theme = `${real ? 'gruvbox' : 'smoke'}-${scheme}`;
  const background = real ? (scheme === 'light' ? 'rgb(249, 245, 215)' : 'rgb(29, 32, 33)')
    : scheme === 'light' ? 'rgb(252, 249, 238)' : 'rgb(18, 24, 32)';
  const foreground = real ? (scheme === 'light' ? 'rgb(60, 56, 54)' : 'rgb(235, 219, 178)')
    : scheme === 'light' ? 'rgb(32, 32, 32)' : 'rgb(224, 224, 224)';
  await page.waitForFunction(({ theme, background, foreground }) => {
    const viewport = document.querySelector('.xterm-scrollable-element');
    return document.documentElement.dataset.theme === theme
      && getComputedStyle(document.body).backgroundColor === background
      && getComputedStyle(document.body).color === foreground
      && !!viewport && getComputedStyle(viewport).backgroundColor === background
      && getComputedStyle(document.querySelector('.xterm-rows')!).color === foreground;
  }, { theme, background, foreground }).catch(async error => {
    console.error('Appearance mismatch:', await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      root: getComputedStyle(document.documentElement).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
      foreground: getComputedStyle(document.body).color,
      terminal: [...document.querySelectorAll('.xterm, .xterm-viewport, .xterm-screen, .xterm-scrollable-element')]
        .map(element => ({ class: element.className, background: getComputedStyle(element).backgroundColor })),
    })));
    throw error;
  });
  const paint = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    page: getComputedStyle(document.body).backgroundColor,
    terminal: getComputedStyle(document.querySelector('.xterm-scrollable-element')!).backgroundColor,
  }));
  assert.equal(paint.theme, theme);
  assert.equal(paint.scheme, scheme);
  assert.equal(paint.page, background);
  assert.equal(paint.terminal, background);
  if (!real && checkFooter) {
    const accent = scheme === 'light' ? 'rgb(18, 90, 138)' : 'rgb(101, 185, 236)';
    // xterm replaces rows while applying the new theme; inspect the current DOM
    // on each frame instead of retaining a span that can become detached.
    await page.waitForFunction(accent => [...document.querySelectorAll('.xterm-rows span')]
      .some(element => element.textContent === 'Fixture footer' && getComputedStyle(element).color === accent), accent);
  }
}

async function assertRendering(page: Page): Promise<void> {
  const rows = page.locator('.xterm-rows');
  if (real) {
    await rows.getByText('Read 2 lines', { exact: false }).first().waitFor();
    await rows.getByText('no-model', { exact: false }).first().waitFor();
    await rows.getByText('? left', { exact: false }).first().waitFor();
    await rows.getByText('Worked for', { exact: false }).first().waitFor();
    assert.doesNotMatch(await rows.textContent() ?? '', /Second deterministic line/, 'Collapsed compact rendering hides raw output');
  } else {
    for (const marker of ['Fixture footer', 'Fixture widget', 'Fixture static', 'Fixture dynamic call', 'Fixture nested result']) {
      await rows.getByText(marker, { exact: false }).first().waitFor();
    }
  }
  assert.doesNotMatch(await page.locator('#notice').textContent() ?? '', /Local presentation:|presentation.*(?:failed|unavailable)/i);
}

try {
  await daemon.start();
  const socket = await connect();
  control = new Connection(socket, socket, () => socket.destroy()); await handshake(control);
  const slot = await control.request('create', { cwd: dir, sessionPath: await seedSession() });
  proxy = await testProxy(join(webState, 'web.sock'));
  web = await startWebServer({ origin: proxy.origin, allowedLogins: ['rowan@example.test'], stateDir: webState,
    daemonStateDir: stateDir, openDaemon: connect, checkTailscale: async () => {},
    uiConfig,
    handleApi: (request, response) => {
      if (request.method !== 'GET' || request.url !== '/api/push') return false;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ publicKey: '', subscribed: false, monitor: 'unsupported' }));
      return true;
    },
    staticDir: fileURLToPath(new URL('../../dist/web/', import.meta.url)) });
  // Write the normal config after the listener starts: no upload or restart.
  if (real) {
    await writeFile(uiConfig, JSON.stringify({ theme: 'gruvbox-light/gruvbox-dark', bell: false,
      extensions: [fileURLToPath(new URL('../../example-configs/rowan-ui.ts', import.meta.url))] }));
  } else await fixturePresentation();
  const presentation = await new ServerPresentation({ uiConfig }).read();
  assert.ok(presentation.bundle);
  assert.equal(presentation.config.presentation?.extensions.length, 1);
  if (!real) assert.match(presentation.bundle, new RegExp(`~/${basename(sourceDir)}/leaf\\.ts`));

  for (const browserType of [chromium, webkit]) {
    // Chromium's service-worker loader does not inherit ignoreHTTPSErrors.
    const browser = await browserType.launch({ headless: true,
      ...(browserType === chromium ? { args: ['--ignore-certificate-errors'] } : {}) });
    try {
      const context = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true,
        serviceWorkers: 'allow', colorScheme: 'light' });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(20_000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
          const unauthenticated = await page.request.get(`${proxy.origin}/api/presentation.js`);
          assert.equal(unauthenticated.status(), 401);
          const { code } = await web.devices.issuePairingCode();
          await page.goto(proxy.origin);
          await page.locator('#pair-dialog').waitFor({ state: 'visible' });
          await page.locator('#pair-code').fill(code);
          await page.locator('#device-name').fill(`${browserType.name()} presentation smoke`);
          const bundleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/presentation.js');
          await page.locator('#pair-form button[type=submit]').click();
          await page.locator('#slot-list button').first().waitFor();
          await page.locator('#slot-list button').first().click();
          const bundle = await bundleResponse;
          assert.equal(bundle.status(), 200);
          assert.equal(bundle.headers()['content-type'], 'text/javascript; charset=utf-8');
          assert.equal(bundle.headers()['cache-control'], 'no-store');
          assert.equal(bundle.headers()['x-content-type-options'], 'nosniff');
          assert.match(bundle.headers()['content-security-policy'], /script-src 'self'/);
          assert.doesNotMatch(bundle.headers()['content-security-policy'], /unsafe-eval/);
          const configResponse = await page.request.get(`${proxy.origin}/api/config`);
          assert.equal(configResponse.status(), 200);
          const config = await configResponse.json();
          assert.equal(config.home, browserHome);
          assert.equal(JSON.parse(config.files[`${browserHome}/.config/pi-remote/config.json`]).theme, real ? 'gruvbox-light/gruvbox-dark' : 'smoke-light/smoke-dark');
          assert.equal(new URL(bundle.url()).searchParams.get('v'), config.presentation.hash);
          await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
          await assertRendering(page); await assertAppearance(page, 'light');
          await page.screenshot({ path: join(dir, `${browserType.name()}-${real ? 'rowan' : 'fixture'}-light.png`) });
          await assertShellCache(page);

          // A media change plus reload must select the other pair member without
          // rebuilding or copying any config. Reload is the documented contract.
          await page.emulateMedia({ colorScheme: 'dark' });
          await page.reload();
          await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
          await assertRendering(page); await assertAppearance(page, 'dark');
          await assertShellCache(page);
          await page.screenshot({ path: join(dir, `${browserType.name()}-${real ? 'rowan' : 'fixture'}-dark.png`) });
          if (!real) {
            const marker = `Updated ${browserType.name()} source`;
            await writeFile(join(sourceDir, 'static.ts'), `export const staticMarker = ${JSON.stringify(`Fixture static / ${marker}`)}; export const widget = ['Fixture widget'];`);
            await page.reload();
            await page.locator('.xterm-rows').getByText(marker, { exact: false }).first().waitFor();
            await assertRendering(page);
            const changed = await (await page.request.get(`${proxy.origin}/api/config`)).json();
            assert.notEqual(changed.presentation.hash, config.presentation.hash, 'Reload must rebuild changed server source');
            const extension = join(sourceDir, 'extension.ts');
            const workingSource = await readFile(extension, 'utf8');
            try {
              await writeFile(extension, 'export default invalid fixture syntax');
              await page.reload();
              await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Connected');
              await page.locator('#notice').getByText('using built-in display', { exact: false }).waitFor();
              await assertAppearance(page, 'dark', false);
              assert.doesNotMatch(await page.locator('.xterm-rows').textContent() ?? '', /Fixture footer/, 'A failed generation must not reuse old factories');
            } finally { await writeFile(extension, workingSource); }
          }
          assert.deepEqual(errors, []);
          console.log(`${browserType.name()}: ${real ? 'real codex footer, compact read renderer, worked-for entry' : 'static widget, footer, nested HOME-relative dynamic tool renderer'}; light/dark theme pair, page/xterm colors, authenticated no-store bundle, fixed worker cache passed`);
        } catch (error) {
          await page.screenshot({ path: join(dir, `${browserType.name()}-failure.png`) }).catch(() => {});
          console.error(`${browserType.name()}: status=${await page.locator('#status').textContent().catch(() => 'unavailable')}; notice=${await page.locator('#notice').textContent().catch(() => 'unavailable')}`);
          throw error;
        }
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }
  const commands = (await readFile(commandsLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).command.type);
  assert.ok(!commands.includes('prompt') && !commands.includes('bash'), 'No model prompts or shell commands were submitted');
  console.log(`Screenshots: ${dir}`);
  if (real) console.log('Real adapter verified without providers/model calls. Native composer intentionally replaces prompt-caret; no extension tool executors or background workers are loaded.');
} finally {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  control?.close();
  await web?.close(); await proxy?.close(); await daemon.stop();
  await rm(sourceDir, { recursive: true, force: true });
  // Keep only screenshots, not private device state or presentation source.
  for (const path of [stateDir, webState, commandsLog, join(dir, 'presentation.jsonl')]) await rm(path, { recursive: true, force: true });
  console.log(`Presentation smoke artifacts: ${dir}`);
}
