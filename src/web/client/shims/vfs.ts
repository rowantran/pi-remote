/// <reference path="./aliases.d.ts" />
import { normalize } from 'node:path';
export { unavailable } from './unsupported.js';
import darkTheme from 'pi-coding-agent-dist/modes/interactive/theme/dark.json';
import lightTheme from 'pi-coding-agent-dist/modes/interactive/theme/light.json';

/** No host filesystem exists here. Only built-in themes and explicitly supplied text are readable. */
export const BUILTIN_THEME_DIR = '/__pi_browser__/modes/interactive/theme';
const builtins = new Map([
  [`${BUILTIN_THEME_DIR}/dark.json`, JSON.stringify(darkTheme)],
  [`${BUILTIN_THEME_DIR}/light.json`, JSON.stringify(lightTheme)],
  // Metadata marker only. Dynamic import resolves the shared class from the app registry.
  ['/__pi_browser__/modes/interactive/components/custom-entry.js', ''],
]);
let files = new Map(builtins);
let home = '/';

export interface VirtualFiles { home: string; files: Record<string, string> }
/** Install only sanitized settings/theme/config text from the browser config API, never credentials. */
export function configureVirtualFiles(config: VirtualFiles): void {
  if (!config || typeof config.home !== 'string' || !config.home.startsWith('/') || !config.files || typeof config.files !== 'object') {
    throw new TypeError('Virtual files require an absolute home and a text file map');
  }
  const next = new Map(builtins);
  for (const [path, text] of Object.entries(config.files)) {
    if (!path.startsWith('/') || typeof text !== 'string') throw new TypeError('Virtual files require absolute paths and text contents');
    const key = virtualPath(path);
    if (key === '/' || next.has(key) && builtins.has(key)) throw new Error(`Reserved virtual path: ${key}`);
    next.set(key, text);
  }
  home = virtualPath(config.home);
  files = next;
}
export function virtualHome(): string { return home; }
export function virtualPath(path: unknown): string {
  if (path instanceof URL) {
    if (path.protocol !== 'file:' || path.host) throw new TypeError('Only local file: URLs are valid virtual paths');
    path = decodeURIComponent(path.pathname);
  }
  if (typeof path !== 'string' || path.includes('\0')) throw new TypeError('Expected a virtual file path');
  const normalized = normalize(path.startsWith('/') ? path : `/${path}`);
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}
export function virtualError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: virtual filesystem '${path}'`), { code, path });
}
export function hasVirtualDirectory(path: unknown): boolean {
  const key = virtualPath(path);
  return !files.has(key) && (key === '/' || [...files.keys()].some(file => file.startsWith(`${key}/`)));
}
export function readVirtualFile(path: unknown): string {
  const key = virtualPath(path);
  const text = files.get(key);
  if (text === undefined) throw virtualError(hasVirtualDirectory(key) ? 'EISDIR' : 'ENOENT', key);
  return text;
}
export function hasVirtualFile(path: unknown): boolean { return files.has(virtualPath(path)); }
export function virtualDirectoryEntries(path: unknown): { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }[] {
  const key = virtualPath(path);
  if (!hasVirtualDirectory(key)) throw virtualError(hasVirtualFile(key) ? 'ENOTDIR' : 'ENOENT', key);
  const prefix = key === '/' ? '/' : `${key}/`;
  const names = new Set([...files.keys()].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0]!));
  return [...names].sort().map(name => ({
    name, isFile: () => hasVirtualFile(`${prefix}${name}`),
    isDirectory: () => hasVirtualDirectory(`${prefix}${name}`), isSymbolicLink: () => false,
  }));
}
export function virtualStat(path: unknown) {
  const key = virtualPath(path);
  const file = hasVirtualFile(key), directory = hasVirtualDirectory(key);
  if (!file && !directory) throw virtualError('ENOENT', key);
  return {
    size: file ? new TextEncoder().encode(readVirtualFile(key)).byteLength : 0,
    isFile: () => file, isDirectory: () => directory, isSymbolicLink: () => false,
  };
}
