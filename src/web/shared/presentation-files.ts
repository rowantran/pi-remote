import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';

// These are resource bounds for trusted, same-user source, not a JavaScript sandbox.
export const MAX_PRESENTATION_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_PRESENTATION_SOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_PRESENTATION_SOURCE_FILES = 2048;
export const MAX_PRESENTATION_CONFIG_BYTES = 128 * 1024;

/** Check the opened object before reading, so a FIFO/device can never block a reload. */
export async function readPresentationFile(path: string, limit = MAX_PRESENTATION_SOURCE_BYTES): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`Presentation input must be a regular file at most ${limit} bytes: ${path}`);
    const data = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null);
      if (!bytesRead) return data.subarray(0, length);
      length += bytesRead;
    }
    // A source that grows during a read is retried on the next reload, not cached partially.
    throw new Error(`Presentation input changed or exceeded its size limit: ${path}`);
  } finally { await file.close(); }
}

export interface PresentationSourceSnapshot { bytes: number; hash: string }
export function presentationSourceSnapshot(data: Buffer): PresentationSourceSnapshot {
  return { bytes: data.length, hash: createHash('sha256').update(data).digest('hex') };
}
export function presentationSnapshotsHash(sources: Map<string, PresentationSourceSnapshot>): string {
  const hash = createHash('sha256');
  for (const [path, source] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(JSON.stringify([path, source.bytes, source.hash]));
  }
  return hash.digest('hex');
}

/** Jiti's synchronous require API needs the same regular-file and byte bounds. */
export function readPresentationFileSync(path: string): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > MAX_PRESENTATION_SOURCE_BYTES) throw new Error(`Presentation input must be a regular file at most ${MAX_PRESENTATION_SOURCE_BYTES} bytes: ${path}`);
    const data = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < data.length) {
      const bytesRead = readSync(file, data, length, data.length - length, null);
      if (!bytesRead) return data.subarray(0, length);
      length += bytesRead;
    }
    throw new Error(`Presentation input changed or exceeded its size limit: ${path}`);
  } finally { closeSync(file); }
}

export async function presentationSourcesHash(paths: string[]): Promise<string> {
  const files = [...new Set(paths)].sort();
  if (files.length > MAX_PRESENTATION_SOURCE_FILES) throw new Error('Presentation source file count exceeds limit');
  const sources = new Map<string, PresentationSourceSnapshot>();
  let total = 0;
  for (const path of files) {
    const data = await readPresentationFile(path);
    total += data.length;
    if (total > MAX_PRESENTATION_SOURCE_TOTAL_BYTES) throw new Error('Presentation source bytes exceed limit');
    sources.set(path, presentationSourceSnapshot(data));
  }
  return presentationSnapshotsHash(sources);
}
