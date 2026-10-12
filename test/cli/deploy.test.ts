import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  ARCHIVE_FILES, HELP, REMOTE_INSTALL_SCRIPT, main, parseDeployArgs,
  type DeployDependencies, type RunOptions,
} from '../../scripts/deploy.js';

type Stage = 'revision' | 'status' | 'build' | 'archive' | 'mktemp' | 'copy' | 'install' | 'restart' | 'cleanup';
interface Call { stage: Stage; command: string; args: string[]; options: RunOptions }

/** Every external dependency is fake. These tests never build, access user config, write files, or connect. */
function fixture(options: {
  dirty?: boolean;
  revision?: string;
  remotePath?: string;
  host?: string;
  failures?: Stage[];
  localCleanupFails?: boolean;
} = {}) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const logs: string[] = [], warnings: string[] = [];
  let defaults = 0, temps = 0;
  const root = '/checkout with spaces', tempDir = '/temporary archive directory';
  const deps: DeployDependencies = {
    root,
    now: () => new Date('2026-10-08T15:30:00.123Z'),
    defaultHost: async () => { defaults++; return options.host ?? 'default-box'; },
    makeTempDir: async () => { temps++; return tempDir; },
    removeTempDir: async path => {
      removed.push(path);
      if (options.localCleanupFails) throw new Error('local cleanup failed');
    },
    log: line => logs.push(line), warn: line => warnings.push(line),
    run: async (command, args, runOptions) => {
      const stage: Stage = command === 'git' ? args[0] === 'rev-parse' ? 'revision' : 'status'
        : command === 'npm' ? 'build' : command === 'tar' ? 'archive' : command === 'scp' ? 'copy'
        : command === process.execPath ? 'restart'
        : args[3] === 'bash' ? 'install' : args[3] === 'rm' ? 'cleanup' : 'mktemp';
      calls.push({ stage, command, args, options: runOptions });
      if (options.failures?.includes(stage)) throw new Error(`${stage} failed: child stderr detail`);
      if (stage === 'revision') return options.revision ?? '9f6e91e\n';
      if (stage === 'status') return options.dirty ? ' M package.json\n' : '';
      if (stage === 'mktemp') return options.remotePath ?? '/tmp/pi-remote-deploy.Ab12Z9\n';
      return '';
    },
  };
  return { deps, calls, removed, logs, warnings, root, tempDir,
    get defaults() { return defaults; }, get temps() { return temps; } };
}

const stages = (f: ReturnType<typeof fixture>) => f.calls.map(call => call.stage);

test('deploy parses optional host and mutually exclusive restart modes', () => {
  assert.deepEqual(parseDeployArgs([]), { restart: 'restart', help: false });
  assert.deepEqual(parseDeployArgs(['--wait', 'user@dev-box']), { host: 'user@dev-box', restart: 'wait', help: false });
  assert.equal(parseDeployArgs(['devbox', '--no-restart']).restart, 'none');
  assert.equal(parseDeployArgs(['-h']).help, true);
  for (const args of [['--wait', '--no-restart'], ['--no-restart', '--wait']]) {
    assert.throws(() => parseDeployArgs(args), /cannot be used together/);
  }
  assert.throws(() => parseDeployArgs(['--unknown']), /Unknown option --unknown/);
  assert.throws(() => parseDeployArgs(['box', 'other-box']), /Usage:/);
});

test('deploy --help has no configuration, process, or filesystem side effects', async () => {
  const f = fixture();
  await main(['--help'], f.deps);
  assert.deepEqual(f.logs, [HELP]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.defaults, 0);
  assert.equal(f.temps, 0);
  assert.deepEqual(f.removed, []);
});

test('deploy builds, explicitly archives the lockfile, installs, restarts, and cleans up in order', async () => {
  const f = fixture();
  await main(['user@dev-box'], f.deps);
  assert.deepEqual(stages(f), ['revision', 'status', 'build', 'archive', 'mktemp', 'copy', 'install', 'restart', 'cleanup']);
  assert.equal(f.defaults, 0, 'An explicit host must not read the default configuration');
  assert.ok(f.calls.every(call => call.options.cwd === f.root));
  assert.deepEqual(f.calls[2].args, ['run', 'build']);
  const archive = join(f.tempDir, 'release.tar.gz');
  assert.deepEqual(f.calls[3].args, ['-czf', archive, 'package.json', 'package-lock.json', 'dist', 'bin', 'completions', 'example-configs']);
  assert.equal(f.calls[3].options.env?.COPYFILE_DISABLE, '1');
  assert.ok(!f.calls[3].args.includes('--no-xattrs'), 'Use tar arguments supported by both BSD and GNU tar');
  assert.deepEqual(f.calls[4].args, ['-o', 'BatchMode=yes', 'user@dev-box', 'mktemp /tmp/pi-remote-deploy.XXXXXX']);
  assert.equal(f.calls[4].options.captureStdout, true);
  assert.deepEqual(f.calls[5].args, ['-q', '-o', 'BatchMode=yes', archive, 'user@dev-box:/tmp/pi-remote-deploy.Ab12Z9']);
  assert.deepEqual(f.calls[6].args, ['-o', 'BatchMode=yes', 'user@dev-box', 'bash', '-s', '--', '/tmp/pi-remote-deploy.Ab12Z9', '20261008T153000Z-9f6e91e']);
  assert.equal(f.calls[6].options.input, REMOTE_INSTALL_SCRIPT);
  assert.deepEqual(f.calls[7].args, [join(f.root, 'bin', 'pi-remote'), 'restart-daemon', '--host', 'user@dev-box']);
  assert.deepEqual(f.calls[8].args, ['-o', 'BatchMode=yes', 'user@dev-box', 'rm', '-f', '--', '/tmp/pi-remote-deploy.Ab12Z9']);
  assert.deepEqual(f.removed, [f.tempDir]);
  assert.deepEqual(f.warnings, []);
  assert.match(f.logs[0], /Installed release 20261008T153000Z-9f6e91e on user@dev-box/);
});

test('deploy uses the shared default host and marks dirty releases', async () => {
  const f = fixture({ host: 'configured-box', dirty: true });
  await main([], f.deps);
  assert.equal(f.defaults, 1);
  const install = f.calls.find(call => call.stage === 'install')!;
  assert.equal(install.args[2], 'configured-box');
  assert.equal(install.args.at(-1), '20261008T153000Z-9f6e91e-dirty');
});

test('deploy --wait forwards the wait flag only to daemon restart', async () => {
  const f = fixture();
  await main(['--wait'], f.deps);
  assert.deepEqual(f.calls.find(call => call.stage === 'restart')!.args,
    [join(f.root, 'bin', 'pi-remote'), 'restart-daemon', '--wait', '--host', 'default-box']);
  assert.ok(f.calls.filter(call => call.stage !== 'restart').every(call => !call.args.includes('--wait')));
});

test('deploy --no-restart installs and cleans up without contacting the daemon', async () => {
  const f = fixture();
  await main(['--no-restart'], f.deps);
  assert.ok(stages(f).includes('install'));
  assert.ok(!stages(f).includes('restart'));
  assert.equal(stages(f).at(-1), 'cleanup');
  assert.deepEqual(f.removed, [f.tempDir]);
  assert.match(f.logs.at(-1)!, /Daemon not restarted.*restart-daemon when ready/);
});

test('deploy rejects missing and unsafe hosts before any process runs', async () => {
  for (const host of ['', '-oProxyCommand=bad', 'two hosts', 'box;touch-file', 'box\nother', 'box$(command)']) {
    const f = fixture({ host });
    await assert.rejects(main([], f.deps), /Give an SSH host alias/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.temps, 0);
  }
  const f = fixture();
  f.deps.defaultHost = () => undefined;
  await assert.rejects(main([], f.deps), /Give an SSH host alias/);
  assert.deepEqual(f.calls, []);
});

test('deploy preserves configuration errors without starting a build', async () => {
  const f = fixture();
  f.deps.defaultHost = () => { throw new Error('Invalid JSON in client configuration'); };
  await assert.rejects(main([], f.deps), /Invalid JSON/);
  assert.deepEqual(f.calls, []);
});

test('deploy rejects an unsafe revision before building or passing it to SSH', async () => {
  const f = fixture({ revision: 'hash;command' });
  await assert.rejects(main([], f.deps), /Unexpected git revision/);
  assert.deepEqual(stages(f), ['revision']);
  assert.equal(f.temps, 0);
});

for (const stage of ['revision', 'status', 'build'] as const) {
  test(`deploy ${stage} failure stops before creating an archive`, async () => {
    const f = fixture({ failures: [stage] });
    await assert.rejects(main([], f.deps), new RegExp(`${stage} failed: child stderr detail`));
    assert.equal(stages(f).at(-1), stage);
    assert.equal(f.temps, 0);
    assert.deepEqual(f.removed, []);
  });
}

for (const stage of ['archive', 'mktemp'] as const) {
  test(`deploy ${stage} failure cleans the local archive without running remote cleanup`, async () => {
    const f = fixture({ failures: [stage] });
    await assert.rejects(main([], f.deps), new RegExp(`${stage} failed: child stderr detail`));
    assert.equal(stages(f).at(-1), stage);
    assert.deepEqual(f.removed, [f.tempDir]);
    assert.ok(!stages(f).includes('copy'));
  });
}

test('deploy validates the remote temporary path before using it in copy or cleanup commands', async () => {
  for (const remotePath of ['/tmp/other-path', '/tmp/pi-remote-deploy.a;command', '/tmp/pi-remote-deploy.abc\nextra', '']) {
    const f = fixture({ remotePath });
    await assert.rejects(main([], f.deps), /Unexpected remote temporary path/);
    assert.equal(stages(f).at(-1), 'mktemp');
    assert.deepEqual(f.removed, [f.tempDir]);
  }
});

for (const stage of ['copy', 'install'] as const) {
  test(`deploy ${stage} failure cleans both archives without restarting`, async () => {
    const f = fixture({ failures: [stage] });
    await assert.rejects(main([], f.deps), new RegExp(`${stage} failed: child stderr detail`));
    assert.equal(stages(f).at(-1), 'cleanup');
    assert.ok(!stages(f).includes('restart'));
    assert.deepEqual(f.removed, [f.tempDir]);
    assert.deepEqual(f.logs, []);
  });
}

test('deploy restart failure reports that the release is installed, preserves stderr detail, and cleans archives', async () => {
  const f = fixture({ failures: ['restart'] });
  await assert.rejects(main([], f.deps), /release is installed.*restart failed.*restart-daemon --wait[^]*restart failed: child stderr detail/);
  assert.match(f.logs[0], /Installed release/);
  assert.equal(stages(f).at(-1), 'cleanup');
  assert.deepEqual(f.removed, [f.tempDir]);
});

test('deploy cleanup failures warn for both archives without masking the original failure', async () => {
  const f = fixture({ failures: ['copy', 'cleanup'], localCleanupFails: true });
  await assert.rejects(main([], f.deps), /copy failed: child stderr detail/);
  assert.equal(f.warnings.length, 2);
  assert.match(f.warnings[0], /Could not remove remote archive.*cleanup failed/);
  assert.match(f.warnings[1], /Could not remove local archive directory.*local cleanup failed/);
  assert.deepEqual(f.removed, [f.tempDir]);
});

for (const localCleanupFails of [false, true]) {
  test(`deploy returns failure when ${localCleanupFails ? 'local' : 'remote'} archive cleanup fails after installation`, async () => {
    const f = fixture({ failures: localCleanupFails ? [] : ['cleanup'], localCleanupFails });
    await assert.rejects(main(['--no-restart'], f.deps), /cleanup failed/);
    assert.match(f.logs[0], /Installed release/);
    assert.equal(f.warnings.length, 1);
    assert.deepEqual(f.removed, [f.tempDir]);
  });
}

test('remote setup retains immutable releases, validates before atomic switch, and protects live releases', () => {
  assert.ok(ARCHIVE_FILES.includes('package-lock.json'));
  assert.match(REMOTE_INSTALL_SCRIPT, /set -euo pipefail/);
  assert.match(REMOTE_INSTALL_SCRIPT, /mkdir "\$release"\ncreated=1/);
  assert.match(REMOTE_INSTALL_SCRIPT, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  const switchAt = REMOTE_INSTALL_SCRIPT.indexOf('mv -Tf');
  for (const validation of ['npm ci', 'bin/pi-remote --version', 'bin/pi-remote completion fish']) {
    assert.ok(REMOTE_INSTALL_SCRIPT.indexOf(validation) < switchAt, `${validation} must finish before switching`);
  }
  assert.match(REMOTE_INSTALL_SCRIPT, /ln -s "\$release\/bin\/pi-remote"/);
  assert.match(REMOTE_INSTALL_SCRIPT, /readlink -f -- "\$base\/bin\/pi-remote"/);
  assert.match(REMOTE_INSTALL_SCRIPT, /process_args=\$\(ps -eo args=\)/);
  assert.ok(REMOTE_INSTALL_SCRIPT.includes('"$dir" != "$release"'));
  assert.ok(REMOTE_INSTALL_SCRIPT.includes('"$dir" != "${previous%/bin/pi-remote}"'));
  assert.ok(REMOTE_INSTALL_SCRIPT.includes('"$process_args" != *"$dir/"*'));
  assert.match(REMOTE_INSTALL_SCRIPT, /trap cleanup EXIT/);
  assert.match(REMOTE_INSTALL_SCRIPT, /rm -f -- "\$archive"/);
  assert.ok(REMOTE_INSTALL_SCRIPT.includes('"$created" == 1 && "$switched" == 0'), 'Only failed, unswitched releases may be removed by the failure trap');
});
