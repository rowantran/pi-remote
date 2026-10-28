import { configPath, loadConfig, type ClientConfig } from '../config/client.js';
import type { Launcher } from '../daemon/pi-process.js';

export { configPath, loadConfig, parseConfig, type ClientConfig } from '../config/client.js';

/** --host > PI_REMOTE_HOST > config file. An empty environment value is unset. */
export function defaultHost(env: NodeJS.ProcessEnv = process.env, load: () => ClientConfig = () => loadConfig(configPath(env))): string | undefined {
  return env.PI_REMOTE_HOST || load().host;
}

/** --cwd > PI_REMOTE_CWD > config file. An empty environment value is unset.
 * The value is a remote path; the remote daemon resolves ~ and checks it. */
export function defaultCwd(env: NodeJS.ProcessEnv = process.env, load: () => ClientConfig = () => loadConfig(configPath(env))): string | undefined {
  return env.PI_REMOTE_CWD || load().cwd;
}

/** `isara sandbox pi --`, the `ipi` shell alias. */
export const DEFAULT_SANDBOXED_COMMAND: readonly string[] = ['isara', 'sandbox', 'pi', '--'];

/** The daemon's command for a launch mode, read on the remote host for every launch, so
 * config edits apply to the next new slot or reload.
 * Sandboxed: `launch.sandboxed` in the config file, then the isara sandbox command.
 * Unsandboxed: PI_REMOTE_PI_BIN, then `launch.unsandboxed` in the config file, then `pi`. */
export function launcher(sandboxed: boolean, env: NodeJS.ProcessEnv = process.env, load: () => ClientConfig = () => loadConfig(configPath(env))): Launcher {
  const command = sandboxed
    ? load().launch?.sandboxed ?? DEFAULT_SANDBOXED_COMMAND
    : env.PI_REMOTE_PI_BIN ? [env.PI_REMOTE_PI_BIN] : load().launch?.unsandboxed ?? ['pi'];
  return { executable: command[0], prefixArgs: command.slice(1) };
}
