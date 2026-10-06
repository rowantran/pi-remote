import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runDaemon, defaultStateDir } from './daemon.js';
import { bridge, connectLocal, connectSsh, type Connection } from './client.js';
import { PI_VERSION, PROTOCOL_VERSION, type SlotInfo, type Snapshot } from './protocol.js';

const HELP = `pi-remote — local terminal UI, persistent remote Pi RPC processes

  pi-remote new HOST --cwd REMOTE_DIRECTORY [--no-attach] [-- PI_OPTIONS...]
  pi-remote ls HOST [--json]
  pi-remote attach HOST SLOT
  pi-remote kill HOST SLOT
  pi-remote rpc HOST SLOT '{"type":"get_state"}'
  pi-remote watch HOST SLOT

Options:
  --host HOST          Alternative to positional SSH host (or PI_REMOTE_HOST)
  --remote-bin PATH    Remote program (default ~/.local/share/pi-remote/bin/pi-remote)
  --state-dir PATH     Remote daemon state directory (default ~/.pi/remote)
  --session PATH       Resume a session file when creating a new slot
  --local              No SSH; run against a daemon on this machine
  --json               Machine-readable list/create output
  --no-attach          Create a slot and print its ID without opening the TUI

Server-only commands: bridge, daemon. These start automatically.
Ctrl+D or /detach exits the local UI WITHOUT stopping remote work.
Explicit 'kill' stops remote Pi. SSH authentication uses your existing config.
Requires matching Pi ${PI_VERSION} on both machines.
`;
interface Options { positionals: string[]; piArgs: string[]; values: Map<string,string>; flags: Set<string> }
function parse(args: string[]): Options {
  const options: Options = { positionals: [], piArgs: [], values: new Map(), flags: new Set() };
  const valueFlags = new Set(['--host', '--remote-bin', '--state-dir', '--cwd', '--session']);
  const boolFlags = new Set(['--local', '--json', '--no-attach', '--help']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { options.piArgs = args.slice(i + 1); break; }
    if (valueFlags.has(arg)) {
      if (args[i + 1] === undefined) throw new Error(`Missing value for ${arg}`);
      options.values.set(arg, args[++i]);
    } else if (boolFlags.has(arg)) options.flags.add(arg);
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else options.positionals.push(arg);
  }
  return options;
}
async function resolveSlot(connection: Connection, id: string | undefined): Promise<string> {
  const slots = await connection.request<SlotInfo[]>('list');
  const candidates = id ? slots.filter(slot => slot.id === id || slot.id.startsWith(id)) : slots.filter(slot => slot.status !== 'exited');
  if (candidates.length !== 1) throw new Error(id ? `Slot '${id}' is missing or ambiguous. Run ls.` : 'Specify a slot ID from ls.');
  return candidates[0].id;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') { console.log(HELP); return; }
  if (command === '--version' || command === 'version') { console.log(`pi-remote 0.1.0 (Pi ${PI_VERSION}, protocol ${PROTOCOL_VERSION})`); return; }
  const options = parse(args.slice(1));
  if (options.flags.has('--help')) { console.log(HELP); return; }
  const stateDir = options.values.get('--state-dir');
  if (command === 'daemon') { await runDaemon({ stateDir: stateDir ?? defaultStateDir(), executable: process.env.PI_REMOTE_PI_BIN ?? 'pi' }); return; }
  if (command === 'bridge') { await bridge(stateDir); return; }
  const host = options.values.get('--host') ?? process.env.PI_REMOTE_HOST ?? (options.flags.has('--local') ? undefined : options.positionals.shift());
  if (!options.flags.has('--local') && !host) throw new Error('Specify an SSH host or use --local. See --help.');
  const connection = options.flags.has('--local') ? await connectLocal(stateDir) : await connectSsh({ host: host!, remoteBin: options.values.get('--remote-bin'), stateDir });
  let removeSignal: (() => void) | undefined;
  try {
    if (command === 'ls') {
      const slots = await connection.request<SlotInfo[]>('list');
      if (options.flags.has('--json')) console.log(JSON.stringify(slots, null, 2));
      else {
        if (!slots.length) console.log('No slots. Create one with new HOST --cwd DIRECTORY.');
        for (const slot of slots) console.log(`${slot.id}  ${slot.status.padEnd(7)}  ${slot.clients} client(s)  ${slot.sessionName ?? '(unnamed)'}  ${slot.cwd}${slot.error ? `\n  ${slot.error}` : ''}`);
      }
      return;
    }
    let slotId: string;
    if (command === 'new') {
      const cwd = options.values.get('--cwd');
      if (!cwd) throw new Error('new requires --cwd with a remote directory');
      const slot = await connection.request<SlotInfo>('create', { cwd, args: options.piArgs, sessionPath: options.values.get('--session') });
      slotId = slot.id;
      if (options.flags.has('--no-attach') || !process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(options.flags.has('--json') ? JSON.stringify(slot, null, 2) : slot.id);
        return;
      }
    } else slotId = await resolveSlot(connection, options.positionals.shift());
    if (command === 'kill') { await connection.request('kill', { slotId }); console.log(`Stopped ${slotId}`); return; }
    if (!['new', 'attach', 'rpc', 'watch'].includes(command)) throw new Error(`Unknown command '${command}'. See --help.`);
    const snapshot = await connection.request<Snapshot>('attach', { slotId, protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    if (command === 'rpc') {
      const json = options.positionals.shift();
      if (!json) throw new Error('rpc requires a JSON Pi RPC command');
      const result = await connection.request('rpc', { slotId, command: JSON.parse(json) });
      console.log(JSON.stringify(result ?? null));
      return;
    }
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
    const { runTui } = await import('./tui.js');
    await runTui(connection, slotId, snapshot);
  } finally { removeSignal?.(); connection.close(); }
}

// Daemon launches this compiled module directly; the bin launcher imports it instead.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
