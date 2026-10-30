import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadOnlyConnection } from '../../src/web/client/cache.js';

test('a saved screen cannot send input, uploads, or remote reads', async () => {
  const connection = new ReadOnlyConnection();
  await assert.rejects(connection.request('input', { slotId: 'slot', data: 'must not run\r' }), /Nothing was sent/);
  await assert.rejects(connection.request('upload', { slotId: 'slot', name: 'x', data: '' }), /Nothing was sent/);
  await assert.rejects(connection.request('attach_native', { slotId: 'slot', columns: 80, rows: 24 }), /Nothing was sent/);
  let disconnected = false;
  connection.onDisconnect(() => { disconnected = true; });
  await Promise.resolve(); assert.equal(disconnected, true);
});
