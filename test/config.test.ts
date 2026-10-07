import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { configPath, defaultCwd, defaultHost, loadConfig, parseConfig } from '../src/config.js';

test('config path follows XDG_CONFIG_HOME and ignores relative values', () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'), '/xdg/pi-remote/config.json');
  assert.equal(configPath({}, '/home/u'), '/home/u/.config/pi-remote/config.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '' }, '/home/u'), '/home/u/.config/pi-remote/config.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: 'relative' }, '/home/u'), '/home/u/.config/pi-remote/config.json');
});

test('config parsing validates the host and cwd and rejects unknown keys', () => {
  assert.deepEqual(parseConfig('{"host":"devbox"}', 'c'), { host: 'devbox', cwd: undefined });
  assert.deepEqual(parseConfig('{"host":"devbox","cwd":"~/project"}', 'c'), { host: 'devbox', cwd: '~/project' });
  assert.deepEqual(parseConfig('{}', 'c'), { host: undefined, cwd: undefined });
  for (const text of ['nope', '[]', 'null', '{"host":""}', '{"host":1}', '{"hots":"x"}', '{"cwd":""}', '{"cwd":[]}']) assert.throws(() => parseConfig(text, 'c'), /c/);
});

test('missing config means no default; host precedence is env then file', async t => {
  const dir = await mkdtemp('/tmp/pi-config-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(loadConfig(join(dir, 'missing.json')), {});
  assert.equal(defaultHost({ XDG_CONFIG_HOME: dir }), undefined);
  await mkdir(join(dir, 'pi-remote'));
  await writeFile(join(dir, 'pi-remote/config.json'), '{"host":"file"}');
  assert.equal(defaultHost({ XDG_CONFIG_HOME: dir }), 'file');
  assert.equal(defaultHost({ XDG_CONFIG_HOME: dir, PI_REMOTE_HOST: '' }), 'file');
  assert.equal(defaultHost({ XDG_CONFIG_HOME: dir, PI_REMOTE_HOST: 'env' }), 'env');
});

test('missing config means no default cwd; cwd precedence is env then file', async t => {
  const dir = await mkdtemp('/tmp/pi-config-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(defaultCwd({ XDG_CONFIG_HOME: dir }), undefined);
  await mkdir(join(dir, 'pi-remote'));
  await writeFile(join(dir, 'pi-remote/config.json'), '{"host":"file","cwd":"/file/dir"}');
  assert.equal(defaultCwd({ XDG_CONFIG_HOME: dir }), '/file/dir');
  assert.equal(defaultCwd({ XDG_CONFIG_HOME: dir, PI_REMOTE_CWD: '' }), '/file/dir');
  assert.equal(defaultCwd({ XDG_CONFIG_HOME: dir, PI_REMOTE_CWD: '/env/dir' }), '/env/dir');
});
