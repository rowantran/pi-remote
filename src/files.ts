import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export interface PathCompletionItem { value: string; label: string; directory: boolean }
export interface PathCompletionResult { items: PathCompletionItem[]; truncated: boolean }
export interface CompletePathOptions { prefix: string; cwd?: string; directoriesOnly?: boolean }
export interface AttachmentImage { type: 'image'; data: string; mimeType: string }
export interface Attachment { path: string; text?: string; image?: AttachmentImage }
export interface FilesystemMetadata { homeDir: string; gitBranch?: string }
export const MAX_COMPLETION_ITEMS = 500;
export const MAX_DIRECTORY_ENTRIES = 10_000;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const unsafePath = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const execute = promisify(execFile);

function pathString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || unsafePath.test(value)) {
    throw new Error(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} path without control characters`);
  }
  return value;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  // Do not pretend to support shell ~user expansion.
  if (path.startsWith('~')) throw new Error('Only ~ and ~/ paths are supported; ~user paths are not');
  return path;
}

function workingDirectory(cwd?: string): string {
  return cwd === undefined ? homedir() : resolve(homedir(), expandHome(pathString(cwd, 'cwd')));
}

function resolvedPath(path: string, cwd?: string): string {
  return resolve(workingDirectory(cwd), expandHome(pathString(path, 'path')));
}

/** Read-only, bounded directory completion. Values are raw paths, not shell expressions. */
export async function completePath({ prefix, cwd, directoriesOnly = false }: CompletePathOptions): Promise<PathCompletionResult> {
  pathString(prefix, 'prefix', true);
  if (typeof directoriesOnly !== 'boolean') throw new Error('directoriesOnly must be a boolean');
  const display = prefix === '~' ? '~/' : prefix;
  const slash = display.lastIndexOf('/');
  const parent = display.slice(0, slash + 1);
  const namePrefix = display.slice(slash + 1);
  if (prefix.startsWith('~') && !display.startsWith('~/')) return { items: [], truncated: false };
  const directory = parent ? resolvedPath(parent, cwd) : workingDirectory(cwd);
  const items: PathCompletionItem[] = [];
  let scanned = 0;
  let truncated = false;
  let dir;
  try { dir = await opendir(directory); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return { items, truncated };
    }
    throw error;
  }
  try {
    while (scanned < MAX_DIRECTORY_ENTRIES) {
      const entry = await dir.read();
      if (!entry) break;
      scanned++;
      if (!entry.name.startsWith(namePrefix) || unsafePath.test(entry.name)) continue;
      let directoryEntry = entry.isDirectory();
      let regularFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(resolve(directory, entry.name));
          directoryEntry = target.isDirectory(); regularFile = target.isFile();
        } catch { continue; } // Broken links, loops, and inaccessible targets are not useful suggestions.
      }
      if ((!directoryEntry && !regularFile) || (directoriesOnly && !directoryEntry)) continue;
      const label = entry.name + (directoryEntry ? '/' : '');
      items.push({ value: parent + label, label, directory: directoryEntry });
    }
    // Conservatively signal the scan limit without reading an extra entry.
    truncated = scanned === MAX_DIRECTORY_ENTRIES || items.length > MAX_COMPLETION_ITEMS;
  } finally { await dir.close(); }
  items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.label.localeCompare(b.label));
  return { items: items.slice(0, MAX_COMPLETION_ITEMS), truncated };
}

/** symbolic-ref does not invoke hooks, filters, project programs, or a shell. */
export async function filesystemMetadata({ cwd }: { cwd?: string }): Promise<FilesystemMetadata> {
  const homeDir = homedir();
  const directory = workingDirectory(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const { stdout } = await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null', 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: directory, timeout: 2000, maxBuffer: 16 * 1024, encoding: 'utf8',
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const gitBranch = stdout.trim();
    if (gitBranch && !unsafePath.test(gitBranch)) return { homeDir, gitBranch };
  } catch { /* Detached HEAD, non-repository, missing git, and timeouts omit the branch. */ }
  return { homeDir };
}

/**
 * Sniff the already-open file. Pi's public detectSupportedImageMimeTypeFromFile
 * reopens a pathname without O_NONBLOCK, so it cannot safely be used here.
 * Match Pi's supported formats, including its APNG exclusion, without deep imports.
 */
export function imageMimeType(bytes: Buffer): string | undefined {
  const ascii = (start: number, value: string) => bytes.toString('latin1', start, start + value.length) === value;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[3] !== 0xf7) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (bytes.length >= 16 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && ascii(12, 'IHDR')) {
    for (let offset = 8; offset + 8 <= bytes.length;) {
      if (ascii(offset + 4, 'acTL')) return undefined;
      if (ascii(offset + 4, 'IDAT')) break;
      offset += 12 + bytes.readUInt32BE(offset);
    }
    return 'image/png';
  }
  if (bytes.length >= 26 && ascii(0, 'BM')) {
    const size = bytes.readUInt32LE(2), pixels = bytes.readUInt32LE(10), dib = bytes.readUInt32LE(14);
    if ((size && size < 26) || pixels < 14 + dib || (size && pixels >= size)) return undefined;
    const offset = dib === 12 ? 22 : dib >= 40 && dib <= 124 && bytes.length >= 30 ? 26 : -1;
    if (offset >= 0 && bytes.readUInt16LE(offset) === 1 && [1, 4, 8, 16, 24, 32].includes(bytes.readUInt16LE(offset + 2))) return 'image/bmp';
  }
  return undefined;
}

/** Explicit attachment reads only; never scans content or silently truncates a file. */
export async function readAttachment({ path, cwd }: { path: string; cwd?: string }): Promise<Attachment> {
  const absolute = resolvedPath(path, cwd);
  try {
    // Avoid opening known devices. fstat below also checks replacements between stat and open.
    if (!(await stat(absolute)).isFile()) throw new Error('Attachments must be regular files (not directories, FIFOs, or devices)');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error('Attachments must be regular files (not directories, FIFOs, or devices)');
      if (metadata.size > MAX_IMAGE_BYTES) throw new Error('Attachment exceeds the 8 MiB image / 1 MiB text limit');
      const head = Buffer.alloc(4100);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const mimeType = imageMimeType(head.subarray(0, bytesRead));
      const limit = mimeType ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
      const tooLarge = () => new Error(`Attachment exceeds the ${mimeType ? '8 MiB image' : '1 MiB text'} limit`);
      if (metadata.size > limit) throw tooLarge();
      // Read one extra byte so growth after fstat also fails instead of truncating.
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > limit) throw tooLarge();
      const bytes = buffer.subarray(0, length);
      // Validate again against the bytes returned, not only the initial header.
      const finalMime = imageMimeType(bytes);
      if (finalMime !== mimeType) throw new Error('Attachment changed while reading; try again');
      if (mimeType) return { path: absolute, image: { type: 'image', data: bytes.toString('base64'), mimeType } };
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error('Attachment is binary or is not valid UTF-8 text'); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error('Attachment is binary, not text or a supported image');
      return { path: absolute, text };
    } finally { await handle.close(); }
  } catch (error) {
    const wrapped = new Error(`Cannot attach ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    // Preserve ENOENT for callers that distinguish a plain @mention from an explicit path.
    Object.assign(wrapped, { code: (error as NodeJS.ErrnoException).code });
    throw wrapped;
  }
}

/** Shared by the daemon and the stdin-JSON sideband; callers resolve slotId to cwd. */
export async function serveFileRequest(method: string, params: Record<string, unknown> = {}): Promise<PathCompletionResult | Attachment | FilesystemMetadata> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('File request params must be an object');
  const cwd = params.cwd === undefined ? undefined : pathString(params.cwd, 'cwd');
  switch (method) {
    case 'complete_path':
      if (params.directoriesOnly !== undefined && typeof params.directoriesOnly !== 'boolean') throw new Error('directoriesOnly must be a boolean');
      return completePath({ prefix: pathString(params.prefix, 'prefix', true), cwd, directoriesOnly: params.directoriesOnly as boolean | undefined });
    case 'read_attachment': return readAttachment({ path: pathString(params.path, 'path'), cwd });
    case 'filesystem_metadata': return filesystemMetadata({ cwd });
    default: throw new Error(`Unknown file request: ${method}`);
  }
}
