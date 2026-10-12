/** Nerd Fonts nf-cod-remote, the VS Code remote indicator glyph. */
export const REMOTE_ICON = '\uEB3A';

/** Slot ownership is separate from Pi's session-file parentSession history. */
export function sideParentLabel(slot: { parentSlotId?: string; parentSlotNumber?: number }): string | undefined {
  if (!slot.parentSlotId) return undefined;
  return `side of ${slot.parentSlotNumber === undefined ? slot.parentSlotId.slice(0, 8) : `#${slot.parentSlotNumber}`}`;
}

/** Text for the user after the local UI closes. Remote work keeps running. */
export function detachMessage(slotId: string, slotNumber?: number): string {
  return `Detached from slot ${slotLabel(slotId, slotNumber)}`;
}

/** Text for the user after /quit stopped the remote Pi process and closed the local UI. */
export function stoppedMessage(slotId: string, slotNumber?: number): string {
  return `Stopped slot ${slotLabel(slotId, slotNumber)}`;
}

function slotLabel(slotId: string, slotNumber?: number): string {
  return slotNumber === undefined ? slotId : `${slotNumber} / ${slotId}`;
}
