import assert from 'node:assert/strict';
import test from 'node:test';
import type { NumberedSlot } from '../../src/cli/completion.js';
import { homeItems } from '../../src/cli/main.js';
import { openSession, pickResume, resumeItems, resumeSlot, storedSessions } from '../../src/cli/resume.js';
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

test('resume rows put recent work first and reuse stopped slot names and numbers', () => {
  const slots = [slot(1, 'exited', { sessionFile: '/sessions/a.jsonl', sessionName: 'fix auth' }), slot(2, 'exited', { sessionFile: '/sessions/b.jsonl' })];
  const items = resumeItems(slots, [session('a', 30), session('b', 5), session('c', 10, { name: 'named c' })], '/work', NOW);
  assert.deepEqual(items.map(item => item.title), ['first message of b', 'named c', 'fix auth']);
  assert.equal(strip(items[0]!.marker!), '#2 ○');
  assert.equal(items[0]!.right, 'stopped · 4 msgs · 5m');
  assert.equal(items[1]!.detail, 'first message of c');
  assert.equal(items[1]!.right, '4 msgs · 10m');
  assert.deepEqual(items[2]!.value, { kind: 'open', cwd: '/work', sessionPath: '/sessions/a.jsonl' });
  assert.deepEqual(items[2]!.exact, ['1', '#1', 'id-1']);
});

test('a session that a running slot has open attaches to that slot', () => {
  const slots = [slot(1, 'exited', { sessionFile: '/sessions/a.jsonl' }), slot(5, 'running', { sessionFile: '/sessions/a.jsonl' }), slot(6, 'running', { sessionFile: '/sessions/b.jsonl' })];
  const items = resumeItems(slots, [session('a', 1), session('b', 2)], '/work', NOW);
  assert.deepEqual(items.map(item => item.value), [{ kind: 'attach', slotId: 'id-5' }, { kind: 'attach', slotId: 'id-6' }]);
  assert.match(items[0]!.right!, /^open in #5/);
  assert.equal(strip(items[1]!.marker!), '#6 ●');
});

test('stopped slots that never saved a session are hidden; unknown directories are kept', () => {
  const slots = [
    slot(1, 'exited', { sessionFile: '/sessions/unsaved.jsonl' }),
    slot(2, 'exited', { sessionFile: '/elsewhere/x.jsonl', cwd: '/other' }),
    slot(3, 'exited'),
    slot(4, 'exited', { sessionFile: '/sessions/a.jsonl' }),
    slot(7, 'exited', { sessionFile: '/sessions/a.jsonl', createdAt: ago(1) }),
  ];
  const items = resumeItems(slots, [session('a', 2)], '/work', NOW);
  // Slot 7 is the newest stopped slot for a.jsonl; slot 4 would be a duplicate row.
  assert.deepEqual(items.map(item => strip(item.marker!)), ['#7 ○', '#2 ○']);
  assert.equal(items[1]!.title, '(unnamed)');
});

test('resume finder lists the default directory and stopped slot directories in summary form', async () => {
  const calls: any[] = [];
  const slots = [slot(1, 'exited', { sessionFile: '/other/s.jsonl', cwd: '/other' })];
  const connection = { request: async (method: string, params?: any) => {
    calls.push({ method, params });
    if (method === 'list') return slots;
    return params.cwd === '/other' ? [session('s', 1, { path: '/other/s.jsonl', cwd: '/other' })] : [session('w', 2)];
  } } as any;
  let rendered = '';
  const choice = await pickResume(connection, { host: 'devbox', cwd: '/work', run: async picker => {
    rendered = strip(picker.render(100).join('\n'));
    return picker.selectedValue();
  } });
  assert.deepEqual(calls.filter(call => call.method === 'sessions').map(call => call.params), [{ cwd: '/work', summary: true }, { cwd: '/other', summary: true }]);
  assert.match(rendered, /Resume a session\s+devbox · \/work/);
  assert.match(rendered, /#1 ○ first message of s/);
  assert.deepEqual(choice, { kind: 'open', cwd: '/other', sessionPath: '/other/s.jsonl' });
});

test('resume finder explains empty results and old daemons', async () => {
  const empty = { request: async (method: string) => method === 'list' ? [] : [] } as any;
  await assert.rejects(pickResume(empty, { cwd: '/work' }), /No saved sessions to resume in \/work/);
  await assert.rejects(pickResume(empty, {}), /No stopped slots to resume/);
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

test('home picker offers resume with a directory or a resumable stopped slot', () => {
  const kinds = (slots: NumberedSlot[], cwd?: string) => homeItems(slots, cwd).map(item => item.value.kind);
  assert.deepEqual(kinds([slot(1, 'running')], '/work'), ['attach', 'new', 'resume']);
  assert.deepEqual(kinds([slot(1, 'exited', { sessionFile: '/s.jsonl' })]), ['resume']);
  assert.deepEqual(kinds([slot(1, 'exited')]), []);
});
