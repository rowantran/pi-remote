import { spawn } from 'node:child_process';
import { connectLocal, connectSsh, shellQuote, type SshOptions } from './client.js';
import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot, SlotInfo } from './protocol.js';

const FILE_METHODS = new Set(['complete_path', 'read_attachment', 'filesystem_metadata']);

/** Add read-only capabilities without restarting a live v0.1 daemon or its Pi children. */
export class CompatibleConnection implements RemoteConnection {
  private slots = new Map<string, SlotInfo>();
  private legacyFiles = false;
  onReconnect?: (listener: (snapshot: Snapshot) => void) => () => void;
  constructor(private connection: RemoteConnection, private sideband: (method: string, params: RecordValue) => Promise<any>) {
    if (connection.onReconnect) this.onReconnect = listener => connection.onReconnect!(listener);
  }
  async request<T = any>(method: string, params: RecordValue = {}): Promise<T> {
    if (!this.legacyFiles || !FILE_METHODS.has(method)) {
      try {
        const result = await this.connection.request<T>(method, params);
        if (method === 'list' && Array.isArray(result)) for (const slot of result) this.slots.set(slot.id, slot);
        if ((method === 'attach' || method === 'snapshot') && (result as any)?.slot) this.slots.set((result as any).slot.id, (result as any).slot);
        return result;
      } catch (error: any) {
        // Never substitute a sideband call for an uncertain mutation or transport error.
        if (!FILE_METHODS.has(method) || !/^Unknown daemon method:/.test(error.message)) throw error;
        this.legacyFiles = true;
      }
    }
    let cwd = params.cwd;
    if (params.slotId) {
      const slots = await this.connection.request<SlotInfo[]>('list');
      for (const slot of slots) this.slots.set(slot.id, slot);
      const slot = this.slots.get(params.slotId);
      if (!slot) throw new Error('Slot not found');
      cwd = slot.cwd;
    }
    return this.sideband(method, { ...params, cwd });
  }
  onEvent(listener: (event: RemoteEvent) => void) { return this.connection.onEvent(listener); }
  onDisconnect(listener: (error: Error) => void) { return this.connection.onDisconnect(listener); }
  close() { this.connection.close(); }
}

export async function fileSideband(options: SshOptions, method: string, params: RecordValue): Promise<any> {
  if (!FILE_METHODS.has(method)) throw new Error('Only read-only filesystem calls may use a sideband');
  if (!options.host || options.host.startsWith('-') || /[\s\x00-\x1f]/.test(options.host)) throw new Error('Invalid SSH host');
  const path = options.remoteBin ?? '~/.local/share/pi-remote/bin/pi-remote';
  const bin = path.startsWith('~/') ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path);
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', options.host, `${bin} fs ${shellQuote(method)}`], {stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return new Promise((resolve,reject) => {
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
export async function connectCompatibleLocal(stateDir?: string): Promise<RemoteConnection> {
  return new CompatibleConnection(await connectLocal(stateDir), async (method,params) => (await import('./files.js')).serveFileRequest(method,params));
}
