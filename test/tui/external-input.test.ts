import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stripTerminalSequences, type SelectItem, type Terminal } from '@earendil-works/pi-tui';
import type { Attachment } from '../../src/protocol/files.js';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../../src/protocol/types.js';
import { RemoteTui, type ExternalInput, type TuiOptions } from '../../src/tui/tui.js';

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: { sessionId: 'session' }, entries: [], leafId: null, ui: [], seq: 0,
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] }, ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  output = ''; stopped = false;
  start(input: (data: string) => void) { this.input = input; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(text: string) { this.output += text; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
class FakeConnection implements RemoteConnection {
  requests: { method: string; params?: RecordValue }[] = [];
  events = new Set<(event: RemoteEvent) => void>();
  disconnects = new Set<(error: Error) => void>();
  reconnects = new Set<(snapshot: Snapshot) => void>();
  seq = 0;
  handler: (method: string, params?: RecordValue) => any = method => method === 'snapshot' ? snapshot() : {};
  async request<T = any>(method: string, params?: RecordValue): Promise<T> {
    this.requests.push({ method, params }); return this.handler(method, params);
  }
  onEvent(listener: (event: RemoteEvent) => void) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onDisconnect(listener: (error: Error) => void) { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
  onReconnect(listener: (snapshot: Snapshot) => void) { this.reconnects.add(listener); return () => { this.reconnects.delete(listener); }; }
  close() {}
  emit(event: RecordValue) { for (const listener of this.events) listener({ type: 'event', slotId: 'slot', seq: ++this.seq, event }); }
  disconnect() { for (const listener of this.disconnects) listener(new Error('network lost')); }
  reconnect(value = snapshot()) { this.seq = value.seq; for (const listener of this.reconnects) listener(value); }
}
function launch(t: TestContext, initial = snapshot(), callbacks: Partial<ExternalInput> = {}, options: TuiOptions = {}) {
  const drafts: string[] = [], dialogs: (RecordValue | undefined)[] = [], terminalDialogs: boolean[] = [];
  const terminal = new FakeTerminal(), connection = new FakeConnection();
  const externalInput: ExternalInput = {
    onDraftChange: text => drafts.push(text), onDialogChange: record => dialogs.push(record),
    onTerminalDialogChange: active => terminalDialogs.push(active), ...callbacks,
  };
  const ui = new RemoteTui(connection, 'slot', initial, terminal, { bell: false, ...options, externalInput });
  const finished = ui.run();
  t.after(async () => { ui.detach(); await finished; });
  const screen = () => { ui.tui.renderNow(); return stripTerminalSequences(ui.tui.getScreenLines().join('\n')); };
  return { ui, terminal, connection, drafts, dialogs, terminalDialogs, screen, finished };
}
const prompts = (connection: FakeConnection) => connection.requests.filter(request => request.params?.command?.type === 'prompt');

test('native drafts use the hidden Pi editor, submit once, retain whitespace, and notify history changes', async t => {
  const { ui, terminal, connection, drafts, screen } = launch(t);
  assert.deepEqual(drafts, ['']);
  ui.setDraft('  native draft\nsecond line  ');
  assert.equal(drafts.at(-1), '  native draft\nsecond line  ');
  assert.deepEqual(ui.editor.render(80), []);
  assert.doesNotMatch(screen(), /native draft|second line/);
  await ui.submitDraft('steer');
  assert.deepEqual(prompts(connection).map(request => request.params?.command), [
    { type: 'prompt', message: '  native draft\nsecond line  ', streamingBehavior: 'steer' },
  ]);
  assert.equal(drafts.at(-1), '');
  terminal.input('\x1b[A');
  // Pi's own history trims surrounding whitespace; native submission itself preserves it.
  assert.equal(drafts.at(-1), 'native draft\nsecond line');
  terminal.input('\x03');
  assert.equal(drafts.at(-1), '');
  connection.disconnect(); connection.reconnect(); await flush();
  assert.equal(prompts(connection).length, 1);
});

test('native steer/follow-up and restored queued text use the existing one-shot prompt path', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const { ui, terminal, connection, drafts } = launch(t, initial);
  for (const [text, behavior] of [['steering text', 'steer'], ['later text', 'followUp']] as const) {
    ui.setDraft(text); await ui.submitDraft(behavior);
  }
  assert.deepEqual(prompts(connection).map(request => request.params?.command.streamingBehavior), ['steer', 'followUp']);
  connection.emit({ type: 'queue_update', steering: ['steering text'], followUp: ['later text'] });
  connection.handler = (_method, params) => params?.command?.type === 'clear_queue'
    ? { steering: ['steering text'], followUp: ['later text'] } : {};
  ui.setDraft('new draft'); terminal.input('\x1b[1;3A'); await flush();
  assert.equal(drafts.at(-1), 'steering text\n\nlater text\n\nnew draft');
  assert.deepEqual(ui.view.snapshot.live.steering, []);
  assert.equal(connection.requests.at(-1)?.params?.command.type, 'clear_queue');
  assert.equal(prompts(connection).length, 2);
});

test('remote set-editor-text and programmatic changes always notify the native input', t => {
  const { ui, connection, drafts } = launch(t);
  connection.emit({ type: 'extension_ui_request', id: 'set-1', method: 'set_editor_text', text: 'remote draft' });
  assert.equal(drafts.at(-1), 'remote draft');
  ui.editor.setText('programmatic\r\n\tchange');
  assert.equal(drafts.at(-1), 'programmatic\n    change');
  connection.emit({ type: 'extension_ui_request', id: 'set-2', method: 'set_editor_text', text: 'replaced' });
  assert.equal(drafts.at(-1), 'replaced');
});

test('uncertain submission restores the old and newer native drafts without replay on reconnect', async t => {
  const { ui, connection, drafts } = launch(t);
  const reply = deferred<RecordValue>();
  connection.handler = () => reply.promise;
  ui.setDraft('possibly accepted');
  const sent = ui.submitDraft('steer');
  const failed = assert.rejects(sent, /lost reply/);
  await flush();
  assert.equal(prompts(connection).length, 1); assert.equal(drafts.at(-1), '');
  ui.setDraft('new typing');
  await assert.rejects(ui.submitDraft('followUp'), /pending/);
  connection.disconnect(); reply.reject(new Error('lost reply')); await failed;
  assert.equal(drafts.at(-1), 'possibly accepted\n\nnew typing');
  connection.reconnect(); await flush();
  assert.equal(prompts(connection).length, 1);
  assert.equal(drafts.at(-1), 'possibly accepted\n\nnew typing');
});

test('native submissions guard dialogs, disconnect, startup, and detach without clearing the draft', async t => {
  const question = { id: 'question', method: 'input', title: 'Value?' };
  const { ui, connection, drafts } = launch(t, snapshot({ ui: [question] }));
  ui.setDraft('preserved');
  await assert.rejects(ui.submitDraft('steer'), /remote dialog/);
  connection.disconnect(); ui.setDraft('offline typing');
  await assert.rejects(ui.submitDraft('steer'), /Disconnected/);
  await assert.rejects(ui.answerExternalDialog('question', { value: 'answer' }), /Disconnected/);
  assert.equal(drafts.at(-1), 'offline typing'); assert.deepEqual(connection.requests, []);
  connection.reconnect(snapshot({ slot: { ...snapshot().slot, status: 'starting' } }));
  await assert.rejects(ui.submitDraft('steer'), /starting or reloading/);
  ui.detach();
  await assert.rejects(ui.submitDraft('steer'), /detached/);
  assert.throws(() => ui.setDraft('late typing'), /detached/);
  assert.deepEqual(connection.requests, []);
});

test('native remote dialogs never paint terminal controls and answer through the daemon once', async t => {
  for (const [method, fields, response] of [
    ['confirm', { message: 'Remote body' }, { confirmed: true }],
    ['select', { options: ['\x1b[31moriginal option\x1b[0m'] }, { value: '\x1b[31moriginal option\x1b[0m' }],
    ['input', { placeholder: 'Remote placeholder' }, { value: 'typed answer' }],
    ['editor', { prefill: 'Remote prefill' }, { value: '  first\nsecond\n' }],
  ] as const) {
    await t.test(method, async t => {
      const record = { id: 'question', method, title: 'REMOTE_NATIVE_QUESTION', ...fields };
      const { ui, terminal, connection, dialogs, screen } = launch(t, snapshot({ ui: [record] }));
      assert.deepEqual(dialogs, [record]);
      ui.setDraft('retained prompt');
      assert.doesNotMatch(screen(), /REMOTE_NATIVE_QUESTION|Remote body|Remote placeholder|Remote prefill|Enter submit|original option|retained prompt/);
      terminal.input('x'); terminal.input('\r'); await flush();
      assert.deepEqual(connection.requests, []); assert.equal(ui.editor.getExpandedText(), 'retained prompt');
      await ui.answerExternalDialog('question', response);
      assert.deepEqual(connection.requests, [{ method: 'answer', params: { slotId: 'slot', response: { ...response, id: 'question' } } }]);
      assert.equal(dialogs.at(-1), undefined);
      await assert.rejects(ui.answerExternalDialog('question', response), /no longer active/);
      assert.equal(connection.requests.length, 1);
    });
  }
});

test('native dialog callbacks change only with the dialog, preserving answers across status and reconnect', t => {
  const record = { id: 'question', method: 'input', title: 'Question', placeholder: 'Value' };
  const { ui, connection, dialogs } = launch(t, snapshot({ ui: [record] }));
  dialogs[0]!.title = 'Host copy only';
  assert.equal(ui.view.snapshot.ui[0].title, 'Question');
  connection.emit({ type: 'extension_ui_request', id: 'status', method: 'setStatus', statusKey: 'status', statusText: 'busy' });
  ui.queueAttachments([]); ui.setDraft('prompt draft'); ui.tui.renderNow();
  connection.disconnect(); connection.reconnect(snapshot({ ui: [{ placeholder: 'Value', title: 'Question', method: 'input', id: 'question' }] }));
  assert.equal(dialogs.length, 1);
  connection.emit({ type: 'extension_ui_request', ...record, title: 'Changed title' });
  assert.equal(dialogs.length, 2); assert.equal(dialogs.at(-1)?.title, 'Changed title');
  connection.emit({ type: 'remote_dialog_resolved', id: 'question', reason: 'expired' });
  assert.equal(dialogs.length, 3); assert.equal(dialogs.at(-1), undefined);
  connection.emit({ type: 'extension_ui_request', ...record });
  assert.equal(dialogs.length, 4);
  ui.detach(); assert.equal(dialogs.at(-1), undefined);
  assert.deepEqual(connection.requests, []);
});

test('a replacement Pi process republishes a reused native dialog identity', t => {
  const record = { id: 'question', method: 'input', title: 'Same text, new process' };
  const { connection, dialogs } = launch(t, snapshot({ slot: { ...snapshot().slot, pid: 1 }, ui: [record] }));
  connection.reconnect(snapshot({ slot: { ...snapshot().slot, pid: 2 }, ui: [record] }));
  assert.deepEqual(dialogs, [record, undefined, record]);
  assert.deepEqual(connection.requests, []);
});

test('native dialog validation and in-flight duplicate guards send no extra answers', async t => {
  const { ui, connection } = launch(t, snapshot({ ui: [{ id: 'question', method: 'confirm' }] }));
  await assert.rejects(ui.answerExternalDialog('other', { confirmed: true }), /no longer active/);
  await assert.rejects(ui.answerExternalDialog('question', { id: 'other', confirmed: true }), /different dialog/);
  await assert.rejects(ui.answerExternalDialog('question', { confirmed: 'yes' }), /boolean/);
  const reply = deferred<RecordValue>(); connection.handler = () => reply.promise;
  const answered = ui.answerExternalDialog('question', { confirmed: false });
  await assert.rejects(ui.answerExternalDialog('question', { confirmed: false }), /already pending/);
  assert.equal(connection.requests.length, 1);
  reply.resolve({}); await answered;
});

test('an uncertain native answer is not replayed or dismissed on disconnect', async t => {
  const record = { id: 'question', method: 'editor', prefill: 'saved' };
  const { ui, connection, dialogs } = launch(t, snapshot({ ui: [record] }));
  const reply = deferred<RecordValue>(); connection.handler = () => reply.promise;
  const answered = ui.answerExternalDialog('question', { value: 'typed native answer' });
  const failed = assert.rejects(answered, /lost answer reply/);
  connection.disconnect(); reply.reject(new Error('lost answer reply')); await failed;
  assert.equal(dialogs.length, 1);
  connection.reconnect(snapshot({ ui: [record] })); await flush();
  assert.equal(dialogs.length, 1);
  assert.deepEqual(connection.requests.map(request => request.method), ['answer']);
});

test('simple native choices receive an AbortSignal, block prompt submission, and use the selected value', async t => {
  const selected = deferred<string | undefined>();
  let shown: { title: string; items: SelectItem[]; signal: AbortSignal } | undefined;
  const { ui, connection, screen } = launch(t, snapshot(), { choose: (title, items, signal) => {
    shown = { title, items, signal }; return selected.promise;
  } });
  connection.handler = (method, params) => method === 'snapshot' ? snapshot() : params?.command?.type === 'get_available_models'
    ? { models: [{ provider: 'provider', id: 'model', name: 'My model' }] } : {};
  ui.setDraft('/model'); const choosing = ui.submitDraft('steer'); await flush();
  assert.equal(shown?.title, 'Choose model'); assert.equal(shown?.signal.aborted, false);
  assert.equal(shown?.items[0].label, 'provider/model');
  assert.doesNotMatch(screen(), /Choose model|provider\/model/);
  ui.setDraft('next prompt'); await assert.rejects(ui.submitDraft('steer'), /local dialog/);
  selected.resolve('0'); await choosing;
  assert.equal(shown?.signal.aborted, true);
  assert.deepEqual(connection.requests.map(request => request.params?.command?.type ?? request.method), ['get_available_models', 'set_model', 'snapshot']);
  assert.equal(ui.editor.getExpandedText(), 'next prompt');
});

test('native choice cancellation aborts its sheet and ignores late destructive choices', async t => {
  for (const reason of ['disconnect', 'reconnect', 'detach', 'session change', 'restart', 'snapshot change', 'escape'] as const) {
    await t.test(reason, async t => {
      const selected = deferred<string | undefined>(); let signal: AbortSignal | undefined;
      const initial = snapshot(); initial.live.busy = true;
      const { ui, terminal, connection } = launch(t, initial, { choose: (_title, _items, choiceSignal) => { signal = choiceSignal; return selected.promise; } });
      ui.setDraft('/quit'); const choosing = ui.submitDraft('steer'); await flush();
      assert.equal(signal?.aborted, false);
      if (reason === 'disconnect') connection.disconnect();
      else if (reason === 'reconnect') connection.reconnect();
      else if (reason === 'detach') ui.detach();
      else if (reason === 'escape') terminal.input('\x1b');
      else if (reason === 'session change') connection.emit({ type: 'remote_state', state: { sessionId: 'new-session' } });
      else if (reason === 'restart') connection.emit({ type: 'remote_slot_restart', slot: { ...initial.slot, status: 'starting' } });
      else {
        connection.handler = () => snapshot({ state: { sessionId: 'new-session' } });
        connection.emit({ type: 'remote_refresh' });
      }
      await choosing; assert.equal(signal?.aborted, true);
      selected.resolve('stop'); await flush();
      assert.equal(connection.requests.some(request => request.method === 'kill'), false);
      assert.equal(prompts(connection).length, 0);
    });
  }
});

test('an incoming remote question cancels a native local chooser before displaying the question', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const selected = deferred<string | undefined>(); let signal: AbortSignal | undefined;
  const { ui, connection, dialogs } = launch(t, initial, { choose: (_title, _items, choiceSignal) => { signal = choiceSignal; return selected.promise; } });
  ui.setDraft('/quit'); const choosing = ui.submitDraft('steer'); await flush();
  const question = { type: 'extension_ui_request', id: 'question', method: 'confirm', title: 'Remote question' };
  connection.emit(question); await choosing;
  assert.equal(signal?.aborted, true); assert.deepEqual(dialogs.at(-1), question);
  selected.resolve('stop'); await flush();
  assert.equal(connection.requests.some(request => request.method === 'kill'), false);
});

test('a session change between native choice completion and continuation cannot kill the new session', async t => {
  const initial = snapshot(); initial.live.busy = true;
  const selected = deferred<string | undefined>();
  let connection!: FakeConnection;
  const launched = launch(t, initial, { choose: (_title, _items, signal) => {
    signal.addEventListener('abort', () => connection.emit({ type: 'remote_state', state: { sessionId: 'new-session' } }));
    return selected.promise;
  } });
  connection = launched.connection;
  launched.ui.setDraft('/quit'); const choosing = launched.ui.submitDraft('steer'); await flush();
  selected.resolve('stop'); await choosing;
  assert.equal(connection.requests.some(request => request.method === 'kill'), false);
});

test('native chooser errors restore the command through the draft callback', async t => {
  const { ui, connection, drafts } = launch(t, snapshot(), { choose: async () => { throw new Error('native chooser failed'); } });
  connection.handler = () => ({ levels: ['low', 'high'] });
  ui.setDraft('/thinking');
  await assert.rejects(ui.submitDraft('steer'), /native chooser failed/);
  assert.equal(drafts.at(-1), '/thinking');
  assert.deepEqual(connection.requests.map(request => request.params?.command.type), ['get_available_thinking_levels']);
});

test('complex fork selection remains terminal-driven and publishes restored fork text', async t => {
  const { ui, terminal, connection, drafts, terminalDialogs } = launch(t, snapshot(), { choose: async () => { throw new Error('Fork must not use a simple native choice'); } });
  const tree = [{ entry: { type: 'message', id: 'user', parentId: null, message: { role: 'user', timestamp: 1, content: 'Original prompt' } }, children: [] }];
  connection.handler = (method, params) => method === 'snapshot' ? snapshot() : params?.command?.type === 'get_tree'
    ? { tree, leafId: 'user' } : params?.command?.type === 'fork' ? { text: 'restored fork draft' } : {};
  ui.setDraft('/fork'); const choosing = ui.submitDraft('steer'); await flush();
  assert.equal(terminalDialogs.at(-1), true);
  ui.setDraft('preserved while choosing'); await assert.rejects(ui.submitDraft('steer'), /local dialog/);
  terminal.input('\r'); await choosing;
  assert.equal(terminalDialogs.at(-1), false);
  assert.equal(drafts.at(-1), 'restored fork draft');
  assert.deepEqual(connection.requests.map(request => request.params?.command?.type ?? request.method), ['get_tree', 'fork', 'snapshot']);
});

test('external mode never installs a presentation editor factory and keeps callbacks after reload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-external-editor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = join(dir, 'adapter.ts');
  await writeFile(adapter, `export default function(pi) { pi.on('session_start', (_event, ctx) => {
    ctx.ui.setEditorComponent(() => { throw new Error('ADAPTER_FACTORY_MUST_NOT_RUN'); });
  }); }`);
  const { ui, drafts, screen } = launch(t, snapshot(), {}, { presentationPaths: [adapter], presentationConfig: join(dir, 'absent.json') });
  t.mock.method(ui.tui, 'queryTerminalColors', async () => ({}));
  ui.setDraft('before loading'); await ui.initialize(); await flush();
  assert.ok(ui.presentation?.editorFactory);
  assert.deepEqual(ui.editor.render(80), []);
  assert.equal(drafts.at(-1), 'before loading');
  assert.doesNotMatch(screen(), /initialization failed|ADAPTER_FACTORY_MUST_NOT_RUN/);
  ui.setDraft('/reload-ui'); await ui.submitDraft('steer');
  ui.editor.setText('after reload'); assert.equal(drafts.at(-1), 'after reload');
  assert.deepEqual(ui.editor.render(80), []);
});

test('native attachment bytes are copied, bounded, and sent once without reading paths', async t => {
  const { ui, connection } = launch(t);
  const file: Attachment = { path: '/not-on-this-machine.txt', text: 'ATTACHED_TEXT' };
  const image: Attachment = { path: 'image.png', image: { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' } };
  ui.queueAttachments([file, image]); file.text = 'mutated'; image.image!.data = 'b3RoZXI=';
  ui.setDraft('first'); await ui.submitDraft('steer');
  const first = prompts(connection)[0].params!.command;
  assert.match(first.message, /ATTACHED_TEXT/); assert.doesNotMatch(first.message, /mutated/);
  assert.deepEqual(first.images, [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]);
  assert.deepEqual(connection.requests.map(request => request.method), ['rpc']);
  ui.setDraft('second'); await ui.submitDraft('followUp');
  assert.equal(prompts(connection)[1].params!.command.message, 'second');
  assert.equal(prompts(connection)[1].params!.command.images, undefined);
});

test('attachments queued during an in-flight submit remain for the next draft', async t => {
  const { ui, connection } = launch(t);
  const reply = deferred<RecordValue>(); connection.handler = () => reply.promise;
  ui.queueAttachments([{ path: 'first.txt', text: 'FIRST_ATTACHMENT' }]); ui.setDraft('first');
  const first = ui.submitDraft('steer'); await flush();
  ui.queueAttachments([{ path: 'later.txt', text: 'LATER_ATTACHMENT' }]); ui.setDraft('second');
  reply.resolve({}); await first;
  connection.handler = () => ({}); await ui.submitDraft('steer');
  assert.match(prompts(connection)[0].params!.command.message, /FIRST_ATTACHMENT/);
  assert.doesNotMatch(prompts(connection)[0].params!.command.message, /LATER_ATTACHMENT/);
  assert.match(prompts(connection)[1].params!.command.message, /LATER_ATTACHMENT/);
  assert.doesNotMatch(prompts(connection)[1].params!.command.message, /FIRST_ATTACHMENT/);
});

test('native attachment validation is atomic and keeps the eight-file and prompt-size bounds', async t => {
  const { ui, connection } = launch(t);
  const eight = Array.from({ length: 8 }, (_, index) => ({ path: `file-${index}.txt`, text: `text-${index}` }));
  ui.queueAttachments(eight);
  assert.throws(() => ui.queueAttachments([{ path: 'ninth', text: 'not queued' }]), /eight/);
  ui.setDraft('send eight'); await ui.submitDraft('steer');
  assert.equal((prompts(connection)[0].params!.command.message.match(/Attached local file/g) ?? []).length, 8);
  assert.throws(() => ui.queueAttachments([{ path: 'empty' }]), /text or an image/);
  assert.throws(() => ui.queueAttachments([{ path: 'large.txt', text: 'a'.repeat(1024 * 1024 + 1) }]), /1 MiB/);
  assert.throws(() => ui.queueAttachments([{ path: 'bad.png', image: { type: 'image', mimeType: 'image/png', data: 'not base64' } }]), /base64/);
  ui.setDraft('preserved'); assert.throws(() => ui.setDraft('x'.repeat(24 * 1024 * 1024)), /24 MiB/);
  assert.equal(ui.editor.getExpandedText(), 'preserved');
  const data = Buffer.alloc(8 * 1024 * 1024).toString('base64');
  const image: Attachment = { path: 'large.png', image: { type: 'image', mimeType: 'image/png', data } };
  ui.queueAttachments([image, image]);
  assert.throws(() => ui.queueAttachments([image]), /24 MiB/);
  ui.setDraft('/clear-attachments'); await ui.submitDraft('steer');
  ui.setDraft('no invalid files'); await ui.submitDraft('steer');
  assert.equal(prompts(connection).at(-1)?.params!.command.message, 'no invalid files');
});

test('touch scrolling and following latest use only the local transcript ScrollView', t => {
  const initial = snapshot();
  initial.live.messages = Array.from({ length: 40 }, (_, index) => ({ role: 'assistant', timestamp: index + 1,
    stopReason: 'stop', content: [{ type: 'text', text: `Transcript line ${index}` }] }));
  const { ui, connection, screen } = launch(t, initial);
  assert.equal(ui.tui.isFollowingOutput, true); screen();
  ui.scrollTranscript(-5); assert.equal(ui.tui.isFollowingOutput, false);
  assert.match(screen(), /Jump to latest message/);
  ui.followLatest(); assert.equal(ui.tui.isFollowingOutput, true);
  assert.doesNotMatch(screen(), /Jump to latest message/);
  assert.throws(() => ui.scrollTranscript(NaN), /finite/);
  connection.disconnect(); ui.scrollTranscript(-10); ui.followLatest();
  assert.deepEqual(connection.requests, []);
});
