import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Theme, initTheme } from '@earendil-works/pi-coding-agent';
import type { RgbColor, TerminalColors, TerminalColorScheme } from '@earendil-works/pi-tui';
import { createPresentationTheme } from './presentation.js';

const BACKGROUNDS = new Set('selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg'.split(' '));
const OPTIONAL: Record<string, string> = { scrollbarTrack: 'muted', scrollbarThumb: 'text', searchMatchText: 'text', searchMatchBg: 'selectedBg', thinkingMax: 'thinkingXhigh' };

const defaultAgentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent');

function relativeLuminance({ r, g, b }: RgbColor): number {
  const linear = (channel: number) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Dark or light from COLORFGBG's background palette index, classified like Pi and Vim. */
export function colorFgBgAppearance(env: NodeJS.ProcessEnv = process.env): TerminalColorScheme | undefined {
  const bg = env.COLORFGBG?.split(';').at(-1)?.trim();
  if (!bg || !/^\d{1,2}$/.test(bg) || Number(bg) > 15) return undefined;
  return Number(bg) <= 6 || Number(bg) === 8 ? 'dark' : 'light';
}

/**
 * Whether the local terminal is dark or light, in Pi's order: the reported background (OSC 11),
 * the terminal's light/dark report (mode 2031), COLORFGBG, then dark.
 */
export function terminalAppearance(colors: TerminalColors = {}, scheme?: TerminalColorScheme, env: NodeJS.ProcessEnv = process.env): TerminalColorScheme {
  const { background, foreground } = colors;
  if (background) {
    const bg = relativeLuminance(background);
    if (foreground) {
      const fg = relativeLuminance(foreground);
      if (Math.abs(fg - bg) > 0.02) return fg > bg ? 'dark' : 'light';
    }
    // White text has more contrast than black text on a dark background.
    return (1.05 / (bg + 0.05)) >= ((bg + 0.05) / 0.05) ? 'dark' : 'light';
  }
  return scheme ?? colorFgBgAppearance(env) ?? 'dark';
}

/** Resolve a Pi `light/dark` theme pair to the member for the terminal appearance. */
export function resolveThemeSelection(selection: string, appearance: TerminalColorScheme): string {
  const parts = selection.split('/');
  if (parts.length > 2 || parts.some(name => !name || !/^[\w.-]+$/.test(name) || name === '.' || name === '..')) throw new Error('Use a theme name, not a path');
  return parts.length === 2 && appearance === 'light' ? parts[0]! : parts.at(-1)!;
}

/** Pi's own `theme` setting, used when no client theme is selected. Missing or invalid settings are ignored. */
export async function readPiThemeSetting(agentDir = defaultAgentDir()): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    return typeof settings?.theme === 'string' && settings.theme ? settings.theme : undefined;
  } catch { return undefined; }
}

/** Theme data only: no private Pi imports, watchers, settings writes, or resource discovery. */
export async function loadLocalTheme(selection = 'system', agentDir = defaultAgentDir(), appearance: TerminalColorScheme = terminalAppearance()): Promise<Theme> {
  const name = resolveThemeSelection(selection, appearance);
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
