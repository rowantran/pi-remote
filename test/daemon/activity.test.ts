import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Connection, handshake } from '../../src/client/connection.js';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { ACTIVITY_CAPABILITY, activitySource, type RemoteActivity } from '../../src/protocol/notification-stream.js';
import { socketPath } from '../../src/protocol/paths.js';
import { PI_VERSION, PROTOCOL_VERSION, type RemoteEvent, type SlotInfo } from '../../src/protocol/types.js';

const fixture = fileURLToPath(new URL('../fixtures/fixture-pi.mjs', import.meta.url));
async function setup(t: TestContext) {
  const dir = await mkdtemp('/tmp/pi-activity-');
  const supervisor = new Supervisor({ stateDir: dir, executable: process.execPath, prefixArgs: [fixture], skipVersionCheck: true, sideIdleGraceMs: 60_000 });
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
  const create = async () => {
    const slot = await controller.connection.request('create', { cwd: dir });
    for (let n = 0; (await controller.connection.request('list')).find(info => info.id === slot.id)?.status !== 'running'; n++) {
      assert.ok(n < 100); await new Promise(resolve => setTimeout(resolve, 50));
    }
    return slot;
  };
  return { dir, supervisor, controller, connect, create };
}
const activity = (event: RemoteEvent) => event.event as RemoteActivity;

test('watch_activity requires hello and a separate read-only peer; advertises activity_stream', { timeout: 10_000 }, async t => {
  const { connect, controller } = await setup(t);
  const unverified = await connect(false);
  await assert.rejects(unverified.connection.request('watch_activity'), /hello/);
  const hello = await controller.connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
  assert.ok(hello.capabilities?.includes(ACTIVITY_CAPABILITY));
  const watcher = await connect();
  await watcher.connection.request('watch_activity');
  await assert.rejects(watcher.connection.request('list'), /read-only/);
});

test('one observer sees several slots from companion events, redacted, without changing client counts', { timeout: 15_000 }, async t => {
  const { connect, controller, create } = await setup(t);
  const one: SlotInfo = await create(), two: SlotInfo = await create();
  const watcher = await connect();
  const seed = await watcher.connection.request('watch_activity');
  assert.deepEqual(seed.slots.map(item => item.slot.id).sort(), [one.id, two.id].sort());
  assert.ok(seed.slots.every(item => item.busy === false && item.slot.clients === 0));
  await controller.connection.request('attach', { slotId: one.id, columns: 80, rows: 24 });
  await controller.connection.request('input', { slotId: one.id, data: 'PRIVATE_PROMPT_TEXT\r' });
  const settled = await watcher.wait(event => activity(event).slot?.id === one.id && activity(event).source.type === 'agent_settled');
  assert.equal(activity(settled).source.type, 'agent_settled');
  assert.ok(watcher.events.some(event => activity(event).source.type === 'agent_start'));
  assert.doesNotMatch(JSON.stringify(watcher.events), /PRIVATE_PROMPT_TEXT/);
  assert.ok(!watcher.events.some(event => activity(event).slot.id === two.id && activity(event).source.type === 'agent_start'));
});

test('normalizer ignores nonblocking UI and unselected provider/transcript event types', () => {
  for (const type of ['message_start', 'message_update', 'turn_end', 'remote_state', 'remote_warning', 'tool_execution_update', 'auto_retry_end']) assert.equal(activitySource({ type, secret: 'private' }), undefined);
  for (const method of ['notify', 'setStatus', 'setWidget']) assert.equal(activitySource({ type: 'extension_ui_request', method, id: 'x', message: 'private' }), undefined);
  for (const method of ['select', 'confirm', 'input', 'editor']) assert.deepEqual(activitySource({ type: 'extension_ui_request', method, id: 'x', message: 'private' }), { type: 'extension_ui_request', method, id: 'x' });
});
