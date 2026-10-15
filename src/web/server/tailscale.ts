import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Tailscale ServeConfig uses AllowFunnel["SNI:port"] and nested Foreground configs.
 * Check every host on this port: Funnel makes a port public, not just one hostname.
 */
export function assertNoFunnel(status: unknown, port: number): void {
  if (!object(status)) throw new Error('Cannot inspect Tailscale Serve status');
  let visited = 0;
  function inspect(config: Record<string, unknown>, depth: number) {
    if (++visited > 256 || depth > 8) throw new Error('Tailscale Serve status exceeds inspection limits');
    if (config.AllowFunnel !== undefined) {
      if (!object(config.AllowFunnel)) throw new Error('Invalid Tailscale AllowFunnel status');
      for (const [hostPort, enabled] of Object.entries(config.AllowFunnel)) {
        const match = /^.+:(\d{1,5})$/.exec(hostPort);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || typeof enabled !== 'boolean') throw new Error('Invalid Tailscale AllowFunnel entry');
        if (enabled && Number(match[1]) === port) throw new Error(`Refusing web server: Tailscale Funnel is enabled on port ${port}`);
      }
    }
    for (const key of ['Foreground', 'Services']) {
      if (config[key] === undefined) continue;
      if (!object(config[key])) throw new Error(`Invalid Tailscale ${key} status`);
      for (const child of Object.values(config[key])) {
        if (!object(child)) throw new Error('Invalid nested Tailscale Serve status');
        inspect(child, depth + 1);
      }
    }
  }
  inspect(status, 0);
}

export async function checkTailscale(origin: URL): Promise<void> {
  let status: unknown;
  try {
    const { stdout } = await exec('tailscale', ['serve', 'status', '--json'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    status = JSON.parse(stdout);
  } catch { throw new Error('Cannot inspect Tailscale Serve status; refusing to start the web server'); }
  assertNoFunnel(status, Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)));
}
