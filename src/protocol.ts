/** Pi's inner RPC records are passed through unchanged. This envelope only adds routing. */
export const PROTOCOL_VERSION = 1;
export const PI_VERSION = "1.0.4";
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
  createdAt: string;
  pid?: number;
  status: "starting" | "running" | "exited";
  sessionFile?: string;
  sessionName?: string;
  error?: string;
  clients: number;
}
export interface LiveState {
  busy: boolean;
  compacting: boolean;
  messages: RecordValue[];
  tools: Record<string, RecordValue>;
  steering: string[];
  followUp: string[];
  bash?: Record<string, RecordValue>;
}
export interface Snapshot {
  slot: SlotInfo;
  state: RecordValue;
  entries: RecordValue[];
  leafId: string | null;
  live: LiveState;
  ui: RecordValue[];
  seq: number;
  /** Baseline/tail separation: true covers completed messages through seq, leaving only unfinished
   * live messages. False preserves a cached baseline and uncheckpointed tail during a transition.
   * Only legacy daemons omit this marker. */
  historyComplete?: boolean;
  presentation?: { models?: RecordValue[]; stats?: RecordValue; gitBranch?: string; homeDir?: string; [key: string]: any };
}
export interface CreateOptions { cwd: string; args?: string[]; sessionPath?: string }
export interface RemoteConnection {
  request<T = any>(method: string, params?: RecordValue): Promise<T>;
  onEvent(listener: (event: RemoteEvent) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
  onReconnect?(listener: (snapshot: Snapshot) => void): () => void;
  close(): void;
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
