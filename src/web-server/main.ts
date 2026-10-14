import { join, resolve } from 'node:path';
import { DeviceStore } from './devices.js';
import { privateDirectory } from './private-state.js';
import { defaultWebStateDir, startWebServer } from './server.js';
import { PushService } from './push.js';
import { startActivityMonitor } from './activity-monitor.js';
import { Connection, handshake } from '../client/connection.js';
import { ensureDaemon } from '../daemon/launch.js';

export { startWebServer, defaultWebStateDir, defaultStaticDir, readJsonBody } from './server.js';
export type { WebServerOptions, WebServerHandle, WebServerContext, AuthenticatedContext } from './server.js';
export { DeviceStore, DEVICE_COOKIE } from './devices.js';
export type { Device } from './devices.js';
export { defaultBrowserConfig } from './browser-config.js';
export type { BrowserConfig } from './browser-config.js';

const HELP = `Usage:
  pi-remote serve --origin https://HOST --allow-user LOGIN [--allow-user LOGIN ...]
  pi-remote serve pair [--web-state-dir DIR]
  pi-remote serve devices [--web-state-dir DIR]
  pi-remote serve revoke DEVICE_ID [--web-state-dir DIR]

Options:
  --web-state-dir DIR  Private web state (default ~/.pi/remote/web)
  --socket PATH        Unix socket inside web state (default web.sock)
  --state-dir DIR     Existing private daemon state directory
  --origin ORIGIN     Exact HTTPS browser origin; no path or trailing slash
  --allow-user LOGIN  Exact Tailscale-User-Login; repeat for each allowed user

The listener is Unix-socket only. Put it behind private Tailscale Serve, never Funnel.
A pairing code expires after 10 minutes and can be used once. Codes are printed only
by the explicit pair command. Inspect existing socket/lock paths manually; they are
never reclaimed automatically.`;

/** The existing CLI dispatches here with the arguments after `serve`. */
export async function serveMain(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP + '\n'); return; }
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const allowedLogins: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!['--web-state-dir', '--socket', '--state-dir', '--origin', '--allow-user'].includes(arg)) throw new Error(`Unknown serve option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--allow-user') allowedLogins.push(value);
    else { if (flags.has(arg)) throw new Error(`Duplicate serve option: ${arg}`); flags.set(arg, value); }
  }
  const stateDir = resolve(flags.get('--web-state-dir') ?? defaultWebStateDir());
  if (positional.length) {
    const [command, id, ...extra] = positional;
    if (!['pair', 'devices', 'list', 'revoke'].includes(command) || extra.length || (command === 'revoke' ? !id : !!id)) throw new Error(HELP);
    const devices = new DeviceStore(await privateDirectory(stateDir));
    if (command === 'pair') {
      const pairing = await devices.issuePairingCode();
      process.stdout.write(`Pairing code: ${pairing.code}\nExpires: ${new Date(pairing.expiresAt).toISOString()}\n`);
    } else if (command === 'revoke') {
      if (!await devices.revoke(id)) throw new Error('Device not found');
      process.stdout.write('Device revoked. Active browser connections will close.\n');
    } else {
      const list = await devices.list();
      process.stdout.write(JSON.stringify(list, null, 2) + '\n');
    }
    return;
  }
  const origin = flags.get('--origin');
  if (!origin) throw new Error('--origin is required; use an exact HTTPS Tailscale Serve origin');
  let push: PushService | undefined;
  const server = await startWebServer({
    origin, allowedLogins, stateDir,
    socketPath: flags.get('--socket') ?? join(stateDir, 'web.sock'),
    daemonStateDir: flags.get('--state-dir'),
    handleApi: (request, response, context) => push?.handleApi(request, response, context) ?? false,
  });
  let monitor: Awaited<ReturnType<typeof startActivityMonitor>>;
  try {
    // Acquire the exclusive socket before generating keys; a second service instance must
    // never replace the VAPID keys used by an already-running instance.
    push = await PushService.open({ stateDir, origin: server.origin, devices: server.devices, allowedLogins });
    monitor = await startActivityMonitor({
      connect: async () => {
        const socket = await ensureDaemon(flags.get('--state-dir'));
        const connection = new Connection(socket, socket, () => socket.destroy());
        try { await handshake(connection); return connection; }
        catch (error) { connection.close(); throw error; }
      },
      onBell: notice => push!.notify(notice),
      onStatus: status => push!.setMonitorStatus(status),
    });
  } catch (error) { await server.close(); await push?.close(); throw error; }
  process.stdout.write(`Web listener: ${server.socketPath}\nOrigin: ${server.origin}\n`);
  await new Promise<void>((accept, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      void (async () => { await monitor.close(); await server.close(); await push!.close(); })().then(accept, reject);
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  });
}
