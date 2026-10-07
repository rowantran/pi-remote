import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { PresentationHost } from '../src/presentation.js';
import type { RecordValue, Snapshot } from '../src/protocol.js';
import { Transcript } from '../src/transcript.js';
import { RemoteView } from '../src/view.js';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content: RecordValue[], timestamp: number, stopReason = 'toolUse'): RecordValue {
  return { role: 'assistant', api: 'test', provider: 'test', model: 'test', content, timestamp, usage, stopReason };
}
function setup(t: TestContext, blocks: RecordValue[]) {
  initTheme('dark', false);
  const initial: Snapshot = {
    slot: { id: 'slot', cwd: '/remote/one', createdAt: '', status: 'running', clients: 1 },
    state: { sessionId: 'session' },
    entries: [{ id: 'calls', parentId: null, type: 'message', message: assistant(blocks, 1) }],
    leafId: 'calls', ui: [], seq: 0,
    live: { busy: true, compacting: false, tools: {}, steering: [], followUp: [], messages: [assistant([{ type: 'text', text: 'live' }], 10, 'pending')] },
  };
  for (const [i, block] of blocks.entries()) {
    const id = `result-${i}`;
    initial.entries.push({ id, parentId: initial.leafId, type: 'message', message: {
      role: 'toolResult', timestamp: i + 2, toolCallId: block.id, toolName: block.name, isError: false, content: [],
    } }); initial.leafId = id;
  }
  const view = new RemoteView(initial);
  const counters = { argsUpdates: 0, factories: 0, disposed: 0 };
  const latest = new Map<string, { args: RecordValue; cwd: string; expanded: boolean; theme: string; component: object; state: RecordValue }>();
  const originalUpdateArgs = ToolExecutionComponent.prototype.updateArgs;
  t.mock.method(ToolExecutionComponent.prototype, 'updateArgs', function(this: ToolExecutionComponent, args: RecordValue) {
    counters.argsUpdates++; return originalUpdateArgs.call(this, args);
  });
  const ui = { requestRender() {} } as TUI;
  const host = new PresentationHost({ snapshot: () => view.snapshot, tui: ui, notify() {}, invalidate() {} });
  host.tools.set('counted', { name: 'counted', renderShell: 'self', renderCall(args, theme, context) {
    counters.factories++;
    const component = {
      render: () => [`${theme.name}:${context.expanded ? 1 : 0}`], invalidate() {}, dispose() { counters.disposed++; },
    };
    latest.set(context.toolCallId, { args, cwd: context.cwd, expanded: context.expanded, theme: theme.name, component, state: context.state });
    return component;
  } });
  const transcript = new Transcript(view, ui, () => host);
  function apply(event: RecordValue): void {
    assert.equal(view.apply({ type: 'event', slotId: 'slot', seq: view.snapshot.seq + 1, event }), true);
    host.update(view.snapshot); transcript.changed(); transcript.render(80);
  }
  return { initial, view, transcript, host, counters, latest, apply, async close() { transcript.reset(); await host.shutdown(); } };
}
function call(id: string, extra: RecordValue = {}): RecordValue {
  return { type: 'toolCall', id, name: 'counted', arguments: {}, argumentText: '{"n":1}', ...extra };
}

test('metadata rebuilds do not update historical parsed arguments or recreate renderer components', async t => {
  const state = setup(t, [call('a'), call('b'), call('c')]);
  try {
    state.transcript.render(80);
    const before = { ...state.counters };
    const components = [...state.latest.values()].map(value => value.component);
    state.apply({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'progress', statusText: 'ready' });
    t.diagnostic(JSON.stringify({ storedEntries: state.initial.entries.length, toolCallBlocks: 3, argumentTextBlocks: 3,
      liveMessages: state.initial.live.messages.length, liveToolStates: Object.keys(state.initial.live.tools).length,
      metadataArgsUpdates: state.counters.argsUpdates - before.argsUpdates, metadataFactories: state.counters.factories - before.factories }));
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 0);
    assert.equal(state.counters.factories - before.factories, 0);
    assert.equal(state.counters.disposed, before.disposed);
    [...state.latest.values()].forEach((value, i) => assert.equal(value.component, components[i]));
  } finally { await state.close(); }
});

test('assistant text deltas preserve historical and current tool-call argument identities', async t => {
  const state = setup(t, [call('stored')]);
  try {
    const live = state.view.snapshot.live.messages[0];
    live.content.push(call('live'));
    const block = live.content[1];
    state.transcript.render(80);
    const before = { ...state.counters };
    const storedComponent = state.latest.get('stored')!.component;
    const liveComponent = state.latest.get('live')!.component;
    for (let i = 0; i < 5; i++) state.apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '!' } });
    assert.equal(state.view.snapshot.live.messages[0].content[1], block);
    assert.equal(state.counters.argsUpdates, before.argsUpdates);
    assert.equal(state.counters.factories, before.factories);
    assert.equal(state.counters.disposed, before.disposed);
    assert.equal(state.latest.get('stored')!.component, storedComponent);
    assert.equal(state.latest.get('live')!.component, liveComponent);
  } finally { await state.close(); }
});

test('streaming argument deltas and completed replacement blocks update the existing tool row', async t => {
  const state = setup(t, []);
  try {
    const live = state.view.snapshot.live.messages[0];
    live.content.push(call('live', { argumentText: '{"n":1' }));
    const oldBlock = live.content[1];
    state.transcript.render(80);
    const rowState = state.latest.get('live')!.state;
    const before = { ...state.counters };
    state.apply({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '2' } });
    assert.notEqual(state.view.snapshot.live.messages[0].content[1], oldBlock);
    assert.equal(state.latest.get('live')!.args.n, 12);
    assert.equal(state.latest.get('live')!.state, rowState);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 1);
    assert.equal(state.counters.factories - before.factories, 1);
    const afterDelta = { ...state.counters };
    state.apply({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1,
      toolCall: call('live', { argumentText: undefined, arguments: { n: 123 } }) } });
    assert.equal(state.latest.get('live')!.args.n, 123);
    assert.equal(state.latest.get('live')!.state, rowState);
    assert.equal(state.counters.argsUpdates - afterDelta.argsUpdates, 1);
    state.apply({ type: 'session_info_changed', name: 'metadata' });
    assert.equal(state.counters.argsUpdates - afterDelta.argsUpdates, 1);
  } finally { await state.close(); }
});

test('mutable argument-text fixtures and canonical argument replacements invalidate cached parsing', async t => {
  const state = setup(t, [call('one', { argumentText: '{"n":1' })]);
  try {
    state.transcript.render(80);
    const block = state.view.snapshot.entries[0].message.content[0];
    const before = { ...state.counters };
    block.argumentText = '{"n":2';
    state.transcript.changed(); state.transcript.render(80);
    assert.equal(state.latest.get('one')!.args.n, 2);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 1);
    assert.equal(state.counters.factories - before.factories, 1);
    state.transcript.changed(); state.transcript.render(80);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 1);
    block.argumentText = ''; block.arguments = { n: 3 };
    state.transcript.changed(); state.transcript.render(80);
    assert.equal(state.latest.get('one')!.args.n, 3);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 2);
    block.arguments = { n: 4 };
    state.transcript.changed(); state.transcript.render(80);
    assert.equal(state.latest.get('one')!.args.n, 4);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 3);
    assert.equal(state.counters.factories - before.factories, 3);
    block.argumentText = '{"n":5';
    state.transcript.changed(); state.transcript.render(80);
    assert.equal(state.latest.get('one')!.args.n, 5);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 4);
  } finally { await state.close(); }
});

test('missing argument defaults stay stable for call blocks, standalone live tools, and orphan results', async t => {
  const state = setup(t, [call('absent', { arguments: undefined, argumentText: undefined }), call('empty', { arguments: undefined, argumentText: '' })]);
  try {
    state.view.snapshot.live.tools.standalone = { toolCallId: 'standalone', toolName: 'counted', type: 'tool_execution_end', result: { content: [] } };
    state.view.snapshot.live.messages.push({ role: 'toolResult', toolName: 'counted', toolCallId: 'orphan', timestamp: 20, content: [], isError: false });
    state.transcript.render(80);
    const before = { ...state.counters };
    assert.equal(state.latest.size, 4);
    state.apply({ type: 'thinking_level_changed', level: 'high' });
    assert.equal(state.counters.argsUpdates, before.argsUpdates);
    assert.equal(state.counters.factories, before.factories);
    for (const value of state.latest.values()) assert.deepEqual(value.args, {});
  } finally { await state.close(); }
});

test('live canonical arguments override parsed arguments and update only when replaced', async t => {
  const state = setup(t, [call('one')]);
  try {
    state.view.snapshot.live.tools.one = { toolCallId: 'one', toolName: 'counted', type: 'tool_execution_end', args: { n: 2 } };
    state.transcript.render(80);
    const before = { ...state.counters };
    assert.equal(state.latest.get('one')!.args.n, 2);
    state.apply({ type: 'tool_execution_end', toolCallId: 'one', toolName: 'counted', args: { n: 3 } });
    assert.equal(state.latest.get('one')!.args.n, 3);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 1);
    assert.equal(state.counters.factories - before.factories, 1);
    state.apply({ type: 'tool_execution_end', toolCallId: 'one', toolName: 'counted' });
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 1);
    assert.equal(state.counters.factories - before.factories, 1);
  } finally { await state.close(); }
});

test('changed argument paths and remote working directories still refresh tool components', async t => {
  const state = setup(t, [call('path', { argumentText: '{"path":"/remote/a"}' })]);
  try {
    state.transcript.render(80);
    const before = { ...state.counters };
    const original = state.latest.get('path')!;
    state.view.snapshot.entries[0].message.content[0] = call('path', { argumentText: '{"path":"/remote/b"}' });
    state.transcript.changed(); state.transcript.render(80);
    assert.equal(state.latest.get('path')!.args.path, '/remote/b');
    assert.equal(state.latest.get('path')!.state, original.state);
    assert.notEqual(state.latest.get('path')!.component, original.component);
    assert.equal(state.counters.argsUpdates - before.argsUpdates, 1);
    const changedArgs = state.latest.get('path')!;
    state.view.snapshot.slot.cwd = '/remote/two';
    state.transcript.render(80);
    assert.equal(state.latest.get('path')!.cwd, '/remote/two');
    assert.equal(state.latest.get('path')!.args.path, '/remote/b');
    assert.notEqual(state.latest.get('path')!.state, changedArgs.state);
    assert.notEqual(state.latest.get('path')!.component, changedArgs.component);
  } finally { await state.close(); }
});

test('expansion and theme invalidation still reach cached tool renderers without updating arguments', async t => {
  const state = setup(t, [call('one')]);
  try {
    state.transcript.render(80);
    const before = { ...state.counters };
    const original = state.latest.get('one')!;
    state.transcript.expanded = true;
    const expanded = state.transcript.render(80);
    assert.equal(state.latest.get('one')!.expanded, true);
    assert.equal(state.latest.get('one')!.state, original.state);
    assert.ok(expanded.some(line => line.includes('dark:1')));
    assert.equal(state.counters.argsUpdates, before.argsUpdates);
    assert.equal(state.counters.factories - before.factories, 1);
    initTheme('light', false); state.transcript.invalidate();
    const themed = state.transcript.render(80);
    assert.equal(state.latest.get('one')!.theme, 'light');
    assert.equal(state.latest.get('one')!.state, original.state);
    assert.ok(themed.some(line => line.includes('light:1')));
    assert.equal(state.counters.argsUpdates, before.argsUpdates);
    assert.ok(state.counters.factories - before.factories >= 2);
  } finally { await state.close(); initTheme('dark', false); }
});
