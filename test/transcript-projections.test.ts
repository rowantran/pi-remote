import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, Text, type Component, type TUI } from '@earendil-works/pi-tui';
import { PresentationHost } from '../src/presentation.js';
import type { RecordValue, Snapshot } from '../src/protocol.js';
import { Transcript } from '../src/transcript.js';
import { messageKey, RemoteView, transcriptMessages } from '../src/view.js';

function snapshot(): Snapshot {
  const entries: RecordValue[] = [];
  function append(entry: RecordValue): void { entries.push({ parentId: entries.at(-1)?.id ?? null, ...entry }); }
  append({ id: 'user', type: 'message', message: { role: 'user', timestamp: 1, content: 'Fixture user' } });
  append({ id: 'custom', type: 'custom_message', timestamp: '2026-01-01T00:00:00.000Z', customType: 'fixture-note', display: true,
    content: '# Fixture custom\n\n*one*', details: { nested: [1] }, customData: { n: 2 } });
  append({ id: 'hidden', type: 'custom_message', timestamp: 3, customType: 'fixture-hidden', display: false, content: 'Fixture hidden' });
  append({ id: 'compaction', type: 'compaction', timestamp: 4, tokensBefore: 100,
    summary: '# Fixture compaction\n\n- one\n- two', customData: { n: 3 } });
  append({ id: 'branch', type: 'branch_summary', timestamp: 5, fromId: 'other', summary: '# Fixture branch\n\n**one**' });
  append({ id: 'state', type: 'custom', timestamp: 6, customType: 'fixture-state', data: { n: 7, nested: [8] } });
  append({ id: 'model', type: 'model_change', timestamp: 7, modelId: 'fixture' });
  return {
    slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 }, state: { sessionId: 'session' },
    entries, leafId: 'model', ui: [], seq: 0,
    live: { busy: true, compacting: false, tools: {}, steering: [], followUp: [], messages: [{
      role: 'assistant', timestamp: 10, api: 'test', provider: 'test', model: 'test', stopReason: 'pending',
      content: [{ type: 'text', text: 'Fixture live' }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }] },
  };
}

class ProjectionHost extends PresentationHost {
  revision = 0;
  entryFactories = 0;
  entryRenders = 0;
  override get rendererRevision(): number { return this.revision; }
  override renderEntry(entry: RecordValue, options: { expanded: boolean }): Component {
    this.entryFactories++;
    const text = new Text(`${entry.data.n}:${options.expanded ? 1 : 0}`, 0, 0);
    return { render: width => { this.entryRenders++; return text.render(width); }, invalidate: () => text.invalidate() };
  }
}
function setup(t: TestContext) {
  initTheme('dark', false);
  const view = new RemoteView(snapshot()); const ui = { requestRender() {} } as TUI;
  const host = new ProjectionHost({ snapshot: () => view.snapshot, tui: ui, notify() {}, invalidate() {} });
  const transcript = new Transcript(view, ui, () => host); transcript.expanded = true;
  const markdown = new Map<Markdown, { renders: number; misses: number }>();
  const original = Markdown.prototype.render;
  t.mock.method(Markdown.prototype, 'render', function(this: Markdown, width: number) {
    const component = this as any;
    const counts = markdown.get(this) ?? { renders: 0, misses: 0 };
    counts.renders++;
    if (!component.cachedLines || component.cachedText !== component.text || component.cachedWidth !== width) counts.misses++;
    markdown.set(this, counts); return original.call(this, width);
  });
  function apply(event: RecordValue): void {
    assert.equal(view.apply({ type: 'event', slotId: 'slot', seq: view.snapshot.seq + 1, event }), true);
    host.update(view.snapshot); transcript.changed(); transcript.render(80);
  }
  return { view, ui, host, transcript, markdown, apply, async close() { transcript.reset(); await host.shutdown(); } };
}
interface CachedMessage { source: RecordValue; component: Component }
function derivedRecords(transcript: Transcript): Map<string, CachedMessage> {
  const records = (transcript as any).messages as Map<string, CachedMessage>;
  return new Map([...records.values()].filter(record => record.source.id).map(record => [record.source.id, record]));
}

test('optional entry projections preserve order, timestamps, display flags, custom data, and live deduplication', () => {
  const s = snapshot(); const cache = new WeakMap<RecordValue, RecordValue>();
  const first = transcriptMessages(s, cache); const second = transcriptMessages(s, cache);
  assert.notEqual(second, first, 'reconciliation still produces a current message list');
  assert.deepEqual(first, transcriptMessages(s));
  assert.deepEqual(first.map(message => message.role), ['user', 'custom', 'custom', 'compactionSummary', 'branchSummary', 'entry', 'assistant']);
  first.forEach((message, i) => assert.equal(message, second[i]));
  assert.equal(first[0], s.entries[0].message); assert.equal(first.at(-1), s.live.messages[0]);
  assert.equal(first[1].timestamp, Date.parse(s.entries[1].timestamp));
  assert.equal(first[1].display, true); assert.equal(first[2].display, false);
  assert.deepEqual(first[1].customData, { n: 2 }); assert.deepEqual(first[1].details, { nested: [1] });
  assert.deepEqual(first[3].customData, { n: 3 }); assert.equal(first[4].fromId, 'other');
  assert.deepEqual(first[5].data, { n: 7, nested: [8] });
  assert.equal(first[5].content, 'Session entry: fixture-state (renderer not loaded)');
  assert.equal(cache.has(s.entries[0]), false); assert.equal(cache.has(s.entries.at(-1)!), false);
  for (const entry of s.entries.slice(1, -1)) assert.equal(cache.has(entry), true);
  const live = { role: 'custom', timestamp: first[1].timestamp, customType: 'fixture-note', content: 'Fixture authoritative', display: false };
  s.live.messages.unshift(live);
  const deduped = transcriptMessages(s, cache);
  assert.deepEqual(deduped, transcriptMessages(s)); assert.equal(deduped.length, first.length);
  assert.equal(deduped[1], live); assert.equal(cache.get(s.entries[1]), first[1]);
  assert.equal(cache.has(live), false, 'live messages never enter the entry projection cache');
  s.live.messages[0] = { ...live, content: 'Fixture replacement' };
  assert.equal(transcriptMessages(s, cache)[1], s.live.messages[0]);
});

test('uncached public projections remain fresh for mutable callers and preserve non-ISO timestamps', () => {
  const s = snapshot(); s.entries[1].timestamp = 'not-a-date';
  const before = transcriptMessages(s); const again = transcriptMessages(s);
  assert.notEqual(before[1], again[1]); assert.notEqual(before[3], again[3]);
  assert.equal(before[1].timestamp, 'not-a-date'); assert.equal(before[2].timestamp, 3);
  s.entries[1].content = 'Fixture changed'; s.entries[3].summary = 'Fixture changed summary';
  s.entries[5].customType = 'new-type';
  const changed = transcriptMessages(s);
  assert.equal(changed[1].content, 'Fixture changed'); assert.equal(changed[3].summary, 'Fixture changed summary');
  assert.equal(changed[5].content, 'Session entry: new-type (renderer not loaded)');
  assert.notEqual(changed[1].content, before[1].content); assert.notEqual(changed[3].summary, before[3].summary);
});

test('metadata and assistant-text deltas reuse derived wrappers, components, and historical Markdown caches', async t => {
  const state = setup(t);
  try {
    state.transcript.render(80);
    const before = derivedRecords(state.transcript);
    const markdown = new Map([...state.markdown].map(([component, counts]) => [component, { ...counts }]));
    const factories = state.host.entryFactories; const renders = state.host.entryRenders;
    assert.equal(before.size, 5); assert.ok(markdown.size >= 4);
    state.apply({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'progress', statusText: 'ready' });
    assert.equal(state.markdown.size, markdown.size);
    for (const [component, counts] of markdown) {
      assert.equal(state.markdown.get(component)!.misses, counts.misses);
      assert.ok(state.markdown.get(component)!.renders > counts.renders);
    }
    state.apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '!' } });
    for (const [id, record] of before) {
      const current = derivedRecords(state.transcript).get(id)!;
      assert.equal(current.source, record.source); assert.equal(current.component, record.component);
    }
    for (const [component, counts] of markdown) assert.equal(state.markdown.get(component)!.misses, counts.misses);
    assert.equal(state.markdown.size, markdown.size + 1, 'only the changed assistant creates new Markdown');
    assert.equal(state.host.entryFactories, factories);
    assert.ok(state.host.entryRenders > renders, 'cached components still render; there is no whole-render cache');
  } finally { await state.close(); }
});

test('each Transcript owns separate stable derived projections and clears them on reset', async t => {
  const state = setup(t); const second = new Transcript(state.view, state.ui, () => state.host); second.expanded = true;
  try {
    state.transcript.render(80); second.render(80);
    const firstRecords = derivedRecords(state.transcript); const secondRecords = derivedRecords(second);
    for (const [id, record] of firstRecords) {
      assert.notEqual(record.source, secondRecords.get(id)!.source);
      assert.notEqual(record.component, secondRecords.get(id)!.component);
    }
    state.apply({ type: 'agent_settled' }); second.changed(); second.render(80);
    for (const [id, record] of secondRecords) assert.equal(derivedRecords(second).get(id)!.source, record.source);
    const oldCache = (state.transcript as any).derivedMessages;
    state.transcript.reset();
    const cache = (state.transcript as any).derivedMessages;
    assert.ok(cache instanceof WeakMap); assert.notEqual(cache, oldCache);
    assert.equal(cache.get(state.view.snapshot.entries[1]), undefined);
    state.transcript.render(80);
    for (const [id, record] of firstRecords) {
      assert.notEqual(derivedRecords(state.transcript).get(id)!.source, record.source);
      assert.notEqual(derivedRecords(state.transcript).get(id)!.component, record.component);
    }
  } finally { second.reset(); await state.close(); }
});

test('snapshot replacement with the same entry IDs creates fresh projections and components', async t => {
  const state = setup(t);
  try {
    state.transcript.render(80); const before = derivedRecords(state.transcript);
    const replacement = snapshot();
    replacement.entries[1].content = 'Fixture replaced custom'; replacement.entries[1].details.nested = [9];
    replacement.entries[3].summary = 'Fixture replaced summary'; replacement.entries[5].data.n = 11;
    state.view.replace(replacement); state.host.update(state.view.snapshot); state.transcript.changed();
    const lines = state.transcript.render(80); const after = derivedRecords(state.transcript);
    for (const [id, record] of before) {
      assert.notEqual(after.get(id)!.source, record.source); assert.notEqual(after.get(id)!.component, record.component);
    }
    assert.equal(after.get('custom')!.source.content, replacement.entries[1].content);
    assert.deepEqual(after.get('custom')!.source.details, { nested: [9] });
    assert.equal(after.get('compaction')!.source.summary, replacement.entries[3].summary);
    assert.equal(after.get('state')!.source.data.n, 11);
    assert.ok(lines.some(line => line.includes('Fixture replaced summary')));
    state.apply({ type: 'session_info_changed', name: 'metadata' });
    assert.equal(derivedRecords(state.transcript).get('compaction')!.component, after.get('compaction')!.component);
  } finally { await state.close(); }
});

test('entry appends and branch changes reconcile current order without replacing unchanged projections', async t => {
  const state = setup(t);
  try {
    state.transcript.render(80); const before = derivedRecords(state.transcript);
    state.apply({ type: 'entry_appended', entry: { id: 'append', parentId: 'model', type: 'custom_message', timestamp: 20,
      customType: 'fixture-append', display: true, content: 'Fixture appended' } });
    const after = derivedRecords(state.transcript);
    for (const [id, record] of before) assert.equal(after.get(id)!.source, record.source);
    assert.ok(after.has('append'));
    const cache = (state.transcript as any).derivedMessages as WeakMap<RecordValue, RecordValue>;
    const projected = transcriptMessages(state.view.snapshot, cache);
    assert.deepEqual(projected, transcriptMessages(state.view.snapshot));
    assert.equal(projected.at(-2)!.id, 'append');
    state.view.snapshot.leafId = 'custom'; state.transcript.changed(); state.transcript.render(80);
    assert.equal(derivedRecords(state.transcript).size, 1);
    assert.equal(derivedRecords(state.transcript).get('custom')!.source, before.get('custom')!.source);
    const records = (state.transcript as any).messages as Map<string, CachedMessage>;
    assert.equal(records.has(messageKey(before.get('compaction')!.source)), false);
  } finally { await state.close(); }
});

test('layout and renderer changes still recreate components rather than bypassing reconciliation', async t => {
  const state = setup(t);
  try {
    state.transcript.render(80); let before = derivedRecords(state.transcript);
    for (const change of [
      () => { state.transcript.expanded = false; },
      () => { state.transcript.thinking = false; },
      () => { state.host.hiddenThinkingLabel = 'Fixture label'; },
    ]) {
      change(); state.transcript.render(80);
      const after = derivedRecords(state.transcript);
      for (const [id, record] of before) {
        assert.equal(after.get(id)!.source, record.source); assert.notEqual(after.get(id)!.component, record.component);
      }
      before = after;
    }
    const oldCache = (state.transcript as any).derivedMessages;
    state.host.revision++; state.transcript.render(80);
    assert.notEqual((state.transcript as any).derivedMessages, oldCache);
    const after = derivedRecords(state.transcript);
    for (const [id, record] of before) {
      assert.notEqual(after.get(id)!.source, record.source); assert.notEqual(after.get(id)!.component, record.component);
    }
  } finally { await state.close(); }
});
