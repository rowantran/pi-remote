import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Theme, initTheme } from '@earendil-works/pi-coding-agent';
import { createPresentationTheme } from './presentation.js';

const BACKGROUNDS = new Set('selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg'.split(' '));
const OPTIONAL: Record<string, string> = { scrollbarTrack: 'muted', scrollbarThumb: 'text', searchMatchText: 'text', searchMatchBg: 'selectedBg', thinkingMax: 'thinkingXhigh' };

/** Theme data only: no private Pi imports, watchers, settings writes, or resource discovery. */
export async function loadLocalTheme(selection = 'system', agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent')): Promise<Theme> {
  // Without terminal appearance metadata choose the dark member, as Pi's documented fallback does.
  const parts = selection.split('/');
  if (parts.length > 2 || parts.some(name => !name || !/^[\w.-]+$/.test(name) || name === '.' || name === '..')) throw new Error('Use a theme name, not a path');
  const name = parts.at(-1)!;
  if (name === 'system') { initTheme('system', false); return createPresentationTheme(); }
  let path = join(agentDir, 'themes', `${name}.json`);
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !['dark', 'light'].includes(name)) throw error;
    // Reading published theme JSON is not importing or patching a private implementation module.
    path = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'modes/interactive/theme', `${name}.json`);
    source = await readFile(path, 'utf8');
  }
  const json = JSON.parse(source);
  if (!json || !json.colors || typeof json.colors !== 'object') throw new Error(`Invalid theme: ${path}`);
  const vars = json.vars ?? {};
  const resolveColor = (value: unknown, seen = new Set<string>()): string | number => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) return value;
    if (typeof value !== 'string') throw new Error(`Invalid color in ${name}`);
    if (Object.hasOwn(vars, value)) {
      if (seen.has(value)) throw new Error(`Circular theme variable: ${value}`);
      return resolveColor(vars[value], new Set([...seen, value]));
    }
    if (value === '' || /^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(value) || /^ok(?:lch|hsl)\(/.test(value)) return value;
    throw new Error(`Unknown theme variable or color: ${value}`);
  };
  const colors: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(json.colors)) colors[key] = resolveColor(value);
  for (const [key, fallback] of Object.entries(OPTIONAL)) colors[key] ??= colors[fallback];
  const required = Object.keys(createPresentationTheme().colors);
  if (required.some(key => colors[key] === undefined)) throw new Error(`Theme ${name} is missing required colors`);
  const foreground = Object.fromEntries(Object.entries(colors).filter(([key]) => !BACKGROUNDS.has(key)));
  const background = Object.fromEntries(Object.entries(colors).filter(([key]) => BACKGROUNDS.has(key)));
  const theme = new Theme(foreground as any, background as any, 'truecolor', { name, sourcePath: path, appearance: json.appearance });
  // Public API keeps Markdown and syntax highlighting consistent with the chosen local theme.
  initTheme(name, false);
  return theme;
}
