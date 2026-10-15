import { unavailable } from './unsupported.js';
export function spawnProcess(..._args: unknown[]): never { return unavailable('Local process execution'); }
export function spawnProcessSync(..._args: unknown[]): never { return unavailable('Local process execution'); }
export async function waitForChildProcess(..._args: unknown[]): Promise<never> { return unavailable('Local child processes'); }
