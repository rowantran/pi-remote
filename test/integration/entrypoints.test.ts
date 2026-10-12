import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { attachInvocation, type AttachInvocation } from '../../src/tui/side-launcher.js';
import { PI_VERSION } from '../../src/protocol/types.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const sourceBin = join(repo, 'bin/pi-remote');
const slotId = '8844ca51-7b8d-47da-b1b9-3e111d70779b';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp('/tmp/pi-entry-'));
  const cwd = join(root, 'foreign-cwd');
  const stateDir = join(root, 'state');
  await mkdir(cwd);
  await mkdir(stateDir, { mode: 0o700 });
  // Loading the caller's config must fail. The source bin must pin its own config,
  // including in the detached daemon and completion worker subprocesses.
  const hostileConfig = join(cwd, 'tsconfig.json');
  await writeFile(hostileConfig, JSON.stringify({ extends: './must-not-be-loaded.json' }));
  const pi = join(root, 'version-only-pi');
  await writeFile(pi, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--version') process.exit(99);\nconsole.log(${JSON.stringify(PI_VERSION)});\n`, { mode: 0o700 });
  const env = {
    ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'),
    PI_CODING_AGENT_DIR: join(root, 'agent'), PI_REMOTE_HOST: '', PI_REMOTE_CWD: '',
    PI_REMOTE_PI_BIN: pi, TSX_TSCONFIG_PATH: hostileConfig,
  };
  t.after(async () => {
    try {
      const pid = Number(await readFile(join(stateDir, 'daemon.lock/pid'), 'utf8'));
      assert.ok(pid > 0);
      try { process.kill(pid, 'SIGTERM'); }
      catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      for (let i = 0; i < 100 && existsSync(join(stateDir, 'daemon.lock')); i++) await delay(50);
      assert.equal(existsSync(join(stateDir, 'daemon.lock')), false, 'isolated daemon must stop before cleanup');
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, cwd, stateDir, env };
}

async function exercise(bin: string, side: AttachInvocation, f: Awaited<ReturnType<typeof fixture>>) {
  const run = async (args: string[]) => {
    try { return await exec(process.execPath, [bin, ...args], { cwd: f.cwd, env: f.env, timeout: 30_000 }); }
    catch (error: any) {
      const log = await readFile(join(f.stateDir, 'daemon.log'), 'utf8').catch(() => '');
      if (log) error.message += `\nIsolated daemon log:\n${log}`;
      throw error;
    }
  };
  assert.match((await run(['--version'])).stdout, /^pi-remote 0\.2\.0 \(Pi /);
  assert.match((await run(['completion', 'fish'])).stdout, /complete/);

  // No slot is created: the daemon only checks the isolated stub's version.
  assert.deepEqual(JSON.parse((await run(['ls', '--local', '--json', '--state-dir', f.stateDir])).stdout), []);
  const pid = await readFile(join(f.stateDir, 'daemon.lock/pid'), 'utf8');
  assert.ok(Number(pid) > 0);
  const directory = join(f.cwd, 'completion target');
  await mkdir(directory);
  const words = ['new', '--local', '--state-dir', f.stateDir, '--cwd', join(f.cwd, 'completion')];
  const completed = await run(['complete', '--shell', 'fish', '--words', JSON.stringify(words)]);
  assert.ok(completed.stdout.includes(`${directory}/`), `completion worker returned ${JSON.stringify(completed.stdout)}`);
  assert.equal(completed.stderr, '');
  assert.equal(await readFile(join(f.stateDir, 'daemon.lock/pid'), 'utf8'), pid, 'completion must reuse the same daemon');

  assert.equal(side.command, process.execPath);
  assert.equal(side.args[0], bin, 'side attach must use the same installation');
  assert.deepEqual(side.args.slice(1), ['attach', '--local', slotId]);
  // Help follows the real attach invocation through bin without creating a TUI,
  // attaching a slot, or requiring a terminal emulator.
  const help = await exec(side.command, [...side.args, '--help'], { cwd: f.cwd, env: f.env, timeout: 30_000 });
  assert.match(help.stdout, /pi-remote/);
}

test('source bin runs from a foreign cwd despite a hostile tsconfig, including child entrypoints', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  await exercise(sourceBin, attachInvocation(slotId, { local: true }), f);
});

test('compiled release launches without src and uses its own completion, daemon, and side entrypoints', {
  timeout: 60_000,
  skip: !existsSync(join(repo, 'dist/cli/main.js')) ? 'Build dist before running compiled release coverage' : false,
}, async t => {
  const f = await fixture(t);
  const release = join(f.root, 'release');
  await mkdir(release);
  for (const name of ['dist', 'bin', 'completions', 'package.json']) {
    await cp(join(repo, name), join(release, name), { recursive: true });
  }
  // Installed runtime dependencies are shared; this release has no source or
  // tsconfig and must never fall back to the checkout's TypeScript entrypoints.
  await symlink(await realpath(join(repo, 'node_modules')), join(release, 'node_modules'), 'dir');
  assert.equal(existsSync(join(release, 'src')), false);
  assert.equal(existsSync(join(release, 'tsconfig.json')), false);
  const compiled = await import(pathToFileURL(join(release, 'dist/tui/side-launcher.js')).href);
  await exercise(join(release, 'bin/pi-remote'), compiled.attachInvocation(slotId, { local: true }), f);
});
