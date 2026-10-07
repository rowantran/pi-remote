/**
 * Offline CPU benchmark of STOCK Pi InteractiveMode (fullscreen, not RemoteTui).
 *
 * Run separately, alternating processes on the same machine:
 *   node --import tsx test/native-scroll-benchmark.ts --snapshot /tmp/pi-scroll-session2.json --presentation vanilla
 *   node --import tsx test/native-scroll-benchmark.ts --snapshot /tmp/pi-scroll-session2.json --presentation rowan
 * Add --theme-file ~/.pi/agent/themes/gruvbox-dark.json to BOTH runs to match
 * the remote benchmark's pinned gruvbox-dark theme. Default: built-in dark.
 * Add --width 120 --rows 45 for the narrower comparison, or --profile FILE
 * for a private, exclusively-created CPU profile of only the measured loop.
 * --history context is the unchanged default. --history full is a diagnostic:
 * after init, clear the stock chatContainer and call stock renderSessionEntries
 * with sessionManager.getBranch(). This changes only displayed history, not the
 * real AgentSession/context or saved entries; it is NOT normal startup behavior.
 *
 * This loads a real AgentSession with createAgentSession + SessionManager.open
 * on a mode-0600 JSONL copy in a mode-0700 temporary directory. It calls real
 * InteractiveMode.init(), which binds TUI extensions and renders saved history.
 * It never calls run()/prompt(), changes the real session, or contacts a provider.
 * All resource discovery is replaced by an explicit ResourceLoader; global Pi
 * config, auth, providers, MCP, background workers and executable extension suites
 * are not loaded. Rowan uses the unchanged examples/rowan-ui.ts visual adapter:
 * four original factories, codemode render-only functions, generic compact-tool
 * resolution, and persisted worked-for rendering (NOT the worked-for factory).
 * Normal default tools and compact-tools overrides stay registered and active so
 * stored calls receive their real custom renderers. No executor is invoked; the
 * benchmark never prompts/runs the agent, and provider requests are denied.
 *
 * Instrumentation: read private InteractiveMode.ui/chatContainer for diagnostics;
 * use the installed package's internal loadExtensions entry point to load only
 * the explicit visual adapter. Provider request methods and outbound sockets/fetch
 * throw as safety guards. No rendering/cache/scheduling methods are replaced.
 *
 * Stock native history rendering is compaction-aware; RemoteTui's saved-snapshot
 * benchmark renders the full active branch. Both source and native-context counts
 * and hashes are reported, so identical Snapshot input is NOT claimed to mean
 * identical visible content. Native startup/cwd/session-id/model-availability,
 * extension status and UI metadata can differ from the remote presentation.
 *
 * Each sample injects real PageUp/PageDown input, calls actual renderNow() without
 * forced invalidation, and yields once. Initialization, syntax loading, warmup,
 * transcript hashing, and profiler start/stop are excluded. One terminal frame
 * and actual viewport movement are required for every sample. CPU/render time
 * is NOT delivered FPS: PageUp/PageDown normally use the stock 16ms requestRender
 * throttle (~62.5 scheduled FPS ceiling). renderNow bypasses it here. Terminal
 * emulator, SSH delivery, provider traffic and initial rendering are not measured.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { Session as InspectorSession } from 'node:inspector';
import { Socket } from 'node:net';
import { cpus, homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { LoadExtensionsResult, ResourceLoader, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { RenderExperiment } from './render-experiments.js';
import type { Component, Terminal, TuiAltScreen } from '@earendil-works/pi-tui';
import type { Snapshot } from '../src/protocol.js';
import { transcriptMessages } from '../src/view.js';

const HELP = `Usage: node --import tsx test/native-scroll-benchmark.ts [options]
  --snapshot FILE       Saved protocol Snapshot (default /tmp/pi-scroll-session2.json)
  --presentation NAME   vanilla | rowan (default vanilla; use separate processes)
  --history NAME        context (default, stock startup) | full (display diagnostic)
  --width NUMBER        Columns (default 140; minimum 20)
  --rows NUMBER         Rows (default 45; minimum 10)
  --iterations NUMBER   Measured frames (default 40; minimum 1)
  --theme-file FILE     Explicit theme JSON copied into isolated agent directory
  --profile FILE        New private .cpuprofile; measured loop only; never overwrite
  --experiment NAME     none (default), cache-footer, cache-settled-tools, cache-both,
                        cache-document, cache-document-and-footer
                        Diagnostic idle-only ablations, NOT normal behavior
  --help                Show this help
Warmup: 8 frames. Thinking shown. JSON output contains hashes/counts, not transcript.
CPU/render time is not delivered FPS. Stock scroll scheduling has a 16ms throttle.
Rowan requires the trusted local pi-extensions checkout used by examples/rowan-ui.ts.
CPU profiles contain source file paths/function names; treat them as private.
See this file's header for safety, stock-history and presentation caveats.
`;
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const WARMUP = 8;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const nextTurn = () => new Promise<void>(accept => setImmediate(accept));
function integer(value: string, name: string, min: number) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) throw new Error(`${name}: invalid integer`);
  return n;
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
/** Count ANSI output without retaining it or writing private content to stdout. */
class MemoryTerminal implements Terminal {
  kittyProtocolActive = false;
  bytes = 0;
  writes = 0;
  frames = 0;
  input: (data: string) => void = () => {};
  constructor(readonly columns: number, readonly rows: number) {}
  start(input: (data: string) => void, _resize: () => void) { this.input = input; }
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.bytes += Buffer.byteLength(data);
    this.writes++;
    this.frames += data.split('\x1b[?2026h').length - 1;
  }
  moveBy(lines: number) { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? 'B' : 'A'}`); }
  hideCursor() { this.write('\x1b[?25l'); }
  showCursor() { this.write('\x1b[?25h'); }
  clearLine() { this.write('\x1b[K'); }
  clearFromCursor() { this.write('\x1b[J'); }
  clearScreen() { this.write('\x1b[2J\x1b[H'); }
  setTitle(title: string) { this.write(`\x1b]0;${title}\x07`); }
  setProgress(_active: boolean) {}
}
function parseSnapshot(text: string): Snapshot {
  let s: Snapshot;
  try { s = JSON.parse(text); } catch { throw new Error('Invalid snapshot JSON (contents withheld)'); }
  if (!s || !s.slot || !s.state || !Array.isArray(s.entries) || !s.live
    || !Array.isArray(s.live.messages) || !(s.leafId === null || typeof s.leafId === 'string')) {
    throw new Error('Invalid Snapshot shape (contents withheld)');
  }
  // A real restored AgentSession must have persisted, quiescent input; never fake live state.
  if (s.live.busy || s.live.compacting || s.state.isStreaming || s.live.messages.length
    || Object.keys(s.live.tools ?? {}).length || s.live.steering?.length || s.live.followUp?.length
    || Object.keys(s.live.bash ?? {}).length) throw new Error('Use a quiescent snapshot with persisted history');
  if (s.entries.some(e => e.type === 'session') || (s.leafId && !s.entries.some(e => e.id === s.leafId))) {
    throw new Error('Snapshot entries/leaf are inconsistent');
  }
  if (s.entries.some(e => e.type === 'message' && e.message?.role === 'assistant'
    && ['pending', 'deferred'].includes(e.message.stopReason))) throw new Error('Unfinished assistant history is not supported');
  if (!s.state.model?.id || !s.state.model?.api) throw new Error('Saved model metadata is required');
  return s;
}
async function profiler(path: string | undefined) {
  if (!path) return undefined;
  // Reserve before startup so a bad path cannot invalidate a completed benchmark.
  const file = await open(resolve(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const inspector = new InspectorSession();
  inspector.connect();
  const post = (method: string) => new Promise<any>((accept, reject) => {
    inspector.post(method as any, (err, result) => err ? reject(err) : accept(result));
  });
  await post('Profiler.enable');
  return {
    start: () => post('Profiler.start'),
    async stop() { const { profile } = await post('Profiler.stop'); await file.writeFile(JSON.stringify(profile)); },
    async close() { inspector.disconnect(); await file.close(); },
  };
}

async function main() {
  const { values: args } = parseArgs({ options: {
    snapshot: { type: 'string', default: '/tmp/pi-scroll-session2.json' },
    presentation: { type: 'string', default: 'vanilla' },
    history: { type: 'string', default: 'context' },
    width: { type: 'string', default: '140' }, rows: { type: 'string', default: '45' },
    iterations: { type: 'string', default: '40' }, 'theme-file': { type: 'string' },
    profile: { type: 'string' }, experiment: { type: 'string', default: 'none' }, help: { type: 'boolean' },
  } });
  if (args.help) { process.stdout.write(HELP); return; }
  if (!['vanilla', 'rowan'].includes(args.presentation)) throw new Error('Unknown presentation');
  if (!['context', 'full'].includes(args.history)) throw new Error('Unknown history');
  if (!['none', 'cache-footer', 'cache-settled-tools', 'cache-both', 'cache-document', 'cache-document-and-footer'].includes(args.experiment)) {
    throw new Error('Unknown experiment');
  }
  const width = integer(args.width, 'width', 20), rows = integer(args.rows, 'rows', 10);
  const iterations = integer(args.iterations, 'iterations', 1);
  const snapshotText = await readFile(resolve(args.snapshot), 'utf8');
  const snapshot = parseSnapshot(snapshotText);
  const sourceMessages = transcriptMessages(snapshot);
  const temp = await mkdtemp(join(tmpdir(), 'pi-native-scroll-'));
  await chmod(temp, 0o700);
  const cwd = join(temp, 'workspace'), agentDir = join(temp, 'agent');
  const extensionRoot = process.env.PI_REMOTE_RENDERER_REPO
    ?? join(homedir(), '.pi/agent/git/github.com/rowantran/pi-extensions');
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch, savedConnect = Socket.prototype.connect;
  let networkAttempts = 0, providerAttempts = 0;
  let runtime: { dispose(): Promise<void> } | undefined;
  let mode: { init(): Promise<void>; stop(output?: 'resume-hint'): void } | undefined;
  let profile: Awaited<ReturnType<typeof profiler>>;
  let restoreExperiment: (() => void) | undefined;
  let stopThemeWatcher: (() => void) | undefined;
  let phase = 'isolated setup';
  try {
    await mkdir(cwd, { mode: 0o700 }); await mkdir(agentDir, { mode: 0o700 });
    // Set BEFORE importing Pi: tools-manager caches its agent-dir at module load.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(temp, 'sessions');
    process.env.PI_OFFLINE = '1';
    process.env.PI_REMOTE_RENDERER_REPO = extensionRoot;
    for (const key of ['PI_TUI_WRITE_LOG', 'PI_TUI_DEBUG', 'PI_EXPERIMENTAL', 'PI_REMOTE_SESSION',
      'PI_REMOTE_SESSION_HOST', 'PI_REMOTE_SESSION_ID', 'PI_REMOTE_SESSION_SLOT']) delete process.env[key];
    globalThis.fetch = (() => { networkAttempts++; throw new Error('Network disabled'); }) as typeof fetch;
    Socket.prototype.connect = function () { networkAttempts++; throw new Error('Outbound socket disabled'); } as typeof savedConnect;
    const pi = await import('@earendil-works/pi-coding-agent');
    ({ stopThemeWatcher } = await import(new URL('./modes/interactive/theme/theme.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href));
    const originalAssistantRender = pi.AssistantMessageComponent.prototype.render;
    const originalToolRender = pi.ToolExecutionComponent.prototype.render;
    let themeName = 'dark', themeSha256: string | undefined;
    if (args['theme-file']) {
      const text = await readFile(resolve(args['theme-file']), 'utf8');
      let theme: { name?: string };
      try { theme = JSON.parse(text); } catch { throw new Error('Invalid theme JSON'); }
      if (!theme.name || !/^[a-zA-Z0-9_-]+$/.test(theme.name) || theme.name === 'system') throw new Error('Invalid theme name');
      themeName = theme.name; themeSha256 = hash(text);
      await mkdir(join(agentDir, 'themes'), { mode: 0o700 });
      await writeFile(join(agentDir, 'themes', `${themeName}.json`), text, { mode: 0o600, flag: 'wx' });
    }
    const terminal = new MemoryTerminal(width, rows);
    const settingsManager = pi.SettingsManager.inMemory({
      theme: themeName, tuiMode: 'fullscreen', quietStartup: true, hideThinkingBlock: false,
      cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false },
      terminal: { showImages: false, images: false, trueColor: true, showTerminalProgress: false },
    });
    settingsManager.setProjectTrusted(true);
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    });
    // Safety-only guards, not a fake model runtime. Session still uses a real ModelRuntime.
    for (const name of ['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred',
      'fetchDeferred', 'cancelDeferred', 'generateImages', 'classify', 'getAuth', 'login']) {
      Object.defineProperty(modelRuntime, name, { value: () => { providerAttempts++; throw new Error('Provider calls disabled'); } });
    }
    const internalLoaderUrl = new URL('./core/extensions/loader.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
    const { loadExtensions } = await import(internalLoaderUrl.href) as {
      loadExtensions(paths: string[], cwd: string): Promise<LoadExtensionsResult>;
    };
    const adapter = fileURLToPath(new URL('../examples/rowan-ui.ts', import.meta.url));
    const extensions = await loadExtensions(args.presentation === 'rowan' ? [adapter] : [], cwd);
    if (extensions.errors.length) throw new Error('Explicit visual extension failed to load (contents withheld)');
    const resourceLoader: ResourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => '', getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {},
    };
    const historyFile = join(temp, 'history.jsonl');
    const header = { type: 'session', version: pi.CURRENT_SESSION_VERSION,
      id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-01-01T00:00:00.000Z', cwd };
    await writeFile(historyFile, [header, ...snapshot.entries].map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const sessionManager = pi.SessionManager.open(historyFile, temp, cwd);
    if (snapshot.leafId) sessionManager.branch(snapshot.leafId); else sessionManager.resetLeaf();
    if (hash(JSON.stringify(sessionManager.getEntries())) !== hash(JSON.stringify(snapshot.entries))) {
      throw new Error('History import changed saved entries');
    }
    const historyHash = hash(JSON.stringify(sessionManager.getEntries()));
    const { session } = await pi.createAgentSession({
      cwd, agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager,
      model: structuredClone(snapshot.state.model), thinkingLevel: snapshot.state.thinkingLevel,
      // Keep normal definitions: noTools:'all' would exclude compact renderer overrides.
    });
    if (!(session instanceof pi.AgentSession)) throw new Error('Expected real AgentSession');
    runtime = new pi.AgentSessionRuntime(session, {
      cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [],
    }, async () => { throw new Error('Session replacement disabled'); });
    mode = new pi.InteractiveMode(runtime as InstanceType<typeof pi.AgentSessionRuntime>, {
      terminal, tuiMode: 'fullscreen', initialThemeSetting: themeName,
    });
    phase = 'stock InteractiveMode initialization';
    await mode.init();
    // Observe stock components; full-history mode invokes stock methods without replacing them.
    const observed = mode as unknown as { ui: TuiAltScreen; chatContainer: Component & { clear(): void };
      documentContainer: Component; footerContainer: Component;
      renderSessionEntries(entries: SessionEntry[], options: { updateFooter: boolean }): void };
    const tui = observed.ui;
    // Wait for stock init's asynchronous syntax-language load/invalidation to settle.
    await new Promise(accept => setTimeout(accept, 250));
    const displayedEntries = args.history === 'full' ? sessionManager.getBranch() : sessionManager.buildContextEntries();
    if (args.history === 'full') {
      phase = 'diagnostic full-history display rebuild';
      observed.chatContainer.clear();
      observed.renderSessionEntries(displayedEntries, { updateFooter: true });
      tui.requestRender();
      await nextTurn();
    }
    tui.renderNow(); await nextTurn();
    const displayedRecords = displayedEntries.flatMap<unknown>(entry => entry.type === 'custom'
      || (entry.type === 'usage' && entry.kind === 'cache_warm') ? [entry] : pi.sessionEntryToContextMessages(entry));
    if (args.presentation === 'rowan' && pi.AssistantMessageComponent.prototype.render === originalAssistantRender) {
      throw new Error('Rowan assistant background factory did not activate');
    }
    const builtinToolDefinitions = ['read', 'bash', 'edit', 'write', 'find', 'grep', 'ls'].map(name => {
      const definition = session.getToolDefinition(name);
      const registered = extensions.extensions.map(extension => extension.tools.get(name)?.definition).find(Boolean);
      return { name, present: !!definition, renderShell: definition?.renderShell ?? null,
        renderCall: !!definition?.renderCall, renderResult: !!definition?.renderResult,
        extensionRegistered: !!registered, usesRegisteredRenderCall: !!registered && definition?.renderCall === registered.renderCall,
        usesRegisteredRenderResult: !!registered && definition?.renderResult === registered.renderResult };
    });
    if (args.presentation === 'rowan' && builtinToolDefinitions.some(definition => !definition.present
      || definition.renderShell !== 'self' || !definition.usesRegisteredRenderCall || !definition.usesRegisteredRenderResult)) {
      throw new Error('Rowan compact builtin rendering definitions were excluded or replaced');
    }
    if (args.experiment !== 'none') {
      const { installRenderExperiment } = await import('./render-experiments.js');
      restoreExperiment = installRenderExperiment(args.experiment as RenderExperiment, {
        document: observed.documentContainer, footer: observed.footerContainer,
      });
    }
    const renderedLines = observed.chatContainer.render(width);
    const nativeContext = session.messages;
    const beforeHistory = hash(JSON.stringify(sessionManager.getEntries()));
    if (historyHash !== beforeHistory) throw new Error('Initialization changed history entries');
    const initialViewport = tui.viewportTop;
    async function frame(index: number) {
      const before = { frames: terminal.frames, bytes: terminal.bytes, writes: terminal.writes, top: tui.viewportTop };
      const start = performance.now();
      terminal.input(index % 2 ? PAGE_DOWN : PAGE_UP);
      const renderStart = performance.now();
      tui.renderNow();
      const end = performance.now();
      const writes = terminal.writes;
      const result = { inputMs: renderStart - start, renderMs: end - renderStart, totalMs: end - start,
        bytes: terminal.bytes - before.bytes, frames: terminal.frames - before.frames, writes: writes - before.writes,
        movedLines: Math.abs(tui.viewportTop - before.top) };
      await nextTurn();
      if (terminal.writes !== writes || result.frames !== 1) throw new Error('Unexpected asynchronous output/frame; initialization may not be settled');
      if (!result.movedLines) throw new Error('No viewport movement; use fewer rows or longer history');
      if (networkAttempts || providerAttempts || session.isStreaming) throw new Error('Safety guard detected unexpected activity');
      return result;
    }
    phase = 'warmup';
    for (let i = 0; i < WARMUP; i++) await frame(i);
    profile = await profiler(args.profile);
    phase = 'measured loop';
    await profile?.start();
    const samples = [];
    for (let i = 0; i < iterations; i++) samples.push(await frame(i));
    await profile?.stop();
    if (hash(JSON.stringify(sessionManager.getEntries())) !== beforeHistory) throw new Error('Scroll changed history entries');
    if (hash(await readFile(resolve(args.snapshot))) !== hash(snapshotText)) throw new Error('Input snapshot changed during benchmark');
    const factories = ['codex-footer.ts', 'prompt-caret.ts', 'assistant-background.ts', 'compact-tools.ts', 'codemode/render.ts'];
    const files = args.presentation === 'rowan' ? await Promise.all(factories.map(async path => ({
      path, sha256: hash(await readFile(join(extensionRoot, path))),
    }))) : [];
    phase = 'report';
    const report = {
      benchmark: 'stock-InteractiveMode-native-scroll', presentation: args.presentation,
      experiment: args.experiment, history: args.history, historyOverride: args.history === 'full',
      normalBehavior: args.experiment === 'none' && args.history === 'context', idleOnly: true,
      runtime: { node: process.version, pi: pi.VERSION, cpu: cpus()[0]?.model },
      geometry: { width, rows }, iterations, warmup: WARMUP,
      settings: { tuiMode: 'fullscreen', thinkingShown: true, theme: themeName, themeSha256,
        quietStartup: true, images: false, cacheWarming: 'off', compaction: false, activeTools: session.getActiveToolNames().length },
      source: { snapshotSha256: hash(snapshotText), entries: snapshot.entries.length, historySha256: historyHash,
        transcriptMessages: sourceMessages.length, transcriptSha256: hash(JSON.stringify(sourceMessages)) },
      native: { contextEntries: sessionManager.buildContextEntries().length, contextMessages: nativeContext.length,
        contextMessagesSha256: hash(JSON.stringify(nativeContext)), displayedHistoryEntries: displayedEntries.length,
        displayedMessageRecords: displayedRecords.length, displayedMessageRecordsSha256: hash(JSON.stringify(displayedRecords)),
        displayedMessageRecordsDefinition: 'Records supplied to the stock entry renderer, including custom/system/hidden records stock may suppress.',
        renderedTranscriptLines: renderedLines.length,
        renderedTranscriptSha256: hash(renderedLines.join('\n')),
        renderedTranscriptTerminatedSha256: hash(renderedLines.map(line => `${line}\n`).join('')),
        initialViewportTop: initialViewport,
        minMovedLines: Math.min(...samples.map(s => s.movedLines)), maxMovedLines: Math.max(...samples.map(s => s.movedLines)) },
      timingMs: { total: stats(samples.map(s => s.totalMs)), input: stats(samples.map(s => s.inputMs)),
        render: stats(samples.map(s => s.renderMs)) },
      output: { frames: samples.reduce((a, s) => a + s.frames, 0), writes: samples.reduce((a, s) => a + s.writes, 0),
        bytes: samples.reduce((a, s) => a + s.bytes, 0), bytesPerFrame: stats(samples.map(s => s.bytes)) },
      safety: { realAgentSession: true, privateHistoryCopy: true, snapshotUnchanged: true, historyEntriesUnchanged: true,
        discoveredResources: false, networkAttempts, providerAttempts },
      presentationFiles: files,
      presentationAdapterSha256: args.presentation === 'rowan' ? hash(await readFile(adapter)) : undefined,
      presentationActivated: { assistantRenderPatched: pi.AssistantMessageComponent.prototype.render !== originalAssistantRender,
        toolRenderPatched: pi.ToolExecutionComponent.prototype.render !== originalToolRender },
      toolRegistration: 'normal-default-tools-and-explicit-extension-overrides',
      builtinToolDefinitions,
      instrumentation: ['private InteractiveMode.ui/chatContainer diagnostics',
        args.history === 'full' ? 'diagnostic chatContainer.clear + stock renderSessionEntries(getBranch); AgentSession context unchanged'
          : 'stock compaction-aware startup history unchanged',
        'stock internal loadExtensions for explicit adapter only',
        'provider requests and outbound sockets/fetch denied', 'stock theme watcher stopped during cleanup',
        args.experiment === 'none' ? 'no render/cache/scheduling patches' : 'diagnostic idle-only rendering ablation; NOT production behavior'],
      scheduling: { bypassedByRenderNow: true, stockScrollMinIntervalMs: 16, stockScheduledFpsCeiling: 62.5 },
      caveats: [
        'CPU/render timing, not delivered FPS; renderNow bypasses stock PageUp/PageDown 16ms throttle (~62.5 scheduled FPS ceiling).',
        args.history === 'full' ? 'Diagnostic full-active-branch display uses the actual stock renderer; NOT normal startup history. AgentSession model context remains compaction-aware.'
          : 'Native compaction-aware context differs from remote full-active-branch transcript; compare reported counts/hashes, not assumed line parity.',
        'Record selection can be matched, but stock suppression of system/hidden/custom records and notices can still cause rendered line/hash differences.',
        'Native startup header is suppressed; cwd/session-id/auth availability/status metadata are isolated and may differ from remote.',
        'No terminal emulator, SSH delivery, model requests, initial layout or streaming updates are measured.',
        ...(args.presentation === 'rowan' ? ['Unchanged visual adapter includes render-only codemode, generic compact tools and persisted worked-for; no worked-for/execution/provider/MCP/background factory loaded.'] : []),
        ...(args.experiment !== 'none' ? ['Diagnostic idle-only experiment changes rendering/caching assumptions; not normal Pi or a production fix.'] : []),
      ],
      profile: args.profile ? { path: resolve(args.profile), measuredLoopOnly: true, private: true } : undefined,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch {
    // Third-party render exceptions can quote private transcript text. Do not print them.
    throw new Error(`Native benchmark failed during ${phase}; details withheld to protect saved transcript`);
  } finally {
    // Restore diagnostic prototypes BEFORE assistant-background session_shutdown cleanup.
    restoreExperiment?.();
    mode?.stop('resume-hint');
    await runtime?.dispose();
    stopThemeWatcher?.();
    await profile?.close();
    globalThis.fetch = savedFetch; Socket.prototype.connect = savedConnect;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(temp, { recursive: true, force: true });
  }
}
main().catch(error => { process.stderr.write(`Native scroll benchmark: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
