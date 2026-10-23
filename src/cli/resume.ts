import { resolve } from 'node:path';
import type { SessionInfo } from '../protocol/methods.js';
import type { RemoteConnection, SlotInfo } from '../protocol/types.js';
import { numberSlots, slotNumber, type NumberedSlot } from './completion.js';
import { FuzzyPicker, formatAge, runPicker, style, type PickerItem } from './picker.js';

/** Attach to the slot that already has the session open, or open a stored session in a new slot. */
export type ResumeChoice = { kind: 'attach'; slotId: string } | { kind: 'open'; cwd: string; sessionPath: string };
type Connection = Pick<RemoteConnection, 'request'>;
type Run = <T>(picker: FuzzyPicker<T>) => Promise<T | undefined>;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);
const pathKey = (path: string) => resolve(path);

/** Stored sessions for one remote directory, without full message text. Daemons
 * before resume support only slot-scoped listing; say how to update them. */
export async function storedSessions(connection: Connection, cwd: string): Promise<SessionInfo[]> {
  try { return await connection.request('sessions', { cwd, summary: true }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/slotId/.test(message)) throw new Error('The remote daemon cannot list sessions without a slot. Deploy this release (npm run deploy -- HOST), then run pi-remote restart-daemon.');
    throw new Error(`Could not list sessions in ${cwd}: ${message}`);
  }
}

/**
 * Rows of the resume picker, newest first: stopped slots whose session was saved, then
 * other stored sessions in `cwd`. A session that a running slot already has open
 * attaches to that slot instead of opening it twice.
 */
export function resumeItems(slots: NumberedSlot[], sessions: SessionInfo[], cwd?: string, now = Date.now()): PickerItem<ResumeChoice>[] {
  slots = numberSlots(slots);
  const byPath = new Map(sessions.map(session => [pathKey(session.path), session]));
  const open = new Map<string, NumberedSlot>();
  for (const slot of slots) if (slot.status !== 'exited' && slot.sessionFile) open.set(pathKey(slot.sessionFile), slot);
  const listedCwds = new Set(sessions.map(session => pathKey(session.cwd)));
  const rows: { item: PickerItem<ResumeChoice>; time: number }[] = [];
  const seen = new Set<string>();

  const stopped = slots.filter(slot => slot.status === 'exited' && slot.sessionFile)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const slot of stopped) {
    const key = pathKey(slot.sessionFile!);
    if (seen.has(key)) continue;
    const session = byPath.get(key);
    // Pi writes a session file only after the first response. A stopped slot in a listed
    // directory whose file is absent was never saved, so there is nothing to resume.
    if (!session && listedCwds.has(pathKey(slot.cwd))) continue;
    seen.add(key);
    const running = open.get(key);
    const number = slotNumber(slot);
    const title = slot.sessionName || session?.name || (session?.firstMessage && oneLine(session.firstMessage)) || '(unnamed)';
    const time = session ? Date.parse(session.modified) : Date.parse(slot.createdAt);
    rows.push({ time, item: {
      value: running ? { kind: 'attach', slotId: running.id } : { kind: 'open', cwd: slot.cwd, sessionPath: slot.sessionFile! },
      marker: running ? `#${slotNumber(running)} ${style.ok('●')}` : `#${number ?? '?'} ${style.dim('○')}`,
      title, detail: slot.cwd,
      right: [running ? `open in #${slotNumber(running)}` : 'stopped', session ? `${session.messageCount} msgs` : undefined, formatAge(time, now)].filter(Boolean).join(' · '),
      search: `#${number ?? ''} ${title} ${session?.firstMessage ?? ''} ${slot.cwd}`,
      exact: number === undefined ? [slot.id] : [String(number), `#${number}`, slot.id],
    } });
  }
  for (const session of sessions) {
    const key = pathKey(session.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const running = open.get(key);
    const first = oneLine(session.firstMessage ?? '');
    const title = session.name || first || session.id;
    const time = Date.parse(session.modified);
    rows.push({ time, item: {
      value: running ? { kind: 'attach', slotId: running.id } : { kind: 'open', cwd: cwd ?? session.cwd, sessionPath: session.path },
      marker: running ? `#${slotNumber(running)} ${style.ok('●')}` : style.dim('·'),
      title, detail: session.name && first ? first : undefined,
      right: [running ? `open in #${slotNumber(running)}` : undefined, `${session.messageCount} msgs`, formatAge(time, now)].filter(Boolean).join(' · '),
      search: `${session.name ?? ''} ${first} ${session.id}`,
    } });
  }
  return rows.sort((a, b) => (b.time || 0) - (a.time || 0)).map(row => row.item);
}

/** The resume finder. Undefined means the user cancelled. */
export async function pickResume(connection: Connection, options: { host?: string; cwd?: string; run?: Run }): Promise<ResumeChoice | undefined> {
  const slots = numberSlots(await connection.request('list'));
  // List the default directory and every stopped slot's directory, so each stopped slot
  // shows its first message and age, and slots that never saved a session are hidden.
  const cwds = [...new Set([...(options.cwd ? [options.cwd] : []), ...slots.filter(slot => slot.status === 'exited' && slot.sessionFile).map(slot => slot.cwd)])];
  const listings = await Promise.allSettled(cwds.map(cwd => storedSessions(connection, cwd)));
  const failure = listings.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  // The default directory's listing is the main content; report its failure.
  if (options.cwd && listings[0]?.status === 'rejected') throw listings[0].reason;
  const sessions = listings.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const items = resumeItems(slots, dedupe(sessions), options.cwd);
  if (!items.length) {
    if (failure) throw failure.reason;
    throw new Error(options.cwd ? `No saved sessions to resume in ${options.cwd}.` : 'No stopped slots to resume. Use --cwd DIRECTORY to list stored sessions there.');
  }
  return (options.run ?? runPicker)(new FuzzyPicker(items, {
    title: 'Resume a session', subtitle: [options.host ?? 'local', options.cwd].filter(Boolean).join(' · '),
    action: 'resume', empty: 'No sessions match.', placeholder: 'Search by name, first message, or slot number',
  }));
}

function dedupe(sessions: SessionInfo[]): SessionInfo[] {
  const seen = new Set<string>();
  return sessions.filter(session => { const key = pathKey(session.path); if (seen.has(key)) return false; seen.add(key); return true; });
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
