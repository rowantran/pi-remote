import { readAttachment } from './files.js';
import { Transcript } from './transcript.js';
import { ForkSelector } from './fork-selector.js';
import { ScheduledTuiAltScreen } from './scheduled-tui.js';
import { WorkingIndicator } from './working-indicator.js';
import { createRemoteKeybindings } from './keybindings.js';
import { readLocalClipboard, editLocally } from './local-input.js';
import { PresentationHost, readPresentationConfig, createPresentationTheme, type PresentationChange } from './presentation.js';
import { loadLocalTheme, readPiDoubleEscapeAction, readPiHideThinkingBlock, readPiThemeSetting, resolveThemeSelection, terminalAppearance, type DoubleEscapeAction } from './local-theme.js';
import { hostname } from 'node:os';
import { REMOTE_ICON, detachMessage, remoteSessionEnv, stoppedMessage } from './remote-session.js';
import { RemoteAutocompleteProvider, transformPromptWithAttachments } from './editor-completion.js';
import {
  copyToClipboard, CustomEditor, getSelectListTheme, initTheme,
  type SessionInfo, type SessionTreeNode, type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component, Container, Editor, type Focusable, fuzzyFilter, getKeybindings, Input, isKeyRelease, Key,
  matchesKey, ProcessTerminal, ScrollView, SelectList, type SelectItem, setKeybindings, Spacer,
  Text, type Terminal, type TerminalColors, type TerminalColorScheme, TuiAltScreen, truncateToWidth, VStack,
} from '@earendil-works/pi-tui';
import {
  errorText,
  type RecordValue, type RemoteConnection, type RemoteEvent, type Snapshot,
} from './protocol.js';
import {
  DIALOG_METHODS, RemoteView, restoredQueueText, safeText, transcriptMessages,
} from './view.js';

const accent = (text: string) => `\x1b[36m${text}\x1b[39m`;
const muted = (text: string) => `\x1b[2m${text}\x1b[22m`;
const warning = (text: string) => `\x1b[33m${text}\x1b[39m`;
const errorColor = (text: string) => `\x1b[31m${text}\x1b[39m`;
/** Pi's interactive mode waits this long for terminal color replies before it falls back. */
const TERMINAL_COLOR_TIMEOUT_MS = 100;
const HELP = `Local Pi remote UI
Enter: send; while running, queue a steering instruction.
Alt+Enter: queue a follow-up (wait until the run finishes).
Shift+Enter / Ctrl+J: newline. Ctrl+C: clear the prompt. Ctrl+D: detach, even in a dialog.
Esc: cancel the dialog, or clear the prompt queue then abort; queue text returns to the editor.
Esc Esc (empty editor, idle): tree-style fork picker, unless local doubleEscapeAction is none.
/fork /tree: browse user and assistant messages; choose a user prompt to fork into a new session.
Ctrl+O: expand/collapse tool output. Ctrl+T: show/hide thinking.
PageUp/PageDown: transcript scroll. Ctrl+End: follow output. Ctrl+Shift+F: transcript search.
/detach /help /model /new /fork /resume /session /copy /name <name> /compact [instructions]
/quit stops the remote Pi process for this slot, then closes the client.
Connection loss: automatically reattach when enabled; never replay submitted commands.
@remote/path attaches remote text/images. /attach LOCAL_PATH attaches a local file.
Ctrl+V /paste: local clipboard files, image, or text. Ctrl+G /editor: local external editor.
!command runs on the remote host; !!command excludes its output from model context.
/thinking /export [remote path] /reload-ui /theme NAME are local client commands.
Unknown slash commands go to remote Pi (extensions, skills, templates).
Trusted local presentation extensions are opt-in with --ui-extension or --ui-config.
No commands are restarted or replayed after a disconnect.`;

/** Keep the full document on detach; a zero transcript basis applies only to the viewport. */
class DocumentLayout extends VStack {
  override render(width: number): string[] {
    return this.children.flatMap(child => child.render(width));
  }
}

class DynamicLines implements Component {
  constructor(private lines: (width: number) => string[]) {}
  render(width: number): string[] { return this.lines(width).map(line => truncateToWidth(line, width, '')); }
  invalidate(): void {}
}

/** Preserve focus propagation, including when a remote dialog replaces the editor. */
class Dialog extends Container implements Focusable {
  private focus = false;
  constructor(readonly control: Component & Partial<Focusable>, title: string, hint: string,
    private inputHandler?: (data: string) => void) {
    super();
    this.addChild(new Text(accent(safeText(title)), 0, 0));
    this.addChild(control);
    this.addChild(new Text(muted(hint), 0, 0));
  }
  get focused(): boolean { return this.focus; }
  set focused(value: boolean) { this.focus = value; if ('focused' in this.control) this.control.focused = value; }
  handleInput(data: string): void { if (this.inputHandler) this.inputHandler(data); else this.control.handleInput?.(data); }
}

export interface TuiOptions {
  presentationPaths?: string[]; presentationConfig?: string; theme?: string;
  /** Remote host label for the footer, such as the SSH host alias. */
  host?: string;
  /** Minimum interval between normal frame starts; defaults to 8 ms locally. */
  renderIntervalMs?: number;
  /** Start with thinking blocks hidden, like Pi's `hideThinkingBlock` setting. */
  hideThinkingBlock?: boolean;
  /** Local Pi preference; tree falls back to fork because RPC cannot navigate in place. */
  doubleEscapeAction?: DoubleEscapeAction;
}

/** Exported for terminal-adapter tests; uses only the public pi-tui API. */
export class RemoteTui {
  readonly view: RemoteView;
  editor: Editor;
  readonly tui: TuiAltScreen;
  private transcript: Transcript;
  private bottom = new VStack();
  private root: VStack;
  private connected = true;
  private detached = false;
  /** True after /quit stopped the remote Pi process; the client then closed. */
  private quit = false;
  private commandPending = false;
  private interruptPending = false;
  private lastEscapeTime?: number;
  private refreshPromise?: Promise<void>;
  private refreshing = false;
  private refreshAgain = false;
  private journal: RemoteEvent[] = [];
  private generation = 0;
  private activeRemote?: { id: string; component: Dialog };
  private localDialog?: { component: Component & Partial<Focusable>; cancel: () => void; escape?: (data: string) => void };
  private answering = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private finish?: () => void;
  private started = false;
  private appliedEditorId?: string;
  private appliedTitle?: string;
  private bashRunning = false;
  private pendingAttachments: Awaited<ReturnType<typeof readAttachment>>[] = [];
  private editorHistory: string[] = [];
  private completion?: RemoteAutocompleteProvider;
  private metadataTimer?: NodeJS.Timeout;
  private working?: WorkingIndicator;
  private workingMessage?: string;
  private workingOptionsRevision?: number;
  private workingEditor?: Editor & Pick<CustomEditor, 'embedWorkingStatus' | 'setWorkingStatusIndicator'>;
  presentation?: PresentationHost;
  private localTheme: Theme = createPresentationTheme();
  private initialized = false;
  private presentationQueued = false;
  private appliedEditorFactory?: PresentationHost['editorFactory'];
  private metadataPending = new Set<string>();
  private lifecycle = Promise.resolve();
  private localInputPending = false;
  private externalEditorActive = false;
  private terminalColors: TerminalColors = {};
  private terminalColorScheme?: TerminalColorScheme;
  private themeSelection = 'system';
  private reloadQueue = Promise.resolve();

  constructor(private connection: RemoteConnection, private slotId: string, snapshot: Snapshot,
    terminal: Terminal = new ProcessTerminal(), private options: TuiOptions = {}) {
    setKeybindings(createRemoteKeybindings());
    // No session, extensions, providers, or remote resources are loaded locally.
    let initial: string | undefined;
    try { initial = options.theme && resolveThemeSelection(options.theme, terminalAppearance()); } catch { /* Reported by initialize(). */ }
    initTheme(initial, false);
    this.view = new RemoteView(snapshot);
    this.tui = new ScheduledTuiAltScreen(terminal, true, undefined, { renderIntervalMs: options.renderIntervalMs, copySelection: async text => {
      try { await copyToClipboard(text); return true; } catch (error) { return errorText(error); }
    } });
    this.editor = this.makeEditor();
    this.editor.onSubmit = text => { void this.submit(text, 'steer'); };
    this.transcript = new Transcript(this.view, this.tui, () => this.presentation);
    this.transcript.thinking = !options.hideThinkingBlock;
    this.root = new DocumentLayout([
      { component: new ScrollView(this.transcript, { primary: true, follow: 'end', scrollbar: 'auto' }), basis: 0, grow: 1, minSize: 1 },
      { component: this.bottom, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
    this.tui.setLayoutRoot(this.root);
  }

  /** Local module loading only. Remote metadata reads are deliberately not awaited. */
  async initialize(): Promise<void> {
    if (this.initialized || this.detached) return;
    this.initialized = true;
    this.completion = new RemoteAutocompleteProvider({
      getCommands: () => this.rpc({ type: 'get_commands' }),
      completePath: prefix => this.connection.request('complete_path', { slotId: this.slotId, prefix }),
      localCommands: ['attach', 'clear-attachments', 'detach', 'help', 'model', 'new', 'fork', 'tree', 'resume', 'session', 'copy', 'name', 'compact', 'thinking', 'export', 'reload-ui', 'theme', 'tool-call', 'paste', 'editor', 'quit'].map(name => ({ name })),
    });
    this.editor.setAutocompleteProvider(this.completion);
    // Like Pi, learn whether the terminal is light or dark before building themed content.
    this.unsubscribe.push(this.tui.onTerminalColorSchemeChange(scheme => this.terminalColorSchemeChanged(scheme)));
    await this.queryTerminalColors();
    if (this.detached) return;
    try { await this.reloadPresentation(); }
    catch (error) { this.notify(`Local presentation initialization failed: ${errorText(error)}`); }
    if (this.detached) return;
    this.refreshPresentationData();
    this.metadataTimer = setInterval(() => this.refreshPresentationData(), 15_000);
    this.metadataTimer.unref();
  }

  private get appearance(): TerminalColorScheme {
    return terminalAppearance(this.terminalColors, this.terminalColorScheme);
  }

  /** Query OSC 10/11/4 colors. Late replies, such as over slow SSH links, still apply. */
  private async queryTerminalColors(): Promise<void> {
    let colors: TerminalColors = {};
    try {
      colors = await this.tui.queryTerminalColors({ timeoutMs: TERMINAL_COLOR_TIMEOUT_MS, onLateReply: late => this.terminalColorsChanged(late) });
    } catch { /* A terminal that cannot be queried reports no colors. */ }
    this.applyTerminalColors(colors);
  }

  private applyTerminalColors(colors: TerminalColors): void {
    this.terminalColors = {
      foreground: colors.foreground ?? this.terminalColors.foreground,
      background: colors.background ?? this.terminalColors.background,
      palette: colors.palette ?? this.terminalColors.palette,
    };
  }

  private terminalColorsChanged(colors: TerminalColors): void {
    if (this.detached) return;
    const previous = this.appearance;
    this.applyTerminalColors(colors);
    if (this.appearance !== previous) this.reapplyThemeForAppearance();
  }

  /** The terminal switched light/dark (mode 2031). Its colors changed too, so query them again. */
  private terminalColorSchemeChanged(scheme: TerminalColorScheme): void {
    if (this.detached) return;
    const previous = this.appearance;
    this.terminalColorScheme = scheme;
    this.terminalColors = {}; // The old background no longer describes the terminal.
    void this.queryTerminalColors().then(() => {
      if (!this.detached && this.appearance !== previous) this.reapplyThemeForAppearance();
    });
  }

  /** Switch the member of a `light/dark` theme pair. Single themes keep their own colors. */
  private reapplyThemeForAppearance(): void {
    if (!this.themeSelection.includes('/')) return;
    let name: string;
    try { name = resolveThemeSelection(this.themeSelection, this.appearance); } catch { return; }
    if (name === this.localTheme.name) return;
    void this.reloadPresentation().catch(error => this.notify(`Local theme change failed: ${errorText(error)}`));
  }

  /** Serialize reloads: appearance changes can arrive while a command reloads the presentation. */
  private reloadPresentation(): Promise<void> {
    const next = this.reloadQueue.then(() => this.loadPresentation());
    this.reloadQueue = next.catch(() => {});
    return next;
  }

  private async loadPresentation(): Promise<void> {
    if (this.detached) return;
    const config = await readPresentationConfig(this.options.presentationConfig, this.options.presentationPaths);
    const selection = this.options.theme ?? config.theme ?? await readPiThemeSetting() ?? 'system';
    const theme = await loadLocalTheme(selection, undefined, this.appearance);
    if (this.detached) return;
    this.themeSelection = selection;
    // Theme pairs follow live terminal light/dark switches. Without Pi's private terminal-color
    // state, the system theme uses palette indices and default colors, which the terminal adapts itself.
    this.tui.setTerminalColorSchemeNotifications(selection.includes('/'));
    const previous = this.presentation;
    this.presentation = undefined; // Async shutdown must not rebuild rows against a retiring host.
    this.clearWorkingIndicator();
    this.transcript.reset(); // Stop native renderer timers before disabling the old host.
    await previous?.shutdown();
    if (this.detached) return;
    this.localTheme = theme;
    this.appliedEditorFactory = undefined;
    const host = new PresentationHost({
      snapshot: () => this.view.snapshot, tui: this.tui, theme: () => this.localTheme,
      notify: message => this.notify(message), invalidate: scope => this.presentationChanged(scope),
      getEditorText: () => this.editor.getExpandedText(), setEditorText: text => this.editor.setText(text),
      getToolsExpanded: () => this.transcript.expanded,
      setToolsExpanded: expanded => { this.transcript.expanded = expanded; },
      setTitle: title => this.tui.terminal.setTitle(safeText(title).replace(/\n/g, ' ')),
    });
    this.presentation = host;
    await host.load(config.extensions);
    if (this.detached) { await host.shutdown(); return; }
    await host.start();
    // Loading a factory can request a render before its later registrations finish.
    this.transcript.reset();
    if (this.view.snapshot.live.busy) await host.dispatch({ type: 'agent_start' });
    this.installEditor(true);
    this.completion?.invalidateCommands();
    this.presentationChanged();
  }

  private installEditor(force = false): void {
    const factory = this.presentation?.editorFactory;
    if (!force && factory === this.appliedEditorFactory) return;
    const previous = this.editor;
    const text = previous.getExpandedText();
    const next = factory?.(this.tui, { borderColor: text => this.localTheme.fg('borderMuted', text), selectList: getSelectListTheme() }, getKeybindings() as unknown as Parameters<NonNullable<PresentationHost['editorFactory']>>[2]) ?? this.makeEditor();
    // Pi's public editor contract is supported; the selected stable extension subclasses Editor.
    this.editor = next as Editor;
    // Native Pi copies the default thinking border onto factory editors. Editors such as
    // prompt-caret may still restore their own neutral border when they render.
    if (this.editor.borderColor !== undefined) {
      this.editor.borderColor = value => this.localTheme.getThinkingBorderColor(this.view.snapshot.state.thinkingLevel ?? 'off')(value);
    }
    this.editor.setText(text);
    for (const item of this.editorHistory) this.editor.addToHistory(item);
    this.editor.onSubmit = value => { void this.submit(value, 'steer'); };
    if (this.completion) this.editor.setAutocompleteProvider(this.completion);
    this.appliedEditorFactory = factory;
    if (previous !== next) {
      this.workingEditor?.setWorkingStatusIndicator(undefined);
      this.workingEditor = undefined;
      (previous as Editor & { dispose?(): void }).dispose?.();
    }
  }

  private presentationChanged(scope: PresentationChange = 'transcript'): void {
    // Footer/status/widget updates need a frame, not a reset of every historical
    // Markdown block. Remote message changes reconcile through Transcript.changed().
    if (scope === 'transcript') this.transcript.invalidate();
    if (this.presentationQueued || this.detached) return;
    this.presentationQueued = true;
    queueMicrotask(() => {
      this.presentationQueued = false;
      if (this.detached) return;
      this.installEditor(); this.syncBottom();
    });
  }

  private displayEvent(event: RecordValue): void {
    const host = this.presentation;
    if (!host) return;
    host.update(this.view.snapshot);
    this.lifecycle = this.lifecycle.then(() => host.dispatch(event)).catch(error => this.notify(`Presentation event: ${errorText(error)}`));
  }

  /** Separate best-effort reads: an unavailable model catalogue cannot delay branch or usage data. */
  private refreshPresentationData(): void {
    if (!this.initialized || this.detached || !this.connected) return;
    const generation = this.generation;
    const read = (key: string, request: () => Promise<any>, apply: (value: any) => void) => {
      if (this.metadataPending.has(key)) return;
      this.metadataPending.add(key);
      void request().then(value => {
        if (this.detached || generation !== this.generation) return;
        this.view.snapshot.presentation ??= {};
        apply(value); this.presentation?.update(this.view.snapshot);
      }).catch(() => { /* Optional display metadata must never interfere with remote work. */ })
        .finally(() => this.metadataPending.delete(key));
    };
    read('stats', () => this.rpc({ type: 'get_session_stats' }), value => { this.view.snapshot.presentation!.stats = value; });
    if (!this.view.snapshot.presentation?.models?.length) read('models', () => this.rpc({ type: 'get_available_models' }), value => {
      if (Array.isArray(value.models)) this.view.snapshot.presentation!.models = value.models;
    });
    read('filesystem', () => this.connection.request('filesystem_metadata', { slotId: this.slotId }), value => {
      if ('gitBranch' in value) this.view.snapshot.presentation!.gitBranch = value.gitBranch;
      if (typeof value.homeDir === 'string') this.view.snapshot.presentation!.homeDir = value.homeDir;
    });
  }

  private async pasteLocal(): Promise<void> {
    if (this.localInputPending || this.activeRemote || this.localDialog || this.detached) return;
    this.localInputPending = true;
    try {
      const paste = await readLocalClipboard();
      if (this.detached) return;
      if (this.pendingAttachments.length + paste.attachments.length > 8) throw new Error('At most eight pending attachments');
      this.pendingAttachments.push(...paste.attachments);
      if (paste.text) this.editor.setText(this.editor.getExpandedText() + paste.text);
      this.syncBottom();
    } catch (error) { this.notify(`Local paste failed: ${errorText(error)}`); }
    finally { this.localInputPending = false; }
  }

  private async externalEditor(): Promise<void> {
    if (this.localInputPending || this.activeRemote || this.localDialog || this.detached) return;
    this.localInputPending = true; this.externalEditorActive = true;
    const draft = this.editor.getExpandedText();
    this.clearWorkingIndicator();
    this.tui.stop();
    try { const text = await editLocally(draft); if (!this.detached) this.editor.setText(text); }
    catch (error) { this.notify(`Local editor failed: ${errorText(error)}`); }
    finally {
      this.externalEditorActive = false; this.localInputPending = false;
      if (!this.detached) { this.syncBottom(); this.tui.start(); }
    }
  }

  private makeEditor(): Editor {
    return new CustomEditor(this.tui, { borderColor: text => this.localTheme.getThinkingBorderColor(this.view.snapshot.state.thinkingLevel ?? 'off')(text), selectList: getSelectListTheme() },
      getKeybindings() as unknown as ConstructorParameters<typeof CustomEditor>[2], { paddingX: 0, embedWorkingStatus: true });
  }
  private notify(text: string, kind: 'general' | 'connection' = 'general'): void {
    if (this.detached) return;
    this.transcript.notify(text, kind); this.tui.requestRender();
  }
  private rpc<T = RecordValue>(command: RecordValue): Promise<T> {
    if (this.detached || !this.connected || this.view.snapshot.slot.status === 'exited') {
      return Promise.reject(new Error('Disconnected. Nothing was sent. Detach, then run the same CLI attach command again.'));
    }
    return this.connection.request<T>('rpc', { slotId: this.slotId, command });
  }

  run(): Promise<void> {
    if (this.started) return Promise.reject(new Error('This terminal UI has already started'));
    this.started = true;
    return new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      if (this.connection.onReconnect) this.unsubscribe.push(this.connection.onReconnect(snapshot => {
        if (this.detached) return;
        this.connected = true; this.generation++;
        const presentation = this.view.snapshot.presentation;
        const wasBusy = this.view.snapshot.live.busy;
        this.view.replace(snapshot);
        this.view.snapshot.presentation = { ...presentation, ...snapshot.presentation };
        this.reconcileWorkingLifecycle(wasBusy);
        this.metadataPending.clear();
        this.transcript.reset();
        this.transcript.clearConnectionNotices();
        this.displayEvent({ type: 'session_switch', reason: 'reconnect' });
        this.answering.clear();
        this.transcript.invalidate(); this.syncBottom();
        this.notify('Reattached. Remote history restored; no submitted commands were replayed.', 'connection');
        void this.refreshPresentationData();
      }));
      // ReconnectingConnection drains its backlog from onEvent; install snapshot replacement first.
      this.unsubscribe.push(this.connection.onEvent(event => this.onEvent(event)));
      this.unsubscribe.push(this.connection.onDisconnect(error => {
        if (this.detached) return;
        this.connected = false; this.generation++;
        this.lastEscapeTime = undefined;
        this.localDialog?.cancel(); // A local selection must not survive into a different snapshot.
        // Do not resolve remote dialogs, clear the queue, abort, or replay requests.
        this.notify(`Connection lost: ${errorText(error)}. Remote work and dialogs remain active. ${this.connection.onReconnect ? 'Reconnecting automatically.' : 'Run attach again to reconnect.'} No commands will be replayed. Ctrl+D detaches.`, 'connection');
        this.syncBottom();
      }));
      this.unsubscribe.push(this.tui.addInputListener(data => {
        if (isKeyRelease(data)) return undefined;
        if (matchesKey(data, Key.ctrl('d'))) { this.detach(); return { consume: true }; }
        if (matchesKey(data, Key.escape)) {
          const previousEscape = this.lastEscapeTime;
          this.lastEscapeTime = undefined;
          if (this.activeRemote) void this.answerDialog(this.activeRemote.id, { cancelled: true });
          else if (this.localDialog) {
            if (this.localDialog.escape) this.localDialog.escape(data);
            else this.localDialog.cancel();
            this.tui.requestRender();
          }
          else if (this.view.snapshot.live.busy || this.view.snapshot.live.compacting || this.hasQueue() || this.bashRunning || Object.keys(this.view.snapshot.live.bash ?? {}).length) void this.interrupt();
          else if (this.connected && this.view.snapshot.slot.status === 'running' && !this.commandPending && !this.interruptPending
            && !this.editor.getExpandedText().trim() && this.options.doubleEscapeAction !== 'none') {
            const now = Date.now();
            if (previousEscape !== undefined && now - previousEscape < 500) void this.openForkFromShortcut();
            else this.lastEscapeTime = now;
          }
          return { consume: true };
        }
        this.lastEscapeTime = undefined;
        // Local pickers own their shortcuts. Tree filters must not toggle the transcript or model.
        if (this.localDialog && !this.activeRemote) return undefined;
        if (!this.activeRemote && !this.localDialog && matchesKey(data, Key.ctrl('c'))) {
          // Like Pi's app.clear. Pending attachments stay; /clear-attachments removes them.
          this.editor.setText(''); this.tui.requestRender(); return { consume: true };
        }
        if (!this.activeRemote && !this.localDialog && matchesKey(data, Key.alt('enter'))) {
          void this.submit(this.editor.getExpandedText(), 'followUp'); return { consume: true };
        }
        if (matchesKey(data, Key.ctrl('o'))) {
          this.transcript.expanded = !this.transcript.expanded; this.transcript.invalidate(); this.tui.requestRender(); return { consume: true };
        }
        if (matchesKey(data, Key.ctrl('t'))) {
          this.transcript.thinking = !this.transcript.thinking; this.transcript.invalidate(); this.tui.requestRender(); return { consume: true };
        }
        if (!this.activeRemote && !this.localDialog) {
          if (matchesKey(data, Key.ctrl('v'))) { void this.pasteLocal(); return { consume: true }; }
          if (matchesKey(data, Key.ctrl('g'))) { void this.externalEditor(); return { consume: true }; }
          if (matchesKey(data, Key.ctrl('l'))) { void this.builtin('/model', '').catch(error => this.notify(errorText(error))); return { consume: true }; }
          if (matchesKey(data, Key.ctrl('p'))) { void this.rpc({ type: 'cycle_model' }).then(() => this.refresh()).catch(error => this.notify(errorText(error))); return { consume: true }; }
          if (matchesKey(data, Key.shift('tab'))) { void this.rpc({ type: 'cycle_thinking_level' }).then(() => this.refresh()).catch(error => this.notify(errorText(error))); return { consume: true }; }
          if (this.presentation?.hasShortcut(data)) { void this.presentation.shortcut(data); return { consume: true }; }
        }
        return undefined;
      }));
      try {
        this.syncBottom(); this.tui.start();
      } catch (error) {
        this.finish = undefined; this.detach(); reject(error);
      }
    });
  }

  /** True when the client closed because /quit stopped the remote Pi process. */
  get stoppedSlot(): boolean { return this.quit; }

  detach(): void {
    if (this.detached) return;
    this.detached = true; this.generation++;
    clearInterval(this.metadataTimer);
    this.clearWorkingIndicator();
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    // Cancel only a LOCAL picker promise. Never answer a remote dialog on detach.
    this.localDialog?.cancel();
    try { this.tui.stop(); } finally {
      // Stop output before retiring components: remote tools still run after detach.
      this.transcript.reset();
      void this.presentation?.shutdown();
      this.connection.close(); this.finish?.();
    }
  }

  private onEvent(event: RemoteEvent): void {
    if (this.detached || event.slotId !== this.slotId) return;
    const gap = event.seq > this.view.snapshot.seq + 1;
    // Legacy daemons lack remote_bash_end. A completed shell record increases
    // messageCount; refresh its history rather than retaining stale live output.
    const legacyBashFinished = event.event.type === 'remote_state' && !this.refreshing
      && Object.keys(this.view.snapshot.live.bash ?? {}).length > 0
      && event.event.state?.messageCount > (this.view.snapshot.state.messageCount ?? 0);
    if (this.refreshing) this.journal.push(event);
    const wasBusy = this.view.snapshot.live.busy;
    if (!this.view.apply(event)) return;
    this.transcript.changed();
    this.displayEvent(event.event);
    if (event.event.type !== 'agent_start' && event.event.type !== 'agent_settled') this.reconcileWorkingLifecycle(wasBusy);
    if (event.event.type === 'extension_ui_request' && event.event.method === 'notify') this.notify(event.event.message ?? '');
    if (event.event.type === 'extension_error') this.notify(`Extension error: ${event.event.error}`);
    if (event.event.type === 'remote_warning') this.notify(`Remote warning: ${event.event.error ?? event.event.message ?? 'State inspection failed; remote work is preserved.'}`);
    if (event.event.type === 'auto_retry_start') this.notify(`Pi retry ${event.event.attempt}: ${event.event.errorMessage ?? ''}`);
    if (event.event.type === 'remote_slot_exit') this.notify(`Remote Pi exited${event.event.error ? `: ${event.event.error}` : ''}. Ctrl+D detaches.`);
    this.syncBottom();
    if (gap || legacyBashFinished || event.event.type === 'remote_refresh' || event.event.type === 'agent_settled' || event.event.type === 'compaction_end') {
      void this.refresh().catch(error => this.notify(`Snapshot refresh failed: ${errorText(error)}`));
    }
  }

  /** Only read-only snapshots may coalesce; mutating commands are never retried. */
  private refresh(): Promise<void> {
    if (this.detached || !this.connected) return Promise.resolve();
    if (this.refreshPromise) { this.refreshAgain = true; return this.refreshPromise; }
    const generation = this.generation;
    this.journal = []; this.refreshing = true;
    this.refreshPromise = (async () => {
      try {
        const snapshot = await this.connection.request<Snapshot>('snapshot', { slotId: this.slotId });
        if (this.detached || generation !== this.generation) return;
        const presentation = this.view.snapshot.presentation;
        const wasBusy = this.view.snapshot.live.busy;
        this.view.replace(snapshot, this.journal);
        this.view.snapshot.presentation = { ...presentation, ...snapshot.presentation };
        this.reconcileWorkingLifecycle(wasBusy);
        this.presentation?.update(this.view.snapshot);
        this.transcript.invalidate(); this.syncBottom();
        void this.refreshPresentationData();
      } finally {
        this.refreshPromise = undefined; this.refreshing = false; this.journal = [];
        if (this.refreshAgain) {
          this.refreshAgain = false;
          if (generation === this.generation) void this.refresh().catch(error => this.notify(`Snapshot refresh failed: ${errorText(error)}`));
        }
      }
    })();
    return this.refreshPromise;
  }

  private hasQueue(): boolean { const live = this.view.snapshot.live; return !!(live.steering.length || live.followUp.length); }
  private async interrupt(): Promise<void> {
    if (this.interruptPending) return;
    this.interruptPending = true;
    try {
      const queue = await this.rpc({ type: 'clear_queue' });
      if (this.detached) return;
      this.editor.setText(restoredQueueText(queue ?? {}, this.editor.getExpandedText()));
      this.view.snapshot.live.steering = []; this.view.snapshot.live.followUp = [];
      this.syncBottom();
      if (this.bashRunning || Object.keys(this.view.snapshot.live.bash ?? {}).length) await this.rpc({ type: 'abort_bash' });
      await this.rpc({ type: 'abort' });
    } catch (error) { this.notify(`Interrupt failed: ${errorText(error)}. Nothing will be retried automatically.`); }
    finally { this.interruptPending = false; }
  }

  private remoteDialog(record: RecordValue): Dialog {
    const done = (response: RecordValue) => { void this.answerDialog(record.id, response); };
    const cancel = () => done({ cancelled: true });
    if (record.method === 'select' || record.method === 'confirm') {
      const options: string[] = record.method === 'confirm' ? ['Yes', 'No'] : record.options ?? [];
      const list = new SelectList(options.map((label, index) => ({ value: String(index), label: safeText(label) })), 7, getSelectListTheme());
      list.onSelect = item => done(record.method === 'confirm' ? { confirmed: item.value === '0' } : { value: options[Number(item.value)] });
      list.onCancel = cancel;
      return new Dialog(list, [record.title, record.message].filter(Boolean).join('\n'), '↑/↓ choose · Enter submit · Esc cancel · Ctrl+D detach');
    }
    if (record.method === 'editor') {
      const editor = new Editor(this.tui, { borderColor: accent, selectList: getSelectListTheme() }, { paddingX: 0 });
      editor.setText(record.prefill ?? ''); editor.disableSubmit = true;
      return new Dialog(editor, record.title ?? 'Edit text', 'Enter submit · Shift+Enter / Ctrl+J newline · Esc cancel · Ctrl+D detach', data => {
        if (matchesKey(data, Key.enter)) done({ value: editor.getExpandedText() });
        else editor.handleInput(data);
      });
    }
    const input = new Input({ placeholder: safeText(record.placeholder).replace(/\n/g, ' ') });
    input.onSubmit = value => done({ value }); input.onEscape = cancel;
    return new Dialog(input, record.title ?? 'Input', 'Enter submit · Esc cancel · Ctrl+D detach');
  }

  private async answerDialog(id: string, response: RecordValue): Promise<void> {
    if (this.answering.has(id)) return;
    if (!this.connected || this.detached || this.view.snapshot.slot.status === 'exited') {
      this.notify('Dialog preserved. Ctrl+D detaches; run the same CLI attach command again before answering.'); return;
    }
    this.answering.add(id);
    try {
      await this.connection.request('answer', { slotId: this.slotId, response: { id, ...response } });
      if (this.detached) return;
      this.view.snapshot.ui = this.view.snapshot.ui.filter(record => record.id !== id);
      this.syncBottom();
    } catch (error) {
      this.notify(`Dialog response failed: ${errorText(error)}. The response will not be replayed.`);
      // Leave an uncertain response disabled until a fresh attach verifies outstanding dialogs.
      if (this.connected) { this.answering.delete(id); void this.refresh().catch(() => {}); }
    }
  }

  /** Snapshot/slot-exit transitions must also start or stop local extension timers. */
  private reconcileWorkingLifecycle(wasBusy: boolean): void {
    const busy = this.view.snapshot.live.busy;
    if (wasBusy !== busy) this.displayEvent({ type: busy ? 'agent_start' : 'agent_settled' });
  }

  private clearWorkingIndicator(): void {
    this.workingEditor?.setWorkingStatusIndicator(undefined);
    this.workingEditor = undefined;
    this.working?.dispose();
    this.working = undefined; this.workingMessage = undefined; this.workingOptionsRevision = undefined;
  }

  /** Keep one loader across message, widget and editor updates; do not restart every frame. */
  private syncWorkingIndicator(control: Component): void {
    if (!this.view.snapshot.live.busy || this.presentation?.workingVisible === false) {
      this.clearWorkingIndicator(); return;
    }
    this.workingEditor?.setWorkingStatusIndicator(undefined);
    this.workingEditor = control === this.editor && 'embedWorkingStatus' in this.editor
      && this.editor.embedWorkingStatus === true && 'setWorkingStatusIndicator' in this.editor
      && typeof this.editor.setWorkingStatusIndicator === 'function'
      ? this.editor as typeof this.workingEditor : undefined;
    const message = this.presentation?.workingMessage ?? 'Working';
    const options = this.presentation?.workingIndicator;
    const optionsRevision = this.presentation?.workingIndicatorRevision ?? 0;
    const color = (role: 'accent' | 'muted', text: string) => this.workingEditor
      ? this.workingEditor.borderColor(text) : this.localTheme.fg(role, text);
    if (!this.working) {
      this.working = new WorkingIndicator(this.tui, text => color('accent', text), text => color('muted', text), message, options);
    } else {
      if (optionsRevision !== this.workingOptionsRevision) this.working.setIndicator(options);
      if (message !== this.workingMessage) this.working.setMessage(message);
      this.working.invalidate(); // Theme/editor colors may have changed; animation state stays intact.
    }
    this.workingMessage = message; this.workingOptionsRevision = optionsRevision;
    this.workingEditor?.setWorkingStatusIndicator(this.working);
  }

  private syncBottom(): void {
    if (this.detached || this.externalEditorActive) return;
    const ui = this.view.snapshot.ui;
    const editorText = ui.find(record => record.method === 'set_editor_text');
    if (editorText && editorText.id !== this.appliedEditorId) {
      this.editor.setText(editorText.text ?? ''); this.appliedEditorId = editorText.id;
    }
    const title = ui.find(record => record.method === 'setTitle')?.title;
    if (title !== this.appliedTitle && title !== undefined) {
      this.tui.terminal.setTitle(safeText(title).replace(/\n/g, ' ')); this.appliedTitle = title;
    }
    const record = ui.find(record => DIALOG_METHODS.has(record.method));
    if (record?.id !== this.activeRemote?.id) {
      this.activeRemote = record ? { id: record.id, component: this.remoteDialog(record) } : undefined;
    }
    this.bottom.clear();
    const widget = (placement: string) => {
      for (const record of ui) if (record.method === 'setWidget' && (record.widgetPlacement ?? 'aboveEditor') === placement && record.widgetLines?.length && !this.presentation?.widgets.has(record.widgetKey)) {
        this.bottom.addChild(new Text(record.widgetLines.map(safeText).join('\n'), 0, 0));
      }
      for (const local of this.presentation?.widgets.values() ?? []) if (local.placement === placement) this.bottom.addChild(local.component);
    };
    // Pi embeds status in supporting editors, or uses the padded Loader above widgets.
    const control = this.activeRemote?.component ?? this.localDialog?.component ?? this.editor;
    this.syncWorkingIndicator(control);
    this.bottom.addChild(new DynamicLines(width => this.queueLines(width)));
    if (this.working && !this.workingEditor) this.bottom.addChild(this.working);
    this.bottom.addChild(new Spacer(1)); // Native above-editor widget container's leading gap.
    widget('aboveEditor');
    if (this.pendingAttachments.length) this.bottom.addChild(new Text(muted(`Attached: ${this.pendingAttachments.map(file => safeText(file.path)).join(', ')} · /clear-attachments to remove`), 0, 0));
    this.bottom.addChild(control);
    widget('belowEditor');
    if (this.presentation?.footer) {
      if (!this.connected || this.view.snapshot.slot.status !== 'running') this.bottom.addChild(new Text(this.footer(), 0, 0));
      this.bottom.addChild(this.presentation.footer);
    } else this.bottom.addChild(new DynamicLines(() => [this.footer()]));
    this.tui.setFocus(control); this.tui.requestRender();
  }

  private queueLines(width: number): string[] {
    const live = this.view.snapshot.live;
    const queue = [...live.steering.map(text => `Steer: ${safeText(text).replace(/\n/g, ' ↵ ')}`), ...live.followUp.map(text => `Follow-up: ${safeText(text).replace(/\n/g, ' ↵ ')}`)];
    const lines = queue.slice(0, 4).map(text => warning(truncateToWidth(text, width)));
    if (queue.length > 4) lines.push(muted(`… ${queue.length - 4} more queued prompts`));
    return lines;
  }
  private footer(): string {
    const s = this.view.snapshot;
    const status = !this.connected ? 'DISCONNECTED — remote work continues' : s.slot.status === 'exited' ? 'EXITED' : s.slot.status === 'starting' ? 'Starting' : s.live.compacting ? 'Compacting' : s.live.busy ? 'Working' : 'Ready';
    const messages = transcriptMessages(s);
    const assistantIndex = messages.findLastIndex(message => message.role === 'assistant');
    const assistant = messages[assistantIndex];
    // Old provider usage is not the current context estimate after compaction.
    const compactionIndex = messages.findLastIndex(message => message.role === 'compactionSummary');
    const usage = assistantIndex > compactionIndex ? assistant?.usage : undefined;
    const context = usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0) : undefined;
    const window = s.state.model?.contextWindow;
    const cost = messages.reduce((total, message) => total + (message.usage?.cost?.total ?? 0), 0);
    const statuses = s.ui.filter(record => record.method === 'setStatus' && record.statusText).map(record => safeText(record.statusText));
    return muted([status, s.state.sessionName ?? s.slot.sessionName ?? this.slotId,
      this.options.host ? `${REMOTE_ICON} ${this.options.host}` : undefined, s.slot.cwd,
      s.state.model?.id ?? assistant?.model, s.state.thinkingLevel,
      context !== undefined ? `${context.toLocaleString()} tokens${window ? ` / ${Math.round(context / window * 100)}%` : ''}` : undefined,
      cost ? `$${cost.toFixed(3)} (message usage)` : undefined, ...statuses].filter(Boolean).map(value => safeText(value).replace(/\n/g, ' ')).join(' · '));
  }

  private choose(title: string, items: SelectItem[]): Promise<string | undefined> {
    if (!items.length) { this.notify(`No choices available: ${title}`); return Promise.resolve(undefined); }
    return new Promise(resolve => {
      const input = new Input({ placeholder: 'Filter choices…' });
      const safeItems = items.map(item => ({ ...item, label: safeText(item.label), description: safeText(item.description) }));
      let list = new SelectList(safeItems, 7, getSelectListTheme());
      const group = new Container(); group.addChild(input); group.addChild(list);
      // The wrapper owns keyboard input; the Input still receives the focus marker.
      const control: Component & Focusable = {
        get focused() { return input.focused; }, set focused(value: boolean) { input.focused = value; },
        render: width => group.render(width), invalidate: () => group.invalidate(),
      };
      let finished = false;
      const done = (value?: string) => {
        if (finished) return; finished = true; this.localDialog = undefined;
        this.syncBottom(); resolve(value);
      };
      list.onSelect = item => done(item.value); list.onCancel = () => done();
      const component = new Dialog(control, title, 'Type to filter · ↑/↓ choose · Enter select · Esc cancel · Ctrl+D detach', data => {
        if ([Key.up, Key.down, Key.enter, Key.pageUp, Key.pageDown].some(key => matchesKey(data, key))) list.handleInput(data);
        else {
          input.handleInput(data);
          group.removeChild(list);
          // SelectList.setFilter only matches value prefixes, not human-readable labels.
          list = new SelectList(fuzzyFilter(safeItems, input.getValue(), item => `${item.label} ${item.description}`), 7, getSelectListTheme());
          list.onSelect = item => done(item.value); list.onCancel = () => done();
          group.addChild(list);
        }
      });
      this.localDialog = { component, cancel: () => done() }; this.syncBottom();
    });
  }

  private async openForkFromShortcut(): Promise<void> {
    if (this.commandPending) return;
    this.commandPending = true;
    try { await this.builtin('/fork', ''); }
    catch (error) {
      this.notify(`Fork request failed: ${errorText(error)}. Its remote outcome can be unknown after connection loss. Nothing will be replayed; check the session before trying again.`);
    } finally { this.commandPending = false; if (!this.detached) this.syncBottom(); }
  }

  private chooseFork(tree: SessionTreeNode[], leafId: string | null): Promise<string | undefined> {
    const pending = [...tree];
    let hasUser = false;
    while (pending.length) {
      const node = pending.pop()!;
      if (node.entry.type === 'message' && node.entry.message.role === 'user') { hasUser = true; break; }
      pending.push(...node.children);
    }
    if (!hasUser) { this.notify('No user prompts available to fork.'); return Promise.resolve(undefined); }
    return new Promise(resolve => {
      let finished = false;
      const done = (value?: string) => {
        if (finished) return; finished = true; this.localDialog = undefined;
        this.syncBottom(); resolve(value);
      };
      let component: ForkSelector;
      component = new ForkSelector(tree, leafId, () => {
        // Keep excluding this picker after cancellation, including the last frame on detach.
        // Leave space for the transcript and the actual footer/widgets/queue, including adapters.
        const otherRows = this.bottom.children.filter(child => child !== component && child !== this.editor)
          .reduce((rows, child) => rows + child.render(this.tui.terminal.columns).length, 0);
        return this.tui.terminal.rows - otherRows - 1;
      },
        () => this.localTheme, entryId => done(entryId), () => done(), text => {
          if (!text) { this.notify('No text to copy at this point.'); return; }
          void copyToClipboard(text).then(() => this.notify('Selected message copied to the local clipboard.'))
            .catch(error => this.notify(`Copy failed: ${errorText(error)}`));
        });
      this.localDialog = { component, cancel: () => done(), escape: data => component.handleInput(data) }; this.syncBottom();
    });
  }

  private restoreSubmission(text: string): void {
    const draft = this.editor.getExpandedText();
    this.editor.setText(draft === text ? text : [text, draft].filter(Boolean).join('\n\n'));
  }

  private async submit(text: string, streamingBehavior: 'steer' | 'followUp'): Promise<void> {
    if (!text.trim() || this.detached) return;
    const command = text.trim().split(/\s+/, 1)[0];
    const args = text.trim().slice(command.length).trim();
    if (command === '/detach') { this.detach(); return; }
    if (command === '/help') { this.editor.setText(''); this.notify(HELP); return; }
    if (this.commandPending) { this.restoreSubmission(text); this.notify('A local command is still pending. Your text remains in the editor.'); return; }
    this.editor.setText(''); this.editor.addToHistory(text);
    this.editorHistory.push(text); if (this.editorHistory.length > 100) this.editorHistory.shift();
    this.commandPending = true;
    try {
      if (text.startsWith('!')) {
        this.bashRunning = true;
        try {
          await this.rpc({type: 'bash', command: text.slice(text.startsWith('!!') ? 2 : 1), excludeFromContext: text.startsWith('!!')});
          await this.refresh();
        } finally { this.bashRunning = false; }
      } else {
        const handled = await this.builtin(command, args) || (command.startsWith('/') && await this.presentation?.command(command, args));
        if (!handled) {
          const prepared = await transformPromptWithAttachments(text, path => this.connection.request('read_attachment', {slotId: this.slotId, path}));
          const attachments = this.pendingAttachments;
          const localText = attachments.filter(file => file.text !== undefined).map(file => `\n\nAttached local file ${file.path}:\n${file.text}`).join('');
          const images = [...(prepared.images ?? []), ...attachments.flatMap(file => file.image ? [file.image] : [])];
          const prompt = { type: 'prompt', message: prepared.message + localText, ...(images.length ? {images} : {}), streamingBehavior };
          if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > 24 * 1024 * 1024) throw new Error('Combined prompt and attachments exceed 24 MiB; nothing was sent');
          await this.rpc(prompt);
          this.pendingAttachments = [];
        }
      }
    } catch (error) {
      this.notify(`Request failed: ${errorText(error)}. After connection loss, its remote outcome can be unknown. Nothing will be replayed; attach again and check the session before resending.`);
      if (!this.detached) this.restoreSubmission(text);
    } finally { this.commandPending = false; if (!this.detached) this.syncBottom(); }
  }

  private async builtin(command: string, args: string): Promise<boolean> {
    switch (command) {
      case '/paste': await this.pasteLocal(); return true;
      case '/editor': await this.externalEditor(); return true;
      case '/reload-ui': await this.reloadPresentation(); this.notify('Local presentation reloaded. Remote Pi was not changed.'); return true;
      case '/reload': this.notify('Stock Pi RPC cannot reload its remote harness. Use /reload-ui to reload local presentation only; remote Pi is not restarted.'); return true;
      case '/theme': {
        if (!args) this.notify(`Local theme: ${this.localTheme.name ?? 'system'}. Usage: /theme NAME`);
        else { await loadLocalTheme(args, undefined, this.appearance); this.options.theme = args; await this.reloadPresentation(); }
        return true;
      }
      case '/attach': {
        if (!args) this.notify('Usage: /attach LOCAL_PATH (remote files use @path in the prompt)');
        else {
          const file = await readAttachment({path: args.replace(/^"(.*)"$/, '$1'), cwd: process.cwd()});
          if (this.pendingAttachments.length >= 8) throw new Error('At most eight pending attachments');
          this.pendingAttachments.push(file);
          this.notify(`Attached local file: ${file.path}`);
        }
        return true;
      }
      case '/clear-attachments': this.pendingAttachments = []; this.syncBottom(); return true;
      case '/thinking': {
        const data = await this.rpc({type:'get_available_thinking_levels'});
        const level = args || await this.choose('Thinking level', (data.levels ?? []).map((value:string) => ({value,label:value})));
        if (level !== undefined) { await this.rpc({type:'set_thinking_level',level}); await this.refresh(); }
        return true;
      }
      case '/export': {
        const result = await this.rpc({type:'export_html', ...(args ? {outputPath:args} : {})});
        this.notify(`Exported on the remote host: ${result.path}`); return true;
      }
      case '/login': case '/settings': this.notify('Configure the remote harness with normal Pi over SSH. The local client does not change provider credentials or remote settings directly.'); return true;
      case '/model': {
        const data = await this.rpc({ type: 'get_available_models' });
        const models: RecordValue[] = data.models ?? [];
        const selected = await this.choose('Choose model', models.map((model, index) => ({ value: String(index), label: `${model.provider}/${model.id}`, description: model.name })));
        if (selected !== undefined && !this.detached) {
          const model = models[Number(selected)];
          await this.rpc({ type: 'set_model', provider: model.provider, modelId: model.id }); await this.refresh();
        }
        return true;
      }
      case '/new': {
        const data = await this.rpc({ type: 'new_session' });
        if (data?.cancelled) this.notify('New session cancelled.'); else await this.refresh(); return true;
      }
      case '/tree': // Explicit fork fallback, not in-place session-tree navigation.
      case '/fork': {
        const generation = this.generation;
        const sessionId = this.view.snapshot.state.sessionId;
        const data = await this.rpc<{ tree: SessionTreeNode[]; leafId: string | null }>({ type: 'get_tree' });
        if (this.detached || !this.connected || generation !== this.generation || sessionId !== this.view.snapshot.state.sessionId) return true;
        const entryId = await this.chooseFork(data.tree ?? [], data.leafId ?? null);
        if (entryId !== undefined && !this.detached && this.connected && generation === this.generation) {
          if (sessionId !== this.view.snapshot.state.sessionId) { this.notify('Session changed while the picker was open. Open /fork again; nothing was sent.'); return true; }
          const result = await this.rpc({ type: 'fork', entryId });
          if (result?.cancelled) this.notify('Fork cancelled.');
          else { await this.refresh(); if (!this.detached) this.editor.setText(result?.text ?? ''); }
        }
        return true;
      }
      case '/resume': {
        if (!this.connected || this.detached) throw new Error('Reconnect before listing sessions');
        const sessions = await this.connection.request<SessionInfo[]>('sessions', { slotId: this.slotId });
        const sessionPath = await this.choose('Resume a remote session', sessions.map(session => ({ value: session.path, label: session.name ?? session.firstMessage ?? session.id, description: `${session.messageCount} messages · ${session.path}` })));
        if (sessionPath !== undefined && !this.detached) {
          const data = await this.rpc({ type: 'switch_session', sessionPath });
          if (data?.cancelled) this.notify('Session switch cancelled.'); else await this.refresh();
        }
        return true;
      }
      case '/quit': await this.quitSlot(); return true;
      case '/session': this.notify(JSON.stringify(await this.rpc({ type: 'get_session_stats' }), null, 2)); return true;
      case '/copy': {
        const result = await this.rpc({ type: 'get_last_assistant_text' });
        if (!result?.text) this.notify('No assistant text to copy.');
        else if (!this.detached) { await copyToClipboard(result.text); this.notify('Assistant text copied to the local clipboard.'); }
        return true;
      }
      case '/name':
        if (!args) this.notify('Usage: /name <session name>');
        else { await this.rpc({ type: 'set_session_name', name: args }); await this.refresh(); } return true;
      case '/compact':
        await this.rpc({ type: 'compact', ...(args ? { customInstructions: args } : {}) }); await this.refresh(); return true;
      default: return false;
    }
  }

  /** Stop the remote Pi process with the daemon's explicit kill, then close the client. */
  private async quitSlot(): Promise<void> {
    const live = this.view.snapshot.live;
    if (this.view.snapshot.slot.status !== 'exited') {
      if (!this.connected) throw new Error('Disconnected. The remote Pi process was not stopped. Reconnect, then run /quit again');
      const working = live.busy || live.compacting || this.hasQueue() || this.bashRunning || Object.keys(live.bash ?? {}).length > 0;
      if (working) {
        const choice = await this.choose('Stop the remote Pi process? Running work and queued prompts will be lost.', [
          { value: 'cancel', label: 'Cancel' }, { value: 'stop', label: 'Stop remote Pi' },
        ]);
        if (choice !== 'stop' || this.detached) { if (!this.detached) this.notify('Quit cancelled. Remote Pi is still running.'); return; }
      }
      await this.connection.request('kill', { slotId: this.slotId });
    }
    this.quit = true;
    this.detach();
  }
}

/** Attach is the caller's responsibility. Closing this UI only closes the local transport. */
export async function runTui(connection: RemoteConnection, slotId: string, initialSnapshot: Snapshot, options: TuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The remote terminal UI requires a terminal for stdin and stdout.');
  const host = options.host ?? hostname();
  // Presentation extensions run in this process. They read the same pi-remote session
  // variables that the daemon gives the remote Pi process.
  Object.assign(process.env, remoteSessionEnv({ host, slotId, slotNumber: initialSnapshot.slot.number }));
  const hideThinkingBlock = options.hideThinkingBlock ?? await readPiHideThinkingBlock();
  const doubleEscapeAction = options.doubleEscapeAction ?? await readPiDoubleEscapeAction();
  const client = new RemoteTui(connection, slotId, initialSnapshot, new ProcessTerminal(), { ...options, host, hideThinkingBlock, doubleEscapeAction });
  // Start input and outstanding startup dialogs before any trusted extension factory can await.
  const finished = client.run();
  void client.initialize();
  await finished;
  const slot = client.view.snapshot.slot;
  const number = slot.number ?? initialSnapshot.slot.number;
  process.stdout.write(`${client.stoppedSlot ? stoppedMessage(slotId, number) : detachMessage(slotId, number)}\n`);
}
