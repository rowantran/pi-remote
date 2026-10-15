import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti, type Jiti, type JitiOptions, type TransformOptions } from 'jiti';
import * as tui from '@earendil-works/pi-tui';
import { PresentationHost, type PresentationFactory } from '../../tui/presentation.js';
import type { Snapshot } from '../../protocol/types.js';
import { TRACE_LOADER_KEY, type PresentationTraceLoader } from './presentation-trace-jiti.js';
import type { Loader, Plugin } from 'esbuild';
import { canonicalBrowserModule as canonical } from '../shared/module-names.js';
import { browserBuildOptions, runtimeOnlyBrowserModule as runtimeOnly } from './browser-compat.js';
import { MAX_PRESENTATION_SOURCE_BYTES, MAX_PRESENTATION_SOURCE_FILES, MAX_PRESENTATION_SOURCE_TOTAL_BYTES, presentationSnapshotsHash, presentationSourceSnapshot, readPresentationFile, readPresentationFileSync, type PresentationSourceSnapshot } from '../shared/presentation-files.js';

import type { PresentationBundle } from '../shared/presentation-bundle.js';

export interface BundlePresentationOptions { home?: string; minify?: boolean }
export type { PresentationBundle } from '../shared/presentation-bundle.js';
const require = createRequire(import.meta.url);
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const validExport = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default';

/** Keep public display imports external: bundling these again breaks class/theme identity. */
const displayExports: Record<string, string[]> = {
  '@earendil-works/pi-tui': Object.keys(tui),
  '@earendil-works/pi-ai': ['parseStreamingJson', 'getCurrentSystemMessage', 'uuidv7'],
  '@earendil-works/pi-coding-agent': [
    'AssistantMessageComponent', 'BashExecutionComponent', 'BranchSummaryMessageComponent',
    'CompactionSummaryMessageComponent', 'CustomEditor', 'CustomMessageComponent', 'CustomEntryComponent', 'SkillInvocationMessageComponent',
    'ToolExecutionComponent', 'TreeSelectorComponent', 'UserMessageComponent', 'Theme',
    'getMarkdownTheme', 'getSelectListTheme', 'getSettingsListTheme', 'getLanguageFromPath', 'highlightCode',
    'initTheme', 'buildSessionProjection', 'parseSkillBlock', 'copyToClipboard',
    ...['Bash', 'PowerShell', 'Edit', 'Find', 'Grep', 'Ls', 'Read', 'Write'].map(name => `create${name}ToolDefinition`),
  ],
  jiti: ['createJiti'],
};
const publicEntries = new Map<string, string>();
for (const name of Object.keys(displayExports)) {
  publicEntries.set(fileURLToPath(import.meta.resolve(name)), name);
}
publicEntries.set(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/compat')), '@earendil-works/pi-ai');
const browserPublicEntry = (name: string): string => name === '@earendil-works/pi-coding-agent'
  ? '/__pi_browser__/index.js' : name.startsWith('@earendil-works/')
    ? `/__pi_browser__/${name.slice('@earendil-works/'.length)}/index.js`
    : `/__pi_browser__/modules/${encodeURIComponent(name)}.js`;

function traceAliases(): Record<string, string> {
  const alias: Record<string, string> = {};
  for (const pkg of ['pi-coding-agent', 'pi-tui', 'pi-agent-core', 'pi-ai']) {
    const target = fileURLToPath(import.meta.resolve(`@earendil-works/${pkg}${pkg === 'pi-ai' ? '/compat' : ''}`));
    alias[`@earendil-works/${pkg}`] = target; alias[`@mariozechner/${pkg}`] = target;
  }
  for (const suffix of ['', '/compile', '/value']) {
    alias[`typebox${suffix}`] = require.resolve(`typebox${suffix}`);
    alias[`@sinclair/typebox${suffix}`] = alias[`typebox${suffix}`]!;
  }
  const js = fileURLToPath(new URL('./presentation-trace-jiti.js', import.meta.url));
  alias.jiti = existsSync(js) ? js : js.replace(/\.js$/, '.ts');
  return alias;
}
const emptySnapshot = (): Snapshot => ({
  slot: { id: 'presentation-trace', cwd: '/', status: 'running', createdAt: '', clients: 0 },
  state: {}, entries: [], leafId: null, ui: [], seq: 0,
  live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
});
// The recording alias shares one process-local context. Serialize callers and always restore it.
let traceTail: Promise<unknown> = Promise.resolve();
function rememberSource(sources: Map<string, PresentationSourceSnapshot>, path: string, data: Buffer): void {
  if (data.length > MAX_PRESENTATION_SOURCE_BYTES) throw new Error(`Presentation source exceeds limit: ${path}`);
  const snapshot = presentationSourceSnapshot(data);
  const prior = sources.get(path);
  if (prior && prior.hash !== snapshot.hash) throw new Error(`Presentation sources changed during build: ${path}; reload to retry`);
  sources.set(path, snapshot);
  if (sources.size > MAX_PRESENTATION_SOURCE_FILES
    || [...sources.values()].reduce((sum, source) => sum + source.bytes, 0) > MAX_PRESENTATION_SOURCE_TOTAL_BYTES) {
    throw new Error('Presentation source graph exceeds limit');
  }
}
async function traceExtensions(extensions: string[]): Promise<{ tracedModules: string[]; snapshots: Map<string, PresentationSourceSnapshot> }> {
  const alias = traceAliases();
  const previous = traceTail;
  let release!: () => void;
  traceTail = new Promise<void>(done => { release = done; });
  await previous;
  const globals = globalThis as Record<symbol, PresentationTraceLoader | undefined>;
  const prior = globals[TRACE_LOADER_KEY];
  const traced = new Set<string>();
  const snapshots = new Map<string, PresentationSourceSnapshot>();
  const defaultTransform = createJiti(import.meta.url, { fsCache: false }).options.transform!;
  const transform = (compiler = defaultTransform) => (options: TransformOptions) => {
    if (options.filename && isAbsolute(options.filename)) rememberSource(snapshots, options.filename, Buffer.from(options.source));
    return compiler(options);
  };
  const notices: string[] = [];
  const host = new PresentationHost({ snapshot: emptySnapshot,
    tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } } as any,
    notify: message => notices.push(message), invalidate() {},
  });
  const recording: PresentationTraceLoader = {
    createJiti(base, options: JitiOptions = {}): Jiti {
      const loader = createJiti(base, { ...options, moduleCache: false, fsCache: false, tryNative: false,
        transform: transform(options.transform),
        alias: { ...alias, ...options.alias, jiti: alias.jiti! },
      });
      const record = (id: string) => {
        const shared = canonical(id).replace(/^(@earendil-works\/pi-ai)\/compat$/, '$1');
        // Browser Jiti already serves these namespaces from the app. They are not source files.
        if (builtins.has(shared) || Object.hasOwn(displayExports, shared)) return;
        const resolved = loader.esmResolve(id);
        const path = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
        if (!isAbsolute(path)) throw new Error(`Presentation dynamic import must resolve to a file: ${id}`);
        traced.add(path);
        rememberSource(snapshots, path, readPresentationFileSync(path));
      };
      return new Proxy(loader, {
        apply(target, self, args: [string]) { record(args[0]); return Reflect.apply(target, self, args); },
        get(target, key, receiver) {
          if (key === 'import') return async (id: string, opts?: Parameters<Jiti['import']>[1]) => {
            record(id); return target.import(id, opts);
          };
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
  globals[TRACE_LOADER_KEY] = recording;
  try {
    const loader = createJiti(import.meta.url, { alias, moduleCache: false, fsCache: false, tryNative: false, transform: transform() });
    for (const path of extensions) {
      if (!(await stat(path)).isFile()) throw new Error(`Select a trusted extension file, not a directory: ${path}`);
      rememberSource(snapshots, path, await readPresentationFile(path));
      const factory = await loader.import<PresentationFactory>(path, { default: true });
      if (typeof factory !== 'function') throw new Error(`Extension must export a default factory: ${path}`);
      await host.loadFactories([{ path, factory }]);
    }
    // Factory failures are recoverable in the UI, but a build must never silently ship a partial trace.
    if (notices.length) throw new Error(`Presentation trace failed:\n${notices.join('\n')}`);
    return { tracedModules: [...traced].sort(), snapshots };
  } finally {
    try { await host.shutdown(); }
    finally { if (prior) globals[TRACE_LOADER_KEY] = prior; else delete globals[TRACE_LOADER_KEY]; release(); }
  }
}

const registryPrelude = `
const __piRemoteRegistry = globalThis.__piRemotePresentation;
if (!__piRemoteRegistry?.modules || !__piRemoteRegistry?.globals) throw new Error('Presentation runtime is not initialized');
const __piRemoteUnavailable = name => function () { throw Object.assign(new Error(name + ' is not available in the browser client'), { code: 'ERR_BROWSER_UNSUPPORTED' }); };
// esbuild lowers nonliteral native import() to this closed, registry-only require. No network/eval.
const require = __piRemoteRegistry.require;
`;
const globalsModule = `const g = globalThis.__piRemotePresentation.globals;
${['process', 'Buffer', 'global', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'].map(name => `export const ${name} = g.${name};`).join('\n')}
export const browserModuleResolve = globalThis.__piRemotePresentation.resolve;
`;
function sharedModule(id: string, names: Iterable<string>, node: boolean): string {
  const lines = [`const real = __piRemoteRegistry.modules[${JSON.stringify(id)}] ?? {};`];
  for (const name of [...names].filter(validExport).sort()) {
    lines.push(`export const ${name} = ${node ? `real[${JSON.stringify(name)}] ?? __piRemoteUnavailable(${JSON.stringify(`${id}.${name}`)})` : `real[${JSON.stringify(name)}]`};`);
  }
  lines.push(node
    ? `export default new Proxy(real.default ?? real, { get: (target, key) => key in target ? target[key] : __piRemoteUnavailable(${JSON.stringify(id)} + '.' + String(key)) });`
    : `export default real.default ?? real;`);
  return lines.join('\n');
}
function bundlePlugin(snapshots: Map<string, PresentationSourceSnapshot>): Plugin {
  return { name: 'pi-remote-presentation', setup(context) {
    context.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
      const data = await readPresentationFile(args.path);
      rememberSource(snapshots, args.path, data);
      const extension = args.path.split('.').pop()!;
      const loaders: Record<string, Loader> = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', json: 'json', css: 'css' };
      const loader = loaders[extension] ?? (!args.path.split('/').pop()!.includes('.') ? 'js' : undefined);
      if (!loader) throw new Error(`Unsupported presentation source extension: ${args.path}`);
      return { contents: data, loader };
    });
    context.onResolve({ filter: /^pi-remote-presentation-globals$/ }, () => ({ path: 'globals', namespace: 'presentation' }));
    context.onLoad({ filter: /^globals$/, namespace: 'presentation' }, () => ({ contents: globalsModule, loader: 'js' }));
    context.onResolve({ filter: /.*/ }, args => {
      const id = canonical(args.path).replace(/^(@earendil-works\/pi-ai)\/compat$/, '$1');
      if (runtimeOnly.test(args.path)) return { errors: [{ text: `Browser presentation cannot import runtime-only module: ${args.path}` }] };
      if (Object.hasOwn(displayExports, id)) return { path: id, namespace: 'presentation-shared' };
      const absolute = args.path.startsWith('file:') ? fileURLToPath(args.path) : args.path;
      const sharedEntry = publicEntries.get(absolute);
      if (sharedEntry) return { path: sharedEntry, namespace: 'presentation-shared' };
      if (builtins.has(id)) return { path: id, namespace: 'presentation-node' };
      // Never accidentally resolve another installation of a Pi package (or a private runtime barrel).
      if (/^(?:@earendil-works|@mariozechner)\/pi-/.test(args.path)) {
        return { errors: [{ text: `Browser presentation requires a public display module, not ${args.path}` }] };
      }
      if (/^@sinclair\/typebox(?:\/|$)/.test(args.path)) return { path: require.resolve(args.path.replace('@sinclair/typebox', 'typebox')) };
      if (/^typebox(?:\/|$)/.test(args.path)) return { path: require.resolve(args.path) };
      return undefined;
    });
    context.onLoad({ filter: /.*/, namespace: 'presentation-shared' }, args => ({ contents: sharedModule(args.path, displayExports[args.path]!, false), loader: 'js' }));
    context.onLoad({ filter: /.*/, namespace: 'presentation-node' }, args => {
      let names: string[] = [];
      try { names = Object.keys(require(`node:${args.path}`)); } catch { /* Experimental/unavailable built-ins remain invocation-time stubs. */ }
      return { contents: sharedModule(args.path, names, true), loader: 'js' };
    });
  } };
}

/** Execute trusted factories once in a display-only host, then build a separate CSP-safe ESM file. */
export async function bundlePresentation(extensions: string[], options: BundlePresentationOptions = {}): Promise<PresentationBundle> {
  let build: typeof import('esbuild')['build'];
  try { ({ build } = await import('esbuild')); }
  catch { throw new Error('Phone presentation bundling requires the esbuild runtime dependency. Reinstall pi-remote, then reload.'); }
  const home = resolve(options.home ?? homedir());
  const paths = [...new Set(extensions.map(path => resolve(path.startsWith('~/') ? resolve(home, path.slice(2)) : path)))];
  const { tracedModules, snapshots: tracedSources } = await traceExtensions(paths);
  const lines = paths.map((path, index) => `import factory${index} from ${JSON.stringify(path)};`);
  tracedModules.forEach((path, index) => lines.push(`import * as dynamic${index} from ${JSON.stringify(path)};`));
  lines.push(`export const factories = [${paths.map((_, index) => `factory${index}`).join(',')}];`,
    `export const dynamic = {${tracedModules.flatMap((path, index) => {
      const keys = [normalize(path)];
      const shared = publicEntries.get(path);
      if (shared) keys.push(browserPublicEntry(shared));
      return keys.map(key => `${JSON.stringify(key)}: dynamic${index}`);
    }).join(',')}};`,
    `Object.assign(__piRemoteRegistry.dynamic, dynamic);`);
  const builtSources = new Map<string, PresentationSourceSnapshot>();
  const result = await build({
    ...browserBuildOptions,
    stdin: { contents: lines.join('\n'), resolveDir: process.cwd(), sourcefile: '<pi-remote-presentation-entry>' },
    minify: options.minify ?? true, sourcemap: false,
    plugins: [bundlePlugin(builtSources)], inject: ['pi-remote-presentation-globals'],
    define: {
      'import.meta.resolve': 'browserModuleResolve', 'process.env.NODE_ENV': '"production"',
      // This is a module-location override, not a copy of the server environment.
      ...(process.env.PI_REMOTE_RENDERER_REPO !== undefined
        ? { 'process.env.PI_REMOTE_RENDERER_REPO': JSON.stringify(process.env.PI_REMOTE_RENDERER_REPO) } : {}),
    },
    supported: { 'dynamic-import': false }, banner: { js: registryPrelude },
    nodePaths: [resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-tui'))), '../../..')],
  });
  const inputs = Object.keys(result.metafile!.inputs);
  const forbidden = inputs.filter(path => runtimeOnly.test(path));
  if (forbidden.length) throw new Error(`Browser presentation includes runtime-only modules:\n${forbidden.join('\n')}`);
  // Display classes must only enter through the app registry, never a second embedded package copy.
  const duplicates = inputs.filter(path => /(?:@earendil-works|@mariozechner)\/(?:pi-tui|pi-coding-agent|pi-ai)\//.test(path) && !path.startsWith('presentation-'));
  if (duplicates.length) throw new Error(`Browser presentation embeds shared Pi modules:\n${duplicates.join('\n')}`);
  const dependencies = [...new Set([...paths, ...tracedModules,
    ...inputs.filter(path => !/^(?:presentation[^:]*:|<)/.test(path)).map(path => resolve(path)),
  ])].sort();
  const sources = new Map<string, PresentationSourceSnapshot>();
  for (const path of dependencies) {
    const traced = tracedSources.get(path);
    const built = builtSources.get(path);
    if (traced && built && traced.hash !== built.hash) throw new Error(`Presentation sources changed during build: ${path}; reload to retry`);
    const snapshot = built ?? traced;
    if (!snapshot) throw new Error(`Presentation source snapshot is missing: ${path}`);
    sources.set(path, snapshot);
  }
  return { bundle: result.outputFiles![0]!.text, dependencies, sourceSignature: presentationSnapshotsHash(sources) };
}
