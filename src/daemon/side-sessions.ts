import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Match Pi getAgentDir(): a nonempty override expands ~, otherwise ~/.pi/agent.
 * Resolve relative overrides from the child's cwd, not the daemon's cwd. */
export function sideSessionDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  const agentDir = override
    ? resolve(cwd, override === '~' ? homedir() : override.startsWith('~/') ? join(homedir(), override.slice(2)) : override)
    : join(homedir(), '.pi', 'agent');
  const encoded = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(agentDir, 'side-sessions', encoded);
}

/** Pi accepts both forms; the last session-dir option wins. */
export function sessionDirArg(args: string[]): string | undefined {
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-dir') dir = args[++i];
    else if (args[i].startsWith('--session-dir=')) dir = args[i].slice('--session-dir='.length);
  }
  return dir;
}

export function withSessionDir(args: string[], dir: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-dir') i++;
    else if (!args[i].startsWith('--session-dir=')) result.push(args[i]);
  }
  return [...result, '--session-dir', dir];
}
