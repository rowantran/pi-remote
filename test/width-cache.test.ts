import assert from 'node:assert/strict';
import test from 'node:test';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { WidthCache } from '../src/width-cache.js';

const styled = '\x1b[38;2;12;34;56mcolored text\x1b[39m';

test('cached width checks preserve truncation for ANSI, links, Unicode and narrow widths', () => {
  const cache = new WidthCache();
  const lines = ['', 'ASCII text', styled, '世界 café e\u0301 👩‍💻', '\tindented',
    '\x1b]8;;https://example.com\x07linked text\x1b]8;;\x07', '\x1b]133;A\x07prompt'];
  for (const width of [80, 40, 8, 1, 0, -1, 8, 80]) {
    const expected = lines.map(line => truncateToWidth(line, width, ''));
    assert.deepEqual(cache.clamp(lines, width), expected, `width=${width}`);
    assert.deepEqual(cache.clamp([...lines], width), expected, `cached width=${width}`);
    assert.ok(cache.clamp(lines, width).every(line => visibleWidth(line) <= Math.max(0, width)));
  }
});

test('unchanged lines reuse the checked output even when components allocate new arrays', () => {
  const cache = new WidthCache();
  const output = cache.clamp([styled, 'world'], 8);
  assert.equal(cache.clamp([styled, 'world'], 8), output);
  assert.notEqual(cache.clamp([styled, 'world'], 9), output);
});

test('mutable component arrays and changed line counts do not produce stale output', () => {
  const cache = new WidthCache();
  const source = [styled, 'world'];
  const initial = cache.clamp(source, 8);
  source[0] = 'new output';
  const changed = cache.clamp(source, 8);
  assert.notEqual(changed, initial);
  assert.equal(changed[0], truncateToWidth('new output', 8, ''));
  assert.equal(changed[1], initial[1]);
  source.push('third');
  assert.deepEqual(cache.clamp(source, 8), source.map(line => truncateToWidth(line, 8, '')));
  source.shift();
  assert.deepEqual(cache.clamp(source, 8), source.map(line => truncateToWidth(line, 8, '')));
  source.length = 0;
  assert.deepEqual(cache.clamp(source, 8), []);
});

test('clear releases the previous render and theme changes are detected from line content', () => {
  const cache = new WidthCache();
  const output = cache.clamp([styled], 80);
  const recolored = styled.replace('12;34;56', '65;43;21');
  assert.deepEqual(cache.clamp([recolored], 80), [recolored]);
  cache.clear();
  assert.notEqual(cache.clamp([styled], 80), output);
});
