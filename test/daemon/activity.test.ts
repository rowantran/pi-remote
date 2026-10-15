import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Connection, handshake } from '../../src/client/connection.js';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { ACTIVITY_CAPABILITY, activitySource, type RemoteActivity } from '../../src/protocol/notification-stream.js';
import { socketPath } from '../../src/protocol/paths.js';
import { PI_VERSION, PROTOCOL_VERSION, type RecordValue, type RemoteEvent, type SlotInfo } from '../../src/protocol/types.js';

const fixture = fileURLToPath(new URL('../fixtures/fixture-pi.mjs', import.meta.url));
async function setup(t: TestContext) {
  const dir = await mkdtemp('/tmp/pi-activity-');
  const entriesLog = join(dir, 'entries.log');
  const supervisor = new Supervisor({ stateDir: dir, executable: process.execPath, prefixArgs: [fixture], skipVersionCheck: true,
    sideIdleGraceMs: 60_000, env: { PI_OFFLINE: '1', PI_FIXTURE_ENTRIES_LOG: entriesLog } });
  await supervisor.start();
  const connections: Connection[] = [];
  t.after(async () => { for (const connection of connections) connection.close(); await supervisor.stop(); await rm(dir, { recursive: true, force: true }); });
  async function connect(verified = true) {
    const socket = createConnection(socketPath(dir));
    const connection = new Connection(socket, socket, () => socket.destroy());
    connections.push(connection);
    const events: RemoteEvent[] = [];
    connection.onEvent(event => events.push(event));
    await once(socket, 'connect');
    if (verified) await handshake(connection);
    const wait = (predicate: (event: RemoteEvent) => boolean) => {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<RemoteEvent>((accept, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('Activity event deadline')); }, 4000);
        const off = connection.onEvent(event => { if (predicate(event)) { clearTimeout(timer); off(); accept(event); } });
      });
    };
    return { connection, events, wait };
  }
  const controller = await connect();
  const create = () => controller.connection.request('create', { cwd: dir });
  return { dir, entriesLog, supervisor, controller, connect, create };
}
const activity = (event: RemoteEvent) => event.event as RemoteActivity;

test('watch_activity requires hello and a separate read-only peer; advertises activity_stream', { timeout: 10_000 }, async t => {
  const f = await setup(t);
  const unknown = await f.connect(false);
  await assert.rejects(unknown.connection.request('watch_activity'), /hello/);
  const hello = await unknown.connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
  assert.ok(hello.capabilities?.includes(ACTIVITY_CAPABILITY));
  assert.deepEqual(await unknown.connection.request('watch_activity'), { slots: [] });
  for (const method of ['create', 'attach', 'snapshot', 'list', 'kill', 'rpc', 'answer', 'restart', 'restart_daemon'] as const) {
    await assert.rejects((unknown.connection.request as any)(method, { cwd: f.dir, slotId: 'none' }), /read-only/);
  }
  const slot = await f.create();
  await f.controller.connection.request('attach', { slotId: slot.id });
  await assert.rejects(f.controller.connection.request('watch_activity'), /separate/);
  assert.equal((await f.controller.connection.request('list')).length, 1);
});

test('one observer sees multiple slots without Pi queries, attachments, or changed client counts', { timeout: 10_000 }, async t => {
  const f = await setup(t);
  const first = await f.create();
  const second = await f.create();
  const slots: Map<string, any> = (f.supervisor as any).slots;
  const counts = new Map<string, number>();
  for (const [id, slot] of slots) {
    const command = slot.process.command.bind(slot.process);
    slot.process.command = (value: RecordValue, ...args: any[]) => { counts.set(id, (counts.get(id) ?? 0) + 1); return command(value, ...args); };
  }
  const before = await f.controller.connection.request('list');
  const observer = await f.connect();
  const seed = await observer.connection.request('watch_activity');
  assert.equal(seed.slots.length, 2);
  assert.ok(seed.slots.every(slot => !slot.busy && !slot.compacting && slot.dialogs.length === 0));
  assert.ok(seed.slots.every(slot => slot.sessionId && slot.slot.clients === 0));
  assert.deepEqual(await f.controller.connection.request('list'), before);
  assert.equal([...counts.values()].reduce((sum, count) => sum + count, 0), 0);
  for (const info of [first, second]) (f.supervisor as any).recordEvent(slots.get(info.id), { type: 'agent_start' });
  await observer.wait(event => event.slotId === second.id && activity(event).source.type === 'agent_start');
  assert.deepEqual(new Set(observer.events.map(event => event.slotId)), new Set([first.id, second.id]));
  assert.ok(observer.events.every(event => event.event.type === 'remote_activity'));
  await assert.rejects(readFile(f.entriesLog), { code: 'ENOENT' });
});

test('monitor subscription and disconnect do not change side-slot idle expiry', { timeout: 10_000 }, async t => {
  const f = await setup(t);
  const parent = await f.create();
  const side = await f.controller.connection.request('create', { parentSlotId: parent.id });
  const internal = (f.supervisor as any).slots.get(side.id);
  const expiry = internal.sideExpiry;
  const detachedAt = internal.detachedAt;
  assert.ok(expiry);
  const observer = await f.connect();
  await observer.connection.request('watch_activity');
  assert.equal(internal.sideExpiry, expiry);
  assert.equal(internal.detachedAt, detachedAt);
  assert.equal((await f.controller.connection.request('list')).find(slot => slot.id === side.id)?.clients, 0);
  const otherObserver = await f.connect();
  await otherObserver.connection.request('watch_activity');
  observer.connection.close();
  assert.equal(internal.sideExpiry, expiry);
  // Fire the existing idle-cleanup decision deterministically, without waiting for wall time.
  internal.detachedAt = Date.now() - 60_001;
  await (f.supervisor as any).expireSide(internal);
  await otherObserver.wait(event => event.slotId === side.id && activity(event).source.type === 'remote_slot_exit');
  assert.ok(!(await f.controller.connection.request('list')).some(slot => slot.id === side.id));
  assert.equal((await f.controller.connection.request('list')).find(slot => slot.id === parent.id)?.status, 'running');
});

test('activity seeds and events redact text, arguments, signatures, provider data, dialogs, and exit diagnostics', { timeout: 10_000 }, async t => {
  const f = await setup(t);
  const info = await f.create();
  const internal = (f.supervisor as any).slots.get(info.id);
  await f.controller.connection.request('attach', { slotId: info.id });
  const observer = await f.connect();
  await observer.connection.request('watch_activity');
  const secret = 'SECRET_TRANSCRIPT_OR_CREDENTIAL';
  const assistant = { role: 'assistant', stopReason: 'toolUse', provider: secret, model: secret, errorMessage: secret, content: [
    { type: 'text', text: secret, textSignature: secret }, { type: 'thinking', thinking: secret, thinkingSignature: secret },
    { type: 'toolCall', id: 'wait-id', name: 'background_wait', arguments: { apiKey: secret }, argumentText: secret },
  ] };
  const rawEvents = [
    { type: 'agent_start', secret },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: secret } },
    { type: 'message_end', message: assistant },
    { type: 'message_end', message: { role: 'toolResult', toolName: 'background_wait', toolCallId: 'wait-id', isError: false, content: secret, details: { apiKey: secret } } },
    { type: 'agent_end', messages: [assistant] },
    { type: 'extension_ui_request', id: 'question', method: 'confirm', title: secret, message: secret, options: [secret] },
    { type: 'extension_ui_request', id: 'widget', method: 'setWidget', widgetKey: 'secret', widgetLines: [secret] },
    { type: 'compaction_start', reason: 'manual', secret },
    { type: 'compaction_end', errorMessage: secret, result: { summary: secret } },
  ];
  for (const event of rawEvents) (f.supervisor as any).recordEvent(internal, event);
  await observer.wait(event => activity(event).source.type === 'compaction_end');
  const projected = observer.events.map(event => activity(event).source);
  assert.deepEqual(projected.find(event => event.type === 'message_end'), { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'background_wait', id: 'wait-id' }] } });
  assert.ok(!projected.some(event => (event as any).type === 'message_update'));
  assert.doesNotMatch(JSON.stringify(observer.events), new RegExp(secret));
  const raw = await f.controller.wait(event => event.event.type === 'message_end' && event.event.message.role === 'assistant');
  assert.equal(raw.event.message.provider, secret);
  assert.equal(raw.event.message.content[2].arguments.apiKey, secret);
  const seed = await observer.connection.request('watch_activity');
  assert.deepEqual(seed.slots[0].dialogs, ['question']);
  assert.equal(seed.slots[0].busy, true);
  assert.doesNotMatch(JSON.stringify(seed), new RegExp(secret));
  internal.error = secret;
  (f.supervisor as any).publish(internal, { type: 'remote_slot_exit', error: secret });
  const exit = await observer.wait(event => activity(event).source.type === 'remote_slot_exit');
  assert.deepEqual(activity(exit).source, { type: 'remote_slot_exit', error: true });
  assert.equal(activity(exit).slot.error, undefined);
  assert.doesNotMatch(JSON.stringify(exit), new RegExp(secret));
});

test('Pi 1.0.4 abort/retry cancellation augments only activity settled flags, not normal events', { timeout: 10_000 }, async t => {
  const f = await setup(t);
  const info = await f.create();
  const internal = (f.supervisor as any).slots.get(info.id);
  await f.controller.connection.request('attach', { slotId: info.id });
  const observer = await f.connect();
  await observer.connection.request('watch_activity');
  await f.controller.connection.request('rpc', { slotId: info.id, command: { type: 'prompt', message: '/background-tail' } });
  await f.controller.connection.request('rpc', { slotId: info.id, command: { type: 'abort' } });
  const aborted = await observer.wait(event => activity(event).source.type === 'agent_settled');
  assert.deepEqual(activity(aborted).source, { type: 'agent_settled', aborted: true });
  const raw = await f.controller.wait(event => event.event.type === 'agent_settled');
  assert.equal(raw.event.aborted, undefined);
  const sequence = internal.seq;
  (f.supervisor as any).recordEvent(internal, { type: 'agent_start' });
  (f.supervisor as any).recordEvent(internal, { type: 'auto_retry_end', success: false, finalError: 'Retry cancelled' });
  (f.supervisor as any).recordEvent(internal, { type: 'agent_settled' });
  const cancelled = await observer.wait(event => event.seq > sequence && activity(event).source.type === 'agent_settled');
  assert.deepEqual(activity(cancelled).source, { type: 'agent_settled', aborted: true, error: true });
  const next = internal.seq;
  (f.supervisor as any).recordEvent(internal, { type: 'agent_start' });
  (f.supervisor as any).recordEvent(internal, { type: 'auto_retry_end', success: false, finalError: 'SECRET_PROVIDER_ERROR' });
  (f.supervisor as any).recordEvent(internal, { type: 'agent_settled' });
  const failed = await observer.wait(event => event.seq > next && activity(event).source.type === 'agent_settled');
  assert.deepEqual(activity(failed).source, { type: 'agent_settled', error: true });
  assert.doesNotMatch(JSON.stringify(observer.events), /SECRET_PROVIDER_ERROR/);
});

test('normalizer ignores nonblocking UI and unselected provider/transcript event types', () => {
  for (const type of ['message_start', 'message_update', 'turn_end', 'remote_state', 'remote_warning', 'tool_execution_update', 'auto_retry_end']) assert.equal(activitySource({ type, secret: 'private' }), undefined);
  for (const method of ['notify', 'setStatus', 'setWidget']) assert.equal(activitySource({ type: 'extension_ui_request', method, id: 'x', message: 'private' }), undefined);
  for (const method of ['select', 'confirm', 'input', 'editor']) assert.deepEqual(activitySource({ type: 'extension_ui_request', method, id: 'x', message: 'private' }), { type: 'extension_ui_request', method, id: 'x' });
});
