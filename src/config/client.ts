import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type SplitDirection = 'auto' | 'right' | 'down' | 'left' | 'up';
export function isSplitDirection(value: unknown): value is SplitDirection {
  return typeof value === 'string' && ['auto', 'right', 'down', 'left', 'up'].includes(value);
}

export interface WebConfig {
  allowUsers: string[];
  origin?: string;
}

/** Commands that start Pi, as argv arrays. The daemon appends `--mode rpc` and Pi options. */
export interface LaunchConfig {
  sandboxed?: string[];
  unsandboxed?: string[];
}

/** Local client and deployment settings. On the remote host, the daemon reads only `launch`. */
export interface ClientConfig {
  host?: string;
  cwd?: string;
  extensions?: string[];
  theme?: string;
  bell?: boolean;
  sideSplit?: SplitDirection;
  /** When absent, deploy does not manage a web service. */
  web?: WebConfig;
  launch?: LaunchConfig;
}
const STRING_KEYS = ['host', 'cwd', 'theme'] as const;
const KEYS = new Set<string>([...STRING_KEYS, 'extensions', 'bell', 'sideSplit', 'web', 'launch']);
const WEB_KEYS = new Set(['allowUsers', 'origin']);
const LAUNCH_KEYS = new Set(['sandboxed', 'unsandboxed']);

function isExactHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

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
  if (config.web !== undefined) {
    if (!config.web || typeof config.web !== 'object' || Array.isArray(config.web)) throw new Error(`'web' in ${path} must be a JSON object`);
    const web = config.web as Record<string, unknown>;
    for (const key of Object.keys(web)) if (!WEB_KEYS.has(key)) throw new Error(`Unknown key 'web.${key}' in ${path}`);
    if (!Array.isArray(web.allowUsers) || !web.allowUsers.length || web.allowUsers.length > 100
      || web.allowUsers.some(login => typeof login !== 'string' || !login || login.startsWith('-') || login.length > 256 || /[\s*\x00-\x1f\x7f-\x9f]/.test(login))) {
      throw new Error(`'web.allowUsers' in ${path} must contain 1–100 exact, non-wildcard Tailscale logins of at most 256 characters without whitespace or control characters`);
    }
    if (web.origin !== undefined && !isExactHttpsOrigin(web.origin)) throw new Error(`'web.origin' in ${path} must be an exact HTTPS origin without credentials, path, trailing slash, query, or hash`);
  }
  if (config.launch !== undefined) {
    if (!config.launch || typeof config.launch !== 'object' || Array.isArray(config.launch)) throw new Error(`'launch' in ${path} must be a JSON object`);
    const launch = config.launch as Record<string, unknown>;
    for (const key of Object.keys(launch)) if (!LAUNCH_KEYS.has(key)) throw new Error(`Unknown key 'launch.${key}' in ${path}`);
    for (const key of LAUNCH_KEYS) {
      const command = launch[key];
      if (command !== undefined && (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string') || !command[0])) {
        throw new Error(`'launch.${key}' in ${path} must be a non-empty array of strings, starting with the program`);
      }
    }
  }
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
