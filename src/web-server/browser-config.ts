import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath } from '../protocol/config.js';

export interface BrowserConfig { home: string; files: Record<string, string> }
export const MAX_THEME_BYTES = 128 * 1024;
const THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Bounded reads, no symlinks/pipes, and no arbitrary filesystem paths from the request. */
async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
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
function theme(value: Record<string, unknown> | undefined): string | undefined {
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

/** Deliberately independent of daemon/agent configuration loaders: those can read secrets. */
export async function defaultBrowserConfig(options: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<BrowserConfig> {
  const home = options.home ?? homedir();
  const files: Record<string, string> = {};
  const themes = join(home, '.pi', 'agent', 'themes');
  const builtins = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'modes', 'interactive', 'theme');
  for (const name of ['dark', 'light']) {
    const text = theme(await jsonFile(join(builtins, `${name}.json`)));
    if (!text) throw new Error(`Pinned Pi theme is unavailable: ${name}`);
    files[join(themes, `${name}.json`)] = text;
  }
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
      const text = theme(await jsonFile(join(themes, entry.name)));
      if (text) { files[join(themes, entry.name)] = text; count++; }
    }
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const settings = await jsonFile(join(home, '.pi', 'agent', 'settings.json')) ?? {};
  const safeSettings: Record<string, unknown> = {};
  if (typeof settings.theme === 'string' && THEME_NAME.test(settings.theme)) safeSettings.theme = settings.theme;
  if (typeof settings.hideThinkingBlock === 'boolean') safeSettings.hideThinkingBlock = settings.hideThinkingBlock;
  if (typeof settings.doubleEscapeAction === 'string' && ['fork', 'tree', 'none'].includes(settings.doubleEscapeAction)) safeSettings.doubleEscapeAction = settings.doubleEscapeAction;
  files[join(home, '.pi', 'agent', 'settings.json')] = JSON.stringify(safeSettings);
  const config = await jsonFile(configPath(options.env ?? process.env, home)) ?? {};
  const safeConfig: Record<string, unknown> = {};
  if (typeof config.theme === 'string' && THEME_NAME.test(config.theme)) safeConfig.theme = config.theme;
  if (typeof config.bell === 'boolean') safeConfig.bell = config.bell;
  if (typeof config.sideSplit === 'string' && ['auto', 'right', 'down', 'left', 'up'].includes(config.sideSplit)) safeConfig.sideSplit = config.sideSplit;
  files[join(home, '.config', 'pi-remote', 'config.json')] = JSON.stringify(safeConfig);
  return { home, files };
}
