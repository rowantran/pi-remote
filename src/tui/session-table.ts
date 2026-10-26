import { resolve } from 'node:path';
import type { SessionInfo } from '../protocol/methods.js';
import type { PickerItem, PickerOptions } from './fuzzy-picker.js';
import { formatAge, numberSlots, slotNumber, type NumberedSlot } from './slot-table.js';
import { plainText, type Column, type Paint } from './table.js';

/** A stored session to open, and the running slot that already has it open, if any. */
export interface SessionChoice { path: string; openIn?: string }

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);
const key = (path: string) => resolve(path);

/** Name or first message, message count, age, and the slot that has or had the session. */
export function sessionColumns(p: Paint): Column[] {
  return [{ shrink: 'keep-start' }, { align: 'right', style: p.dim }, { align: 'right', style: p.dim }, {}];
}

/**
 * Rows of every resume picker: `pi-remote resume` and `/resume` in an attached slot
 * list the same sessions (one workspace, in Pi's order, newest first) with the same cells.
 * A session that a running slot has open is marked, so it is attached rather than opened
 * twice. A session last open in a stopped slot shows that slot's number, which also
 * finds the row (type `4` for `pi-remote resume 4`).
 */
export function sessionItems(sessions: readonly SessionInfo[], slots: NumberedSlot[], p: Paint, options: { currentSlotId?: string; now?: number } = {}): PickerItem<SessionChoice>[] {
  const running = new Map<string, NumberedSlot>();
  const stopped = new Map<string, NumberedSlot>();
  for (const slot of numberSlots(slots)) {
    if (!slot.sessionFile) continue;
    const owners = slot.status === 'exited' ? stopped : running;
    const previous = owners.get(key(slot.sessionFile));
    // The newest stopped slot is the one `resume N` users remember.
    if (!previous || Date.parse(slot.createdAt) > Date.parse(previous.createdAt)) owners.set(key(slot.sessionFile), slot);
  }
  return sessions.map(session => {
    const open = running.get(key(session.path));
    const last = stopped.get(key(session.path));
    const owner = open ?? last;
    const number = owner ? slotNumber(owner) : undefined;
    const first = oneLine(session.firstMessage ?? '');
    const title = plainText(session.name || first || session.id);
    const where = !owner ? '' : open
      ? `${p.ok('●')} ${open.id === options.currentSlotId ? 'this slot' : `open in #${number}`}`
      : `${p.dim('○')} stopped #${number}`;
    return {
      value: { path: session.path, ...(open ? { openIn: open.id } : {}) },
      cells: [title, `${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`, formatAge(session.modified, options.now), where],
      search: `${session.name ?? ''} ${first} ${session.id}${number === undefined ? '' : ` #${number}`}`,
      ...(number === undefined ? {} : { exact: [String(number), `#${number}`] }),
    };
  });
}

/** Picker options shared by both resume pickers. */
export function sessionPickerOptions(p: Paint, subtitle: string, title = 'Resume a session'): PickerOptions {
  return { title, subtitle, action: 'resume', empty: 'No sessions match.', placeholder: 'Search by name, first message, or slot number', columns: sessionColumns(p), paint: p };
}
