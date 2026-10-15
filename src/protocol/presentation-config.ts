import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { configPath, parseConfig, type ClientConfig, type SplitDirection } from './config.js';

export interface PresentationConfig { extensions: string[]; theme?: string; bell?: boolean; sideSplit?: SplitDirection }
export interface PresentationConfigOptions { env?: NodeJS.ProcessEnv; home?: string }

/** Read the ordinary client configuration without loading or executing any extension code. */
export async function readPresentationConfig(
  path?: string, cliExtensions: string[] = [], options: PresentationConfigOptions = {},
): Promise<PresentationConfig> {
  const home = options.home ?? homedir();
  // Explicit --ui-config replaces the UI defaults, never the connection defaults.
  const file = path ?? configPath(options.env, home);
  let text: string | undefined;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return parsePresentationConfig(text, file, cliExtensions, home);
}

/** Parse one config snapshot and resolve extension paths without reading files or loading code. */
export function parsePresentationConfig(
  text: string | undefined, file: string, cliExtensions: string[] = [], home = homedir(),
): PresentationConfig {
  let config: ClientConfig = {};
  if (text !== undefined) {
    try { config = parseConfig(text, file); }
    catch (error) { throw new Error(`Invalid presentation config: ${(error as Error).message}`); }
  }
  return {
    extensions: [...new Set([
      ...(config.extensions ?? []).map(p => modulePath(p, dirname(resolve(file)), home)),
      ...cliExtensions.map(p => modulePath(p, undefined, home)),
    ])],
    theme: config.theme, bell: config.bell, ...(config.sideSplit !== undefined ? { sideSplit: config.sideSplit } : {}),
  };
}

export function modulePath(path: string, base = process.cwd(), home = homedir()): string {
  return resolve(base, path.startsWith('~/') ? resolve(home, path.slice(2)) : path);
}
