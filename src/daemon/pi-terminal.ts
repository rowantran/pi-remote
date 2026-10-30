import { accessSync, chmodSync, constants, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { readJsonl } from '../protocol/jsonl.js';
import { TerminalOutputFilter } from './terminal-output.js';
import { COMPANION_SOCKET_ENV, type CompanionMessage, type ControlMessage, type RgbColor, type TerminalAnswers } from '../protocol/companion.js';
export type { RgbColor, TerminalAnswers } from '../protocol/companion.js';

export interface PiTerminalOptions {
  executable: string;
  /** Arguments before Pi's own, for example a script path when `executable` is node. */
  prefixArgs?: string[];
  /** Extra Pi CLI arguments, after the ones the host adds. */
  args: string[];
  cwd: string;
  companionPath: string;
  columns: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
  answers: TerminalAnswers;
}

const hex16 = (value: number) => Math.round(Math.max(0, Math.min(255, value)) * 257).toString(16).padStart(4, '0');
const oscColor = (color: RgbColor) => `rgb:${hex16(color.r)}/${hex16(color.g)}/${hex16(color.b)}`;

/**
 * Terminal queries that Pi's renderer writes at startup. Pi runs in a PTY whose output
 * nobody displays, so the host answers them with the client terminal's values.
 */
const QUERY = /\x1b\[\?u|\x1b\[0?c|\x1b\](10|11|4;(\d+));\?(?:\x07|\x1b\\)|\x1b\[16t/g;
const QUERY_TAIL_BYTES = 64;

/** Dark or light, from the background's relative luminance; undefined without a background. */
export function appearance(answers: TerminalAnswers): 'dark' | 'light' | undefined {
  const color = answers.background;
  if (!color) return undefined;
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b < 128 ? 'dark' : 'light';
}

/** Answers every query in `output` that ends after index `after`. */
export function answerQueries(output: string, answers: TerminalAnswers, after = 0): string {
  let reply = '';
  for (const match of output.matchAll(QUERY)) {
    if (match.index + match[0].length <= after) continue;
    const query = match[0];
    if (query === '\x1b[?u') { if (answers.kittyFlags !== undefined) reply += `\x1b[?${answers.kittyFlags}u`; }
    else if (query === '\x1b[c' || query === '\x1b[0c') reply += '\x1b[?62;22c';
    else if (query === '\x1b[16t') { if (answers.cell) reply += `\x1b[6;${answers.cell.height};${answers.cell.width}t`; }
    else if (match[1] === '10' && answers.foreground) reply += `\x1b]10;${oscColor(answers.foreground)}\x1b\\`;
    else if (match[1] === '11' && answers.background) reply += `\x1b]11;${oscColor(answers.background)}\x1b\\`;
    else if (match[2] !== undefined) {
      const index = Number(match[2]);
      const color = answers.palette?.[index];
      if (color) reply += `\x1b]4;${index};${oscColor(color)}\x1b\\`;
    }
  }
  return reply;
}

/**
 * node-pty's macOS prebuild starts processes through a `spawn-helper` binary. Its install
 * script marks it executable, but this project installs with --ignore-scripts.
 */
export function ensureSpawnHelper(): void {
  if (process.platform !== 'darwin') return;
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (!existsSync(helper)) return;
  try { accessSync(helper, constants.X_OK); }
  catch { chmodSync(helper, statSync(helper).mode | 0o111); }
}

/**
 * Runs the stock interactive Pi CLI in a PTY with the companion extension loaded, and
 * relays the companion's messages. The PTY carries keys in; its output is discarded
 * except for terminal queries, because the client draws from the companion's frames.
 */
export class PiTerminal {
  onMessage?: (message: CompanionMessage) => void;
  onExit?: (code: number, signal?: number) => void;
  private pty?: IPty;
  private server?: Server;
  private companion?: Socket;
  private socketDir?: string;
  private queryTail = '';
  private output = new TerminalOutputFilter();
  private exited?: Promise<void>;
  private size: { columns: number; rows: number };

  constructor(private readonly options: PiTerminalOptions) {
    this.size = { columns: options.columns, rows: options.rows };
  }

  get pid(): number | undefined { return this.pty?.pid; }
  get columns(): number { return this.size.columns; }
  get rows(): number { return this.size.rows; }

  async start(): Promise<void> {
    this.socketDir = mkdtempSync(join(tmpdir(), 'pi-remote-companion-'));
    const socketPath = join(this.socketDir, 'companion.sock');
    this.server = createServer(socket => {
      // One companion per Pi process. A second connection is unexpected; keep the first.
      if (this.companion) { socket.destroy(); return; }
      this.companion = socket;
      readJsonl(socket, record => this.onMessage?.(record as CompanionMessage), error => {
        console.error(`pi-remote: companion message error: ${error.message}`);
      }, { recover: true });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socketPath, () => { this.server!.off('error', reject); resolve(); });
    });
    const { executable, prefixArgs = [], args, cwd, companionPath, columns, rows, env } = this.options;
    ensureSpawnHelper();
    this.pty = spawn(executable, [...prefixArgs, '--tui-mode', 'regular', '-e', companionPath, ...args], {
      name: 'xterm-256color', cols: columns, rows, cwd,
      env: { ...process.env, ...env, [COMPANION_SOCKET_ENV]: socketPath, COLORTERM: 'truecolor' } as Record<string, string>,
    });
    this.pty.onData(data => this.handleOutput(data));
    this.exited = new Promise(resolve => {
      this.pty!.onExit(({ exitCode, signal }) => { this.cleanup(); resolve(); this.onExit?.(exitCode, signal); });
    });
  }

  /** Sends a message to the companion inside Pi. Dropped when the companion is not connected. */
  control(message: ControlMessage): boolean {
    if (!this.companion || this.companion.destroyed) return false;
    this.companion.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  /** Writes client input to Pi, in order. */
  write(data: string): void { this.pty?.write(data); }

  resize(columns: number, rows: number): void {
    if (!(columns > 0 && rows > 0) || (columns === this.size.columns && rows === this.size.rows)) return;
    this.size = { columns, rows };
    this.pty?.resize(columns, rows);
  }

  get answers(): TerminalAnswers { return this.options.answers; }

  /**
   * Use another terminal's answers from now on. When its light or dark appearance differs,
   * report the change the way a terminal does (DEC mode 2031), so Pi can switch themes.
   */
  setAnswers(answers: TerminalAnswers): void {
    const before = appearance(this.options.answers), after = appearance(answers);
    this.options.answers = answers;
    if (after && after !== before) this.pty?.write(`\x1b[?997;${after === 'dark' ? 1 : 2}n`);
  }

  /**
   * Stops Pi: SIGTERM first, so Pi saves its session and restores the terminal, then
   * SIGKILL if it has not exited after `graceMs`.
   */
  async stop(graceMs = 5000): Promise<void> {
    if (!this.pty || !this.exited) return;
    try { this.pty.kill('SIGTERM'); } catch { /* Already gone. */ }
    const timer = setTimeout(() => { try { this.pty?.kill('SIGKILL'); } catch { /* Already gone. */ } }, graceMs);
    try { await this.exited; } finally { clearTimeout(timer); }
  }

  private handleOutput(data: string): void {
    // Queries can be split across reads. Scan the new data with a short tail of the old.
    // Queries that end inside the old tail were answered with the previous read.
    const text = this.queryTail + data;
    const reply = answerQueries(text, this.options.answers, this.queryTail.length);
    this.queryTail = text.slice(-QUERY_TAIL_BYTES);
    if (reply) this.pty?.write(reply);
    for (const message of this.output.feed(data)) this.onMessage?.(message);
  }

  private cleanup(): void {
    this.companion?.destroy();
    this.server?.close();
    if (this.socketDir) rmSync(this.socketDir, { recursive: true, force: true });
  }
}
