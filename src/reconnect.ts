import type { RecordValue, RemoteConnection, RemoteEvent, Snapshot } from './protocol.js';

export interface ReconnectOptions { minDelayMs?: number; maxDelayMs?: number }
type Factory = () => Promise<RemoteConnection>;
type State = 'connected' | 'recovering' | 'terminal' | 'closed';
interface Generation {
  connection: RemoteConnection;
  offEvent: () => void;
  offDisconnect: () => void;
  buffering: boolean;
  error?: Error;
}
const MAX_BACKLOG_BYTES = 64 * 1024 * 1024;
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
// The wire protocol currently carries error text, not machine-readable error codes.
const incompatible = (error: Error): boolean =>
  /(?:version|protocol).*(?:mismatch|incompatible|does not match|unsupported)|(?:mismatch|incompatible|unsupported).*(?:version|protocol)|matching versions first/i.test(error.message);
const unavailableSlot = (error: Error): boolean =>
  /\b(?:slot (?:not found|is not running|has exited)|(?:unknown|missing|exited) slot|session not found|daemon restarted|Pi exited)\b/i.test(error.message);

/** Reattach an existing slot, never replay a command or create a replacement Pi process. */
export class ReconnectingConnection implements RemoteConnection {
  private state: State = 'connected';
  private current?: Generation;
  private error?: Error;
  private slotId?: string;
  private exited = false;
  private snapshotSeq = -1;
  private recoveredSnapshot?: Snapshot;
  private events = new Set<(event: RemoteEvent) => void>();
  private disconnects = new Set<(error: Error) => void>();
  private reconnects = new Set<(snapshot: Snapshot) => void>();
  private backlog: RemoteEvent[] = [];
  private backlogBytes = 0;
  private draining = false;
  private recovery?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private cancelDelay?: () => void;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;

  private constructor(private factory: Factory, options: ReconnectOptions) {
    this.minDelayMs = options.minDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    if (!Number.isFinite(this.minDelayMs) || !Number.isFinite(this.maxDelayMs) || this.minDelayMs < 0 || this.maxDelayMs < this.minDelayMs) {
      throw new Error('Reconnect delays must be finite, nonnegative, and maxDelayMs >= minDelayMs');
    }
  }

  /** The factory must return a transport that has already completed its version handshake. */
  static async connect(factory: Factory, options: ReconnectOptions = {}): Promise<ReconnectingConnection> {
    const wrapper = new ReconnectingConnection(factory, options);
    wrapper.install(await factory(), false);
    // Connection reports an already-failed transport to late subscribers in a microtask.
    await Promise.resolve();
    if (wrapper.state !== 'connected') throw wrapper.error;
    return wrapper;
  }

  async request<T = any>(method: string, params: RecordValue = {}): Promise<T> {
    const generation = this.current;
    if (this.state !== 'connected' || !generation) throw this.error ?? new Error('Disconnected. Nothing was sent.');
    if (method === 'attach') {
      if (generation.buffering) throw new Error('Attachment already in progress');
      generation.buffering = true;
    }
    try {
      // No queue, retry, or mutation deadline: pending requests belong to the inner transport.
      const result = await generation.connection.request<T>(method, params);
      if (this.current !== generation) throw new Error(`${generation.error?.message ?? 'Connection closed'} The result of an in-flight command may be unknown; it was not retried.`);
      if (method === 'attach') {
        const snapshot = result as Snapshot;
        this.validateSnapshot(snapshot, params.slotId);
        this.slotId = snapshot.slot.id;
        this.recoveredSnapshot = undefined;
        this.acceptSnapshot(snapshot);
        generation.buffering = false;
        this.drain();
      }
      return result;
    } catch (error) {
      if (method === 'attach' && this.current === generation) {
        generation.buffering = false;
        this.clearBacklog();
      }
      throw error;
    }
  }

  onEvent(listener: (event: RemoteEvent) => void): () => void {
    if (this.state !== 'closed' && this.state !== 'terminal') {
      this.events.add(listener);
      this.drain();
    }
    return () => { this.events.delete(listener); };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnects.add(listener);
    const error = this.error;
    if (error) queueMicrotask(() => {
      if (this.disconnects.has(listener) && this.error === error && this.state !== 'connected') this.call(listener, error);
    });
    return () => { this.disconnects.delete(listener); };
  }

  /** Subscribe before onEvent. Late subscribers receive the latest recovered snapshot first. */
  onReconnect(listener: (snapshot: Snapshot) => void): () => void {
    if (this.state !== 'closed' && this.state !== 'terminal') {
      this.reconnects.add(listener);
      if (this.state === 'connected' && this.recoveredSnapshot) this.call(listener, this.recoveredSnapshot);
    }
    return () => { this.reconnects.delete(listener); };
  }

  /** Detach only this client; cancel recovery without stopping the remote slot. */
  close(): void {
    if (this.state === 'closed') return;
    const notify = this.state === 'connected';
    this.state = 'closed';
    this.error = new Error('Detached from remote session');
    this.cancelDelay?.();
    this.release(this.error);
    this.clearBacklog();
    if (notify) this.notifyDisconnect(this.error);
    this.events.clear();
    this.disconnects.clear();
    this.reconnects.clear();
    this.recoveredSnapshot = undefined;
  }

  private install(connection: RemoteConnection, buffering: boolean): Generation {
    const generation: Generation = { connection, buffering, offEvent: () => {}, offDisconnect: () => {} };
    this.current = generation;
    generation.offDisconnect = connection.onDisconnect(error => this.lost(generation, error));
    if (this.current !== generation) { generation.offDisconnect(); return generation; }
    generation.offEvent = connection.onEvent(event => {
      if (this.current !== generation) return;
      if (this.slotId && event.slotId !== this.slotId && !generation.buffering) return;
      if (!generation.buffering && event.seq <= this.snapshotSeq) return;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (this.backlogBytes + bytes > MAX_BACKLOG_BYTES) { this.terminal(new Error('Event backlog exceeded limit')); return; }
      this.backlog.push(event);
      this.backlogBytes += bytes;
      if (event.slotId === this.slotId && event.event.type === 'remote_slot_exit') this.exited = true;
      this.drain();
    });
    // Both subscription methods may synchronously deliver buffered notifications.
    if (this.current !== generation) generation.offEvent();
    return generation;
  }

  private lost(generation: Generation, error: Error): void {
    if (this.current !== generation) return;
    this.error = error;
    this.state = this.slotId && !this.exited && !incompatible(error) && !unavailableSlot(error) ? 'recovering' : 'terminal';
    this.release(error);
    this.clearBacklog();
    this.notifyDisconnect(error); // Notify before even scheduling a retry.
    if (this.state === 'recovering') this.startRecovery();
  }

  private release(error: Error): void {
    const generation = this.current;
    this.current = undefined;
    if (!generation) return;
    generation.error = error;
    generation.offEvent();
    generation.offDisconnect();
    generation.connection.close();
  }

  private terminal(error: Error): void {
    this.state = 'terminal';
    this.error = error;
    this.cancelDelay?.();
    this.release(error);
    this.clearBacklog();
    this.notifyDisconnect(error);
  }

  private startRecovery(): void {
    if (this.recovery || this.state !== 'recovering') return;
    this.recovery = this.recover().finally(() => {
      this.recovery = undefined;
      // A reconnect listener can itself cause another drop before recover() returns.
      if (this.state === 'recovering') this.startRecovery();
    });
  }

  private async recover(): Promise<void> {
    const slotId = this.slotId;
    if (!slotId) return;
    let delay = this.minDelayMs;
    while (this.state === 'recovering') {
      await this.wait(delay);
      if (this.state !== 'recovering') return;
      delay = Math.min(this.maxDelayMs, Math.max(1, delay * 2));
      let generation: Generation | undefined;
      try {
        const connection = await this.factory();
        if (this.state !== 'recovering') { connection.close(); return; }
        generation = this.install(connection, true);
        if (this.current !== generation) continue;
        const snapshot = await connection.request<Snapshot>('attach', { slotId });
        if (this.current !== generation || this.state !== 'recovering') continue;
        this.validateSnapshot(snapshot, slotId);
        this.acceptSnapshot(snapshot);
        this.recoveredSnapshot = snapshot;
        this.state = 'connected';
        this.error = undefined;
        for (const listener of [...this.reconnects]) {
          if (this.current !== generation) break;
          this.call(listener, snapshot);
        }
        if (this.current === generation) {
          generation.buffering = false;
          this.drain();
        }
        return;
      } catch (error) {
        if (this.state !== 'recovering') return;
        const failure = asError(error);
        // A failed attach on a live transport is authoritative (missing/exited slot,
        // for example). Only transport loss or factory connection failures retry.
        if (incompatible(failure) || unavailableSlot(failure) || (generation && this.current === generation)) {
          this.terminal(failure);
          return;
        }
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.cancelDelay = undefined;
        resolve();
      };
      this.cancelDelay = finish;
      this.timer = setTimeout(finish, ms);
    });
  }

  private validateSnapshot(snapshot: Snapshot, slotId: string): void {
    if (!snapshot?.slot || snapshot.slot.id !== slotId || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0) throw new Error('Invalid attach snapshot');
    if (snapshot.slot.status === 'exited') throw new Error(snapshot.slot.error ?? 'Slot is not running');
  }

  private acceptSnapshot(snapshot: Snapshot): void {
    this.snapshotSeq = snapshot.seq;
    this.backlog = this.backlog.filter(event => event.slotId === snapshot.slot.id && event.seq > snapshot.seq);
    this.exited = this.backlog.some(event => event.event.type === 'remote_slot_exit');
    this.backlogBytes = this.backlog.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    const generation = this.current;
    try {
      while (generation && this.current === generation && this.state === 'connected' && !generation.buffering && this.events.size && this.backlog.length) {
        const event = this.backlog.shift()!;
        this.backlogBytes -= Buffer.byteLength(JSON.stringify(event));
        if (event.event.type === 'remote_slot_exit') this.exited = true;
        for (const listener of [...this.events]) {
          if (this.current !== generation) break;
          this.call(listener, event);
        }
      }
    } finally { this.draining = false; }
  }

  private clearBacklog(): void { this.backlog = []; this.backlogBytes = 0; }
  private notifyDisconnect(error: Error): void {
    for (const listener of [...this.disconnects]) this.call(listener, error);
  }
  private call<T>(listener: (value: T) => void, value: T): void {
    try { listener(value); } catch (error) { console.error('Connection listener failed:', error); }
  }
}
