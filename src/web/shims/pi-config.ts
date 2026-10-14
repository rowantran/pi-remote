import { join } from 'node:path';
import { virtualHome, BUILTIN_THEME_DIR } from './vfs.js';

/** Display-only config for Pi 1.0.4. Never inspect an installation or discover resources. */
export const APP_NAME = 'pi';
export const CONFIG_DIR_NAME = '.pi';
export function getAgentDir(): string { return join(virtualHome(), '.pi/agent'); }
export function getCustomThemesDir(): string { return join(getAgentDir(), 'themes'); }
export function getThemesDir(): string { return BUILTIN_THEME_DIR; }
export function getSessionsDir(): string { return join(getAgentDir(), 'sessions'); }
export function getBinDir(): string { return join(getAgentDir(), 'bin'); }
export function getReadmePath(): string { return '/__pi_browser__/README.md'; }
