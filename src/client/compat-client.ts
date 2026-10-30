import { spawn } from 'node:child_process';
import { connectSsh, type SshOptions } from './connection.js';
import { shellQuote } from '../protocol/shell.js';
import type { DaemonMethod, FileMethod, MethodResult, RequestArgs } from '../protocol/methods.js';
import type { ConnectionRetry, RecordValue, RemoteConnection, RemoteEvent, Snapshot, SlotInfo } from '../protocol/types.js';

const FILE_METHODS: ReadonlySet<string> = new Set<FileMethod>(['complete_path', 'read_attachment', 'filesystem_metadata']);
const isFileMethod = (method: string): method is FileMethod => FILE_METHODS.has(method);

/** Add read-only capabilities without restarting a live v0.1 daemon or its Pi children. */
export class CompatibleConnection implements RemoteConnection {
  private slots = new Map<string, SlotInfo>();
  private legacyFiles = false;
  get reconnecting(): boolean | undefined { return this.connection.reconnecting; }
  onReconnect?: (listener: (snapshot: Snapshot) => void) => () => void;
  onRetry?: (listener: (retry: ConnectionRetry) => void) => () => void;
  onNativeReconnect?: RemoteConnection['onNativeReconnect'];
  constructor(private connection: RemoteConnection, private sideband: (method: FileMethod, params: RecordValue) => Promise<MethodResult<FileMethod>>) {
    if (connection.onReconnect) this.onReconnect = listener => connection.onReconnect!(listener);
    if (connection.onRetry) this.onRetry = listener => connection.onRetry!(listener);
    if (connection.onNativeReconnect) this.onNativeReconnect = listener => connection.onNativeReconnect!(listener);
  }
  async request<M extends DaemonMethod>(method: M, ...args: RequestArgs<M>): Promise<MethodResult<M>> {
    const params = (args[0] ?? {}) as RecordValue;
    if (!this.legacyFiles || !isFileMethod(method)) {
      try {
        const result = await this.connection.request(method, ...args);
        if (method === 'list' && Array.isArray(result)) for (const slot of result) this.slots.set(slot.id, slot);
        if ((method === 'attach' || method === 'snapshot') && (result as Snapshot)?.slot) {
          const snapshot = result as Snapshot;
          this.slots.set(snapshot.slot.id, snapshot.slot);
        }
        return result;
      } catch (error: any) {
        // Never substitute a sideband call for an uncertain mutation or transport error.
        if (!isFileMethod(method) || !/^Unknown daemon method:/.test(error.message)) throw error;
        this.legacyFiles = true;
      }
    }
    if (!isFileMethod(method)) throw new Error('Only read-only filesystem calls may use a sideband');
    let cwd = params.cwd;
    if (params.slotId) {
      const slots = await this.connection.request('list');
      for (const slot of slots) this.slots.set(slot.id, slot);
      const slot = this.slots.get(params.slotId);
      if (!slot) throw new Error('Slot not found');
      cwd = slot.cwd;
    }
    // The method guard limits this raw JSON transport boundary to file response shapes.
    return await this.sideband(method, { ...params, cwd }) as MethodResult<M>;
  }
  onEvent(listener: (event: RemoteEvent) => void) { return this.connection.onEvent(listener); }
  onDisconnect(listener: (error: Error) => void) { return this.connection.onDisconnect(listener); }
  close() { this.connection.close(); }
}

export async function fileSideband(options: SshOptions, method: FileMethod, params: RecordValue): Promise<MethodResult<FileMethod>> {
  if (!FILE_METHODS.has(method)) throw new Error('Only read-only filesystem calls may use a sideband');
  if (!options.host || options.host.startsWith('-') || /[\s\x00-\x1f]/.test(options.host)) throw new Error('Invalid SSH host');
  const path = options.remoteBin ?? '~/.local/share/pi-remote/bin/pi-remote';
  const bin = path.startsWith('~/') ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path);
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', options.host, `${bin} fs ${shellQuote(method)}`], {stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return new Promise<MethodResult<FileMethod>>((resolve,reject) => {
    let output = ''; let errors = ''; let settled = false;
    const finish = (error?: Error, data?: any) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Remote filesystem request timed out')), 15_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 16 * 1024 * 1024) finish(new Error('Remote file reply exceeds limit'));
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4096); });
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) { finish(new Error(errors.trim() || `Remote filesystem helper exited ${code}`)); return; }
      try { finish(undefined, JSON.parse(output)); } catch { finish(new Error('Invalid remote filesystem response')); }
    });
    child.stdin.end(JSON.stringify(params));
  });
}
export async function connectCompatibleSsh(options: SshOptions): Promise<RemoteConnection> {
  return new CompatibleConnection(await connectSsh(options), (method,params) => fileSideband(options,method,params));
}
