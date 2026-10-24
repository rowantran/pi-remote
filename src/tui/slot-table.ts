import type { SlotInfo } from '../protocol/types.js';
import type { PickerItem } from './fuzzy-picker.js';
import { sideParentLabel } from './session-labels.js';
import { paint, plainText, layoutTable, type Column, type Paint } from './table.js';

export type NumberedSlot = SlotInfo & { number?: number };

export function slotNumber(slot: NumberedSlot): number | undefined {
  return Number.isSafeInteger(slot.number) && slot.number! > 0 ? slot.number : undefined;
}
/** Old daemons only append slots and retain exited entries, so insertion order
 * supplies the same short reference until the new daemon persists numbers. */
export function numberSlots(slots: NumberedSlot[]): NumberedSlot[] {
  return slots.map((slot, index) => ({ ...slot, number: slotNumber(slot) ?? index + 1 }));
}

/** Relative age for lists: 40s, 12m, 3h, 2d. Empty for a missing time. */
export function formatAge(from: string | number | Date, now = Date.now()): string {
  const time = new Date(from).getTime();
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(Math.floor((now - time) / 1000), 0);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Parents before their side slots, in slot order. Malformed cycles still list every slot. */
export function orderSlots(slots: readonly NumberedSlot[]): { slot: NumberedSlot; depth: number }[] {
  const ordered: { slot: NumberedSlot; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (slot: NumberedSlot, depth: number) => {
    if (seen.has(slot.id)) return;
    seen.add(slot.id); ordered.push({ slot, depth });
    for (const child of slots) if (child.parentSlotId === slot.id) visit(child, depth + 1);
  };
  const ids = new Set(slots.map(slot => slot.id));
  for (const slot of slots) if (!slot.parentSlotId || !ids.has(slot.parentSlotId)) visit(slot, 0);
  for (const slot of slots) visit(slot, 0);
  return ordered;
}

/** Number, status, session name, workspace, attached clients, age, and short UUID. */
export function slotColumns(p: Paint): Column[] {
  return [{ align: 'right' }, {}, { shrink: 'keep-start' }, { shrink: 'keep-end', style: p.dim }, {}, { style: p.dim }, { style: p.dim }];
}
const GLYPH: Record<SlotInfo['status'], [string, keyof Paint]> = { running: ['●', 'ok'], starting: ['●', 'warn'], exited: ['○', 'dim'] };

/** One slot's cells. `ls` and the slot pickers both use these, so they show the same facts. */
export function slotCells(slot: NumberedSlot, depth: number, p: Paint, now = Date.now()): string[] {
  const [glyph, color] = GLYPH[slot.status] ?? ['?', 'dim'];
  const side = sideParentLabel(slot);
  return [
    String(slotNumber(slot) ?? '-'),
    `${p[color](glyph)} ${slot.status}`,
    `${'  '.repeat(depth)}${plainText(slot.sessionName || '(unnamed)')}${side ? ` (${side})` : ''}`,
    plainText(slot.cwd),
    slot.clients ? `${slot.clients} client${slot.clients === 1 ? '' : 's'}` : '',
    formatAge(slot.createdAt, now),
    slot.id.slice(0, 8),
  ];
}

/** `ls`: the slot table, then how many stopped slots are hidden. */
export function formatSlotList(slots: NumberedSlot[], hidden = 0, p: Paint = paint(false), now = Date.now(), width?: number): string {
  const ordered = orderSlots(slots);
  const table = layoutTable(ordered.map(({ slot, depth }) => slotCells(slot, depth, p, now)), slotColumns(p), width);
  const lines = ordered.flatMap(({ slot }, index) => [`  ${table[index]}`, ...(slot.error ? [`    ${p.dim(plainText(slot.error))}`] : [])]);
  if (!slots.length) lines.push(hidden ? 'No active slots. Create one with new --cwd DIRECTORY.' : 'No slots. Create one with new --cwd DIRECTORY.');
  if (hidden) lines.push(`${hidden} stopped slot${hidden === 1 ? '' : 's'} hidden. Use ls --all to show ${hidden === 1 ? 'it' : 'them'}.`);
  return lines.join('\n');
}

/** The line above `ls` and the subtitle of the slot pickers: host and slot counts. */
export function listSummary(host: string, slots: readonly SlotInfo[]): string {
  const running = slots.filter(slot => slot.status !== 'exited').length;
  return `${plainText(host)} · ${running} running · ${slots.length - running} stopped`;
}

/** Slot picker rows: the same cells and order as `ls`, searchable by every field. */
export function slotItems(slots: NumberedSlot[], p: Paint, now = Date.now()): PickerItem<string>[] {
  return orderSlots(numberSlots(slots)).map(({ slot, depth }) => {
    const number = slotNumber(slot);
    return {
      value: slot.id,
      cells: slotCells(slot, depth, p, now),
      note: slot.error,
      search: `#${number ?? ''} ${slot.sessionName ?? ''} ${sideParentLabel(slot) ?? ''} ${slot.cwd} ${slot.status} ${slot.id}`,
      exact: number === undefined ? [slot.id] : [String(number), `#${number}`, slot.id],
    };
  });
}
