import assert from 'node:assert/strict';
import test from 'node:test';
import { LAUNCH_MODES_CAPABILITY, createSlot } from '../../src/protocol/launch-modes.js';

function fakeConnection(capabilities: string[]) {
  const calls: [string, unknown][] = [];
  const connection = {
    request: async (method: string, params: unknown) => {
      calls.push([method, params]);
      return method === 'hello' ? { protocol: 1, piVersion: '1.0.4', pid: 1, capabilities } : { id: 'slot' };
    },
  } as any;
  return { connection, calls };
}

test('a sandboxed create fails before creating anything on a daemon without launch modes', async () => {
  const old = fakeConnection(['side_slots']);
  await assert.rejects(createSlot(old.connection, { cwd: '/w', sandboxed: true }), /cannot start sandboxed Pi.*Nothing was started/);
  assert.deepEqual(old.calls.map(([method]) => method), ['hello']);
  // Older daemons start unsandboxed Pi anyway, so an unsandboxed create needs no check.
  await createSlot(old.connection, { cwd: '/w', sandboxed: false });
  assert.deepEqual(old.calls.at(-1), ['create', { cwd: '/w', sandboxed: false }]);
  const current = fakeConnection([LAUNCH_MODES_CAPABILITY]);
  await createSlot(current.connection, { cwd: '/w', sandboxed: true });
  assert.deepEqual(current.calls.map(([method]) => method), ['hello', 'create']);
  assert.deepEqual(current.calls[1][1], { cwd: '/w', sandboxed: true });
});
