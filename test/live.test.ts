import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLiveEvent, captureLiveSnapshot, emptyLive } from '../src/live.js';

const assistant = () => ({ role: 'assistant', timestamp: 123, stopReason: 'pending', content: [] });

test('live state reconstructs delta-only text, thinking, and tool calls by content index', () => {
  const live = emptyLive();
  const message = assistant();
  applyLiveEvent(live, { type: 'agent_start' });
  applyLiveEvent(live, { type: 'message_start', message });
  const update = (type: string, contentIndex: number, fields = {}) => applyLiveEvent(live,
    { type: 'message_update', usage: { output: 4 }, assistantMessageEvent: { type, contentIndex, ...fields } });
  update('text_start', 0);
  update('text_delta', 0, { delta: 'hello ' });
  update('text_delta', 0, { delta: 'world\u2028' });
  update('thinking_start', 1);
  update('thinking_delta', 1, { delta: 'reason' });
  update('toolcall_start', 2, { id: 'tool-1', toolName: 'read' });
  update('toolcall_delta', 2, { delta: '{"path":' });
  update('toolcall_delta', 2, { delta: '"file"}' });
  assert.deepEqual(live.messages[0].content, [
    { type: 'text', text: 'hello world\u2028' },
    { type: 'thinking', thinking: 'reason' },
    { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {}, argumentText: '{"path":"file"}' },
  ]);
  update('text_end', 0, { content: 'authoritative text' });
  update('thinking_end', 1, { content: 'authoritative thinking' });
  const toolCall = { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'file' } };
  update('toolcall_end', 2, { toolCall });
  assert.deepEqual(live.messages[0].content, [
    { type: 'text', text: 'authoritative text' },
    { type: 'thinking', thinking: 'authoritative thinking' }, toolCall,
  ]);
  assert.deepEqual(live.messages[0].usage, { output: 4 });
  assert.deepEqual(message.content, [], 'Live reconstruction must not mutate source records');
  toolCall.arguments.path = 'changed';
  assert.equal(live.messages[0].content[2].arguments!.path, 'file');
});

test('authoritative message_end replaces the partial, and agent_end does not settle work', () => {
  const live = emptyLive();
  applyLiveEvent(live, { type: 'agent_start' });
  applyLiveEvent(live, { type: 'message_start', message: assistant() });
  applyLiveEvent(live, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
  const final = { ...assistant(), stopReason: 'stop', content: [{ type: 'text', text: 'complete' }] };
  applyLiveEvent(live, { type: 'message_end', message: final });
  assert.equal(live.messages.length, 1);
  assert.deepEqual(live.messages[0], final);
  final.content[0].text = 'changed';
  assert.equal(live.messages[0].content[0].text, 'complete');
  applyLiveEvent(live, { type: 'agent_end', willRetry: true, messages: [] });
  assert.equal(live.busy, true);
  applyLiveEvent(live, { type: 'agent_start' });
  assert.equal(live.messages.length, 1, 'Retry starts retain the active run display');
  applyLiveEvent(live, { type: 'agent_settled' });
  assert.equal(live.busy, false);
  applyLiveEvent(live, { type: 'agent_start' });
  assert.equal(live.messages.length, 1, 'New runs retain uncheckpointed messages after a failed or absent refresh');
  const checkpoint = captureLiveSnapshot(live);
  assert.deepEqual(checkpoint.state.messages, []);
  checkpoint.retire();
  assert.deepEqual(live.messages, []);
});

test('live state tracks tool lifecycle, compaction, and complete queue replacements', () => {
  const live = emptyLive();
  const start = { type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: { path: 'one' } };
  applyLiveEvent(live, start);
  start.args.path = 'changed';
  assert.equal(live.tools.call.args.path, 'one');
  applyLiveEvent(live, { type: 'tool_execution_update', toolCallId: 'call', partialResult: { content: ['partial'] } });
  assert.deepEqual(live.tools.call.partialResult.content, ['partial']);
  applyLiveEvent(live, { type: 'tool_execution_end', toolCallId: 'call', result: {} });
  assert.deepEqual(live.tools, {});
  applyLiveEvent(live, { type: 'compaction_start', reason: 'overflow' });
  assert.equal(live.compacting, true);
  applyLiveEvent(live, { type: 'compaction_end', aborted: true });
  assert.equal(live.compacting, false);
  applyLiveEvent(live, { type: 'queue_update', steering: ['a'], followUp: ['b'] });
  assert.deepEqual(live.steering, ['a']);
  assert.deepEqual(live.followUp, ['b']);
  applyLiveEvent(live, { type: 'queue_update' });
  assert.deepEqual(live.steering, []);
  assert.deepEqual(live.followUp, []);
});

test('orphan updates are ignored and tool result identities include toolCallId', () => {
  const live = emptyLive();
  applyLiveEvent(live, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'orphan' } });
  assert.deepEqual(live.messages, []);
  for (const toolCallId of ['one', 'two']) applyLiveEvent(live,
    { type: 'message_end', message: { role: 'toolResult', timestamp: 123, toolCallId, content: [] } });
  assert.equal(live.messages.length, 2);
});

test('a history snapshot retires completed occurrences of every role, not unfinished messages', () => {
  const live = emptyLive();
  const messages = [
    { role: 'system', timestamp: 1, content: 'system' },
    { role: 'user', timestamp: 2, content: 'user' },
    { role: 'custom', timestamp: 3, customType: 'background', content: 'complete' },
    { role: 'toolResult', timestamp: 4, toolCallId: 'call', content: [] },
    { role: 'assistant', timestamp: 5, stopReason: 'stop', content: [] },
  ];
  for (const message of messages) {
    applyLiveEvent(live, { type: 'message_start', message });
    applyLiveEvent(live, { type: 'message_end', message });
  }
  // Even a message with a terminal stopReason is unfinished until message_end arrives.
  const unfinished = { role: 'assistant', timestamp: 6, stopReason: 'stop', content: [] };
  applyLiveEvent(live, { type: 'message_start', message: unfinished });
  const checkpoint = captureLiveSnapshot(live);
  assert.deepEqual(checkpoint.state.messages, [unfinished]);
  assert.equal(live.messages.length, 6, 'Capture alone does not retire messages if validation fails');
  checkpoint.retire();
  assert.deepEqual(live.messages, [unfinished]);
  assert.notEqual(checkpoint.state.messages[0], live.messages[0]);
});

test('retirement excludes messages that finish or arrive after the snapshot cut', () => {
  const live = emptyLive();
  const old = { role: 'custom', customType: 'background', timestamp: 1, content: 'old' };
  const pending = assistant();
  applyLiveEvent(live, { type: 'message_end', message: old });
  applyLiveEvent(live, { type: 'message_start', message: pending });
  const checkpoint = captureLiveSnapshot(live);
  const final = { ...pending, stopReason: 'stop', content: [{ type: 'text', text: 'new' }] };
  applyLiveEvent(live, { type: 'message_end', message: final });
  applyLiveEvent(live, { type: 'message_end', message: { ...old, timestamp: 2 } });
  checkpoint.retire();
  assert.deepEqual(live.messages, [final, { ...old, timestamp: 2 }]);
  assert.deepEqual(checkpoint.state.messages, [pending], 'The snapshot is immutable across later events');
  assert.deepEqual(captureLiveSnapshot(live).state.messages, []);
});

test('identical same-millisecond custom notices remain separate occurrences', () => {
  const live = emptyLive();
  const message = { role: 'custom', timestamp: 1, customType: 'background', content: 'same', details: { id: 'task' } };
  for (let i = 0; i < 2; i++) {
    applyLiveEvent(live, { type: 'message_start', message });
    applyLiveEvent(live, { type: 'message_end', message });
  }
  assert.deepEqual(live.messages, [message, message]);
  const checkpoint = captureLiveSnapshot(live);
  assert.deepEqual(checkpoint.state.messages, []);
  // Reusing the exact payload after the cut must not cause it to be retired too.
  applyLiveEvent(live, { type: 'message_start', message });
  applyLiveEvent(live, { type: 'message_end', message });
  checkpoint.retire();
  assert.deepEqual(live.messages, [message]);
  // An incomplete snapshot can carry completed messages but no local WeakSet bookkeeping.
  const restored = structuredClone(live);
  applyLiveEvent(restored, { type: 'message_start', message });
  applyLiveEvent(restored, { type: 'message_end', message });
  assert.deepEqual(restored.messages, [message, message]);
});
