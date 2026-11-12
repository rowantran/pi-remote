import { basename } from 'node:path';
import { PI_VERSION, PROTOCOL_VERSION, errorText, parseVersionMismatch, type RemoteConnection, type SlotInfo } from '../protocol/types.js';

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
  /**
   * Rejects when the next daemon would refuse to start because of the host's Pi version.
   * Called before every restart request, since Pi can be upgraded while this waits.
   */
  checkPi?: () => Promise<void>;
  /** The Pi version this client is built for. Tests set another. */
  piVersion?: string;
}
/** Connects and completes the handshake, naming the given Pi version. */
export type Connect = (piVersion: string) => Promise<RemoteConnection>;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const label = (slot: SlotInfo) => `slot ${slot.number ?? slot.id}`;
export const releaseName = (release?: string) => release ? basename(release) : 'unknown release';

/**
 * Connect to a daemon built for any Pi version. A daemon refuses a `hello` that names
 * another Pi version than its own, because an attached client draws Pi's interface with
 * its own copy of Pi. A restart uses none of that, and a Pi upgrade needs it: the client
 * that deploys the release for the new Pi must restart the daemon built for the old one.
 * So after that refusal, connect again and name the daemon's version. The protocol version
 * must still match, since it defines the requests that follow.
 */
async function connectAnyPi(connect: Connect, own: string): Promise<{ connection: RemoteConnection; hello: Hello }> {
  let piVersion = own;
  let connection: RemoteConnection;
  try { connection = await connect(piVersion); }
  catch (error) {
    const daemon = parseVersionMismatch(errorText(error));
    if (!daemon || daemon.protocol !== PROTOCOL_VERSION || daemon.piVersion === own) throw error;
    piVersion = daemon.piVersion;
    connection = await connect(piVersion);
  }
  try { return { connection, hello: await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion }) }; }
  catch (error) { connection.close(); throw error; }
}

/** Ask the daemon to exit so the installed release replaces it, then connect until a new
 * daemon answers. The daemon decides atomically whether every slot is ready; this client
 * retries that question until it accepts and never stops a slot itself. A refusal locks
 * nothing, so interrupting the wait leaves the old daemon running unchanged. The old and
 * the new daemon can each be built for another Pi version than this client. */
export async function restartDaemon(connect: Connect, options: RestartOptions = {}): Promise<RestartResult> {
  const log = options.log ?? (() => {});
  const own = options.piVersion ?? PI_VERSION;
  const { connection, hello: before } = await connectAnyPi(connect, own);
  let outcome: Outcome;
  try {
    if (before.piVersion && before.piVersion !== own) log(`Daemon ${before.pid} is built for Pi ${before.piVersion}, and this client for Pi ${own}.`);
    let waiting = '';
    for (;;) {
      // A daemon that refuses to start reopens nothing, so every slot would stay stopped.
      try { await options.checkPi?.(); }
      catch (error) {
        throw new Error(`Not restarting the daemon: ${(error as Error).message}. The next daemon would refuse to start and every slot would stay stopped. The current daemon and its slots keep running.`, { cause: error });
      }
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
      const { connection: next, hello: after } = await connectAnyPi(connect, own);
      try {
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
