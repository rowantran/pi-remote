import { normalize } from 'node:path';
import { presentationRegistry } from './globals.js';
import { virtualHome, unavailable } from './vfs.js';
import { fileURLToPath } from './url.js';

/** Home-relative keys let a laptop bundle resolve the same modules on the devbox. */
export function presentationModuleKey(path: string): string {
  const registry = presentationRegistry();
  if (path.startsWith('file:')) path = fileURLToPath(path);
  if (path === '~' || path.startsWith('~/')) return normalize(path);
  path = normalize(path);
  for (const home of [virtualHome(), registry.traceHome]) {
    if (!home) continue;
    const root = normalize(home).replace(/\/$/, '');
    if (path === root) return '~';
    if (root && path.startsWith(`${root}/`)) return `~/${path.slice(root.length + 1)}`;
  }
  return path;
}

interface BrowserJitiOptions { alias?: Record<string, string>; interopDefault?: boolean; moduleCache?: boolean }
/** No eval or filesystem loading: only modules included by the server's presentation build can load. */
export function createJiti(_base?: string, options: BrowserJitiOptions = {}) {
  const load = (path: string, defaults = false): any => {
    const registry = presentationRegistry();
    const key = presentationModuleKey(path);
    const alias = options.alias?.[path];
    const value = Object.hasOwn(registry.dynamic, key) ? registry.dynamic[key]
      : Object.hasOwn(registry.modules, path) ? registry.modules[path]
        : alias && Object.hasOwn(registry.dynamic, presentationModuleKey(alias)) ? registry.dynamic[presentationModuleKey(alias)]
          : undefined;
    if (value === undefined) return unavailable(`Presentation module ${key} was not bundled; import it during extension setup on the server, then reload`);
    return defaults && value !== null && (typeof value === 'object' || typeof value === 'function') && 'default' in value ? value.default : value;
  };
  return Object.assign((path: string) => load(path, options.interopDefault !== false), {
    import: async <T = any>(path: string, importOptions?: { default?: boolean }): Promise<T> => load(path, importOptions?.default === true),
    resolve: (path: string) => presentationModuleKey(options.alias?.[path] ?? path),
  });
}
