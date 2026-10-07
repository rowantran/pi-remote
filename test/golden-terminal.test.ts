import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalLines, crop, lineToAnsi, sideBySide, strip, workingDisplay } from './golden/terminal.js';

const border = '─'.repeat(80);
const screen = (body: string[]) => ['Startup metadata', '', ...body, '', '', border, 'editor', border, 'footer', ''].join('\n');

test('golden capture compares colors, attributes and colored spaces, not redundant SGR', () => {
  assert.deepEqual(canonicalLines('\x1b[1;31ma\x1b[0m\n'), canonicalLines('\x1b[31m\x1b[1ma\x1b[22;39m\n'));
  assert.notDeepEqual(canonicalLines('\x1b[31ma'), canonicalLines('\x1b[32ma'));
  assert.notDeepEqual(canonicalLines('\x1b[3ma'), canonicalLines('a'));
  assert.deepEqual(canonicalLines('a   '), canonicalLines('a'));
  assert.notDeepEqual(canonicalLines('\x1b[44ma   '), canonicalLines('\x1b[44ma'));
  assert.notDeepEqual(canonicalLines('\x1b[7ma   '), canonicalLines('\x1b[7ma'));
  assert.notDeepEqual(canonicalLines('\x1b[4ma   '), canonicalLines('\x1b[4ma'));
  assert.notDeepEqual(canonicalLines('\x1b[9ma   '), canonicalLines('\x1b[9ma'));
  assert.throws(() => canonicalLines('\x1b[53ma'), /Unsupported/);
});

test('golden capture resolves inherited styles before cropping and serializes standalone rows', () => {
  const lines = canonicalLines('\x1b[38;2;1;2;3;48;5;42mfirst\nsecond\n');
  assert.deepEqual(canonicalLines(lineToAnsi(lines[1])), [lines[1]]);
  assert.match(lines[1], /rgb:1,2,3/);
  assert.match(lines[1], /palette:42/);
});

test('golden crop excludes startup/editor/footer but keeps user padding and shell borders', () => {
  const capture = screen(['\x1b[44m' + ' '.repeat(80), ' GOLDEN_USER', ' '.repeat(80) + '\x1b[49m', 'answer', '', border,
    '$ printf GOLDEN_SHELL_DONE', 'GOLDEN_SHELL_DONE', border]);
  const result = crop(capture, 160);
  assert.ok(result.text.startsWith('\n GOLDEN_USER\n\n'));
  assert.equal(result.text.split(border).length - 1, 2, 'both shell borders remain');
  assert.doesNotMatch(result.text, /Startup|editor|footer/);
  assert.match(result.canonical, /ansi:44/);
});

test('golden crop excludes only explicit transient toggle notices and normalizes only wall-clock labels', () => {
  const body = ['GOLDEN_USER', 'number 0.7s', 'Took 0.7s', 'Elapsed 0.8s', '', ' Tool output: expanded', '', ' Thinking blocks: hidden'];
  const result = crop(screen(body), 160);
  assert.doesNotMatch(result.text, /Tool output|Thinking blocks/);
  assert.match(result.text, /Took 0.7s/);
  assert.match(result.canonical, /number 0.7s/);
  assert.match(result.canonical, /Took 0.0s/);
  assert.match(result.canonical, /Elapsed 0.0s/);
  assert.equal(result.canonical, crop(screen(['GOLDEN_USER', 'number 0.7s', 'Took 0.2s', 'Elapsed 0.1s']), 160).canonical);
});

test('golden restored-history comparison does not hide synthetic clock rows', () => {
  const history = crop(screen(['GOLDEN_USER', 'saved tool output']), 160);
  const syntheticClock = crop(screen(['GOLDEN_USER', 'saved tool output', '', ' Took 0.0s']), 160);
  assert.notEqual(history.canonical, syntheticClock.canonical, 'clock normalization must not remove missing or extra timer rows');
});

test('golden crop excludes native and remote working status without masking transcript text', () => {
  for (const status of [' ⠴ Working', 'Working…']) {
    const body = ['GOLDEN_USER', 'answer', '', '', '', status, ''];
    assert.equal(crop(screen(body), 160).text, 'GOLDEN_USER\nanswer\n');
    assert.match(crop(screen(['GOLDEN_USER', status, 'answer']), 160).text, /Working/);
    const first = crop(screen(['GOLDEN_USER', '', '', '', status, 'answer A']), 160);
    const second = crop(screen(['GOLDEN_USER', '', '', '', status, 'answer B']), 160);
    assert.match(first.text, /Working/);
    assert.match(first.text, /answer A/);
    assert.notEqual(first.canonical, second.canonical, 'status-shaped transcript text must not mask different answers');
    const distant = crop(screen(['GOLDEN_USER', '', '', '', status, '', '', '', '', '']), 160);
    assert.match(distant.text, /Working/, 'transcript status text outside the prompt edge must remain');
  }
});

test('golden working comparison normalizes only spinner phase and catches placement, spacing and styling', () => {
  const separate = (status: string, gap = '') => ['GOLDEN_USER', 'answer', '', status, gap, border, 'editor', border, 'footer'].join('\n');
  const embedded = (status: string) => ['GOLDEN_USER', 'answer', '', `── ${status} ──`, 'editor', border, 'footer'].join('\n');
  assert.deepEqual(workingDisplay(separate(' ⠋ Working ')), workingDisplay(separate(' ⠙ Working ')));
  assert.notDeepEqual(workingDisplay(separate(' ⠋ Working ')), workingDisplay(separate('⠋ Working')));
  assert.notDeepEqual(workingDisplay(separate(' ⠋ Working ')), workingDisplay(separate(' ⠋ Working ', 'missing gap')));
  assert.notDeepEqual(workingDisplay(separate(' ⠋ Working ')), workingDisplay(separate(' \x1b[31m⠋ Working\x1b[0m ')));
  assert.notDeepEqual(workingDisplay(separate(' ⠋ Working ')), workingDisplay(separate('Working…')));
  assert.notDeepEqual(workingDisplay(separate(' ⠋ Working ')), workingDisplay(embedded('⠋ Working')));
  assert.deepEqual(workingDisplay(embedded('⠋ Working')), workingDisplay(embedded('⠙ Working')));
  assert.notDeepEqual(workingDisplay(embedded('⠋ Working')), workingDisplay(screen(['GOLDEN_USER', 'answer'])));
  assert.equal(workingDisplay(screen(['GOLDEN_USER', ' ⠋ Working', 'answer'])), null,
    'Status-shaped transcript text must not be treated as prompt status');
});

test('golden crop keeps legacy remote heading and fails closed on missing boundaries', () => {
  assert.ok(crop(screen(['You', 'GOLDEN_USER', 'Pi', 'answer']), 160).text.startsWith('You\n'));
  assert.throws(() => crop(screen(['missing prompt']), 160), /not visible/);
  assert.throws(() => crop('GOLDEN_USER\nanswer', 160), /editor border/);
});

test('golden side-by-side pads terminal columns instead of Unicode code units', () => {
  assert.equal(sideBySide('世界\n', 'right\n', 8), '世界     │ right\n');
  assert.equal(strip(sideBySide('\x1b[31m世界\x1b[0m\n', 'right\n', 8, true)).trimEnd(), '世界     │ right');
});
