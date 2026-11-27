import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionProblem } from '../../src/tui/session-labels.js';

test("a connection problem is SSH's last diagnostic line, as one sentence", () => {
  assert.equal(
    connectionProblem(new Error('SSH exited (code=255, signal=null)\nTimeout, server rowan-v2-dev not responding.\r\n')),
    'Timeout, server rowan-v2-dev not responding.',
  );
  assert.equal(connectionProblem(new Error('SSH exited (code=255, signal=null)')), 'SSH exited (code=255, signal=null).');
  assert.equal(connectionProblem(new Error('\r\n')), 'Connection closed.');
});
