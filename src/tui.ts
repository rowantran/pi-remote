import {
  copyToClipboard, getMarkdownTheme, getSelectListTheme, initTheme,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import {
  type Component, Container, Editor, type Focusable, fuzzyFilter, Input, isKeyRelease, Key,
  Markdown, matchesKey, ProcessTerminal, ScrollView, SelectList, type SelectItem,
  Text, type Terminal, TuiAltScreen, truncateToWidth, VStack, wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
  errorText,
  type RecordValue, type RemoteConnection, type RemoteEvent, type Snapshot,
} from './protocol.js';
import {
  DIALOG_METHODS, RemoteView, restoredQueueText, safeText, toolText, transcriptMessages,
} from './view.js';

const accent = (text: string) => `\x1b[36m${text}\x1b[39m`;
const muted = (text: string) => `\x1b[2m${text}\x1b[22m`;
const warning = (text: string) => `\x1b[33m${text}\x1b[39m`;
const errorColor = (text: string) => `\x1b[31m${text}\x1b[39m`;
const HELP = `Local Pi remote UI
Enter: send; while running, queue a steering instruction.
Alt+Enter: queue a follow-up (wait until the run finishes).
Shift+Enter / Ctrl+J: newline. Ctrl+D: detach, even in a dialog.
Esc: cancel the dialog, or clear the prompt queue then abort; queue text returns to the editor.
Ctrl+O: expand/collapse tool output. Ctrl+T: show/hide thinking.
PageUp/PageDown: transcript scroll. Ctrl+End: follow output. Ctrl+Shift+F: transcript search.
/detach /help /model /new /fork /resume /session /copy /name <name> /compact [instructions]
After connection loss: Ctrl+D, then run the same CLI attach command again.
Unknown slash commands go to remote Pi (extensions, skills, templates).
Display-only local extension loading and custom renderers are a later milestone.
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

class MessageDisplay implements Component {
  private children: Component[] = [];
  constructor(message: RecordValue, expanded: boolean, thinking: boolean) {
    const text = (value: unknown, color = (s: string) => s) => this.children.push(new Text(color(safeText(value)), 0, 0));
    const markdown = (value: unknown) => this.children.push(new Markdown(safeText(value), 0, 0, getMarkdownTheme()));
    switch (message.role) {
      case 'system': return;
      case 'custom': if (message.display === false) return;
        text(`[${message.customType ?? 'extension'}]`, accent); markdown(contentText(message.content)); break;
      case 'user': text('You', accent); text(contentText(message.content)); break;
      case 'assistant':
        text('Pi', accent);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!block) continue;
          if (block.type === 'text') markdown(block.text);
          else if (block.type === 'thinking') {
            if (thinking) text(block.thinking || '[redacted thinking]', muted);
            else text('Thinking (Ctrl+T to show)', muted);
          } else if (block.type === 'toolCall') text(toolHeading(block.name, block.arguments, block.argumentText), muted);
        }
        if (message.errorMessage) text(message.errorMessage, errorColor);
        if (message.stopReason === 'aborted') text('Aborted', warning);
        break;
      case 'toolResult':
        text(`${message.isError ? '✗' : '✓'} ${message.toolName ?? 'tool'}`, message.isError ? errorColor : muted);
        this.children.push(new ToolOutput(toolText(message), expanded)); break;
      case 'bashExecution':
        text(`$ ${message.command}`, muted);
        this.children.push(new ToolOutput(safeText(message.output), expanded)); break;
      case 'compactionSummary': case 'branchSummary':
        text(message.role === 'compactionSummary' ? 'Context compacted' : 'Branch summary', muted);
        if (expanded) markdown(message.summary); break;
      default: text(message.content ? contentText(message.content) : `[${message.role ?? 'message'}]`, muted);
    }
    if (this.children.length) this.children.push(new Text('', 0, 0));
  }
  render(width: number): string[] { return this.children.flatMap(child => child.render(width)).map(line => truncateToWidth(line, width, '')); }
  invalidate(): void { for (const child of this.children) child.invalidate(); }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(Boolean).map(block => block.type === 'text' ? block.text : block.type === 'image' ? `[image: ${block.mimeType}]` : '').filter(Boolean).join('\n');
}
function toolHeading(name: unknown, args?: RecordValue, argumentText?: string): string {
  const detail = args?.command ?? args?.path ?? args?.pattern ?? argumentText ?? (args && Object.keys(args).length ? JSON.stringify(args) : '');
  return safeText(`${name ?? 'tool'}${detail ? `: ${detail}` : ''}`).replace(/\n/g, ' ');
}

class ToolOutput implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  constructor(private text: string, private expanded: boolean) {}
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = wrapTextWithAnsi(this.text, Math.max(1, width));
    const output = this.expanded ? lines : lines.slice(0, 3);
    if (!this.expanded && lines.length > 3) output.push(`… ${lines.length - 3} more lines (Ctrl+O to expand)`);
    this.cachedWidth = width;
    return this.cachedLines = output.map(line => truncateToWidth(muted(line), width, ''));
  }
  invalidate(): void { this.cachedLines = undefined; }
}

class Transcript implements Component {
  private cache = new WeakMap<RecordValue, MessageDisplay>();
  private cachedLines?: string[];
  private cachedWidth?: number;
  expanded = false;
  thinking = false;
  readonly notices: string[] = [];
  constructor(private view: RemoteView) {}
  changed(): void { this.cachedLines = undefined; }
  invalidate(): void { this.cache = new WeakMap(); this.changed(); }
  notify(message: string): void { this.notices.push(safeText(message)); if (this.notices.length > 50) this.notices.shift(); this.changed(); }
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const messages = transcriptMessages(this.view.snapshot);
    const lines: string[] = [];
    for (const message of messages) {
      let component = this.cache.get(message);
      if (!component) { component = new MessageDisplay(message, this.expanded, this.thinking); this.cache.set(message, component); }
      lines.push(...component.render(width));
    }
    const finished = new Set(messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId));
    for (const tool of Object.values(this.view.snapshot.live.tools)) {
      if (finished.has(tool.toolCallId)) continue;
      const ended = tool.type === 'tool_execution_end';
      lines.push(truncateToWidth(muted(`${ended ? (tool.isError ? '✗' : '✓') : '⋯'} ${toolHeading(tool.toolName, tool.args)}`), width, ''));
      lines.push(...new ToolOutput(toolText(tool.result ?? tool.partialResult), this.expanded).render(width));
    }
    for (const notice of this.notices) lines.push(...wrapTextWithAnsi(warning(notice), Math.max(1, width)));
    this.cachedWidth = width;
    return this.cachedLines = lines.map(line => truncateToWidth(line, width, ''));
  }
}

/** Exported for terminal-adapter tests; uses only the public pi-tui API. */
export class RemoteTui {
  readonly view: RemoteView;
  readonly editor: Editor;
  readonly tui: TuiAltScreen;
  private transcript: Transcript;
  private bottom = new VStack();
  private root: VStack;
  private connected = true;
  private detached = false;
  private commandPending = false;
  private interruptPending = false;
  private refreshPromise?: Promise<void>;
  private refreshing = false;
  private refreshAgain = false;
  private journal: RemoteEvent[] = [];
  private generation = 0;
  private activeRemote?: { id: string; component: Dialog };
  private localDialog?: { component: Dialog; cancel: () => void };
  private answering = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private finish?: () => void;
  private started = false;
  private appliedEditorId?: string;
  private appliedTitle?: string;

  constructor(private connection: RemoteConnection, private slotId: string, snapshot: Snapshot,
    terminal: Terminal = new ProcessTerminal()) {
    initTheme(undefined, false); // No session, extensions, providers, or remote resources are loaded locally.
    this.view = new RemoteView(snapshot);
    this.tui = new TuiAltScreen(terminal, true, undefined, { copySelection: async text => {
      try { await copyToClipboard(text); return true; } catch (error) { return errorText(error); }
    } });
    this.editor = this.makeEditor();
    this.editor.onSubmit = text => { void this.submit(text, 'steer'); };
    this.transcript = new Transcript(this.view);
    this.root = new DocumentLayout([
      { component: new ScrollView(this.transcript, { primary: true, follow: 'end', scrollbar: 'auto' }), basis: 0, grow: 1, minSize: 1 },
      { component: this.bottom, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
    this.tui.setLayoutRoot(this.root);
  }

  private makeEditor(): Editor {
    return new Editor(this.tui, { borderColor: accent, selectList: getSelectListTheme() }, { paddingX: 0 });
  }
  private notify(text: string): void {
    if (this.detached) return;
    this.transcript.notify(text); this.tui.requestRender();
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
      this.unsubscribe.push(this.connection.onEvent(event => this.onEvent(event)));
      this.unsubscribe.push(this.connection.onDisconnect(error => {
        if (this.detached) return;
        this.connected = false; this.generation++;
        // Do not resolve remote dialogs, clear the queue, abort, or replay requests.
        this.notify(`Connection lost: ${errorText(error)}. Remote work and dialogs remain active. No commands will be replayed. Press Ctrl+D, then run the same CLI attach command again.`);
        this.syncBottom();
      }));
      this.unsubscribe.push(this.tui.addInputListener(data => {
        if (isKeyRelease(data)) return undefined;
        if (matchesKey(data, Key.ctrl('d'))) { this.detach(); return { consume: true }; }
        if (matchesKey(data, Key.escape)) {
          if (this.activeRemote) void this.answerDialog(this.activeRemote.id, { cancelled: true });
          else if (this.localDialog) this.localDialog.cancel();
          else if (this.view.snapshot.live.busy || this.view.snapshot.live.compacting || this.hasQueue()) void this.interrupt();
          return { consume: true };
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
        return undefined;
      }));
      try {
        this.syncBottom(); this.tui.start();
      } catch (error) {
        this.finish = undefined; this.detach(); reject(error);
      }
    });
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true; this.generation++;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    // Cancel only a LOCAL picker promise. Never answer a remote dialog on detach.
    this.localDialog?.cancel();
    try { this.tui.stop(); } finally {
      this.connection.close(); this.finish?.();
    }
  }

  private onEvent(event: RemoteEvent): void {
    if (this.detached || event.slotId !== this.slotId) return;
    const gap = event.seq > this.view.snapshot.seq + 1;
    if (this.refreshing) this.journal.push(event);
    if (!this.view.apply(event)) return;
    this.transcript.changed();
    if (event.event.type === 'extension_ui_request' && event.event.method === 'notify') this.notify(event.event.message ?? '');
    if (event.event.type === 'extension_error') this.notify(`Extension error: ${event.event.error}`);
    if (event.event.type === 'remote_warning') this.notify(`Remote warning: ${event.event.error ?? event.event.message ?? 'State inspection failed; remote work is preserved.'}`);
    if (event.event.type === 'auto_retry_start') this.notify(`Pi retry ${event.event.attempt}: ${event.event.errorMessage ?? ''}`);
    if (event.event.type === 'remote_slot_exit') this.notify(`Remote Pi exited${event.event.error ? `: ${event.event.error}` : ''}. Ctrl+D detaches.`);
    this.syncBottom();
    if (gap || event.event.type === 'remote_refresh' || event.event.type === 'agent_settled' || event.event.type === 'compaction_end') {
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
        this.view.replace(snapshot, this.journal);
        this.transcript.invalidate(); this.syncBottom();
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
      const editor = this.makeEditor(); editor.setText(record.prefill ?? ''); editor.disableSubmit = true;
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

  private syncBottom(): void {
    if (this.detached) return;
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
      for (const record of ui) if (record.method === 'setWidget' && (record.widgetPlacement ?? 'aboveEditor') === placement && record.widgetLines?.length) {
        this.bottom.addChild(new Text(record.widgetLines.map(safeText).join('\n'), 0, 0));
      }
    };
    widget('aboveEditor');
    this.bottom.addChild(new DynamicLines(width => this.queueLines(width)));
    const control = this.activeRemote?.component ?? this.localDialog?.component ?? this.editor;
    this.bottom.addChild(control);
    widget('belowEditor');
    this.bottom.addChild(new DynamicLines(() => [this.footer(), muted('Enter steer · Alt+Enter follow-up · Esc cancel/abort · Ctrl+D detach · /help')]));
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
    return muted([status, s.state.sessionName ?? s.slot.sessionName ?? this.slotId, s.slot.cwd,
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
    this.commandPending = true;
    try {
      const handled = await this.builtin(command, args);
      if (!handled) await this.rpc({ type: 'prompt', message: text, streamingBehavior });
    } catch (error) {
      this.notify(`Request failed: ${errorText(error)}. After connection loss, its remote outcome can be unknown. Nothing will be replayed; attach again and check the session before resending.`);
      if (!this.detached) this.restoreSubmission(text);
    } finally { this.commandPending = false; if (!this.detached) this.syncBottom(); }
  }

  private async builtin(command: string, args: string): Promise<boolean> {
    switch (command) {
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
      case '/fork': {
        const data = await this.rpc({ type: 'get_fork_messages' });
        const messages: RecordValue[] = data.messages ?? [];
        const entryId = await this.choose('Fork from a user message', messages.map(message => ({ value: message.entryId, label: message.text })));
        if (entryId !== undefined && !this.detached) {
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
}

/** Attach is the caller's responsibility. Closing this UI only closes the local transport. */
export async function runTui(connection: RemoteConnection, slotId: string, initialSnapshot: Snapshot): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The remote terminal UI requires a terminal for stdin and stdout.');
  await new RemoteTui(connection, slotId, initialSnapshot).run();
}
