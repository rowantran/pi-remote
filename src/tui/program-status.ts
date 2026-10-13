import type { Terminal } from '@earendil-works/pi-tui';
import type { RecordValue, Snapshot } from '../protocol/types.js';
import { DIALOG_METHODS, transcriptMessages } from './view.js';

export const WAITING_STATUS_KEY = 'waiting-on-background';
export const WAITING_STATUS_TEXT = 'Waiting on background task';
export const PROGRAM_STATUS_QUERY = '\x1b]7501;?\x1b\\';
export interface ProgramStatus {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'clear';
  kind?: 'permission' | 'question';
  message?: string;
}

/** Root records only. Keep this compatible with Pi's newer pi-tui formatter. */
export function formatProgramStatus(status: ProgramStatus): string {
  const pairs = [`state=${status.state}`, 'app=pi'];
  if (status.state === 'blocked' && status.kind) pairs.push(`kind=${status.kind}`);
  const text = (status.message ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  let message = '', bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > 2048) break;
    message += character;
  }
  if (message) pairs.push(`msg=${Buffer.from(message, 'utf8').toString('base64')}`);
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}

export function waitingOnBackground(snapshot: Snapshot): boolean {
  return snapshot.ui.some(record => record.method === 'setStatus'
    && record.statusKey === WAITING_STATUS_KEY && record.statusText === WAITING_STATUS_TEXT);
}

type Outcome = { state: 'idle' | 'done' | 'error'; message?: string };
function lastAssistant(snapshot: Snapshot): RecordValue | undefined {
  return transcriptMessages(snapshot).findLast(message => message.role === 'assistant');
}
function assistantIdentity(message: RecordValue | undefined): string | undefined {
  // Stable across live messages and saved snapshot copies, regardless of property order.
  return message ? JSON.stringify([message.timestamp, message.stopReason, message.model, message.errorMessage]) : undefined;
}
function messageOutcome(message: RecordValue | undefined): Outcome | undefined {
  if (message?.role !== 'assistant' || message.stopReason === 'pending') return undefined;
  if (message.stopReason === 'aborted') return { state: 'idle' };
  return message.stopReason === 'error'
    ? { state: 'error', message: message.errorMessage } : { state: 'done' };
}

/** One logical run can contain several agent_start/end pairs (retries and follow-ups).
 * Notification identity belongs to the run, not the resulting state string. */
export class ProgramActivity {
  private sessionId?: string;
  private active = false;
  private outcome: Outcome = { state: 'idle' };
  private cancelled = false;
  private localAbort = false;
  private operation = 0;
  private settledDuringAbort = false;
  private recoveredCompletion = false;
  private runAssistant?: string;
  /** A signal clear precedes collection of the background result; it is not task completion. */
  private waitingHandoff = false;
  private handoffAssistant?: string;
  private awaitingAgent = false;
  private exited = false;
  private dialogs = new Set<string>();

  constructor(snapshot: Snapshot) { this.reset(snapshot); }

  reset(snapshot: Snapshot): void {
    this.operation++;
    this.waitingHandoff = false;
    this.awaitingAgent = false;
    this.exited = false;
    this.localAbort = false; this.settledDuringAbort = false; this.recoveredCompletion = false;
    this.sessionId = snapshot.state.sessionId;
    this.active = snapshot.live.busy || snapshot.live.compacting;
    this.outcome = { state: this.active ? 'done' : 'idle' };
    this.cancelled = false;
    this.runAssistant = assistantIdentity(lastAssistant(snapshot));
    this.dialogs = new Set(snapshot.ui.filter(record => DIALOG_METHODS.has(record.method)).map(record => record.id));
  }

  /** The caller applies each sequenced event once. Snapshot journal replay must not call this. */
  event(event: RecordValue, snapshot: Snapshot): void {
    switch (event.type) {
      case 'agent_start': case 'compaction_start':
        this.waitingHandoff = false;
        this.cancelled = false;
        this.awaitingAgent = event.type === 'compaction_start' && !snapshot.live.busy
          && event.reason !== undefined && event.reason !== 'manual';
        if (!this.active) {
          this.operation++;
          this.localAbort = false; this.settledDuringAbort = false; this.recoveredCompletion = false;
          this.cancelled = false;
          this.runAssistant = assistantIdentity(lastAssistant(snapshot));
        }
        this.active = true;
        this.outcome = { state: 'done' };
        break;
      case 'message_end': {
        const outcome = messageOutcome(event.message);
        if (this.active && outcome) this.outcome = outcome;
        break;
      }
      case 'agent_end': {
        const message = event.messages?.findLast((record: RecordValue) => record.role === 'assistant');
        const outcome = messageOutcome(message);
        if (this.active && outcome) this.outcome = outcome;
        break;
      }
      case 'auto_retry_end':
        if (this.active && event.success === false) this.outcome = event.finalError === 'Retry cancelled'
          ? { state: 'idle' } : { state: 'error', message: event.finalError };
        break;
      case 'compaction_end':
        // Pre-prompt automatic compaction returns to prompt() even on failure/cancellation.
        // Its following agent_start, not this end event, owns the eventual completion.
        if (event.aborted) this.outcome = { state: 'idle' };
        else if (event.errorMessage) this.outcome = { state: 'error', message: event.errorMessage };
        break;
      case 'agent_settled':
        this.awaitingAgent = false;
        // Newer remote Pi versions expose cancellation even after a successful reply.
        if (event.aborted === true) {
          this.cancelled = true;
          this.waitingHandoff = false;
          this.outcome = { state: 'idle' };
        }
        break;
      case 'remote_slot_exit':
        this.awaitingAgent = false;
        if (event.error) this.outcome = { state: 'error', message: event.error };
        break;
    }
    if (this.outcome.state === 'idle' && this.active) this.cancelled = true;
    if (this.cancelled) this.outcome = { state: 'idle' };
  }

  /** RPC abort has no dedicated event. Mark the request before its settle can race the reply,
   * but keep observed outcomes separate so a refused request can undo only its own mark. */
  abort(): () => void {
    const operation = this.operation, previous = this.localAbort;
    this.localAbort = true;
    return () => {
      if (operation !== this.operation) return;
      this.localAbort = previous;
      if (!previous && this.settledDuringAbort) this.recoveredCompletion = true;
      this.settledDuringAbort = false;
    };
  }

  /** Pre-prompt compaction can finish before prompt preflight subsequently rejects. */
  promptFailed(message: string): void {
    if (!this.awaitingAgent) return;
    this.awaitingAgent = false;
    this.cancelled = false;
    this.outcome = { state: 'error', message };
  }

  /** Reconcile an authoritative snapshot without replaying completed runs or existing dialogs. */
  update(snapshot: Snapshot, options: { snapshot?: boolean; reconnect?: boolean } = {}): { status: ProgramStatus; bells: number } {
    if (this.sessionId !== snapshot.state.sessionId) this.reset(snapshot);
    const last = options.snapshot ? lastAssistant(snapshot) : undefined;
    if (snapshot.slot.status === 'exited') this.awaitingAgent = false;
    if (options.reconnect && this.awaitingAgent && !snapshot.live.busy && !snapshot.live.compacting) {
      // Pi 1.0.4 cannot expose another requester's preflight failure. A reconnect gives the
      // user a recovery path, but proves neither success nor failure: return quietly to idle.
      this.awaitingAgent = false; this.active = false; this.cancelled = true; this.outcome = { state: 'idle' };
    }
    if (options.snapshot && this.awaitingAgent && messageOutcome(last) && assistantIdentity(last) !== this.runAssistant) this.awaitingAgent = false;
    const busy = snapshot.live.busy || snapshot.live.compacting || this.awaitingAgent;
    let settled = this.active && !busy;
    const waiting = waitingOnBackground(snapshot);
    if (snapshot.slot.status === 'exited') {
      this.waitingHandoff = false;
      if (snapshot.slot.error) this.outcome = { state: 'error', message: snapshot.slot.error };
      else if (!this.exited && !this.active) this.outcome = { state: 'idle' };
      this.exited = true;
    } else if (options.snapshot && !busy && !waiting && this.waitingHandoff) {
      if (assistantIdentity(last) !== this.handoffAssistant && messageOutcome(last)) {
        // A complete wake-up run may have happened while disconnected or across an event gap.
        // New final assistant output proves completion; a signal clear alone does not.
        this.outcome = messageOutcome(last)!;
        this.cancelled = this.outcome.state === 'idle';
        this.waitingHandoff = false;
        settled = true;
      }
    }
    if (options.reconnect) {
      for (const record of snapshot.ui) if (DIALOG_METHODS.has(record.method)) this.dialogs.add(record.id);
    }
    if (this.active && !busy) {
      if (options.snapshot && !this.cancelled && !this.localAbort) {
        // A standalone compaction or interrupted run may not create an assistant message.
        // Never mistake a previous run's saved error/abort for this run's outcome.
        this.outcome = snapshot.slot.status === 'exited' && snapshot.slot.error ? { state: 'error', message: snapshot.slot.error }
          : assistantIdentity(last) !== this.runAssistant ? messageOutcome(last) ?? this.outcome : this.outcome;
        if (this.outcome.state === 'idle') this.cancelled = true;
      }
      this.active = false;
      if (this.localAbort) this.settledDuringAbort = true;
    } else if (!this.active && busy) {
      this.operation++;
      this.waitingHandoff = false;
      this.localAbort = false; this.settledDuringAbort = false; this.recoveredCompletion = false;
      this.active = true;
      this.cancelled = false;
      this.runAssistant = assistantIdentity(lastAssistant(snapshot));
      this.outcome = { state: 'done' };
    }
    let bells = 0;
    for (const record of snapshot.ui) if (DIALOG_METHODS.has(record.method) && !this.dialogs.has(record.id)) {
      this.dialogs.add(record.id); bells++;
    }
    if (snapshot.slot.status !== 'exited' && !busy && !this.cancelled && !this.localAbort && this.outcome.state !== 'error' && waiting && !this.waitingHandoff) {
      this.waitingHandoff = true;
      this.handoffAssistant = assistantIdentity(lastAssistant(snapshot));
    }
    const dialog = snapshot.slot.status !== 'exited' && snapshot.ui.find(record => DIALOG_METHODS.has(record.method));
    const status: ProgramStatus = snapshot.slot.status === 'exited' ? { ...this.outcome } : dialog ? { state: 'blocked', kind: dialog.method === 'confirm' ? 'permission' : 'question',
      message: dialog.title }
      : busy ? { state: 'working', message: snapshot.live.compacting ? 'Compacting' : undefined }
      : this.cancelled || this.localAbort ? { state: 'idle' }
      : this.outcome.state === 'error' ? { ...this.outcome }
      : this.waitingHandoff ? { state: 'working', message: waiting ? WAITING_STATUS_TEXT : undefined }
      : { ...this.outcome };
    if (status.state === 'error') status.message = status.message?.split(/[\r\n]/, 1)[0];
    if ((status.state === 'working' || status.state === 'done') && !status.message) {
      status.message = snapshot.state.sessionName ?? snapshot.slot.sessionName;
    }
    // A signal clear can precede agent_start or a background completion wake-up.
    // Only a real observed settlement may notify, never working -> done by itself.
    if ((settled || this.recoveredCompletion) && (status.state === 'done' || status.state === 'error')) bells++;
    this.recoveredCompletion = false;
    return { status, bells };
  }
}

/** Compatibility adapter for pi-tui 1.0.4. It already splits input into complete terminal
 * sequences. Its keyboard DA1 is consumed internally, so query after start with our own DA1.
 * No reports are written until support is confirmed (or explicitly forced). */
export class ProgramStatusTerminal implements Terminal {
  private status: ProgramStatus = { state: 'idle' };
  private encoded?: string;
  private supported = false;
  private pending = false;
  private awaitingDeviceAttributes = false;
  private started = false;
  private timeout?: NodeJS.Timeout;
  constructor(private terminal: Terminal, private env: NodeJS.ProcessEnv = process.env) {}
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.started = true;
    this.encoded = undefined;
    this.supported = this.env.PI_PROGRAM_STATUS === '1';
    this.pending = this.env.PI_PROGRAM_STATUS !== '0' && !this.supported;
    this.terminal.start(data => {
      if (/^\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(data)) {
        if (this.pending) { this.supported = true; this.pending = false; clearTimeout(this.timeout); this.report(); }
        return; // Late replies must not enter the editor or enable reporting.
      }
      if (this.awaitingDeviceAttributes && /^\x1b\[\?[\d;]*c$/.test(data)) {
        this.awaitingDeviceAttributes = false;
        this.pending = false; clearTimeout(this.timeout); return;
      }
      onInput(data);
    }, onResize);
    if (this.pending) {
      this.awaitingDeviceAttributes = true;
      this.timeout = setTimeout(() => { this.pending = false; }, 1000);
      this.timeout.unref();
      this.terminal.write(`${PROGRAM_STATUS_QUERY}\x1b[c`);
    }
    this.report();
  }
  setProgramStatus(status: ProgramStatus): void { this.status = { ...status }; this.report(); }
  private report(): void {
    if (!this.started || !this.supported) return;
    const encoded = formatProgramStatus(this.status);
    if (encoded !== this.encoded) { this.encoded = encoded; this.terminal.write(encoded); }
  }
  stop(): void {
    if (this.started && this.supported) this.terminal.write(formatProgramStatus({ state: 'clear' }));
    this.started = false; this.pending = false; this.awaitingDeviceAttributes = false; this.supported = false; this.encoded = undefined;
    clearTimeout(this.timeout);
    this.terminal.stop();
  }
  get columns() { return this.terminal.columns; }
  get rows() { return this.terminal.rows; }
  get kittyProtocolActive() { return this.terminal.kittyProtocolActive; }
  drainInput(maxMs?: number, idleMs?: number) { return this.terminal.drainInput(maxMs, idleMs); }
  write(data: string) { this.terminal.write(data); }
  moveBy(lines: number) { this.terminal.moveBy(lines); }
  hideCursor() { this.terminal.hideCursor(); }
  showCursor() { this.terminal.showCursor(); }
  clearLine() { this.terminal.clearLine(); }
  clearFromCursor() { this.terminal.clearFromCursor(); }
  clearScreen() { this.terminal.clearScreen(); }
  setTitle(title: string) { this.terminal.setTitle(title); }
  setProgress(active: boolean) { this.terminal.setProgress(active); }
}
