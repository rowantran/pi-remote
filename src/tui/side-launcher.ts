import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isSplitDirection, type SplitDirection } from '../config/client.js';

export { isSplitDirection, type SplitDirection } from '../config/client.js';
export type ExplicitSplitDirection = Exclude<SplitDirection, 'auto'>;
export interface SplitDimensions { columns: number; rows: number; cellWidth?: number; cellHeight?: number }

/** Compare pixels, not character counts: terminal cells are usually twice as tall as wide. */
export function resolveSplitDirection(direction: SplitDirection, dimensions: SplitDimensions): ExplicitSplitDirection {
  if (direction !== 'auto') {
    if (!isSplitDirection(direction)) throw new Error(`Invalid split direction: ${direction}`);
    return direction;
  }
  const { columns, rows, cellWidth = 9, cellHeight = 18 } = dimensions;
  if (![columns, rows, cellWidth, cellHeight].every(n => Number.isFinite(n) && n > 0)) return 'right';
  const width = columns * cellWidth, height = rows * cellHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'right';
  return width > height ? 'right' : 'down';
}

/** Resolved local-client settings, not remote Pi arguments or environment variables.
 * Relative UI paths keep their meaning because splits start in the client's cwd. */
export interface AttachContext {
  host?: string;
  local?: boolean;
  stateDir?: string;
  remoteBin?: string;
  presentationPaths?: readonly string[];
  presentationConfig?: string;
  theme?: string;
  bell?: boolean;
  reconnect?: boolean;
}
export interface AttachInvocation { command: string; args: string[] }

/** Use this installation's bin launcher for both source checkouts and compiled releases.
 * The bin handles tsx itself; forwarding process.execArgv would also forward test/debug flags. */
export function attachInvocation(slotId: string, context: AttachContext): AttachInvocation {
  if (!slotId || slotId.startsWith('-')) throw new Error('Attach requires a slot UUID.');
  const args = [fileURLToPath(new URL('../../bin/pi-remote', import.meta.url)), 'attach'];
  if (context.local) args.push('--local');
  else {
    if (!context.host) throw new Error('Attach requires the resolved SSH host or local mode.');
    args.push('--host', context.host);
  }
  if (context.stateDir !== undefined) args.push('--state-dir', context.stateDir);
  if (context.remoteBin !== undefined) args.push('--remote-bin', context.remoteBin);
  for (const path of context.presentationPaths ?? []) args.push('--ui-extension', path);
  if (context.presentationConfig !== undefined) args.push('--ui-config', context.presentationConfig);
  if (context.theme !== undefined) args.push('--theme', context.theme);
  if (context.bell === false) args.push('--no-bell');
  if (context.reconnect === false) args.push('--no-reconnect');
  args.push(slotId);
  const invocation = { command: process.execPath, args };
  // Validate here too, so the fallback can always be rendered as a shell command.
  formatInvocation(invocation);
  return invocation;
}

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A launch argument contains a NUL character.');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Copyable POSIX-shell command. No environment or credentials are included. */
export function formatInvocation(invocation: AttachInvocation): string {
  if (!invocation.command) throw new Error('A launch executable is required.');
  return [invocation.command, ...invocation.args].map(shellQuote).join(' ');
}

export interface SideSplitOptions {
  invocation: AttachInvocation;
  /** Capture before creating the remote slot, so changing focus cannot redirect the split. */
  targetId: string;
  direction: ExplicitSplitDirection;
  cwd?: string;
  /** Only the SSH/UI/PATH allowlist is forwarded. Defaults to the current client environment. */
  environment?: Readonly<NodeJS.ProcessEnv>;
}
export type LauncherExecFile = (command: string, args: string[], options: {
  encoding: 'utf8'; timeout: number; maxBuffer: number;
}) => Promise<{ stdout: string; stderr?: string }>;
export interface LauncherDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: LauncherExecFile;
}
/** Opens a pane beside the client's own pane in the terminal the client runs in. */
export interface SideLauncher {
  captureTarget(): Promise<string>;
  open(options: SideSplitOptions): Promise<void>;
}
export type GhosttySplitOptions = SideSplitOptions;
export type GhosttyExecFile = LauncherExecFile;
export type GhosttyDependencies = LauncherDependencies;
export type GhosttyLauncher = SideLauncher;

const execute = promisify(execFile);
// The command bypasses shell startup. Carry only settings needed for SSH and
// trusted local UI adapters; never copy credentials or the whole client environment.
const INHERITED_ENVIRONMENT = ['SSH_AUTH_SOCK', 'PI_CODING_AGENT_DIR', 'PI_REMOTE_RENDERER_REPO', 'XDG_CONFIG_HOME', 'PATH'] as const;

/** `KEY=value` for each allowlisted variable that is set, in allowlist order. */
function inheritedAssignments(environment: Readonly<NodeJS.ProcessEnv>): string[] {
  const assignments: string[] = [];
  for (const key of INHERITED_ENVIRONMENT) {
    const value = environment[key];
    if (value === undefined) continue;
    if (value.includes('\0')) throw new Error(`The ${key} environment variable contains a NUL character.`);
    assignments.push(`${key}=${value}`);
  }
  return assignments;
}

function launchDirectory(cwd: string | undefined): string {
  const directory = resolve(cwd ?? process.cwd());
  if (directory.includes('\0')) throw new Error('The local working directory contains a NUL character.');
  return directory;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIREMENTS = 'Ghostty splits require macOS and Ghostty 1.3 or newer, with macos-applescript = true and macOS Automation permission for Ghostty.';

function preflight(dependencies: GhosttyDependencies): void {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error(REQUIREMENTS);
  const env = dependencies.env ?? process.env;
  if (env.TERM_PROGRAM?.toLowerCase() !== 'ghostty') throw new Error(`Run this command in Ghostty or Rex. ${REQUIREMENTS}`);
}

async function runScript(script: string, args: string[], dependencies: GhosttyDependencies): Promise<string> {
  preflight(dependencies);
  try {
    const result = await (dependencies.execFile ?? execute)('/usr/bin/osascript', ['-e', script, '--', ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    // execFile's message can include its argv (and thus user paths). Prefer the script's diagnostic.
    const failure = error as { stderr?: string; message?: string };
    throw new Error(`Could not control Ghostty. ${REQUIREMENTS}${failure.stderr?.trim() ? ` ${failure.stderr.trim()}` : ''}`, { cause: error });
  }
}

// Official API: https://ghostty.org/docs/features/applescript
// Creating a configuration record is a capability check, not a terminal creation.
const CAPTURE_TARGET = `on run argv
  tell application "Ghostty"
    if not running then error "Ghostty is not running."
    set appVersion to version
    set cfg to new surface configuration
    set sourceTerminal to focused terminal of selected tab of front window
    if sourceTerminal is missing value then error "No focused Ghostty terminal."
    return appVersion & linefeed & (id of sourceTerminal as text)
  end tell
end run`;

/** Read-only capture/capability check. Failure must not prevent the caller creating a slot. */
export async function captureGhosttyTarget(dependencies: GhosttyDependencies = {}): Promise<string> {
  const output = await runScript(CAPTURE_TARGET, [], dependencies);
  const [version, targetId] = output.split(/\r?\n/);
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version ?? '');
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 3)) throw new Error(REQUIREMENTS);
  if (!targetId || !UUID.test(targetId)) throw new Error(`No focused Ghostty terminal was found. ${REQUIREMENTS}`);
  return targetId;
}

// The enum literals must be compiled into AppleScript; text argv cannot be coerced
// into these enum values. All dynamic data stays in argv, never in script source.
const OPEN_SPLIT = `on run argv
  set sourceId to item 1 of argv
  set splitDirection to item 2 of argv
  set launchCommand to item 3 of argv
  set launchDirectory to item 4 of argv
  set launchEnvironment to {}
  if (count of argv) > 4 then set launchEnvironment to items 5 thru -1 of argv
  tell application "Ghostty"
    if not (exists terminal id sourceId) then error "The original Ghostty terminal is no longer available."
    set sourceTerminal to terminal id sourceId
    set cfg to new surface configuration
    set command of cfg to launchCommand
    set initial working directory of cfg to launchDirectory
    set environment variables of cfg to launchEnvironment
    if splitDirection is "right" then
      set newTerminal to split sourceTerminal direction right with configuration cfg
    else if splitDirection is "down" then
      set newTerminal to split sourceTerminal direction down with configuration cfg
    else if splitDirection is "left" then
      set newTerminal to split sourceTerminal direction left with configuration cfg
    else if splitDirection is "up" then
      set newTerminal to split sourceTerminal direction up with configuration cfg
    else
      error "Invalid split direction."
    end if
    if newTerminal is missing value then error "Ghostty did not create a split."
  end tell
end run`;

export async function openGhosttySplit(options: SideSplitOptions, dependencies: LauncherDependencies = {}): Promise<void> {
  if (!UUID.test(options.targetId)) throw new Error('A captured Ghostty terminal ID is required.');
  if (!['right', 'down', 'left', 'up'].includes(options.direction)) throw new Error('Resolve the split direction before opening Ghostty.');
  const cwd = launchDirectory(options.cwd);
  // The embedded API treats command overrides as shell commands (not config
  // shell:/direct: prefixes). On macOS Ghostty already wraps this as
  // /bin/bash --noprofile --norc -c "exec -l <command>"; another exec would fail.
  // https://github.com/ghostty-org/ghostty/blob/v1.3.1/src/termio/Exec.zig#L1511-L1530
  const command = formatInvocation(options.invocation);
  const assignments = inheritedAssignments(options.environment ?? dependencies.env ?? process.env);
  await runScript(OPEN_SPLIT, [options.targetId, options.direction, command, cwd, ...assignments], dependencies);
}

export const ghosttyLauncher: SideLauncher = {
  captureTarget: () => captureGhosttyTarget(),
  open: options => openGhosttySplit(options),
};

// Rex (com.superlogical.rex) sets REX_BLOCK to each pane's ("block's") own ID, and
// TERM_PROGRAM=rex. See `rex split --help`: `rex split -b BLOCK` opens a new block beside it.
const REX_BLOCK = /^block:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REX_REQUIREMENTS = 'Rex splits need the rex command and a REX_BLOCK set by Rex for this pane.';
const REX_DIRECTIONS: Record<ExplicitSplitDirection, string> = { right: 'right', down: 'below', left: 'left', up: 'above' };

/** The client's own block. Unlike Ghostty's focused terminal, focus changes cannot move it. */
export async function captureRexTarget(dependencies: LauncherDependencies = {}): Promise<string> {
  if ((dependencies.platform ?? process.platform) === 'win32') throw new Error(`Rex splits are not supported on Windows. ${REX_REQUIREMENTS}`);
  const block = (dependencies.env ?? process.env).REX_BLOCK;
  if (!block || !REX_BLOCK.test(block)) throw new Error(`Run this command in a Rex pane. ${REX_REQUIREMENTS}`);
  return block;
}

/** The rex next to Rex's server, as Rex sets REX_BIN_DIR in each pane; otherwise rex on PATH. */
function rexCommand(env: NodeJS.ProcessEnv): string {
  return env.REX_BIN_DIR && isAbsolute(env.REX_BIN_DIR) ? join(env.REX_BIN_DIR, 'rex') : 'rex';
}

export async function openRexSplit(options: SideSplitOptions, dependencies: LauncherDependencies = {}): Promise<void> {
  await captureRexTarget(dependencies);
  if (!REX_BLOCK.test(options.targetId)) throw new Error('A captured Rex block ID is required.');
  if (!Object.hasOwn(REX_DIRECTIONS, options.direction)) throw new Error('Resolve the split direction before opening Rex.');
  const cwd = launchDirectory(options.cwd);
  const env = dependencies.env ?? process.env;
  const assignments = inheritedAssignments(options.environment ?? env);
  const { command, args } = options.invocation;
  formatInvocation(options.invocation);
  // Rex starts the block with its server's environment, not ours, and has no option to set
  // variables, so /usr/bin/env sets the allowlist. env(1) reads every argument containing
  // `=` before the program as an assignment, so the program must not contain one.
  if (!isAbsolute(command) || command.includes('=')) throw new Error('Rex splits need an absolute launch executable without "=".');
  // --shell=none starts the program directly, and Rex passes each argument unchanged.
  const rexArgs = ['split', '-b', options.targetId, '--split', REX_DIRECTIONS[options.direction], '--cwd', cwd, '--shell=none', '--',
    '/usr/bin/env', ...assignments, command, ...args];
  try {
    // No env option: rex needs REX_SERVER and friends from this pane to reach the right server.
    await (dependencies.execFile ?? execute)(rexCommand(env), rexArgs, { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    // execFile's message can include its argv (and thus user paths). Prefer rex's diagnostic.
    const failure = error as { stderr?: string };
    const reason = failure.stderr?.trim().replace(/^Error:\s*/, '');
    throw new Error(`Could not split the Rex pane. ${REX_REQUIREMENTS}${reason ? ` ${reason}` : ''}`, { cause: error });
  }
}

export const rexLauncher: SideLauncher = {
  captureTarget: () => captureRexTarget(),
  open: options => openRexSplit(options),
};

/** Rex when the client runs in a Rex pane (also inside tmux there); Ghostty otherwise. */
export function detectSideLauncher(env: NodeJS.ProcessEnv = process.env): SideLauncher {
  const program = env.TERM_PROGRAM?.toLowerCase();
  if (program === 'rex') return rexLauncher;
  if (program !== 'ghostty' && env.REX_BLOCK) return rexLauncher;
  return ghosttyLauncher;
}
