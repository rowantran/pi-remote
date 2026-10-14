import { Buffer } from 'buffer';
import { unavailable } from './unsupported.js';

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
const processShim = {
  env, platform: 'browser', argv: [] as string[], version: '', versions: {} as Record<string, string>,
  cwd: () => '/', exitCode: undefined as number | undefined, pid: 0,
  nextTick: (callback: (...args: any[]) => void, ...args: any[]) => queueMicrotask(() => callback(...args)),
  on: blocked('process.on'), once: blocked('process.once'), off: blocked('process.off'),
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
  traceHome?: string;
  resolve: typeof browserModuleResolve;
  import: (specifier: string) => Promise<any>;
  globals: Record<string, any>;
}
export function presentationRegistry(): BrowserPresentationRegistry {
  const host = globalThis as typeof globalThis & { __piRemotePresentation?: BrowserPresentationRegistry };
  return host.__piRemotePresentation ??= {
    modules: Object.create(null), dynamic: Object.create(null), resolve: browserModuleResolve,
    import: async specifier => unavailable(`Presentation module ${specifier} was not bundled`),
    globals: { process: processShim, Buffer, global, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate },
  };
}
/** Metadata URLs only; this does not import Node modules or grant filesystem access. */
export function browserModuleResolve(specifier: string): string {
  const canonical = specifier.replace(/^@mariozechner\//, '@earendil-works/');
  if (canonical === '@earendil-works/pi-coding-agent') return 'file:///__pi_browser__/index.js';
  if (/^@earendil-works\/pi-(?:tui|ai|agent-core)(?:\/(?:compat|oauth|providers\/all))?$/.test(canonical)) {
    return `file:///__pi_browser__/${canonical.slice('@earendil-works/'.length)}/index.js`;
  }
  if (specifier.startsWith('file:') || specifier.startsWith('/')) return new URL(specifier, 'file:///').href;
  if (Object.hasOwn(presentationRegistry().modules, specifier)) return `file:///__pi_browser__/modules/${encodeURIComponent(specifier)}.js`;
  return unavailable(`Module resolution (${specifier}); sync and bundle this presentation dependency first`);
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
