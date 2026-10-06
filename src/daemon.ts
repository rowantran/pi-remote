import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile, chmod, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonl, writeJsonl } from './jsonl.js';
import { emptyLive, applyLiveEvent } from './live.js';
import { PiProcess, type PiLaunch } from './pi-process.js';
import { PI_VERSION, PROTOCOL_VERSION, errorText, type CreateOptions, type LiveState, type RecordValue, type Request, type SlotInfo, type Snapshot } from './protocol.js';

const exec = promisify(execFile);
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const SESSION_CHANGES = new Set(['new_session', 'switch_session', 'fork', 'clone']);
const RESERVED_ARGS = new Set(['--mode', '--print', '-p', '--session', '--session-id', '--fork', '--continue', '-c', '--resume', '-r', '--no-session', '--export', '--help', '-h', '--version', '-v', '--api-key']);
const QUERY_COMMANDS = new Set(['get_state', 'get_entries', 'get_tree', 'get_messages', 'get_available_models', 'get_session_stats', 'get_fork_messages', 'get_last_assistant_text', 'get_commands', 'get_available_thinking_levels']);
const RPC_COMMANDS = new Set([...QUERY_COMMANDS, ...SESSION_CHANGES, 'prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'set_steering_mode', 'set_follow_up_mode', 'compact', 'set_auto_compaction', 'set_auto_retry', 'abort_retry', 'bash', 'abort_bash', 'export_html', 'set_session_name']);

interface StoredSlot { id: string; cwd: string; createdAt: string; args: string[]; sessionFile?: string; sessionName?: string }
interface Slot extends StoredSlot {
  process?: PiProcess;
  status: 'starting' | 'running' | 'exited';
  error?: string;
  stateRequest?: Promise<RecordValue>;
  startupRetry?: NodeJS.Timeout;
  history?: { sessionId: string; entries: RecordValue[]; leafId: string | null };
  live: LiveState;
  ui: Map<string, RecordValue>;
  timers: Map<string, NodeJS.Timeout>;
  seq: number;
  state: RecordValue;
  changing: boolean;
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
function expandHome(path: string): string { return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path; }

export class Supervisor {
  private slots = new Map<string, Slot>();
  private peers = new Set<Peer>();
  private reservedPaths = new Set<string>();
  private server?: Server;
  private saves = Promise.resolve();
  private stopping = false;
  readonly stateDir: string;
  constructor(private options: DaemonOptions) { this.stateDir = resolve(options.stateDir); }

  async start(): Promise<void> {
    await prepareStateDir(this.stateDir);
    await this.checkVersion();
    try {
      const stored = JSON.parse(await readFile(join(this.stateDir, 'slots.json'), 'utf8')) as StoredSlot[];
      for (const metadata of stored) this.slots.set(metadata.id, { ...metadata, status: 'exited', error: 'Daemon restarted. Work stopped; session history is on disk. Resume explicitly.', live: emptyLive(), ui: new Map(), timers: new Map(), seq: 0, state: {}, changing: false });
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
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
    return { id: slot.id, cwd: slot.cwd, createdAt: slot.createdAt, pid: slot.status !== 'exited' ? slot.process?.child.pid : undefined, status: slot.status, sessionFile: slot.sessionFile, sessionName: slot.sessionName, error: slot.error, clients: [...this.peers].filter(p => p.slotId === slot.id).length };
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
    slot.stateRequest = slot.process!.command<RecordValue>({ type: 'get_state' }, 30_000, state => {
      this.updateState(slot, state);
      return state;
    }).finally(() => { slot.stateRequest = undefined; });
    return slot.stateRequest;
  }
  private async inspectStartup(slot: Slot): Promise<void> {
    try { await this.refreshState(slot); }
    catch (error) {
      if (slot.status === 'exited') return;
      slot.error = `Pi is still starting; process preserved. ${errorText(error)}`;
      this.publish(slot, { type: 'remote_warning', error: slot.error });
      slot.startupRetry = setTimeout(() => { void this.inspectStartup(slot); }, 5000);
    }
  }
  private save(): Promise<void> {
    const stored: StoredSlot[] = [...this.slots.values()].map(({id,cwd,createdAt,args,sessionFile,sessionName}) => ({id,cwd,createdAt,args,sessionFile,sessionName}));
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
    const slot: Slot = { id: randomUUID(), cwd, createdAt: new Date().toISOString(), args, sessionFile, status: 'starting', live: emptyLive(), ui: new Map(), timers: new Map(), seq: 0, state: {}, changing: false };
    this.slots.set(slot.id, slot);
    const launch: PiLaunch = { executable: this.options.executable ?? 'pi', prefixArgs: this.options.prefixArgs, cwd, env: this.options.env, args: [...args, ...(sessionFile ? ['--session', sessionFile] : ['--session-id', randomUUID()])] };
    slot.process = new PiProcess(launch, event => this.recordEvent(slot, event), error => {
      slot.status = 'exited'; slot.error = error.message;
      clearTimeout(slot.startupRetry);
      for (const id of [...slot.timers.keys()]) { clearTimeout(slot.timers.get(id)); }
      slot.timers.clear();
      slot.ui.clear();
      this.publish(slot, { type: 'remote_slot_exit', error: error.message });
      void this.save().catch(error => console.error(error));
    });
    try {
      // A slow startup or an extension awaiting UI must not cause us to kill Pi.
      let timer: NodeJS.Timeout | undefined;
      const startup = this.inspectStartup(slot);
      await Promise.race([startup, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
      await this.save();
      return this.info(slot);
    } finally { if (sessionFile) this.reservedPaths.delete(sessionFile); }
  }
  private async snapshot(slot: Slot, retries = 2): Promise<Snapshot> {
    // A transition may be awaiting an extension dialog. Permit attachment using the last
    // verified history so disconnection cannot make that dialog impossible to answer.
    if (slot.status === 'starting' || slot.changing) return { slot: this.info(slot), state: slot.state, entries: slot.history?.entries ?? [], leafId: slot.history?.leafId ?? null, live: structuredClone(slot.live), ui: structuredClone([...slot.ui.values()]), seq: slot.seq };
    const state = await this.refreshState(slot);
    const snapshot = await slot.process!.command<Snapshot>({ type: 'get_entries' }, 30_000, data => {
      const entries = data.entries as RecordValue[];
      const leafId = data.leafId as string | null;
      slot.history = { sessionId: state.sessionId, entries, leafId };
      return { slot: this.info(slot), state, entries, leafId, live: structuredClone(slot.live), ui: structuredClone([...slot.ui.values()]), seq: slot.seq };
    });
    // Extension commands can switch sessions without a switch_session RPC. Check identity
    // again; never combine one session's history with another one's state/live messages.
    const after = await this.refreshState(slot);
    if (after.sessionId !== state.sessionId || slot.changing) {
      if (retries === 0) throw new Error('Session changed repeatedly during snapshot; attach again');
      return this.snapshot(slot, retries - 1);
    }
    return snapshot;
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
        data = { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION, pid: process.pid };
      } else {
        if (!peer.verified) throw new Error('Send hello with matching versions first');
        switch (request.method) {
          case 'list': data = [...this.slots.values()].map(slot => this.info(slot)); break;
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
          case 'snapshot': data = await this.snapshot(this.running(params.slotId)); break;
          case 'sessions': {
            const slot = this.slot(params.slotId);
            const { SessionManager } = await import('@earendil-works/pi-coding-agent');
            const dirIndex = slot.args.indexOf('--session-dir');
            data = await SessionManager.list(slot.cwd, dirIndex === -1 ? undefined : resolve(slot.cwd, slot.args[dirIndex + 1]));
            break;
          }
          case 'rpc': {
            const slot = this.running(params.slotId);
            if (peer.slotId !== slot.id) throw new Error('Attach to the slot before sending RPC commands');
            const command = object(params.command, 'RPC command');
            if (!RPC_COMMANDS.has(command.type)) throw new Error(`Unsupported Pi RPC command: ${command.type}`);
            let reserved: string | undefined;
            const changing = SESSION_CHANGES.has(command.type);
            if (changing && slot.changing) throw new Error('A session change is already in progress');
            if (changing) slot.changing = true;
            try {
              if (command.type === 'switch_session') {
                reserved = await this.checkPath(string(command.sessionPath, 'sessionPath'), slot.id);
                this.reservedPaths.add(reserved);
                command.sessionPath = reserved;
              }
              data = await slot.process!.command(command, QUERY_COMMANDS.has(command.type) ? 30_000 : undefined);
              if (!QUERY_COMMANDS.has(command.type)) {
                // Inspection failure must not turn an accepted mutation into a failure:
                // otherwise a user may retry a prompt that Pi has already accepted.
                try { await this.refreshState(slot); }
                catch (error) { this.publish(slot, { type: 'remote_warning', error: `Command succeeded; state refresh failed: ${errorText(error)}` }); }
              }
            } finally {
              if (reserved) this.reservedPaths.delete(reserved);
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
    });
  } finally {
    if (owned && await readFile(join(lock, 'token'), 'utf8').catch(() => '') === token) await rm(lock, { recursive: true, force: true });
    if (launching) await rm(startLock, { recursive: true, force: true });
  }
}
