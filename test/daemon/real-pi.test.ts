/**
 * Slots in the daemon, with the pinned stock Pi CLI and an offline fixture provider.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Supervisor } from '../../src/daemon/supervisor.js';
import { ScreenState } from '../../src/protocol/screen.js';
import { readJsonl, writeJsonl } from '../../src/protocol/jsonl.js';
import { socketPath } from '../../src/protocol/paths.js';
import { EDITOR_SECTION, encodeBarrier, encodeSetText, type PiExtensionMessage } from '../../src/protocol/pi-extension.js';
import { PI_VERSION, PROTOCOL_VERSION, type RecordValue, type SlotInfo } from '../../src/protocol/types.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const piCli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const fixture = join(repo, 'test/golden/fixture-provider.ts');
const childSlotExtension = join(repo, 'test/fixtures/child-slot-extension.ts');
const customEditorExtension = join(repo, 'test/fixtures/custom-editor-extension.ts');
const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07|\x1b\]8;;[^\x1b]*\x1b\\/g, '');

/** A daemon client that keeps its own copy of the screen, like a real client. */
class Client {
  readonly events: RecordValue[] = [];
  readonly screen = new ScreenState();
  private nextId = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private waiters = new Set<() => void>();
  constructor(readonly socket: Socket) {
    readJsonl(socket, record => {
      if (record.type === 'result') {
        const pending = this.pending.get(record.id); this.pending.delete(record.id);
        if (record.success) pending?.resolve(record.data); else pending?.reject(new Error(record.error));
      } else if (record.type === 'event') {
        this.events.push(record.event);
        if (record.event.type === 'screen') this.screen.apply(record.event.message);
      }
      for (const waiter of this.waiters) waiter();
    }, () => {});
  }
  static async connect(stateDir: string): Promise<Client> {
    const socket = createConnection(socketPath(stateDir));
    await once(socket, 'connect');
    const client = new Client(socket);
    await client.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    return client;
  }
  request<T = any>(method: string, params: RecordValue = {}): Promise<T> {
    const id = `t${++this.nextId}`;
    return new Promise<T>((resolve, reject) => { this.pending.set(id, { resolve, reject }); writeJsonl(this.socket, { type: 'request', id, method, params }); });
  }
  async attach(slotId: string, columns = 100, rows = 30): Promise<RecordValue> {
    const result = await this.request('attach', { slotId, columns, rows });
    for (const message of result.messages as PiExtensionMessage[]) this.screen.apply(message);
    return result;
  }
  /** Every screen line, as plain text. */
  text(): string {
    return this.screen.snapshot().flatMap(message => message.type === 'frame'
      ? Object.values(message.sections).flatMap(diff => diff.insert) : []).map(strip).join('\n');
  }
  frameWidth(): number | undefined {
    return (this.screen.snapshot().find(message => message.type === 'frame') as { width?: number } | undefined)?.width;
  }
  async until<T>(check: () => T | undefined | false, label: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}\n${this.text()}`);
      await new Promise<void>(resolve => { const done = () => { this.waiters.delete(done); resolve(); }; this.waiters.add(done); setTimeout(done, 200); });
    }
  }
}

/** A daemon with a slot running the pinned Pi CLI and the offline fixture provider. */
async function setup(t: import('node:test').TestContext, extraArgs: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'pi-remote-daemon-'));
  const stateDir = join(root, 'state'), agent = join(root, 'agent'), gates = join(root, 'gates'), workspace = join(root, 'workspace');
  await Promise.all([mkdir(agent, { recursive: true }), mkdir(gates), mkdir(workspace)]);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'dark', quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } }));
  const env = { HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', GOLDEN_GATE_DIR: gates, TERM: 'xterm-256color' };
  const daemon = { supervisor: new Supervisor({ stateDir, executable: process.execPath, prefixArgs: [piCli], env }) };
  await daemon.supervisor.start();
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    await daemon.supervisor.stop();
    await rm(root, { recursive: true, force: true });
  });
  const connect = async () => { const client = await Client.connect(stateDir); clients.push(client); return client; };
  const first = await connect();
  const args = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--no-approve', '--extension', fixture, '--model', 'golden-local/transcript', '--tools', 'bash', '--session-dir', join(root, 'sessions'), ...extraArgs];
  const created: SlotInfo = await first.request('create', { cwd: workspace, args });
  const listed = async (client = first) => (await client.request<SlotInfo[]>('list')).find(slot => slot.id === created.id)!;
  const running = async (client = first) => {
    for (const deadline = Date.now() + 20_000; (await listed(client)).status !== 'running';) {
      assert.ok(Date.now() < deadline, 'slot starts'); await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await running();
  /** Stop this daemon and start another on the same state, as restart-daemon does. */
  const restart = async () => {
    for (const client of clients.splice(0)) client.socket.destroy();
    await daemon.supervisor.stop();
    daemon.supervisor = new Supervisor({ stateDir, executable: process.execPath, prefixArgs: [piCli], env });
    await daemon.supervisor.start();
  };
  return { root, stateDir, created, first, connect, listed, running, restart };
}

test('slots run Pi in a PTY and share its screen, size and activity with clients', { timeout: 120_000 }, async t => {
  const { stateDir, created, first, connect, listed } = await setup(t);
  assert.ok((await listed()).pid! > 0);

  await first.attach(created.id);
  await first.until(() => first.text().includes('transcript'), 'the footer');
  await first.until(() => first.frameWidth() === 100, 'the first client sets the size');

  // Keys go to Pi through its terminal; the screen copy follows.
  await first.request('input', { slotId: created.id, data: '!echo DAEMON_SHELL_OK\r' });
  await first.until(() => first.text().split('DAEMON_SHELL_OK').length > 2, 'the shell output');

  // A second client gets the current screen at once, and takes the size when it types.
  const second = await connect();
  const attached = await second.attach(created.id, 80, 24);
  assert.ok(second.text().includes('DAEMON_SHELL_OK'), 'attach returns the current screen');
  // Pi set the window title at startup, before this client attached.
  assert.ok((attached.messages as PiExtensionMessage[]).some(message => message.type === 'terminal' && message.kind === 'title' && message.data.includes('π - ')), 'attach returns the window title');
  // The host answered Pi's program status query (OSC 7501), so Pi reported its status.
  assert.ok((attached.messages as PiExtensionMessage[]).some(message => message.type === 'terminal' && message.kind === 'status' && message.data.startsWith('\x1b]7501;state=idle')), 'attach returns the program status');
  assert.equal(second.frameWidth(), 100, 'attaching alone does not take the size');
  await second.request('input', { slotId: created.id, data: 'x' });
  await second.until(() => second.frameWidth() === 80, 'the new width');
  await first.until(() => first.frameWidth() === 80, 'the new width for every client');
  await second.request('input', { slotId: created.id, data: '\x7f' });

  // Lifecycle events reach activity watchers, without transcript text.
  const watcher = await connect();
  const watched = await watcher.request('watch_activity');
  assert.equal(watched.slots.find((slot: RecordValue) => slot.slot.id === created.id).busy, false);
  await first.request('input', { slotId: created.id, data: 'GOLDEN_SECOND_USER\r' });
  const kinds = () => watcher.events.filter(event => event.type === 'remote_activity' && event.slot.id === created.id).map(event => event.source.type);
  await watcher.until(() => kinds().includes('agent_settled'), 'agent_settled activity');
  assert.ok(kinds().includes('agent_start'));
  assert.ok(!JSON.stringify(watcher.events).includes('Second response'), 'activity carries no transcript text');
  await first.until(() => first.text().includes('GOLDEN_SECOND_DONE'), 'the response');

  // The editor section and the session are in the screen copy.
  const session = first.screen.sessionInfo!;
  assert.equal(session.remote?.slotId, created.id);
  assert.ok(session.sessionFile);
  assert.ok(first.screen.snapshot().some(message => message.type === 'frame' && message.sections[EDITOR_SECTION]));


  await first.request('kill', { slotId: created.id });
  assert.equal((await listed()).status, 'exited');
});

for (const editor of ['default', 'extension'] as const) {
  test(`after /reload and /new, the ${editor} editor stays local and the Pi extension keeps reporting`, { timeout: 120_000 }, async t => {
    const { created, first } = await setup(t, editor === 'extension' ? ['--extension', customEditorExtension] : []);
    await first.attach(created.id);
    const frame = () => first.screen.snapshot().find(message => message.type === 'frame') as Extract<PiExtensionMessage, { type: 'frame' }> | undefined;
    const installed = () => first.screen.snapshot().find(message => message.type === 'editorInstalled') as Extract<PiExtensionMessage, { type: 'editorInstalled' }> | undefined;
    let barrier = 0;
    /** Type into Pi's editor and wait for the Pi extension to report the state after it. */
    const typed = async (data: string, text: string, label: string) => {
      const id = `test:${++barrier}`;
      await first.request('input', { slotId: created.id, data: data + encodeBarrier(id) });
      await first.until(() => first.events.some(event => event.type === 'screen' && event.message.type === 'editor'
        && event.message.barrier === id && event.message.state.text === text), `the editor state after ${label}`);
    };
    await first.until(() => frame()?.editorFocused, 'the focused editor');
    assert.equal(installed()?.editor, editor);
    await typed('x', 'x', 'typing');
    await typed('\x7f', '', 'deleting');

    for (const [command, done] of [['/reload', 'Reloaded'], ['/new', 'New session started']] as const) {
      await first.request('input', { slotId: created.id, data: encodeSetText(command) + '\r' });
      await first.until(() => first.text().includes(done), `${command} to finish`);
      await first.until(() => frame()?.editorFocused, `the focused editor after ${command}`);
      assert.equal(installed()?.editor, editor, `the ${editor} editor after ${command}`);
      await typed('y', 'y', `typing after ${command}`);
      await typed('\x7f', '', `deleting after ${command}`);
      // The reloaded Pi extension still runs its commands.
      const actions = first.events.filter(event => event.type === 'screen' && event.message.type === 'clientAction').length;
      await first.request('input', { slotId: created.id, data: encodeSetText('/status') + '\r' });
      await first.until(() => first.events.filter(event => event.type === 'screen' && event.message.type === 'clientAction').length > actions, `/status after ${command}`);
    }
  });
}

test('restart_daemon reopens slots from their session files', { timeout: 120_000 }, async t => {
  const { created, first, connect, listed, running, restart } = await setup(t);
  await first.attach(created.id);
  await first.request('input', { slotId: created.id, data: 'GOLDEN_SECOND_USER\r' });
  await first.until(() => first.text().includes('GOLDEN_SECOND_DONE'), 'the response');
  await first.until(() => first.screen.sessionInfo?.entryCount, 'saved entries');
  // The screen can show the reply just before Pi settles.
  await first.until(() => first.events.some(event => event.type === 'agent_settled'), 'agent_settled');
  const result = await first.request('restart_daemon');
  assert.equal(result.accepted, true, JSON.stringify(result.blocked));
  await restart();
  const client = await connect();
  await running(client);
  await client.attach(created.id);
  await client.until(() => client.text().includes('GOLDEN_SECOND_DONE'), 'the restored transcript');
});

test('the terminal client attaches to a slot, edits locally, reconnects, and detaches', { timeout: 120_000 }, async t => {
  const { stateDir, created, root } = await setup(t);
  const { ReconnectingConnection } = await import('../../src/client/reconnect.js');
  const { connectLocal } = await import('../../src/cli/connections.js');
  const { runTerminalSession } = await import('../../src/tui/terminal-session.js');
  const sockets: { destroy(): void }[] = [];
  const connection = await ReconnectingConnection.connect(async () => {
    const inner = await connectLocal(stateDir);
    sockets.push({ destroy: () => inner.close() });
    return inner;
  }, { minDelayMs: 50, maxDelayMs: 200 });
  t.after(() => connection.close());
  const writes: string[] = [];
  let input: (data: string) => void = () => {};
  const terminal = {
    columns: 90, rows: 30, kittyProtocolActive: true,
    start(onInput: (data: string) => void) { input = onInput; }, stop() {}, async drainInput() {},
    write(data: string) { writes.push(data); },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const output: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
  t.after(() => { process.stdout.write = write; });
  const screen = () => strip(writes.join(''));
  const until = async (check: () => boolean, label: string) => {
    for (const deadline = Date.now() + 20_000; !check();) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const done = runTerminalSession(connection, created, { terminal: terminal as never, theme: 'dark', presentationConfig: join(root, 'no-config.json') });
  await until(() => screen().includes('transcript'), 'the footer');
  for (const key of 'local draft') input(key);
  await until(() => screen().includes('local draft'), 'the local draft');
  // Lose the transport: the client reattaches to the same slot and keeps the draft Pi has.
  sockets.at(-1)!.destroy();
  await until(() => sockets.length > 1, 'a new connection');
  await new Promise(resolve => setTimeout(resolve, 500));
  input('!');
  await until(() => screen().includes('local draft!'), 'typing after the reconnect');
  for (let n = 0; n < 'local draft!'.length; n++) input('\x7f');
  await new Promise(resolve => setTimeout(resolve, 300));
  input('\x04'); // Ctrl+D with an empty editor detaches.
  await done;
  assert.match(output.join(''), new RegExp(`Detached from slot 1 / ${created.id}`));
  assert.equal((await connection.request('list')).find(slot => slot.id === created.id)?.status, 'running', 'Pi keeps running');
});

test('another extension forks into a child slot with the extension API, and the client opens it', { timeout: 120_000 }, async t => {
  const { stateDir, created, root, connect } = await setup(t, ['--extension', childSlotExtension]);
  const { connectLocal } = await import('../../src/cli/connections.js');
  const { runTerminalSession } = await import('../../src/tui/terminal-session.js');
  const connection = await connectLocal(stateDir);
  t.after(() => connection.close());
  const writes: string[] = [];
  let input: (data: string) => void = () => {};
  const terminal = {
    columns: 120, rows: 30, kittyProtocolActive: true,
    start(onInput: (data: string) => void) { input = onInput; }, stop() {}, async drainInput() {},
    write(data: string) { writes.push(data); },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  t.after(() => { process.stdout.write = write; });
  const opened: { invocation: { command: string; args: string[] }; targetId: string; direction: string }[] = [];
  const TARGET = '00000000-0000-4000-8000-000000000000';
  let splitError: Error | undefined;
  const sideLauncher = {
    captureTarget: async () => { if (splitError) throw splitError; return TARGET; },
    open: async (options: typeof opened[number]) => { opened.push(options); },
  };
  const screen = () => strip(writes.join(''));
  const until = async (check: () => boolean, label: string) => {
    for (const deadline = Date.now() + 20_000; !check();) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}\n${screen().slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const type = (text: string) => { for (const key of text) input(key); };
  const gate = (name: string) => existsSync(join(root, 'gates', name));
  const done = runTerminalSession(connection, created, {
    terminal: terminal as never, theme: 'dark', presentationConfig: join(root, 'no-config.json'),
    attachContext: { local: true, stateDir }, sideLauncher: sideLauncher as never,
  });
  await until(() => screen().includes('transcript'), 'the footer');
  type('GOLDEN_SECOND_USER\r');
  await until(() => gate('settled-ready'), 'the first run settles');
  // The extension forks the last finished run while another run is in progress.
  type('BUSY_WORK\r');
  await until(() => gate('stream-ready'), 'the busy run');
  type('/fork-child GOLDEN_SECOND_USER again\r');
  await until(() => screen().includes('CHILD_OPENED'), 'the extension hears that the pane opened');

  const child = (await connection.request('list')).find(slot => slot.parentSlotId === created.id)!;
  assert.ok(child, 'a child slot of the parent');
  assert.ok(screen().includes(`CHILD_OPENED in #${child.number} from #${created.number}`));
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.targetId, TARGET);
  assert.deepEqual(opened[0]!.invocation.args.slice(1), ['attach', '--local', '--state-dir', stateDir, '--theme', 'dark', child.id]);
  assert.ok(child.sessionFile!.startsWith(join(root, 'children')), child.sessionFile);

  const viewer = await connect();
  await viewer.attach(child.id, 120, 40);
  await viewer.until(() => viewer.text().split('GOLDEN_SECOND_DONE').length > 2, 'the child answers its prompt');
  assert.ok(!viewer.text().includes('BUSY_WORK'), 'the busy run stays in the parent');

  // When the client cannot open a pane, the extension gets the reason.
  splitError = new Error('Ghostty splits require macOS.');
  type('/fork-child\r');
  await until(() => screen().includes('CHILD_FAILED Ghostty splits require macOS.'), 'the split failure reaches the extension');
  assert.equal((await connection.request('list')).filter(slot => slot.parentSlotId === created.id && slot.status !== 'exited').length, 2);

  input('\x1c');
  await done;
});
