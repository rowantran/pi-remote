import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Supervisor, socketPath } from '../src/daemon.js';
import { readJsonl, writeJsonl } from '../src/jsonl.js';
import { RemoteView, transcriptMessages } from '../src/view.js';
import { applyLiveEvent, emptyLive } from '../src/live.js';
import type { RecordValue, RemoteEvent, Result, SlotInfo, Snapshot } from '../src/protocol.js';

const fixture = fileURLToPath(new URL('./fixture-pi.mjs', import.meta.url));
const hello = { protocol: 1, piVersion: '1.0.4' };

/** A test-only wire peer: do not depend on the production terminal client. */
class Peer {
  readonly records: (Result | RemoteEvent)[] = [];
  private changes = new EventEmitter();
  private nextId = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private closed = false;
  constructor(readonly socket: Socket) {
    const fail = (error: Error) => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.changes.emit('record');
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('Test peer disconnected')));
    readJsonl(socket, record => {
      this.records.push(record);
      if (record.type === 'result') {
        const pending = this.pending.get(record.id);
        this.pending.delete(record.id);
        if (record.success) pending?.resolve(record.data);
        else pending?.reject(new Error(record.error));
      }
      this.changes.emit('record');
    }, fail);
  }
  static async connect(path: string): Promise<Peer> {
    const socket = createConnection(path);
    const peer = new Peer(socket);
    await once(socket, 'connect');
    return peer;
  }
  async request<T = any>(method: string, params: RecordValue = {}, id = `test-${++this.nextId}`): Promise<T> {
    if (this.closed) throw new Error('Test peer disconnected');
    assert.equal(this.pending.has(id), false, 'Test request IDs must be unique per peer');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Test deadline waiting for ${method}`));
        }, 4000);
        this.pending.set(id, { resolve, reject });
        writeJsonl(this.socket, { type: 'request', id, method, params });
      });
    } finally { clearTimeout(timer); }
  }
  async waitFor(predicate: (record: Result | RemoteEvent) => boolean, from = 0): Promise<any> {
    const find = () => this.records.slice(from).find(predicate);
    const existing = find();
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.changes.off('record', check); };
      const check = () => {
        const found = find();
        if (found) { cleanup(); resolve(found); }
        else if (this.closed) { cleanup(); reject(new Error('Peer disconnected before expected record')); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Test deadline waiting for event')); }, 4000);
      this.changes.on('record', check);
      check();
    });
  }
  event(type: string, from = 0): Promise<RemoteEvent> {
    return this.waitFor(record => record.type === 'event' && record.event.type === type, from);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    const closed = once(this.socket, 'close');
    this.socket.destroy();
    await closed;
  }
}

async function setup(t: TestContext, options: { skipVersionCheck?: boolean } = {}) {
  // /tmp keeps Unix socket paths short even on macOS with a long TMPDIR.
  const dir = await realpath(await mkdtemp('/tmp/pi-remote-test-'));
  const versionFile = join(dir, 'fixture-version');
  const versionLog = join(dir, 'fixture-version-log');
  const envLog = join(dir, 'fixture-env-log');
  const launchLog = join(dir, 'fixture-launch-log');
  const extensionFile = join(dir, 'fixture-extension.json');
  const startDelayFile = join(dir, 'fixture-start-delay');
  const exitFile = join(dir, 'fixture-exit');
  await writeFile(versionFile, hello.piVersion + '\n');
  const supervisor = new Supervisor({ stateDir: dir, executable: process.execPath,
    prefixArgs: [fixture], skipVersionCheck: options.skipVersionCheck ?? true,
    env: { PI_OFFLINE: '1', PI_FIXTURE_VERSION_FILE: versionFile, PI_FIXTURE_VERSION_LOG: versionLog, PI_FIXTURE_ENV_LOG: envLog,
      PI_FIXTURE_LAUNCH_LOG: launchLog, PI_FIXTURE_EXTENSION_FILE: extensionFile, PI_FIXTURE_START_DELAY_FILE: startDelayFile, PI_FIXTURE_EXIT_FILE: exitFile } });
  const peers: Peer[] = [];
  t.after(async () => {
    await Promise.all(peers.map(peer => peer.close()));
    await supervisor.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await supervisor.start();
  const connect = async (verify = true) => {
    const peer = await Peer.connect(socketPath(dir));
    peers.push(peer);
    if (verify) {
      const response = await peer.request('hello', hello);
      assert.deepEqual({protocol: response.protocol, piVersion: response.piVersion, pid: response.pid}, { ...hello, pid: process.pid });
      assert.deepEqual(response.capabilities, ['slot_numbers', 'complete_path', 'read_attachment', 'filesystem_metadata', 'restart']);
    }
    return peer;
  };
  const peer = await connect();
  const create = (args: string[] = []) => peer.request<SlotInfo>('create', { cwd: dir, args });
  const slot = async (args: string[] = []) => {
    const info = await create(args);
    const snapshot = await peer.request<Snapshot>('attach', { slotId: info.id });
    return { info, snapshot };
  };
  return { dir, supervisor, peer, connect, create, slot, versionFile, versionLog, envLog, launchLog, extensionFile, startDelayFile, exitFile };
}
const textOf = (message: RecordValue) => message.content.filter((block: RecordValue) => block.type === 'text').map((block: RecordValue) => block.text).join('');

test('an older concurrent snapshot cannot roll the cached baseline behind the retired tail', async () => {
  const supervisor = new Supervisor({ stateDir: '/tmp/unused-snapshot-test' });
  const live = emptyLive(), state = { sessionId: 'session' };
  const notices = [1, 2].map(timestamp => ({ role: 'custom', customType: 'background', timestamp, content: `notice-${timestamp}` }));
  const entries = notices.map((message, i) => ({ type: 'custom_message', id: String(i + 1), parentId: i ? String(i) : null,
    timestamp: new Date(message.timestamp + 100).toISOString(), customType: message.customType, content: message.content }));
  let reads = 0, checks = 0;
  let validationStarted!: () => void, finishValidation!: (state: RecordValue) => void;
  const waiting = new Promise<void>(resolve => { validationStarted = resolve; });
  const blocked = new Promise<RecordValue>(resolve => { finishValidation = resolve; });
  const slot: RecordValue = { id: 'slot', cwd: '/tmp', status: 'running', seq: 0, state, live, ui: new Map(), changing: false,
    process: { child: { pid: 1 }, command: async (_command: RecordValue, _timeout: number, atResponse: (data: RecordValue) => Snapshot) => {
      applyLiveEvent(live, { type: 'message_end', message: notices[reads] });
      slot.seq = ++reads;
      return atResponse({ entries: entries.slice(0, reads), leafId: String(reads) });
    } } };
  // Deterministically hold the older snapshot's final identity check while a newer reader commits.
  (supervisor as any).refreshState = async () => {
    if (++checks === 2) { validationStarted(); return blocked; }
    return state;
  };
  const older = (supervisor as any).snapshot(slot) as Promise<Snapshot>;
  await waiting;
  const newer = await (supervisor as any).snapshot(slot) as Snapshot;
  assert.equal(newer.seq, 2);
  assert.deepEqual(live.messages, []);
  finishValidation(state);
  assert.equal((await older).seq, 1);
  slot.changing = true;
  const fallback = await (supervisor as any).snapshot(slot) as Snapshot;
  assert.equal(fallback.historyComplete, false);
  assert.deepEqual(fallback.entries, entries);
  assert.equal(transcriptMessages(fallback).length, 2, 'No entry can be lost by rolling back a retired baseline');
});

test('private Unix socket, strict hello, and reserved launch arguments', { timeout: 10_000 }, async t => {
  const { dir, peer, connect } = await setup(t);
  assert.equal((await stat(socketPath(dir))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const unverified = await connect(false);
  await assert.rejects(unverified.request('list'), /hello/);
  await assert.rejects(unverified.request('hello', { ...hello, piVersion: 'wrong' }), /Version mismatch/);
  await assert.rejects(unverified.request('hello', { ...hello, protocol: 2 }), /Version mismatch/);
  await unverified.request('hello', hello);
  assert.deepEqual(await unverified.request('list'), []);
  for (const args of [['--mode=rpc'], ['--no-session'], ['--api-key=not-a-secret'], ['--']]) {
    await assert.rejects(peer.request('create', { cwd: dir, args }), /daemon session options/);
  }
  assert.deepEqual(await peer.request('list'), []);
});

test('each Pi process receives the pi-remote session environment', { timeout: 10_000 }, async t => {
  const { slot, envLog } = await setup(t);
  const first = await slot();
  const second = await slot();
  const env = (await readFile(envLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(env, [first.info, second.info].map(info => ({
    PI_REMOTE_SESSION: '1', PI_REMOTE_SESSION_HOST: hostname(),
    PI_REMOTE_SESSION_SLOT: info.id, PI_REMOTE_SESSION_SLOT_NUMBER: String(info.number),
  })));
});

test('disconnect during streaming preserves partial state and completed session history', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info } = await slot();
  assert.deepEqual(await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: 'offline run' } }), { disposition: 'started' });
  await peer.event('message_update');
  await peer.close();
  const reattached = await connect();
  const partial = await reattached.request<Snapshot>('attach', { slotId: info.id });
  assert.equal(partial.live.busy, true);
  assert.equal(textOf(partial.live.messages.find(message => message.role === 'assistant')!), 'partial: ');
  assert.equal(partial.entries.filter(entry => entry.message?.role === 'assistant').length, 0, 'Pending messages are not persisted');
  await reattached.event('agent_settled');
  await reattached.close();
  const afterCompletion = await connect();
  const complete = await afterCompletion.request<Snapshot>('attach', { slotId: info.id });
  assert.equal(complete.live.busy, false);
  const assistant = complete.entries.find(entry => entry.message?.role === 'assistant');
  assert.equal(textOf(assistant!.message), 'partial: offline run complete');
  assert.equal(assistant!.message.stopReason, 'stop');
  assert.equal(complete.leafId, assistant!.id);
  const events = reattached.records.filter((record): record is RemoteEvent => record.type === 'event');
  assert.ok(events.every((event, index) => event.slotId === info.id && event.seq > partial.seq && (!index || event.seq > events[index - 1].seq)));
  const disk = (await readFile(info.sessionFile!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(disk[0].type, 'session');
  assert.equal(disk.at(-1).message.stopReason, 'stop');
});

test('dialog opened without a client persists and replays to two clients; first answer wins', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info } = await slot();
  const abandoned = peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/dialog' } }).then(() => 'resolved', () => 'disconnected');
  // A query barrier confirms the child consumed /dialog before the socket closes.
  await peer.request('rpc', { slotId: info.id, command: { type: 'get_state' } });
  await peer.close();
  assert.equal(await abandoned, 'disconnected');
  await delay(220); // Deliberately longer than the fixture's explicit /timeout duration.
  const first = await connect();
  const second = await connect();
  const a = await first.request<Snapshot>('attach', { slotId: info.id });
  const b = await second.request<Snapshot>('attach', { slotId: info.id });
  assert.equal(a.ui.length, 1);
  assert.deepEqual(a.ui, b.ui);
  assert.equal(a.ui[0].method, 'input');
  assert.equal(a.ui[0].timeout, undefined);
  const id = a.ui[0].id;
  await first.request('answer', { slotId: info.id, response: { id, value: 'first' } });
  await assert.rejects(second.request('answer', { slotId: info.id, response: { id, value: 'second' } }), /already answered or expired/);
  for (const client of [first, second]) {
    const resolved = await client.event('remote_dialog_resolved');
    assert.deepEqual(resolved.event, { type: 'remote_dialog_resolved', id, reason: 'answered' });
    const notify = await client.waitFor(record => record.type === 'event' && record.event.method === 'notify');
    assert.equal(notify.event.message, 'answer:{"value":"first"}');
  }
  assert.deepEqual((await second.request<Snapshot>('snapshot', { slotId: info.id })).ui, []);
});

test('commands waiting on a confirm dialog have no added deadline', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  let completed = false;
  const command = peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/confirm' } }).then(result => { completed = true; return result; });
  const dialog = (await peer.event('extension_ui_request')).event;
  assert.equal(dialog.method, 'confirm');
  await delay(220);
  assert.equal(completed, false);
  const snapshot = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(snapshot.ui[0].id, dialog.id);
  await peer.request('answer', { slotId: info.id, response: { id: dialog.id, confirmed: true } });
  assert.deepEqual(await command, { disposition: 'handled' });
  const notification = await peer.waitFor(record => record.type === 'event' && record.event.method === 'notify');
  assert.equal(notification.event.message, 'answer:{"confirmed":true}');
});

test('explicit extension dialog timeout is respected and cannot be answered afterward', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  const command = peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/timeout' } });
  const dialog = (await peer.event('extension_ui_request')).event;
  assert.equal(dialog.timeout, 120);
  assert.deepEqual((await peer.event('remote_dialog_resolved')).event, { type: 'remote_dialog_resolved', id: dialog.id, reason: 'timeout' });
  assert.deepEqual(await command, { disposition: 'handled' });
  assert.deepEqual((await peer.request<Snapshot>('snapshot', { slotId: info.id })).ui, []);
  await assert.rejects(peer.request('answer', { slotId: info.id, response: { id: dialog.id, value: 'late' } }), /expired/);
});

test('snapshot cut precedes events in the same get_entries stdout chunk and attach replays them', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info } = await slot();
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/boundary' } });
  const attaching = await connect();
  const snapshot = await attaching.request<Snapshot>('attach', { slotId: info.id }, 'boundary-attach');
  assert.deepEqual(snapshot.entries, []);
  assert.deepEqual(snapshot.live.messages, []);
  assert.equal(snapshot.live.busy, false, 'The snapshot must not include events parsed after its entries response');
  await attaching.event('agent_settled');
  const resultIndex = attaching.records.findIndex(record => record.type === 'result' && record.id === 'boundary-attach');
  const following = attaching.records.slice(resultIndex + 1).filter((record): record is RemoteEvent => record.type === 'event');
  const burst = following.slice(0, 6);
  assert.deepEqual(burst.map(record => record.event.type), ['agent_start', 'message_start', 'message_update', 'message_end', 'agent_end', 'agent_settled']);
  assert.deepEqual(burst.map(record => record.seq), Array.from({ length: 6 }, (_, index) => snapshot.seq + index + 1));
  const recovered = await attaching.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(textOf(recovered.entries[0].message), 'boundary complete');
  assert.equal(recovered.live.busy, false);
  assert.equal(recovered.historyComplete, true);
  assert.deepEqual(recovered.live.messages, [], 'Completed post-cut events are covered by the next snapshot');
});

test('snapshots replace thirteen earlier background completions with saved history and preserve partial work', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info, snapshot: initial } = await slot();
  const view = new RemoteView(initial), from = peer.records.length;
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/background-tail' } });
  for (const record of peer.records.slice(from)) if (record.type === 'event') view.apply(record);
  const liveNotices = view.snapshot.live.messages.filter(message => message.role === 'custom');
  assert.equal(liveNotices.length, 13, 'Identical live notices are separate occurrences');
  assert.equal(transcriptMessages(view.snapshot).length, 14);
  const partial = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(partial.historyComplete, true);
  assert.equal(partial.live.busy, true);
  assert.equal(partial.entries.length, 13);
  assert.deepEqual(partial.live.messages.map(textOf), ['PARTIAL_BACKGROUND_ANSWER']);
  assert.equal(Date.parse(partial.entries[0].timestamp) - liveNotices[0].timestamp, 60_000,
    'Custom message creation and persistence timestamps need not match');
  view.replace(partial);
  const messages = transcriptMessages(view.snapshot);
  assert.equal(messages.filter(message => message.role === 'custom').length, 13);
  assert.equal(messages.filter(message => message.content === 'BACKGROUND_11').length, 2);
  assert.equal(textOf(messages.at(-1)!), 'PARTIAL_BACKGROUND_ANSWER');
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/finish-background-tail' } });
  const complete = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.deepEqual(complete.live.messages, []);
  view.replace(complete);
  const final = transcriptMessages(view.snapshot);
  assert.equal(final.filter(message => message.role === 'custom').length, 13);
  assert.equal(final.length, 15);
  assert.equal(textOf(final.at(-2)!), 'FINAL_BACKGROUND_ANSWER');
  assert.equal(final.at(-1)!.customType, 'worked-for');
  const reattached = await connect();
  const restored = await reattached.request<Snapshot>('attach', { slotId: info.id });
  assert.equal(restored.historyComplete, true);
  assert.deepEqual(restored.live.messages, []);
  assert.deepEqual(transcriptMessages(restored), final);
});

test('an incomplete transition preserves identical notices in its cached baseline', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot(['--fixture-new-session-dialog']);
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/background-tail' } });
  const verified = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(transcriptMessages(verified).filter(message => message.role === 'custom').length, 13);
  const changing = peer.request('rpc', { slotId: info.id, command: { type: 'new_session' } });
  const dialog = (await peer.event('extension_ui_request')).event;
  const incomplete = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(transcriptMessages(incomplete).filter(message => message.role === 'custom').length, 13);
  assert.equal(transcriptMessages(incomplete).length, 14);
  await peer.request('answer', { slotId: info.id, response: { id: dialog.id, cancelled: true } });
  await changing;
});

test('failed snapshots and incomplete session transitions do not retire the live tail', { timeout: 15_000 }, async t => {
  for (const failure of ['/fail-next-entries', '/fail-snapshot-validation']) await t.test(failure, async t => {
    const { peer, slot } = await setup(t);
    const { info } = await slot(['--fixture-new-session-dialog']);
    await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/background-tail' } });
    await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: failure } });
    await assert.rejects(peer.request('snapshot', { slotId: info.id }), /Fixture get_(entries|state) failure/);
    // While the transition waits on a dialog, inspection returns the last verified baseline
    // plus the untouched tail. Neither a failed query nor this incomplete snapshot may retire it.
    const changing = peer.request('rpc', { slotId: info.id, command: { type: 'new_session' } });
    const dialog = (await peer.event('extension_ui_request')).event;
    const incomplete = await peer.request<Snapshot>('snapshot', { slotId: info.id });
    assert.equal(incomplete.historyComplete, false);
    assert.deepEqual(incomplete.entries, []);
    assert.equal(incomplete.live.messages.filter(message => message.role === 'custom').length, 13);
    assert.equal(incomplete.live.messages.length, 14);
    await peer.request('answer', { slotId: info.id, response: { id: dialog.id, cancelled: true } });
    await changing;
    const repaired = await peer.request<Snapshot>('snapshot', { slotId: info.id });
    assert.equal(repaired.historyComplete, true);
    assert.equal(repaired.entries.length, 13);
    assert.deepEqual(repaired.live.messages.map(textOf), ['PARTIAL_BACKGROUND_ANSWER']);
    assert.equal(transcriptMessages(repaired).length, 14);
  });
});

test('slots isolate streams and reject cross-slot RPC and dialog answers', { timeout: 10_000 }, async t => {
  const { peer, connect, slot, create } = await setup(t);
  const { info: a } = await slot();
  const b = await create();
  const other = await connect();
  await other.request('attach', { slotId: b.id });
  assert.notEqual(a.pid, b.pid);
  await assert.rejects(peer.request('rpc', { slotId: b.id, command: { type: 'get_state' } }), /Attach/);
  await assert.rejects(peer.request('answer', { slotId: b.id, response: { id: 'anything', value: 'wrong' } }), /Attach/);
  const aFrom = peer.records.length;
  const bFrom = other.records.length;
  await Promise.all([
    peer.request('rpc', { slotId: a.id, command: { type: 'prompt', message: 'alpha' } }),
    other.request('rpc', { slotId: b.id, command: { type: 'prompt', message: 'beta' } }),
  ]);
  await Promise.all([peer.event('agent_settled', aFrom), other.event('agent_settled', bFrom)]);
  for (const [client, info, from, text] of [[peer, a, aFrom, 'alpha'], [other, b, bFrom, 'beta']] as const) {
    const events = client.records.slice(from).filter((record): record is RemoteEvent => record.type === 'event');
    assert.ok(events.every(event => event.slotId === info.id));
    const snapshot = await client.request<Snapshot>('snapshot', { slotId: info.id });
    assert.equal(textOf(snapshot.entries.at(-1)!.message), `partial: ${text} complete`);
  }
});

test('child IDs are unique despite colliding caller IDs and errors do not poison a slot', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info } = await slot();
  const other = await connect();
  await other.request('attach', { slotId: info.id });
  const results = await Promise.all([
    peer.request('rpc', { slotId: info.id, command: { id: 'collision', type: 'bash', command: 'one' } }, 'same-outer-id'),
    other.request('rpc', { slotId: info.id, command: { id: 'collision', type: 'bash', command: 'two' } }, 'same-outer-id'),
    peer.request('rpc', { slotId: info.id, command: { id: 'collision', type: 'get_messages' } }),
  ]);
  assert.equal(results[0].output, 'one');
  assert.equal(results[1].output, 'two');
  assert.deepEqual(results[2], { messages: [] });
  await assert.rejects(peer.request('rpc', { slotId: info.id, command: { type: 'get_entries', since: 'unknown' } }), /Unknown entry cursor/);
  await assert.rejects(peer.request('rpc', { slotId: info.id, command: { type: 'not_real' } }), /Unsupported Pi RPC command/);
  assert.equal((await peer.request('rpc', { slotId: info.id, command: { type: 'get_state' } })).isStreaming, false);
});

test('unexpected child exit rejects pending commands and marks the slot exited', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  const pending = peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/exit' } });
  await assert.rejects(pending, /Pi exited.*code=23.*fixture requested exit/s);
  const exit = await peer.event('remote_slot_exit');
  assert.match(exit.event.error, /code=23/);
  const slots = await peer.request<SlotInfo[]>('list');
  assert.equal(slots[0].status, 'exited');
  assert.equal(slots[0].pid, undefined);
  await assert.rejects(peer.request('snapshot', { slotId: info.id }), /Pi exited/);
  await assert.rejects(peer.request('attach', { slotId: info.id }), /Pi exited/);
});

test('canonical session double-open guard covers create and switch; kill releases ownership', { timeout: 10_000 }, async t => {
  const { dir, peer, slot } = await setup(t);
  const session = join(dir, 'existing.jsonl');
  await writeFile(session, JSON.stringify({ type: 'session', version: 3, id: 'existing-session', timestamp: new Date().toISOString(), cwd: dir }) + '\n');
  const alias = join(dir, 'alias.jsonl');
  await symlink(session, alias);
  const attempts = await Promise.allSettled([
    peer.request<SlotInfo>('create', { cwd: dir, sessionPath: session }),
    peer.request<SlotInfo>('create', { cwd: dir, sessionPath: alias }),
  ]);
  const success = attempts.filter((result): result is PromiseFulfilledResult<SlotInfo> => result.status === 'fulfilled');
  const failure = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(success.length, 1);
  assert.equal(failure.length, 1);
  assert.match(failure[0].reason.message, /already (being opened|open)/);
  await assert.rejects(peer.request('create', { cwd: dir, sessionPath: alias }), /already open/);
  const { info: another } = await slot();
  await assert.rejects(peer.request('rpc', { slotId: another.id, command: { type: 'switch_session', sessionPath: alias } }), /already open/);
  await peer.request('kill', { slotId: success[0].value.id });
  const reopened = await peer.request<SlotInfo>('create', { cwd: dir, sessionPath: alias });
  assert.equal(reopened.sessionFile, session);
  assert.equal(reopened.status, 'running');
});

test('sessions lists fixture-written history from an explicit isolated directory', { timeout: 15_000 }, async t => {
  const { dir, peer, slot } = await setup(t);
  const sessionDir = join(dir, 'sessions');
  const { info } = await slot(['--session-dir', sessionDir]);
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: 'session listing' } });
  await peer.event('agent_settled');
  const sessions = await peer.request('sessions', { slotId: info.id });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].path, info.sessionFile);
  assert.equal(sessions[0].cwd, dir);
  assert.match(sessions[0].firstMessage, /session listing/);
});

test('successful mutating RPC stays successful when its follow-up get_state fails', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  const from = peer.records.length;
  const result = await peer.request('rpc', { slotId: info.id,
    command: { type: 'prompt', message: '/fail-next-state' } }, 'successful-mutation');
  assert.deepEqual(result, { disposition: 'handled' });
  const replies = peer.records.slice(from).filter(record => record.type === 'result' && record.id === 'successful-mutation');
  assert.equal(replies.length, 1, 'The accepted mutation must have exactly one successful result');
  assert.equal((replies[0] as Result).success, true);
  const state = await peer.request('rpc', { slotId: info.id, command: { type: 'get_state' } });
  assert.equal(state.sessionName, 'mutation applied before refresh failed');
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].status, 'running');
});

test('method-specific dialog validation rejects invalid answers without consuming the pending dialog', { timeout: 20_000 }, async t => {
  const cases: { method: string; message: string; valid: RecordValue; invalid: RecordValue[] }[] = [
    { method: 'confirm', message: '/confirm', valid: { confirmed: false, cancelled: false },
      invalid: [{}, { confirmed: 'true' }, { confirmed: 1 }, { confirmed: null }, { value: 'yes' }] },
    { method: 'input', message: '/dialog', valid: { value: '', cancelled: false },
      invalid: [{}, { value: 1 }, { value: null }, { value: false }, { confirmed: true }] },
    { method: 'editor', message: '/editor', valid: { value: 'line one\nline two', cancelled: false },
      invalid: [{}, { value: [] }, { value: {} }, { value: null }, { confirmed: true }] },
    { method: 'select', message: '/select', valid: { value: 'Allow', cancelled: false },
      invalid: [{}, { value: 'not an option' }, { value: '' }, { value: 1 }, { confirmed: true }] },
  ];
  for (const scenario of cases) await t.test(scenario.method, async t => {
    const { peer, slot } = await setup(t);
    const { info } = await slot();
    const from = peer.records.length;
    let completed = false;
    // Capture rejection immediately so a failing regression still cleans up without unhandled promises.
    const command = peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: scenario.message } })
      .then(data => { completed = true; return { success: true, data }; }, error => ({ success: false, error }));
    const dialog = (await peer.event('extension_ui_request', from)).event;
    assert.equal(dialog.method, scenario.method);
    const invalid = [...scenario.invalid, ...['true', 0, null].map(cancelled => ({ ...scenario.valid, cancelled }))];
    for (const response of invalid) {
      await assert.rejects(peer.request('answer', { slotId: info.id, response: { id: dialog.id, ...response } }),
        `Invalid ${scenario.method} answer ${JSON.stringify(response)} must fail`);
      const snapshot = await peer.request<Snapshot>('snapshot', { slotId: info.id });
      assert.ok(snapshot.ui.some(request => request.id === dialog.id), 'Invalid answers must leave the dialog pending');
      assert.equal(completed, false);
      assert.equal(peer.records.slice(from).some(record => record.type === 'event' && record.event.type === 'remote_dialog_resolved'), false);
    }
    await peer.request('answer', { slotId: info.id, response: { id: dialog.id, ...scenario.valid } });
    assert.deepEqual(await command, { success: true, data: { disposition: 'handled' } });
    assert.deepEqual((await peer.request<Snapshot>('snapshot', { slotId: info.id })).ui, []);
  });
  for (const scenario of cases) await t.test(`${scenario.method} cancellation`, async t => {
    const { peer, slot } = await setup(t);
    const { info } = await slot();
    const command = peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: scenario.message } })
      .then(data => ({ success: true, data }), error => ({ success: false, error }));
    const dialog = (await peer.event('extension_ui_request')).event;
    await peer.request('answer', { slotId: info.id, response: { id: dialog.id, cancelled: true } });
    assert.deepEqual(await command, { success: true, data: { disposition: 'handled' } });
  });
});

const clearedLive = { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] };
async function seedOldLive(peer: Peer, slotId: string): Promise<Snapshot> {
  await peer.request('rpc', { slotId, command: { type: 'prompt', message: '/seed-live' } });
  const snapshot = await peer.request<Snapshot>('snapshot', { slotId });
  assert.equal(snapshot.live.busy, true);
  assert.equal(snapshot.live.compacting, true);
  assert.equal(textOf(snapshot.live.messages[0]), 'old session partial');
  assert.ok(snapshot.live.tools['old-tool']);
  assert.deepEqual(snapshot.live.steering, ['old steering']);
  assert.deepEqual(snapshot.live.followUp, ['old follow-up']);
  return snapshot;
}

test('snapshot clears old live state when sessionId changes even at the same session file path', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  const before = await seedOldLive(peer, info.id);
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/switch-on-snapshot' } });
  const after = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.notEqual(after.state.sessionId, before.state.sessionId);
  assert.equal(after.state.sessionFile, before.state.sessionFile, 'A changed session ID, not just the file path, must reset live state');
  assert.deepEqual(after.entries, []);
  assert.deepEqual(after.live, clearedLive);
  const reattached = await peer.request<Snapshot>('attach', { slotId: info.id });
  assert.deepEqual(reattached.live, clearedLive);
});

test('extension-driven session switch clears prior live state without an explicit switch_session RPC', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  const before = await seedOldLive(peer, info.id);
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/switch-session' } });
  const after = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.notEqual(after.state.sessionId, before.state.sessionId);
  assert.notEqual(after.state.sessionFile, before.state.sessionFile);
  assert.deepEqual(after.entries, []);
  assert.deepEqual(after.live, clearedLive);
});

test('new_session resets all prior live state before the next snapshot', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  const before = await seedOldLive(peer, info.id);
  assert.deepEqual(await peer.request('rpc', { slotId: info.id, command: { type: 'new_session' } }), { cancelled: false });
  const after = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.notEqual(after.state.sessionId, before.state.sessionId);
  assert.deepEqual(after.entries, []);
  assert.deepEqual(after.live, clearedLive);
});

test('failed attach detaches the peer and denies RPC until a successful reattach', { timeout: 10_000 }, async t => {
  const { peer, slot, create } = await setup(t);
  const { info: previous } = await slot();
  const target = await create(['--fixture-fail-entries', '1']);
  await assert.rejects(peer.request('attach', { slotId: target.id }), /Fixture get_entries failure/);
  for (const slotId of [target.id, previous.id]) {
    await assert.rejects(peer.request('rpc', { slotId, command: { type: 'get_state' } }), /Attach/);
  }
  const slots = await peer.request<SlotInfo[]>('list');
  assert.ok(slots.every(slot => slot.clients === 0), 'A failed attach must not leave the peer counted as attached');
  const snapshot = await peer.request<Snapshot>('attach', { slotId: target.id });
  assert.equal(snapshot.slot.id, target.id);
  const state = await peer.request('rpc', { slotId: target.id, command: { type: 'get_state' } });
  assert.equal(state.sessionFile, target.sessionFile);
});

test('every create rechecks executable version while existing slots keep running', { timeout: 15_000 }, async t => {
  const { peer, slot, create, versionFile, versionLog } = await setup(t, { skipVersionCheck: false });
  const probeCount = async () => (await readFile(versionLog, 'utf8')).trim().split('\n').length;
  const initialProbes = await probeCount();
  const { info } = await slot();
  assert.equal(await probeCount(), initialProbes + 1, 'Create must probe the version even after successful daemon startup');
  await writeFile(versionFile, '9.9.9\n');
  await assert.rejects(create(), /version/i);
  assert.equal(await probeCount(), initialProbes + 2);
  const slots = await peer.request<SlotInfo[]>('list');
  assert.equal(slots.length, 1, 'A version mismatch must not create a slot');
  assert.equal(slots[0].id, info.id);
  assert.equal(slots[0].pid, info.pid);
  assert.equal(slots[0].status, 'running');
  assert.equal((await peer.request('rpc', { slotId: info.id, command: { type: 'get_state' } })).sessionFile, info.sessionFile);
  await writeFile(versionFile, hello.piVersion + '\n');
  const restored = await create();
  assert.equal(restored.status, 'running');
  assert.equal(await probeCount(), initialProbes + 3);
});

test('slow startup returns starting after the grace period, preserves Pi, and exposes startup UI', { timeout: 10_000 }, async t => {
  const { peer, create } = await setup(t);
  const began = performance.now();
  const info = await create(['--fixture-start-delay=1800']);
  const elapsed = performance.now() - began;
  assert.equal(info.status, 'starting');
  assert.ok(elapsed >= 1400, `Create returned before its startup grace period: ${elapsed}ms`);
  assert.ok(info.pid);
  assert.doesNotThrow(() => process.kill(info.pid!, 0));
  const starting = await peer.request<Snapshot>('attach', { slotId: info.id });
  assert.equal(starting.slot.status, 'starting');
  assert.equal(starting.historyComplete, false);
  assert.ok(starting.ui.some(request => request.method === 'setStatus' && request.statusText === 'Starting fixture'));
  await peer.waitFor(record => record.type === 'event' && record.event.type === 'remote_state' && Boolean(record.event.state.sessionId));
  const ready = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(ready.slot.status, 'running');
  assert.equal(ready.slot.pid, info.pid);
  assert.ok(ready.state.sessionId);
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].status, 'running');
  assert.equal(peer.records.some(record => record.type === 'event' && record.event.type === 'remote_slot_exit'), false);
});

test('new_session awaiting an extension hook dialog remains answerable after disconnect and reattach', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info, snapshot: original } = await slot(['--fixture-new-session-dialog']);
  const pending = peer.request('rpc', { slotId: info.id, command: { type: 'new_session' } })
    .then(() => 'completed', () => 'disconnected');
  const dialog = (await peer.event('extension_ui_request')).event;
  assert.equal(dialog.title, 'New session hook');
  await peer.close();
  assert.equal(await pending, 'disconnected');
  const reattached = await connect();
  const waiting = await reattached.request<Snapshot>('attach', { slotId: info.id });
  assert.equal(waiting.state.sessionId, original.state.sessionId);
  assert.equal(waiting.historyComplete, false);
  assert.ok(waiting.ui.some(request => request.id === dialog.id));
  const from = reattached.records.length;
  await reattached.request('answer', { slotId: info.id, response: { id: dialog.id, confirmed: true } });
  await reattached.waitFor(record => record.type === 'event' && record.event.type === 'remote_state'
    && record.event.state.sessionId !== original.state.sessionId, from);
  await reattached.event('remote_refresh', from);
  const completed = await reattached.request<Snapshot>('snapshot', { slotId: info.id });
  assert.notEqual(completed.state.sessionId, original.state.sessionId);
  assert.deepEqual(completed.ui, []);
  assert.deepEqual(completed.live, clearedLive);
  assert.equal(completed.slot.status, 'running');
});

test('an explicit kill records a clean stop reason without startup stderr', { timeout: 10_000 }, async t => {
  const { peer, create } = await setup(t);
  const info = await create();
  await peer.request('kill', { slotId: info.id });
  const [stopped] = await peer.request<SlotInfo[]>('list');
  assert.equal(stopped.status, 'exited');
  assert.equal(stopped.error, 'Stopped by request (code=0, signal=null).');
});

test('reload replaces Pi in the same slot, restores disk history, and reloads extension resources for every client', { timeout: 10_000 }, async t => {
  const { dir, peer, connect, slot, launchLog, envLog, extensionFile } = await setup(t);
  const ui = (version: string) => ({ commands: [`command-${version}`], ui: [
    { id: version, method: 'setWidget', widgetKey: version, widgetLines: [version] },
    { id: `status-${version}`, method: 'setStatus', statusKey: version, statusText: version },
  ] });
  await writeFile(extensionFile, JSON.stringify(ui('old')));
  const args = ['--session-dir', join(dir, 'history'), '--fixture-shutdown-events'];
  const { info, snapshot: initial } = await slot(args);
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: 'saved history' } });
  await peer.event('agent_settled');
  await peer.request('rpc', { slotId: info.id, command: { type: 'set_session_name', name: 'Retained name' } });
  const before = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  const other = await connect();
  await other.request('attach', { slotId: info.id });
  const view = new RemoteView(before);
  const from = peer.records.length;
  await writeFile(extensionFile, JSON.stringify(ui('new')));
  const result = await peer.request<SlotInfo>('restart', { slotId: info.id });
  assert.equal(result.id, info.id); assert.equal(result.number, info.number);
  assert.equal(result.createdAt, info.createdAt); assert.equal(result.cwd, info.cwd);
  assert.equal(result.sessionFile, info.sessionFile); assert.notEqual(result.pid, info.pid);
  const restart = await peer.event('remote_slot_restart', from);
  assert.equal(restart.event.slot.status, 'starting');
  view.apply(restart);
  assert.deepEqual(view.snapshot.ui, []);
  assert.deepEqual(view.snapshot.live, emptyLive());
  assert.deepEqual(view.snapshot.entries, before.entries, 'Transition must retain saved history');
  await other.event('remote_slot_restart');
  const after = await other.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(after.slot.status, 'running');
  assert.equal(after.state.sessionId, initial.state.sessionId);
  assert.equal(after.state.sessionName, 'Retained name');
  assert.deepEqual(after.entries, before.entries);
  assert.deepEqual(after.live, emptyLive());
  assert.deepEqual(after.ui.map(record => record.widgetKey ?? record.statusKey), ['new', 'new']);
  const commands = await peer.request('rpc', { slotId: info.id, command: { type: 'get_commands' } });
  assert.ok(commands.commands.some((command: RecordValue) => command.name === 'command-new'));
  assert.ok(!commands.commands.some((command: RecordValue) => command.name === 'command-old'));
  const events = peer.records.slice(from).filter((record): record is RemoteEvent => record.type === 'event');
  assert.ok(events.every((record, index) => !index || record.seq > events[index - 1].seq));
  assert.ok(!events.some(record => record.event.type === 'remote_slot_exit' || record.event.widgetKey === 'retired'));
  const launches = (await readFile(launchLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[1].args, ['--mode', 'rpc', ...args, '--session', info.sessionFile]);
  assert.equal(launches[1].cwd, dir);
  const environments = (await readFile(envLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(environments[0], environments[1]);
  const stored = JSON.parse(await readFile(join(dir, 'slots.json'), 'utf8'));
  assert.equal(stored.length, 1); assert.equal(stored[0].sessionFile, info.sessionFile);
  await assert.rejects(peer.request('create', { cwd: dir, sessionPath: info.sessionFile }), /already open/);
});

test('reload requires attachment, validates force, and refuses busy work unless explicitly confirmed', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info } = await slot();
  const unattached = await connect();
  await assert.rejects(unattached.request('restart', { slotId: info.id, force: true }), /Attach/);
  for (const force of ['true', 1, null]) await assert.rejects(peer.request('restart', { slotId: info.id, force }), /force must be a boolean/);
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/seed-live' } });
  const before = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  await assert.rejects(peer.request('restart', { slotId: info.id }), /Remote Pi is busy/);
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].pid, info.pid);
  const unchanged = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.deepEqual(unchanged.live, before.live);
  const result = await peer.request<SlotInfo>('restart', { slotId: info.id, force: true });
  assert.notEqual(result.pid, info.pid);
  const after = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.deepEqual(after.live, emptyLive());
  assert.deepEqual(after.ui, []);
});

test('reload checks pending shell and extension commands even when get_state reports idle', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  const shell = peer.request('rpc', { slotId: info.id, command: { type: 'bash', command: 'pending shell' } });
  await assert.rejects(peer.request('restart', { slotId: info.id }), /Remote Pi is busy/);
  assert.equal((await shell).output, 'pending shell');
  const pending = peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/dialog' } })
    .then(() => 'completed', () => 'interrupted');
  const dialog = (await peer.event('extension_ui_request')).event;
  await assert.rejects(peer.request('restart', { slotId: info.id }), /Remote Pi is busy/);
  await peer.request('restart', { slotId: info.id, force: true });
  assert.equal(await pending, 'interrupted');
  const after = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.deepEqual(after.ui, []);
  await assert.rejects(peer.request('answer', { slotId: info.id, response: { id: dialog.id, value: 'late' } }), /already answered or expired/);
});

test('reload serializes against other clients and session changes without dropping the transport', { timeout: 10_000 }, async t => {
  const { peer, connect, slot } = await setup(t);
  const { info } = await slot(['--fixture-new-session-dialog', '--fixture-stop-delay', '150']);
  const other = await connect(); await other.request('attach', { slotId: info.id });
  const transition = peer.request('rpc', { slotId: info.id, command: { type: 'new_session' } });
  const dialog = (await peer.event('extension_ui_request')).event;
  await assert.rejects(other.request('restart', { slotId: info.id, force: true }), /session change is already in progress/);
  await peer.request('answer', { slotId: info.id, response: { id: dialog.id, confirmed: false } });
  await transition;
  const from = peer.records.length;
  const restart = peer.request('restart', { slotId: info.id });
  await peer.event('remote_slot_restart', from);
  await assert.rejects(other.request('restart', { slotId: info.id }), /already starting or reloading/);
  await assert.rejects(other.request('rpc', { slotId: info.id, command: { type: 'prompt', message: 'do not send' } }), /reloading/);
  await assert.rejects(other.request('kill', { slotId: info.id }), /reloading/);
  const partial = await other.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(partial.slot.status, 'starting'); assert.equal(partial.historyComplete, false);
  const result = await restart;
  assert.equal(result.status, 'running');
  assert.equal((await other.request<SlotInfo[]>('list')).length, 1);
});

test('version or session inspection failure refuses reload before stopping Pi', { timeout: 10_000 }, async t => {
  const { peer, slot, versionFile, versionLog } = await setup(t, { skipVersionCheck: false });
  const { info } = await slot();
  await writeFile(versionFile, 'incompatible\n');
  await assert.rejects(peer.request('restart', { slotId: info.id, force: true }), /does not match required/);
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].pid, info.pid);
  await writeFile(versionFile, hello.piVersion);
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/fail-next-entries' } });
  await assert.rejects(peer.request('restart', { slotId: info.id }), /get_entries failure/);
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].pid, info.pid);
  await peer.request('restart', { slotId: info.id });
  assert.equal((await readFile(versionLog, 'utf8')).trim().split('\n').length, 5);
});

test('reload resumes the current session after /new, not the original launch session', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  await peer.request('rpc', { slotId: info.id, command: { type: 'new_session' } });
  const before = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.notEqual(before.state.sessionFile, info.sessionFile);
  await peer.request('restart', { slotId: info.id });
  const after = await peer.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(after.state.sessionFile, before.state.sessionFile);
  assert.equal(after.state.sessionId, before.state.sessionId);
});

test('disconnect during reload does not cancel it or require a new slot', { timeout: 10_000 }, async t => {
  const { peer, connect, slot, launchLog } = await setup(t);
  const { info } = await slot(['--fixture-stop-delay', '150']);
  const from = peer.records.length;
  const restart = peer.request('restart', { slotId: info.id }).then(() => 'completed', () => 'disconnected');
  await peer.event('remote_slot_restart', from);
  await peer.close(); assert.equal(await restart, 'disconnected');
  const other = await connect();
  await other.request('attach', { slotId: info.id });
  await other.event('remote_state');
  const after = await other.request<Snapshot>('snapshot', { slotId: info.id });
  assert.equal(after.slot.id, info.id); assert.notEqual(after.slot.pid, info.pid);
  assert.equal(after.slot.status, 'running');
  assert.equal((await readFile(launchLog, 'utf8')).trim().split('\n').length, 2);
});

test('slow replacement startup remains attachable and rejects mutations until ready', { timeout: 10_000 }, async t => {
  const { peer, connect, slot, startDelayFile } = await setup(t);
  const { info } = await slot();
  await writeFile(startDelayFile, '3000');
  const result = await peer.request<SlotInfo>('restart', { slotId: info.id });
  assert.equal(result.status, 'starting');
  const other = await connect();
  const attached = await other.request<Snapshot>('attach', { slotId: info.id });
  assert.equal(attached.slot.status, 'starting');
  await assert.rejects(other.request('rpc', { slotId: info.id, command: { type: 'prompt', message: 'not ready' } }), /starting/);
  await other.event('remote_state');
  assert.equal((await other.request<Snapshot>('snapshot', { slotId: info.id })).slot.status, 'running');
});

test('other clients can refresh commands from ready Pi before the restart request returns', { timeout: 10_000 }, async t => {
  const { supervisor, peer, connect, slot } = await setup(t);
  const { info } = await slot();
  const other = await connect(); await other.request('attach', { slotId: info.id });
  let seen!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { seen = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const original = (supervisor as any).startupGrace.bind(supervisor);
  t.mock.method(supervisor as any, 'startupGrace', async (slot: any) => { await original(slot); seen(); await hold; });
  const restart = peer.request('restart', { slotId: info.id });
  await reached;
  const commands = await other.request('rpc', { slotId: info.id, command: { type: 'get_commands' } });
  assert.ok(commands.commands.length);
  await assert.rejects(other.request('rpc', { slotId: info.id, command: { type: 'prompt', message: 'wait' } }), /reloading/);
  release(); await restart;
});

test('reload rechecks work, session identity, and liveness after the path reservation', { timeout: 15_000 }, async t => {
  for (const change of ['busy', 'session', 'exit']) await t.test(change, async t => {
    const { supervisor, peer, slot, launchLog } = await setup(t);
    const { info } = await slot();
    const internal = (supervisor as any).slots.get(info.id);
    let seen!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { seen = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const original = (supervisor as any).checkPath.bind(supervisor);
    t.mock.method(supervisor as any, 'checkPath', async (...args: any[]) => {
      const path = await original(...args); seen(); await hold; return path;
    });
    const restart = peer.request('restart', { slotId: info.id });
    const rejected = assert.rejects(restart, change === 'busy' ? /Remote Pi is busy/ : change === 'session' ? /Session changed during reload/ : /Stopped by request/);
    await reached;
    if (change === 'busy') (supervisor as any).recordEvent(internal, { type: 'agent_start' });
    if (change === 'session') await internal.process.command({ type: 'prompt', message: '/switch-session' });
    if (change === 'exit') await internal.process.stop();
    release(); await rejected;
    assert.equal((await readFile(launchLog, 'utf8')).trim().split('\n').length, 1);
    if (change !== 'exit') assert.equal((await peer.request<SlotInfo[]>('list'))[0].pid, info.pid);
    assert.equal(peer.records.some(record => record.type === 'event' && record.event.type === 'remote_slot_restart'), false);
  });
});

test('a snapshot rejected by the retiring process recovers the cached starting snapshot', async () => {
  const supervisor = new Supervisor({ stateDir: '/tmp/unused-reload-snapshot-test' });
  let reading!: () => void, rejectEntries!: (error: Error) => void;
  const reached = new Promise<void>(resolve => { reading = resolve; });
  const slot: RecordValue = { id: 'slot', cwd: '/tmp', status: 'running', seq: 2, state: { sessionId: 'saved' },
    live: emptyLive(), ui: new Map(), changing: false, incarnation: 1,
    history: { entries: [{ id: 'saved-entry' }], leafId: 'saved-entry', seq: 2 },
    process: { child: { pid: 1 }, command: () => { reading(); return new Promise((_resolve, reject) => { rejectEntries = reject; }); } } };
  (supervisor as any).refreshState = async () => slot.state;
  const snapshot = (supervisor as any).snapshot(slot) as Promise<Snapshot>;
  await reached;
  slot.incarnation++; slot.status = 'starting'; slot.seq++;
  rejectEntries(new Error('Stopped by request'));
  const recovered = await snapshot;
  assert.equal(recovered.slot.status, 'starting'); assert.equal(recovered.historyComplete, false);
  assert.deepEqual(recovered.entries, slot.history.entries); assert.equal(recovered.seq, 3);
});

test('a synchronous replacement launch failure cannot strand the slot in starting', { timeout: 10_000 }, async t => {
  const { supervisor, peer, slot } = await setup(t);
  const { info } = await slot();
  t.mock.method(supervisor as any, 'launch', () => { throw new Error('synchronous spawn failure'); });
  const result = await peer.request<SlotInfo>('restart', { slotId: info.id });
  assert.equal(result.status, 'exited'); assert.equal(result.pid, undefined);
  assert.equal(result.sessionFile, info.sessionFile); assert.equal(result.error, 'synchronous spawn failure');
  await peer.event('remote_slot_exit');
  await peer.request('kill', { slotId: info.id });
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].status, 'exited');
});

test('daemon shutdown during reload does not launch an orphan replacement', { timeout: 15_000 }, async t => {
  for (const phase of ['stopping-old', 'starting-new']) await t.test(phase, async t => {
    const { supervisor, peer, slot, launchLog, startDelayFile } = await setup(t);
    const { info } = await slot(['--fixture-stop-delay', '150']);
    if (phase === 'starting-new') await writeFile(startDelayFile, '3000');
    const from = peer.records.length;
    const restart = peer.request('restart', { slotId: info.id }).catch(() => undefined);
    await peer.event('remote_slot_restart', from);
    if (phase === 'starting-new') await peer.waitFor(record => record.type === 'event' && record.event.statusKey === 'startup', from);
    await supervisor.stop(); await restart;
    const launches = (await readFile(launchLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(launches.length, phase === 'stopping-old' ? 1 : 2);
    for (const launch of launches) assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' });
  });
});

test('late state replies from retired Pi cannot revive the slot or clear a newer state request', async () => {
  const supervisor = new Supervisor({ stateDir: '/tmp/unused-reload-state-test' });
  const replies: ((state: RecordValue) => void)[] = [];
  const slot: RecordValue = { id: 'slot', cwd: '/tmp', status: 'starting', seq: 0, state: {}, live: emptyLive(),
    ui: new Map(), incarnation: 1, process: {
      child: { pid: 1 }, command: (_command: RecordValue, _timeout: number, atResponse: (state: RecordValue) => RecordValue) =>
        new Promise<RecordValue>((resolve, reject) => replies.push(state => { try { resolve(atResponse(state)); } catch (error) { reject(error); } })),
    } };
  const old = (supervisor as any).refreshState(slot) as Promise<RecordValue>;
  const failed = assert.rejects(old, /process changed/);
  slot.incarnation++; slot.stateRequest = undefined;
  const current = (supervisor as any).refreshState(slot) as Promise<RecordValue>;
  const request = slot.stateRequest;
  replies[0]({ sessionId: 'old', sessionFile: '/tmp/old.jsonl' });
  await failed;
  assert.equal(slot.status, 'starting'); assert.deepEqual(slot.state, {});
  assert.equal(slot.stateRequest, request);
  // An exit of the new process also invalidates its outstanding inspection.
  slot.status = 'exited';
  const exited = assert.rejects(current, /process changed/);
  replies[1]({ sessionId: 'new', sessionFile: '/tmp/new.jsonl' });
  await exited;
  assert.equal(slot.status, 'exited'); assert.deepEqual(slot.state, {});
  assert.equal(slot.stateRequest, undefined);
});

test('deleted nonempty sessions refuse reload without stopping their running writer', { timeout: 10_000 }, async t => {
  const { peer, slot } = await setup(t);
  const { info } = await slot();
  await peer.request('rpc', { slotId: info.id, command: { type: 'prompt', message: 'retain this history' } });
  await peer.event('agent_settled');
  await rm(info.sessionFile!);
  await assert.rejects(peer.request('restart', { slotId: info.id, force: true }), /ENOENT/);
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].pid, info.pid);
});

test('failed replacement reports an exited slot with its original session file', { timeout: 10_000 }, async t => {
  const { peer, slot, exitFile } = await setup(t);
  const { info } = await slot();
  await writeFile(exitFile, 'fail');
  const from = peer.records.length;
  const result = await peer.request<SlotInfo>('restart', { slotId: info.id });
  assert.equal(result.status, 'exited'); assert.equal(result.sessionFile, info.sessionFile);
  const exit = await peer.event('remote_slot_exit', from);
  assert.match(exit.event.error, /fixture startup failed/);
  await assert.rejects(peer.request('restart', { slotId: info.id }), /Pi exited/);
});
