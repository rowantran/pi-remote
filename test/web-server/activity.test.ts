import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { Connection } from '../../src/client/connection.js';
import { ACTIVITY_CAPABILITY, activitySource, waitingOnBackground, type ActivitySnapshot } from '../../src/protocol/notification-stream.js';
import { readJsonl } from '../../src/protocol/jsonl.js';
import { PI_VERSION, PROTOCOL_VERSION, type RecordValue, type RemoteEvent, type SlotInfo } from '../../src/protocol/types.js';
import { ActivityTracker, startActivityMonitor, type ActivityNotice, type ActivityMonitorStatus } from '../../src/web/server/activity-monitor.js';

const slot: SlotInfo = { id: 'slot', number: 1, cwd: '/remote', createdAt: '2026-01-01', pid: 123, status: 'running', clients: 0 };
const seed = (options: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({ slot, seq: 10, sessionId: 'session', busy: false, compacting: false, dialogs: [], ...options });
function record(seq: number, source: RecordValue, options: { slot?: SlotInfo; sessionId?: string } = {}): RemoteEvent {
  return { type: 'event', slotId: (options.slot ?? slot).id, seq, event: { type: 'remote_activity', slot: options.slot ?? slot, sessionId: options.sessionId ?? 'session', source: activitySource(source) } };
}
function tracker(initial = seed()) {
  const state = new ActivityTracker();
  state.seed([initial]);
  let seq = initial.seq;
  const notices: ActivityNotice[] = [];
  const send = (type: string, fields: RecordValue = {}, options?: { slot?: SlotInfo; sessionId?: string }) => {
    const event = record(++seq, { type, ...fields }, options);
    const emitted = state.event(event);
    notices.push(...emitted);
    return { event, emitted };
  };
  return { state, send, notices };
}
function waitMessages(): RecordValue[] {
  return [
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'private' }, { type: 'toolCall', name: 'background_wait', id: 'wait', arguments: { secret: 'private' } }] },
    { role: 'toolResult', toolName: 'background_wait', toolCallId: 'wait', isError: false, content: 'private' },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'private' }] },
  ];
}

test('tracker starts quiet, ignores duplicate sequences, and completes a logical run only at settled', () => {
  const f = tracker();
  f.send('agent_end'); f.send('agent_settled');
  assert.equal(f.notices.length, 0);
  f.send('agent_start'); f.send('agent_end');
  assert.equal(f.notices.length, 0);
  f.send('agent_start'); f.send('agent_end'); // retry, still the same logical run
  const settled = f.send('agent_settled');
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].kind, 'done');
  assert.deepEqual(f.state.event(settled.event), []);
  f.send('agent_settled');
  assert.equal(f.notices.length, 1);
  f.send('agent_start'); f.send('agent_settled');
  assert.equal(f.notices.length, 2);
  assert.notEqual(f.notices[0].id, f.notices[1].id);
});

test('seeded idle completions and dialogs never ring; a busy seed may complete once', () => {
  const f = tracker(seed({ dialogs: ['existing'], busy: true }));
  f.send('extension_ui_request', { id: 'existing', method: 'confirm' });
  assert.equal(f.notices.length, 0);
  f.send('agent_settled'); f.send('agent_settled');
  assert.deepEqual(f.notices.map(notice => notice.kind), ['done']);
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    f.send('extension_ui_request', { id: method, method });
    f.send('remote_dialog_resolved', { id: method });
    f.send('extension_ui_request', { id: method, method });
  }
  assert.deepEqual(f.notices.slice(1).map(notice => [notice.kind, notice.method]), ['select', 'confirm', 'input', 'editor'].map(method => ['blocked', method]));
});

test('session/process changes and reload clear stale runs and dialog dedupe without false completions', () => {
  for (const change of ['session', 'process', 'restart']) {
    const f = tracker();
    f.send('extension_ui_request', { id: 'question', method: 'confirm' });
    f.send('agent_start');
    const identity = change === 'session' ? { sessionId: 'new-session' } : change === 'process' ? { slot: { ...slot, pid: 456 } } : {};
    f.send(change === 'restart' ? 'remote_slot_restart' : 'remote_refresh', {}, identity);
    f.send('agent_settled', {}, identity);
    assert.equal(f.notices.length, 1, change);
    f.send('extension_ui_request', { id: 'question', method: 'confirm' }, identity);
    f.send('agent_start', {}, identity); f.send('agent_settled', {}, identity);
    assert.deepEqual(f.notices.map(notice => notice.kind), ['blocked', 'blocked', 'done'], change);
  }
});

test('aborts suppress completion, errors ring once, and an unexpected busy-slot exit rings', () => {
  for (const abort of ['message', 'settled']) {
    const f = tracker();
    f.send('agent_start');
    if (abort === 'message') f.send('message_end', { message: { role: 'assistant', stopReason: 'aborted', content: [] } });
    f.send('agent_settled', abort === 'settled' ? { aborted: true } : {});
    assert.equal(f.notices.length, 0);
  }
  const error = tracker();
  error.send('agent_start'); error.send('message_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: 'secret', content: [] } });
  error.send('agent_end'); error.send('agent_settled');
  assert.equal(error.notices[0].kind, 'error');
  assert.doesNotMatch(JSON.stringify(error.notices), /secret/);
  const busy = tracker(seed({ busy: true }));
  busy.send('remote_slot_exit', { error: 'secret stderr' }, { slot: { ...slot, status: 'exited', pid: undefined, error: 'secret stderr' } });
  assert.equal(busy.notices[0].kind, 'error');
  assert.equal(busy.notices[0].slot.error, undefined);
  busy.send('remote_slot_exit', { error: 'again' });
  assert.equal(busy.notices.length, 1);
  const idle = tracker(); idle.send('remote_slot_exit', { error: 'idle exit' });
  assert.equal(idle.notices.length, 0);
});

test('exact redacted background_wait tail suppresses completion, not parallel/failed/interrupted waits', () => {
  const cases: [string, (messages: RecordValue[]) => void, boolean][] = [
    ['wait', () => {}, true],
    ['parallel', messages => messages[0].content.push({ type: 'toolCall', name: 'bash', id: 'other' }), false],
    ['failed', messages => { messages[1].isError = true; }, false],
    ['missing success', messages => { delete messages[1].isError; }, false],
    ['mismatched ID', messages => { messages[1].toolCallId = 'other'; }, false],
    ['trailing custom', messages => messages.push({ role: 'custom', content: 'private' }), false],
    ['tool reply', messages => messages[2].content.push({ type: 'toolCall', id: 'next', name: 'read' }), false],
    ['error', messages => { messages[2].stopReason = 'error'; }, false],
  ];
  for (const [name, mutate, waiting] of cases) {
    const messages = waitMessages(); mutate(messages);
    const redacted = messages.map(message => (activitySource({ type: 'message_end', message }) as any).message);
    assert.equal(waitingOnBackground(messages), waiting, name);
    assert.equal(waitingOnBackground(redacted), waiting, name);
    const f = tracker(); f.send('agent_start');
    for (const message of messages) f.send('message_end', { message });
    f.send('agent_end'); f.send('agent_settled');
    assert.equal(f.notices.length, waiting ? 0 : 1, name);
  }
});

test('failed sub-runs retry quietly; successful final retries and later wake-ups complete once', () => {
  const f = tracker();
  f.send('agent_start'); f.send('message_end', { message: { role: 'assistant', stopReason: 'error' } }); f.send('agent_end');
  assert.equal(f.notices.length, 0);
  f.send('compaction_start', { reason: 'overflow' }); f.send('compaction_end');
  assert.equal(f.notices.length, 0);
  f.send('agent_start');
  for (const message of waitMessages()) f.send('message_end', { message });
  f.send('agent_settled');
  assert.equal(f.notices.length, 0);
  f.send('agent_start'); f.send('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [] } });
  f.send('agent_settled');
  assert.deepEqual(f.notices.map(notice => notice.kind), ['done']);
});

test('retry/overflow preserves a background_wait pair when only the final assistant is retried', () => {
  for (const recovery of ['retry', 'overflow']) {
    const f = tracker();
    const [call, result, reply] = waitMessages();
    const failed = { role: 'assistant', stopReason: recovery === 'retry' ? 'error' : 'length', content: [] };
    f.send('agent_start');
    for (const message of [call, result, failed]) f.send('message_end', { message });
    f.send('agent_end', { messages: [failed], willRetry: true });
    if (recovery === 'overflow') { f.send('compaction_start', { reason: 'overflow' }); f.send('compaction_end'); }
    f.send('agent_start'); f.send('message_end', { message: reply }); f.send('agent_settled');
    assert.equal(f.notices.length, 0, recovery);
  }
});

test('settled cancellation and retry-exhaustion flags override an otherwise valid wait tail', () => {
  for (const outcome of ['cancelled', 'error']) {
    const f = tracker(); f.send('agent_start');
    for (const message of waitMessages()) f.send('message_end', { message });
    f.send('agent_settled', outcome === 'cancelled' ? { aborted: true } : { error: true });
    assert.deepEqual(f.notices.map(notice => notice.kind), outcome === 'cancelled' ? [] : ['error']);
  }
});

test('manual compaction completes once; automatic compaction cannot bell before its following run', () => {
  const manual = tracker();
  manual.send('compaction_start', { reason: 'manual' }); manual.send('compaction_end'); manual.send('agent_settled');
  assert.deepEqual(manual.notices.map(notice => notice.kind), ['done']);
  manual.send('compaction_start', { reason: 'manual' }); manual.send('compaction_end', { aborted: true });
  assert.equal(manual.notices.length, 1);
  manual.send('compaction_start', { reason: 'manual' }); manual.send('compaction_end', { errorMessage: 'private' });
  assert.deepEqual(manual.notices.map(notice => notice.kind), ['done', 'error']);
  const auto = tracker();
  auto.send('compaction_start', { reason: 'threshold' }); auto.send('compaction_end');
  assert.equal(auto.notices.length, 0);
  auto.send('agent_start'); auto.send('agent_end');
  assert.equal(auto.notices.length, 0);
  auto.send('agent_settled');
  assert.deepEqual(auto.notices.map(notice => notice.kind), ['done']);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function until<T>(events: EventEmitter, event: string, find: () => T | undefined): Promise<T> {
  const found = find();
  if (found !== undefined) return Promise.resolve(found);
  return new Promise((accept, reject) => {
    const cleanup = () => { clearTimeout(timer); events.off(event, check); };
    const check = () => { const found = find(); if (found !== undefined) { cleanup(); accept(found); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Test deadline: ${event}`)); }, 4000);
    events.on(event, check); check();
  });
}
class TestClock {
  private events = new EventEmitter();
  private waits: { ms: number; resolve: () => void; claimed: boolean }[] = [];
  sleep = (ms: number, signal: AbortSignal) => new Promise<void>((accept, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('Aborted')); };
    const wait = { ms, claimed: false, resolve: () => { signal.removeEventListener('abort', aborted); accept(); } };
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    signal.addEventListener('abort', aborted, { once: true });
    this.waits.push(wait); this.events.emit('wait');
  });
  async next() {
    const wait = await until(this.events, 'wait', () => this.waits.find(wait => !wait.claimed));
    wait.claimed = true;
    return wait;
  }
}
function fake(t: TestContext) {
  const input = new PassThrough(), output = new PassThrough();
  const stopped = deferred<void>();
  let stops = 0;
  const connection = new Connection(input, output, () => { stops++; input.destroy(); output.destroy(); stopped.resolve(); });
  const peer = {
    connection, requests: [] as RecordValue[], capabilities: [ACTIVITY_CAPABILITY] as string[], seed: { slots: [seed()] },
    watch: undefined as ((request: RecordValue) => void) | undefined,
    write(...records: RecordValue[]) { input.write(records.map(record => JSON.stringify(record)).join('\n') + '\n'); },
    reply(request: RecordValue, data: unknown) { peer.write({ type: 'result', id: request.id, success: true, data }); },
    stops: () => stops, stopped: stopped.promise,
  };
  readJsonl(output, request => {
    peer.requests.push(request);
    if (request.method === 'hello') peer.reply(request, { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION, capabilities: peer.capabilities, pid: 1 });
    else if (request.method === 'watch_activity') {
      if (peer.watch) peer.watch(request); else peer.reply(request, peer.seed);
    } else throw new Error('Monitor sent a non-read-only request');
  }, () => {});
  t.after(() => connection.close());
  return peer;
}
function statuses() {
  const events = new EventEmitter();
  const changes: ActivityMonitorStatus[] = [];
  return { changes, onStatus: (status: ActivityMonitorStatus) => { changes.push(status); events.emit('status'); },
    wait: (status: ActivityMonitorStatus, after = 0) => until(events, 'status', () => changes.slice(after).find(value => value === status)) };
}

test('monitor buffers same-chunk seed races, ignores seq<=seed, and isolates throwing/rejected onBell callbacks', async t => {
  const peer = fake(t);
  peer.watch = request => peer.write(
    record(9, { type: 'agent_start' }), record(10, { type: 'agent_settled' }),
    { type: 'result', id: request.id, success: true, data: peer.seed },
    record(11, { type: 'agent_start' }), record(12, { type: 'agent_settled' }),
    record(13, { type: 'agent_start' }), record(14, { type: 'agent_settled' }),
  );
  const observed: ActivityNotice[] = [];
  const state = statuses();
  const monitor = startActivityMonitor({ connect: async () => peer.connection, ...state, onBell: notice => {
    observed.push(notice);
    if (observed.length === 1) throw new Error('private callback detail');
    return Promise.reject(new Error('private async detail'));
  } });
  t.after(() => monitor.close());
  await state.wait('active');
  assert.equal(monitor.status, 'active');
  assert.equal(observed.length, 2);
  assert.deepEqual(peer.requests.map(request => request.method), ['hello', 'watch_activity']);
  assert.notEqual(observed[0].id, observed[1].id);
  monitor.close(); await peer.stopped;
  assert.equal(peer.stops(), 1);
});

test('closing from a bell callback stops buffered event drain and never reports active afterward', async t => {
  const peer = fake(t);
  peer.watch = request => peer.write({ type: 'result', id: request.id, success: true, data: peer.seed },
    record(11, { type: 'agent_start' }), record(12, { type: 'agent_settled' }),
    record(13, { type: 'agent_start' }), record(14, { type: 'agent_settled' }));
  const observed: ActivityNotice[] = [];
  const state = statuses();
  const monitor = startActivityMonitor({ connect: async () => peer.connection, ...state, onBell: notice => { observed.push(notice); monitor.close(); } });
  t.after(() => monitor.close());
  await peer.stopped;
  assert.equal(observed.length, 1);
  assert.equal(monitor.status, 'disconnected');
  assert.ok(!state.changes.includes('active'));
});

test('unsupported daemon is probed periodically with hello only, without attach or restart', async t => {
  const peer = fake(t); peer.capabilities = [];
  const clock = new TestClock(), state = statuses();
  let connects = 0;
  const monitor = startActivityMonitor({ connect: async () => { connects++; return peer.connection; }, ...state, sleep: clock.sleep, onBell: () => assert.fail('Unexpected initial bell') });
  t.after(() => monitor.close());
  await state.wait('unsupported');
  assert.equal(monitor.status, 'unsupported');
  const probe = await clock.next();
  assert.equal(probe.ms, 10_000);
  assert.deepEqual(peer.requests.map(request => request.method), ['hello']);
  peer.capabilities = [ACTIVITY_CAPABILITY]; probe.resolve();
  await state.wait('active');
  assert.equal(connects, 1);
  assert.deepEqual(peer.requests.map(request => request.method), ['hello', 'hello', 'watch_activity']);
});

test('disconnect reconnects read-only after backoff, quietly reseeds, and releases transports on close', async t => {
  const first = fake(t), second = fake(t), clock = new TestClock(), state = statuses();
  let connects = 0;
  const monitor = startActivityMonitor({ connect: async () => (++connects === 1 ? first : second).connection, ...state, sleep: clock.sleep, onBell: () => assert.fail('Unexpected bell') });
  t.after(() => monitor.close());
  await state.wait('active');
  const after = state.changes.length;
  first.connection.disconnect(new Error('private transport diagnostic'));
  await state.wait('disconnected', after);
  const retry = await clock.next(); assert.equal(retry.ms, 1000); retry.resolve();
  await state.wait('active', after);
  assert.equal(connects, 2);
  assert.equal(first.stops(), 1);
  assert.deepEqual(second.requests.map(request => request.method), ['hello', 'watch_activity']);
  monitor.close(); await second.stopped;
  assert.equal(second.stops(), 1);
});

test('factory failures use bounded exponential backoff and close handles a pending factory', async t => {
  const peer = fake(t), clock = new TestClock(), state = statuses();
  let attempts = 0;
  const monitor = startActivityMonitor({ connect: async () => { if (++attempts <= 2) throw new Error('private'); return peer.connection; },
    ...state, sleep: clock.sleep, onBell: () => {} });
  t.after(() => monitor.close());
  const first = await clock.next(); assert.equal(first.ms, 1000); first.resolve();
  const second = await clock.next(); assert.equal(second.ms, 2000); second.resolve();
  await state.wait('active');
  assert.equal(attempts, 3);
  monitor.close();
  const pending = deferred<Connection>();
  const late = fake(t);
  const closing = startActivityMonitor({ connect: () => pending.promise, onBell: () => {} });
  closing.close(); pending.resolve(late.connection);
  await late.stopped;
  assert.equal(late.stops(), 1);
  assert.deepEqual(late.requests, []);
});
