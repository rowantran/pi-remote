import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readJsonl, writeJsonl } from './jsonl.js';
import { defaultStateDir, socketPath } from './daemon.js';
import { PI_VERSION, PROTOCOL_VERSION, type RecordValue, type RemoteConnection, type RemoteEvent, type Result } from './protocol.js';

interface Pending { resolve: (value: any) => void; reject: (error: Error) => void }
export class Connection implements RemoteConnection {
  private pending = new Map<string, Pending>();
  private events = new Set<(event: RemoteEvent) => void>();
  private disconnects = new Set<(error: Error) => void>();
  private backlog: RemoteEvent[] = [];
  private backlogBytes = 0;
  private error?: Error;
  private closed = false;
  private detachInput: () => void;
  private onEnd = () => this.fail(new Error('Disconnected. Remote work continues; attach again to restore the screen.'));
  private onClose = () => this.fail(new Error('Connection closed'));
  private onError = (error: Error) => this.fail(error);
  constructor(private input: Readable, private output: Writable, private stop: () => void) {
    this.detachInput = readJsonl(input, record => {
      if (this.error || this.closed) return;
      if (record.type === 'result') {
        const result = record as Result;
        const pending = this.pending.get(result.id);
        if (!pending) return;
        this.pending.delete(result.id);
        if (result.success) pending.resolve(result.data);
        else pending.reject(new Error(result.error ?? 'Remote request failed'));
      } else if (record.type === 'event') {
        if (this.events.size) for (const listener of [...this.events]) listener(record as RemoteEvent);
        else {
          this.backlogBytes += Buffer.byteLength(JSON.stringify(record));
          if (this.backlogBytes > 64 * 1024 * 1024) { this.fail(new Error('Event backlog exceeded limit')); return; }
          this.backlog.push(record as RemoteEvent);
        }
      } else this.fail(new Error('Invalid daemon protocol record'));
    }, error => this.fail(error));
    input.once('end', this.onEnd);
    input.once('close', this.onClose);
    output.on('error', this.onError);
  }
  async request<T = any>(method: string, params: RecordValue = {}): Promise<T> {
    if (this.error || this.closed) throw this.error ?? new Error('Connection closed');
    if (this.pending.size >= 256) throw new Error('Too many pending requests');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { writeJsonl(this.output, { type: 'request', id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  onEvent(listener: (event: RemoteEvent) => void): () => void {
    if (!this.error && !this.closed) {
      this.events.add(listener);
      const backlog = this.backlog.splice(0);
      this.backlogBytes = 0;
      for (const event of backlog) listener(event);
    }
    return () => this.events.delete(listener);
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    if (this.error) queueMicrotask(() => {
      if (this.disconnects.delete(listener)) listener(this.error!);
    });
    return () => this.disconnects.delete(listener);
  }
  /** Stops only this client's transport, never the remote Pi process. */
  disconnect(error: Error): void { this.fail(error); }
  private fail(error: Error) {
    if (this.error || this.closed) return;
    this.error = error;
    this.detachInput();
    this.input.off('end', this.onEnd);
    this.input.off('close', this.onClose);
    this.output.off('error', this.onError);
    // Transport shutdown can deliver a late pipe error. Release safety listeners on close.
    for (const stream of new Set([this.input, this.output])) {
      if (stream.closed) continue;
      const ignore = () => {};
      stream.on('error', ignore);
      stream.once('close', () => stream.off('error', ignore));
    }
    for (const pending of this.pending.values()) pending.reject(new Error(`${error.message} The result of an in-flight command may be unknown; it was not retried.`));
    this.pending.clear();
    this.backlog = [];
    this.backlogBytes = 0;
    this.events.clear();
    try {
      for (const listener of [...this.disconnects]) {
        try { listener(error); } catch (error) { console.error('Disconnect listener failed:', error); }
      }
    } finally { this.disconnects.clear(); this.stop(); }
  }
  close(): void {
    if (this.closed) return;
    this.fail(new Error('Detached from remote session'));
    this.closed = true;
  }
}

async function openSocket(stateDir: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(stateDir));
    const failed = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out connecting to the daemon socket; remote work was not stopped'));
    }, 5000);
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', failed); resolve(socket); });
    socket.once('error', failed);
  });
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Validate dedicated state storage without changing an existing directory's permissions. */
export async function ensurePrivateStateDir(stateDir: string): Promise<string> {
  const absolute = resolve(stateDir);
  try { await lstat(absolute); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  }
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`State directory must be a directory, not a symlink: ${absolute}`);
  const uid = process.getuid?.();
  if (uid === undefined || metadata.uid !== uid) throw new Error(`State directory must be owned by the current user: ${absolute}`);
  if ((metadata.mode & 0o7777) !== 0o700) throw new Error(`State directory must have mode 0700; choose a dedicated private directory: ${absolute}`);
  return absolute;
}

async function launchDaemon(absolute: string): Promise<void> {
  // Fail closed for log symlinks, shared files, and pipes. Concurrent clients only append.
  const log = await open(join(absolute, 'daemon.log'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const metadata = await log.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o600 || metadata.nlink !== 1) throw new Error('daemon.log must be an owner-private regular file with mode 0600 and no hard links');
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
    await new Promise<void>((accept, reject) => {
      const child = spawn(process.execPath, [cli, 'daemon', '--state-dir', absolute], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); accept(); });
    });
  } finally { await log.close(); }
}

export interface DaemonStartupOptions {
  /** Test seam for launching without starting a real daemon. */
  launch?: (stateDir: string) => Promise<void>;
  timeoutMs?: number;
}
/** Detached daemon startup; clients NEVER delete daemon locks or sockets. */
export async function ensureDaemon(stateDir = defaultStateDir(), options: DaemonStartupOptions = {}): Promise<Socket> {
  const absolute = await ensurePrivateStateDir(stateDir);
  try { return await openSocket(absolute); }
  catch (error: any) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  // runDaemon serializes launch/reclamation using start.lock. Competing launches are safe.
  await (options.launch ?? launchDaemon)(absolute);
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  do {
    try { return await openSocket(absolute); }
    catch (error: any) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Daemon did not start. Check ${join(absolute, 'daemon.log')}. An abandoned start.lock requires manual inspection; clients never remove locks or sockets.`);
}

/** Deadline for transport/version negotiation ONLY; no prompt or mutation deadlines. */
export async function handshake(connection: Connection, timeoutMs = 45_000): Promise<void> {
  const timer = setTimeout(() => connection.disconnect(new Error('Timed out waiting for the daemon version handshake; remote work was not stopped')), timeoutMs);
  try {
    const hello = await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    if (hello?.protocol !== PROTOCOL_VERSION || hello?.piVersion !== PI_VERSION) throw new Error('Daemon returned an incompatible protocol or Pi version');
  } catch (error) { connection.close(); throw error; }
  finally { clearTimeout(timer); }
}

export async function connectLocal(stateDir = defaultStateDir()): Promise<Connection> {
  const socket = await ensureDaemon(stateDir);
  const connection = new Connection(socket, socket, () => socket.destroy());
  try { await handshake(connection); return connection; }
  catch (error) { connection.close(); throw error; }
}
export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function remotePath(path: string): string { return path.startsWith('~/') ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path); }
export interface SshOptions { host: string; remoteBin?: string; stateDir?: string }
export async function connectSsh(options: SshOptions): Promise<Connection> {
  if (!options.host || options.host.startsWith('-') || /[\s\x00-\x1f]/.test(options.host)) throw new Error('Use an SSH host alias, such as rowan-v2-dev');
  const command = `${remotePath(options.remoteBin ?? '~/.local/share/pi-remote/bin/pi-remote')} bridge${options.stateDir ? ` --state-dir ${shellQuote(options.stateDir)}` : ''}`;
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', options.host, command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); process.stderr.write(chunk); });
  let killTimer: NodeJS.Timeout | undefined;
  const connection = new Connection(child.stdout, child.stdin, () => {
    child.stdin.destroy();
    child.stdout.resume();
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    child.kill('SIGTERM');
    // This deadline affects only the local SSH transport, never a daemon or Pi slot.
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref();
  });
  const onError = (error: Error) => connection.disconnect(new Error(`Could not start SSH: ${error.message}`));
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => connection.disconnect(new Error(`SSH exited (code=${code}, signal=${signal})${diagnostics ? `\n${diagnostics}` : ''}`));
  child.once('error', onError);
  child.once('exit', onExit);
  child.once('close', () => { clearTimeout(killTimer); child.off('error', onError); child.off('exit', onExit); });
  try { await handshake(connection); return connection; }
  catch (error: any) { connection.close(); throw new Error(`${error.message}${diagnostics && !error.message.includes(diagnostics) ? `\n${diagnostics}` : ''}`); }
}

export async function bridge(stateDir = defaultStateDir()): Promise<void> {
  const socket = await ensureDaemon(stateDir);
  const socketError = (error: Error) => { console.error(error.message); process.exitCode = 1; socket.destroy(); };
  const stdinEnd = () => socket.end();
  const stdioError = () => socket.destroy();
  socket.on('error', socketError);
  process.stdin.once('end', stdinEnd);
  process.stdin.on('error', stdioError);
  process.stdout.on('error', stdioError);
  try {
    // Backpressure applies only to this client's bridge, never Pi stdout.
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    await new Promise<void>(resolve => socket.once('close', resolve));
  } finally {
    process.stdin.unpipe(socket);
    socket.unpipe(process.stdout);
    process.stdin.pause();
    process.stdin.off('end', stdinEnd);
    process.stdin.off('error', stdioError);
    process.stdout.off('error', stdioError);
    socket.off('error', socketError);
    socket.destroy();
  }
}
