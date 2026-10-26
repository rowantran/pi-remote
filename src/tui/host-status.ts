import { basename } from 'node:path';
import type { DaemonStatus } from '../protocol/methods.js';
import type { RemoteConnection, SlotInfo } from '../protocol/types.js';
import { plainText, type Paint } from './table.js';

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
 * Time one daemon round trip. `ping` does no work; older daemons lack it,
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

/** Daemon facts, or undefined from an older daemon without `status`. */
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
    ['daemon', `pid ${status.pid} · up ${formatDuration((now - Date.parse(status.startedAt)) / 1000)} · release ${plainText(basename(status.release))}`],
    ['versions', `Pi ${plainText(status.piVersion)} · Node ${plainText(status.nodeVersion)}`],
    ['machine', `${plainText(host.hostname)} · ${plainText(host.platform)} ${plainText(host.arch)} · up ${formatDuration(host.uptimeSeconds)}`],
    ['load', `${host.loadavg.map(value => value.toFixed(2)).join(' ')} · ${host.cpus} CPU${host.cpus === 1 ? '' : 's'}`],
    ['memory', `${formatBytes(host.freeMemory)} free of ${formatBytes(host.totalMemory)}`],
  ];
}

/** Align labelled rows: `  label    value`. */
export function formatRows(rows: readonly [string, string][], indent = '  '): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${indent}${label.padEnd(width)}  ${value}`);
}

/** A round trip in its level's color: green, yellow when slow, red when very slow. */
export function styleLatency(ms: number, p: Paint): string {
  const level = latencyLevel(ms);
  return (level === 'ok' ? p.ok : level === 'slow' ? p.warn : p.error)(formatLatency(ms));
}

/** Daemon facts as the panel knows them: still loading, failed, absent (older daemon), or known. */
export type DaemonState = DaemonStatus | 'loading' | { error: string } | undefined;

export interface StatusPanel {
  host: string;
  connected: boolean;
  /** How long and how reliably this client has been connected, for example `connected 1h 2m`. */
  connection?: string;
  /** Recent round trips, oldest first. */
  samples: readonly number[];
  /** Rows between latency and the daemon, for example the attached slot. */
  extra?: [string, string][];
  daemon: DaemonState;
}

/**
 * The status panel: the same rows in the attached UI (Ctrl+S, /status) and in the
 * CLI pickers (Ctrl+S): host and connection, live latency, then daemon and host facts.
 */
export function statusPanelRows(panel: StatusPanel, p: Paint, now = Date.now()): string[] {
  const stats = panel.connected ? latencyStats(panel.samples) : undefined;
  const rows: [string, string][] = [
    ['host', `${plainText(panel.host)} · ${panel.connected ? panel.connection ?? 'connected' : p.error('disconnected, reconnecting')}`],
    ['latency', stats
      ? `${styleLatency(stats.last, p)} ${p.dim(`min ${formatLatency(stats.min)} · avg ${formatLatency(stats.avg)} · max ${formatLatency(stats.max)} · ${stats.count} sample${stats.count === 1 ? '' : 's'}`)}`
      : p.dim(panel.connected ? 'measuring…' : 'unavailable while disconnected')],
    ...(panel.extra ?? []),
  ];
  const daemon = panel.daemon;
  if (daemon === 'loading') rows.push(['daemon', p.dim('loading…')]);
  else if (daemon && 'error' in daemon) rows.push(['daemon', p.error(plainText(daemon.error))]);
  else if (daemon || panel.connected) rows.push(...daemonRows(daemon, now));
  return formatRows(rows);
}

/** Live panel data for one connection: a round trip and fresh daemon facts per call. */
export function statusSampler(connection: Requester, host: string, extra: [string, string][] = [], limit = 20) {
  const pinger = new Pinger(connection);
  const samples: number[] = [];
  let daemon: DaemonState = 'loading';
  return {
    async sample(p: Paint): Promise<string[]> {
      try { samples.push(await pinger.ping()); if (samples.length > limit) samples.shift(); } catch { /* Shown as no new sample. */ }
      try { daemon = await daemonStatus(connection); } catch (error) { daemon = { error: error instanceof Error ? error.message : String(error) }; }
      return statusPanelRows({ host, connected: true, samples, extra, daemon }, p);
    },
  };
}
