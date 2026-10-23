import assert from 'node:assert/strict';
import test from 'node:test';
import type { NumberedSlot } from '../../src/cli/completion.js';
import { homeItems } from '../../src/cli/main.js';
import { openSession, pickResume, resumeSlot, storedSessions } from '../../src/cli/resume.js';
import { sessionItems } from '../../src/tui/session-table.js';
import { paint } from '../../src/tui/table.js';
import type { SessionInfo } from '../../src/protocol/methods.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*\x07/g, '');
const slot = (number: number, status: NumberedSlot['status'], extra: Partial<NumberedSlot> = {}): NumberedSlot =>
  ({ id: `id-${number}`, number, cwd: '/work', createdAt: ago(600), status, clients: 0, ...extra });
const session = (name: string, minutes: number, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  path: `/sessions/${name}.jsonl`, id: `sid-${name}`, cwd: '/work', created: ago(minutes + 60), modified: ago(minutes),
  messageCount: 4, firstMessage: `first message of ${name}`, allMessagesText: '', ...extra,
});

test('resume rows keep Pi order and mark sessions open in or last used by a slot', () => {
  const slots = [
    slot(1, 'exited', { sessionFile: '/sessions/a.jsonl', createdAt: ago(600) }),
    slot(7, 'exited', { sessionFile: '/sessions/a.jsonl', createdAt: ago(60) }),
    slot(5, 'running', { sessionFile: '/sessions/b.jsonl' }),
  ];
  const items = sessionItems([session('b', 5), session('c', 10, { name: 'named c' }), session('a', 30)], slots, paint(false), { now: NOW });
  assert.deepEqual(items.map(item => item.cells), [
    ['first message of b', '4 msgs', '5m', '● open in #5'],
    ['named c', '4 msgs', '10m', ''],
    ['first message of a', '4 msgs', '30m', '○ stopped #7'],
  ]);
  assert.deepEqual(items.map(item => item.value), [{ path: '/sessions/b.jsonl', openIn: 'id-5' }, { path: '/sessions/c.jsonl' }, { path: '/sessions/a.jsonl' }]);
  assert.deepEqual(items[2]!.exact, ['7', '#7']);
});

test('resume picker lists one directory like /resume and maps choices to attach or open', async () => {
  const calls: any[] = [];
  const slots = [slot(5, 'running', { sessionFile: '/sessions/b.jsonl' })];
  const connection = { request: async (method: string, params?: any) => { calls.push({ method, params }); return method === 'list' ? slots : [session('a', 1), session('b', 2)]; } } as any;
  let rendered = '';
  const pick = (index: number) => pickResume(connection, { host: 'devbox', cwd: '/work', sessionDir: '.sessions', run: async picker => {
    rendered = strip(picker.render(100).join('\n'));
    for (let step = 0; step < index; step++) picker.handleInput('\x1b[B');
    return picker.selectedValue();
  } });
  assert.deepEqual(await pick(0), { kind: 'open', cwd: '/work', sessionPath: '/sessions/a.jsonl' });
  assert.deepEqual(await pick(1), { kind: 'attach', slotId: 'id-5' });
  assert.deepEqual(calls.find(call => call.method === 'sessions').params, { cwd: '/work', summary: true, sessionDir: '.sessions' });
  assert.match(rendered, /Resume a session\s+devbox · \/work/);
  assert.match(rendered, /first message of b\s+4 msgs\s+\d+[smhd]\s+● open in #5/);
});

test('resume picker explains a missing directory, empty results, and old daemons', async () => {
  const empty = { request: async () => [] } as any;
  await assert.rejects(pickResume(empty, {}), /resume lists the sessions of a directory.*resume SLOT/);
  await assert.rejects(pickResume(empty, { cwd: '/work' }), /No saved sessions in \/work/);
  const old = { request: async (method: string) => { if (method === 'list') return []; throw new Error('slotId must be a string'); } } as any;
  await assert.rejects(storedSessions(old, '/work'), /Deploy this release.*restart-daemon/);
  await assert.rejects(pickResume(old, { cwd: '/work' }), /Deploy this release/);
});

test('resume SLOT reopens a stopped slot, attaches to a running one, and needs a saved session', () => {
  assert.deepEqual(resumeSlot(slot(3, 'exited', { sessionFile: '/sessions/a.jsonl' })), { kind: 'open', cwd: '/work', sessionPath: '/sessions/a.jsonl' });
  assert.deepEqual(resumeSlot(slot(3, 'running')), { kind: 'attach', slotId: 'id-3' });
  assert.throws(() => resumeSlot(slot(3, 'exited')), /Slot 3 has no saved session/);
});

test('opening a session creates a slot, attaches if another slot owns it, and explains unsaved files', async () => {
  const choice = { kind: 'open' as const, cwd: '/work', sessionPath: '/sessions/a.jsonl' };
  const created: any[] = [];
  const ok = { request: async (_method: string, params: any) => { created.push(params); return slot(9, 'starting'); } } as any;
  assert.deepEqual((await openSession(ok, choice, ['--model', 'm'])).slotId, 'id-9');
  assert.deepEqual(created, [{ cwd: '/work', args: ['--model', 'm'], sessionPath: '/sessions/a.jsonl' }]);
  const owned = { request: async () => { throw new Error('Session is already open in slot 8844ca51-7b8d-47da-b1b9-3e111d70779b; attach to that slot instead'); } } as any;
  assert.deepEqual(await openSession(owned, choice), { slotId: '8844ca51-7b8d-47da-b1b9-3e111d70779b', existing: true });
  const missing = { request: async () => { throw new Error("ENOENT: no such file or directory, realpath '/sessions/a.jsonl'"); } } as any;
  await assert.rejects(openSession(missing, choice), /does not exist.*first response/);
});

test('home picker offers new and resume rows only with a directory', () => {
  const kinds = (slots: NumberedSlot[], cwd?: string) => homeItems(slots, cwd).map(item => item.value.kind);
  assert.deepEqual(kinds([slot(1, 'running')], '/work'), ['attach', 'new', 'resume']);
  assert.deepEqual(kinds([slot(1, 'exited', { sessionFile: '/s.jsonl' })]), []);
});
