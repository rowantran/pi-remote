import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSlotList, parseOptions } from '../../src/cli/main.js';
import type { NumberedSlot } from '../../src/cli/completion.js';

const slot = (number: number, status: NumberedSlot['status'], sessionName?: string): NumberedSlot =>
  ({ id: `id-${number}`, number, cwd: '/work', createdAt: '', status, sessionName, clients: 0 });
const paint = { bold: (t: string) => t, dim: (t: string) => t, accent: (t: string) => t, ok: (t: string) => t, warn: (t: string) => t, error: (t: string) => t };

test('slot list says how many stopped slots are hidden', () => {
  assert.equal(formatSlotList([slot(1, 'running', 'fix-tests')], 2, paint), '  1  ● running  fix-tests  /work  id-1\n2 stopped slots hidden. Use ls --all to show them.');
  assert.equal(formatSlotList([], 1), 'No active slots. Create one with new --cwd DIRECTORY.\n1 stopped slot hidden. Use ls --all to show it.');
  assert.equal(formatSlotList([]), 'No slots. Create one with new --cwd DIRECTORY.');
  assert.equal(formatSlotList([slot(3, 'exited')]), '  3  ○ exited  (unnamed)  /work  id-3');
});

test('side slots are grouped under their parent with normal slot numbers', () => {
  const child = { ...slot(3, 'running', 'question'), parentSlotId: 'id-1', parentSlotNumber: 1 };
  const nested = { ...slot(4, 'running'), parentSlotId: 'id-3', parentSlotNumber: 3 };
  const output = formatSlotList([slot(1, 'running', 'main'), slot(2, 'running'), nested, child]).split('\n');
  assert.match(output[0], /^  1  ● running  main/);
  assert.match(output[1], /^  3  ● running    question \(side of #1\)/);
  assert.match(output[2], /^  4  ● running      \(unnamed\) \(side of #3\)/);
  assert.match(output[3], /^  2  ● running  \(unnamed\)/);
  assert.match(formatSlotList([child]), /side of #1/);
  const cycle = { ...slot(1, 'running'), parentSlotId: 'id-3' };
  assert.equal(formatSlotList([cycle, child]).split('\n').length, 2);
});

test('CLI parses --all', () => {
  assert.ok(parseOptions(['--all']).flags.has('--all'));
});
