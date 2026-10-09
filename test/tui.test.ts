import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import { Loader, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../src/protocol.js';
import { RemoteTui, type TuiOptions } from '../src/tui.js';
import { detachMessage, stoppedMessage } from '../src/remote-session.js';
import { activeBranch, applyAssistantDelta, RemoteView, restoredQueueText, safeText, toolText, transcriptMessages } from '../src/view.js';

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null,
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
    ui: [], seq: 0, ...overrides,
  };
}
function message(role = 'assistant', timestamp = 1): RecordValue {
  return { role, timestamp, stopReason: 'pending', content: [] };
}
function event(seq: number, event: RecordValue, slotId = 'slot'): RemoteEvent { return { type: 'event', slotId, seq, event }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  output = ''; title = ''; stopped = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle(title: string) { this.title = title; }
  setProgress() {}
}
class FakeConnection implements RemoteConnection {
  requests: { method: string; params?: RecordValue }[] = [];
  closed = false;
  events = new Set<(event: RemoteEvent) => void>();
  disconnects = new Set<(error: Error) => void>();
  backlog: RemoteEvent[] = [];
  handler: (method: string, params?: RecordValue) => any = () => ({});
  async request<T = any>(method: string, params?: RecordValue): Promise<T> {
    this.requests.push({ method, params }); return this.handler(method, params);
  }
  onEvent(listener: (event: RemoteEvent) => void) {
    this.events.add(listener); for (const event of this.backlog.splice(0)) listener(event);
    return () => { this.events.delete(listener); };
  }
  onDisconnect(listener: (error: Error) => void) { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
  close() { this.closed = true; }
  emit(value: RemoteEvent) { for (const listener of this.events) listener(value); }
  disconnect() { for (const listener of this.disconnects) listener(new Error('network lost')); }
}
class ReconnectingFakeConnection extends FakeConnection {
  reconnected?: (snapshot: Snapshot) => void;
  onReconnect(listener: (snapshot: Snapshot) => void) {
    this.reconnected = listener; return () => { this.reconnected = undefined; };
  }
}
function backgroundNotice(timestamp: number): RecordValue {
  return { role: 'custom', customType: 'background', timestamp, display: true, content: 'BACKGROUND_NOTICE',
    details: { id: 'worker', kind: 'shell', event: 'completion', state: 'completed', exitCode: 0 } };
}
function savedCustomEntry(message: RecordValue, id: string, parentId: string | null, timestamp = message.timestamp + 50): RecordValue {
  const { role: _role, ...stored } = message;
  return { ...stored, type: 'custom_message', id, parentId, timestamp: new Date(timestamp).toISOString() };
}
function screen(ui: RemoteTui): string {
  ui.tui.renderNow(); return stripTerminalSequences(ui.tui.getScreenLines().join('\n'));
}
function launch(t: any, initial = snapshot(), connection = new FakeConnection(), options: TuiOptions = {}) {
  const terminal = new FakeTerminal();
  const ui = new RemoteTui(connection, 'slot', initial, terminal, options);
  const finished = ui.run();
  t.after(() => ui.detach());
  const submit = (text: string) => { ui.editor.setText(text); terminal.input('\r'); };
  return { ui, terminal, connection, finished, submit };
}

function forkTree() {
  const assistant = { entry: { type: 'message', id: 'a', parentId: 'u', timestamp: '2026-01-01', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant context' }] } }, children: [] };
  const user = { entry: { type: 'message', id: 'u', parentId: null, timestamp: '2026-01-01', message: { role: 'user', content: 'original prompt' } }, children: [assistant] };
  return { tree: [user], leafId: 'a' };
}

function serveFork(connection: FakeConnection) {
  connection.handler = (method, params) => method === 'snapshot' ? snapshot() : params?.command.type === 'get_tree' ? forkTree() : params?.command.type === 'fork' ? { text: 'original\ntext', cancelled: false } : {};
}

test('active branch excludes abandoned branches and handles empty, broken and cyclic trees', () => {
  const entries = [
    { id: 'a', parentId: null }, { id: 'b', parentId: 'a' },
    { id: 'other', parentId: 'a' }, { id: 'c', parentId: 'b' },
  ];
  assert.deepEqual(activeBranch(entries, 'c').map(entry => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(activeBranch(entries, null), []);
  assert.deepEqual(activeBranch(entries, 'missing'), []);
  assert.deepEqual(activeBranch([{ id: 'orphan', parentId: 'missing' }], 'orphan').map(entry => entry.id), ['orphan']);
  assert.equal(activeBranch([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }], 'a').length, 2);
});

test('transcript merges persisted and live messages without dropping pre-compaction raw history', () => {
  const s = snapshot();
  const user = { role: 'user', timestamp: 1, content: 'original' };
  s.entries = [
    { type: 'message', id: 'a', parentId: null, message: user },
    { type: 'compaction', id: 'b', parentId: 'a', timestamp: 'iso', summary: 'summary' },
    { type: 'context_edit', id: 'c', parentId: 'b', targetId: 'a', replacement: null },
  ];
  s.leafId = 'c'; s.live.messages = [{ ...user, content: 'authoritative' }, message('assistant', 2)];
  const messages = transcriptMessages(s);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, 'authoritative');
  assert.equal(messages[1].role, 'compactionSummary');
});

test('text, thinking, and tool deltas are indexed, immutable, and replaced by authoritative ends', () => {
  const original = message();
  let partial = applyAssistantDelta(original, { type: 'text_delta', contentIndex: 0, delta: 'hello' });
  partial = applyAssistantDelta(partial, { type: 'thinking_delta', contentIndex: 1, delta: 'reason' });
  partial = applyAssistantDelta(partial, { type: 'text_delta', contentIndex: 0, delta: ' 🌍' }, { output: 3 });
  partial = applyAssistantDelta(partial, { type: 'toolcall_start', contentIndex: 2, id: 'call', toolName: 'bash' });
  partial = applyAssistantDelta(partial, { type: 'toolcall_delta', contentIndex: 2, delta: '{"command":' });
  partial = applyAssistantDelta(partial, { type: 'toolcall_delta', contentIndex: 2, delta: '"ls"}' });
  assert.equal(partial.content[0].text, 'hello 🌍');
  assert.equal(partial.content[1].thinking, 'reason');
  assert.equal(partial.content[2].argumentText, '{"command":"ls"}');
  assert.deepEqual(original.content, []);
  partial = applyAssistantDelta(partial, { type: 'text_end', contentIndex: 0, content: 'final' });
  partial = applyAssistantDelta(partial, { type: 'thinking_end', contentIndex: 1, content: 'final thought' });
  partial = applyAssistantDelta(partial, { type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'ls' } } });
  assert.equal(partial.content[0].text, 'final'); assert.equal(partial.content[1].thinking, 'final thought');
  assert.deepEqual(partial.content[2].arguments, { command: 'ls' });
  assert.equal(partial.content[2].argumentText, undefined);
  assert.equal(partial.usage.output, 3);
});

test('invalid and unknown delta indexes do not corrupt the message; provider terminal events replace it', () => {
  const initial = message();
  for (const index of [-1, 1.5, 10001, undefined]) {
    assert.deepEqual(applyAssistantDelta(initial, { type: 'text_delta', contentIndex: index, delta: 'bad' }).content, []);
  }
  assert.deepEqual(applyAssistantDelta(initial, { type: 'future', contentIndex: 0 }).content, []);
  const final = { ...initial, stopReason: 'stop', content: [{ type: 'text', text: 'done' }] };
  assert.deepEqual(applyAssistantDelta(initial, { type: 'done', message: final }), final);
  assert.deepEqual(applyAssistantDelta(initial, { type: 'error', error: { ...final, stopReason: 'error' } }).stopReason, 'error');
});

test('snapshot partial messages resume from deltas and final message replaces reconstructed content', () => {
  const s = snapshot(); s.live.busy = true;
  s.live.messages = [{ ...message(), content: [{ type: 'text', text: 'before' }] }];
  const view = new RemoteView(s);
  view.apply(event(1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' after' } }));
  assert.equal(view.snapshot.live.messages[0].content[0].text, 'before after');
  view.apply(event(2, { type: 'message_end', message: { ...message(), stopReason: 'stop', content: [{ type: 'text', text: 'final' }] } }));
  assert.equal(view.snapshot.live.messages.length, 1);
  assert.equal(view.snapshot.live.messages[0].content[0].text, 'final');
  assert.equal(s.live.messages[0].content[0].text, 'before');
});

test('display ignores duplicate sequences, wrong slots, and keeps busy through low-level agent_end', () => {
  const view = new RemoteView(snapshot());
  view.apply(event(1, { type: 'agent_start' }));
  assert.equal(view.apply(event(1, { type: 'agent_settled' })), false);
  assert.equal(view.apply(event(2, { type: 'agent_settled' }, 'other')), false);
  view.apply(event(2, { type: 'agent_end', willRetry: true }));
  assert.equal(view.snapshot.live.busy, true);
  view.apply(event(3, { type: 'agent_settled' })); assert.equal(view.snapshot.live.busy, false);
  view.apply(event(4, { type: 'remote_state', state: { model: { id: 'new-model' }, thinkingLevel: 'high' } }));
  assert.equal(view.snapshot.state.model.id, 'new-model');
});

test('UI state replaces statuses/widgets by key and resolves dialogs by id', () => {
  const view = new RemoteView(snapshot()); let seq = 0;
  for (const record of [
    { id: 's1', method: 'setStatus', statusKey: 'extension', statusText: 'busy' },
    { id: 's2', method: 'setStatus', statusKey: 'extension' },
    { id: 'w', method: 'setWidget', widgetKey: 'widget', widgetLines: ['hello'] },
    { id: 'd', method: 'confirm', title: 'Are you sure?' },
  ]) view.apply(event(++seq, { type: 'extension_ui_request', ...record }));
  assert.equal(view.snapshot.ui.length, 3);
  assert.equal(view.snapshot.ui[0].statusText, undefined);
  view.apply(event(++seq, { type: 'remote_dialog_resolved', id: 'd', reason: 'expired' }));
  assert.equal(view.snapshot.ui.length, 2);
});

test('queue restoration preserves order, multiline text, and the local draft', () => {
  assert.equal(restoredQueueText({ steering: ['one\nline', 'two'], followUp: ['later'] }, 'draft'), 'one\nline\n\ntwo\n\nlater\n\ndraft');
  assert.equal(restoredQueueText({}, ''), '');
});

test('remote text cannot emit terminal controls; generic tools include image placeholders', () => {
  assert.equal(safeText('\x1b[2Jhello\x1b]0;title\x07\x00\r\n世界\x9b'), 'hello\n世界');
  assert.equal(toolText({ content: [{ type: 'text', text: 'output' }, { type: 'image', mimeType: 'image/png' }] }), 'output\n[image: image/png]');
});

test('Ctrl+D detaches with a remote dialog open without answering, aborting, or killing', async t => {
  const initial = snapshot({ ui: [{ type: 'extension_ui_request', id: 'dialog', method: 'confirm', title: 'Continue?' }] });
  const { terminal, connection, finished } = launch(t, initial);
  terminal.input('\x04'); await finished;
  assert.equal(connection.closed, true); assert.equal(terminal.stopped, true);
  assert.deepEqual(connection.requests, []); assert.equal(connection.events.size, 0);
});

test('disconnect preserves remote dialogs and sends no automatic commands; Ctrl+D still works', async t => {
  const initial = snapshot({ ui: [{ id: 'dialog', method: 'input', title: 'Value' }] });
  const { ui, terminal, connection, finished } = launch(t, initial);
  connection.disconnect(); terminal.input('\x1b'); await flush();
  assert.equal(ui.view.snapshot.ui[0].id, 'dialog'); assert.equal(connection.requests.length, 0);
  terminal.input('\x04'); await finished;
});

test('starting-slot refresh preserves MCP warnings while learning the initial session identity', async t => {
  const initial = snapshot(); initial.slot.status = 'starting';
  const { ui, connection } = launch(t, initial);
  const rows = () => { ui.tui.renderNow(); return stripTerminalSequences(ui.tui.getScreenLines().join('\n')); };
  connection.emit(event(1, { type: 'extension_ui_request', method: 'notify', message: 'MCP_STARTUP_WARNING' }));
  assert.match(rows(), /MCP_STARTUP_WARNING/);
  const ready = snapshot({ seq: 2, state: { sessionId: 'first-session' } });
  connection.handler = method => method === 'snapshot' ? ready : {};
  connection.emit(event(2, { type: 'remote_refresh' })); await flush();
  assert.match(rows(), /MCP_STARTUP_WARNING/);
  ready.seq = 3; ready.state.sessionFile = '/remote/first-session.jsonl';
  connection.emit(event(3, { type: 'remote_refresh' })); await flush();
  assert.match(rows(), /MCP_STARTUP_WARNING/);
  ready.seq = 4; ready.state = { sessionId: 'next-session', sessionFile: '/remote/next-session.jsonl' };
  connection.emit(event(4, { type: 'remote_refresh' })); await flush();
  assert.doesNotMatch(rows(), /MCP_STARTUP_WARNING/);
});

test('repeated reconnects clear obsolete connection notices, preserve warnings and do not replay commands', async t => {
  const initial = snapshot({ ui: [{ id: 'dialog', method: 'input', title: 'Preserved question' }] });
  initial.live.messages = [{ role: 'user', timestamp: 1, content: 'EARLIER_PROMPT' }];
  const connection = new ReconnectingFakeConnection();
  const { ui } = launch(t, initial, connection);
  const rows = () => { ui.tui.renderNow(); return stripTerminalSequences(ui.tui.getScreenLines().join('\n')); };
  connection.emit(event(1, { type: 'extension_ui_request', method: 'notify', message: 'MCP_WARNING' }));
  const restored = structuredClone(initial); restored.seq = 1;
  restored.live.messages.push({ role: 'user', timestamp: 2, content: 'LATER_PROMPT' });
  for (let i = 0; i < 3; i++) {
    connection.disconnect();
    assert.match(rows(), /Connection lost/);
    connection.reconnected?.(restored); await flush();
    const output = rows();
    assert.doesNotMatch(output, /Connection lost/);
    assert.equal((output.match(/Reattached\./g) ?? []).length, 1, output);
    assert.ok(output.indexOf('MCP_WARNING') < output.indexOf('LATER_PROMPT'), output);
    assert.equal(ui.view.snapshot.ui[0].id, 'dialog');
  }
  assert.ok(connection.requests.every(request => request.method === 'filesystem_metadata'
    || ['get_available_models', 'get_session_stats'].includes(request.params?.command?.type)), JSON.stringify(connection.requests));
  connection.emit(event(2, { type: 'message_start', message: { role: 'user', timestamp: 3, content: 'NEW_CONVERSATION' } }));
  const output = rows();
  assert.ok(output.indexOf('Reattached.') < output.indexOf('NEW_CONVERSATION'), output);
});

test('Enter and Alt+Enter send steer and followUp, and extension slash commands are prompts', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const { ui, terminal, connection, submit } = launch(t, initial);
  submit('change direction'); await flush();
  ui.editor.setText('later'); terminal.input('\x1b[13;3u'); await flush();
  submit('/extension-command argument'); await flush();
  assert.deepEqual(connection.requests.map(request => request.params?.command), [
    { type: 'prompt', message: 'change direction', streamingBehavior: 'steer' },
    { type: 'prompt', message: 'later', streamingBehavior: 'followUp' },
    { type: 'prompt', message: '/extension-command argument', streamingBehavior: 'steer' },
  ]);
  assert.equal(ui.editor.getExpandedText(), '');
});

test('local help and detach are never sent to Pi', async t => {
  const { terminal, connection, submit, finished } = launch(t);
  submit('/help'); await flush(); assert.equal(connection.requests.length, 0);
  submit('/detach'); await finished; assert.equal(connection.requests.length, 0);
  assert.equal(terminal.stopped, true);
});

test('Ctrl+C clears the prompt locally and sends nothing', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const { ui, terminal, connection } = launch(t, initial);
  ui.editor.setText('draft\nsecond line'); terminal.input('\x03'); await flush();
  assert.equal(ui.editor.getExpandedText(), '');
  terminal.input('\x03'); await flush();
  assert.equal(ui.editor.getExpandedText(), '');
  assert.deepEqual(connection.requests, []); assert.equal(terminal.stopped, false);
});

test('Ctrl+C in a remote dialog keeps the prompt draft and uses the dialog cancel', async t => {
  const initial = snapshot({ ui: [{ id: 'dialog', method: 'input', title: 'Value' }] });
  const { ui, terminal, connection } = launch(t, initial);
  ui.editor.setText('draft'); terminal.input('\x03'); await flush();
  assert.equal(ui.editor.getExpandedText(), 'draft');
  // pi-tui's Input treats Ctrl+C like Esc, as in stock Pi dialogs.
  assert.deepEqual(connection.requests.map(request => request.method), ['answer']);
});

test('footer shows the remote host and no key-hint line', async t => {
  const { terminal } = launch(t, snapshot(), new FakeConnection(), { host: 'devbox' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const screen = stripTerminalSequences(terminal.output);
  assert.match(screen, /\uEB3A devbox/);
  assert.doesNotMatch(screen, /Alt\+Enter follow-up/);
});

test('working status stays in the editor border above the prompt and footer while the agent runs', async t => {
  const initial = snapshot(); initial.live.busy = true; initial.live.steering = ['queued instruction'];
  initial.ui = [
    { id: 'above', method: 'setWidget', widgetKey: 'above', widgetLines: ['above-editor widget'] },
    { id: 'below', method: 'setWidget', widgetKey: 'below', widgetPlacement: 'belowEditor', widgetLines: ['below-editor widget'] },
  ];
  const { ui, terminal, connection } = launch(t, initial);
  ui.editor.setText('prompt draft');
  const rows = () => { ui.tui.renderNow(); return ui.tui.getScreenLines().map(stripTerminalSequences); };
  const checkOrder = () => {
    const screen = rows();
    const markers = ['Steering: queued instruction', 'to edit all queued messages', 'above-editor widget', ' Working ', 'prompt draft', 'below-editor widget', 'Working · slot'];
    const positions = markers.map(marker => screen.findIndex(row => row.includes(marker)));
    assert.ok(positions.every(position => position >= 0), screen.join('\n'));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, screen.join('\n'));
  };
  checkOrder();
  // A smaller viewport must still keep the status in the pinned prompt area.
  terminal.rows = 12; terminal.resize(); checkOrder();
  assert.equal(ui.editor.focused, true);
  connection.emit(event(1, { type: 'agent_end', willRetry: true }));
  checkOrder();
  connection.handler = method => method === 'snapshot' ? snapshot({ seq: 2 }) : {};
  connection.emit(event(2, { type: 'agent_settled' })); await flush();
  assert.ok(!rows().some(row => row.includes(' Working ')));
  assert.ok(rows().some(row => row.includes('Ready · slot')));
});

test('working status remains above a remote dialog instead of below the footer', async t => {
  const initial = snapshot({ ui: [{ id: 'dialog', method: 'input', title: 'Remote question' }] });
  initial.live.busy = true;
  const { ui } = launch(t, initial);
  ui.tui.renderNow();
  const screen = ui.tui.getScreenLines().map(stripTerminalSequences);
  const working = screen.findIndex(row => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working/.test(row));
  const dialog = screen.findIndex(row => row.includes('Remote question'));
  const footer = screen.findIndex(row => row.includes('Working · slot'));
  assert.ok(working >= 0 && working < dialog && dialog < footer, screen.join('\n'));
});

test('detach message includes the slot number when known', () => {
  assert.equal(detachMessage('uuid', 3), 'Detached from slot 3 / uuid');
  assert.equal(detachMessage('uuid'), 'Detached from slot uuid');
  assert.equal(stoppedMessage('uuid', 3), 'Stopped slot 3 / uuid');
  assert.equal(stoppedMessage('uuid'), 'Stopped slot uuid');
});

test('remote_slot_restart clears live/UI state but keeps cached history and increasing sequence', () => {
  const initial = snapshot({ entries: [{ id: 'saved', type: 'message', parentId: null, message: { role: 'user', content: 'saved history', timestamp: 1 } }], leafId: 'saved', seq: 10 });
  initial.live.busy = true; initial.live.compacting = true;
  initial.live.messages = [message()]; initial.live.tools.old = { type: 'tool_execution_update' };
  initial.live.steering = ['steering']; initial.live.followUp = ['follow-up']; initial.live.bash = { old: { output: 'partial' } };
  initial.ui = [{ id: 'old', method: 'confirm' }]; initial.presentation = { models: [{ id: 'old' }] };
  const view = new RemoteView(initial);
  const slot = { ...initial.slot, status: 'starting' as const, pid: undefined };
  assert.equal(view.apply(event(11, { type: 'remote_slot_restart', slot })), true);
  assert.deepEqual(view.snapshot.live, snapshot().live); assert.deepEqual(view.snapshot.ui, []);
  assert.deepEqual(view.snapshot.entries, initial.entries); assert.equal(view.snapshot.leafId, 'saved');
  assert.deepEqual(view.snapshot.slot, slot); assert.equal(view.snapshot.presentation, undefined);
  assert.equal(view.apply(event(10, { type: 'agent_start' })), false); assert.equal(view.snapshot.seq, 11);
});

test('/reload on an idle slot restarts through the daemon and keeps the client attached', async t => {
  const { ui, terminal, connection, submit } = launch(t);
  const slot = { ...ui.view.snapshot.slot, status: 'starting' as const };
  connection.handler = method => {
    assert.equal(method, 'restart');
    connection.emit(event(1, { type: 'remote_slot_restart', slot }));
    return slot;
  };
  (ui as any).pendingAttachments = [{ path: 'local.txt', text: 'keep this attachment' }];
  submit('/reload'); ui.editor.setText('draft typed during reload'); await flush();
  assert.deepEqual(connection.requests, [{ method: 'restart', params: { slotId: 'slot' } }]);
  assert.equal(connection.closed, false); assert.equal(terminal.stopped, false); assert.equal(ui.stoppedSlot, false);
  assert.equal(ui.editor.getExpandedText(), 'draft typed during reload');
  assert.equal((ui as any).pendingAttachments.length, 1); assert.match(screen(ui), /Starting/);
  submit('blocked @remote/file.txt'); await flush();
  assert.equal(connection.requests.length, 1); assert.equal(ui.editor.getExpandedText(), 'blocked @remote/file.txt');
  assert.equal((ui as any).pendingAttachments.length, 1);
  const ready = snapshot({ seq: 2, state: { sessionId: 'same-session', model: { id: 'new-model' } } });
  connection.handler = method => method === 'snapshot' ? ready : {};
  connection.emit(event(2, { type: 'remote_refresh' })); await flush();
  assert.equal(ui.view.snapshot.slot.status, 'running'); assert.match(screen(ui), /new-model/);
  submit('new prompt'); await flush();
  assert.equal(connection.requests.at(-1)?.params?.command?.message, 'new prompt\n\nAttached local file local.txt:\nkeep this attachment');
  assert.equal((ui as any).pendingAttachments.length, 0);
});

test('/reload busy confirmation defaults to Cancel and only confirmation sends force', async t => {
  for (const kind of ['streaming', 'compacting', 'steering', 'follow-up', 'bash', 'tool', 'inflight']) {
    await t.test(kind, async t => {
      const initial = snapshot();
      if (kind === 'streaming') initial.live.busy = true;
      if (kind === 'compacting') initial.live.compacting = true;
      if (kind === 'steering') initial.live.steering = ['queued'];
      if (kind === 'follow-up') initial.live.followUp = ['queued'];
      if (kind === 'bash') initial.live.bash = { shell: { output: 'working' } };
      if (kind === 'tool') initial.live.tools.shell = { type: 'tool_execution_start' };
      const { ui, terminal, connection, submit } = launch(t, initial);
      const pending = deferred<RecordValue>();
      connection.handler = (method, params) => {
        if (params?.command?.type === 'prompt') return pending.promise;
        if (method === 'restart') {
          const slot = { ...initial.slot, status: 'starting' as const };
          connection.emit(event(1, { type: 'remote_slot_restart', slot })); return slot;
        }
        return {};
      };
      if (kind === 'inflight') { submit('work accepted but not yet visible'); await flush(); }
      const before = connection.requests.length;
      submit('/reload'); await flush(); assert.match(screen(ui), /Reload remote Pi\?/);
      terminal.input('\r'); await flush();
      assert.equal(connection.requests.length, before); assert.equal(connection.closed, false);
      submit('/reload'); await flush(); terminal.input('\x1b[B'); terminal.input('\r'); await flush();
      assert.deepEqual(connection.requests.at(-1), { method: 'restart', params: { slotId: 'slot', force: true } });
      assert.equal(connection.closed, false); assert.equal(ui.view.snapshot.slot.status, 'starting');
      pending.resolve({}); await flush();
    });
  }
});

test('/reload handles a late authoritative busy refusal with explicit confirm or cancel', async t => {
  for (const confirm of [false, true]) await t.test(confirm ? 'confirm' : 'cancel', async t => {
    const { ui, terminal, connection, submit } = launch(t);
    connection.handler = (_method, params) => {
      if (!params?.force) throw new Error('Remote Pi is busy. Confirm reload to interrupt running work and discard queued prompts.');
      const slot = { ...ui.view.snapshot.slot, status: 'starting' as const };
      connection.emit(event(1, { type: 'remote_slot_restart', slot })); return slot;
    };
    submit('/reload'); await flush();
    assert.equal(connection.requests.length, 1); assert.match(screen(ui), /Reload remote Pi\?/);
    if (confirm) terminal.input('\x1b[B');
    terminal.input('\r'); await flush();
    assert.equal(connection.requests.length, confirm ? 2 : 1);
    if (confirm) assert.deepEqual(connection.requests[1], { method: 'restart', params: { slotId: 'slot', force: true } });
    assert.equal(connection.closed, false);
  });
});

test('/reload disconnect does not replay an uncertain restart on reconnect', async t => {
  const connection = new ReconnectingFakeConnection();
  const { ui, submit } = launch(t, snapshot(), connection);
  const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
  submit('/reload'); await flush(); connection.disconnect();
  pending.reject(new Error('network lost after acceptance')); await flush();
  connection.handler = () => ({});
  connection.reconnected?.(snapshot({ seq: 5 })); await flush();
  assert.deepEqual(connection.requests, [{ method: 'restart', params: { slotId: 'slot' } }]);
  assert.equal(connection.closed, false); assert.match(screen(ui), /no submitted commands were replayed/);
});

test('/reload reports failed startup without detaching or claiming success', async t => {
  const { ui, connection, submit } = launch(t);
  connection.handler = () => {
    connection.emit(event(1, { type: 'remote_slot_restart', slot: { ...ui.view.snapshot.slot, status: 'starting' } }));
    return { ...ui.view.snapshot.slot, status: 'exited', error: 'failed to launch Pi' };
  };
  submit('/reload'); await flush();
  assert.equal(connection.requests.length, 1); assert.equal(connection.closed, false);
  assert.equal(ui.view.snapshot.slot.status, 'exited'); assert.equal(ui.stoppedSlot, false);
  assert.match(screen(ui), /reload failed: failed to launch Pi/); assert.doesNotMatch(screen(ui), /Reload accepted/);
});

test('/reload non-busy rejection is not retried or offered force confirmation', async t => {
  const { ui, connection, submit } = launch(t);
  connection.handler = () => { throw new Error('Unsupported method: restart'); };
  submit('/reload'); await flush();
  assert.equal(connection.requests.length, 1); assert.equal((ui as any).localDialog, undefined);
  assert.equal(ui.editor.getExpandedText(), '/reload'); assert.match(screen(ui), /Unsupported method/);
});

test('restart discards stale refresh and dialog answers and accepts new startup UI identities', async t => {
  const initial = snapshot({ ui: [
    { id: 'same-id', method: 'confirm', title: 'Old dialog' },
    { id: 'reused-editor', method: 'set_editor_text', text: 'old editor text' },
    { id: 'old-title', method: 'setTitle', title: 'old title' },
  ] });
  const { ui, terminal, connection } = launch(t, initial);
  const answer = deferred<RecordValue>(); const oldRefresh = deferred<Snapshot>();
  connection.handler = method => method === 'answer' ? answer.promise : oldRefresh.promise;
  terminal.input('\r'); await flush();
  connection.emit(event(1, { type: 'remote_refresh' }));
  ui.editor.setText('preserved draft');
  connection.emit(event(2, { type: 'remote_slot_restart', slot: { ...initial.slot, status: 'starting' } }));
  assert.equal((ui as any).activeRemote, undefined); assert.equal((ui as any).answering.size, 0);
  assert.equal(terminal.title, ''); assert.equal((ui as any).appliedEditorId, undefined);
  assert.equal(ui.editor.getExpandedText(), 'preserved draft');
  connection.emit(event(3, { type: 'extension_ui_request', id: 'same-id', method: 'confirm', title: 'New startup dialog' }));
  answer.resolve({}); oldRefresh.resolve(snapshot({ seq: 1, ui: initial.ui })); await flush();
  assert.match(screen(ui), /New startup dialog/); assert.equal(ui.view.snapshot.seq, 3);
  assert.equal(ui.view.snapshot.slot.status, 'starting');
  connection.handler = () => ({}); terminal.input('\r'); await flush();
  assert.equal(connection.requests.filter(request => request.method === 'answer').length, 2);
  assert.equal(ui.view.snapshot.ui.length, 0);
  connection.emit(event(4, { type: 'extension_ui_request', id: 'reused-editor', method: 'set_editor_text', text: 'new editor text' }));
  assert.equal(ui.editor.getExpandedText(), 'new editor text');
});

test('reconnect after a missed restart clears old metadata and remote UI identities', async t => {
  const initial = snapshot({ ui: [{ id: 'same-id', method: 'confirm', title: 'Old process dialog' }], presentation: { models: [{ id: 'old-model' }] } });
  initial.slot.pid = 10; initial.live.busy = true;
  const connection = new ReconnectingFakeConnection();
  const { ui } = launch(t, initial, connection);
  ui.editor.setText('draft survives reconnect'); connection.disconnect();
  const recovered = snapshot({ seq: 5, ui: [{ id: 'same-id', method: 'confirm', title: 'New process dialog' }] });
  recovered.slot.pid = 20; recovered.live.busy = true;
  connection.reconnected?.(recovered); await flush();
  assert.match(screen(ui), /New process dialog/); assert.doesNotMatch(screen(ui), /Old process dialog/);
  assert.equal(ui.view.snapshot.presentation?.models, undefined);
  assert.equal(ui.editor.getExpandedText(), 'draft survives reconnect');
  assert.equal(ui.view.snapshot.live.busy, true); assert.equal((ui as any).pendingBell, false);
});

test('same-process reconnect retires a pending snapshot and permits later refreshes', async t => {
  const initial = snapshot(); initial.slot.pid = 10;
  const connection = new ReconnectingFakeConnection();
  const { ui } = launch(t, initial, connection);
  const pending = deferred<Snapshot>(); connection.handler = () => pending.promise;
  connection.emit(event(1, { type: 'remote_refresh' }));
  connection.disconnect();
  const reattached = snapshot({ seq: 5 }); reattached.slot.pid = 10;
  connection.reconnected?.(reattached);
  pending.resolve(snapshot({ seq: 1 })); await flush();
  const fresh = snapshot({ seq: 6, state: { model: { id: 'fresh-model' } } }); fresh.slot.pid = 10;
  connection.handler = () => fresh;
  connection.emit(event(6, { type: 'remote_refresh' })); await flush();
  assert.equal(connection.requests.filter(request => request.method === 'snapshot').length, 2);
  assert.equal(ui.view.snapshot.state.model.id, 'fresh-model'); assert.equal(ui.view.snapshot.seq, 6);
});

test('a stale refresh cannot clear or overwrite a new process refresh', async t => {
  const { ui, connection } = launch(t);
  const oldRefresh = deferred<Snapshot>(), newRefresh = deferred<Snapshot>();
  connection.handler = () => oldRefresh.promise;
  connection.emit(event(1, { type: 'remote_refresh' }));
  connection.emit(event(2, { type: 'remote_slot_restart', slot: { ...ui.view.snapshot.slot, status: 'starting' } }));
  connection.handler = () => newRefresh.promise;
  connection.emit(event(3, { type: 'remote_refresh' }));
  oldRefresh.resolve(snapshot({ seq: 1 })); await flush();
  assert.equal((ui as any).refreshing, true); assert.equal(ui.view.snapshot.slot.status, 'starting');
  connection.emit(event(4, { type: 'agent_start' }));
  newRefresh.resolve(snapshot({ seq: 3, state: { model: { id: 'new-process' } } })); await flush();
  assert.equal(ui.view.snapshot.seq, 4); assert.equal(ui.view.snapshot.live.busy, true);
  assert.equal(ui.view.snapshot.state.model.id, 'new-process'); assert.equal((ui as any).refreshing, false);
  assert.equal(connection.requests.filter(request => request.method === 'snapshot').length, 2);
});

test('restart cancels local pickers and discards model reads from the old process', async t => {
  for (const awaitingRead of [false, true]) await t.test(awaitingRead ? 'read pending' : 'picker open', async t => {
    const { ui, connection, submit } = launch(t);
    const pending = deferred<RecordValue>();
    const models = { models: [{ provider: 'old', id: 'old-model' }] };
    connection.handler = () => awaitingRead ? pending.promise : models;
    submit('/model'); await flush();
    if (!awaitingRead) assert.match(screen(ui), /Choose model/);
    connection.emit(event(1, { type: 'remote_slot_restart', slot: { ...ui.view.snapshot.slot, status: 'starting' } }));
    pending.resolve(models); await flush();
    assert.equal((ui as any).localDialog, undefined); assert.equal(connection.requests.length, 1);
    assert.doesNotMatch(screen(ui), /Choose model/);
  });
});

test('/quit on an idle slot kills it through the daemon, not Pi, then closes the client', async t => {
  const { ui, terminal, connection, submit, finished } = launch(t);
  submit('/quit'); await finished;
  assert.deepEqual(connection.requests, [{ method: 'kill', params: { slotId: 'slot' } }]);
  assert.equal(ui.stoppedSlot, true); assert.equal(connection.closed, true); assert.equal(terminal.stopped, true);
});

test('/quit while Pi is working asks first; cancel keeps the slot and the client', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const { ui, terminal, connection, submit } = launch(t, initial);
  submit('/quit'); await flush();
  assert.match(stripTerminalSequences(terminal.output), /Stop the remote Pi process\?/);
  terminal.input('\x1b'); await flush();
  assert.deepEqual(connection.requests, []);
  assert.equal(ui.stoppedSlot, false); assert.equal(terminal.stopped, false); assert.equal(connection.closed, false);
});

test('/quit while Pi is working kills the slot after confirmation', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const { ui, terminal, connection, submit, finished } = launch(t, initial);
  submit('/quit'); await flush();
  terminal.input('\x1b[B'); terminal.input('\r'); await finished;
  assert.deepEqual(connection.requests, [{ method: 'kill', params: { slotId: 'slot' } }]);
  assert.equal(ui.stoppedSlot, true);
});

test('/quit failure keeps the client attached and does not report a stopped slot', async t => {
  const { ui, terminal, connection, submit } = launch(t);
  connection.handler = () => { throw new Error('daemon unavailable'); };
  submit('/quit'); await flush();
  assert.equal(connection.requests.length, 1);
  assert.equal(ui.stoppedSlot, false); assert.equal(terminal.stopped, false);
  assert.match(stripTerminalSequences(terminal.output), /daemon unavailable/);
});

test('/quit while disconnected sends nothing and keeps the client', async t => {
  const { ui, terminal, connection, submit } = launch(t);
  connection.disconnect(); submit('/quit'); await flush();
  assert.deepEqual(connection.requests, []);
  assert.equal(ui.stoppedSlot, false); assert.equal(terminal.stopped, false);
});

test('/quit on an exited slot closes the client without another kill', async t => {
  const initial = snapshot(); initial.slot.status = 'exited';
  const { ui, connection, submit, finished } = launch(t, initial);
  submit('/quit'); await finished;
  assert.deepEqual(connection.requests, []); assert.equal(ui.stoppedSlot, true);
});

test('Esc clears the queue BEFORE abort and restores returned text plus draft', async t => {
  const initial = snapshot(); initial.live.busy = true; initial.live.steering = ['queued'];
  const { ui, terminal, connection } = launch(t, initial);
  connection.handler = (_method, params) => params?.command.type === 'clear_queue' ? { steering: ['first'], followUp: ['last'] } : {};
  ui.editor.setText('draft'); terminal.input('\x1b'); await flush();
  assert.deepEqual(connection.requests.map(request => request.params?.command.type), ['clear_queue', 'abort']);
  assert.equal(ui.editor.getExpandedText(), 'first\n\nlast\n\ndraft');
});

test('queued messages render like Pi with the dequeue hint', async t => {
  const initial = snapshot(); initial.live.busy = true;
  initial.live.steering = ['steer one', 'multi\nline']; initial.live.followUp = ['later'];
  const { ui } = launch(t, initial);
  ui.tui.renderNow();
  const screen = ui.tui.getScreenLines().map(stripTerminalSequences);
  const start = screen.findIndex(row => row.startsWith(' Steering: steer one'));
  assert.ok(start > 0, screen.join('\n'));
  const key = process.platform === 'darwin' ? 'Option+Up' : 'Alt+Up';
  assert.equal(screen[start - 1].trim(), '');
  assert.deepEqual(screen.slice(start, start + 4).map(row => row.trimEnd()), [
    ' Steering: steer one', ' Steering: multi', ' Follow-up: later', ` ↳ ${key} to edit all queued messages`,
  ]);
});

test('Alt+Up restores queued messages to the editor without aborting', async t => {
  const initial = snapshot(); initial.live.busy = true; initial.live.steering = ['queued'];
  const { ui, terminal, connection } = launch(t, initial);
  connection.handler = (_method, params) => params?.command.type === 'clear_queue' ? { steering: ['first'], followUp: ['last'] } : {};
  ui.editor.setText('draft'); terminal.input('\x1b[1;3A'); await flush();
  assert.deepEqual(connection.requests.map(request => request.params?.command.type), ['clear_queue']);
  assert.equal(ui.editor.getExpandedText(), 'first\n\nlast\n\ndraft');
  assert.deepEqual(ui.view.snapshot.live.steering, []);
  ui.tui.renderNow();
  assert.ok(!ui.tui.getScreenLines().some(row => row.includes('to edit all queued messages')));
});

test('failed clear_queue does not send abort or discard queue text', async t => {
  const initial = snapshot(); initial.live.busy = true; initial.live.followUp = ['keep'];
  const { ui, terminal, connection } = launch(t, initial);
  connection.handler = () => { throw new Error('failure'); };
  ui.editor.setText('draft'); terminal.input('\x1b'); await flush();
  assert.equal(connection.requests.length, 1); assert.equal(ui.editor.getExpandedText(), 'draft');
  assert.deepEqual(ui.view.snapshot.live.followUp, ['keep']);
});

test('dialog Esc uses daemon answer, not RPC, and does not abort the agent', async t => {
  const { terminal, connection } = launch(t, snapshot({ ui: [{ id: 'd', method: 'confirm', title: 'Confirm' }] }));
  terminal.input('\x1b'); await flush();
  assert.deepEqual(connection.requests, [{ method: 'answer', params: { slotId: 'slot', response: { id: 'd', cancelled: true } } }]);
});

test('selection returns the original option while rendering a safe label', async t => {
  const value = '\x1b[31mred\x1b[0m';
  const { terminal, connection } = launch(t, snapshot({ ui: [{ id: 'd', method: 'select', title: 'Pick', options: [value] }] }));
  terminal.input('\r'); await flush();
  assert.equal(connection.requests[0].params?.response.value, value);
});

test('multiline editor dialog preserves whitespace and uses Enter to submit', async t => {
  const prefill = '  first\nsecond\n';
  const { terminal, connection } = launch(t, snapshot({ ui: [{ id: 'd', method: 'editor', title: 'Edit', prefill }] }));
  terminal.input('\r'); await flush();
  assert.equal(connection.requests[0].params?.response.value, prefill);
});

test('initial synchronous event backlog respects the initial snapshot sequence', async t => {
  const initial = snapshot({ seq: 10 }); initial.live.busy = true;
  initial.live.messages = [{ ...message(), content: [{ type: 'text', text: 'prefix' }] }];
  const connection = new FakeConnection();
  connection.backlog = [
    event(10, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'duplicate' } }),
    event(11, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' suffix' } }),
  ];
  const { ui } = launch(t, initial, connection);
  assert.equal(ui.view.snapshot.live.messages[0].content[0].text, 'prefix suffix');
});

test('authoritative refresh replaces a completed custom message with its later-timestamp saved copy', async t => {
  const notice = backgroundNotice(Date.parse('2026-04-01T00:00:00.000Z'));
  const { ui, connection } = launch(t);
  connection.emit(event(1, { type: 'message_start', message: notice }));
  connection.emit(event(2, { type: 'message_end', message: notice }));
  assert.equal((screen(ui).match(/BACKGROUND_NOTICE/g) ?? []).length, 1);
  const saved = savedCustomEntry(notice, 'saved-notice', null);
  const authoritative = snapshot({ historyComplete: true, seq: 3, entries: [saved], leafId: saved.id });
  connection.handler = method => method === 'snapshot' ? authoritative : {};
  connection.emit(event(3, { type: 'remote_refresh' })); await flush();
  assert.deepEqual(ui.view.snapshot.live.messages, []);
  const messages = transcriptMessages(ui.view.snapshot);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, saved.id);
  assert.equal(messages[0].timestamp, notice.timestamp + 50);
  assert.equal((screen(ui).match(/BACKGROUND_NOTICE/g) ?? []).length, 1);
  assert.deepEqual(authoritative.live.messages, [], 'Rendering must not populate the daemon snapshot');
});

test('authoritative refresh preserves two legitimate identical background notices', async t => {
  const notices = [backgroundNotice(100), backgroundNotice(100)];
  const { ui, connection } = launch(t, snapshot({ historyComplete: true }));
  notices.forEach((notice, index) => {
    connection.emit(event(index * 2 + 1, { type: 'message_start', message: notice }));
    connection.emit(event(index * 2 + 2, { type: 'message_end', message: notice }));
  });
  assert.equal((screen(ui).match(/BACKGROUND_NOTICE/g) ?? []).length, 2);
  const entries = [savedCustomEntry(notices[0], 'first', null), savedCustomEntry(notices[1], 'second', 'first')];
  connection.handler = method => method === 'snapshot' ? snapshot({ historyComplete: true, seq: 5, entries, leafId: 'second' }) : {};
  connection.emit(event(5, { type: 'remote_refresh' })); await flush();
  const messages = transcriptMessages(ui.view.snapshot);
  assert.deepEqual(messages.map(message => message.id), ['first', 'second']);
  assert.equal(messages[0].content, messages[1].content);
  assert.deepEqual(messages[0].details, messages[1].details);
  assert.deepEqual(ui.view.snapshot.live.messages, []);
  assert.equal((screen(ui).match(/BACKGROUND_NOTICE/g) ?? []).length, 2);
});

test('incomplete snapshots keep identical cached notices and the whole uncheckpointed tail', async t => {
  const notice = backgroundNotice(100), tail = backgroundNotice(200);
  const entries = [savedCustomEntry(notice, 'first', null), savedCustomEntry(notice, 'second', 'first')];
  const initial = snapshot({ historyComplete: true, entries, leafId: 'second' });
  const { ui, terminal, connection } = launch(t, initial);
  terminal.rows = 60; terminal.resize(); // Keep all four generic panels visible for the render assertion.
  connection.emit(event(1, { type: 'message_start', message: tail }));
  connection.emit(event(2, { type: 'message_end', message: tail }));
  const incomplete = snapshot({ historyComplete: false, seq: 3, entries, leafId: 'second' });
  incomplete.live.messages = [tail];
  connection.handler = method => method === 'snapshot' ? incomplete : {};
  connection.emit(event(3, { type: 'remote_refresh' })); await flush();
  assert.deepEqual(transcriptMessages(ui.view.snapshot).map(message => message.id), ['first', 'second', undefined]);
  assert.equal((screen(ui).match(/BACKGROUND_NOTICE/g) ?? []).length, 3);
  assert.deepEqual(ui.view.snapshot.live.messages, [tail]);
  // No lifecycle bookkeeping travels with completed messages in an incomplete snapshot.
  // A later identical start/end pair must still create a separate occurrence.
  connection.emit(event(4, { type: 'message_start', message: tail }));
  connection.emit(event(5, { type: 'message_end', message: tail }));
  assert.equal(transcriptMessages(ui.view.snapshot).length, 4);
  assert.equal((screen(ui).match(/BACKGROUND_NOTICE/g) ?? []).length, 4);
  assert.deepEqual(ui.view.snapshot.live.messages, [tail, tail]);
});

test('authoritative refresh leaves the saved final answer and worked-for entry at the end', async t => {
  const notice = backgroundNotice(100);
  const answer = { ...message('assistant', 200), stopReason: 'stop', content: [{ type: 'text', text: 'FINAL_ANSWER' }] };
  const initial = snapshot({ entries: [
    savedCustomEntry(notice, 'notice', null),
    { type: 'message', id: 'answer', parentId: 'notice', message: answer },
    { type: 'custom', id: 'timing', parentId: 'answer', customType: 'worked-for', data: { elapsedSeconds: 2 } },
  ], leafId: 'timing' });
  // Before a successful refresh, the client's event buffer can still contain completed messages.
  initial.live.messages = [notice, answer];
  const { ui, connection } = launch(t, initial);
  const authoritative = structuredClone(initial); authoritative.historyComplete = true;
  authoritative.seq = 1; authoritative.live.messages = [];
  connection.handler = method => method === 'snapshot' ? authoritative : {};
  connection.emit(event(1, { type: 'remote_refresh' })); await flush();
  const messages = transcriptMessages(ui.view.snapshot);
  assert.deepEqual(messages.map(message => message.role), ['custom', 'assistant', 'entry']);
  assert.deepEqual(messages.at(-2), answer);
  assert.equal(messages.at(-1)?.id, 'timing');
  assert.equal(messages.at(-1)?.customType, 'worked-for');
  assert.deepEqual(messages.at(-1)?.data, { elapsedSeconds: 2 });
  assert.deepEqual(ui.view.snapshot.live.messages, []);
  const output = screen(ui);
  assert.equal((output.match(/BACKGROUND_NOTICE/g) ?? []).length, 1);
  assert.equal((output.match(/FINAL_ANSWER/g) ?? []).length, 1);
  assert.ok(output.indexOf('BACKGROUND_NOTICE') < output.indexOf('FINAL_ANSWER'), output);
});

test('snapshot refresh replaces prior messages and replays only events after the cut exactly once', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const stale = backgroundNotice(100); initial.live.messages = [stale];
  const { ui, connection } = launch(t, initial);
  const pending = deferred<Snapshot>(); connection.handler = method => method === 'snapshot' ? pending.promise : {};
  connection.emit(event(1, { type: 'remote_refresh' }));
  const notice = backgroundNotice(200);
  connection.emit(event(2, { type: 'message_end', message: notice }));
  const partial = { ...message('assistant', 300), content: [{ type: 'text', text: 'prefix' }] };
  connection.emit(event(3, { type: 'message_start', message: partial }));
  const cut = snapshot({ historyComplete: true, seq: 3, entries: [savedCustomEntry(notice, 'saved-notice', null)], leafId: 'saved-notice' });
  cut.live.busy = true; cut.live.messages = [partial];
  const delta = event(4, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' hello' } });
  connection.emit(delta); connection.emit(delta);
  pending.resolve(cut);
  connection.emit(event(5, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' } }));
  await flush();
  assert.equal(ui.view.snapshot.seq, 5);
  assert.equal(ui.view.snapshot.live.messages.length, 1);
  assert.equal(ui.view.snapshot.live.messages[0].content[0].text, 'prefix hello world');
  assert.deepEqual(transcriptMessages(ui.view.snapshot).map(message => message.role), ['custom', 'assistant']);
  assert.equal((screen(ui).match(/BACKGROUND_NOTICE/g) ?? []).length, 1);
  assert.deepEqual(cut.live.messages, [partial], 'Replay must not mutate the supplied snapshot');
  assert.deepEqual(connection.requests.filter(request => request.method === 'snapshot').map(request => request.method), ['snapshot']);
  connection.emit(event(6, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' after' } }));
  assert.equal(ui.view.snapshot.live.messages[0].content[0].text, 'prefix hello world after');
});

test('failed snapshot refresh keeps completed live messages until a later success repairs the display', async t => {
  const notice = backgroundNotice(100);
  const answer = { ...message('assistant', 200), stopReason: 'stop', content: [{ type: 'text', text: 'FINAL_ANSWER' }] };
  const { ui, connection } = launch(t);
  connection.emit(event(1, { type: 'message_end', message: notice }));
  connection.emit(event(2, { type: 'message_end', message: answer }));
  const pending = deferred<Snapshot>(); connection.handler = method => method === 'snapshot' ? pending.promise : {};
  connection.emit(event(3, { type: 'remote_refresh' }));
  const later = backgroundNotice(300);
  connection.emit(event(4, { type: 'message_end', message: later }));
  pending.reject(new Error('snapshot unavailable')); await flush();
  assert.deepEqual(ui.view.snapshot.live.messages, [notice, answer, later]);
  const failedOutput = screen(ui);
  assert.equal((failedOutput.match(/BACKGROUND_NOTICE/g) ?? []).length, 2);
  assert.equal((failedOutput.match(/FINAL_ANSWER/g) ?? []).length, 1);
  assert.match(failedOutput, /Snapshot refresh failed: snapshot unavailable/);
  const repaired = snapshot({ historyComplete: true, seq: 5, entries: [
    savedCustomEntry(notice, 'first', null), savedCustomEntry(later, 'second', 'first'),
    { type: 'message', id: 'answer', parentId: 'second', message: answer },
  ], leafId: 'answer' });
  connection.handler = method => method === 'snapshot' ? repaired : {};
  connection.emit(event(5, { type: 'remote_refresh' })); await flush();
  assert.deepEqual(ui.view.snapshot.live.messages, []);
  assert.deepEqual(transcriptMessages(ui.view.snapshot).map(message => message.role), ['custom', 'custom', 'assistant']);
  const output = screen(ui);
  assert.equal((output.match(/BACKGROUND_NOTICE/g) ?? []).length, 2);
  assert.equal((output.match(/FINAL_ANSWER/g) ?? []).length, 1);
  assert.ok(output.lastIndexOf('BACKGROUND_NOTICE') < output.indexOf('FINAL_ANSWER'), output);
  assert.equal(connection.requests.filter(request => request.method === 'snapshot').length, 2);
});

test('reconnect replaces the live buffer with saved history and ignores an obsolete refresh', async t => {
  const notice = backgroundNotice(100);
  const initial = snapshot(); initial.live.messages = [notice];
  const connection = new ReconnectingFakeConnection();
  const { ui } = launch(t, initial, connection);
  const pending = deferred<Snapshot>(); connection.handler = method => method === 'snapshot' ? pending.promise : {};
  connection.emit(event(1, { type: 'remote_refresh' }));
  connection.disconnect();
  const restored = snapshot({ historyComplete: true, seq: 10, entries: [savedCustomEntry(notice, 'saved-notice', null)], leafId: 'saved-notice' });
  const partial = { ...message('assistant', 200), content: [{ type: 'text', text: 'RECONNECTED_STREAM' }] };
  restored.live.busy = true; restored.live.messages = [partial];
  connection.reconnected?.(restored);
  connection.emit(event(10, { type: 'message_end', message: notice }));
  const delta = event(11, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' suffix' } });
  connection.emit(delta); connection.emit(delta);
  pending.resolve(snapshot({ seq: 1 })); await flush();
  assert.equal(ui.view.snapshot.seq, 11);
  assert.equal(ui.view.snapshot.live.messages.length, 1);
  assert.equal(ui.view.snapshot.live.messages[0].content[0].text, 'RECONNECTED_STREAM suffix');
  assert.equal(transcriptMessages(ui.view.snapshot)[0].id, 'saved-notice');
  const output = screen(ui);
  assert.equal((output.match(/BACKGROUND_NOTICE/g) ?? []).length, 1);
  assert.equal((output.match(/RECONNECTED_STREAM suffix/g) ?? []).length, 1);
  assert.doesNotMatch(output, /Connection lost/);
  assert.ok(connection.requests.every(request => request.method === 'snapshot'
    || request.method === 'filesystem_metadata'
    || ['get_available_models', 'get_session_stats'].includes(request.params?.command?.type)), JSON.stringify(connection.requests));
});

test('session transition /new handles remote confirmation while the command is still pending', async t => {
  const { ui, terminal, connection, submit } = launch(t);
  const transition = deferred<RecordValue>();
  connection.handler = (method, params) => method === 'rpc' && params?.command.type === 'new_session' ? transition.promise : method === 'snapshot' ? snapshot({ seq: 2 }) : {};
  submit('/new'); await flush();
  connection.emit(event(1, { type: 'extension_ui_request', id: 'd', method: 'confirm', title: 'New?' }));
  terminal.input('\r'); await flush();
  assert.equal(connection.requests[1].method, 'answer');
  assert.equal(connection.requests[1].params?.response.confirmed, true);
  transition.resolve({ cancelled: false }); await flush();
  assert.equal(connection.requests[2].method, 'snapshot'); assert.equal(ui.view.snapshot.seq, 2);
});

test('fork loads the returned original text into the editor without prompting', async t => {
  const { ui, terminal, connection, submit } = launch(t);
  serveFork(connection);
  submit('/fork'); await flush(); terminal.input('\r'); await flush();
  assert.equal(ui.editor.getExpandedText(), 'original\ntext');
  assert.deepEqual(connection.requests.filter(request => request.method === 'rpc').map(request => request.params?.command), [{ type: 'get_tree' }, { type: 'fork', entryId: 'u' }]);
});

test('double Esc follows local settings without changing draft or history on cancel', async t => {
  for (const doubleEscapeAction of [undefined, 'tree', 'fork', 'none'] as const) {
    const { ui, terminal, connection } = launch(t, snapshot(), new FakeConnection(), { doubleEscapeAction });
    serveFork(connection); ui.editor.setText(' \n');
    terminal.input('\x1b'); assert.equal(connection.requests.length, 0);
    terminal.input('\x1b'); await flush();
    assert.deepEqual(connection.requests.map(request => request.params?.command), doubleEscapeAction === 'none' ? [] : [{ type: 'get_tree' }]);
    if (doubleEscapeAction !== 'none') {
      ui.tui.renderNow();
      assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join('\n'), /Session Fork/);
      terminal.input('\x1b'); await flush(); terminal.input('\x1b');
      assert.equal(connection.requests.length, 1); // Cancellation is not the first Esc of another shortcut.
    }
    assert.equal(ui.editor.getExpandedText(), ' \n');
    terminal.input('\x03'); terminal.input('\x1b[A');
    assert.equal(ui.editor.getExpandedText(), '');
    ui.detach();
  }
});

test('double Esc requires an empty editor, less than 500 ms, and no intervening input', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const { ui, terminal, connection } = launch(t); serveFork(connection);
  terminal.input('\x1b'); now += 500; terminal.input('\x1b'); await flush();
  assert.equal(connection.requests.length, 0);
  terminal.input('x'); ui.editor.setText(''); terminal.input('\x1b');
  assert.equal(connection.requests.length, 0);
  ui.editor.setText('draft'); terminal.input('\x1b'); terminal.input('\x1b');
  assert.equal(connection.requests.length, 0); assert.equal(ui.editor.getExpandedText(), 'draft');
});

test('Esc during an abort or pending command cannot open the fork picker', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const { ui, terminal, connection } = launch(t, initial);
  const pending = deferred<RecordValue>();
  connection.handler = (_method, params) => params?.command.type === 'abort' ? pending.promise : {};
  terminal.input('\x1b'); await flush(); ui.view.snapshot.live.busy = false;
  terminal.input('\x1b'); terminal.input('\x1b'); await flush();
  assert.deepEqual(connection.requests.map(request => request.params?.command.type), ['clear_queue', 'abort']);
  pending.resolve({}); await flush();
});

test('picker keys own local shortcuts and repaint search and Esc without forced renders', async t => {
  const { ui, terminal, connection, submit } = launch(t); serveFork(connection);
  submit('/fork'); await flush(); ui.tui.renderNow();
  const frame = async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return ui.tui.getScreenLines().map(stripTerminalSequences).join('\n');
  };
  terminal.input('\x0c'); assert.match(await frame(), /\[labeled\]/); // Not the model picker.
  terminal.input('\x0f'); assert.match(await frame(), /\[all\]/); // Not transcript expansion.
  terminal.input('\x14'); assert.match(await frame(), /\[no-tools\]/); // Not hidden thinking.
  terminal.input('assistant'); assert.match(await frame(), /Type to search: assistant/);
  terminal.input('\r'); assert.equal(connection.requests.length, 1);
  terminal.input('\x1b'); const cleared = await frame();
  assert.match(cleared, /Session Fork/); assert.doesNotMatch(cleared, /Type to search: assistant/);
  terminal.input('\x1b'); assert.doesNotMatch(await frame(), /Session Fork/);
  assert.equal(connection.requests.length, 1);
});

test('fork picker remains visible on a small screen with widgets above and below', async t => {
  const initial = snapshot({ ui: [
    { id: 'above', method: 'setWidget', widgetKey: 'above', widgetLines: ['above 1', 'above 2', 'above 3'] },
    { id: 'below', method: 'setWidget', widgetKey: 'below', widgetPlacement: 'belowEditor', widgetLines: ['below 1', 'below 2', 'below 3'] },
  ] });
  const { ui, terminal, connection, submit } = launch(t, initial);
  terminal.rows = 12; terminal.resize(); serveFork(connection);
  submit('/fork'); await flush(); ui.tui.renderNow();
  const screen = ui.tui.getScreenLines().map(stripTerminalSequences);
  assert.ok(screen.some(row => row.startsWith('› ') && row.includes('user: original prompt')), screen.join('\n'));
  assert.match(screen.join('\n'), /below 3/);
});

test('tree commands and double Esc show loading immediately, then replace it with the picker', async t => {
  for (const command of ['/tree', '/fork', 'shortcut']) {
    const { ui, terminal, connection, submit } = launch(t);
    const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
    if (command === 'shortcut') { terminal.input('\x1b'); terminal.input('\x1b'); }
    else submit(command);
    assert.match(stripTerminalSequences(ui.tui.getScreenLines().join('\n')), /Loading session tree/);
    assert.match(screen(ui), /Esc cancel/);
    pending.resolve(forkTree()); await flush();
    assert.match(screen(ui), /user: original prompt/);
    assert.doesNotMatch(screen(ui), /Loading session tree/);
    terminal.input('\x1b'); await flush(); ui.detach();
  }
});

test('Esc cancels tree loading and ignores late results or errors without blocking new commands', async t => {
  for (const late of ['result', 'error'] as const) {
    const { ui, terminal, connection, submit } = launch(t);
    const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
    submit('/tree'); terminal.input('\x1b'); await flush();
    assert.doesNotMatch(screen(ui), /Loading session tree|Session Fork/);
    assert.equal(ui.editor.getExpandedText(), '');
    connection.handler = () => forkTree(); submit('/fork'); await flush();
    assert.match(screen(ui), /Session Fork/);
    if (late === 'result') pending.resolve(forkTree()); else pending.reject(new Error('late tree failure'));
    await flush();
    assert.match(screen(ui), /Session Fork/); assert.doesNotMatch(screen(ui), /late tree failure|Request failed/);
    terminal.input('\x1b'); await flush();
    assert.deepEqual(connection.requests.map(request => request.params?.command), [{ type: 'get_tree' }, { type: 'get_tree' }]);
    ui.detach();
  }
});

test('tree loading stops its animation on success, cancel, error, disconnect and detach', async t => {
  const stop = t.mock.method(Loader.prototype, 'stop');
  for (const outcome of ['success', 'cancel', 'error', 'disconnect', 'detach'] as const) {
    const { ui, terminal, connection, submit } = launch(t);
    const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
    submit('/tree');
    const before = stop.mock.callCount(); // Loader construction restarts its animation.
    if (outcome === 'success') pending.resolve(forkTree());
    else if (outcome === 'cancel') terminal.input('\x1b');
    else if (outcome === 'error') pending.reject(new Error('unavailable'));
    else if (outcome === 'disconnect') connection.disconnect();
    else ui.detach();
    await flush(); assert.equal(stop.mock.callCount(), before + 1, outcome);
    if (outcome !== 'detach') assert.doesNotMatch(screen(ui), /Loading session tree/);
    pending.resolve(forkTree()); await flush(); ui.detach();
    assert.equal(stop.mock.callCount(), before + 1, `${outcome}: late result or detach must not restart/stop another loader`);
  }
});

test('failed tree reads remove the loader and allow retry', async t => {
  const { ui, connection, submit, terminal } = launch(t);
  const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
  submit('/tree'); pending.reject(new Error('tree unavailable')); await flush();
  assert.match(screen(ui), /tree unavailable/); assert.doesNotMatch(screen(ui), /Loading session tree/);
  assert.equal(ui.editor.getExpandedText(), '/tree');
  serveFork(connection); submit('/tree'); await flush();
  assert.match(screen(ui), /Session Fork/);
  terminal.input('\x1b'); await flush();
});

test('/tree uses the fork fallback and Ctrl+D still detaches', async t => {
  const { ui, terminal, connection, submit, finished } = launch(t); serveFork(connection);
  submit('/tree'); await flush(); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join('\n'), /new session/);
  terminal.input('\x04'); await finished;
  assert.deepEqual(connection.requests.map(request => request.params?.command), [{ type: 'get_tree' }]);
});

test('disconnect, detach, or session change rejects stale trees and selections', async t => {
  for (const loading of [true, false]) for (const change of ['disconnect', 'detach', 'session'] as const) {
    const { ui, terminal, connection, submit } = launch(t, snapshot({ state: { sessionId: 'old' } }));
    const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
    submit('/fork'); await flush();
    if (!loading) { pending.resolve(forkTree()); await flush(); }
    if (change === 'disconnect') connection.disconnect();
    else if (change === 'detach') ui.detach();
    else connection.emit(event(1, { type: 'remote_state', state: { sessionId: 'new' } }));
    if (loading) pending.resolve(forkTree());
    await flush(); terminal.input('\r'); await flush();
    assert.deepEqual(connection.requests.map(request => request.params?.command), [{ type: 'get_tree' }]);
    ui.detach();
  }
});

test('an empty tree reports no fork points', async t => {
  const { ui, connection, submit } = launch(t);
  connection.handler = () => ({ tree: [], leafId: null });
  submit('/fork'); await flush(); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join('\n'), /No user prompts available/);
  assert.equal(connection.requests.length, 1);
});

test('in-flight prompt failure after disconnect is not restarted or replayed', async t => {
  const { ui, terminal, connection, finished, submit } = launch(t);
  const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
  submit('possibly accepted'); await flush();
  connection.disconnect(); pending.reject(new Error('outcome unknown')); await flush();
  assert.equal(connection.requests.length, 1); assert.equal(ui.editor.getExpandedText(), 'possibly accepted');
  terminal.input('\x04'); await finished; assert.equal(connection.requests.length, 1);
});

test('rendering handles Unicode, streamed Markdown, compact tool output, and very narrow terminals', async t => {
  const initial = snapshot(); initial.live.messages = [
    { ...message('user'), content: '世界 👩‍💻 café' },
    { ...message('assistant', 2), content: [{ type: 'text', text: '# Heading\n\n```ts\nconst value = "世界";\n```\n\n| key | value |\n| --- | --- |\n| 世界 | longlonglong |' }] },
    { role: 'toolResult', timestamp: 3, toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: Array.from({ length: 20 }, (_, i) => `output ${i}`).join('\n') }] },
  ];
  const { ui, terminal } = launch(t, initial);
  for (const width of [80, 20, 6, 1]) {
    terminal.columns = width; ui.tui.invalidate();
    const lines = ui.tui.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at width ${width}`);
  }
  terminal.columns = 80; ui.tui.invalidate(); ui.tui.renderNow();
  const before = ui.tui.render(80).join('\n'); assert.doesNotMatch(before, /output 19/); // Pi collapses successful read output entirely.
  terminal.input('\x0f'); ui.tui.renderNow(); assert.match(ui.tui.render(80).join('\n'), /output 19/);
});

test('stock tool previews show the same application shortcut the client handles', t => {
  const initial = snapshot(); initial.live.messages = [
    { ...message('assistant', 1), content: [{ type: 'toolCall', id: 'bash', name: 'bash', arguments: { command: 'fixture' } }] },
    { role: 'toolResult', timestamp: 2, toolCallId: 'bash', toolName: 'bash', content: [{ type: 'text', text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') }], isError: false },
  ];
  const { ui, terminal } = launch(t, initial);
  assert.match(stripTerminalSequences(ui.tui.render(80).join('\n')), /ctrl\+o to expand/);
  terminal.input('\x0f');
  assert.match(stripTerminalSequences(ui.tui.render(80).join('\n')), /line 0/);
});

test('custom entry with an unpersisted parent does not hide existing raw history', () => {
  const initial = snapshot({ entries: [{ type: 'message', id: 'old', parentId: null, message: { role: 'user', timestamp: 1, content: 'history' } }], leafId: 'old' });
  const view = new RemoteView(initial);
  view.apply(event(1, { type: 'entry_appended', entry: { type: 'custom', id: 'custom', parentId: 'not-in-snapshot', customType: 'extension' } }));
  assert.equal(view.snapshot.leafId, 'old');
  assert.equal(transcriptMessages(view.snapshot)[0].content, 'history');
  assert.equal(view.snapshot.entries.length, 2);
});

test('model picker renders in the local frame, filters text, and sets only the selected model', async t => {
  const { ui, terminal, connection, submit } = launch(t);
  connection.handler = (method, params) => method === 'snapshot' ? snapshot({ state: { model: { id: 'model-b' } } }) : params?.command.type === 'get_available_models' ? {
    models: [{ provider: 'provider', id: 'model-a', name: 'Alpha' }, { provider: 'provider', id: 'model-b', name: 'Beta' }],
  } : {};
  submit('/model'); await flush(); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /Choose model/);
  terminal.input('b'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(ui.tui.getScreenLines().join('\n'), /provider\/model-b/);
  assert.doesNotMatch(ui.tui.getScreenLines().join('\n'), /provider\/model-a/);
  terminal.input('\r'); await flush();
  assert.deepEqual(connection.requests.filter(request => request.method === 'rpc').map(request => request.params?.command), [
    { type: 'get_available_models' }, { type: 'set_model', provider: 'provider', modelId: 'model-b' },
  ]);
});

test('typed text is editable locally and streaming deltas redraw without snapshot requests', async t => {
  const initial = snapshot(); initial.live.busy = true; initial.live.messages = [message()];
  const { ui, terminal, connection } = launch(t, initial);
  for (const char of 'draft') terminal.input(char);
  assert.equal(ui.editor.getExpandedText(), 'draft');
  terminal.input('\x7f'); assert.equal(ui.editor.getExpandedText(), 'draf');
  connection.emit(event(1, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '**streaming** hello 世界' } }));
  ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /streaming/);
  assert.match(ui.tui.getScreenLines().join('\n'), /hello 世界/);
  assert.equal(ui.editor.getExpandedText(), 'draf');
  assert.equal(connection.requests.length, 0);
});

test('persisted custom messages deduplicate their live counterpart across timestamp formats', () => {
  const timestamp = Date.parse('2026-04-01T00:00:00.000Z');
  const initial = snapshot({ entries: [{ type: 'custom_message', id: 'custom', parentId: null, timestamp: '2026-04-01T00:00:00.000Z', customType: 'extension', content: 'persisted', display: true }], leafId: 'custom' });
  initial.live.messages = [{ role: 'custom', timestamp, customType: 'extension', content: 'live', display: true }];
  const messages = transcriptMessages(initial);
  assert.equal(messages.length, 1); assert.equal(messages[0].content, 'live');
});

test('Alt+Enter preserves a waiting draft only once while another command is pending', async t => {
  const { ui, terminal, connection, submit } = launch(t);
  const pending = deferred<RecordValue>(); connection.handler = () => pending.promise;
  submit('first'); await flush();
  ui.editor.setText('next'); terminal.input('\x1b[13;3u'); await flush();
  assert.equal(ui.editor.getExpandedText(), 'next'); assert.equal(connection.requests.length, 1);
  pending.resolve({ disposition: 'started' }); await flush();
});

test('starting slot shows Starting until the first remote_refresh restores initialized state', async t => {
  const initial = snapshot(); initial.slot.status = 'starting';
  const { ui, connection } = launch(t, initial);
  ui.tui.renderNow(); assert.match(ui.tui.getScreenLines().join('\n'), /Starting/);
  const ready = snapshot({ seq: 1, state: { model: { id: 'initialized-model' } } });
  connection.handler = () => ready;
  connection.emit(event(1, { type: 'remote_refresh' })); await flush(); ui.tui.renderNow();
  assert.equal(ui.view.snapshot.slot.status, 'running');
  assert.match(ui.tui.getScreenLines().join('\n'), /Ready/);
  assert.match(ui.tui.getScreenLines().join('\n'), /initialized-model/);
  assert.deepEqual(connection.requests.map(request => request.method), ['snapshot']);
});

test('remote warnings are displayed without retrying requests or stopping the remote process', async t => {
  const initial = snapshot(); initial.slot.status = 'starting';
  const { ui, connection } = launch(t, initial);
  connection.emit(event(1, { type: 'remote_warning', error: 'Pi is still starting; process preserved.' }));
  ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /Remote warning: Pi is still starting; process preserved\./);
  assert.equal(ui.view.snapshot.slot.status, 'starting');
  assert.equal(connection.requests.length, 0); assert.equal(connection.closed, false);
});

function localForkSnapshot(): Snapshot {
  const tree = forkTree();
  return snapshot({ state: { sessionId: 'session' }, historyComplete: true,
    entries: [tree.tree[0]!.entry, tree.tree[0]!.children[0]!.entry], leafId: tree.leafId });
}

test('fork/tree/shortcut use verified local history without any remote read', async t => {
  for (const command of ['/fork', '/tree', 'shortcut']) {
    const { ui, terminal, connection, submit } = launch(t, localForkSnapshot());
    connection.handler = () => { throw new Error('Unexpected remote read'); };
    if (command === 'shortcut') { terminal.input('\x1b'); terminal.input('\x1b'); }
    else submit(command);
    await flush();
    assert.match(screen(ui), /user: original prompt/);
    assert.match(screen(ui), /assistant: assistant context/);
    assert.equal(connection.requests.length, 0);
    terminal.input('\x1b'); await flush(); ui.detach();
  }
});

test('selecting a local fork point sends its original id and fully replaces the new session history', async t => {
  const { ui, terminal, connection, submit } = launch(t, localForkSnapshot());
  connection.handler = (method, params) => {
    if (method === 'rpc' && params?.command.type === 'fork') return { text: 'original prompt' };
    if (method === 'snapshot') return snapshot({ state: { sessionId: 'forked' }, historyComplete: true });
    throw new Error('Unexpected request');
  };
  submit('/fork'); await flush(); terminal.input('\r'); await flush();
  assert.deepEqual(connection.requests.map(r => r.method), ['rpc', 'snapshot']);
  assert.deepEqual(connection.requests[0]!.params?.command, { type: 'fork', entryId: 'u' });
  assert.equal(ui.editor.getExpandedText(), 'original prompt');
  assert.deepEqual(ui.view.snapshot.entries, []);
  assert.equal(ui.view.snapshot.state.sessionId, 'forked');
});

test('a gap before a refresh omits the history cursor and restores the complete checkpoint', async t => {
  const initial = localForkSnapshot();
  const { ui, connection } = launch(t, initial);
  connection.handler = () => ({ ...initial, seq: 2 });
  connection.emit(event(2, { type: 'agent_settled' })); await flush();
  assert.deepEqual(connection.requests[0], { method: 'snapshot', params: { slotId: 'slot' } });
  assert.equal(ui.view.hasCompleteHistory(), true);
});

test('fork refreshes incomplete history, then builds locally without requesting a tree', async t => {
  const initial = localForkSnapshot(); initial.historyComplete = false;
  const { ui, terminal, connection, submit } = launch(t, initial);
  connection.handler = method => {
    assert.equal(method, 'snapshot'); return localForkSnapshot();
  };
  submit('/fork'); await flush();
  assert.match(screen(ui), /user: original prompt/);
  assert.deepEqual(connection.requests, [{ method: 'snapshot', params: { slotId: 'slot' } }]);
  terminal.input('\x1b'); await flush();
});

test('turn refresh requests only entries after the verified checkpoint, and accepts old full replies', async t => {
  for (const incremental of [true, false]) {
    const initial = localForkSnapshot();
    const { ui, connection } = launch(t, initial);
    const newer = { ...initial.entries[0], id: 'u2', parentId: 'a', message: { role: 'user', content: 'new prompt' } };
    connection.handler = () => snapshot({ state: initial.state, seq: 1, historyComplete: true, leafId: 'u2',
      entries: incremental ? [newer] : [...initial.entries, newer],
      ...(incremental ? { historyDelta: { sessionId: 'session', entryId: 'a' } } : {}) });
    connection.emit(event(1, { type: 'agent_settled' })); await flush();
    assert.deepEqual(connection.requests[0], { method: 'snapshot', params: { slotId: 'slot',
      historyCursor: { sessionId: 'session', entryId: 'a' } } });
    assert.deepEqual(ui.view.snapshot.entries.map(e => e.id), ['u', 'a', 'u2']);
    assert.equal(ui.view.historyCursor()!.entryId, 'u2'); ui.detach();
  }
});

test('fork waits for the running incremental refresh instead of requesting the whole tree again', async t => {
  const initial = localForkSnapshot();
  const { ui, terminal, connection, submit } = launch(t, initial);
  const pending = deferred<Snapshot>(); connection.handler = () => pending.promise;
  connection.emit(event(1, { type: 'agent_settled' }));
  submit('/fork');
  assert.match(screen(ui), /Loading session tree/);
  pending.resolve(snapshot({ state: initial.state, seq: 1, historyComplete: true, leafId: 'u2',
    entries: [{ ...initial.entries[0], id: 'u2', parentId: 'a', message: { role: 'user', content: 'latest prompt' } }],
    historyDelta: { sessionId: 'session', entryId: 'a' } }));
  await flush();
  assert.match(screen(ui), /user: latest prompt/);
  assert.equal(connection.requests.length, 1);
  terminal.input('\x1b'); await flush();
});

test('fork fetches saved IDs for messages that finish after an already-running refresh cut', async t => {
  const initial = localForkSnapshot();
  const { ui, terminal, connection, submit } = launch(t, initial);
  const pending = deferred<Snapshot>();
  const newer = { ...initial.entries[0], id: 'u2', parentId: 'a', message: { role: 'user', content: 'post-cut prompt' } };
  const notice = { type: 'custom', id: 'notice', parentId: 'u2', timestamp: '2026-01-01', customType: 'background' };
  connection.handler = (method, params) => {
    if (method === 'rpc') return { cancelled: true };
    if (connection.requests.length === 1) return pending.promise;
    return snapshot({ state: initial.state, seq: 3, historyComplete: true, leafId: 'notice',
      entries: [newer, notice], historyDelta: params?.historyCursor });
  };
  connection.emit(event(1, { type: 'remote_refresh' }));
  connection.emit(event(2, { type: 'message_end', message: newer.message }));
  connection.emit(event(3, { type: 'entry_appended', entry: notice }));
  submit('/fork');
  pending.resolve(snapshot({ state: initial.state, seq: 1, historyComplete: true, leafId: 'a',
    entries: [], historyDelta: { sessionId: 'session', entryId: 'a' } }));
  await flush();
  assert.match(screen(ui), /user: post-cut prompt/);
  assert.equal(connection.requests.length, 2);
  assert.ok(connection.requests.every(r => r.method === 'snapshot' && r.params?.historyCursor));
  assert.deepEqual(ui.view.snapshot.entries.map(e => e.id), ['u', 'a', 'u2', 'notice']);
  terminal.input('\r'); await flush();
  assert.deepEqual(connection.requests.at(-1)!.params?.command, { type: 'fork', entryId: 'u2' });
});

test('a disconnected client cannot open a cached fork picker', async t => {
  const { ui, connection, submit } = launch(t, localForkSnapshot());
  connection.disconnect(); submit('/fork'); await flush();
  assert.doesNotMatch(screen(ui), /Session Fork|Loading session tree/);
  assert.match(screen(ui), /Reconnect before/);
  assert.equal(ui.editor.getExpandedText(), '/fork');
  assert.equal(connection.requests.length, 0);
});

test('an event gap during a delta read triggers a full recovery without losing later live events', async t => {
  const initial = localForkSnapshot();
  const { ui, connection } = launch(t, initial);
  const delta = deferred<Snapshot>(), full = deferred<Snapshot>();
  connection.handler = (_method, params) => connection.requests.length === 1 ? delta.promise
    : connection.requests.length === 2 ? full.promise
    : { ...initial, seq: 3, entries: [], historyDelta: params?.historyCursor,
      live: { ...initial.live, busy: true } };
  connection.emit(event(1, { type: 'agent_settled' }));
  connection.emit(event(3, { type: 'agent_start' })); // seq 2 was lost
  delta.resolve(snapshot({ state: initial.state, seq: 1, historyComplete: true, entries: [], leafId: 'a',
    historyDelta: { sessionId: 'session', entryId: 'a' } }));
  await flush();
  assert.deepEqual(connection.requests[1], { method: 'snapshot', params: { slotId: 'slot' } });
  full.resolve({ ...initial, seq: 1 }); await flush();
  assert.equal(ui.view.snapshot.live.busy, true);
  assert.equal(ui.view.snapshot.seq, 3);
});

test('fork cancellation while waiting for history ignores late refresh results', async t => {
  const initial = localForkSnapshot();
  const { ui, terminal, connection, submit } = launch(t, initial);
  const pending = deferred<Snapshot>(); connection.handler = () => pending.promise;
  connection.emit(event(1, { type: 'agent_settled' }));
  submit('/fork'); terminal.input('\x1b'); await flush();
  pending.resolve({ ...initial, seq: 1 }); await flush();
  assert.doesNotMatch(screen(ui), /Session Fork|Loading session tree/);
  assert.equal(connection.requests.filter(r => r.params?.command?.type === 'fork').length, 0);
});

test('scrolling up shows a jump-to-latest pill; Ctrl+End or clicking it follows output again', async t => {
  const initial = snapshot();
  initial.live.messages = Array.from({ length: 40 }, (_, i) =>
    ({ role: 'assistant', timestamp: i + 1, stopReason: 'stop', content: [{ type: 'text', text: `line ${i}` }] }));
  const { ui, terminal } = launch(t, initial);
  assert.doesNotMatch(screen(ui), /Jump to latest message/);
  ui.tui.scrollBy(-5);
  const pill = screen(ui).split('\n').find(line => line.includes('Jump to latest message'));
  assert.ok(pill?.includes('↓ Jump to latest message · Ctrl+End'));
  terminal.input('\x1b[1;5F'); // Ctrl+End
  assert.equal(ui.tui.isFollowingOutput, true);
  assert.doesNotMatch(screen(ui), /Jump to latest message/);
  ui.tui.scrollBy(-5);
  const lines = screen(ui).split('\n');
  const row = lines.findIndex(line => line.includes('Jump to latest message'));
  const column = lines[row]!.indexOf('Jump') + 1;
  terminal.input(`\x1b[<0;${column + 1};${row + 1}M`); terminal.input(`\x1b[<0;${column + 1};${row + 1}m`);
  assert.equal(ui.tui.isFollowingOutput, true);
  assert.doesNotMatch(screen(ui), /Jump to latest message/);
});
