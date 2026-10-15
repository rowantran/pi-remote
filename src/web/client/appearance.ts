import { colorToHex, parseColor } from '@earendil-works/pi-tui';
import { resolveThemeSelection } from '../../tui/local-theme.js';
import { BUILTIN_THEME_DIR, readVirtualFile, virtualHome } from './shims/vfs.js';

export type BrowserColorScheme = 'light' | 'dark';
export interface BrowserAppearance {
  theme: string;
  appearance: BrowserColorScheme;
  colorScheme: BrowserColorScheme;
  terminal: { background: string; foreground: string; cursor: string };
  variables: Record<string, string>;
}
export function preferredAppearance(): BrowserColorScheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Use Pi's public color conversion, including OKHSL, which is not a browser CSS syntax. */
export function themeCssColor(value: unknown, vars: Record<string, unknown> = {}, seen = new Set<string>()): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
    return colorToHex(parseColor(value));
  }
  if (typeof value !== 'string' || !value) return undefined;
  if (Object.hasOwn(vars, value)) {
    if (seen.has(value)) return undefined;
    return themeCssColor(vars[value], vars, new Set([...seen, value]));
  }
  if (/^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(value)) return value;
  // Theme colors, not arbitrary CSS declarations or url() values.
  if (/^ok(?:lch|hsl)\([\d.%\s,+/-]+\)$/i.test(value)) {
    try { return colorToHex(parseColor(value)); } catch { return undefined; }
  }
  return undefined;
}
function backgroundScheme(background: string, fallback: BrowserColorScheme): BrowserColorScheme {
  let hex = background.slice(1);
  if (!/^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(background)) return fallback;
  if (hex.length === 3) hex = [...hex].map(channel => channel + channel).join('');
  const [r, g, b] = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 'light' : 'dark';
}

/** Pure color derivation; absent exports and terminal-default colors use readable fallbacks. */
export function appearanceFromTheme(theme: string, json: any, appearance: BrowserColorScheme): BrowserAppearance {
  const fallback = appearance === 'light'
    ? { bg: '#ffffff', fg: '#202020', card: '#f4f4f4', info: '#e8e8e8', border: '#b0b0b0', accent: '#245a94', muted: '#626262', error: '#a32424' }
    : { bg: '#161616', fg: '#dedede', card: '#202020', info: '#262626', border: '#555555', accent: '#89b4fa', muted: '#aaaaaa', error: '#ffaaaa' };
  const color = (value: unknown, defaultColor: string) => themeCssColor(value, json?.vars) ?? defaultColor;
  const background = color(json?.export?.pageBg, fallback.bg);
  const foreground = color(json?.colors?.text, fallback.fg);
  const card = color(json?.export?.cardBg, fallback.card);
  const info = color(json?.export?.infoBg, fallback.info);
  const border = color(json?.colors?.borderMuted ?? json?.colors?.border, fallback.border);
  const accent = color(json?.colors?.accent, fallback.accent);
  return {
    theme, appearance,
    colorScheme: json?.appearance === 'light' || json?.appearance === 'dark' ? json.appearance : backgroundScheme(background, appearance),
    terminal: { background, foreground, cursor: foreground },
    variables: {
      '--app-bg': background, '--app-fg': foreground, '--chrome-bg': card, '--info-bg': info,
      '--input-bg': card, '--button-bg': info, '--border': border, '--accent': accent,
      '--muted': color(json?.colors?.muted, fallback.muted), '--error': color(json?.colors?.error, fallback.error),
    },
  };
}
export function readBrowserAppearance(selection = 'system', appearance = preferredAppearance()): BrowserAppearance {
  const selected = resolveThemeSelection(selection, appearance);
  const theme = selected === 'system' ? appearance : selected;
  let source: string;
  try { source = readVirtualFile(`${virtualHome()}/.pi/agent/themes/${theme}.json`); }
  catch (error) {
    if (!['dark', 'light'].includes(theme)) throw error;
    source = readVirtualFile(`${BUILTIN_THEME_DIR}/${theme}.json`);
  }
  // A named dark/light theme must stay readable even when it differs from the device preference.
  const fallback = /(?:^|[-_.])light$/.test(theme) ? 'light' : /(?:^|[-_.])dark$/.test(theme) ? 'dark' : appearance;
  return appearanceFromTheme(theme, JSON.parse(source), fallback);
}
export function applyBrowserAppearance(appearance: BrowserAppearance): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(appearance.variables)) root.style.setProperty(key, value);
  root.style.colorScheme = appearance.colorScheme;
  root.dataset.theme = appearance.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', appearance.terminal.background);
}
