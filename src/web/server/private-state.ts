import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import type { Server } from 'node:http';

/** Reject symlink ancestors too: checking only the final directory is insufficient. */
export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('The web server requires a Unix user ID');
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory (symlinks are forbidden): ${current}`);
    if (stat.uid !== uid && stat.uid !== 0) throw new Error(`Directory has the wrong owner: ${current}`);
    // A root-owned sticky /tmp is safe when the child itself is private.
    if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))) throw new Error(`Directory is writable by other users: ${current}`);
    if (current === absolute && (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)) throw new Error(`Web state directory must be owned by the current user with mode 0700: ${current}`);
  }
  if (absolute === parse(absolute).root) throw new Error('Use a dedicated private web state directory');
  return absolute;
}

export function privateFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
    throw new Error('Web state files must be owner-private regular files (0600), without hard links');
  }
}

export async function readPrivateJson(path: string, limit = 1024 * 1024): Promise<unknown | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    privateFile(stat);
    if (stat.size > limit) throw new Error('Web state file exceeds limit');
    // Read incrementally: presentation state has a large ceiling, not a large allocation
    // on every request. Also bound a file that grows after the initial stat.
    const data = Buffer.alloc(Math.min(64 * 1024, limit + 1));
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await file.read(data, 0, Math.min(data.length, limit + 1 - length), null);
      if (!bytesRead) break;
      chunks.push(Buffer.from(data.subarray(0, bytesRead)));
      length += bytesRead;
    }
    if (length > limit) throw new Error('Web state file exceeds limit');
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally { await file.close(); }
}

export async function unlinkOwned(path: string, owner: Pick<Stats, 'ino' | 'dev'>): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.ino === owner.ino && current.dev === owner.dev) await unlink(path);
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}

/** Publish without overwriting ANY existing pathname, including a live/stale socket.
 * Node unlinks its original bind pathname on close without checking its inode. Bind
 * under a disposable private name, then hard-link into place so Node cannot remove
 * a replacement at the public pathname. Cleanup below only removes our inode.
 */
export async function listenPrivate(server: Server, stateDir: string, socketPath: string): Promise<() => Promise<void>> {
  if (dirname(socketPath) !== stateDir) throw new Error('The web socket must be inside the private web state directory');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Web socket path is too long');
  try {
    await lstat(socketPath);
    throw new Error('Web socket path already exists; inspect it manually (it will not be removed)');
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(stateDir, '.bind-'));
  const temporary = join(staging, 's');
  if (Buffer.byteLength(temporary) > 100) {
    await rmdir(staging);
    throw new Error('Web state directory is too long for a Unix socket');
  }
  let owner: Stats | undefined;
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(temporary, () => { server.off('error', reject); accept(); });
    });
    await chmod(temporary, 0o600);
    owner = await lstat(temporary);
    if (!owner.isSocket() || owner.uid !== process.getuid?.() || (owner.mode & 0o7777) !== 0o600) throw new Error('Unsafe web socket');
    await link(temporary, socketPath); // EEXIST is a safe failure, never reclaim a socket.
  } catch (error) {
    if (server.listening) await new Promise<void>(accept => server.close(() => accept()));
    throw error;
  } finally {
    if (owner) await unlinkOwned(temporary, owner);
    await rmdir(staging);
  }
  return () => unlinkOwned(socketPath, owner!);
}
