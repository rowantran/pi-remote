import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PI_VERSION } from '../protocol/types.js';

const exec = promisify(execFile);

export interface PiCommand { executable?: string; prefixArgs?: string[]; env?: NodeJS.ProcessEnv }

/**
 * Runs `pi --version` as slots would run Pi, and throws unless it is the version this
 * release requires. The daemon checks before it starts any slot; deploy checks before
 * it switches releases or restarts the daemon. Returns the version.
 */
export async function checkPiVersion({ executable = 'pi', prefixArgs = [], env }: PiCommand = {}): Promise<string> {
  const { stdout } = await exec(executable, [...prefixArgs, '--version'], { env: { ...process.env, ...env }, timeout: 15_000 });
  const version = stdout.trim();
  if (version !== PI_VERSION) throw new Error(`Remote Pi version ${version} does not match required ${PI_VERSION}`);
  return version;
}
