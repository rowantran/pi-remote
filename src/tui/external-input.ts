import { CustomEditor } from '@earendil-works/pi-coding-agent';
import type { SelectItem } from '@earendil-works/pi-tui';
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES, type Attachment } from '../protocol/files.js';
import type { RecordValue } from '../protocol/types.js';

/** A host-owned text input and dialogs. Pi still owns drafts, history, and request handling. */
export interface ExternalInput {
  onDraftChange(text: string): void;
  /** Called only when the outstanding remote dialog changes; undefined clears it. */
  onDialogChange(record: RecordValue | undefined): void;
  /** The signal closes the host sheet when this local choice finishes or is cancelled. */
  choose?(title: string, items: SelectItem[], signal: AbortSignal): Promise<string | undefined>;
  /** Complex pickers still use terminal keys; the host can temporarily disable its text input. */
  onTerminalDialogChange?(active: boolean): void;
}

/** Keep Pi's input/history behavior, but leave all prompt painting to the host. */
export class ExternalInputEditor extends CustomEditor {
  override render(_width: number): string[] { return []; }
}

export const MAX_PROMPT_BYTES = 24 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

/** Validate and copy host-supplied bytes. This API never opens a local or remote pathname. */
export function externalAttachments(attachments: Attachment[]): Attachment[] {
  if (!Array.isArray(attachments)) throw new TypeError('Attachments must be an array');
  return attachments.map(file => {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.includes('\0')) throw new Error('Each attachment needs a filename');
    const copy: Attachment = { path: file.path };
    if (file.text !== undefined) {
      if (typeof file.text !== 'string') throw new TypeError('Attachment text must be a string');
      if (Buffer.byteLength(file.text, 'utf8') > MAX_TEXT_BYTES) throw new Error('Text attachments cannot exceed 1 MiB');
      copy.text = file.text;
    }
    if (file.image !== undefined) {
      const image = file.image;
      if (!image || image.type !== 'image' || !IMAGE_TYPES.has(image.mimeType) || typeof image.data !== 'string'
        || !image.data.length || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
        || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
        throw new Error('Image attachments need supported image data encoded as base64, at most 8 MiB');
      }
      if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) throw new Error('Image attachments cannot exceed 8 MiB');
      copy.image = { type: 'image', data: image.data, mimeType: image.mimeType };
    }
    if (copy.text === undefined && !copy.image) throw new Error('Each attachment needs text or an image');
    return copy;
  });
}

export function localAttachmentText(attachments: Attachment[]): string {
  return attachments.filter(file => file.text !== undefined).map(file => `\n\nAttached local file ${file.path}:\n${file.text}`).join('');
}

/** Reserve the serialized prompt budget, including JSON escaping and image base64. */
export function checkExternalPromptSize(text: string, attachments: Attachment[]): void {
  const images = attachments.flatMap(file => file.image ? [file.image] : []);
  const prompt = { type: 'prompt', message: text + localAttachmentText(attachments), ...(images.length ? { images } : {}), streamingBehavior: 'followUp' };
  if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > MAX_PROMPT_BYTES) throw new Error('Combined prompt and attachments exceed 24 MiB; nothing was sent');
}
