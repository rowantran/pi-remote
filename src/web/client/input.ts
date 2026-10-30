/** A slot that runs Pi's own interface: the text box replaces Pi's editor text and presses Enter. */
export interface ComposerTarget { submit(text: string): Promise<void> }

/** Session state the composer reacts to. */
export interface ComposerState {
  /** A Pi picker or dialog has focus: typing goes through the choice buttons instead. */
  onTerminalDialogChange(active: boolean): void;
  onWorkingChange(working: boolean): void;
}

/** iOS owns editing, selection, autocorrection, composition, and dictation. No keystrokes
 * from this field are forwarded to the terminal. Only explicit Send submits a prompt: it
 * replaces Pi's editor text and presses Enter. Pi's pickers and dialogs show in the
 * terminal, driven by the choice buttons. */
export class NativeInput {
  private target?: ComposerTarget;
  private slotId?: string;
  private connected = false;
  private submitting = false;
  private composing = false;
  private terminalDialog = false;
  private working = false;
  /** Sends Esc to Pi: interrupts work exactly like the laptop's Escape key. */
  onStop?: () => void;
  readonly textarea = document.getElementById('prompt') as HTMLTextAreaElement;
  private sendButton = document.getElementById('send') as HTMLButtonElement;
  private stopButton = document.getElementById('stop') as HTMLButtonElement;
  private pickerKeys = document.getElementById('picker-keys')!;

  constructor(private report: (error: unknown) => void) {
    this.textarea.addEventListener('compositionstart', () => { this.composing = true; this.updateControls(); });
    this.textarea.addEventListener('compositionend', () => { this.composing = false; this.changed(); });
    this.textarea.addEventListener('input', () => { if (!this.composing) this.changed(); this.resize(); });
    document.getElementById('composer')!.addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
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

  readonly callbacks: ComposerState = {
    onTerminalDialogChange: (active: boolean) => { this.terminalDialog = active; this.updateControls(); },
    onWorkingChange: (working: boolean) => { this.working = working; this.updateControls(); },
  };

  release(): void { this.target = undefined; this.working = false; this.terminalDialog = false; this.setConnected(false); }
  /** Returns the saved draft for `slotId`. */
  prepare(slotId: string): string {
    this.target = undefined; this.slotId = slotId; this.connected = false; this.working = false; this.terminalDialog = false;
    this.updateControls();
    let draft = '';
    try { draft = localStorage.getItem(`pi-remote-draft:${slotId}`) ?? ''; } catch { /* No storage. */ }
    this.textarea.value = draft; this.resize();
    return draft;
  }
  bindSession(target: ComposerTarget, slotId: string, draft: string): void {
    this.target = target; this.slotId = slotId;
    this.textarea.value = draft; this.resize(); this.setConnected(true);
  }
  setConnected(connected: boolean): void { this.connected = connected; this.updateControls(); }
  private saveDraft(text: string): void {
    if (!this.slotId) return;
    try { if (text) localStorage.setItem(`pi-remote-draft:${this.slotId}`, text); else localStorage.removeItem(`pi-remote-draft:${this.slotId}`); }
    catch { /* In-memory drafts remain usable when private storage is unavailable or full. */ }
  }
  private changed(): void { this.saveDraft(this.textarea.value); this.updateControls(); }
  private resize(): void {
    this.textarea.style.height = 'auto';
    const borders = this.textarea.offsetHeight - this.textarea.clientHeight;
    const limit = (window.visualViewport?.height ?? window.innerHeight) * 0.4;
    this.textarea.style.height = `${Math.min(Math.max(36, this.textarea.scrollHeight + borders), limit)}px`;
  }
  private updateControls(): void {
    const bound = !!this.target;
    this.sendButton.disabled = !this.connected || !bound || this.submitting || this.composing || !this.textarea.value.trim() || this.terminalDialog;
    this.textarea.disabled = this.terminalDialog;
    this.pickerKeys.hidden = !this.terminalDialog;
    // Like a chat app: an empty composer offers Stop while Pi works; typing brings Send back (steering).
    const stop = this.working && this.connected && bound && !this.terminalDialog && !this.textarea.value.trim();
    this.stopButton.hidden = !stop; this.sendButton.hidden = stop;
    this.textarea.placeholder = this.terminalDialog ? 'Choose with the buttons above' : this.connected ? 'Message Pi' : 'Draft saved · reconnecting';
  }
  async submit(): Promise<void> {
    const target = this.target;
    if (this.sendButton.disabled || !target) return;
    this.submitting = true; this.updateControls();
    // Return to the compact bar, like iMessage: dismiss the keyboard during the tap itself.
    this.textarea.blur();
    try {
      await target.submit(this.textarea.value);
      this.textarea.value = ''; this.saveDraft(''); this.resize();
    } catch (error) { this.report(error); }
    finally { this.submitting = false; this.updateControls(); }
  }
}
