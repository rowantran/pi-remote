import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { buildWeb } from '../../src/web/build/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = (path: string) => JSON.stringify(join(root, path));

/** This is bundled, not run by Node. It deliberately has no globals side-effect import. */
const browserProbe = `
import { bootCheck } from './boot.ts';
import { PiScreen } from ${source('src/tui/pi-screen.ts')};
import { XtermTerminal } from ${source('src/web/client/terminal.ts')};
import { configureVirtualFiles, BUILTIN_THEME_DIR } from ${source('src/web/client/shims/vfs.ts')};
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { createBashToolDefinition } from ${source('src/web/client/shims/pi-coding-agent.ts')};
const check = (value, message) => { if (!value) throw new Error(message); };
const rejects = async (fn, code) => {
  try { await fn(); } catch (error) { check(error.code === code, String(error)); return; }
  throw new Error('Unsupported operation silently succeeded');
};
class MemoryTerminal {
  columns = 100; rows = 100; kittyProtocolActive = false; output = '';
  start(input) { this.input = input; } stop() { this.input = undefined; } async drainInput() {} write(data) { this.output += data; }
  sendKey(data) { this.input?.(data); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {} setProgramStatus() {}
}
const frame = (lines, extra = {}) => ({ type: 'frame', width: 100, layout: 'known', reset: true, editorFocused: true, dropdownRows: 0, hardwareCursor: false,
  sections: { 0: { start: 0, remove: 0, insert: lines }, 4: { start: 0, remove: 0, insert: ['──', '> ', '──'] }, 6: { start: 0, remove: 0, insert: ['FOOTER_OFFLINE'] } }, ...extra });
async function render(terminal) {
  const sent = [];
  const client = new PiScreen(terminal, { send: data => sent.push(data), resize() {} });
  client.start();
  try {
    client.receive({ type: 'editorInstalled', editor: 'default', bindings: {} });
    client.receive(frame(['USER_OFFLINE', '\\x1b[1mASSISTANT_OFFLINE\\x1b[22m', ...Array.from({ length: 150 }, (_, i) => 'history ' + i)]));
    client.tui.renderNow();
    const initial = stripTerminalSequences(client.tui.getScreenLines().join('\\n'));
    for (const marker of ['history 149', 'FOOTER_OFFLINE']) check(initial.includes(marker), 'Missing rendered marker: ' + marker);
    client.receive({ ...frame([]), reset: false, sections: { 0: { start: 152, remove: 0, insert: ['STREAM_OFFLINE'] } } });
    client.tui.renderNow();
    const streamed = stripTerminalSequences(client.tui.getScreenLines().join('\\n'));
    check(streamed.includes('STREAM_OFFLINE'), 'A line diff did not render');
    client.scrollTranscript(-200); client.tui.renderNow();
    const scrolled = stripTerminalSequences(client.tui.getScreenLines().join('\\n'));
    check(scrolled.includes('USER_OFFLINE'), 'Local scrolling did not reach the top');
    client.followLatest();
    let xtermText, domText;
    if (terminal.xterm) {
      client.tui.renderNow();
      await new Promise(resolve => terminal.xterm.write('', resolve));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      domText = terminal.element.querySelector('.xterm-rows')?.textContent ?? '';
      check(domText.includes('STREAM_OFFLINE'), 'xterm DOM did not paint the latest line');
      const buffer = terminal.xterm.buffer.active;
      xtermText = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\\n');
      check(xtermText.includes('STREAM_OFFLINE'), 'xterm did not parse the latest line');
    }
    terminal.sendKey?.('a');
    await new Promise(resolve => setTimeout(resolve, 0));
    check(sent.join('').startsWith('a\\x1b_pi-remote:barrier:'), 'Typing did not reach Pi with a barrier');
    return { initial, streamed, xtermText, domText, sent: sent.length };
  } finally { client.stop(); }
}
async function probe() {
  check(bootCheck === 'boot' && globalThis.process === process && globalThis.Buffer === Buffer, 'Globals were not initialized before dependencies');
  configureVirtualFiles({ home: '/browser', files: {
    '/browser/.pi/agent/settings.json': '{"theme":"dark"}', '/browser/settings.txt': 'héllo',
  } });
  check(existsSync(BUILTIN_THEME_DIR + '/dark.json') && existsSync(BUILTIN_THEME_DIR + '/light.json'), 'Built-in themes were lost');
  check(JSON.parse(readFileSync(BUILTIN_THEME_DIR + '/dark.json', 'utf8')).name === 'dark', 'Dark theme missing');
  check(Buffer.isBuffer(readFileSync('/browser/settings.txt')), 'readFile without encoding must return Buffer');
  check(await readFile('/browser/settings.txt', 'utf8') === 'héllo', 'VFS text read failed');
  check(readdirSync('/browser').includes('settings.txt'), 'VFS directory listing failed');
  await rejects(() => readFile('/etc/passwd', 'utf8'), 'ENOENT');
  await rejects(() => readdirSync('/not-supplied'), 'ENOENT');
  for (const fn of [() => writeFile('/browser/settings.txt', 'new'), () => mkdir('/tmp/new'),
    () => spawn('sh'), () => createRequire(import.meta.url)('fs'),
    () => process.exit(0), () => process.stdout.write('discarded'),
    () => createJiti().import('/any-extension.ts'), () => createBashToolDefinition('/remote').execute()]) {
    await rejects(fn, 'ERR_BROWSER_UNSUPPORTED');
  }
  const memory = await render(new MemoryTerminal());
  const host = document.createElement('div'); host.style.cssText = 'width:1000px;height:2200px'; document.body.append(host);
  const terminal = new XtermTerminal(host);
  try {
    const xterm = await render(terminal);
    globalThis.__probe = { ok: true, memory, xterm };
  } finally { terminal.dispose(); }
}
void probe().catch(error => { globalThis.__probe = { error: error.stack ?? String(error) }; });
`;

test('browser bundle runs PiScreen offline in Chromium and WebKit without runtime providers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'probe.ts');
  // Resolve package-only imports from the repository, even though this fixture lives in /tmp.
  await writeFile(entry, browserProbe.replace("from '@earendil-works/pi-tui'", `from ${source('node_modules/@earendil-works/pi-tui/dist/index.js')}`));
  await writeFile(join(dir, 'boot.ts'), "export const bootCheck = Buffer.from('boot').toString(); process.nextTick(() => {});\n");
  const outdir = join(dir, 'web');
  await buildWeb({ entry, outdir, minify: true });
  const meta = JSON.parse(await readFile(join(outdir, 'bundle-meta.json'), 'utf8'));
  const inputs = Object.keys(meta.inputs).join('\n');
  assert.doesNotMatch(inputs, /pi-agent-core|pi-ai\/dist\/(?:auth|api|providers)|photon\.js|cross-spawn/);
  assert.doesNotMatch(inputs, /core\/tools\/(?:bash|powershell|read|write|edit|grep|find|ls)\.js/);
  for (const name of ['index.html', 'style.css', 'icon.svg', 'xterm.css']) {
    if (name === 'xterm.css' || existsSync(join(root, 'src/web/client', name))) assert.ok(existsSync(join(outdir, name)), `${name} was not copied`);
  }
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<link rel="stylesheet" href="/xterm.css"><script type="module" src="/app.js"></script>');
    } else if (req.url === '/app.js' || req.url === '/xterm.css') {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(join(outdir, req.url.slice(1))));
    } else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
    await t.test(name, async t => {
      let executablePath = engine.executablePath();
      if (!existsSync(executablePath) && name === 'chromium') {
        const cache = join(homedir(), '.cache/ms-playwright');
        const versions = await readdir(cache).catch(() => []);
        for (const version of versions.filter(v => /^chromium-/.test(v)).sort().reverse()) {
          for (const platform of ['chrome-linux64', 'chrome-linux']) {
            const candidate = join(cache, version, platform, 'chrome');
            if (existsSync(candidate)) { executablePath = candidate; break; }
          }
          if (existsSync(executablePath)) break;
        }
      }
      if (!existsSync(executablePath)) { t.skip(`Install Playwright ${name} to run the offline rendering test`); return; }
      const browser = await engine.launch({ executablePath, headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage();
      const errors: string[] = [], external: string[] = [];
      page.on('pageerror', error => errors.push(error.stack ?? error.message));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      await page.goto(origin);
      await page.waitForFunction(() => '__probe' in globalThis, undefined, { timeout: 20_000 });
      const result = await page.evaluate(() => (globalThis as any).__probe);
      assert.equal(result.error, undefined, result.error);
      assert.equal(result.ok, true);
      assert.ok(result.xterm.xtermText.includes('STREAM_OFFLINE'));
      assert.ok(result.xterm.domText.includes('STREAM_OFFLINE'));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    });
  }
});
