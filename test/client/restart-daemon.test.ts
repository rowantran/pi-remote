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

test('a failed Pi check stops before any restart request and leaves the daemon running', async () => {
  const { connect, calls } = daemons(old([{ accepted: true, blocked: [], reopen: [slot('a', 2)] }]));
  await assert.rejects(
    restartDaemon(connect, { pollMs: 1, checkPi: async () => { throw new Error('Remote Pi version 9.9.9 does not match required 1.5.2'); } }),
    /^Error: Not restarting the daemon: Remote Pi version 9\.9\.9 does not match required 1\.5\.2\. The next daemon would refuse to start and every slot would stay stopped\. The current daemon and its slots keep running\.$/);
  assert.deepEqual(calls, ['hello']);
});

test('the Pi check runs before every restart request, so an upgrade while waiting stops the restart', async () => {
  const busy = { accepted: false, blocked: [{ slot: slot('a', 2), reason: 'busy' }], reopen: [] };
  const { connect, calls } = daemons(old([busy, busy, { accepted: true, blocked: [], reopen: [slot('a', 2)] }]));
  let checks = 0;
  const checkPi = async () => { if (++checks === 3) throw new Error('Remote Pi version 9.9.9 does not match required 1.5.2'); };
  await assert.rejects(restartDaemon(connect, { pollMs: 1, checkPi }), /Not restarting the daemon/);
  assert.equal(checks, 3);
  assert.deepEqual(calls, ['hello', 'restart_daemon', 'restart_daemon'], 'the third request, which the daemon would accept, is never sent');
});

/**
 * Daemons that each accept only a `hello` naming their own Pi version, as real daemons do.
 * `current()` is the daemon that listens now. `named` lists the Pi version of every connect.
 */
function versioned(current: () => { pid: number; pi: string; protocol?: number }, outcome: RecordValue = { accepted: true, blocked: [], reopen: [slot('a', 2)] }) {
  const named: string[] = [];
  const state = { restarts: 0 };
  const connect = async (piVersion: string): Promise<RemoteConnection> => {
    named.push(piVersion);
    const daemon = current();
    // SSH diagnostics follow the daemon's refusal on later lines.
    if (piVersion !== daemon.pi || (daemon.protocol ?? 2) !== 2) throw new Error(`Version mismatch: daemon protocol ${daemon.protocol ?? 2}, Pi ${daemon.pi}\nWarning: Permanently added 'host' to the list of known hosts.`);
    return {
      request: async (method: string, params: RecordValue = {}) => {
        if (method === 'hello') { assert.equal(params.piVersion, daemon.pi); return { protocol: 2, piVersion: daemon.pi, pid: daemon.pid, release: `/r/releases/pi-${daemon.pi}` }; }
        if (method === 'restart_daemon') { state.restarts++; return outcome; }
        if (method === 'list') return [slot('a', 2)];
        throw new Error(`unexpected ${method}`);
      },
      onEvent: () => () => {}, onDisconnect: () => () => {}, close: () => {},
    };
  };
  return { connect, named, state };
}

test('a client for a new Pi restarts a daemon built for the old Pi onto the release for the new one', async () => {
  const lines: string[] = [];
  const { connect, named, state } = versioned(() => state.restarts ? { pid: 2, pi: '2.0.0' } : { pid: 1, pi: '1.0.0' });
  const result = await restartDaemon(connect, { piVersion: '2.0.0', pollMs: 1, log: line => lines.push(line) });
  assert.deepEqual(named, ['2.0.0', '1.0.0', '2.0.0'], 'after the old daemon refuses, the client names the daemon\'s Pi version');
  assert.deepEqual([result.before.pid, result.before.piVersion, result.after.pid, result.after.piVersion], [1, '1.0.0', 2, '2.0.0']);
  assert.deepEqual(result.reopened.map(slot => slot.id), ['a']);
  assert.deepEqual(lines, ['Daemon 1 is built for Pi 1.0.0, and this client for Pi 2.0.0.', 'Daemon 1 (pi-1.0.0) is stopping; reopening slot 2.']);
});

test('a client for the old Pi restarts its daemon onto an installed release for a new Pi, and reports that daemon', async () => {
  const { connect, named, state } = versioned(() => state.restarts ? { pid: 2, pi: '2.0.0' } : { pid: 1, pi: '1.0.0' });
  const result = await restartDaemon(connect, { piVersion: '1.0.0', pollMs: 1 });
  assert.deepEqual(named, ['1.0.0', '1.0.0', '2.0.0']);
  assert.deepEqual([result.after.pid, result.after.piVersion], [2, '2.0.0']);
});

test('a daemon with another protocol version is not restarted', async () => {
  const { connect, named, state } = versioned(() => ({ pid: 1, pi: '1.0.0', protocol: 1 }));
  await assert.rejects(restartDaemon(connect, { piVersion: '2.0.0', pollMs: 1 }), /^Error: Version mismatch: daemon protocol 1, Pi 1\.0\.0/);
  assert.deepEqual(named, ['2.0.0']);
  assert.equal(state.restarts, 0);
});
