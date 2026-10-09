import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { HistoryCursor, RecordValue, RemoteEvent, Snapshot } from './protocol.js';
import { emptyLive, messageKey, putLiveMessage } from './live.js';
export { messageKey } from './live.js';

/** Remote content must not execute terminal control sequences. */
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** Raw history is a tree, not the model's compacted/edited context. */
export function activeBranch(entries: RecordValue[], leafId: string | null): RecordValue[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const seen = new Set<string>();
  const branch: RecordValue[] = [];
  let id = leafId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    branch.push(entry);
    id = entry.parentId ?? null;
  }
  return branch.reverse();
}

/** Optional projections are owned by one Transcript and keyed only by immutable stored entries. */
export function transcriptMessages(snapshot: Snapshot, projections?: WeakMap<RecordValue, RecordValue>): RecordValue[] {
  const messages: RecordValue[] = [];
  const indexes = new Map<string, number>();
  const put = (message: RecordValue) => {
    // Snapshot baselines and their tails are disjoint, even during transitions. Preserve occurrences,
    // including identical notices created or persisted within the same millisecond.
    if (snapshot.historyComplete !== undefined) { messages.push(message); return; }
    const key = messageKey(message);
    const index = indexes.get(key);
    if (index === undefined) { indexes.set(key, messages.length); messages.push(message); }
    else messages[index] = message;
  };
  const putDerived = (entry: RecordValue, message: RecordValue) => {
    projections?.set(entry, message); put(message);
  };
  for (const entry of activeBranch(snapshot.entries, snapshot.leafId)) {
    if (entry.type === 'message' && entry.message) { put(entry.message); continue; }
    const cached = projections?.get(entry);
    if (cached) { put(cached); continue; }
    if (entry.type === 'custom_message') {
      // Stored entry timestamps are ISO strings; live message timestamps are milliseconds.
      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : entry.timestamp;
      putDerived(entry, { ...entry, timestamp: Number.isFinite(timestamp) ? timestamp : entry.timestamp, role: 'custom' });
    }
    else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      putDerived(entry, { ...entry, role: entry.type === 'compaction' ? 'compactionSummary' : 'branchSummary' });
    } else if (entry.type === 'custom') {
      putDerived(entry, { ...entry, role: 'entry', content: `Session entry: ${entry.customType ?? 'custom'} (renderer not loaded)` });
    }
  }
  // Normal snapshots supply unfinished messages plus newer events. Incomplete snapshots
  // retain the whole uncheckpointed tail. Only unmarked legacy snapshots need timestamp merging.
  for (const message of snapshot.live.messages) put(message);
  return messages;
}

/** Never sends reconstructed content back to Pi. Completed blocks replace buffered deltas. */
export function applyAssistantDelta(message: RecordValue, update: RecordValue, usage?: RecordValue): RecordValue {
  if (!update || typeof update !== 'object' || typeof update.type !== 'string') return message;
  if (update.type === 'done' && update.message) return structuredClone(update.message);
  if (update.type === 'error' && update.error && typeof update.error === 'object') return structuredClone(update.error);
  const next: RecordValue = { ...message, content: [...(Array.isArray(message.content) ? message.content : [])] };
  if (usage) next.usage = structuredClone(usage);
  const index = update.contentIndex;
  if (!Number.isInteger(index) || index < 0 || index > 10000) return next;
  if (update.type.endsWith('_delta') && typeof update.delta !== 'string') return next;
  const old = next.content[index] ?? {};
  switch (update.type) {
    case 'text_start': next.content[index] = { type: 'text', text: '' }; break;
    case 'thinking_start': next.content[index] = { type: 'thinking', thinking: '' }; break;
    case 'text_delta': next.content[index] = { ...old, type: 'text', text: (old.text ?? '') + (update.delta ?? '') }; break;
    case 'thinking_delta': next.content[index] = { ...old, type: 'thinking', thinking: (old.thinking ?? '') + (update.delta ?? '') }; break;
    case 'text_end': next.content[index] = { ...old, type: 'text', text: update.content ?? '' }; break;
    case 'thinking_end': next.content[index] = { ...old, type: 'thinking', thinking: update.content ?? '' }; break;
    case 'toolcall_start': next.content[index] = { type: 'toolCall', id: update.id, name: update.toolName, arguments: {}, argumentText: '' }; break;
    case 'toolcall_delta': next.content[index] = { ...old, type: 'toolCall', argumentText: (old.argumentText ?? '') + (update.delta ?? '') }; break;
    case 'toolcall_end': next.content[index] = structuredClone(update.toolCall); break;
  }
  return next;
}

export const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

function uiKey(record: RecordValue): string {
  if (record.method === 'setStatus') return `status:${record.statusKey}`;
  if (record.method === 'setWidget') return `widget:${record.widgetKey}`;
  if (record.method === 'setTitle' || record.method === 'set_editor_text') return record.method;
  return `dialog:${record.id}`;
}

export class HistoryMismatchError extends Error {
  constructor() { super('Snapshot history checkpoint mismatch; a full snapshot is required'); }
}

/** Mutable display state; individual messages remain immutable for render caching. */
export class RemoteView {
  snapshot!: Snapshot;
  // Keep the verified prefix separate from entries appended speculatively by live events.
  private history?: { sessionId: string; entries: RecordValue[] };
  constructor(snapshot: Snapshot) { this.replace(snapshot); }

  hasCompleteHistory(): boolean {
    return this.history !== undefined && this.history.sessionId === this.snapshot.state.sessionId;
  }

  historyCursor(): HistoryCursor | undefined {
    const entryId = this.history?.entries.at(-1)?.id;
    return this.hasCompleteHistory() && typeof entryId === 'string'
      ? { sessionId: this.history!.sessionId, entryId } : undefined;
  }

  invalidateHistory(): void { this.history = undefined; }

  replace(snapshot: Snapshot, events: RemoteEvent[] = []): void {
    const delta = snapshot.historyDelta;
    if (delta && (snapshot.historyComplete !== true || !this.history
      || this.snapshot.slot.id !== snapshot.slot.id || delta.sessionId !== snapshot.state.sessionId
      || delta.sessionId !== this.history.sessionId || delta.entryId !== this.history.entries.at(-1)?.id)) {
      throw new HistoryMismatchError();
    }
    const next = structuredClone(snapshot);
    if (delta) next.entries = [...this.history!.entries, ...next.entries];
    delete next.historyDelta; // Only wire replies can be partial; display snapshots always contain full history.
    this.history = next.historyComplete === true && typeof next.state.sessionId === 'string'
      ? { sessionId: next.state.sessionId, entries: [...next.entries] } : undefined;
    this.snapshot = next;
    for (const event of events) this.apply(event);
  }

  apply(remote: RemoteEvent): boolean {
    const s = this.snapshot;
    if (remote.slotId !== s.slot.id || remote.seq <= s.seq) return false;
    s.seq = remote.seq;
    const event = remote.event;
    const live = s.live;
    switch (event.type) {
      case 'bash_execution_update': {
        live.bash ??= {};
        const id = typeof event.id === 'string' ? event.id : 'bash';
        if (typeof event.delta !== 'string') break;
        const previous = Object.hasOwn(live.bash, id) ? live.bash[id].output : '';
        Object.defineProperty(live.bash, id, {value: {output: (previous + event.delta).slice(-131072)}, writable: true, configurable: true, enumerable: true});
        break;
      }
      case 'remote_bash_end': live.bash = {}; break;
      case 'agent_start': live.busy = true; break;
      // agent_end is NOT idle: automatic retries and queued prompts can continue.
      case 'agent_settled': live.busy = false; break;
      case 'compaction_start': live.compacting = true; break;
      case 'compaction_end': live.compacting = false; break;
      case 'queue_update': live.steering = [...(event.steering ?? [])]; live.followUp = [...(event.followUp ?? [])]; break;
      case 'message_start': case 'message_end': {
        if (!event.message) break;
        putLiveMessage(live, event.message, event.type === 'message_end');
        break;
      }
      case 'message_update': {
        const index = live.messages.findLastIndex(message => message.role === 'assistant' && message.stopReason === 'pending');
        if (index >= 0 && event.assistantMessageEvent) {
          live.messages[index] = applyAssistantDelta(live.messages[index], event.assistantMessageEvent, event.usage);
        }
        break;
      }
      case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': {
        const id = event.toolCallId;
        if (typeof id !== 'string') break;
        const previous = Object.hasOwn(live.tools, id) ? live.tools[id] : undefined;
        Object.defineProperty(live.tools, id, {value: { ...previous, ...structuredClone(event) }, writable: true, configurable: true, enumerable: true});
        break;
      }
      case 'entry_appended':
        if (event.entry && !s.entries.some(entry => entry.id === event.entry.id)) {
          s.entries.push(structuredClone(event.entry));
          // message_end is live-only until the next snapshot. A custom entry can
          // reference that missing parent; moving the leaf then would hide history.
          if ((event.entry.parentId ?? null) === s.leafId) s.leafId = event.entry.id;
        }
        break;
      case 'remote_state': if (event.state) s.state = structuredClone(event.state); break;
      case 'session_info_changed': s.state.sessionName = event.name; break;
      case 'thinking_level_changed': s.state.thinkingLevel = event.level; break;
      case 'extension_ui_request': {
        if (event.method === 'notify') break;
        const index = s.ui.findIndex(record => uiKey(record) === uiKey(event));
        if (index < 0) s.ui.push(structuredClone(event)); else s.ui[index] = structuredClone(event);
        break;
      }
      case 'remote_dialog_resolved': s.ui = s.ui.filter(record => record.id !== event.id); break;
      case 'remote_slot_restart':
        s.slot = structuredClone(event.slot); s.live = emptyLive(); s.ui = [];
        delete s.presentation;
        break;
      case 'remote_slot_exit':
        s.slot.status = 'exited'; s.slot.error = event.error; live.busy = false; live.compacting = false;
        break;
    }
    return true;
  }
}

export function restoredQueueText(queue: RecordValue, draft: string): string {
  return [...(queue.steering ?? []), ...(queue.followUp ?? []), draft].filter(text => typeof text === 'string' && text.length > 0).join('\n\n');
}

export function toolText(result: RecordValue | undefined): string {
  if (!result) return '';
  return (result.content ?? []).map((block: RecordValue) => block.type === 'text' ? safeText(block.text) : block.type === 'image' ? `[image: ${block.mimeType ?? 'unknown'}]` : '').filter(Boolean).join('\n');
}
