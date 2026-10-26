import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/** Optional ANSI styling. Disabled for pipes and NO_COLOR. Each style resets only its
 * own attribute, so styled text can sit inside other styled text. */
export interface Paint {
  bold(text: string): string; dim(text: string): string; accent(text: string): string;
  ok(text: string): string; warn(text: string): string; error(text: string): string;
}
const sgr = (on: string, off: string) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
const COLOR: Paint = { bold: sgr('1', '22'), dim: sgr('2', '22'), accent: sgr('36', '39'), ok: sgr('32', '39'), warn: sgr('33', '39'), error: sgr('31', '39') };
const PLAIN: Paint = { bold: text => text, dim: text => text, accent: text => text, ok: text => text, warn: text => text, error: text => text };
export function paint(enabled: boolean): Paint { return enabled ? COLOR : PLAIN; }
/** Color for a local terminal unless NO_COLOR is set. */
export function terminalPaint(stream: { isTTY?: boolean } = process.stdout): Paint {
  return paint(Boolean(stream.isTTY) && !process.env.NO_COLOR);
}

/** Remote names, paths, and session titles are data. Never let them drive the terminal. */
export const plainText = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

export interface Column {
  align?: 'left' | 'right';
  /** How a column gives up width when the table is too wide: keep the end (paths) or
   * the start (names). Columns without it never shrink. Shrinking cells must be plain. */
  shrink?: 'keep-end' | 'keep-start';
  /** Applied after fitting, so truncation never cuts a style sequence. */
  style?: (text: string) => string;
}
const MIN_SHRUNK = 8;

/** Fit `text` to `width` cells, keeping its start or end. */
export function fitText(text: string, width: number, keep: 'keep-end' | 'keep-start' = 'keep-start'): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? '…' : '';
  if (keep === 'keep-start') return truncateToWidth(text, width, '…');
  const chars = [...text];
  let tail = '';
  for (let index = chars.length - 1; index >= 0 && visibleWidth(chars[index] + tail) <= width - 1; index--) tail = chars[index] + tail;
  return `…${tail}`;
}

/**
 * Align rows into columns separated by two spaces. Widths come from all rows, so a
 * filtered subset keeps the same layout. Empty columns take no space. With `width`,
 * shrinking columns give up space, widest first, down to a minimum.
 */
export function layoutTable(rows: readonly (readonly string[])[], columns: readonly Column[], width = Infinity): string[] {
  const widths = columns.map((_, index) => Math.max(0, ...rows.map(row => visibleWidth(row[index] ?? ''))));
  const total = () => widths.reduce((sum, value) => sum + value, 0) + 2 * Math.max(widths.filter(Boolean).length - 1, 0);
  let excess = total() - width;
  while (excess > 0) {
    const candidates = columns.map((column, index) => ({ column, index })).filter(({ column, index }) => column.shrink && widths[index]! > MIN_SHRUNK);
    if (!candidates.length) break;
    const widest = candidates.reduce((best, next) => widths[next.index]! > widths[best.index]! ? next : best);
    const cut = Math.min(excess, widths[widest.index]! - MIN_SHRUNK, Math.max(Math.ceil(excess / candidates.length), 1));
    widths[widest.index] = widths[widest.index]! - cut; excess -= cut;
  }
  const last = widths.findLastIndex(value => value > 0);
  return rows.map(row => columns.flatMap((column, index) => {
    const cellWidth = widths[index]!;
    if (!cellWidth) return [];
    const cell = column.shrink ? fitText(row[index] ?? '', cellWidth, column.shrink) : row[index] ?? '';
    const pad = ' '.repeat(Math.max(cellWidth - visibleWidth(cell), 0));
    const styled = column.style && cell ? column.style(cell) : cell;
    if (column.align === 'right') return [pad + styled];
    return [index === last ? styled : styled + pad];
  }).join('  ').trimEnd());
}
