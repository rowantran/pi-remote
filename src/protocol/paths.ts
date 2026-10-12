import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function defaultStateDir(): string { return process.env.PI_REMOTE_STATE_DIR ?? join(homedir(), '.pi', 'remote'); }
export function socketPath(stateDir: string): string {
  const path = join(resolve(stateDir), 'daemon.sock');
  if (Buffer.byteLength(path) > 100) throw new Error('State directory path is too long for a Unix socket; use --state-dir with a shorter path');
  return path;
}
