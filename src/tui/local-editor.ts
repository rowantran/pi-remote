import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { LocalEditorFactory } from './pi-screen.js';

const noop = () => undefined;
/** Any property is a function that does nothing; nested access keeps working. */
const inert: any = new Proxy(noop, { get: (_target, property) => (property === 'then' ? undefined : inert), apply: () => undefined });

/**
 * Loads local copies of the extensions that set the remote editor, and returns the editor
 * factory they set. The extensions only run their `session_start` handlers here, with an
 * API that ignores everything except `ctx.ui.setEditorComponent` and `ctx.ui.theme`.
 */
export async function loadLocalEditorFactory(paths: readonly string[], theme: Theme): Promise<LocalEditorFactory | undefined> {
  if (paths.length === 0) return undefined;
  const alias: Record<string, string> = {};
  for (const pkg of ['pi-coding-agent', 'pi-tui']) alias[`@earendil-works/${pkg}`] = fileURLToPath(import.meta.resolve(`@earendil-works/${pkg}`));
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
  for (const path of paths) {
    const extension = await jiti.import<(api: unknown) => unknown>(path, { default: true });
    await extension(api);
  }
  for (const handler of handlers) await handler({ type: 'session_start', reason: 'startup' }, ctx);
  return factory;
}
