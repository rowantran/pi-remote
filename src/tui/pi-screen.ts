import { copyToClipboard, CustomEditor, getSelectListTheme, keyText, type Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component, type EditorComponent, type EditorTheme, type Focusable, KeybindingsManager, matchesKey, type OverlayHandle,
  ScrollView, setKeybindings, type Terminal, type TUI, TUI_KEYBINDINGS, TuiAltScreen, type TuiAltScreenOptions, truncateToWidth,
  visibleWidth, VStack, type KeybindingDefinitions,
} from '@earendil-works/pi-tui';
import {
  applyDiff, EDITOR_SECTION, encodeBarrier, SECTION_COUNT, sameEditorState,
  type CompanionMessage, type EditorState,
} from '../protocol/companion.js';

/** How the client reaches the remote Pi process. Calls must be delivered in order. */
export interface PiScreenLink {
  send(data: string): void;
  resize(columns: number, rows: number): void;
}

/** Lines that Pi rendered on the remote, shown as one local component. */
class RemoteLines implements Component {
  lines: string[] = [];
  /** Width the remote rendered at. Wider lines are cut until Pi renders at the new width. */
  width = 0;
  private cache?: { width: number; source: string[]; lines: string[] };

  set(lines: string[], width: number): void { this.lines = lines; this.width = width; this.cache = undefined; }

  render(width: number): string[] {
    if (width >= this.width) return this.lines;
    if (this.cache?.width === width && this.cache.source === this.lines) return this.cache.lines;
    const lines = this.lines.map(line => (visibleWidth(line) > width ? truncateToWidth(line, width, '') : line));
    this.cache = { width, source: this.lines, lines };
    return lines;
  }

  invalidate(): void { this.cache = undefined; }
}

/**
 * A key sent to Pi's editor and not yet confirmed. `state` is the local editor state after
 * the key, or undefined when the client did not apply the key locally (Pi decides alone).
 */
interface PendingKey { id: number; data: string; state?: EditorState }

/** Keys that act on Pi's autocomplete dropdown while it is open. */
const DROPDOWN_KEYS = ['tui.select.up', 'tui.select.down', 'tui.select.cancel', 'tui.select.confirm', 'tui.input.tab'] as const;

/** Copy of Pi's fullscreen layout (createChatViewport, Pi 1.0.4 to 1.4.0). */
function chatViewport(sections: Component[], theme?: () => Theme | undefined): { root: Component; transcript: ScrollView } {
  const [document, pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer] = sections;
  const style = (color: 'scrollbarTrack' | 'scrollbarThumb') => (text: string) => theme?.()?.fg(color, text) ?? text;
  const transcript = new ScrollView(document!, {
    follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto',
    scrollbarTrackStyle: style('scrollbarTrack'), scrollbarThumbStyle: style('scrollbarThumb'),
  });
  const dock = new VStack([
    { component: pendingMessages!, shrink: 1, minSize: 0 },
    { component: status!, shrink: 1, minSize: 0 },
    { component: widgetsAbove!, shrink: 1, minSize: 0 },
    { component: editor!, shrink: 1, minSize: 3 },
    { component: widgetsBelow!, shrink: 1, minSize: 0 },
    { component: footer!, shrink: 1, minSize: 0 },
  ]);
  return {
    transcript,
    root: new VStack([
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
    ]),
  };
}

/** The local editor: Pi's CustomEditor, or the editor a local copy of an extension creates. */
type LocalEditor = EditorComponent & Component & Partial<Focusable> & {
  getCursor?(): { line: number; col: number };
  actionHandlers?: Map<string, () => void>;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
};
export type LocalEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

function editorState(editor: LocalEditor): EditorState {
  return { text: editor.getText(), cursor: editor.getCursor?.() ?? { line: 0, col: 0 } };
}

/**
 * Sets the local editor to an exact state. Editor has no public cursor setter;
 * this uses its internal state, which matches the pinned Pi version.
 */
function setEditorState(editor: LocalEditor, state: EditorState): void {
  editor.setText(state.text);
  const internal = (editor as unknown as { state?: { lines: string[]; cursorLine: number; cursorCol: number } }).state;
  if (!internal) return;
  const line = Math.max(0, Math.min(state.cursor.line, internal.lines.length - 1));
  internal.cursorLine = line;
  internal.cursorCol = Math.max(0, Math.min(state.cursor.col, internal.lines[line]?.length ?? 0));
}

/**
 * The editor slot. While Pi's stand-in editor holds the slot and has focus, a local copy
 * of Pi's editor handles keys at once. Otherwise (pickers, dialogs) it shows Pi's lines.
 */
class EditorSlot implements Component, Focusable {
  readonly remote = new RemoteLines();
  private _focused = false;

  constructor(private readonly client: PiScreen) {}

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (this.client.editor) this.client.editor.focused = value;
  }

  render(width: number): string[] {
    const editor = this.client.editor;
    if (!editor || !this.client.editorLocal) return this.remote.render(width);
    const local = editor.render(width);
    // Only use Pi's rows when Pi rendered at this width.
    if (this.remote.width !== width || local.length === 0) return local;
    // Pi draws the working status inside the editor's top border, and the autocomplete
    // dropdown below the bottom border. The text rows between come from the local editor.
    const remote = this.remote.lines;
    const top = remote[0] ?? local[0]!;
    const dropdown = this.client.dropdownRows > 0 ? remote.slice(-this.client.dropdownRows) : [];
    return [top, ...local.slice(1), ...dropdown];
  }

  handleInput(data: string): void { this.client.input(data); }

  invalidate(): void { this.remote.invalidate(); this.client.editor?.invalidate(); }
}

/** Opens and closes the status panel. Free in Pi; terminals without the kitty keyboard protocol send it as Ctrl+-. */
export const STATUS_KEY = 'ctrl+/';

/** Content of the status panel. `sample` runs once a second while the panel is open. */
export interface StatusSource {
  lines(width: number): string[];
  sample?(): Promise<void>;
}

/** A centered, bordered box that shows live lines. Any of Esc, Enter, q, or Ctrl+/ closes it. */
class StatusPanel implements Component, Focusable {
  focused = false;
  constructor(private readonly source: StatusSource, private readonly close: () => void) {}

  render(width: number): string[] {
    const inner = Math.max(10, width - 4);
    const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
    const fit = (text: string) => {
      const cut = visibleWidth(text) > inner ? truncateToWidth(text, inner, '…') : text;
      return `${dim('│')} ${cut}${' '.repeat(Math.max(0, inner - visibleWidth(cut)))} ${dim('│')}`;
    };
    const title = ' pi-remote status ';
    return [
      dim(`┌─${title}${'─'.repeat(Math.max(0, inner - title.length))}─┐`),
      ...this.source.lines(inner).map(fit),
      fit(''),
      fit(dim('Live · Esc, Enter, q, or Ctrl+/ closes')),
      dim(`└${'─'.repeat(inner + 2)}┘`),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, STATUS_KEY) || data === 'q') this.close();
  }

  invalidate(): void {}
}

export interface PiScreenOptions {
  /** Called when the user asks to leave the client (Ctrl+\\). */
  onQuit?: () => void;
  /**
   * Local copy of the editor an extension set on the remote. Without it, an extension
   * editor is shown as Pi renders it, and every key waits for the remote.
   */
  editorFactory?: LocalEditorFactory;
  /** Editor colors from the local copy of the remote's theme. */
  editorTheme?: () => EditorTheme;
  /** Status panel content, opened with Ctrl+/. */
  status?: StatusSource;
  /** Local copy of the remote's theme, for the parts of Pi's fullscreen renderer that run locally. */
  theme?: () => Theme | undefined;
}

/** The options Pi's own fullscreen renderer uses (createInteractiveTui, Pi 1.4.0). */
function rendererOptions(theme: () => Theme | undefined): TuiAltScreenOptions {
  const searchMatch = (text: string) => {
    const t = theme();
    return t ? t.bg('searchMatchBg', t.fg('searchMatchText', text)) : `\x1b[7m${text}\x1b[27m`;
  };
  return {
    searchMatchStyle: text => theme()?.underline(searchMatch(text)) ?? searchMatch(text),
    searchCurrentMatchStyle: text => { const t = theme(); return t ? t.bold(t.inverse(searchMatch(text))) : searchMatch(text); },
    searchNavigationButtonStyle: (text, hovered) => (hovered ? theme()?.underline(text) ?? text : text),
    scrollToEndIndicator: () => {
      const shortcut = keyText('tui.altScreen.bottom');
      const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ''} `;
      const t = theme();
      return t ? t.bg('selectedBg', t.fg('text', label)) : `\x1b[7m${label}\x1b[27m`;
    },
    wheelScrollLines: 'auto',
    copySelection: async text => {
      try { await copyToClipboard(text); return true; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    },
  };
}

/** Local terminal UI that shows a remote Pi's own rendering, with local editing and scrolling. */
export class PiScreen {
  readonly tui: TuiAltScreen;
  editor?: LocalEditor;
  private sections: RemoteLines[] = [];
  private slot: EditorSlot;
  private layout: 'known' | 'unknown' = 'unknown';
  private editorFocused = false;
  /** Autocomplete rows at the end of Pi's editor section; 0 when Pi shows no dropdown. */
  dropdownRows = 0;
  private barrier = 0;
  /** Names this client's barriers, so it can tell its own reports from other clients'. */
  private readonly tag = Math.random().toString(36).slice(2, 10);
  private pending: PendingKey[] = [];
  private keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  private statusPanel?: { handle: OverlayHandle; timer: NodeJS.Timeout };
  private outgoing: string[] = [];
  /** Kind of editor in Pi's slot, from the last editorInstalled message. */
  editorKind?: 'default' | 'extension';
  /** The last facts the companion sent about Pi and its session. */
  session?: Extract<CompanionMessage, { type: 'session' }>;
  readonly traffic = { messages: 0, bytes: 0 };

  constructor(readonly terminal: Terminal, private readonly link: PiScreenLink, private readonly options: PiScreenOptions = {}) {
    setKeybindings(this.keybindings);
    this.tui = new TuiAltScreen(terminal, false, undefined, rendererOptions(() => options.theme?.()));
    this.slot = new EditorSlot(this);
    for (let index = 0; index < SECTION_COUNT; index++) this.sections.push(index === EDITOR_SECTION ? this.slot.remote : new RemoteLines());
    const components: Component[] = this.sections.map((section, index) => (index === EDITOR_SECTION ? this.slot : section));
    for (const component of components) this.tui.addChild(component);
    this.tui.setLayoutRoot(chatViewport(components, () => options.theme?.()).root);
    this.tui.setFocus(this.slot);
  }

  /** Section line counts and the first lines of each, for debugging. */
  debugSections(): { lines: number; head: string[]; all: string[] }[] {
    return this.sections.map(section => ({ lines: section.lines.length, head: section.lines.slice(0, 3), all: section.lines }));
  }

  /** True when keys go to the local editor first. */
  get editorLocal(): boolean { return this.layout === 'known' && this.editorFocused && this.editor !== undefined; }

  start(): void {
    this.tui.start();
    process.stdout.on('resize', this.onResize);
  }

  stop(): void {
    process.stdout.off('resize', this.onResize);
    this.tui.stop();
  }

  /** Unconfirmed editor keys and the layout state, for the status panel. */
  get unconfirmedKeys(): number { return this.pending.length; }
  get layoutKnown(): boolean { return this.layout === 'known'; }

  /** `bytes` is the message's encoded size, when the caller knows it. */
  receive(message: CompanionMessage, bytes = 0): void {
    this.traffic.messages++;
    this.traffic.bytes += bytes;
    switch (message.type) {
      case 'session': this.session = message; break;
      case 'editorInstalled': this.installEditor(message.editor, message.bindings); break;
      case 'frame': this.applyFrame(message); break;
      case 'editor': this.confirm(message.barrier, message.state); break;
      case 'editorChrome': {
        const editor = this.editor;
        if (!editor) break;
        const [before, after] = message.border;
        editor.borderColor = text => `${before}${text}${after}`;
        editor.setPaddingX?.(message.paddingX);
        editor.setAutocompleteMaxVisible?.(message.autocompleteMaxVisible);
        break;
      }
      case 'history': this.editor?.addToHistory?.(message.text); break;
    }
    this.tui.requestRender();
  }

  input(data: string): void {
    if (data === '\x1c') { this.options.onQuit?.(); return; }
    if (this.options.status && matchesKey(data, STATUS_KEY)) { this.toggleStatus(); return; }
    const editor = this.editor;
    if (!editor || !this.editorLocal) { this.send(data); return; }
    // Pi's editor gets the same key; the barrier lets it report the state it reached.
    const id = ++this.barrier;
    this.send(data + encodeBarrier(`${this.tag}:${id}`));
    // While Pi shows its dropdown, these keys act on the dropdown, which only Pi has.
    // Leave the local editor alone and show Pi's result when it arrives.
    if (this.dropdownRows > 0 && DROPDOWN_KEYS.some(binding => this.keybindings.matches(data, binding))) {
      this.pending.push({ id, data });
      return;
    }
    editor.handleInput(data);
    this.pending.push({ id, data, state: editorState(editor) });
    this.tui.requestRender();
  }

  /**
   * Keys that arrive together (a paste, fast typing, a burst from the terminal) go to Pi in
   * one write, so Pi handles them in one pass, as it does in a local terminal. Separate
   * writes let Pi's asynchronous autocomplete apply stale suggestions between keys.
   */
  private send(data: string): void {
    this.outgoing.push(data);
    if (this.outgoing.length === 1) queueMicrotask(() => { const batch = this.outgoing.join(''); this.outgoing = []; this.link.send(batch); });
  }

  toggleStatus(): void {
    const source = this.options.status;
    if (this.statusPanel) {
      clearInterval(this.statusPanel.timer);
      this.statusPanel.handle.hide();
      this.statusPanel = undefined;
      this.tui.requestRender();
      return;
    }
    if (!source) return;
    const panel = new StatusPanel(source, () => this.toggleStatus());
    const handle = this.tui.showOverlay(panel, { anchor: 'center', width: '90%', maxHeight: '90%' });
    const sample = () => { void source.sample?.().catch(() => {}).finally(() => this.tui.requestRender()); };
    const timer = setInterval(sample, 1000);
    timer.unref();
    this.statusPanel = { handle, timer };
    sample();
    this.tui.requestRender();
  }

  private onResize = () => {
    this.link.resize(this.terminal.columns, this.terminal.rows);
  };

  private installEditor(kind: 'default' | 'extension', bindings: Record<string, string | string[] | undefined>): void {
    const definitions: KeybindingDefinitions = {};
    for (const [id, keys] of Object.entries(bindings)) definitions[id] = { defaultKeys: (keys ?? []) as never };
    this.keybindings = new KeybindingsManager(definitions);
    setKeybindings(this.keybindings);
    const theme = this.options.editorTheme?.() ?? { borderColor: (text: string) => text, selectList: getSelectListTheme() };
    let editor: LocalEditor | undefined;
    if (kind === 'default') editor = new CustomEditor(this.tui, theme, this.keybindings as never, { embedWorkingStatus: false });
    else if (this.options.editorFactory) editor = this.options.editorFactory(this.tui, theme, this.keybindings) as LocalEditor;
    if (editor) {
      // Pi runs these actions. Locally they must not change the text; Pi reports any change.
      editor.onSubmit = () => {};
      if (editor.actionHandlers) {
        editor.actionHandlers.clear();
        for (const id of Object.keys(bindings)) if (id.startsWith('app.')) editor.actionHandlers.set(id, () => {});
        editor.onEscape = () => {};
        editor.onCtrlD = () => {};
        editor.onPasteImage = () => {};
      }
      editor.focused = this.slot.focused;
    }
    this.editor = editor;
    this.editorKind = kind;
    this.pending = [];
  }

  private applyFrame(message: Extract<CompanionMessage, { type: 'frame' }>): void {
    this.layout = message.layout;
    if (message.reset) for (const section of this.sections) section.set([], message.width);
    for (const [key, diff] of Object.entries(message.sections)) {
      const section = this.sections[message.layout === 'known' ? Number(key) : 0];
      section?.set(applyDiff(section.lines, diff), message.width);
    }
    // A width change re-renders every section; sections without changes keep their lines.
    for (const section of this.sections) if (section.width !== message.width) section.set(section.lines, message.width);
    const wasLocal = this.editorLocal;
    this.editorFocused = message.editorFocused;
    this.dropdownRows = message.dropdownRows;
    if (this.tui.getShowHardwareCursor() !== message.hardwareCursor) this.tui.setShowHardwareCursor(message.hardwareCursor);
    // Keys typed while a picker had focus went to the picker, not the editor.
    if (wasLocal && !this.editorLocal) this.pending = [];
  }

  /** The remote editor's exact state after a barrier. Confirm the local copy or correct it. */
  private confirm(barrier: string, state: EditorState): void {
    const editor = this.editor;
    if (!editor) return;
    // Another client's barrier says nothing about which of this client's keys Pi has seen.
    const [tag, number] = barrier.split(':');
    const id = tag === this.tag ? Number(number) : 0;
    const head = this.pending.find(key => key.id === id);
    const rest = this.pending.filter(key => key.id > id);
    this.pending = rest;
    if (head?.state && sameEditorState(head.state, state)) return;
    if (!head && rest.length === 0 && sameEditorState(editorState(editor), state)) return;
    // Pi changed the text differently, or on its own. Take Pi's state and replay newer keys.
    // Keys that only Pi applied stay unapplied here; their own confirmation shows the result.
    setEditorState(editor, state);
    for (const key of rest) {
      if (!key.state) continue;
      editor.handleInput(key.data);
      key.state = editorState(editor);
    }
  }
}
