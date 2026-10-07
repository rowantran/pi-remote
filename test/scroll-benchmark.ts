/**
 * Reproducible, offline RemoteTui scroll benchmark. Default runs leave product methods unchanged.
 * Explicit --experiment runs are diagnostic idle-only component-caching ablations.
 *
 * Capture once (read-only hello/list/snapshot; refuses to overwrite the private file):
 *   node --import tsx test/scroll-benchmark.ts --capture /tmp/pi-scroll-snapshot.json \
 *     --host rowan-v2-dev --slot 2 --ui-config /tmp/pi-scroll-no-ui.json \
 *     --ui-extension ./examples/rowan-ui.ts
 * Replay the SAME file, options, dependencies and local UI files in both worktrees:
 *   cp test/scroll-benchmark.ts /tmp/pi-remote-scroll-diagnosis/test/scroll-benchmark.ts
 *   cd /tmp/pi-remote-scroll-diagnosis
 *   node --import tsx test/scroll-benchmark.ts --snapshot /tmp/pi-scroll-snapshot.json \
 *     --ui-config /tmp/pi-scroll-no-ui.json --ui-extension ./examples/rowan-ui.ts \
 *     --theme gruvbox-dark --scenario idle-scroll --iterations 10 \
 *     > /tmp/pi-scroll-baseline-idle.json
 *   cd /Users/rowan/workplace/pi-remote-worktrees/scroll-performance
 *   node --import tsx test/scroll-benchmark.ts --snapshot /tmp/pi-scroll-snapshot.json \
 *     --ui-config /tmp/pi-scroll-no-ui.json --ui-extension ./examples/rowan-ui.ts \
 *     --theme gruvbox-dark --scenario idle-scroll --iterations 10 \
 *     > /tmp/pi-scroll-fixed-idle.json
 *
 * Use an unchanged baseline worktree, not the primary checkout. Alternate multiple
 * baseline/fixed runs on the same machine. Do not profile only one variant.
 * Repeat for metadata-update-scroll and assistant-delta-scroll. Separate processes
 * and 10 or 20 iterations avoid overlapping the normal 15-second metadata timer;
 * the timer is not disabled. Without --scenario, all three run in one process.
 * The no-UI config path above must not exist. Resolve the unchanged Rowan adapter
 * inside EACH worktree: its import aliases must point to that worktree's classes,
 * not a primary-checkout adapter selected by ~/.pi/remote-client.json. Check equal
 * transcript hashes/line counts and presentation.assistantRenderPatched=true.
 * --theme can pin the theme instead of using the config/local Pi theme setting.
 * Trusted UI extensions have normal process privileges: use only offline adapters.
 * Active renderer timers or async hooks that cause extra frames fail the benchmark
 * rather than silently doing uncounted work. --profile records only measured frames;
 * profile runs should be separate from unprofiled timing comparisons.
 * This measures CPU/rendering, not SSH,
 * terminal emulator throughput, initial rendering, or sustained provider traffic.
 * Wheel/PageUp events use pi-tui's 16 ms throttle; renderNow bypasses that scheduler
 * so this benchmark measures CPU frame cost, not achievable scheduled display FPS.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { Session as InspectorSession } from 'node:inspector/promises';
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { cpus, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AssistantMessageComponent, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import type { Terminal } from '@earendil-works/pi-tui';
import { readPresentationConfig } from '../src/presentation.js';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from '../src/protocol.js';
import { remoteSessionEnv } from '../src/remote-session.js';
import { RemoteTui } from '../src/tui.js';
import { transcriptMessages } from '../src/view.js';
import { installRenderExperiment, RENDER_EXPERIMENTS, type RenderExperiment } from './render-experiments.js';

const HELP = `Usage: node --import tsx test/scroll-benchmark.ts [options]
  --snapshot FILE      Replay a saved Snapshot; no remote connection is opened
  --capture FILE       Capture once, then replay locally; new file only, mode 0600
  --host HOST          Required with --capture (SSH alias)
  --slot NUMBER|ID     Required with --capture; never opens a picker or attaches
  --ui-config FILE     Local presentation config (default ~/.pi/remote-client.json)
  --ui-extension FILE  Trusted local presentation adapter (repeatable; cwd-relative)
  --theme NAME         Optional fixed theme (otherwise normal UI theme selection)
  --width NUMBER       Terminal columns (default 140; minimum 20)
  --rows NUMBER        Terminal rows (default 45; minimum 10)
  --iterations NUMBER  Measured frames per scenario (default 40)
  --scenario NAME      Run only idle-scroll, metadata-update-scroll, or
                       assistant-delta-scroll (default: all three)
  --profile FILE       Save a CPU profile of the measured loop only (single scenario)
  --experiment NAME    Idle-only diagnostic ablation: none (default), cache-footer,
                       cache-settled-tools, cache-both, cache-document,
                       cache-document-and-footer. NOT production behavior.
  --help               Show this help
Exactly one of --snapshot or --capture is required. Capture performs only the
transport handshake, list and snapshot, then closes SSH before any replay.
Output is JSON statistics, never transcript text. See the file header for the
baseline/fixed commands and limitations. No profiler is started by this script.
`;

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const nextTurn = () => new Promise<void>(accept => setImmediate(accept));
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const CTRL_END = '\x1b[1;5F';
const WARMUP_FRAMES = 8;
const SCENARIOS = ['idle-scroll', 'metadata-update-scroll', 'assistant-delta-scroll'] as const;
type Scenario = typeof SCENARIOS[number];
const DELTA = ' Scroll benchmark synthetic assistant delta.';

function integer(value: string, name: string, minimum: number): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return n;
}

function parseSnapshot(text: string): Snapshot {
  let value: Snapshot;
  // JSON.parse errors can quote private message contents. Do not propagate them.
  try { value = JSON.parse(text); } catch { throw new Error('Invalid snapshot JSON (contents withheld)'); }
  if (!value || typeof value !== 'object' || typeof value.slot?.id !== 'string'
    || !value.state || typeof value.state !== 'object' || !Array.isArray(value.entries)
    || !(value.leafId === null || typeof value.leafId === 'string')
    || !value.live || !Array.isArray(value.live.messages) || !value.live.tools
    || !Array.isArray(value.live.steering) || !Array.isArray(value.live.followUp)
    || !Array.isArray(value.ui) || !Number.isSafeInteger(value.seq) || value.seq < 0
    || value.seq > Number.MAX_SAFE_INTEGER - 1_000_000) {
    throw new Error('File must contain a protocol Snapshot object (contents withheld)');
  }
  return value;
}

async function capture(path: string, host: string, reference: string): Promise<string> {
  // Import the real transport only in capture mode. No attach or RPC is used.
  const { connectSsh } = await import('../src/client.js');
  const { selectSlot } = await import('../src/cli.js');
  const connection = await connectSsh({ host });
  let text: string;
  try {
    const slots = await connection.request<Snapshot['slot'][]>('list');
    const slot = selectSlot(slots, reference);
    text = JSON.stringify(await connection.request<Snapshot>('snapshot', { slotId: slot.id })) + '\n';
    parseSnapshot(text);
  } finally { connection.close(); }
  // Exclusive creation also avoids truncating a symlink or an existing private capture.
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(text); }
  finally { await file.close(); }
  return text;
}

/** Counters only: never retain or print any terminal/transcript strings. */
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
    // pi-tui writes one synchronized-output buffer for every alternate-screen frame.
    this.frames += data.split('\x1b[?2026h').length - 1;
  }
  moveBy(lines: number) { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? 'B' : 'A'}`); }
  hideCursor() { this.write('\x1b[?25l'); }
  showCursor() { this.write('\x1b[?25h'); }
  clearLine() { this.write('\x1b[K'); }
  clearFromCursor() { this.write('\x1b[J'); }
  clearScreen() { this.write('\x1b[2J\x1b[H'); }
  setTitle(title: string) { this.write(`\x1b]0;${title}\x07`); }
  setProgress(_active: boolean) {} // No real terminal's animation or output timer.
}

/** Only local display metadata reads are allowed, and they use saved data. */
class FakeConnection implements RemoteConnection {
  private listeners = new Set<(event: RemoteEvent) => void>();
  readonly requests: string[] = [];
  readonly unexpected: string[] = [];
  constructor(private original: Snapshot) {}
  async request<T = any>(method: string, params?: RecordValue): Promise<T> {
    const name = method === 'rpc' ? `rpc:${params?.command?.type}` : method;
    this.requests.push(name);
    let value: unknown;
    switch (name) {
      case 'rpc:get_session_stats': value = this.original.presentation?.stats ?? {}; break;
      case 'rpc:get_available_models': value = { models: this.original.presentation?.models ?? [] }; break;
      case 'rpc:get_commands': value = { commands: [] }; break;
      case 'filesystem_metadata': value = {
        ...(this.original.presentation?.gitBranch === undefined ? {} : { gitBranch: this.original.presentation.gitBranch }),
        ...(this.original.presentation?.homeDir === undefined ? {} : { homeDir: this.original.presentation.homeDir }),
      }; break;
      default:
        this.unexpected.push(name);
        throw new Error('Unexpected request during offline replay');
    }
    return structuredClone(value) as T;
  }
  onEvent(listener: (event: RemoteEvent) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  onDisconnect(_listener: (error: Error) => void) { return () => {}; }
  close() { this.listeners.clear(); }
  emit(event: RemoteEvent) { for (const listener of this.listeners) listener(event); }
}

// Read-only observation of the actual dispatch queue and rendered document.
// Default runs do not replace methods/caches/timers. Explicit experiments are
// installed separately and disclosed in the result's methodology.
type ObservedUi = {
  lifecycle: Promise<void>;
  transcript: { render(width: number): string[] };
  localTheme: { name: string };
};
const observe = (ui: RemoteTui) => ui as unknown as ObservedUi;
async function settle(ui: RemoteTui): Promise<void> {
  let lifecycle: Promise<void>;
  do {
    lifecycle = observe(ui).lifecycle;
    await lifecycle;
    await Promise.resolve(); // Flush presentationChanged's microtask after hooks.
  } while (lifecycle !== observe(ui).lifecycle);
}

function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

async function replay(snapshot: Snapshot, options: { width: number; rows: number; iterations: number; config: string; extensions: string[]; scenarios: readonly Scenario[]; theme?: string; profile?: string; experiment: RenderExperiment }) {
  const terminal = new MemoryTerminal(options.width, options.rows);
  const connection = new FakeConnection(snapshot);
  // Match runTui's local presentation environment, with the same deterministic
  // host label in capture and replay modes, independent of the machine hostname.
  Object.assign(process.env, remoteSessionEnv({ host: 'scroll-benchmark', slotId: snapshot.slot.id, slotNumber: snapshot.slot.number }));
  const originalAssistantRender = AssistantMessageComponent.prototype.render;
  const originalToolRender = ToolExecutionComponent.prototype.render;
  const ui = new RemoteTui(connection, snapshot.slot.id, snapshot, terminal, {
    presentationConfig: options.config, presentationPaths: options.extensions,
    theme: options.theme, host: 'scroll-benchmark',
  });
  let sequence = snapshot.seq;
  const emit = (event: RecordValue) => connection.emit({ type: 'event', slotId: snapshot.slot.id, seq: ++sequence, event });
  const counts = () => {
    const lines = observe(ui).transcript.render(options.width);
    const digest = createHash('sha256');
    for (const line of lines) digest.update(line).update('\n');
    return {
      messages: transcriptMessages(ui.view.snapshot).length,
      transcriptLines: lines.length, transcriptSha256: digest.digest('hex'),
    };
  };
  const assertRequests = () => {
    if (connection.unexpected.length) throw new Error('Replay attempted a non-metadata request; no remote call was made');
  };
  const finished = ui.run();
  let restoreExperiment = () => {};
  try {
    await ui.initialize();
    await settle(ui);
    ui.tui.renderNow(); // Initial rendering, extension loading and metadata are excluded.
    await nextTurn();
    assertRequests();
    const initialCounts = counts();
    restoreExperiment = installRenderExperiment(options.experiment, {
      document: observe(ui).transcript, footer: ui.presentation?.footer,
    });

    async function frame(step: () => void, requireScroll = true) {
      const before = { bytes: terminal.bytes, frames: terminal.frames, viewport: ui.tui.viewportTop, requests: connection.requests.length };
      const start = performance.now();
      step();
      await settle(ui); // Includes real async presentation hooks and invalidation.
      const renderStart = performance.now();
      ui.tui.renderNow(); // Public API cancels pending render timers, without forcing redraw.
      const end = performance.now();
      const result = { ms: end - start, updateAndInputMs: renderStart - start, renderMs: end - renderStart, bytes: terminal.bytes - before.bytes };
      const expectedWrites = terminal.writes;
      await nextTurn(); // Yield between EVERY frame; never a synchronous cache-only loop.
      assertRequests();
      if (terminal.frames - before.frames !== 1 || terminal.writes !== expectedWrites) {
        throw new Error('Extra asynchronous terminal output/frame detected; use a quiescent snapshot and offline UI adapters');
      }
      if (connection.requests.length !== before.requests) throw new Error('Background metadata refresh overlapped a frame; rerun with fewer iterations');
      if (requireScroll && ui.tui.viewportTop === before.viewport) {
        throw new Error('No viewport movement: use a taller transcript or fewer terminal rows');
      }
      return result;
    }

    const scenarios = [];
    const baseState = structuredClone(snapshot.state);
    for (const name of options.scenarios) {
      if (name === 'assistant-delta-scroll') {
        const timestamps = new Set(transcriptMessages(ui.view.snapshot).filter(m => m.role === 'assistant').map(m => m.timestamp));
        let timestamp = 1;
        while (timestamps.has(timestamp)) timestamp++;
        const message = {
          role: 'assistant', api: 'anthropic-messages', provider: 'benchmark', model: 'benchmark', timestamp,
          stopReason: 'pending', content: [{ type: 'text', text: 'Synthetic offline assistant stream.' }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        // Only FakeConnection events create this stream; the real slot was closed.
        await frame(() => { emit({ type: 'agent_start' }); emit({ type: 'message_start', message }); }, false);
      }
      const step = (index: number) => {
        if (name === 'metadata-update-scroll') emit({ type: 'remote_state', state: { ...baseState, thinkingLevel: index % 2 ? 'high' : 'low' } });
        if (name === 'assistant-delta-scroll') emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: DELTA } });
        // Real terminal input goes through RemoteTui/pi-tui listeners. Alternating
        // page direction avoids reaching the top of a long transcript mid-run.
        terminal.input(index % 2 ? PAGE_DOWN : PAGE_UP);
      };
      await frame(() => terminal.input(CTRL_END), false); // Reset viewport before warming.
      for (let i = 0; i < WARMUP_FRAMES; i++) await frame(() => step(i));
      await frame(() => terminal.input(CTRL_END), false); // Same start position for measurements.
      const before = counts();
      const samples = [];
      const inspector = options.profile ? new InspectorSession() : undefined;
      if (inspector) {
        inspector.connect();
        await inspector.post('Profiler.enable');
        await inspector.post('Profiler.start');
      }
      try {
        for (let i = 0; i < options.iterations; i++) samples.push(await frame(() => step(i)));
      } finally {
        if (inspector) {
          const { profile } = await inspector.post('Profiler.stop');
          inspector.disconnect();
          await writeFile(options.profile!, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
        }
      }
      scenarios.push({
        name, measuredFrames: samples.length, warmupFrames: WARMUP_FRAMES,
        before, after: counts(),
        frameMs: statistics(samples.map(s => s.ms)),
        updateAndInputMs: statistics(samples.map(s => s.updateAndInputMs)),
        renderMs: statistics(samples.map(s => s.renderMs)),
        writtenBytesPerFrame: statistics(samples.map(s => s.bytes)),
        totalWrittenBytes: samples.reduce((sum, s) => sum + s.bytes, 0),
        ...(name === 'assistant-delta-scroll' ? { deltaCharactersPerFrame: DELTA.length } : {}),
      });
    }
    return {
      initial: initialCounts, resolvedTheme: observe(ui).localTheme.name,
      presentation: {
        assistantRenderPatched: AssistantMessageComponent.prototype.render !== originalAssistantRender,
        toolRenderPatched: ToolExecutionComponent.prototype.render !== originalToolRender,
      },
      localMetadataRequests: connection.requests, remoteReplayCalls: 0, scenarios,
    };
  } finally {
    restoreExperiment();
    ui.detach();
    await finished;
    await nextTurn(); // Let detach's own async shutdown run; do not dispatch it twice.
  }
}

async function fileHash(path: string): Promise<string | null> {
  try { return hash(await readFile(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function main() {
  const { values } = parseArgs({ options: {
    snapshot: { type: 'string' }, capture: { type: 'string' }, host: { type: 'string' }, slot: { type: 'string' },
    'ui-config': { type: 'string' }, 'ui-extension': { type: 'string', multiple: true },
    theme: { type: 'string' }, width: { type: 'string', default: '140' },
    rows: { type: 'string', default: '45' }, iterations: { type: 'string', default: '40' },
    scenario: { type: 'string' }, profile: { type: 'string' },
    experiment: { type: 'string', default: 'none' }, help: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (Boolean(values.snapshot) === Boolean(values.capture)) throw new Error('Specify exactly one of --snapshot FILE or --capture FILE');
  if (values.capture && (!values.host || !values.slot)) throw new Error('--capture requires --host and --slot');
  if (values.snapshot && (values.host || values.slot)) throw new Error('--host and --slot are capture-only options; replay is offline');
  if (values.scenario !== undefined && !SCENARIOS.includes(values.scenario as Scenario)) {
    throw new Error('--scenario must be idle-scroll, metadata-update-scroll, or assistant-delta-scroll');
  }
  if (values.profile && values.scenario === undefined) throw new Error('--profile requires a single --scenario');
  if (!RENDER_EXPERIMENTS.includes(values.experiment as RenderExperiment)) throw new Error('--experiment is not a supported render ablation');
  if (values.experiment !== 'none' && values.scenario !== 'idle-scroll') throw new Error('--experiment requires --scenario idle-scroll');
  const options = {
    profile: values.profile, experiment: values.experiment as RenderExperiment,
    width: integer(values.width!, '--width', 20), rows: integer(values.rows!, '--rows', 10),
    iterations: integer(values.iterations!, '--iterations', 1),
    config: resolve(values['ui-config'] ?? join(homedir(), '.pi/remote-client.json')),
    extensions: values['ui-extension'] ?? [], theme: values.theme,
    scenarios: values.scenario === undefined ? SCENARIOS : [values.scenario as Scenario],
  };
  const text = values.capture ? await capture(values.capture, values.host!, values.slot!) : await readFile(values.snapshot!, 'utf8');
  const snapshot = parseSnapshot(text);
  if (options.experiment !== 'none' && (snapshot.live.busy || snapshot.live.compacting || Object.values(snapshot.live.tools).some(tool => tool.type !== 'tool_execution_end'))) {
    throw new Error('--experiment requires a settled snapshot with no active tools');
  }
  const config = await readPresentationConfig(options.config, options.extensions);
  const script = fileURLToPath(import.meta.url);
  const root = dirname(dirname(script));
  const sourceFiles = (await readdir(join(root, 'src'))).filter(name => name.endsWith('.ts')).sort();
  const sourceHashes = await Promise.all(sourceFiles.map(async name => [name, await fileHash(join(root, 'src', name))]));
  const result = await replay(snapshot, options);
  process.stdout.write(JSON.stringify({
    benchmarkVersion: 1,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, root },
    input: {
      snapshotSha256: hash(text), scriptSha256: await fileHash(script), sourceSha256: hash(JSON.stringify(sourceHashes)),
      packageLockSha256: await fileHash(join(root, 'package-lock.json')),
      uiConfig: options.config, uiConfigSha256: await fileHash(options.config),
      uiExtensions: await Promise.all(config.extensions.map(async path => ({ path, sha256: await fileHash(path) }))),
      width: options.width, rows: options.rows, iterations: options.iterations, scenarios: options.scenarios,
      entries: snapshot.entries.length, liveMessages: snapshot.live.messages.length,
      capturedBusy: snapshot.live.busy, capturedCompacting: snapshot.live.compacting,
    },
    methodology: {
      scrolling: 'alternating PageUp/PageDown from transcript end',
      timing: 'event/update + input + awaited presentation hooks/microtasks + renderNow; inter-frame yield excluded',
      initialRenderIncluded: false, profilerStarted: Boolean(options.profile), p95: 'nearest rank',
      experiment: options.experiment,
      experimentalBehavior: options.experiment !== 'none' ? 'Idle-only cached-component ablation; not a production fix or normal behavior' : null,
      caveats: [
        'Memory terminal counts bytes but does not model SSH or terminal emulator speed.',
        'Keep node, dependencies, options, terminal environment, theme and imported UI extension files unchanged between variants.',
        'Extension hashes cover configured entry files, not their imported dependencies.',
        'Use a worktree-local adapter in each variant; compare transcript hashes and prototype-patch flags.',
        'Idle means no injected updates; captured live state is replayed unchanged.',
        'Synthetic deltas use FakeConnection only; no real session is modified.',
      ],
    },
    ...result,
  }, null, 2) + '\n');
}

// Withhold arbitrary errors: renderer/extension exceptions can quote transcript
// text. Known benchmark validation failures are safe, everything else is generic.
main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  const safe = /^(Specify exactly|--(?:capture|host|width|rows|iterations|scenario|profile|experiment)|Invalid snapshot JSON|File must contain|Replay attempted|Extra asynchronous|Background metadata|No viewport movement)/.test(message);
  process.stderr.write(`Scroll benchmark failed: ${safe ? message : 'check input paths, private capture destination, SSH, and trusted UI configuration (details withheld)'}\n`);
  process.exitCode = 1;
});
