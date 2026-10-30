import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile, chmod, lstat } from 'node:fs/promises';
import { availableParallelism, freemem, homedir, hostname, loadavg, tmpdir, totalmem, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJsonl, writeJsonl } from '../protocol/jsonl.js';
import { ACTIVITY_CAPABILITY, activitySlot, activitySource, type ActivitySnapshot } from '../protocol/notification-stream.js';
import { PiTerminal } from './pi-terminal.js';
import { ScreenState } from '../protocol/screen.js';
import type { CompanionMessage, TerminalAnswers } from '../protocol/companion.js';
import { remoteSessionEnv } from '../protocol/remote-session.js';
import { socketPath } from '../protocol/paths.js';
import type { FileMethod, MethodResult, ClientTerminal, SessionInfo } from '../protocol/methods.js';
import { defaultSessionDir, sessionDirArg, sideSessionDir, withSessionDir } from './session-dirs.js';
import { forkSideSession } from './side-fork.js';
import { PI_VERSION, PROTOCOL_VERSION, errorText, type CreateOptions, type RecordValue, type Request, type SlotInfo, type ServerRecord } from '../protocol/types.js';

// SessionManager returns Dates; JSON serialization produces the protocol's ISO strings.
type SessionInfoSource = Omit<SessionInfo, 'created' | 'modified'> & { created: Date; modified: Date };

const exec = promisify(execFile);
/** Kinds of extension dialog Pi can wait on (from the companion's ui_prompt events). */
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor', 'custom']);
const RESERVED_ARGS = new Set(['--mode', '--tui-mode', '--print', '-p', '--session', '--session-id', '--fork', '--continue', '-c', '--resume', '-r', '--no-session', '--export', '--help', '-h', '--version', '-v', '--api-key']);

/** The installed code this daemon runs: a deployed release directory, or a source checkout. */
const RELEASE = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const DAEMON_STARTED_AT = new Date().toISOString();
const BUSY = 'Remote Pi is busy. Confirm reload to interrupt running work and discard queued prompts.';
/** The companion extension the daemon loads into slots, next to this module. */
const COMPANION = fileURLToPath(new URL(`../companion/index.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));
/** Pi in a slot always uses the kitty keyboard protocol; clients send keys in that encoding. */
const KITTY_FLAGS = 7;
/** Terminal size until a client attaches. */
const DEFAULT_SIZE = { columns: 120, rows: 40 };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** One slot's running Pi: its terminal host, its screen copy, and the client that sets its size. */
interface PiRuntime { host: PiTerminal; screen: ScreenState; owner?: Peer }

/** `reopen` marks a slot that was running when `restart_daemon` stopped the daemon. The next
 * daemon starts it again from its session file, exactly like /reload. Crashes never set it. */
interface StoredSlot { id: string; number?: number; parentSlotId?: string; cwd: string; createdAt: string; args: string[]; sessionFile?: string; sessionName?: string; reopen?: boolean }
/** Whether Pi is working, from the companion's lifecycle events. */
interface Live { busy: boolean; compacting: boolean }
const idle = (): Live => ({ busy: false, compacting: false });
interface Slot extends StoredSlot {
  runtime?: PiRuntime;
  status: 'starting' | 'running' | 'exited';
  error?: string;
  startupRetry?: NodeJS.Timeout;
  /** Never persisted or replayed; bound to the initial process generation only. */
  initialPrompt?: { message: string; incarnation: number };
  sideExpiry?: NodeJS.Timeout;
  detachedAt?: number;
  stopping?: boolean;
  creating?: boolean;
  live: Live;
  /** Open extension dialogs, by ID. */
  ui: Map<string, RecordValue>;
  seq: number;
  state: RecordValue;
  changing: boolean;
  restarting: boolean;
  mutations: number;
  /** Notification flags for the current run. */
  activityAborted?: boolean;
  activityRetryError?: boolean;
  /** Monotonic process generation; late replies and events cannot affect its replacement. */
  incarnation: number;
}
interface Peer { socket: Socket; slotId?: string; activity?: boolean; verified: boolean; pending: number
  /** The attached client's terminal. */
  terminal?: ClientTerminal }
export interface DaemonOptions { stateDir: string; executable?: string; prefixArgs?: string[]; env?: NodeJS.ProcessEnv; skipVersionCheck?: boolean; sideIdleGraceMs?: number }
function object(value: any, name: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function string(value: any, name: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`Missing ${name}`);
  return value;
}
function expandHome(path: string): string { return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path; }

export class Supervisor {
  private slots = new Map<string, Slot>();
  private nextSlotNumber = 1;
  /** Includes pre-launch validation and delivery of the allocated slot ID. */
  private creatingRequests = 0;
  private peers = new Set<Peer>();
  private reservedPaths = new Set<string>();
  private server?: Server;
  private saves = Promise.resolve();
  private stopping = false;
  private reopen = new Set<string>();
  private exitRequest!: () => void;
  /** Resolves when a client asked this daemon to exit for a restart; runDaemon then stops it. */
  readonly exitRequested = new Promise<void>(resolve => { this.exitRequest = resolve; });
  readonly stateDir: string;
  constructor(private options: DaemonOptions) { this.stateDir = resolve(options.stateDir); }

  async start(): Promise<void> {
    await prepareStateDir(this.stateDir);
    await this.checkVersion();
    const reopening: Slot[] = [];
    // Keep the old slots.json array format. A separate high-water mark survives pruning
    // even when every slot was a side slot. Write it before pruning the catalogue.
    try {
      const next = JSON.parse(await readFile(join(this.stateDir, 'slots-counter.json'), 'utf8')).nextSlotNumber;
      if (Number.isSafeInteger(next) && next > 0) this.nextSlotNumber = next;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    try {
      const stored = JSON.parse(await readFile(join(this.stateDir, 'slots.json'), 'utf8')) as StoredSlot[];
      const reserved = new Set(stored.filter(slot => Number.isSafeInteger(slot.number) && slot.number! > 0).map(slot => slot.number!));
      const assigned = new Set<number>();
      let candidate = 1;
      for (const metadata of stored) {
        let number = metadata.number;
        if (!Number.isSafeInteger(number) || number! <= 0 || assigned.has(number!)) {
          while (reserved.has(candidate) || assigned.has(candidate)) candidate++;
          number = candidate++;
        }
        assigned.add(number!);
        this.nextSlotNumber = Math.max(this.nextSlotNumber, number! + 1);
        const { reopen, ...rest } = metadata;
        const slot: Slot = { ...rest, number, status: 'exited', error: 'Daemon restarted. Work stopped; session history is on disk. Resume explicitly.', live: idle(), ui: new Map(), seq: 0, state: {}, changing: false, restarting: false, mutations: 0, incarnation: 0 };
        this.slots.set(metadata.id, slot);
        if (reopen && slot.sessionFile) reopening.push(slot);
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    // Crash records are not resumable slots. Keep their session files for /resume --side.
    // An orderly restart retains a side only when all its ancestors will reopen too.
    const canReopen = (slot: Slot, seen = new Set<string>()): boolean => {
      if (!reopening.includes(slot) || seen.has(slot.id)) return false;
      seen.add(slot.id);
      if (!slot.parentSlotId) return true;
      const parent = this.slots.get(slot.parentSlotId);
      return !!parent && canReopen(parent, seen);
    };
    for (const slot of this.slots.values()) {
      if (slot.parentSlotId && !canReopen(slot)) {
        this.slots.delete(slot.id);
        const index = reopening.indexOf(slot);
        if (index !== -1) reopening.splice(index, 1);
      }
    }
    // Reopen before listening, so reconnecting clients find the slots starting, not stopped.
    for (const slot of reopening) { slot.status = 'starting'; slot.error = undefined; }
    await Promise.all(reopening.map(slot => this.relaunch(slot)));
    await this.save();
    for (const slot of reopening) this.scheduleSideExpiry(slot);
    this.server = createServer(socket => this.connect(socket));
    await new Promise<void>((accept, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath(this.stateDir), accept);
    });
    this.server.on('error', error => console.error(error));
    await chmod(socketPath(this.stateDir), 0o600);
  }

  private async checkVersion(): Promise<void> {
    if (this.options.skipVersionCheck) return;
    const { stdout } = await exec(this.options.executable ?? 'pi', [...(this.options.prefixArgs ?? []), '--version'], { env: { ...process.env, ...this.options.env }, timeout: 15_000 });
    if (stdout.trim() !== PI_VERSION) throw new Error(`Remote Pi version ${stdout.trim()} does not match required ${PI_VERSION}`);
  }
  private connect(socket: Socket) {
    const peer: Peer = { socket, verified: false, pending: 0 };
    this.peers.add(peer);
    socket.on('error', () => {});
    socket.on('close', () => {
      this.peers.delete(peer);
      if (peer.slotId) {
        const runtime = this.slots.get(peer.slotId)?.runtime;
        if (runtime?.owner === peer) runtime.owner = undefined;
        this.peerLeft(peer.slotId);
      }
    });
    readJsonl(socket, request => {
      // Reject a abusive client without affecting any Pi processes.
      if (++peer.pending > 256) { socket.destroy(); return; }
      void this.handle(peer, request).finally(() => { peer.pending--; });
    }, () => socket.destroy());
  }
  private send(peer: Peer, record: ServerRecord) {
    try { writeJsonl(peer.socket, record); }
    catch { peer.socket.destroy(); }
  }
  private info(slot: Slot): SlotInfo {
    return { id: slot.id, number: slot.number, parentSlotId: slot.parentSlotId, parentSlotNumber: slot.parentSlotId ? this.slots.get(slot.parentSlotId)?.number : undefined, cwd: slot.cwd, createdAt: slot.createdAt, pid: slot.status !== 'exited' ? slot.runtime?.host.pid : undefined, status: slot.status, sessionFile: slot.sessionFile, sessionName: slot.sessionName, error: slot.error, clients: [...this.peers].filter(p => p.slotId === slot.id).length };
  }
  private slot(id: any): Slot {
    const slot = this.slots.get(string(id, 'slotId'));
    if (!slot) throw new Error('Slot not found');
    return slot;
  }
  private running(id: any): Slot {
    const slot = this.slot(id);
    if (slot.status === 'exited' || slot.stopping || !slot.runtime) throw new Error(slot.error ?? 'Slot is not running');
    return slot;
  }
  private terminalSlot(id: any): Slot & { runtime: PiRuntime } {
    return this.running(id) as Slot & { runtime: PiRuntime };
  }
  private publish(slot: Slot, event: RecordValue) {
    const record: ServerRecord = { type: 'event', slotId: slot.id, seq: ++slot.seq, event };
    let activity: ServerRecord | undefined;
    for (const peer of this.peers) {
      if (peer.activity) {
        if (!activity) {
          const source = activitySource(event);
          if (!source) continue;
          if (source.type === 'agent_settled') {
            if (slot.activityAborted) source.aborted = true;
            if (slot.activityRetryError) source.error = true;
          }
          activity = { ...record, event: { type: 'remote_activity', slot: activitySlot(this.info(slot)),
            ...(typeof slot.state.sessionId === 'string' ? { sessionId: slot.state.sessionId } : {}), source } };
        }
        this.send(peer, activity);
        continue;
      }
      if (peer.slotId === slot.id && peer.terminal) this.send(peer, record);
    }
  }
  private updateState(slot: Slot, state: RecordValue) {
    const previousId = slot.state.sessionId;
    const starting = slot.status === 'starting';
    const changed = previousId !== undefined && previousId !== state.sessionId;
    // Reconcile identity synchronously at the get_state response, before any client
    // can snapshot the new session with the old session's live transcript.
    if (changed) slot.live = idle();
    slot.state = state;
    slot.status = 'running';
    slot.error = undefined;
    slot.sessionFile = state.sessionFile;
    slot.sessionName = state.sessionName;
    if (changed || starting) this.publish(slot, { type: 'remote_refresh' });
    this.publish(slot, { type: 'remote_state', state });
    void this.save().catch(error => console.error('Cannot save daemon metadata:', error));
    this.sendInitialPrompt(slot);
  }
  /** The companion reports a slot's session as it changes; there is nothing to ask. */
  private refreshState(slot: Slot): Promise<RecordValue> {
    if (slot.status === 'starting') return Promise.reject(new Error('Pi is starting'));
    return Promise.resolve(slot.state);
  }
  private save(): Promise<void> {
    const stored: StoredSlot[] = [...this.slots.values()]
      .filter(slot => !slot.parentSlotId || slot.status !== 'exited' || this.reopen.has(slot.id))
      .map(({id,number,parentSlotId,cwd,createdAt,args,sessionFile,sessionName}) => ({id,number,parentSlotId,cwd,createdAt,args,sessionFile,sessionName, ...(this.reopen.has(id) ? { reopen: true } : {})}));
    const nextSlotNumber = this.nextSlotNumber;
    this.saves = this.saves.catch(() => {}).then(async () => {
      const counter = join(this.stateDir, 'slots-counter.json.tmp');
      await writeFile(counter, JSON.stringify({ nextSlotNumber }) + '\n', { mode: 0o600 });
      await rename(counter, join(this.stateDir, 'slots-counter.json'));
      const temp = join(this.stateDir, 'slots.json.tmp');
      await writeFile(temp, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, join(this.stateDir, 'slots.json'));
    });
    return this.saves;
  }
  private async checkPath(path: string, currentId?: string): Promise<string> {
    // Pi can assign a session file before it creates it (first assistant response).
    const requested = resolve(expandHome(path));
    for (const slot of this.slots.values()) {
      if (slot.status !== 'exited' && slot.id !== currentId && slot.sessionFile && resolve(slot.sessionFile) === requested) throw new Error(`Session is already open in slot ${slot.id}; attach to that slot instead`);
    }
    const canonical = await realpath(requested);
    if (this.reservedPaths.has(canonical)) throw new Error('Session is already being opened');
    for (const slot of this.slots.values()) {
      if (slot.status !== 'exited' && slot.id !== currentId && slot.sessionFile) {
        const owned = await realpath(slot.sessionFile).catch(() => resolve(slot.sessionFile!));
        if (owned === canonical) throw new Error(`Session is already open in slot ${slot.id}; attach to that slot instead`);
      }
    }
    if (this.reservedPaths.has(canonical)) throw new Error('Session is already being opened');
    this.reservedPaths.add(canonical);
    return canonical;
  }
  private async create(options: CreateOptions): Promise<SlotInfo> {
    if (this.stopping) throw new Error('Daemon is shutting down');
    if (options.parentSlotId !== undefined) return this.createSide(options);
    if (options.prompt !== undefined) throw new Error('prompt requires parentSlotId');
    if (options.expectedParentSessionId !== undefined) throw new Error('expectedParentSessionId requires parentSlotId');
    // A daemon can outlive a Pi upgrade. Check the actual executable for every new slot.
    await this.checkVersion();
    const cwd = await realpath(expandHome(string(options.cwd, 'cwd')));
    if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
    const args = options.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('args must be strings');
    for (const arg of args) if (RESERVED_ARGS.has(arg.split('=')[0]) || arg === '--') throw new Error(`Use daemon session options instead of ${arg}; credentials belong in the remote Pi configuration`);
    const sessionFile = options.sessionPath ? await this.checkPath(options.sessionPath) : undefined;
    if (sessionFile) this.reservedPaths.add(sessionFile);
    if (this.stopping) {
      if (sessionFile) this.reservedPaths.delete(sessionFile);
      throw new Error('Daemon is shutting down');
    }
    const slot: Slot = { id: randomUUID(), number: this.nextSlotNumber++, cwd, createdAt: new Date().toISOString(), args, sessionFile, status: 'starting', live: idle(), ui: new Map(), seq: 0, state: {}, changing: false, restarting: false, mutations: 0, incarnation: 0 };
    this.slots.set(slot.id, slot);
    try {
      this.launch(slot);
      await this.startupGrace(slot);
      await this.save();
      return this.info(slot);
    } finally { if (sessionFile) this.reservedPaths.delete(sessionFile); }
  }

  private async createSide(options: CreateOptions): Promise<SlotInfo> {
    if (options.cwd !== undefined || options.args !== undefined || options.sessionPath !== undefined) throw new Error('Side slots inherit cwd and args; do not supply cwd, args, or sessionPath');
    if (options.prompt !== undefined && (typeof options.prompt !== 'string' || !options.prompt.trim())) throw new Error('prompt must be a nonempty string');
    if (options.expectedParentSessionId !== undefined) string(options.expectedParentSessionId, 'expectedParentSessionId');
    const parent = this.running(options.parentSlotId);
    const incarnation = parent.incarnation;
    const parentProcess = parent.runtime;
    const identity = { sessionId: parent.state.sessionId, sessionFile: parent.sessionFile };
    const checkParent = () => {
      if (this.stopping) throw new Error('Daemon is shutting down');
      if (parent.status === 'exited' || parent.stopping || parent.runtime !== parentProcess || parent.incarnation !== incarnation) throw new Error('Parent Pi exited or restarted while creating side; no side was launched');
      const blocked = this.transitionBlocker(parent);
      if (blocked) throw new Error(`Cannot create side: ${blocked}`);
      if (parent.state.sessionId !== identity.sessionId || parent.sessionFile !== identity.sessionFile) throw new Error('Parent session changed while creating side; no side was launched');
    };
    checkParent();
    await this.checkVersion();
    checkParent();
    const state = await this.refreshState(parent);
    checkParent();
    if (options.expectedParentSessionId !== undefined && state.sessionId !== options.expectedParentSessionId) throw new Error('Parent session changed before creating side; no side was launched');
    if (!state.sessionFile) throw new Error('Cannot create side: parent has no persisted session file. Save a conversation first.');
    let source: string;
    try {
      source = await realpath(state.sessionFile);
      if (!(await stat(source)).isFile()) throw new Error('Not a session file');
    } catch (error) { throw new Error(`Cannot create side: parent session file is not persisted or readable. Save a conversation first. ${errorText(error)}`); }
    const sessionDir = sideSessionDir(parent.cwd, { ...process.env, ...this.options.env });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    // Never reserve or mutate the parent's file: the fork reads only its persisted
    // history, even when the parent is busy.
    let sessionFile: string;
    try { sessionFile = await forkSideSession(source, parent.cwd, sessionDir); }
    catch (error) { throw new Error(`Cannot create side: ${errorText(error)}`); }
    try {
      const latest = await this.refreshState(parent);
      checkParent();
      if (latest.sessionId !== state.sessionId || latest.sessionFile !== state.sessionFile
        || options.expectedParentSessionId !== undefined && latest.sessionId !== options.expectedParentSessionId) throw new Error('Parent session changed while creating side; no side was launched');
    } catch (error) {
      await rm(sessionFile, { force: true });
      throw error;
    }
    // Final checks and launch are synchronous.
    const slot: Slot = { id: randomUUID(), number: this.nextSlotNumber++, parentSlotId: parent.id,
      cwd: parent.cwd, createdAt: new Date().toISOString(), args: withSessionDir(parent.args, sessionDir), sessionFile,
      status: 'starting', live: idle(), ui: new Map(), seq: 0, state: {},
      changing: false, restarting: false, mutations: 0, incarnation: 0, creating: true };
    this.slots.set(slot.id, slot);
    try { this.launch(slot, options.prompt); }
    catch (error) { this.finishExit(slot, new Error(errorText(error))); }
    await this.startupGrace(slot);
    // Once allocated, always return the ID. A launch/prompt/save failure is not a safe
    // reason to retry create: a side process may already have accepted work.
    try { await this.save(); }
    catch (error) {
      slot.error = `Side created; metadata save failed: ${errorText(error)}`;
      this.publish(slot, { type: 'remote_warning', error: slot.error });
    }
    slot.creating = false;
    if (slot.status === 'exited') {
      // Keep the allocated ID and startup diagnostic addressable for the client's grace,
      // although stopped sides are already absent from persisted metadata.
      slot.sideExpiry = setTimeout(() => this.pruneExitedSides(), this.options.sideIdleGraceMs ?? 90_000);
      slot.sideExpiry.unref();
    } else this.scheduleSideExpiry(slot);
    return this.info(slot);
  }

  private launch(slot: Slot, prompt?: string): void {
    if (slot.stopping || this.stopping) throw new Error('Slot is stopping; not launching Pi');
    const incarnation = ++slot.incarnation;
    slot.activityAborted = false; slot.activityRetryError = false;
    slot.initialPrompt = prompt !== undefined ? { message: prompt, incarnation } : undefined;
    this.launchTerminal(slot, incarnation);
  }

  /**
   * Start stock interactive Pi in a PTY with the companion. The slot is `starting` until
   * the companion reports the session; the client that attaches first sets the size.
   */
  private launchTerminal(slot: Slot, incarnation: number): void {
    const owner = slot.runtime?.owner;
    const size = owner?.terminal ?? DEFAULT_SIZE;
    const host = new PiTerminal({
      executable: this.options.executable ?? 'pi', prefixArgs: this.options.prefixArgs, cwd: slot.cwd, companionPath: COMPANION,
      args: [...slot.args, ...(slot.sessionFile ? ['--session', slot.sessionFile] : [])],
      env: { ...this.options.env, ...remoteSessionEnv({ host: hostname(), slotId: slot.id, slotNumber: slot.number }) },
      columns: size.columns, rows: size.rows, answers: terminalAnswers(owner?.terminal?.answers),
    });
    slot.runtime = { host, screen: new ScreenState(), owner };
    host.onMessage = message => { if (incarnation === slot.incarnation) this.companionMessage(slot, message); };
    host.onExit = (code, signal) => {
      if (incarnation === slot.incarnation) this.finishExit(slot, new Error(slot.stopping ? 'Stopped by request. Session history is on disk.' : `Pi exited (code=${code}, signal=${signal ?? 0}).`));
    };
    host.start().catch(error => { if (incarnation === slot.incarnation) this.finishExit(slot, new Error(`Cannot start Pi: ${errorText(error)}`)); });
  }

  /** Apply a companion message to the slot, then pass it to the slot's clients. */
  private companionMessage(slot: Slot, message: CompanionMessage): void {
    // A clipboard write and a pi-remote command belong to the client that acted last.
    if ((message.type === 'terminal' && message.kind === 'clipboard') || message.type === 'clientAction') {
      const owner = slot.runtime!.owner;
      if (owner && !owner.socket.destroyed && owner.slotId === slot.id) {
        this.send(owner, { type: 'event', slotId: slot.id, seq: ++slot.seq, event: { type: 'screen', message } });
      }
      return;
    }
    slot.runtime!.screen.apply(message);
    if (message.type === 'session') {
      const state = { sessionId: message.sessionId, sessionFile: message.sessionFile, sessionName: message.sessionName, messageCount: message.entryCount ?? 0 };
      const changed = slot.state.sessionId !== undefined && slot.state.sessionId !== state.sessionId;
      if (changed) { slot.live = idle(); slot.ui.clear(); }
      this.updateState(slot, state);
    } else if (message.type === 'activity') this.companionActivity(slot, message.event);
    this.publish(slot, { type: 'screen', message });
  }

  /** Lifecycle events from the companion keep busy flags, dialogs, `ls` and notifications current. */
  private companionActivity(slot: Slot, event: RecordValue): void {
    const live = slot.live;
    if (event.type === 'agent_start') live.busy = true;
    else if (event.type === 'agent_settled') live.busy = false;
    else if (event.type === 'compaction_start') live.compacting = true;
    else if (event.type === 'compaction_end') live.compacting = false;
    if (event.type === 'extension_ui_request') slot.ui.set(`dialog:${event.id}`, event);
    else if (event.type === 'remote_dialog_resolved') slot.ui.delete(`dialog:${event.id}`);
    if (event.type === 'agent_settled' && event.aborted) slot.activityAborted = true;
    this.publish(slot, event);
    if (event.type === 'agent_settled' || (event.type === 'compaction_end' && !live.busy)) {
      slot.activityAborted = false; slot.activityRetryError = false;
    }
  }

  /** The client that typed or resized last sets Pi's terminal size and appearance. */
  private takeSize(slot: Slot & { runtime: PiRuntime }, peer: Peer): void {
    const runtime = slot.runtime;
    if (!peer.terminal) return;
    runtime.owner = peer;
    runtime.host.resize(peer.terminal.columns, peer.terminal.rows);
    if (peer.terminal.answers) runtime.host.setAnswers(terminalAnswers(peer.terminal.answers));
  }

  /** Start Pi again from the slot's session file. Shared by /reload and by a daemon
   * reopening the slots that the previous daemon marked during restart_daemon. */
  private async relaunch(slot: Slot): Promise<void> {
    try { this.launch(slot); }
    catch (error) {
      // A synchronous spawn failure has no child exit callback to finish the transition.
      slot.runtime = undefined;
      this.finishExit(slot, new Error(errorText(error)));
    }
    if (slot.runtime) await this.startupGrace(slot);
  }

  /**
   * The companion reports the session when Pi is ready; wait briefly for it. A slow startup
   * (or an extension awaiting UI) leaves the slot `starting`; Pi is never killed for it.
   */
  private async startupGrace(slot: Slot): Promise<void> {
    for (let waited = 0; waited < 1500 && slot.status === 'starting' && !slot.stopping; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  }

  private isBusy(slot: Slot): boolean {
    return !!(slot.live.busy || slot.live.compacting || slot.mutations || slot.initialPrompt
      || [...slot.ui.keys()].some(key => key.startsWith('dialog:')));
  }

  private sendInitialPrompt(slot: Slot): void {
    const pending = slot.initialPrompt;
    if (!pending || pending.incarnation !== slot.incarnation || slot.status !== 'running' || slot.stopping || this.stopping) return;
    // Clear before writing to stdin, so another get_state/reconnect can never resend it.
    slot.initialPrompt = undefined;
    if (!slot.runtime?.host.control({ type: 'prompt', text: pending.message })) {
      slot.error = 'Initial side prompt could not be delivered; it was not retried';
      this.publish(slot, { type: 'remote_warning', error: slot.error });
    }
  }

  private attached(slot: Slot): boolean {
    return [...this.peers].some(peer => peer.slotId === slot.id && !peer.socket.destroyed);
  }

  private peerLeft(id: string): void {
    const slot = this.slots.get(id);
    if (!slot?.parentSlotId || this.attached(slot)) return;
    if (slot.status === 'exited') this.pruneExitedSides();
    else this.scheduleSideExpiry(slot);
  }

  private scheduleSideExpiry(slot: Slot): void {
    clearTimeout(slot.sideExpiry);
    if (!slot.parentSlotId || slot.status === 'exited' || slot.stopping || this.stopping || this.attached(slot)) return;
    slot.detachedAt = Date.now();
    const grace = this.options.sideIdleGraceMs ?? 90_000;
    slot.sideExpiry = setTimeout(() => { void this.expireSide(slot); }, grace);
    slot.sideExpiry.unref();
  }

  private async expireSide(slot: Slot): Promise<void> {
    if (this.stopping || slot.stopping || slot.status === 'exited' || this.attached(slot) || slot.detachedAt === undefined) return;
    const incarnation = slot.incarnation;
    // Queries can be blocked by extension dialogs. Never inspect a startup/transition
    // from cleanup, and never infer idle from a failed or timed-out query.
    if (!this.transitionBlocker(slot) && !slot.mutations && !slot.initialPrompt
      && ![...slot.ui.keys()].some(key => key.startsWith('dialog:'))) {
      try {
        await this.refreshState(slot);
        const grace = this.options.sideIdleGraceMs ?? 90_000;
        if (!this.stopping && !slot.stopping && incarnation === slot.incarnation && !this.attached(slot)
          && slot.detachedAt !== undefined && Date.now() - slot.detachedAt >= grace
          && !this.transitionBlocker(slot) && !this.isBusy(slot)) {
          await this.stopTree(slot);
          return;
        }
      } catch { /* Preserve work when inspection is uncertain. */ }
    }
    if (!this.stopping && !slot.stopping && !this.attached(slot)) {
      slot.sideExpiry = setTimeout(() => { void this.expireSide(slot); }, Math.min(1000, Math.max(10, this.options.sideIdleGraceMs ?? 1000)));
      slot.sideExpiry.unref();
    }
  }

  private finishExit(slot: Slot, error: Error): void {
    slot.status = 'exited'; slot.stopping = true; slot.error = error.message;
    slot.initialPrompt = undefined;
    clearTimeout(slot.startupRetry); clearTimeout(slot.sideExpiry);
    slot.ui.clear();
    this.publish(slot, { type: 'remote_slot_exit', error: error.message });
    // Retired /reload generations never reach this callback. An orderly daemon restart
    // deliberately stops every process while keeping their reopen metadata.
    if (!this.stopping) {
      for (const child of this.slots.values()) {
        if (child.parentSlotId === slot.id && child.status !== 'exited') void this.stopTree(child).catch(error => console.error(error));
      }
      this.pruneExitedSides();
    }
    if (!this.stopping) void this.save().catch(error => console.error(error));
  }

  private async stopTree(slot: Slot): Promise<void> {
    // Mark the whole tree synchronously, before stop() awaits child shutdown. In-flight
    // creates and reloads cannot launch descendants or resurrect a stopped generation.
    slot.stopping = true;
    slot.initialPrompt = undefined;
    clearTimeout(slot.sideExpiry); clearTimeout(slot.startupRetry);
    const children = [...this.slots.values()].filter(child => child.parentSlotId === slot.id && child.status !== 'exited');
    await Promise.all([slot.runtime?.host.stop(), ...children.map(child => this.stopTree(child))]);
    // A reload may have retired its old exit callback before a parent cascaded a stop.
    // Finish that transition here; no replacement may launch after stopping was set.
    if (slot.status !== 'exited') this.finishExit(slot, new Error('Stopped by request. Session history is on disk.'));
    if (!this.stopping) {
      this.pruneExitedSides();
      await this.save();
    }
  }

  private pruneExitedSides(): void {
    if (this.stopping) return;
    // Retain attached exited slots until peers leave, so clients get the exit event and
    // can inspect metadata. Retain their ancestors for derived parent slot numbers.
    let removed: boolean;
    do {
      removed = false;
      for (const slot of this.slots.values()) {
        if (slot.parentSlotId && slot.status === 'exited' && !slot.creating && !this.reopen.has(slot.id) && !this.attached(slot)
          && ![...this.slots.values()].some(child => child.parentSlotId === slot.id)) {
          this.slots.delete(slot.id); removed = true;
        }
      }
    } while (removed);
  }

  /** A slot in a transition cannot be stopped and reopened, even with force. */
  private transitionBlocker(slot: Slot): string | undefined {
    if (slot.creating) return 'Slot creation is in progress; wait for its allocated ID';
    if (slot.restarting || slot.status === 'starting') return 'Pi is already starting or reloading';
    if (slot.changing) return 'A session change is already in progress';
  }

  /** Explicit restart only: retain the slot and disk session, never replay pending commands. */
  private async restart(slot: Slot, force: boolean): Promise<SlotInfo> {
    if (this.stopping) throw new Error('Daemon is shutting down');
    const blocked = this.transitionBlocker(slot);
    if (blocked) throw new Error(blocked);
    slot.restarting = true; // Lock before the first await, including against other clients.
    const host = slot.runtime!.host;
    const incarnation = slot.incarnation;
    const busyError = () => new Error(BUSY);
    let reserved: string | undefined;
    try {
      // Refuse an incompatible executable before touching the currently running process.
      await this.checkVersion();
      const state = slot.state;
      if (this.isBusy(slot) && !force) throw busyError();
      const sessionFile = resolve(string(state.sessionFile, 'sessionFile'));
      try { reserved = await this.checkPath(sessionFile, slot.id); }
      catch (error: any) {
        // Pi does not write a new session until it has content. --session can reopen its
        // assigned path, but cannot recover unpersisted state (including its original ID).
        if (error.code !== 'ENOENT' || state.messageCount > 0) throw error;
      }
      // Extensions and dialog answers can act independently of our mutation lock.
      // Reinspect after the path check, then stop synchronously with the final checks.
      const latest = await this.refreshState(slot);
      if (this.stopping) throw new Error('Daemon is shutting down');
      if (slot.status === 'exited' || slot.stopping || slot.runtime?.host !== host || slot.incarnation !== incarnation) throw new Error(slot.error ?? 'Pi exited during reload');
      if (latest.sessionId !== state.sessionId || latest.sessionFile !== state.sessionFile) throw new Error('Session changed during reload; check the current session before trying again');
      if (this.isBusy(slot) && !force) throw busyError();
      // Retire the old generation BEFORE closing stdin. Its shutdown events, state
      // replies and exit notification must not mark the replacement as exited.
      slot.incarnation++;
      slot.initialPrompt = undefined;
      clearTimeout(slot.startupRetry);
      slot.ui.clear();
      slot.live = idle(); slot.status = 'starting'; slot.error = undefined;
      slot.sessionFile = sessionFile;
      this.publish(slot, { type: 'remote_slot_restart', slot: this.info(slot) });
      await host.stop();
      if (this.stopping || slot.stopping) throw new Error('Pi stopped during reload; session history is on disk');
      await this.relaunch(slot);
      try { await this.save(); }
      catch (error) { this.publish(slot, { type: 'remote_warning', error: `Reload completed; metadata save failed: ${errorText(error)}` }); }
      return this.info(slot);
    } finally {
      slot.restarting = false;
      if (reserved) this.reservedPaths.delete(reserved);
    }
  }
  /** /reload for every slot at once, across a daemon restart. Uses the same rules as /reload:
   * a slot in a transition blocks the restart, and a busy slot blocks it unless forced. The
   * daemon marks running slots `reopen` and exits; the next daemon relaunches them from their
   * session files with the same IDs and numbers. Nothing stops unless every slot is ready. */
  private async restartDaemon(force: boolean): Promise<MethodResult<'restart_daemon'>> {
    if (this.stopping) throw new Error('Daemon is shutting down');
    const live = () => [...this.slots.values()].filter(slot => slot.status !== 'exited' && slot.runtime);
    const creationReason = () => this.creatingRequests ? 'Slot creation is in progress; wait for its allocated ID' : undefined;
    // Read fresh state without locking slots, so a waiting restart-daemon never rejects a prompt.
    const unsure = new Map<Slot, string>();
    await Promise.all(live().map(async slot => {
      if (creationReason() || this.transitionBlocker(slot)) return;
      try {
        const state = await this.refreshState(slot);
        // Pi writes a new session file only once it has content. Reopening a missing file is
        // safe only when there is nothing in memory to lose.
        if (state.messageCount > 0) await stat(resolve(string(state.sessionFile, 'sessionFile')));
      } catch (error) { unsure.set(slot, `Cannot confirm the session is saved: ${errorText(error)}`); }
    }));
    if (this.stopping) throw new Error('Daemon is shutting down');
    // Decide synchronously from the latest state, and commit before any other request runs.
    const blocked = live().flatMap(slot => {
      const reason = creationReason() ?? (slot.stopping ? 'Pi is stopping' : undefined) ?? this.transitionBlocker(slot) ?? unsure.get(slot) ?? (!force && this.isBusy(slot) ? BUSY : undefined);
      return reason ? [{ slot: this.info(slot), reason }] : [];
    });
    const result = { pid: process.pid, release: RELEASE, blocked };
    if (blocked.length || creationReason()) return { accepted: false, ...result, reopen: [], ...(creationReason() ? { reason: creationReason() } : {}) };
    const reopen = live().filter(slot => slot.sessionFile);
    this.stopping = true;
    for (const slot of reopen) this.reopen.add(slot.id);
    return { accepted: true, ...result, reopen: reopen.map(slot => this.info(slot)) };
  }

  private async handle(peer: Peer, raw: any): Promise<void> {
    let id: string | undefined;
    try {
      const request = object(raw, 'request') as Request;
      id = string(request.id, 'id');
      if (request.type !== 'request') throw new Error('Expected request envelope');
      const params = object(request.params ?? {}, 'params');
      let data: unknown;
      if (request.method === 'hello') {
        if (params.protocol !== PROTOCOL_VERSION || params.piVersion !== PI_VERSION) throw new Error(`Version mismatch: daemon protocol ${PROTOCOL_VERSION}, Pi ${PI_VERSION}`);
        peer.verified = true;
        data = { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION, pid: process.pid, release: RELEASE, capabilities: ['slot_numbers', 'complete_path', 'read_attachment', 'filesystem_metadata', 'restart', 'restart_daemon', 'side_slots', ACTIVITY_CAPABILITY] } satisfies MethodResult<'hello'>;
      } else {
        if (!peer.verified) throw new Error('Send hello with matching versions first');
        if (peer.activity && request.method !== 'watch_activity') throw new Error('Activity watchers are read-only; use a separate connection');
        switch (request.method) {
          case 'watch_activity': {
            if (peer.slotId || peer.pending > 1) throw new Error('Use a separate, unattached connection to watch activity');
            peer.activity = true;
            // Subscribe, capture the cut, and send synchronously. No Pi queries, awaits,
            // attach bookkeeping, or side-idle timer changes may occur in this block.
            const slots: ActivitySnapshot[] = [...this.slots.values()].map(slot => ({
              slot: activitySlot(this.info(slot)), seq: slot.seq,
              ...(typeof slot.state.sessionId === 'string' ? { sessionId: slot.state.sessionId } : {}),
              busy: slot.live.busy, compacting: slot.live.compacting,
              dialogs: [...slot.ui.values()].filter(event => DIALOGS.has(event.method)).map(event => event.id),
            }));
            this.send(peer, { type: 'result', id, success: true, data: { slots } satisfies MethodResult<'watch_activity'> });
            return;
          }
          case 'list': data = [...this.slots.values()].map(slot => this.info(slot)) satisfies MethodResult<'list'>; break;
          case 'ping': data = {} satisfies MethodResult<'ping'>; break;
          case 'status': data = {
            pid: process.pid, release: RELEASE, startedAt: DAEMON_STARTED_AT, piVersion: PI_VERSION, nodeVersion: process.version,
            host: { hostname: hostname(), platform: process.platform, arch: process.arch, uptimeSeconds: Math.round(uptime()), loadavg: loadavg(),
              cpus: availableParallelism(), totalMemory: totalmem(), freeMemory: freemem() },
          } satisfies MethodResult<'status'>; break;
          case 'complete_path': case 'read_attachment': case 'filesystem_metadata': {
            const { serveFileRequest } = await import('./files.js');
            const cwd = params.slotId ? this.slot(params.slotId).cwd : params.cwd;
            data = await serveFileRequest(request.method, { ...params, cwd }) satisfies MethodResult<FileMethod>;
            break;
          }
          case 'create': {
            this.creatingRequests++;
            try {
              data = await this.create(params as CreateOptions) satisfies MethodResult<'create'>;
              // Restart cannot close this transport before the allocated ID is sent.
              this.send(peer, { type: 'result', id, success: true, data });
              await new Promise<void>(resolve => {
                const flushed = () => { peer.socket.off('close', flushed); resolve(); };
                peer.socket.once('close', flushed);
                peer.socket.write('', flushed);
                if (peer.socket.destroyed) flushed();
              });
              return;
            } finally { this.creatingRequests--; }
          }
          case 'sessions': {
            if (params.side !== undefined && typeof params.side !== 'boolean') throw new Error('side must be a boolean');
            if (params.summary !== undefined && typeof params.summary !== 'boolean') throw new Error('summary must be a boolean');
            if ((params.slotId === undefined) === (params.cwd === undefined)) throw new Error('Give exactly one of slotId or cwd');
            if (params.sessionDir !== undefined && (params.cwd === undefined || typeof params.sessionDir !== 'string' || !params.sessionDir)) throw new Error('sessionDir must be a nonempty string and needs cwd');
            // A slot supplies its workspace and any --session-dir. A bare directory (resume
            // without a slot) takes the same --session-dir as sessionDir. Both otherwise use
            // the default directory that Pi started by this daemon would use, so `resume`
            // and `/resume` in a new slot list the same sessions.
            const slot = params.slotId === undefined ? undefined : this.slot(params.slotId);
            const cwd = slot ? slot.cwd : await realpath(expandHome(string(params.cwd, 'cwd')));
            if (!slot && !(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
            const { SessionManager } = await import('@earendil-works/pi-coding-agent');
            const env = { ...process.env, ...this.options.env };
            const dir = params.side ? sideSessionDir(cwd, env) : (slot ? sessionDirArg(slot.args) : params.sessionDir) ?? defaultSessionDir(cwd, env);
            const sessions = await SessionManager.list(cwd, resolve(cwd, expandHome(dir))) satisfies SessionInfoSource[];
            // Pickers only need the first message. The full text can be megabytes over SSH.
            data = params.summary ? sessions.map(session => ({ ...session, allMessagesText: '' })) : sessions;
            break;
          }
          case 'restart_daemon': {
            if (params.force !== undefined && typeof params.force !== 'boolean') throw new Error('force must be a boolean');
            const outcome: MethodResult<'restart_daemon'> = await this.restartDaemon(params.force === true);
            data = outcome;
            if (!outcome.accepted) break;
            // Deliver the acceptance before shutdown closes every client connection.
            this.send(peer, { type: 'result', id, success: true, data });
            await new Promise<void>(resolve => peer.socket.write('', () => resolve()));
            this.exitRequest();
            return;
          }
          case 'restart': {
            const slot = this.running(params.slotId);
            if (peer.slotId !== slot.id) throw new Error('Attach to the slot before reloading Pi');
            if (params.force !== undefined && typeof params.force !== 'boolean') throw new Error('force must be a boolean');
            data = await this.restart(slot, params.force === true) satisfies MethodResult<'restart'>;
            break;
          }
          case 'attach': {
            const slot = this.terminalSlot(params.slotId);
            const terminal = clientTerminal(params);
            const previousSlotId = peer.slotId;
            peer.slotId = slot.id; peer.terminal = terminal;
            if (previousSlotId && previousSlotId !== slot.id) this.peerLeft(previousSlotId);
            clearTimeout(slot.sideExpiry);
            slot.detachedAt = undefined;
            if (!slot.runtime.owner || slot.runtime.owner.socket.destroyed) this.takeSize(slot, peer);
            // Synchronous: no companion message can arrive between this cut and live events.
            data = { slot: this.info(slot), messages: slot.runtime.screen.snapshot(), seq: slot.seq, busy: slot.live.busy || slot.live.compacting } satisfies MethodResult<'attach'>;
            break;
          }
          case 'input': {
            const slot = this.terminalSlot(params.slotId);
            if (peer.slotId !== slot.id || !peer.terminal) throw new Error('Attach before sending input');
            if (typeof params.data !== 'string' || !params.data) throw new Error('data must be a nonempty string');
            if (slot.runtime.owner !== peer) this.takeSize(slot, peer);
            slot.runtime.host.write(params.data);
            data = {} satisfies MethodResult<'input'>;
            break;
          }
          case 'upload': {
            const slot = this.terminalSlot(params.slotId);
            if (peer.slotId !== slot.id || !peer.terminal) throw new Error('Attach before uploading');
            data = { path: await writeUpload(params) } satisfies MethodResult<'upload'>;
            break;
          }
          case 'resize': {
            const slot = this.terminalSlot(params.slotId);
            if (peer.slotId !== slot.id || !peer.terminal) throw new Error('Attach before resizing');
            peer.terminal = clientTerminal(params);
            if (slot.runtime.owner === peer || !slot.runtime.owner) this.takeSize(slot, peer);
            data = {} satisfies MethodResult<'resize'>;
            break;
          }
          case 'kill': {
            if (this.stopping) throw new Error('Daemon is shutting down');
            const slot = this.slot(params.slotId);
            if (slot.restarting && slot.status === 'starting') throw new Error('Pi is reloading; wait before stopping the slot');
            await this.stopTree(slot);
            data = {} satisfies MethodResult<'kill'>;
            break;
          }
          default: throw new Error(`Unknown daemon method: ${request.method}`);
        }
      }
      this.send(peer, { type: 'result', id, success: true, data });
    } catch (error) {
      this.send(peer, { type: 'result', id: id ?? '', success: false, error: errorText(error) });
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const peer of this.peers) peer.socket.destroy();
    const close = this.server ? new Promise<void>(accept => this.server!.close(() => accept())) : Promise.resolve();
    await Promise.all([...this.slots.values()].map(async slot => {
      slot.stopping = true; slot.initialPrompt = undefined;
      clearTimeout(slot.sideExpiry); clearTimeout(slot.startupRetry);
      await slot.runtime?.host.stop();
      if (slot.status !== 'exited') this.finishExit(slot, new Error('Stopped by daemon shutdown. Session history is on disk.'));
    }));
    await this.save();
    await close;
    await rm(socketPath(this.stateDir), { force: true });
  }
}

/**
 * Store a file the client pasted (a clipboard image or a copied file) where Pi can read it,
 * like Pi's own clipboard paste does: a private temporary directory on this machine.
 */
async function writeUpload(params: RecordValue): Promise<string> {
  const name = string(params.name, 'name').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'pasted';
  const data = string(params.data, 'data');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) throw new Error('Upload must be base64, at most 8 MiB');
  const directory = await mkdtemp(join(tmpdir(), 'pi-remote-paste-'));
  const path = join(directory, name);
  await writeFile(path, Buffer.from(data, 'base64'), { mode: 0o600 });
  return path;
}

function clientTerminal(params: RecordValue): ClientTerminal {
  const size = (value: unknown, name: string) => {
    if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 10_000) throw new Error(`${name} must be an integer from 2 to 10000`);
    return value as number;
  };
  const answers = params.answers === undefined ? undefined : object(params.answers, 'answers') as TerminalAnswers;
  return { columns: size(params.columns, 'columns'), rows: size(params.rows, 'rows'), ...(answers ? { answers } : {}) };
}

/** Pi in a slot always uses the kitty keyboard protocol; the rest comes from the client. */
function terminalAnswers(answers: TerminalAnswers = {}): TerminalAnswers {
  return { ...answers, kittyFlags: KITTY_FLAGS };
}

export async function prepareStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const metadata = await lstat(stateDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`Use a dedicated private state directory owned by this user (mode 0700): ${stateDir}`);
  }
}

/** Only daemon launchers reclaim stale owners, under a separate exclusive startup lock. */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const stateDir = resolve(options.stateDir);
  await prepareStateDir(stateDir);
  const lock = join(stateDir, 'daemon.lock');
  const startLock = join(stateDir, 'start.lock');
  try { await mkdir(startLock, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another daemon is starting. If startup crashed, inspect ${startLock} before removing it.`);
  }
  const token = randomUUID();
  let owned = false;
  let launching = true;
  const supervisor = new Supervisor(options);
  try {
    await writeFile(join(startLock, 'pid'), String(process.pid), { mode: 0o600 });
    try {
      const pid = Number(await readFile(join(lock, 'pid'), 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid daemon owner at ${lock}; inspect it manually`);
      let dead = false;
      try { process.kill(pid, 0); }
      catch (error: any) { if (error.code === 'ESRCH') dead = true; else throw error; }
      if (!dead) throw new Error(`Daemon PID ${pid} is already alive; not replacing its socket`);
      await rm(lock, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      // Missing owner files are not proof that a live lock can be reclaimed.
      try { await lstat(lock); throw new Error(`Incomplete daemon owner at ${lock}; inspect it manually`); }
      catch (missing: any) { if (missing.code !== 'ENOENT') throw missing; }
    }
    await mkdir(lock, { mode: 0o700 });
    owned = true;
    await writeFile(join(lock, 'token'), token, { mode: 0o600 });
    await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
    await rm(socketPath(stateDir), { force: true });
    await supervisor.start();
    await rm(startLock, { recursive: true });
    launching = false;
    console.error(`pi-remoted ${process.pid} listening at ${socketPath(stateDir)}`);
    await new Promise<void>(resolve => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void supervisor.stop().then(resolve).catch(error => { console.error(error); resolve(); });
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      void supervisor.exitRequested.then(stop);
    });
  } finally {
    if (owned && await readFile(join(lock, 'token'), 'utf8').catch(() => '') === token) await rm(lock, { recursive: true, force: true });
    if (launching) await rm(startLock, { recursive: true, force: true });
  }
}
