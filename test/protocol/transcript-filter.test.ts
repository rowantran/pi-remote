import assert from 'node:assert/strict';
import test from 'node:test';
import { filterEvent, filterSnapshot } from '../../src/protocol/transcript-filter.js';
import type { RecordValue, Snapshot } from '../../src/protocol/types.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assistantPair(): { message: RecordValue; displayed: RecordValue } {
  const nested = {
    thinkingSignature: 'nested thinking', textSignature: 'nested text',
    message: { role: 'assistant', content: [{ type: 'text', textSignature: 'nested message' }] },
  };
  const content = [
    { type: 'thinking', thinking: 'reason', thinkingSignature: 'private thinking', textSignature: 'keep on thinking', redacted: true, unknown: nested },
    { type: 'text', text: 'answer', textSignature: 'private text', thinkingSignature: 'keep on text', redacted: false, unknown: nested },
    { type: 'toolCall', id: 'call-1', name: 'read', arguments: nested, thinkingSignature: 'tool thinking', textSignature: 'tool text' },
    { type: 'future', thinkingSignature: 'future thinking', textSignature: 'future text', payload: nested },
    { type: 'image', data: 'image data', thinkingSignature: 'image thinking', textSignature: 'image text' },
    { type: 'thinking', thinking: '', redacted: false },
    { type: 'text', text: '' },
    null, 'opaque block', 42, ['opaque array', nested],
  ];
  const message = {
    role: 'assistant', timestamp: 123, stopReason: 'stop', model: 'model',
    thinkingSignature: 'message-level thinking', textSignature: 'message-level text',
    usage: { input: 2, output: 3 }, unknown: nested, content,
  };
  const displayed = {
    ...message,
    content: [
      { type: 'thinking', thinking: 'reason', textSignature: 'keep on thinking', redacted: true, unknown: nested },
      { type: 'text', text: 'answer', thinkingSignature: 'keep on text', redacted: false, unknown: nested },
      ...content.slice(2),
    ],
  };
  return { message, displayed };
}

function snapshot(entries: RecordValue[], messages: RecordValue[] = []): Snapshot & RecordValue {
  return {
    slot: { id: 'slot', cwd: '/workspace', createdAt: '2026-01-01', status: 'running', clients: 2 },
    state: { sessionId: 'session', unknown: { textSignature: 'state data' } },
    entries, historyDelta: { sessionId: 'session', entryId: 'checkpoint' },
    leafId: 'leaf', seq: 57, historyComplete: false,
    live: {
      busy: true, compacting: false, messages,
      tools: { 'call-1': { arguments: { textSignature: 'tool argument' }, result: { details: { thinkingSignature: 'tool result' } } } },
      steering: ['steer'], followUp: ['next'], bash: { command: { textSignature: 'bash data' } },
    },
    ui: [{ type: 'custom', textSignature: 'ui data' }],
    presentation: { stats: { thinkingSignature: 'stats data' }, gitBranch: 'main', unknown: { textSignature: 'presentation data' } },
    unknown: { textSignature: 'snapshot data' },
  };
}

test('filterSnapshot removes only matching assistant block signatures and preserves the frozen graph', () => {
  const { message, displayed } = assistantPair();
  const user = { ...message, role: 'user' };
  const custom = { ...message, role: 'custom', customType: 'notice', details: message.unknown };
  const toolResult = { ...message, role: 'toolResult', toolCallId: 'call-1', details: message.unknown };
  const entries = [
    { type: 'session', id: 'root', parentId: null, thinkingSignature: 'entry data' },
    { type: 'message', id: 'user', parentId: 'root', message: user },
    { type: 'message', id: 'assistant', parentId: 'user', message, timestamp: 'timestamp', unknown: message },
    { type: 'custom', id: 'custom', parentId: 'assistant', message, data: message.unknown, textSignature: 'custom entry data' },
    { type: 'message', id: 'notice', parentId: 'custom', message: custom },
    { type: 'message', id: 'result', parentId: 'notice', message: toolResult },
    { type: 'future', id: 'leaf', parentId: 'result', message, thinkingSignature: 'future entry data' },
  ];
  const original = snapshot(entries, [user, message, custom, toolResult, message]);
  original.state.messages = [message];
  original.ui.push({ type: 'custom', message });
  original.live.tools['call-1'].result.details.message = message;
  const before = structuredClone(original);
  deepFreeze(original);

  const result = filterSnapshot(original);
  assert.deepEqual(result, {
    ...original,
    entries: entries.map((entry, index) => index === 2 ? { ...entry, message: displayed } : entry),
    live: { ...original.live, messages: [user, displayed, custom, toolResult, displayed] },
  });
  assert.deepEqual(original, before, 'Display projection must not alter any original data');
  assert.notStrictEqual(result, original);
  assert.notStrictEqual(result.entries[2].message, message);
  assert.deepEqual(result.entries.map(entry => [entry.id, entry.parentId]), entries.map(entry => [entry.id, entry.parentId]));
  assert.equal(result.entries[2].message.content.length, message.content.length);
  assert.equal(Object.hasOwn(result.entries[2].message.content[0], 'thinkingSignature'), false);
  assert.equal(Object.hasOwn(result.entries[2].message.content[1], 'textSignature'), false);
  assert.equal(message.content[0].thinkingSignature, 'private thinking');
  assert.equal(message.content[1].textSignature, 'private text');
});

test('filterSnapshot leaves unchanged snapshots valid, including empty live messages and full history', () => {
  for (const original of [
    snapshot([]),
    snapshot([{ type: 'message', id: 'clean', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text: 'clean' }] } }]),
  ]) {
    delete original.historyDelta;
    delete original.historyComplete;
    deepFreeze(original);
    assert.deepEqual(filterSnapshot(original), original);
  }
});

for (const type of ['message_start', 'message_end', 'turn_end']) {
  test(`filterEvent projects ${type}.message without touching nested payloads`, () => {
    const { message, displayed } = assistantPair();
    const event = deepFreeze({
      type, message, seq: 7, unknown: { message },
      toolResults: [{ role: 'toolResult', content: message.content, details: message }],
      thinkingSignature: 'event thinking', textSignature: 'event text',
    });
    const before = structuredClone(event);
    assert.deepEqual(filterEvent(event), { ...event, message: displayed });
    assert.deepEqual(event, before);
  });
}

for (const [type, carrier] of [['text_delta', 'partial'], ['done', 'message'], ['error', 'error']] as const) {
  test(`filterEvent projects message_update outer message and ${type}.${carrier}`, () => {
    const { message, displayed } = assistantPair();
    const event = deepFreeze({
      type: 'message_update', message,
      assistantMessageEvent: {
        type, [carrier]: message, contentIndex: 1, delta: 'delta', reason: 'stop',
        unknown: { message }, textSignature: 'event text', thinkingSignature: 'event thinking',
      },
      unknown: { partial: message, message, error: message },
    });
    const before = structuredClone(event);
    assert.deepEqual(filterEvent(event), {
      ...event, message: displayed,
      assistantMessageEvent: { ...event.assistantMessageEvent, [carrier]: displayed },
    });
    assert.deepEqual(event, before);
  });
}

test('filterEvent projects all message_update carriers together, including when the outer message is absent', () => {
  const { message, displayed } = assistantPair();
  for (const outer of [{}, { message }]) {
    const event = deepFreeze({
      type: 'message_update', ...outer,
      assistantMessageEvent: { type: 'future', partial: message, message, error: message, details: { message } },
    });
    assert.deepEqual(filterEvent(event), {
      ...event, ...('message' in outer ? { message: displayed } : {}),
      assistantMessageEvent: { ...event.assistantMessageEvent, partial: displayed, message: displayed, error: displayed },
    });
  }
});

test('filterEvent projects agent_end.messages in order without changing other roles or metadata', () => {
  const { message, displayed } = assistantPair();
  const user = { ...message, role: 'user' };
  const custom = { ...message, role: 'custom' };
  const toolResult = { ...message, role: 'toolResult', details: message };
  const event = deepFreeze({
    type: 'agent_end', messages: [user, message, custom, toolResult, message],
    willRetry: true, seq: 8, details: { messages: [message] },
  });
  const before = structuredClone(event);
  assert.deepEqual(filterEvent(event), { ...event, messages: [user, displayed, custom, toolResult, displayed] });
  assert.deepEqual(event, before);
});

test('filterEvent projects entry_appended message entries but not custom entries or entry data', () => {
  const { message, displayed } = assistantPair();
  const entry = { type: 'message', id: 'entry', parentId: 'parent', message, data: { message }, unknown: 'keep' };
  const event = deepFreeze({ type: 'entry_appended', entry, seq: 9, unknown: { entry } });
  const before = structuredClone(event);
  assert.deepEqual(filterEvent(event), { ...event, entry: { ...entry, message: displayed } });
  assert.deepEqual(event, before);
  for (const type of ['custom', 'future']) {
    const customEvent = deepFreeze({ ...event, entry: { ...entry, type } });
    assert.deepEqual(filterEvent(customEvent), customEvent);
  }
});

test('filterEvent does not recursively strip tool, custom, or unknown event payloads', () => {
  const { message } = assistantPair();
  for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'custom', 'future']) {
    const event = deepFreeze({
      type, message, messages: [message], entry: { type: 'message', message },
      assistantMessageEvent: { partial: message, message, error: message },
      args: { thinkingSignature: 'argument thinking', textSignature: 'argument text', message },
      result: { details: { thinkingSignature: 'result thinking', textSignature: 'result text', message } },
      partialResult: { message },
    });
    assert.deepEqual(filterEvent(event), event);
  }
});

test('filterEvent removes matching signature properties even when their values are empty or undefined', () => {
  for (const signature of [undefined, null, '', false, 0]) {
    const message = deepFreeze({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'reason', thinkingSignature: signature },
      { type: 'text', text: 'answer', textSignature: signature },
    ] });
    const result = filterEvent({ type: 'message_end', message });
    assert.deepEqual(result.message.content, [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'answer' }]);
    assert.equal(Object.hasOwn(message.content[0], 'thinkingSignature'), true);
    assert.equal(Object.hasOwn(message.content[1], 'textSignature'), true);
  }
});

test('filterEvent safely preserves absent or malformed optional message carriers', () => {
  const malformed = [undefined, null, false, 0, 'opaque', [], {}, { role: 'assistant' }, { role: 'assistant', content: null }, { role: 'assistant', content: 'opaque' }];
  for (const type of ['message_start', 'message_end', 'turn_end', 'message_update', 'agent_end', 'entry_appended']) {
    const absent = deepFreeze({ type, unknown: 'keep' });
    assert.deepEqual(filterEvent(absent), absent);
    for (const value of malformed) {
      const event = deepFreeze({ type, message: value, messages: value, entry: value, assistantMessageEvent: value });
      assert.deepEqual(filterEvent(event), event, `${type} must preserve malformed carriers`);
    }
  }
  for (const value of malformed) {
    const update = deepFreeze({ type: 'message_update', assistantMessageEvent: { type: 'error', partial: value, message: value, error: value } });
    const appended = deepFreeze({ type: 'entry_appended', entry: { type: 'message', id: 'entry', message: value } });
    const ended = deepFreeze({ type: 'agent_end', messages: [value] });
    assert.deepEqual(filterEvent(update), update);
    assert.deepEqual(filterEvent(appended), appended);
    assert.deepEqual(filterEvent(ended), ended);
  }
});

test('filterSnapshot safely preserves absent or malformed optional entry messages and live message values', () => {
  const malformed = [undefined, null, 'opaque', [], {}, { role: 'assistant' }, { role: 'assistant', content: {} }];
  const original = snapshot([
    { type: 'message', id: 'absent', parentId: null },
    ...malformed.map((message, index) => ({ type: 'message', id: String(index), parentId: 'absent', message })),
  ]);
  deepFreeze(original);
  assert.deepEqual(filterSnapshot(original), original);
  for (const messages of malformed) {
    // Exercise defensive runtime handling without weakening the public Snapshot type.
    const value = deepFreeze({ ...original, live: { ...original.live, messages } });
    assert.deepEqual(filterSnapshot(value as unknown as Snapshot), value);
  }
});
