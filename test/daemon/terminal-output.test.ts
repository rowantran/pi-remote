import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalOutputFilter } from '../../src/daemon/terminal-output.js';

test('keeps bells, titles, notifications, progress and clipboard writes; drops drawing and links', () => {
  const filter = new TerminalOutputFilter();
  const found = filter.feed('\x1b[2J\x1b]8;;https://x\x07link\x1b]8;;\x07\x07\x1b]0;π - repo\x07\x1b]9;done\x1b\\\x1b]9;4;3\x07\x1b]52;c;aGk=\x07\x1b]11;?\x07');
  assert.deepEqual(found.map(message => [message.kind, message.data]), [
    ['bell', '\x07'], ['title', '\x1b]0;π - repo\x07'], ['notify', '\x1b]9;done\x1b\\'],
    ['progress', '\x1b]9;4;3\x07'], ['clipboard', '\x1b]52;c;aGk=\x07'],
  ]);
});

test('an OSC sequence split across reads is found once it ends', () => {
  const filter = new TerminalOutputFilter();
  assert.deepEqual(filter.feed('x\x1b]52;c;aG'), []);
  assert.deepEqual(filter.feed('k=\x07').map(message => message.data), ['\x1b]52;c;aGk=\x07']);
});
