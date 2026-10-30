import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath } from '../../config/client.js';
import type { PresentationConfig } from '../../config/presentation.js';

/** Theme files and safe settings for the phone's page colors, as virtual files. */
export interface BrowserConfig { home: string; files: Record<string, string> }
export const MAX_THEME_BYTES = 128 * 1024;
const THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function validThemeName(value: unknown): value is string { return typeof value === 'string' && THEME_NAME.test(value); }
export function validThemeSelection(value: unknown): value is string {
  return typeof value === 'string' && value.split('/').length <= 2 && value.split('/').every(validThemeName);
}

/** Bounded regular-file reads; no arbitrary filesystem paths from the request.
 * The normal client config may be a dotfiles symlink, as in the terminal client. */
async function jsonFile(path: string, followSymlinks = false): Promise<Record<string, unknown> | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | (followSymlinks ? 0 : constants.O_NOFOLLOW) | constants.O_NONBLOCK); }
  catch (error: any) { if (['ENOENT', 'ELOOP'].includes(error.code)) return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_THEME_BYTES) return undefined;
    const data = Buffer.alloc(MAX_THEME_BYTES + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_THEME_BYTES) return undefined;
    try {
      const value = JSON.parse(data.subarray(0, length).toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch { return undefined; }
  } finally { await file.close(); }
}
export function sanitizeTheme(value: Record<string, unknown> | undefined): string | undefined {
  if (!value || typeof value.name !== 'string' || !THEME_NAME.test(value.name)) return undefined;
  const result: Record<string, unknown> = { name: value.name };
  if (value.appearance === 'dark' || value.appearance === 'light') result.appearance = value.appearance;
  for (const key of ['vars', 'colors', 'export']) {
    const map = value[key];
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 256) continue;
    // Theme dictionaries contain only scalar color values, not arbitrary settings.
    result[key] = Object.fromEntries(Object.entries(map).filter(([name, color]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
      && ((typeof color === 'string' && color.length <= 2048) || (typeof color === 'number' && Number.isFinite(color)))));
  }
  if (!result.colors) return undefined;
  return JSON.stringify(result);
}

/** Published Pi theme JSON only; this does not read any user configuration. */
export async function builtinThemeFiles(home: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const builtins = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'modes', 'interactive', 'theme');
  for (const name of ['dark', 'light']) {
    const text = sanitizeTheme(await jsonFile(join(builtins, `${name}.json`)));
    if (!text) throw new Error(`Pinned Pi theme is unavailable: ${name}`);
    files[join(home, '.pi', 'agent', 'themes', `${name}.json`)] = text;
  }
  return files;
}

/** Deliberately independent of daemon/agent configuration loaders: those can read secrets. */
export async function defaultBrowserConfig(options: { home?: string; env?: NodeJS.ProcessEnv; uiConfig?: string; config?: PresentationConfig } = {}): Promise<BrowserConfig> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const selectedAgentDir = env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent');
  const agentDir = selectedAgentDir === '~' ? home : selectedAgentDir.startsWith('~/') ? join(home, selectedAgentDir.slice(2)) : selectedAgentDir;
  const files = await builtinThemeFiles(home);
  const themes = join(agentDir, 'themes');
  const virtualThemes = join(home, '.pi', 'agent', 'themes');
  // Bound both directory scanning and the number/size of exported custom themes.
  try {
    const directory = await opendir(themes);
    let scanned = 0;
    let count = 0;
    for await (const entry of directory) {
      if (++scanned > 128 || count >= 32) break;
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const name = entry.name.slice(0, -5);
      if (!THEME_NAME.test(name) || ['dark', 'light', 'system'].includes(name)) continue;
      const text = sanitizeTheme(await jsonFile(join(themes, entry.name)));
      if (text) { files[join(virtualThemes, entry.name)] = text; count++; }
    }
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const settings = await jsonFile(join(agentDir, 'settings.json')) ?? {};
  const safeSettings: Record<string, unknown> = {};
  if (validThemeSelection(settings.theme)) safeSettings.theme = settings.theme;
  if (typeof settings.hideThinkingBlock === 'boolean') safeSettings.hideThinkingBlock = settings.hideThinkingBlock;
  if (typeof settings.doubleEscapeAction === 'string' && ['fork', 'tree', 'none'].includes(settings.doubleEscapeAction)) safeSettings.doubleEscapeAction = settings.doubleEscapeAction;
  files[join(home, '.pi', 'agent', 'settings.json')] = JSON.stringify(safeSettings);
  const config = options.config ?? await jsonFile(options.uiConfig ?? configPath(env, home), true) ?? {};
  const safeConfig: Record<string, unknown> = {};
  if (validThemeSelection(config.theme)) safeConfig.theme = config.theme;
  if (typeof config.bell === 'boolean') safeConfig.bell = config.bell;
  if (typeof config.sideSplit === 'string' && ['auto', 'right', 'down', 'left', 'up'].includes(config.sideSplit)) safeConfig.sideSplit = config.sideSplit;
  files[join(home, '.config', 'pi-remote', 'config.json')] = JSON.stringify(safeConfig);
  return { home, files };
}
