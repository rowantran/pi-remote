import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJsonl, writeJsonl } from '../../src/protocol/jsonl.js';
import { PI_VERSION, PROTOCOL_VERSION } from '../../src/protocol/types.js';
import { webRequest } from './http.js';

const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const origin = 'https://phone.example.ts.net';
const login = 'alice@example.test';
const headers = {
  Host: 'localhost', 'X-Forwarded-Host': 'phone.example.ts.net',
  'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': login,
};

async function bounded<T>(promise: Promise<T>, label: string, timeout = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_accept, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

function watchFileState(path: string, present: boolean) {
  let accept!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename?.toString() === basename(path)) void check();
  });
  async function check() {
    try { await lstat(path); if (present) accept(); }
    catch (error: any) {
      if (error.code === 'ENOENT') { if (!present) accept(); }
      else reject(error);
    }
  }
  watcher.on('error', reject);
  // Check after registering so a change between setup and the first check is not lost.
  void check();
  void promise.catch(() => {});
  return { promise, close: () => watcher.close() };
}

async function fixture(t: TestContext, { notifyFails = false, collision = false, notifyWait = false } = {}) {
  const root = await mkdtemp('/tmp/pi-ready-');
  const bin = join(root, 'bin');
  const webState = join(root, 'web');
  const daemonState = join(root, 'daemon');
  const socketPath = join(webState, 'web.sock');
  const notifySocket = join(root, 'dummy-notify.sock');
  const notifyLog = join(root, 'notify.jsonl');
  const waitingPath = join(root, 'notify-waiting');
  const releasePath = join(root, 'notify-release');
  // Register before spawning the CLI; the marker means the notifier's release watch is active.
  const waiting = notifyWait ? watchFileState(waitingPath, true) : undefined;
  const releaseNotifier = () => writeFile(releasePath, 'release');
  const tailscaleLog = join(root, 'tailscale.json');
  const transports = new Set<Socket>();
  const requests: any[] = [];
  let helloDone!: () => void;
  const hello = new Promise<void>(accept => { helloDone = accept; });
  let disconnectedDone!: () => void;
  const disconnected = new Promise<void>(accept => { disconnectedDone = accept; });
  const daemon = createServer(socket => {
    transports.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { transports.delete(socket); disconnectedDone(); });
    readJsonl(socket, record => {
      requests.push(record);
      if (record.method === 'hello') {
        writeJsonl(socket, { type: 'result', id: record.id, success: true,
          data: { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION, pid: process.pid } });
        helloDone();
      } else writeJsonl(socket, { type: 'result', id: record.id, success: false, error: 'Unexpected test daemon request' });
    }, () => socket.destroy());
  });
  let child: ChildProcess | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  t.after(async () => {
    try {
      waiting?.close();
      // Release even on an assertion failure so the test-owned notifier cannot be orphaned.
      if (notifyWait) await releaseNotifier();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (exited) await bounded(exited, 'test CLI cleanup', 3000);
    } finally {
      for (const transport of transports) transport.destroy();
      if (daemon.listening) await bounded(new Promise<void>(accept => daemon.close(() => accept())), 'fake daemon cleanup', 3000);
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const directory of [bin, webState, daemonState]) await mkdir(directory, { mode: 0o700 });
  // PATH contains only these stubs: no real Tailscale or systemd command can run.
  await writeFile(join(bin, 'tailscale'), `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(tailscaleLog)}, JSON.stringify({
  args: process.argv.slice(2), hasNotifySocket: Object.hasOwn(process.env, 'NOTIFY_SOCKET'),
}));
assert.deepEqual(process.argv.slice(2), ['serve', 'status', '--json']);
console.log('{}');
`, { mode: 0o700 });
  await writeFile(join(bin, 'systemd-notify'), `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { request } = require('node:http');
const record = value => fs.appendFileSync(${JSON.stringify(notifyLog)}, JSON.stringify(value) + '\\n');
record({ event: 'invoked', args: process.argv.slice(2), notifySocket: process.env.NOTIFY_SOCKET });
assert.deepEqual(process.argv.slice(2), ['--ready']);
assert.equal(process.env.NOTIFY_SOCKET, ${JSON.stringify(notifySocket)});
const req = request({ socketPath: ${JSON.stringify(socketPath)}, path: '/api/status',
  headers: ${JSON.stringify(headers)}, agent: false }, response => {
  response.resume();
  response.on('end', () => {
    assert.equal(response.statusCode, 200, 'listener must answer before READY');
    const complete = () => {
      record({ event: ${JSON.stringify(notifyFails ? 'rejected' : 'READY')}, status: response.statusCode });
      ${notifyFails ? "console.error('test notifier refused readiness'); process.exitCode = 23;" : ''}
    };
    if (${notifyWait}) {
      let released = false;
      const release = () => {
        if (released || !fs.existsSync(${JSON.stringify(releasePath)})) return;
        released = true;
        clearTimeout(timer);
        watcher.close();
        complete();
      };
      const watcher = fs.watch(${JSON.stringify(root)}, (_event, filename) => {
        if (filename?.toString() === 'notify-release') release();
      });
      const timer = setTimeout(() => {
        watcher.close(); console.error('test notifier barrier timed out'); process.exitCode = 25;
      }, 8000);
      record({ event: 'waiting', status: response.statusCode });
      fs.writeFileSync(${JSON.stringify(waitingPath)}, 'waiting');
      release();
    } else complete();
  });
});
req.setTimeout(2000, () => req.destroy(new Error('readiness HTTP request timed out')));
req.on('error', error => { console.error(error.message); process.exitCode = 24; });
req.end();
`, { mode: 0o700 });
  if (collision) await writeFile(socketPath, 'leave this file alone', { mode: 0o600 });
  const listening = once(daemon, 'listening');
  daemon.listen(join(daemonState, 'daemon.sock'));
  await bounded(listening, 'fake daemon listen');

  // Do not inherit credentials, user config, Node loaders, or a real notification endpoint.
  child = spawn(process.execPath, [cli, 'serve', '--origin', origin, '--allow-user', login,
    '--web-state-dir', webState, '--state-dir', daemonState], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
      TMPDIR: root, PATH: bin, NOTIFY_SOCKET: notifySocket },
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  exited = new Promise((accept, reject) => {
    child!.once('error', reject);
    child!.once('close', (code, signal) => accept({ code, signal }));
  });
  // Cleanup still observes a launch error if it happens before a test awaits exit.
  void exited.catch(() => {});
  const diagnostics = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  async function waitForListener() {
    const listenerLine = `Web listener: ${socketPath}\n`;
    const output = child!.stdout!;
    let check!: () => void;
    const announced = new Promise<void>(accept => {
      check = () => { if (stdout.includes(listenerLine)) accept(); };
      output.on('data', check);
      check();
    });
    try {
      // The CLI prints this only after the notifier has completed and installed its stop handlers.
      await bounded(Promise.race([announced, exited!.then(() => {
        throw new Error(`CLI exited before readiness\n${diagnostics()}`);
      })]), `CLI readiness\n${diagnostics()}`);
    } finally { output.off('data', check); }
  }
  async function notificationRecords() {
    return (await readFile(notifyLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  }
  async function assertTailscaleEnvironment() {
    assert.deepEqual(JSON.parse(await readFile(tailscaleLog, 'utf8')), {
      args: ['serve', 'status', '--json'], hasNotifySocket: false,
    }, 'NOTIFY_SOCKET must be removed before launching any other command');
  }
  return { child, exited, socketPath, notifyLog, notifySocket, daemonState, hello, disconnected,
    requests, waitForListener, notificationRecords, assertTailscaleEnvironment, diagnostics,
    waiting: waiting?.promise, releaseNotifier };
}

test('compiled serve notifies only after HTTP works, isolates NOTIFY_SOCKET, and cleans up on SIGTERM', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.waitForListener();
  assert.deepEqual(await f.notificationRecords(), [
    { event: 'invoked', args: ['--ready'], notifySocket: f.notifySocket },
    { event: 'READY', status: 200 },
  ]);
  await f.assertTailscaleEnvironment();
  assert.equal((await bounded(webRequest(f.socketPath, '/api/status', { headers }), 'status after READY')).status, 200);
  await bounded(f.hello, 'fake daemon handshake');
  assert.ok(f.requests.every(request => request.method === 'hello'), 'readiness must not mutate daemon state');
  assert.equal((await lstat(f.daemonState)).mode & 0o7777, 0o700);
  assert.equal(f.child.kill('SIGTERM'), true);
  assert.deepEqual(await bounded(f.exited, 'SIGTERM shutdown'), { code: 0, signal: null }, f.diagnostics());
  await bounded(f.disconnected, 'activity monitor disconnect');
  await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' });
});

test('compiled serve handles SIGTERM while its notifier is pending and finishes cleanup before release', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { notifyWait: true });
  await bounded(f.waiting!, 'notifier waiting after HTTP 200');
  assert.deepEqual(await f.notificationRecords(), [
    { event: 'invoked', args: ['--ready'], notifySocket: f.notifySocket },
    { event: 'waiting', status: 200 },
  ]);
  await bounded(f.hello, 'fake daemon handshake before SIGTERM');
  assert.equal((await lstat(f.socketPath)).isSocket(), true);
  const removed = watchFileState(f.socketPath, false);
  try {
    assert.equal(f.child.kill('SIGTERM'), true);
    await bounded(Promise.all([removed.promise, f.disconnected]), 'socket and monitor cleanup while notifier waits');
    assert.equal(f.child.exitCode, null, 'CLI must still await the held notifier');
    assert.equal(f.child.signalCode, null, 'SIGTERM must run shutdown handlers, not terminate the CLI');
    await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' });
    await f.releaseNotifier();
    assert.deepEqual(await bounded(f.exited, 'exit after notifier release'), { code: 0, signal: null }, f.diagnostics());
    await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' });
    assert.deepEqual(await f.notificationRecords(), [
      { event: 'invoked', args: ['--ready'], notifySocket: f.notifySocket },
      { event: 'waiting', status: 200 },
      { event: 'READY', status: 200 },
    ]);
    await f.assertTailscaleEnvironment();
  } finally { removed.close(); }
});

test('compiled serve never invokes the notifier when a regular file blocks its Unix socket', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { collision: true });
  const result = await bounded(f.exited, 'bind failure exit');
  assert.equal(result.signal, null, f.diagnostics());
  assert.equal(result.code, 1, f.diagnostics());
  assert.match(f.diagnostics(), /Web socket path already exists/);
  await assert.rejects(lstat(f.notifyLog), { code: 'ENOENT' });
  assert.equal(await readFile(f.socketPath, 'utf8'), 'leave this file alone');
  assert.deepEqual(f.requests, []);
  await f.assertTailscaleEnvironment();
});

test('compiled serve exits nonzero and releases its Unix socket when notification fails', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { notifyFails: true });
  const result = await bounded(f.exited, 'notifier failure exit');
  assert.equal(result.signal, null, f.diagnostics());
  assert.equal(result.code, 1, f.diagnostics());
  assert.match(f.diagnostics(), /test notifier refused readiness/);
  assert.doesNotMatch(f.diagnostics(), /Web listener:/);
  assert.deepEqual(await f.notificationRecords(), [
    { event: 'invoked', args: ['--ready'], notifySocket: f.notifySocket },
    { event: 'rejected', status: 200 },
  ]);
  await f.assertTailscaleEnvironment();
  await bounded(f.hello, 'fake daemon handshake before failure');
  await bounded(f.disconnected, 'activity monitor cleanup after notifier failure');
  await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' });
});
