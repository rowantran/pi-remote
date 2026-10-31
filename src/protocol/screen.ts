import { applyDiff, diffLines, SECTION_COUNT, type PiExtensionMessage, type LineDiff } from './pi-extension.js';

type Frame = Extract<PiExtensionMessage, { type: 'frame' }>;
type TerminalOutput = Extract<PiExtensionMessage, { type: 'terminal' }>;
const HISTORY_LIMIT = 1000;

/**
 * The daemon's copy of what the Pi extension reported for one Pi process. A client that
 * attaches gets `snapshot()`: messages that rebuild the current screen and editor from
 * nothing. Live messages follow.
 */
export class ScreenState {
  private sections: string[][] = Array.from({ length: SECTION_COUNT }, () => []);
  private frame?: Omit<Frame, 'sections' | 'reset'>;
  private editorInstalled?: Extract<PiExtensionMessage, { type: 'editorInstalled' }>;
  private editorChrome?: Extract<PiExtensionMessage, { type: 'editorChrome' }>;
  private editor?: Extract<PiExtensionMessage, { type: 'editor' }>;
  private session?: Extract<PiExtensionMessage, { type: 'session' }>;
  private history: string[] = [];
  /** Pi sets the window title once at startup and again on session changes and renames, so a
   * client that attaches later needs the last one. Other terminal output is a one-time event. */
  private title?: TerminalOutput;

  apply(message: PiExtensionMessage): void {
    switch (message.type) {
      case 'frame': {
        if (message.reset) this.sections = Array.from({ length: SECTION_COUNT }, () => []);
        for (const [key, diff] of Object.entries(message.sections)) {
          const index = message.layout === 'known' ? Number(key) : 0;
          if (index >= 0 && index < SECTION_COUNT) this.sections[index] = applyDiff(this.sections[index]!, diff);
        }
        const { sections: _sections, reset: _reset, ...rest } = message;
        this.frame = rest;
        break;
      }
      case 'editorInstalled':
        // A new editor starts with an empty history; Pi adds entries to it as prompts are sent.
        this.editorInstalled = message; this.history = []; this.editor = undefined;
        break;
      case 'editorChrome': this.editorChrome = message; break;
      case 'editor': this.editor = message; break;
      case 'history':
        this.history.push(message.text);
        if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
        break;
      case 'session': this.session = message; break;
      case 'terminal': if (message.kind === 'title') this.title = message; break;
      case 'activity': case 'clientAction': break;
    }
  }

  get sessionInfo(): Extract<PiExtensionMessage, { type: 'session' }> | undefined { return this.session; }

  /** Messages that rebuild the current state on a client that has nothing. */
  snapshot(): PiExtensionMessage[] {
    const messages: PiExtensionMessage[] = [];
    if (this.editorInstalled) messages.push(this.editorInstalled);
    if (this.editorChrome) messages.push(this.editorChrome);
    for (const text of this.history) messages.push({ type: 'history', text });
    if (this.session) messages.push(this.session);
    if (this.frame) {
      const sections: Record<number, LineDiff> = {};
      this.sections.forEach((lines, index) => { const diff = diffLines([], lines); if (diff) sections[index] = diff; });
      messages.push({ ...this.frame, reset: true, sections });
    }
    if (this.editor) messages.push(this.editor);
    if (this.title) messages.push(this.title);
    return messages;
  }
}
