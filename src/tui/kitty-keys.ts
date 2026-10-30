import { isKittyProtocolActive, parseKey } from '@earendil-works/pi-tui';

/** Escape-sequence forms for keys that keep a CSI form in the kitty protocol. */
const FUNCTIONAL: Record<string, [string, string]> = {
  up: ['1', 'A'], down: ['1', 'B'], right: ['1', 'C'], left: ['1', 'D'], home: ['1', 'H'], end: ['1', 'F'],
  f1: ['1', 'P'], f2: ['1', 'Q'], f3: ['1', 'R'], f4: ['1', 'S'],
  insert: ['2', '~'], delete: ['3', '~'], pageUp: ['5', '~'], pageDown: ['6', '~'],
  f5: ['15', '~'], f6: ['17', '~'], f7: ['18', '~'], f8: ['19', '~'], f9: ['20', '~'], f10: ['21', '~'], f11: ['23', '~'], f12: ['24', '~'],
};
const CODES: Record<string, number> = { escape: 27, enter: 13, tab: 9, backspace: 127, space: 32 };
const MODIFIERS: Record<string, number> = { shift: 1, alt: 2, ctrl: 4, super: 8 };

/**
 * Pi in a slot uses the kitty keyboard protocol. A local terminal without it sends
 * legacy sequences, some of which mean other keys under that protocol (for example ESC b
 * is Alt+Left in legacy terminals and Alt+B in kitty). Re-encode each legacy key as the
 * kitty sequence for the same key. Text, pastes and unknown sequences pass through.
 */
export function toKittyInput(data: string, kittyActive = isKittyProtocolActive()): string {
  if (kittyActive || data.startsWith('\x1b[200~')) return data;
  // A lone LF is Ctrl+J in a legacy terminal, which Pi binds to a new line.
  if (data === '\n') return '\x1b[106;5u';
  const key = parseKey(data);
  if (!key) return data;
  const parts = key.split('+');
  let modifier = 0;
  while (parts.length > 1 && MODIFIERS[parts[0]!] !== undefined) modifier |= MODIFIERS[parts.shift()!]!;
  const base = parts.join('+');
  const functional = FUNCTIONAL[base];
  if (functional) {
    if (!modifier) return data;
    const [number, final] = functional;
    return final === '~' ? `\x1b[${number};${modifier + 1}~` : `\x1b[1;${modifier + 1}${final}`;
  }
  const code = CODES[base] ?? (Array.from(base).length === 1 ? base.toLowerCase().codePointAt(0) : undefined);
  if (code === undefined) return data;
  // Unmodified Enter, Tab and Backspace keep their legacy bytes in the kitty protocol.
  if (!modifier && base !== 'escape') return data;
  if (modifier === MODIFIERS.shift && CODES[base] === undefined) return data; // Shifted text is text.
  return `\x1b[${code}${modifier ? `;${modifier + 1}` : ''}u`;
}
