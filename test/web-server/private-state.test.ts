import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readPrivateJson } from '../../src/web/server/private-state.js';

// Device/push state still uses this reader after presentation uploads are removed.
// Preserve its independent byte-limit and fragmented-read contract.
test('private JSON reads handle multiple chunks, exact byte limits, missing and empty files', async t => {
  const root = await mkdtemp('/tmp/pi-private-json-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'bounded.json');
  const limit = 256 * 1024;
  assert.equal(await readPrivateJson(file, limit), undefined);
  const value = { text: 'é'.repeat(80 * 1024) };
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  await writeFile(file, text, { mode: 0o600 });
  assert.deepEqual(await readPrivateJson(file, bytes), value);
  assert.deepEqual(await readPrivateJson(file, limit), value);
  await assert.rejects(readPrivateJson(file, bytes - 1), /exceeds limit/);
  await writeFile(file, '');
  await assert.rejects(readPrivateJson(file, limit), SyntaxError);
});
