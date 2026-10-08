import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { connectCompatibleLocal, connectCompatibleSsh } from './compat-client.js';
import { defaultCwd as configuredDefaultCwd, defaultHost as configuredDefaultHost } from './config.js';
import { nodeModuleArgs } from './node-entry.js';
import type { RemoteConnection, SlotInfo } from './protocol.js';

export const VALUE_OPTIONS = ['--host', '--remote-bin', '--state-dir', '--cwd', '--session', '--ui-extension', '--ui-config', '--theme'] as const;
export const BOOLEAN_OPTIONS = ['--local', '--json', '--no-attach', '--no-reconnect', '--no-bell', '--all', '--force', '--wait', '--help'] as const;
export const COMMANDS = ['new', 'ls', 'attach', 'kill', 'watch', 'rpc', 'restart-daemon', 'completion', 'help', 'version'] as const;
const COMMAND_LABELS: Partial<Record<typeof COMMANDS[number], string>> = {
  rpc: 'Power-user/debug: send a JSON command',
  watch: 'Power-user/debug: stream session events as JSON',
  'restart-daemon': 'Run the installed release; reopen idle slots',
};
const SLOT_COMMANDS = new Set(['attach', 'kill', 'watch', 'rpc']);
/** Server/internal commands: exact names only, never matched by a prefix. */
export const INTERNAL_COMMANDS = ['complete', 'fs', 'daemon', 'bridge'] as const;

/** Exact names win (including internal ones). Otherwise an unambiguous prefix
 * of a public command selects it, e.g. n -> new, k -> kill. Unknown or
 * ambiguous input is returned unchanged with any matching candidates. */
export function matchCommand(input: string): { command?: string; candidates: string[] } {
  if ((COMMANDS as readonly string[]).includes(input) || (INTERNAL_COMMANDS as readonly string[]).includes(input)) return { command: input, candidates: [input] };
  const candidates = input ? COMMANDS.filter(command => command.startsWith(input)) : [];
  return { command: candidates.length === 1 ? candidates[0] : undefined, candidates };
}
export function resolveCommand(input: string): string {
  const { command, candidates } = matchCommand(input);
  if (command) return command;
  if (candidates.length > 1) throw new Error(`Ambiguous command '${input}': ${candidates.join(', ')}. See --help.`);
  throw new Error(`Unknown command '${input}'. See --help.`);
}
export type NumberedSlot = SlotInfo & { number?: number };
export interface CompletionItem { value: string; label: string; directory: boolean }
export interface PathCompletion { items: CompletionItem[]; truncated: boolean }
export type CompletionShell = 'fish' | 'zsh' | 'bash';

/** Old daemons only append slots and retain exited entries, so insertion order
 * supplies the same short reference until the new daemon persists numbers. */
export function numberSlots(slots: NumberedSlot[]): NumberedSlot[] {
  return slots.map((slot, index) => ({ ...slot, number: slotNumber(slot) ?? index + 1 }));
}
export function slotNumber(slot: NumberedSlot): number | undefined {
  return Number.isSafeInteger(slot.number) && slot.number! > 0 ? slot.number : undefined;
}
export function slotLabel(slot: SlotInfo): string {
  return `${slot.status} · ${slot.sessionName || '(unnamed)'} · ${slot.cwd}`;
}

/** The host is never positional: --host wins, then the default (PI_REMOTE_HOST
 * or the config file). --local ignores both. */
export function selectHost(options: { host?: string; local?: boolean; defaultHost?: string }): string | undefined {
  if (options.local) return undefined;
  return options.host ?? (options.defaultHost || undefined);
}

/** Remove shell quoting, but never expand variables, substitutions, globs, or ~.
 * Completion words are data, including unfinished quotes at the cursor. */
export function unquoteWord(word: string, shell: CompletionShell): string {
  let output = '', quote = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === '\\' && i + 1 < word.length) {
      const next = word[i + 1];
      const escapes = !quote || (quote === '"' && (shell === 'fish' ? /["\\$]/ : /["\\$`\n]/).test(next)) || (quote === "'" && shell === 'fish' && /['\\]/.test(next));
      if (escapes) { output += next === '\n' ? '' : next; i++; continue; }
    }
    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) { quote = quote ? '' : ch; continue; }
    output += ch;
  }
  return output;
}

/** Bash supplies the original line because COMP_WORDS splits '=' and ':'.
 * Tokenize quotes and escapes only. Shell operators/substitutions are refused,
 * not evaluated; shells never send a command string to a remote interpreter. */
export function tokenizeCompletionLine(line: string): string[] {
  const words: string[] = [];
  let word = '', quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && quote !== "'" && i + 1 < line.length) { word += ch + line[++i]; continue; }
    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) { quote = quote ? '' : ch; word += ch; continue; }
    if (!quote && /[|;&<>\n]/.test(ch)) return [];
    if (quote !== "'" && (ch === '`' || (ch === '$' && line[i + 1] === '('))) return [];
    if (!quote && /\s/.test(ch)) { if (word) { words.push(word); word = ''; } }
    else word += ch;
  }
  words.push(word);
  return words.map(word => unquoteWord(word, 'bash'));
}

interface CompletionContext {
  command: string;
  prefix: string;
  valueOption?: string;
  insertionPrefix: string;
  values: Map<string, string>;
  local: boolean;
  positionals: string[];
  forwarded: boolean;
}
export function completionContext(words: string[]): CompletionContext {
  const command = matchCommand(words[0] ?? '').command ?? words[0] ?? '';
  const current = words.length > 1 ? words.at(-1)! : '';
  const context: CompletionContext = { command, prefix: current, insertionPrefix: '', values: new Map(), local: false, positionals: [], forwarded: false };
  let pending: string | undefined;
  for (const word of words.slice(1, -1)) {
    if (pending) { context.values.set(pending, word); pending = undefined; continue; }
    if (word === '--') { context.forwarded = true; break; }
    const equals = word.indexOf('=');
    const flag = equals < 0 ? word : word.slice(0, equals);
    if ((VALUE_OPTIONS as readonly string[]).includes(flag)) {
      if (equals < 0) pending = flag;
      else context.values.set(flag, word.slice(equals + 1));
    } else if (word === '--local') context.local = true;
    else if (!word.startsWith('-')) context.positionals.push(word);
  }
  context.valueOption = pending;
  if (!pending) {
    const equals = current.indexOf('=');
    const flag = equals < 0 ? current : current.slice(0, equals);
    if (equals >= 0 && (VALUE_OPTIONS as readonly string[]).includes(flag)) {
      context.valueOption = flag;
      context.insertionPrefix = `${flag}=`;
      context.prefix = current.slice(equals + 1);
    }
  }
  return context;
}

/** Completion is silent: a malformed config file yields no default host. */
function safeDefaultHost(): string | undefined {
  try { return configuredDefaultHost(); } catch { return undefined; }
}
function safeDefaultCwd(): string | undefined {
  try { return configuredDefaultCwd(); } catch { return undefined; }
}
export interface CompletionDependencies {
  connect?: (options: { host?: string; local: boolean; remoteBin?: string; stateDir?: string }) => Promise<Pick<RemoteConnection, 'request' | 'close'>>;
  defaultHost?: string;
  defaultCwd?: string;
}
/** Only hello (inside connect), list, and complete_path are used. Never attaches,
 * creates a slot, invokes a Pi command, or retries a request. */
export async function completeWords(words: string[], dependencies: CompletionDependencies = {}): Promise<CompletionItem[]> {
  // Accept both a full shell word array and command arguments without argv[0].
  if (words[0] && basename(words[0]) === 'pi-remote') words = words.slice(1);
  if (words.length <= 1) return COMMANDS.filter(value => value.startsWith(words[0] ?? '')).map(value => ({ value, label: COMMAND_LABELS[value] ?? 'Command', directory: false }));
  const context = completionContext(words);
  if (context.forwarded || !(COMMANDS as readonly string[]).includes(context.command)) return [];
  if (context.command === 'completion') return ['fish', 'zsh', 'bash'].filter(value => value.startsWith(context.prefix)).map(value => ({ value, label: 'Print shell completion script', directory: false }));
  if (!context.valueOption && context.prefix.startsWith('-')) return [...VALUE_OPTIONS, ...BOOLEAN_OPTIONS].filter(value => value.startsWith(context.prefix)).map(value => ({ value, label: 'Option', directory: false }));
  const pathOption = context.valueOption === '--cwd' || context.valueOption === '--session';
  if (context.valueOption && !pathOption) return [];
  const slotCompletion = !context.valueOption && SLOT_COMMANDS.has(context.command);
  if (!pathOption && !slotCompletion) return [];
  if (slotCompletion && context.positionals.length > 0) return [];
  const host = selectHost({ host: context.values.get('--host'), local: context.local, defaultHost: dependencies.defaultHost ?? safeDefaultHost() });
  if (!context.local && !host) return [];
  const connect = dependencies.connect ?? (options => options.local ? connectCompatibleLocal(options.stateDir) : connectCompatibleSsh({ host: options.host!, remoteBin: options.remoteBin, stateDir: options.stateDir }));
  let connection: Pick<RemoteConnection, 'request' | 'close'> | undefined;
  try {
    connection = await connect({ host, local: context.local, remoteBin: context.values.get('--remote-bin'), stateDir: context.values.get('--state-dir') });
    if (pathOption) {
      // --session paths are relative to --cwd, or to the default directory that new would use.
      const sessionBase = context.valueOption === '--session' ? context.values.get('--cwd') ?? (context.local ? undefined : (dependencies.defaultCwd ?? safeDefaultCwd()) || undefined) : undefined;
      const result = await connection.request<PathCompletion>('complete_path', {
        prefix: context.prefix,
        ...(sessionBase ? { cwd: sessionBase } : {}),
        directoriesOnly: context.valueOption === '--cwd',
      });
      if (!Array.isArray(result?.items)) return [];
      return result.items.slice(0, 500).filter(item => typeof item.value === 'string' && typeof item.label === 'string' && typeof item.directory === 'boolean' && (context.valueOption !== '--cwd' || item.directory)).map(item => ({
        value: context.insertionPrefix + item.value + (item.directory && !item.value.endsWith('/') ? '/' : ''), label: item.label, directory: item.directory,
      }));
    }
    const slots = numberSlots(await connection.request<NumberedSlot[]>('list'));
    // Every slot command needs a running Pi process, so stopped slots are not offered.
    return slots.filter(slot => slot.status !== 'exited').flatMap(slot => {
      const number = slotNumber(slot);
      const value = number === undefined ? slot.id : String(number);
      // UUID/prefix remains available if explicitly typed, while the default
      // menu uses stable daemon-assigned numbers, never list positions.
      const candidate = value.startsWith(context.prefix) ? value : context.prefix && !/^\d+$/.test(context.prefix) && slot.id.startsWith(context.prefix) ? slot.id : undefined;
      return candidate === undefined ? [] : [{ value: candidate, label: slotLabel(slot), directory: false }];
    }).slice(0, 500);
  } catch { return []; }
  finally { connection?.close(); }
}

export async function completionScript(shell: string): Promise<string> {
  const file = shell === 'fish' ? 'pi-remote.fish' : shell === 'zsh' ? '_pi-remote' : shell === 'bash' ? 'pi-remote.bash' : undefined;
  if (!file) throw new Error('Usage: pi-remote completion fish|zsh|bash (prints a script; does not edit shell configuration)');
  return readFile(new URL(`../completions/${file}`, import.meta.url), 'utf8');
}

/** A line protocol deliberately excludes control-character filenames. This
 * prevents line/tab ambiguity and terminal-control injection in shell menus. */
export function formatCompletions(items: CompletionItem[], shell: CompletionShell): string {
  return items.filter(item => item.value && !/[\x00-\x1f\x7f-\x9f]/.test(item.value)).map(item => {
    const label = item.label.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    return shell === 'bash' ? item.value : `${item.value}\t${label}`;
  }).join('\n');
}

/** The worker owns a process group so a stalled SSH handshake can be cancelled
 * without leaving SSH behind. Killing this local group never sends slot kill.
 * stderr is not inherited: an unavailable host must be silent during Tab. */
export function boundedCompletions(words: string[], timeoutMs = 1800): Promise<CompletionItem[]> {
  return new Promise(resolveResult => {
    const detached = process.platform !== 'win32';
    const child = spawn(process.execPath, [...nodeModuleArgs(import.meta.url, 'completion'), '--worker', JSON.stringify(words)], { detached, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', done = false;
    const stop = () => {
      if (!child.pid) return;
      try { if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const finish = (items: CompletionItem[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      resolveResult(items);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 1024 * 1024) finish([]); });
    child.once('error', () => finish([]));
    child.once('close', code => {
      if (code !== 0) { finish([]); return; }
      try { const parsed = JSON.parse(output); finish(Array.isArray(parsed) ? parsed : []); }
      catch { finish([]); }
    });
  });
}

/** Bound optional stdin without exiting the embedding process or leaving a
 * detached completion worker alive after a late stdin delivery. */
function completionInput(timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolveInput => {
    let input = '', finished = false;
    const finish = (value?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', failed);
      process.stdin.pause();
      if (value === undefined) process.stdin.destroy();
      resolveInput(value);
    };
    process.stdin.setEncoding('utf8');
    const data = (chunk: string) => { input += chunk; if (input.length > 64 * 1024) finish(); };
    const end = () => finish(input);
    const failed = () => finish();
    const timer = setTimeout(() => finish(), timeoutMs);
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', failed);
    process.stdin.resume();
  });
}

export async function runCompletionCommand(args: string[]): Promise<void> {
  const started = Date.now();
  try {
    let shell: CompletionShell = 'fish', words: unknown, rawCurrent = false, rawWords = false, line: string | undefined, currentWord: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--') { words = args.slice(i + 1); break; }
      if (args[i] === '--line') { line = args[++i]; continue; }
      if (args[i] === '--current-word') { currentWord = args[++i]; continue; }
      if (args[i] === '--shell') { shell = args[++i] as CompletionShell; continue; }
      if (args[i] === '--words') { words = JSON.parse(args[++i]); continue; }
      if (args[i] === '--raw-current') { rawCurrent = true; continue; }
      if (args[i] === '--raw-words') { rawWords = true; continue; }
      return;
    }
    if (!['fish', 'zsh', 'bash'].includes(shell)) return;
    if (line !== undefined) { words = tokenizeCompletionLine(line).slice(1); if (!(words as string[]).length) return; }
    if (words === undefined) {
      if (process.stdin.isTTY) return;
      const input = await completionInput(1800);
      if (input === undefined) return;
      words = JSON.parse(input);
    }
    if (!Array.isArray(words) || words.length > 256 || words.some(word => typeof word !== 'string' || word.includes('\0')) || JSON.stringify(words).length > 64 * 1024) return;
    const tokens = words as string[];
    if (rawWords) for (let i = 0; i < tokens.length; i++) tokens[i] = unquoteWord(tokens[i], shell);
    else if (rawCurrent && tokens.length) tokens[tokens.length - 1] = unquoteWord(tokens.at(-1)!, shell);
    const remaining = 1800 - (Date.now() - started);
    if (remaining <= 0) return;
    let items = await boundedCompletions(tokens, remaining);
    if (shell === 'bash' && line !== undefined && currentWord !== undefined) {
      const full = tokens.at(-1) ?? '';
      const current = unquoteWord(currentWord, 'bash');
      // Readline replaces only the suffix after COMP_WORDBREAKS (= and : by
      // default). Strip the already-present part of each full candidate.
      const offset = current === '=' && full.endsWith('=') ? full.length : full.endsWith(current) ? full.length - current.length : 0;
      const retained = full.slice(0, offset);
      items = items.map(item => ({ ...item, value: item.value.startsWith(retained) ? item.value.slice(offset) : item.value }));
    }
    const output = formatCompletions(items, shell);
    if (output) process.stdout.write(`${output}\n`);
  } catch { /* Completion is best-effort, not a diagnostic command. */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv[2] === '--worker') {
  completeWords(JSON.parse(process.argv[3])).then(items => { process.stdout.write(JSON.stringify(items)); }, () => {}).finally(() => { process.exitCode = 0; });
}
