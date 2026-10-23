import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BOOLEAN_OPTIONS, VALUE_OPTIONS, completionScript, resolveCommand, runCompletionCommand, selectHost, slotNumber, numberSlots, type NumberedSlot } from './completion.js';
import { runDaemon } from '../daemon/supervisor.js';
import { defaultStateDir } from '../protocol/paths.js';
import { configPath, defaultCwd, defaultHost } from './config.js';
import { bridge } from '../daemon/bridge.js';
import { connectCompatibleSsh } from '../client/compat-client.js';
import { connectCompatibleLocal } from './connections.js';
import { ReconnectingConnection } from '../client/reconnect.js';
import { releaseName, restartDaemon } from '../client/restart-daemon.js';
import { PI_VERSION, PROTOCOL_VERSION, errorText, type SlotInfo, type Snapshot, type RemoteConnection } from '../protocol/types.js';
import type { AttachContext } from '../tui/side-launcher.js';
import { FuzzyPicker, runPicker, type PickerItem } from '../tui/fuzzy-picker.js';
import { formatSlotList, listSummary, slotColumns, slotItems } from '../tui/slot-table.js';
import { terminalPaint } from '../tui/table.js';
import { openSession, pickResume, resumeSlot, type ResumeChoice } from './resume.js';
import { sessionDirArg } from '../daemon/session-dirs.js';
import { collectStatus, formatReport, lsHeader } from './status.js';

const HELP = `pi-remote — local terminal UI, persistent remote Pi RPC processes

Everyday commands:
  pi-remote [--host HOST]
    Open a searchable picker: attach to a running slot, start a new one in the
    default directory, or resume a session. Without a terminal, print this help.
  pi-remote new [--cwd REMOTE_DIRECTORY] [--host HOST] [--no-attach] [-- PI_OPTIONS...]
  pi-remote ls [--host HOST] [--all] [--json]
    A read-only attach: print the attach picker's header and rows without
    opening it. --all adds stopped slots; --json prints the slot data.
  pi-remote attach [--host HOST] [SLOT]
  pi-remote resume [--host HOST] [--cwd REMOTE_DIRECTORY] [--no-attach] [SLOT] [-- PI_OPTIONS...]
    The same picker as /resume in a new slot: search the sessions stored for the
    directory and open one in a new slot. With SLOT, reopen that stopped slot's
    session. A session that is still open attaches to its slot instead.
  pi-remote kill [--host HOST] SLOT
  pi-remote status [--host HOST] [--json]
    Measure the round trip to the remote daemon, and show daemon uptime, host
    load and memory, and slot counts. Exits 1 if the host is unreachable.
  pi-remote restart-daemon [--host HOST] [--force]
    Restart the remote daemon on the installed release. Every running slot is
    reopened from its session file with the same number, like /reload. Waits
    until no slot is busy; --force interrupts busy slots instead.
  pi-remote completion fish|zsh|bash
  pi-remote serve --origin HTTPS_URL --allow-user TAILSCALE_LOGIN [--ui-config PATH]
    Serve the browser client through a private Unix socket and Tailscale Serve.
    Read themes and presentation extensions from this server's pi-remote config.
    Use 'pi-remote serve --help' for pairing, device revocation, and security.

Power-user / debugging commands:
  pi-remote rpc [--host HOST] SLOT '{"type":"get_state"}'
    Send one JSON command and print its response.
  pi-remote watch [--host HOST] SLOT
    Print a session snapshot, then stream live events as JSON.
  These are for scripts and debugging. Use attach for normal interactive work.

Any unambiguous command prefix works: n = new, a = attach, k = kill, l = ls, s = status, rest = restart-daemon.
r is short for resume.

Options:
  --host HOST          SSH host (default: PI_REMOTE_HOST, then the config file)
  --cwd PATH           Remote working directory for new, and the directory whose
                       stored sessions resume lists (default: PI_REMOTE_CWD,
                       then the config file)
  --remote-bin PATH    Remote program (default ~/.local/share/pi-remote/bin/pi-remote)
  --state-dir PATH     Remote daemon state directory (default ~/.pi/remote)
  --session PATH       Resume a session file when creating a new slot
  --all                ls: include stopped slots (hidden by default)
  --local              No SSH; run against a daemon on this machine
  --json               Machine-readable list/create output
  --no-attach          Create a slot and print its ID without opening the TUI
  --force              restart-daemon: interrupt busy slots
  --ui-extension PATH  Load a local presentation adapter (repeatable)
  --ui-config PATH     Alternate UI config (does not change host/cwd defaults)
  --theme NAME         Local UI theme, or a LIGHT/DARK pair
  --no-reconnect       Disable automatic client reconnection
  --no-bell            Disable bells for remote completion and blocking dialogs

Configuration:
  $XDG_CONFIG_HOME/pi-remote/config.json (default ~/.config/pi-remote/config.json)
  sets connection defaults and local UI settings:
    {"host": "devbox", "cwd": "~/project", "extensions": [], "theme": "dark",
     "bell": true, "sideSplit": "auto"}
  Host precedence: --host, then PI_REMOTE_HOST, then the config file.
  Directory precedence: --cwd, then PI_REMOTE_CWD, then the config file.
  --ui-config overrides only UI settings; --ui-extension adds trusted adapters.
  The bell defaults to on; --no-bell overrides the config.

SLOT is a stable number from ls, a full UUID, or a unique UUID prefix.
attach without SLOT opens a searchable picker when several active slots exist.
--local ignores the host and directory defaults. Remote ~ and relative completion paths use
remote home; --session completion uses --cwd, or the default directory.
Quote remote '~' paths so your shell does not expand them to LOCAL home.

Completion installation (prints scripts; never edits shell configuration):
  fish: command -q pi-remote; and pi-remote completion fish | source
        Add this line to ~/.config/fish/config.fish after setting PATH. The guard
        skips machines without pi-remote, such as a remote host sharing the file.
        Alternatively, save the output to ~/.config/fish/completions/pi-remote.fish.
  zsh:  pi-remote completion zsh > ~/.zsh/completions/_pi-remote
        Add ~/.zsh/completions to fpath before running compinit.
  bash: pi-remote completion bash > ~/.pi-remote-completion.bash
        Source that file from your shell configuration.

Server-only commands: bridge, daemon. These start automatically.
Ctrl+D or /detach exits the local UI WITHOUT stopping remote work. Ctrl+C clears the prompt.
Explicit 'kill', or /quit in the UI, stops remote Pi. SSH authentication uses your existing config.
Requires matching Pi ${PI_VERSION} on both machines.
`;
export interface UiOptions { presentationPaths?: string[]; presentationConfig?: string; theme?: string; host?: string; bell?: boolean; attachContext?: AttachContext }
export interface Options { positionals: string[]; piArgs: string[]; values: Map<string,string>; flags: Set<string>; ui: UiOptions }
export function parseOptions(args: string[]): Options {
  const options: Options = { positionals: [], piArgs: [], values: new Map(), flags: new Set(), ui: {} };
  const valueFlags = new Set<string>(VALUE_OPTIONS);
  const boolFlags = new Set<string>(BOOLEAN_OPTIONS);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { options.piArgs = args.slice(i + 1); break; }
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (valueFlags.has(flag)) {
      if (equals < 0 && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) throw new Error(`Missing value for ${flag}`);
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (!value) throw new Error(`Missing value for ${flag}`);
      options.values.set(flag, value);
      if (flag === '--ui-extension') (options.ui.presentationPaths ??= []).push(value);
      if (flag === '--ui-config') options.ui.presentationConfig = value;
      if (flag === '--theme') options.ui.theme = value;
    } else if (boolFlags.has(arg)) {
      options.flags.add(arg);
      if (arg === '--no-bell') options.ui.bell = false;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else options.positionals.push(arg);
  }
  return options;
}

/** Numeric references never fall back to numeric UUID prefixes. A missing
 * number must not accidentally select a different process after a restart. */
export function selectSlot(slots: NumberedSlot[], id: string): NumberedSlot {
  slots = numberSlots(slots);
  let candidates: NumberedSlot[];
  if (/^\d+$/.test(id)) candidates = slots.filter(slot => slotNumber(slot) === Number(id));
  else {
    const exact = slots.find(slot => slot.id === id);
    candidates = exact ? [exact] : slots.filter(slot => slot.id.startsWith(id));
  }
  if (!id || candidates.length !== 1) throw new Error(`Slot '${id}' is missing or ambiguous. Run ls.`);
  return candidates[0];
}

export type RunPicker = <T>(picker: FuzzyPicker<T>) => Promise<T | undefined>;
export interface PickerIo { isTTY?: boolean; host?: string; run?: RunPicker }
const interactive = (io: PickerIo) => io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Local, pre-TUI selection with the same rows as `ls`. It returns a UUID and never sends an RPC. */
export async function pickSlot(slots: NumberedSlot[], io: PickerIo = {}, all: NumberedSlot[] = slots): Promise<string> {
  if (!interactive(io)) throw new Error('Specify a slot number or UUID from ls; selection needs a local terminal.');
  const p = terminalPaint();
  const picker = new FuzzyPicker(slotItems(slots, p), {
    title: 'Attach to a slot', subtitle: listSummary(io.host ?? 'local', all), action: 'attach', empty: 'No slots match.', columns: slotColumns(p), paint: p,
  });
  const chosen = await (io.run ?? runPicker)(picker);
  if (chosen === undefined) throw new Error('Selection cancelled.');
  return chosen;
}

export type HomeChoice = { kind: 'attach'; slotId: string } | { kind: 'new'; cwd: string } | { kind: 'resume' };

/** Rows of the bare `pi-remote` picker: active slots as in `ls`, then actions. */
export function homeItems(slots: NumberedSlot[], cwd?: string, p = terminalPaint(), now = Date.now()): PickerItem<HomeChoice>[] {
  const items: PickerItem<HomeChoice>[] = slotItems(slots.filter(slot => slot.status !== 'exited'), p, now)
    .map(item => ({ ...item, value: { kind: 'attach', slotId: item.value } }));
  if (cwd) {
    items.push({ value: { kind: 'new', cwd }, marker: p.accent('+'), label: 'New session', detail: cwd, search: 'new session', pinned: true });
    // Like `new` followed by /resume: the stored sessions of this directory.
    items.push({ value: { kind: 'resume' }, marker: p.accent('↺'), label: 'Resume a session…', detail: cwd, search: 'resume session', pinned: true });
  }
  return items;
}

/** The bare `pi-remote` picker. Undefined means the user cancelled. */
export async function pickHome(connection: Pick<RemoteConnection, 'request'>, options: PickerIo & { cwd?: string }): Promise<HomeChoice | undefined> {
  const slots = numberSlots(await connection.request('list'));
  const p = terminalPaint();
  const items = homeItems(slots, options.cwd, p);
  if (!items.length) throw new Error(`No active slots. Create one with new --cwd DIRECTORY, or add {"cwd": "DIRECTORY"} to ${configPath()}.`);
  const active = items.some(item => item.value.kind === 'attach');
  return (options.run ?? runPicker)(new FuzzyPicker(items, {
    title: 'pi-remote', subtitle: listSummary(options.host ?? 'local', slots),
    action: 'open', empty: active ? 'No active slots match.' : 'No active slots yet.', columns: slotColumns(p), paint: p,
  }));
}

export async function resolveSlot(connection: Pick<RemoteConnection, 'request'>, id: string | undefined, allowPicker = false, io: PickerIo = {}): Promise<string> {
  const slots = numberSlots(await connection.request('list'));
  if (id !== undefined) return selectSlot(slots, id).id;
  const active = slots.filter(slot => slot.status !== 'exited');
  if (active.length === 1) return active[0].id;
  if (allowPicker && active.length > 1) return pickSlot(active, io, slots);
  throw new Error(active.length ? 'Specify a slot number or UUID from ls.' : 'No active slots. Create one with new --cwd DIRECTORY.');
}
export { formatSlotList };

/** Only interactive attach/new request transcript filtering; watch/rpc stay raw. */
export function usesTerminalUi(command: string, flags: ReadonlySet<string>, stdinIsTTY = Boolean(process.stdin.isTTY), stdoutIsTTY = Boolean(process.stdout.isTTY)): boolean {
  return stdinIsTTY && stdoutIsTTY && (command === 'attach' || command === 'home' || ((command === 'new' || command === 'resume') && !flags.has('--no-attach')));
}

/** Only a live terminal UI owns recovery. Headless commands end on disconnect. */
export function shouldReconnect(command: string, flags: ReadonlySet<string>, stdinIsTTY = Boolean(process.stdin.isTTY), stdoutIsTTY = Boolean(process.stdout.isTTY)): boolean {
  return usesTerminalUi(command, flags, stdinIsTTY, stdoutIsTTY) && !flags.has('--no-reconnect');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  // Separate parser: serve is local-only and deliberately has no TCP bind option.
  if (args[0] === 'serve') {
    const { serveMain } = await import('../web/server/main.js');
    await serveMain(args.slice(1)); return;
  }
  const first = args[0];
  // Bare `pi-remote`, optionally with options such as --host, opens the home picker.
  const home = first === undefined || (first.startsWith('-') && !['--help', '-h', '--version'].includes(first));
  if (home && !(process.stdin.isTTY && process.stdout.isTTY)) { console.log(HELP); return; }
  const command = home ? 'home' : first === '--help' || first === '-h' || first === '--version' ? first : resolveCommand(first);
  if (command === 'help' || command === '--help' || command === '-h') { console.log(HELP); return; }
  if (command === '--version' || command === 'version') { console.log(`pi-remote 0.2.0 (Pi ${PI_VERSION}, protocol ${PROTOCOL_VERSION})`); return; }
  if (command === 'fs') {
    const { serveFileRequest } = await import('../daemon/files.js');
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1024 * 1024) throw new Error('Filesystem request exceeds limit'); }
    console.log(JSON.stringify(await serveFileRequest(args[1] ?? '', JSON.parse(input))));
    return;
  }
  if (command === 'completion') { process.stdout.write(await completionScript(args[1] ?? '')); return; }
  if (command === 'complete') { await runCompletionCommand(args.slice(1)); return; }
  const options = parseOptions(home ? args : args.slice(1));
  if (options.flags.has('--help')) { console.log(HELP); return; }
  const stateDir = options.values.get('--state-dir');
  if (command === 'daemon') { await runDaemon({ stateDir: stateDir ?? defaultStateDir(), executable: process.env.PI_REMOTE_PI_BIN ?? 'pi' }); return; }
  if (command === 'bridge') { await bridge(stateDir); return; }
  if (!['home', 'new', 'ls', 'attach', 'resume', 'kill', 'status', 'rpc', 'watch', 'restart-daemon'].includes(command)) throw new Error(`Unknown command '${command}'. See --help.`);
  const local = options.flags.has('--local');
  const host = selectHost({ host: options.values.get('--host'), local, defaultHost: local ? undefined : defaultHost() });
  const maxPositionals = command === 'rpc' ? 2 : ['attach', 'resume', 'kill', 'watch'].includes(command) ? 1 : 0;
  if (options.positionals.length > maxPositionals) throw new Error(`Too many arguments. Use --host HOST to select a host. See --help.`);
  if (!local && !host) throw new Error(`No host. Use --host HOST, set PI_REMOTE_HOST, add {"host": "HOST"} to ${configPath()}, or use --local.`);
  const factory = () => options.flags.has('--local') ? connectCompatibleLocal(stateDir) : connectCompatibleSsh({ host: host!, remoteBin: options.values.get('--remote-bin'), stateDir });
  if (command === 'status') {
    const report = await collectStatus(factory, host ?? 'local', 5, undefined, local);
    console.log(options.flags.has('--json') ? JSON.stringify(report, null, 2) : formatReport(report));
    if (!report.online) process.exitCode = 1;
    return;
  }
  if (command === 'restart-daemon') {
    const result = await restartDaemon(factory, { force: options.flags.has('--force'), log: line => console.error(line) });
    console.log(`Daemon restarted: ${result.before.pid} (${releaseName(result.before.release)}) -> ${result.after.pid} (${releaseName(result.after.release)})`);
    const active = numberSlots(result.slots).filter(slot => slot.status !== 'exited');
    console.log(formatSlotList(active, result.slots.length - active.length));
    return;
  }
  const connection = shouldReconnect(command, options.flags) ? await ReconnectingConnection.connect(factory) : await factory();
  let removeSignal: (() => void) | undefined;
  try {
    if (command === 'ls') {
      const started = performance.now();
      const all = numberSlots(await connection.request('list'));
      const latency = performance.now() - started;
      const slots = options.flags.has('--all') ? all : all.filter(slot => slot.status !== 'exited');
      if (options.flags.has('--json')) console.log(JSON.stringify(slots, null, 2));
      else {
        const p = terminalPaint();
        // On a terminal, the same summary line as the pickers; pipes get only the list.
        if (process.stdout.isTTY) console.log(p.dim(listSummary(host ?? 'local', all)));
        console.log(formatSlotList(slots, all.length - slots.length, p));
      }
      return;
    }
    let slotId: string | undefined;
    let createCwd: string | undefined;
    let resume: ResumeChoice | undefined;
    const cwdDefault = options.values.get('--cwd') ?? (local ? undefined : defaultCwd());
    if (command === 'home') {
      // Esc in the resume finder returns to the home picker.
      while (!slotId && !createCwd && !resume) {
        const choice = await pickHome(connection, { host, cwd: cwdDefault });
        if (!choice) return;
        if (choice.kind === 'attach') slotId = choice.slotId;
        else if (choice.kind === 'new') createCwd = choice.cwd;
        else {
          // Nothing to resume, or an old daemon, is not fatal here: say why and go back.
          try { resume = await pickResume(connection, { host, cwd: cwdDefault, sessionDir: sessionDirArg(options.piArgs) }); }
          catch (error) { console.error(errorText(error)); }
        }
      }
    }
    if (command === 'resume') {
      const id = options.positionals.shift();
      if (id !== undefined) resume = resumeSlot(selectSlot(await connection.request('list'), id));
      else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Specify a stopped slot number from ls --all; selection needs a local terminal.');
        resume = await pickResume(connection, { host, cwd: cwdDefault, sessionDir: sessionDirArg(options.piArgs) });
        if (!resume) return;
      }
    }
    const headless = options.flags.has('--no-attach') || !process.stdin.isTTY || !process.stdout.isTTY;
    if (resume?.kind === 'attach') {
      slotId = resume.slotId;
      if (command === 'resume' && headless) { console.log(slotId); return; }
      if (command === 'resume') console.error('That session is still open; attaching to its slot.');
    } else if (resume) {
      const opened = await openSession(connection, resume, options.piArgs);
      slotId = opened.slotId;
      if (opened.existing) console.error(`Another slot opened that session first${headless ? '' : '; attaching to it'}.`);
      if (headless) {
        console.log(options.flags.has('--json') && opened.slot ? JSON.stringify(opened.slot, null, 2) : slotId);
        return;
      }
    }
    if (command === 'new' || createCwd) {
      const cwd = createCwd ?? cwdDefault;
      if (!cwd) throw new Error(local ? 'new --local requires --cwd with a directory' : `new requires a remote directory. Use --cwd DIRECTORY, set PI_REMOTE_CWD, or add {"cwd": "DIRECTORY"} to ${configPath()}.`);
      const slot = await connection.request('create', { cwd, args: options.piArgs, sessionPath: options.values.get('--session') });
      slotId = slot.id;
      if (options.flags.has('--no-attach') || !process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(options.flags.has('--json') ? JSON.stringify(slot, null, 2) : slot.id);
        return;
      }
    } else slotId ??= await resolveSlot(connection, options.positionals.shift(), command === 'attach', { host });
    if (command === 'kill') { await connection.request('kill', { slotId }); console.log(`Stopped ${slotId}`); return; }
    if (!['home', 'new', 'attach', 'resume', 'rpc', 'watch'].includes(command)) throw new Error(`Unknown command '${command}'. See --help.`);
    const snapshot = await connection.request('attach', { slotId, protocol: PROTOCOL_VERSION, piVersion: PI_VERSION,
      ...(usesTerminalUi(command, options.flags) ? { filterTranscript: true } : {}),
    });
    // Power-user/debug interface: one explicit JSON command, not an interactive session.
    if (command === 'rpc') {
      const json = options.positionals.shift();
      if (!json) throw new Error('rpc requires a JSON Pi RPC command');
      const result = await connection.request('rpc', { slotId, command: JSON.parse(json) });
      console.log(JSON.stringify(result ?? null));
      return;
    }
    // Power-user/debug observer: snapshot and event JSON, without terminal controls.
    if (command === 'watch') {
      console.log(JSON.stringify({ type: 'snapshot', ...snapshot }));
      const unsubscribe = connection.onEvent(event => { if (event.seq > snapshot.seq) console.log(JSON.stringify(event)); });
      await new Promise<void>(resolve => {
        const stop = () => resolve();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        const disconnect = connection.onDisconnect(() => resolve());
        removeSignal = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); disconnect(); unsubscribe(); };
      });
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('attach needs a local terminal. Use watch or rpc for headless access.');
    const { runTui } = await import('../tui/tui.js');
    const startTui: (connection: RemoteConnection, slotId: string, snapshot: Snapshot, options?: UiOptions) => Promise<void> = runTui;
    await startTui(connection, slotId, snapshot, { ...options.ui, ...(host ? { host } : {}),
      attachContext: { ...options.ui, host, local, stateDir: local ? resolve(stateDir ?? defaultStateDir()) : stateDir,
        remoteBin: options.values.get('--remote-bin'), reconnect: !options.flags.has('--no-reconnect') },
    });
  } finally { removeSignal?.(); connection.close(); }
}

// Daemon launches this compiled module directly; the bin launcher imports it instead.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
