import { Buffer } from 'buffer';
import { hasVirtualDirectory, hasVirtualFile, readVirtualFile, unavailable, virtualDirectoryEntries, virtualStat } from './vfs.js';
import * as promises from './fs-promises.js';

export { promises };
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_NOFOLLOW: 0 };
type EncodingOptions = BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null;
export function readFileSync(path: unknown, options?: EncodingOptions): string | Buffer {
  if (options && typeof options === 'object' && options.flag && options.flag !== 'r') unavailable('fs.readFile with non-read flag');
  const bytes = Buffer.from(readVirtualFile(path), 'utf8');
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? bytes.toString(encoding) : bytes;
}
export function existsSync(path: unknown): boolean { return hasVirtualFile(path) || hasVirtualDirectory(path); }
export function readdirSync(path: unknown, options?: { withFileTypes?: boolean; recursive?: boolean; encoding?: string } | string) {
  if (typeof options === 'object' && options?.recursive) unavailable('fs.readdir recursive');
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (encoding && encoding !== 'utf8' && encoding !== 'utf-8') unavailable('fs.readdir non-text encoding');
  const entries = virtualDirectoryEntries(path);
  return typeof options === 'object' && options?.withFileTypes ? entries : entries.map(entry => entry.name);
}
export function statSync(path: unknown, options?: { bigint?: boolean }) {
  if (options?.bigint) unavailable('fs.stat bigint metadata');
  return virtualStat(path);
}
export function accessSync(path: unknown, mode = constants.F_OK): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) throw new RangeError('Invalid virtual file access mode');
  if (mode & (constants.W_OK | constants.X_OK)) unavailable('Writable/executable virtual files');
  virtualStat(path);
}
