import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfig } from '../../src/config/client.js';
import { readPresentationConfig } from '../../src/config/presentation.js';
import { defaultBrowserConfig, MAX_THEME_BYTES } from '../../src/web/server/browser-config.js';

test('browser config exposes only safe settings, pinned themes, bounded custom themes, and virtual client settings', async t => {
  const home = await mkdtemp('/tmp/pi-web-config-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const themes = join(home, '.pi', 'agent', 'themes');
  await mkdir(themes, { recursive: true });
  await mkdir(join(home, '.config', 'pi-remote'), { recursive: true });
  await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
    theme: 'custom', hideThinkingBlock: true, doubleEscapeAction: 'tree',
    apiKey: 'DO_NOT_EXPORT_API_KEY', providers: { private: 'DO_NOT_EXPORT_PROVIDER' }, extensions: ['/private/plugin.ts'],
  }));
  await writeFile(join(home, '.config', 'pi-remote', 'config.json'), JSON.stringify({
    theme: 'custom', bell: false, sideSplit: 'down', extensions: ['/private/plugin.ts'], host: 'private-host', cwd: '/private/project', apiKey: 'DO_NOT_EXPORT_CLIENT_KEY',
  }));
  await writeFile(join(themes, 'custom.json'), JSON.stringify({ name: 'custom', appearance: 'dark', colors: { text: '#ffffff' }, vars: { accent: '#abcdef' }, apiKey: 'DO_NOT_EXPORT_THEME_KEY' }));
  await writeFile(join(themes, 'dark.json'), JSON.stringify({ name: 'dark', colors: { text: 'DO_NOT_OVERRIDE_BUILTIN' } }));
  await writeFile(join(themes, 'oversized.json'), ' '.repeat(MAX_THEME_BYTES + 1));
  await writeFile(join(themes, 'malformed.json'), '{broken');
  await symlink(join(home, '.pi', 'agent', 'settings.json'), join(themes, 'symlink.json'));
  const config = await defaultBrowserConfig({ home, env: {} });
  assert.equal(config.home, home);
  assert.deepEqual(JSON.parse(config.files[join(home, '.pi', 'agent', 'settings.json')]), { theme: 'custom', hideThinkingBlock: true, doubleEscapeAction: 'tree' });
  assert.deepEqual(JSON.parse(config.files[join(home, '.config', 'pi-remote', 'config.json')]), { theme: 'custom', bell: false, sideSplit: 'down' });
  assert.deepEqual(JSON.parse(config.files[join(themes, 'custom.json')]), { name: 'custom', appearance: 'dark', vars: { accent: '#abcdef' }, colors: { text: '#ffffff' } });
  const builtinDir = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'modes', 'interactive', 'theme');
  for (const name of ['dark', 'light']) {
    const builtin = JSON.parse(await readFile(join(builtinDir, `${name}.json`), 'utf8'));
    assert.deepEqual(JSON.parse(config.files[join(themes, `${name}.json`)]).colors, builtin.colors);
  }
  assert.equal(config.files[join(themes, 'oversized.json')], undefined);
  assert.equal(config.files[join(themes, 'malformed.json')], undefined);
  assert.equal(config.files[join(themes, 'symlink.json')], undefined);
  assert.doesNotMatch(JSON.stringify(config), /DO_NOT_EXPORT|DO_NOT_OVERRIDE|private\/plugin|private-host|private\/project/);
});

test('normal web deployment config and explicit Pi directory overrides expose only canonical display files', async t => {
  const home = await mkdtemp('/tmp/pi-web-config-path-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const agent = join(home, 'agent-elsewhere');
  const xdg = join(home, 'xdg');
  const uiConfig = join(home, 'phone-config.json');
  await mkdir(join(agent, 'themes'), { recursive: true });
  await mkdir(join(xdg, 'pi-remote'), { recursive: true });
  const normalPath = join(xdg, 'pi-remote', 'config.json');
  const normalSettings = {
    theme: 'dark', bell: true,
    web: { allowUsers: ['PRIVATE_LOGIN@example.com'], origin: 'https://private-web.example.ts.net' },
  };
  await writeFile(normalPath, JSON.stringify(normalSettings));
  assert.deepEqual(loadConfig(normalPath), normalSettings);
  await writeFile(uiConfig, JSON.stringify({ theme: 'custom/light', bell: false, host: 'PRIVATE_HOST', extensions: ['/PRIVATE_EXTENSION'] }));
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ hideThinkingBlock: true, apiKey: 'PRIVATE_KEY' }));
  await writeFile(join(agent, 'themes', 'custom.json'), JSON.stringify({ name: 'custom', colors: { text: '#123456' } }));
  const env = { XDG_CONFIG_HOME: xdg, PI_CODING_AGENT_DIR: '~/agent-elsewhere' };
  const presentation = await readPresentationConfig(undefined, [], { home, env });
  assert.deepEqual(presentation, { extensions: [], theme: 'dark', bell: true });
  const normal = await defaultBrowserConfig({ home, env });
  const virtualConfig = join(home, '.config', 'pi-remote', 'config.json');
  assert.deepEqual(JSON.parse(normal.files[virtualConfig]), { theme: 'dark', bell: true });
  assert.doesNotMatch(JSON.stringify(normal), /PRIVATE_LOGIN|private-web|allowUsers|origin/);
  const fromPresentation = await defaultBrowserConfig({ home, env, config: presentation });
  assert.deepEqual(fromPresentation, normal);
  const explicit = await defaultBrowserConfig({ home, env, uiConfig });
  assert.deepEqual(JSON.parse(explicit.files[virtualConfig]), { theme: 'custom/light', bell: false });
  assert.deepEqual(JSON.parse(explicit.files[join(home, '.pi', 'agent', 'settings.json')]), { hideThinkingBlock: true });
  assert.deepEqual(JSON.parse(explicit.files[join(home, '.pi', 'agent', 'themes', 'custom.json')]).colors, { text: '#123456' });
  assert.ok(Object.keys(explicit.files).every(path => !path.startsWith(agent) && !path.startsWith(xdg)));
  assert.doesNotMatch(JSON.stringify(explicit), /PRIVATE_/);
  const linked = join(home, 'dotfiles-config.json');
  await symlink(uiConfig, linked);
  const fromDotfiles = await defaultBrowserConfig({ home, env, uiConfig: linked });
  assert.deepEqual(JSON.parse(fromDotfiles.files[virtualConfig]), { theme: 'custom/light', bell: false });
});

test('custom theme inventory and individual input reads are bounded', async t => {
  const home = await mkdtemp('/tmp/pi-web-theme-limit-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const themes = join(home, '.pi', 'agent', 'themes');
  await mkdir(themes, { recursive: true });
  await Promise.all(Array.from({ length: 45 }, (_, i) => writeFile(join(themes, `theme-${i}.json`), JSON.stringify({ name: `theme-${i}`, colors: { text: '#ffffff' } }))));
  await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ theme: '/etc/passwd', hideThinkingBlock: 'true', doubleEscapeAction: 'run_code' }));
  const config = await defaultBrowserConfig({ home, env: {} });
  assert.equal(Object.keys(config.files).filter(path => path.includes('/themes/')).length, 34); // 32 custom + 2 pinned
  assert.deepEqual(JSON.parse(config.files[join(home, '.pi', 'agent', 'settings.json')]), {});
  assert.deepEqual(JSON.parse(config.files[join(home, '.config', 'pi-remote', 'config.json')]), {});
});

test('browser settings accept theme names and light/dark pairs, but never paths', async t => {
  const home = await mkdtemp('/tmp/pi-web-theme-pair-');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  await mkdir(join(home, '.config', 'pi-remote'), { recursive: true });
  for (const selection of ['gruvbox-light/gruvbox-dark', 'light', 'system', '../dark', 'light/', 'a/b/c', '/etc/passwd']) {
    await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ theme: selection }));
    await writeFile(join(home, '.config', 'pi-remote', 'config.json'), JSON.stringify({ theme: selection }));
    const config = await defaultBrowserConfig({ home, env: {} });
    const expected = ['gruvbox-light/gruvbox-dark', 'light', 'system'].includes(selection) ? { theme: selection } : {};
    assert.deepEqual(JSON.parse(config.files[join(home, '.pi', 'agent', 'settings.json')]), expected);
    assert.deepEqual(JSON.parse(config.files[join(home, '.config', 'pi-remote', 'config.json')]), expected);
  }
});
