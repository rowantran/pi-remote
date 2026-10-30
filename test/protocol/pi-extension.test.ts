import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDiff, decodeBarrier, diffLines, encodeBarrier } from '../../src/protocol/pi-extension.js';

test('line diffs reproduce the new lines for random edits', () => {
  for (let i = 0; i < 5000; i++) {
    const random = () => Array.from({ length: Math.floor(Math.random() * 8) }, () => String(Math.floor(Math.random() * 3)));
    const before = random();
    const after = random();
    const diff = diffLines(before, after);
    assert.deepEqual(diff ? applyDiff(before, diff) : before, after);
  }
});

test('an append sends only the new lines', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b', 'c']), { start: 2, remove: 0, insert: ['c'] });
  assert.equal(diffLines(['a'], ['a']), undefined);
});

test('barriers round-trip and ignore other input', () => {
  assert.equal(decodeBarrier(encodeBarrier('c1:42')), 'c1:42');
  assert.equal(decodeBarrier(encodeBarrier('bad tag:1')), undefined);
  assert.equal(decodeBarrier('a'), undefined);
  assert.equal(decodeBarrier('\x1b_other\x1b\\'), undefined);
});
