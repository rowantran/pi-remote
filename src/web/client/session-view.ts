import { PiScreen } from '../../tui/pi-screen.js';
import { ScreenState } from '../../protocol/screen.js';
import { toKittyInput } from '../../tui/kitty-keys.js';
import type { SlotAttachment } from '../../protocol/methods.js';
import type { PiExtensionMessage, RgbColor } from '../../protocol/pi-extension.js';
import type { RemoteConnection, RemoteEvent, SlotInfo } from '../../protocol/types.js';
import type { XtermTerminal } from './terminal.js';

function rgb(color: string): RgbColor | undefined {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  return match ? { r: parseInt(match[1]!, 16), g: parseInt(match[2]!, 16), b: parseInt(match[3]!, 16) } : undefined;
}

export interface SessionViewEvents {
  /** A picker or dialog has Pi's focus: the composer cannot type into it. */
  onPickerChange?: (active: boolean) => void;
  onWorkingChange?: (working: boolean) => void;
  /** Pi stopped (the slot exited). */
  onStopped?: () => void;
  /** The current screen, for the device-local offline preview. */
  onScreen?: (messages: PiExtensionMessage[]) => void;
}

/**
 * The phone view of a slot: Pi renders at the phone's width (the phone takes the size
 * when it attaches or sends), and the phone scrolls Pi's transcript locally. Prompts come from
 * the native text box and replace Pi's editor text before Enter.
 */
export class SessionView {
  readonly client: PiScreen;
  private seq = -1;
  private picker = false;
  private working = false;
  private unsubscribe: (() => void)[] = [];
  private screen = new ScreenState();

  constructor(private readonly connection: RemoteConnection, readonly slot: SlotInfo, readonly terminal: XtermTerminal,
    private readonly colors: { background: string; foreground: string }, private readonly events: SessionViewEvents = {}) {
    this.client = new PiScreen(terminal, {
      send: data => { void connection.request('input', { slotId: slot.id, data }).catch(() => {}); },
      resize: (columns, rows) => { void connection.request('resize', { slotId: slot.id, columns, rows, answers: this.answers }).catch(() => {}); },
    }, { encodeKey: data => toKittyInput(data, false) });
  }

  /** The phone's colors tell Pi whether to use its light or dark theme. */
  get answers() {
    const background = rgb(this.colors.background), foreground = rgb(this.colors.foreground);
    return { ...(background ? { background } : {}), ...(foreground ? { foreground } : {}) };
  }

  /** Show saved screen messages without a connection (offline preview). */
  preview(messages: PiExtensionMessage[]): void {
    this.client.start();
    for (const message of messages) this.client.receive(message);
  }

  async attach(): Promise<void> {
    this.client.start();
    const attachment = await this.connection.request('attach', {
      slotId: this.slot.id, columns: this.terminal.columns, rows: this.terminal.rows, answers: this.answers,
    });
    this.apply(attachment);
    this.setWorking(attachment.busy === true);
    this.unsubscribe.push(this.connection.onEvent((event: RemoteEvent) => this.event(event)));
    this.unsubscribe.push(this.connection.onReconnect?.(next => { this.client.reset(); this.apply(next); this.setWorking(next.busy === true); }) ?? (() => {}));
    // Typing on the phone is the native text box. Pi gets the phone's size when it sends.
  }

  /** Replace Pi's editor text with `text` and press Enter, as if typed in Pi. */
  async submit(text: string): Promise<void> {
    this.client.replaceEditorText(text);
    this.client.input('\r');
  }

  sendKey(data: string): void { this.client.input(data); }
  scrollTranscript(lines: number): void { this.client.scrollTranscript(lines); }
  followLatest(): void { this.client.followLatest(); }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.client.stop();
  }

  private apply(attachment: SlotAttachment): void {
    this.seq = attachment.seq;
    this.screen = new ScreenState();
    for (const message of attachment.messages) this.receive(message);
  }

  private event(event: RemoteEvent): void {
    if (event.slotId !== this.slot.id || event.seq <= this.seq) return;
    this.seq = event.seq;
    const record = event.event;
    if (record.type === 'screen') this.receive(record.message);
    else if (record.type === 'agent_start') this.setWorking(true);
    else if (record.type === 'agent_settled') this.setWorking(false);
    else if (record.type === 'remote_slot_exit') this.events.onStopped?.();
  }

  private receive(message: PiExtensionMessage): void {
    this.client.receive(message, JSON.stringify(message).length);
    this.screen.apply(message);
    const picker = this.client.layoutKnown && !this.client.editorFocusedOnPi;
    if (picker !== this.picker) { this.picker = picker; this.events.onPickerChange?.(picker); }
    if (message.type === 'frame') this.events.onScreen?.(this.screen.snapshot());
  }

  private setWorking(working: boolean): void {
    if (working === this.working) return;
    this.working = working;
    this.events.onWorkingChange?.(working);
  }
}
