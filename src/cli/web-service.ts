import { execFile } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseConfig, type WebConfig } from '../config/client.js';
import { assertNoFunnel } from '../web/server/tailscale.js';

const exec = promisify(execFile);
const service = 'pi-remote-web.service';

/** systemd parses command arguments itself: neither shell syntax nor specifiers may expand. */
function argument(value: string, expandVariables = true): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Control characters are not allowed in service arguments');
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return '"' + (expandVariables ? escaped.replace(/\$/g, '$$$$') : escaped) + '"';
}
function shellArgument(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** Called only by the remote deploy script, using the installed release's Node and modules. */
export async function installWebService(config: WebConfig): Promise<void> {
  const home = homedir();
  const uid = process.getuid!();
  // Non-interactive SSH sessions may omit these even when the user manager is running.
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus` };
  const run = (command: string, args: string[], timeout = 15_000) => exec(command, args, { env, timeout, maxBuffer: 1024 * 1024 });
  let managerEnvironment: string;
  try { managerEnvironment = (await run('systemctl', ['--user', 'show-environment'])).stdout; }
  catch { throw new Error('Cannot reach the systemd user manager. Log into the devbox and run loginctl enable-linger "$USER", then deploy again.'); }
  const managerXdg = /^XDG_CONFIG_HOME=(.*)$/m.exec(managerEnvironment)?.[1];
  if (managerXdg && (!isAbsolute(managerXdg) || /[\s\\'"\x00-\x1f\x7f]/.test(managerXdg))) {
    throw new Error('Cannot interpret the user manager\'s XDG_CONFIG_HOME; use an absolute unquoted config directory.');
  }
  // systemctl enable must write into the same search path that the user manager reads.
  if (managerXdg) env.XDG_CONFIG_HOME = managerXdg;
  else delete env.XDG_CONFIG_HOME;

  let origin = config.origin;
  if (!origin) {
    let status;
    try {
      const { stdout } = await run('tailscale', ['status', '--json', '--peers=false']);
      status = JSON.parse(stdout);
    } catch { throw new Error('Cannot inspect this devbox\'s Tailscale identity. Connect Tailscale or set web.origin explicitly.'); }
    const dns: unknown = status?.Self?.DNSName;
    if (status?.BackendState !== 'Running' || typeof dns !== 'string' || !/^[a-z0-9.-]+\.ts\.net\.?$/i.test(dns)) {
      throw new Error('Cannot determine this devbox\'s Tailscale HTTPS origin. Connect Tailscale or set web.origin explicitly.');
    }
    origin = new URL(`https://${dns.replace(/\.$/, '')}`).origin;
  }
  // Revalidate discovered origins with the same rules as explicitly configured ones.
  const web = parseConfig(JSON.stringify({ web: { ...config, origin } }), 'deploy web settings').web!;
  const url = new URL(origin);
  const port = Number(url.port || 443);
  let serve;
  try {
    const { stdout } = await run('tailscale', ['serve', 'status', '--json']);
    serve = JSON.parse(stdout);
  } catch { throw new Error('Cannot inspect Tailscale Serve routes. Check tailscale serve status --json on the devbox.'); }
  assertNoFunnel(serve, port);

  const release = fileURLToPath(new URL('../../', import.meta.url));
  const state = join(home, '.pi-remote-web');
  // Pin the real release in the process argv so deploy's cleanup protects a running server.
  const command = [process.execPath, join(release, 'dist/cli/main.js'), 'serve', '--origin', origin,
    ...web.allowUsers.flatMap(login => ['--allow-user', login]), '--web-state-dir', state];
  // systemd expands dollars in argv, but resolves the executable path without that expansion.
  const unit = `[Unit]
Description=Pi Remote phone client (managed by pi-remote deploy)
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=notify
NotifyAccess=all
TimeoutStartSec=45
ExecStart=${command.map((value, index) => argument(value, index > 0)).join(' ')}
Environment=${argument(`PATH=${[...new Set((process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(isAbsolute))].join(':')}`, false)}
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
# The daemon owns Pi sessions; stopping the web service must not stop them.
KillMode=process

[Install]
WantedBy=default.target
`;
  const xdg = env.XDG_CONFIG_HOME;
  const directory = join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'systemd/user');
  await mkdir(directory, { recursive: true });
  const target = join(directory, service), temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, unit, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  try {
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', service]);
    // restart also starts a newly installed or previously stopped service.
    // Cover old stop (30s), startup (45s), and cleanup after a failed startup (30s).
    await run('systemctl', ['--user', 'restart', service], 120_000);
  } catch (error) {
    throw new Error(`Cannot install/start ${service}; see journalctl --user -u ${service}. ${(error as Error).message}`);
  }
  console.log(`Installed and started ${service} for ${origin}`);

  if (serve?.TCP?.[port]?.HTTPS !== true
    || serve?.Web?.[`${url.hostname}:${port}`]?.Handlers?.['/']?.Proxy !== `unix:${state}/web.sock`) {
    console.log('Tailscale Serve routing is not configured for this app. Review existing routes before setting the / handler:');
    console.log(`tailscale serve --bg --https=${port} ${shellArgument(`unix:${state}/web.sock`)}`);
  }
  try {
    const { stdout } = await run('loginctl', ['show-user', String(uid), '--property=Linger', '--value']);
    if (stdout.trim() === 'yes') return;
  } catch { /* Linger is an explicit administrator/user decision, not a deploy side effect. */ }
  console.log(`To keep the service running after logout: loginctl enable-linger ${shellArgument(userInfo().username)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const value = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
    const config = parseConfig(JSON.stringify({ web: value }), 'deploy web settings').web!;
    if (!config) throw new Error('Missing web deployment settings');
    await installWebService(config);
  })().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
