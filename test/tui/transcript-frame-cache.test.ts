import assert from 'node:assert/strict';
import test from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import type { Snapshot } from '../../src/protocol/types.js';
import { PresentationHost } from '../../src/tui/presentation.js';
import { Transcript } from '../../src/tui/transcript.js';
import { RemoteView } from '../../src/tui/view.js';

function setup(t: any) {
  initTheme('dark', false);
  const snapshot: Snapshot = {
    slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null, ui: [], seq: 0,
    live: { busy: true, compacting: false, tools: {}, steering: [], followUp: [],
      messages: [{ role: 'custom', customType: 'clock', display: true, content: 'custom', timestamp: 1 }] },
  };
  const view = new RemoteView(snapshot);
  const ui = { requestRender() {} } as TUI;
  const host = new PresentationHost({ snapshot: () => view.snapshot, tui: ui, notify() {}, invalidate() {} });
  let statusOnly = false, value = 'FIRST', renders = 0;
  let duringRender = () => {};
  host.messageRenderer = () => () => ({
    render() { renders++; duringRender(); return [value]; }, invalidate() {},
  });
  const transcript = new Transcript(view, ui, () => host, () => statusOnly);
  t.after(async () => { transcript.reset(); await host.shutdown(); });
  return { transcript, view, host, renders: () => renders,
    status: (status: boolean) => { statusOnly = status; },
    value: (next: string) => { value = next; },
    duringRender: (callback: () => void) => { duringRender = callback; } };
}
const plain = (transcript: Transcript, width = 80) => stripTerminalSequences(transcript.render(width).join('\n'));

test('status-only frames reuse the last layout; ordinary frames still evaluate dynamic renderers', t => {
  const f = setup(t);
  assert.match(plain(f.transcript), /FIRST/);
  assert.equal(f.renders(), 1);
  f.status(true); f.value('SECOND');
  assert.match(plain(f.transcript), /FIRST/);
  assert.equal(f.renders(), 1);
  f.status(false);
  assert.match(plain(f.transcript), /SECOND/);
  assert.equal(f.renders(), 2);
  f.status(true);
  assert.match(plain(f.transcript), /SECOND/);
  assert.equal(f.renders(), 2);
});

test('content changes, explicit invalidation and width/expansion/thinking changes discard cached layout', t => {
  const f = setup(t); plain(f.transcript); f.status(true);
  const refresh = (change: () => void, width = 80) => {
    const before = f.renders(); change(); plain(f.transcript, width);
    assert.ok(f.renders() > before);
  };
  refresh(() => { f.transcript.changed(); });
  refresh(() => { f.transcript.invalidate(); });
  refresh(() => {}, 40);
  refresh(() => { f.transcript.expanded = true; }, 40);
  refresh(() => { f.transcript.thinking = false; }, 40);
  refresh(() => { f.view.snapshot.state.sessionId = 'other-session'; }, 40);
  refresh(() => { f.transcript.reset(); }, 40);
  f.transcript.notify('NEW NOTICE');
  assert.match(plain(f.transcript, 40), /NEW NOTICE/);
});

test('notices emitted during rendering are not lost behind a status-frame cache', t => {
  const f = setup(t); f.status(true);
  f.duringRender(() => { f.duringRender(() => {}); f.transcript.notify('RENDER NOTICE'); });
  plain(f.transcript);
  assert.match(plain(f.transcript), /RENDER NOTICE/);
  assert.equal(f.renders(), 2);
});

test('loading avoids history construction, preserves updates and respects narrow widths', t => {
  const f = setup(t); f.transcript.setLoading(true);
  for (const width of [1, 20, 80]) {
    const lines = f.transcript.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.equal(f.renders(), 0);
  f.transcript.notify('PENDING NOTICE'); f.value('LOADED');
  f.transcript.setLoading(false); f.status(true);
  const output = plain(f.transcript);
  assert.match(output, /LOADED/); assert.match(output, /PENDING NOTICE/);
  assert.equal(f.renders(), 1);
});
