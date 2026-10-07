import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { RemoteTui } from '../src/tui.js';
import { createPresentationTheme } from '../src/presentation.js';
import { loadLocalTheme } from '../src/local-theme.js';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../src/protocol.js';

class FakeTerminal implements Terminal {
  columns = 140; rows = 50; kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
class Connection implements RemoteConnection {
  requests: { method: string; params?: RecordValue }[] = [];
  registration: string[] = [];
  listener?: (event: RemoteEvent) => void;
  reconnected?: (snapshot: Snapshot) => void;
  handler: (method: string, params?: RecordValue) => any = (method, params) =>
    method === 'filesystem_metadata' ? { gitBranch: 'remote-git', homeDir: '/remote' }
      : params?.command.type === 'get_available_models' ? { models: [{ id: 'physical', provider: 'provider', contextWindow: 200000, reasoning: true }] }
        : params?.command.type === 'get_session_stats' ? { contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 } } : {};
  async request<T = any>(method: string, params?: RecordValue): Promise<T> { this.requests.push({ method, params }); return this.handler(method, params); }
  onEvent(listener: (event: RemoteEvent) => void) { this.registration.push('events'); this.listener = listener; return () => { this.listener = undefined; }; }
  onReconnect(listener: (snapshot: Snapshot) => void) { this.registration.push('reconnect'); this.reconnected = listener; return () => {}; }
  onDisconnect() { return () => {}; }
  close() {}
}
function snapshot(): Snapshot {
  return { slot: { id: 'slot', cwd: '/remote/work', createdAt: '', status: 'running', clients: 1 },
    state: { model: { provider: 'router', id: 'auto', api: 'pi-virtual' }, thinkingLevel: 'high' },
    entries: [], leafId: null, ui: [], seq: 0,
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
  };
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const absentConfig = fileURLToPath(new URL('./fixtures/presentation/no-config.json', import.meta.url));
const display = fileURLToPath(new URL('./fixtures/presentation/display.ts', import.meta.url));

async function launch(t: any, initial = snapshot(), paths: string[] = [], connection = new Connection()) {
  const terminal = new FakeTerminal();
  const ui = new RemoteTui(connection, 'slot', initial, terminal, { presentationConfig: absentConfig, presentationPaths: paths });
  const finished = ui.run(); t.after(async () => { ui.detach(); await finished; });
  await ui.initialize(); await flush();
  const submit = async (text: string) => { ui.editor.setText(text); terminal.input('\r'); await flush(); };
  return { ui, terminal, connection, submit };
}

test('presentation initialization does not wait for unavailable metadata or block startup dialogs', async t => {
  const initial = snapshot(); initial.ui = [{ id: 'startup', method: 'confirm', title: 'Startup confirmation' }];
  const connection = new Connection(); connection.handler = () => new Promise(() => {});
  const { ui, terminal } = await launch(t, initial, [], connection);
  assert.deepEqual(connection.registration, ['reconnect', 'events']);
  assert.equal(connection.requests.length, 3);
  ui.tui.renderNow(); assert.match(stripTerminalSequences(ui.tui.getScreenLines().join('\n')), /Startup confirmation/);
  terminal.input('\r'); await flush(); assert.equal(connection.requests.at(-1)?.method, 'answer');
});

test('local widgets, commands, shortcuts, metadata and reload leave the remote harness unchanged', async t => {
  const { ui, connection, terminal, submit } = await launch(t, snapshot(), [display]);
  assert.equal(ui.view.snapshot.presentation?.gitBranch, 'remote-git');
  assert.equal(ui.view.snapshot.presentation?.stats?.contextUsage.tokens, 50000);
  ui.tui.renderNow(); assert.match(stripTerminalSequences(ui.tui.getScreenLines().join('\n')), /component widget/);
  const requests = connection.requests.length;
  await submit('/local preserved draft'); assert.equal(ui.editor.getExpandedText(), 'preserved draft');
  terminal.input('\x1bo'); await flush(); assert.equal(ui.presentation?.workingMessage, 'shortcut');
  await submit('/reload'); assert.equal(connection.requests.length, requests);
  ui.editor.setText('draft survives editor replacement');
  await (ui as any).reloadPresentation(); await flush();
  assert.equal(ui.editor.getExpandedText(), 'draft survives editor replacement');
  assert.equal(connection.requests.length, requests);
  assert.ok(ui.presentation?.footer);
  assert.equal((ui.editor as any).autocompleteProvider, (ui as any).completion);
  const next = snapshot(); next.seq = 4;
  connection.reconnected?.(next); await flush();
  assert.equal(ui.view.snapshot.seq, 4); assert.equal(ui.view.snapshot.presentation?.gitBranch, 'remote-git');
  connection.listener?.({ type: 'event', slotId: 'slot', seq: 5, event: { type: 'agent_start' } }); await flush();
  assert.equal(ui.presentation?.workingMessage, 'agent');
});

test('oversized combined attachment payload is rejected before sending a prompt', async t => {
  const { ui, connection, submit } = await launch(t);
  (ui as any).pendingAttachments = [{ path: 'large.png', image: { type: 'image', mimeType: 'image/png', data: 'x'.repeat(24 * 1024 * 1024) } }];
  await submit('describe this image');
  assert.ok(!connection.requests.some(request => request.params?.command?.type === 'prompt'));
  assert.match((ui as any).transcript.notices.join('\n'), /exceed 24 MiB; nothing was sent/);
  assert.equal(ui.editor.getExpandedText(), 'describe this image');
});

test('local clipboard and editor keys do not run while a remote dialog owns input', async t => {
  const initial = snapshot(); initial.ui = [{ id: 'remote-dialog', method: 'confirm', title: 'Keep remote dialog' }];
  const { terminal, connection } = await launch(t, initial);
  const requests = connection.requests.length;
  terminal.input('\x16'); terminal.input('\x07'); await flush();
  assert.equal(connection.requests.length, requests);
});

test('local theme loader resolves variables and rejects cycles without importing private modules', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'remote-theme-')); t.after(() => rm(dir, { recursive: true }));
  const { mkdir } = await import('node:fs/promises'); await mkdir(resolve(dir, 'themes'));
  const colors = Object.fromEntries(Object.keys(createPresentationTheme().colors).map(key => [key, 'foreground']));
  const path = resolve(dir, 'themes/test.json');
  await writeFile(path, JSON.stringify({ name: 'test', vars: { foreground: 'nested', nested: '#abcdef' }, colors }));
  const theme = await loadLocalTheme('test', dir); assert.equal(theme.name, 'test'); assert.match(theme.fg('text', 'colored'), /38;2;171;205;239/);
  await writeFile(path, JSON.stringify({ vars: { foreground: 'nested', nested: 'foreground' }, colors }));
  await assert.rejects(loadLocalTheme('test', dir), /Circular/);
  await assert.rejects(loadLocalTheme('../secret', dir), /theme name/);
});

test('a second client refreshes completed bash history from a legacy daemon without remote_bash_end', async t => {
  const initial = snapshot(); initial.state.messageCount = 0;
  const connection = new Connection();
  const { ui } = await launch(t, initial, [], connection);
  const originalHandler = connection.handler;
  connection.handler = (method, params) => {
    if (method !== 'snapshot') return originalHandler(method, params);
    const completed = snapshot(); completed.seq = 2; completed.state.messageCount = 1;
    completed.entries = [{ type: 'message', id: 'bash1', parentId: null,
      message: { role: 'bashExecution', command: 'printf done', output: 'done', timestamp: 1 } }];
    completed.leafId = 'bash1';
    return completed;
  };
  connection.listener?.({ type: 'event', slotId: 'slot', seq: 1, event: { type: 'bash_execution_update', id: 'another-client', delta: 'done' } });
  assert.equal(ui.view.snapshot.live.bash?.['another-client'].output, 'done');
  connection.listener?.({ type: 'event', slotId: 'slot', seq: 2, event: { type: 'remote_state', state: { messageCount: 1 } } });
  await flush();
  assert.equal(Object.keys(ui.view.snapshot.live.bash ?? {}).length, 0);
  assert.equal(ui.view.snapshot.entries[0].message.output, 'done');
  assert.equal(connection.requests.filter(request => request.method === 'snapshot').length, 1);
});

test('opt-in custom editors are trusted input controllers, not a security sandbox', async t => {
  const fixture = fileURLToPath(new URL('./fixtures/presentation/input-controller.ts', import.meta.url));
  const key = Symbol.for('pi-remote.test.input-controller');
  t.after(() => { delete (globalThis as any)[key]; });
  const { ui, connection } = await launch(t, snapshot(), [fixture]);
  assert.ok(ui.presentation?.editorFactory);
  assert.ok(!connection.requests.some(request => request.params?.command?.type === 'prompt'));
  // A selected editor can retain this callback and synthesize input. Document this
  // authority rather than claiming that blocked context methods provide isolation.
  const retainedEditor = (globalThis as any)[key];
  assert.ok(retainedEditor.onSubmit);
  retainedEditor.onSubmit('trusted synthetic input'); await flush();
  const prompts = connection.requests.filter(request => request.params?.command?.type === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].params?.command.message, 'trusted synthetic input');
});

const repo = '/Users/rowan/.pi/agent/git/github.com/rowantran/pi-extensions';
test('actual Rowan adapter renders virtual footer, caret, compact tools, codemode and worked-for locally', {
  skip: !existsSync(resolve(repo, 'codex-footer.ts')),
}, async t => {
  const initial = snapshot();
  initial.live.messages = [{ role: 'assistant', timestamp: 1, provider: 'provider', model: 'physical', stopReason: 'stop', usage: { cost: { total: 0.25 } }, content: [
    { type: 'toolCall', id: 'read1', name: 'read', arguments: { path: '/remote/a.ts' } },
    { type: 'toolCall', id: 'code1', name: 'codemode', arguments: { code: '// Verify nested work\ntext("ok")' } },
  ] },
  { role: 'toolResult', timestamp: 2, toolCallId: 'read1', toolName: 'read', content: [{ type: 'text', text: 'first\nsecond' }] },
  { role: 'toolResult', timestamp: 3, toolCallId: 'code1', toolName: 'codemode', content: [
    { type: 'text', text: 'Script completed\nWall time 0.5 seconds\nOutput:\n' }, { type: 'text', text: 'all verified' },
  ], details: { calls: [{ id: 'nested1', name: 'read', args: '{"path":"/remote/nested.ts"}', status: 'ok' }] } }];
  initial.entries = [{ type: 'custom', id: 'worked', parentId: null, customType: 'worked-for', data: { elapsedSeconds: 75 } }]; initial.leafId = 'worked';
  const adapter = fileURLToPath(new URL('../examples/rowan-ui.ts', import.meta.url));
  const { ui, terminal, connection, submit } = await launch(t, initial, [adapter]);
  assert.ok(ui.presentation?.footer, (ui as any).transcript.notices.join('\n'));
  const footer = stripTerminalSequences(ui.presentation!.footer!.render(140).join('\n'));
  assert.match(footer, /physical high/); assert.match(footer, /73% left/); assert.match(footer, /remote-git/);
  ui.editor.setText('draft'); assert.match(stripTerminalSequences(ui.editor.render(140).join('\n')), /› draft/);
  const render = (width = 140) => stripTerminalSequences((ui as any).transcript.render(width).join('\n'));
  const output = render();
  assert.match(output, /Worked for 1m 15s/); assert.match(output, /Read 2 lines/); assert.match(output, /all verified/);
  assert.match(output, /nested.ts/); assert.equal((output.match(/Codemode/g) ?? []).length, 1);
  assert.doesNotMatch(output, /✓ codemode|✓ read/);
  const requests = connection.requests.length;
  await submit('/tool-call'); assert.match(render(), /text\("ok"\)/);
  assert.equal(connection.requests.length, requests);
  terminal.input('\x1bo'); await flush();
  for (const width of [1, 8, 40, 140]) {
    (ui as any).transcript.invalidate();
    assert.ok((ui as any).transcript.render(width).every((line: string) => visibleWidth(line) <= width));
  }
  assert.ok(!('execute' in ui.presentation!.tools.get('read')!));
});
