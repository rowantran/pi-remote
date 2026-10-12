import { configPath, loadConfig, type ClientConfig } from '../protocol/config.js';

export { configPath, loadConfig, parseConfig, type ClientConfig } from '../protocol/config.js';

/** --host > PI_REMOTE_HOST > config file. An empty environment value is unset. */
export function defaultHost(env: NodeJS.ProcessEnv = process.env, load: () => ClientConfig = () => loadConfig(configPath(env))): string | undefined {
  return env.PI_REMOTE_HOST || load().host;
}

/** --cwd > PI_REMOTE_CWD > config file. An empty environment value is unset.
 * The value is a remote path; the remote daemon resolves ~ and checks it. */
export function defaultCwd(env: NodeJS.ProcessEnv = process.env, load: () => ClientConfig = () => loadConfig(configPath(env))): string | undefined {
  return env.PI_REMOTE_CWD || load().cwd;
}
