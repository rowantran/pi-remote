import assert from 'node:assert/strict';
import test from 'node:test';
import { toKittyInput } from '../../src/tui/kitty-keys.js';

test('legacy keys become the kitty sequences for the same keys', () => {
  const cases: [string, string][] = [
    ['a', 'a'], ['A', 'A'], ['é', 'é'], ['\r', '\r'], ['\t', '\t'], ['\x7f', '\x7f'],
    ['\x1b', '\x1b[27u'], ['\x01', '\x1b[97;5u'], ['\x03', '\x1b[99;5u'], ['\x1bx', '\x1b[120;3u'],
    ['\x1b\r', '\x1b[13;3u'], ['\x1b[Z', '\x1b[9;2u'], ['\n', '\x1b[106;5u'], ['\x1f', '\x1b[45;5u'],
    ['\x1b[A', '\x1b[A'], ['\x1b[1;5D', '\x1b[1;5D'], ['\x1bb', '\x1b[1;3D'], ['\x1b[3~', '\x1b[3~'],
    ['\x1b[200~text\x1b[201~', '\x1b[200~text\x1b[201~'],
  ];
  for (const [legacy, kitty] of cases) assert.equal(toKittyInput(legacy, false), kitty, JSON.stringify(legacy));
});

test('a terminal that already uses the kitty protocol passes keys through', () => {
  assert.equal(toKittyInput('\x1b', true), '\x1b');
});
