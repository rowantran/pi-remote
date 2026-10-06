import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Connection, ensureDaemon, ensurePrivateStateDir, handshake, shellQuote, connectSsh } from '../src/client.js';
import { socketPath } from '../src/daemon.js';
import { PI_VERSION, PROTOCOL_VERSION, type RemoteEvent } from '../src/protocol.js';

const hello = { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION, pid: 123 };
function fakeConnection(t: TestContext) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: any[] = [];
  let stops = 0;
  output.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const connection = new Connection(input, output, () => { stops++; input.destroy(); output.destroy(); });
  const reply = (value: any) => input.write(JSON.stringify(value) + '\n');
  t.after(() => connection.close());
  return { connection, input, output, sent, reply, stops: () => stops };
}
async function temporaryDir(t: TestContext) {
  const dir = await mkdtemp('/tmp/pi-client-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('shell quoting preserves empty strings, spaces, quotes, and shell syntax', () => {
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('two words'), "'two words'");
  assert.equal(shellQuote("it's $(not executed); $HOME"), "'it'\\''s $(not executed); $HOME'");
});

test('disconnect rejects in-flight commands without retry and stops transport only once', async t => {
  const f = fakeConnection(t);
  const request = f.connection.request('rpc', { command: { type: 'prompt', message: 'continue remotely' } });
  const rejected = assert.rejects(request, /in-flight command may be unknown; it was not retried/);
  f.connection.disconnect(new Error('SSH transport disappeared'));
  f.connection.close();
  f.connection.close();
  await rejected;
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].params.command.type, 'prompt');
  assert.equal(f.stops(), 1);
  await assert.rejects(f.connection.request('list'), /SSH transport disappeared/);
  await delay(0);
  assert.equal(f.input.listenerCount('data'), 0);
  assert.equal(f.input.listenerCount('end'), 0);
  assert.equal(f.input.listenerCount('error'), 0);
  assert.equal(f.output.listenerCount('error'), 0);
});

test('buffered events preserve order around a result in the same stdout chunk', async t => {
  const f = fakeConnection(t);
  const attach = f.connection.request('attach', { slotId: 'slot' });
  const event = (seq: number) => ({ type: 'event', slotId: 'slot', seq, event: { type: 'message_update', delta: String(seq) } });
  f.input.write([event(1), { type: 'result', id: f.sent[0].id, success: true, data: { seq: 0 } }, event(2)].map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.deepEqual(await attach, { seq: 0 });
  const events: RemoteEvent[] = [];
  const unsubscribe = f.connection.onEvent(value => events.push(value));
  f.reply(event(3));
  assert.deepEqual(events.map(value => value.seq), [1, 2, 3]);
  unsubscribe();
});

test('late disconnect subscription can be cancelled before notification', async t => {
  const f = fakeConnection(t);
  f.connection.close();
  let calls = 0;
  const off = f.connection.onDisconnect(() => calls++);
  off();
  await delay(0);
  assert.equal(calls, 0);
});

test('transport failure preserves the original process error and cleans up pending work', async t => {
  const f = fakeConnection(t);
  const request = f.connection.request('hello');
  const rejected = assert.rejects(request, /Could not start SSH: spawn ssh ENOENT/);
  f.connection.disconnect(new Error('Could not start SSH: spawn ssh ENOENT'));
  await rejected;
  assert.equal(f.stops(), 1);
});

test('handshake times out on a silent stdio peer without sending a remote kill', async t => {
  const f = fakeConnection(t);
  await assert.rejects(handshake(f.connection, 15), /version handshake; remote work was not stopped/);
  assert.deepEqual(f.sent.map(value => value.method), ['hello']);
  assert.equal(f.stops(), 1);
});

test('handshake validates versions and cleans up an incompatible peer', async t => {
  const f = fakeConnection(t);
  const pending = handshake(f.connection, 1000);
  f.reply({ type: 'result', id: f.sent[0].id, success: true, data: { ...hello, piVersion: 'wrong' } });
  await assert.rejects(pending, /incompatible/);
  assert.equal(f.stops(), 1);
});

test('successful handshake clears its timer; subsequent mutations have no deadline', async t => {
  const f = fakeConnection(t);
  const pending = handshake(f.connection, 20);
  f.reply({ type: 'result', id: f.sent[0].id, success: true, data: hello });
  await pending;
  let completed = false;
  const mutation = f.connection.request('rpc', { command: { type: 'prompt', message: '/waiting-dialog' } }).then(value => { completed = true; return value; });
  await delay(50);
  assert.equal(completed, false);
  assert.equal(f.stops(), 0);
  f.reply({ type: 'result', id: f.sent[1].id, success: true, data: { disposition: 'handled' } });
  assert.deepEqual(await mutation, { disposition: 'handled' });
});

test('SSH rejects unsafe hosts before spawning a process', async () => {
  for (const host of ['', '-oProxyCommand=bad', 'host name', 'host\ncommand']) {
    await assert.rejects(connectSsh({ host }), /SSH host alias/);
  }
});

test('private state directory is created as 0700 and existing unsafe modes are unchanged', async t => {
  const dir = await temporaryDir(t);
  const state = join(dir, 'dedicated');
  assert.equal(await ensurePrivateStateDir(state), state);
  assert.equal((await lstat(state)).mode & 0o7777, 0o700);
  await chmod(state, 0o755);
  await assert.rejects(ensurePrivateStateDir(state), /mode 0700/);
  assert.equal((await lstat(state)).mode & 0o7777, 0o755);
});

test('state directory rejects symlinks, files, and wrong ownership before connecting', async t => {
  const dir = await temporaryDir(t);
  const alias = join(dir, 'alias');
  const file = join(dir, 'file');
  await symlink(dir, alias);
  await writeFile(file, 'not a directory');
  await assert.rejects(ensurePrivateStateDir(alias), /not a symlink/);
  await assert.rejects(ensurePrivateStateDir(file), /must be a directory/);
  const originalUid = process.getuid!();
  t.mock.method(process, 'getuid', () => originalUid + 1);
  await assert.rejects(ensurePrivateStateDir(dir), /owned by the current user/);
});

test('concurrent clients launch without reclaiming lock directories', { timeout: 3000 }, async t => {
  const dir = await temporaryDir(t);
  for (const name of ['daemon.lock', 'start.lock']) {
    await mkdir(join(dir, name), { mode: 0o700 });
    await writeFile(join(dir, name, 'pid'), 'stale-owner');
  }
  const peers = new Set<Socket>();
  const server = createServer(socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  let launches = 0;
  let ready: Promise<void> | undefined;
  const launch = async () => {
    launches++;
    for (const name of ['daemon.lock', 'start.lock']) assert.equal(await readFile(join(dir, name, 'pid'), 'utf8'), 'stale-owner');
    ready ??= (async () => {
      await delay(30);
      server.listen(socketPath(dir));
      await once(server, 'listening');
    })();
    await ready;
  };
  const sockets = await Promise.all([ensureDaemon(dir, { launch, timeoutMs: 1000 }), ensureDaemon(dir, { launch, timeoutMs: 1000 })]);
  assert.equal(launches, 2);
  for (const socket of sockets) socket.destroy();
  for (const name of ['daemon.lock', 'start.lock']) assert.equal(await readFile(join(dir, name, 'pid'), 'utf8'), 'stale-owner');
});

test('failed startup leaves stale socket and locks untouched, with fail-closed recovery guidance', { timeout: 3000 }, async t => {
  const dir = await temporaryDir(t);
  await mkdir(join(dir, 'daemon.lock'), { mode: 0o700 });
  await mkdir(join(dir, 'start.lock'), { mode: 0o700 });
  await writeFile(join(dir, 'daemon.lock', 'pid'), 'dead-pid');
  // Rename a bound fake socket before close so Node's original-path cleanup leaves
  // a real, refused Unix socket behind (a regular file is ENOTSOCK on macOS).
  const server = createServer();
  server.listen(join(dir, 'staging.sock'));
  await once(server, 'listening');
  await rename(join(dir, 'staging.sock'), socketPath(dir));
  await new Promise<void>(resolve => server.close(() => resolve()));
  const inode = (await lstat(socketPath(dir))).ino;
  let launches = 0;
  await assert.rejects(ensureDaemon(dir, { launch: async () => { launches++; }, timeoutMs: 1 }), /start\.lock requires manual inspection/);
  assert.equal(launches, 1);
  assert.equal((await lstat(socketPath(dir))).ino, inode);
  assert.equal(await readFile(join(dir, 'daemon.lock', 'pid'), 'utf8'), 'dead-pid');
  assert.equal((await lstat(join(dir, 'start.lock'))).isDirectory(), true);
});

test('existing daemon socket connects without launching or inspecting/removing ownership locks', { timeout: 3000 }, async t => {
  const dir = await temporaryDir(t);
  const peers = new Set<Socket>();
  const server = createServer(socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
  server.listen(socketPath(dir));
  await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const socket = await ensureDaemon(dir, { launch: async () => { assert.fail('Must not launch'); } });
  socket.destroy();
});

test('launch rejects shared log permissions and log symlinks without modifying them', async t => {
  const dir = await temporaryDir(t);
  const log = join(dir, 'daemon.log');
  await writeFile(log, 'private diagnostics', { mode: 0o644 });
  await chmod(log, 0o644);
  await assert.rejects(ensureDaemon(dir), /owner-private regular file/);
  assert.equal((await lstat(log)).mode & 0o777, 0o644);
  await rm(log);
  const target = join(dir, 'target');
  await writeFile(target, 'unchanged', { mode: 0o600 });
  await symlink(target, log);
  await assert.rejects(ensureDaemon(dir));
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
