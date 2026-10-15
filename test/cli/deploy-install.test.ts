import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { REMOTE_INSTALL_SCRIPT } from '../../scripts/deploy.js';
import type { WebConfig } from '../../src/config/client.js';

const NAME = '20261008T153000Z-9f6e91e';
const NEXT = '20261008T153100Z-9f6e91f';
const SERVICE = 'pi-remote-web.service';
const ORIGIN = 'https://remote-box.example.ts.net';
const USERS = ['alice@example.com', 'bob@example.com'];
const OLD_UNIT = '[Service]\nExecStart=/sentinel/old-web\n';
const SYSTEMCTL_ACTIONS = ['show-environment', 'daemon-reload', 'enable', 'restart'] as const;
type ServiceState = 'absent' | 'stopped' | 'active';
type SystemctlAction = typeof SYSTEMCTL_ACTIONS[number];
interface Call {
  command: string;
  args: string[];
  oldPresent: boolean;
  launcher: string;
  unit: string | null;
  serviceState: ServiceState;
  xdgConfigHome: string | null;
}
interface FixtureOptions {
  state?: ServiceState;
  fail?: SystemctlAction;
  status?: unknown;
  serve?: unknown;
  linger?: 'yes' | 'no' | 'fail';
  homeName?: string;
  nodeName?: string;
  sshConfigDirectory?: string;
  pathEntries?: (home: string) => string[];
}

/**
 * Run the real installer and compiled helper, never service commands. All four external
 * service/package commands are private fakes first on PATH, with an unreachable user bus.
 */
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-remote-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, options.homeName ?? 'home'), fakes = join(root, 'fakes'), payload = join(root, 'payload');
  const base = join(home, '.local/share/pi-remote');
  const releases = join(base, 'releases'), link = join(base, 'bin/pi-remote');
  const unit = join(home, '.config/systemd/user', SERVICE);
  const sshConfigHome = join(home, options.sshConfigDirectory ?? '.config');
  const path = [fakes, ...(options.pathEntries?.(home) ?? (process.env.PATH ?? '').split(':'))].join(':');
  const calls = join(root, 'calls.jsonl'), state = join(root, 'service-state'), enabled = join(root, 'enabled');
  const status = join(root, 'tailscale-status.json'), serve = join(root, 'tailscale-serve.json'), linger = join(root, 'linger');
  const managerEnvironment = join(root, 'manager-environment');
  for (const dir of [fakes, join(payload, 'bin'), join(base, 'bin')]) await mkdir(dir, { recursive: true });
  const executable = async (path: string, body: string) => { await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755); };
  await executable(join(payload, 'bin/pi-remote'), 'exit 0');
  await writeFile(join(payload, 'package.json'), JSON.stringify({ type: 'module' }));
  // The parent compiles dist before these tests. Do not replace the service helper with a stub.
  for (const file of ['cli/web-service.js', 'config/client.js', 'web/server/tailscale.js']) {
    const target = join(payload, 'dist', file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(new URL(`../../dist/${file}`, import.meta.url), target);
  }
  await writeFile(calls, '');
  await writeFile(state, options.state ?? 'absent');
  await writeFile(status, JSON.stringify(options.status ?? { BackendState: 'Running', Self: { DNSName: 'remote-box.example.ts.net.' } }));
  await writeFile(serve, JSON.stringify(options.serve ?? {}));
  await writeFile(linger, options.linger ?? 'yes');
  await writeFile(managerEnvironment, '');
  if (options.state && options.state !== 'absent') {
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, OLD_UNIT);
  }
  // Two older releases: the current launcher target survives; the oldest is removable.
  for (const release of ['old', 'previous']) {
    await mkdir(join(releases, release, 'bin'), { recursive: true });
    await executable(join(releases, release, 'bin/pi-remote'), 'exit 0');
  }
  await symlink(join(releases, 'previous/bin/pi-remote'), link);

  const runner = join(root, 'fake-command.cjs');
  await writeFile(runner, `
const { appendFileSync, existsSync, readFileSync, readlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const command = process.argv[2], args = process.argv.slice(3), env = process.env;
const unit = join(env.XDG_CONFIG_HOME || join(env.HOME, '.config'), 'systemd/user', '${SERVICE}');
appendFileSync(env.FAKE_CALLS, JSON.stringify({
  command, args, oldPresent: existsSync(join(env.FAKE_RELEASES, 'old')),
  launcher: readlinkSync(env.FAKE_LINK),
  unit: existsSync(unit) ? readFileSync(unit, 'utf8') : null,
  serviceState: readFileSync(env.FAKE_STATE, 'utf8'), xdgConfigHome: env.XDG_CONFIG_HOME ?? null,
}) + '\\n');
function reject(message) { console.error(message); process.exit(64); }
if (command === 'npm') {
  if (JSON.stringify(args) !== JSON.stringify(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'])) reject('Unexpected npm command');
} else if (command === 'systemctl') {
  const action = args[1];
  const expected = ['--user', action, ...(['enable', 'restart'].includes(action) ? ['${SERVICE}'] : [])];
  if (!${JSON.stringify(SYSTEMCTL_ACTIONS)}.includes(action) || JSON.stringify(args) !== JSON.stringify(expected)) reject('Unexpected systemctl command');
  if (action === env.FAKE_FAIL) { console.error('simulated systemctl ' + action + ' failure'); process.exit(1); }
  if (action === 'show-environment') process.stdout.write(readFileSync(env.FAKE_MANAGER_ENV));
  if (action === 'enable') writeFileSync(env.FAKE_ENABLED, '${SERVICE}');
  if (action === 'restart') writeFileSync(env.FAKE_STATE, 'active');
} else if (command === 'tailscale') {
  const key = JSON.stringify(args);
  if (key === JSON.stringify(['status', '--json', '--peers=false'])) process.stdout.write(readFileSync(env.FAKE_STATUS));
  else if (key === JSON.stringify(['serve', 'status', '--json'])) process.stdout.write(readFileSync(env.FAKE_SERVE));
  else reject('Refusing any Tailscale mutation: ' + key);
} else if (command === 'loginctl') {
  if (JSON.stringify(args) !== JSON.stringify(['show-user', String(process.getuid()), '--property=Linger', '--value'])) reject('Refusing any linger mutation');
  const linger = readFileSync(env.FAKE_LINGER, 'utf8');
  if (linger === 'fail') process.exit(1);
  console.log(linger);
} else reject('Unexpected fake command');
`);
  for (const command of ['npm', 'systemctl', 'tailscale', 'loginctl']) {
    await executable(join(fakes, command), `exec "${process.execPath}" "${runner}" ${command} "$@"`);
  }
  // A copied real Node can exercise executable-path quoting, not just its argv.
  const node = options.nodeName ? join(root, options.nodeName) : process.execPath;
  if (options.nodeName) { await copyFile(process.execPath, node); await chmod(node, 0o755); }
  await symlink(node, join(fakes, 'node'));
  const run = async (name: string, web?: WebConfig) => {
    const archive = execFileSync('mktemp', ['/tmp/pi-remote-deploy.XXXXXX'], { encoding: 'utf8', timeout: 5_000 }).trim();
    t.after(() => rm(archive, { force: true }));
    execFileSync('tar', ['-czf', archive, '-C', payload, '.'], { timeout: 10_000 });
    const result = spawnSync('bash', ['-s', '--', archive, name, ...(web ? [Buffer.from(JSON.stringify(web)).toString('base64')] : [])], {
      input: REMOTE_INSTALL_SCRIPT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
      env: {
        PATH: path, HOME: home, XDG_CONFIG_HOME: sshConfigHome,
        XDG_RUNTIME_DIR: join(root, 'no-runtime'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/unreachable-user-bus`,
        FAKE_CALLS: calls, FAKE_RELEASES: releases, FAKE_LINK: link, FAKE_STATE: state, FAKE_MANAGER_ENV: managerEnvironment,
        FAKE_ENABLED: enabled, FAKE_FAIL: options.fail ?? '', FAKE_STATUS: status, FAKE_SERVE: serve, FAKE_LINGER: linger,
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, `Installer terminated by ${result.signal}`);
    assert.ok(!existsSync(archive), 'installer removes its temporary archive on success and failure');
    return result;
  };
  const readCalls = async (): Promise<Call[]> => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { run, readCalls, home, releases, link, unit, state, enabled, status, serve, linger, managerEnvironment, sshConfigHome, fakes, node };
}

/** Model unit quoting: the executable path and Environment values have no dollar expansion. */
function unitArguments(unit: string, directive = 'ExecStart', expandVariables = true): string[] {
  const line = unit.split('\n').find(line => line.startsWith(`${directive}=`));
  assert.ok(line, `generated unit has a ${directive} directive`);
  const command = line.slice(directive.length + 1), result: string[] = [];
  const token = /"((?:[^"\\]|\\["\\])*)"(?: |$)/gy;
  let offset = 0;
  while (offset < command.length) {
    token.lastIndex = offset;
    const match = token.exec(command);
    assert.ok(match, `Invalid quoted systemd argument at ${command.slice(offset)}`);
    const escaped = match[1].replace(/\\(["\\])/g, '$1');
    let value = '';
    for (let i = 0; i < escaped.length; i++) {
      const char = escaped[i];
      if ((char === '$' && expandVariables && result.length > 0) || char === '%') {
        assert.equal(escaped[++i], char, `Unescaped systemd expansion in ${escaped}`);
      }
      value += char;
    }
    result.push(value);
    offset = token.lastIndex;
  }
  return result;
}

function expectedCommand(home: string, releases: string, name: string, web: WebConfig): string[] {
  return [process.execPath, join(releases, name, 'dist/cli/main.js'), 'serve', '--origin', web.origin ?? ORIGIN,
    ...web.allowUsers.flatMap(login => ['--allow-user', login]), '--web-state-dir', join(home, '.pi-remote-web')];
}

function serviceCalls(calls: Call[]): Call[] { return calls.filter(call => call.command === 'systemctl'); }
function tailscaleCalls(calls: Call[]): string[][] { return calls.filter(call => call.command === 'tailscale').map(call => call.args); }

test('configured deploy creates, enables, and restarts absent, stopped, and active web services before cleanup', async t => {
  for (const state of ['absent', 'stopped', 'active'] as const) await t.test(state, async t => {
    const f = await fixture(t, { state });
    const web = { allowUsers: USERS };
    const result = await f.run(NAME, web);
    assert.equal(result.status, 0, result.stderr);
    const calls = await f.readCalls(), systemctl = serviceCalls(calls);
    assert.deepEqual(systemctl.map(call => call.args), SYSTEMCTL_ACTIONS.map(action =>
      ['--user', action, ...(['enable', 'restart'].includes(action) ? [SERVICE] : [])]));
    assert.deepEqual(tailscaleCalls(calls), [['status', '--json', '--peers=false'], ['serve', 'status', '--json']]);
    assert.equal(systemctl[0].xdgConfigHome, f.sshConfigHome);
    assert.deepEqual(systemctl.slice(1).map(call => call.xdgConfigHome), [null, null, null], 'unset manager XDG overrides the SSH environment');
    const restart = systemctl.at(-1)!;
    assert.equal(restart.oldPresent, true, 'restart occurs before deleting any unused release');
    assert.equal(restart.serviceState, state);
    assert.equal(restart.launcher, join(f.releases, NAME, 'bin/pi-remote'));
    assert.ok(restart.unit, 'unit is written before restart');
    assert.match(restart.unit, /^Type=notify$/m);
    assert.match(restart.unit, /^NotifyAccess=all$/m);
    assert.match(restart.unit, /^TimeoutStartSec=45$/m);
    assert.deepEqual(unitArguments(restart.unit), expectedCommand(f.home, f.releases, NAME, web));
    assert.equal(await readFile(f.unit, 'utf8'), restart.unit);
    assert.equal(await readFile(f.state, 'utf8'), 'active');
    assert.equal(await readFile(f.enabled, 'utf8'), SERVICE);
    assert.match(result.stdout, /Installed and started pi-remote-web.service for https:\/\/remote-box\.example\.ts\.net/);
    assert.equal(await readlink(f.link), join(f.releases, NAME, 'bin/pi-remote'));
    assert.ok(!existsSync(join(f.releases, 'old')), 'successful restart allows unused release cleanup');
    assert.ok(existsSync(join(f.releases, 'previous')));
  });
});

test('absent web settings leave existing units and service state untouched without service or Tailscale commands', async t => {
  for (const state of ['absent', 'stopped', 'active'] as const) await t.test(state, async t => {
    const f = await fixture(t, { state });
    const result = await f.run(NAME);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await f.readCalls()).map(call => call.command), ['npm']);
    if (state === 'absent') assert.ok(!existsSync(f.unit));
    else assert.equal(await readFile(f.unit, 'utf8'), OLD_UNIT);
    assert.equal(await readFile(f.state, 'utf8'), state);
    assert.ok(!existsSync(f.enabled));
    assert.equal(await readlink(f.link), join(f.releases, NAME, 'bin/pi-remote'));
    assert.ok(!existsSync(join(f.releases, 'old')));
    assert.ok(existsSync(join(f.releases, 'previous')));
  });
});

test('a second configured deployment replaces the unit with the next immutable release and all new users', async t => {
  const f = await fixture(t);
  const firstWeb = { allowUsers: USERS };
  const first = await f.run(NAME, firstWeb);
  assert.equal(first.status, 0, first.stderr);
  const firstUnit = await readFile(f.unit, 'utf8');
  const helper = join(f.releases, NAME, 'dist/cli/web-service.js');
  const originalHelper = await readFile(helper);
  const secondWeb = { allowUsers: ['carol@example.com', 'dave@example.com'], origin: 'https://second.example.ts.net' };
  const second = await f.run(NEXT, secondWeb);
  assert.equal(second.status, 0, second.stderr);
  const secondUnit = await readFile(f.unit, 'utf8');
  assert.notEqual(secondUnit, firstUnit);
  assert.deepEqual(unitArguments(firstUnit), expectedCommand(f.home, f.releases, NAME, firstWeb));
  assert.deepEqual(unitArguments(secondUnit), expectedCommand(f.home, f.releases, NEXT, secondWeb));
  const restarts = serviceCalls(await f.readCalls()).filter(call => call.args[1] === 'restart');
  assert.equal(restarts.length, 2);
  assert.equal(restarts[0].unit, firstUnit);
  assert.equal(restarts[1].unit, secondUnit);
  assert.equal(restarts[1].launcher, join(f.releases, NEXT, 'bin/pi-remote'));
  assert.equal(await readlink(f.link), join(f.releases, NEXT, 'bin/pi-remote'));
  assert.deepEqual(await readFile(helper), originalHelper, 'previous release code remains immutable');
  assert.ok(existsSync(join(f.releases, NAME)));
  assert.ok(existsSync(join(f.releases, NEXT)));
  assert.ok(!existsSync(join(f.releases, 'previous')));
});

test('an explicit HTTPS origin overrides remote discovery and uses its configured port', async t => {
  const f = await fixture(t, { status: { BackendState: 'Stopped', Self: {} } });
  const web = { allowUsers: USERS, origin: 'https://override.example.ts.net:8443' };
  const result = await f.run(NAME, web);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(tailscaleCalls(await f.readCalls()), [['serve', 'status', '--json']]);
  assert.deepEqual(unitArguments(await readFile(f.unit, 'utf8')), expectedCommand(f.home, f.releases, NAME, web));
  assert.match(result.stdout, /tailscale serve --bg --https=8443/);
});

test('missing discovery, refused Funnel, and systemctl failures preserve releases after switching', async t => {
  const cases: { name: string; options: FixtureOptions; error: RegExp; preservesUnit?: boolean }[] = [
    { name: 'missing discovery', options: { status: { BackendState: 'Running', Self: {} } }, error: /Cannot determine.*web\.origin/, preservesUnit: true },
    { name: 'disconnected Tailscale', options: { status: { BackendState: 'Stopped', Self: { DNSName: 'remote-box.example.ts.net' } } }, error: /Cannot determine.*web\.origin/, preservesUnit: true },
    { name: 'Funnel on another hostname', options: { serve: { Foreground: { nested: { AllowFunnel: { 'other.example.ts.net:443': true } } } } }, error: /Funnel is enabled on port 443/, preservesUnit: true },
    ...SYSTEMCTL_ACTIONS.map(fail => ({ name: `systemctl ${fail}`, options: { fail },
      error: fail === 'show-environment' ? /Cannot reach the systemd user manager.*loginctl enable-linger/ : /Cannot install\/start pi-remote-web\.service.*journalctl/,
      preservesUnit: fail === 'show-environment' })),
  ];
  for (const { name, options, error, preservesUnit } of cases) await t.test(name, async t => {
    const f = await fixture(t, { ...options, state: 'active' });
    const result = await f.run(NAME, { allowUsers: USERS });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.match(result.stderr, /web service setup failed; release cleanup skipped/);
    assert.equal(await readlink(f.link), join(f.releases, NAME, 'bin/pi-remote'));
    for (const release of ['old', 'previous', NAME]) {
      assert.ok(existsSync(join(f.releases, release)), `${release} must survive failed service setup`);
    }
    const calls = await f.readCalls();
    const restarts = serviceCalls(calls).filter(call => call.args[1] === 'restart');
    assert.equal(restarts.length, options.fail === 'restart' ? 1 : 0);
    if (restarts.length) {
      assert.equal(restarts[0].oldPresent, true, 'failed restart still sees every old release');
      assert.equal(restarts[0].launcher, join(f.releases, NAME, 'bin/pi-remote'));
      assert.deepEqual(unitArguments(restarts[0].unit!), expectedCommand(f.home, f.releases, NAME, { allowUsers: USERS }));
    }
    if (preservesUnit) assert.equal(await readFile(f.unit, 'utf8'), OLD_UNIT);
    assert.ok(!calls.some(call => call.command === 'loginctl'), 'linger checks follow successful restart only');
    assert.equal(await readFile(f.state, 'utf8'), 'active');
  });
});

test('read-only route and linger checks print manual instructions without changing either setting', async t => {
  for (const linger of ['no', 'fail'] as const) await t.test(linger, async t => {
    const f = await fixture(t, { linger });
    const before = await Promise.all([f.status, f.serve, f.linger].map(path => readFile(path, 'utf8')));
    const result = await f.run(NAME, { allowUsers: USERS });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Review existing routes before setting the \/ handler/);
    assert.ok(result.stdout.includes(`tailscale serve --bg --https=443 'unix:${join(f.home, '.pi-remote-web/web.sock')}'`));
    assert.match(result.stdout, /To keep the service running after logout: loginctl enable-linger /);
    const calls = await f.readCalls();
    assert.deepEqual(tailscaleCalls(calls), [['status', '--json', '--peers=false'], ['serve', 'status', '--json']]);
    assert.deepEqual(calls.filter(call => call.command === 'loginctl').map(call => call.args),
      [['show-user', String(process.getuid!()), '--property=Linger', '--value']]);
    assert.deepEqual(await Promise.all([f.status, f.serve, f.linger].map(path => readFile(path, 'utf8'))), before);
  });
});

test('the manager config directory overrides SSH XDG for both unit installation and enable', async t => {
  const f = await fixture(t, { sshConfigDirectory: 'ssh-config' });
  const managerConfig = join(f.home, 'manager-config');
  const managerUnit = join(managerConfig, 'systemd/user', SERVICE);
  const sshUnit = join(f.sshConfigHome, 'systemd/user', SERVICE);
  await mkdir(dirname(sshUnit), { recursive: true });
  await writeFile(sshUnit, OLD_UNIT);
  await writeFile(f.managerEnvironment, `LANG=C\nXDG_CONFIG_HOME=${managerConfig}\n`);
  const web = { allowUsers: USERS };
  const result = await f.run(NAME, web);
  assert.equal(result.status, 0, result.stderr);
  const unit = await readFile(managerUnit, 'utf8');
  assert.deepEqual(unitArguments(unit), expectedCommand(f.home, f.releases, NAME, web));
  assert.equal(await readFile(sshUnit, 'utf8'), OLD_UNIT, 'SSH config directory is not the manager search path');
  assert.ok(!existsSync(f.unit), 'the default config directory is not used when the manager sets XDG');
  const calls = serviceCalls(await f.readCalls());
  assert.equal(calls[0].xdgConfigHome, f.sshConfigHome);
  assert.deepEqual(calls.slice(1).map(call => call.xdgConfigHome), [managerConfig, managerConfig, managerConfig]);
  assert.equal(calls.find(call => call.args[1] === 'enable')!.unit, unit, 'enable sees the installed unit in the same config directory');
  assert.equal(calls.at(-1)!.oldPresent, true);
  assert.equal(await readFile(f.enabled, 'utf8'), SERVICE);
});

test('quoted manager XDG values fail before changing any unit or cleaning releases', async t => {
  for (const quote of ['"', "'"]) await t.test(quote, async t => {
    const f = await fixture(t, { state: 'active', sshConfigDirectory: 'ssh-config' });
    const managerConfig = join(f.home, 'manager-config');
    await writeFile(f.managerEnvironment, `XDG_CONFIG_HOME=${quote}${managerConfig}${quote}\n`);
    const result = await f.run(NAME, { allowUsers: USERS });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot interpret the user manager's XDG_CONFIG_HOME.*absolute unquoted config directory/);
    assert.match(result.stderr, /release cleanup skipped/);
    const calls = await f.readCalls();
    assert.deepEqual(calls.map(call => [call.command, call.args]), [
      ['npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']],
      ['systemctl', ['--user', 'show-environment']],
    ]);
    assert.equal(await readFile(f.unit, 'utf8'), OLD_UNIT);
    assert.equal(await readFile(f.state, 'utf8'), 'active');
    assert.ok(!existsSync(f.sshConfigHome));
    assert.ok(!existsSync(managerConfig));
    assert.ok(!existsSync(f.enabled));
    assert.equal(await readlink(f.link), join(f.releases, NAME, 'bin/pi-remote'));
    for (const release of ['old', 'previous', NAME]) assert.ok(existsSync(join(f.releases, release)));
  });
});

test('unit PATH keeps unique absolute entries and literal dollar values without Environment expansion', async t => {
  const specialDirectory = (home: string) => join(home, String.raw`tools $USER %n "quoted" \literal`);
  const f = await fixture(t, { pathEntries: home => [
    'relative/bin', '', '.', specialDirectory(home), '/usr/bin', '/bin', '/usr/bin', specialDirectory(home),
  ] });
  const result = await f.run(NAME, { allowUsers: USERS });
  assert.equal(result.status, 0, result.stderr);
  const unit = await readFile(f.unit, 'utf8');
  assert.deepEqual(unitArguments(unit, 'Environment', false), [
    `PATH=${[f.fakes, specialDirectory(f.home), '/usr/bin', '/bin'].join(':')}`,
  ]);
  const environment = unit.split('\n').find(line => line.startsWith('Environment='))!;
  assert.ok(environment.includes('$USER'), 'Environment values contain literal dollars');
  assert.ok(!environment.includes('$$USER'), 'Environment does not use ExecStart dollar escaping');
  assert.ok(environment.includes('%%n'), 'Environment still escapes systemd percent specifiers');
});

test('existing matching routes and enabled linger need no manual change instructions', async t => {
  const f = await fixture(t);
  const serve = { TCP: { 443: { HTTPS: true } }, Web: { 'remote-box.example.ts.net:443': { Handlers: { '/': { Proxy: `unix:${join(f.home, '.pi-remote-web/web.sock')}` } } } } };
  await writeFile(f.serve, JSON.stringify(serve));
  const result = await f.run(NAME, { allowUsers: USERS });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /tailscale serve --bg|loginctl enable-linger/);
  assert.deepEqual(JSON.parse(await readFile(f.serve, 'utf8')), serve);
  assert.equal(await readFile(f.linger, 'utf8'), 'yes');
});

test('the executable path preserves literal dollars without argv environment escaping', async t => {
  const f = await fixture(t, { nodeName: 'node $USER %n "quoted"' });
  const web = { allowUsers: USERS };
  const result = await f.run(NAME, web);
  assert.equal(result.status, 0, result.stderr);
  const expected = expectedCommand(f.home, f.releases, NAME, web);
  expected[0] = f.node;
  // Unlike argv, systemd resolves this executable path without dollar substitution.
  assert.deepEqual(unitArguments(await readFile(f.unit, 'utf8')), expected);
});

test('generated unit arguments preserve literal dollars, percent signs, quotes, and backslashes', async t => {
  const f = await fixture(t, { homeName: String.raw`home $USER %n 'single' "double"` });
  const web = { allowUsers: [String.raw`literal$USER%n'"\@example.com`, 'second@example.com'] };
  const result = await f.run(NAME, web);
  assert.equal(result.status, 0, result.stderr);
  const unit = await readFile(f.unit, 'utf8');
  assert.ok(unit.includes('$$USER'), 'dollars are escaped against environment expansion');
  assert.ok(unit.includes('%%n'), 'percent signs are escaped against systemd specifier expansion');
  assert.ok(unit.includes(String.raw`\"double\"`), 'double quotes remain inside one argument');
  assert.ok(unit.includes(String.raw`\\@example.com`), 'literal backslashes are escaped');
  assert.deepEqual(unitArguments(unit), expectedCommand(f.home, f.releases, NAME, web));
  const restart = serviceCalls(await f.readCalls()).find(call => call.args[1] === 'restart')!;
  assert.equal(restart.unit, unit);
  assert.equal(restart.oldPresent, true);
});
