import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotForCache, ReadOnlyConnection } from '../../src/web/client/cache.js';
import type { Snapshot } from '../../src/protocol/types.js';

test('cached display strips stale questions, queued prompts, and running work without changing the live view', () => {
  const original: Snapshot = { slot: { id: 'slot', cwd: '/work', createdAt: '', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null, seq: 4, historyComplete: true,
    live: { busy: true, compacting: true, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Saved answer', textSignature: 'PRIVATE_SIGNATURE' }] }],
      tools: { tool: { type: 'tool_execution_start' } }, steering: ['queued steering'], followUp: ['queued follow-up'] },
    ui: [{ id: 'question', method: 'input', title: 'A live question' }, { id: 'draft', method: 'set_editor_text', text: 'Remote draft' },
      { method: 'setStatus', statusKey: 'test', statusText: 'Kept display status' }] };
  const before = structuredClone(original);
  Object.freeze(original); Object.freeze(original.live); Object.freeze(original.ui);
  const cached = snapshotForCache(original);
  assert.deepEqual(original, before, 'caching must not clear the live dialog or running-state objects');
  assert.deepEqual(cached.live, { busy: false, compacting: false, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Saved answer' }] }], tools: {}, steering: [], followUp: [] });
  assert.deepEqual(cached.ui, [{ method: 'setStatus', statusKey: 'test', statusText: 'Kept display status' }]);
  assert.equal(cached.seq, 4);
  assert.equal(cached.historyComplete, true);
});

test('a cached transcript cannot submit prompts, dialog responses, or remote reads', async () => {
  const connection = new ReadOnlyConnection();
  await assert.rejects(connection.request('rpc', { slotId: 'slot', command: { type: 'prompt', message: 'must not run' } }), /Nothing was sent/);
  await assert.rejects(connection.request('answer', { slotId: 'slot', response: { id: 'old-dialog', value: 'must not answer' } }), /Nothing was sent/);
  await assert.rejects(connection.request('snapshot', { slotId: 'slot' }), /Cached transcript only/);
  let disconnected = false;
  connection.onDisconnect(() => { disconnected = true; });
  await Promise.resolve(); assert.equal(disconnected, true);
});
