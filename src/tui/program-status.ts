import { isProgramStatusClear, PROGRAM_STATUS_CLEAR } from '../protocol/pi-extension.js';

/**
 * Whether this client left a program status record (OSC 7501) on the local terminal. Pi
 * clears its record when it exits, but a client that detaches, loses the connection or
 * attaches to a restarted Pi must clear the record it forwarded itself, or the terminal
 * shows a stale "working" or "blocked" state.
 */
export class ForwardedProgramStatus {
  private set = false;

  get active(): boolean { return this.set; }

  /** Note a status report written to the local terminal. */
  wrote(data: string): void { this.set = !isProgramStatusClear(data); }

  /** The sequence that removes the forwarded record, or '' when there is none. Forgets the record. */
  clear(): string {
    const sequence = this.set ? PROGRAM_STATUS_CLEAR : '';
    this.set = false;
    return sequence;
  }
}
