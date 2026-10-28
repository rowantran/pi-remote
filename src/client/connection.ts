import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readJsonl, writeJsonl } from '../protocol/jsonl.js';
import { shellQuote } from '../protocol/shell.js';
import { PI_VERSION, PROTOCOL_VERSION, type RemoteConnection, type RemoteEvent, type Result } from '../protocol/types.js';
import type { DaemonMethod, MethodResult, RequestArgs } from '../protocol/methods.js';

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
  private onEnd = () => this.onInputClosed ? this.onInputClosed() : this.fail(new Error('Disconnected. Remote work continues; attach again to restore the screen.'));
  private onClose = () => this.onInputClosed ? this.onInputClosed() : this.fail(new Error('Connection closed'));
  private onError = (error: Error) => this.fail(error);
  constructor(private input: Readable, private output: Writable, private stop: () => void,
    private onInputClosed?: () => void) {
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
  async request<M extends DaemonMethod>(method: M, ...args: RequestArgs<M>): Promise<MethodResult<M>> {
    const params = args[0] ?? {};
    if (this.error || this.closed) throw this.error ?? new Error('Connection closed');
    if (this.pending.size >= 256) throw new Error('Too many pending requests');
    const id = randomUUID();
    return new Promise<MethodResult<M>>((resolve, reject) => {
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

/** Deadline for transport/version negotiation ONLY; no prompt or mutation deadlines. */
export async function handshake(connection: Connection, timeoutMs = 45_000): Promise<void> {
  const timer = setTimeout(() => connection.disconnect(new Error('Timed out waiting for the daemon version handshake; remote work was not stopped')), timeoutMs);
  try {
    const hello = await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    if (hello?.protocol !== PROTOCOL_VERSION || hello?.piVersion !== PI_VERSION) throw new Error('Daemon returned an incompatible protocol or Pi version');
  } catch (error) { connection.close(); throw error; }
  finally { clearTimeout(timer); }
}

function remotePath(path: string): string { return path.startsWith('~/') ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path); }
export interface SshOptions { host: string; remoteBin?: string; stateDir?: string }
export async function connectSsh(options: SshOptions): Promise<Connection> {
  if (!options.host || options.host.startsWith('-') || /[\s\x00-\x1f]/.test(options.host)) throw new Error('Use an SSH host alias, such as rowan-v2-dev');
  const command = `${remotePath(options.remoteBin ?? '~/.local/share/pi-remote/bin/pi-remote')} bridge${options.stateDir ? ` --state-dir ${shellQuote(options.stateDir)}` : ''}`;
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', options.host, command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  // SSH banners, host-key warnings, and diagnostics must never write over the TUI.
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
  let killTimer: NodeJS.Timeout | undefined;
  let eofTimer: NodeJS.Timeout | undefined;
  let handshakeComplete = false;
  let transportEnded = false;
  const transportError = () => new Error(`${child.exitCode !== null || child.signalCode !== null
    ? `SSH exited (code=${child.exitCode}, signal=${child.signalCode})`
    : 'SSH output closed. Remote work continues; attach again to restore the screen.'}${diagnostics ? `\n${diagnostics}` : ''}`);
  const onTransportEnd = () => {
    transportEnded = true;
    // Once established, EOF or process exit must block new writes immediately.
    if (handshakeComplete) { connection.disconnect(transportError()); return; }
    // During negotiation only, let SSH close and drain its diagnostic stderr first.
    eofTimer ??= setTimeout(() => connection.disconnect(transportError()), 1000);
    eofTimer.unref();
  };
  const connection = new Connection(child.stdout, child.stdin, () => {
    clearTimeout(eofTimer);
    child.stdin.destroy();
    child.stdout.resume();
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    child.kill('SIGTERM');
    // This deadline affects only the local SSH transport, never a daemon or Pi slot.
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref();
  }, onTransportEnd);
  const onError = (error: Error) => connection.disconnect(new Error(`Could not start SSH: ${error.message}`));
  child.once('error', onError);
  child.once('exit', onTransportEnd);
  child.once('close', (code, signal) => {
    clearTimeout(killTimer);
    clearTimeout(eofTimer);
    child.off('error', onError);
    child.off('exit', onTransportEnd);
    connection.disconnect(new Error(`SSH exited (code=${code}, signal=${signal})${diagnostics ? `\n${diagnostics}` : ''}`));
  });
  try {
    await handshake(connection);
    handshakeComplete = true;
    // EOF/exit may arrive alongside the successful hello, before this continuation.
    if (transportEnded) { const error = transportError(); connection.disconnect(error); throw error; }
    return connection;
  }
  catch (error: any) { connection.close(); throw new Error(`${error.message}${diagnostics && !error.message.includes(diagnostics) ? `\n${diagnostics}` : ''}`); }
  finally { clearTimeout(eofTimer); }
}
