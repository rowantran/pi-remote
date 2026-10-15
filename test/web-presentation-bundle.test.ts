import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, webkit } from 'playwright';
import { bundlePresentation, presentationTraceKey } from '../src/web/build/presentation-bundle.js';
import { buildWeb } from '../src/web/build/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path: string) => JSON.stringify(join(root, path));
const traceGlobal = globalThis as typeof globalThis & { __bundleFactoryCount?: number; __bundleSessionStarts?: number };

/** Real files under home exercise both original-home and different-browser-home key normalization. */
async function fixture() {
  const dir = await mkdtemp(join(homedir(), '.pi-remote-presentation-fixture-'));
  const homeRelative = relative(homedir(), dir);
  await writeFile(join(dir, 'static.ts'), `
    import { Type } from 'typebox';
    export const label = 'STATIC_FIXTURE';
    export const parameters = Type.Object({ input: Type.String() });
  `);
  await writeFile(join(dir, 'namespace.ts'), `
    import { spawn } from 'node:child_process';
    import childProcess from 'node:child_process';
    export { Text } from '@earendil-works/pi-tui';
    export { Theme, initTheme, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
    export function unsupportedNamed() { return spawn('never-run'); }
    export function unsupportedDefault() { return childProcess.exec('never-run'); }
    export function unknownNative(path) { return import(path); }
    export default 'NAMESPACE_DEFAULT';
  `);
  await writeFile(join(dir, 'nested.ts'), `
    import { Text } from '@earendil-works/pi-tui';
    export default function install(pi, label, parameters) {
      pi.registerTool({ name: 'fixture', label, description: '', parameters,
        renderCall: () => new Text(label + ':NESTED_DYNAMIC_FIXTURE', 0, 0) });
      pi.on('session_start', (_event, ctx) => {
        globalThis.__bundleSessionStarts = (globalThis.__bundleSessionStarts ?? 0) + 1;
        ctx.ui.setWidget('fixture', ['FIXTURE_WIDGET']);
      });
    }
  `);
  // Do not rely on import.meta.url in the browser for nested paths: the browser has one bundle URL.
  // The fixture passes an explicit home-based path just as the real rowan-ui adapter does.
  await writeFile(join(dir, 'dynamic.ts'), `
    import { createJiti } from 'jiti';
    import { join } from 'node:path';
    import { homedir } from 'node:os';
    export default async function dynamic(pi, label, parameters) {
      const loader = createJiti(import.meta.url, { moduleCache: false });
      const nested = await loader.import(join(process.env.PI_REMOTE_RENDERER_REPO ?? join(homedir(), ${JSON.stringify(homeRelative)}), 'nested.ts'), { default: true });
      nested(pi, label, parameters);
    }
  `);
  const entry = join(dir, 'extension.ts');
  await writeFile(entry, `
    import { createJiti } from 'jiti';
    import { homedir } from 'node:os';
    import { dirname, join } from 'node:path';
    import { existsSync } from 'node:fs';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    import { label, parameters } from './static.ts';
    export default async function fixture(pi) {
      globalThis.__bundleFactoryCount = (globalThis.__bundleFactoryCount ?? 0) + 1;
      const root = process.env.PI_REMOTE_RENDERER_REPO ?? join(homedir(), ${JSON.stringify(homeRelative)});
      const loader = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
      const shared = await loader.import('@earendil-works/pi-tui');
      const builtin = await loader.import('node:path');
      if (typeof shared.Text !== 'function' || typeof builtin.join !== 'function') throw new Error('Shared namespace dynamic import failed');
      const dynamic = await loader.import(join(root, 'dynamic.ts'), { default: true });
      const namespace = await loader.import(join(root, 'namespace.ts'));
      if (namespace.default !== 'NAMESPACE_DEFAULT') throw new Error('Namespace default semantics changed');
      // Exercise the native dynamic import used by worked-for.ts, including its VFS check.
      const componentPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'modes/interactive/components/custom-entry.js');
      if (!existsSync(componentPath)) throw new Error('Shared private display module is not visible');
      const component = await import(pathToFileURL(componentPath).href);
      if (typeof component.CustomEntryComponent !== 'function') throw new Error('Native display import failed');
      await dynamic(pi, label, parameters);
    }
  `);
  return { dir, entry };
}

test('presentation keys are home-relative only within the selected home', () => {
  assert.equal(presentationTraceKey('/home/user/a.ts', '/home/user'), '~/a.ts');
  assert.equal(presentationTraceKey('/home/user', '/home/user'), '~');
  assert.equal(presentationTraceKey('/home/username/a.ts', '/home/user'), '/home/username/a.ts');
  assert.equal(presentationTraceKey('/outside/a.ts', '/home/user'), '/outside/a.ts');
});

test('an empty extension list still exports a valid browser module', async () => {
  const output = await bundlePresentation([]);
  const host = globalThis as typeof globalThis & { __piRemotePresentation?: any };
  const previous = host.__piRemotePresentation;
  host.__piRemotePresentation = { modules: {}, globals: {}, dynamic: {}, traceHome: undefined };
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(output.bundle).toString('base64')}`);
    assert.deepEqual(module.factories, []);
    assert.deepEqual(module.dynamic, {});
    assert.deepEqual(output.extensions, []);
    assert.deepEqual(output.tracedModules, []);
  } finally {
    if (previous === undefined) delete host.__piRemotePresentation; else host.__piRemotePresentation = previous;
  }
});

test('presentation trace and browser bundle preserve static/nested dynamic imports and shared display identity', async t => {
  const { dir, entry } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = await mkdtemp(join(tmpdir(), 'pi-remote-presentation-bundle-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const previousEnv = process.env.PI_REMOTE_RENDERER_REPO;
  const previousCount = traceGlobal.__bundleFactoryCount;
  const previousStarts = traceGlobal.__bundleSessionStarts;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.PI_REMOTE_RENDERER_REPO; else process.env.PI_REMOTE_RENDERER_REPO = previousEnv;
    if (previousCount === undefined) delete traceGlobal.__bundleFactoryCount; else traceGlobal.__bundleFactoryCount = previousCount;
    if (previousStarts === undefined) delete traceGlobal.__bundleSessionStarts; else traceGlobal.__bundleSessionStarts = previousStarts;
  });
  delete process.env.PI_REMOTE_RENDERER_REPO;
  traceGlobal.__bundleFactoryCount = 0;
  traceGlobal.__bundleSessionStarts = 0;
  const first = await bundlePresentation([entry, entry]);
  assert.equal(traceGlobal.__bundleFactoryCount, 1, 'Only one factory invocation while tracing duplicate extension paths');
  assert.equal(traceGlobal.__bundleSessionStarts, 0, 'Tracing must not start a session');
  assert.deepEqual(first.extensions, [entry]);
  assert.deepEqual(first.tracedModules, ['dynamic.ts', 'namespace.ts', 'nested.ts'].map(name => join(dir, name)));
  const second = await bundlePresentation([entry]);
  assert.equal(second.bundle, first.bundle, 'No timestamps, random wrapper paths or execution counters in bundle bytes');
  assert.equal(traceGlobal.__bundleFactoryCount, 2);
  assert.doesNotMatch(first.bundle, /apiKey|PI_BACKGROUND_CLI_PATH|PI_SESSION_FILE/);
  await writeFile(join(output, 'presentation.js'), first.bundle);
  process.env.PI_REMOTE_RENDERER_REPO = dir;
  const overridden = await bundlePresentation([entry]);
  await writeFile(join(output, 'override.js'), overridden.bundle);
  if (previousEnv === undefined) delete process.env.PI_REMOTE_RENDERER_REPO; else process.env.PI_REMOTE_RENDERER_REPO = previousEnv;

  const probe = join(output, 'probe.ts');
  await writeFile(probe, `
    import { installPresentationRegistry } from ${source('src/web/client/presentation.ts')};
    import { PresentationHost } from ${source('src/tui/presentation.ts')};
    import { configureVirtualFiles } from ${source('src/web/client/shims/vfs.ts')};
    import { presentationRegistry } from ${source('src/web/client/shims/globals.ts')};
    import { Text, stripTerminalSequences } from ${source('node_modules/@earendil-works/pi-tui/dist/index.js')};
    import { Theme, initTheme, getMarkdownTheme, CustomEntryComponent } from '@earendil-works/pi-coding-agent';
    const check = (value, message) => { if (!value) throw new Error(message); };
    const rejects = async fn => {
      try { await fn(); } catch (error) { check(error.code === 'ERR_BROWSER_UNSUPPORTED', String(error)); return; }
      throw new Error('Unsupported browser operation succeeded');
    };
    const snapshot = {
      slot: { id: 'fixture', cwd: '/remote', status: 'running', createdAt: '', clients: 0 },
      state: {}, entries: [], leafId: null, ui: [], seq: 0,
      live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
    };
    async function run() {
      configureVirtualFiles({ home: '/different/device/home', files: {} });
      installPresentationRegistry();
      const registry = presentationRegistry();
      check(!process.env.PI_REMOTE_RENDERER_REPO, 'Browser inherited the Node environment');
      for (const name of ['presentation', 'override']) {
        registry.dynamic = Object.create(null);
        const bundle = await import('/' + name + '.js');
        const notices = [];
        const host = new PresentationHost({ snapshot: () => snapshot,
          tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
          notify: message => notices.push(message), invalidate() {} });
        try {
          await host.loadFactories(bundle.factories);
          check(notices.length === 0, notices.join('\\n'));
          const rendered = host.renderCall('fixture', {}, { toolCallId: name });
          check(rendered instanceof Text, 'Bundler embedded a second Text class');
          check(stripTerminalSequences(rendered.render(80).join('\\n')).includes('STATIC_FIXTURE:NESTED_DYNAMIC_FIXTURE'), 'Static/nested dynamic renderer did not run');
          check(host.tools.get('fixture').parameters.properties.input.type === 'string', 'TypeBox was not bundled');
          const namespace = Object.entries(bundle.dynamic).find(([key]) => key.endsWith('/namespace.ts'))[1];
          check(Object.keys(bundle.dynamic).every(key => key.startsWith('~/')), 'Home paths were not normalized');
          check(namespace.Text === Text && namespace.Theme === Theme, 'Display constructor identity differs');
          check(namespace.initTheme === initTheme && namespace.getMarkdownTheme === getMarkdownTheme, 'Theme singleton module was duplicated');
          check(registry.modules['/__pi_browser__/modes/interactive/components/custom-entry.js'].CustomEntryComponent === CustomEntryComponent, 'Native dynamic display import used a duplicate class');
          await rejects(() => namespace.unsupportedNamed());
          await rejects(() => namespace.unsupportedDefault());
          await rejects(() => namespace.unknownNative('https://untrusted.invalid/module.js'));
          await rejects(() => registry.modules.jiti.createJiti().import('/untraced.ts'));
          await host.start();
          check(host.widgets.get('fixture').component.render(80).join(' ').includes('FIXTURE_WIDGET'), 'Factory display hook was not active');
        } finally { await host.shutdown(); }
      }
      globalThis.__bundleProbe = { ok: true, factories: globalThis.__bundleFactoryCount, sessions: globalThis.__bundleSessionStarts };
    }
    void run().catch(error => { globalThis.__bundleProbe = { error: error.stack ?? String(error) }; });
  `);
  const web = join(output, 'web');
  await buildWeb({ entry: probe, outdir: web, minify: true });
  const meta = JSON.parse(await readFile(join(web, 'bundle-meta.json'), 'utf8'));
  assert.doesNotMatch(Object.keys(meta.inputs).join('\n'), /pi-agent-core|pi-ai\/dist\/(?:auth|api|providers)/);
  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'");
      res.end('<script type="module" src="/app.js"></script>');
    } else if (['/app.js', '/presentation.js', '/override.js'].includes(req.url ?? '')) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(join(req.url === '/app.js' ? web : output, req.url!.slice(1))));
    } else res.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
    await t.test(name, async t => {
      let executablePath = engine.executablePath();
      if (!existsSync(executablePath) && name === 'chromium') {
        const cache = join(homedir(), '.cache/ms-playwright');
        for (const version of (await readdir(cache).catch(() => [])).filter(v => /^chromium-/.test(v)).sort().reverse()) {
          for (const platform of ['chrome-linux64', 'chrome-linux']) {
            const candidate = join(cache, version, platform, 'chrome');
            if (existsSync(candidate)) { executablePath = candidate; break; }
          }
          if (existsSync(executablePath)) break;
        }
      }
      if (!existsSync(executablePath)) { t.skip(`Install Playwright ${name} to run presentation integration`); return; }
      const browser = await engine.launch({ executablePath, headless: true });
      t.after(() => browser.close());
      const page = await browser.newPage();
      const errors: string[] = [], external: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      await page.goto(origin);
      await page.waitForFunction(() => '__bundleProbe' in globalThis, undefined, { timeout: 20_000 });
      const result = await page.evaluate(() => (globalThis as any).__bundleProbe);
      assert.equal(result.error, undefined, result.error);
      assert.equal(result.ok, true);
      assert.equal(result.factories, 2);
      assert.equal(result.sessions, 2);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, [], 'Unknown native import attempted a network request');
    });
  }
});

test('presentation bundler rejects runtime-only imports, failed factories, and non-file roots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-presentation-rejection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'extension.ts');
  await writeFile(path, `import { Agent } from '@earendil-works/pi-agent-core'; export default function () { globalThis.__forbiddenPresentationAgent = Agent; }`);
  await assert.rejects(bundlePresentation([path]), /cannot import runtime-only module/);
  delete (globalThis as any).__forbiddenPresentationAgent;
  await writeFile(path, `export default function () { throw new Error('FACTORY_REJECTED'); }`);
  await assert.rejects(bundlePresentation([path]), /Presentation trace failed:[\s\S]*FACTORY_REJECTED/);
  await assert.rejects(bundlePresentation([dir]), /trusted extension file/);
  await mkdir(join(dir, 'nested'));
  // An absolute public entry must also reuse the app namespace, not embed another Text class.
  await writeFile(path, `import { Text } from ${JSON.stringify(fileURLToPath(import.meta.resolve('@earendil-works/pi-tui')))};
    export default function (pi) { pi.registerMessageRenderer('absolute', () => new Text('absolute', 0, 0)); }`);
  const absolute = await bundlePresentation([path]);
  assert.match(absolute.bundle, /@earendil-works\/pi-tui/);
  await writeFile(path, 'export default function () {}');
  assert.equal((await bundlePresentation([path])).tracedModules.length, 0, 'Failed traces must restore/release their loader context');
});
