import type { Attachment, FilesystemMetadata, PathCompletionResult } from './files.js';
import type { ActivitySnapshot } from './notification-stream.js';
import type { CreateOptions, SlotInfo } from './types.js';
import type { CompanionMessage, TerminalAnswers } from './companion.js';

/** A client's terminal: its size and its answers to Pi's terminal queries. */
export interface ClientTerminal { columns: number; rows: number; answers?: TerminalAnswers }

/**
 * attach result. `messages` rebuild the current screen from nothing; live messages
 * follow as `{ type: 'screen', message }` events with a higher seq.
 */
export interface SlotAttachment { slot: SlotInfo; messages: CompanionMessage[]; seq: number;
  /** Pi is running or compacting. Later changes arrive as agent_start and agent_settled events. */
  busy?: boolean }

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

/** Read-only facts about the daemon and its machine, for `pi-remote status`. */
export interface DaemonStatus {
  pid: number;
  release: string;
  /** ISO time the daemon process started. */
  startedAt: string;
  piVersion: string;
  nodeVersion: string;
  host: {
    hostname: string; platform: string; arch: string;
    uptimeSeconds: number;
    /** 1, 5, and 15 minute load averages. */
    loadavg: number[];
    cpus: number;
    totalMemory: number; freeMemory: number;
  };
}

export interface RestartDaemonResult {
  accepted: boolean;
  pid: number;
  release: string;
  blocked: { slot: SlotInfo; reason: string }[];
  reopen: SlotInfo[];
  reason?: string;
}

type FileContext = { slotId?: string; cwd?: string };
type EmptyResult = Record<string, never>;

/** The daemon envelope is typed here; inner Pi commands and results stay pass-through. */
export interface DaemonMethods {
  hello: { params: { protocol: number; piVersion: string }; result: HelloResult };
  list: { params: Record<string, never>; result: SlotInfo[] };
  /** Smallest round trip, for latency measurement. Older daemons lack it and `status`;
   * clients recognize their "Unknown daemon method" error. */
  ping: { params: Record<string, never>; result: EmptyResult };
  status: { params: Record<string, never>; result: DaemonStatus };
  /** Read-only, all-slot lifecycle stream. Not an attachment and never a slot client. */
  watch_activity: { params: Record<string, never>; result: { slots: ActivitySnapshot[] } };
  create: { params: CreateOptions; result: SlotInfo };
  /** Stored sessions for a slot's workspace, or for `cwd` without a slot (with an optional
   * `--session-dir` value). `summary` leaves allMessagesText empty. Older daemons
   * require slotId; clients recognize their error. */
  sessions: { params: ({ slotId: string; cwd?: never; sessionDir?: never } | { cwd: string; sessionDir?: string; slotId?: never }) & { side?: boolean; summary?: boolean }; result: SessionInfo[] };
  restart_daemon: { params: { force?: boolean }; result: RestartDaemonResult };
  restart: { params: { slotId: string; force?: boolean }; result: SlotInfo };
  kill: { params: { slotId: string }; result: EmptyResult };
  /** Attach to a slot. The client that last typed or resized sets Pi's terminal size. */
  attach: { params: { slotId: string } & ClientTerminal; result: SlotAttachment };
  /** Keys for Pi, in order. Makes this client the one that sets Pi's terminal size. */
  input: { params: { slotId: string; data: string }; result: EmptyResult };
  resize: { params: { slotId: string } & ClientTerminal; result: EmptyResult };
  /** Store a pasted file on the daemon's machine for Pi to read; returns its path. */
  upload: { params: { slotId: string; name: string; data: string }; result: { path: string } };
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
