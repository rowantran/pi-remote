import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyLive } from '../src/live.js';
import type { RecordValue, RemoteEvent, Snapshot } from '../src/protocol.js';
import { HistoryMismatchError, RemoteView, transcriptMessages } from '../src/view.js';

function entry(id: string, parentId: string | null, role = 'user'): RecordValue {
  return { type: 'message', id, parentId, timestamp: '2026-01-01',
    message: { role, timestamp: 1, content: [{ type: 'text', text: id }] } };
}
function snapshot(entries: RecordValue[], overrides: Partial<Snapshot> = {}): Snapshot {
  return { slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: { sessionId: 'session' }, entries, leafId: entries.at(-1)?.id ?? null,
    live: emptyLive(), ui: [], seq: 1, historyComplete: true, ...overrides };
}
function event(seq: number, value: RecordValue): RemoteEvent {
  return { type: 'event', slotId: 'slot', seq, event: value };
}

test('merges history deltas without cloning the retained prefix or mutating the wire reply', () => {
  const view = new RemoteView(snapshot([entry('u', null)]));
  const prefix = view.snapshot.entries[0];
  const cursor = view.historyCursor()!;
  assert.deepEqual(cursor, { sessionId: 'session', entryId: 'u' });
  const delta = snapshot([entry('a', 'u', 'assistant')], { historyDelta: cursor, seq: 2 });
  view.replace(delta);
  assert.equal(view.snapshot.entries[0], prefix);
  assert.deepEqual(view.snapshot.entries.map(e => e.id), ['u', 'a']);
  assert.equal(view.snapshot.historyDelta, undefined);
  assert.equal(delta.entries.length, 1);
  assert.deepEqual(view.historyCursor(), { sessionId: 'session', entryId: 'a' });
  view.replace(snapshot([], { historyDelta: view.historyCursor(), leafId: 'u', seq: 3 }));
  assert.equal(view.snapshot.entries.length, 2);
  assert.equal(view.snapshot.leafId, 'u', 'The cursor follows file order, not the active branch');
});

test('live entries do not advance the checkpoint or reorder/duplicate a delta', () => {
  const view = new RemoteView(snapshot([entry('u', null)]));
  const liveEntry = entry('notice', 'a');
  liveEntry.type = 'custom_message'; liveEntry.customType = 'background'; liveEntry.content = 'notice';
  delete liveEntry.message;
  view.apply(event(2, { type: 'entry_appended', entry: liveEntry }));
  assert.deepEqual(view.historyCursor(), { sessionId: 'session', entryId: 'u' });
  const newer = event(5, { type: 'entry_appended', entry: entry('next', 'notice') });
  view.apply(newer);
  view.replace(snapshot([entry('a', 'u', 'assistant'), liveEntry], {
    historyDelta: view.historyCursor(), seq: 4, leafId: 'notice',
  }), [event(2, { type: 'entry_appended', entry: liveEntry }), newer]);
  assert.deepEqual(view.snapshot.entries.map(e => e.id), ['u', 'a', 'notice', 'next']);
  assert.deepEqual(view.historyCursor(), { sessionId: 'session', entryId: 'notice' });
  assert.equal(view.snapshot.seq, 5);
});

test('checkpoint/tail merging retains identical completed occurrences and replays post-cut work', () => {
  const notice = { type: 'custom_message', id: 'one', parentId: null, timestamp: '2026-01-01',
    customType: 'background', content: 'same' };
  const view = new RemoteView(snapshot([notice]));
  const partial = { role: 'assistant', timestamp: 10, stopReason: 'pending', content: [] };
  const reply = snapshot([{ ...notice, id: 'two', parentId: 'one' }], {
    historyDelta: view.historyCursor(), live: { ...emptyLive(), busy: true, messages: [partial] }, seq: 3,
  });
  view.replace(reply, [event(4, { type: 'message_update', assistantMessageEvent: {
    type: 'text_delta', contentIndex: 0, delta: 'new text',
  } })]);
  const messages = transcriptMessages(view.snapshot);
  assert.equal(messages.filter(m => m.content === 'same').length, 2);
  assert.equal(messages.at(-1)!.content[0].text, 'new text');
});

test('mismatched deltas leave the view untouched and require a full replacement', () => {
  const view = new RemoteView(snapshot([entry('u', null)]));
  const before = view.snapshot;
  for (const overrides of [
    { historyDelta: { sessionId: 'session', entryId: 'missing' } },
    { historyDelta: { sessionId: 'other', entryId: 'u' } },
    { historyDelta: view.historyCursor(), state: { sessionId: 'other' } },
    { historyDelta: view.historyCursor(), historyComplete: false },
    { historyDelta: view.historyCursor(), slot: { ...before.slot, id: 'other' } },
  ]) {
    assert.throws(() => view.replace(snapshot([], overrides)), HistoryMismatchError);
    assert.equal(view.snapshot, before);
  }
  view.invalidateHistory();
  assert.equal(view.historyCursor(), undefined);
  assert.equal(view.hasCompleteHistory(), false);
  assert.throws(() => view.replace(snapshot([], { historyDelta: { sessionId: 'session', entryId: 'u' } })), HistoryMismatchError);
  view.replace(snapshot([entry('restored', null)]));
  assert.equal(view.hasCompleteHistory(), true);
  assert.equal(view.historyCursor()!.entryId, 'restored');
});

test('full replacements, legacy replies, empty history and transitions do not reuse old checkpoints', () => {
  const view = new RemoteView(snapshot([entry('u', null)]));
  view.apply(event(2, { type: 'remote_state', state: { sessionId: 'new' } }));
  assert.equal(view.historyCursor(), undefined);
  assert.equal(view.hasCompleteHistory(), false);
  view.replace(snapshot([], { state: { sessionId: 'new' } }));
  assert.equal(view.hasCompleteHistory(), true);
  assert.equal(view.historyCursor(), undefined);
  view.replace(snapshot([entry('fresh', null)], { state: { sessionId: 'new' } }));
  assert.deepEqual(view.snapshot.entries.map(e => e.id), ['fresh']);
  view.replace(snapshot([entry('fresh', null)], { historyComplete: false }));
  assert.equal(view.hasCompleteHistory(), false);
  view.replace(snapshot([entry('legacy', null)], { historyComplete: undefined }));
  assert.equal(view.historyCursor(), undefined);
  assert.equal(view.hasCompleteHistory(), false);
});
