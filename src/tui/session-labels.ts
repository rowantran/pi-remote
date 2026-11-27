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
  return `Stopped slot ${slotLabel(slotId, slotNumber)}. Resume it with: pi-remote resume ${slotNumber ?? slotId}`;
}

function slotLabel(slotId: string, slotNumber?: number): string {
  return slotNumber === undefined ? slotId : `${slotNumber} / ${slotId}`;
}

/**
 * The most useful line of a connection error. SSH's own explanation, such as "Timeout, server
 * rowan-v2-dev not responding.", comes after pi-remote's summary of how SSH ended.
 */
export function connectionProblem(error: Error): string {
  const lines = error.message.split(/[\r\n\u2028\u2029]+/).map(line => line.trim()).filter(Boolean);
  const problem = lines.at(-1) ?? 'Connection closed';
  return /[.!?…]$/.test(problem) ? problem : `${problem}.`;
}
