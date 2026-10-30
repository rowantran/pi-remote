import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { LocalEditorFactory } from './pi-screen.js';

const noop = () => undefined;
/** Any property is a function that does nothing and returns itself; nested use keeps working. */
const inert: any = new Proxy(noop, {
  get: (_target, property) => (property === 'then' ? undefined : property === Symbol.toPrimitive ? () => '' : inert),
  apply: () => inert,
});

/**
 * Loads local copies of the extensions that set the remote editor, and returns the editor
 * factory they set. The extensions only run their `session_start` handlers here, with an
 * API that ignores everything except `ctx.ui.setEditorComponent` and `ctx.ui.theme`.
 */
export async function loadLocalEditorFactory(paths: readonly string[], theme: Theme, onError: (message: string) => void = () => {}): Promise<LocalEditorFactory | undefined> {
  if (paths.length === 0) return undefined;
  // Extensions may live outside this checkout (for example beside the config file), so
  // resolve the packages they import to this installation's copies.
  const resolveModule = (name: string) => fileURLToPath(import.meta.resolve(name));
  const alias: Record<string, string> = { jiti: resolveModule('jiti') };
  for (const pkg of ['pi-coding-agent', 'pi-tui', 'pi-agent-core', 'pi-ai']) {
    try { alias[`@earendil-works/${pkg}`] = resolveModule(`@earendil-works/${pkg}${pkg === 'pi-ai' ? '/compat' : ''}`); } catch { /* Not installed. */ }
  }
  const jiti = createJiti(import.meta.url, { alias, moduleCache: false });
  const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  let factory: LocalEditorFactory | undefined;
  const ui = new Proxy({
    theme,
    setEditorComponent: (next: LocalEditorFactory | undefined) => { factory = next; },
    getEditorComponent: () => factory,
  }, { get: (target, property) => (property in target ? (target as any)[property] : inert) });
  const ctx = new Proxy({ ui, mode: 'tui', hasUI: true }, { get: (target, property) => (property in target ? (target as any)[property] : inert) });
  const api = new Proxy({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { if (name === 'session_start') handlers.push(handler); return noop; },
  }, { get: (target, property) => (property in target ? (target as any)[property] : inert) });
  // An extension that fails here only loses its local editor; report it and keep going.
  for (const path of paths) {
    try {
      const extension = await jiti.import<(api: unknown) => unknown>(path, { default: true });
      await extension(api);
    } catch (error) { onError(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const handler of handlers) {
    try { await handler({ type: 'session_start', reason: 'startup' }, ctx); }
    catch (error) { onError(`session_start: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return factory;
}
