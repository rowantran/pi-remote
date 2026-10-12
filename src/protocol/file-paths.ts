import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const unsafePath = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

export function pathString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value) || unsafePath.test(value)) {
    throw new Error(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} path without control characters`);
  }
  return value;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  // Do not pretend to support shell ~user expansion.
  if (path.startsWith('~')) throw new Error('Only ~ and ~/ paths are supported; ~user paths are not');
  return path;
}

export function workingDirectory(cwd?: string): string {
  return cwd === undefined ? homedir() : resolve(homedir(), expandHome(pathString(cwd, 'cwd')));
}

export function resolvedPath(path: string, cwd?: string): string {
  return resolve(workingDirectory(cwd), expandHome(pathString(path, 'path')));
}
