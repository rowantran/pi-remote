import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/** Cache only the pure width check, not component rendering: timers and adapters stay live. */
export class WidthCache {
  private previous?: { width: number; source: string[]; output: string[] };

  clear(): void { this.previous = undefined; }

  clamp(lines: string[], width: number): string[] {
    const previous = this.previous?.width === width ? this.previous : undefined;
    let unchanged = previous?.source.length === lines.length;
    const output = lines.map((line, index) => {
      if (previous?.source[index] === line) return previous.output[index];
      unchanged = false;
      // Pi's styled ASCII width calculation is much cheaper than truncation, which
      // segments every grapheme even when the line already fits the available width.
      return width > 0 && visibleWidth(line) <= width ? line : truncateToWidth(line, width, '');
    });
    if (unchanged && previous) return previous.output;
    // Components may reuse and mutate their arrays. Keep a separate source snapshot,
    // bounded to the most recent render rather than retaining every streamed line.
    this.previous = { width, source: lines.slice(), output };
    return output;
  }
}
