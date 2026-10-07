import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantMessageComponent, CustomMessageComponent, initTheme, ToolExecutionComponent, type ToolDefinition, type ToolRenderers } from '@earendil-works/pi-coding-agent';
import { getKeybindings, stripTerminalSequences as stripAnsi, Text, visibleWidth } from '@earendil-works/pi-tui';
import { PresentationHost, readPresentationConfig } from '../src/presentation.js';
import type { Snapshot } from '../src/protocol.js';
import { Transcript } from '../src/transcript.js';
import { RemoteView } from '../src/view.js';

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

test('width caching keeps dynamic adapter renders live and contains later failures', async () => {
  const { host, notices } = setup();
  const source = ['\x1b[31mwide styled text\x1b[39m'];
  let renders = 0;
  let fail = false;
  host.tools.set('dynamic', { name: 'dynamic', renderCall: () => ({
    render() { renders++; if (fail) throw new Error('late render failure'); return source; },
    invalidate() {},
  }) });
  try {
    const component = host.renderCall('dynamic', {}, { toolCallId: 'dynamic' })!;
    const first = component.render(8);
    assert.equal(component.render(8), first);
    assert.equal(renders, 2, 'render still runs when only its width check is cached');
    source[0] = 'changed output';
    assert.equal(stripAnsi(component.render(8)[0]), 'changed ');
    assert.equal(renders, 3);
    assert.equal(stripAnsi(component.render(80)[0]), 'changed output');
    assert.ok(component.render(1).every(line => visibleWidth(line) <= 1));
    fail = true;
    assert.deepEqual(component.render(8), []);
    assert.deepEqual(component.render(8), []);
    assert.equal(notices.filter(message => message.includes('late render failure')).length, 1);
  } finally { await host.shutdown(); }
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

type ToolContext = Parameters<NonNullable<ToolDefinition['renderCall']>>[2];

async function withPresentationFixture(source: string, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(resolve(tmpdir(), 'presentation-bridge-'));
  try {
    const path = resolve(dir, 'extension.ts');
    await writeFile(path, source);
    await run(path);
  } finally { await rm(dir, { recursive: true }); }
}

test('renderer revisions announce late registrations and replacements to cached transcripts', async () => {
  await withPresentationFixture(`
    import { Text } from '@earendil-works/pi-tui';
    export default function(pi) {
      pi.registerCommand('late', { handler() {
        pi.registerTool({ name: 'late', parameters: {}, renderCall: () => new Text('late tool', 0, 0) });
        pi.registerToolRenderer((name, next) => next());
        pi.registerMessageRenderer('late', () => new Text('late message', 0, 0));
        pi.registerEntryRenderer('late', () => new Text('late entry', 0, 0));
        pi.registerMarkdownTransformer(text => text + ' transformed');
      } });
      pi.registerCommand('replace', { handler() {
        pi.registerTool({ name: 'late', parameters: {}, renderCall: () => new Text('replaced tool', 0, 0) });
      } });
    }
  `, async path => {
    const state = setup(); const { host } = state;
    await host.load([path]);
    try {
      const revision = host.rendererRevision;
      const before = state.invalidations;
      assert.equal(host.toolRenderers('late'), undefined);
      assert.equal(await host.command('late'), true);
      assert.equal(host.rendererRevision, revision + 5);
      assert.ok(state.invalidations > before);
      assert.ok(host.toolRenderers('late')); assert.ok(host.messageRenderer('late'));
      assert.equal(host.renderCall('late', {}, { toolCallId: 'late' })!.render(80)[0].trimEnd(), 'late tool');
      state.update(snapshot());
      assert.equal(host.rendererRevision, revision + 5); // Ordinary snapshot updates keep row state.
      assert.equal(await host.command('replace'), true);
      assert.equal(host.rendererRevision, revision + 6);
      assert.equal(host.renderCall('late', {}, { toolCallId: 'late' })!.render(80)[0].trimEnd(), 'replaced tool');
    } finally { await host.shutdown(); }
  });
});

test('public tool components own state, flags, previous components and invalidation', async () => {
  initTheme('dark', false);
  const state = setup(); const { host, tui } = state;
  const calls: ToolContext[] = [];
  const results: ToolContext[] = [];
  host.tools.set('native', {
    name: 'native', renderShell: 'self',
    renderCall(args, theme, context) {
      assert.equal(theme.name, 'dark'); // Not the host's remote-default theme.
      assert.equal(args, context.args);
      assert.ok(Object.isFrozen(args));
      calls.push(context);
      context.state.renders = (context.state.renders ?? 0) + 1;
      context.state.value = args.value;
      if (context.lastComponent) assert.equal(context.lastComponent, context.state.callComponent);
      const component = context.lastComponent ?? {
        render: () => [`call:${context.state.value}:${context.state.status ?? 'pending'}`],
        invalidate() {},
      };
      context.state.callComponent = component;
      return component;
    },
    renderResult(result, options, theme, context) {
      assert.equal(theme.name, 'dark');
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(context.args));
      assert.equal(options.expanded, context.expanded);
      assert.equal(options.isPartial, context.isPartial);
      results.push(context);
      context.state.status = result.details;
      if (context.lastComponent) assert.equal(context.lastComponent, context.state.resultComponent);
      const component = context.lastComponent ?? new Text('result', 0, 0);
      context.state.resultComponent = component;
      return component;
    },
  });
  try {
    const renderers = host.toolRenderers('native')!;
    const row = new ToolExecutionComponent('native', 'native-1', { value: 'first' }, { showImages: false }, renderers, tui, '/remote/work');
    assert.deepEqual({
      id: calls[0].toolCallId, cwd: calls[0].cwd, started: calls[0].executionStarted,
      complete: calls[0].argsComplete, partial: calls[0].isPartial, expanded: calls[0].expanded,
      images: calls[0].showImages, error: calls[0].isError,
    }, { id: 'native-1', cwd: '/remote/work', started: false, complete: false, partial: true, expanded: false, images: false, error: false });
    row.markExecutionStarted(); row.setArgsComplete(); row.updateArgs({ value: 'second' });
    row.updateResult({ content: [], details: 'partial', isError: false }, true);
    assert.equal(results.at(-1)!.state, calls[0].state);
    assert.match(stripAnsi(row.render(80).join('\n')), /call:second:partial/);
    row.updateResult({ content: [], details: 'failed', isError: true });
    row.setExpanded(true); row.setShowImages(true);
    assert.equal(calls.at(-1)!.executionStarted, true);
    assert.equal(calls.at(-1)!.argsComplete, true);
    assert.equal(calls.at(-1)!.expanded, true);
    assert.equal(calls.at(-1)!.showImages, true);
    assert.equal(results.at(-1)!.isPartial, false);
    assert.equal(results.at(-1)!.isError, true);
    assert.match(stripAnsi(row.render(80).join('\n')), /call:second:failed/);
    const before = state.invalidations;
    calls.at(-1)!.invalidate();
    assert.ok(state.invalidations > before);
    host.retainToolCalls(['native-1']); // Retained rows keep Pi-owned renderer state.
    row.invalidate();
    assert.equal(calls.at(-1)!.state, calls[0].state);
    new ToolExecutionComponent('native', 'native-2', { value: 'other' }, {}, renderers, tui, '/remote/other');
    assert.notEqual(calls.at(-1)!.state, calls[0].state);
    assert.deepEqual(state.notices, []);
  } finally { await host.shutdown(); }
});

test('native tool lifecycle disposes replaced components and fences removed row invalidators', async () => {
  initTheme('dark', false);
  const state = setup(); const { host, tui } = state;
  const components: { disposed: number }[] = [];
  const invalidators = new Map<string, () => void>();
  const render = (_value: unknown, context: ToolContext) => {
    invalidators.set(context.toolCallId, context.invalidate);
    const component = { disposed: 0, render: () => ['lifecycle'], invalidate() {}, dispose() { this.disposed++; } };
    components.push(component);
    return component;
  };
  host.tools.set('lifecycle', {
    name: 'lifecycle', renderShell: 'self',
    renderCall: (args, _theme, context) => render(args, context),
    renderResult: (result, _options, _theme, context) => render(result, context),
  });
  try {
    const definition = host.toolRenderers('lifecycle');
    const row = new ToolExecutionComponent('lifecycle', 'same-id', {}, {}, definition, tui, '/remote/work');
    const originalInvalidator = invalidators.get('same-id')!;
    row.updateResult({ content: [], isError: false });
    assert.equal(components[0].disposed, 1); // Replaced call component is released.
    const beforeActive = state.invalidations;
    originalInvalidator();
    assert.ok(state.invalidations > beforeActive);
    assert.ok(components.slice(0, -2).every(component => component.disposed === 1));
    new ToolExecutionComponent('lifecycle', 'same-id', {}, {}, definition, tui, '/remote/work');
    assert.ok(components.slice(0, -1).every(component => component.disposed === 1));
    const beforeReplaced = state.invalidations;
    originalInvalidator();
    assert.equal(state.invalidations, beforeReplaced); // Same id, new Pi component/state.
    const replacementInvalidator = invalidators.get('same-id')!;
    host.retainToolCalls([]);
    assert.ok(components.every(component => component.disposed === 1));
    replacementInvalidator();
    assert.equal(state.invalidations, beforeReplaced);
    new ToolExecutionComponent('lifecycle', 'shutdown', {}, {}, definition, tui, '/remote/work');
    const shutdownInvalidator = invalidators.get('shutdown')!;
    await host.shutdown();
    const afterShutdown = state.invalidations;
    shutdownInvalidator();
    assert.equal(state.invalidations, afterShutdown);
    assert.ok(components.every(component => component.disposed === 1));
    assert.deepEqual(state.notices, []);
  } finally { await host.shutdown(); }
});

test('tool resolver next sees stock fallbacks and failures do not hide downstream renderers', async () => {
  await withPresentationFixture(`
    export default function(pi) {
      pi.registerToolRenderer((name, next) => {
        const fallback = next();
        if (name === 'resolver-error') throw new Error('resolver exploded');
        if (name === 'override') return { renderShell: 'self', renderCall: () => ({ render: () => ['override'], invalidate() {} }) };
        return fallback;
      });
      let resolutions = 0;
      pi.registerToolRenderer((name, next) => {
        if (name !== 'resolver-error') return next();
        resolutions++;
        return { ...next(), renderResult: () => ({ render: () => [String(resolutions)], invalidate() {} }) };
      });
    }
  `, async path => {
    const { host, notices, tui } = setup();
    await host.load([path]);
    try {
      let received: ToolContext | undefined;
      const fallback: ToolRenderers = {
        renderShell: 'self', renderCall: (_args, _theme, context) => { received = context; return new Text('stock', 0, 0); },
      };
      const override = new ToolExecutionComponent('override', 'override', {}, {}, host.toolRenderers('override', fallback), tui, '/remote/work');
      assert.match(stripAnsi(override.render(80).join('\n')), /override/);
      assert.doesNotMatch(stripAnsi(override.render(80).join('\n')), /stock/);
      const definition = host.toolRenderers('resolver-error', { ...fallback, execute: () => { throw new Error('must not execute'); } } as any)!;
      assert.deepEqual(Object.keys(definition).sort(), ['renderCall', 'renderResult', 'renderShell']);
      const row = new ToolExecutionComponent('resolver-error', 'fallback', {}, {}, definition, tui, '/remote/work');
      row.setArgsComplete(); row.updateResult({ content: [], isError: false });
      assert.equal(received!.argsComplete, true);
      assert.match(stripAnsi(row.render(80).join('\n')), /stock\s+1/);
      assert.equal(notices.filter(message => message.includes('resolver exploded')).length, 1);
      assert.ok(host.toolRenderers('resolver-error', fallback));
      assert.equal(notices.filter(message => message.includes('resolver exploded')).length, 1);
      assert.equal(host.toolRenderers('unregistered'), undefined);
    } finally { await host.shutdown(); }
  });
});

test('public tool components retain Pi fallback behavior for broken renderer factories', async () => {
  initTheme('dark', false);
  const { host, notices, tui } = setup();
  let callAttempts = 0;
  let resultAttempts = 0;
  host.tools.set('broken-native', {
    name: 'broken-native', renderShell: 'self',
    renderCall() { callAttempts++; throw new Error('call factory exploded'); },
    renderResult() { resultAttempts++; throw new Error('result factory exploded'); },
  });
  try {
    const row = new ToolExecutionComponent('broken-native', 'broken', { value: 'argument' }, {}, host.toolRenderers('broken-native'), tui, '/remote/work');
    row.updateResult({ content: [{ type: 'text', text: 'authoritative output' }], isError: true });
    row.invalidate(); row.setExpanded(true);
    const text = stripAnsi(row.render(100).join('\n'));
    assert.match(text, /broken-native/); assert.match(text, /argument/); assert.match(text, /authoritative output/);
    assert.equal(callAttempts, 1); assert.equal(resultAttempts, 1);
    assert.equal(notices.filter(message => message.includes('factory exploded')).length, 2);
  } finally { await host.shutdown(); }
});

test('public message and markdown bridges preserve callback themes, options and error containment', async () => {
  initTheme('dark', false);
  await withPresentationFixture(`
    import { Text } from '@earendil-works/pi-tui';
    export default function(pi) {
      pi.registerMessageRenderer('native', (message, options, theme) => {
        if (!Object.isFrozen(message)) throw new Error('mutable message');
        return new Text(theme.name + ':' + options.outputPad + ':' + options.expanded + ':' + message.details, 0, 0);
      });
      pi.registerMessageRenderer('throws', () => { throw new Error('message factory exploded'); });
      pi.registerMarkdownTransformer(() => { throw new Error('markdown exploded'); });
      pi.registerMarkdownTransformer((text, context) => text + ':' + context.messageType);
    }
  `, async path => {
    const { host, notices } = setup();
    const transformers = host.markdownTransformers; // Remains live after registration.
    await host.load([path]);
    try {
      const message = { role: 'custom', customType: 'native', content: 'body', display: true, details: 'detail', timestamp: 1 } as any;
      const component = new CustomMessageComponent(message, host.messageRenderer('native'), undefined, 3);
      assert.match(stripAnsi(component.render(80).join('\n')), /dark:3:false:detail/);
      component.setExpanded(true); component.setOutputPad(2);
      assert.match(stripAnsi(component.render(80).join('\n')), /dark:2:true:detail/);
      const fallback = new CustomMessageComponent({ ...message, customType: 'throws' }, host.messageRenderer('throws'));
      fallback.invalidate();
      assert.match(stripAnsi(fallback.render(80).join('\n')), /body/);
      const context = { messageType: 'assistant', availableWidth: 80, isStreaming: false } as const;
      for (let i = 0; i < 2; i++) assert.equal(transformers.reduce((text, transform) => transform(text, context), 'text'), 'text:assistant');
      assert.equal(notices.filter(message => message.includes('message factory exploded')).length, 1);
      assert.equal(notices.filter(message => message.includes('markdown exploded')).length, 1);
      assert.equal(host.messageRenderer('missing'), undefined);
    } finally { await host.shutdown(); }
  });
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

test('Rowan compact and background extensions work with public transcript components', {
  skip: !['compact-tools.ts', 'assistant-background.ts', 'codemode-compact.ts'].every(file => existsSync(resolve(userExtensions, file))),
}, async () => {
  initTheme('dark', false);
  const originalAssistantRender = AssistantMessageComponent.prototype.render;
  const originalToolRender = ToolExecutionComponent.prototype.render;
  const { host, notices, tui } = setup();
  await host.load(['compact-tools.ts', 'assistant-background.ts', 'codemode-compact.ts'].map(file => resolve(userExtensions, file)));
  await host.start();
  try {
    assert.notEqual(AssistantMessageComponent.prototype.render, originalAssistantRender);
    assert.notEqual(ToolExecutionComponent.prototype.render, originalToolRender);
    const row = new ToolExecutionComponent('bash', 'compact-bash', { command: 'never execute' }, { showImages: false }, host.toolRenderers('bash'), tui, '/remote/work');
    row.markExecutionStarted(); row.setArgsComplete();
    row.updateResult({ content: [{ type: 'text', text: 'first\nsecond\nthird' }], isError: false });
    const collapsed = stripAnsi(row.render(80).join('\n'));
    assert.match(collapsed, /^  ┌─ Bash\(never execute\)/); // Extension removes Pi's spacer; no duplicate shell padding.
    assert.match(collapsed, /└─ first/); assert.match(collapsed, /\(\+ 2 lines\)/);
    assert.doesNotMatch(collapsed, /second/);
    row.setExpanded(true);
    assert.match(stripAnsi(row.render(80).join('\n')), /second/);
    const code = '// Read remote files\nreturn await tools.read({path:"remote.txt"});';
    const script = new ToolExecutionComponent('codemode', 'compact-code', { code }, {}, host.toolRenderers('codemode'), tui, '/remote/work');
    script.markExecutionStarted(); script.setArgsComplete();
    script.updateResult({
      content: [{ type: 'text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'text', text: 'done\nextra' }],
      details: { calls: [{ id: 'nested', name: 'read', args: '{"path":"remote.txt"}', status: 'ok', durationMs: 10 }] }, isError: false,
    });
    const scriptText = stripAnsi(script.render(100).join('\n'));
    assert.match(scriptText, /Codemode\(Read remote files\)/);
    assert.match(scriptText, /Read\(remote.txt\)/); assert.match(scriptText, /done.*0\.2s/);
    assert.doesNotMatch(scriptText, /return await/);
    const before = row.render(80).join('\n');
    await host.shortcut('\x1bo');
    assert.notEqual(row.render(80).join('\n'), before);
    assert.match(stripAnsi(script.render(100).join('\n')), /return await/);
    for (const width of [1, 8, 30, 100]) {
      assert.ok(row.render(width).every(line => visibleWidth(line) <= width));
      assert.ok(script.render(width).every(line => visibleWidth(line) <= width));
    }
    const assistant = new AssistantMessageComponent({ role: 'assistant', content: [{ type: 'text', text: 'answer' }] } as any);
    assert.ok(assistant.render(80).every(line => visibleWidth(line) === 80));
    const initial = snapshot();
    const message = { role: 'assistant', timestamp: 12, stopReason: 'toolUse', content: [
      { type: 'text', text: 'Original assistant background' },
      { type: 'toolCall', id: 'transcript-bash', name: 'bash', arguments: { command: 'never execute' } },
    ] };
    initial.live.messages = [message, { role: 'toolResult', toolCallId: 'transcript-bash', toolName: 'bash', timestamp: 13,
      content: [{ type: 'text', text: 'transcript output' }], isError: false }];
    const transcript = new Transcript(new RemoteView(initial), tui, () => host);
    const lines = transcript.render(80);
    const expectedAssistant = new AssistantMessageComponent(message as any).render(80);
    assert.deepEqual(lines.slice(0, expectedAssistant.length), expectedAssistant);
    assert.match(stripAnsi(lines[expectedAssistant.length]), /^  ┌─ Bash/); // Patched tool spacer applies inside Transcript too.
    assert.match(stripAnsi(lines.join('\n')), /transcript output/);
    assert.deepEqual(notices.filter(message => message.startsWith('Local presentation:')), []);
    assert.ok(host.tools.has('codemode'));
    assert.equal('execute' in host.tools.get('codemode')!, false);
    assert.equal('prepareLoadout' in host.tools.get('codemode')!, false);
  } finally { await host.shutdown(); }
  assert.equal(AssistantMessageComponent.prototype.render, originalAssistantRender);
  assert.equal(ToolExecutionComponent.prototype.render, originalToolRender);
});
