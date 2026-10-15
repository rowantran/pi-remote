import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium, webkit, devices } from 'playwright';
import { buildWeb } from '../../src/web/build/app.js';

const root = resolve(import.meta.dirname, '../..');
const source = (path: string) => JSON.stringify(join(root, path));
const hash = 'a'.repeat(64);
// A separate same-origin module must use the app's classes/shims, not duplicate Pi's state.
const extension = `
const registry = globalThis.__piRemotePresentation;
const { Text } = registry.modules['@earendil-works/pi-tui'];
const { createJiti } = registry.modules.jiti;
const { homedir } = registry.modules.os;
const { join } = registry.modules.path;
export const dynamic = { '/devbox/extensions/footer.ts': {
  default: pi => pi.on('session_start', (_event, context) => {
    context.ui.setFooter(() => new Text('SYNCED_PHONE_FOOTER', 0, 0));
  }), named: 'DYNAMIC_NAMESPACE',
} };
export const factories = [{ path: '/devbox/adapter.ts', factory: async pi => {
  const factory = await createJiti().import(join(homedir(), 'extensions/footer.ts'), { default: true });
  await factory(pi);
} }];
`;
const probe = `
import { RemoteTui } from ${source('src/tui/tui.ts')};
import { XtermTerminal } from ${source('src/web/client/terminal.ts')};
import { configureVirtualFiles, readVirtualFile, BUILTIN_THEME_DIR } from ${source('src/web/client/shims/vfs.ts')};
import { loadBrowserPresentation, browserPresentationOptions, browserTerminalTheme } from ${source('src/web/client/presentation.ts')};
import { readBrowserAppearance, themeCssColor } from ${source('src/web/client/appearance.ts')};
import { presentationRegistry, browserModuleResolve } from ${source('src/web/client/shims/globals.ts')};
import { createJiti } from ${source('src/web/client/shims/jiti.ts')};
import { existsSync } from 'node:fs';
import { stripTerminalSequences } from ${source('node_modules/@earendil-works/pi-tui/dist/index.js')};
const check = (value, message) => { if (!value) throw new Error(message); };
async function probe() {
  const base = JSON.parse(readVirtualFile(BUILTIN_THEME_DIR + '/light.json'));
  const makeTheme = (name, bg, fg) => JSON.stringify({ ...base, name, appearance: name.endsWith('light') ? 'light' : 'dark', vars: { ...base.vars, page: bg, card: bg, info: bg, ink: fg },
    colors: { ...base.colors, text: 'ink' }, export: { pageBg: 'page', cardBg: 'card', infoBg: 'info' } });
  const config = { home: '/devbox', files: {
    '/devbox/.config/pi-remote/config.json': JSON.stringify({ theme: 'fixture-light/fixture-dark', bell: false }),
    '/devbox/.pi/agent/settings.json': JSON.stringify({ hideThinkingBlock: true, doubleEscapeAction: 'none' }),
    '/devbox/.pi/agent/themes/fixture-light.json': makeTheme('fixture-light', '#faf5dd', '#282828'),
    '/devbox/.pi/agent/themes/fixture-dark.json': makeTheme('fixture-dark', '#202020', '#ededed'),
  }, presentation: { hash: '${hash}' } };
  configureVirtualFiles(config);
  for (const [selection, scheme, expected] of [
    ['system/dark', 'light', 'light'], ['system/dark', 'dark', 'dark'],
    ['light/system', 'light', 'light'], ['light/system', 'dark', 'dark'],
    ['system/system', 'light', 'light'], ['system/system', 'dark', 'dark'],
  ]) check(readBrowserAppearance(selection, scheme).theme === expected, 'System pair member failed: ' + selection + ' / ' + scheme);
  const notices = [];
  await loadBrowserPresentation(config, error => notices.push(String(error)));
  check(!notices.length, notices.join('\\n'));
  const options = await browserPresentationOptions();
  check(options.bell === false && options.hideThinkingBlock === true && options.doubleEscapeAction === 'none', 'Pi/client preferences were ignored');
  const registry = presentationRegistry();
  const loader = createJiti();
  const namespace = await loader.import('/devbox/extensions/footer.ts');
  check(namespace.named === 'DYNAMIC_NAMESPACE', 'Namespace import lost named exports');
  check(await loader.import('file:///devbox/extensions/../extensions/footer.ts', { default: true }) === namespace.default, 'File URL/default import normalization failed');
  check(await createJiti(undefined, { alias: { footer: '/devbox/extensions/footer.ts' } }).import('footer') === namespace, 'Dynamic import alias failed');
  check(await loader.import('@mariozechner/pi-tui') === registry.modules['@earendil-works/pi-tui'], 'Legacy display namespace was not shared');
  check(await loader.import('~/extensions/footer.ts', { default: true }) === namespace.default, 'Home-relative import failed');
  const component = '/__pi_browser__/modes/interactive/components/custom-entry.js';
  check(existsSync(component), 'Display component metadata is missing');
  const native = await registry.import('file://' + component);
  check(typeof native.CustomEntryComponent === 'function', 'Private display component was not shared');
  check(browserModuleResolve('@earendil-works/pi-tui').startsWith('file:'), 'Package metadata resolution failed');
  check(browserModuleResolve('@mariozechner/pi-tui') === browserModuleResolve('@earendil-works/pi-tui'), 'Legacy package metadata resolution failed');
  check(browserModuleResolve('node:path') === browserModuleResolve('path'), 'Builtin metadata resolution failed');
  check(themeCssColor('a', { a: 'b', b: 'a' }) === undefined, 'Circular variable must fall back');
  check(themeCssColor(231) === '#ffffff' && themeCssColor(16) === '#000000', 'Palette colors were not converted');
  check(/^#[a-f0-9]{6}$/.test(themeCssColor('okhsl(225 5% 27%)')), 'Pi OKHSL colors must convert to browser-compatible hex');
  const connection = {
    request: async () => ({}), onEvent: () => () => {}, onDisconnect: () => () => {}, close() {},
  };
  const snapshot = { slot: { id: 'browser', cwd: '/remote', status: 'running', createdAt: '', clients: 1 },
    state: {}, seq: 0, ui: [], entries: [], leafId: null,
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] } };
  const terminal = new XtermTerminal(document.getElementById('terminal'), undefined, browserTerminalTheme());
  const ui = new RemoteTui(connection, 'browser', snapshot, terminal, options);
  const finished = ui.run();
  await ui.initialize(); ui.tui.renderNow();
  await new Promise(resolve => terminal.xterm.write('', resolve));
  const text = stripTerminalSequences(ui.tui.getScreenLines().join('\\n'));
  check(text.includes('SYNCED_PHONE_FOOTER'), text);
  const result = { theme: options.theme, background: getComputedStyle(document.documentElement).backgroundColor,
    xtermBackground: terminal.xterm.options.theme.background, text, colorScheme: document.documentElement.style.colorScheme };
  const failures = [];
  await loadBrowserPresentation(config, error => failures.push(String(error)), async () => { throw new Error('bundle unavailable'); });
  check(failures.length === 1 && failures[0].includes('built-in display'), 'Bundle failure had no notice');
  check((await browserPresentationOptions()).presentationFactories.length === 0, 'Failed bundle did not fall back');
  const serverFailures = [];
  let importedFailedGeneration = false;
  await loadBrowserPresentation({ ...config, presentationError: 'Phone presentation unavailable; using built-in display. Check the web server logs.' },
    error => serverFailures.push(String(error)), async () => { importedFailedGeneration = true; throw new Error('must not import'); });
  check(!importedFailedGeneration && serverFailures.length === 1 && serverFailures[0].includes('server logs'), 'Server build failure must warn without importing stale code');
  const fallback = await browserPresentationOptions();
  check(fallback.presentationFactories.length === 0 && fallback.theme === options.theme && fallback.bell === false, 'Build fallback lost safe display preferences');
  ui.detach(); await finished; terminal.dispose();
  globalThis.__presentationProbe = result;
}
void probe().catch(error => { globalThis.__presentationProbe = { error: error.stack ?? String(error) }; });
`;

test('phone presentation shares dynamic adapters and honors light/dark preferences', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phone-presentation-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, 'probe.ts');
  const outdir = join(directory, 'web');
  await writeFile(entry, probe);
  await buildWeb({ entry, outdir });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
      response.end('<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/xterm.css"><div id="terminal" style="width:390px;height:650px"></div><script type="module" src="/app.js"></script>');
    } else if (path === '/api/presentation.js' && request.url === `/api/presentation.js?v=${hash}`) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(extension);
    } else if (['/app.js', '/app.css', '/xterm.css'].includes(path)) {
      response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(await readFile(join(outdir, path.slice(1))));
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
    await t.test(name, async t => {
      const browser = await engine.launch({ headless: true });
      t.after(() => browser.close());
      for (const colorScheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.waitForFunction(() => '__presentationProbe' in globalThis);
        const result = await page.evaluate(() => (globalThis as any).__presentationProbe);
        assert.equal(result.error, undefined, result.error);
        assert.equal(result.theme, `fixture-${colorScheme}`);
        assert.equal(result.colorScheme, colorScheme);
        assert.equal(result.background, colorScheme === 'light' ? 'rgb(250, 245, 221)' : 'rgb(32, 32, 32)');
        assert.equal(result.xtermBackground, colorScheme === 'light' ? '#faf5dd' : '#202020');
        assert.ok(result.text.includes('SYNCED_PHONE_FOOTER'));
        assert.deepEqual(errors, []);
        await context.close();
      }
    });
  }
});
