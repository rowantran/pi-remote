import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultStateDir, socketPath } from '../protocol/paths.js';
import { nodeModuleArgs } from '../protocol/node-entry.js';

async function openSocket(stateDir: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(stateDir));
    const failed = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out connecting to the daemon socket; remote work was not stopped'));
    }, 5000);
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', failed); resolve(socket); });
    socket.once('error', failed);
  });
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Validate dedicated state storage without changing an existing directory's permissions. */
export async function ensurePrivateStateDir(stateDir: string): Promise<string> {
  const absolute = resolve(stateDir);
  try { await lstat(absolute); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  }
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`State directory must be a directory, not a symlink: ${absolute}`);
  const uid = process.getuid?.();
  if (uid === undefined || metadata.uid !== uid) throw new Error(`State directory must be owned by the current user: ${absolute}`);
  if ((metadata.mode & 0o7777) !== 0o700) throw new Error(`State directory must have mode 0700; choose a dedicated private directory: ${absolute}`);
  return absolute;
}

async function launchDaemon(absolute: string): Promise<void> {
  // Fail closed for log symlinks, shared files, and pipes. Concurrent clients only append.
  const log = await open(join(absolute, 'daemon.log'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const metadata = await log.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o600 || metadata.nlink !== 1) throw new Error('daemon.log must be an owner-private regular file with mode 0600 and no hard links');
    await new Promise<void>((accept, reject) => {
      const child = spawn(process.execPath, [...nodeModuleArgs(import.meta.url, '../cli/main'), 'daemon', '--state-dir', absolute], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); accept(); });
    });
  } finally { await log.close(); }
}

export interface DaemonStartupOptions {
  /** Test seam for launching without starting a real daemon. */
  launch?: (stateDir: string) => Promise<void>;
  timeoutMs?: number;
}
/** Detached daemon startup; clients NEVER delete daemon locks or sockets. */
export async function ensureDaemon(stateDir = defaultStateDir(), options: DaemonStartupOptions = {}): Promise<Socket> {
  const absolute = await ensurePrivateStateDir(stateDir);
  try { return await openSocket(absolute); }
  catch (error: any) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  // runDaemon serializes launch/reclamation using start.lock. Competing launches are safe.
  await (options.launch ?? launchDaemon)(absolute);
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  do {
    try { return await openSocket(absolute); }
    catch (error: any) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Daemon did not start. Check ${join(absolute, 'daemon.log')}. An abandoned start.lock requires manual inspection; clients never remove locks or sockets.`);
}
