import { execFile } from 'node:child_process';
import { opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { readAttachment } from '../protocol/attachments.js';
import { pathString, resolvedPath, unsafePath, workingDirectory } from '../protocol/file-paths.js';
import { MAX_COMPLETION_ITEMS, MAX_DIRECTORY_ENTRIES, type Attachment, type CompletePathOptions, type FilesystemMetadata, type PathCompletionItem, type PathCompletionResult } from '../protocol/files.js';

const execute = promisify(execFile);

/** Read-only, bounded directory completion. Values are raw paths, not shell expressions. */
export async function completePath({ prefix, cwd, directoriesOnly = false }: CompletePathOptions): Promise<PathCompletionResult> {
  pathString(prefix, 'prefix', true);
  if (typeof directoriesOnly !== 'boolean') throw new Error('directoriesOnly must be a boolean');
  const display = prefix === '~' ? '~/' : prefix;
  const slash = display.lastIndexOf('/');
  const parent = display.slice(0, slash + 1);
  const namePrefix = display.slice(slash + 1);
  if (prefix.startsWith('~') && !display.startsWith('~/')) return { items: [], truncated: false };
  const directory = parent ? resolvedPath(parent, cwd) : workingDirectory(cwd);
  const items: PathCompletionItem[] = [];
  let scanned = 0;
  let truncated = false;
  let dir;
  try { dir = await opendir(directory); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return { items, truncated };
    }
    throw error;
  }
  try {
    while (scanned < MAX_DIRECTORY_ENTRIES) {
      const entry = await dir.read();
      if (!entry) break;
      scanned++;
      if (!entry.name.startsWith(namePrefix) || unsafePath.test(entry.name)) continue;
      let directoryEntry = entry.isDirectory();
      let regularFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(resolve(directory, entry.name));
          directoryEntry = target.isDirectory(); regularFile = target.isFile();
        } catch { continue; } // Broken links, loops, and inaccessible targets are not useful suggestions.
      }
      if ((!directoryEntry && !regularFile) || (directoriesOnly && !directoryEntry)) continue;
      const label = entry.name + (directoryEntry ? '/' : '');
      items.push({ value: parent + label, label, directory: directoryEntry });
    }
    // Conservatively signal the scan limit without reading an extra entry.
    truncated = scanned === MAX_DIRECTORY_ENTRIES || items.length > MAX_COMPLETION_ITEMS;
  } finally { await dir.close(); }
  items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.label.localeCompare(b.label));
  return { items: items.slice(0, MAX_COMPLETION_ITEMS), truncated };
}

/** symbolic-ref does not invoke hooks, filters, project programs, or a shell. */
export async function filesystemMetadata({ cwd }: { cwd?: string }): Promise<FilesystemMetadata> {
  const homeDir = homedir();
  const directory = workingDirectory(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const { stdout } = await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null', 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: directory, timeout: 2000, maxBuffer: 16 * 1024, encoding: 'utf8',
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const gitBranch = stdout.trim();
    if (gitBranch && !unsafePath.test(gitBranch)) return { homeDir, gitBranch };
  } catch { /* Detached HEAD, non-repository, missing git, and timeouts omit the branch. */ }
  return { homeDir };
}

/** Shared by the daemon and the stdin-JSON sideband; callers resolve slotId to cwd. */
export async function serveFileRequest(method: string, params: Record<string, unknown> = {}): Promise<PathCompletionResult | Attachment | FilesystemMetadata> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('File request params must be an object');
  const cwd = params.cwd === undefined ? undefined : pathString(params.cwd, 'cwd');
  switch (method) {
    case 'complete_path':
      if (params.directoriesOnly !== undefined && typeof params.directoriesOnly !== 'boolean') throw new Error('directoriesOnly must be a boolean');
      return completePath({ prefix: pathString(params.prefix, 'prefix', true), cwd, directoriesOnly: params.directoriesOnly as boolean | undefined });
    case 'read_attachment': return readAttachment({ path: pathString(params.path, 'path'), cwd });
    case 'filesystem_metadata': return filesystemMetadata({ cwd });
    default: throw new Error(`Unknown file request: ${method}`);
  }
}
