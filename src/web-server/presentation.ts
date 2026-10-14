import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { configPath } from '../protocol/config.js';
import { readPresentationConfig } from '../protocol/presentation-config.js';
import { defaultBrowserConfig, type BrowserConfig } from './browser-config.js';
import { MAX_PRESENTATION_CONFIG_BYTES, presentationSourcesHash, readPresentationFile } from './presentation-files.js';

export const MAX_PRESENTATION_BUNDLE_BYTES = 8 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 30_000;
const MAX_WORKER_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_WORKER_LOG_BYTES = 64 * 1024;
const MAX_EXTENSIONS = 32;

export function presentationHash(bundle: string): string { return createHash('sha256').update(bundle).digest('hex'); }
export interface PresentationBundle {
  bundle: string;
  extensions: string[];
  /** Absolute files observed through nested Jiti loaders, not guessed from source text. */
  tracedModules: string[];
  traceHome: string;
  /** Absolute source files from esbuild, including static imports of traced dynamic modules. */
  dependencies: string[];
  /** Digest of the bytes actually consumed by the build, not a later filesystem read. */
  sourceSignature: string;
}
export interface ServerPresentationOptions { uiConfig?: string; home?: string; env?: NodeJS.ProcessEnv }
export interface ServerPresentationResult { config: BrowserConfig; bundle?: string }
interface Cache { selection: string; signature: string; output: PresentationBundle }

/** Trace trusted, same-user code only in a bounded, short-lived process, never in the listener. */
async function buildPresentation(extensions: string[], env: NodeJS.ProcessEnv): Promise<PresentationBundle> {
  const compiled = fileURLToPath(new URL('../cli/presentation-worker.js', import.meta.url));
  const worker = existsSync(compiled) ? compiled : compiled.replace(/\.js$/, '.ts');
  // Do not copy execArgv: a listener/test runner can have --test, --inspect, or unrelated loaders.
  const args = [...(worker.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--max-old-space-size=256', worker];
  const childEnv = { ...env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_TEST_CONTEXT;
  return new Promise<PresentationBundle>((accept, reject) => {
    const child = spawn(process.execPath, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let outputBytes = 0;
    let logBytes = 0;
    const chunks: Buffer[] = [];
    const logs: Buffer[] = [];
    const fail = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new Error('Presentation build timed out')), BUILD_TIMEOUT_MS);
    const diagnostics = (data: Buffer) => {
      logBytes += data.length;
      if (logBytes > MAX_WORKER_LOG_BYTES) return fail(new Error('Presentation build output exceeds limit'));
      logs.push(data);
    };
    child.stdout.on('data', diagnostics);
    child.stderr.on('data', diagnostics);
    const result = child.stdio[3] as Readable;
    result.on('data', (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > MAX_WORKER_RESULT_BYTES) return fail(new Error('Presentation worker result exceeds limit'));
      chunks.push(data);
    });
    result.on('error', fail);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.once('error', error => fail(error));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      let message: { ok: boolean; error?: string; result?: PresentationBundle };
      try { message = JSON.parse(Buffer.concat(chunks, outputBytes).toString('utf8')); }
      catch { return reject(new Error(`Presentation build failed (${signal ?? code}): ${Buffer.concat(logs).toString('utf8').slice(-8192)}`)); }
      if (code !== 0 || !message.ok || !message.result) return reject(new Error(message.error ?? 'Presentation build failed'));
      if (typeof message.result.bundle !== 'string' || Buffer.byteLength(message.result.bundle) > MAX_PRESENTATION_BUNDLE_BYTES) {
        return reject(new Error('Presentation bundle exceeds limit'));
      }
      accept(message.result);
    });
    child.stdin.end(JSON.stringify({ extensions }));
  });
}

/** Ordinary pi-remote config is the only presentation selection; nothing is uploaded or persisted. */
export class ServerPresentation {
  private readonly options: ServerPresentationOptions & { home: string; env: NodeJS.ProcessEnv };
  private cache?: Cache;
  private pending?: Promise<ServerPresentationResult>;

  constructor(options: ServerPresentationOptions = {}) {
    this.options = { ...options, home: resolve(options.home ?? homedir()), env: options.env ?? process.env };
  }

  /** Concurrent reloads share one build. Later reloads re-read preferences and hash source bytes. */
  read(): Promise<ServerPresentationResult> {
    if (this.pending) return this.pending;
    const pending = this.readCurrent().catch(error => {
      // A failed generation must never make an earlier bundle look current.
      this.cache = undefined;
      throw error;
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  private async readCurrent(): Promise<ServerPresentationResult> {
    const { uiConfig, env, home } = this.options;
    // readPresentationConfig owns parsing/path resolution; preflight its input to bound reads.
    const file = uiConfig ?? configPath(env, home);
    try { await readPresentationFile(file, MAX_PRESENTATION_CONFIG_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const presentation = await readPresentationConfig(uiConfig, [], { env, home });
    const config = await defaultBrowserConfig({ uiConfig, env, home });
    const extensions = presentation.extensions;
    if (!extensions.length) { this.cache = undefined; return { config }; }
    if (extensions.length > MAX_EXTENSIONS || extensions.some(path => Buffer.byteLength(path) > 4096)) {
      throw new Error('Presentation extension selection exceeds limit');
    }
    const selection = JSON.stringify(extensions);
    let cached = this.cache;
    let signature: string | undefined;
    if (cached?.selection === selection) {
      try { signature = await presentationSourcesHash(cached.output.dependencies); }
      catch { /* An old import may have been removed along with its file. Rebuild the new graph. */ }
    }
    if (!cached || signature !== cached.signature) {
      // Drop the old generation before tracing: a failed trace cannot serve stale JavaScript.
      this.cache = undefined;
      await presentationSourcesHash(extensions);
      const output = await buildPresentation(extensions, env);
      const currentSignature = await presentationSourcesHash(output.dependencies);
      if (currentSignature !== output.sourceSignature) throw new Error('Presentation sources changed during build; reload to retry');
      cached = { selection, output, signature: output.sourceSignature };
      this.cache = cached;
    }
    const bundle = cached.output.bundle;
    config.presentation = { hash: presentationHash(bundle), bundleBytes: Buffer.byteLength(bundle), extensions: [...extensions] };
    return { config, bundle };
  }
}
