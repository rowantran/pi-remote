import { readPresentationConfig } from '../../config/presentation.js';
import { readPiThemeSetting } from '../../tui/local-theme.js';
import type { VirtualFiles } from './shims/vfs.js';
import { applyBrowserAppearance, readBrowserAppearance } from './appearance.js';

/** The theme files and settings the server shares with the phone, as virtual files. */
export type BrowserConfig = VirtualFiles;

/**
 * Color the page from the configured theme (or Pi's theme setting). Pi renders the session
 * itself; these colors cover the page, and tell Pi whether the phone is light or dark.
 */
export async function applyPhoneAppearance(notify: (error: unknown) => void = () => {}): Promise<void> {
  const config = await readPresentationConfig();
  const selection = config.theme ?? await readPiThemeSetting() ?? 'system';
  let appearance;
  try { appearance = readBrowserAppearance(selection); }
  catch (error) {
    notify(new Error(`Phone theme unavailable; using system colors. ${error instanceof Error ? error.message : String(error)}`));
    appearance = readBrowserAppearance();
  }
  applyBrowserAppearance(appearance);
}

export function browserTerminalTheme(): { background: string; foreground: string; cursor: string } {
  const root = document.documentElement.style;
  return { background: root.getPropertyValue('--app-bg') || '#161616', foreground: root.getPropertyValue('--app-fg') || '#dedede', cursor: root.getPropertyValue('--app-fg') || '#dedede' };
}
