import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { ProcessTerminal, StdinBuffer, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../../src/protocol/types.js';
import { formatProgramStatus, PROGRAM_STATUS_QUERY, ProgramStatusTerminal, ProgramActivity, waitingOnBackground } from '../../src/tui/program-status.js';
import { RemoteTui } from '../../src/tui/tui.js';

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const WAITING_MESSAGE = 'Waiting on background task';
function waitMessages(timestamp = 1): RecordValue[] {
  return [
    { role: 'assistant', timestamp, stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: 'Wait for the task.' }, { type: 'toolCall', id: `wait-${timestamp}`, name: 'background_wait', arguments: {} },
    ] },
    { role: 'toolResult', timestamp: timestamp + 1, toolName: 'background_wait', toolCallId: `wait-${timestamp}`, isError: false, content: [] },
    { role: 'assistant', timestamp: timestamp + 2, stopReason: 'stop', content: [{ type: 'text', text: 'Waiting for the task.' }] },
  ];
}
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
  const wait = () => { for (const message of waitMessages(1000 + seq * 10)) send('message_end', { message }); };
  return { terminal, connection, ui, send, wait };
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

test('a completed wait stays working through the background completion and wake-up gap', async t => {
  const { terminal, send, wait } = launch(t);
  send('agent_start'); wait();
  assert.equal(terminal.last?.state, 'working'); assert.notEqual(terminal.last?.message, WAITING_MESSAGE);
  send('agent_end');
  assert.notEqual(terminal.last?.message, WAITING_MESSAGE); assert.equal(terminal.bells, 0);
  send('agent_settled');
  assert.deepEqual(terminal.last, { state: 'working', kind: undefined, message: WAITING_MESSAGE });
  assert.equal(terminal.bells, 0);
  send('message_end', { message: { role: 'custom', timestamp: 2000, content: 'Background task finished.' } });
  send('extension_ui_request', { method: 'setWidget', widgetKey: 'background', widgetText: [] });
  await flush();
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.last?.message, WAITING_MESSAGE); assert.equal(terminal.bells, 0);
  send('agent_settled'); assert.equal(terminal.bells, 0);
});

test('extension statuses are ordinary footer data and never imply waiting', async t => {
  const { terminal, send, ui } = launch(t);
  send('extension_ui_request', { method: 'setStatus', statusKey: 'waiting-on-background', statusText: WAITING_MESSAGE });
  send('extension_ui_request', { method: 'setStatus', statusKey: 'normal', statusText: 'Normal status' });
  assert.match(stripTerminalSequences((ui as any).footer()), /Waiting on background task.*Normal status/);
  send('agent_start'); send('agent_settled');
  assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
  send('extension_ui_request', { method: 'setStatus', statusKey: 'waiting-on-background', statusText: undefined });
  assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
  await flush();
});

test('waiting follows the last successful tool call since the latest user message', async t => {
  const waiting = new Set(['valid wait', 'parallel sibling before wait', 'call did not finish for tools',
    'extra assistant step', 'injected custom', 'trailing custom', 'final error', 'final abort', 'partial run']);
  const cases: [string, (messages: RecordValue[]) => void][] = [
    ['valid wait', () => {}],
    ['parallel sibling before wait', messages => messages[0].content.unshift({ type: 'toolCall', id: 'other', name: 'bash' })],
    ['parallel sibling after wait', messages => messages[0].content.push({ type: 'toolCall', id: 'other', name: 'bash' })],
    ['parallel sibling finishes first', messages => {
      messages[0].content.push({ type: 'toolCall', id: 'other', name: 'bash' });
      messages.splice(1, 0, { role: 'toolResult', timestamp: 4, toolName: 'bash', toolCallId: 'other', isError: false, content: [] });
    }],
    ['parallel wait finishes first', messages => {
      messages[0].content.push({ type: 'toolCall', id: 'other', name: 'bash' });
      messages.splice(2, 0, { role: 'toolResult', timestamp: 4, toolName: 'bash', toolCallId: 'other', isError: false, content: [] });
    }],
    ['failed wait', messages => { messages[1].isError = true; }],
    ['missing success flag', messages => { delete messages[1].isError; }],
    ['mismatched result', messages => { messages[1].toolCallId = 'other'; }],
    ['wrong result tool', messages => { messages[1].toolName = 'bash'; }],
    ['empty call ID', messages => { messages[0].content[1].id = messages[1].toolCallId = ''; }],
    ['call did not finish for tools', messages => { messages[0].stopReason = 'stop'; }],
    ['later tool', messages => messages.push(
      { role: 'assistant', timestamp: 4, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'later', name: 'bash' }] },
      { role: 'toolResult', timestamp: 5, toolName: 'bash', toolCallId: 'later', isError: false, content: [] },
      { role: 'assistant', timestamp: 6, stopReason: 'stop', content: [] })],
    ['final reply has a tool', messages => messages[2].content.push({ type: 'toolCall', id: 'later', name: 'bash' })],
    ['extra assistant step', messages => messages.splice(2, 0, { role: 'assistant', timestamp: 4, stopReason: 'stop', content: [] })],
    ['injected user', messages => messages.splice(2, 0, { role: 'user', timestamp: 4, content: 'Continue' })],
    ['injected custom', messages => messages.splice(1, 0, { role: 'custom', timestamp: 4, content: 'Notice' })],
    ['trailing custom', messages => messages.push({ role: 'custom', timestamp: 4, content: 'Notice' })],
    ['final error', messages => { messages[2].stopReason = 'error'; messages[2].errorMessage = 'Failed'; }],
    ['final abort', messages => { messages[2].stopReason = 'aborted'; }],
    ['partial run', messages => { messages.pop(); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const { terminal, send } = launch(t);
    const messages = waitMessages(); mutate(messages);
    assert.equal(waitingOnBackground(messages), waiting.has(name));
    send('agent_start');
    for (const message of messages) send('message_end', { message });
    send('agent_end', { messages });
    assert.equal(terminal.last?.state, 'working'); assert.notEqual(terminal.last?.message, WAITING_MESSAGE);
    assert.equal(terminal.bells, 0);
    send('agent_settled');
    const state = name === 'final error' ? 'error' : name === 'final abort' ? 'idle' : waiting.has(name) ? 'working' : 'done';
    assert.equal(terminal.last?.state, state);
    assert.equal(terminal.bells, state === 'done' || state === 'error' ? 1 : 0);
    await flush();
  });
});

test('wait decisions survive notices and reply text on events, snapshots, and reconnects', async t => {
  for (const source of ['events', 'snapshot', 'reconnect']) for (const input of ['none', 'steering', 'follow-up', 'wait-again']) {
    await t.test(`${source}/${input}`, async t => {
      const { terminal, connection, send, ui } = launch(t);
      const [call, result, reply] = waitMessages();
      const messages = [call,
        { role: 'custom', timestamp: 4, customType: 'background', content: 'Background check-in' }, result,
        ...Array.from({ length: 5 }, (_, i) => ({ role: 'custom', timestamp: 10 + i, customType: 'background', content: 'Still running' })),
        reply];
      if (input !== 'none') {
        messages.push({ role: 'user', timestamp: 20, content: input });
        if (input === 'wait-again') messages.push(...waitMessages(30));
        else messages.push({ role: 'assistant', timestamp: 21, stopReason: 'stop', content: [{ type: 'text', text: 'Answer' }] });
      }
      send('agent_start');
      if (source === 'events') {
        for (const message of messages) {
          if (message.role === 'user' && input === 'follow-up') send('agent_end');
          send('message_end', { message });
          if (message.role === 'user' && input === 'follow-up') send('agent_start');
        }
        send('agent_end', { messages }); send('agent_settled');
      } else {
        const idle = structuredClone(ui.view.snapshot); idle.seq += 10; idle.live.busy = false;
        idle.live.messages.push(...messages);
        if (source === 'reconnect') connection.reconnected?.(idle);
        else { connection.current = () => idle; send('remote_refresh'); await flush(); }
      }
      const waiting = input === 'none' || input === 'wait-again';
      assert.equal(terminal.last?.state, waiting ? 'working' : 'done');
      assert.equal(terminal.bells, waiting ? 0 : 1);
      await flush(); assert.equal(terminal.bells, waiting ? 0 : 1);
    });
  }
});

test('idle attach does not recover an old wait across a silent wake-up or user input', async t => {
  for (const ending of ['notice', 'silent-wake-up', 'user-reply']) await t.test(ending, async t => {
    const initial = snapshot(); initial.live.messages = waitMessages();
    initial.live.messages.push({ role: 'custom', timestamp: 10, customType: 'background', content: 'Background completed' });
    if (ending === 'user-reply') initial.live.messages.push({ role: 'user', timestamp: 11, content: 'A new question' });
    if (ending !== 'notice') initial.live.messages.push({ role: 'assistant', timestamp: 12, stopReason: 'stop', content: [] });
    const { terminal } = launch(t, initial);
    assert.equal(terminal.last?.state, ending === 'notice' ? 'working' : 'idle');
    assert.equal(terminal.bells, 0);
  });
});

test('saved waits cannot cross failed completions or hide an error or cancellation', async t => {
  for (const stopReason of ['stop', 'length', 'error', 'aborted']) await t.test(stopReason, async t => {
    const initial = snapshot(); initial.live.messages = waitMessages();
    initial.live.messages.at(-1)!.stopReason = stopReason;
    initial.live.messages.push({ role: 'custom', timestamp: 10, content: 'Wake-up' },
      { role: 'assistant', timestamp: 11, stopReason: 'stop', content: [] });
    const { terminal } = launch(t, initial);
    assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 0);
  });
  for (const stopReason of ['error', 'aborted']) for (const mode of ['attach', 'missed wake-up']) {
    await t.test(`${mode}/${stopReason}`, async t => {
      const messages = waitMessages(30); messages.at(-1)!.stopReason = stopReason;
      const initial = snapshot(); initial.live.messages = mode === 'attach' ? messages : waitMessages();
      const { terminal, connection, ui } = launch(t, initial);
      if (mode === 'attach') {
        assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 0);
      } else {
        const idle = structuredClone(ui.view.snapshot); idle.seq += 10; idle.live.messages.push(...messages);
        connection.reconnected?.(idle); connection.reconnected?.(idle);
        assert.equal(terminal.last?.state, stopReason === 'error' ? 'error' : 'idle');
        assert.equal(terminal.bells, stopReason === 'error' ? 1 : 0);
      }
    });
  }
});

test('busy snapshots replace wait metadata missed during a disconnect', async t => {
  for (const missed of ['later tool', 'user', 'new wait', 'incomplete history']) await t.test(missed, async t => {
    const { terminal, connection, send, wait, ui } = launch(t);
    send('agent_start'); wait();
    const busy = structuredClone(ui.view.snapshot); busy.seq += 10;
    if (missed === 'later tool') busy.live.messages.push(
      { role: 'assistant', timestamp: 20, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'later', name: 'read' }] },
      { role: 'toolResult', timestamp: 21, toolName: 'read', toolCallId: 'later', isError: false, content: [] });
    if (missed === 'user') busy.live.messages.push({ role: 'user', timestamp: 20, content: 'New question' });
    if (missed === 'new wait') busy.live.messages.push(...waitMessages(30));
    if (missed === 'incomplete history') busy.historyComplete = false;
    connection.reconnected?.(busy);
    // These direct events follow the new authoritative sequence, not launch's old counter.
    let seq = busy.seq;
    connection.listener?.({ type: 'event', slotId: 'slot', seq: ++seq, event: { type: 'message_end',
      message: { role: 'assistant', timestamp: 50, stopReason: 'stop', content: [] } } });
    connection.listener?.({ type: 'event', slotId: 'slot', seq: ++seq, event: { type: 'agent_settled' } });
    assert.equal(terminal.last?.state, missed === 'new wait' ? 'working' : 'done');
    assert.equal(terminal.bells, missed === 'new wait' ? 0 : 1);
    await flush(); assert.equal(terminal.bells, missed === 'new wait' ? 0 : 1);
  });
});

test('snapshots covering several runs cannot reuse a missed wait for a later no-tool wake-up', async t => {
  for (const mode of ['observed run', 'already waiting', 'busy reconnect']) await t.test(mode, async t => {
    const { terminal, connection, send, wait, ui } = launch(t);
    send('agent_start');
    if (mode === 'already waiting') { wait(); send('agent_settled'); await flush(); }
    const cut = structuredClone(ui.view.snapshot); cut.seq += 20;
    cut.live.messages.push(...waitMessages(5000), { role: 'custom', timestamp: 5010, content: 'Wake-up' });
    cut.live.busy = mode === 'busy reconnect';
    if (mode !== 'busy reconnect') cut.live.messages.push({ role: 'assistant', timestamp: 5020, stopReason: 'stop', content: [] });
    connection.reconnected?.(cut);
    if (mode === 'busy reconnect') {
      connection.listener?.({ type: 'event', slotId: 'slot', seq: cut.seq + 1, event: { type: 'message_end',
        message: { role: 'assistant', timestamp: 5020, stopReason: 'stop', content: [] } } });
      connection.listener?.({ type: 'event', slotId: 'slot', seq: cut.seq + 2, event: { type: 'agent_settled' } });
    }
    assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
    const repeat = structuredClone(ui.view.snapshot); repeat.seq += 10; repeat.live.busy = false;
    connection.reconnected?.(repeat); connection.reconnected?.(repeat);
    assert.equal(terminal.bells, 1); await flush(); assert.equal(terminal.bells, 1);
  });
});

test('unknown or removed starting checkpoints cannot recover an old wait from history', async t => {
  for (const checkpoint of ['unknown', 'compacted']) await t.test(checkpoint, async t => {
    const initial = snapshot(true); initial.historyComplete = checkpoint === 'unknown' ? false : true;
    if (checkpoint === 'compacted') initial.live.messages.push({ role: 'assistant', timestamp: 1, stopReason: 'stop', content: [] });
    const { terminal, connection } = launch(t, initial);
    const idle = snapshot(false, 20); idle.historyComplete = true;
    idle.live.messages = waitMessages(30);
    connection.reconnected?.(idle); connection.reconnected?.(idle);
    assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
  });
});

test('a successful last wait needs no final reply and ignores sibling result order', async t => {
  for (const reverseResults of [false, true]) await t.test(String(reverseResults), async t => {
    const { terminal, send } = launch(t);
    const [call, result] = waitMessages();
    call.content.unshift({ type: 'toolCall', id: 'other', name: 'bash', arguments: {} });
    const other = { role: 'toolResult', timestamp: 10, toolCallId: 'other', toolName: 'bash', isError: false, content: [] };
    send('agent_start');
    for (const message of [call, ...(reverseResults ? [result, other] : [other, result])]) send('message_end', { message });
    send('agent_settled');
    assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
    await flush();
  });
});

test('wake-up runs replace waiting with normal, error, cancellation, or another wait outcomes', async t => {
  for (const ending of ['normal', 'error', 'aborted', 'waiting']) await t.test(ending, async t => {
    const { terminal, send, wait } = launch(t);
    send('agent_start'); wait(); send('agent_settled'); await flush();
    assert.equal(terminal.bells, 0);
    send('agent_start');
    assert.equal(terminal.last?.state, 'working'); assert.notEqual(terminal.last?.message, WAITING_MESSAGE);
    if (ending === 'waiting') wait();
    else send('message_end', { message: { role: 'assistant', timestamp: 3000, content: [], stopReason: ending === 'normal' ? 'stop' : ending, errorMessage: 'Failure' } });
    send('agent_end'); assert.equal(terminal.bells, 0);
    send('agent_settled');
    assert.equal(terminal.last?.state, ending === 'waiting' ? 'working' : ending === 'normal' ? 'done' : ending === 'aborted' ? 'idle' : 'error');
    assert.equal(terminal.bells, ending === 'normal' || ending === 'error' ? 1 : 0);
    await flush();
  });
});

test('all RPC dialogs block and ring immediately mid-run, including while waiting; replay is quiet', async t => {
  const { terminal, send, wait, connection, ui } = launch(t);
  send('agent_start'); wait();
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
  const initial = snapshot(true); initial.ui = [{ id: 'old', method: 'confirm', title: 'Approve' }];
  const { terminal, ui } = launch(t, initial);
  assert.equal(terminal.last?.state, 'blocked'); assert.equal(terminal.bells, 0);
  await (ui as any).answerDialog('old', { confirmed: true });
  assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
});

test('errors override waiting; successful retry recovers; abort signals settle idle without a bell', async t => {
  for (const kind of ['error', 'aborted', 'retry-cancel', 'local-abort', 'retry-success']) await t.test(kind, async t => {
    const { terminal, send, wait, ui } = launch(t);
    send('agent_start'); wait();
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
    const { terminal, send, wait } = launch(t);
    send('agent_start');
    send('message_end', { message: { role: 'assistant', timestamp: 1, stopReason: 'stop', content: [] } });
    if (aborted === true) wait();
    send('agent_settled', { aborted });
    assert.equal(terminal.last?.state, aborted === true ? 'idle' : 'done');
    assert.equal(terminal.bells, aborted === true ? 0 : 1);
    send('agent_settled', { aborted }); await flush();
    assert.equal(terminal.last?.state, aborted === true ? 'idle' : 'done');
    assert.equal(terminal.bells, aborted === true ? 0 : 1, 'repeated settles remain quiet');
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

test('snapshot journal replays wait messages without reclassifying or repeating completion', async t => {
  for (const waiting of [true, false]) await t.test(String(waiting), async t => {
    const { terminal, connection, send, wait, ui } = launch(t);
    send('agent_start');
    const cut = structuredClone(ui.view.snapshot);
    let resolve!: (snapshot: Snapshot) => void;
    connection.current = () => new Promise<Snapshot>(done => { resolve = done; });
    send('remote_refresh');
    if (waiting) wait();
    else send('message_end', { message: { role: 'assistant', timestamp: 3, stopReason: 'stop', content: [] } });
    send('agent_settled');
    assert.equal(terminal.bells, waiting ? 0 : 1);
    connection.current = () => ui.view.snapshot;
    resolve(cut); await flush();
    assert.equal(terminal.last?.state, waiting ? 'working' : 'done');
    assert.equal(terminal.bells, waiting ? 0 : 1);
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
      const idle = snapshot(false, 2); idle.historyComplete = historyComplete;
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

test('idle snapshots recover a missed wake-up run once; unchanged waiting checkpoints stay quiet', async t => {
  for (const outcome of ['unchanged', 'stop', 'error', 'aborted', 'waiting']) await t.test(outcome, async t => {
    const { terminal, connection, send, wait, ui } = launch(t);
    send('agent_start'); wait(); send('agent_settled'); await flush();
    assert.equal(terminal.bells, 0);
    const cut = structuredClone(ui.view.snapshot); cut.seq += 10;
    if (outcome === 'waiting') cut.live.messages.push(...waitMessages(5000));
    else if (outcome !== 'unchanged') cut.live.messages.push({ role: 'assistant', timestamp: 5000, stopReason: outcome, errorMessage: outcome === 'error' ? 'Failure' : undefined, content: [] });
    connection.reconnected?.(cut);
    assert.equal(terminal.last?.state, outcome === 'unchanged' || outcome === 'waiting' ? 'working' : outcome === 'stop' ? 'done' : outcome === 'error' ? 'error' : 'idle');
    assert.equal(terminal.bells, outcome === 'stop' || outcome === 'error' ? 1 : 0);
    connection.reconnected?.(cut); assert.equal(terminal.bells, outcome === 'stop' || outcome === 'error' ? 1 : 0);
  });
});

test('exited slots never retain a working handoff; running-slot warnings are not run failures', async t => {
  const { terminal, connection, send, wait, ui } = launch(t);
  send('agent_start'); wait(); send('agent_settled');
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

test('idle attach and recovery accept valid wait tails in saved or legacy snapshots without replay', async t => {
  for (const historyComplete of [undefined, true]) for (const mode of ['attach', 'refresh', 'reconnect']) {
    await t.test(`${mode}/${historyComplete}`, async t => {
      const idle = snapshot(false, 10); idle.historyComplete = historyComplete;
      const messages = waitMessages();
      if (historyComplete) {
        idle.entries = messages.map((message, i) => ({ type: 'message', id: `m${i}`, parentId: i ? `m${i - 1}` : null, message }));
        idle.leafId = 'm2';
      } else idle.live.messages = messages;
      const { terminal, connection, send } = launch(t, mode === 'attach' ? idle : snapshot(true));
      if (mode === 'refresh') { connection.current = () => idle; send('remote_refresh'); await flush(); }
      else if (mode === 'reconnect') connection.reconnected?.(idle);
      assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.last?.message, WAITING_MESSAGE);
      assert.equal(terminal.bells, 0);
      connection.reconnected?.(idle); connection.reconnected?.(idle);
      assert.equal(terminal.bells, 0);
    });
  }
});

test('old wait tails cannot suppress a current empty, partial, or compaction completion', async t => {
  for (const source of ['events', 'snapshot', 'reconnect']) for (const operation of ['empty', 'partial', 'compaction']) {
    await t.test(`${source}/${operation}`, async t => {
      const initial = snapshot();
      initial.live.messages = operation === 'partial' ? waitMessages().slice(0, 2) : waitMessages();
      const { terminal, connection, send, ui } = launch(t, initial);
      send(operation === 'compaction' ? 'compaction_start' : 'agent_start');
      if (operation === 'partial') send('message_end', { message: { role: 'assistant', timestamp: 20, stopReason: 'stop', content: [] } });
      if (source === 'events') send(operation === 'compaction' ? 'compaction_end' : 'agent_settled');
      else {
        const idle = structuredClone(ui.view.snapshot); idle.seq += 10; idle.live.busy = false; idle.live.compacting = false;
        if (source === 'reconnect') connection.reconnected?.(idle);
        else { connection.current = () => idle; send('remote_refresh'); await flush(); }
      }
      assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
      await flush(); assert.equal(terminal.bells, 1);
    });
  }
});

test('active snapshots and busy changes alone never classify a wait tail or complete an agent run', () => {
  const current = snapshot();
  const activity = new ProgramActivity(current);
  current.live.busy = true;
  activity.event({ type: 'agent_start' }, current);
  for (const message of waitMessages()) {
    current.live.messages.push(message);
    activity.event({ type: 'message_end', message }, current);
  }
  let result = activity.update(current, { snapshot: true });
  assert.equal(result.status.state, 'working'); assert.notEqual(result.status.message, WAITING_MESSAGE);
  current.live.busy = false;
  activity.event({ type: 'agent_end', messages: waitMessages() }, current);
  result = activity.update(current);
  assert.equal(result.status.state, 'working'); assert.notEqual(result.status.message, WAITING_MESSAGE); assert.equal(result.bells, 0);
  activity.event({ type: 'agent_settled' }, current);
  result = activity.update(current);
  assert.equal(result.status.state, 'working'); assert.equal(result.status.message, WAITING_MESSAGE); assert.equal(result.bells, 0);
});

test('agent_end messages and incomplete checkpoints do not supply a completed live wait tail', async t => {
  for (const source of ['agent_end', 'incomplete attach', 'incomplete snapshot']) await t.test(source, async t => {
    const initial = snapshot();
    if (source === 'incomplete attach') { initial.historyComplete = false; initial.live.messages = waitMessages(); }
    const { terminal, connection, send } = launch(t, initial);
    if (source === 'incomplete attach') { assert.equal(terminal.last?.state, 'idle'); return; }
    send('agent_start'); send('agent_end', { messages: waitMessages() });
    if (source === 'incomplete snapshot') {
      const idle = snapshot(false, 10); idle.historyComplete = false; idle.live.messages = waitMessages();
      connection.reconnected?.(idle);
    } else send('agent_settled');
    assert.equal(terminal.last?.state, 'done'); assert.equal(terminal.bells, 1);
    await flush(); assert.equal(terminal.bells, 1);
  });
});

test('current-run error and cancellation override an otherwise valid wait tail', async t => {
  for (const ending of ['retry-error', 'retry-cancelled', 'agent-end-error', 'settled-error', 'aborted', 'local-abort']) await t.test(ending, async t => {
    const { terminal, send, wait, ui } = launch(t);
    send('agent_start'); wait();
    if (ending === 'retry-error' || ending === 'retry-cancelled') send('auto_retry_end', { success: false, finalError: ending === 'retry-error' ? 'Failure' : 'Retry cancelled' });
    if (ending === 'agent-end-error') send('agent_end', { messages: [{ role: 'assistant', timestamp: 5000, stopReason: 'error', errorMessage: 'Failure', content: [] }] });
    if (ending === 'local-abort') await (ui as any).rpc({ type: 'abort' });
    send('agent_settled', { aborted: ending === 'aborted', error: ending === 'settled-error' });
    const error = ['retry-error', 'agent-end-error', 'settled-error'].includes(ending);
    assert.equal(terminal.last?.state, error ? 'error' : 'idle');
    assert.equal(terminal.bells, error ? 1 : 0);
    await flush();
  });
});

test('retries and overflow recovery preserve the effective wait tail within one logical run', async t => {
  for (const recovery of ['retry', 'overflow-error', 'overflow-length']) for (const ending of ['success', 'exhausted', 'cancelled']) {
    await t.test(`${recovery}/${ending}`, async t => {
      const { terminal, send } = launch(t);
      const [call, result, reply] = waitMessages();
      const failed = { role: 'assistant', timestamp: 10, stopReason: recovery === 'overflow-length' ? 'length' : 'error', errorMessage: 'Provider failed', content: [] };
      send('agent_start');
      for (const message of [call, result, failed]) send('message_end', { message });
      send('agent_end', { messages: [call, result, failed], willRetry: true });
      if (recovery === 'retry') send('auto_retry_start', { attempt: 1 });
      else {
        send('compaction_start', { reason: 'overflow' });
        send('compaction_end', { reason: 'overflow', willRetry: true });
      }
      assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.bells, 0);
      if (ending === 'cancelled') send('auto_retry_end', { success: false, finalError: 'Retry cancelled' });
      else {
        send('agent_start');
        const final = ending === 'success' ? reply : { ...failed, timestamp: 20, stopReason: 'error' };
        send('message_end', { message: final });
        send('auto_retry_end', { success: ending === 'success', finalError: ending === 'exhausted' ? 'Provider failed' : undefined });
        send('agent_end', { messages: [final] });
      }
      send('agent_settled');
      assert.equal(terminal.last?.state, ending === 'success' ? 'working' : ending === 'cancelled' ? 'idle' : 'error');
      if (ending === 'success') assert.equal(terminal.last?.message, WAITING_MESSAGE);
      assert.equal(terminal.bells, ending === 'exhausted' ? 1 : 0);
      await flush(); assert.equal(terminal.bells, ending === 'exhausted' ? 1 : 0);
    });
  }
});

test('idle snapshots use context edits to omit a recovered failed reply from the waiting tail', async t => {
  for (const mode of ['attach', 'reconnect', 'recovered waiting']) for (const historyComplete of [undefined, true]) await t.test(`${mode}/${historyComplete}`, async t => {
    const [call, result, reply] = waitMessages();
    const failed = { role: 'assistant', timestamp: 10, stopReason: 'error', errorMessage: 'Provider failed', content: [] };
    const idle = snapshot(false, 20); idle.historyComplete = historyComplete;
    if (historyComplete === undefined) idle.live.messages = [call, result, failed, reply];
    idle.entries = [call, result, failed].map((message, i) => ({ type: 'message', id: `m${i}`, parentId: i ? `m${i - 1}` : null, message }));
    idle.entries.push({ type: 'context_edit', id: 'omit', parentId: 'm2', targetId: 'm2', replacement: null },
      { type: 'message', id: 'reply', parentId: 'omit', message: reply });
    idle.leafId = 'reply';
    const { terminal, connection, send } = launch(t, mode === 'attach' ? idle : snapshot(mode === 'reconnect'));
    if (mode === 'recovered waiting') {
      send('agent_start');
      for (const message of [call, result, failed]) send('message_end', { message });
      send('auto_retry_start'); send('agent_start');
      send('message_end', { message: reply }); send('auto_retry_end', { success: true }); send('agent_settled');
      assert.equal(terminal.last?.message, WAITING_MESSAGE); assert.equal(terminal.bells, 0);
    }
    if (mode !== 'attach') connection.reconnected?.(idle);
    assert.equal(terminal.last?.state, 'working'); assert.equal(terminal.last?.message, WAITING_MESSAGE);
    assert.equal(terminal.bells, 0);
    connection.reconnected?.(idle); assert.equal(terminal.bells, 0);
  });
});

test('an earlier run error disqualifies waiting until a fresh retry agent_start', async t => {
  for (const retry of [false, true]) await t.test(String(retry), async t => {
    const { terminal, send, wait } = launch(t);
    send('agent_start');
    send('message_end', { message: { role: 'assistant', timestamp: 1, stopReason: 'error', errorMessage: 'Failure', content: [] } });
    if (retry) { send('auto_retry_start'); send('agent_start'); }
    wait(); send('agent_settled');
    assert.equal(terminal.last?.state, retry ? 'working' : 'done');
    assert.equal(terminal.bells, retry ? 0 : 1);
    await flush();
  });
});

test('session and process resets discard waiting even if the retained transcript ends in an old wait', async t => {
  for (const reset of ['restart', 'reconnect process', 'session']) await t.test(reset, async t => {
    const initial = snapshot(); initial.slot.pid = 1; initial.live.messages = waitMessages();
    const { terminal, connection, send, ui } = launch(t, initial);
    assert.equal(terminal.last?.message, WAITING_MESSAGE);
    // A verified saved branch survives a process reset until the next history read.
    ui.view.snapshot.entries = waitMessages().map((message, i) => ({ type: 'message', id: `m${i}`, parentId: i ? `m${i - 1}` : null, message }));
    ui.view.snapshot.live.messages = []; ui.view.snapshot.leafId = 'm2';
    if (reset === 'restart') send('remote_slot_restart', { slot: { ...initial.slot, status: 'starting' } });
    else {
      const cut = structuredClone(ui.view.snapshot); cut.seq += 10;
      if (reset === 'session') cut.state.sessionId = 'other'; else cut.slot.pid = 2;
      connection.reconnected?.(cut);
    }
    assert.equal(terminal.last?.state, 'idle'); assert.equal(terminal.bells, 0);
    await flush();
  });
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
