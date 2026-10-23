import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BOOLEAN_OPTIONS, VALUE_OPTIONS, completionScript, resolveCommand, runCompletionCommand, selectHost, slotLabel, slotNumber, numberSlots, type NumberedSlot } from './completion.js';
import { runDaemon } from '../daemon/supervisor.js';
import { defaultStateDir } from '../protocol/paths.js';
import { configPath, defaultCwd, defaultHost } from './config.js';
import { bridge } from '../daemon/bridge.js';
import { connectCompatibleSsh } from '../client/compat-client.js';
import { connectCompatibleLocal } from './connections.js';
import { ReconnectingConnection } from '../client/reconnect.js';
import { releaseName, restartDaemon } from '../client/restart-daemon.js';
import { PI_VERSION, PROTOCOL_VERSION, type SlotInfo, type Snapshot, type RemoteConnection } from '../protocol/types.js';
import { sideParentLabel } from '../tui/session-labels.js';
import type { AttachContext } from '../tui/side-launcher.js';
import { FuzzyPicker, runPicker, slotItem, style, type PickerItem } from './picker.js';

const HELP = `pi-remote — local terminal UI, persistent remote Pi RPC processes

Everyday commands:
  pi-remote [--host HOST]
    Open a searchable picker: attach to a running slot, or start a new one in
    the default directory. Without a terminal, print this help.
  pi-remote new [--cwd REMOTE_DIRECTORY] [--host HOST] [--no-attach] [-- PI_OPTIONS...]
  pi-remote ls [--host HOST] [--all] [--json]
  pi-remote attach [--host HOST] [SLOT]
  pi-remote kill [--host HOST] SLOT
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

Any unambiguous command prefix works: n = new, a = attach, k = kill, l = ls, re = restart-daemon.

Options:
  --host HOST          SSH host (default: PI_REMOTE_HOST, then the config file)
  --cwd PATH           Remote working directory for new (default: PI_REMOTE_CWD,
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

/** Local, pre-TUI selection. It returns a UUID and never sends an RPC. */
export async function pickSlot(slots: NumberedSlot[], io: PickerIo = {}): Promise<string> {
  if (!interactive(io)) throw new Error('Specify a slot number or UUID from ls; selection needs a local terminal.');
  const picker = new FuzzyPicker(numberSlots(slots).map(slot => slotItem(slot)), {
    title: 'Attach to a slot', subtitle: io.host, action: 'attach', empty: 'No slots match.',
  });
  const chosen = await (io.run ?? runPicker)(picker);
  if (chosen === undefined) throw new Error('Selection cancelled.');
  return chosen;
}

export type HomeChoice = { kind: 'attach'; slotId: string } | { kind: 'new'; cwd: string };

/** Rows of the bare `pi-remote` picker: active slots, then actions. */
export function homeItems(slots: NumberedSlot[], cwd?: string, now = Date.now()): PickerItem<HomeChoice>[] {
  const items: PickerItem<HomeChoice>[] = numberSlots(slots).filter(slot => slot.status !== 'exited')
    .map(slot => ({ ...slotItem(slot, now), value: { kind: 'attach', slotId: slot.id } }));
  if (cwd) items.push({ value: { kind: 'new', cwd }, marker: style.accent('+'), title: 'New session', detail: cwd, pinned: true });
  return items;
}

/** The bare `pi-remote` picker. Undefined means the user cancelled. */
export async function pickHome(connection: Pick<RemoteConnection, 'request'>, options: PickerIo & { cwd?: string }): Promise<HomeChoice | undefined> {
  const items = homeItems(await connection.request('list'), options.cwd);
  if (!items.length) throw new Error(`No active slots. Create one with new --cwd DIRECTORY, or add {"cwd": "DIRECTORY"} to ${configPath()}.`);
  const active = items.filter(item => item.value.kind === 'attach').length;
  return (options.run ?? runPicker)(new FuzzyPicker(items, {
    title: 'pi-remote', subtitle: [options.host ?? 'local', `${active} active slot${active === 1 ? '' : 's'}`].join(' · '),
    action: 'open', empty: active ? 'No active slots match.' : 'No active slots yet.',
  }));
}

export async function resolveSlot(connection: Pick<RemoteConnection, 'request'>, id: string | undefined, allowPicker = false, io: PickerIo = {}): Promise<string> {
  const slots = numberSlots(await connection.request('list'));
  if (id !== undefined) return selectSlot(slots, id).id;
  const active = slots.filter(slot => slot.status !== 'exited');
  if (active.length === 1) return active[0].id;
  if (allowPicker && active.length > 1) return pickSlot(active, io);
  throw new Error(active.length ? 'Specify a slot number or UUID from ls.' : 'No active slots. Create one with new --cwd DIRECTORY.');
}
/** Stopped slots are hidden unless --all is given; say how many so they are not lost. */
export function formatSlotList(slots: NumberedSlot[], hidden = 0): string {
  const ordered: { slot: NumberedSlot; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (slot: NumberedSlot, depth: number) => {
    if (seen.has(slot.id)) return;
    seen.add(slot.id); ordered.push({ slot, depth });
    for (const child of slots) if (child.parentSlotId === slot.id) visit(child, depth + 1);
  };
  const ids = new Set(slots.map(slot => slot.id));
  for (const slot of slots) if (!slot.parentSlotId || !ids.has(slot.parentSlotId)) visit(slot, 0);
  for (const slot of slots) visit(slot, 0); // Malformed cycles must not hide entries.
  const lines = ordered.map(({ slot, depth }) => `${'  '.repeat(depth)}${String(slotNumber(slot) ?? '-').padStart(3)}  ${slot.id}  ${slot.status.padEnd(7)}  ${slot.clients} client(s)  ${slot.sessionName ?? '(unnamed)'}${sideParentLabel(slot) ? ` (${sideParentLabel(slot)})` : ''}  ${slot.cwd}${slot.error ? `\n  ${slot.error}` : ''}`);
  if (!slots.length) lines.push(hidden ? 'No active slots. Create one with new --cwd DIRECTORY.' : 'No slots. Create one with new --cwd DIRECTORY.');
  if (hidden) lines.push(`${hidden} stopped slot${hidden === 1 ? '' : 's'} hidden. Use ls --all to show ${hidden === 1 ? 'it' : 'them'}.`);
  return lines.join('\n');
}

/** Only interactive attach/new request transcript filtering; watch/rpc stay raw. */
export function usesTerminalUi(command: string, flags: ReadonlySet<string>, stdinIsTTY = Boolean(process.stdin.isTTY), stdoutIsTTY = Boolean(process.stdout.isTTY)): boolean {
  return stdinIsTTY && stdoutIsTTY && (command === 'attach' || command === 'home' || (command === 'new' && !flags.has('--no-attach')));
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
  if (!['home', 'new', 'ls', 'attach', 'kill', 'rpc', 'watch', 'restart-daemon'].includes(command)) throw new Error(`Unknown command '${command}'. See --help.`);
  const local = options.flags.has('--local');
  const host = selectHost({ host: options.values.get('--host'), local, defaultHost: local ? undefined : defaultHost() });
  const maxPositionals = command === 'rpc' ? 2 : ['attach', 'kill', 'watch'].includes(command) ? 1 : 0;
  if (options.positionals.length > maxPositionals) throw new Error(`Too many arguments. Use --host HOST to select a host. See --help.`);
  if (!local && !host) throw new Error(`No host. Use --host HOST, set PI_REMOTE_HOST, add {"host": "HOST"} to ${configPath()}, or use --local.`);
  const factory = () => options.flags.has('--local') ? connectCompatibleLocal(stateDir) : connectCompatibleSsh({ host: host!, remoteBin: options.values.get('--remote-bin'), stateDir });
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
      const all = numberSlots(await connection.request('list'));
      const slots = options.flags.has('--all') ? all : all.filter(slot => slot.status !== 'exited');
      if (options.flags.has('--json')) console.log(JSON.stringify(slots, null, 2));
      else console.log(formatSlotList(slots, all.length - slots.length));
      return;
    }
    let slotId: string | undefined;
    let createCwd: string | undefined;
    if (command === 'home') {
      const choice = await pickHome(connection, { host, cwd: options.values.get('--cwd') ?? (local ? undefined : defaultCwd()) });
      if (!choice) return;
      if (choice.kind === 'attach') slotId = choice.slotId; else createCwd = choice.cwd;
    }
    if (command === 'new' || createCwd) {
      const cwd = createCwd ?? options.values.get('--cwd') ?? (local ? undefined : defaultCwd());
      if (!cwd) throw new Error(local ? 'new --local requires --cwd with a directory' : `new requires a remote directory. Use --cwd DIRECTORY, set PI_REMOTE_CWD, or add {"cwd": "DIRECTORY"} to ${configPath()}.`);
      const slot = await connection.request('create', { cwd, args: options.piArgs, sessionPath: options.values.get('--session') });
      slotId = slot.id;
      if (options.flags.has('--no-attach') || !process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(options.flags.has('--json') ? JSON.stringify(slot, null, 2) : slot.id);
        return;
      }
    } else slotId ??= await resolveSlot(connection, options.positionals.shift(), command === 'attach', { host });
    if (command === 'kill') { await connection.request('kill', { slotId }); console.log(`Stopped ${slotId}`); return; }
    if (!['home', 'new', 'attach', 'rpc', 'watch'].includes(command)) throw new Error(`Unknown command '${command}'. See --help.`);
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
