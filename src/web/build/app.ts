import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildFailure, type Message, type Plugin } from 'esbuild';
import { canonicalBrowserModule } from '../shared/module-names.js';
import { browserBuildOptions, runtimeOnlyBrowserModule } from './browser-compat.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const shims = join(root, 'src/web/client/shims');
const agentDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const aiDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')));

/** Handwritten browser implementations. Other Node built-ins become explicit throwing stubs. */
const replacements: Record<string, string> = {
  fs: join(shims, 'fs.ts'), 'fs/promises': join(shims, 'fs-promises.ts'), os: join(shims, 'os.ts'),
  url: join(shims, 'url.ts'), crypto: join(shims, 'crypto.ts'), module: join(shims, 'module.ts'), util: join(shims, 'util.ts'),
  path: require.resolve('path-browserify'), events: require.resolve('events/'), buffer: require.resolve('buffer/'),
  perf_hooks: join(shims, 'perf-hooks.ts'),
};
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/**
 * Shared display modules import Node APIs for laptop-only features. Missing named exports are
 * discovered by esbuild, recorded in unsupported-node-apis.json, and made to throw when invoked.
 * This does NOT emulate process execution, filesystem writes, native helpers, or module loading.
 */
function browserPlugin(missing: Map<string, Set<string>>): Plugin {
  return {
    name: 'pi-remote-browser',
    setup(context) {
      context.onResolve({ filter: runtimeOnlyBrowserModule }, args => ({ errors: [{ text: `Browser build cannot import runtime-only module: ${args.path}` }] }));
      context.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: join(shims, 'pi-coding-agent.ts') }));
      context.onResolve({ filter: /^pi-coding-agent-dist\// }, args => ({ path: join(agentDist, args.path.slice('pi-coding-agent-dist/'.length)) }));
      context.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, () => ({ path: join(shims, 'pi-ai.ts') }));
      context.onResolve({ filter: /^pi-ai-dist\// }, args => ({ path: join(aiDist, args.path.slice('pi-ai-dist/'.length)) }));
      context.onResolve({ filter: /(?:config|image-convert|child-process)\.js$/ }, args => {
        const path = resolve(args.resolveDir, args.path);
        if (path === join(agentDist, 'config.js')) return { path: join(shims, 'pi-config.ts') };
        if (path === join(agentDist, 'utils/image-convert.js')) return { path: join(shims, 'image-convert.ts') };
        if (path === join(agentDist, 'utils/child-process.js')) return { path: join(shims, 'child-process.ts') };
        return undefined;
      });
      context.onResolve({ filter: /^jiti$/ }, () => ({ path: join(shims, 'jiti.ts') }));
      context.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, args => {
        if (!builtins.has(args.path)) return undefined;
        return { path: canonicalBrowserModule(args.path), namespace: 'node-stub' };
      });
      context.onLoad({ filter: /.*/, namespace: 'node-stub' }, args => {
        const names = [...(missing.get(args.path) ?? [])].filter(name => name !== 'default');
        const real = replacements[args.path];
        const lines = [`const unavailable = name => function () { throw Object.assign(new Error(name + ' is not available in the browser client'), { code: 'ERR_BROWSER_UNSUPPORTED' }); };`];
        if (real) lines.push(`import * as real from ${JSON.stringify(real)};`, `export * from ${JSON.stringify(real)};`);
        else lines.push('const real = {};');
        for (const name of names) lines.push(`export const ${name} = unavailable(${JSON.stringify(`${args.path}.${name}`)});`);
        lines.push(`export default new Proxy({ ...(real.default ?? real) }, { get: (target, key) => key in target ? target[key] : unavailable(${JSON.stringify(args.path)} + '.' + String(key)) });`);
        return { contents: lines.join('\n'), loader: 'js', resolveDir: root };
      });
    },
  };
}

function missingExports(messages: Message[], missing: Map<string, Set<string>>): boolean {
  let added = false;
  for (const message of messages) {
    const match = /No matching export in "node-stub:([^"]+)" for import "([^"]+)"/.exec(message.text);
    if (!match) continue;
    const names = missing.get(match[1]!) ?? new Set<string>();
    if (!names.has(match[2]!)) { names.add(match[2]!); added = true; }
    missing.set(match[1]!, names);
  }
  return added;
}

/** Copy fixed source assets without requiring UI files during isolated build probes. */
async function copyAssets(source: string, target: string, nested = false): Promise<void> {
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (entry.isDirectory() && (nested || entry.name === 'assets')) {
      await mkdir(join(target, entry.name), { recursive: true });
      await copyAssets(join(source, entry.name), join(target, entry.name), true);
    } else if (entry.isFile() && /\.(?:html|css|svg|png|ico|webmanifest|woff2?)$/.test(entry.name)) {
      await copyFile(join(source, entry.name), join(target, entry.name));
    }
  }
}

/** Version the worker from its template and the exact fixed shell bytes, never timestamps/paths. */
async function writeServiceWorker(outdir: string): Promise<void> {
  let source: string;
  try { source = await readFile(join(root, 'src/web/client/sw.js'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!source.includes('__BUILD_ID__')) throw new Error('Service worker is missing its build ID placeholder');
  const hash = createHash('sha256').update(source);
  for (const name of ['index.html', 'app.js', 'app.css', 'xterm.css', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'].sort()) {
    hash.update(`\0${name}\0`);
    try {
      const bytes = await readFile(join(outdir, name));
      hash.update(`${bytes.length}\0`).update(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('missing\0'); // Isolated entry probes may run before all UI assets exist.
    }
  }
  await writeFile(join(outdir, 'sw.js'), source.replaceAll('__BUILD_ID__', hash.digest('hex')));
}

export interface BuildWebOptions { outdir?: string; entry?: string; minify?: boolean }
export async function buildWeb(options: BuildWebOptions = {}): Promise<void> {
  const outdir = resolve(options.outdir ?? join(root, 'dist/web'));
  const missing = new Map<string, Set<string>>();
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await build({
        ...browserBuildOptions, entryPoints: [options.entry ?? join(root, 'src/web/client/main.ts')],
        outdir, entryNames: 'app', minify: options.minify ?? true, sourcemap: true, plugins: [browserPlugin(missing)],
        // Injection binds references before dependency evaluation; an entry side-effect import is too late.
        inject: [join(shims, 'globals.ts')],
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.resolve': 'browserModuleResolve' },
        loader: { '.json': 'json' },
      });
      // Fail closed if a new display import brings in runtime-only modules.
      const forbidden = Object.keys(result.metafile!.inputs).filter(path => runtimeOnlyBrowserModule.test(path));
      if (forbidden.length) throw new Error(`Browser build includes runtime-only modules:\n${forbidden.join('\n')}`);
      await mkdir(outdir, { recursive: true });
      for (const output of result.outputFiles!) await writeFile(output.path, output.contents);
      await writeFile(join(outdir, 'bundle-meta.json'), JSON.stringify(result.metafile, null, 2));
      await writeFile(join(outdir, 'unsupported-node-apis.json'), JSON.stringify(Object.fromEntries(
        [...missing].sort(([a], [b]) => a.localeCompare(b)).map(([module, names]) => [module, [...names].sort()]),
      ), null, 2));
      break;
    } catch (error) {
      const failure = error as BuildFailure;
      if (attempt < 5 && failure.errors && missingExports(failure.errors, missing)) continue;
      throw error;
    }
  }
  const css = await readFile(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
  await writeFile(join(outdir, 'xterm.css'), css);
  await copyAssets(join(root, 'src/web/client'), outdir);
  await writeServiceWorker(outdir);
}
