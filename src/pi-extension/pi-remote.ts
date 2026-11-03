/**
 * pi-remote's Pi extension, which pi-remote loads into each slot's Pi process.
 *
 * It does not change what Pi does. It reports what Pi draws, section by section, and
 * puts a stand-in editor in Pi's editor slot so that the client can edit text locally:
 *
 * - Frames: wraps render() on each of the interactive layout's root children and sends
 *   the lines that changed after each render pass.
 * - Stand-in editor: a normal CustomEditor. The client sends every editor key through
 *   the PTY, so this editor processes the same keys as the client's local copy. After
 *   each input barrier it reports its exact state, so the client can confirm or correct.
 *
 * Pi starts its extensions again on /reload and on session changes (/new, /resume, /fork),
 * in the same process. The host accepts one connection per Pi process, so every start of
 * this extension shares one connection, and the newest start takes over the reporting.
 */
import { CustomEditor, VERSION, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext, type KeybindingsManager } from '@earendil-works/pi-coding-agent';
import type { Component, EditorComponent, EditorTheme, TUI } from '@earendil-works/pi-tui';
import { createConnection, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { appendFileSync } from 'node:fs';
import {
  decodeBarrier, decodeSetText, diffLines, EDITOR_SECTION, PI_EXTENSION_SOCKET_ENV, SECTION_COUNT, sameEditorState,
  type PiExtensionMessage, type ControlMessage, type EditorState, type LineDiff,
} from '../protocol/pi-extension.js';
import { PI_REMOTE_API_EVENT, type PiRemoteApi } from '../protocol/extension-api.js';

class Channel {
  private socket: Socket;
  private connected = false;
  private failed = false;
  private queue: string[] = [];

  constructor(path: string, onControl: (message: ControlMessage) => void) {
    this.socket = createConnection(path);
    // Control messages from the host, one JSON object per line.
    let buffered = '';
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try { onControl(JSON.parse(line) as ControlMessage); } catch { /* Ignore a malformed message. */ }
      }
    });
    this.socket.on('connect', () => {
      this.connected = true;
      for (const line of this.queue) this.socket.write(line);
      this.queue = [];
    });
    // Pi's stderr goes to an undisplayed PTY. Stop sending; Pi keeps working normally.
    this.socket.on('error', () => { this.failed = true; this.queue = []; });
    this.socket.on('close', () => { this.failed = true; });
    this.socket.unref();
  }

  /** False when the connection has failed and the message was dropped. */
  send(message: PiExtensionMessage): boolean {
    if (this.failed) return false;
    const line = `${JSON.stringify(message)}\n`;
    if (this.connected) this.socket.write(line);
    else this.queue.push(line);
    return true;
  }
}

type Container = Component & { children?: Component[] };
/** Editor methods beyond Pi's EditorComponent interface. Pi's Editor and CustomEditor have them. */
type ObservedEditor = EditorComponent & {
  getCursor?(): { line: number; col: number };
  getPaddingX?(): number;
  getAutocompleteMaxVisible?(): number;
  isShowingAutocomplete?(): boolean;
};

/** Autocomplete rows the editor drew below its bottom border in its last render. */
function dropdownRows(editor: ObservedEditor): number {
  if (!editor.isShowingAutocomplete?.()) return 0;
  // Pi's Editor records this height in a private field when it renders.
  const height = (editor as { renderedAutocompleteHeight?: unknown }).renderedAutocompleteHeight;
  return typeof height === 'number' ? height : 0;
}
class Bridge {
  /** Set when a newer load of this module took over; then this bridge sends nothing. */
  private disposed = false;
  /** Root children whose render() this bridge wraps. */
  private wrapped = new WeakSet<Component>();
  private tui?: TUI;
  private editor?: ObservedEditor;
  private editorContainer?: Container;
  private latest = new Map<Component, string[]>();
  private sent: (string[] | undefined)[] = [];
  /** The next frame starts from empty sections. */
  private reset = true;
  private sentLayout?: 'known' | 'unknown';
  private sentEditorFocused?: boolean;
  private sentDropdownRows = 0;
  private sentHardwareCursor?: boolean;
  private width = 0;
  private sentWidth = 0;
  private flushQueued = false;
  private lastBarrier = '';
  /** True when the last input from the client was a barrier, so the editor state has a precise position. */
  private quiescent = true;
  private reported?: EditorState;
  private chrome = '';

  constructor(readonly channel: Channel) {}

  /** Stop reporting. The render() wrappers stay on Pi's components but only pass through. */
  dispose(): void {
    this.disposed = true;
    this.tui = undefined;
    this.editor = undefined;
    this.editorContainer = undefined;
    this.latest.clear();
  }

  /** True when this bridge observes the editor that Pi has in its editor slot. */
  hasInstalledEditor(): boolean {
    const editor = this.editor;
    return editor !== undefined && (this.tui?.children ?? []).some(child => (child as Container).children?.includes(editor));
  }

  attach(tui: TUI, editor: EditorComponent, keybindings: KeybindingsManager, kind: 'default' | 'extension', theme?: string): void {
    if (this.disposed) return;
    this.tui = tui;
    this.editor = editor;
    this.editorContainer = undefined;
    this.sent = [];
    this.reset = true;
    this.sentLayout = undefined;
    this.reported = undefined;
    this.chrome = '';
    this.channel.send({ type: 'editorInstalled', editor: kind, bindings: keybindings.getResolvedBindings(), theme });
    this.wrapChildren();
    // Pi mounts its layout before extensions start; retry briefly in case it has not.
    let attempts = 0;
    const retry = () => {
      if (this.tui !== tui || attempts++ > 20) return;
      if (this.wrapChildren()) tui.requestRender(true);
      else setTimeout(retry, 50).unref();
    };
    retry();
  }

  /** Called by Pi for each terminal input sequence, before the focused component. */
  input(data: string): { consume: true } | undefined {
    if (this.disposed) return undefined;
    // Development aid: PI_REMOTE_EXTENSION_DEBUG=FILE logs each input with the editor text before it.
    if (process.env.PI_REMOTE_EXTENSION_DEBUG) appendFileSync(process.env.PI_REMOTE_EXTENSION_DEBUG, `${JSON.stringify({ input: data, text: this.editor?.getText() })}\n`);
    const text = decodeSetText(data);
    if (text !== undefined) {
      this.editor?.setText(text);
      this.quiescent = false;
      return { consume: true };
    }
    const barrier = decodeBarrier(data);
    if (barrier === undefined) { this.quiescent = false; return undefined; }
    // The keys before this barrier were handled synchronously; report the state they produced.
    this.lastBarrier = barrier;
    this.quiescent = true;
    this.reportEditor(true);
    return { consume: true };
  }

  history(text: string): void { if (!this.disposed) this.channel.send({ type: 'history', text }); }

  private wrapChildren(): boolean {
    const tui = this.tui;
    if (!tui || tui.children.length === 0) return false;
    for (const child of tui.children) {
      if (this.wrapped.has(child)) continue;
      const render = child.render.bind(child);
      this.wrapped.add(child);
      child.render = (width: number) => {
        const lines = render(width);
        if (this.disposed) return lines;
        this.latest.set(child, lines);
        this.width = width;
        this.scheduleFlush();
        return lines;
      };
    }
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    // Container.render calls every root child synchronously; flush once the pass ends.
    queueMicrotask(() => { this.flushQueued = false; this.flush(); });
  }

  private findEditorContainer(children: readonly Component[]): Container | undefined {
    if (this.editorContainer && children.includes(this.editorContainer)) return this.editorContainer;
    const found = children.find(child => (child as Container).children?.includes(this.editor!)) as Container | undefined;
    this.editorContainer = found;
    return found;
  }

  private flush(): void {
    const tui = this.tui;
    const editor = this.editor;
    if (!tui || !editor) return;
    this.wrapChildren();
    const children = tui.children;
    const editorContainer = this.findEditorContainer(children);
    const known = children.length === SECTION_COUNT && editorContainer !== undefined && children[EDITOR_SECTION] === editorContainer;
    const layout = known ? 'known' : 'unknown';
    const focused = (tui as TUI & { getFocusedComponent?(): Component | null }).getFocusedComponent?.();
    const editorFocused = known && editorContainer!.children?.[0] === editor && focused === editor;
    const dropdown = editorFocused ? dropdownRows(editor) : 0;
    const hardwareCursor = tui.getShowHardwareCursor();

    const sections: Record<number, LineDiff> = {};
    if (layout !== this.sentLayout) { this.sent = []; this.reset = true; }
    let changed = this.reset || editorFocused !== this.sentEditorFocused || dropdown !== this.sentDropdownRows || hardwareCursor !== this.sentHardwareCursor || this.width !== this.sentWidth;
    if (known) {
      children.forEach((child, index) => {
        const lines = this.latest.get(child) ?? [];
        const diff = diffLines(this.sent[index] ?? [], lines);
        if (!diff) return;
        sections[index] = diff;
        this.sent[index] = lines;
        changed = true;
      });
    } else {
      const lines = children.flatMap(child => this.latest.get(child) ?? []);
      const diff = diffLines(this.sent[0] ?? [], lines);
      if (diff) { sections[0] = diff; this.sent[0] = lines; changed = true; }
    }
    if (changed) {
      this.channel.send({ type: 'frame', width: this.width, layout, reset: this.reset, sections, editorFocused, dropdownRows: dropdown, hardwareCursor });
      this.sentDropdownRows = dropdown;
      this.sentHardwareCursor = hardwareCursor;
      this.reset = false;
      this.sentLayout = layout;
      this.sentEditorFocused = editorFocused;
      this.sentWidth = this.width;
    }
    this.reportChrome(editor);
    // Pi can change the editor itself (clearing after submit, restoring queued messages).
    if (this.quiescent) this.reportEditor(false);
  }

  private reportChrome(editor: ObservedEditor): void {
    const [before, after] = (editor.borderColor?.('\u0000') ?? '\u0000').split('\u0000');
    const message: PiExtensionMessage = {
      type: 'editorChrome', border: [before ?? '', after ?? ''],
      paddingX: editor.getPaddingX?.() ?? 0, autocompleteMaxVisible: editor.getAutocompleteMaxVisible?.() ?? 5,
    };
    const key = JSON.stringify(message);
    if (key === this.chrome) return;
    this.chrome = key;
    this.channel.send(message);
  }

  private reportEditor(force: boolean): void {
    const editor = this.editor;
    if (!editor) return;
    const state: EditorState = { text: editor.getText(), cursor: editor.getCursor?.() ?? { line: 0, col: 0 } };
    if (!force && this.reported && sameEditorState(state, this.reported)) return;
    this.reported = state;
    this.channel.send({ type: 'editor', barrier: this.lastBarrier, state });
  }
}

type EditorFactory = NonNullable<Parameters<ExtensionUIContext['setEditorComponent']>[0]>;

/** What every load of this module in one Pi process shares. */
interface Shared {
  channel: Channel;
  /** The bridge of the newest load. */
  bridge?: Bridge;
  /** Handles the host's control messages; set by the newest load. */
  onControl?: (message: ControlMessage) => void;
}
// Symbol.for: a reloaded copy of this module must find the same values.
const SHARED = Symbol.for('pi-remote.extension');
const EDITOR_PATCH = Symbol.for('pi-remote.editor-patch');

function shared(socketPath: string): Shared {
  const global = globalThis as { [SHARED]?: Shared };
  const existing = global[SHARED];
  if (existing) return existing;
  const created: Shared = { channel: new Channel(socketPath, message => created.onControl?.(message)) };
  global[SHARED] = created;
  return created;
}

/** Pi's own setEditorComponent, and the factory another extension set last. */
interface EditorPatch { setEditorComponent: ExtensionUIContext['setEditorComponent']; foreign?: EditorFactory }

/**
 * Puts an editor that the Pi extension can observe in Pi's editor slot. Other extensions may
 * set their own editor; the Pi extension wraps their factory instead of replacing it, so their
 * editor stays in use. Pi passes one UI object to every extension in a session, and keeps it
 * across /reload. The patch is made once per UI object and reports to the newest bridge.
 */
function installEditor(ui: ExtensionUIContext & { [EDITOR_PATCH]?: EditorPatch }, state: Shared): void {
  const wrap = (factory: EditorFactory | undefined): EditorFactory => (tui, theme, keybindings) => {
    const editor = factory
      ? factory(tui, theme, keybindings)
      // Match Pi's default editor, which shows the working status in its top border.
      : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
    const addToHistory = editor.addToHistory?.bind(editor);
    if (addToHistory) editor.addToHistory = (text: string) => { addToHistory(text); state.bridge?.history(text); };
    state.bridge?.attach(tui, editor, keybindings, factory ? 'extension' : 'default', ui.theme.name);
    return editor;
  };
  let patch = ui[EDITOR_PATCH];
  if (!patch) {
    const created: EditorPatch = { setEditorComponent: ui.setEditorComponent.bind(ui) };
    ui[EDITOR_PATCH] = patch = created;
    ui.setEditorComponent = factory => { created.foreign = factory; created.setEditorComponent(wrap(factory)); };
    ui.getEditorComponent = () => created.foreign;
  }
  // On /reload and session changes, Pi puts its default editor back without calling
  // setEditorComponent. Another extension may already have set its editor in this round.
  if (state.bridge?.hasInstalledEditor()) return;
  patch.foreign = undefined;
  patch.setEditorComponent(wrap(undefined));
}

function sessionMessage(ctx: ExtensionContext): PiExtensionMessage {
  const sessions = ctx.sessionManager;
  const env = process.env;
  return {
    type: 'session', hostname: hostname(), pid: process.pid, piVersion: VERSION, cwd: ctx.cwd,
    sessionId: sessions.getSessionId(), sessionFile: sessions.getSessionFile(), sessionName: sessions.getSessionName(),
    entryCount: sessions.getEntries().length,
    remote: env.PI_REMOTE_SESSION === '1' ? { host: env.PI_REMOTE_SESSION_HOST, slotId: env.PI_REMOTE_SESSION_SLOT } : undefined,
  };
}

type ActivityEvent = Extract<PiExtensionMessage, { type: 'activity' }>['event'];

/** Only what notifications need from a message: never text, thinking, or tool arguments. */
function redactedMessage(message: any): Record<string, unknown> | undefined {
  if (!message || typeof message.role !== 'string') return undefined;
  if (message.role === 'assistant') {
    return {
      role: 'assistant', stopReason: message.stopReason,
      content: Array.isArray(message.content) ? message.content.filter((block: any) => block?.type === 'toolCall')
        .map((block: any) => ({ type: 'toolCall', name: block.name, id: block.id })) : [],
    };
  }
  if (message.role === 'toolResult') return { role: 'toolResult', toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError };
  return { role: message.role };
}

/** Pi lifecycle events for the daemon, in the shape of Pi's RPC events. */
function reportActivity(pi: ExtensionAPI, send: (event: ActivityEvent) => void): void {
  pi.on('agent_start', () => { send({ type: 'agent_start' }); });
  pi.on('agent_end', event => {
    const last = redactedMessage(event.messages.findLast((message: any) => message?.role === 'assistant'));
    send({ type: 'agent_end', messages: last ? [last] : [] });
  });
  pi.on('agent_settled', event => { send({ type: 'agent_settled', aborted: event.aborted }); });
  pi.on('message_end', event => { const message = redactedMessage(event.message); if (message) send({ type: 'message_end', message }); });
  pi.on('session_before_compact', event => {
    send({ type: 'compaction_start', reason: event.reason === 'threshold' ? 'automatic' : event.reason });
    return undefined;
  });
  pi.on('session_compact', () => { send({ type: 'compaction_end', aborted: false }); });
  pi.on('session_compact_failed', event => { send({ type: 'compaction_end', aborted: event.aborted, errorMessage: event.errorMessage }); });
  // Pi reports only the outermost extension dialog; one ID at a time is enough.
  let dialog = 0;
  pi.on('ui_prompt_start', event => { send({ type: 'extension_ui_request', id: `dialog-${++dialog}`, method: event.kind, title: event.title }); });
  pi.on('ui_prompt_end', () => { send({ type: 'remote_dialog_resolved', id: `dialog-${dialog}` }); });
}

type ApiResult = Extract<ControlMessage, { type: 'apiResult' }>;
type ApiRequest = Extract<PiExtensionMessage, { type: 'createChildSlot' | 'openSlot' }>;
type Request = ApiRequest extends infer R ? R extends ApiRequest ? Omit<R, 'id'> : never : never;
/** Longer than the host's own limits (a Pi version check, or a client opening a pane). */
const API_TIMEOUT_MS = 60_000;

/**
 * Offer PiRemoteApi (src/protocol/extension-api.ts) to the other extensions in this Pi.
 * Returns the handler for the host's answers.
 */
function offerApi(pi: ExtensionAPI, channel: Channel): (message: ApiResult) => void {
  const pending = new Map<string, (result: ApiResult) => void>();
  let nextId = 0;
  const call = (request: Request) => new Promise<ApiResult>((resolve, reject) => {
    const id = `api-${++nextId}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      // The host may still act on the request; callers must not retry it blindly.
      reject(new Error('pi-remote did not answer in time. Check pi-remote ls before trying again.'));
    }, API_TIMEOUT_MS);
    pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
    if (!channel.send({ ...request, id } as ApiRequest)) { clearTimeout(timer); pending.delete(id); reject(new Error('pi-remote is not connected')); }
  });
  const number = Number(process.env.PI_REMOTE_SESSION_SLOT_NUMBER);
  const api: PiRemoteApi = Object.freeze({
    version: 1 as const,
    slotId: process.env.PI_REMOTE_SESSION_SLOT ?? '',
    ...(Number.isSafeInteger(number) && number > 0 ? { slotNumber: number } : {}),
    async createChildSlot(options: Parameters<PiRemoteApi['createChildSlot']>[0]) {
      const result = await call({ type: 'createChildSlot', sessionFile: options.sessionFile,
        ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}), ...(options.prompt !== undefined ? { prompt: options.prompt } : {}) });
      if (!result.slotId) throw new Error(result.error ?? 'pi-remote did not start a slot');
      return { slotId: result.slotId, ...(result.slotNumber !== undefined ? { slotNumber: result.slotNumber } : {}), ...(result.error ? { error: result.error } : {}) };
    },
    async openSlot(options: Parameters<PiRemoteApi['openSlot']>[0]) {
      const result = await call({ type: 'openSlot', slotId: options.slotId });
      if (result.error) throw new Error(result.error);
    },
  });
  pi.events.on(PI_REMOTE_API_EVENT, data => {
    const respond = (data as { respond?: unknown } | undefined)?.respond;
    if (typeof respond === 'function') respond(api);
  });
  return message => pending.get(message.id)?.(message);
}

export default function piRemoteExtension(pi: ExtensionAPI): void {
  const socketPath = process.env[PI_EXTENSION_SOCKET_ENV];
  if (!socketPath) return;
  let apiResult: (message: ApiResult) => void = () => {};
  const state = shared(socketPath);
  // This load replaces any earlier one in this Pi process (/reload, /new, /resume, /fork).
  state.bridge?.dispose();
  const bridge = new Bridge(state.channel);
  state.bridge = bridge;
  state.onControl = message => {
    if (message.type === 'prompt') { try { pi.sendUserMessage(message.text); } catch { /* Reported through activity and the screen. */ } }
    else if (message.type === 'apiResult') apiResult(message);
  };
  apiResult = offerApi(pi, bridge.channel);
  reportActivity(pi, event => bridge.channel.send({ type: 'activity', event }));
  // pi-remote commands. They act in the client that ran them.
  pi.registerCommand('detach', {
    description: 'Close this pi-remote client; Pi keeps running (pi-remote)',
    handler: async () => { bridge.channel.send({ type: 'clientAction', action: 'detach' }); },
  });
  pi.registerCommand('status', {
    description: 'Show the pi-remote connection status (pi-remote)',
    handler: async () => { bridge.channel.send({ type: 'clientAction', action: 'status' }); },
  });
  let unsubscribeInput: (() => void) | undefined;
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    unsubscribeInput?.();
    unsubscribeInput = ctx.ui.onTerminalInput(data => bridge.input(data));
    installEditor(ctx.ui, state);
    bridge.channel.send(sessionMessage(ctx));
  });
  pi.on('session_info_changed', (_event, ctx) => { bridge.channel.send(sessionMessage(ctx)); });
  // Keep the entry count current for reload and daemon-restart safety checks.
  pi.on('agent_settled', (_event, ctx) => { bridge.channel.send(sessionMessage(ctx)); });
}
