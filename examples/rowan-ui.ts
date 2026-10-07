import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { ExtensionAPI, MessageRenderer } from '@earendil-works/pi-coding-agent';

// Only this original factory may attempt its expected timing append locally. Remote Pi owns
// persisted history, so suppress that append rather than forwarding it or changing host guards.
type WorkedForPresentationAPI = Pick<ExtensionAPI,
  'on' | 'appendEntry' | 'registerEntryRenderer' | 'registerMarkdownTransformer'>;
function workedForPresentationAPI(pi: ExtensionAPI): WorkedForPresentationAPI {
  const on = ((name: string, handler: any) => {
    // Model-context filtering belongs to remote Pi, not this display-only client.
    if (name === 'context') return () => {};
    return Reflect.apply(pi.on, pi, [name, handler]);
  }) as ExtensionAPI['on'];
  return {
    on,
    appendEntry: (customType: string) => {
      if (customType !== 'worked-for') throw new Error(`Unexpected worked-for entry type: ${customType}`);
    },
    registerEntryRenderer: pi.registerEntryRenderer.bind(pi),
    registerMarkdownTransformer: pi.registerMarkdownTransformer.bind(pi),
  };
}

/** Local presentation adapter. Never loads providers, background workers, or tool executors. */
export default async function rowanUI(pi: ExtensionAPI) {
  const root = process.env.PI_REMOTE_RENDERER_REPO ?? join(homedir(), '.pi/agent/git/github.com/rowantran/pi-extensions');
  const alias = Object.fromEntries(['pi-coding-agent', 'pi-tui', 'pi-agent-core'].map(pkg => [
    `@earendil-works/${pkg}`, fileURLToPath(import.meta.resolve(`@earendil-works/${pkg}`)),
  ]));
  const loader = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias });
  const footer = await loader.import<any>(join(root, 'codex-footer.ts'), { default: true });
  const caret = await loader.import<any>(join(root, 'prompt-caret.ts'), { default: true });
  const background = await loader.import<any>(join(root, 'assistant-background.ts'), { default: true });
  const compact = await loader.import<any>(join(root, 'compact-tools.ts'));
  const workedFor = await loader.import<any>(join(root, 'worked-for.ts'), { default: true });
  const bell = await loader.import<any>(join(root, 'emit-terminal-bel.ts'), { default: true });
  const codemode = await loader.import<any>(join(root, 'codemode/render.ts'));
  const { renderBackgroundMessage } = await loader.import<{ renderBackgroundMessage: MessageRenderer }>(join(root, 'background/render.ts'));
  footer(pi);
  caret(pi);
  // The transcript uses the same public Pi classes this original factory decorates.
  background(pi);
  compact.default(pi);
  // Keep the original live timer, settle/shutdown cleanup, renderer and Markdown filter.
  // Its private CustomEntryComponent spacing patch runs too, but our Transcript renders
  // custom entries directly and does not use that native wrapper.
  await workedFor(workedForPresentationAPI(pi));
  // Remote Pi runs in RPC mode, where this factory is a no-op and stdout carries JSONL.
  // Run it here instead: the local host reports mode "tui" and forwards remote settle
  // events, so BEL reaches the local terminal (Ghostty's bell title, dock, SketchyBar).
  bell(pi);
  // Completion/check-in notices share the renderer without loading background.ts workers.
  pi.registerMessageRenderer('background', renderBackgroundMessage);

  // Capture only the existing render functions. No codemode runtime is instantiated.
  const visualTool = { name: 'codemode', label: 'Codemode', description: '', parameters: { type: 'object', properties: {} } };
  const renderers = codemode.compactCodemodeTool(visualTool);
  pi.registerToolRenderer((name, next) => name === 'codemode' ? renderers : next());

  // Use the same generic compact renderer for background, MCP, Slack and web tools,
  // without loading their extension factories or credential/process initialization.
  pi.registerToolRenderer((name, next) => {
    const existing = next();
    if (existing) return existing;
    let captured: any;
    const capture = { registerTool: (tool: any) => { captured = tool; } } as unknown as ExtensionAPI;
    compact.withCompactToolRendering(capture).registerTool({ ...visualTool, name });
    return captured;
  });
}
