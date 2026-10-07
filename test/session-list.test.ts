import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSlotList, parseOptions } from '../src/cli.js';
import type { NumberedSlot } from '../src/completion.js';

const slot = (number: number, status: NumberedSlot['status'], sessionName?: string): NumberedSlot =>
  ({ id: `id-${number}`, number, cwd: '/work', createdAt: '', status, sessionName, clients: 0 });

test('slot list says how many stopped slots are hidden', () => {
  assert.equal(formatSlotList([slot(1, 'running', 'fix-tests')], 2), '  1  id-1  running  0 client(s)  fix-tests  /work\n2 stopped slots hidden. Use ls --all to show them.');
  assert.equal(formatSlotList([], 1), 'No active slots. Create one with new --cwd DIRECTORY.\n1 stopped slot hidden. Use ls --all to show it.');
  assert.equal(formatSlotList([]), 'No slots. Create one with new --cwd DIRECTORY.');
  assert.equal(formatSlotList([slot(3, 'exited')]), '  3  id-3  exited   0 client(s)  (unnamed)  /work');
});

test('CLI parses --all', () => {
  assert.ok(parseOptions(['--all']).flags.has('--all'));
});
