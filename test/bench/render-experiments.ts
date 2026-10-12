import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';

export const RENDER_EXPERIMENTS = [
  'none', 'cache-footer', 'cache-settled-tools', 'cache-both',
  'cache-document', 'cache-document-and-footer',
] as const;
export type RenderExperiment = typeof RENDER_EXPERIMENTS[number];
type Renderable = { render(width: number): string[] };

/**
 * Diagnostic idle-only ablations, NOT production fixes or normal benchmark results.
 * Freezing the footer/document assumes no clock, theme or data changes. The tool
 * experiment caches final results and drops cached output on native updateDisplay.
 * This tests possible savings without silently changing the application's behavior.
 */
export function installRenderExperiment(experiment: RenderExperiment,
  components: { footer?: Renderable; document: Renderable }): () => void {
  const restores: (() => void)[] = [];
  const freeze = (component?: Renderable) => {
    if (!component) throw new Error('Requested render experiment has no component');
    const original = component.render;
    let cache: { width: number; lines: string[] } | undefined;
    component.render = function (width) {
      if (cache?.width === width) return cache.lines;
      const lines = original.call(this, width);
      cache = { width, lines };
      return lines;
    };
    restores.push(() => { component.render = original; });
  };
  if (['cache-footer', 'cache-both', 'cache-document-and-footer'].includes(experiment)) freeze(components.footer);
  if (['cache-document', 'cache-document-and-footer'].includes(experiment)) freeze(components.document);
  if (experiment === 'cache-settled-tools' || experiment === 'cache-both') {
    const prototype = ToolExecutionComponent.prototype as unknown as Renderable & {
      updateDisplay(): void; isPartial: boolean; result?: unknown;
    };
    const originalRender = prototype.render;
    const originalUpdate = prototype.updateDisplay;
    const cache = new WeakMap<object, { width: number; lines: string[] }>();
    prototype.render = function (width) {
      if (this.isPartial || !this.result) return originalRender.call(this, width);
      const previous = cache.get(this);
      if (previous?.width === width) return previous.lines;
      const lines = originalRender.call(this, width);
      cache.set(this, { width, lines });
      return lines;
    };
    prototype.updateDisplay = function () { cache.delete(this); return originalUpdate.call(this); };
    restores.push(() => { prototype.render = originalRender; prototype.updateDisplay = originalUpdate; });
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
