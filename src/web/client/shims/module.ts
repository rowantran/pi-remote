import { unavailable } from './vfs.js';

export function createRequire(): (id: string) => never {
  const require = (id: string): never => unavailable(`require(${id})`);
  return Object.assign(require, { resolve: (id: string): never => unavailable(`require.resolve(${id})`) });
}
export const builtinModules: string[] = [];
