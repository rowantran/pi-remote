import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { REMOTE_INSTALL_SCRIPT } from '../../scripts/deploy.js';

const NAME = '20261008T153000Z-9f6e91e';

/**
 * Run the real remote install script against a private HOME. npm and systemctl are fakes placed
 * first on PATH, and the user bus is unreachable, so this never touches a real service.
 */
async function install(t: TestContext, web: 'active' | 'inactive', restart: 'ok' | 'fail' = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'pi-remote-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), fakes = join(root, 'fakes'), payload = join(root, 'payload');
  const base = join(home, '.local/share/pi-remote');
  const releases = join(base, 'releases'), link = join(base, 'bin/pi-remote');
  const calls = join(root, 'systemctl.log');
  for (const dir of [fakes, join(payload, 'bin'), join(base, 'bin')]) await mkdir(dir, { recursive: true });
  const executable = async (path: string, body: string) => { await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755); };
  await executable(join(payload, 'bin/pi-remote'), 'exit 0');
  await executable(join(fakes, 'npm'), 'exit 0');
  // Record where the launcher points and whether the oldest release still exists at restart time.
  await executable(join(fakes, 'systemctl'), `
case "$*" in
  "--user --quiet is-active pi-remote-web.service") [ "$FAKE_WEB" = active ] && exit 0; exit 3 ;;
  "--user restart pi-remote-web.service")
    old=missing; [ -d "$FAKE_RELEASES/old" ] && old=present
    printf 'restart %s %s\\n' "$(readlink -f "$FAKE_LINK")" "$old" >> "$FAKE_CALLS"
    [ "$FAKE_RESTART" = ok ] ;;
  *) printf 'unexpected %s\\n' "$*" >> "$FAKE_CALLS"; exit 64 ;;
esac`);
  // Two older releases: "previous" is the current link target and survives; "old" is removable.
  for (const release of ['old', 'previous']) {
    await mkdir(join(releases, release, 'bin'), { recursive: true });
    await executable(join(releases, release, 'bin/pi-remote'), 'exit 0');
  }
  await symlink(join(releases, 'previous/bin/pi-remote'), link);
  const archive = execFileSync('mktemp', ['/tmp/pi-remote-deploy.XXXXXX'], { encoding: 'utf8' }).trim();
  t.after(() => rm(archive, { force: true }));
  execFileSync('tar', ['-czf', archive, '-C', payload, 'bin']);
  const result = spawnSync('bash', ['-s', '--', archive, NAME], {
    input: REMOTE_INSTALL_SCRIPT, encoding: 'utf8',
    env: {
      PATH: `${fakes}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: join(root, 'no-runtime'),
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent', FAKE_WEB: web, FAKE_RESTART: restart,
      FAKE_RELEASES: releases, FAKE_LINK: link, FAKE_CALLS: calls,
    },
  });
  const restarts = existsSync(calls) ? (await readFile(calls, 'utf8')).trim().split('\n') : [];
  return { result, restarts, releases, link };
}

test('deploy restarts an active web service onto the new release before deleting old releases', async t => {
  const { result, restarts, releases, link } = await install(t, 'active');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(restarts, [`restart ${join(releases, NAME, 'bin/pi-remote')} present`]);
  assert.match(result.stdout, new RegExp(`Restarted pi-remote-web.service on release ${NAME}`));
  assert.equal(await readlink(link), join(releases, NAME, 'bin/pi-remote'));
  assert.ok(!existsSync(join(releases, 'old')), 'cleanup still removes unused releases after the restart');
  assert.ok(existsSync(join(releases, 'previous')));
});

test('deploy leaves a stopped web service stopped', async t => {
  const { result, restarts, releases } = await install(t, 'inactive');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(restarts, []);
  assert.ok(!existsSync(join(releases, 'old')));
});

test('a failed web restart keeps the switched release and skips release cleanup', async t => {
  const { result, restarts, releases, link } = await install(t, 'active', 'fail');
  assert.notEqual(result.status, 0);
  assert.equal(restarts.length, 1);
  assert.match(result.stderr, new RegExp(`Release ${NAME} is installed, but pi-remote-web.service did not restart; see journalctl --user -u pi-remote-web.service`));
  assert.equal(await readlink(link), join(releases, NAME, 'bin/pi-remote'));
  assert.ok(existsSync(join(releases, 'old')), 'no release is deleted while the web service state is unknown');
});
