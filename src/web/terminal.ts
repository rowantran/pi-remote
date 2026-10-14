import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@earendil-works/pi-tui';

/** All terminal painting and scroll layout happen on the phone, not across the network. */
export class XtermTerminal implements Terminal {
  readonly xterm: Xterm;
  private fit = new FitAddon();
  private input?: (data: string) => void;
  private resize?: () => void;
  private observer: ResizeObserver;
  private disposables: { dispose(): void }[] = [];
  private running = false;
  readonly kittyProtocolActive = false;

  constructor(readonly element: HTMLElement, private onBell: () => void = () => {}) {
    this.xterm = new Xterm({
      fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.15,
      scrollback: 0, cursorBlink: false, convertEol: false, allowProposedApi: false,
      theme: { background: '#161616', foreground: '#dedede', cursor: '#dedede' },
    });
    this.xterm.loadAddon(this.fit);
    this.xterm.open(element);
    this.disposables.push(this.xterm.onData(data => this.input?.(data)), this.xterm.onBell(onBell),
      this.xterm.onResize(() => this.resize?.()));
    this.observer = new ResizeObserver(() => this.fit.fit());
    this.observer.observe(element);
    this.fit.fit();
  }
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput; this.resize = onResize; this.running = true; this.fit.fit();
  }
  stop(): void { this.input = undefined; this.resize = undefined; this.running = false; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.xterm.write(data); }
  sendKey(data: string): void { if (this.running) this.input?.(data); }
  focus(): void { this.xterm.focus(); }
  useNativeInput(): void {
    this.xterm.options.disableStdin = true;
    const input = this.element.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (input) { input.readOnly = true; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true'); }
  }
  get columns(): number { return this.xterm.cols; }
  get rows(): number { return this.xterm.rows; }
  moveBy(lines: number): void { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? 'B' : 'A'}`); }
  hideCursor(): void { this.write('\x1b[?25l'); }
  showCursor(): void { this.write('\x1b[?25h'); }
  clearLine(): void { this.write('\x1b[K'); }
  clearFromCursor(): void { this.write('\x1b[J'); }
  clearScreen(): void { this.write('\x1b[2J\x1b[H'); }
  setTitle(title: string): void { document.title = title || 'Pi Remote'; }
  setProgress(_active: boolean): void {}
  dispose(): void {
    this.stop(); this.observer.disconnect();
    for (const disposable of this.disposables) disposable.dispose();
    this.xterm.dispose();
  }
}
