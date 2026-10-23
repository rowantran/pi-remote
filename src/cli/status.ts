import type { DaemonStatus } from '../protocol/methods.js';
import { errorText, type RemoteConnection, type SlotInfo } from '../protocol/types.js';
import {
  Pinger, daemonRows, daemonStatus, formatLatency, formatRows, formatSlotCounts, latencyLevel, latencyStats, slotCounts,
} from '../tui/host-status.js';
import { style } from './picker.js';

export interface HostReport {
  host: string;
  /** --local: a Unix socket on this machine, not SSH. */
  local?: boolean;
  online: boolean;
  /** SSH (or socket) connection plus the daemon handshake. */
  connectMs?: number;
  /** Daemon round trips on the open connection. */
  pings: number[];
  daemon?: DaemonStatus;
  slots: SlotInfo[];
  error?: string;
}

const now = () => performance.now();

/** Connect once, then measure `count` sequential round trips and read daemon facts. */
export async function collectStatus(connect: () => Promise<RemoteConnection>, host: string, count = 5, clock = now, local = false): Promise<HostReport> {
  const started = clock();
  let connection: RemoteConnection;
  try { connection = await connect(); }
  catch (error) { return { host, local, online: false, pings: [], slots: [], error: errorText(error) }; }
  const connectMs = clock() - started;
  try {
    const pinger = new Pinger(connection, clock);
    const pings: number[] = [];
    for (let index = 0; index < count; index++) pings.push(await pinger.ping());
    const [daemon, slots] = await Promise.all([daemonStatus(connection), connection.request('list')]);
    return { host, local, online: true, connectMs, pings, daemon, slots };
  } catch (error) {
    return { host, local, online: false, connectMs, pings: [], slots: [], error: errorText(error) };
  } finally { connection.close(); }
}

export function styleLatency(ms: number): string {
  const level = latencyLevel(ms);
  return (level === 'ok' ? style.ok : level === 'slow' ? style.warn : style.error)(formatLatency(ms));
}

/** SSH already printed its own diagnostics to stderr; replace only the generic
 * transport message, which talks about remote work this command never had. */
function connectionError(error = 'unknown error'): string {
  const [first = '', ...rest] = error.split('\n').filter(line => line.trim());
  if (!/^(Disconnected\.|SSH exited)/.test(first)) return first;
  return `the connection closed before the daemon answered${rest.length ? ' (SSH output above)' : ''}`;
}

/** Human-readable `pi-remote status`. */
export function formatReport(report: HostReport, at = Date.now()): string {
  if (!report.online) return `${style.bold(report.host)}  ${style.error('✗ unreachable')}\n${formatRows([['error', connectionError(report.error)]]).join('\n')}`;
  const stats = latencyStats(report.pings);
  const rows: [string, string][] = [];
  if (stats) rows.push(['latency', `${styleLatency(stats.avg)} ${style.dim(`(min ${formatLatency(stats.min)} · max ${formatLatency(stats.max)} over ${stats.count} round trip${stats.count === 1 ? '' : 's'})`)}`]);
  if (report.connectMs !== undefined) rows.push(['connect', `${formatLatency(report.connectMs)} ${style.dim(report.local ? '(daemon handshake)' : '(SSH and daemon handshake)')}`]);
  rows.push(...daemonRows(report.daemon, at));
  rows.push(['slots', formatSlotCounts(slotCounts(report.slots))]);
  return [`${style.bold(report.host)}  ${style.ok('● online')}`, ...formatRows(rows)].join('\n');
}

/** One line above `ls` on a terminal: host, round trip, and slot counts. */
export function lsHeader(host: string, latencyMs: number, slots: readonly SlotInfo[]): string {
  return style.dim(`${host} · `) + styleLatency(latencyMs) + style.dim(` · ${formatSlotCounts(slotCounts(slots))}`);
}
