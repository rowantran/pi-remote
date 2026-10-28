import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Connection } from '../../src/client/connection.js';
import { Supervisor, type DaemonOptions } from '../../src/daemon/supervisor.js';
import type { Launcher } from '../../src/daemon/pi-process.js';
import { LAUNCH_MODES_CAPABILITY } from '../../src/protocol/launch-modes.js';
import { socketPath } from '../../src/protocol/paths.js';
import { PI_VERSION, PROTOCOL_VERSION, type RecordValue, type RemoteEvent } from '../../src/protocol/types.js';

const fixture = fileURLToPath(new URL('../fixtures/fixture-pi.mjs', import.meta.url));
/** The fixture ignores unknown options, so a marker shows which launch command started it. */
const marked = (sandboxed: boolean): Launcher => ({ executable: process.execPath, prefixArgs: [fixture, `--fixture-launcher=${sandboxed ? 'sandboxed' : 'unsandboxed'}`] });

async function setup(t: TestContext, options: Partial<DaemonOptions> = {}) {
  const root = await realpath(await mkdtemp('/tmp/pi-launch-'));
  const log = join(root, 'launches');
  const daemonOptions: DaemonOptions = { stateDir: root, launcher: marked, skipVersionCheck: true, sideIdleGraceMs: 20_000, ...options,
    env: { PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_FIXTURE_LAUNCH_LOG: log } };
  let supervisor = new Supervisor(daemonOptions);
  const connections: Connection[] = [];
  const connect = async () => {
    const socket = createConnection(socketPath(root));
    await once(socket, 'connect');
    const connection = new Connection(socket, socket, () => socket.destroy());
    connections.push(connection);
    const hello = await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    assert.ok(hello.capabilities?.includes(LAUNCH_MODES_CAPABILITY));
    return connection;
  };
  await supervisor.start();
  let peer = await connect();
  t.after(async () => {
    connections.forEach(connection => connection.close());
    await supervisor.stop();
    await rm(root, { recursive: true, force: true });
  });
  const successor = async (edit?: (stored: RecordValue[]) => void) => {
    connections.forEach(connection => connection.close());
    await supervisor.stop();
    if (edit) {
      const stored = JSON.parse(await readFile(join(root, 'slots.json'), 'utf8'));
      edit(stored);
      await writeFile(join(root, 'slots.json'), JSON.stringify(stored));
    }
    supervisor = new Supervisor(daemonOptions);
    await supervisor.start();
    peer = await connect();
    return peer;
  };
  /** Launch-command marker of the process with this PID. */
  const launcherOf = async (pid: number | undefined) => {
    const launches = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const launch = launches.find(record => record.pid === pid);
    assert.ok(launch, `No recorded launch for PID ${pid}`);
    return launch.args.find((arg: string) => arg.startsWith('--fixture-launcher='))?.slice('--fixture-launcher='.length);
  };
  return { root, peer: () => peer, connect, successor, launcherOf, supervisor: () => supervisor };
}

const settled = (connection: Connection, slotId: string) => new Promise<void>(resolve => {
  const off = connection.onEvent((event: RemoteEvent) => {
    if (event.slotId === slotId && event.event.type === 'agent_settled') { off(); resolve(); }
  });
});

test('slots start sandboxed by default and keep their launch mode for sides, reloads, and daemon restarts', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const peer = f.peer();
  const sandboxed = await peer.request('create', { cwd: f.root });
  const plain = await peer.request('create', { cwd: f.root, sandboxed: false });
  const legacy = await peer.request('create', { cwd: f.root, sandboxed: true });
  assert.deepEqual([sandboxed.sandboxed, plain.sandboxed, legacy.sandboxed], [true, false, true]);
  assert.deepEqual([await f.launcherOf(sandboxed.pid), await f.launcherOf(plain.pid)], ['sandboxed', 'unsandboxed']);
  await assert.rejects(peer.request('create', { cwd: f.root, sandboxed: 'no' as any }), /sandboxed must be a boolean/);

  // A side inherits its parent's mode and cannot choose another.
  await peer.request('attach', { slotId: plain.id });
  const done = settled(peer, plain.id);
  await peer.request('rpc', { slotId: plain.id, command: { type: 'prompt', message: 'persist history' } });
  await done;
  await assert.rejects(peer.request('create', { parentSlotId: plain.id, sandboxed: true }), /launch mode/);
  const side = await peer.request('create', { parentSlotId: plain.id });
  assert.equal(side.sandboxed, false);
  assert.equal(await f.launcherOf(side.pid), 'unsandboxed');

  // Reload uses the same launch command again.
  await peer.request('attach', { slotId: sandboxed.id });
  const reloaded = await peer.request('restart', { slotId: sandboxed.id });
  assert.notEqual(reloaded.pid, sandboxed.pid);
  assert.equal(reloaded.sandboxed, true);
  assert.equal(await f.launcherOf(reloaded.pid), 'sandboxed');

  const stored = JSON.parse(await readFile(join(f.root, 'slots.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(stored.map((slot: RecordValue) => [slot.id, slot.sandboxed])),
    { [sandboxed.id]: true, [plain.id]: false, [legacy.id]: true, [side.id]: false });

  // Slots stored before launch modes existed ran unsandboxed and reopen unsandboxed.
  const accepted = await peer.request('restart_daemon', { force: true });
  assert.equal(accepted.accepted, true);
  await f.supervisor().exitRequested;
  const next = await f.successor(records => { delete records.find(slot => slot.id === legacy.id)!.sandboxed; });
  const slots = new Map((await next.request('list')).map(slot => [slot.id, slot]));
  assert.deepEqual([sandboxed.id, plain.id, legacy.id].map(id => [slots.get(id)!.status === 'exited', slots.get(id)!.sandboxed]),
    [[false, true], [false, false], [false, false]]);
  assert.deepEqual(await Promise.all([sandboxed.id, plain.id, legacy.id].map(id => f.launcherOf(slots.get(id)!.pid))),
    ['sandboxed', 'unsandboxed', 'unsandboxed']);
});

test('a broken sandboxed command refuses sandboxed creates without affecting unsandboxed slots', { timeout: 15_000 }, async t => {
  const f = await setup(t, {
    skipVersionCheck: false,
    launcher: sandboxed => sandboxed ? { executable: join('/nonexistent', 'isara'), prefixArgs: ['sandbox', 'pi', '--'] } : marked(false),
  });
  const peer = f.peer();
  await assert.rejects(peer.request('create', { cwd: f.root }), /Sandboxed launch command '\/nonexistent\/isara sandbox pi --' failed/);
  const plain = await peer.request('create', { cwd: f.root, sandboxed: false });
  assert.equal(plain.status, 'running');
  assert.deepEqual((await peer.request('list')).map(slot => slot.id), [plain.id]);
});
