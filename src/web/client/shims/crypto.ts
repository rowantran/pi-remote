import { Buffer } from 'buffer';
import { unavailable } from './unsupported.js';

export function randomUUID(): string { return globalThis.crypto.randomUUID(); }
export function randomBytes(size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Expected a non-negative random byte count');
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 65_536) globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
  return bytes;
}
export function createHash(): never { return unavailable('crypto.createHash'); }
