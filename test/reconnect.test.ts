import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../src/protocol.js';
import { ReconnectingConnection } from '../src/reconnect.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function snapshot(seq = 0): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/work', createdAt: 'now', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null,
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
    ui: [], seq,
  };
}
function event(seq: number, slotId = 'slot', value: RecordValue = { type: 'message_update' }): RemoteEvent {
  return { type: 'event', slotId, seq, event: value };
}
interface Call { method: string; params: RecordValue; result: ReturnType<typeof deferred<any>> }
class FakeConnection implements RemoteConnection {
  calls: Call[] = [];
  pending = new Set<Call>();
  events = new Set<(event: RemoteEvent) => void>();
  disconnects = new Set<(error: Error) => void>();
  oldEvents: ((event: RemoteEvent) => void)[] = [];
  oldDisconnects: ((error: Error) => void)[] = [];
  initialEvents: RemoteEvent[] = [];
  error?: Error;
  closes = 0;
  autoAttach = true;
  attachedSnapshot = snapshot();
  request<T = any>(method: string, params: RecordValue = {}): Promise<T> {
    if (this.error) return Promise.reject(this.error);
    const call = { method, params, result: deferred<T>() };
    this.calls.push(call);
    this.pending.add(call);
    if (method === 'attach' && this.autoAttach) call.result.resolve(this.attachedSnapshot as T);
    return call.result.promise.finally(() => this.pending.delete(call));
  }
  onEvent(listener: (event: RemoteEvent) => void): () => void {
    this.events.add(listener);
    this.oldEvents.push(listener);
    for (const event of this.initialEvents.splice(0)) listener(event);
    return () => { this.events.delete(listener); };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    this.oldDisconnects.push(listener);
    if (this.error) queueMicrotask(() => { if (this.disconnects.has(listener)) listener(this.error!); });
    return () => { this.disconnects.delete(listener); };
  }
  emit(value: RemoteEvent): void { for (const listener of [...this.events]) listener(value); }
  drop(error = new Error('SSH transport disappeared')): void {
    if (this.error) return;
    this.error = error;
    for (const call of this.pending) call.result.reject(new Error(`${error.message} The result of an in-flight command may be unknown; it was not retried.`));
    for (const listener of [...this.disconnects]) listener(error);
  }
  close(): void { this.closes++; this.drop(new Error('Detached from remote session')); }
}
async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function tick(t: TestContext, ms: number): Promise<void> { t.mock.timers.tick(ms); await settle(); }
type Attempt = FakeConnection | Error | (() => Promise<RemoteConnection>);
async function setup(t: TestContext, ...attempts: Attempt[]) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const connection = await ReconnectingConnection.connect(async () => {
    const attempt = attempts[count++];
    if (!attempt) throw new Error('Unexpected connection attempt');
    if (attempt instanceof Error) throw attempt;
    return typeof attempt === 'function' ? attempt() : attempt;
  }, { minDelayMs: 10, maxDelayMs: 40 });
  t.after(() => connection.close());
  return { connection, count: () => count };
}
async function attached(t: TestContext, ...attempts: Attempt[]) {
  const f = await setup(t, ...attempts);
  await f.connection.request('attach', { slotId: 'slot', protocol: 1, piVersion: 'already negotiated' });
  return f;
}

test('initial attach buffers same-chunk events and excludes events covered by its snapshot', async t => {
  const first = new FakeConnection();
  first.autoAttach = false;
  first.initialEvents = [event(1)];
  const { connection } = await setup(t, first);
  const pending = connection.request<Snapshot>('attach', { slotId: 'slot' });
  first.emit(event(2));
  first.calls[0].result.resolve(snapshot(2));
  first.emit(event(3));
  first.emit(event(4));
  assert.equal((await pending).seq, 2);
  const received: number[] = [];
  const off = connection.onEvent(value => received.push(value.seq));
  first.emit(event(5));
  assert.deepEqual(received, [3, 4, 5]);
  off();
  first.emit(event(6));
  connection.onEvent(value => received.push(value.seq));
  assert.deepEqual(received, [3, 4, 5, 6]);
});

test('recovery publishes its snapshot before same-chunk events and filters old sequence numbers', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  second.autoAttach = false;
  const { connection, count } = await attached(t, first, second);
  const received: string[] = [];
  connection.onEvent(value => received.push(`event:${value.seq}`));
  connection.onDisconnect(error => received.push(`disconnect:${error.message}`));
  connection.onReconnect(value => received.push(`snapshot:${value.seq}`));
  first.drop();
  assert.deepEqual(received, ['disconnect:SSH transport disappeared']);
  assert.equal(count(), 1);
  await tick(t, 10);
  assert.deepEqual(second.calls.map(({ method, params }) => ({ method, params })), [{ method: 'attach', params: { slotId: 'slot' } }]);
  second.emit(event(19));
  second.calls[0].result.resolve(snapshot(20));
  second.emit(event(20));
  second.emit(event(21));
  second.emit(event(99, 'another-slot'));
  second.emit(event(22));
  assert.equal(received.length, 1);
  await settle();
  second.emit(event(23));
  assert.deepEqual(received, ['disconnect:SSH transport disappeared', 'snapshot:20', 'event:21', 'event:22', 'event:23']);
});

test('no prompt, command, answer, create, or query is queued or retried', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const { connection } = await attached(t, first, second);
  const requests: [string, RecordValue][] = [
    ['rpc', { command: { type: 'prompt', message: 'do not duplicate' } }],
    ['rpc', { command: { type: 'steer', message: 'once' } }],
    ['rpc', { command: { type: 'follow_up', message: 'once' } }],
    ['ui_response', { id: 'dialog', response: { value: 'answer once' } }],
    ['create', { cwd: '/work' }], ['list', {}], ['snapshot', { slotId: 'slot' }],
  ];
  const failures = requests.map(([method, params]) => assert.rejects(connection.request(method, params), /in-flight command may be unknown; it was not retried/));
  first.drop();
  await Promise.all(failures);
  for (const [method, params] of requests) await assert.rejects(connection.request(method, params), /SSH transport disappeared/);
  assert.equal(first.calls.length, requests.length + 1);
  await tick(t, 10);
  assert.deepEqual(second.calls.map(value => value.method), ['attach']);
  const fresh = connection.request('list');
  second.calls[1].result.resolve(['fresh']);
  assert.deepEqual(await fresh, ['fresh']);
});

for (const method of ['list', 'create', 'attach']) {
  test(`loss during the original ${method} does not start recovery without a successful attach`, async t => {
    const first = new FakeConnection();
    first.autoAttach = false;
    const { connection, count } = await setup(t, first);
    const rejected = assert.rejects(connection.request(method, { slotId: 'slot', cwd: '/work' }), /not retried/);
    first.drop();
    await rejected;
    await tick(t, 1000);
    assert.equal(count(), 1);
    assert.deepEqual(first.calls.map(value => value.method), [method]);
  });
}

test('a failed original attach never enables recovery', async t => {
  const first = new FakeConnection();
  first.autoAttach = false;
  const { connection, count } = await setup(t, first);
  const rejected = assert.rejects(connection.request('attach', { slotId: 'missing' }), /Slot not found/);
  first.calls[0].result.reject(new Error('Slot not found'));
  await rejected;
  first.drop();
  await tick(t, 1000);
  assert.equal(count(), 1);
});

test('drops during successive recovery attachments discard old generations and keep recovering', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const third = new FakeConnection();
  const fourth = new FakeConnection();
  second.autoAttach = third.autoAttach = false;
  fourth.attachedSnapshot = snapshot(40);
  const { connection, count } = await attached(t, first, second, third, fourth);
  const snapshots: number[] = [];
  const events: number[] = [];
  connection.onReconnect(value => snapshots.push(value.seq));
  connection.onEvent(value => events.push(value.seq));
  first.drop();
  await tick(t, 10);
  second.emit(event(11));
  second.drop();
  await settle();
  await tick(t, 20);
  assert.equal(count(), 3);
  for (const listener of second.oldEvents) listener(event(999));
  for (const listener of second.oldDisconnects) listener(new Error('stale failure'));
  third.calls[0].result.resolve(snapshot(30));
  third.emit(event(31));
  await settle();
  assert.deepEqual(snapshots, [30]);
  assert.deepEqual(events, [31]);
  third.drop();
  await tick(t, 10);
  assert.equal(count(), 4);
  assert.deepEqual(snapshots, [30, 40]);
  assert.deepEqual(events, [31]);
});

test('a result settled just before loss cannot resolve a request from the old generation', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const { connection } = await attached(t, first, second);
  const rejected = assert.rejects(connection.request('rpc', { command: { type: 'prompt' } }), /not retried/);
  first.calls[1].result.resolve({ success: true });
  first.drop();
  await rejected;
  await tick(t, 10);
  assert.deepEqual(second.calls.map(value => value.method), ['attach']);
});

test('close cancels retry timers, unsubscribes, and is idempotent', async t => {
  const first = new FakeConnection();
  const { connection, count } = await attached(t, first);
  first.drop();
  connection.close();
  connection.close();
  await tick(t, 1000);
  assert.equal(count(), 1);
  assert.equal(first.closes, 1);
  assert.equal(first.events.size, 0);
  assert.equal(first.disconnects.size, 0);
  await assert.rejects(connection.request('rpc'), /Detached/);
});

test('explicit detach closes the transport once without starting recovery', async t => {
  const first = new FakeConnection();
  const { connection, count } = await attached(t, first);
  const notices: string[] = [];
  connection.onDisconnect(error => notices.push(error.message));
  const rejected = assert.rejects(connection.request('rpc'), /Detached/);
  connection.close();
  await rejected;
  await tick(t, 1000);
  assert.deepEqual(notices, ['Detached from remote session']);
  assert.equal(count(), 1);
  assert.equal(first.closes, 1);
});

test('close during a factory call closes its eventual transport without attaching', async t => {
  const first = new FakeConnection();
  const late = new FakeConnection();
  const opening = deferred<RemoteConnection>();
  const { connection, count } = await attached(t, first, () => opening.promise);
  first.drop();
  await tick(t, 10);
  connection.close();
  opening.resolve(late);
  await settle();
  await tick(t, 1000);
  assert.equal(count(), 2);
  assert.equal(late.closes, 1);
  assert.deepEqual(late.calls, []);
});

test('close during a recovery attach cancels recovery and suppresses all late events', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  second.autoAttach = false;
  const { connection, count } = await attached(t, first, second);
  const received: unknown[] = [];
  connection.onReconnect(value => received.push(value));
  connection.onEvent(value => received.push(value));
  first.drop();
  await tick(t, 10);
  connection.close();
  second.calls[0].result.resolve(snapshot(20));
  for (const listener of second.oldEvents) listener(event(21));
  await settle();
  await tick(t, 1000);
  assert.equal(count(), 2);
  assert.equal(second.closes, 1);
  assert.deepEqual(received, []);
});

for (const message of ['Slot not found', 'Slot is not running', 'Daemon restarted. Work stopped; session history is on disk. Resume explicitly.']) {
  test(`recovery stops for '${message}' and never creates or restarts Pi`, async t => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    second.autoAttach = false;
    const { connection, count } = await attached(t, first, second);
    const notices: string[] = [];
    connection.onDisconnect(error => notices.push(error.message));
    first.drop();
    await tick(t, 10);
    second.calls[0].result.reject(new Error(message));
    await settle();
    await tick(t, 1000);
    assert.equal(count(), 2);
    assert.equal(second.closes, 1);
    assert.deepEqual(second.calls.map(value => value.method), ['attach']);
    assert.equal(notices.at(-1), message);
    await assert.rejects(connection.request('create'), error => (error as Error).message === message);
  });
}

test('a terminal attach rejection stays terminal when the transport drops in the same chunk', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  second.autoAttach = false;
  const { connection, count } = await attached(t, first, second);
  first.drop();
  await tick(t, 10);
  second.calls[0].result.reject(new Error('Slot not found'));
  second.drop();
  await settle();
  await tick(t, 1000);
  assert.equal(count(), 2);
  await assert.rejects(connection.request('create'), /Slot not found/);
});

test('an exited recovery snapshot is terminal even if the peer reports attach success', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  second.attachedSnapshot.slot.status = 'exited';
  second.attachedSnapshot.slot.error = 'Daemon restarted';
  const { connection, count } = await attached(t, first, second);
  const snapshots: Snapshot[] = [];
  connection.onReconnect(value => snapshots.push(value));
  first.drop();
  await tick(t, 10);
  await tick(t, 1000);
  assert.equal(count(), 2);
  assert.deepEqual(snapshots, []);
  await assert.rejects(connection.request('rpc'), /Daemon restarted/);
});

for (const message of ['Version mismatch: daemon protocol 2, Pi 0.0.0', 'Daemon returned an incompatible protocol or Pi version', 'Remote Pi version 0.0.0 does not match required 1.0.4']) {
  test(`a handshake error '${message}' is terminal`, async t => {
    const first = new FakeConnection();
    const { connection, count } = await attached(t, first, new Error(message));
    first.drop();
    await tick(t, 10);
    await tick(t, 1000);
    assert.equal(count(), 2);
    await assert.rejects(connection.request('list'), error => (error as Error).message === message);
  });
}

test('temporary factory failures back off to the maximum; a handshake timeout is not a version mismatch', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const temporary = new Error('Timed out waiting for the daemon version handshake; remote work was not stopped');
  const { connection, count } = await attached(t, first, temporary, new Error('ECONNREFUSED'), new Error('Network unavailable'), second);
  first.drop();
  await tick(t, 9); assert.equal(count(), 1);
  await tick(t, 1); assert.equal(count(), 2);
  await tick(t, 19); assert.equal(count(), 2);
  await tick(t, 1); assert.equal(count(), 3);
  await tick(t, 39); assert.equal(count(), 3);
  await tick(t, 1); assert.equal(count(), 4);
  await tick(t, 39); assert.equal(count(), 4);
  await tick(t, 1); assert.equal(count(), 5);
  const snapshots: number[] = [];
  connection.onReconnect(value => snapshots.push(value.seq));
  assert.deepEqual(snapshots, [0]);
});

test('late subscriptions receive the recovered snapshot and its bounded event backlog in order', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  second.attachedSnapshot = snapshot(20);
  second.initialEvents = [event(19), event(21)];
  const { connection } = await attached(t, first, second);
  first.drop();
  await tick(t, 10);
  second.emit(event(22));
  const received: string[] = [];
  const off = connection.onReconnect(value => received.push(`snapshot:${value.seq}`));
  connection.onEvent(value => received.push(`event:${value.seq}`));
  off();
  assert.deepEqual(received, ['snapshot:20', 'event:21', 'event:22']);
});

test('throwing reconnect listeners do not stop event delivery or later recovery', async t => {
  t.mock.method(console, 'error', () => {});
  const first = new FakeConnection();
  const second = new FakeConnection();
  const third = new FakeConnection();
  second.attachedSnapshot = snapshot(10);
  second.initialEvents = [event(11)];
  third.attachedSnapshot = snapshot(20);
  const { connection } = await attached(t, first, second, third);
  const received: number[] = [];
  connection.onReconnect(() => { throw new Error('broken UI callback'); });
  connection.onReconnect(value => received.push(value.seq));
  connection.onEvent(value => received.push(value.seq));
  first.drop();
  await tick(t, 10);
  second.drop();
  await tick(t, 10);
  assert.deepEqual(received, [10, 11, 20]);
});

test('a drop inside a reconnect listener schedules the next recovery without replaying old events', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const third = new FakeConnection();
  second.initialEvents = [event(1)];
  const { connection, count } = await attached(t, first, second, third);
  let reconnects = 0;
  const received: number[] = [];
  connection.onReconnect(() => { if (++reconnects === 1) second.drop(); });
  connection.onEvent(value => received.push(value.seq));
  first.drop();
  await tick(t, 10);
  await tick(t, 10);
  assert.equal(count(), 3);
  assert.equal(reconnects, 2);
  assert.deepEqual(received, []);
});

test('late disconnect subscriptions can be cancelled and old loss notifications do not repeat', async t => {
  const first = new FakeConnection();
  const { connection } = await attached(t, first);
  first.drop();
  let calls = 0;
  const off = connection.onDisconnect(() => calls++);
  off();
  await settle();
  assert.equal(calls, 0);
  connection.onDisconnect(() => calls++);
  await settle();
  assert.equal(calls, 1);
});

test('observing an exited slot disables recovery after a subsequent transport loss', async t => {
  const first = new FakeConnection();
  const { connection, count } = await attached(t, first);
  const received: RemoteEvent[] = [];
  connection.onEvent(value => received.push(value));
  first.emit(event(1, 'slot', { type: 'remote_slot_exit', error: 'Pi stopped' }));
  first.drop();
  await tick(t, 1000);
  assert.equal(count(), 1);
  assert.equal(received[0].event.type, 'remote_slot_exit');
});

test('an event backlog larger than 64 MiB fails closed without creating a retry loop', async t => {
  const first = new FakeConnection();
  const { connection, count } = await attached(t, first);
  const notices: string[] = [];
  connection.onDisconnect(error => notices.push(error.message));
  const payload = 'x'.repeat(1024 * 1024);
  for (let seq = 1; seq <= 63; seq++) first.emit(event(seq, 'slot', { type: 'message_update', payload }));
  assert.deepEqual(notices, []);
  first.emit(event(64, 'slot', { type: 'message_update', payload }));
  assert.deepEqual(notices, ['Event backlog exceeded limit']);
  await tick(t, 1000);
  assert.equal(count(), 1);
  assert.equal(first.closes, 1);
});

test('a buffered exit event disables recovery even before the first event subscription', async t => {
  const first = new FakeConnection();
  const { count } = await attached(t, first);
  first.emit(event(1, 'slot', { type: 'remote_slot_exit', error: 'Pi stopped' }));
  first.drop();
  await tick(t, 1000);
  assert.equal(count(), 1);
});

test('closing from the disconnect listener prevents even the first recovery attempt', async t => {
  const first = new FakeConnection();
  const { connection, count } = await attached(t, first);
  connection.onDisconnect(() => connection.close());
  first.drop();
  await tick(t, 1000);
  assert.equal(count(), 1);
  assert.equal(first.closes, 1);
});

test('a replacement that disconnects before subscription still permits the next recovery', async t => {
  const first = new FakeConnection();
  const dead = new FakeConnection();
  dead.drop();
  const third = new FakeConnection();
  const { connection, count } = await attached(t, first, dead, third);
  const received: Snapshot[] = [];
  connection.onReconnect(value => received.push(value));
  first.drop();
  await tick(t, 10);
  assert.equal(dead.closes, 1);
  await tick(t, 20);
  assert.equal(count(), 3);
  assert.equal(received.length, 1);
});

test('a second loss immediately after an attach result suppresses the stale snapshot', async t => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const third = new FakeConnection();
  second.autoAttach = false;
  third.attachedSnapshot = snapshot(30);
  const { connection, count } = await attached(t, first, second, third);
  const received: number[] = [];
  connection.onReconnect(value => received.push(value.seq));
  first.drop();
  await tick(t, 10);
  second.calls[0].result.resolve(snapshot(20));
  second.drop();
  await settle();
  assert.deepEqual(received, []);
  await tick(t, 20);
  assert.equal(count(), 3);
  assert.deepEqual(received, [30]);
});

test('default retry delays are one second through ten seconds, capped at ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = new FakeConnection();
  let count = 0;
  const connection = await ReconnectingConnection.connect(async () => {
    if (++count === 1) return first;
    throw new Error('network unavailable');
  });
  t.after(() => connection.close());
  await connection.request('attach', { slotId: 'slot' });
  first.drop();
  let expected = 1;
  for (const delay of [1000, 2000, 4000, 8000, 10_000, 10_000]) {
    await tick(t, delay - 1);
    assert.equal(count, expected);
    await tick(t, 1);
    assert.equal(count, ++expected);
  }
  connection.close();
  await tick(t, 100_000);
  assert.equal(count, expected);
});

test('initial factory failure is not retried and invalid backoff options fail before opening', async () => {
  let attempts = 0;
  await assert.rejects(ReconnectingConnection.connect(async () => { attempts++; throw new Error('offline'); }), /offline/);
  assert.equal(attempts, 1);
  for (const options of [{ minDelayMs: -1 }, { maxDelayMs: 0 }, { minDelayMs: Number.NaN }, { maxDelayMs: Infinity }]) {
    await assert.rejects(ReconnectingConnection.connect(async () => { attempts++; return new FakeConnection(); }, options), /Reconnect delays/);
  }
  assert.equal(attempts, 1);
});
