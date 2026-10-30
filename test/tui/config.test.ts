import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { configPath, defaultCwd, defaultHost, loadConfig, parseConfig } from '../../src/cli/config.js';
import { readPresentationConfig } from '../../src/config/presentation.js';

async function setup(t: TestContext, xdg = true) {
  const home = await mkdtemp(join(tmpdir(), 'pi-unified-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = xdg ? { XDG_CONFIG_HOME: join(home, 'xdg') } : {};
  const target = configPath(env, home);
  const oldPath = join(home, '.pi/remote-client.json');
  const options = { env, home };
  const write = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  return { home, env, target, oldPath, options, write };
}

test('one XDG config provides connection defaults and all UI settings', async t => {
  const f = await setup(t);
  const settings = { host: 'devbox', cwd: '~/project', extensions: ['./ui.ts', './ui.ts', '~/personal-ui.ts'], theme: 'light/dark', bell: false, sideSplit: 'down' };
  await f.write(f.target, settings);
  assert.deepEqual(loadConfig(f.target), settings);
  assert.equal(defaultHost(f.env), 'devbox');
  assert.equal(defaultCwd(f.env), '~/project');
  assert.deepEqual(await readPresentationConfig(undefined, ['./cli-ui.ts'], f.options), {
    extensions: [join(dirname(f.target), 'ui.ts'), join(f.home, 'personal-ui.ts'), resolve('cli-ui.ts')],
    theme: 'light/dark', bell: false, sideSplit: 'down',
  });
});

test('default UI config uses the same home fallback and ignores relative XDG_CONFIG_HOME', async t => {
  const f = await setup(t, false);
  await f.write(f.target, { theme: 'light' });
  assert.equal((await readPresentationConfig(undefined, [], f.options)).theme, 'light');
  assert.equal((await readPresentationConfig(undefined, [], { ...f.options, env: { XDG_CONFIG_HOME: 'relative' } })).theme, 'light');
});

test('a missing default config loads no adapters', async t => {
  const f = await setup(t);
  assert.deepEqual(await readPresentationConfig(undefined, [], f.options), { extensions: [], theme: undefined, bell: undefined });
});

test('the old UI path is ignored even when the XDG config is absent', async t => {
  const f = await setup(t);
  await f.write(f.oldPath, { host: 'ignored', cwd: '/ignored', extensions: ['./old-ui.ts'], theme: 'dark', bell: false, sideSplit: 'left' });
  assert.equal(defaultHost(f.env), undefined);
  assert.equal(defaultCwd(f.env), undefined);
  assert.deepEqual(await readPresentationConfig(undefined, [], f.options), { extensions: [], theme: undefined, bell: undefined });
});

test('missing UI keys in the XDG config do not fall back to the old path', async t => {
  const f = await setup(t);
  await f.write(f.oldPath, { extensions: ['./old-ui.ts'], theme: 'dark', bell: false, sideSplit: 'left' });
  await f.write(f.target, { host: 'devbox', cwd: '~/project' });
  assert.deepEqual(await readPresentationConfig(undefined, ['./cli-ui.ts'], f.options), {
    extensions: [resolve('cli-ui.ts')], theme: undefined, bell: undefined,
  });
});

test('invalid content at the old path cannot break default UI configuration', async t => {
  const f = await setup(t);
  await f.write(f.oldPath, {});
  await writeFile(f.oldPath, 'not json');
  assert.deepEqual(await readPresentationConfig(undefined, [], f.options), { extensions: [], theme: undefined, bell: undefined });
  await f.write(f.target, { extensions: ['./new-ui.ts'], theme: 'light', bell: false, sideSplit: 'auto' });
  assert.deepEqual(await readPresentationConfig(undefined, [join(dirname(f.target), 'new-ui.ts')], f.options), {
    extensions: [join(dirname(f.target), 'new-ui.ts')], theme: 'light', bell: false, sideSplit: 'auto',
  });
});

test('--ui-config replaces UI defaults only and does not inspect invalid default files', async t => {
  const f = await setup(t);
  await f.write(f.target, { host: 'devbox', cwd: '~/project', theme: 'dark', bell: false });
  const explicit = join(f.home, 'project/ui.json');
  await f.write(explicit, { host: 'not-a-connection-override', cwd: '/ignored', extensions: ['./ui.ts'] });
  assert.deepEqual(await readPresentationConfig(explicit, [], f.options), {
    extensions: [join(dirname(explicit), 'ui.ts')], theme: undefined, bell: undefined,
  });
  assert.equal(defaultHost(f.env), 'devbox');
  assert.equal(defaultCwd(f.env), '~/project');
  await f.write(f.target, { invalid: true });
  assert.equal((await readPresentationConfig(explicit, [], f.options)).extensions.length, 1);
  assert.deepEqual(await readPresentationConfig(join(f.home, 'missing.json'), [], f.options), {
    extensions: [], theme: undefined, bell: undefined,
  });
});

test('malformed selected configuration fails instead of silently discarding settings', async t => {
  const f = await setup(t);
  await f.write(f.target, { bell: 'false' });
  await assert.rejects(readPresentationConfig(undefined, [], f.options), /Invalid presentation config.*bell/);
  await writeFile(f.target, 'not json');
  await assert.rejects(readPresentationConfig(undefined, [], f.options), /Invalid presentation config.*Invalid JSON/);
});

test('shared config schema validates all six settings and rejects unknown keys', () => {
  for (const settings of [
    { extensions: 'all' }, { extensions: [''] }, { extensions: [null] }, { extensions: [1] }, { extensions: null },
    { theme: null }, { theme: 1 }, { theme: '' }, { bell: 'false' }, { bell: null },
    { sideSplit: 'horizontal' }, { sideSplit: false }, { sideSplit: null }, { extentions: [] },
  ]) assert.throws(() => parseConfig(JSON.stringify(settings), 'config.json'), /config.json/);
  for (const sideSplit of ['auto', 'right', 'down', 'left', 'up']) {
    assert.equal(parseConfig(JSON.stringify({ sideSplit }), 'c').sideSplit, sideSplit);
  }
  assert.deepEqual(parseConfig('{"extensions":[],"bell":false}', 'c'), { extensions: [], bell: false });
});
