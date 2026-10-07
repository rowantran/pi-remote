import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent, CustomMessageComponent, UserMessageComponent,
  ToolExecutionComponent, createReadToolDefinition, initTheme,
} from '@earendil-works/pi-coding-agent';
import { Container, Spacer, Text, stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { Transcript, builtinToolRenderers } from '../src/transcript.js';
import { PresentationHost } from '../src/presentation.js';
import { RemoteView } from '../src/view.js';
import type { RecordValue, Snapshot } from '../src/protocol.js';

const ui = { requestRender() {} } as TUI;
const cwd = '/remote/project';
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(content: any[], extra: RecordValue = {}) {
  return { role: 'assistant' as const, content, timestamp: 2, api: 'test', provider: 'test', model: 'test', usage, stopReason: 'stop' as const, ...extra };
}
function setup(messages: RecordValue[], tools: Record<string, RecordValue> = {}) {
  initTheme('dark', false);
  const snapshot: Snapshot = {
    slot: { id: 'slot', cwd, createdAt: '', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null, ui: [], seq: 0,
    live: { busy: false, compacting: false, messages, tools, steering: [], followUp: [] },
  };
  const view = new RemoteView(snapshot);
  return { transcript: new Transcript(view, ui), view };
}
const plain = (transcript: Transcript) => stripTerminalSequences(transcript.render(100).join('\n'));

test('notices keep their position through new messages, streaming updates and history restoration', () => {
  const prompt = { role: 'user', timestamp: 1, content: 'FIRST_PROMPT' };
  const response = assistant([{ type: 'text', text: 'FIRST_RESPONSE' }], { stopReason: 'pending' });
  const { transcript, view } = setup([prompt, response]);
  transcript.notify('FIRST_NOTICE'); transcript.notify('SECOND_NOTICE');
  // An immutable streaming replacement keeps the same message identity.
  view.snapshot.live.messages[1] = assistant([{ type: 'text', text: 'COMPLETED_RESPONSE' }]);
  view.snapshot.live.messages.push({ role: 'user', timestamp: 3, content: 'NEXT_PROMPT' });
  transcript.changed();
  const check = () => {
    const output = plain(transcript);
    const positions = ['COMPLETED_RESPONSE', 'FIRST_NOTICE', 'SECOND_NOTICE', 'NEXT_PROMPT'].map(text => output.indexOf(text));
    assert.ok(positions.every(position => position >= 0), output);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, output);
  };
  check();
  // The remote snapshot moves live messages into persisted entries.
  const restored = structuredClone(view.snapshot);
  restored.entries = restored.live.messages.map((message, i) => ({ type: 'message', id: String(i), parentId: i ? String(i - 1) : null, message }));
  restored.leafId = '2'; restored.live.messages = [];
  view.replace(restored); transcript.reset(); check();
  transcript.expanded = true; transcript.thinking = false; check();
});

test('notices emitted by renderers appear on the next frame without new remote activity', async () => {
  const { view } = setup([{ role: 'custom', customType: 'fixture', display: true, timestamp: 1, content: 'content' }]);
  const host = new PresentationHost({ snapshot: () => view.snapshot, tui: ui, notify() {}, invalidate() {} });
  const transcript = new Transcript(view, ui, () => host);
  host.messageRenderer = () => () => {
    transcript.notify('RENDERER_WARNING');
    return new Text('PRESENTATION_ROW');
  };
  try {
    assert.match(plain(transcript), /PRESENTATION_ROW/);
    assert.match(plain(transcript), /RENDERER_WARNING/);
    assert.deepEqual(transcript.notices, ['RENDERER_WARNING']);
  } finally { transcript.reset(); await host.shutdown(); }
});

test('startup notices remain before later conversation, including after the first render', () => {
  const { transcript, view } = setup([]);
  transcript.notify('STARTUP_WARNING'); plain(transcript);
  view.snapshot.live.messages.push({ role: 'user', timestamp: 1, content: 'LATER_PROMPT' });
  transcript.changed();
  const output = plain(transcript);
  assert.ok(output.indexOf('STARTUP_WARNING') < output.indexOf('LATER_PROMPT'), output);
});

test('notices anchored to tool results or invisible records still precede later messages', () => {
  const response = assistant([{ type: 'toolCall', id: 'call', name: 'unknown', arguments: {} }]);
  const result = { role: 'toolResult', toolName: 'unknown', toolCallId: 'call', timestamp: 3, content: [{ type: 'text', text: 'TOOL_OUTPUT' }] };
  const hiddenRecords = [result, { role: 'system', timestamp: 4, content: 'HIDDEN' },
    { role: 'custom', customType: 'hidden', display: false, timestamp: 4, content: 'HIDDEN' },
    { role: 'entry', id: 'hidden', customType: 'internal', timestamp: 4 }];
  for (const record of hiddenRecords) {
    const { transcript, view } = setup([response, result, ...(record === result ? [] : [record])]);
    transcript.notify('AFTER_TOOL_NOTICE');
    view.snapshot.live.messages.push(assistant([{ type: 'text', text: 'NEXT_RESPONSE' }], { timestamp: 5 }));
    transcript.changed();
    const output = plain(transcript);
    assert.ok(output.indexOf('TOOL_OUTPUT') < output.indexOf('AFTER_TOOL_NOTICE'), output);
    assert.ok(output.indexOf('AFTER_TOOL_NOTICE') < output.indexOf('NEXT_RESPONSE'), output);
    assert.doesNotMatch(output, /HIDDEN/);
  }
});

test('notices after one tool result stay before sibling tool output that completes later', () => {
  const response = assistant([
    { type: 'toolCall', id: 'a', name: 'unknown', arguments: {} },
    { type: 'toolCall', id: 'b', name: 'unknown', arguments: {} },
  ]);
  const result = (id: string, timestamp: number) => ({ role: 'toolResult', toolName: 'unknown', toolCallId: id, timestamp,
    content: [{ type: 'text', text: `OUTPUT_${id.toUpperCase()}` }] });
  const { transcript, view } = setup([response, result('a', 3)]);
  transcript.notify('AFTER_A_WARNING'); plain(transcript);
  view.snapshot.live.messages.push(result('b', 4)); transcript.changed();
  const output = plain(transcript);
  const positions = ['OUTPUT_A', 'AFTER_A_WARNING', 'OUTPUT_B'].map(text => output.indexOf(text));
  assert.ok(positions.every(position => position >= 0), output);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, output);
  assert.equal((output.match(/AFTER_A_WARNING/g) ?? []).length, 1);
});

test('learning a starting session identity and file preserves startup warnings', () => {
  for (const state of [{ sessionId: 'session-1' }, { sessionFile: '/remote/session-1.jsonl' }]) {
    const { transcript, view } = setup([]);
    transcript.notify('STARTUP_WARNING'); plain(transcript);
    view.snapshot.state = state; transcript.changed();
    assert.match(plain(transcript), /STARTUP_WARNING/);
    view.snapshot.state = { sessionId: 'session-1', sessionFile: '/remote/session-1.jsonl' };
    transcript.changed();
    assert.match(plain(transcript), /STARTUP_WARNING/);
    // Temporarily absent metadata must not erase the last known identity.
    view.snapshot.state = {}; transcript.changed();
    assert.match(plain(transcript), /STARTUP_WARNING/);
    view.snapshot.state = { sessionId: 'session-2', sessionFile: '/remote/session-2.jsonl' };
    assert.doesNotMatch(plain(transcript), /STARTUP_WARNING/);
  }
});

test('renderer resets preserve warnings but removed anchors and session switches discard them', () => {
  const { transcript, view } = setup([{ role: 'user', timestamp: 1, content: 'PROMPT' }]);
  view.snapshot.state.sessionId = 'first-session';
  transcript.notify('KEEP_WARNING'); transcript.reset();
  assert.match(plain(transcript), /KEEP_WARNING/);
  view.snapshot.live.messages = []; transcript.changed();
  assert.doesNotMatch(plain(transcript), /KEEP_WARNING/);
  transcript.notify('OLD_SESSION_WARNING');
  view.snapshot.state.sessionId = 'different-session';
  assert.doesNotMatch(plain(transcript), /OLD_SESSION_WARNING/);
  // Notify before the first render of a switched session must not keep old warnings.
  transcript.notify('SECOND_SESSION_WARNING');
  view.snapshot.state.sessionId = 'third-session'; transcript.notify('NEW_SESSION_WARNING');
  assert.deepEqual(transcript.notices, ['NEW_SESSION_WARNING']);
});

test('connection notice cleanup is targeted, bounded, and strips remote terminal controls', () => {
  const { transcript } = setup([]);
  transcript.notify('MCP_WARNING\x1b[2J\x00');
  transcript.notify('Connection lost', 'connection');
  transcript.notify('Reattached', 'connection');
  transcript.clearConnectionNotices();
  assert.deepEqual(transcript.notices, ['MCP_WARNING']);
  assert.match(plain(transcript), /MCP_WARNING/);
  assert.doesNotMatch(plain(transcript), /Connection lost|Reattached/);
  for (let i = 0; i < 51; i++) transcript.notify(`notice-${i}`);
  assert.equal(transcript.notices.length, 50);
  assert.equal(transcript.notices[0], 'notice-1');
  assert.equal(transcript.notices.at(-1), 'notice-50');
});

test('user, thinking, Markdown and tool rows match public Pi components byte-for-byte', () => {
  const prompt = { role: 'user', timestamp: 1, content: '9. preserve numbers\n\n**Bold** and \\*escaped\\* 世界' };
  const response = assistant([
    { type: 'thinking', thinking: 'Check the **input**.' },
    { type: 'thinking', thinking: 'Then the output.' },
    { type: 'text', text: '# Result\n\n```ts\nconst x = 1;\n```\n\n| key | value |\n| --- | --- |\n| 世界 | café |' },
    { type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'src/a.ts' } },
  ], { stopReason: 'toolUse' });
  const result = { role: 'toolResult', toolName: 'read', toolCallId: 'r', timestamp: 3, content: [{ type: 'text', text: 'const x = 1;\n' }], isError: false };
  const final = assistant([{ type: 'text', text: 'Done.' }], { timestamp: 4 });
  const { transcript } = setup([prompt, response, result, final]);
  for (const expanded of [false, true]) for (const thinking of [true, false]) {
    transcript.expanded = expanded; transcript.thinking = thinking;
    const expected = new Container();
    expected.addChild(new UserMessageComponent(prompt.content));
    expected.addChild(new AssistantMessageComponent(response as any, !thinking));
    const tool = new ToolExecutionComponent('read', 'r', { path: 'src/a.ts' }, { showImages: false }, createReadToolDefinition(cwd), ui, cwd);
    tool.markExecutionStarted(); tool.setArgsComplete(); tool.updateResult(result); tool.setExpanded(expanded);
    expected.addChild(tool); expected.addChild(new AssistantMessageComponent(final as any, !thinking));
    for (const width of [40, 80, 120]) assert.deepEqual(transcript.render(width), expected.render(width), `width=${width}, expanded=${expanded}, thinking=${thinking}`);
  }
});

test('error, length and abort messages use Pi wording and spacing', () => {
  for (const stopReason of ['error', 'length', 'aborted'] as const) {
    const message = assistant([{ type: 'text', text: 'Partial response' }], { stopReason, errorMessage: stopReason === 'error' ? 'Fixture error' : undefined });
    const { transcript } = setup([message]);
    assert.deepEqual(transcript.render(80), new AssistantMessageComponent(message as any).render(80));
  }
});

test('restored shell tools do not invent execution clocks', () => {
  const response = assistant([{ type: 'toolCall', id: 'shell', name: 'bash', arguments: { command: 'echo restored' } }]);
  const result = { role: 'toolResult', toolName: 'bash', toolCallId: 'shell', timestamp: 3, content: [{ type: 'text', text: 'restored' }], isError: false };
  const { transcript } = setup([response, result]);
  const expected = new Container();
  expected.addChild(new AssistantMessageComponent(response as any));
  const tool = new ToolExecutionComponent('bash', 'shell', { command: 'echo restored' }, { showImages: false }, builtinToolRenderers(cwd).get('bash'), ui, cwd);
  tool.updateResult(result); expected.addChild(tool);
  assert.deepEqual(transcript.render(80), expected.render(80));
  assert.doesNotMatch(plain(transcript), /Took|Elapsed/);
});

test('a resolver can explicitly decline a built-in renderer', async () => {
  const response = assistant([{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'sample.ts' } }]);
  const { view } = setup([response]);
  const host = new PresentationHost({ snapshot: () => view.snapshot, tui: ui, notify() {}, invalidate() {} });
  host.toolRenderers = () => undefined;
  const transcript = new Transcript(view, ui, () => host);
  const expected = new Container(); expected.addChild(new AssistantMessageComponent(response as any));
  expected.addChild(new ToolExecutionComponent('read', 'read', { path: 'sample.ts' }, { showImages: false }, undefined, ui, cwd));
  assert.deepEqual(transcript.render(80), expected.render(80));
  transcript.reset(); await host.shutdown();
});

test('native partial shell timers stop before rows and their presentation host are released', async t => {
  const active = new Set<ReturnType<typeof setInterval>>();
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => { const timer = originalSet(...args); active.add(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', (timer: ReturnType<typeof setInterval>) => { active.delete(timer); originalClear(timer); });
  try {
    for (const name of ['bash', 'powershell']) for (const remove of [false, true]) {
      const response = assistant([{ type: 'toolCall', id: 'shell', name, arguments: { command: 'fixture' } }]);
      const { view } = setup([response], { shell: { toolCallId: 'shell', toolName: name, type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'partial' }] } } });
      const host = new PresentationHost({ snapshot: () => view.snapshot, tui: ui, notify() {}, invalidate() {} });
      const transcript = new Transcript(view, ui, () => host);
      transcript.render(80); assert.equal(active.size, 1);
      if (remove) { view.snapshot.live.messages = []; view.snapshot.live.tools = {}; transcript.changed(); transcript.render(80); }
      else transcript.reset();
      await host.shutdown(); assert.equal(active.size, 0, `${name}: ${remove ? 'removed' : 'reset'}`);
    }
  } finally { for (const timer of active) originalClear(timer); }
});

test('custom messages, summaries and completed shell output use Pi panels', () => {
  const custom = { role: 'custom', customType: 'note', display: true, content: '**Note**', timestamp: 1 };
  const compaction = { role: 'compactionSummary' as const, summary: 'Earlier work', tokensBefore: 12000, timestamp: 2 };
  const branch = { role: 'branchSummary' as const, summary: 'Other branch', fromId: 'branch', timestamp: 3 };
  const bash = { role: 'bashExecution', command: 'printf failure', output: 'failure', exitCode: 3, cancelled: false, timestamp: 4 };
  const { transcript } = setup([custom, compaction, branch, bash]);
  for (const expanded of [false, true]) {
    transcript.expanded = expanded;
    const expected = new Container();
    const customComponent = new CustomMessageComponent(custom as any); customComponent.setExpanded(expanded); expected.addChild(customComponent);
    for (const component of [new CompactionSummaryMessageComponent(compaction), new BranchSummaryMessageComponent(branch)]) {
      component.setExpanded(expanded); expected.addChild(new Spacer(1)); expected.addChild(component);
    }
    const shell = new BashExecutionComponent(bash.command, ui);
    shell.setComplete(3, false); shell.appendOutput(bash.output); shell.setExpanded(expanded); expected.addChild(shell);
    assert.deepEqual(transcript.render(80), expected.render(80));
  }
});

test('custom state entries and nested executions do not produce extra transcript rows', () => {
  const response = assistant([{ type: 'toolCall', id: 'parent', name: 'codemode', arguments: { code: 'nested work' } }]);
  const { transcript } = setup([response, { role: 'entry', id: 'internal', customType: 'private-state', timestamp: 3, data: {} }], {
    parent: { toolCallId: 'parent', toolName: 'codemode', type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'parent result' }] } },
    nested: { parentToolCallId: 'parent', toolCallId: 'parent/1', toolName: 'read', args: { path: 'MUST_NOT_DUPLICATE' }, type: 'tool_execution_start' },
  });
  const output = plain(transcript);
  assert.match(output, /parent result/);
  assert.doesNotMatch(output, /MUST_NOT_DUPLICATE|private-state|renderer not loaded/);
  assert.equal((output.match(/codemode/g) ?? []).length, 1);
});

test('live tool updates and restored final results occupy the same row', () => {
  const response = assistant([{ type: 'toolCall', id: 'call', name: 'unknown', arguments: { query: 'query' } }]);
  const { transcript, view } = setup([response], {
    call: { toolCallId: 'call', toolName: 'unknown', type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'PARTIAL' }] } },
  });
  assert.match(plain(transcript), /PARTIAL/);
  view.snapshot.live.tools.call = { ...view.snapshot.live.tools.call, type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'FINAL' }] } };
  view.snapshot.live.messages.push({ role: 'toolResult', timestamp: 3, toolCallId: 'call', toolName: 'unknown', content: [{ type: 'text', text: 'FINAL' }], isError: false });
  transcript.changed();
  const output = plain(transcript);
  assert.doesNotMatch(output, /PARTIAL/); assert.equal((output.match(/FINAL/g) ?? []).length, 1);
});

test('streamed tool arguments use Pi parsing before the completed call arrives', () => {
  const response = assistant([{ type: 'toolCall', id: 'streamed', name: 'read', arguments: {}, argumentText: '{"path":"src/part' }], { stopReason: 'pending' });
  const { transcript, view } = setup([response]);
  assert.match(plain(transcript), /src\/part/);
  view.snapshot.live.messages = [assistant([{ type: 'toolCall', id: 'streamed', name: 'read', arguments: { path: 'src/complete.ts' } }], { stopReason: 'toolUse' })];
  transcript.changed();
  assert.match(plain(transcript), /src\/complete.ts/); assert.doesNotMatch(plain(transcript), /src\/part/);
});

test('an aborted assistant settles pending tool rows instead of leaving partial output running', () => {
  const response = assistant([{ type: 'toolCall', id: 'call', name: 'unknown', arguments: {} }], { stopReason: 'aborted' });
  const { transcript } = setup([response], {
    call: { toolCallId: 'call', toolName: 'unknown', type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'PARTIAL' }] } },
  });
  assert.match(plain(transcript), /Operation aborted/); assert.doesNotMatch(plain(transcript), /PARTIAL/);
});

test('wire controls are removed while generated Pi styling and prompt markers remain', () => {
  const { transcript } = setup([{ role: 'user', timestamp: 1, content: '\x1b]52;c;c2VjcmV0\x07safe\x1b[2J\x00' },
    assistant([{ type: 'text', text: 'body\x1b]0;bad title\x07' }])]);
  const output = transcript.render(80).join('\n');
  assert.doesNotMatch(output, /\x1b\]52;|\x1b\[2J|bad title|\x00/);
  assert.match(output, /\x1b\]133;A/); assert.match(output, /\x1b\[/); assert.match(output, /safe/);
});

test('built-in edit rendering never reads a local path to preview remote edits', async () => {
  initTheme('dark', false);
  let reads = 0;
  const original = fs.readFile;
  fs.readFile = (async () => { reads++; throw new Error('Client must not read remote paths'); }) as typeof fs.readFile;
  syncBuiltinESMExports();
  try {
    const tool = new ToolExecutionComponent('edit', 'edit', { path: '/remote/file.ts', edits: [{ oldText: 'before', newText: 'after' }] },
      { showImages: false }, builtinToolRenderers(cwd).get('edit'), ui, cwd);
    tool.setArgsComplete(); tool.markExecutionStarted(); tool.render(80);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0);
    tool.updateResult({ content: [{ type: 'text', text: 'Applied' }], details: { diff: '-1 before\n+1 after' }, isError: false });
    assert.match(stripTerminalSequences(tool.render(80).join('\n')), /after/);
    assert.equal(reads, 0);
  } finally { fs.readFile = original; syncBuiltinESMExports(); }
});
