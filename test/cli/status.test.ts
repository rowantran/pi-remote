import assert from 'node:assert/strict';
import test from 'node:test';
import { collectStatus, formatReport, lsHeader } from '../../src/cli/status.js';
import {
  Pinger, daemonRows, daemonStatus, formatBytes, formatDuration, formatLatency, formatSlotCounts, latencyLevel, latencyStats, slotCounts,
} from '../../src/tui/host-status.js';
import type { DaemonStatus } from '../../src/protocol/methods.js';
import type { SlotInfo } from '../../src/protocol/types.js';

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const NOW = Date.parse('2026-10-21T12:00:00Z');
const facts: DaemonStatus = {
  pid: 7, release: '/opt/pi-remote/releases/abc1234', startedAt: new Date(NOW - 90_000).toISOString(), piVersion: '1.0.4', nodeVersion: 'v22.19.0',
  host: { hostname: 'devbox', platform: 'linux', arch: 'arm64', uptimeSeconds: 3 * 86_400 + 7_200, loadavg: [1, 0.5, 0.25], cpus: 1, totalMemory: 2 * 1024 ** 3, freeMemory: 512 * 1024 ** 2 },
};
const slot = (status: SlotInfo['status'], clients = 0): SlotInfo => ({ id: status, cwd: '/w', createdAt: '', status, clients });
/** A clock that advances by the given steps, one per reading. */
const clock = (...steps: number[]) => { let time = 0, index = 0; return () => (time += index < steps.length ? steps[index++]! : 0); };

test('latency, duration, and size formatting stays short', () => {
  assert.deepEqual([0.42, 8.24, 38.4, 143].map(formatLatency), ['0.4 ms', '8.2 ms', '38 ms', '143 ms']);
  assert.deepEqual([40, 720, 3 * 3600 + 300, 2 * 86_400, 2 * 86_400 + 3600, NaN, -5].map(formatDuration), ['40s', '12m', '3h 5m', '2d', '2d 1h', '0s', '0s']);
  assert.deepEqual([512, 1536, 20 * 1024 ** 2, 31.3 * 1024 ** 3].map(formatBytes), ['512 B', '1.5 KB', '20 MB', '31 GB']);
  assert.deepEqual([20, 150, 399, 400].map(latencyLevel), ['ok', 'slow', 'slow', 'very-slow']);
  assert.deepEqual(latencyStats([30, 10, 20]), { last: 20, min: 10, avg: 20, max: 30, count: 3 });
  assert.equal(latencyStats([]), undefined);
  assert.equal(formatSlotCounts(slotCounts([slot('running', 1), slot('starting', 1), slot('exited')])), '2 running · 1 stopped · 2 clients attached');
  assert.equal(formatSlotCounts(slotCounts([])), '0 running · 0 stopped');
});

test('pinger times ping, and remembers to use list on daemons without it', async () => {
  const calls: string[] = [];
  const connection = { request: async (method: string) => { calls.push(method); if (method === 'ping') throw new Error('Unknown daemon method: ping'); return []; } } as any;
  const pinger = new Pinger(connection, clock(0, 5, 12, 0, 7));
  assert.equal(await pinger.ping(), 12);
  assert.equal(await pinger.ping(), 7);
  assert.deepEqual(calls, ['ping', 'list', 'list']);
  const failing = new Pinger({ request: async () => { throw new Error('network lost'); } } as any);
  await assert.rejects(failing.ping(), /network lost/);
});

test('daemon status is optional on older daemons but real errors still surface', async () => {
  assert.equal(await daemonStatus({ request: async () => { throw new Error('Unknown daemon method: status'); } } as any), undefined);
  await assert.rejects(daemonStatus({ request: async () => { throw new Error('boom'); } } as any), /boom/);
  assert.deepEqual(daemonRows(facts, NOW), [
    ['daemon', 'pid 7 · up 1m 30s · release abc1234'],
    ['versions', 'Pi 1.0.4 · Node v22.19.0'],
    ['machine', 'devbox · linux arm64 · up 3d 2h'],
    ['load', '1.00 0.50 0.25 · 1 CPU'],
    ['memory', '512 MB free of 2.0 GB'],
  ]);
  assert.match(daemonRows(undefined)[0]![1], /restart-daemon/);
});

test('status connects once, pings sequentially, and closes the connection', async () => {
  const calls: string[] = [];
  let closed = 0;
  const connection = { request: async (method: string) => { calls.push(method); return method === 'status' ? facts : method === 'list' ? [slot('running', 1), slot('exited')] : {}; }, close: () => { closed++; } } as any;
  const report = await collectStatus(async () => connection, 'devbox', 3, clock(0, 250, 0, 30, 0, 40, 0, 50));
  assert.deepEqual(calls, ['ping', 'ping', 'ping', 'status', 'list']);
  assert.equal(closed, 1);
  assert.equal(report.connectMs, 250);
  assert.deepEqual(report.pings, [30, 40, 50]);
  const text = strip(formatReport(report, NOW));
  assert.match(text, /^devbox  ● online$/m);
  assert.match(text, /latency\s+40 ms \(min 30 ms · max 50 ms over 3 round trips\)/);
  assert.match(text, /connect\s+250 ms \(SSH and daemon handshake\)/);
  assert.match(text, /slots\s+1 running · 1 stopped · 1 client attached/);
  assert.match(strip(formatReport({ ...report, local: true })), /\(daemon handshake\)/);
});

test('status reports unreachable hosts without the generic transport message', async () => {
  const report = await collectStatus(async () => { throw new Error('Disconnected. Remote work continues; attach again.\nssh: Could not resolve hostname x'); }, 'x');
  assert.equal(report.online, false);
  const text = strip(formatReport(report));
  assert.match(text, /^x  ✗ unreachable$/m);
  assert.match(text, /error\s+the connection closed before the daemon answered \(SSH output above\)/);
  const failed = await collectStatus(async () => ({ request: async () => { throw new Error('Slot not found'); }, close() {} }) as any, 'devbox');
  assert.equal(failed.online, false);
  assert.match(strip(formatReport(failed)), /error\s+Slot not found/);
});

test('ls header shows host, round trip, and counts', () => {
  assert.equal(strip(lsHeader('devbox', 38.2, [slot('running'), slot('exited')])), 'devbox · 38 ms · 1 running · 1 stopped');
});
