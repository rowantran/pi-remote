import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** Strict LF framing: readline also splits Unicode separators inside JSON strings. */
export function readJsonl(input: Readable, onRecord: (value: any) => void, onError: (error: Error) => void,
  options: { recover?: boolean; onHandlerError?: (error: Error) => void } = {}): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let failed = false;
  let discarding = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = !options.recover;
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  const parse = (chunk: string) => {
    if (failed) return;
    if (discarding) {
      const end = chunk.indexOf('\n');
      if (end === -1) return;
      discarding = false;
      chunk = chunk.slice(end + 1);
    }
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        fail(new Error('JSONL frame exceeds limit'));
        if (failed) return;
        continue;
      }
      if (!line.trim()) continue;
      let value: any;
      try {
        value = JSON.parse(line);
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object');
      } catch (error) { fail(error); if (failed) return; else continue; }
      // Consumer bugs are not wire corruption. The Pi reader must never kill a healthy
      // agent because a display reducer or a client event listener threw.
      try { onRecord(value); }
      catch (error) {
        const handlerError = error instanceof Error ? error : new Error(String(error));
        if (options.onHandlerError) options.onHandlerError(handlerError);
        else { fail(handlerError); if (failed) return; }
      }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      buffer = ''; discarding = true;
      fail(new Error('JSONL frame exceeds limit'));
    }
  };
  const onData = (chunk: Buffer | string) => parse(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const onEnd = () => {
    parse(decoder.end());
    if (buffer.trim() && !failed) fail(new Error('Truncated JSONL record'));
  };
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', fail);
  return () => { input.off('data', onData); input.off('end', onEnd); input.off('error', fail); };
}

export function writeJsonl(output: Writable, value: unknown): void {
  if (output.destroyed || !output.writable) throw new Error('Connection is closed');
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('JSONL frame exceeds limit');
  // A slow presentation must not stall a remote Pi process or grow memory without bound.
  if (output.writableLength + Buffer.byteLength(line) > MAX_QUEUED_BYTES) throw new Error('Connection output queue exceeds limit');
  output.write(line);
}
