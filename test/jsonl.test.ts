import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { MAX_QUEUED_BYTES, readJsonl, writeJsonl } from '../src/jsonl.js';

test('JSONL decodes byte-fragmented UTF-8 and preserves Unicode line separators', () => {
  const input = new PassThrough();
  const records: unknown[] = [];
  const errors: Error[] = [];
  readJsonl(input, record => records.push(record), error => errors.push(error));
  const value = { text: 'snowman ☃, emoji 🦊, separators \u2028 and \u2029' };
  for (const byte of Buffer.from(JSON.stringify(value) + '\r\n\n {"next":true}\n')) input.write(Buffer.from([byte]));
  input.end();
  assert.deepEqual(records, [value, { next: true }]);
  assert.deepEqual(errors, []);
});

test('JSONL dispatches every record in a chunk synchronously, before promise continuations', async () => {
  const input = new PassThrough();
  const order: string[] = [];
  readJsonl(input, record => {
    order.push(record.type);
    if (record.type === 'response') void Promise.resolve().then(() => order.push('continuation'));
  }, assert.fail);
  input.end('{"type":"response"}\n{"type":"event"}\n');
  assert.deepEqual(order, ['response', 'event']);
  await Promise.resolve();
  assert.deepEqual(order, ['response', 'event', 'continuation']);
});

test('JSONL rejects invalid records once and stops delivering later frames', () => {
  for (const line of ['null', '[]', 'true', '123', '"string"', '{broken']) {
    const input = new PassThrough();
    const records: unknown[] = [];
    const errors: Error[] = [];
    readJsonl(input, record => records.push(record), error => errors.push(error));
    input.end(`${line}\n{"ignored":true}\n`);
    assert.equal(errors.length, 1, line);
    assert.deepEqual(records, [], line);
  }
});

test('JSONL requires LF termination and unsubscribe removes its input listeners', async () => {
  const input = new PassThrough();
  const errors: Error[] = [];
  const finished = new Promise<void>(resolve => input.once('end', resolve));
  readJsonl(input, assert.fail, error => errors.push(error));
  input.end('{"truncated":true}');
  await finished;
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Truncated JSONL record/);
  const detached = new PassThrough();
  const unsubscribe = readJsonl(detached, assert.fail, assert.fail);
  unsubscribe();
  assert.equal(detached.listenerCount('data'), 0);
  assert.equal(detached.listenerCount('end'), 0);
  assert.equal(detached.listenerCount('error'), 0);
  detached.destroy();
});

test('JSONL writes one LF-delimited record and rejects closed or overloaded output', () => {
  const chunks: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  writeJsonl(output, { text: 'one\ntwo\u2028three' });
  assert.deepEqual(chunks, ['{"text":"one\\ntwo\u2028three"}\n']);
  Object.defineProperty(output, 'writableLength', { value: MAX_QUEUED_BYTES });
  assert.throws(() => writeJsonl(output, {}), /output queue exceeds limit/);
  output.destroy();
  assert.throws(() => writeJsonl(output, {}), /Connection is closed/);
});
