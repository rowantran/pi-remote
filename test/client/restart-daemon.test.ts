import assert from 'node:assert/strict';
import test from 'node:test';
import { restartDaemon } from '../../src/client/restart-daemon.js';
import type { RecordValue, RemoteConnection, SlotInfo } from '../../src/protocol/types.js';

const slot = (id: string, number: number): SlotInfo => ({ id, number, cwd: '/w', createdAt: '', status: 'running', clients: 0 });

/** Each connect() gets the next scripted daemon; requests are answered by its handler. */
function daemons(...handlers: ((method: string, params: RecordValue) => any)[]) {
  const calls: string[] = [];
  let index = 0;
  const connect = async (): Promise<RemoteConnection> => {
    const handler = handlers[Math.min(index++, handlers.length - 1)];
    return {
      request: async (method: string, params: RecordValue = {}) => { calls.push(method); return handler(method, params); },
      onEvent: () => () => {}, onDisconnect: () => () => {}, close: () => {},
    };
  };
  return { connect, calls };
}
const old = (outcomes: RecordValue[]) => (method: string, params: RecordValue) => {
  if (method === 'hello') return { pid: 1, release: '/r/releases/old' };
  if (method === 'restart_daemon') return { ...outcomes.shift()!, force: params.force };
  throw new Error(`unexpected ${method}`);
};

test('waits by default until the daemon accepts, then connects until a new daemon answers', async () => {
  const busy = { accepted: false, blocked: [{ slot: slot('a', 2), reason: 'busy' }], reopen: [] };
  const lines: string[] = [];
  const { connect, calls } = daemons(
    old([busy, busy, { accepted: true, blocked: [], reopen: [slot('a', 2)] }]),
    () => { throw new Error('old daemon still stopping'); },
    method => method === 'hello' ? { pid: 1 } : [],
    method => method === 'hello' ? { pid: 2, release: '/r/releases/new' } : [slot('a', 2), slot('b', 3)],
  );
  const result = await restartDaemon(connect, { pollMs: 1, log: line => lines.push(line) });
  assert.equal(result.before.pid, 1); assert.equal(result.after.pid, 2);
  assert.deepEqual(result.reopened.map(slot => slot.id), ['a']);
  assert.equal(calls.filter(call => call === 'restart_daemon').length, 3);
  assert.deepEqual(lines.filter(line => line.startsWith('Waiting')),
    ['Waiting: slot 2: busy. Press Ctrl-C to stop waiting, or use --force to interrupt busy slots.'],
    'Repeated identical reasons are logged once');
  assert.match(lines.at(-1)!, /Daemon 1 \(old\) is stopping; reopening slot 2/);
});

test('waits for daemon-level creation blockers before any live slot exists, and logs each new reason once', async () => {
  const reason = 'Slot creation is in progress; wait for its allocated ID';
  const lines: string[] = [];
  const { connect, calls } = daemons(
    old([
      { accepted: false, blocked: [], reopen: [], reason },
      { accepted: false, blocked: [], reopen: [], reason },
      { accepted: false, blocked: [{ slot: slot('created', 1), reason: 'busy' }], reopen: [] },
      { accepted: true, blocked: [], reopen: [slot('created', 1)] },
    ]),
    method => method === 'hello' ? { pid: 2 } : [slot('created', 1)],
  );
  const result = await restartDaemon(connect, { pollMs: 1, log: line => lines.push(line) });
  assert.equal(calls.filter(call => call === 'restart_daemon').length, 4);
  assert.deepEqual(result.reopened.map(slot => slot.id), ['created']);
  assert.deepEqual(lines.filter(line => line.startsWith('Waiting')),
    [`Waiting: ${reason}. Press Ctrl-C to stop waiting, or use --force to interrupt busy slots.`, 'Waiting: slot 1: busy'],
    'The Ctrl-C hint appears only on the first waiting line');
});

test('explains the one-time manual step for daemons without restart_daemon', async () => {
  const { connect } = daemons(method => {
    if (method === 'hello') return { pid: 7 };
    throw new Error('Unknown daemon method: restart_daemon');
  });
  await assert.rejects(restartDaemon(connect), /Daemon 7 predates restart-daemon.*kill 7/);
});

test('reports when no new daemon answers', async () => {
  const { connect } = daemons(old([{ accepted: true, blocked: [], reopen: [] }]), () => { throw new Error('refused'); });
  await assert.rejects(restartDaemon(connect, { pollMs: 1, reconnectTimeoutMs: 20 }), /no new daemon answered.*refused/);
});
