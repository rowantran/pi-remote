import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile, chmod, lstat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJsonl, writeJsonl } from './jsonl.js';
import { emptyLive, applyLiveEvent, captureLiveSnapshot } from './live.js';
import { PiProcess, type PiLaunch } from './pi-process.js';
import { remoteSessionEnv } from './remote-session.js';
import { PI_VERSION, PROTOCOL_VERSION, errorText, type CreateOptions, type HistoryCursor, type LiveState, type RecordValue, type Request, type SlotInfo, type Snapshot } from './protocol.js';

const exec = promisify(execFile);
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const SESSION_CHANGES = new Set(['new_session', 'switch_session', 'fork', 'clone']);
const RESERVED_ARGS = new Set(['--mode', '--print', '-p', '--session', '--session-id', '--fork', '--continue', '-c', '--resume', '-r', '--no-session', '--export', '--help', '-h', '--version', '-v', '--api-key']);
const QUERY_COMMANDS = new Set(['get_state', 'get_entries', 'get_tree', 'get_messages', 'get_available_models', 'get_session_stats', 'get_fork_messages', 'get_last_assistant_text', 'get_commands', 'get_available_thinking_levels']);
const RPC_COMMANDS = new Set([...QUERY_COMMANDS, ...SESSION_CHANGES, 'prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'set_steering_mode', 'set_follow_up_mode', 'compact', 'set_auto_compaction', 'set_auto_retry', 'abort_retry', 'bash', 'abort_bash', 'export_html', 'set_session_name']);

/** The installed code this daemon runs: a deployed release directory, or a source checkout. */
const RELEASE = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const BUSY = 'Remote Pi is busy. Confirm reload to interrupt running work and discard queued prompts.';

/** `reopen` marks a slot that was running when `restart_daemon` stopped the daemon. The next
 * daemon starts it again from its session file, exactly like /reload. Crashes never set it. */
interface StoredSlot { id: string; number?: number; cwd: string; createdAt: string; args: string[]; sessionFile?: string; sessionName?: string; reopen?: boolean }
interface Slot extends StoredSlot {
  process?: PiProcess;
  status: 'starting' | 'running' | 'exited';
  error?: string;
  stateRequest?: Promise<RecordValue>;
  startupRetry?: NodeJS.Timeout;
  history?: { sessionId: string; entries: RecordValue[]; leafId: string | null; seq: number };
  live: LiveState;
  ui: Map<string, RecordValue>;
  timers: Map<string, NodeJS.Timeout>;
  seq: number;
  state: RecordValue;
  changing: boolean;
  restarting: boolean;
  mutations: number;
  /** Monotonic process generation; late replies and events cannot affect its replacement. */
  incarnation: number;
}
interface Peer { socket: Socket; slotId?: string; ready: boolean; verified: boolean; pending: number; attaching: boolean; buffer: RecordValue[]; bufferBytes: number }
export interface DaemonOptions { stateDir: string; executable?: string; prefixArgs?: string[]; env?: NodeJS.ProcessEnv; skipVersionCheck?: boolean }
export function defaultStateDir(): string { return process.env.PI_REMOTE_STATE_DIR ?? join(homedir(), '.pi', 'remote'); }
export function socketPath(stateDir: string): string {
  const path = join(resolve(stateDir), 'daemon.sock');
  if (Buffer.byteLength(path) > 100) throw new Error('State directory path is too long for a Unix socket; use --state-dir with a shorter path');
  return path;
}
function object(value: any, name: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function string(value: any, name: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`Missing ${name}`);
  return value;
}
/** Malformed optional cursors use the full-response path, just like older clients. */
function historyCursor(value: unknown): HistoryCursor | undefined {
  try {
    const cursor = object(value, 'historyCursor');
    return { sessionId: string(cursor.sessionId, 'sessionId'), entryId: string(cursor.entryId, 'entryId') };
  } catch { return undefined; }
}
function expandHome(path: string): string { return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path; }

export class Supervisor {
  private slots = new Map<string, Slot>();
  private nextSlotNumber = 1;
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
        const slot: Slot = { ...rest, number, status: 'exited', error: 'Daemon restarted. Work stopped; session history is on disk. Resume explicitly.', live: emptyLive(), ui: new Map(), timers: new Map(), seq: 0, state: {}, changing: false, restarting: false, mutations: 0, incarnation: 0 };
        this.slots.set(metadata.id, slot);
        if (reopen && slot.sessionFile) reopening.push(slot);
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    // Reopen before listening, so reconnecting clients find the slots starting, not stopped.
    for (const slot of reopening) { slot.status = 'starting'; slot.error = undefined; }
    await Promise.all(reopening.map(slot => this.relaunch(slot)));
    if (reopening.length) await this.save();
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
    const peer: Peer = { socket, ready: false, verified: false, pending: 0, attaching: false, buffer: [], bufferBytes: 0 };
    this.peers.add(peer);
    socket.on('error', () => {});
    socket.on('close', () => this.peers.delete(peer));
    readJsonl(socket, request => {
      // Reject a abusive client without affecting any Pi processes.
      if (++peer.pending > 256) { socket.destroy(); return; }
      void this.handle(peer, request).finally(() => { peer.pending--; });
    }, () => socket.destroy());
  }
  private send(peer: Peer, record: unknown) {
    try { writeJsonl(peer.socket, record); }
    catch { peer.socket.destroy(); }
  }
  private info(slot: Slot): SlotInfo {
    return { id: slot.id, number: slot.number, cwd: slot.cwd, createdAt: slot.createdAt, pid: slot.status !== 'exited' ? slot.process?.child.pid : undefined, status: slot.status, sessionFile: slot.sessionFile, sessionName: slot.sessionName, error: slot.error, clients: [...this.peers].filter(p => p.slotId === slot.id).length };
  }
  private slot(id: any): Slot {
    const slot = this.slots.get(string(id, 'slotId'));
    if (!slot) throw new Error('Slot not found');
    return slot;
  }
  private running(id: any): Slot {
    const slot = this.slot(id);
    if (slot.status === 'exited' || !slot.process) throw new Error(slot.error ?? 'Slot is not running');
    return slot;
  }
  private publish(slot: Slot, event: RecordValue) {
    const record = { type: 'event', slotId: slot.id, seq: ++slot.seq, event };
    for (const peer of this.peers) {
      if (peer.slotId !== slot.id) continue;
      if (peer.ready) this.send(peer, record);
      else if (peer.attaching) {
        peer.bufferBytes += Buffer.byteLength(JSON.stringify(record));
        if (peer.bufferBytes > 64 * 1024 * 1024) peer.socket.destroy();
        else peer.buffer.push(record);
      }
    }
  }
  private recordEvent(slot: Slot, event: RecordValue) {
    applyLiveEvent(slot.live, event);
    if (event.type === 'extension_ui_request') {
      if (DIALOGS.has(event.method)) {
        slot.ui.set(`dialog:${event.id}`, event);
        // Respect timeouts explicitly chosen by an extension; introduce no timeout of our own.
        if (event.timeout > 0) slot.timers.set(event.id, setTimeout(() => this.resolveDialog(slot, event.id, 'timeout'), event.timeout));
      } else {
        const key = event.method === 'setStatus' ? `status:${event.statusKey}` : event.method === 'setWidget' ? `widget:${event.widgetKey}` : event.method;
        if (event.method === 'setStatus' && event.statusText === undefined || event.method === 'setWidget' && event.widgetLines === undefined) slot.ui.delete(key);
        else if (event.method !== 'notify') slot.ui.set(key, event);
      }
    }
    this.publish(slot, event);
    if (event.type === 'agent_settled' || event.type === 'session_info_changed') void this.refreshState(slot).catch(() => {});
  }
  private resolveDialog(slot: Slot, id: string, reason: string) {
    if (!slot.ui.delete(`dialog:${id}`)) return;
    clearTimeout(slot.timers.get(id));
    slot.timers.delete(id);
    this.publish(slot, { type: 'remote_dialog_resolved', id, reason });
  }
  private updateState(slot: Slot, state: RecordValue) {
    const previousId = slot.state.sessionId;
    const starting = slot.status === 'starting';
    const changed = previousId !== undefined && previousId !== state.sessionId;
    // Reconcile identity synchronously at the get_state response, before any client
    // can snapshot the new session with the old session's live transcript.
    if (changed) { slot.live = emptyLive(); slot.history = undefined; }
    slot.state = state;
    slot.status = 'running';
    slot.error = undefined;
    slot.sessionFile = state.sessionFile;
    slot.sessionName = state.sessionName;
    if (changed || starting) this.publish(slot, { type: 'remote_refresh' });
    this.publish(slot, { type: 'remote_state', state });
    void this.save().catch(error => console.error('Cannot save daemon metadata:', error));
  }
  private refreshState(slot: Slot): Promise<RecordValue> {
    if (slot.stateRequest) return slot.stateRequest;
    const incarnation = slot.incarnation;
    const request = slot.process!.command<RecordValue>({ type: 'get_state' }, 30_000, state => {
      if (incarnation !== slot.incarnation || slot.status === 'exited') throw new Error('Pi process changed during state inspection');
      this.updateState(slot, state);
      return state;
    }).finally(() => { if (slot.stateRequest === request) slot.stateRequest = undefined; });
    slot.stateRequest = request;
    return request;
  }
  private async inspectStartup(slot: Slot): Promise<void> {
    const incarnation = slot.incarnation;
    try { await this.refreshState(slot); }
    catch (error) {
      if (slot.status === 'exited' || incarnation !== slot.incarnation || this.stopping) return;
      slot.error = `Pi is still starting; process preserved. ${errorText(error)}`;
      this.publish(slot, { type: 'remote_warning', error: slot.error });
      slot.startupRetry = setTimeout(() => { void this.inspectStartup(slot); }, 5000);
    }
  }
  private save(): Promise<void> {
    const stored: StoredSlot[] = [...this.slots.values()].map(({id,number,cwd,createdAt,args,sessionFile,sessionName}) => ({id,number,cwd,createdAt,args,sessionFile,sessionName, ...(this.reopen.has(id) ? { reopen: true } : {})}));
    this.saves = this.saves.catch(() => {}).then(async () => {
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
    const slot: Slot = { id: randomUUID(), number: this.nextSlotNumber++, cwd, createdAt: new Date().toISOString(), args, sessionFile, status: 'starting', live: emptyLive(), ui: new Map(), timers: new Map(), seq: 0, state: {}, changing: false, restarting: false, mutations: 0, incarnation: 0 };
    this.slots.set(slot.id, slot);
    try {
      this.launch(slot);
      await this.startupGrace(slot);
      await this.save();
      return this.info(slot);
    } finally { if (sessionFile) this.reservedPaths.delete(sessionFile); }
  }

  private launch(slot: Slot): void {
    const incarnation = ++slot.incarnation;
    const launch: PiLaunch = { executable: this.options.executable ?? 'pi', prefixArgs: this.options.prefixArgs, cwd: slot.cwd,
      env: { ...this.options.env, ...remoteSessionEnv({ host: hostname(), slotId: slot.id, slotNumber: slot.number }) },
      args: [...slot.args, ...(slot.sessionFile ? ['--session', slot.sessionFile] : [])] };
    slot.process = new PiProcess(launch, event => {
      if (incarnation === slot.incarnation) this.recordEvent(slot, event);
    }, error => {
      if (incarnation !== slot.incarnation) return;
      slot.status = 'exited'; slot.error = error.message;
      clearTimeout(slot.startupRetry);
      for (const timer of slot.timers.values()) clearTimeout(timer);
      slot.timers.clear();
      slot.ui.clear();
      this.publish(slot, { type: 'remote_slot_exit', error: error.message });
      void this.save().catch(error => console.error(error));
    });
  }

  /** Start Pi again from the slot's session file. Shared by /reload and by a daemon
   * reopening the slots that the previous daemon marked during restart_daemon. */
  private async relaunch(slot: Slot): Promise<void> {
    try { this.launch(slot); }
    catch (error) {
      // A synchronous spawn failure has no child exit callback to finish the transition.
      slot.process = undefined; slot.status = 'exited'; slot.error = errorText(error);
      this.publish(slot, { type: 'remote_slot_exit', error: slot.error });
    }
    if (slot.process) await this.startupGrace(slot);
  }

  private async startupGrace(slot: Slot): Promise<void> {
    // A slow startup or an extension awaiting UI must not cause us to kill Pi.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.inspectStartup(slot), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
    } finally { clearTimeout(timer); }
  }

  private isBusy(slot: Slot, state: RecordValue): boolean {
    const live = slot.live;
    return !!(state.isStreaming || state.isCompacting || state.pendingMessageCount > 0
      || live.busy || live.compacting || live.steering.length || live.followUp.length
      || Object.keys(live.bash ?? {}).length || slot.mutations || [...slot.ui.keys()].some(key => key.startsWith('dialog:')));
  }

  /** A slot in a transition cannot be stopped and reopened, even with force. */
  private transitionBlocker(slot: Slot): string | undefined {
    if (slot.restarting || slot.status === 'starting') return 'Pi is already starting or reloading';
    if (slot.changing) return 'A session change is already in progress';
  }

  /** Explicit restart only: retain the slot and disk session, never replay pending commands. */
  private async restart(slot: Slot, force: boolean): Promise<SlotInfo> {
    if (this.stopping) throw new Error('Daemon is shutting down');
    const blocked = this.transitionBlocker(slot);
    if (blocked) throw new Error(blocked);
    slot.restarting = true; // Lock before the first await, including against other clients.
    const process = slot.process!;
    const incarnation = slot.incarnation;
    const busyError = () => new Error(BUSY);
    let reserved: string | undefined;
    try {
      // Refuse an incompatible executable before touching the currently running process.
      await this.checkVersion();
      const snapshot = await this.snapshot(slot);
      const state = snapshot.state;
      if (this.isBusy(slot, state) && !force) throw busyError();
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
      if (slot.status === 'exited' || slot.process !== process || slot.incarnation !== incarnation) throw new Error(slot.error ?? 'Pi exited during reload');
      if (latest.sessionId !== state.sessionId || latest.sessionFile !== state.sessionFile) throw new Error('Session changed during reload; check the current session before trying again');
      if (this.isBusy(slot, latest) && !force) throw busyError();
      // Retire the old generation BEFORE closing stdin. Its shutdown events, state
      // replies and exit notification must not mark the replacement as exited.
      slot.incarnation++;
      slot.stateRequest = undefined;
      clearTimeout(slot.startupRetry);
      for (const timer of slot.timers.values()) clearTimeout(timer);
      slot.timers.clear(); slot.ui.clear();
      slot.live = emptyLive(); slot.status = 'starting'; slot.error = undefined;
      slot.sessionFile = sessionFile;
      this.publish(slot, { type: 'remote_slot_restart', slot: this.info(slot) });
      await process.stop();
      if (this.stopping) throw new Error('Daemon shut down during reload; session history is on disk');
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
  private async restartDaemon(force: boolean): Promise<{ accepted: boolean; pid: number; release: string; blocked: { slot: SlotInfo; reason: string }[]; reopen: SlotInfo[] }> {
    if (this.stopping) throw new Error('Daemon is shutting down');
    const live = () => [...this.slots.values()].filter(slot => slot.status !== 'exited' && slot.process);
    // Read fresh state without locking slots, so polling with --wait never rejects a prompt.
    const unsure = new Map<Slot, string>();
    await Promise.all(live().map(async slot => {
      if (this.transitionBlocker(slot)) return;
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
      const reason = this.transitionBlocker(slot) ?? unsure.get(slot) ?? (!force && this.isBusy(slot, slot.state) ? BUSY : undefined);
      return reason ? [{ slot: this.info(slot), reason }] : [];
    });
    const result = { pid: process.pid, release: RELEASE, blocked };
    if (blocked.length) return { accepted: false, ...result, reopen: [] };
    const reopen = live().filter(slot => slot.sessionFile);
    this.stopping = true;
    for (const slot of reopen) this.reopen.add(slot.id);
    return { accepted: true, ...result, reopen: reopen.map(slot => this.info(slot)) };
  }

  private async snapshot(slot: Slot, retries = 2, cursor?: HistoryCursor): Promise<Snapshot> {
    // A transition may be awaiting an extension dialog. Permit attachment using the last
    // verified history so disconnection cannot make that dialog impossible to answer.
    if (slot.status === 'starting' || slot.changing) return { slot: this.info(slot), state: slot.state, entries: slot.history?.entries ?? [], leafId: slot.history?.leafId ?? null, live: structuredClone(slot.live), ui: structuredClone([...slot.ui.values()]), seq: slot.seq, historyComplete: false };
    const incarnation = slot.incarnation;
    try {
      const state = await this.refreshState(slot);
      if (incarnation !== slot.incarnation) return this.snapshot(slot, retries);
      // Keep a complete, immutable baseline for both merging and transition fallback.
      // A client's cursor alone is not enough to prove that we can retain its prefix.
      const history = slot.history;
      const cursorIndex = cursor && history && cursor.sessionId === state.sessionId && history.sessionId === state.sessionId
        ? history.entries.findIndex(entry => entry.id === cursor.entryId) : -1;
      const delta = cursorIndex >= 0 ? cursor : undefined;
      let retire = () => {};
      let snapshot: Snapshot;
      try {
        snapshot = await slot.process!.command<Snapshot>({ type: 'get_entries', ...(delta ? { since: delta.entryId } : {}) }, 30_000, data => {
          const entries = data.entries as RecordValue[];
          const leafId = data.leafId as string | null;
          const tail = captureLiveSnapshot(slot.live);
          retire = tail.retire;
          return { slot: this.info(slot), state, entries, ...(delta ? { historyDelta: delta } : {}), leafId, live: tail.state,
            ui: structuredClone([...slot.ui.values()]), seq: slot.seq, historyComplete: true };
        });
      } catch (error) {
        // Pi may have removed the entry or switched sessions since get_state. Reinspect
        // with a full read; unrelated RPC failures must still reject the snapshot.
        if (delta && errorText(error) === `Entry not found: ${delta.entryId}`) return this.snapshot(slot, retries);
        throw error;
      }
      // Extension commands can switch sessions without a switch_session RPC. Check identity
      // again; never combine one session's history with another one's state/live messages.
      if (incarnation !== slot.incarnation) return this.snapshot(slot, retries);
      const after = await this.refreshState(slot);
      if (incarnation !== slot.incarnation) return this.snapshot(slot, retries);
      if (after.sessionId !== state.sessionId || slot.changing) {
        if (retries === 0) throw new Error('Session changed repeatedly during snapshot; attach again');
        return this.snapshot(slot, retries - 1);
      }
      // Overlapping readers must not roll the cached baseline back behind an already retired tail.
      if (!slot.history || slot.history.seq <= snapshot.seq) {
        const entries = snapshot.historyDelta ? [...history!.entries.slice(0, cursorIndex + 1), ...snapshot.entries] : snapshot.entries;
        slot.history = { sessionId: state.sessionId, entries, leafId: snapshot.leafId, seq: snapshot.seq };
        retire();
      }
      return snapshot;
    } catch (error) {
      // A reader attached to the retiring process may be rejected by orderly shutdown.
      // Restore it from the replacement/cache rather than treating this as a lost slot.
      if (incarnation !== slot.incarnation) return this.snapshot(slot, retries);
      throw error;
    }
  }

  private async handle(peer: Peer, raw: any): Promise<void> {
    let id: string | undefined;
    try {
      const request = object(raw, 'request') as Request;
      id = string(request.id, 'id');
      if (request.type !== 'request') throw new Error('Expected request envelope');
      const params = object(request.params ?? {}, 'params');
      let data: any;
      if (request.method === 'hello') {
        if (params.protocol !== PROTOCOL_VERSION || params.piVersion !== PI_VERSION) throw new Error(`Version mismatch: daemon protocol ${PROTOCOL_VERSION}, Pi ${PI_VERSION}`);
        peer.verified = true;
        data = { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION, pid: process.pid, release: RELEASE, capabilities: ['slot_numbers', 'complete_path', 'read_attachment', 'filesystem_metadata', 'restart', 'restart_daemon', 'incremental_snapshots'] };
      } else {
        if (!peer.verified) throw new Error('Send hello with matching versions first');
        switch (request.method) {
          case 'list': data = [...this.slots.values()].map(slot => this.info(slot)); break;
          case 'complete_path': case 'read_attachment': case 'filesystem_metadata': {
            const { serveFileRequest } = await import('./files.js');
            const cwd = params.slotId ? this.slot(params.slotId).cwd : params.cwd;
            data = await serveFileRequest(request.method, { ...params, cwd });
            break;
          }
          case 'create': data = await this.create(params as CreateOptions); break;
          case 'attach': {
            const slot = this.running(params.slotId);
            if (peer.attaching) throw new Error('Attachment already in progress');
            peer.ready = false;
            peer.attaching = true;
            peer.buffer = [];
            peer.bufferBytes = 0;
            peer.slotId = slot.id;
            try {
              data = await this.snapshot(slot);
              this.send(peer, { type: 'result', id, success: true, data });
              // Events may follow the entries response in the same stdout chunk, before this
              // await continuation runs. Buffer them and replay only those after the cut.
              for (const event of peer.buffer) if (event.seq > data.seq) this.send(peer, event);
              peer.ready = true;
              return;
            } finally {
              peer.attaching = false; peer.buffer = []; peer.bufferBytes = 0;
              if (!peer.ready) peer.slotId = undefined;
            }
          }
          case 'snapshot': data = await this.snapshot(this.running(params.slotId), 2, historyCursor(params.historyCursor)); break;
          case 'sessions': {
            const slot = this.slot(params.slotId);
            const { SessionManager } = await import('@earendil-works/pi-coding-agent');
            const dirIndex = slot.args.indexOf('--session-dir');
            data = await SessionManager.list(slot.cwd, dirIndex === -1 ? undefined : resolve(slot.cwd, slot.args[dirIndex + 1]));
            break;
          }
          case 'restart_daemon': {
            if (params.force !== undefined && typeof params.force !== 'boolean') throw new Error('force must be a boolean');
            data = await this.restartDaemon(params.force === true);
            if (!data.accepted) break;
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
            data = await this.restart(slot, params.force === true);
            break;
          }
          case 'rpc': {
            const slot = this.running(params.slotId);
            if (peer.slotId !== slot.id) throw new Error('Attach to the slot before sending RPC commands');
            const command = object(params.command, 'RPC command');
            if (!RPC_COMMANDS.has(command.type)) throw new Error(`Unsupported Pi RPC command: ${command.type}`);
            // Readers may inspect the newly launched process before the restart caller
            // gets its result. Block mutations, not other clients' command-cache refreshes.
            if (this.stopping && !QUERY_COMMANDS.has(command.type)) throw new Error('Daemon is shutting down');
            if (slot.restarting && !QUERY_COMMANDS.has(command.type)) throw new Error('Pi is reloading; wait for startup to finish');
            if (slot.status === 'starting' && !QUERY_COMMANDS.has(command.type)) throw new Error('Pi is starting; wait before sending commands');
            const incarnation = slot.incarnation;
            const mutating = !QUERY_COMMANDS.has(command.type);
            let reserved: string | undefined;
            const changing = SESSION_CHANGES.has(command.type);
            if (changing && slot.changing) throw new Error('A session change is already in progress');
            if (changing) slot.changing = true;
            if (mutating) slot.mutations++;
            try {
              if (command.type === 'switch_session') {
                reserved = await this.checkPath(string(command.sessionPath, 'sessionPath'), slot.id);
                this.reservedPaths.add(reserved);
                command.sessionPath = reserved;
              }
              data = await slot.process!.command(command, QUERY_COMMANDS.has(command.type) ? 30_000 : undefined);
              if (incarnation !== slot.incarnation) throw new Error('Remote Pi restarted while this command was pending; it was not replayed');
              if (command.type === 'bash' || command.type === 'abort_bash') {
                this.recordEvent(slot, {type: 'remote_bash_end'});
                this.publish(slot, {type: 'remote_refresh'});
              }
              if (!QUERY_COMMANDS.has(command.type)) {
                // Inspection failure must not turn an accepted mutation into a failure:
                // otherwise a user may retry a prompt that Pi has already accepted.
                try { await this.refreshState(slot); }
                catch (error) { if (incarnation === slot.incarnation) this.publish(slot, { type: 'remote_warning', error: `Command succeeded; state refresh failed: ${errorText(error)}` }); }
              }
            } catch (error) {
              if (incarnation !== slot.incarnation) throw new Error('Remote Pi restarted while this command was pending; it was not replayed');
              throw error;
            } finally {
              if (reserved) this.reservedPaths.delete(reserved);
              if (mutating) slot.mutations--;
              if (changing) { slot.changing = false; this.publish(slot, { type: 'remote_refresh' }); }
            }
            break;
          }
          case 'answer': {
            const slot = this.running(params.slotId);
            if (peer.slotId !== slot.id) throw new Error('Attach before answering a dialog');
            const response = object(params.response, 'dialog response');
            const dialogId = string(response.id, 'dialog id');
            const dialog = slot.ui.get(`dialog:${dialogId}`);
            if (!dialog) throw new Error('Dialog already answered or expired');
            if (response.cancelled !== undefined && typeof response.cancelled !== 'boolean') throw new Error('cancelled must be a boolean');
            if (response.cancelled !== true) {
              if (dialog.method === 'confirm') {
                if (typeof response.confirmed !== 'boolean') throw new Error('confirmed must be a boolean');
              } else {
                if (typeof response.value !== 'string') throw new Error('Dialog value must be a string');
                if (dialog.method === 'select' && !dialog.options.includes(response.value)) throw new Error('Select value must be one of the dialog options');
              }
            }
            slot.process!.answer(response);
            this.resolveDialog(slot, dialogId, 'answered');
            data = {};
            break;
          }
          case 'kill': {
            const slot = this.slot(params.slotId);
            if (slot.restarting && slot.status === 'starting') throw new Error('Pi is reloading; wait before stopping the slot');
            await slot.process?.stop();
            data = {};
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
    await Promise.all([...this.slots.values()].map(slot => slot.process?.stop()));
    await this.save();
    await close;
    await rm(socketPath(this.stateDir), { force: true });
  }
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
