import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';

export const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*m/g, '');
type Run = { style: Record<string, string | boolean>; text: string };

/** Resolve terminal attributes before cropping. Equivalent SGR encodings compare
 * equal; foreground/background colors and text attributes compare exactly. */
export function canonicalLines(ansi: string): string[] {
  let state: Run['style'] = {};
  return ansi.replace(/\n$/, '').split('\n').map(line => {
    const runs: Run[] = [];
    let cursor = 0;
    for (const match of line.matchAll(/\x1b\[([0-9;:]*)m/g)) {
      if (match.index! > cursor) runs.push({ style: { ...state }, text: line.slice(cursor, match.index) });
      const codes = (match[1] || '0').split(/[;:]/).map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) state = {};
        else if (code === 1) state.bold = true;
        else if (code === 2) state.dim = true;
        else if (code === 3) state.italic = true;
        else if (code === 4) state.underline = true;
        else if (code === 5) state.blink = true;
        else if (code === 7) state.inverse = true;
        else if (code === 8) state.hidden = true;
        else if (code === 9) state.strike = true;
        else if (code === 22) { delete state.bold; delete state.dim; }
        else if (code === 23) delete state.italic;
        else if (code === 24) delete state.underline;
        else if (code === 25) delete state.blink;
        else if (code === 27) delete state.inverse;
        else if (code === 28) delete state.hidden;
        else if (code === 29) delete state.strike;
        else if (code === 39) delete state.fg;
        else if (code === 49) delete state.bg;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.fg = `ansi:${code}`;
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.bg = `ansi:${code}`;
        else if (code === 38 || code === 48) {
          const key = code === 38 ? 'fg' : 'bg';
          const mode = codes[++i];
          if (mode === 5) state[key] = `palette:${codes[++i]}`;
          else if (mode === 2) { state[key] = `rgb:${codes.slice(i + 1, i + 4).join(',')}`; i += 3; }
          else throw new Error(`Unsupported tmux SGR color: ${match[0]}`);
        } else throw new Error(`Unsupported tmux SGR attribute ${code}`);
      }
      cursor = match.index! + match[0].length;
    }
    if (cursor < line.length) runs.push({ style: { ...state }, text: line.slice(cursor) });
    // Background-less trailing spaces are visually empty. Colored spaces are not.
    while (runs.length && !runs.at(-1)!.style.bg && !runs.at(-1)!.style.inverse && !runs.at(-1)!.style.underline && !runs.at(-1)!.style.strike) {
      runs.at(-1)!.text = runs.at(-1)!.text.trimEnd();
      if (runs.at(-1)!.text) break;
      runs.pop();
    }
    const merged: Run[] = [];
    for (const run of runs) {
      run.style = Object.fromEntries(Object.entries(run.style).sort(([a], [b]) => a.localeCompare(b)));
      if (merged.length && JSON.stringify(merged.at(-1)!.style) === JSON.stringify(run.style)) merged.at(-1)!.text += run.text;
      else merged.push(run);
    }
    return JSON.stringify(merged);
  });
}

/** Each output line stands alone; raw capture SGR can otherwise inherit from a
 * previous screen row or leak across the side-by-side separator. */
export function lineToAnsi(canonical: string): string {
  const attrs: Record<string, number> = { bold: 1, dim: 2, italic: 3, underline: 4, blink: 5, inverse: 7, hidden: 8, strike: 9 };
  const runs: Run[] = JSON.parse(canonical);
  return runs.map(({ style, text }) => {
    const codes = [0];
    for (const [key, value] of Object.entries(style)) {
      if (value === true) codes.push(attrs[key]);
      else if (typeof value === 'string') {
        const [kind, color] = value.split(':');
        if (kind === 'ansi') codes.push(Number(color));
        else codes.push(key === 'fg' ? 38 : 48, kind === 'rgb' ? 2 : 5, ...color.split(',').map(Number));
      }
    }
    return `\x1b[${codes.join(';')}m${text}`;
  }).join('') + '\x1b[0m';
}

export function crop(ansi: string, rows: number) {
  const full = ansi.replace(/\n$/, '').split('\n');
  const plain = full.map(strip);
  const canonical = canonicalLines(ansi);
  let start = plain.findIndex(line => line.includes('GOLDEN_USER'));
  assert.ok(start >= 0, 'GOLDEN_USER not visible: transcript is clipped or prompt failed');
  // A user's colored top padding is transcript content. Startup blanks are not.
  while (start > 0 && !plain[start - 1].trim() && canonical[start - 1] !== '[]') start--;
  if (start > 0 && plain[start - 1].trim() === 'You') start--; // Old remote heading.
  // The last two borders belong to the editor. Earlier ones can be bash panels.
  const borders = plain.flatMap((line, i) => i > start && /^[─━]{2}/u.test(line.trimStart()) ? [i] : []);
  let end = borders.at(-2) ?? -1;
  assert.ok(end > start, 'Cannot find editor border after transcript');
  // Pi's custom-editor spinner and the remote client's working label sit above
  // the editor border. They are prompt UI, separated from the transcript.
  const working = plain.findIndex((line, i) => i > start + 3 && /^\s*(?:[\u2800-\u28ff]\s+Working|Working…)\s*$/.test(line)
    && canonical.slice(i - 3, i).every(row => row === '[]'));
  if (working >= 0 && working < end) end = working;
  while (end > start && canonical[end - 1] === '[]') end--;
  assert.ok(end - start < rows - 12, 'Transcript might be clipped; increase --rows');
  const selected = Array.from({ length: end - start }, (_, i) => i + start);
  // Temporary application notifications are not persisted transcript messages.
  for (let i = selected.length - 1; i >= 0; i--) {
    if (/^\s*(?:Tool output: (?:expanded|collapsed)|Thinking blocks: (?:hidden|visible|shown))\s*$/.test(plain[selected[i]])) {
      selected.splice(i, 1);
      if (i > 0 && canonical[selected[i - 1]] === '[]') { selected.splice(i - 1, 1); i--; }
    }
  }
  while (selected.length && canonical[selected.at(-1)!] === '[]') selected.pop();
  // Wall-clock labels are the only normalized transcript metadata. Retain their
  // exact styles and all raw captures. Under this short fixture durations are <10s.
  const normalized = full.map((line, i) => /^\s*(?:Took|Elapsed) \d\.\ds\s*$/.test(plain[i])
    ? line.replace(/((?:Took|Elapsed) )\d\.\ds/, (_match, prefix) => `${prefix}0.0s`) : line).join('\n') + '\n';
  const normalizedCanonical = canonicalLines(normalized);
  return {
    ansi: `${selected.map(i => lineToAnsi(canonical[i])).join('\n')}\n`,
    text: `${selected.map(i => plain[i].trimEnd()).join('\n')}\n`,
    canonical: `${selected.map(i => normalizedCanonical[i]).join('\n')}\n`, start, end,
  };
}

export function sideBySide(left: string, right: string, width: number, ansi = false) {
  const a = left.replace(/\n$/, '').split('\n'), b = right.replace(/\n$/, '').split('\n');
  const reset = ansi ? '\x1b[0m' : '';
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
    `${a[i] ?? ''}${reset}${' '.repeat(Math.max(0, width - visibleWidth(a[i] ?? '')))} │ ${b[i] ?? ''}${reset}`).join('\n') + '\n';
}
