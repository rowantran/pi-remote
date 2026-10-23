import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@earendil-works/pi-tui';
import { homeItems, pickHome } from '../../src/cli/main.js';
import { FuzzyPicker, formatAge, runPicker, slotItem, type PickerItem } from '../../src/cli/picker.js';
import type { NumberedSlot } from '../../src/cli/completion.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const slot = (number: number, status: NumberedSlot['status'], sessionName?: string, cwd = '/work'): NumberedSlot =>
  ({ id: `id-${number}`, number, cwd, createdAt: new Date(NOW - 3_600_000).toISOString(), status, sessionName, clients: 0 });
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*\x07/g, '');
const type = (picker: FuzzyPicker<unknown>, text: string) => { for (const key of text) picker.handleInput(key); };
const items = (titles: string[], pinned?: string): PickerItem<string>[] =>
  [...titles.map(title => ({ value: title, title })), ...(pinned ? [{ value: pinned, title: pinned, pinned: true }] : [])];

test('fuzzy picker filters by query and keeps pinned actions below matches', () => {
  const picker = new FuzzyPicker(items(['fix-auth-tests', 'refactor parser', 'flaky ci'], 'New session'), { title: 'Pick' });
  assert.deepEqual(picker.rows().map(row => row.value), ['fix-auth-tests', 'refactor parser', 'flaky ci', 'New session']);
  type(picker, 'flk');
  assert.deepEqual(picker.rows().map(row => row.value), ['flaky ci', 'New session']);
  type(picker, 'zzz');
  assert.deepEqual(picker.rows().map(row => row.value), ['New session']);
  assert.match(strip(picker.render(80).join('\n')), /Nothing matches\./);
});

test('fuzzy picker ranks exact slot numbers first and selects with Enter', () => {
  const picker = new FuzzyPicker([slotItem(slot(12, 'running', 'about 3 things')), slotItem(slot(3, 'running', 'other'))], { title: 'Pick' });
  type(picker, '3');
  assert.equal(picker.selectedValue(), 'id-3');
  let chosen: string | undefined;
  picker.onSelect = value => { chosen = value; };
  picker.handleInput('\r');
  assert.equal(chosen, 'id-3');
});

test('fuzzy picker moves with arrows, resets on a new query, and cancels with Esc, Ctrl+C, or Ctrl+D', () => {
  const picker = new FuzzyPicker(items(['a', 'b', 'c']), { title: 'Pick' });
  picker.handleInput('\x1b[B'); picker.handleInput('\x1b[B'); picker.handleInput('\x1b[B');
  assert.equal(picker.selectedValue(), 'c');
  picker.handleInput('\x1b[A');
  assert.equal(picker.selectedValue(), 'b');
  type(picker, 'c');
  assert.equal(picker.selectedValue(), 'c');
  for (const key of ['\x1b', '\x03', '\x04']) {
    let cancelled = false;
    picker.onCancel = () => { cancelled = true; };
    picker.handleInput(key);
    assert.ok(cancelled, JSON.stringify(key));
  }
});

test('fuzzy picker scrolls a long list and shows the position', () => {
  const picker = new FuzzyPicker(items(Array.from({ length: 30 }, (_, index) => `session ${index}`)), { title: 'Pick', maxVisible: 5 });
  for (let index = 0; index < 12; index++) picker.handleInput('\x1b[B');
  const text = strip(picker.render(80).join('\n'));
  assert.match(text, /› session 12/);
  assert.doesNotMatch(text, /session 0\b/);
  assert.match(text, /13\/30/);
});

test('picker rows neutralize remote control characters and fit the width', () => {
  const evil = slotItem(slot(1, 'running', 'name\x1b]0;pwned\x07', '/very/long/remote/path/that/does/not/fit/in/a/narrow/terminal'));
  const lines = new FuzzyPicker([evil], { title: 'Pick\x1b[2J' }).render(50);
  for (const line of lines) {
    assert.doesNotMatch(line, /\x1b\]0;|\x1b\[2J|\x07pwned/);
    assert.ok(strip(line).length <= 50, line);
  }
  assert.match(strip(lines.join('\n')), /…/);
});

test('slot rows show number, status, name, side parent, workspace, age, and attached clients', () => {
  const side = { ...slot(4, 'starting', 'question'), parentSlotId: 'id-1', parentSlotNumber: 1, clients: 2 };
  const row = slotItem(side, NOW);
  assert.equal(strip(row.marker!), '#4 ●');
  assert.equal(row.title, 'question');
  assert.equal(row.detail, 'side of #1 · /work');
  assert.equal(row.right, 'starting · 1h · 2 attached');
  assert.equal(slotItem(slot(2, 'running'), NOW).title, '(unnamed)');
  assert.deepEqual([formatAge(NOW - 5_000, NOW), formatAge(NOW - 300_000, NOW), formatAge(NOW - 7_200_000, NOW), formatAge(NOW - 3 * 86_400_000, NOW)], ['5s', '5m', '2h', '3d']);
});

test('home picker lists active slots and offers a new session only with a directory', () => {
  const slots = [slot(1, 'running', 'main'), slot(2, 'exited', 'old'), slot(3, 'starting')];
  assert.deepEqual(homeItems(slots, '~/project').map(item => item.value), [
    { kind: 'attach', slotId: 'id-1' }, { kind: 'attach', slotId: 'id-3' }, { kind: 'new', cwd: '~/project' },
  ]);
  assert.ok(homeItems(slots, '~/project').at(-1)!.pinned);
  assert.equal(homeItems(slots).length, 2);
});

test('home picker shows the host and fails clearly when there is nothing to offer', async () => {
  const connection = (slots: NumberedSlot[]) => ({ request: async <T>() => slots as T });
  let title = '';
  const choice = await pickHome(connection([slot(1, 'running')]), { host: 'devbox', cwd: '~/p', run: async picker => {
    title = strip(picker.render(80)[0]!);
    picker.handleInput('\x1b[B');
    return picker.selectedValue();
  } });
  assert.match(title, /pi-remote\s+devbox · 1 active slot$/);
  assert.deepEqual(choice, { kind: 'new', cwd: '~/p' });
  await assert.rejects(pickHome(connection([slot(2, 'exited')]), { run: async () => undefined }), /No active slots/);
});

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false;
  output = '';
  input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; }
  stop() {}
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {}
}

test('runPicker erases only its own lines, never the screen or scrollback', async () => {
  const terminal = new FakeTerminal();
  const picker = new FuzzyPicker(items(['one', 'two']), { title: 'Pick' });
  const result = runPicker(picker, terminal);
  await new Promise(resolve => setImmediate(resolve));
  terminal.input('\x1b[B');
  terminal.input('\r');
  assert.equal(await result, 'two');
  const tail = terminal.output.slice(terminal.output.lastIndexOf('\x1b[?2026l'));
  assert.match(tail, /\r\x1b\[J/);
  assert.doesNotMatch(terminal.output, /\x1b\[2J|\x1b\[3J/);
});

test('runPicker fits the list to a short terminal', async () => {
  const terminal = Object.assign(new FakeTerminal(), { rows: 10 });
  const picker = new FuzzyPicker(items(Array.from({ length: 20 }, (_, index) => `s${index}`)), { title: 'Pick' });
  const result = runPicker(picker, terminal);
  assert.equal(picker.maxVisible, 2);
  terminal.input('\x1b');
  await new Promise(resolve => setTimeout(resolve, 100));
  terminal.input('');
  assert.equal(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('pending'), 1000))]), undefined);
});
