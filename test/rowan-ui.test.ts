import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { EntryRenderer, ExtensionAPI, MarkdownTransformer } from '@earendil-works/pi-coding-agent';
import { Loader, stripTerminalSequences, type Terminal, type TUI } from '@earendil-works/pi-tui';
import rowanUI from '../examples/rowan-ui.js';
import { PresentationHost } from '../src/presentation.js';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../src/protocol.js';
import { Transcript } from '../src/transcript.js';
import { RemoteTui } from '../src/tui.js';
import { RemoteView } from '../src/view.js';

const adapter = fileURLToPath(new URL('../examples/rowan-ui.ts', import.meta.url));
const originalRoot = process.env.PI_REMOTE_RENDERER_REPO
  ?? join(homedir(), '.pi/agent/git/github.com/rowantran/pi-extensions');
const originalWorkedFor = join(originalRoot, 'worked-for.ts');
const originalBell = join(originalRoot, 'emit-terminal-bel.ts');
const plain = (lines: string[]) => stripTerminalSequences(lines.join('\n'));

// This fixture deliberately differs from the real persisted renderer/filter. Its markers
// prove the selected factory ran, rather than a handwritten substitute in the adapter.
function workedForFixture(entryType = 'worked-for'): string {
  return `
    import { Text } from '@earendil-works/pi-tui';
    export default async function originalWorkedForFixture(pi) {
      if (Object.keys(pi).sort().join(',') !==
          'appendEntry,on,registerEntryRenderer,registerMarkdownTransformer') {
        throw new Error('Worked-for must receive only its explicit facade');
      }
      let startedAt, ticker, settled = 0, shutdowns = 0;
      const stop = () => {
        if (ticker !== undefined) clearInterval(ticker);
        ticker = undefined;
      };
      pi.registerEntryRenderer('worked-for', (entry) => new Text(
        'original factory:' + entry.data.elapsedSeconds + ':settled=' + settled
          + ':shutdowns=' + shutdowns, 1, 0));
      pi.registerMarkdownTransformer((text, ctx) => {
        if (ctx.messageType === 'assistant' && text === 'fixture legacy timing') return '';
        return text;
      });
      pi.on('agent_start', (_event, ctx) => {
        startedAt ??= performance.now();
        if (!ctx.hasUI || ticker !== undefined) return;
        const update = () => ctx.ui.setWorkingMessage('Working... ('
          + Math.floor((performance.now() - startedAt) / 1000) + 's)');
        update(); ticker = setInterval(update, 1000);
      });
      pi.on('agent_settled', (_event, ctx) => {
        stop();
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
        if (startedAt === undefined) return;
        const elapsedSeconds = Math.round((performance.now() - startedAt) / 1000);
        startedAt = undefined;
        pi.appendEntry(${JSON.stringify(entryType)}, { elapsedSeconds });
        settled++; // Must run after append; a blocked hook cannot silently pass this test.
      });
      pi.on('session_shutdown', () => { stop(); shutdowns++; });
      pi.on('context', () => { throw new Error('CONTEXT HOOK MUST NOT EXECUTE'); });
    }
  `;
}

async function withRepo(run: (root: string) => Promise<void>, timingSource = workedForFixture()) {
  const root = await mkdtemp(join(tmpdir(), 'rowan-ui-worked-for-'));
  const previous = process.env.PI_REMOTE_RENDERER_REPO;
  const modules = {
    'codex-footer.ts': 'export default function() {}',
    'prompt-caret.ts': 'export default function() {}',
    'assistant-background.ts': 'export default function() {}',
    'compact-tools.ts': 'export default function() {}\nexport function withCompactToolRendering(pi) { return pi; }',
    'codemode/render.ts': 'export function compactCodemodeTool() { return {}; }',
    'background/render.ts': 'export function renderBackgroundMessage() {}',
    'worked-for.ts': timingSource,
    // Records instead of writing BEL, so test output stays clean. Mirrors the original mode check.
    'emit-terminal-bel.ts': `export default function(pi) {
      pi.on('agent_settled', (_event, ctx) => {
        if (ctx.mode !== 'tui') return;
        (globalThis.rowanUiBells ??= []).push(ctx.mode);
      });
    }`,
    'background.ts': 'throw new Error("Worker factory must never load");',
    'codemode.ts': 'throw new Error("Execution factory must never load");',
  };
  try {
    for (const [path, source] of Object.entries(modules)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    process.env.PI_REMOTE_RENDERER_REPO = root;
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.PI_REMOTE_RENDERER_REPO;
    else process.env.PI_REMOTE_RENDERER_REPO = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function snapshot(): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/remote/work', status: 'running', createdAt: '', clients: 1 },
    state: {},
    entries: [{ type: 'custom', customType: 'worked-for', id: 'timing', parentId: null,
      timestamp: '2024-01-01T00:00:00.000Z', data: { elapsedSeconds: 3661 } }],
    leafId: 'timing',
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
    ui: [], seq: 1,
  };
}

function setup() {
  const view = new RemoteView(snapshot());
  const notices: string[] = [];
  let invalidations = 0;
  const tui = { requestRender() { invalidations++; }, terminal: { columns: 100, rows: 30 } } as TUI;
  // There is intentionally no request transport or writable session manager in this host.
  const host = new PresentationHost({ snapshot: () => view.snapshot, tui,
    notify: message => notices.push(message), invalidate() { invalidations++; } });
  const transcript = new Transcript(view, tui, () => host);
  return { host, view, transcript, notices, get invalidations() { return invalidations; } };
}

function clock(t: TestContext, keepRenderClockAdvancing = false) {
  let now = 0;
  const realNow = performance.now.bind(performance);
  // RemoteTui renders on real setTimeout deadlines and queries terminal colors at startup.
  // Keep its monotonic clock advancing while virtual intervals fast-forward worked-for.
  t.mock.method(performance, 'now', () => now + (keepRenderClockAdvancing ? realNow() : 0));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const set = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  const active = new Set<ReturnType<typeof setInterval>>();
  t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => {
    const timer = set(...args); active.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer: ReturnType<typeof setInterval>) => {
    active.delete(timer); clear(timer);
  });
  return { active, tick(ms: number) { now += ms; t.mock.timers.tick(ms); } };
}

function captureAPI() {
  const hooks = new Map<string, Function>();
  const entries = new Map<string, EntryRenderer>();
  const markdown: MarkdownTransformer[] = [];
  let writes = 0;
  let requests = 0;
  const api = {
    on(name: string, fn: Function) {
      // Several factories may share an event; keep registration order like Pi.
      const previous = hooks.get(name);
      hooks.set(name, previous ? (...args: unknown[]) => { previous(...args); fn(...args); } : fn);
      return () => hooks.delete(name);
    },
    appendEntry() { writes++; assert.fail('Local timing append must not reach the host'); },
    sendMessage() { requests++; assert.fail('No local model requests'); },
    sendUserMessage() { requests++; assert.fail('No local model requests'); },
    exec() { requests++; assert.fail('No local execution'); },
    registerTool() { requests++; assert.fail('No executable tool registration'); },
    registerEntryRenderer(name: string, fn: EntryRenderer) { entries.set(name, fn); },
    registerMarkdownTransformer(fn: MarkdownTransformer) { markdown.push(fn); },
    registerMessageRenderer() {}, registerToolRenderer() {},
  } as unknown as ExtensionAPI;
  return { api, hooks, entries, markdown, get writes() { return writes; }, get requests() { return requests; } };
}

const markdownContext = { messageType: 'assistant' as const, availableWidth: 100, isStreaming: false };

// All tests run serially: renderer-root overrides and mocked global timers are process-local.
test('Rowan adapter loads the full selected factory through a narrow facade and forwards no writes or requests', async t => {
  const time = clock(t);
  await withRepo(async () => {
    const captured = captureAPI();
    await rowanUI(captured.api);
    assert.deepEqual([...captured.hooks.keys()], ['agent_start', 'agent_settled', 'session_shutdown']);
    assert.equal(captured.markdown[0]('fixture legacy timing', markdownContext), '');
    assert.equal(captured.markdown[0]('fixture legacy timing', { ...markdownContext, messageType: 'user' }), 'fixture legacy timing');
    let working: string | undefined;
    const ctx = { hasUI: true, ui: { setWorkingMessage(value?: string) { working = value; } } };
    try {
      for (let run = 0; run < 3; run++) {
        captured.hooks.get('agent_start')!({}, ctx);
        assert.equal(working, 'Working... (0s)');
        time.tick(2000);
        assert.equal(working, 'Working... (2s)');
        captured.hooks.get('agent_settled')!({}, ctx);
        assert.equal(working, undefined);
        assert.equal(time.active.size, 0);
      }
      assert.equal(captured.writes, 0);
      assert.equal(captured.requests, 0);
    } finally { captured.hooks.get('session_shutdown')!({}, ctx); }
  });
});

test('Rowan worked-for timer settles repeatedly, preserves remote history, and stops across reload and detach', async t => {
  const time = clock(t);
  await withRepo(async () => {
    // A new host is how /reload-ui replaces the old presentation runtime.
    for (let reload = 0; reload < 2; reload++) {
      const state = setup();
      const { host, transcript, notices, view } = state;
      const before = JSON.stringify(view.snapshot);
      try {
        await host.load([adapter]); await host.start();
        assert.match(plain(transcript.render(100)), /original factory:3661:settled=0/);
        assert.equal(host.transformMarkdown('fixture legacy timing', markdownContext), '');
        await host.dispatch({ type: 'context', messages: [] });
        for (let run = 1; run <= 3; run++) {
          await host.dispatch({ type: 'agent_start' });
          assert.equal(host.workingMessage, 'Working... (0s)');
          assert.equal(time.active.size, 1);
          time.tick(2000);
          assert.equal(host.workingMessage, 'Working... (2s)');
          await host.dispatch({ type: 'agent_settled' });
          assert.equal(host.workingMessage, undefined);
          assert.equal(time.active.size, 0);
          const rendered = host.renderEntry(view.snapshot.entries[0], { expanded: false });
          assert.match(plain(rendered!.render(100)), new RegExp('settled=' + run));
        }
        assert.equal(JSON.stringify(view.snapshot), before, 'Remote entries must not be appended or mutated');
        assert.deepEqual(notices, [], 'No unsupported context hook or disabled settle hook warning');
        await host.dispatch({ type: 'agent_start' });
        assert.equal(time.active.size, 1);
        await host.shutdown(); await host.shutdown();
        assert.equal(time.active.size, 0, 'Reload/detach must retire the active ticker');
        const invalidations = state.invalidations;
        time.tick(5000);
        await host.dispatch({ type: 'agent_start' });
        assert.equal(time.active.size, 0);
        assert.equal(state.invalidations, invalidations, 'Retired hooks/timers must not redraw');
      } finally { transcript.reset(); await host.shutdown(); }
    }
  });
});

test('Worked-for facade rejects unexpected append types without weakening write guards for other extensions', async () => {
  await withRepo(async root => {
    const captured = captureAPI();
    await rowanUI(captured.api);
    const ctx = { hasUI: false };
    captured.hooks.get('agent_start')!({}, ctx);
    assert.throws(() => captured.hooks.get('agent_settled')!({}, ctx), /Unexpected worked-for entry type: unexpected/);
    assert.equal(captured.writes, 0);
    assert.equal(captured.requests, 0);
    // Even the expected timing type stays blocked when a different extension calls it.
    await writeFile(join(root, 'worked-for.ts'), workedForFixture());
    const writer = join(root, 'other-extension.ts');
    await writeFile(writer, `export default function(pi) {
      pi.registerCommand('write', { handler() { pi.appendEntry('worked-for', { elapsedSeconds: 999 }); } });
    }`);
    const { host, notices, view, transcript } = setup();
    const before = JSON.stringify(view.snapshot);
    try {
      await host.load([adapter, writer]); await host.start();
      await host.dispatch({ type: 'agent_start' });
      await host.dispatch({ type: 'agent_settled' });
      assert.deepEqual(notices, []);
      await host.command('write');
      assert.ok(notices.some(message => /pi\.appendEntry.*unavailable/.test(message)));
      assert.equal(JSON.stringify(view.snapshot), before);
    } finally { transcript.reset(); await host.shutdown(); }
  }, workedForFixture('unexpected'));
});

test('Missing original worked-for module fails explicitly, without a handwritten fallback', async () => {
  await withRepo(async root => {
    await rm(join(root, 'worked-for.ts'));
    const captured = captureAPI();
    await assert.rejects(rowanUI(captured.api), /worked-for/);
    assert.equal(captured.entries.has('worked-for'), false);
    const { host, notices, transcript } = setup();
    try {
      await host.load([adapter]);
      assert.ok(notices.some(message => /worked-for/.test(message)));
      assert.equal(host.renderEntry(snapshot().entries[0], { expanded: false }), undefined);
    } finally { transcript.reset(); await host.shutdown(); }
  });
});

test('Real original worked-for factory resolves private native component with jiti aliases and keeps lifecycle cleanup', {
  skip: !existsSync(originalWorkedFor),
}, async t => {
  const time = clock(t);
  await withRepo(async root => {
    // Copy the original unchanged into a portable root with no node_modules. This exercises
    // its import.meta.resolve path using the adapter aliases, not an external dependency tree.
    await copyFile(originalWorkedFor, join(root, 'worked-for.ts'));
    const { host, notices, transcript, view } = setup();
    const before = JSON.stringify(view.snapshot);
    try {
      await host.load([adapter]); await host.start();
      assert.deepEqual(notices, [], 'Original private-component import must load successfully');
      const componentURL = new URL('modes/interactive/components/custom-entry.js',
        import.meta.resolve('@earendil-works/pi-coding-agent'));
      const { CustomEntryComponent } = await import(componentURL.href);
      assert.equal(CustomEntryComponent.prototype[Symbol.for('worked-for.no-top-spacer')], true,
        'Original resolver must patch the local native component, not a different Pi installation');
      assert.match(plain(transcript.render(100)), /Worked for 1h 1m 1s/);
      assert.equal(host.transformMarkdown('_Worked for 1h 1m 1s_', markdownContext), '');
      assert.equal(host.transformMarkdown('_Worked for 2s_', { ...markdownContext, messageType: 'user' }), '_Worked for 2s_');
      for (let run = 0; run < 3; run++) {
        await host.dispatch({ type: 'agent_start' });
        assert.equal(stripTerminalSequences(host.workingMessage!), 'Working... (0s)');
        assert.equal(time.active.size, 1);
        // A repeated start must neither reset elapsed time nor create a second timer.
        time.tick(1000); await host.dispatch({ type: 'agent_start' }); time.tick(1000);
        assert.equal(stripTerminalSequences(host.workingMessage!), 'Working... (2s)');
        assert.equal(time.active.size, 1);
        await host.dispatch({ type: 'agent_settled' });
        assert.equal(host.workingMessage, undefined);
        assert.equal(time.active.size, 0);
      }
      assert.equal(JSON.stringify(view.snapshot), before);
      assert.deepEqual(notices, []);
      await host.dispatch({ type: 'agent_start' });
      await host.shutdown();
      assert.equal(time.active.size, 0);
    } finally { transcript.reset(); await host.shutdown(); }
    t.diagnostic('Unchanged original: ' + originalWorkedFor);
  });
});

class WorkedForTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  writes: string[] = [];
  start() {} stop() {} async drainInput() {}
  write(text: string) { this.writes.push(text); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {}
  clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}

class WorkedForConnection implements RemoteConnection {
  requests: { method: string; params?: RecordValue }[] = [];
  listener?: (event: RemoteEvent) => void;
  async request<T = any>(method: string, params?: RecordValue): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'filesystem_metadata') return {} as T;
    assert.equal(method, 'rpc', 'Only read-only metadata requests are allowed');
    assert.ok(['get_available_models', 'get_session_stats', 'get_commands'].includes(params?.command?.type),
      'Worked-for animation/reload/detach must not send mutation requests');
    return { models: [], commands: [] } as T;
  }
  onEvent(listener: (event: RemoteEvent) => void) {
    this.listener = listener; return () => { this.listener = undefined; };
  }
  onDisconnect() { return () => {}; }
  close() {}
}

const flushUI = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

test('Full worked-for factory updates the RemoteTui screen with a native animated spinner and retires both timers', async t => {
  for (const original of [false, true]) await t.test(original ? 'unchanged original' : 'always-on fixture', {
    skip: original && !existsSync(originalWorkedFor),
  }, async t => {
    const time = clock(t, true);
    await withRepo(async root => {
      if (original) await copyFile(originalWorkedFor, join(root, 'worked-for.ts'));
      const initial = snapshot();
      const entriesBefore = JSON.stringify(initial.entries);
      const connection = new WorkedForConnection();
      const terminal = new WorkedForTerminal();
      const ui = new RemoteTui(connection, 'slot', initial, terminal, {
        presentationPaths: [adapter], presentationConfig: join(root, 'absent-config.json'), theme: 'dark',
      });
      const finished = ui.run();
      const screen = () => { ui.tui.renderNow(); return plain(ui.tui.getScreenLines()); };
      const status = (seconds: number) => {
        const text = screen();
        const row = text.split('\n').find(line => /^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working\.\.\./.test(line));
        assert.ok(row, 'The native spinner and worked-for message must be embedded in the editor border:\n' + text);
        assert.match(row, new RegExp('Working\\.\\.\\. \\(' + seconds + 's\\)'));
        assert.equal(text.split('\n').filter(line => line.includes('Working... (')).length, 1);
        return row.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)![0];
      };
      try {
        await ui.initialize(); await flushUI();
        assert.match(screen(), original ? /Worked for 1h 1m 1s/ : /original factory:3661/);
        const reads = connection.requests.length;
        const metadataTimer = (ui as any).metadataTimer;
        assert.equal(time.active.size, 1, 'Only the read-only metadata poll runs while idle');
        connection.listener!({ type: 'event', slotId: 'slot', seq: initial.seq + 1,
          event: { type: 'agent_start' } });
        await flushUI();
        const oldLoader = (ui as any).working;
        assert.ok(oldLoader instanceof Loader);
        const oldLoaderTimer = (oldLoader as any).intervalId;
        const oldTicker = [...time.active].find(timer => timer !== metadataTimer && timer !== oldLoaderTimer);
        assert.ok(oldTicker);
        assert.equal(time.active.size, 3, 'Original ticker, native Loader animation, and metadata poll');
        const firstFrame = status(0);
        time.tick(80); await flushUI();
        assert.notEqual(status(0), firstFrame, 'The visible native spinner must animate independently of elapsed seconds');
        time.tick(1920); await flushUI();
        status(2);
        assert.equal((ui as any).working, oldLoader, 'Timer message updates must not reset the native Loader');
        await (ui as any).reloadPresentation(); await flushUI();
        assert.ok(!time.active.has(oldTicker), 'Reload must retire the original factory ticker');
        assert.ok(!time.active.has(oldLoaderTimer), 'Reload must retire the old native Loader timer');
        assert.notEqual((ui as any).working, oldLoader);
        assert.equal(time.active.size, 3, 'Only replacement presentation timers and metadata poll may remain');
        status(0);
        time.tick(2000); await flushUI(); status(2);
        assert.doesNotMatch(screen(), /Local presentation:|CONTEXT HOOK MUST NOT EXECUTE/);
        assert.equal(JSON.stringify(ui.view.snapshot.entries), entriesBefore, 'Local timers cannot persist timing entries');
        assert.equal(ui.view.snapshot.live.busy, true, 'UI reload cannot stop remote work');
        ui.detach(); await finished; await flushUI();
        assert.equal(time.active.size, 0, 'Detach must stop original ticker, native Loader, and metadata poll');
        const writes = terminal.writes.length;
        time.tick(5000); await flushUI();
        assert.equal(terminal.writes.length, writes, 'Retired presentation timers must not write to the terminal');
        assert.equal(connection.requests.length, reads, 'Animation, reload, and detach must send no requests');
        assert.equal(ui.view.snapshot.live.busy, true, 'Detach must not abort the remote run');
      } finally { ui.detach(); await finished; await flushUI(); }
    });
  });
});

class BellConnection extends WorkedForConnection {
  constructor(private readonly current: () => Snapshot) { super(); }
  override async request<T = any>(method: string, params?: RecordValue): Promise<T> {
    // Settle events trigger a read-only snapshot refresh; everything else stays read-only too.
    if (method === 'snapshot') { this.requests.push({ method, params }); return structuredClone(this.current()) as T; }
    return super.request<T>(method, params);
  }
}

test('Terminal bell factory rings the local terminal once per remote settle, not on attach', async t => {
  for (const original of [false, true]) await t.test(original ? 'unchanged original' : 'fixture', {
    skip: original && !existsSync(originalBell),
  }, async t => {
    await withRepo(async root => {
      if (original) await copyFile(originalBell, join(root, 'emit-terminal-bel.ts'));
      const bells: string[] = [];
      (globalThis as any).rowanUiBells = bells;
      // The original writes BEL straight to process.stdout, outside pi-tui's frame writes.
      const write = process.stdout.write;
      t.mock.method(process.stdout, 'write', function (this: typeof process.stdout, chunk: unknown, ...rest: unknown[]) {
        if (chunk === '\x07') { bells.push('stdout'); return true; }
        return Reflect.apply(write, this, [chunk, ...rest]);
      });
      const initial = snapshot();
      let seq = initial.seq;
      const connection = new BellConnection(() => ({ ...initial, seq }));
      const terminal = new WorkedForTerminal();
      const ui = new RemoteTui(connection, 'slot', initial, terminal, {
        presentationPaths: [adapter], presentationConfig: join(root, 'absent-config.json'), theme: 'dark',
      });
      const finished = ui.run();
      const send = async (type: string) => {
        connection.listener!({ type: 'event', slotId: 'slot', seq: ++seq, event: { type } });
        await flushUI();
      };
      try {
        await ui.initialize(); await flushUI();
        assert.deepEqual(bells, [], 'Attaching to an idle slot must not ring');
        for (let run = 1; run <= 2; run++) {
          await send('agent_start');
          assert.equal(bells.length, run - 1, 'Starting work must not ring');
          await send('agent_settled');
          assert.deepEqual(bells, Array(run).fill(original ? 'stdout' : 'tui'));
        }
        assert.doesNotMatch(plain(ui.tui.getScreenLines()), /Local presentation:/);
        ui.detach(); await finished; await flushUI();
        assert.equal(bells.length, 2, 'Detach must not ring');
      } finally { ui.detach(); await finished; delete (globalThis as any).rowanUiBells; }
    });
  });
});
