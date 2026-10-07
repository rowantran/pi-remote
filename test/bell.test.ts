import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../src/protocol.js';
import { RemoteTui, type TuiOptions } from '../src/tui.js';

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function snapshot(busy = false, seq = 0): Snapshot {
  return { slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null, ui: [], seq,
    live: { busy, compacting: false, messages: [], tools: {}, steering: [], followUp: [] } };
}
class BellTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  writes: string[] = [];
  start() {} stop() {} async drainInput() {}
  write(text: string) { this.writes.push(text); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {}
  // OSC color queries also contain BEL terminators; count only standalone bells.
  get bells() { return this.writes.filter(text => text === '\x07').length; }
}
class BellConnection implements RemoteConnection {
  listener?: (event: RemoteEvent) => void;
  reconnected?: (snapshot: Snapshot) => void;
  disconnected?: (error: Error) => void;
  current: () => Snapshot = snapshot;
  requests: string[] = [];
  async request<T>(method: string): Promise<T> {
    this.requests.push(method);
    return (method === 'snapshot' ? structuredClone(this.current()) : {}) as T;
  }
  onEvent(fn: (event: RemoteEvent) => void) { this.listener = fn; return () => { this.listener = undefined; }; }
  onReconnect(fn: (snapshot: Snapshot) => void) { this.reconnected = fn; return () => { this.reconnected = undefined; }; }
  onDisconnect(fn: (error: Error) => void) { this.disconnected = fn; return () => { this.disconnected = undefined; }; }
  close() {}
  emit(seq: number, event: RecordValue, slotId = 'slot') { this.listener?.({ type: 'event', slotId, seq, event }); }
}
async function launch(t: TestContext, options: TuiOptions = {}, initial = snapshot(), initialize = true) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-bell-'));
  const config = join(dir, 'remote-client.json');
  const connection = new BellConnection();
  const terminal = new BellTerminal();
  const ui = new RemoteTui(connection, 'slot', initial, terminal, {
    presentationConfig: config, theme: 'dark', ...options,
  });
  connection.current = () => ui.view.snapshot;
  const finished = ui.run();
  t.after(async () => { ui.detach(); await finished; await flush(); await rm(dir, { recursive: true, force: true }); });
  if (initialize) { await ui.initialize(); await flush(); }
  let seq = initial.seq;
  const send = async (type: string, fields: RecordValue = {}) => {
    connection.emit(++seq, { type, ...fields }); await flush();
  };
  return { ui, terminal, connection, config, send };
}

test('built-in bell works without adapters and rings only when an observed run settles', async t => {
  const { ui, terminal, connection, send } = await launch(t);
  assert.equal(terminal.bells, 0, 'idle attach is quiet');
  assert.equal(ui.presentation?.footer, undefined, 'no adapter loaded');
  for (let run = 1; run <= 2; run++) {
    await send('agent_start');
    await send('agent_end', { willRetry: true });
    await send('message_end');
    await send('auto_retry_start', { attempt: 1 });
    await send('agent_start'); // A repeated start must not ring or reset notification state.
    assert.equal(terminal.bells, run - 1);
    await send('agent_settled');
    assert.equal(terminal.bells, run);
    await send('agent_settled');
    connection.emit(ui.view.snapshot.seq, { type: 'agent_settled' }); // same-sequence replay
    connection.emit(ui.view.snapshot.seq + 1, { type: 'agent_settled' }, 'other-slot');
    assert.equal(terminal.bells, run, 'duplicate and foreign-slot events are quiet');
  }
  await send('compaction_end');
  await send('remote_bash_end');
  await send('extension_ui_request', { method: 'notify', message: 'notice' });
  connection.disconnected?.(new Error('test disconnect'));
  assert.equal(terminal.bells, 2, 'other notices and disconnect are quiet');
  ui.detach();
  connection.emit(100, { type: 'agent_settled' });
  assert.equal(terminal.bells, 2, 'detach does not ring');
});

test('busy attach is quiet, then rings on settle or busy slot exit', async t => {
  for (const type of ['agent_settled', 'remote_slot_exit']) await t.test(type, async t => {
    const { ui, terminal, send } = await launch(t, {}, snapshot(true));
    assert.equal(terminal.bells, 0);
    await send(type);
    assert.equal(terminal.bells, 1);
    await send('agent_settled');
    assert.equal(terminal.bells, 1);
    assert.equal(ui.view.snapshot.live.busy, false);
  });
  const idle = await launch(t);
  await idle.send('remote_slot_exit');
  assert.equal(idle.terminal.bells, 0, 'idle slot exit is quiet');
});

test('reconnect and snapshot settle transitions ring once; later live settle does not duplicate', async t => {
  for (const source of ['reconnect', 'snapshot']) await t.test(source, async t => {
    const { ui, terminal, connection, send } = await launch(t, {}, snapshot(true));
    const idle = snapshot(false, 1);
    if (source === 'reconnect') {
      connection.disconnected?.(new Error('lost transport'));
      connection.reconnected?.(snapshot(true));
      assert.equal(terminal.bells, 0, 'busy reconnect is quiet');
      connection.reconnected?.(idle);
    } else {
      connection.current = () => idle;
      await send('remote_refresh');
    }
    await flush();
    assert.equal(terminal.bells, 1);
    connection.current = () => ui.view.snapshot;
    connection.emit(2, { type: 'agent_settled' }); await flush();
    connection.reconnected?.(snapshot(false, 3)); await flush();
    assert.equal(terminal.bells, 1, 'idle refresh/reconnect and later settle remain quiet');
  });
});

test('bell config reloads and a CLI opt-out always overrides it', async t => {
  for (const bell of [undefined, false]) await t.test(bell === false ? '--no-bell' : 'config', async t => {
    const { ui, terminal, config, send } = await launch(t, { bell }, snapshot(), false);
    await writeFile(config, JSON.stringify({ bell: false }));
    await ui.initialize(); await flush();
    await send('agent_start'); await send('agent_settled');
    assert.equal(terminal.bells, 0);
    await writeFile(config, JSON.stringify({ bell: true }));
    await (ui as any).builtin('/reload-ui', ''); await flush();
    assert.equal(terminal.bells, 0, 'reload itself is quiet');
    await send('agent_start'); await send('agent_settled');
    assert.equal(terminal.bells, bell === false ? 0 : 1);
    await writeFile(config, '{}'); // Omitting bell restores the default, unless CLI disabled it.
    await (ui as any).builtin('/reload-ui', ''); await flush();
    await send('agent_start'); await send('agent_settled');
    assert.equal(terminal.bells, bell === false ? 0 : 2);
    await send('agent_start');
    await (ui as any).builtin('/reload-ui', ''); await flush();
    ui.detach();
    assert.equal(terminal.bells, bell === false ? 0 : 2, 'busy reload and detach do not ring');
  });
});

test('settle before initialization respects the config rather than ringing with a provisional default', async t => {
  for (const bell of [undefined, true, false]) await t.test(String(bell), async t => {
    const { ui, terminal, config, send } = await launch(t, {}, snapshot(true), false);
    await send('agent_settled');
    assert.equal(terminal.bells, 0, 'wait until local config is known');
    await writeFile(config, JSON.stringify({ bell }));
    await ui.initialize(); await flush();
    assert.equal(terminal.bells, bell === false ? 0 : 1);
  });
});

test('startup detach and CLI opt-out suppress pending bells', async t => {
  for (const action of ['detach', '--no-bell']) await t.test(action, async t => {
    const { ui, terminal, config, send } = await launch(t,
      action === '--no-bell' ? { bell: false } : {}, snapshot(true), false);
    await send('agent_settled');
    await writeFile(config, JSON.stringify({ bell: true }));
    if (action === 'detach') ui.detach();
    await ui.initialize(); await flush();
    assert.equal(terminal.bells, 0);
  });
});

test('bell works even when optional presentation loading fails', async t => {
  for (const failure of ['adapter', 'theme', 'config']) await t.test(failure, async t => {
    const { ui, terminal, config, send } = await launch(t,
      failure === 'theme' ? { theme: 'missing-bell-test-theme' } : {}, snapshot(true), false);
    await send('agent_settled');
    await writeFile(config, failure === 'config' ? 'not JSON' :
      JSON.stringify({ extensions: failure === 'adapter' ? ['./missing-adapter.ts'] : [], bell: true }));
    await ui.initialize(); await flush();
    assert.equal(terminal.bells, 1, 'failed optional UI loading must not lose the completion bell');
    await send('agent_start'); await send('agent_settled');
    assert.equal(terminal.bells, 2);
  });
});
