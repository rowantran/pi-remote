import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MAX_PRESENTATION_BUNDLE_BYTES, ServerPresentation, presentationHash } from '../../src/web/server/presentation.js';
import { MAX_PRESENTATION_SOURCE_BYTES } from '../../src/protocol/presentation-files.js';

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pi-presentation-provider-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, '.config', 'pi-remote', 'config.json');
  const agent = join(home, 'custom-agent');
  const calls = join(home, 'calls.jsonl');
  await mkdir(dirname(config), { recursive: true });
  await mkdir(join(agent, 'themes'), { recursive: true });
  const env = { ...process.env, XDG_CONFIG_HOME: join(home, '.config'), PI_CODING_AGENT_DIR: agent };
  const provider = new ServerPresentation({ home, env });
  const history = async () => (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { home, config, agent, calls, env, provider, history };
}

function countedFactory(calls: string, label: string): string {
  return `import { appendFileSync } from 'node:fs';
    export default function () { appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ pid: process.pid, label: ${JSON.stringify(label)} }) + '\\n'); }`;
}

function clientFile(home: string) { return join(home, '.config', 'pi-remote', 'config.json'); }
function settingsFile(home: string) { return join(home, '.pi', 'agent', 'settings.json'); }

test('provider uses ordinary config paths, relative/~/ extensions, and only safe browser fields', async t => {
  const f = await fixture(t);
  const relative = join(dirname(f.config), 'relative.ts');
  const tilde = join(f.home, 'tilde.ts');
  await writeFile(relative, countedFactory(f.calls, 'RELATIVE_FACTORY'));
  await writeFile(tilde, countedFactory(f.calls, 'TILDE_FACTORY'));
  await writeFile(f.config, JSON.stringify({ extensions: ['./relative.ts', '~/tilde.ts'], theme: 'custom', bell: false, sideSplit: 'down', host: 'PRIVATE_HOST', cwd: '/PRIVATE_CWD' }));
  await writeFile(join(f.agent, 'settings.json'), JSON.stringify({ theme: 'custom', hideThinkingBlock: true, doubleEscapeAction: 'tree', apiKey: 'PRIVATE_API_KEY', providers: ['PRIVATE_PROVIDER'] }));
  await writeFile(join(f.agent, 'themes', 'custom.json'), JSON.stringify({ name: 'custom', colors: { text: '#abcdef' }, apiKey: 'PRIVATE_THEME_KEY' }));
  const result = await f.provider.read();
  assert.ok(result.bundle);
  assert.equal(result.config.home, f.home);
  assert.deepEqual(result.config.presentation?.extensions, [relative, tilde]);
  assert.equal(result.config.presentation?.hash, presentationHash(result.bundle));
  assert.equal(result.config.presentation?.bundleBytes, Buffer.byteLength(result.bundle));
  assert.ok(Buffer.byteLength(result.bundle) < MAX_PRESENTATION_BUNDLE_BYTES);
  assert.deepEqual(JSON.parse(result.config.files[clientFile(f.home)]), { theme: 'custom', bell: false, sideSplit: 'down' });
  assert.deepEqual(JSON.parse(result.config.files[settingsFile(f.home)]), { theme: 'custom', hideThinkingBlock: true, doubleEscapeAction: 'tree' });
  assert.deepEqual(JSON.parse(result.config.files[join(f.home, '.pi', 'agent', 'themes', 'custom.json')]), { name: 'custom', colors: { text: '#abcdef' } });
  assert.doesNotMatch(JSON.stringify(result.config.files), /PRIVATE_|extensions|relative\.ts|tilde\.ts/);
  assert.equal((await f.history()).length, 2);
  assert.ok((await f.history()).every(call => call.pid !== process.pid), 'Factories must never execute in the server process');
});

test('explicit UI config replaces default selection and reloads settings/themes without rebuilding code', async t => {
  const f = await fixture(t);
  const custom = join(f.home, 'explicit.json');
  await writeFile(join(f.home, 'extension.ts'), countedFactory(f.calls, 'EXPLICIT_FACTORY'));
  await writeFile(f.config, JSON.stringify({ extensions: ['/never/load.ts'], theme: 'dark', bell: true }));
  await writeFile(custom, JSON.stringify({ extensions: ['./extension.ts'], theme: 'light', bell: false }));
  const previousCwd = process.cwd();
  t.after(() => process.chdir(previousCwd));
  process.chdir(f.home);
  const provider = new ServerPresentation({ home: f.home, env: f.env, uiConfig: 'explicit.json' });
  const first = await provider.read();
  await writeFile(custom, JSON.stringify({ extensions: ['./extension.ts'], theme: 'custom', bell: true }));
  await writeFile(join(f.agent, 'settings.json'), JSON.stringify({ hideThinkingBlock: true, doubleEscapeAction: 'none' }));
  await writeFile(join(f.agent, 'themes', 'custom.json'), JSON.stringify({ name: 'custom', colors: { text: '#123456' } }));
  const next = await provider.read();
  assert.equal(next.bundle, first.bundle);
  assert.equal((await f.history()).length, 1, 'Preference changes do not retrace unchanged source');
  assert.deepEqual(JSON.parse(next.config.files[clientFile(f.home)]), { theme: 'custom', bell: true });
  assert.deepEqual(JSON.parse(next.config.files[settingsFile(f.home)]), { hideThinkingBlock: true, doubleEscapeAction: 'none' });
  const theme = join(f.home, '.pi', 'agent', 'themes', 'custom.json');
  assert.equal(JSON.parse(next.config.files[theme]).colors.text, '#123456');
  await writeFile(join(f.agent, 'themes', 'custom.json'), JSON.stringify({ name: 'custom', colors: { text: '#654321' } }));
  assert.equal(JSON.parse((await provider.read()).config.files[theme]).colors.text, '#654321');
  await rm(join(f.agent, 'themes', 'custom.json'));
  assert.equal((await provider.read()).config.files[theme], undefined);
});

test('source content edits rebuild static and nested dynamic dependency graphs in fresh processes', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'extension.ts');
  const staticPath = join(f.home, 'static.ts');
  const dynamicPath = join(f.home, 'dynamic.ts');
  const nestedPath = join(f.home, 'nested.ts');
  const nestedStaticPath = join(f.home, 'nested-static.ts');
  await writeFile(staticPath, `export const label = 'STATIC_ONE';`);
  await writeFile(nestedStaticPath, `export const label = 'NESTED_ONE';`);
  await writeFile(nestedPath, `import { label } from './nested-static.ts'; export default label;`);
  await writeFile(dynamicPath, `import { createJiti } from 'jiti';
    export default async function () { const loader = createJiti(import.meta.url); return loader.import(${JSON.stringify(nestedPath)}, { default: true }); }`);
  await writeFile(entry, `import { appendFileSync } from 'node:fs'; import { createJiti } from 'jiti'; import { label } from './static.ts';
    export default async function () { const loader = createJiti(import.meta.url);
      const dynamic = await loader.import(${JSON.stringify(dynamicPath)}, { default: true });
      appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify({ pid: process.pid, label, nested: await dynamic() }) + '\\n'); }`);
  await writeFile(f.config, JSON.stringify({ extensions: [entry] }));
  const first = await f.provider.read();
  assert.equal((await f.provider.read()).bundle, first.bundle);
  assert.equal((await f.history()).length, 1);
  await writeFile(staticPath, `export const label = 'STATIC_TWO';`);
  const second = await f.provider.read();
  assert.notEqual(second.bundle, first.bundle);
  await writeFile(nestedStaticPath, `export const label = 'NESTED_TWO';`);
  const third = await f.provider.read();
  assert.notEqual(third.bundle, second.bundle);
  await writeFile(nestedPath, `import { label } from './nested-static.ts'; export default label + ':EDIT';`);
  const fourth = await f.provider.read();
  assert.notEqual(fourth.bundle, third.bundle);
  const calls = await f.history();
  assert.deepEqual(calls.map(({ label, nested }) => [label, nested]), [
    ['STATIC_ONE', 'NESTED_ONE'], ['STATIC_TWO', 'NESTED_ONE'], ['STATIC_TWO', 'NESTED_TWO'], ['STATIC_TWO', 'NESTED_TWO:EDIT'],
  ]);
  assert.equal(new Set(calls.map(call => call.pid)).size, 4, 'Every rebuild gets a fresh module cache/process');
});

test('editing a loaded source during a trace rejects that generation instead of caching mismatched bytes', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'extension.ts');
  const ready = join(f.home, 'ready.json');
  const resume = join(f.home, 'resume.json');
  await writeFile(f.config, JSON.stringify({ extensions: [entry] }));
  await writeFile(entry, `import { watch, writeFileSync, renameSync } from 'node:fs';
    export default async function () {
      const resumed = new Promise(resolve => {
        const watcher = watch(${JSON.stringify(f.home)}, (_event, name) => {
          if (name === 'resume.json') { watcher.close(); resolve(); }
        });
      });
      writeFileSync(${JSON.stringify(f.calls)}, 'ready');
      renameSync(${JSON.stringify(f.calls)}, ${JSON.stringify(ready)});
      await resumed;
    }`);
  const started = new Promise<void>(accept => {
    const watcher = watch(f.home, (_event, name) => { if (name === 'ready.json') { watcher.close(); accept(); } });
    t.after(() => watcher.close());
  });
  const rejected = assert.rejects(f.provider.read(), /sources changed during build/);
  await started;
  await writeFile(entry, countedFactory(f.calls, 'EDITED_DURING_TRACE'));
  await writeFile(resume, 'resume');
  await rejected;
  const recovered = await f.provider.read();
  assert.ok(recovered.bundle);
  assert.match(recovered.bundle, /EDITED_DURING_TRACE/);
  assert.equal((await f.history()).length, 1);
});

test('concurrent requests deduplicate builds and failures; fixed or removed config recovers without stale bundles', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'extension.ts');
  const original = countedFactory(f.calls, 'FACTORY_FIRST');
  await writeFile(entry, original);
  await writeFile(f.config, JSON.stringify({ extensions: [entry] }));
  const results = await Promise.all(Array.from({ length: 8 }, () => f.provider.read()));
  assert.ok(results.every(result => result.bundle === results[0].bundle));
  assert.equal((await f.history()).length, 1);
  await writeFile(entry, countedFactory(f.calls, 'FACTORY_ERROR').replace('function () {', "function () { throw new Error('BROKEN_FACTORY');"));
  const failed = await Promise.allSettled(Array.from({ length: 8 }, () => f.provider.read()));
  assert.ok(failed.every(result => result.status === 'rejected' && /BROKEN_FACTORY/.test(String(result.reason))));
  await writeFile(entry, countedFactory(f.calls, 'FACTORY_FIXED'));
  const recovered = await f.provider.read();
  assert.notEqual(recovered.bundle, results[0].bundle);
  assert.equal((await f.history()).length, 2);
  await writeFile(f.config, '{bad JSON');
  await assert.rejects(f.provider.read(), /Invalid presentation config/);
  await writeFile(f.config, JSON.stringify({ extensions: [entry] }));
  assert.ok((await f.provider.read()).bundle);
  assert.equal((await f.history()).length, 3);
  await rm(entry);
  await assert.rejects(f.provider.read(), /ENOENT/);
  await writeFile(entry, original);
  assert.ok((await f.provider.read()).bundle);
  await writeFile(f.config, JSON.stringify({ bell: false }));
  const cleared = await f.provider.read();
  assert.equal(cleared.bundle, undefined);
  assert.equal(cleared.config.presentation, undefined);
  await rm(f.config);
  const missing = await f.provider.read();
  assert.equal(missing.bundle, undefined);
  assert.deepEqual(JSON.parse(missing.config.files[clientFile(f.home)]), {});
});

test('deleted static or dynamic dependencies fail instead of serving stale code and recover after repair', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'extension.ts');
  const dependency = join(f.home, 'dependency.ts');
  const staticDependency = join(f.home, 'static.ts');
  const source = `export default 'DEPENDENCY_VALUE';`;
  const staticSource = `export default 'STATIC_VALUE';`;
  await writeFile(dependency, source);
  await writeFile(staticDependency, staticSource);
  await writeFile(entry, `import { createJiti } from 'jiti'; import label from './static.ts'; export default async function () {
    if (!label) throw new Error('Missing static dependency');
    const loader = createJiti(import.meta.url); await loader.import(${JSON.stringify(dependency)}); }`);
  await writeFile(f.config, JSON.stringify({ extensions: [entry] }));
  const first = await f.provider.read();
  await rm(staticDependency);
  await assert.rejects(f.provider.read(), /ENOENT|Cannot find/);
  await writeFile(staticDependency, staticSource);
  assert.equal((await f.provider.read()).bundle, first.bundle);
  await rm(dependency);
  await assert.rejects(f.provider.read(), /ENOENT|Cannot find/);
  await writeFile(dependency, source);
  assert.equal((await f.provider.read()).bundle, first.bundle);
  await writeFile(entry, countedFactory(f.calls, 'IMPORTS_REMOVED'));
  await rm(staticDependency);
  await rm(dependency);
  const removedImports = await f.provider.read();
  assert.ok(removedImports.bundle, 'Removing imports and their files together must succeed on the first reload');
  assert.doesNotMatch(removedImports.bundle, /STATIC_VALUE|DEPENDENCY_VALUE/);
});

test('a stalled trace is killed at its deadline, excludes inherited Node flags, and recovers', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'extension.ts');
  const ready = join(f.home, 'ready.json');
  await writeFile(f.config, JSON.stringify({ extensions: [entry] }));
  await writeFile(entry, `import { writeFileSync, renameSync } from 'node:fs';
    export default async function () {
      writeFileSync(${JSON.stringify(f.calls)}, JSON.stringify({ pid: process.pid, args: process.execArgv, nodeOptions: process.env.NODE_OPTIONS }));
      renameSync(${JSON.stringify(f.calls)}, ${JSON.stringify(ready)});
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }`);
  const started = new Promise<void>(accept => {
    const watcher = watch(f.home, (_event, name) => { if (name === 'ready.json') { watcher.close(); accept(); } });
    t.after(() => watcher.close());
  });
  const env = { ...f.env, NODE_OPTIONS: '--inspect=0' };
  const provider = new ServerPresentation({ home: f.home, env });
  // A filesystem readiness signal, not a sleep, proves the child is executing its factory.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = provider.read();
  const rejected = assert.rejects(pending, /timed out/);
  await started;
  const child = JSON.parse(await readFile(ready, 'utf8'));
  assert.equal(child.nodeOptions, undefined);
  assert.ok(child.args.every((arg: string) => !/^--(?:test|inspect)/.test(arg)));
  t.mock.timers.tick(30_000);
  await rejected;
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  t.mock.timers.reset();
  await writeFile(entry, `export default function () {}`);
  assert.ok((await provider.read()).bundle);
});

test('source/config reads and trace output are bounded', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'extension.ts');
  await writeFile(f.config, JSON.stringify({ extensions: [entry] }));
  await writeFile(entry, ' '.repeat(MAX_PRESENTATION_SOURCE_BYTES + 1));
  await assert.rejects(f.provider.read(), /regular file at most/);
  await writeFile(entry, `export default function () { console.log('x'.repeat(70 * 1024)); }`);
  await assert.rejects(f.provider.read(), /output exceeds limit/);
  await writeFile(entry, `export default function () {}`);
  assert.ok((await f.provider.read()).bundle, 'An output-bound failure must not poison future reloads');
  await writeFile(f.config, ' '.repeat(128 * 1024 + 1));
  await assert.rejects(f.provider.read(), /regular file at most/);
});
