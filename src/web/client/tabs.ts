import type { SlotInfo } from '../../protocol/types.js';

type Api = <T>(path: string, body?: unknown) => Promise<T>;
interface TabList { slotIds: string[] }
export interface TabHandlers { select(slotId: string): void; close(slotId: string): void }

export function slotLabel(slot: Pick<SlotInfo, 'id' | 'number' | 'sessionName'> | undefined, fallback = 'Session'): string {
  if (!slot) return fallback;
  return `${slot.number ?? slot.id.slice(0, 8)} · ${slot.sessionName ?? 'Unnamed'}`;
}

/** The device's open sessions ("tabs"). The server stores them because push notifications
 * go only to devices that have the session open. Closing a tab never stops the session. */
export class SessionTabs {
  private ids: string[] = [];
  private slots = new Map<string, SlotInfo>();
  private active?: string;
  constructor(private api: Api, private strip: HTMLElement, private handlers: TabHandlers) {}
  get slotIds(): readonly string[] { return this.ids; }
  has(slotId: string): boolean { return this.ids.includes(slotId); }
  async load(): Promise<void> { this.ids = (await this.api<TabList>('/api/tabs')).slotIds; this.render(); }
  async open(slotId: string): Promise<void> {
    if (this.has(slotId)) return;
    this.ids = (await this.api<TabList>('/api/tabs/open', { slotId })).slotIds; this.render();
  }
  /** Returns the tab to show instead when the closed tab was active. */
  async close(slotId: string): Promise<string | undefined> {
    const index = this.ids.indexOf(slotId);
    this.ids = (await this.api<TabList>('/api/tabs/close', { slotId })).slotIds;
    if (this.active === slotId) this.active = undefined;
    this.render();
    return index < 0 ? undefined : this.ids[Math.min(index, this.ids.length - 1)];
  }
  /** Refresh labels from the daemon's slot list. Tabs whose session no longer exists close. */
  update(slots: readonly SlotInfo[]): void {
    this.slots = new Map(slots.map(slot => [slot.id, slot]));
    for (const id of this.ids.filter(id => !this.slots.has(id))) void this.close(id).catch(() => {});
    this.render();
  }
  setActive(slotId: string | undefined): void { this.active = slotId; this.render(); }
  private render(): void {
    this.strip.replaceChildren();
    for (const id of this.ids) {
      const slot = this.slots.get(id);
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.dataset.slot = id;
      if (id === this.active) tab.classList.add('active');
      if (slot?.status === 'exited') tab.classList.add('exited');
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'tab-open';
      open.textContent = slotLabel(slot) + (slot?.status === 'exited' ? ' (stopped)' : '');
      if (id === this.active) open.setAttribute('aria-current', 'page');
      open.addEventListener('click', () => this.handlers.select(id));
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Close tab ${open.textContent}`);
      close.title = 'Close tab (the session keeps running)';
      close.addEventListener('click', () => this.handlers.close(id));
      tab.append(open, close);
      this.strip.append(tab);
    }
    this.strip.hidden = !this.ids.length;
    this.strip.querySelector('.tab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}
