import { unavailable } from './vfs.js';

/** Presentation adapters are not loaded from disk in the browser. */
export function createJiti(): { import: () => Promise<never> } {
  return { import: async () => unavailable('Loading presentation adapters') };
}
