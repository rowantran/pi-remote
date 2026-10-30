import { Buffer } from 'buffer';
import { normalize } from 'node:path';
import { canonicalBrowserModule } from '../../shared/module-names.js';
import { virtualHome, unavailable } from './vfs.js';
import { fileURLToPath } from './url.js';

/** Injected by esbuild into every module, so globals exist before dependency evaluation. */
const env: Record<string, string | undefined> = {
  TERM: 'xterm-256color', COLORTERM: 'truecolor', PI_IMAGE_PROTOCOL: 'none',
};
const blocked = (name: string) => (..._args: unknown[]): never => unavailable(name);
const stream = (name: string) => ({
  isTTY: false, write: blocked(`${name}.write (supply a browser Terminal)`),
  on: blocked(`${name}.on`), once: blocked(`${name}.once`), off: blocked(`${name}.off`),
});
const hrtime = (previous?: [number, number]): [number, number] => {
  const ns = Math.round(performance.now() * 1e6) - (previous ? previous[0] * 1e9 + previous[1] : 0);
  const seconds = Math.floor(ns / 1e9);
  return [seconds, ns - seconds * 1e9];
};
/** Accept (and ignore) only 'exit' listeners; anything else is unavailable, as before. */
const exitOnly = (name: string) => (event: string, ..._rest: unknown[]) => {
  if (event !== 'exit') return blocked(name)();
  return processShim;
};
const processShim = {
  env, platform: 'browser', argv: [] as string[], version: '', versions: {} as Record<string, string>,
  cwd: () => '/', exitCode: undefined as number | undefined, pid: 0,
  nextTick: (callback: (...args: any[]) => void, ...args: any[]) => queueMicrotask(() => callback(...args)),
  // pi-tui 1.4 restores the terminal from a process 'exit' handler. A page has no process exit.
  on: exitOnly('process.on'), once: exitOnly('process.once'), off: exitOnly('process.off'),
  removeListener: blocked('process.removeListener'), emit: blocked('process.emit'),
  stdout: stream('process.stdout'), stderr: stream('process.stderr'), stdin: stream('process.stdin'),
  hrtime: Object.assign(hrtime, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: blocked('process.memoryUsage'), exit: blocked('process.exit'), kill: blocked('process.kill'),
  chdir: blocked('process.chdir'),
};
/** A real Node process, if present in a test runner, must never be replaced. */
const browserGlobal = globalThis as unknown as { process?: typeof processShim; Buffer?: typeof Buffer; global?: typeof globalThis };
if (typeof window !== 'undefined') {
  browserGlobal.process = processShim;
  browserGlobal.Buffer = Buffer;
  browserGlobal.global = globalThis;
}
export { processShim as process, Buffer };
export const global = globalThis;
/** Runtime bridge shared with separately bundled, trusted presentation adapters. */
export interface BrowserPresentationRegistry {
  modules: Record<string, Record<string, any>>;
  dynamic: Record<string, any>;
  require: typeof requirePresentation;
  resolve: typeof browserModuleResolve;
  import: (specifier: string) => Promise<any>;
  globals: Record<string, any>;
}
export function presentationRegistry(): BrowserPresentationRegistry {
  const host = globalThis as typeof globalThis & { __piRemotePresentation?: BrowserPresentationRegistry };
  return host.__piRemotePresentation ??= {
    modules: Object.create(null), dynamic: Object.create(null), require: requirePresentation, resolve: browserModuleResolve,
    import: async specifier => requirePresentation(specifier),
    globals: { process: processShim, Buffer, global, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate },
  };
}
/** Dynamic imports resolve only against this server's bundled modules, without network/eval. */
export function presentationModuleKey(path: string): string {
  if (typeof path !== 'string') throw new TypeError('Presentation module path must be a string');
  if (path.startsWith('file:')) path = fileURLToPath(path);
  if (path === '~' || path.startsWith('~/')) path = virtualHome() + path.slice(1);
  return normalize(canonicalBrowserModule(path));
}
function requirePresentation(specifier: string, alias?: string): any {
  const registry = presentationRegistry();
  for (const path of alias ? [specifier, alias] : [specifier]) {
    const key = presentationModuleKey(path);
    if (Object.hasOwn(registry.modules, key)) return registry.modules[key];
    if (Object.hasOwn(registry.dynamic, key)) return registry.dynamic[key];
  }
  return unavailable(`Presentation module ${specifier} was not bundled; import it during extension setup on the server, then reload`);
}
/** Metadata URLs only; this does not import Node modules or grant filesystem access. */
export function browserModuleResolve(specifier: string): string {
  const canonical = canonicalBrowserModule(specifier);
  if (canonical === '@earendil-works/pi-coding-agent') return 'file:///__pi_browser__/index.js';
  if (/^@earendil-works\/pi-(?:tui|ai|agent-core)(?:\/(?:compat|oauth|providers\/all))?$/.test(canonical)) {
    return `file:///__pi_browser__/${canonical.slice('@earendil-works/'.length)}/index.js`;
  }
  if (specifier.startsWith('file:') || specifier.startsWith('/')) return new URL(specifier, 'file:///').href;
  if (Object.hasOwn(presentationRegistry().modules, canonical)) return `file:///__pi_browser__/modules/${encodeURIComponent(canonical)}.js`;
  return unavailable(`Module resolution (${specifier}); bundle this presentation dependency on the server first`);
}
/** Pi's ScrollView/selection timers use Node's unref(). Bind timer calls in the bundle
 * to these handles rather than patching the pinned package or browser globals. */
class BrowserTimer {
  constructor(readonly id: number) {}
  unref(): this { return this; }
  ref(): this { return this; }
  hasRef(): boolean { return false; }
  [Symbol.toPrimitive](): number { return this.id; }
}
export function setTimeout(callback: (...args: any[]) => void, delay?: number, ...args: any[]): any {
  return typeof window === 'undefined' ? globalThis.setTimeout(callback, delay, ...args) : new BrowserTimer(window.setTimeout(callback, delay, ...args));
}
export function setInterval(callback: (...args: any[]) => void, delay?: number, ...args: any[]): any {
  return typeof window === 'undefined' ? globalThis.setInterval(callback, delay, ...args) : new BrowserTimer(window.setInterval(callback, delay, ...args));
}
export function clearTimeout(handle: any): void { globalThis.clearTimeout(handle instanceof BrowserTimer ? handle.id : handle); }
export function clearInterval(handle: any): void { globalThis.clearInterval(handle instanceof BrowserTimer ? handle.id : handle); }
/** Syntax highlighting uses the Node immediate API to defer optional language loading. */
export const setImmediate = (callback: (...args: any[]) => void, ...args: any[]): ReturnType<typeof setTimeout> => setTimeout(callback, 0, ...args);
export const clearImmediate = (handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle);
