import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { PiProcess } from '../src/pi-process.js';
import type { RecordValue } from '../src/protocol.js';

const fixture = fileURLToPath(new URL('./fixture-pi.mjs', import.meta.url));
async function start(t: TestContext, onEvent: (event: RecordValue) => void) {
  const cwd = await realpath(await mkdtemp('/tmp/pi-process-test-'));
  const exits: Error[] = [];
  const pi = new PiProcess({ executable: process.execPath, prefixArgs: [fixture], cwd, args: [], env: { PI_OFFLINE: '1' } },
    onEvent, error => exits.push(error));
  t.after(async () => { await pi.stop(); await rm(cwd, { recursive: true, force: true }); });
  await pi.command({ type: 'get_state' }, 2000);
  return { pi, exits };
}
function assertAlive(pi: PiProcess, exits: Error[]) {
  assert.equal(pi.child.exitCode, null);
  assert.equal(pi.child.signalCode, null);
  assert.equal(pi.child.killed, false);
  assert.deepEqual(exits, []);
  assert.doesNotThrow(() => process.kill(pi.child.pid!, 0));
}

test('a consumer throwing on a valid event does not kill Pi or reject its accepted command', { timeout: 5000 }, async t => {
  const records: RecordValue[] = [];
  let threw = false;
  const { pi, exits } = await start(t, event => {
    records.push(event);
    if (event.type === 'queue_update' && !threw) { threw = true; throw new Error('Fixture consumer failure'); }
  });
  assert.deepEqual(await pi.command({ type: 'prompt', message: '/consumer-event' }, 2000), { disposition: 'handled' });
  assert.equal(threw, true);
  assert.ok(records.some(record => record.type === 'remote_warning' && record.error.includes('Fixture consumer failure')));
  assert.equal((await pi.command({ type: 'get_state' }, 2000)).isStreaming, false);
  assertAlive(pi, exits);
});

test('malformed stdout rejects local waiters without cancelling Pi and recovers on subsequent valid records', { timeout: 5000 }, async t => {
  const events = new EventEmitter();
  const records: RecordValue[] = [];
  const { pi, exits } = await start(t, event => { records.push(event); events.emit(event.type, event); });
  const recoveredEvent = once(events, 'queue_update');
  const unrelated = pi.command({ type: 'bash', command: 'still running' }, 2000);
  const malformed = pi.command({ type: 'prompt', message: '/malformed-output' }, 2000);
  const outcomes = await Promise.allSettled([unrelated, malformed]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.match(outcome.reason.message, /Remote work was not cancelled.*outcomes may be unknown/s);
  }
  assertAlive(pi, exits);
  await recoveredEvent;
  assert.ok(records.some(record => record.type === 'remote_warning'));
  assert.equal((await pi.command({ type: 'get_state' }, 2000)).isStreaming, false);
  assertAlive(pi, exits);
});
