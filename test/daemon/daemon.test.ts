/**
 * Daemon lifecycle with a deterministic Pi stand-in (test/fixtures/fixture-pi.mjs).
 * test/daemon/real-pi.test.ts covers the same paths with the real pinned Pi CLI.
 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { socketPath } from '../../src/protocol/paths.js';
import { readJsonl, writeJsonl } from '../../src/protocol/jsonl.js';
import { PI_VERSION, PROTOCOL_VERSION, type RecordValue, type RemoteEvent, type Result, type SlotInfo } from '../../src/protocol/types.js';

const fixture = fileURLToPath(new URL('../fixtures/fixture-pi.mjs', import.meta.url));
const hello = { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION };
const TERMINAL = { columns: 80, rows: 24 };

class Peer {
  readonly records: (Result | RemoteEvent)[] = [];
  private changes = new EventEmitter();
  private nextId = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(readonly socket: Socket) {
    socket.on('error', () => {});
    readJsonl(socket, record => {
      this.records.push(record);
      if (record.type === 'result') {
        const pending = this.pending.get(record.id); this.pending.delete(record.id);
        if (record.success) pending?.resolve(record.data); else pending?.reject(new Error(record.error));
      }
      this.changes.emit('record');
    }, () => {});
  }
  static async connect(path: string): Promise<Peer> {
    const socket = createConnection(path);
    await once(socket, 'connect');
    return new Peer(socket);
  }
  request<T = any>(method: string, params: RecordValue = {}): Promise<T> {
    const id = `t${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Test deadline waiting for ${method}`)); }, 8000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      writeJsonl(this.socket, { type: 'request', id, method, params });
    });
  }
  waitFor(predicate: (record: Result | RemoteEvent) => boolean, from = 0): Promise<any> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.records.slice(from).find(predicate);
        if (found) { clearTimeout(timer); this.changes.off('record', check); resolve(found); }
      };
      const timer = setTimeout(() => { this.changes.off('record', check); reject(new Error('Timed out waiting for record')); }, 8000);
      this.changes.on('record', check); check();
    });
  }
  event(type: string, from = 0): Promise<RemoteEvent> { return this.waitFor(record => record.type === 'event' && record.event.type === type, from); }
  close(): void { this.socket.destroy(); }
}

async function setup(t: TestContext, options: { skipVersionCheck?: boolean } = {}) {
  // /tmp keeps Unix socket paths short even on macOS with a long TMPDIR.
  const dir = await realpath(await mkdtemp('/tmp/pi-remote-test-'));
  const versionFile = join(dir, 'fixture-version'), launchLog = join(dir, 'fixture-launch-log');
  const exitFile = join(dir, 'fixture-exit'), gate = join(dir, 'fixture-gate');
  await writeFile(versionFile, `${PI_VERSION}\n`);
  const daemonOptions = { stateDir: dir, executable: process.execPath, prefixArgs: [fixture], skipVersionCheck: options.skipVersionCheck ?? true,
    env: { PI_FIXTURE_VERSION_FILE: versionFile, PI_FIXTURE_LAUNCH_LOG: launchLog, PI_FIXTURE_EXIT_FILE: exitFile, PI_FIXTURE_PROMPT_GATE: gate } };
  let current = new Supervisor(daemonOptions);
  const peers: Peer[] = [];
  /** Stop the current daemon as runDaemon would, then start its successor in the same state directory. */
  const successor = async () => {
    for (const peer of peers.splice(0)) peer.close();
    await current.stop();
    current = new Supervisor(daemonOptions);
    await current.start();
  };
  t.after(async () => {
    for (const peer of peers) peer.close();
    await current.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await current.start();
  const connect = async (verify = true) => {
    const peer = await Peer.connect(socketPath(dir));
    peers.push(peer);
    if (verify) {
      const response = await peer.request('hello', hello);
      assert.deepEqual(response.capabilities, ['slot_numbers', 'complete_path', 'read_attachment', 'filesystem_metadata', 'restart', 'restart_daemon', 'side_slots', 'activity_stream']);
    }
    return peer;
  };
  const peer = await connect();
  /** Create a slot and wait until Pi reports its session. */
  const create = async (params: RecordValue = {}, client = peer) => {
    const info = await client.request<SlotInfo>('create', { cwd: dir, ...params });
    for (let n = 0; info.status === 'starting'; n++) {
      const listed = (await client.request<SlotInfo[]>('list')).find(slot => slot.id === info.id)!;
      if (listed.status !== 'starting') return listed;
      assert.ok(n < 100, 'Pi reports its session');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return info;
  };
  const attach = (slotId: string, client = peer) => client.request('attach', { slotId, ...TERMINAL });
  /** Type a prompt into Pi and wait until it settles. */
  const prompt = async (slotId: string, text: string, client = peer) => {
    const from = client.records.length;
    await client.request('input', { slotId, data: `${text}\r` });
    await client.event('agent_settled', from);
  };
  return { dir, peer, connect, create, attach, prompt, successor, versionFile, launchLog, exitFile, gate, slots: () => peer.request<SlotInfo[]>('list') };
}

test('private Unix socket, strict hello, and reserved launch arguments', { timeout: 10_000 }, async t => {
  const { dir, peer, connect } = await setup(t);
  assert.equal((await stat(socketPath(dir))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const unverified = await connect(false);
  await assert.rejects(unverified.request('list'), /hello/);
  await assert.rejects(unverified.request('hello', { ...hello, piVersion: 'wrong' }), /Version mismatch/);
  await assert.rejects(unverified.request('hello', { ...hello, protocol: 1 }), /Version mismatch/);
  await unverified.request('hello', hello);
  assert.deepEqual(await unverified.request('list'), []);
  for (const args of [['--mode=rpc'], ['--tui-mode', 'fullscreen'], ['--no-session'], ['--api-key=not-a-secret'], ['--']]) {
    await assert.rejects(peer.request('create', { cwd: dir, args }), /daemon session options/);
  }
  for (const method of ['snapshot', 'rpc', 'answer', 'attach_native']) await assert.rejects(peer.request(method, { slotId: 'x' }), /Unknown daemon method/);
  assert.deepEqual(await peer.request('list'), []);
});

test('each Pi process starts in a terminal with the companion and the pi-remote session environment', { timeout: 10_000 }, async t => {
  const { create, launchLog } = await setup(t);
  const first = await create(), second = await create();
  const launches = (await readFile(launchLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(launches.map(launch => launch.env), [first, second].map(info => ({
    PI_REMOTE_SESSION: '1', PI_REMOTE_SESSION_HOST: hostname(), PI_REMOTE_SESSION_SLOT: info.id, PI_REMOTE_SESSION_SLOT_NUMBER: String(info.number),
  })));
  assert.deepEqual(launches[0].args.slice(0, 3), ['--tui-mode', 'regular', '-e']);
  assert.match(launches[0].args[3], /companion[\\/]index\.(ts|js)$/);
  assert.ok(first.pid && first.pid !== second.pid);
});

test('attach returns the current screen; input reaches Pi; events go only to attached clients of that slot', { timeout: 10_000 }, async t => {
  const { create, attach, prompt, peer, connect } = await setup(t);
  const one = await create(), two = await create();
  const other = await connect();
  await attach(one.id);
  await attach(two.id, other);
  await prompt(one.id, 'hello daemon');
  const screen = await attach(one.id);
  assert.ok(JSON.stringify(screen.messages).includes('echo: hello daemon'));
  assert.equal(screen.busy, false);
  assert.ok(!other.records.some(record => record.type === 'event' && record.slotId === one.id), 'slots isolate their streams');
  await assert.rejects(other.request('input', { slotId: one.id, data: 'x' }), /Attach before sending input/);
  await assert.rejects(peer.request('input', { slotId: one.id, data: '' }), /nonempty/);
  await assert.rejects(peer.request('attach', { slotId: one.id, columns: 1, rows: 24 }), /columns/);
});

test('the client that typed last sets the terminal size', { timeout: 10_000 }, async t => {
  const { create, attach, peer, connect } = await setup(t);
  const info = await create();
  const other = await connect();
  await attach(info.id);
  await other.request('attach', { slotId: info.id, columns: 60, rows: 20 });
  const frameAt = (client: Peer, width: number) => client.waitFor(r => r.type === 'event' && r.event.type === 'screen'
    && r.event.message.type === 'frame' && r.event.message.width === width, client.records.length);
  const narrow = frameAt(peer, 60);
  await other.request('input', { slotId: info.id, data: 'x' });
  await narrow;
  const wide = frameAt(other, 80);
  await peer.request('input', { slotId: info.id, data: 'y' });
  await wide;
});

test('unexpected Pi exit marks the slot exited; kill records a clean stop reason', { timeout: 10_000 }, async t => {
  const { create, slots, peer, attach } = await setup(t);
  const crashing = await create();
  await attach(crashing.id);
  const exit = peer.event('remote_slot_exit');
  process.kill(crashing.pid!, 'SIGKILL');
  assert.match((await exit).event.error, /Pi exited/);
  assert.equal((await slots()).find(slot => slot.id === crashing.id)?.status, 'exited');
  const stopped = await create();
  await peer.request('kill', { slotId: stopped.id });
  const info = (await slots()).find(slot => slot.id === stopped.id)!;
  assert.equal(info.status, 'exited');
  assert.match(info.error!, /Stopped by request/);
});

test('a startup failure reports an exited slot', { timeout: 10_000 }, async t => {
  const { peer, dir, exitFile, slots } = await setup(t);
  await writeFile(exitFile, '');
  const info = await peer.request<SlotInfo>('create', { cwd: dir });
  for (let n = 0; (await slots()).find(slot => slot.id === info.id)?.status !== 'exited'; n++) {
    assert.ok(n < 100); await new Promise(resolve => setTimeout(resolve, 50));
  }
});

test('canonical session double-open guard; kill releases ownership', { timeout: 10_000 }, async t => {
  const { dir, peer, create } = await setup(t);
  const session = join(dir, 'existing.jsonl');
  await writeFile(session, JSON.stringify({ type: 'session', version: 3, id: 'existing-session', timestamp: new Date().toISOString(), cwd: dir }) + '\n');
  const alias = join(dir, 'alias.jsonl');
  await symlink(session, alias);
  const attempts = await Promise.allSettled([
    peer.request<SlotInfo>('create', { cwd: dir, sessionPath: session }),
    peer.request<SlotInfo>('create', { cwd: dir, sessionPath: alias }),
  ]);
  const success = attempts.filter((result): result is PromiseFulfilledResult<SlotInfo> => result.status === 'fulfilled');
  assert.equal(success.length, 1);
  assert.match((attempts.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message, /already (being opened|open)/);
  await assert.rejects(peer.request('create', { cwd: dir, sessionPath: alias }), /already open/);
  await peer.request('kill', { slotId: success[0].value.id });
  const reopened = await create({ sessionPath: alias });
  assert.equal(reopened.sessionFile, session);
  assert.equal(reopened.status, 'running');
});

test('sessions lists a slot\'s saved history and a directory without a slot', { timeout: 15_000 }, async t => {
  const { dir, peer, create, attach, prompt } = await setup(t);
  const sessionDir = join(dir, 'sessions');
  const info = await create({ args: ['--session-dir', sessionDir] });
  await attach(info.id);
  await prompt(info.id, 'session listing');
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  await assert.rejects(peer.request('sessions', {}), /exactly one of slotId or cwd/);
  await assert.rejects(peer.request('sessions', { cwd: workspace, summary: 'yes' }), /summary must be a boolean/);
  assert.ok(Array.isArray(await peer.request('sessions', { cwd: workspace })));
});

test('ping does no work and status reports daemon and host facts', { timeout: 10_000 }, async t => {
  const { peer } = await setup(t);
  assert.deepEqual(await peer.request('ping', {}), {});
  const status = await peer.request('status', {});
  assert.equal(status.pid, process.pid);
  assert.equal(status.piVersion, PI_VERSION);
  assert.equal(status.host.hostname, hostname());
});

test('every create rechecks the executable version while existing slots keep running', { timeout: 15_000 }, async t => {
  const { versionFile, create, peer, dir, slots } = await setup(t, { skipVersionCheck: false });
  const running = await create();
  await writeFile(versionFile, '0.0.1\n');
  await assert.rejects(peer.request('create', { cwd: dir }), /does not match required/);
  assert.equal((await slots()).find(slot => slot.id === running.id)?.status, 'running');
});

test('reload (restart) relaunches Pi in the same slot from its session, and refuses busy work unless forced', { timeout: 15_000 }, async t => {
  const { create, attach, prompt, peer, gate, slots } = await setup(t);
  const info = await create();
  await attach(info.id);
  await prompt(info.id, 'before reload');
  const before = (await slots()).find(slot => slot.id === info.id)!;
  const reloaded = await peer.request<SlotInfo>('restart', { slotId: info.id });
  assert.equal(reloaded.id, info.id);
  assert.notEqual(reloaded.pid, before.pid);
  for (let n = 0; (await slots()).find(slot => slot.id === info.id)?.status !== 'running'; n++) { assert.ok(n < 100); await new Promise(r => setTimeout(r, 50)); }
  const screen = await attach(info.id);
  assert.ok(JSON.stringify(screen.messages).includes('echo: before reload'), 'the replacement reopens the saved session');
  await writeFile(gate, '');
  const started = peer.event('agent_start', peer.records.length);
  await peer.request('input', { slotId: info.id, data: 'busy\r' });
  await started;
  await assert.rejects(peer.request('restart', { slotId: info.id }), /busy/);
  await rm(gate);
});

test('restart_daemon refuses while a slot is busy, then reopens slots with the same IDs, numbers and history', { timeout: 20_000 }, async t => {
  const { create, attach, prompt, peer, gate, successor, connect } = await setup(t);
  const info = await create();
  await attach(info.id);
  await prompt(info.id, 'survives restart');
  await writeFile(gate, '');
  const started = peer.event('agent_start', peer.records.length);
  await peer.request('input', { slotId: info.id, data: 'busy\r' });
  await started;
  const refused = await peer.request('restart_daemon');
  assert.equal(refused.accepted, false);
  assert.match(refused.blocked[0].reason, /busy/);
  await rm(gate);
  await peer.event('agent_settled', peer.records.length - 1);
  const accepted = await peer.request('restart_daemon');
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));
  await successor();
  const client = await connect();
  let reopened: SlotInfo | undefined;
  for (let n = 0; reopened?.status !== 'running'; n++) {
    assert.ok(n < 100); await new Promise(r => setTimeout(r, 50));
    reopened = (await client.request<SlotInfo[]>('list')).find(slot => slot.id === info.id);
  }
  assert.equal(reopened!.number, info.number);
  const screen = await client.request('attach', { slotId: info.id, ...TERMINAL });
  assert.ok(JSON.stringify(screen.messages).includes('echo: survives restart'));
});

test('a daemon that stops without restart_daemon leaves every slot stopped', { timeout: 15_000 }, async t => {
  const { create, successor, connect } = await setup(t);
  const info = await create();
  await successor();
  const client = await connect();
  const listed = (await client.request<SlotInfo[]>('list')).find(slot => slot.id === info.id)!;
  assert.equal(listed.status, 'exited');
  assert.match(listed.error!, /Daemon restarted/);
});

test('side slots fork the parent session, inherit its args, and deliver the first prompt once', { timeout: 15_000 }, async t => {
  const { create, attach, prompt, peer, dir, slots } = await setup(t);
  const parent = await create({ args: ['--session-dir', join(dir, 'sessions')] });
  await attach(parent.id);
  await prompt(parent.id, 'parent work');
  await assert.rejects(peer.request('create', { parentSlotId: parent.id, cwd: dir }), /inherit cwd and args/);
  const side = await peer.request<SlotInfo>('create', { parentSlotId: parent.id, prompt: 'side question' });
  assert.equal(side.parentSlotId, parent.id);
  assert.equal(side.parentSlotNumber, parent.number);
  for (let n = 0; (await slots()).find(slot => slot.id === side.id)?.status !== 'running'; n++) { assert.ok(n < 100); await new Promise(r => setTimeout(r, 50)); }
  for (let n = 0; ; n++) {
    const screen = await attach(side.id);
    if (JSON.stringify(screen.messages).includes('echo: side question')) {
      assert.ok(JSON.stringify(screen.messages).includes('echo: parent work'), 'the side starts from the parent history');
      break;
    }
    assert.ok(n < 100, 'the side gets its first prompt'); await new Promise(r => setTimeout(r, 50));
  }
  await peer.request('kill', { slotId: parent.id });
  for (let n = 0; (await slots()).find(slot => slot.id === side.id)?.status === 'running'; n++) { assert.ok(n < 100); await new Promise(r => setTimeout(r, 50)); }
});
