import { PI_VERSION, PROTOCOL_VERSION, type RemoteConnection, type RemoteEvent, type Result } from '../../protocol/types.js';
import type { DaemonMethod, MethodResult, RequestArgs } from '../../protocol/methods.js';

const MAX_BYTES = 64 * 1024 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** A browser transport, not an agent. Closing it only detaches this client. */
export class WebSocketConnection implements RemoteConnection {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private events = new Set<(event: RemoteEvent) => void>();
  private disconnects = new Set<(error: Error) => void>();
  private backlog: RemoteEvent[] = [];
  private backlogBytes = 0;
  private error?: Error;

  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', message => {
      try {
        if (typeof message.data !== 'string' || bytes(message.data) > MAX_BYTES) throw new Error('Invalid or oversized server frame');
        const record = JSON.parse(message.data);
        if (record.type === 'result') {
          const result = record as Result;
          const pending = this.pending.get(result.id);
          if (!pending) return;
          this.pending.delete(result.id);
          if (result.success) pending.resolve(result.data);
          else pending.reject(new Error(result.error ?? 'Remote request failed'));
        } else if (record.type === 'event') {
          if (this.events.size) for (const listener of [...this.events]) listener(record);
          else {
            this.backlogBytes += bytes(message.data);
            if (this.backlogBytes > MAX_BYTES) throw new Error('Event backlog exceeded limit');
            this.backlog.push(record);
          }
        } else throw new Error('Invalid daemon record');
      } catch (error) { this.disconnect(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.addEventListener('error', () => this.disconnect(new Error('Connection failed. Remote work continues.')));
    socket.addEventListener('close', () => this.disconnect(new Error('Connection closed. Remote work continues.')));
  }

  static async connect(): Promise<WebSocketConnection> {
    const url = new URL('/ws', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const connection = new WebSocketConnection(socket);
    const timer = setTimeout(() => connection.disconnect(new Error('Connection timed out; remote work continues.')), 15_000);
    try {
      await new Promise<void>((resolve, reject) => {
        const off = connection.onDisconnect(reject);
        socket.addEventListener('open', () => { off(); resolve(); }, { once: true });
      });
      const hello = await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
      if (hello.protocol !== PROTOCOL_VERSION || hello.piVersion !== PI_VERSION) throw new Error('Incompatible daemon protocol or Pi version');
      return connection;
    } catch (error) {
      connection.close(); throw error;
    } finally { clearTimeout(timer); }
  }

  request<M extends DaemonMethod>(method: M, ...args: RequestArgs<M>): Promise<MethodResult<M>> {
    if (this.error || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(this.error ?? new Error('Disconnected. Nothing was sent.'));
    if (this.pending.size >= 256) return Promise.reject(new Error('Too many pending requests'));
    const id = crypto.randomUUID();
    const text = JSON.stringify({ type: 'request', id, method, params: args[0] ?? {} });
    if (bytes(text) > MAX_BYTES || this.socket.bufferedAmount + bytes(text) > MAX_BYTES) return Promise.reject(new Error('Connection output queue exceeds limit; nothing was sent'));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { this.socket.send(text); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  onEvent(listener: (event: RemoteEvent) => void): () => void {
    this.events.add(listener);
    const backlog = this.backlog.splice(0); this.backlogBytes = 0;
    for (const event of backlog) listener(event);
    return () => this.events.delete(listener);
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    if (this.error) queueMicrotask(() => { if (this.disconnects.has(listener)) listener(this.error!); });
    return () => this.disconnects.delete(listener);
  }
  disconnect(error: Error): void {
    if (this.error) return;
    this.error = error;
    for (const pending of this.pending.values()) pending.reject(new Error(`${error.message} The command outcome may be unknown. It was not replayed.`));
    this.pending.clear(); this.events.clear(); this.backlog = []; this.backlogBytes = 0;
    this.socket.close();
    for (const listener of [...this.disconnects]) listener(error);
    this.disconnects.clear();
  }
  close(): void { this.disconnect(new Error('Detached. Remote work continues.')); }
}
