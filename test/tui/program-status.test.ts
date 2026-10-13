import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { ProcessTerminal, StdinBuffer, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../../src/protocol/types.js';
import { formatProgramStatus, PROGRAM_STATUS_QUERY, ProgramStatusTerminal, WAITING_STATUS_KEY, WAITING_STATUS_TEXT } from '../../src/tui/program-status.js';
import { RemoteTui } from '../../src/tui/tui.js';

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const waiting = (statusText: string | undefined = WAITING_STATUS_TEXT, statusKey = WAITING_STATUS_KEY) =>
  ({ type: 'extension_ui_request', id: 'status', method: 'setStatus', statusKey, statusText });
function snapshot(busy = false, seq = 0): Snapshot {
  return { slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: { sessionId: 'session' }, entries: [], leafId: null, ui: [], seq,
    live: { busy, compacting: false, messages: [], tools: {}, steering: [], followUp: [] } };
}
class FakeTerminal implements Terminal {
  columns = 120; rows = 24; kittyProtocolActive = false;
  writes: string[] = [];
  input: (data: string) => void = () => {};
  private buffer?: StdinBuffer;
  start(input: (data: string) => void) {
    this.buffer = new StdinBuffer(); this.buffer.on('data', input);
    this.input = data => this.buffer!.process(data);
  }
  stop() { this.buffer?.destroy(); }
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {}
  get bells() { return this.writes.filter(data => data === '\x07').length; }
  get reports() {
    return this.writes.filter(data => data.startsWith('\x1b]7501;state=')).map(data => {
      const pairs = Object.fromEntries(data.slice(7, -2).split(':').map(pair => pair.split('=').slice(0, 2)));
      const msg = /:msg=([^\x1b]*)/.exec(data)?.[1];
      return { state: pairs.state, kind: pairs.kind, message: msg ? Buffer.from(msg, 'base64').toString('utf8') : undefined };
    });
  }
  get last() { return this.reports.at(-1); }
}
class Connection implements RemoteConnection {
  listener?: (event: RemoteEvent) => void;
  reconnected?: (snapshot: Snapshot) => void;
  disconnected?: (error: Error) => void;
  current: () => Snapshot | Promise<Snapshot> = snapshot;
  async request<T>(method: string): Promise<T> { return (method === 'snapshot' ? structuredClone(await this.current()) : {}) as T; }
  onEvent(fn: (event: RemoteEvent) => void) { this.listener = fn; return () => { this.listener = undefined; }; }
  onReconnect(fn: (snapshot: Snapshot) => void) { this.reconnected = fn; return () => { this.reconnected = undefined; }; }
  onDisconnect(fn: (error: Error) => void) { this.disconnected = fn; return () => { this.disconnected = undefined; }; }
  close() {}
}
function launch(t: TestContext, initial = snapshot(), bell = true) {
  const previous = process.env.PI_PROGRAM_STATUS; process.env.PI_PROGRAM_STATUS = '1';
  const terminal = new FakeTerminal(), connection = new Connection();
  const ui = new RemoteTui(connection, 'slot', initial, terminal, { bell });
  connection.current = () => ui.view.snapshot;
  void ui.run();
  t.after(() => { ui.detach(); if (previous === undefined) delete process.env.PI_PROGRAM_STATUS; else process.env.PI_PROGRAM_STATUS = previous; });
  let seq = initial.seq;
  const send = (type: string, fields: RecordValue = {}) => connection.listener?.({ type: 'event', slotId: 'slot', seq: ++seq, event: { type, ...fields } });
  const signal = (value: string | undefined = WAITING_STATUS_TEXT, key = WAITING_STATUS_KEY) => send('extension_ui_request', waiting(value, key));
  return { terminal, connection, ui, send, signal };
}

test('root status starts idle; each run completes once, including successive done results', async t => {
  const { terminal, send, ui } = launch(t);
  assert.equal(terminal.last?.state, 'idle');
  for (let run = 1; run <= 2; run++) {
    send('agent_start'); assert.equal(terminal.last?.state, 'working');
    send('agent_end'); assert.equal(terminal.last?.state, 'working');
    send('agent_settled'); assert.equal(terminal.last?.state, 'done');
    assert.equal(terminal.bells, run);
    send('agent_settled'); assert.equal(terminal.bells, run);
    await flush(); assert.equal(terminal.bells, run);
  }
  ui.detach(); assert.equal(terminal.last?.state, 'clear'); assert.equal(terminal.bells, 2);
  assert.ok(terminal.writes.filter(data => data.startsWith('\x1b]7501;')).every(data => !data.includes(':id=')));
});

test('only the exact reserved signal suppresses completion; clear stays quiet and footer omits the key', async t => {
  const { terminal, send, signal, ui } = launch(t);
  signal(WAITING_STATUS_TEXT, 'other');
  send('agent_start'); send('agent_settled'); assert.equal(terminal.bells, 1);
  send('agent_start'); signal('almost'); send('agent_settled'); assert.equal(terminal.bells, 2);
  send('agent_start'); signal(); send('agent_settled');
  assert.deepEqual(terminal.last, { state: 'working', kind: undefined, message: WAITING_STATUS_TEXT });
  assert.equal(terminal.bells, 2);
  ui.view.snapshot.ui = ui.view.snapshot.ui.filter(record => record.statusKey !== 'other');
  assert.doesNotMatch(stripTerminalSequences((ui as any).footer()), /Waiting on background task|almost/);
  assert.equal(ui.presentation?.footer, undefined);
  send('extension_ui_request', { ...waiting(), statusText: undefined });
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.last?.message, undefined); assert.equal(terminal.bells, 2);
  send('extension_ui_request', { ...waiting(), statusText: undefined }); assert.equal(terminal.bells, 2);
  await flush(); assert.equal(terminal.bells, 2);
});

test('background completion before settle rings at settle; a new run replaces waiting without a false bell', async t => {
  const { terminal, send, signal } = launch(t);
  send('agent_start'); signal(); send('extension_ui_request', { ...waiting(), statusText: undefined });
  assert.equal(terminal.bells, 0); send('agent_settled'); assert.equal(terminal.bells, 1);
  send('agent_start'); signal(); send('agent_settled'); assert.equal(terminal.bells, 1);
  // The extension clears before the foreground agent_start, while busy is still false.
  send('extension_ui_request', { ...waiting(), statusText: undefined });
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 1);
  send('agent_start');
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 1);
  send('agent_settled'); assert.equal(terminal.bells, 2);
  // Last-child completion can also clear before async result retrieval starts the wake-up run.
  send('agent_start'); signal(); send('agent_settled'); assert.equal(terminal.bells, 2);
  send('extension_ui_request', { ...waiting(), statusText: undefined });
  await flush(); assert.equal(terminal.bells, 2);
  send('agent_start'); send('agent_settled'); assert.equal(terminal.bells, 3);
  await flush();
});

test('all RPC dialogs block and ring immediately mid-run, including while waiting; replay is quiet', async t => {
  const { terminal, send, signal, connection, ui } = launch(t);
  send('agent_start'); signal();
  for (const method of ['confirm', 'input', 'select', 'editor']) {
    send('extension_ui_request', { id: method, method, title: 'Answer: café\nnow', message: 'Sensitive bash arguments', options: ['One'] });
    assert.equal(terminal.last?.state, 'blocked');
    assert.equal(terminal.last?.kind, method === 'confirm' ? 'permission' : 'question');
    assert.equal(terminal.last?.message, 'Answer: café now');
    const bells = terminal.bells;
    send('extension_ui_request', { id: method, method, title: 'Repeated', options: ['One'] });
    connection.reconnected?.(structuredClone(ui.view.snapshot));
    assert.equal(terminal.bells, bells);
    send('remote_dialog_resolved', { id: method }); assert.equal(terminal.last?.state, 'working');
  }
  assert.equal(terminal.bells, 4);
  send('agent_settled'); assert.equal(terminal.bells, 4);
  send('extension_ui_request', { id: 'idle-question', method: 'input', title: 'Question' });
  assert.equal(terminal.bells, 5); assert.equal(terminal.last?.state, 'blocked');
  await flush();
});

test('pending dialogs on attach are blocked but quiet; answering updates status without aborting', async t => {
  const initial = snapshot(true); initial.ui = [{ id: 'old', method: 'confirm', title: 'Approve' }, waiting()];
  const { terminal, ui } = launch(t, initial);
  assert.equal(terminal.last?.state, 'blocked'); assert.equal(terminal.bells, 0);
  await (ui as any).answerDialog('old', { confirmed: true });
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
});

test('errors override waiting; successful retry recovers; abort signals settle idle without a bell', async t => {
  for (const kind of ['error', 'aborted', 'retry-cancel', 'local-abort', 'retry-success']) await t.test(kind, async t => {
    const { terminal, send, signal, ui } = launch(t);
    send('agent_start'); signal();
    if (kind === 'local-abort') await (ui as any).rpc({ type: 'abort' });
    else if (kind === 'retry-cancel') send('auto_retry_end', { success: false, finalError: 'Retry cancelled' });
    else send('message_end', { message: { role: 'assistant', timestamp: 1, content: [], stopReason: kind === 'aborted' ? 'aborted' : 'error', errorMessage: 'Failure' } });
    if (kind === 'retry-success') {
      send('auto_retry_start'); send('agent_start');
      send('message_end', { message: { role: 'assistant', timestamp: 2, content: [], stopReason: 'stop' } });
    }
    send('agent_settled');
    assert.equal(terminal.last?.state, kind === 'error' ? 'error' : kind === 'retry-success' ? 'working' : 'idle');
    assert.equal(terminal.bells, kind === 'error' ? 1 : 0);
    await flush();
  });
});

test('newer agent_settled.aborted overrides a successful reply while legacy settles retain completion', async t => {
  for (const aborted of [undefined, false, true, 'true']) await t.test(String(aborted), async t => {
    const { terminal, send, signal } = launch(t);
    send('agent_start');
    send('message_end', { message: { role: 'assistant', timestamp: 1, stopReason: 'stop', content: [] } });
    if (aborted === true) signal();
    send('agent_settled', { aborted });
    assert.equal(terminal.last?.state, aborted === true ? 'idle' : 'done');
    assert.equal(terminal.bells, aborted === true ? 0 : 1);
    send('agent_settled', { aborted }); await flush();
    assert.equal(terminal.last?.state, aborted === true ? 'idle' : 'done');
    assert.equal(terminal.bells, aborted === true ? 0 : 1, 'repeated settles remain quiet');
    send('extension_ui_request', { ...waiting(), statusText: undefined });
    send('agent_start'); send('agent_settled');
    assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, aborted === true ? 1 : 2);
  });
});

test('rejected abort restores completion; successful abort can settle before its response without a bell', async t => {
  for (const outcome of ['rejected', 'rejected-after-settle', 'accepted']) await t.test(outcome, async t => {
    const { terminal, connection, send, ui } = launch(t);
    send('agent_start');
    const request = connection.request.bind(connection);
    let resolve!: () => void, reject!: (error: Error) => void;
    const reply = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    connection.request = (async (method: string) => method === 'rpc' ? reply : request(method)) as typeof connection.request;
    const abort = (ui as any).rpc({ type: 'abort' });
    if (outcome !== 'rejected') send('agent_settled');
    if (outcome === 'accepted') { resolve(); await abort; }
    else { reject(new Error('Abort refused')); await assert.rejects(abort, /Abort refused/); }
    if (outcome === 'rejected') send('agent_settled');
    assert.equal(terminal.bells, outcome === 'accepted' ? 0 : 1);
    assert.equal(terminal.last?.state, outcome === 'accepted' ? 'idle' : 'done');
    await flush(); assert.equal(terminal.bells, outcome === 'accepted' ? 0 : 1);
  });
});

test('standalone compaction reports working, done/error/abort; in-run compaction waits for agent_settled', async t => {
  for (const ending of [{}, { errorMessage: 'Summary failed' }, { aborted: true }]) await t.test(JSON.stringify(ending), async t => {
    const { terminal, send } = launch(t);
    send('compaction_start'); assert.equal(terminal.last?.state, 'working');
    send('compaction_end', ending);
    assert.equal(terminal.last?.state, ending.aborted ? 'idle' : ending.errorMessage ? 'error' : 'done');
    assert.equal(terminal.bells, ending.aborted ? 0 : 1);
    await flush();
  });
  const { terminal, send } = launch(t);
  send('agent_start'); send('compaction_start'); send('compaction_end', { willRetry: true });
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
  send('agent_settled'); assert.equal(terminal.bells, 1);
});

test('automatic pre-prompt compaction never completes before the foreground run starts', async t => {
  for (const ending of [{}, { errorMessage: 'Summary failed' }, { aborted: true }]) await t.test(JSON.stringify(ending), async t => {
    const { terminal, send } = launch(t);
    send('agent_start'); send('message_end', { message: { role: 'assistant', timestamp: 1, stopReason: 'aborted', content: [] } });
    send('agent_settled'); assert.equal(terminal.last?.state, 'idle');
    const reportCount = terminal.reports.length;
    send('compaction_start', { reason: 'threshold' }); send('compaction_end', { reason: 'threshold', ...ending });
    await flush(); assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
    assert.ok(terminal.reports.slice(reportCount).every(report => report.state === 'working'));
    send('agent_start'); send('message_end', { message: { role: 'assistant', timestamp: 2, stopReason: 'stop', content: [] } });
    send('agent_settled'); assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
    await flush(); assert.equal(terminal.bells, 1);
  });
});

test('a prompt rejected after automatic compaction reports error rather than remaining working', async t => {
  const { terminal, connection, send, ui } = launch(t);
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, no) => { reject = no; });
  const request = connection.request.bind(connection);
  connection.request = (async (method: string) => method === 'rpc' ? pending : request(method)) as typeof connection.request;
  const prompt = (ui as any).rpc({ type: 'prompt', message: 'Task' });
  send('compaction_start', { reason: 'threshold' }); send('compaction_end', { reason: 'threshold' });
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
  reject(new Error('Image preflight failed\nstack')); await assert.rejects(prompt, /Image preflight failed/);
  assert.equal(terminal.last?.state, 'error'); assert.equal(terminal.last?.message, 'Image preflight failed'); assert.equal(terminal.bells, 1);
  await flush(); assert.equal(terminal.bells, 1);
});

test('another requester preflight failure after auto compaction stays working until reconnect, then idles quietly', async t => {
  const { terminal, connection, send, ui } = launch(t);
  send('compaction_start', { reason: 'threshold' }); send('compaction_end', { reason: 'threshold' });
  send('remote_refresh'); await flush();
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
  const cut = structuredClone(ui.view.snapshot); cut.seq += 10; connection.reconnected?.(cut);
  assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 0);
  for (const [offset, type] of [[1, 'agent_start'], [2, 'agent_settled']] as const) {
    connection.listener?.({ type: 'event', slotId: 'slot', seq: cut.seq + offset, event: { type } });
  }
  assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
});

test('refresh journal keeps waiting asserted/cleared in order without replaying bells', async t => {
  for (const asserted of [true, false]) await t.test(String(asserted), async t => {
    const { terminal, connection, send, signal, ui } = launch(t);
    send('agent_start'); if (!asserted) signal();
    let resolve!: (snapshot: Snapshot) => void;
    connection.current = () => new Promise<Snapshot>(done => { resolve = done; });
    send('remote_refresh');
    if (asserted) signal(); else send('extension_ui_request', { ...waiting(), statusText: undefined });
    send('agent_settled');
    const cut = snapshot(true, asserted ? 2 : 3); if (!asserted) cut.ui = [waiting()];
    assert.equal(terminal.bells, asserted ? 0 : 1);
    connection.current = () => ui.view.snapshot;
    resolve(cut); await flush();
    assert.equal(terminal.last?.state, asserted ? 'working' : 'done');
    assert.equal(terminal.bells, asserted ? 0 : 1);
  });
});

test('reconnect observes completion once; stale dialogs, initial history, restart and detach do not replay bells', async t => {
  const initial = snapshot(true); const { terminal, connection, ui, send } = launch(t, initial);
  connection.disconnected?.(new Error('lost'));
  assert.equal(terminal.bells, 0);
  const idle = snapshot(false, 4); idle.ui = [{ id: 'restored', method: 'input', title: 'Restored question' }];
  connection.reconnected?.(idle); assert.equal(terminal.last?.state, 'blocked'); assert.equal(terminal.bells, 0);
  send('remote_dialog_resolved', { id: 'restored' }); // seq below restored snapshot is ignored.
  connection.listener?.({ type: 'event', slotId: 'slot', seq: 5, event: { type: 'remote_dialog_resolved', id: 'restored' } });
  assert.equal(terminal.bells, 0, 'resolving a restored dialog is not a completion event');
  connection.reconnected?.(snapshot(false, 6)); assert.equal(terminal.bells, 0);
  connection.listener?.({ type: 'event', slotId: 'slot', seq: 7, event: { type: 'remote_slot_restart', slot: { ...initial.slot, status: 'starting' } } });
  assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 0);
  ui.detach(); assert.equal(terminal.last?.state, 'clear'); await flush();
});

test('initial saved outcomes are quiet; session/process changes reset the root rather than replaying completion', async t => {
  const initial = snapshot();
  initial.live.messages.push({ role: 'assistant', timestamp: 1, stopReason: 'error', errorMessage: 'Old failure', content: [] });
  const { terminal, connection, send } = launch(t, initial);
  assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 0);
  send('agent_start'); send('agent_settled'); assert.equal(terminal.last?.state, 'done');
  const next = snapshot(false, 3); next.state.sessionId = 'other-session';
  connection.reconnected?.(next);
  assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 1);
  const restarted = snapshot(false, 4); restarted.slot.pid = 2;
  next.slot.pid = 1; connection.reconnected?.(next); connection.reconnected?.(restarted);
  assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 1); await flush();
});

test('snapshot/reconnect outcomes respect saved errors and aborts with complete or transitional history', async t => {
  for (const source of ['snapshot', 'reconnect']) for (const historyComplete of [true, false]) for (const stopReason of ['error', 'aborted']) {
    await t.test(`${source}/${historyComplete}/${stopReason}`, async t => {
      const { terminal, connection, send } = launch(t, snapshot(true));
      const idle = snapshot(false, 2); idle.historyComplete = historyComplete; idle.ui = [waiting()];
      const message = { role: 'assistant', timestamp: 2, stopReason, errorMessage: 'New failure\nstack', content: [] };
      if (historyComplete) {
        idle.entries = [{ type: 'message', id: 'final', parentId: null, message }]; idle.leafId = 'final';
      } else idle.live.messages = [message];
      if (source === 'reconnect') connection.reconnected?.(idle);
      else { connection.current = () => idle; send('remote_refresh'); await flush(); }
      assert.equal(terminal.last?.state, stopReason === 'error' ? 'error' : 'idle');
      assert.equal(terminal.bells, stopReason === 'error' ? 1 : 0);
      connection.reconnected?.(idle); assert.equal(terminal.bells, stopReason === 'error' ? 1 : 0);
    });
  }
});

test('reconnect can prove a complete wake-up run occurred, but clearing the signal alone stays working', async t => {
  for (const outcome of ['unchanged', 'stop', 'error', 'aborted']) await t.test(outcome, async t => {
    const { terminal, connection, send, signal, ui } = launch(t);
    send('agent_start');
    send('message_end', { message: { role: 'assistant', timestamp: 1, stopReason: 'stop', content: [] } });
    signal(); send('agent_settled'); await flush();
    assert.equal(terminal.bells, 0);
    const cut = structuredClone(ui.view.snapshot); cut.seq += 10; cut.ui = [];
    if (outcome !== 'unchanged') cut.live.messages.push({ role: 'assistant', timestamp: 2, stopReason: outcome, errorMessage: outcome === 'error' ? 'Failure' : undefined, content: [] });
    connection.reconnected?.(cut);
    assert.equal(terminal.last?.state, outcome === 'unchanged' ? 'working' : outcome === 'stop' ? 'done' : outcome === 'error' ? 'error' : 'idle');
    assert.equal(terminal.bells, outcome === 'stop' || outcome === 'error' ? 1 : 0);
    connection.reconnected?.(cut); assert.equal(terminal.bells, outcome === 'stop' || outcome === 'error' ? 1 : 0);
  });
});

test('exited slots never retain a working handoff; running-slot warnings are not run failures', async t => {
  const { terminal, connection, send, signal, ui } = launch(t);
  send('agent_start'); signal(); send('agent_settled');
  const cut = structuredClone(ui.view.snapshot); cut.seq += 10; cut.slot.status = 'exited'; cut.ui = [];
  connection.reconnected?.(cut); assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 0);
  cut.seq++; cut.slot.error = 'Process died'; connection.reconnected?.(cut);
  assert.equal(terminal.last?.state, 'error');
  const fresh = snapshot(true, cut.seq + 1); fresh.state.sessionId = 'fresh'; connection.reconnected?.(fresh);
  const done = snapshot(false, fresh.seq + 1); done.state.sessionId = 'fresh'; done.slot.error = 'Metadata save warning';
  connection.reconnected?.(done); assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1); await flush();
});

test('clean active slot exit completes once and keeps its result through repeated updates', async t => {
  const { terminal, send } = launch(t, snapshot(true));
  send('remote_slot_exit'); assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
  send('agent_settled'); send('remote_state', { state: { sessionId: 'session' } });
  assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1); await flush();
});

test('snapshot completion does not reuse a prior assistant error for standalone compaction', async t => {
  const initial = snapshot();
  initial.live.messages.push({ role: 'assistant', timestamp: 1, stopReason: 'error', errorMessage: 'Old failure', content: [] });
  const { terminal, connection, send, ui } = launch(t, initial);
  send('compaction_start');
  const idle = structuredClone(ui.view.snapshot); idle.seq = 3; idle.live.compacting = false;
  idle.live.messages = [{ content: [], errorMessage: 'Old failure', stopReason: 'error', timestamp: 1, role: 'assistant', extraSnapshotField: true }];
  connection.current = () => idle;
  send('remote_refresh'); await flush();
  assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
});

test('--no-bell suppresses both questions and completion, not program status', async t => {
  const { terminal, send } = launch(t, snapshot(), false);
  send('agent_start'); send('extension_ui_request', { method: 'input', id: 'q', title: 'Question' });
  assert.equal(terminal.last?.state, 'blocked');
  send('remote_dialog_resolved', { id: 'q' }); send('agent_settled');
  assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 0); await flush();
});

test('working/done messages use session name; errors use only their first line', async t => {
  const initial = snapshot(); initial.state.sessionName = 'Review client';
  const { terminal, send } = launch(t, initial);
  send('agent_start'); assert.equal(terminal.last?.message, 'Review client');
  send('agent_settled'); assert.equal(terminal.last?.message, 'Review client');
  send('agent_start');
  send('message_end', { message: { role: 'assistant', timestamp: 1, stopReason: 'error', content: [], errorMessage: 'Provider failed\n    at stack frame\n    more detail' } });
  send('agent_settled'); assert.equal(terminal.last?.message, 'Provider failed'); await flush();
});

test('OSC encoding is single-line UTF-8 base64, bounded, root-only and uses ST rather than BEL', () => {
  const sequence = formatProgramStatus({ state: 'blocked', kind: 'question', message: '\x1b\x07\n\tcafé:;=' + '😀'.repeat(1000) });
  assert.ok(sequence.startsWith('\x1b]7501;state=blocked:app=pi:kind=question:msg='));
  assert.ok(sequence.endsWith('\x1b\\')); assert.ok(Buffer.byteLength(sequence) < 4096);
  const encoded = sequence.split(':msg=')[1].slice(0, -2), decoded = Buffer.from(encoded, 'base64').toString('utf8');
  assert.ok(Buffer.byteLength(decoded) <= 2048); assert.ok(encoded.length <= 2732);
  assert.ok(decoded.startsWith('café:;=')); assert.doesNotMatch(decoded, /[\u0000-\u001f\u007f-\u009f\ufffd]/);
  assert.doesNotMatch(formatProgramStatus({ state: 'done', kind: 'question' }), /kind=/);
});

test('capability detection consumes split/batched replies before DA1, rejects late replies, and honors overrides', async t => {
  for (const mode of ['auto', 'unsupported', 'late', '1', '0']) await t.test(mode, () => {
    const terminal = new FakeTerminal();
    const adapter = new ProgramStatusTerminal(terminal, mode === '1' || mode === '0' ? { PI_PROGRAM_STATUS: mode } : {});
    const input: string[] = [];
    adapter.setProgramStatus({ state: 'working' }); adapter.start(data => input.push(data), () => {});
    if (mode === '1') assert.equal(terminal.last?.state, 'working');
    else assert.equal(terminal.reports.length, 0);
    if (mode === 'auto') {
      terminal.input('\x1b]7501;?'); terminal.input(':states=idle,working,done,blocked,error\x1b');
      terminal.input('\\\x1b[?1;2c'); assert.equal(terminal.last?.state, 'working');
    } else if (mode === 'late' || mode === 'unsupported') {
      terminal.input('\x1b[?1;2c');
      if (mode === 'late') terminal.input('\x1b]7501;?\x07');
      assert.equal(terminal.reports.length, 0);
    }
    terminal.input('abc'); assert.equal(input.join(''), 'abc', 'status replies and our DA1 sentinel never enter the editor');
    assert.equal(terminal.writes.some(data => data.includes(PROGRAM_STATUS_QUERY)), mode !== '1' && mode !== '0');
    adapter.stop();
    assert.equal(terminal.last?.state, mode === 'auto' || mode === '1' ? 'clear' : undefined);
  });
});

test('support timeout rejects late replies and consumes its eventual DA1 without swallowing other input', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const terminal = new FakeTerminal(), adapter = new ProgramStatusTerminal(terminal, {}), input: string[] = [];
  adapter.start(data => input.push(data), () => {});
  t.mock.timers.tick(1001);
  terminal.input(`${PROGRAM_STATUS_QUERY}\x1b[?1cabc`);
  assert.equal(terminal.reports.length, 0); assert.equal(input.join(''), 'abc'); adapter.stop();
});

test('terminal restart clears while stopped and restores latest state after forced/detected support', () => {
  const terminal = new FakeTerminal(), adapter = new ProgramStatusTerminal(terminal, {});
  adapter.start(() => {}, () => {}); terminal.input(`${PROGRAM_STATUS_QUERY}\x1b[?1c`);
  adapter.setProgramStatus({ state: 'blocked', kind: 'permission', message: 'Approve' });
  adapter.stop(); assert.equal(terminal.last?.state, 'clear');
  adapter.setProgramStatus({ state: 'done' }); assert.equal(terminal.last?.state, 'clear');
  adapter.start(() => {}, () => {}); assert.equal(terminal.last?.state, 'clear');
  terminal.input(`${PROGRAM_STATUS_QUERY}\x1b[?1c`); assert.equal(terminal.last?.state, 'done'); adapter.stop();
});


test('real ProcessTerminal preserves capability negotiation across keyboard DA1, batched CSI and fragmented OSC', async t => {
  for (const supported of [true, false]) await t.test(String(supported), t => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;
    const writes: string[] = [], input: string[] = [];
    const stdin = Object.assign(new EventEmitter(), {
      isRaw: false, setRawMode() {}, setEncoding() {}, resume() {}, pause() {},
    });
    const stdout = Object.assign(new EventEmitter(), { write: (data: string) => { writes.push(data); return true; } });
    t.mock.method(process, 'kill', () => true); // No real SIGWINCH while streams are replaced.
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });
    const adapter = new ProgramStatusTerminal(new ProcessTerminal(), {});
    try {
      adapter.setProgramStatus({ state: 'working' }); adapter.start(data => input.push(data), () => {});
      assert.equal(writes.filter(data => data.includes('\x1b[c')).length, 2, 'keyboard query and status query each have a DA1 sentinel');
      assert.equal(writes.some(data => data.includes('7501;state=')), false);
      // The keyboard DA1 precedes our query response and must be consumed by ProcessTerminal.
      // A split CSI response must not close our detection window.
      stdin.emit('data', '\x1b[?1u\x1b[?'); stdin.emit('data', '1;2c');
      if (supported) {
        stdin.emit('data', '\x1b]750'); stdin.emit('data', '1;?:states=idle,working,done,blocked,error');
        stdin.emit('data', '\x1b'); stdin.emit('data', '\\\x1b[?1;2cX');
        assert.ok(writes.some(data => data.includes('7501;state=working')));
      } else {
        stdin.emit('data', '\x1b[?1;2c\x1b]7501;?\x07X');
        assert.equal(writes.some(data => data.includes('7501;state=')), false, 'reply after our DA1 is too late');
      }
      assert.deepEqual(input, ['X'], 'neither DA1 reply nor OSC response reaches the editor');
      adapter.stop();
      assert.equal(writes.some(data => data.includes('7501;state=clear')), supported);
    } finally {
      adapter.stop();
      Object.defineProperty(process, 'stdin', stdinDescriptor);
      Object.defineProperty(process, 'stdout', stdoutDescriptor);
    }
  });
});
