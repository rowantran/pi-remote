import type { Attachment, FilesystemMetadata, PathCompletionResult } from './files.js';
import type { CreateOptions, HistoryCursor, RecordValue, SlotInfo, Snapshot } from './types.js';

/** Session catalogue data after JSON serialization; no upstream runtime dependency. */
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

export interface HelloResult {
  protocol: number;
  piVersion: string;
  pid: number;
  /** Older compatible daemons may omit these fields. */
  release?: string;
  capabilities?: string[];
}

export interface RestartDaemonResult {
  accepted: boolean;
  pid: number;
  release: string;
  blocked: { slot: SlotInfo; reason: string }[];
  reopen: SlotInfo[];
  reason?: string;
}

/** Pi dialog records remain extensible, but every answer identifies its dialog. */
export interface DialogResponse extends RecordValue {
  id: string;
  cancelled?: boolean;
  confirmed?: boolean;
  value?: string;
}

type FileContext = { slotId?: string; cwd?: string };
type EmptyResult = Record<string, never>;

/** The daemon envelope is typed here; inner Pi commands and results stay pass-through. */
export interface DaemonMethods {
  hello: { params: { protocol: number; piVersion: string }; result: HelloResult };
  list: { params: Record<string, never>; result: SlotInfo[] };
  create: { params: CreateOptions; result: SlotInfo };
  /** Version fields are retained for callers that send legacy attachment metadata. */
  attach: { params: { slotId: string; protocol?: number; piVersion?: string }; result: Snapshot };
  snapshot: { params: { slotId: string; historyCursor?: HistoryCursor }; result: Snapshot };
  sessions: { params: { slotId: string; side?: boolean }; result: SessionInfo[] };
  restart_daemon: { params: { force?: boolean }; result: RestartDaemonResult };
  restart: { params: { slotId: string; force?: boolean }; result: SlotInfo };
  rpc: { params: { slotId: string; command: RecordValue }; result: unknown };
  answer: { params: { slotId: string; response: DialogResponse }; result: EmptyResult };
  kill: { params: { slotId: string }; result: EmptyResult };
  complete_path: { params: FileContext & { prefix: string; directoriesOnly?: boolean }; result: PathCompletionResult };
  read_attachment: { params: FileContext & { path: string }; result: Attachment };
  filesystem_metadata: { params: FileContext; result: FilesystemMetadata };
}

export type DaemonMethod = keyof DaemonMethods;
export type FileMethod = 'complete_path' | 'read_attachment' | 'filesystem_metadata';
export type MethodParams<M extends DaemonMethod> = DaemonMethods[M]['params'];
export type MethodResult<M extends DaemonMethod> = DaemonMethods[M]['result'];
/** Params may be omitted only when the method has no required parameter fields. */
export type RequestArgs<M extends DaemonMethod> = {} extends MethodParams<M>
  ? [params?: MethodParams<M>]
  : [params: MethodParams<M>];
