import { readFileSync, readdirSync, accessSync, statSync } from './fs.js';
import { unavailable } from './vfs.js';

export async function readFile(...args: Parameters<typeof readFileSync>): Promise<ReturnType<typeof readFileSync>> { return readFileSync(...args); }
export async function readdir(...args: Parameters<typeof readdirSync>): Promise<ReturnType<typeof readdirSync>> { return readdirSync(...args); }
export async function stat(...args: Parameters<typeof statSync>): Promise<ReturnType<typeof statSync>> { return statSync(...args); }
export async function access(...args: Parameters<typeof accessSync>): Promise<void> { accessSync(...args); }
export async function writeFile(): Promise<never> { return unavailable('fs.writeFile'); }
export async function mkdir(): Promise<never> { return unavailable('fs.mkdir'); }
