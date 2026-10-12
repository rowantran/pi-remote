import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Connection } from '../src/client.js';
import { Supervisor, socketPath, type DaemonOptions } from '../src/daemon.js';
import { PI_VERSION, PROTOCOL_VERSION, type RecordValue, type SlotInfo, type Snapshot } from '../src/protocol.js';
import { sessionDirArg, sideSessionDir, withSessionDir } from '../src/side-sessions.js';

const fixture = fileURLToPath(new URL('./fixture-pi.mjs', import.meta.url));
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 4000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > end) throw new Error('Timed out waiting for condition');
    await delay(10);
  }
}
const records = async (path: string): Promise<RecordValue[]> => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

async function setup(t: TestContext, options: Partial<DaemonOptions> = {}) {
  const root = await realpath(await mkdtemp('/tmp/pi-side-'));
  const log = join(root, 'launches'), commands = join(root, 'commands');
  const daemonOptions: DaemonOptions = { stateDir: root, executable: process.execPath, prefixArgs: [fixture], skipVersionCheck: true,
    sideIdleGraceMs: 20_000, ...options, env: { PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1',
      PI_FIXTURE_LAUNCH_LOG: log, PI_FIXTURE_COMMANDS_LOG: commands, ...options.env } };
  let supervisor = new Supervisor(daemonOptions);
  const connections: Connection[] = [];
  const connect = async () => {
    const socket = createConnection(socketPath(root));
    await once(socket, 'connect');
    const connection = new Connection(socket, socket, () => socket.destroy());
    connections.push(connection);
    const hello = await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    assert.ok(hello.capabilities.includes('side_slots'));
    return connection;
  };
  await supervisor.start();
  const peer = await connect();
  const successor = async () => {
    connections.forEach(connection => connection.close());
    await supervisor.stop();
    supervisor = new Supervisor(daemonOptions);
    await supervisor.start();
    return connect();
  };
  t.after(async () => {
    connections.forEach(connection => connection.close());
    await supervisor.stop();
    await rm(root, { recursive: true, force: true });
  });
  const parent = async (args: string[] = []) => {
    const slot = await peer.request<SlotInfo>('create', { cwd: root, args });
    await peer.request('attach', { slotId: slot.id });
    return slot;
  };
  const createSide = (id: string, prompt?: string) => peer.request<SlotInfo>('create', { parentSlotId: id, ...(prompt === undefined ? {} : { prompt }) });
  const list = () => peer.request<SlotInfo[]>('list');
  const rpc = (id: string, command: RecordValue) => peer.request('rpc', { slotId: id, command });
  return { root, log, commands, peer, connect, parent, createSide, list, rpc, successor, supervisor, daemonOptions };
}

test('side session paths match Pi encoding and session-dir options replace all forms', () => {
  assert.equal(sideSessionDir('/work/a:b', { PI_CODING_AGENT_DIR: '/private/agent' }), '/private/agent/side-sessions/--work-a-b--');
  assert.equal(sideSessionDir('/work', { PI_CODING_AGENT_DIR: '.agent' }), '/work/.agent/side-sessions/--work--');
  assert.equal(sessionDirArg(['--session-dir=first', '--session-dir', 'last']), 'last');
  assert.deepEqual(withSessionDir(['--session-dir=one', '--model', 'test', '--session-dir', 'two', '--thinking', 'high'], '/side'),
    ['--model', 'test', '--thinking', 'high', '--session-dir', '/side']);
});

test('side forks persisted busy parent without changing it, inherits args, and derives parent number', { timeout: 15_000 }, async t => {
  const { root, peer, parent, createSide, rpc, log, daemonOptions } = await setup(t);
  const main = await parent(['--session-dir=main-sessions', '--model', 'fixture', '--thinking', 'high']);
  await rpc(main.id, { type: 'prompt', message: '/background-tail' });
  const original = await readFile(main.sessionFile!, 'utf8');
  const side = await createSide(main.id);
  assert.equal(side.parentSlotId, main.id);
  assert.equal(side.parentSlotNumber, main.number);
  assert.equal(side.number, main.number! + 1);
  assert.equal(side.cwd, main.cwd);
  assert.notEqual(side.pid, main.pid);
  const sideDir = sideSessionDir(root, daemonOptions.env);
  assert.ok(side.sessionFile!.startsWith(sideDir + '/'));
  const launches = await records(log), launch = launches.find(record => record.pid === side.pid)!;
  assert.deepEqual(launch.args, ['--mode', 'rpc', '--model', 'fixture', '--thinking', 'high', '--session-dir', sideDir, '--fork', main.sessionFile]);
  assert.equal(await readFile(main.sessionFile!, 'utf8'), original);
  const savedSide = await records(side.sessionFile!);
  assert.equal(savedSide[0].parentSession, main.sessionFile);
  assert.notEqual(savedSide[0].id, (await records(main.sessionFile!))[0].id);
  assert.deepEqual(savedSide.slice(1), (await records(main.sessionFile!)).slice(1));
  const mainState = await rpc(main.id, { type: 'get_state' });
  assert.equal(mainState.isStreaming, true);
  const stored = JSON.parse(await readFile(join(root, 'slots.json'), 'utf8'));
  assert.equal(stored.find((slot: any) => slot.id === side.id).parentSlotId, main.id);
  assert.ok(stored.every((slot: any) => slot.parentSlotNumber === undefined));
  const normalSessions = await peer.request('sessions', { slotId: main.id });
  assert.deepEqual(normalSessions.map((session: any) => session.path), [main.sessionFile]);
  const sideSessions = await peer.request('sessions', { slotId: main.id, side: true });
  assert.deepEqual(sideSessions.map((session: any) => session.path), [side.sessionFile]);
});

test('side refuses missing parent files and invalid options before allocating a slot', async t => {
  const { parent, createSide, peer, list, log } = await setup(t);
  const main = await parent();
  await rm(main.sessionFile!);
  await assert.rejects(createSide(main.id), /parent session file is not persisted/);
  await assert.rejects(peer.request('create', { parentSlotId: main.id, cwd: main.cwd }), /inherit cwd and args/);
  await assert.rejects(createSide(main.id, ''), /nonempty string/);
  await assert.rejects(peer.request('create', { cwd: main.cwd, prompt: 'oops' }), /requires parentSlotId/);
  await assert.rejects(createSide('missing'), /Slot not found/);
  assert.equal((await list()).length, 1);
  assert.equal((await records(log)).length, 1);
});

test('create does not await the initial prompt turn; prompt never replays on attach or reload', { timeout: 15_000 }, async t => {
  const { root, peer, parent, createSide, connect, commands, log } = await setup(t);
  const gate = join(root, 'complete-prompt');
  const main = await parent(['--fixture-prompt-after-turn', '--fixture-prompt-gate', gate]);
  const side = await createSide(main.id, 'side question');
  const sidePeer = await connect();
  const initial = await sidePeer.request<Snapshot>('attach', { slotId: side.id });
  assert.equal(initial.live.busy, true);
  const prompts = async () => (await records(commands)).filter(record => record.pid === side.pid && record.command.type === 'prompt');
  assert.equal((await prompts()).length, 1);
  await writeFile(gate, 'complete');
  await until(() => sidePeer.request('rpc', { slotId: side.id, command: { type: 'get_state' } }), state => !state.isStreaming);
  sidePeer.close();
  const reconnected = await connect();
  await reconnected.request('attach', { slotId: side.id });
  assert.equal((await prompts()).length, 1);
  const reloaded = await reconnected.request<SlotInfo>('restart', { slotId: side.id });
  assert.notEqual(reloaded.pid, side.pid);
  const launch = (await records(log)).find(record => record.pid === reloaded.pid)!;
  assert.ok(!launch.args.includes('--fork'));
  assert.ok(launch.args.includes('--session'));
  assert.ok(launch.args.includes(side.sessionFile));
  assert.equal((await records(commands)).filter(record => record.pid === reloaded.pid && record.command.type === 'prompt').length, 0);
  assert.equal((await peer.request<SlotInfo[]>('list')).find(slot => slot.id === main.id)!.status, 'running');
});

test('forced reload discards an outstanding initial prompt without replay in the replacement', async t => {
  const { root, parent, createSide, connect, commands } = await setup(t);
  const main = await parent(['--fixture-prompt-after-turn', '--fixture-prompt-gate', join(root, 'never-complete')]);
  const side = await createSide(main.id, 'outstanding side prompt');
  const sidePeer = await connect();
  const snapshot = await sidePeer.request<Snapshot>('attach', { slotId: side.id });
  assert.equal(snapshot.live.busy, true);
  const reloaded = await sidePeer.request<SlotInfo>('restart', { slotId: side.id, force: true });
  assert.notEqual(reloaded.pid, side.pid);
  assert.equal((await records(commands)).filter(record => record.pid === side.pid && record.command.type === 'prompt').length, 1);
  assert.equal((await records(commands)).filter(record => record.pid === reloaded.pid && record.command.type === 'prompt').length, 0);
  const after = await sidePeer.request<Snapshot>('snapshot', { slotId: side.id });
  assert.equal(after.live.busy, false);
  assert.equal(after.state.isStreaming, false);
  assert.ok(!after.ui.some(record => record.widgetKey === 'pi-remote:side-prompt-error'));
});

test('startup dialogs preserve side process and delay its initial prompt until ready', { timeout: 15_000 }, async t => {
  const { parent, createSide, connect, commands, root } = await setup(t, { sideIdleGraceMs: 40 });
  const main = await parent(['--fixture-startup-dialog']);
  const side = await createSide(main.id, 'after startup');
  assert.equal(side.status, 'starting');
  assert.ok(side.pid);
  assert.equal(side.sessionFile, undefined, 'Never persist the parent file as the new side file');
  const stored = JSON.parse(await readFile(join(root, 'slots.json'), 'utf8'));
  assert.equal(stored.find((slot: any) => slot.id === side.id).sessionFile, undefined);
  assert.equal((await records(commands)).filter(record => record.pid === side.pid && record.command.type === 'prompt').length, 0);
  const sidePeer = await connect();
  const snapshot = await sidePeer.request<Snapshot>('attach', { slotId: side.id });
  assert.equal(snapshot.ui.find(record => record.id === 'fixture-startup-dialog')?.method, 'confirm');
  await sidePeer.request('answer', { slotId: side.id, response: { id: 'fixture-startup-dialog', confirmed: true } });
  await until(() => records(commands), records => records.some(record => record.pid === side.pid && record.command.type === 'prompt'));
  assert.equal((await records(commands)).filter(record => record.pid === side.pid && record.command.type === 'prompt').length, 1);
});

test('unattached sides expire only when idle; initial prompt and queues keep them alive', { timeout: 10_000 }, async t => {
  const { parent, createSide, list, peer, connect, root } = await setup(t, { sideIdleGraceMs: 60 });
  const main = await parent();
  const side = await createSide(main.id, 'finish before cleanup');
  await delay(200);
  assert.equal((await list()).find(slot => slot.id === side.id)?.status, 'running');
  await until(list, slots => !slots.some(slot => slot.id === side.id));
  assert.ok((await readFile(side.sessionFile!, 'utf8')).includes('finish before cleanup'));
  const persisted = JSON.parse(await readFile(join(root, 'slots.json'), 'utf8'));
  assert.ok(!persisted.some((slot: any) => slot.id === side.id));
  const queued = await createSide(main.id, '/seed-live');
  await delay(180);
  assert.ok((await list()).some(slot => slot.id === queued.id), 'Queue/compaction state is not idle');
  const sidePeer = await connect();
  await sidePeer.request('attach', { slotId: queued.id });
  await sidePeer.request('rpc', { slotId: queued.id, command: { type: 'new_session' } });
  sidePeer.close();
  await until(list, slots => !slots.some(slot => slot.id === queued.id));
  assert.equal((await peer.request<SlotInfo[]>('list')).find(slot => slot.id === main.id)?.status, 'running');
});

test('cleanup rechecks cached streaming state rather than preserving an idle side forever', async t => {
  const { parent, createSide, supervisor, list } = await setup(t, { sideIdleGraceMs: 80 });
  const main = await parent();
  const side = await createSide(main.id);
  // A get_state response parsed in the same chunk as agent_settled can leave this
  // cached flag stale. Cleanup must ask Pi again after the grace before deciding.
  const runtime = (supervisor as any).slots.get(side.id);
  runtime.state.isStreaming = true;
  await until(list, slots => !slots.some(slot => slot.id === side.id));
  assert.equal((await list()).find(slot => slot.id === main.id)?.status, 'running');
});

test('last peer detach starts a new grace; attachment cancels expiry', { timeout: 10_000 }, async t => {
  const { parent, createSide, connect, list, peer } = await setup(t, { sideIdleGraceMs: 100 });
  const main = await parent();
  const side = await createSide(main.id, '/background-tail');
  const first = await connect(), second = await connect();
  await first.request('attach', { slotId: side.id });
  await second.request('attach', { slotId: side.id });
  await first.request('rpc', { slotId: side.id, command: { type: 'abort' } });
  await delay(180);
  first.close();
  await delay(150);
  assert.equal((await list()).find(slot => slot.id === side.id)?.clients, 1);
  second.close();
  await delay(40);
  await peer.request('attach', { slotId: side.id });
  await delay(140);
  assert.equal((await list()).find(slot => slot.id === side.id)?.status, 'running');
  await peer.request('attach', { slotId: main.id });
  await until(list, slots => !slots.some(slot => slot.id === side.id));
});

test('dialog, bash, pending prompt and session transition prevent idle cleanup', { timeout: 15_000 }, async t => {
  const { parent, createSide, connect, list, peer } = await setup(t, { sideIdleGraceMs: 30 });
  const main = await parent(['--fixture-new-session-dialog']);
  const side = await createSide(main.id, '/dialog');
  await delay(160);
  assert.ok((await list()).some(slot => slot.id === side.id), 'Unanswered initial prompt cannot expire');
  const sidePeer = await connect();
  const snapshot = await sidePeer.request<Snapshot>('attach', { slotId: side.id });
  const dialog = snapshot.ui.find(record => record.method === 'input')!;
  await sidePeer.request('answer', { slotId: side.id, response: { id: dialog.id, cancelled: true } });
  const bash = sidePeer.request('rpc', { slotId: side.id, command: { type: 'bash', command: 'wait' } });
  await sidePeer.request('attach', { slotId: main.id });
  await delay(80);
  assert.ok((await list()).some(slot => slot.id === side.id), 'Pending bash cannot expire');
  await peer.request('attach', { slotId: side.id });
  const transitioning = peer.request('rpc', { slotId: side.id, command: { type: 'new_session' } });
  const transitionSnapshot = await until(() => peer.request<Snapshot>('snapshot', { slotId: side.id }), snapshot => snapshot.ui.some(record => record.method === 'confirm'));
  await peer.request('attach', { slotId: main.id });
  await delay(240);
  assert.ok((await list()).some(slot => slot.id === side.id), 'Session transition awaiting dialog remains alive');
  await peer.request('attach', { slotId: side.id });
  const confirm = transitionSnapshot.ui.find(record => record.method === 'confirm')!;
  await peer.request('answer', { slotId: side.id, response: { id: confirm.id, cancelled: true } });
  await Promise.all([transitioning, bash]);
  await peer.request('attach', { slotId: main.id });
  await until(list, slots => !slots.some(slot => slot.id === side.id));
});

test('parent reload retains descendants; stopping parent cascades and publishes exit to attached side', { timeout: 15_000 }, async t => {
  const { peer, parent, createSide, connect, list, root } = await setup(t);
  const main = await parent();
  const side = await createSide(main.id), nested = await createSide(side.id);
  const sidePeer = await connect();
  const exits: string[] = [];
  sidePeer.onEvent(record => { if (record.event.type === 'remote_slot_exit') exits.push(record.slotId); });
  await sidePeer.request('attach', { slotId: nested.id });
  const reloaded = await peer.request<SlotInfo>('restart', { slotId: main.id });
  assert.notEqual(reloaded.pid, main.pid);
  assert.equal((await list()).find(slot => slot.id === side.id)?.status, 'running');
  assert.equal((await list()).find(slot => slot.id === nested.id)?.pid, nested.pid);
  await peer.request('kill', { slotId: main.id });
  await until(list, slots => slots.find(slot => slot.id === nested.id)?.status === 'exited');
  assert.deepEqual(exits, [nested.id]);
  const retained = await list();
  assert.equal(retained.find(slot => slot.id === nested.id)?.parentSlotNumber, side.number);
  const saved = JSON.parse(await readFile(join(root, 'slots.json'), 'utf8'));
  assert.deepEqual(saved.map((slot: any) => slot.id), [main.id]);
  sidePeer.close();
  await until(list, slots => slots.length === 1);
});

test('unexpected parent exit cascades even while side is starting; no initial prompt after replacement', { timeout: 15_000 }, async t => {
  const { peer, parent, createSide, list, rpc, commands } = await setup(t);
  const main = await parent(['--fixture-startup-dialog']);
  const side = await createSide(main.id, 'must not start');
  await assert.rejects(rpc(main.id, { type: 'prompt', message: '/exit' }), /Pi exited/);
  await until(list, slots => !slots.some(slot => slot.id === side.id));
  assert.equal((await records(commands)).filter(record => record.pid === side.pid && record.command.type === 'prompt').length, 0);
  assert.equal((await peer.request<SlotInfo[]>('list'))[0].status, 'exited');
});

test('orderly daemon restart retains side identities and session dirs without replaying prompt', { timeout: 15_000 }, async t => {
  const { peer, parent, createSide, successor, log, commands, root } = await setup(t);
  const main = await parent();
  const side = await createSide(main.id, 'one time');
  await delay(800);
  const accepted = await peer.request('restart_daemon');
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.reopen.map((slot: SlotInfo) => slot.id), [main.id, side.id]);
  const next = await successor();
  const slots = await next.request<SlotInfo[]>('list');
  assert.deepEqual(slots.map(slot => [slot.id, slot.number, slot.parentSlotId]), [[main.id, main.number, undefined], [side.id, side.number, main.id]]);
  const reopened = slots.find(slot => slot.id === side.id)!;
  assert.notEqual(reopened.pid, side.pid);
  const launch = (await records(log)).find(record => record.pid === reopened.pid)!;
  assert.equal(sessionDirArg(launch.args), sideSessionDir(root, { PI_CODING_AGENT_DIR: join(root, 'agent') }));
  assert.ok(!launch.args.includes('--fork'));
  assert.equal((await records(commands)).filter(record => record.pid === reopened.pid && record.command.type === 'prompt').length, 0);
});

test('pruned side numbers survive restart, and crash side records are pruned without deleting files', { timeout: 15_000 }, async t => {
  const { root, peer, parent, createSide, successor } = await setup(t);
  const main = await parent();
  const side = await createSide(main.id);
  await peer.request('kill', { slotId: side.id });
  let next = await successor();
  const created = await next.request<SlotInfo>('create', { cwd: root });
  assert.equal(created.number, side.number! + 1);
  // Seed a crash record not marked reopen. Its number advances the high-water mark.
  const stored = JSON.parse(await readFile(join(root, 'slots.json'), 'utf8'));
  const metadata = { id: 'crashed-side', number: 50, parentSlotId: main.id, cwd: root, args: [], createdAt: '', sessionFile: side.sessionFile };
  // stop() saves before the next start, so add crash metadata after shutdown explicitly.
  next.close();
  // Exercise migration with a separate hermetic daemon state catalogue.
  const crashDir = await mkdtemp('/tmp/pi-side-crash-');
  await writeFile(join(crashDir, 'slots.json'), JSON.stringify([...stored, metadata]));
  const restored = new Supervisor({ stateDir: crashDir, executable: process.execPath, prefixArgs: [fixture], skipVersionCheck: true,
    env: { PI_CODING_AGENT_DIR: join(root, 'agent') } });
  try {
    await restored.start();
    const socket = createConnection(socketPath(crashDir));
    await once(socket, 'connect');
    const connection = new Connection(socket, socket, () => socket.destroy());
    try {
      await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
      assert.ok(!(await connection.request<SlotInfo[]>('list')).some(slot => slot.id === metadata.id));
      assert.ok((await readFile(side.sessionFile!, 'utf8')).length);
      const afterCrash = await connection.request<SlotInfo>('create', { cwd: root });
      assert.equal(afterCrash.number, 51);
    } finally { connection.close(); }
  } finally { await restored.stop(); await rm(crashDir, { recursive: true, force: true }); }
});

test('parent exit or session change during create validation cannot launch a side', { timeout: 15_000 }, async t => {
  for (const action of ['exit', 'change', 'reload', 'daemon-restart']) await t.test(action, async t => {
    const { peer, parent, createSide, rpc, supervisor, log } = await setup(t);
    const main = await parent();
    const internal = supervisor as any;
    const checkVersion = internal.checkVersion.bind(supervisor);
    let resume!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let checks = 0;
    internal.checkVersion = async () => { if (++checks === 1) { entered(); await gate; } else await checkVersion(); };
    const creating = createSide(main.id).then(value => ({ value }), error => ({ error }));
    await waiting;
    if (action === 'exit') await peer.request('kill', { slotId: main.id });
    else if (action === 'change') await rpc(main.id, { type: 'new_session' });
    else if (action === 'reload') await peer.request('restart', { slotId: main.id });
    else assert.equal((await peer.request('restart_daemon')).accepted, false, 'Pending create blocks daemon restart');
    resume();
    const result = await creating;
    assert.ok(action === 'daemon-restart' ? 'value' in result : 'error' in result);
    assert.equal((await records(log)).filter(record => record.args.includes('--fork')).length, action === 'daemon-restart' ? 1 : 0);
  });
});

test('side startup failure returns allocated ID, not a retryable create error', async t => {
  const { parent, peer, createSide, daemonOptions } = await setup(t);
  const main = await parent();
  const exitFile = join(main.cwd, 'fail-start');
  daemonOptions.env!.PI_FIXTURE_EXIT_FILE = exitFile;
  await writeFile(exitFile, 'fail');
  const side = await createSide(main.id, 'never delivered');
  assert.ok(side.id);
  assert.equal(side.parentSlotId, main.id);
  assert.equal(side.status, 'exited');
  assert.match(side.error!, /startup failed/);
  assert.equal((await peer.request<SlotInfo[]>('list')).find(slot => slot.id === side.id)?.status, 'exited');
  await assert.rejects(peer.request('attach', { slotId: side.id }), /startup failed/);
});

test('initial prompt rejection remains visible after get_state and reconnect, and is never retried', async t => {
  const { parent, peer, createSide, connect, commands } = await setup(t);
  const main = await parent();
  const side = await createSide(main.id, '/reject-prompt');
  await until(() => records(commands), records => records.some(record => record.pid === side.pid && record.command.type === 'prompt'));
  const sidePeer = await connect();
  const first = await sidePeer.request<Snapshot>('attach', { slotId: side.id });
  assert.ok(first.ui.some(record => record.widgetLines?.some((line: string) => line.includes('Fixture prompt rejected'))));
  await sidePeer.request('rpc', { slotId: side.id, command: { type: 'get_state' } });
  sidePeer.close();
  const again = await connect();
  const snapshot = await again.request<Snapshot>('attach', { slotId: side.id });
  assert.ok(snapshot.ui.some(record => record.widgetLines?.some((line: string) => line.includes('it was not retried'))));
  assert.equal((await records(commands)).filter(record => record.pid === side.pid && record.command.type === 'prompt').length, 1);
  const reloaded = await again.request<SlotInfo>('restart', { slotId: side.id });
  const refreshed = await again.request<Snapshot>('snapshot', { slotId: side.id });
  assert.ok(!refreshed.ui.some(record => record.widgetKey === 'pi-remote:side-prompt-error'));
  assert.equal((await records(commands)).filter(record => record.pid === reloaded.pid && record.command.type === 'prompt').length, 0);
  assert.equal((await peer.request<SlotInfo[]>('list')).find(slot => slot.id === side.id)?.status, 'running');
});

test('cascade during side reload does not resurrect or leave starting metadata', { timeout: 15_000 }, async t => {
  const { root, parent, peer, createSide, connect, list, log } = await setup(t);
  const main = await parent(['--fixture-stop-delay', '180']);
  const side = await createSide(main.id);
  const sidePeer = await connect();
  sidePeer.onEvent(() => {});
  await sidePeer.request('attach', { slotId: side.id });
  const reloading = sidePeer.request('restart', { slotId: side.id }).then(value => ({ value }), error => ({ error }));
  await until(list, slots => slots.find(slot => slot.id === side.id)?.status === 'starting');
  await peer.request('kill', { slotId: main.id });
  assert.ok('error' in await reloading);
  assert.equal((await list()).find(slot => slot.id === side.id)?.status, 'exited');
  assert.equal((await records(log)).length, 2, 'Cascade must not spawn a replacement side');
  assert.ok(!JSON.parse(await readFile(join(root, 'slots.json'), 'utf8')).some((slot: any) => slot.id === side.id));
});

test('daemon restart waits for create ID delivery and protects reopen slots from pruning or kill', async t => {
  const { parent, createSide, supervisor, peer, connect, list, successor } = await setup(t);
  const main = await parent();
  const internal = supervisor as any;
  const startupGrace = internal.startupGrace.bind(supervisor);
  let resume!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  internal.startupGrace = async (slot: any) => {
    await startupGrace(slot);
    if (slot.parentSlotId) { entered(); await gate; }
  };
  const creating = createSide(main.id);
  await waiting;
  const blocked = await peer.request('restart_daemon', { force: true });
  assert.equal(blocked.accepted, false);
  assert.ok(blocked.blocked.some((item: any) => item.reason.includes('creation is in progress')));
  resume();
  const side = await creating;
  assert.ok(side.id);
  const sidePeer = await connect();
  await sidePeer.request('attach', { slotId: side.id });
  const accepted = await peer.request('restart_daemon');
  assert.equal(accepted.accepted, true);
  await assert.rejects(peer.request('kill', { slotId: side.id }), /shutting down/);
  internal.slots.get(side.id).process.child.kill('SIGTERM');
  await until(list, slots => slots.find(slot => slot.id === side.id)?.status === 'exited');
  sidePeer.close();
  await delay(30);
  assert.ok((await list()).some(slot => slot.id === side.id), 'Disconnect must not prune a reopen-marked side');
  const next = await successor();
  assert.equal((await next.request<SlotInfo[]>('list')).find(slot => slot.id === side.id)?.status, 'running');
});

test('daemon restart refuses normal create during pre-launch validation', async t => {
  const { supervisor, peer, root } = await setup(t);
  const internal = supervisor as any;
  let resume!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  internal.checkVersion = async () => { entered(); await gate; };
  const creating = peer.request<SlotInfo>('create', { cwd: root });
  await waiting;
  const blocked = await peer.request('restart_daemon', { force: true });
  assert.equal(blocked.accepted, false);
  assert.deepEqual(blocked.blocked, []);
  assert.match(blocked.reason, /creation is in progress/);
  resume();
  assert.ok((await creating).id);
});

test('expected parent identity rejects stale client context before allocating side', async t => {
  const { parent, peer, rpc, log } = await setup(t);
  const main = await parent();
  const state = await rpc(main.id, { type: 'get_state' });
  await rpc(main.id, { type: 'new_session' });
  await assert.rejects(peer.request('create', { parentSlotId: main.id, expectedParentSessionId: state.sessionId }), /Parent session changed/);
  assert.equal((await records(log)).length, 1);
  const latest = await rpc(main.id, { type: 'get_state' });
  const side = await peer.request<SlotInfo>('create', { parentSlotId: main.id, expectedParentSessionId: latest.sessionId });
  assert.equal(side.parentSlotId, main.id);
});

test('parent session change during final path validation prevents launch', async t => {
  const { parent, createSide, rpc, supervisor, log } = await setup(t);
  const main = await parent();
  const internal = supervisor as any;
  const refreshState = internal.refreshState.bind(supervisor);
  let resume!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let checks = 0;
  internal.refreshState = async (slot: any) => {
    if (slot.id === main.id && ++checks === 2) { entered(); await gate; }
    return refreshState(slot);
  };
  const creating = createSide(main.id).then(value => ({ value }), error => ({ error }));
  await waiting;
  await rpc(main.id, { type: 'new_session' });
  resume();
  assert.ok('error' in await creating);
  assert.equal((await records(log)).length, 1);
});

test('stock Pi CLI forks with provenance and keeps new_session, fork, resume and reload in side storage', { timeout: 45_000 }, async t => {
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
  const provider = fileURLToPath(new URL('./golden/fixture-provider.ts', import.meta.url));
  const { root, parent, peer, createSide, connect, daemonOptions } = await setup(t, {
    prefixArgs: [cli], env: { PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
  });
  daemonOptions.env!.GOLDEN_GATE_DIR = root;
  const main = await parent(['--session-dir', join(root, 'main-sessions'), '--offline', '--no-extensions', '--extension', provider, '--no-skills',
    '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--model', 'golden-local/transcript']);
  await peer.request('rpc', { slotId: main.id, command: { type: 'prompt', message: 'GOLDEN_SECOND_USER parent context' } });
  const parentSnapshot = await until(() => peer.request<Snapshot>('snapshot', { slotId: main.id }),
    snapshot => snapshot.entries.some(entry => entry.message?.role === 'assistant') && !snapshot.state.isStreaming);
  const sourceFile = parentSnapshot.state.sessionFile;
  const source = await readFile(sourceFile, 'utf8');
  const side = await createSide(main.id);
  const sidePeer = await connect();
  await sidePeer.request('attach', { slotId: side.id });
  const dir = sideSessionDir(root, daemonOptions.env);
  const sideState = await sidePeer.request('rpc', { slotId: side.id, command: { type: 'get_state' } });
  assert.ok(sideState.sessionFile.startsWith(dir + '/'));
  const forked = await records(sideState.sessionFile);
  assert.equal(forked[0].parentSession, sourceFile);
  assert.notEqual(forked[0].id, parentSnapshot.state.sessionId);
  assert.ok(forked.some(entry => JSON.stringify(entry.message?.content ?? '').includes('GOLDEN_SECOND_USER parent context')));
  assert.equal(await readFile(sourceFile, 'utf8'), source, 'CLI --fork never modifies the parent');
  const normal = await peer.request('sessions', { slotId: main.id });
  assert.ok(normal.some((session: any) => session.path === sourceFile));
  assert.ok(!normal.some((session: any) => session.path === sideState.sessionFile));
  assert.ok((await peer.request('sessions', { slotId: main.id, side: true })).some((session: any) => session.path === sideState.sessionFile));

  const ask = async (message: string) => {
    await sidePeer.request('rpc', { slotId: side.id, command: { type: 'prompt', message } });
    return until(() => sidePeer.request<Snapshot>('snapshot', { slotId: side.id }),
      snapshot => snapshot.entries.some(entry => entry.message?.role === 'assistant') && !snapshot.state.isStreaming);
  };
  await sidePeer.request('rpc', { slotId: side.id, command: { type: 'new_session' } });
  const fresh = await ask('GOLDEN_SECOND_USER fresh side');
  assert.ok(fresh.state.sessionFile.startsWith(dir + '/'));
  assert.notEqual(fresh.state.sessionFile, sideState.sessionFile);
  const user = fresh.entries.find(entry => entry.message?.role === 'user')!;
  await sidePeer.request('rpc', { slotId: side.id, command: { type: 'fork', entryId: user.id } });
  const secondFork = await ask('GOLDEN_SECOND_USER forked side');
  assert.ok(secondFork.state.sessionFile.startsWith(dir + '/'));
  assert.equal((await records(secondFork.state.sessionFile))[0].parentSession, fresh.state.sessionFile);
  await sidePeer.request('rpc', { slotId: side.id, command: { type: 'switch_session', sessionPath: sideState.sessionFile } });
  await sidePeer.request('rpc', { slotId: side.id, command: { type: 'new_session' } });
  const resumedNew = await ask('GOLDEN_SECOND_USER after side resume');
  assert.ok(resumedNew.state.sessionFile.startsWith(dir + '/'));
  const reloaded = await sidePeer.request<SlotInfo>('restart', { slotId: side.id });
  assert.notEqual(reloaded.pid, side.pid);
  assert.equal(reloaded.sessionFile, resumedNew.state.sessionFile);
  assert.equal(reloaded.parentSlotNumber, main.number);
});
