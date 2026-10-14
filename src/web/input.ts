import { RemoteAutocompleteProvider } from '../tui/editor-completion.js';
import type { RemoteTui, TuiOptions } from '../tui/tui.js';
import type { RecordValue, RemoteConnection } from '../protocol/types.js';
import type { SelectItem } from '@earendil-works/pi-tui';

const commands = ['help', 'model', 'thinking', 'new', 'fork', 'tree', 'resume', 'session', 'copy', 'name', 'compact', 'export', 'reload', 'quit'];

/** iOS owns editing, selection, autocorrection, composition, and dictation. No keystrokes
 * from this field are forwarded to the terminal. Only explicit Send submits a prompt. */
export class NativeInput {
  private client?: RemoteTui;
  private slotId?: string;
  private connected = false;
  private submitting = false;
  private composing = false;
  private provider?: RemoteAutocompleteProvider;
  private suggestions?: AbortController;
  private completionTimer?: ReturnType<typeof setTimeout>;
  private remote?: RecordValue;
  private answerPending = false;
  private localChoice?: (value?: string) => void;
  private terminalDialog = false;
  private working = false;
  /** Sends Esc through the TUI: interrupts work exactly like the laptop's Escape key. */
  onStop?: () => void;
  readonly textarea = document.getElementById('prompt') as HTMLTextAreaElement;
  private sendButton = document.getElementById('send') as HTMLButtonElement;
  private stopButton = document.getElementById('stop') as HTMLButtonElement;
  private pickerKeys = document.getElementById('picker-keys')!;
  private results = document.getElementById('completions')!;
  private sheet = document.getElementById('action-dialog') as HTMLDialogElement;
  private content = document.getElementById('action-content')!;

  constructor(private report: (error: unknown) => void) {
    this.textarea.addEventListener('compositionstart', () => { this.composing = true; this.hideSuggestions(); this.updateControls(); });
    this.textarea.addEventListener('compositionend', () => { this.composing = false; this.changed(); });
    this.textarea.addEventListener('input', () => { if (!this.composing) this.changed(); this.resize(); });
    this.textarea.addEventListener('select', () => this.complete());
    this.textarea.addEventListener('click', () => this.complete());
    document.getElementById('composer')!.addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
    this.sheet.addEventListener('cancel', event => {
      event.preventDefault();
      if (this.localChoice) this.localChoice();
      else if (this.remote && this.connected) void this.answer(this.remote.id, { cancelled: true });
    });
    // Keep the keyboard state unchanged when tapping Stop.
    this.stopButton.addEventListener('pointerdown', event => event.preventDefault());
    this.stopButton.addEventListener('click', () => this.onStop?.());
    this.updateControls();
    const viewport = () => {
      const visual = window.visualViewport;
      const height = visual?.height ?? window.innerHeight;
      const style = document.documentElement.style;
      style.setProperty('--viewport-height', `${height}px`);
      style.setProperty('--viewport-top', `${Math.max(0, visual?.offsetTop ?? 0)}px`);
      // A much shorter visual viewport means the software keyboard covers the home-indicator area.
      const keyboard = height < window.innerHeight - 120;
      document.body.classList.toggle('keyboard-open', keyboard);
      if (!keyboard && (window.scrollY || document.documentElement.scrollTop)) window.scrollTo(0, 0);
      this.resize();
    };
    window.visualViewport?.addEventListener('resize', viewport);
    window.visualViewport?.addEventListener('scroll', viewport);
    window.addEventListener('resize', viewport); viewport();
  }

  readonly callbacks: NonNullable<TuiOptions['externalInput']> = {
    onDraftChange: (text: string) => {
      if (this.textarea.value !== text) this.textarea.value = text;
      this.saveDraft(text); this.resize(); this.updateControls();
    },
    onDialogChange: (record: RecordValue | undefined) => this.showRemote(record),
    choose: (title: string, items: SelectItem[], signal: AbortSignal) => this.choose(title, items, signal),
    onTerminalDialogChange: (active: boolean) => { this.terminalDialog = active; this.updateControls(); },
    onWorkingChange: (working: boolean) => { this.working = working; this.updateControls(); },
  };

  release(): void { this.client = undefined; this.working = false; this.setConnected(false); this.hideSuggestions(); }
  prepare(slotId: string): string {
    this.client = undefined; this.slotId = slotId; this.connected = false; this.provider = undefined; this.working = false;
    this.hideSuggestions(); this.updateControls();
    try { return localStorage.getItem(`pi-remote-draft:${slotId}`) ?? ''; } catch { return ''; }
  }
  bind(client: RemoteTui, connection: RemoteConnection, slotId: string, draft: string): void {
    this.client = client; this.slotId = slotId;
    this.provider = new RemoteAutocompleteProvider({
      localCommands: commands.map(name => ({ name })),
      getCommands: async () => await connection.request('rpc', { slotId, command: { type: 'get_commands' } }) as { commands: { name: string; description?: string }[] },
      completePath: prefix => connection.request('complete_path', { slotId, prefix }),
    });
    client.setDraft(draft); this.setConnected(true);
  }
  setConnected(connected: boolean): void {
    this.connected = connected; this.updateControls();
    for (const control of this.content.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('button,input,textarea')) control.disabled = !connected || this.answerPending;
  }
  private saveDraft(text: string): void {
    if (!this.slotId) return;
    try { if (text) localStorage.setItem(`pi-remote-draft:${this.slotId}`, text); else localStorage.removeItem(`pi-remote-draft:${this.slotId}`); }
    catch { /* In-memory drafts remain usable when private storage is unavailable or full. */ }
  }
  private changed(): void { this.client?.setDraft(this.textarea.value); this.saveDraft(this.textarea.value); this.complete(); this.updateControls(); }
  private resize(): void {
    this.textarea.style.height = 'auto';
    const borders = this.textarea.offsetHeight - this.textarea.clientHeight;
    const limit = (window.visualViewport?.height ?? window.innerHeight) * 0.4;
    this.textarea.style.height = `${Math.min(Math.max(36, this.textarea.scrollHeight + borders), limit)}px`;
  }
  private updateControls(): void {
    this.sendButton.disabled = !this.connected || !this.client || this.submitting || this.composing || !this.textarea.value.trim() || this.terminalDialog;
    this.textarea.disabled = this.terminalDialog;
    this.pickerKeys.hidden = !this.terminalDialog;
    // Like a chat app: an empty composer offers Stop while Pi works; typing brings Send back (steering).
    const stop = this.working && this.connected && !!this.client && !this.terminalDialog && !this.textarea.value.trim();
    this.stopButton.hidden = !stop; this.sendButton.hidden = stop;
    this.textarea.placeholder = this.terminalDialog ? 'Choose with the buttons above' : this.connected ? 'Message Pi' : 'Draft saved · reconnecting';
  }
  async submit(): Promise<void> {
    if (this.sendButton.disabled || !this.client) return;
    const client = this.client;
    this.submitting = true; this.hideSuggestions(); this.updateControls();
    // Return to the compact bar, like iMessage: dismiss the keyboard during the tap itself.
    this.textarea.blur();
    try { client.setDraft(this.textarea.value); await client.submitDraft('steer'); }
    catch (error) { this.report(error); }
    finally { this.submitting = false; this.updateControls(); }
  }
  private hideSuggestions(): void {
    clearTimeout(this.completionTimer); this.suggestions?.abort();
    this.results.replaceChildren(); this.results.hidden = true;
  }
  private complete(): void {
    this.hideSuggestions();
    if (!this.provider || this.composing || !this.connected || this.textarea.selectionStart !== this.textarea.selectionEnd) return;
    const provider = this.provider;
    const text = this.textarea.value;
    const caret = this.textarea.selectionStart;
    const prefix = text.slice(0, caret).split('\n');
    const line = prefix.length - 1, col = prefix.at(-1)!.length;
    const lines = text.split('\n');
    const controller = new AbortController(); this.suggestions = controller;
    this.completionTimer = setTimeout(() => {
      void provider.getSuggestions(lines, line, col, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted || !result || this.textarea.value !== text || this.textarea.selectionStart !== caret) return;
        this.results.replaceChildren();
        for (const item of result.items.slice(0, 6)) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label;
          button.title = item.description ?? item.label;
          button.addEventListener('pointerdown', event => event.preventDefault());
          button.addEventListener('click', () => {
            const applied = provider.applyCompletion(lines, line, col, item, result.prefix);
            this.textarea.value = applied.lines.join('\n');
            const position = applied.lines.slice(0, applied.cursorLine).reduce((n, line) => n + line.length + 1, 0) + applied.cursorCol;
            this.textarea.setSelectionRange(position, position); this.client?.setDraft(this.textarea.value);
            this.hideSuggestions(); this.resize(); this.textarea.focus({ preventScroll: true });
          });
          this.results.append(button);
        }
        this.results.hidden = !this.results.children.length;
      }).catch(() => {});
    }, 120);
  }
  private title(text: string): void { const heading = document.createElement('h1'); heading.textContent = text; this.content.append(heading); }
  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.disabled = !this.connected || this.answerPending; button.addEventListener('click', action); this.content.append(button); return button;
  }
  private showRemote(record: RecordValue | undefined): void {
    if (record?.id === this.remote?.id) return;
    this.remote = record; this.answerPending = false;
    if (!record) { if (!this.localChoice) this.sheet.close(); return; }
    this.localChoice?.(); this.content.replaceChildren();
    this.title(record.title ?? 'Pi needs your input');
    if (record.message) { const message = document.createElement('p'); message.textContent = String(record.message); this.content.append(message); }
    if (record.method === 'confirm') {
      this.button('Yes', () => { void this.answer(record.id, { confirmed: true }); });
      this.button('No', () => { void this.answer(record.id, { confirmed: false }); });
    } else if (record.method === 'select') {
      for (const option of record.options ?? []) this.button(String(option), () => { void this.answer(record.id, { value: option }); });
    } else {
      const input = document.createElement(record.method === 'editor' ? 'textarea' : 'input');
      input.id = 'dialog-input'; input.setAttribute('aria-label', record.title ?? 'Answer');
      input.autocomplete = 'off'; input.spellcheck = true; input.setAttribute('autocorrect', 'on');
      input.placeholder = String(record.placeholder ?? 'Your answer'); input.value = String(record.prefill ?? '');
      if (input instanceof HTMLTextAreaElement) input.rows = 6;
      this.content.append(input);
      this.button('Submit answer', () => { void this.answer(record.id, { value: input.value }); });
    }
    const cancel = this.button('Cancel', () => { void this.answer(record.id, { cancelled: true }); });
    if (!this.sheet.open) this.sheet.showModal();
    cancel.focus();
  }
  private async answer(id: string, response: RecordValue): Promise<void> {
    if (!this.client || !this.connected || this.answerPending || this.remote?.id !== id) return;
    this.answerPending = true; this.setConnected(this.connected);
    try { await this.client.answerExternalDialog(id, response); }
    catch (error) { this.report(error); }
    finally { this.answerPending = false; this.setConnected(this.connected); }
  }
  private choose(title: string, items: SelectItem[], signal: AbortSignal): Promise<string | undefined> {
    this.localChoice?.();
    return new Promise(resolve => {
      const cancel = () => done();
      const done = (value?: string) => { if (this.localChoice !== done) return; signal.removeEventListener('abort', cancel); this.localChoice = undefined; this.sheet.close(); resolve(value); };
      this.localChoice = done;
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { done(); return; }
      this.content.replaceChildren(); this.title(title);
      const filter = document.createElement('input'); filter.placeholder = 'Filter choices…'; filter.setAttribute('aria-label', 'Filter choices');
      const list = document.createElement('div'); list.className = 'choices';
      const render = () => {
        list.replaceChildren();
        for (const item of items.filter(item => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(filter.value.toLowerCase()))) {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = `${item.label}${item.description ? ` · ${item.description}` : ''}`;
          button.addEventListener('click', () => done(item.value)); list.append(button);
        }
      };
      filter.addEventListener('input', render); this.content.append(filter, list); render();
      this.button('Cancel', () => done()); if (!this.sheet.open) this.sheet.showModal();
    });
  }
}
