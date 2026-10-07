import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantMessageComponent, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { RemoteTui } from '../src/tui.js';
import { createPresentationTheme } from '../src/presentation.js';
import { loadLocalTheme, resolveThemeSelection, terminalAppearance } from '../src/local-theme.js';
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

test('custom working messages stay above the editor with a custom footer and respect visibility', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'remote-working-status-'));
  t.after(() => rm(dir, { recursive: true }));
  const fixture = resolve(dir, 'working.ts');
  await writeFile(fixture, `export default function(pi) {
    pi.on('session_start', (_, ctx) => {
      ctx.ui.setFooter(() => ({ invalidate() {}, render() { return ['custom footer']; } }));
      ctx.ui.setWidget('above', ['above-editor widget']);
      ctx.ui.setWidget('below', ['below-editor widget'], { placement: 'belowEditor' });
    });
    pi.on('agent_start', (_, ctx) => ctx.ui.setWorkingMessage('Custom working message'));
    pi.registerCommand('hide-working', { handler(_, ctx) { ctx.ui.setWorkingVisible(false); } });
    pi.registerCommand('show-working', { handler(_, ctx) { ctx.ui.setWorkingVisible(true); } });
    pi.registerCommand('change-working', { handler(_, ctx) { ctx.ui.setWorkingMessage('Changed working message'); } });
  }`);
  const initial = snapshot(); initial.live.busy = true;
  const { ui, submit } = await launch(t, initial, [fixture]);
  const rows = () => { ui.tui.renderNow(); return ui.tui.getScreenLines().map(stripTerminalSequences); };
  ui.editor.setText('prompt draft');
  const screen = rows();
  const markers = ['Custom working message', 'above-editor widget', 'prompt draft', 'below-editor widget', 'custom footer'];
  const positions = markers.map(marker => screen.findIndex(row => row.includes(marker)));
  assert.ok(positions.every(position => position >= 0), screen.join('\n'));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, screen.join('\n'));
  assert.equal(screen.filter(row => row.includes('Custom working message')).length, 1);
  await submit('/hide-working');
  assert.ok(!rows().some(row => row.includes('Custom working message')));
  await submit('/show-working');
  assert.equal(rows().filter(row => row.includes('Custom working message')).length, 1);
  await submit('/change-working');
  const changed = rows();
  assert.ok(!changed.some(row => row.includes('Custom working message')));
  assert.ok(changed.findIndex(row => row.includes('Changed working message')) < changed.findIndex(row => row.includes('custom footer')));
});

test('metadata, status and streaming updates preserve historical Markdown caches', async t => {
  const key = Symbol.for('pi-remote.test.render-cache');
  const counts = { history: 0, live: 0 };
  (globalThis as any)[key] = counts;
  const dir = await mkdtemp(resolve(tmpdir(), 'remote-render-cache-'));
  t.after(async () => { delete (globalThis as any)[key]; await rm(dir, { recursive: true }); });
  const fixture = resolve(dir, 'cache.ts');
  await writeFile(fixture, `export default function(pi) {
    pi.registerMarkdownTransformer(text => {
      const counts = globalThis[Symbol.for('pi-remote.test.render-cache')];
      if (text.includes('historical')) counts.history++;
      if (text.includes('streamed')) counts.live++;
      return text;
    });
    pi.on('session_start', (_, ctx) => {
      ctx.ui.setFooter(() => ({ invalidate() {}, render() { return ['usage:' + ctx.getContextUsage()?.tokens]; } }));
      ctx.ui.setWidget('metadata', () => ({ invalidate() {}, render() { return ['session:' + pi.getSessionName()]; } }));
    });
    pi.on('message_update', (_, ctx) => ctx.ui.setStatus('stream', 'receiving'));
    pi.registerCommand('header', { handler(_, ctx) {
      ctx.ui.setHeader(() => ({ invalidate() {}, render() { return ['new header']; } }));
    } });
    pi.registerCommand('transform', { handler() {
      pi.registerMarkdownTransformer(text => text.replace('historical', 'replaced'));
    } });
  }`);
  const initial = snapshot();
  initial.live.messages = [
    { role: 'assistant', timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: '**historical** response' }] },
    { role: 'assistant', timestamp: 2, stopReason: 'pending', content: [{ type: 'text', text: 'streamed' }] },
  ];
  const { ui, connection, terminal, submit } = await launch(t, initial, [fixture]);
  ui.tui.renderNow();
  assert.ok(counts.history > 0);
  counts.history = 0; counts.live = 0;
  const historical = (ui as any).transcript.children[0];
  let invalidations = 0;
  const original = historical.invalidate;
  t.mock.method(historical, 'invalidate', function (this: any) { invalidations++; original.call(this); });
  for (let i = 0; i < 3; i++) { ui.tui.scrollBy(-1); ui.tui.renderNow(); }
  assert.equal(counts.history, 0);
  const handler = connection.handler;
  connection.handler = (method, params) => params?.command?.type === 'get_session_stats'
    ? { contextUsage: { tokens: 60000 } } : handler(method, params);
  (ui as any).refreshPresentationData(); await flush(); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /usage:60000/);
  connection.listener?.({ type: 'event', slotId: 'slot', seq: 1,
    event: { type: 'session_info_changed', name: 'renamed' } });
  await flush(); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /session:renamed/);
  connection.listener?.({ type: 'event', slotId: 'slot', seq: 2,
    event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' new text' } } });
  await flush(); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /streamed new text/);
  assert.ok(counts.live > 0);
  assert.equal(counts.history, 0);
  assert.equal(invalidations, 0);
  assert.equal((ui as any).transcript.children[0], historical);
  // Display options and real renderer registrations still invalidate/rebuild content.
  terminal.input('\x14'); await flush(); ui.tui.renderNow();
  assert.ok(counts.history > 0);
  await submit('/header'); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /new header/);
  await submit('/transform'); ui.tui.renderNow();
  assert.match(ui.tui.getScreenLines().join('\n'), /replaced/);
  assert.doesNotMatch(ui.tui.getScreenLines().join('\n'), /historical/);
});

test('partial shell timers are retired on UI reload, reconnect and detach without stopping remote work', async t => {
  for (const action of ['reload', 'async-reload', 'reconnect', 'detach']) await t.test(action, async t => {
    const active = new Set<ReturnType<typeof setInterval>>();
    const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
    t.mock.method(globalThis, 'setInterval', (callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
      const timer = originalSet(callback, ms, ...args); if (ms === 1000) active.add(timer); return timer;
    });
    t.mock.method(globalThis, 'clearInterval', (timer: ReturnType<typeof setInterval>) => { active.delete(timer); originalClear(timer); });
    let ui: RemoteTui | undefined;
    let releaseShutdown = () => {};
    const gateKey = Symbol.for('pi-remote.test.shutdown-gate');
    try {
      const initial = snapshot(); initial.live.busy = true;
      initial.live.messages = [{ role: 'assistant', timestamp: 1, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'running', name: 'bash', arguments: { command: 'fixture' } }] }];
      initial.live.tools.running = { toolCallId: 'running', toolName: 'bash', type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'partial output' }] } };
      const paths: string[] = [];
      if (action === 'async-reload') {
        const dir = await mkdtemp(resolve(tmpdir(), 'remote-shutdown-')); t.after(() => rm(dir, { recursive: true }));
        const path = resolve(dir, 'async-shutdown.ts');
        await writeFile(path, `export default function(pi) { pi.on('session_shutdown', async () => {
          const gate = globalThis[Symbol.for('pi-remote.test.shutdown-gate')];
          if (gate) { gate.entered(); await gate.wait; }
        }); }`);
        paths.push(path);
      }
      const launched = await launch(t, initial, paths); ui = launched.ui;
      ui.tui.renderNow(); assert.equal(active.size, 1);
      const originalTimer = [...active][0];
      if (action === 'reload') {
        await launched.submit('/reload-ui');
        for (let i = 0; i < 20 && active.has(originalTimer); i++) await flush();
        ui.tui.renderNow();
      }
      if (action === 'async-reload') {
        let entered!: () => void;
        const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { releaseShutdown = resolve; });
        (globalThis as any)[gateKey] = { entered, wait };
        const reloading = (ui as any).reloadPresentation();
        await enteredPromise;
        ui.tui.renderNow(); // Simulate incoming remote output while shutdown awaits.
        assert.equal(active.size, 1);
        releaseShutdown(); await reloading; ui.tui.renderNow();
      }
      if (action === 'reconnect') { launched.connection.reconnected?.(structuredClone(initial)); await flush(); ui.tui.renderNow(); }
      if (action !== 'detach') { assert.ok(!active.has(originalTimer)); assert.equal(active.size, 1); }
      ui.detach(); await flush(); assert.equal(active.size, 0);
      assert.equal(ui.view.snapshot.live.busy, true);
      assert.equal(ui.view.snapshot.live.tools.running.partialResult.content[0].text, 'partial output');
      assert.ok(!launched.connection.requests.some(request => ['kill', 'abort', 'abort_bash'].includes(request.params?.command?.type ?? request.method)));
    } finally { releaseShutdown(); delete (globalThis as any)[gateKey]; ui?.detach(); for (const timer of active) originalClear(timer); }
  });
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

test('terminal appearance follows reported colors, mode 2031 reports, then COLORFGBG', () => {
  const white = { r: 255, g: 255, b: 255 }, black = { r: 0, g: 0, b: 0 }, cream = { r: 251, g: 241, b: 199 };
  assert.equal(terminalAppearance({ background: cream, foreground: { r: 60, g: 56, b: 54 } }, 'dark', {}), 'light');
  assert.equal(terminalAppearance({ background: black, foreground: white }, 'light', {}), 'dark');
  assert.equal(terminalAppearance({ background: white }, undefined, {}), 'light');
  assert.equal(terminalAppearance({}, 'light', { COLORFGBG: '15;0' }), 'light');
  assert.equal(terminalAppearance({}, undefined, { COLORFGBG: '0;15' }), 'light');
  assert.equal(terminalAppearance({}, undefined, { COLORFGBG: '15;default;0' }), 'dark');
  assert.equal(terminalAppearance({}, undefined, {}), 'dark');
  assert.equal(resolveThemeSelection('gruvbox-light/gruvbox-dark', 'light'), 'gruvbox-light');
  assert.equal(resolveThemeSelection('gruvbox-light/gruvbox-dark', 'dark'), 'gruvbox-dark');
  assert.equal(resolveThemeSelection('gruvbox-dark', 'light'), 'gruvbox-dark');
  assert.throws(() => resolveThemeSelection('a/b/c', 'light'), /theme name/);
});

test('light/dark theme pairs pick the member for the local terminal and follow live switches', async t => {
  class ColorTerminal extends FakeTerminal {
    background = 'ffff/ffff/ffff'; foreground = '0000/0000/0000';
    override write(data: string) {
      if (!data.includes('\x1b]11;?')) return;
      setImmediate(() => {
        this.input(`\x1b]10;rgb:${this.foreground}\x07`);
        this.input(`\x1b]11;rgb:${this.background}\x07`);
        this.input('\x1b[?62c');
      });
    }
  }
  const terminal = new ColorTerminal();
  const ui = new RemoteTui(new Connection(), 'slot', snapshot(), terminal, { presentationConfig: absentConfig, theme: 'light/dark' });
  const finished = ui.run(); t.after(async () => { ui.detach(); await finished; });
  await ui.initialize(); await flush();
  const themeName = () => (ui as any).localTheme.name;
  assert.equal(themeName(), 'light');
  terminal.background = '0000/0000/0000'; terminal.foreground = 'ffff/ffff/ffff';
  terminal.input('\x1b[?997;1n');
  for (let i = 0; i < 50 && themeName() !== 'dark'; i++) await flush();
  assert.equal(themeName(), 'dark');
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
  const assistantRender = AssistantMessageComponent.prototype.render;
  const toolRender = ToolExecutionComponent.prototype.render;
  const { ui, terminal, connection, submit } = await launch(t, initial, [adapter]);
  assert.ok(ui.presentation?.footer, (ui as any).transcript.notices.join('\n'));
  assert.notEqual(AssistantMessageComponent.prototype.render, assistantRender);
  assert.notEqual(ToolExecutionComponent.prototype.render, toolRender);
  assert.equal(ui.presentation!.transformMarkdown('_Worked for 1m 15s_', {
    messageType: 'assistant', isStreaming: false, availableWidth: 140,
  }), '');
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
