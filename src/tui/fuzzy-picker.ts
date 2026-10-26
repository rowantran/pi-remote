import {
  type Component, type Focusable, fuzzyFilter, Input, Key, matchesKey, ProcessTerminal, type Terminal,
  TuiMainScreen, truncateToWidth,
} from '@earendil-works/pi-tui';
import { layoutTable, paint, plainText, type Column, type Paint } from './table.js';

/**
 * One picker row. Normal rows are table cells laid out like the matching list command
 * (for example `ls`), so a picker never shows less than the list. `pinned` rows are
 * actions such as "New session": they stay below the matches whatever the query.
 */
export interface PickerItem<T> {
  value: T;
  /** Table cells for normal rows; styles are allowed in columns that do not shrink. */
  cells?: string[];
  /** Pinned action rows: a short marker, a label, and dim detail. */
  marker?: string;
  label?: string;
  detail?: string;
  /** A dim second line, for example a slot error. */
  note?: string;
  /** Text matched by the fuzzy filter. */
  search: string;
  /** Queries that rank this row first, for example its slot number. */
  exact?: string[];
  pinned?: boolean;
}

export interface PickerOptions {
  title: string;
  /** Dim text after the title, for example the host and slot counts. */
  subtitle?: string;
  placeholder?: string;
  /** Shown when no normal row matches the query. */
  empty?: string;
  /** Verb for Enter in the key hints. */
  action?: string;
  /** Layout of `cells`; shared with the matching list command. */
  columns?: readonly Column[];
  /** Rows of the list shown at once. */
  maxVisible?: number;
  paint?: Paint;
}

/**
 * A fuzzy finder: a title, a query line, matching rows, then key hints. It is a plain
 * component, so the same picker runs below a shell prompt (`runPicker`) and inside the
 * attached terminal UI.
 */
export class FuzzyPicker<T> implements Component, Focusable {
  private readonly input: Input;
  private readonly paint: Paint;
  private selected = 0;
  private scroll = 0;
  /** Rows of the list shown at once; hosts lower it to fit their screen. */
  maxVisible: number;
  onSelect?: (value: T) => void;
  onCancel?: () => void;

  constructor(private readonly items: PickerItem<T>[], private readonly options: PickerOptions) {
    this.paint = options.paint ?? paint(true);
    this.input = new Input({ prompt: this.paint.accent('❯ '), placeholder: options.placeholder ?? 'Type to search', placeholderStyle: this.paint.dim });
    this.input.focused = true;
    this.maxVisible = options.maxVisible ?? 10;
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  get query(): string { return this.input.getValue(); }

  /** Exact matches first, then fuzzy matches by score, then pinned rows. */
  rows(): PickerItem<T>[] {
    const query = this.query.trim();
    const normal = this.items.filter(item => !item.pinned);
    const exact = query ? normal.filter(item => item.exact?.includes(query)) : [];
    const fuzzy = fuzzyFilter(normal, query, item => item.search).filter(item => !exact.includes(item));
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
    const p = this.paint;
    const rows = this.rows();
    this.selected = Math.min(this.selected, Math.max(rows.length - 1, 0));
    const visible = this.visibleCount();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
    this.scroll = Math.min(this.scroll, Math.max(rows.length - visible, 0));

    const title = p.bold(plainText(this.options.title)) + (this.options.subtitle ? p.dim(`  ${plainText(this.options.subtitle)}`) : '');
    const lines = [truncateToWidth(title, width), ...this.input.render(width), ''];

    // Lay out every normal row, not only matches, so columns stay put while typing.
    const normal = this.items.filter(item => !item.pinned);
    const columns = this.options.columns ?? Array.from({ length: Math.max(0, ...normal.map(item => item.cells?.length ?? 0)) }, () => ({}));
    const laid = layoutTable(normal.map(item => item.cells ?? []), columns, Math.max(width - 2, 1));
    const lineOf = new Map(normal.map((item, index) => [item, laid[index]!]));
    if (!rows.some(item => !item.pinned)) lines.push(p.dim(`  ${this.options.empty ?? 'Nothing matches.'}`));
    rows.slice(this.scroll, this.scroll + visible).forEach((item, offset) => {
      const selected = this.scroll + offset === this.selected;
      const lead = selected ? p.accent('› ') : '  ';
      const body = item.pinned
        ? `${item.marker ? `${item.marker} ` : ''}${selected ? p.bold(plainText(item.label ?? '')) : plainText(item.label ?? '')}${item.detail ? `  ${p.dim(plainText(item.detail))}` : ''}`
        : lineOf.get(item) ?? '';
      lines.push(truncateToWidth(lead + body, width));
      if (item.note) lines.push(truncateToWidth(`    ${p.dim(plainText(item.note))}`, width));
    });
    if (rows.length > visible) lines.push(p.dim(`  ${this.selected + 1}/${rows.length}`));
    lines.push('', truncateToWidth(p.dim(`type to search · ↑/↓ move · enter ${this.options.action ?? 'select'} · esc cancel`), width));
    return lines;
  }
}

/** Show `picker` below the shell prompt until the user chooses (value) or cancels
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
    // Rows can carry a note line, so allow two lines per row.
    picker.maxVisible = Math.max(Math.min(picker.maxVisible, Math.floor((terminal.rows - 8) / 2)), 1);
    tui.addChild(picker);
    tui.setFocus(picker);
    tui.start();
    tui.requestRender();
  });
}
