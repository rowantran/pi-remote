import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { MAX_FRAME_BYTES, MAX_QUEUED_BYTES, readJsonl, writeJsonl } from '../src/jsonl.js';

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

test('JSONL byte accounting is linear for a fragmented frame', t => {
  const input = new PassThrough();
  const value = { text: 'x'.repeat(1024 * 1024) };
  const frame = Buffer.from(JSON.stringify(value) + '\n');
  const byteLength = Buffer.byteLength;
  let countedCharacters = 0;
  let dispatched = false;
  readJsonl(input, record => { assert.deepEqual(record, value); dispatched = true; }, assert.fail);
  t.mock.method(Buffer, 'byteLength', (value: Parameters<typeof byteLength>[0], encoding?: BufferEncoding) => {
    if (typeof value === 'string') countedCharacters += value.length;
    return byteLength(value, encoding);
  });
  for (let offset = 0; offset < frame.length; offset += 16 * 1024) input.write(frame.subarray(offset, offset + 16 * 1024));
  assert.equal(dispatched, true, 'dispatch must finish before the final write returns');
  assert.ok(countedCharacters <= frame.length * 3, `counted ${countedCharacters} characters for ${frame.length} bytes`);
  input.end();
});

test('JSONL does not treat a bare CR as a frame delimiter', () => {
  const input = new PassThrough();
  const errors: Error[] = [];
  readJsonl(input, assert.fail, error => errors.push(error));
  input.write('{"first":1}\r{"second":2}\r');
  assert.deepEqual(errors, []);
  input.write('\n');
  assert.equal(errors.length, 1, 'two objects separated only by CR are one invalid frame');
  input.end();
});

test('JSONL completes a buffered frame and dispatches later frames in the same chunk synchronously', () => {
  const input = new PassThrough();
  const records: unknown[] = [];
  readJsonl(input, record => records.push(record), assert.fail);
  input.write('{"first":');
  input.write('1}\r\n\n{"second":2}\n{"third":');
  assert.deepEqual(records, [{ first: 1 }, { second: 2 }]);
  input.write('3}\n');
  assert.deepEqual(records, [{ first: 1 }, { second: 2 }, { third: 3 }]);
  input.end();
});

test('JSONL accepts a fragmented frame at the exact byte limit and counts UTF-8, not characters', () => {
  const input = new PassThrough();
  let records = 0;
  readJsonl(input, record => {
    records++;
    assert.equal(Buffer.byteLength(JSON.stringify(record)), MAX_FRAME_BYTES);
  }, assert.fail);
  // Emit strings to avoid allocating an extra full-size encoded buffer in this boundary test.
  const text = 'é'.repeat((MAX_FRAME_BYTES - 16) / 2) + 'x';
  input.emit('data', '{"text":"');
  input.emit('data', text);
  // String chunks may split a UTF-16 surrogate pair, unlike StringDecoder output.
  input.emit('data', '\uD83E');
  input.emit('data', '\uDD8A');
  input.emit('data', '"}');
  input.emit('data', '\r\n');
  assert.equal(records, 1);
  input.end();
});

test('JSONL rejects an oversized complete frame and stops dispatching in strict mode', () => {
  const input = new PassThrough();
  const errors: Error[] = [];
  readJsonl(input, assert.fail, error => errors.push(error));
  input.emit('data', 'x'.repeat(MAX_FRAME_BYTES + 1) + '\n{"ignored":true}\n');
  input.write('{broken}\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /JSONL frame exceeds limit/);
  input.end();
});

test('JSONL recovery discards an oversized fragmented frame through LF, then resumes in the same chunk', () => {
  const input = new PassThrough();
  const records: unknown[] = [];
  const errors: Error[] = [];
  readJsonl(input, record => records.push(record), error => errors.push(error), { recover: true });
  // The character count is below the limit, but the decoded UTF-8 byte count exceeds it.
  const fragment = '☃'.repeat(1024 * 1024);
  for (let i = 0; i < 22; i++) input.emit('data', fragment);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /JSONL frame exceeds limit/);
  input.write('{"discarded":true}');
  input.write('\r\n{"kept":1}\n{broken}\n{"kept":2}\n');
  assert.deepEqual(records, [{ kept: 1 }, { kept: 2 }]);
  assert.equal(errors.length, 2, 'discarded suffix must not produce another parse error');
  input.end();
});

test('JSONL recovery skips an oversized complete frame without discarding the next frame', () => {
  const input = new PassThrough();
  const records: unknown[] = [];
  const errors: Error[] = [];
  readJsonl(input, record => records.push(record), error => errors.push(error), { recover: true });
  input.emit('data', 'x'.repeat(MAX_FRAME_BYTES + 1) + '\n{"kept":true}\n');
  assert.deepEqual(records, [{ kept: true }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /JSONL frame exceeds limit/);
  input.end();
});

test('JSONL end handling ignores whitespace and an already discarded oversized frame', async () => {
  for (const oversized of [false, true]) {
    const input = new PassThrough();
    const errors: Error[] = [];
    const finished = new Promise<void>(resolve => input.once('end', resolve));
    readJsonl(input, assert.fail, error => errors.push(error), { recover: true });
    if (oversized) input.emit('data', 'x'.repeat(MAX_FRAME_BYTES + 1));
    input.end(' \r\t');
    await finished;
    assert.equal(errors.length, oversized ? 1 : 0);
    if (oversized) assert.match(errors[0].message, /JSONL frame exceeds limit/);
  }
});

test('JSONL reports handler errors separately and still delivers later records', () => {
  const input = new PassThrough();
  const records: unknown[] = [];
  const handlerErrors: Error[] = [];
  const failure = new Error('display failed');
  readJsonl(input, record => {
    records.push(record);
    if (record.fail) throw failure;
  }, assert.fail, { onHandlerError: error => handlerErrors.push(error) });
  input.end('{"fail":true}\n{"kept":true}\n');
  assert.deepEqual(records, [{ fail: true }, { kept: true }]);
  assert.deepEqual(handlerErrors, [failure]);
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
