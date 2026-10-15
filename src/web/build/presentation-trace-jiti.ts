import type { Jiti, JitiOptions } from 'jiti';

/** Loaded through a Jiti alias, including by loaders created inside an adapter's factory. */
export interface PresentationTraceLoader {
  createJiti(base: string, options?: JitiOptions): Jiti;
}
export const TRACE_LOADER_KEY = Symbol.for('pi-remote.presentation-trace-loader');
export function createJiti(base: string, options?: JitiOptions): Jiti {
  const loader = (globalThis as Record<symbol, PresentationTraceLoader | undefined>)[TRACE_LOADER_KEY];
  if (!loader) throw new Error('Presentation trace loader is not active');
  return loader.createJiti(base, options);
}
export default createJiti;
