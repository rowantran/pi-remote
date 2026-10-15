import { basename } from 'node:path';
import { PI_VERSION, PROTOCOL_VERSION, type RemoteConnection, type SlotInfo } from '../protocol/types.js';

import type { HelloResult, RestartDaemonResult } from '../protocol/methods.js';

type Hello = HelloResult;
type Outcome = RestartDaemonResult;
export interface RestartResult { before: Hello; after: Hello; reopened: SlotInfo[]; slots: SlotInfo[] }
export interface RestartOptions {
  /** Interrupt busy slots instead of waiting for them. */
  force?: boolean;
  log?: (line: string) => void;
  pollMs?: number;
  reconnectTimeoutMs?: number;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const label = (slot: SlotInfo) => `slot ${slot.number ?? slot.id}`;
export const releaseName = (release?: string) => release ? basename(release) : 'unknown release';

/** Ask the daemon to exit so the installed release replaces it, then connect until a new
 * daemon answers. The daemon decides atomically whether every slot is ready; this client
 * retries that question until it accepts and never stops a slot itself. A refusal locks
 * nothing, so interrupting the wait leaves the old daemon running unchanged. */
export async function restartDaemon(connect: () => Promise<RemoteConnection>, options: RestartOptions = {}): Promise<RestartResult> {
  const log = options.log ?? (() => {});
  const connection = await connect();
  let before: Hello, outcome: Outcome;
  try {
    before = await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    let waiting = '';
    for (;;) {
      try { outcome = await connection.request('restart_daemon', options.force ? { force: true } : {}); }
      catch (error: any) {
        if (!/^Unknown daemon method/.test(error.message)) throw error;
        throw new Error(`Daemon ${before.pid} predates restart-daemon. Once its slots are idle, stop it by hand (kill ${before.pid} on the remote host) and reopen sessions with new --session.`);
      }
      if (outcome.accepted) break;
      const reasons = outcome.blocked.map(({ slot, reason }) => `${label(slot)}: ${reason}`).join('; ') || outcome.reason || 'Daemon is not ready';
      if (reasons !== waiting) log(`Waiting: ${reasons}${waiting ? '' : '. Press Ctrl-C to stop waiting, or use --force to interrupt busy slots.'}`);
      waiting = reasons;
      await pause(options.pollMs ?? 2000);
    }
  } finally { connection.close(); }
  log(`Daemon ${before.pid} (${releaseName(before.release)}) is stopping${outcome.reopen.length ? `; reopening ${outcome.reopen.map(label).join(', ')}` : ''}.`);
  // The old daemon may still hold its lock while Pi processes exit. Each attempt is a new
  // transport whose bridge starts the installed daemon once the old one is gone.
  const deadline = Date.now() + (options.reconnectTimeoutMs ?? 60_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const next = await connect();
      try {
        const after = await next.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
        if (after.pid !== before.pid) {
          const slots = await next.request('list');
          const reopened = slots.filter(slot => outcome.reopen.some(old => old.id === slot.id));
          return { before, after, reopened, slots };
        }
      } finally { next.close(); }
    } catch (error) { last = error; }
    await pause(options.pollMs ?? 500);
  }
  throw new Error(`Old daemon stopped, but no new daemon answered within ${Math.round((options.reconnectTimeoutMs ?? 60_000) / 1000)}s.${last ? ` Last error: ${(last as Error).message}` : ''} Check daemon.log on the remote host.`);
}
