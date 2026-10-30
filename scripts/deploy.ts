import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientConfig } from '../src/config/client.js';

export const HELP = `Usage: npm run deploy -- [HOST] [--force | --no-restart]

Install this checkout as a new release on an SSH Linux host, then restart the daemon
onto it once no slot is busy. HOST defaults to PI_REMOTE_HOST, then the client
configuration file.
  --force       Restart the daemon now, interrupting busy slots.
  --no-restart  Install without restarting the daemon.
  -h, --help    Show this help without building or connecting.

When config.json contains web settings, deploy installs/enables pi-remote-web.service
and restarts it onto the new release, even with --no-restart. Without web settings,
it does not manage a web service. Tailscale routing and device pairing remain manual.
`;

export interface DeployOptions {
  host?: string;
  restart: 'wait' | 'force' | 'none';
  help: boolean;
}

export function parseDeployArgs(args: string[]): DeployOptions {
  const options: DeployOptions = { restart: 'wait', help: false };
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--force' || arg === '--no-restart') {
      const restart = arg === '--force' ? 'force' : 'none';
      if (options.restart !== 'wait' && options.restart !== restart) {
        throw new Error('--force and --no-restart cannot be used together.');
      }
      options.restart = restart;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}\n${HELP}`);
    else if (options.host !== undefined) throw new Error(HELP);
    else options.host = arg;
  }
  return options;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  captureStdout?: boolean;
}
export type ProcessRunner = (command: string, args: string[], options: RunOptions) => Promise<string>;

/** No local shell: arguments, including paths with spaces, remain separate. */
export const runProcess: ProcessRunner = (command, args, options) => new Promise((done, fail) => {
  const child = spawn(command, args, {
    cwd: options.cwd, env: options.env ?? process.env, shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  let inputError: Error | undefined;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!options.captureStdout) process.stdout.write(chunk);
  });
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  child.stdin.on('error', error => { inputError = error; });
  child.on('error', error => fail(new Error(`Cannot run ${command}: ${error.message}`, { cause: error })));
  child.on('close', (code, signal) => {
    if (code !== 0) {
      fail(new Error(`${command} ${args.join(' ')} failed (${signal ? `signal ${signal}` : `exit ${code}`})${stderr.trim() ? `:\n${stderr.trim()}` : ''}`));
    } else if (inputError) fail(inputError);
    else done(stdout);
  });
  child.stdin.end(options.input);
});

/** SSH runs this on Linux. Only validated temporary paths and release names are passed as arguments. */
export const REMOTE_INSTALL_SCRIPT = `set -euo pipefail
archive=$1 name=$2 web_config=\${3:--}
[[ "$archive" =~ ^/tmp/pi-remote-deploy\\.[a-zA-Z0-9]+$ ]] || { printf 'Invalid archive path\\n' >&2; exit 1; }
[[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+(-dirty)?$ ]] || { printf 'Invalid release name %s\\n' "$name" >&2; exit 1; }
base="$HOME/.local/share/pi-remote"
release="$base/releases/$name"
created=0 switched=0
cleanup() {
  status=$?
  rm -f -- "$archive"
  if [[ "$created" == 1 && "$switched" == 0 ]]; then
    rm -f -- "$base/bin/.pi-remote-$name"
    rm -rf -- "$release"
  fi
  exit "$status"
}
trap cleanup EXIT
mkdir -p "$base/releases" "$base/bin"
# Refuse an existing release: installed code must never change under a running daemon.
mkdir "$release"
created=1
tar -xzf "$archive" -C "$release"
cd "$release"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# node-pty runs each slot's Pi in a terminal. Linux has no prebuilt binary: compile it.
npm rebuild node-pty --no-audit --no-fund
node -e "require('node-pty')"
chmod +x bin/pi-remote
# Validate both the compiled launcher and completion assets before switching.
bin/pi-remote --version
bin/pi-remote completion fish >/dev/null
previous=$(readlink -f -- "$base/bin/pi-remote" || true)
ln -s "$release/bin/pi-remote" "$base/bin/.pi-remote-$name"
mv -Tf "$base/bin/.pi-remote-$name" "$base/bin/pi-remote"
switched=1
# Web management is opt-in. Only the validated, base64-encoded web settings cross SSH.
# Start the configured service before cleanup can remove an older release.
if [[ "$web_config" != - ]]; then
  [[ "$web_config" =~ ^[A-Za-z0-9+/=]+$ ]] || { printf 'Invalid web settings encoding\\n' >&2; exit 1; }
  node dist/cli/web-service.js "$web_config" || {
    printf 'Release %s is installed, but web service setup failed; release cleanup skipped\\n' "$name" >&2
    exit 1
  }
fi
# Preserve current, previous, and every release referenced by a running process.
# If ps fails, set -e stops cleanup rather than deleting potentially live code.
process_args=$(ps -eo args=)
for dir in "$base"/releases/*; do
  [[ -d "$dir" && ! -L "$dir" ]] || continue
  if [[ "$dir" != "$release" && "$dir" != "\${previous%/bin/pi-remote}" && "$process_args" != *"$dir/"* ]]; then
    rm -rf -- "$dir"
  fi
done
`;

export const ARCHIVE_FILES = ['package.json', 'package-lock.json', 'dist', 'bin', 'completions'];

export interface DeployDependencies {
  run: ProcessRunner;
  root: string;
  loadConfig: () => ClientConfig | Promise<ClientConfig>;
  defaultHost: (config: ClientConfig) => string | undefined | Promise<string | undefined>;
  now: () => Date;
  makeTempDir: () => Promise<string>;
  removeTempDir: (path: string) => Promise<void>;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const dependencies: DeployDependencies = {
  run: runProcess,
  root: fileURLToPath(new URL('../', import.meta.url)),
  // A single snapshot supplies both the default host and optional web settings.
  // Imports and --help do not read user configuration.
  loadConfig: async () => (await import('../src/config/client.js')).loadConfig(),
  defaultHost: async config => (await import('../src/cli/config.js')).defaultHost(process.env, () => config),
  now: () => new Date(),
  makeTempDir: () => mkdtemp(join(tmpdir(), 'pi-remote-deploy-')),
  removeTempDir: path => rm(path, { recursive: true, force: true }),
  log: line => console.log(line),
  warn: line => console.error(line),
};

/** Injectable dependencies let tests verify orchestration without building, SSH, or filesystem changes. */
export async function main(args = process.argv.slice(2), overrides: Partial<DeployDependencies> = {}): Promise<void> {
  const deps = { ...dependencies, ...overrides };
  const options = parseDeployArgs(args);
  if (options.help) { deps.log(HELP); return; }
  const config = await deps.loadConfig();
  const host = options.host ?? await deps.defaultHost(config);
  // SSH aliases, DNS names, and optional user@host. Reject options and remote-shell syntax.
  if (!host || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(host)) {
    throw new Error('Give an SSH host alias, or set a default host (see README "Configuration").');
  }
  const run = (command: string, args: string[], options: Omit<RunOptions, 'cwd'> = {}) =>
    deps.run(command, args, { cwd: deps.root, ...options });
  const revision = (await run('git', ['rev-parse', '--short', 'HEAD'], { captureStdout: true })).trim();
  if (!/^[0-9a-f]+$/.test(revision)) throw new Error('Unexpected git revision.');
  const dirty = (await run('git', ['status', '--porcelain'], { captureStdout: true })).trim() ? '-dirty' : '';
  const stamp = deps.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const release = `${stamp}-${revision}${dirty}`;
  await run('npm', ['run', 'build']);

  const tempDir = await deps.makeTempDir();
  const archive = join(tempDir, 'release.tar.gz');
  let remoteArchive: string | undefined;
  let failed = false;
  try {
    // Explicit tar includes the lockfile (npm pack omits it). The environment flag
    // suppresses AppleDouble metadata on macOS and is harmless to GNU tar.
    await run('tar', ['-czf', archive, ...ARCHIVE_FILES], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const remotePath = (await run('ssh', ['-o', 'BatchMode=yes', host, 'mktemp /tmp/pi-remote-deploy.XXXXXX'], { captureStdout: true })).trim();
    if (!/^\/tmp\/pi-remote-deploy\.[a-zA-Z0-9]+$/.test(remotePath)) throw new Error('Unexpected remote temporary path.');
    remoteArchive = remotePath;
    await run('scp', ['-q', '-o', 'BatchMode=yes', archive, `${host}:${remoteArchive}`]);
    const web = config.web ? [Buffer.from(JSON.stringify(config.web)).toString('base64')] : [];
    await run('ssh', ['-o', 'BatchMode=yes', host, 'bash', '-s', '--', remoteArchive, release, ...web], { input: REMOTE_INSTALL_SCRIPT });
    deps.log(`Installed release ${release} on ${host}.`);
    if (options.restart === 'none') {
      deps.log('Daemon not restarted (--no-restart). Run pi-remote restart-daemon when ready.');
    } else {
      try {
        await run(process.execPath, [join(deps.root, 'bin', 'pi-remote'), 'restart-daemon', ...(options.restart === 'force' ? ['--force'] : []), '--host', host]);
      } catch (error) {
        throw new Error(`The release is installed, but the daemon restart failed. Run pi-remote restart-daemon when ready.\n${errorMessage(error)}`, { cause: error });
      }
    }
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupError: unknown;
    if (remoteArchive) {
      try { await run('ssh', ['-o', 'BatchMode=yes', host, 'rm', '-f', '--', remoteArchive]); }
      catch (error) { deps.warn(`Could not remove remote archive ${remoteArchive}: ${errorMessage(error)}`); cleanupError = error; }
    }
    try { await deps.removeTempDir(tempDir); }
    catch (error) { deps.warn(`Could not remove local archive directory ${tempDir}: ${errorMessage(error)}`); cleanupError ??= error; }
    if (!failed && cleanupError) throw cleanupError;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
}
