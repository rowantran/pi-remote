import {
  type Component, type Focusable, fuzzyFilter, Input, Key, matchesKey, ProcessTerminal, type Terminal,
  TuiMainScreen, truncateToWidth, visibleWidth,
} from '@earendil-works/pi-tui';
import { sideParentLabel } from '../tui/session-labels.js';
import { slotNumber, type NumberedSlot } from './completion.js';

/** One picker row. `pinned` rows (actions such as "New session") stay below the
 * filtered rows whatever the query, so they are always one arrow key away. */
export interface PickerItem<T> {
  value: T;
  /** Short leading column, for example `#3 ●`. Its ANSI styles are kept. */
  marker?: string;
  title: string;
  /** Muted text after the title, for example the workspace. */
  detail?: string;
  /** Muted, right-aligned text, for example `2h ago`. */
  right?: string;
  /** Text matched by the fuzzy filter. Defaults to the title and detail. */
  search?: string;
  /** Queries that rank this row first, for example its slot number. */
  exact?: string[];
  pinned?: boolean;
}

export interface PickerOptions {
  title: string;
  /** Muted text after the title, for example the host. */
  subtitle?: string;
  placeholder?: string;
  /** Shown when no unpinned row matches the query. */
  empty?: string;
  /** Verb for Enter in the key hints. */
  action?: string;
  /** Rows of the list, not counting the title, query, and hints. */
  maxVisible?: number;
}

const color = (code: string) => (text: string) => process.env.NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`;
export const style = { bold: color('1'), dim: color('2'), accent: color('36'), ok: color('32'), warn: color('33'), error: color('31') };
/** Remote names, paths, and session titles are data. Never let them drive the terminal. */
export const plainText = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/**
 * A fuzzy finder rendered inline below the shell prompt: a query line, matching rows,
 * then key hints. It is a pure component; `runPicker` hosts it on a terminal.
 */
export class FuzzyPicker<T> implements Component, Focusable {
  private readonly input: Input;
  private selected = 0;
  private scroll = 0;
  /** Rows of the list shown at once; the runner lowers it to fit the terminal. */
  maxVisible: number;
  onSelect?: (value: T) => void;
  onCancel?: () => void;

  constructor(private readonly items: PickerItem<T>[], private readonly options: PickerOptions) {
    this.input = new Input({ prompt: style.accent('❯ '), placeholder: options.placeholder ?? 'Search by name, number, or folder', placeholderStyle: style.dim });
    this.input.focused = true;
    this.maxVisible = options.maxVisible ?? 10;
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  get query(): string { return this.input.getValue(); }

  /** Exact matches first, then fuzzy matches by score, then pinned rows. */
  rows(): PickerItem<T>[] {
    const query = this.query.trim();
    const unpinned = this.items.filter(item => !item.pinned);
    const exact = query ? unpinned.filter(item => item.exact?.includes(query)) : [];
    const fuzzy = fuzzyFilter(unpinned, query, item => item.search ?? `${item.title} ${item.detail ?? ''}`)
      .filter(item => !exact.includes(item));
    return [...exact, ...fuzzy, ...this.items.filter(item => item.pinned)];
  }

  selectedValue(): T | undefined { return this.rows()[this.selected]?.value; }

  handleInput(data: string): void {
    const rows = this.rows();
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) { this.onCancel?.(); return; }
    if (matchesKey(data, Key.enter)) { const row = rows[this.selected]; if (row) this.onSelect?.(row.value); return; }
    const page = this.visibleCount();
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl('p'))) this.selected = Math.max(this.selected - 1, 0);
    else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl('n'))) this.selected = Math.min(this.selected + 1, rows.length - 1);
    else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(this.selected - page, 0);
    else if (matchesKey(data, Key.pageDown)) this.selected = Math.min(this.selected + page, rows.length - 1);
    else {
      const before = this.query;
      this.input.handleInput(data);
      // A new query starts at its best match, as in Pi's own pickers.
      if (this.query !== before) { this.selected = 0; this.scroll = 0; }
    }
  }

  invalidate(): void { this.input.invalidate(); }

  private visibleCount(): number { return Math.max(this.maxVisible, 1); }

  render(width: number): string[] {
    const rows = this.rows();
    this.selected = Math.min(this.selected, Math.max(rows.length - 1, 0));
    const visible = this.visibleCount();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
    this.scroll = Math.min(this.scroll, Math.max(rows.length - visible, 0));

    const title = style.bold(plainText(this.options.title)) + (this.options.subtitle ? style.dim(`  ${plainText(this.options.subtitle)}`) : '');
    const lines = [truncateToWidth(title, width)];
    lines.push(...this.input.render(width));
    lines.push('');

    const shown = rows.slice(this.scroll, this.scroll + visible);
    const markerWidth = Math.max(0, ...shown.map(item => visibleWidth(item.marker ?? '')));
    const titleWidth = Math.min(Math.max(0, ...shown.map(item => visibleWidth(plainText(item.title)))), Math.max(Math.floor(width * 0.4), 12));
    if (!rows.some(item => !item.pinned)) lines.push(style.dim(`  ${this.options.empty ?? 'Nothing matches.'}`));
    shown.forEach((item, index) => lines.push(this.renderRow(item, this.scroll + index === this.selected, width, markerWidth, titleWidth)));
    if (rows.length > visible) lines.push(style.dim(`  ${this.selected + 1}/${rows.length}`));
    lines.push('');
    lines.push(truncateToWidth(style.dim(`type to filter · ↑/↓ move · enter ${this.options.action ?? 'select'} · esc cancel`), width));
    return lines;
  }

  private renderRow(item: PickerItem<T>, selected: boolean, width: number, markerWidth: number, titleWidth: number): string {
    const lead = selected ? style.accent('› ') : '  ';
    const marker = markerWidth ? `${item.marker ?? ''}${' '.repeat(markerWidth - visibleWidth(item.marker ?? ''))} ` : '';
    const name = plainText(item.title);
    const titleText = item.detail === undefined ? name : truncateToWidth(name, titleWidth, '…', true);
    const titled = selected ? style.bold(titleText) : titleText;
    const right = item.right ? plainText(item.right) : '';
    const used = 2 + visibleWidth(marker) + visibleWidth(titleText);
    const room = width - used - (right ? visibleWidth(right) + 2 : 0) - 2;
    // Keep the end of a path: it is the most specific part.
    const detailText = item.detail ? plainText(item.detail) : '';
    const detail = detailText && room > 4 ? style.dim(visibleWidth(detailText) > room ? `…${detailText.slice(-(room - 1))}` : detailText) : '';
    const left = `${lead}${marker}${titled}${detail ? `  ${detail}` : ''}`;
    if (!right) return truncateToWidth(left, width);
    const gap = width - visibleWidth(left) - visibleWidth(right);
    return gap >= 2 ? `${left}${' '.repeat(gap)}${style.dim(right)}` : truncateToWidth(left, width);
  }
}

/** Show `picker` below the prompt until the user chooses (value) or cancels
 * (undefined). The picker's lines are erased afterwards. */
export async function runPicker<T>(picker: FuzzyPicker<T>, terminal: Terminal = new ProcessTerminal()): Promise<T | undefined> {
  const tui = new TuiMainScreen(terminal);
  return new Promise<T | undefined>(resolve => {
    let finished = false;
    const finish = (value?: T) => {
      if (finished) return; finished = true;
      // Erase only the picker's own lines. Rendering an empty TUI instead would make
      // pi-tui redraw the whole screen and clear the user's scrollback.
      const { hardwareCursorRow } = tui.captureRenderState();
      terminal.write(`${hardwareCursorRow > 0 ? `\x1b[${hardwareCursorRow}A` : ''}\r\x1b[J`);
      tui.stop({ preserveScreen: true });
      resolve(value);
    };
    picker.onSelect = value => finish(value);
    picker.onCancel = () => finish();
    // The picker must fit on screen: lines scrolled off the top could not be erased.
    picker.maxVisible = Math.max(Math.min(picker.maxVisible, terminal.rows - 8), 1);
    tui.addChild(picker);
    tui.setFocus(picker);
    tui.start();
    tui.requestRender();
  });
}

/** Relative age for lists: 40s, 12m, 3h, 2d. */
export function formatAge(from: string | number | Date, now = Date.now()): string {
  const seconds = Math.max(Math.floor((now - new Date(from).getTime()) / 1000), 0);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const STATUS_GLYPH: Record<NumberedSlot['status'], (text: string) => string> = { running: style.ok, starting: style.warn, exited: style.dim };

/** A slot as a picker row: number and status, session name, workspace, age, and clients. */
export function slotItem(slot: NumberedSlot, now = Date.now()): PickerItem<string> {
  const number = slotNumber(slot);
  const glyph = STATUS_GLYPH[slot.status](slot.status === 'exited' ? '○' : '●');
  const side = sideParentLabel(slot);
  const clients = slot.clients ? ` · ${slot.clients} attached` : '';
  return {
    value: slot.id,
    marker: `${number === undefined ? '' : `#${number}`} ${glyph}`.trim(),
    title: slot.sessionName || '(unnamed)',
    detail: side ? `${side} · ${slot.cwd}` : slot.cwd,
    right: `${slot.status === 'running' ? '' : `${slot.status} · `}${formatAge(slot.createdAt, now)}${clients}`,
    search: `#${number ?? ''} ${slot.sessionName ?? ''} ${side ?? ''} ${slot.cwd} ${slot.status}`,
    exact: number === undefined ? [slot.id] : [String(number), `#${number}`, slot.id],
  };
}
