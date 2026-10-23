import { basename } from 'node:path';
import type { DaemonStatus } from '../protocol/methods.js';
import type { RemoteConnection, SlotInfo } from '../protocol/types.js';

/** Round trips at or above these are shown as slow and very slow. */
export const SLOW_MS = 150;
export const VERY_SLOW_MS = 400;

export type LatencyLevel = 'ok' | 'slow' | 'very-slow';
export function latencyLevel(ms: number): LatencyLevel {
  return ms >= VERY_SLOW_MS ? 'very-slow' : ms >= SLOW_MS ? 'slow' : 'ok';
}

/** 0.4 ms, 8.2 ms, 143 ms. */
export function formatLatency(ms: number): string {
  return ms < 10 ? `${(Math.round(ms * 10) / 10).toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/** The largest unit and, when nonzero, the next one: 40s, 12m, 3h 5m, 2d. */
export function formatDuration(seconds: number): string {
  seconds = Math.max(Math.floor(seconds), 0);
  const units: [number, string][] = [[86_400, 'd'], [3_600, 'h'], [60, 'm'], [1, 's']];
  const index = units.findIndex(([size]) => seconds >= size);
  if (index < 0) return '0s';
  const [size, suffix] = units[index]!;
  const major = Math.floor(seconds / size);
  const next = units[index + 1];
  const minor = next ? Math.floor((seconds - major * size) / next[0]) : 0;
  return minor ? `${major}${suffix} ${minor}${next![1]}` : `${major}${suffix}`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export interface LatencyStats { last: number; min: number; avg: number; max: number; count: number }
export function latencyStats(samples: readonly number[]): LatencyStats | undefined {
  if (!samples.length) return undefined;
  return { last: samples.at(-1)!, min: Math.min(...samples), max: Math.max(...samples),
    avg: samples.reduce((total, sample) => total + sample, 0) / samples.length, count: samples.length };
}

type Requester = Pick<RemoteConnection, 'request'>;
const unknownMethod = (error: unknown) => error instanceof Error && /^Unknown daemon method:/.test(error.message);

/**
 * Time one daemon round trip. `ping` does no work; daemons before host_status lack it,
 * so fall back to `list` (a small read) and remember that for this connection.
 */
export class Pinger {
  private legacy = false;
  constructor(private readonly connection: Requester, private readonly now: () => number = () => performance.now()) {}
  async ping(): Promise<number> {
    if (!this.legacy) {
      const start = this.now();
      try { await this.connection.request('ping'); return this.now() - start; }
      catch (error) { if (!unknownMethod(error)) throw error; this.legacy = true; }
    }
    const start = this.now();
    await this.connection.request('list');
    return this.now() - start;
  }
}

/** Daemon facts, or undefined from a daemon before host_status. */
export async function daemonStatus(connection: Requester): Promise<DaemonStatus | undefined> {
  try { return await connection.request('status'); }
  catch (error) { if (unknownMethod(error)) return undefined; throw error; }
}

export interface SlotCounts { running: number; stopped: number; clients: number }
export function slotCounts(slots: readonly SlotInfo[]): SlotCounts {
  return {
    running: slots.filter(slot => slot.status !== 'exited').length,
    stopped: slots.filter(slot => slot.status === 'exited').length,
    clients: slots.reduce((total, slot) => total + (slot.clients ?? 0), 0),
  };
}
export function formatSlotCounts(counts: SlotCounts): string {
  return [`${counts.running} running`, `${counts.stopped} stopped`, ...(counts.clients ? [`${counts.clients} client${counts.clients === 1 ? '' : 's'} attached`] : [])].join(' · ');
}

/** Labelled rows about the daemon and its machine. Older daemons say how to get them. */
export function daemonRows(status: DaemonStatus | undefined, now = Date.now()): [string, string][] {
  if (!status) return [['daemon', 'details need a newer daemon: deploy, then run pi-remote restart-daemon']];
  const { host } = status;
  return [
    ['daemon', `pid ${status.pid} · up ${formatDuration((now - Date.parse(status.startedAt)) / 1000)} · release ${basename(status.release)}`],
    ['versions', `Pi ${status.piVersion} · Node ${status.nodeVersion}`],
    ['machine', `${host.hostname} · ${host.platform} ${host.arch} · up ${formatDuration(host.uptimeSeconds)}`],
    ['load', `${host.loadavg.map(value => value.toFixed(2)).join(' ')} · ${host.cpus} CPU${host.cpus === 1 ? '' : 's'}`],
    ['memory', `${formatBytes(host.freeMemory)} free of ${formatBytes(host.totalMemory)}`],
  ];
}

/** Align labelled rows: `  label    value`. */
export function formatRows(rows: readonly [string, string][], indent = '  '): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`);
}
