import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomEditor, initTheme } from '@earendil-works/pi-coding-agent';
import { Editor, stripTerminalSequences, visibleWidth, type Terminal, type TUI } from '@earendil-works/pi-tui';
import { WorkingIndicator } from '../src/working-indicator.js';
import { RemoteTui } from '../src/tui.js';
import { PresentationHost } from '../src/presentation.js';
import { loadLocalTheme } from '../src/local-theme.js';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../src/protocol.js';

// Reference implementation is test-only. Production imports only public Pi APIs.
const { WorkingStatusIndicator } = await import(new URL('./modes/interactive/components/status-indicator.js',
  import.meta.resolve('@earendil-works/pi-coding-agent')).href);
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  start() {} stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
class Connection implements RemoteConnection {
  listener?: (event: RemoteEvent) => void;
  reconnected?: (snapshot: Snapshot) => void;
  requests: string[] = [];
  current = snapshot();
  request<T>(method: string): Promise<T> { this.requests.push(method); return Promise.resolve(this.current as T); }
  onEvent(fn: (event: RemoteEvent) => void) { this.listener = fn; return () => { this.listener = undefined; }; }
  onReconnect(fn: (snapshot: Snapshot) => void) { this.reconnected = fn; return () => {}; }
  onDisconnect() { return () => {}; }
  close() {}
  emit(seq: number, event: RecordValue) { this.listener?.({ type: 'event', slotId: 'slot', seq, event }); }
}
function snapshot(busy = true): Snapshot {
  return { slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 }, state: {},
    entries: [], leafId: null, live: { busy, compacting: false, messages: [], tools: {}, steering: [], followUp: [] }, ui: [], seq: 0 };
}
function launch(t: any, initial = snapshot()) {
  const connection = new Connection(); connection.current = initial;
  const terminal = new FakeTerminal();
  const ui = new RemoteTui(connection, 'slot', initial, terminal);
  const finished = ui.run(); t.after(async () => { ui.detach(); await finished; });
  const host = new PresentationHost({ snapshot: () => ui.view.snapshot, tui: ui.tui,
    notify: () => {}, invalidate: () => { (ui as any).installEditor(); (ui as any).syncBottom(); } });
  ui.presentation = host;
  const rows = () => { ui.tui.renderNow(); return plain(ui.tui.getScreenLines()); };
  return { ui, connection, terminal, rows, controls: (host as any).context.ui };
}

function trackTimers(t: any) {
  const active = new Set<ReturnType<typeof setInterval>>();
  const set = globalThis.setInterval, clear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = set(...args); active.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer: ReturnType<typeof setInterval>) => { active.delete(timer); clear(timer); });
  return active;
}

test('public Loader border adapter matches native Pi spacing, frames and narrow widths', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  initTheme('dark', false);
  const tui = { requestRender() {} } as TUI;
  for (const options of [undefined, { frames: [] }, { frames: ['STATIC'] }, { frames: ['A', 'B'], intervalMs: 40 }]) {
    const local = new WorkingIndicator(tui, text => text, text => text, 'Working', options);
    const native = new WorkingStatusIndicator(tui, 'Working', options, (text: string) => text);
    try {
      for (const wait of [0, 40, 80]) {
        t.mock.timers.tick(wait);
        for (const width of [1, 2, 5, 12, 80]) {
          assert.deepEqual(local.render(width), native.render(width));
          assert.equal(local.renderInBorder(width), native.renderInBorder(width));
          assert.equal(local.renderSpinnerInBorder(width), native.renderSpinnerInBorder(width));
          assert.ok(local.render(width).every(line => visibleWidth(line) <= width));
        }
      }
    } finally { local.dispose(); native.dispose(); }
  }
});

test('default editor embeds the animated native status and preserves its frame on UI events', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const active = trackTimers(t);
  const { ui, connection, rows } = launch(t);
  assert.ok(rows().some(row => /^── ⠋ Working ─/.test(row)));
  assert.equal(active.size, 1);
  const indicator = (ui as any).working;
  t.mock.timers.tick(80);
  assert.ok(rows().some(row => /^── ⠙ Working ─/.test(row)));
  connection.emit(1, { type: 'queue_update', steering: ['queued'], followUp: [] });
  assert.equal((ui as any).working, indicator);
  assert.ok(rows().some(row => /^── ⠙ Working ─/.test(row)), 'normal events must not reset the spinner');
  connection.emit(2, { type: 'agent_end', willRetry: true });
  assert.equal((ui as any).working, indicator, 'remote agent_end is not a settled run');
  ui.detach(); assert.equal(active.size, 0);
  assert.equal(connection.requests.length, 0, 'animation and cleanup must not send remote commands');
});

test('separate status uses native blank rows and side padding before widgets and the editor', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { ui, rows, controls } = launch(t);
  ui.editor = new Editor(ui.tui, { borderColor: text => text, selectList: {} as any });
  controls.setWidget('above', ['above-editor widget']);
  const screen = rows();
  const index = screen.findIndex(row => /^ ⠋ Working /.test(row));
  assert.ok(index >= 0);
  assert.equal(screen[index - 1].trim(), '');
  assert.equal(screen[index + 1].trim(), '');
  assert.equal(screen[index + 2].trim(), 'above-editor widget');
  assert.ok(/^─/.test(screen[index + 3]));
  assert.ok(screen.every(row => visibleWidth(row) <= 80));
});

test('working controls update live messages, custom frames, spinner removal and visibility', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const active = trackTimers(t);
  const { ui, rows, controls, terminal } = launch(t);
  controls.setWorkingMessage('Working... (3s)');
  const options = { frames: ['FIRST', 'SECOND'], intervalMs: 40 };
  controls.setWorkingIndicator(options);
  assert.ok(rows().some(row => row.includes('FIRST Working... (3s)')));
  t.mock.timers.tick(40);
  assert.ok(rows().some(row => row.includes('SECOND Working... (3s)')));
  options.frames = ['STATIC']; controls.setWorkingIndicator(options);
  assert.ok(rows().some(row => row.includes('STATIC Working... (3s)')), 'a reused options object must still apply');
  assert.equal(active.size, 0);
  controls.setWorkingIndicator({ frames: [] });
  assert.equal(active.size, 0);
  assert.ok(rows().some(row => row.includes('Working... (3s)')));
  controls.setWorkingVisible(false);
  assert.ok(!rows().some(row => row.includes('Working... (3s)')));
  controls.setWorkingVisible(true);
  assert.ok(rows().some(row => row.includes('Working... (3s)')));
  controls.setWorkingMessage(); controls.setWorkingIndicator();
  assert.equal(active.size, 1);
  t.mock.timers.tick(80); controls.setWorkingIndicator();
  assert.ok(rows().some(row => /^── ⠋ Working ─/.test(row)), 'resetting default options must reset the animation');
  terminal.columns = 5; terminal.rows = 12;
  assert.ok(rows().every(row => visibleWidth(row) <= 5));
  ui.detach(); assert.equal(active.size, 0);
});

test('dialogs temporarily move the same indicator out of the editor border', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { ui, connection, rows } = launch(t);
  const indicator = (ui as any).working;
  t.mock.timers.tick(80);
  connection.emit(1, { type: 'extension_ui_request', id: 'dialog', method: 'input', title: 'Question' });
  assert.equal((ui as any).working, indicator);
  const screen = rows();
  const status = screen.findIndex(row => /^ ⠙ Working /.test(row));
  assert.ok(status >= 0 && status < screen.findIndex(row => row.includes('Question')));
  connection.emit(2, { type: 'remote_dialog_resolved', id: 'dialog' });
  assert.ok(rows().some(row => /^── ⠙ Working ─/.test(row)));
  assert.equal((ui as any).working, indicator);
});

test('editor factories move the same animated indicator between border and separate placement', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const active = trackTimers(t);
  const { ui, rows, controls } = launch(t);
  const indicator = (ui as any).working;
  const oldEditor = ui.editor;
  ui.editor.setText('draft');
  t.mock.timers.tick(80);
  controls.setEditorComponent((tui: any, theme: any, keys: any) => new CustomEditor(tui, theme, keys));
  assert.equal((oldEditor as any).workingStatusIndicator, undefined);
  assert.ok(rows().some(row => /^ ⠙ Working /.test(row)));
  assert.equal(ui.editor.getExpandedText(), 'draft');
  controls.setEditorComponent((tui: any, theme: any, keys: any) => new CustomEditor(tui, theme, keys, { embedWorkingStatus: true }));
  assert.ok(rows().some(row => /^── ⠙ Working ─/.test(row)));
  assert.equal((ui.editor as any).workingStatusIndicator, indicator);
  controls.setEditorComponent();
  assert.ok(rows().some(row => /^── ⠙ Working ─/.test(row)));
  assert.equal((ui as any).working, indicator);
  assert.equal(active.size, 1);
});

test('thinking-level changes update native embedded colors without resetting the spinner', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { ui, connection, rows, controls } = launch(t);
  (ui as any).localTheme = await loadLocalTheme('dark');
  controls.setEditorComponent((tui: any, theme: any, keys: any) => new CustomEditor(tui, theme, keys, { embedWorkingStatus: true }));
  const rawBorder = () => { rows(); return ui.tui.getScreenLines().find(row => stripTerminalSequences(row).startsWith('── '))!; };
  const off = rawBorder();
  const indicator = (ui as any).working;
  t.mock.timers.tick(80);
  connection.emit(1, { type: 'thinking_level_changed', level: 'high' });
  const high = rawBorder();
  assert.notEqual(high, off);
  assert.match(stripTerminalSequences(high), /^── ⠙ Working ─/);
  assert.equal((ui as any).working, indicator);
  assert.ok(high.includes((ui as any).localTheme.fg('thinkingHigh', '── ')));
});

test('settle and slot exit dispose the spinner; snapshot transitions stop extension timers too', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const active = trackTimers(t);
  const { ui, connection, rows } = launch(t);
  const dispatches: string[] = [];
  t.mock.method(ui.presentation!, 'dispatch', async (event: RecordValue) => { dispatches.push(event.type); });
  connection.current = snapshot(false); connection.current.seq = 1;
  connection.emit(1, { type: 'agent_settled' }); await flush();
  assert.equal(active.size, 0); assert.ok(!rows().some(row => /⠋|⠙/.test(row)));
  connection.emit(2, { type: 'agent_start' }); await flush();
  assert.equal(active.size, 1);
  connection.emit(3, { type: 'remote_slot_exit' }); await flush();
  assert.equal(active.size, 0); assert.equal(dispatches.at(-1), 'agent_settled');
  const busy = snapshot(true); busy.seq = 4; connection.reconnected?.(busy); await flush();
  assert.equal(active.size, 1); assert.ok(dispatches.includes('agent_start'));
  const idle = snapshot(false); idle.seq = 5; connection.reconnected?.(idle); await flush();
  assert.equal(active.size, 0); assert.equal(dispatches.at(-1), 'session_switch');
  assert.equal(dispatches.filter(type => type === 'agent_settled').length, 3);
});
