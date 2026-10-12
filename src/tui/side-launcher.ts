import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isSplitDirection, type SplitDirection } from '../protocol/config.js';

export { isSplitDirection, type SplitDirection } from '../protocol/config.js';
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
 * Relative UI paths keep their meaning when openGhosttySplit uses the client's cwd. */
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

export interface GhosttySplitOptions {
  invocation: AttachInvocation;
  /** Capture before creating the remote slot, so changing focus cannot redirect the split. */
  targetId: string;
  direction: ExplicitSplitDirection;
  cwd?: string;
  /** Only the SSH/UI/PATH allowlist is forwarded. Defaults to the current client environment. */
  environment?: Readonly<NodeJS.ProcessEnv>;
}
export type GhosttyExecFile = (command: string, args: string[], options: {
  encoding: 'utf8'; timeout: number; maxBuffer: number;
}) => Promise<{ stdout: string; stderr?: string }>;
export interface GhosttyDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: GhosttyExecFile;
}
export interface GhosttyLauncher {
  captureTarget(): Promise<string>;
  open(options: GhosttySplitOptions): Promise<void>;
}

const execute = promisify(execFile);
// The command bypasses shell startup. Carry only settings needed for SSH and
// trusted local UI adapters; never copy credentials or the whole client environment.
const INHERITED_ENVIRONMENT = ['SSH_AUTH_SOCK', 'PI_CODING_AGENT_DIR', 'PI_REMOTE_RENDERER_REPO', 'XDG_CONFIG_HOME', 'PATH'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIREMENTS = 'Ghostty splits require macOS and Ghostty 1.3 or newer, with macos-applescript = true and macOS Automation permission for Ghostty.';

function preflight(dependencies: GhosttyDependencies): void {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error(REQUIREMENTS);
  const env = dependencies.env ?? process.env;
  if (env.TERM_PROGRAM?.toLowerCase() !== 'ghostty') throw new Error(`Run this command in Ghostty. ${REQUIREMENTS}`);
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

export async function openGhosttySplit(options: GhosttySplitOptions, dependencies: GhosttyDependencies = {}): Promise<void> {
  if (!UUID.test(options.targetId)) throw new Error('A captured Ghostty terminal ID is required.');
  if (!['right', 'down', 'left', 'up'].includes(options.direction)) throw new Error('Resolve the split direction before opening Ghostty.');
  const cwd = resolve(options.cwd ?? process.cwd());
  if (cwd.includes('\0')) throw new Error('The local working directory contains a NUL character.');
  // The embedded API treats command overrides as shell commands (not config
  // shell:/direct: prefixes). On macOS Ghostty already wraps this as
  // /bin/bash --noprofile --norc -c "exec -l <command>"; another exec would fail.
  // https://github.com/ghostty-org/ghostty/blob/v1.3.1/src/termio/Exec.zig#L1511-L1530
  const command = formatInvocation(options.invocation);
  const environment = options.environment ?? dependencies.env ?? process.env;
  const assignments: string[] = [];
  for (const key of INHERITED_ENVIRONMENT) {
    const value = environment[key];
    if (value === undefined) continue;
    if (value.includes('\0')) throw new Error(`The ${key} environment variable contains a NUL character.`);
    assignments.push(`${key}=${value}`);
  }
  await runScript(OPEN_SPLIT, [options.targetId, options.direction, command, cwd, ...assignments], dependencies);
}

export const ghosttyLauncher: GhosttyLauncher = {
  captureTarget: () => captureGhosttyTarget(),
  open: options => openGhosttySplit(options),
};
