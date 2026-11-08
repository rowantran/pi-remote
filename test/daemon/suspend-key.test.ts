import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesKey } from '@earendil-works/pi-tui';
import { SuspendKeyFilter } from '../../src/daemon/suspend-key.js';

const filter = (data: string) => new SuspendKeyFilter().filter(data);

const CTRL_Z_FORMS = [
  '\x1a',
  '\x1b[122;5u',
  '\x1b[122;5:1u',
  '\x1b[122;5:2u',
  '\x1b[122;5:3u',
  '\x1b[122;69u', // Caps Lock
  '\x1b[122;133u', // Num Lock
  '\x1b[122:90;5u',
  '\x1b[122::122;5u',
  '\x1b[1103::122;5u', // Cyrillic layout, Z position
  '\x1b[27;5;122~',
];

test('removes Ctrl+Z in every form Pi reads as Ctrl+Z', () => {
  for (const key of CTRL_Z_FORMS) {
    if (!key.endsWith(':3u')) assert.ok(matchesKey(key, 'ctrl+z'), `Pi reads ${JSON.stringify(key)} as Ctrl+Z`);
    assert.equal(filter(key), '', JSON.stringify(key));
    assert.equal(filter(`a${key}b`), 'ab', JSON.stringify(key));
  }
});

test('keeps other keys', () => {
  for (const key of ['z', 'Z', '\x1b[122u', '\x1b[122;2u', '\x1b[122;6u', '\x1b[122;7u', '\x1b[90;5u',
    '\x1b[121;5u', '\x1b[1103;5u', '\x1b[99::122;5u', '\x1b[27;6;122~', '\x03', '\x1b[1;5A', 'hello\r']) {
    assert.ok(!matchesKey(key, 'ctrl+z'), `Pi does not read ${JSON.stringify(key)} as Ctrl+Z`);
    assert.equal(filter(key), key, JSON.stringify(key));
  }
});

test('leaves bracketed pastes unchanged, including pastes split across writes', () => {
  assert.equal(filter('\x1a\x1b[200~a\x1ab\x1b[201~\x1a'), '\x1b[200~a\x1ab\x1b[201~');
  const split = new SuspendKeyFilter();
  assert.equal(split.filter('\x1b[200~one\x1a'), '\x1b[200~one\x1a');
  assert.equal(split.filter('two\x1b[122;5u'), 'two\x1b[122;5u');
  assert.equal(split.filter('\x1b[201~\x1a!'), '\x1b[201~!');
});
