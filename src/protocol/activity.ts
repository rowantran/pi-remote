import type { RecordValue, SlotInfo } from './types.js';

export const ACTIVITY_CAPABILITY = 'activity_stream';
export const ACTIVITY_DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
export interface ActivitySnapshot {
  slot: SlotInfo;
  seq: number;
  sessionId?: string;
  busy: boolean;
  compacting: boolean;
  dialogs: string[];
}
/** These records intentionally cannot carry transcript text, tool arguments, or provider data. */
export interface ActivityMessage {
  role: string;
  stopReason?: string;
  content?: { type: 'toolCall'; name: string; id: string }[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}
export type ActivitySource =
  | { type: 'agent_start' | 'remote_slot_restart' | 'remote_refresh' }
  | { type: 'agent_end'; willRetry?: boolean; stopReason?: string }
  | { type: 'agent_settled'; aborted?: boolean; error?: boolean }
  | { type: 'compaction_start'; reason?: 'manual' | 'overflow' | 'automatic' }
  | { type: 'compaction_end'; aborted?: boolean; error?: boolean }
  | { type: 'remote_slot_exit'; error: boolean }
  | { type: 'extension_ui_request'; id: string; method: string }
  | { type: 'remote_dialog_resolved'; id: string }
  | { type: 'message_end'; message: ActivityMessage };
export interface RemoteActivity {
  type: 'remote_activity';
  slot: SlotInfo;
  sessionId?: string;
  source: ActivitySource;
}

/** Explicit projection rather than a spread: SlotInfo.error may contain stderr/provider details. */
export function activitySlot(slot: SlotInfo): SlotInfo {
  return {
    id: slot.id, number: slot.number, parentSlotId: slot.parentSlotId, parentSlotNumber: slot.parentSlotNumber,
    cwd: slot.cwd, createdAt: slot.createdAt, pid: slot.pid, status: slot.status,
    sessionFile: slot.sessionFile, sessionName: slot.sessionName, clients: slot.clients,
  };
}
export function activitySource(event: RecordValue): ActivitySource | undefined {
  switch (event.type) {
    case 'agent_start': case 'remote_slot_restart': case 'remote_refresh': return { type: event.type };
    case 'agent_end': {
      const last = Array.isArray(event.messages) ? event.messages.findLast((message: any) => message?.role === 'assistant') : undefined;
      const stopReason = ['stop', 'length', 'toolUse', 'error', 'aborted', 'pending'].includes(last?.stopReason) ? last.stopReason : undefined;
      return { type: event.type, ...(typeof event.willRetry === 'boolean' ? { willRetry: event.willRetry } : {}), ...(stopReason ? { stopReason } : {}) };
    }
    case 'agent_settled': return { type: event.type, ...(typeof event.aborted === 'boolean' ? { aborted: event.aborted } : {}), ...(event.error === true ? { error: true } : {}) };
    case 'compaction_start': return {
      type: event.type, ...(event.reason === undefined ? {} : { reason: event.reason === 'manual' ? 'manual' : event.reason === 'overflow' ? 'overflow' : 'automatic' }),
    };
    case 'compaction_end': return { type: event.type, aborted: event.aborted === true, error: !!event.errorMessage };
    case 'remote_slot_exit': return { type: event.type, error: !!event.error };
    case 'extension_ui_request': return ACTIVITY_DIALOG_METHODS.has(event.method) && typeof event.id === 'string'
      ? { type: event.type, id: event.id, method: event.method } : undefined;
    case 'remote_dialog_resolved': return typeof event.id === 'string' ? { type: event.type, id: event.id } : undefined;
    case 'message_end': {
      const raw = event.message;
      if (!raw || typeof raw !== 'object' || typeof raw.role !== 'string') return undefined;
      const message: ActivityMessage = { role: raw.role };
      if (raw.role === 'assistant') {
        if (typeof raw.stopReason === 'string') message.stopReason = raw.stopReason;
        // Preserve an empty content array: it is meaningful to the background-wait predicate.
        if (Array.isArray(raw.content)) message.content = raw.content.filter((block: any) => block?.type === 'toolCall'
          && typeof block.name === 'string' && typeof block.id === 'string').map((block: any) => ({ type: 'toolCall', name: block.name, id: block.id }));
      } else if (raw.role === 'toolResult') {
        if (typeof raw.toolName === 'string') message.toolName = raw.toolName;
        if (typeof raw.toolCallId === 'string') message.toolCallId = raw.toolCallId;
        if (typeof raw.isError === 'boolean') message.isError = raw.isError;
      }
      return { type: event.type, message };
    }
  }
}

/** Call only at a completed-run checkpoint, with messages scoped to that run.
 * Works equally with complete TUI messages and the activity stream's redacted messages.
 */
export function waitingOnBackground(messages: readonly RecordValue[] | readonly ActivityMessage[]): boolean {
  const [call, result, reply] = messages.slice(-3);
  if (call?.role !== 'assistant' || call.stopReason !== 'toolUse'
    || result?.role !== 'toolResult' || result.toolName !== 'background_wait' || reply?.role !== 'assistant') return false;
  const calls = Array.isArray(call.content) ? call.content.filter((block: RecordValue) => block.type === 'toolCall') : [];
  return calls.length === 1 && calls[0].name === 'background_wait' && typeof calls[0].id === 'string' && calls[0].id.length > 0
    && result.toolCallId === calls[0].id && result.isError === false
    && reply.stopReason === 'stop' && Array.isArray(reply.content)
    && !reply.content.some((block: RecordValue) => block.type === 'toolCall');
}
