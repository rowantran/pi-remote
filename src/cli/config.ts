import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Local client defaults. Only read on the machine running the client, never
 * by the remote bridge or daemon. */
export interface ClientConfig { host?: string; cwd?: string }

const KEYS = new Set(['host', 'cwd']);

/** XDG Base Directory: $XDG_CONFIG_HOME when set to an absolute path,
 * otherwise ~/.config. Relative values are invalid per the spec and ignored. */
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
  for (const key of KEYS) if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key])) throw new Error(`'${key}' in ${path} must be a non-empty string`);
  return { host: config.host as string | undefined, cwd: config.cwd as string | undefined };
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

/** --host > PI_REMOTE_HOST > config file. An empty environment value is unset. */
export function defaultHost(env: NodeJS.ProcessEnv = process.env, load: () => ClientConfig = () => loadConfig(configPath(env))): string | undefined {
  return env.PI_REMOTE_HOST || load().host;
}

/** --cwd > PI_REMOTE_CWD > config file. An empty environment value is unset.
 * The value is a remote path; the remote daemon resolves ~ and checks it. */
export function defaultCwd(env: NodeJS.ProcessEnv = process.env, load: () => ClientConfig = () => loadConfig(configPath(env))): string | undefined {
  return env.PI_REMOTE_CWD || load().cwd;
}
