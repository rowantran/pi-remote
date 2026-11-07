/**
 * pi-remote's API for other Pi extensions in a slot. Keep this file free of imports: it is
 * the contract that extensions in other packages copy.
 *
 * Find it with a synchronous event. Nothing answers outside a pi-remote slot:
 *
 *   let remote: PiRemoteApi | undefined;
 *   pi.events.emit(PI_REMOTE_API_EVENT, { respond: (api: PiRemoteApi) => { remote = api; } });
 */
export const PI_REMOTE_API_EVENT = 'pi-remote:api';

export interface PiRemoteApi {
  /** Changes only when an existing member changes incompatibly. */
  readonly version: 1;
  /** The slot this Pi runs in. */
  readonly slotId: string;
  readonly slotNumber?: number;
  /**
   * Start a child slot of this slot: a new Pi process in the same directory, with the same
   * Pi options, that opens `sessionFile`. `sessionDir` replaces the session directory, so
   * /resume, /new and /fork in the child use it. `prompt` is sent once, as the child's first
   * message. `pi-remote ls` lists the child under this slot. It stops when this slot stops,
   * and 90 seconds after its last client leaves, once it is idle.
   *
   * Rejects when no slot was started. Resolves with `error` when the slot started but exited.
   */
  createChildSlot(options: { sessionFile: string; sessionDir?: string; prompt?: string }): Promise<{ slotId: string; slotNumber?: number; error?: string }>;
  /**
   * Ask the pi-remote client where the user typed or resized last to open a pane attached to
   * `slotId` (a Ghostty split on macOS, or a Rex split). Resolves once the pane is open; rejects with the
   * reason otherwise, for example another terminal or the phone.
   */
  openSlot(options: { slotId: string }): Promise<void>;
}
