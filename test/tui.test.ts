import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
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
function launch(t: any, initial = snapshot(), connection = new FakeConnection(), options: TuiOptions = {}) {
  const terminal = new FakeTerminal();
  const ui = new RemoteTui(connection, 'slot', initial, terminal, options);
  const finished = ui.run();
  t.after(() => ui.detach());
  const submit = (text: string) => { ui.editor.setText(text); terminal.input('\r'); };
  return { ui, terminal, connection, finished, submit };
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
  class ReconnectingFakeConnection extends FakeConnection {
    reconnected?: (snapshot: Snapshot) => void;
    onReconnect(listener: (snapshot: Snapshot) => void) {
      this.reconnected = listener; return () => { this.reconnected = undefined; };
    }
  }
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
    const markers = ['Steer: queued instruction', 'above-editor widget', ' Working ', 'prompt draft', 'below-editor widget', 'Working · slot'];
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

test('snapshot refresh replays events received after the cut before the await continuation', async t => {
  const initial = snapshot(); initial.live.busy = true; initial.live.messages = [message()];
  const { ui, connection } = launch(t, initial);
  const pending = deferred<Snapshot>(); connection.handler = () => pending.promise;
  connection.emit(event(1, { type: 'remote_refresh' }));
  connection.emit(event(2, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } }));
  const cut = structuredClone(initial); cut.seq = 1;
  pending.resolve(cut);
  connection.emit(event(3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' } }));
  await flush();
  assert.equal(ui.view.snapshot.seq, 3);
  assert.equal(ui.view.snapshot.live.messages[0].content[0].text, 'hello world');
  assert.equal(connection.requests[0].method, 'snapshot');
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
  connection.handler = (method, params) => method === 'snapshot' ? snapshot() : params?.command.type === 'get_fork_messages' ? { messages: [{ entryId: 'a', text: 'original' }] } : params?.command.type === 'fork' ? { text: 'original\ntext', cancelled: false } : {};
  submit('/fork'); await flush(); terminal.input('\r'); await flush();
  assert.equal(ui.editor.getExpandedText(), 'original\ntext');
  assert.deepEqual(connection.requests.filter(request => request.method === 'rpc').map(request => request.params?.command.type), ['get_fork_messages', 'fork']);
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
  terminal.input('b'); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /provider\/model-b/);
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
