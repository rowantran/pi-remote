import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type SplitDirection = 'auto' | 'right' | 'down' | 'left' | 'up';
export function isSplitDirection(value: unknown): value is SplitDirection {
  return typeof value === 'string' && ['auto', 'right', 'down', 'left', 'up'].includes(value);
}

/** Local client settings only. The remote daemon never reads this file. */
export interface ClientConfig {
  host?: string;
  cwd?: string;
  extensions?: string[];
  theme?: string;
  bell?: boolean;
  sideSplit?: SplitDirection;
}
const STRING_KEYS = ['host', 'cwd', 'theme'] as const;
const KEYS = new Set<string>([...STRING_KEYS, 'extensions', 'bell', 'sideSplit']);

/** Ignore relative XDG_CONFIG_HOME values, as required by the XDG specification. */
export function configPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'pi-remote', 'config.json');
}

export function parseConfig(text: string, path: string): ClientConfig {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) if (!KEYS.has(key)) throw new Error(`Unknown key '${key}' in ${path}`);
  for (const key of STRING_KEYS) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key])) throw new Error(`'${key}' in ${path} must be a non-empty string`);
  }
  if (config.extensions !== undefined && (!Array.isArray(config.extensions) || config.extensions.some(p => typeof p !== 'string' || !p))) {
    throw new Error(`'extensions' in ${path} must be an array of non-empty strings`);
  }
  if (config.bell !== undefined && typeof config.bell !== 'boolean') throw new Error(`'bell' in ${path} must be a boolean`);
  if (config.sideSplit !== undefined && !isSplitDirection(config.sideSplit)) throw new Error(`'sideSplit' in ${path} must be auto, right, down, left, or up`);
  return config as ClientConfig;
}

/** A missing file means no defaults. Malformed files fail loudly. */
export function loadConfig(path = configPath()): ClientConfig {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
  return parseConfig(text, path);
}
