import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  attachInvocation, captureGhosttyTarget, formatInvocation, ghosttyLauncher,
  isSplitDirection, openGhosttySplit, resolveSplitDirection,
  type AttachInvocation, type ExplicitSplitDirection, type GhosttyDependencies, type GhosttyExecFile,
} from '../../src/tui/side-launcher.js';

const TARGET = '66C39D89-6C23-4609-B762-348810D89429';
const SLOT = '8844ca51-7b8d-47da-b1b9-3e111d70779b';
const invocation: AttachInvocation = { command: '/local/node', args: ['/local/bin/pi-remote', 'attach', '--local', SLOT] };

function mockGhostty(output = `1.3.1\n${TARGET}\n`) {
  const calls: { command: string; args: string[]; options: Parameters<GhosttyExecFile>[2] }[] = [];
  const dependencies: GhosttyDependencies = {
    platform: 'darwin', env: { TERM_PROGRAM: 'ghostty' },
    execFile: async (command, args, options) => { calls.push({ command, args, options }); return { stdout: output }; },
  };
  return { dependencies, calls };
}

test('split-direction validation accepts only the five supported names', () => {
  for (const direction of ['auto', 'right', 'down', 'left', 'up']) assert.equal(isSplitDirection(direction), true);
  for (const value of [undefined, null, true, 1, {}, [], 'Right', 'horizontal', 'auto ', '']) assert.equal(isSplitDirection(value), false);
});

test('auto split compares pixel dimensions and explicit directions ignore dimensions', () => {
  // Character counts alone would pick right; 80x9 is narrower than 50x18.
  assert.equal(resolveSplitDirection('auto', { columns: 80, rows: 50 }), 'down');
  assert.equal(resolveSplitDirection('auto', { columns: 160, rows: 40 }), 'right');
  assert.equal(resolveSplitDirection('auto', { columns: 80, rows: 40 }), 'down');
  assert.equal(resolveSplitDirection('auto', { columns: 80, rows: 40, cellWidth: 15, cellHeight: 20 }), 'right');
  assert.equal(resolveSplitDirection('auto', { columns: 80, rows: 40, cellWidth: 5, cellHeight: 20 }), 'down');
  for (const direction of ['right', 'down', 'left', 'up'] as const) {
    assert.equal(resolveSplitDirection(direction, { columns: 0, rows: 0 }), direction);
  }
  assert.throws(() => resolveSplitDirection('invalid' as any, { columns: 1, rows: 1 }), /Invalid split direction/);
});

test('unusable terminal sizes use the safe right-split fallback', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    for (const key of ['columns', 'rows', 'cellWidth', 'cellHeight']) {
      assert.equal(resolveSplitDirection('auto', { columns: 40, rows: 100, [key]: bad }), 'right', `${key}: ${bad}`);
    }
  }
  assert.equal(resolveSplitDirection('auto', { columns: Number.MAX_VALUE, rows: 100 }), 'right');
});

test('attach uses this exact local installation and carries resolved connection/UI settings', () => {
  const actual = attachInvocation(SLOT, {
    host: 'resolved-host', stateDir: '~/.pi/remote custom', remoteBin: '~/releases/pi-remote/bin/pi-remote',
    presentationPaths: ['./first adapter.ts', '../second.ts'], presentationConfig: './client config.json',
    theme: 'light/dark', bell: false, reconnect: false,
  });
  assert.equal(actual.command, process.execPath);
  assert.deepEqual(actual.args, [
    fileURLToPath(new URL('../../bin/pi-remote', import.meta.url)), 'attach',
    '--host', 'resolved-host', '--state-dir', '~/.pi/remote custom', '--remote-bin', '~/releases/pi-remote/bin/pi-remote',
    '--ui-extension', './first adapter.ts', '--ui-extension', '../second.ts', '--ui-config', './client config.json',
    '--theme', 'light/dark', '--no-bell', '--no-reconnect', SLOT,
  ]);
  assert.equal(actual.args.includes('--import'), false);
  assert.equal(actual.args.includes('--test'), false);
  assert.equal(actual.args.includes('--cwd'), false);
});

test('local attach ignores a stale host and leaves enabled/default options alone', () => {
  const actual = attachInvocation(SLOT, { local: true, host: 'must-not-use', bell: true, reconnect: true });
  assert.deepEqual(actual.args.slice(1), ['attach', '--local', SLOT]);
  assert.throws(() => attachInvocation(SLOT, {}), /resolved SSH host/);
  assert.throws(() => attachInvocation('', { local: true }), /UUID/);
  assert.throws(() => attachInvocation('--host', { local: true }), /UUID/);
});

test('fallback shell-quotes every token, including empty arguments and malicious-looking data', () => {
  assert.equal(formatInvocation({ command: '/some path/node', args: ["a'b", '', '$(touch /tmp/no); `false`\nnext', '"\\'] }),
    `'/some path/node' 'a'\\''b' '' '$(touch /tmp/no); \`false\`\nnext' '"\\'`);
  const command = attachInvocation(SLOT, { host: 'host; false', remoteBin: "~/a'b; $(false)", presentationPaths: ['" & do shell script "bad'] });
  assert.ok(formatInvocation(command).includes(`'~/a'\\''b; $(false)'`));
  assert.throws(() => formatInvocation({ command: '', args: [] }), /executable/);
  assert.throws(() => formatInvocation({ command: '/node', args: ['bad\0arg'] }), /NUL/);
  assert.throws(() => attachInvocation(SLOT, { host: 'bad\0host' }), /NUL/);
});

test('capture checks capability and returns the stable ID before any split is created', async () => {
  const { dependencies, calls } = mockGhostty();
  assert.equal(await captureGhosttyTarget(dependencies), TARGET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(2), ['--']);
  const script = calls[0].args[1];
  assert.match(script, /new surface configuration/);
  assert.match(script, /focused terminal of selected tab of front window/);
  assert.match(script, /id of sourceTerminal/);
  assert.doesNotMatch(script, /split sourceTerminal|input text|send key/);
  assert.deepEqual(calls[0].options, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
});

test('capture and open refuse unsupported environments without executing anything', async () => {
  for (const overrides of [
    { platform: 'linux' as const }, { platform: 'win32' as const },
    { env: {} }, { env: { TERM_PROGRAM: 'iTerm.app' } },
  ]) {
    const { dependencies, calls } = mockGhostty();
    Object.assign(dependencies, overrides);
    await assert.rejects(captureGhosttyTarget(dependencies), /Ghostty/);
    await assert.rejects(openGhosttySplit({ invocation, targetId: TARGET, direction: 'right' }, dependencies), /Ghostty/);
    assert.equal(calls.length, 0);
  }
});

test('capture verifies installed version and rejects absent or malformed terminal IDs', async () => {
  for (const version of ['0.9.0', '1.2.9', 'unknown']) {
    await assert.rejects(captureGhosttyTarget(mockGhostty(`${version}\n${TARGET}`).dependencies), /Ghostty 1.3/);
  }
  for (const version of ['1.3.0', '1.3.1', '1.4.0-dev', '2.0.0']) {
    assert.equal(await captureGhosttyTarget(mockGhostty(`${version}\n${TARGET}`).dependencies), TARGET);
  }
  for (const id of ['', 'missing value', 'not-a-uuid']) {
    await assert.rejects(captureGhosttyTarget(mockGhostty(`1.3.1\n${id}`).dependencies), /No focused Ghostty terminal/);
  }
});

test('split uses the captured ID, literal direction branches, argv data, and client cwd', async () => {
  const { dependencies, calls } = mockGhostty();
  const targetId = await captureGhosttyTarget(dependencies);
  const hostile = { command: "/a path/n'ode", args: ['attach', '--host', '$(false); "\\\nend tell', SLOT] };
  const cwd = '/local/a "quoted" directory';
  await openGhosttySplit({ invocation: hostile, targetId, direction: 'left', cwd }, dependencies);
  const call = calls[1];
  assert.equal(call.command, '/usr/bin/osascript');
  assert.deepEqual(call.args.slice(2), ['--', TARGET, 'left', formatInvocation(hostile), cwd]);
  const script = call.args[1];
  assert.match(script, /exists terminal id sourceId/);
  assert.match(script, /set sourceTerminal to terminal id sourceId/);
  assert.match(script, /set command of cfg to launchCommand/);
  assert.match(script, /set initial working directory of cfg to launchDirectory/);
  for (const direction of ['right', 'down', 'left', 'up']) assert.ok(script.includes(`split sourceTerminal direction ${direction} with configuration cfg`));
  assert.match(script, /set environment variables of cfg to launchEnvironment/);
  assert.match(script, /items 5 thru -1 of argv/);
  assert.doesNotMatch(script, /front window|focused terminal|input text|send key|do shell script/);
  assert.equal(script.includes(hostile.command), false);
  assert.equal(script.includes(hostile.args[2]), false);
  assert.equal(script.includes(cwd), false);
  assert.equal(Object.hasOwn(call.options, 'env'), false);
});

test('each direction is passed as data and omitted cwd preserves the current local directory', async () => {
  const { dependencies, calls } = mockGhostty();
  for (const direction of ['right', 'down', 'left', 'up'] as const) {
    await openGhosttySplit({ invocation, targetId: TARGET, direction }, dependencies);
    assert.deepEqual(calls.at(-1)!.args.slice(-4), [TARGET, direction, formatInvocation(invocation), process.cwd()]);
  }
  assert.equal(new Set(calls.map(call => call.args[1])).size, 1);
});

test('invalid targets, unresolved directions, and invalid values never launch a split', async () => {
  const { dependencies, calls } = mockGhostty();
  await assert.rejects(openGhosttySplit({ invocation, targetId: '', direction: 'right' }, dependencies), /captured Ghostty terminal ID/);
  await assert.rejects(openGhosttySplit({ invocation, targetId: TARGET, direction: 'auto' as ExplicitSplitDirection }, dependencies), /Resolve the split direction/);
  await assert.rejects(openGhosttySplit({ invocation, targetId: TARGET, direction: 'down', cwd: '/bad\0dir' }, dependencies), /NUL/);
  assert.equal(calls.length, 0);
});

test('automation, disabled scripting, timeout, and stale-target errors preserve a useful fallback reason', async () => {
  for (const message of ['Not authorized to send Apple events', 'AppleScript is disabled', 'original terminal no longer available', 'timed out']) {
    const { dependencies } = mockGhostty();
    const cause = Object.assign(new Error('command failed, potentially containing argv'), { stderr: message });
    dependencies.execFile = async () => { throw cause; };
    for (const action of [
      () => captureGhosttyTarget(dependencies),
      () => openGhosttySplit({ invocation, targetId: TARGET, direction: 'right' }, dependencies),
    ]) {
      await assert.rejects(action(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, cause);
        assert.ok(error.message.includes(message));
        assert.match(error.message, /macos-applescript = true/);
        assert.match(error.message, /Automation permission/);
        assert.doesNotMatch(error.message, /potentially containing argv/);
        return true;
      });
    }
  }
});

test('formatted launch runs through Ghostty macOS bash wrapper without an extra exec', { skip: process.platform === 'win32' }, async () => {
  const { dependencies, calls } = mockGhostty();
  await openGhosttySplit({ invocation: { command: process.execPath, args: ['--version'] }, targetId: TARGET, direction: 'right' }, dependencies);
  const command = calls[0].args[5];
  assert.equal(command, formatInvocation({ command: process.execPath, args: ['--version'] }));
  // The macOS branch of Ghostty 1.3.1 src/termio/Exec.zig, without login(1)
  // or an actual terminal. The old command would become `exec -l exec ...`.
  const result = await promisify(execFile)('/bin/bash', ['--noprofile', '--norc', '-c', `exec -l ${command}`], {
    encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.stdout.trim(), process.version);
});

test('Ghostty macOS bash wrapper preserves quoted argument data', { skip: process.platform === 'win32' }, async () => {
  const values = ["a'b", '', 'space and \"quotes\"', '$(exit 99); `exit 98`\nnext', 'back\\slash', 'KEY=a=b'];
  const command = formatInvocation({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...values] });
  const result = await promisify(execFile)('/bin/bash', ['--noprofile', '--norc', '-c', `exec -l ${command}`], {
    encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' },
  });
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('split forwards only SSH, UI adapter, XDG config, and PATH settings as argv assignments', async () => {
  const { dependencies, calls } = mockGhostty();
  dependencies.env = {
    TERM_PROGRAM: 'ghostty',
    SSH_AUTH_SOCK: '/socket/a \"quoted\" path',
    PI_CODING_AGENT_DIR: '/agent/a=b',
    XDG_CONFIG_HOME: '/custom config',
    PI_REMOTE_RENDERER_REPO: '/renderer/$(false);\nend tell',
    PATH: '/bin:/a path/bin',
    OPENAI_API_KEY: 'do-not-forward', AWS_SECRET_ACCESS_KEY: 'also-not-forwarded',
    NODE_OPTIONS: '--inspect', BASH_ENV: '/do/not/source', HOME: '/not-forwarded',
  };
  await openGhosttySplit({ invocation, targetId: TARGET, direction: 'right' }, dependencies);
  assert.deepEqual(calls[0].args.slice(7), [
    'SSH_AUTH_SOCK=/socket/a \"quoted\" path',
    'PI_CODING_AGENT_DIR=/agent/a=b',
    'PI_REMOTE_RENDERER_REPO=/renderer/$(false);\nend tell',
    'XDG_CONFIG_HOME=/custom config',
    'PATH=/bin:/a path/bin',
  ]);
  const script = calls[0].args[1];
  assert.equal(script.includes(dependencies.env.PI_REMOTE_RENDERER_REPO!), false);
  assert.equal(calls[0].args.includes('do-not-forward'), false);
  assert.equal(formatInvocation(invocation).includes('SSH_AUTH_SOCK'), false);
  assert.equal(Object.hasOwn(calls[0].options, 'env'), false);
});

test('explicit environment overrides inheritance but cannot expand the allowlist', async () => {
  const { dependencies, calls } = mockGhostty();
  dependencies.env = { TERM_PROGRAM: 'ghostty', SSH_AUTH_SOCK: '/old/socket', PATH: '/old/bin' };
  await openGhosttySplit({ invocation, targetId: TARGET, direction: 'down', environment: {
    PI_CODING_AGENT_DIR: '', PATH: '/custom/bin', UNTRUSTED_SECRET: 'not-forwarded',
  } }, dependencies);
  assert.deepEqual(calls[0].args.slice(7), ['PI_CODING_AGENT_DIR=', 'PATH=/custom/bin']);
  await openGhosttySplit({ invocation, targetId: TARGET, direction: 'down', environment: {} }, dependencies);
  assert.deepEqual(calls[1].args.slice(7), []);
});

test('invalid allowlisted environment values fail before osascript without exposing their value', async () => {
  const { dependencies, calls } = mockGhostty();
  await assert.rejects(openGhosttySplit({ invocation, targetId: TARGET, direction: 'right', environment: {
    SSH_AUTH_SOCK: 'private\0value',
  } }, dependencies), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /SSH_AUTH_SOCK.*NUL/);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('default launcher exposes the parent integration methods without opening panes', () => {
  assert.equal(typeof ghosttyLauncher.captureTarget, 'function');
  assert.equal(typeof ghosttyLauncher.open, 'function');
});
