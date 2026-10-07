import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { Text } from '@earendil-works/pi-tui';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Local presentation adapter. Never loads providers, background workers, or tool executors. */
export default async function rowanUI(pi: ExtensionAPI) {
  const root = process.env.PI_REMOTE_RENDERER_REPO ?? join(homedir(), '.pi/agent/git/github.com/rowantran/pi-extensions');
  const alias = Object.fromEntries(['pi-coding-agent', 'pi-tui', 'pi-agent-core'].map(pkg => [
    `@earendil-works/${pkg}`, fileURLToPath(import.meta.resolve(`@earendil-works/${pkg}`)),
  ]));
  const loader = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias });
  const footer = await loader.import<any>(join(root, 'codex-footer.ts'), { default: true });
  const caret = await loader.import<any>(join(root, 'prompt-caret.ts'), { default: true });
  const compact = await loader.import<any>(join(root, 'compact-tools.ts'));
  const codemode = await loader.import<any>(join(root, 'codemode/render.ts'));
  footer(pi);
  caret(pi);
  compact.default(pi);

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
  // The original worked-for factory patches Pi internals. Reuse only its persisted data.
  pi.registerEntryRenderer('worked-for', (entry, _options, theme) => {
    const seconds = Math.max(0, Math.round(Number((entry.data as any)?.elapsedSeconds ?? 0)));
    const label = seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`
      : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
    return new Text(theme.fg('dim', `Worked for ${label}`), 1, 0);
  });
  pi.registerEntryRenderer('pi.virtual-model-state', () => new Text('', 0, 0));
}
