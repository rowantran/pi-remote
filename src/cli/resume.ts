import type { SessionInfo } from '../protocol/methods.js';
import type { RemoteConnection, SlotInfo } from '../protocol/types.js';
import { FuzzyPicker, runPicker } from '../tui/fuzzy-picker.js';
import { sessionItems, sessionPickerOptions } from '../tui/session-table.js';
import { slotNumber, type NumberedSlot } from '../tui/slot-table.js';
import { terminalPaint } from '../tui/table.js';

/** Attach to the slot that already has the session open, or open a stored session in a new slot. */
export type ResumeChoice = { kind: 'attach'; slotId: string } | { kind: 'open'; cwd: string; sessionPath: string };
type Connection = Pick<RemoteConnection, 'request'>;
type Run = <T>(picker: FuzzyPicker<T>) => Promise<T | undefined>;

/** Stored sessions for one remote directory, without full message text. `sessionDir`
 * matches a `--session-dir` Pi option, as `/resume` uses the slot's. Daemons before
 * resume support only slot-scoped listing; say how to update them. */
export async function storedSessions(connection: Connection, cwd: string, sessionDir?: string): Promise<SessionInfo[]> {
  try { return await connection.request('sessions', { cwd, summary: true, ...(sessionDir ? { sessionDir } : {}) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/slotId/.test(message)) throw new Error('The remote daemon cannot list sessions without a slot. Deploy this release (npm run deploy -- HOST), then run pi-remote restart-daemon.');
    throw new Error(`Could not list sessions in ${cwd}: ${message}`);
  }
}

/**
 * The resume picker: the same rows that `/resume` shows in a slot started in `cwd`, so
 * `pi-remote resume` equals `pi-remote new` followed by `/resume`. Undefined means the
 * user cancelled.
 */
export async function pickResume(connection: Connection, options: { host?: string; cwd?: string; sessionDir?: string; run?: Run }): Promise<ResumeChoice | undefined> {
  const cwd = options.cwd;
  if (!cwd) throw new Error('resume lists the sessions of a directory. Use --cwd DIRECTORY, set PI_REMOTE_CWD, or add "cwd" to the config file; or reopen a stopped slot with resume SLOT.');
  const [sessions, slots] = await Promise.all([storedSessions(connection, cwd, options.sessionDir), connection.request('list')]);
  if (!sessions.length) throw new Error(`No saved sessions in ${cwd}. Pi saves a session after its first response.`);
  const p = terminalPaint();
  const choice = await (options.run ?? runPicker)(new FuzzyPicker(sessionItems(sessions, slots, p), sessionPickerOptions(p, [options.host ?? 'local', cwd].join(' · '))));
  if (!choice) return undefined;
  return choice.openIn ? { kind: 'attach', slotId: choice.openIn } : { kind: 'open', cwd, sessionPath: choice.path };
}

/** `resume SLOT`: reopen a stopped slot's session, or attach if the slot still runs. */
export function resumeSlot(slot: NumberedSlot): ResumeChoice {
  if (slot.status !== 'exited') return { kind: 'attach', slotId: slot.id };
  if (!slot.sessionFile) throw new Error(`Slot ${slotNumber(slot) ?? slot.id} has no saved session to resume.`);
  return { kind: 'open', cwd: slot.cwd, sessionPath: slot.sessionFile };
}

/** Open a stored session in a new slot. If another slot opened it meanwhile, attach
 * there instead; a session must never run in two Pi processes. */
export async function openSession(connection: Connection, choice: Extract<ResumeChoice, { kind: 'open' }>, args: string[] = []): Promise<{ slotId: string; slot?: SlotInfo; existing: boolean }> {
  try {
    const slot = await connection.request('create', { cwd: choice.cwd, args, sessionPath: choice.sessionPath });
    return { slotId: slot.id, slot, existing: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const owner = /already open in slot ([0-9a-f-]+)/.exec(message)?.[1];
    if (owner) return { slotId: owner, existing: true };
    if (/ENOENT/.test(message)) throw new Error(`The session file ${choice.sessionPath} does not exist. Pi saves a session after its first response; start a new session instead.`);
    throw error;
  }
}
