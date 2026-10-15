import { virtualHome, unavailable } from './vfs.js';

export function homedir(): string { return virtualHome(); }
export function hostname(): string { return 'browser'; }
export function platform(): string { return 'browser'; }
export function tmpdir(): never { return unavailable('os.tmpdir (no writable local filesystem)'); }
export function type(): string { return 'Browser'; }
export function release(): never { return unavailable('os.release'); }
export function arch(): never { return unavailable('os.arch'); }
export function cpus(): never { return unavailable('os.cpus'); }
export const EOL = '\n';
