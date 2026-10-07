import {
  fuzzyFilter, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, type SlashCommand,
} from '@earendil-works/pi-tui';
import type { Attachment, AttachmentImage, PathCompletionResult } from './files.js';

export interface FileReference { path: string; start: number; end: number }
interface ParsedReference extends FileReference { quoted: boolean; closed: boolean; escaped: boolean }
const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const boundary = (text: string, index: number) => index === 0 || /[\s([{]/.test(text[index - 1]);

/** A small literal tokenizer, not a shell parser. Offsets include @ and any quotes. */
function scanReferences(text: string, partial = false): ParsedReference[] {
  const references: ParsedReference[] = [];
  let code: { marker: string; count: number; fenced: boolean } | undefined;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === '`' || char === '~') {
      let end = index + 1;
      while (text[end] === char) end++;
      const count = end - index;
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      const fenced = count >= 3 && /^[ \t]{0,3}$/.test(text.slice(lineStart, index));
      if (code) {
        if (char === code.marker && (code.fenced ? fenced && count >= code.count : count === code.count)) code = undefined;
      } else if (char === '`' || fenced) code = { marker: char, count, fenced };
      index = end; continue;
    }
    if (code) { index++; continue; }
    if (char !== '@' || !boundary(text, index)) { index++; continue; }
    const start = index++;
    const quote = text[index] === '"' || text[index] === "'" ? text[index++] : undefined;
    let path = '', escaped = false, closed = !quote;
    while (index < text.length) {
      const next = text[index];
      if (next === '\n' || next === '\r') break;
      if (next === '\\') {
        if (index + 1 >= text.length) { index++; break; }
        if (text[index + 1] === '\n' || text[index + 1] === '\r') break;
        escaped = true; path += text[index + 1]; index += 2; continue;
      }
      if (quote && next === quote) { index++; closed = true; break; }
      if (!quote && /[\s)\]}>,;`'"(]/.test(next)) break;
      path += next; index++;
    }
    // Avoid treating a prefix of another token (or an email) as an attachment.
    const suffixBoundary = index === text.length || /[\s)\]}>,;]/.test(text[index]) || (!!quote && /[.!?:]/.test(text[index]));
    if ((path || partial) && !controls.test(path) && (quote || !path.includes('@')) &&
      (partial ? index === text.length || (closed && suffixBoundary) : closed && suffixBoundary)) {
      references.push({ path, start, end: index, quoted: !!quote, closed, escaped });
    }
  }
  return references;
}

/** Ignore email addresses, escaped @, and fenced/inline code. */
export function tokenizeFileReferences(text: string): FileReference[] {
  return scanReferences(text).map(({ path, start, end }) => ({ path, start, end }));
}

export interface RemoteAutocompleteOptions {
  /** Return get_commands data, not the outer RPC envelope. Cached until invalidateCommands(). */
  getCommands: () => Promise<{ commands: SlashCommand[] } | SlashCommand[]>;
  /** The caller binds slotId/cwd; only the raw path prefix is passed here. */
  completePath: (prefix: string) => Promise<PathCompletionResult>;
  localCommands?: readonly SlashCommand[];
}

const defaultCommands: readonly SlashCommand[] = [
  { name: 'attach', description: 'Attach a local file' },
  { name: 'detach', description: 'Detach without stopping remote Pi' },
  { name: 'help', description: 'Show local keyboard shortcuts and commands' },
  { name: 'model', description: 'Choose a model' },
  { name: 'new', description: 'Start a new session' },
  { name: 'fork', description: 'Browse the session tree and fork from a user prompt' },
  { name: 'tree', description: 'Tree-style fork picker (creates a new session)' },
  { name: 'resume', description: 'Resume a session' },
  { name: 'session', description: 'Show session information' },
  { name: 'copy', description: 'Copy the last response' },
  { name: 'name', description: 'Name this session' },
  { name: 'compact', description: 'Compact session context' },
];

function cursorText(lines: string[], cursorLine: number, cursorCol: number): string {
  return [...lines.slice(0, cursorLine), (lines[cursorLine] ?? '').slice(0, cursorCol)].join('\n');
}

function activeReference(lines: string[], cursorLine: number, cursorCol: number): ParsedReference | undefined {
  const before = cursorText(lines, cursorLine, cursorCol);
  const references = scanReferences(before, true);
  const reference = references.at(-1);
  if (!reference || reference.end !== before.length) return undefined;
  // A closed quoted reference is complete unless the cursor is still inside its quotes.
  if (reference.quoted && reference.closed) return undefined;
  return reference;
}

function quotePath(path: string): string {
  return /[\s\\"'`()\[\]{},;<>@]/.test(path) ? `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : path;
}

/** Uses only the public async pi-tui API; it never searches the local filesystem. */
export class RemoteAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ['/', '@'];
  private commands?: Promise<SlashCommand[]>;
  constructor(private readonly options: RemoteAutocompleteOptions) {}

  invalidateCommands(): void { this.commands = undefined; }

  setCommands(commands: SlashCommand[]): void { this.commands = Promise.resolve(this.mergeCommands(commands)); }

  private mergeCommands(remote: SlashCommand[]): SlashCommand[] {
    const byName = new Map<string, SlashCommand>();
    for (const command of [...remote, ...(this.options.localCommands ?? defaultCommands)]) {
      if (!command || typeof command.name !== 'string') continue;
      const name = command.name.replace(/^\//, '');
      if (!name || /[\s\x00-\x1f\x7f-\x9f]/.test(name)) continue;
      byName.set(name, { ...command, name });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private getCommands(): Promise<SlashCommand[]> {
    if (!this.commands) {
      this.commands = Promise.resolve().then(() => this.options.getCommands()).then(result => {
        const remote = Array.isArray(result) ? result : result.commands;
        return this.mergeCommands(Array.isArray(remote) ? remote : []);
      }).catch(() => this.mergeCommands([]));
    }
    return this.commands;
  }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number,
    { signal }: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    if (signal.aborted) return null;
    const before = cursorText(lines, cursorLine, cursorCol);
    // Only the first token of the whole prompt is a slash command.
    if (/^\/[^\s/]*$/.test(before)) {
      const commands = await this.getCommands();
      if (signal.aborted) return null;
      const items = fuzzyFilter(commands, before.slice(1), command => command.name).map(command => ({
        value: `/${command.name}`, label: `/${command.name}`,
        description: command.description?.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' '),
      }));
      return items.length ? { items, prefix: before } : null;
    }
    const reference = activeReference(lines, cursorLine, cursorCol);
    if (!reference) return null;
    try {
      const result = await this.options.completePath(reference.path);
      if (signal.aborted) return null;
      const items = result.items.filter(item => item && typeof item.value === 'string' && typeof item.label === 'string' &&
        !controls.test(item.value) && !controls.test(item.label)).map(item => ({
        ...item, value: item.directory && !item.value.endsWith('/') ? `${item.value}/` : item.value,
      }));
      return items.length ? { items, prefix: before.slice(reference.start) } : null;
    } catch { return null; } // A failed lookup must not break typing or submit a request.
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return !!activeReference(lines, cursorLine, cursorCol);
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): {
    lines: string[]; cursorLine: number; cursorCol: number;
  } {
    const result = [...lines];
    const line = result[cursorLine] ?? '';
    const start = Math.max(0, cursorCol - prefix.length);
    let end = cursorCol;
    let cursorOffset = 0;
    let insertion: string;
    if (prefix.startsWith('@')) {
      const fullText = lines.join('\n');
      const lineOffset = lines.slice(0, cursorLine).reduce((total, entry) => total + entry.length + 1, 0);
      const reference = scanReferences(fullText).find(candidate => candidate.start === lineOffset + start);
      // Replace the rest of the same token too when completing in the middle.
      if (reference && reference.end >= lineOffset + cursorCol) end = reference.end - lineOffset;
      const directory = item.value.endsWith('/');
      insertion = '@' + quotePath(item.value);
      if (directory && insertion.startsWith('@"')) {
        // Place the cursor before the closing quote so child paths stay in this token.
        cursorOffset = -1;
      } else if (!directory && !/^\s/.test(line.slice(end))) insertion += ' ';
    } else {
      while (end < line.length && !/\s/.test(line[end])) end++;
      insertion = item.value + (/^\s/.test(line.slice(end)) ? '' : ' ');
    }
    result[cursorLine] = line.slice(0, start) + insertion + line.slice(end);
    return { lines: result, cursorLine, cursorCol: start + insertion.length + cursorOffset };
  }
}

/**
 * Append explicit attachments without interpreting their contents or evaluating paths.
 * Unknown simple @mentions stay literal; missing quoted/dotted/slashed paths fail.
 * Keep the original prompt intact, including slash commands, for remote Pi expansion.
 */
export async function transformPromptWithAttachments(text: string, reader: (path: string) => Promise<Attachment>): Promise<{
  message: string; images: AttachmentImage[];
}> {
  const parts = [text];
  const images: AttachmentImage[] = [];
  const seen = new Set<string>();
  let bytes = Buffer.byteLength(text);
  for (const reference of scanReferences(text)) {
    if (seen.has(reference.path)) continue;
    seen.add(reference.path);
    if (seen.size > 32) throw new Error('At most 32 distinct @file references per prompt');
    let attachment: Attachment;
    try { attachment = await reader(reference.path); }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT' || /\bENOENT\b|no such file/i.test(error instanceof Error ? error.message : String(error));
      if (missing && !reference.quoted && !reference.escaped && /^[\p{L}\p{N}_-]+$/u.test(reference.path)) continue;
      throw new Error(`Could not attach @${JSON.stringify(reference.path)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    bytes += Buffer.byteLength(attachment.text ?? '') + (attachment.image?.data.length ?? 0);
    if (bytes > 24 * 1024 * 1024) throw new Error('Combined attachments exceed the 24 MiB prompt limit');
    const name = JSON.stringify(attachment.path);
    if (typeof attachment.text === 'string') parts.push(`Attached file ${name}:\n<file-content>\n${attachment.text}\n</file-content>`);
    if (attachment.image) {
      images.push(attachment.image);
      parts.push(`Attached image ${name} (image ${images.length}).`);
    }
    if (typeof attachment.text !== 'string' && !attachment.image) throw new Error(`Attachment ${name} contained neither text nor an image`);
  }
  return { message: parts.join('\n\n'), images };
}
