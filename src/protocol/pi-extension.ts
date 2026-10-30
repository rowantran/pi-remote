/**
 * Messages between pi-remote's Pi extension (inside the remote Pi process) and the
 * pi-remote host that owns that Pi process. Keep this file free of imports: Pi loads
 * the Pi extension through its own module loader, and this file is loaded with it.
 */

export interface RgbColor { r: number; g: number; b: number }

/** Answers to the queries Pi's renderer sends to its terminal, taken from a client's terminal. */
export interface TerminalAnswers {
  /** Kitty keyboard protocol flags. Undefined means the terminal does not use the protocol. */
  kittyFlags?: number;
  foreground?: RgbColor;
  background?: RgbColor;
  palette?: RgbColor[];
  /** Cell size in pixels, for image layout. */
  cell?: { width: number; height: number };
}

/** Environment variable with the Unix socket path the Pi extension connects to. */
export const PI_EXTENSION_SOCKET_ENV = 'PI_REMOTE_EXTENSION_SOCKET';

/**
 * Pi's interactive mode mounts these root children, in this order, in both its regular
 * and fullscreen layouts. The client rebuilds Pi's fullscreen layout from them.
 */
export const SECTION_NAMES = ['document', 'pendingMessages', 'status', 'widgetsAbove', 'editor', 'widgetsBelow', 'footer'] as const;
export const SECTION_COUNT = SECTION_NAMES.length;
export const EDITOR_SECTION = 4;

/** Replace `remove` lines at `start` with `insert`. */
export interface LineDiff { start: number; remove: number; insert: string[] }

export interface EditorState { text: string; cursor: { line: number; col: number } }

export type PiExtensionMessage =
  /**
   * Sent when Pi creates an editor in its editor slot. `bindings` are the remote's resolved
   * keybindings. `editor` says whether the editor is Pi's default or one an extension set.
   */
  | { type: 'editorInstalled'; editor: 'default' | 'extension'; bindings: Record<string, string | string[] | undefined>; theme?: string }
  /**
   * Rendered lines. `sections` holds changes for the sections that changed since the last frame.
   * `layout: 'unknown'` means the root did not match SECTION_NAMES; then `sections[0]`
   * holds every rendered line and the client must forward all keys. `editorFocused` means
   * the editor holds the editor slot and has keyboard focus (no picker or dialog is open).
   * `reset` means the diffs start from empty sections. `dropdownRows` is the number of
   * autocomplete rows at the end of the editor section; 0 when no dropdown is open.
   * `hardwareCursor` is Pi's showHardwareCursor setting, which the client's renderer applies.
   */
  | {
    type: 'frame'; width: number; layout: 'known' | 'unknown'; reset: boolean;
    sections: Record<number, LineDiff>; editorFocused: boolean; dropdownRows: number; hardwareCursor: boolean;
  }
  /**
   * Authoritative editor state. `barrier` is the last input barrier Pi processed, as
   * `CLIENT:NUMBER`; the state includes every key sent before it, from every client.
   */
  | { type: 'editor'; barrier: string; state: EditorState }
  /** Editor appearance that Pi sets on the stand-in editor. `border` wraps text as [before, after]. */
  | { type: 'editorChrome'; border: [string, string]; paddingX: number; autocompleteMaxVisible: number }
  | { type: 'history'; text: string }
  /** Facts about the Pi process and its current session, for the client's status panel. */
  | {
    type: 'session'; hostname: string; pid: number; piVersion: string; cwd: string;
    sessionId?: string; sessionFile?: string; sessionName?: string;
    /** Entries in the session; 0 means nothing would be lost by reopening it from its file. */
    entryCount?: number;
    /** The pi-remote session variables Pi sees; absent when Pi does not run in a pi-remote session. */
    remote?: { host?: string; slotId?: string };
  }
  /**
   * Pi lifecycle events for `ls`, notifications and busy checks, in the same shape as Pi's
   * RPC events, without transcript text: agent_start, agent_end, agent_settled,
   * message_end (role, stop reason, tool names), compaction_start, compaction_end,
   * extension_ui_request (a dialog opened) and remote_dialog_resolved.
   */
  | { type: 'activity'; event: { type: string; [key: string]: unknown } }
  /** A pi-remote command the user ran in Pi (/detach, /status); the client that typed it acts. */
  | { type: 'clientAction'; action: 'detach' | 'status' }
  /**
   * Terminal output Pi wrote to its PTY that only a real terminal can act on: a bell, the
   * window title, a desktop notification, progress, or a clipboard write (OSC 52). Added by
   * the host, not the Pi extension. `data` is the escape sequence to write to the local terminal.
   */
  | { type: 'terminal'; kind: 'bell' | 'title' | 'notify' | 'progress' | 'clipboard'; data: string };

/** Messages from the host to the Pi extension. */
export type ControlMessage =
  /** Send `text` to the agent as a user message (pi.sendUserMessage). */
  | { type: 'prompt'; text: string };

/** APC (application program command) escape sequences pass through Pi's input parser as one unit. */
const BARRIER_PREFIX = '\x1b_pi-remote:barrier:';
const APC_END = '\x1b\\';

/** `id` is `CLIENT:NUMBER`. Each client picks its own CLIENT tag, so reports name their keys. */
export function encodeBarrier(id: string): string { return `${BARRIER_PREFIX}${id}${APC_END}`; }

export function decodeBarrier(data: string): string | undefined {
  if (!data.startsWith(BARRIER_PREFIX) || !data.endsWith(APC_END)) return undefined;
  const id = data.slice(BARRIER_PREFIX.length, -APC_END.length);
  return /^[A-Za-z0-9_-]{1,64}:\d{1,15}$/.test(id) ? id : undefined;
}

const SET_TEXT_PREFIX = '\x1b_pi-remote:set-text:';

/** Replace the editor text, in order with keys. Used after the client's local external editor. */
export function encodeSetText(text: string): string { return `${SET_TEXT_PREFIX}${Buffer.from(text, 'utf8').toString('base64')}${APC_END}`; }

export function decodeSetText(data: string): string | undefined {
  if (!data.startsWith(SET_TEXT_PREFIX) || !data.endsWith(APC_END)) return undefined;
  const encoded = data.slice(SET_TEXT_PREFIX.length, -APC_END.length);
  return /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ? Buffer.from(encoded, 'base64').toString('utf8') : undefined;
}

export function sameEditorState(a: EditorState, b: EditorState): boolean {
  return a.text === b.text && a.cursor.line === b.cursor.line && a.cursor.col === b.cursor.col;
}

/** The smallest single replacement that turns `before` into `after`. */
export function diffLines(before: readonly string[], after: readonly string[]): LineDiff | undefined {
  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start++;
  if (start === before.length && start === after.length) return undefined;
  let end = 0;
  while (end < shorter - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { start, remove: before.length - start - end, insert: after.slice(start, after.length - end) };
}

export function applyDiff(lines: readonly string[], diff: LineDiff): string[] {
  return [...lines.slice(0, diff.start), ...diff.insert, ...lines.slice(diff.start + diff.remove)];
}
