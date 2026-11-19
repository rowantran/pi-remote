import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDiff, decodeBarrier, decodeClick, diffLines, encodeBarrier, encodeClick } from '../../src/protocol/pi-extension.js';

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

test('transcript clicks round-trip, with any line text, and ignore malformed input', () => {
  const click = { x: 3, y: 7, width: 80, line: '\x1b[3mThinking...\x1b[23m\x1b]8;;\x1b\\', button: 'left' as const, clickCount: 1, shift: false, alt: true, ctrl: false };
  assert.deepEqual(decodeClick(encodeClick(click)), click);
  const raw = (value: unknown) => `\x1b_pi-remote:click:${Buffer.from(JSON.stringify(value)).toString('base64')}\x1b\\`;
  assert.equal(decodeClick(raw({ ...click, y: -1 })), undefined);
  assert.equal(decodeClick(raw({ ...click, button: 'none' })), undefined);
  assert.equal(decodeClick(raw({ ...click, line: undefined })), undefined);
  assert.equal(decodeClick('\x1b_pi-remote:click:not base64!\x1b\\'), undefined);
  assert.equal(decodeClick(encodeBarrier('c1:1')), undefined);
});
