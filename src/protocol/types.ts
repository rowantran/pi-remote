import type { DaemonMethod, MethodResult, RequestArgs } from './methods.js';

/** Routing envelope for Pi RPC. Filtered snapshots/events omit assistant signatures;
 * raw RPC replies and the authoritative Pi history remain unchanged. */
/** 2: every slot runs Pi's own interface (attach); the RPC slot methods are gone. */
export const PROTOCOL_VERSION = 2;
export const PI_VERSION = "1.4.0";
export type RecordValue = Record<string, any>;
export interface Request { type: "request"; id: string; method: string; params?: RecordValue }
export interface Result { type: "result"; id: string; success: boolean; data?: any; error?: string }
export interface RemoteEvent { type: "event"; slotId: string; seq: number; event: RecordValue }
export type ServerRecord = Result | RemoteEvent;
export interface SlotInfo {
  id: string;
  /** Stable positive integer within one daemon's persisted slot catalogue. */
  number?: number;
  cwd: string;
  /** Parent daemon slot, not the Pi session ID or parentSession file. */
  parentSlotId?: string;
  /** Derived from the live catalogue, never persisted. */
  parentSlotNumber?: number;
  createdAt: string;
  pid?: number;
  status: "starting" | "running" | "exited";
  sessionFile?: string;
  sessionName?: string;
  error?: string;
  clients: number;
}
export interface CreateOptions { cwd?: string; args?: string[]; sessionPath?: string; parentSlotId?: string; prompt?: string; expectedParentSessionId?: string }
/** A failed recovery attempt and the delay before the next attempt. */
export interface ConnectionRetry { attempt: number; error: Error; nextDelayMs: number }
export interface RemoteConnection {
  readonly reconnecting?: boolean;
  request<M extends DaemonMethod>(method: M, ...args: RequestArgs<M>): Promise<MethodResult<M>>;
  onEvent(listener: (event: RemoteEvent) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
  /** The new attachment after a reconnect. */
  onReconnect?(listener: (attachment: import('./methods.js').SlotAttachment) => void): () => void;
  onRetry?(listener: (retry: ConnectionRetry) => void): () => void;
  close(): void;
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
