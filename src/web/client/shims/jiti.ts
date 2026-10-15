import { presentationRegistry, presentationModuleKey } from './globals.js';

interface BrowserJitiOptions { alias?: Record<string, string>; interopDefault?: boolean; moduleCache?: boolean }
/** No eval or filesystem loading: only modules included by the server's presentation build can load. */
export function createJiti(_base?: string, options: BrowserJitiOptions = {}) {
  const load = (path: string, defaults = false): any => {
    const value = presentationRegistry().require(path, options.alias?.[path]);
    return defaults && value !== null && (typeof value === 'object' || typeof value === 'function') && 'default' in value ? value.default : value;
  };
  return Object.assign((path: string) => load(path, options.interopDefault !== false), {
    import: async <T = any>(path: string, importOptions?: { default?: boolean }): Promise<T> => load(path, importOptions?.default === true),
    resolve: (path: string) => presentationModuleKey(options.alias?.[path] ?? path),
  });
}
