import { applyDiff, diffLines, SECTION_COUNT, type CompanionMessage, type LineDiff } from './companion.js';

type Frame = Extract<CompanionMessage, { type: 'frame' }>;
const HISTORY_LIMIT = 1000;

/**
 * The daemon's copy of what the companion reported for one Pi process. A client that
 * attaches gets `snapshot()`: messages that rebuild the current screen and editor from
 * nothing. Live messages follow.
 */
export class ScreenState {
  private sections: string[][] = Array.from({ length: SECTION_COUNT }, () => []);
  private frame?: Omit<Frame, 'sections' | 'reset'>;
  private editorInstalled?: Extract<CompanionMessage, { type: 'editorInstalled' }>;
  private editorChrome?: Extract<CompanionMessage, { type: 'editorChrome' }>;
  private editor?: Extract<CompanionMessage, { type: 'editor' }>;
  private session?: Extract<CompanionMessage, { type: 'session' }>;
  private history: string[] = [];

  apply(message: CompanionMessage): void {
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
      case 'activity': break;
    }
  }

  get sessionInfo(): Extract<CompanionMessage, { type: 'session' }> | undefined { return this.session; }

  /** Messages that rebuild the current state on a client that has nothing. */
  snapshot(): CompanionMessage[] {
    const messages: CompanionMessage[] = [];
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
    return messages;
  }
}
