import { setTimeout as delay } from 'node:timers/promises';
import type { Connection } from '../../client/connection.js';
import { ACTIVITY_CAPABILITY, ACTIVITY_DIALOG_METHODS, activitySlot, waitingOnBackground,
  type ActivityMessage, type ActivitySnapshot, type RemoteActivity } from '../../protocol/activity.js';
import { MAX_QUEUED_BYTES } from '../../protocol/jsonl.js';
import { PI_VERSION, PROTOCOL_VERSION, type RemoteEvent, type SlotInfo } from '../../protocol/types.js';

export interface ActivityNotice { id: string; slot: SlotInfo; kind: 'done' | 'blocked' | 'error'; method?: string }
export type ActivityMonitorStatus = 'active' | 'unsupported' | 'disconnected';
interface TrackedSlot {
  slot: SlotInfo; sessionId?: string; seq: number; run: number;
  active: boolean; agent: boolean; manualCompaction: boolean;
  cancelled: boolean; outcome: 'done' | 'error'; runError: boolean;
  tail: ActivityMessage[]; dialogs: Set<string>;
}

/** Lifecycle-only state machine. Never queries history or infers completion from agent_end. */
export class ActivityTracker {
  private slots = new Map<string, TrackedSlot>();
  seed(slots: readonly ActivitySnapshot[]): void {
    this.slots.clear();
    for (const snapshot of slots) {
      if (!snapshot.slot?.id || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || !Array.isArray(snapshot.dialogs)) throw new Error('Invalid activity seed');
      const state = this.fresh(snapshot.slot, snapshot.sessionId, snapshot.seq);
      // A busy seed is an in-progress run, not a completion. Existing dialogs never ring.
      state.active = snapshot.busy;
      state.agent = snapshot.busy;
      state.dialogs = new Set(snapshot.dialogs);
      this.slots.set(snapshot.slot.id, state);
    }
  }
  private fresh(slot: SlotInfo, sessionId: string | undefined, seq: number): TrackedSlot {
    return { slot: activitySlot(slot), sessionId, seq, run: seq, active: false, agent: false, manualCompaction: false,
      cancelled: false, outcome: 'done', runError: false, tail: [], dialogs: new Set() };
  }
  event(record: RemoteEvent): ActivityNotice[] {
    if (record.event.type !== 'remote_activity' || !Number.isSafeInteger(record.seq) || record.seq < 0) return [];
    const activity = record.event as RemoteActivity;
    if (!activity.slot?.id || activity.slot.id !== record.slotId || !activity.source) return [];
    let state = this.slots.get(record.slotId);
    if (state && record.seq <= state.seq) return [];
    const source = activity.source;
    // Exit clears pid in SlotInfo; that is not a replacement and must preserve a busy run.
    const changed = state && ((activity.sessionId !== undefined && state.sessionId !== undefined && activity.sessionId !== state.sessionId)
      || (activity.slot.pid !== undefined && state.slot.pid !== undefined && activity.slot.pid !== state.slot.pid));
    if (!state || changed || source.type === 'remote_slot_restart') {
      state = this.fresh(activity.slot, activity.sessionId, record.seq);
      this.slots.set(record.slotId, state);
    }
    state.slot = activitySlot(activity.slot);
    state.sessionId = activity.sessionId ?? state.sessionId;
    state.seq = record.seq;
    const notices: ActivityNotice[] = [];
    const notice = (kind: ActivityNotice['kind'], identity: string | number, method?: string): ActivityNotice => ({
      id: JSON.stringify([state!.slot.id, state!.slot.pid ?? null, state!.sessionId ?? null, identity, kind]),
      slot: { ...state!.slot }, kind, ...(method ? { method } : {}),
    });
    const settle = () => {
      if (state!.active && !state!.cancelled && (state!.runError || !waitingOnBackground(state!.tail))) notices.push(notice(state!.outcome, state!.run));
      state!.active = false; state!.agent = false; state!.manualCompaction = false; state!.tail = [];
    };
    switch (source.type) {
      case 'agent_start': {
        if (!state.active) state.run = record.seq;
        if (!state.active || !state.agent) state.tail = [];
        else {
          // Retry starts share one logical run. Drop the omitted failed assistant,
          // but retain its preceding background_wait call/result pair.
          const last = state.tail.at(-1);
          if (last?.role === 'assistant' && ['error', 'length'].includes(last.stopReason ?? '')) state.tail.pop();
        }
        state.active = true; state.agent = true; state.manualCompaction = false;
        state.cancelled = false; state.outcome = 'done'; state.runError = false;
        break;
      }
      case 'message_end':
        if (state.agent) state.tail = [...state.tail.slice(-2), source.message];
        if (state.active && source.message.role === 'assistant') {
          if (source.message.stopReason === 'aborted') state.cancelled = true;
          else if (source.message.stopReason === 'error') { state.outcome = 'error'; state.runError = true; }
          else if (source.message.stopReason !== 'pending') state.outcome = 'done';
        }
        break;
      case 'agent_settled':
        if (source.aborted) state.cancelled = true;
        if (source.error) { state.outcome = 'error'; state.runError = true; }
        settle();
        break;
      case 'compaction_start': {
        if (!state.active) {
          state.run = record.seq; state.cancelled = false; state.outcome = 'done'; state.runError = false; state.tail = [];
        }
        state.active = true;
        // Automatic/pre-prompt compaction returns to prompt: its end is NOT completion.
        state.manualCompaction = !state.agent && (source.reason === undefined || source.reason === 'manual');
        if (source.reason === 'overflow') {
          const last = state.tail.at(-1);
          if (last?.role === 'assistant' && ['error', 'length'].includes(last.stopReason ?? '')) state.tail.pop();
          state.runError = false; state.outcome = 'done';
        }
        break;
      }
      case 'compaction_end':
        if (source.aborted) state.cancelled = true;
        if (source.error) state.outcome = 'error';
        if (state.manualCompaction) settle();
        break;
      case 'extension_ui_request':
        if (ACTIVITY_DIALOG_METHODS.has(source.method) && !state.dialogs.has(source.id)) {
          state.dialogs.add(source.id);
          notices.push(notice('blocked', source.id, source.method));
        }
        break;
      case 'remote_slot_exit':
        if (state.active) notices.push(notice('error', state.run));
        state.active = false; state.agent = false; state.manualCompaction = false; state.tail = []; state.dialogs.clear();
        break;
      case 'agent_end': {
        // A sub-run boundary never completes a run, even when no retry is planned.
        if (state.active && source.stopReason === 'aborted') state.cancelled = true;
        if (state.active && source.stopReason === 'error') { state.outcome = 'error'; state.runError = true; }
        if (source.willRetry) {
          const last = state.tail.at(-1);
          if (last?.role === 'assistant' && ['error', 'length'].includes(last.stopReason ?? '')) state.tail.pop();
        }
        break;
      }
      // Resolved dialog IDs remain deduplicated within this session/process.
      case 'remote_dialog_resolved': case 'remote_slot_restart': case 'remote_refresh': break;
    }
    return notices;
  }
}

export interface ActivityMonitorOptions {
  /** Returns an already-handshaken, dedicated connection. No mutations or attachments. */
  connect: () => Promise<Connection>;
  onBell: (notice: ActivityNotice) => void | Promise<void>;
  onStatus?: (status: ActivityMonitorStatus) => void | Promise<void>;
  unsupportedRetryMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  queryTimeoutMs?: number;
  /** Deterministic timer seam for isolated tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface ActivityMonitor { readonly status: ActivityMonitorStatus; close(): void }
function callSafely<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): void {
  try { void Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Never log callback errors or their possible secrets. */ }
}

/** Reconnect only read-only hello/watch requests. An unsupported daemon is left untouched. */
export function startActivityMonitor(options: ActivityMonitorOptions): ActivityMonitor {
  let closed = false;
  let status: ActivityMonitorStatus = 'disconnected';
  let connection: Connection | undefined;
  const abort = new AbortController();
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal, ref: false }));
  const setStatus = (next: ActivityMonitorStatus) => { if (status !== next) { status = next; callSafely(options.onStatus, next); } };
  let retry = options.retryDelayMs ?? 1000;
  async function run() {
    while (!closed) {
      let offEvent = () => {};
      let offDisconnect = () => {};
      try {
        const current = await options.connect();
        if (closed) { current.close(); return; }
        connection = current;
        let disconnected = false;
        const transportAbort = new AbortController();
        const signal = AbortSignal.any([abort.signal, transportAbort.signal]);
        let disconnectedResolve!: () => void;
        const disconnectedPromise = new Promise<void>(resolve => { disconnectedResolve = resolve; });
        const disconnectedOff = current.onDisconnect(() => { disconnected = true; disconnectedResolve(); transportAbort.abort(); });
        offDisconnect = () => { disconnectedOff(); transportAbort.abort(); };
        const tracker = new ActivityTracker();
        let seeded = false;
        let buffer: RemoteEvent[] = [];
        let bufferBytes = 0;
        const dispatch = (event: RemoteEvent) => {
          if (closed || disconnected) return;
          for (const notice of tracker.event(event)) {
            if (closed || disconnected) break;
            callSafely(options.onBell, notice);
          }
        };
        offEvent = current.onEvent(event => {
          if (closed || disconnected || event.event.type !== 'remote_activity') return;
          if (!seeded) {
            bufferBytes += Buffer.byteLength(JSON.stringify(event));
            if (bufferBytes > MAX_QUEUED_BYTES) { current.disconnect(new Error('Activity seed buffer exceeded limit')); return; }
            buffer.push(event);
          } else dispatch(event);
        });
        const query = async <T>(request: Promise<T>): Promise<T> => {
          const timer = setTimeout(() => current.disconnect(new Error('Activity query timed out')), options.queryTimeoutMs ?? 15_000);
          timer.unref();
          try { return await request; } finally { clearTimeout(timer); }
        };
        while (!closed && !disconnected) {
          const hello = await query(current.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION }));
          if (!hello.capabilities?.includes(ACTIVITY_CAPABILITY)) {
            setStatus('unsupported');
            await Promise.race([sleep(options.unsupportedRetryMs ?? 10_000, signal), disconnectedPromise]);
            continue;
          }
          const seed = await query(current.request('watch_activity'));
          if (closed || disconnected) break;
          tracker.seed(seed.slots);
          seeded = true;
          for (const event of buffer) dispatch(event);
          buffer = []; bufferBytes = 0;
          if (closed || disconnected) break;
          retry = options.retryDelayMs ?? 1000;
          setStatus('active');
          await disconnectedPromise;
          break;
        }
      } catch { /* Transport/query failures are not actionable notification content. */ }
      finally {
        offEvent(); offDisconnect();
        connection?.close(); connection = undefined;
      }
      if (!closed) {
        setStatus('disconnected');
        try { await sleep(retry, abort.signal); } catch { return; }
        retry = Math.min(retry * 2, options.maxRetryDelayMs ?? 30_000);
      }
    }
  }
  void run().catch(() => setStatus('disconnected'));
  return {
    get status() { return status; },
    close() { if (!closed) { closed = true; abort.abort(); connection?.close(); setStatus('disconnected'); } },
  };
}
