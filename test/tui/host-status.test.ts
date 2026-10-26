import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Pinger, daemonRows, daemonStatus, formatBytes, formatDuration, formatLatency, formatSlotCounts, latencyLevel, latencyStats, slotCounts,
  statusPanelRows, statusSampler,
} from '../../src/tui/host-status.js';
import { listSummary } from '../../src/tui/slot-table.js';
import { paint } from '../../src/tui/table.js';
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

test('the status panel shows host, live latency, extra rows, and daemon facts', () => {
  const rows = statusPanelRows({ host: 'devbox', connected: true, connection: 'connected 2m', samples: [30, 10, 20], extra: [['slot', '#3 · running']], daemon: facts }, paint(false), NOW);
  assert.deepEqual(rows, [
    '  host      devbox · connected 2m',
    '  latency   20 ms min 10 ms · avg 20 ms · max 30 ms · 3 samples',
    '  slot      #3 · running',
    '  daemon    pid 7 · up 1m 30s · release abc1234',
    '  versions  Pi 1.0.4 · Node v22.19.0',
    '  machine   devbox · linux arm64 · up 3d 2h',
    '  load      1.00 0.50 0.25 · 1 CPU',
    '  memory    512 MB free of 2.0 GB',
  ]);
  const p = paint(false);
  assert.match(statusPanelRows({ host: 'h', connected: true, samples: [], daemon: 'loading' }, p).join('\n'), /measuring…[\s\S]*daemon\s+loading…/);
  assert.match(statusPanelRows({ host: 'h', connected: true, samples: [5], daemon: { error: 'boom' } }, p).join('\n'), /daemon\s+boom/);
  assert.match(statusPanelRows({ host: 'h', connected: true, samples: [5], daemon: undefined }, p).join('\n'), /newer daemon/);
  const offline = statusPanelRows({ host: 'h', connected: false, samples: [5], daemon: undefined }, p).join('\n');
  assert.match(offline, /disconnected, reconnecting[\s\S]*unavailable while disconnected/);
  assert.doesNotMatch(offline, /daemon/);
});

test('the status sampler pings and refreshes daemon facts on every call', async () => {
  const calls: string[] = [];
  const connection = { request: async (method: string) => { calls.push(method); return method === 'status' ? facts : {}; } } as any;
  const sampler = statusSampler(connection, 'devbox', [['connect', '412 ms']]);
  await sampler.sample(paint(false));
  const rows = await sampler.sample(paint(false));
  assert.deepEqual(calls, ['ping', 'status', 'ping', 'status']);
  assert.match(rows.join('\n'), /host\s+devbox · connected\n.*2 samples\n  connect\s+412 ms\n  daemon\s+pid 7/);
});

test('the ls and picker summary shows host, colored round trip, and counts', () => {
  assert.equal(listSummary('devbox', [slot('running'), slot('exited')], { latencyMs: 38.2 }), 'devbox · 38 ms · 1 running · 1 stopped');
  assert.equal(listSummary('dev\x1bbox', [], {}), 'dev box · 0 running · 0 stopped');
  assert.match(listSummary('devbox', [], { latencyMs: 450, paint: paint(true) }), /\x1b\[31m450 ms\x1b\[39m/);
});
