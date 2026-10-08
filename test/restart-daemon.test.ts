import assert from 'node:assert/strict';
import test from 'node:test';
import { restartDaemon } from '../src/restart-daemon.js';
import type { RecordValue, RemoteConnection, SlotInfo } from '../src/protocol.js';

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

test('refuses without --wait and names the busy slots', async () => {
  const { connect } = daemons(old([{ accepted: false, blocked: [{ slot: slot('a', 2), reason: 'Remote Pi is busy.' }], reopen: [] }]));
  await assert.rejects(restartDaemon(connect), /slot 2: Remote Pi is busy\..*--wait.*--force/);
});

test('--wait retries until the daemon accepts, then connects until a new daemon answers', async () => {
  const busy = { accepted: false, blocked: [{ slot: slot('a', 2), reason: 'busy' }], reopen: [] };
  const lines: string[] = [];
  const { connect, calls } = daemons(
    old([busy, busy, { accepted: true, blocked: [], reopen: [slot('a', 2)] }]),
    () => { throw new Error('old daemon still stopping'); },
    method => method === 'hello' ? { pid: 1 } : [],
    method => method === 'hello' ? { pid: 2, release: '/r/releases/new' } : [slot('a', 2), slot('b', 3)],
  );
  const result = await restartDaemon(connect, { wait: true, pollMs: 1, log: line => lines.push(line) });
  assert.equal(result.before.pid, 1); assert.equal(result.after.pid, 2);
  assert.deepEqual(result.reopened.map(slot => slot.id), ['a']);
  assert.equal(calls.filter(call => call === 'restart_daemon').length, 3);
  assert.equal(lines.filter(line => line.startsWith('Waiting')).length, 1, 'Repeated identical reasons are logged once');
  assert.match(lines.at(-1)!, /Daemon 1 \(old\) is stopping; reopening slot 2/);
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
