/**
 * Ctrl+Z in every encoding Pi accepts: the legacy control byte, xterm modifyOtherKeys, and
 * kitty CSI u with any event type, alternate keys, or Caps Lock or Num Lock. CSI u keys are
 * matched in `isCtrlZ`.
 */
const KEYS = /\x1a|\x1b\[27;5;122~|\x1b\[(\d+)(?::(\d*))?(?::(\d+))?;(\d+)(?::\d+)?u/g;
const Z = 122;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const CTRL = 4;
const LOCKS = 64 + 128;

/**
 * Removes Ctrl+Z from client input before it reaches Pi. Pi's suspend key stops its
 * terminal handling and sends itself SIGTSTP. Pi runs as a session leader with no shell,
 * so the kernel discards that signal: Pi never stops, never gets SIGCONT, and stops
 * reading its terminal until someone sends SIGCONT by hand. Bracketed pastes pass through
 * unchanged.
 */
export class SuspendKeyFilter {
  private inPaste = false;

  filter(data: string): string {
    let result = '';
    let index = 0;
    while (index < data.length) {
      const marker = this.inPaste ? PASTE_END : PASTE_START;
      const found = data.indexOf(marker, index);
      const end = found === -1 ? data.length : found + marker.length;
      const part = data.slice(index, end);
      result += this.inPaste ? part : removeCtrlZ(part);
      if (found !== -1) this.inPaste = !this.inPaste;
      index = end;
    }
    return result;
  }
}

function removeCtrlZ(data: string): string {
  return data.replace(KEYS, (key, codepoint?: string, _shifted?: string, base?: string, modifier?: string) =>
    codepoint === undefined || isCtrlZ(Number(codepoint), base === undefined ? undefined : Number(base), Number(modifier)) ? '' : key);
}

/** Like Pi: the base layout key counts only when the key itself is not ASCII (a non-Latin layout). */
function isCtrlZ(codepoint: number, base: number | undefined, modifier: number): boolean {
  if (((modifier - 1) & ~LOCKS) !== CTRL) return false;
  return codepoint === Z || (base === Z && codepoint > 127);
}
