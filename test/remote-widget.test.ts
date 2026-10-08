import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TUI } from '@earendil-works/pi-tui';
import { PresentationHost, type PresentationUIContext } from '../src/presentation.js';
import type { Snapshot } from '../src/protocol.js';
import { RemoteView } from '../src/view.js';

function snapshot(): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null, seq: 0, ui: [],
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
  };
}

test('presentation adapters read sanitized immutable remote widgets, independently of local overrides', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-widget-api-'));
  const key = Symbol.for('pi-remote.test.remote-widget-ui');
  t.after(async () => { delete (globalThis as any)[key]; await rm(dir, { recursive: true }); });
  const fixture = join(dir, 'capture.ts');
  await writeFile(fixture, `export default function(pi) {
    pi.on('session_start', (_, ctx) => {
      globalThis[Symbol.for('pi-remote.test.remote-widget-ui')] = ctx.ui;
      ctx.ui.setWidget('tasks', ['local replacement'], { placement: 'belowEditor' });
    });
  }`);
  const initial = snapshot();
  const remoteLines = ['\x1b[31mRemote red\x1b[0m', '\x1b]52;c;payload\x07task\x1b[2J\x1b[H\x01'];
  initial.ui = [
    { method: 'setWidget', widgetKey: 'tasks', widgetLines: remoteLines, widgetPlacement: 'belowEditor', privateData: { secret: true } },
    { method: 'setWidget', widgetKey: 'default', widgetLines: ['above'] },
    { method: 'setStatus', statusKey: 'not-a-widget', statusText: 'status' },
  ];
  const view = new RemoteView(initial);
  const notices: string[] = [];
  let invalidations = 0;
  const host = new PresentationHost({ snapshot: () => view.snapshot,
    tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } } as TUI,
    notify: text => notices.push(text), invalidate() { invalidations++; } });
  t.after(() => host.shutdown());
  await host.load([fixture]); await host.start();
  const ui = (globalThis as any)[key] as PresentationUIContext;
  const widget = ui.getRemoteWidget('tasks')!;
  assert.deepEqual(widget, { key: 'tasks', lines: ['Remote red', 'task'], placement: 'belowEditor' });
  assert.ok(Object.isFrozen(widget)); assert.ok(Object.isFrozen(widget.lines));
  assert.throws(() => (widget.lines as string[]).push('injected'), TypeError);
  assert.throws(() => { (widget as any).placement = 'aboveEditor'; }, TypeError);
  assert.deepEqual(view.snapshot.ui[0].widgetLines, remoteLines, 'Wire data is not rewritten');
  assert.equal(host.widgets.get('tasks')!.component.render(80)[0].trimEnd(), 'local replacement');
  assert.equal(ui.getRemoteWidget('default')!.placement, 'aboveEditor');
  assert.equal(ui.getRemoteWidget('missing'), undefined);
  assert.equal(ui.getRemoteWidget('not-a-widget'), undefined);

  const before = invalidations;
  view.apply({ type: 'event', slotId: 'slot', seq: 1, event: {
    type: 'extension_ui_request', method: 'setWidget', widgetKey: 'tasks', widgetLines: ['new task'],
  } });
  host.update(view.snapshot);
  assert.ok(invalidations > before);
  assert.deepEqual(ui.getRemoteWidget('tasks'), { key: 'tasks', lines: ['new task'], placement: 'aboveEditor' });
  assert.deepEqual(widget.lines, ['Remote red', 'task'], 'Previously returned data is a detached copy');
  view.apply({ type: 'event', slotId: 'slot', seq: 2, event: {
    type: 'extension_ui_request', method: 'setWidget', widgetKey: 'tasks',
  } });
  host.update(view.snapshot);
  assert.equal(ui.getRemoteWidget('tasks'), undefined, 'Clear events count as absent before the next full snapshot');

  const multiline = snapshot();
  multiline.ui = [{ method: 'setWidget', widgetKey: 'tasks',
    widgetLines: ['a\nb', 'c\r\nd', 't\tx', 'u\u2028v', 'w\u2029z'] }];
  host.update(multiline);
  assert.deepEqual(ui.getRemoteWidget('tasks')!.lines, ['a', 'b', 'c', 'd', 't x', 'u', 'v', 'w', 'z']);
  assert.ok(ui.getRemoteWidget('tasks')!.lines.every(line => !/[\n\r\t\u2028\u2029]/.test(line)));

  const restored = snapshot(); restored.seq = 10;
  restored.ui = [{ method: 'setWidget', widgetKey: 'tasks', widgetLines: ['restored'], widgetPlacement: 'belowEditor' }];
  view.replace(restored); host.update(view.snapshot);
  assert.deepEqual(ui.getRemoteWidget('tasks')!.lines, ['restored'], 'Existing contexts read replacement snapshots');
  restored.ui = []; host.update(restored);
  assert.equal(ui.getRemoteWidget('tasks'), undefined);

  for (const badLines of [undefined, null, '', [], [123], ['valid', null]]) {
    restored.ui = [{ method: 'setWidget', widgetKey: 'tasks', widgetLines: badLines }]; host.update(restored);
    assert.equal(ui.getRemoteWidget('tasks'), undefined);
  }
  assert.deepEqual(notices, []);
});
