import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolvedPath } from './file-paths.js';
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES, type Attachment } from './files.js';

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
