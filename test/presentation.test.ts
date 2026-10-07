import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKeybindings, stripTerminalSequences as stripAnsi, visibleWidth } from '@earendil-works/pi-tui';
import { PresentationHost, readPresentationConfig } from '../src/presentation.js';
import type { Snapshot } from '../src/protocol.js';

const fixtures = fileURLToPath(new URL('./fixtures/presentation/', import.meta.url));
function snapshot(): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/remote/work', status: 'running', createdAt: '', clients: 1 },
    state: { model: { id: 'virtual', provider: 'router', api: 'pi-virtual' }, thinkingLevel: 'high' },
    entries: [
      { id: 'root', type: 'model_change', parentId: null },
      { id: 'other', type: 'custom', parentId: 'root' },
      { id: 'leaf', type: 'custom', parentId: 'root' },
    ], leafId: 'leaf',
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
    ui: [{ method: 'setStatus', statusKey: 'remote', statusText: 'remote status' }], seq: 1,
    presentation: {
      gitBranch: 'remote-branch', homeDir: '/remote',
      models: [{ id: 'virtual', provider: 'router', api: 'pi-virtual' }, { id: 'real', provider: 'physical', api: 'test', contextWindow: 200000, reasoning: true }],
      stats: { contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 } },
    },
  };
}
function setup(initial = snapshot()) {
  let current = initial;
  let text = '';
  let expanded = false;
  let invalidations = 0;
  const notices: string[] = [];
  const tui: any = { requestRender() { invalidations++; }, terminal: { columns: 100, rows: 30 }, getTerminalSize: () => ({ columns: 100, rows: 30 }) };
  const host = new PresentationHost({ snapshot: () => current, tui, notify: message => notices.push(message),
    invalidate: () => { invalidations++; }, getEditorText: () => text, setEditorText: value => { text = value; },
    getToolsExpanded: () => expanded, setToolsExpanded: value => { expanded = value; },
  });
  return { host, notices, tui, initial, update(value: Snapshot) { current = value; host.update(value); }, get text() { return text; }, get expanded() { return expanded; }, get invalidations() { return invalidations; } };
}

test('presentation configuration is opt-in and exact paths are resolved predictably', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'presentation-'));
  try {
    const path = resolve(dir, 'remote-client.json');
    assert.deepEqual(await readPresentationConfig(path), { extensions: [], theme: undefined });
    await writeFile(path, JSON.stringify({ extensions: ['./a.ts', './a.ts'], theme: 'dark' }));
    const config = await readPresentationConfig(path, ['./b.ts']);
    assert.deepEqual(config, { extensions: [resolve(dir, 'a.ts'), resolve('b.ts')], theme: 'dark' });
    await writeFile(path, JSON.stringify({ extensions: 'all' }));
    await assert.rejects(readPresentationConfig(path), /Invalid presentation config/);
    const { host } = setup(); await host.start();
    assert.equal(host.footer, undefined); assert.equal(host.tools.size, 0); await host.shutdown();
  } finally { await rm(dir, { recursive: true }); }
});

test('display lifecycle uses readonly active branch, mirrored models, stats and remote branch/status data', async () => {
  const state = setup(); const { host } = state;
  await host.load([resolve(fixtures, 'display.ts')]); await host.start();
  const footer = () => JSON.parse(host.footer!.render(3000)[0]);
  assert.deepEqual(footer().branch, ['root', 'leaf']);
  assert.equal(footer().routed, 'real'); assert.equal(footer().providers, 2);
  assert.equal(footer().git, 'remote-branch'); assert.equal(footer().usage.tokens, 50000);
  assert.deepEqual(footer().statuses, [['remote', 'remote status'], ['local', 'local status']]);
  assert.equal(host.header!.render(80)[0].trimEnd(), 'header'); assert.equal(host.widgets.get('below')?.placement, 'belowEditor');
  assert.equal(host.workingMessage, 'working');
  const next = structuredClone(state.initial); next.presentation!.gitBranch = 'new-remote'; next.state.model.id = 'new-model';
  next.live.messages.push({ role: 'assistant', timestamp: 123, content: [] });
  state.update(next);
  assert.equal(footer().name, 'new-model'); assert.equal(footer().git, 'new-remote'); assert.equal(footer().branch.length, 3);
  assert.equal(state.notices.filter(n => n === 'branch changed').length, 1);
  await host.dispatch({ type: 'before_agent_start' }); await host.dispatch({ type: 'tool_call' }); await host.dispatch({ type: 'context' });
  assert.ok(!state.notices.some(n => n.includes('MUST NEVER RUN')));
  await host.command('inspect-readonly'); assert.equal(next.entries[0].id, 'root');
  await host.command('local', 'local text'); assert.equal(state.text, 'local text'); assert.equal(state.expanded, true);
  assert.equal(await host.shortcut('\x1bo'), true); assert.equal(host.workingMessage, 'shortcut');
  await host.dispatch({ type: 'agent_start' }); assert.equal(host.workingMessage, 'agent');
  await host.dispatch({ type: 'agent_settled' }); assert.equal(host.workingMessage, undefined);
  await host.command('mutate'); assert.ok(state.notices.some(n => n.includes('pi.appendEntry')));
  await host.shutdown(); await host.shutdown(); assert.equal(state.notices.filter(n => n === 'shutdown').length, 1);
});

test('tool renderer context retains state and previous components without retaining execute', async () => {
  const { host } = setup(); await host.load([resolve(fixtures, 'display.ts')]);
  const context = { toolCallId: 'call1' };
  assert.equal('execute' in host.tools.get('fixture')!, false);
  assert.equal(host.renderCall('fixture', { value: 'x' }, context)!.render(100)[0].trimEnd(), 'call:x:1:new');
  assert.equal(host.renderCall('fixture', { value: 'y' }, context)!.render(100)[0].trimEnd(), 'call:y:2:reused');
  assert.equal(host.renderResult('fixture', { content: [], details: 'done' }, { expanded: true, isPartial: false }, context)!.render(100)[0].trimEnd(), 'result:y:2:true:done');
  assert.equal(host.renderCall('fixture', { value: 'z' }, { toolCallId: 'call2' })!.render(100)[0].trimEnd(), 'call:z:1:new');
  assert.equal(host.renderCall('resolver', {}, context)!.render(100)[0].trimEnd(), 'first');
  assert.equal(host.renderCall('missing', {}, context), undefined);
  host.retainToolCalls(['call2']);
  assert.equal(host.renderCall('fixture', { value: 'reset' }, context)!.render(100)[0].trimEnd(), 'call:reset:1:new');
  assert.equal(host.renderMessage({ customType: 'fixture', details: 'hello' }, { expanded: false })!.render(100)[0].trimEnd(), 'message:hello');
  assert.equal(host.renderEntry({ customType: 'fixture', data: 'hello' }, { expanded: false })!.render(100)[0].trimEnd(), 'entry:hello');
  assert.equal(host.transformMarkdown('old', { messageType: 'assistant', availableWidth: 100, isStreaming: false }), 'new');
  await host.shutdown();
});

test('errors stay local, notify once, and mutation APIs never execute', async () => {
  const { host, notices } = setup(); await host.load([resolve(fixtures, 'errors.ts')]); await host.start();
  for (let i = 0; i < 2; i++) {
    assert.equal(host.renderEntry({ customType: 'broken' }, { expanded: false }), undefined);
    assert.deepEqual(host.renderMessage({ customType: 'broken' }, { expanded: false })!.render(80), []);
    assert.equal(host.renderCall('broken', {}, { toolCallId: 'broken' }), undefined);
    assert.equal(host.transformMarkdown('unchanged', { messageType: 'user', availableWidth: 80, isStreaming: false }), 'unchanged');
    await host.dispatch({ type: 'agent_start' });
  }
  assert.equal(host.workingMessage, 'survived');
  assert.equal(notices.filter(n => n.includes('renderer failed')).length, 2);
  assert.equal(notices.filter(n => n.includes('component failed')).length, 1);
  for (const name of ['exec', 'send', 'provider', 'virtual', 'mcp', 'model', 'context-exec']) assert.equal(await host.command(name), true);
  assert.ok(notices.some(n => n.includes('pi.exec'))); assert.ok(notices.some(n => n.includes('ctx.executeTool')));
  await host.load([resolve(fixtures, 'missing.ts'), fixtures]);
  assert.ok(notices.some(n => n.includes('not a directory')));
  await host.shutdown();
});

const userExtensions = '/Users/rowan/.pi/agent/git/github.com/rowantran/pi-extensions';
test('explicitly opted-in stable user extensions load and render without execution', {
  skip: !['codex-footer.ts', 'prompt-caret.ts', 'compact-tools.ts'].every(file => existsSync(resolve(userExtensions, file))),
}, async () => {
  const initial = snapshot();
  initial.entries.push({ id: 'answer', parentId: 'leaf', type: 'message', message: {
    role: 'assistant', provider: 'physical', model: 'real', stopReason: 'stop', thinkingLevel: 'high',
    timestamp: 1, content: [], usage: { cost: { total: 0.125 } },
  } }); initial.leafId = 'answer';
  const state = setup(initial); const { host } = state;
  await host.load(['codex-footer.ts', 'prompt-caret.ts', 'compact-tools.ts'].map(file => resolve(userExtensions, file)));
  await host.start();
  assert.deepEqual(state.notices, []);
  assert.ok(host.footer); assert.ok(host.editorFactory); assert.ok(host.tools.has('bash'));
  const footer = stripAnsi(host.footer!.render(160).join('\n'));
  assert.match(footer, /real high/); assert.match(footer, /remote-branch/); assert.match(footer, /73% left/); assert.match(footer, /0\.125/);
  const editor = host.editorFactory!(state.tui, { borderColor: text => text, selectList: {
    selectedPrefix: text => text, selectedText: text => text, description: text => text, scrollInfo: text => text, noMatch: text => text,
  } } as any, getKeybindings() as any);
  editor.setText('hello'); assert.match(stripAnsi(editor.render(80).join('\n')), /› hello/);
  const input = { toolCallId: 'real-bash', expanded: false, isPartial: false, isError: false };
  const call = host.renderCall('bash', { command: 'never execute this' }, input)!;
  const result = host.renderResult('bash', { content: [{ type: 'text', text: 'hello\nsecond\nthird' }], details: undefined }, { expanded: false, isPartial: false }, input)!;
  assert.deepEqual(result.render(80), []);
  assert.match(stripAnsi(call.render(80).join('\n')), /hello/);
  for (const width of [1, 8, 30, 100]) assert.ok(call.render(width).every(line => visibleWidth(line) <= width));
  const before = state.invalidations;
  assert.equal(await host.command('tool-call'), true); assert.ok(state.invalidations > before);
  assert.ok(!('execute' in host.tools.get('bash')!));
  await host.shutdown();
});
