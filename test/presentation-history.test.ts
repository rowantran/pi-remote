import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadonlyHistory } from '../src/presentation-history.js';
import { PresentationHost } from '../src/presentation.js';
import type { RecordValue, Snapshot } from '../src/protocol.js';
import { activeBranch, messageKey, RemoteView } from '../src/view.js';

function snapshot(): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/remote', status: 'running', createdAt: '', clients: 1 },
    state: { sessionId: 'session', sessionName: 'name' },
    entries: [
      { type: 'session', id: 'session', version: 3, data: { nested: ['header'] } },
      { type: 'message', id: 'root', parentId: null, message: {
        role: 'user', timestamp: 10, content: [{ type: 'text', text: 'stored' }],
      } },
      { type: 'custom', id: 'other', parentId: 'root', data: { nested: ['other'] } },
      { type: 'custom', id: 'leaf', parentId: 'root', data: { nested: ['leaf'] } },
    ],
    leafId: 'leaf',
    live: { busy: true, compacting: false, messages: [{
      role: 'assistant', timestamp: 20, stopReason: 'pending', content: [{ type: 'text', text: 'live' }],
    }], tools: {}, steering: [], followUp: [] },
    ui: [], seq: 1,
  };
}
function apply(view: RemoteView, event: RecordValue): void {
  assert.equal(view.apply({ type: 'event', slotId: view.snapshot.slot.id, seq: view.snapshot.seq + 1, event }), true);
}
function assertFrozen(value: any, frozen: boolean): void {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), frozen);
  for (const child of Object.values(value)) assertFrozen(child, frozen);
}

// The value produced by the original facade, before caching, is the compatibility contract.
function uncachedBranch(s: Snapshot, leafId?: string): RecordValue[] {
  const branch = activeBranch(s.entries, leafId ?? s.leafId);
  if (leafId === undefined) {
    const seen = new Set(branch.filter(entry => entry.type === 'message').map(entry => messageKey(entry.message)));
    for (const message of s.live.messages) if (!seen.has(messageKey(message))) {
      branch.push({ type: 'message', id: `live:${messageKey(message)}`, message });
    }
  }
  return branch;
}

test('history copies protect nested data without freezing authoritative objects', () => {
  const s = snapshot(); const before = structuredClone(s); const history = new ReadonlyHistory();
  const entries = history.getEntries(s); const branch = history.getBranch(s);
  const root = history.getEntry(s, 'root')!; const header = history.getHeader(s)!;
  assertFrozen(entries, true); assertFrozen(branch, true); assertFrozen(s, false);
  assert.notEqual(entries, s.entries); assert.notEqual(root, s.entries[1]);
  assert.notEqual(root.message, s.entries[1].message);
  assert.notEqual(branch.at(-1)!.message, s.live.messages[0]);
  assert.throws(() => entries.push({}), TypeError);
  assert.throws(() => branch.splice(0, 1), TypeError);
  assert.throws(() => { root.message.content[0].text = 'changed'; }, TypeError);
  assert.throws(() => { header.data.nested[0] = 'changed'; }, TypeError);
  assert.throws(() => { branch.at(-1)!.message.content[0].text = 'changed'; }, TypeError);
  assert.throws(() => { branch.at(-1)!.id = 'changed'; }, TypeError);
  assert.deepEqual(s, before);
  assert.equal(history.getEntries(s), entries);
  assert.equal(history.getBranch(s), branch);
  assert.equal(history.getEntry(s, 'root'), entries[1]);
  assert.equal(history.getHeader(s), entries[0]);
  assert.equal(branch[0], entries[1]); assert.equal(branch[1], entries[3]);
  assert.equal(history.getEntry(s, 'missing'), undefined);
});

test('header and branch readers copy only the history objects they expose', () => {
  const s = snapshot(); const history = new ReadonlyHistory(); const copies = (history as any).copies;
  const header = history.getHeader(s);
  assert.equal(copies.has(s.entries[0]), true); assert.equal(copies.has(s.entries[1]), false);
  const root = history.getEntry(s, 'root');
  assert.equal(copies.has(s.entries[1]), true); assert.equal(copies.has(s.entries[2]), false);
  history.getBranch(s);
  assert.equal(copies.has(s.entries[2]), false, 'off-branch entries are not cloned by a branch reader');
  const entries = history.getEntries(s);
  assert.equal(entries[0], header); assert.equal(entries[1], root);
  assert.equal(copies.has(s.entries[2]), true);
});

test('history arrays survive unchanged element lists and unrelated sequence or metadata updates', () => {
  const view = new RemoteView(snapshot()); const history = new ReadonlyHistory();
  const entries = history.getEntries(view.snapshot); const branch = history.getBranch(view.snapshot);
  const explicit = history.getBranch(view.snapshot, 'leaf'); const header = history.getHeader(view.snapshot);
  for (const event of [
    { type: 'agent_settled' },
    { type: 'session_info_changed', name: 'new name' },
    { type: 'thinking_level_changed', level: 'high' },
    { type: 'extension_ui_request', method: 'setStatus', statusKey: 'progress', statusText: 'working' },
    { type: 'remote_state', state: { sessionId: 'session', sessionName: 'new name', thinkingLevel: 'high' } },
  ]) {
    apply(view, event);
    assert.equal(history.getEntries(view.snapshot), entries);
    assert.equal(history.getBranch(view.snapshot), branch);
    assert.equal(history.getBranch(view.snapshot, 'leaf'), explicit);
    assert.equal(history.getHeader(view.snapshot), header);
  }
  view.snapshot.entries = view.snapshot.entries.slice();
  view.snapshot.live.messages = view.snapshot.live.messages.slice();
  const newEnvelope = { ...view.snapshot, presentation: { gitBranch: 'new git branch' } };
  assert.equal(history.getEntries(newEnvelope), entries);
  assert.equal(history.getBranch(newEnvelope), branch);
});

test('same-array appends copy only new entries and reuse unchanged stored branches and live wrappers', () => {
  const view = new RemoteView(snapshot()); const history = new ReadonlyHistory();
  const source = view.snapshot.entries;
  const entries = history.getEntries(view.snapshot); const branch = history.getBranch(view.snapshot);
  const explicit = history.getBranch(view.snapshot, 'leaf'); const root = history.getBranch(view.snapshot, 'root');
  const header = history.getHeader(view.snapshot);
  apply(view, { type: 'entry_appended', entry: { type: 'custom', id: 'append', parentId: 'leaf', data: { new: ['value'] } } });
  assert.equal(view.snapshot.entries, source);
  const appended = history.getEntries(view.snapshot); const nextBranch = history.getBranch(view.snapshot);
  assert.notEqual(appended, entries); assert.equal(appended.length, entries.length + 1);
  entries.forEach((entry, i) => assert.equal(appended[i], entry));
  assert.equal(history.getEntry(view.snapshot, 'append'), appended.at(-1));
  assert.equal(history.getHeader(view.snapshot), header);
  assert.equal(history.getBranch(view.snapshot, 'leaf'), explicit);
  assert.equal(history.getBranch(view.snapshot, 'root'), root);
  assert.notEqual(nextBranch, branch);
  assert.equal(nextBranch[0], branch[0]); assert.equal(nextBranch[1], branch[1]);
  assert.equal(nextBranch[2], appended.at(-1)); assert.equal(nextBranch.at(-1), branch.at(-1));
  assertFrozen(appended.at(-1), true); assertFrozen(view.snapshot.entries.at(-1), false);
  apply(view, { type: 'entry_appended', entry: { type: 'custom', id: 'side-append', parentId: 'other' } });
  assert.notEqual(history.getEntries(view.snapshot), appended);
  assert.equal(history.getBranch(view.snapshot), nextBranch);
  assert.equal(history.getBranch(view.snapshot, 'leaf'), explicit);
});

test('same-array live replacements and deltas refresh only the changed synthetic entry', () => {
  const view = new RemoteView(snapshot()); const history = new ReadonlyHistory();
  apply(view, { type: 'message_start', message: { role: 'toolResult', toolCallId: 'tool', timestamp: 21, content: [] } });
  const source = view.snapshot.live.messages;
  const entries = history.getEntries(view.snapshot); const explicit = history.getBranch(view.snapshot, 'leaf');
  let previous = history.getBranch(view.snapshot);
  for (let i = 0; i < 10; i++) {
    apply(view, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '!' } });
    assert.equal(view.snapshot.live.messages, source);
    const branch = history.getBranch(view.snapshot);
    assert.notEqual(branch, previous); assert.notEqual(branch[2], previous[2]);
    assert.equal(branch[2].id, previous[2].id);
    assert.equal(branch[2].message.content[0].text, 'live' + '!'.repeat(i + 1));
    assert.equal(branch[3], previous[3]); assert.equal(branch[0], previous[0]);
    assert.equal(history.getEntries(view.snapshot), entries);
    assert.equal(history.getBranch(view.snapshot, 'leaf'), explicit);
    assert.equal(history.getBranch(view.snapshot), branch);
    previous = branch;
  }
  apply(view, { type: 'message_end', message: { role: 'assistant', timestamp: 20, stopReason: 'stop', content: [{ type: 'text', text: 'complete' }] } });
  const complete = history.getBranch(view.snapshot);
  assert.notEqual(complete[2], previous[2]); assert.equal(complete[3], previous[3]);
  assert.equal(complete[2].message.content[0].text, 'complete');
  assertFrozen(complete, true); assertFrozen(view.snapshot.live.messages, false);
  view.snapshot.live.messages = [];
  const stored = history.getBranch(view.snapshot);
  assert.deepEqual(stored, explicit); assert.equal(history.getBranch(view.snapshot), stored);
  assert.equal(history.getEntries(view.snapshot), entries);
});

test('explicit leaves preserve tree order while default branches merge and deduplicate live messages', () => {
  const s = snapshot(); const history = new ReadonlyHistory();
  s.live.messages.unshift(structuredClone(s.entries[1].message));
  s.live.messages.push({ role: 'toolResult', toolCallId: 'tool', timestamp: 21, content: [] });
  const branch = history.getBranch(s);
  assert.deepEqual(branch, uncachedBranch(s));
  assert.deepEqual(branch.map(entry => entry.id), ['root', 'leaf', `live:${messageKey(s.live.messages[1])}`, `live:${messageKey(s.live.messages[2])}`]);
  for (const leaf of ['root', 'other', 'leaf', 'missing', '']) {
    assert.deepEqual(history.getBranch(s, leaf), uncachedBranch(s, leaf));
    assert.equal(history.getBranch(s, leaf), history.getBranch(s, leaf));
  }
  assert.equal(history.getBranch(s), branch);
  // Changes to an already-persisted live message do not change the visible branch.
  s.live.messages[0] = { ...s.live.messages[0], content: [{ type: 'text', text: 'ignored live copy' }] };
  assert.equal(history.getBranch(s), branch);
  s.leafId = 'other';
  const other = history.getBranch(s);
  assert.deepEqual(other, uncachedBranch(s)); assert.notEqual(other, branch);
  assert.equal(other.at(-1), branch.at(-1));
  s.leafId = null;
  assert.deepEqual(history.getBranch(s), uncachedBranch(s));
  // The original explicit-null behavior selects the current leaf but excludes live data.
  s.leafId = 'leaf';
  assert.deepEqual(history.getBranch(s, null as any), uncachedBranch(s, null as any));
});

test('stored branches retain duplicate-ID, missing-parent and cycle behavior', () => {
  const s = snapshot(); const history = new ReadonlyHistory();
  s.entries.push({ id: 'root', type: 'custom', parentId: 'leaf', data: { latest: true } });
  assert.deepEqual(history.getBranch(s, 'leaf'), activeBranch(s.entries, 'leaf'));
  assert.equal(history.getEntry(s, 'root')!.type, 'message', 'getEntry keeps first-match semantics');
  s.entries.push({ id: 'orphan', type: 'custom', parentId: 'missing' });
  assert.deepEqual(history.getBranch(s, 'orphan'), activeBranch(s.entries, 'orphan'));
});

test('snapshot and session replacement with the same IDs never returns stale content', () => {
  const view = new RemoteView(snapshot()); const history = new ReadonlyHistory();
  const entries = history.getEntries(view.snapshot); const branch = history.getBranch(view.snapshot);
  const explicit = history.getBranch(view.snapshot, 'leaf');
  const replacement = snapshot();
  replacement.state.sessionId = 'new-session';
  replacement.entries[0].data.nested[0] = 'new header';
  replacement.entries[1].message.content[0].text = 'new stored';
  replacement.entries[3].data.nested[0] = 'new leaf';
  replacement.live.messages[0].content[0].text = 'new live';
  view.replace(replacement);
  const nextEntries = history.getEntries(view.snapshot); const nextBranch = history.getBranch(view.snapshot);
  assert.notEqual(nextEntries, entries); assert.notEqual(nextBranch, branch);
  nextEntries.forEach((entry, i) => assert.notEqual(entry, entries[i]));
  assert.equal(history.getHeader(view.snapshot)!.data.nested[0], 'new header');
  assert.equal(history.getEntry(view.snapshot, 'root')!.message.content[0].text, 'new stored');
  assert.equal(nextBranch.at(-1)!.message.content[0].text, 'new live');
  assert.notEqual(nextBranch.at(-1), branch.at(-1));
  assert.notEqual(history.getBranch(view.snapshot, 'leaf'), explicit);
  assert.deepEqual(nextBranch, uncachedBranch(view.snapshot));
  // A reconnect snapshot can replace content without changing the session ID either.
  replacement.live.messages[0].content[0].text = 'reconnected live';
  replacement.entries[3].data.nested[0] = 'reconnected leaf';
  view.replace(replacement);
  assert.equal(history.getBranch(view.snapshot).at(-1)!.message.content[0].text, 'reconnected live');
  assert.equal(history.getEntry(view.snapshot, 'leaf')!.data.nested[0], 'reconnected leaf');
  assertFrozen(view.snapshot, false);
});

test('history bounds explicit branch retention and drops retired sources on replacement and teardown', () => {
  const s = snapshot(); const history = new ReadonlyHistory();
  for (let i = 0; i < 50; i++) s.entries.push({ type: 'custom', id: `side-${i}`, parentId: 'root' });
  const defaultBranch = history.getBranch(s);
  for (const entry of s.entries) assert.deepEqual(history.getBranch(s, entry.id), uncachedBranch(s, entry.id));
  // Inspect ownership to test the memory bound without relying on nondeterministic garbage collection.
  const cache = history as any;
  assert.equal(cache.branches.size, 8);
  assert.equal(history.getBranch(s), defaultBranch, 'explicit-leaf cache eviction does not change default output');
  for (let i = 0; i < 50; i++) history.getBranch(s, `missing-${i}`);
  assert.equal(cache.branches.size, 8, 'unknown leaf IDs do not accumulate');
  const oldMessage = s.live.messages[0];
  for (let i = 0; i < 50; i++) {
    s.live.messages[0] = { ...oldMessage, content: [{ type: 'text', text: `version-${i}` }] };
    history.getBranch(s);
  }
  assert.ok(cache.copies instanceof WeakMap); assert.ok(cache.liveEntries instanceof WeakMap);
  assert.deepEqual(cache.defaultSources, s.live.messages);
  assert.equal(cache.defaultSources[0], s.live.messages[0], 'only the latest live source is strongly retained');
  s.entries = structuredClone(s.entries);
  history.getEntries(s);
  assert.equal(cache.branches.size, 0, 'replaced source leaves are retired even when IDs match');
  history.dispose();
  assert.equal(cache.branches.size, 0); assert.equal(cache.sources.length, 0);
  assert.equal(cache.defaultSources, undefined);
  assert.equal(cache.liveEntries.get(oldMessage), undefined);
  assert.deepEqual(history.getEntries(s), []); assert.deepEqual(history.getBranch(s), []);
});

test('presentation facade uses the history cache and releases it on shutdown', async () => {
  const view = new RemoteView(snapshot());
  const host = new PresentationHost({ snapshot: () => view.snapshot, tui: {} as any, notify() {}, invalidate() {} });
  // Inspect the same facade passed to extension callbacks, without loading an extension module.
  const manager = (host as any).context.sessionManager;
  try {
    const entries = manager.getEntries(); const branch = manager.getBranch();
    assert.equal(manager.getEntry('root'), entries[1]); assert.equal(manager.getHeader(), entries[0]);
    assertFrozen(branch, true);
    apply(view, { type: 'extension_ui_request', method: 'setStatus', statusKey: 'state', statusText: 'ready' });
    host.update(view.snapshot);
    assert.equal(manager.getEntries(), entries); assert.equal(manager.getBranch(), branch);
    apply(view, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '!' } });
    host.update(view.snapshot);
    assert.notEqual(manager.getBranch(), branch); assert.equal(manager.getEntries(), entries);
    await host.shutdown();
    assert.deepEqual(manager.getEntries(), []); assert.deepEqual(manager.getBranch(), []);
    assert.equal(manager.getEntry('root'), undefined); assert.equal(manager.getHeader(), undefined);
    assertFrozen(manager.getEntries(), true);
  } finally { await host.shutdown(); }
});
