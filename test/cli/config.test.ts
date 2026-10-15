import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { configPath, defaultCwd, defaultHost, loadConfig, parseConfig } from '../../src/cli/config.js';
import type { WebConfig } from '../../src/config/client.js';

test('config path follows XDG_CONFIG_HOME and ignores relative values', () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'), '/xdg/pi-remote/config.json');
  assert.equal(configPath({}, '/home/u'), '/home/u/.config/pi-remote/config.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '' }, '/home/u'), '/home/u/.config/pi-remote/config.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: 'relative' }, '/home/u'), '/home/u/.config/pi-remote/config.json');
});

test('config parsing validates the host and cwd and rejects unknown keys', () => {
  assert.deepEqual(parseConfig('{"host":"devbox"}', 'c'), { host: 'devbox' });
  assert.deepEqual(parseConfig('{"host":"devbox","cwd":"~/project"}', 'c'), { host: 'devbox', cwd: '~/project' });
  assert.deepEqual(parseConfig('{}', 'c'), {});
  for (const text of ['nope', '[]', 'null', '{"host":""}', '{"host":1}', '{"hots":"x"}', '{"cwd":""}', '{"cwd":[]}']) assert.throws(() => parseConfig(text, 'c'), /c/);
});

test('web deployment is absent by default and preserves explicit exact logins and HTTPS origins', () => {
  assert.equal(parseConfig('{}', 'config.json').web, undefined);
  assert.equal(parseConfig('{"host":"owner-host"}', 'config.json').web, undefined);
  const valid: WebConfig[] = [
    { allowUsers: ['alice@example.com'] },
    { allowUsers: ['Alice.Example+phone@example.com', 'github-user@github'] },
    { allowUsers: ['alice@example.com', 'alice@example.com'] },
    { allowUsers: Array.from({ length: 100 }, (_, i) => `user${i}@example.com`) },
    { allowUsers: [`${'a'.repeat(244)}@example.com`] },
    { allowUsers: ['alice@example.com'], origin: 'https://phone.example.ts.net' },
    { allowUsers: ['alice@example.com'], origin: 'https://phone.example.ts.net:8443' },
    { allowUsers: ['alice@example.com'], origin: 'https://[::1]:8443' },
  ];
  for (const web of valid) {
    assert.deepEqual(parseConfig(JSON.stringify({ host: 'devbox', web }), 'config.json'), { host: 'devbox', web });
  }
});

test('web deployment rejects malformed objects, implicit access, and unknown nested keys with config paths', () => {
  const cases: { web: unknown; key: string }[] = [
    ...[null, true, false, 1, 'enabled', [], [{ allowUsers: ['alice@example.com'] }]].map(web => ({ web, key: 'web' })),
    ...[{}, { origin: 'https://phone.example.ts.net' }].map(web => ({ web, key: 'web.allowUsers' })),
    ...[null, 'alice@example.com', true, 1, {}, [], [''], [null], [1], [false], [{}], [['alice@example.com']],
      ['-not-an-option'], ['*'], ['*@example.com'], ['alice*@example.com'], [' alice@example.com'], ['alice@example.com '],
      ['alice @example.com'], ['alice\t@example.com'], ['alice\n@example.com'], ['alice\r@example.com'],
      ['alice\x00@example.com'], ['alice\x1f@example.com'], ['alice\x7f@example.com'], ['alice\x85@example.com'],
      ['\u00a0alice@example.com'], ['alice@example.com\u2003'], ['alice@example.com', '*'],
      Array.from({ length: 101 }, () => 'alice@example.com'), [`${'a'.repeat(245)}@example.com`],
    ].map(allowUsers => ({ web: { allowUsers }, key: 'web.allowUsers' })),
    ...['allowedUsers', 'allowUser', 'owner', 'skip', 'enabled', '__proto__'].map(key => ({
      web: { allowUsers: ['alice@example.com'], [key]: true }, key: `web.${key}`,
    })),
  ];
  const path = '/tmp/pi-config-fixture/config.json';
  for (const { web, key } of cases) {
    assert.throws(() => parseConfig(JSON.stringify({ web }), path), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path), error.message);
      assert.ok(error.message.includes(key), error.message);
      return true;
    }, JSON.stringify(web));
  }
});

test('web origin accepts only an exact HTTPS origin and reports its config path', () => {
  const path = '/tmp/pi-config-fixture/config.json';
  for (const origin of [
    null, true, 1, [], {}, '', 'not-a-url', 'http://phone.example.ts.net', 'http://localhost',
    'https://phone.example.ts.net/', 'https://phone.example.ts.net/path', 'https://phone.example.ts.net/.',
    'https://user@phone.example.ts.net', 'https://user:password@phone.example.ts.net',
    'https://phone.example.ts.net?query=1', 'https://phone.example.ts.net#fragment',
    'https://phone.example.ts.net?', 'https://phone.example.ts.net#',
    ' https://phone.example.ts.net', 'https://phone.example.ts.net ', 'https://phone.example.ts.net\n',
    'HTTPS://phone.example.ts.net', 'https://PHONE.example.ts.net', 'https://phone.example.ts.net:443',
    'https://phone.\texample.ts.net', 'https://',
  ]) {
    assert.throws(() => parseConfig(JSON.stringify({ web: { allowUsers: ['alice@example.com'], origin } }), path), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path), error.message);
      assert.ok(error.message.includes('web.origin'), error.message);
      return true;
    }, JSON.stringify(origin));
  }
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
