import type { PiExtensionMessage } from '../protocol/pi-extension.js';

type TerminalMessage = Extract<PiExtensionMessage, { type: 'terminal' }>;
const MAX_PENDING = 64 * 1024;

/**
 * Finds the parts of Pi's PTY output that a real terminal acts on, apart from drawing: a
 * bell, the window title (OSC 0/2), notifications (OSC 9, OSC 777), progress (OSC 9;4) and
 * clipboard writes (OSC 52). The host discards everything else; the client draws the screen.
 */
export class TerminalOutputFilter {
  private pending = '';

  feed(data: string): TerminalMessage[] {
    const text = this.pending + data;
    this.pending = '';
    const found: TerminalMessage[] = [];
    let index = 0;
    while (index < text.length) {
      const bell = text.indexOf('\x07', index);
      const escape = text.indexOf('\x1b]', index);
      if (escape === -1 || (bell !== -1 && bell < escape)) {
        if (bell === -1) break;
        found.push({ type: 'terminal', kind: 'bell', data: '\x07' });
        index = bell + 1;
        continue;
      }
      // An OSC sequence ends with BEL or ST (ESC \).
      const bel = text.indexOf('\x07', escape + 2), st = text.indexOf('\x1b\\', escape + 2);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) {
        // Keep an unfinished sequence for the next read, within a bound.
        const rest = text.slice(escape);
        if (rest.length <= MAX_PENDING) this.pending = rest;
        break;
      }
      const sequence = text.slice(escape, end + (end === st ? 2 : 1));
      const kind = oscKind(text.slice(escape + 2, end));
      if (kind) found.push({ type: 'terminal', kind, data: sequence });
      index = escape + sequence.length;
    }
    return found;
  }
}

function oscKind(body: string): TerminalMessage['kind'] | undefined {
  const code = body.slice(0, body.indexOf(';') === -1 ? body.length : body.indexOf(';'));
  if (body.endsWith(';?')) return undefined; // A query; the host answers those.
  if (code === '0' || code === '2') return 'title';
  if (code === '52') return 'clipboard';
  if (code === '9') return body.startsWith('9;4;') ? 'progress' : 'notify';
  if (code === '777') return 'notify';
  return undefined;
}
