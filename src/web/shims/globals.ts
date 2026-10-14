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
/** Resolve the one metadata URL used by shared theme readers, not arbitrary module imports. */
export function browserModuleResolve(specifier: string): string {
  if (specifier === '@earendil-works/pi-coding-agent') return 'file:///__pi_browser__/index.js';
  return unavailable(`Module resolution (${specifier}); browser presentation extensions must be statically bundled`);
}
/** Syntax highlighting uses the Node immediate API to defer optional language loading. */
export const setImmediate = (callback: (...args: any[]) => void, ...args: any[]): ReturnType<typeof setTimeout> => setTimeout(callback, 0, ...args);
export const clearImmediate = (handle: ReturnType<typeof setTimeout>): void => clearTimeout(handle);
