import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TUI } from '@earendil-works/pi-tui';
import { PresentationHost, type PresentationUIContext } from '../src/presentation.js';
import type { Snapshot } from '../src/protocol.js';

async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'widget-failure-'));
  const key = Symbol.for('pi-remote.test.widget-failure-ui');
  t.after(async () => { delete (globalThis as any)[key]; await rm(dir, { recursive: true }); });
  const fixture = join(dir, 'capture.ts');
  await writeFile(fixture, `export default function(pi) {
    pi.on('session_start', (_, ctx) => { globalThis[Symbol.for('pi-remote.test.widget-failure-ui')] = ctx.ui; });
  }`);
  const snapshot: Snapshot = {
    slot: { id: 'slot', cwd: '/remote', status: 'running', createdAt: '', clients: 1 },
    state: {}, entries: [], leafId: null, seq: 0,
    live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
    ui: ['a', 'b'].map(widgetKey => ({ method: 'setWidget', widgetKey, widgetLines: [`remote ${widgetKey}`] })),
  };
  const notices: string[] = [];
  const host = new PresentationHost({ snapshot: () => snapshot,
    tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } } as TUI,
    notify: text => notices.push(text), invalidate() {} });
  t.after(() => host.shutdown());
  await host.load([fixture]); await host.start();
  return { host, notices, ui: (globalThis as any)[key] as PresentationUIContext };
}

test('failed shared widgets release every key and cannot hide remote text when reused', async t => {
  const { host, ui, notices } = await setup(t);
  let disposed = 0;
  const shared = { invalidate() {}, render(): string[] { throw new Error('shared render failed'); }, dispose() { disposed++; } };
  ui.setWidget('a', () => shared); ui.setWidget('b', () => shared);
  const guarded = host.widgets.get('b')!.component;
  assert.deepEqual(guarded.render(80), []);
  assert.equal(host.widgets.has('a'), false); assert.equal(host.widgets.has('b'), false);
  assert.equal(disposed, 1, 'Dispose the failed shared component once, not once per key');
  assert.deepEqual(ui.getRemoteWidget('a')!.lines, ['remote a']);
  assert.deepEqual(ui.getRemoteWidget('b')!.lines, ['remote b']);
  ui.setWidget('a', () => shared);
  assert.equal(host.widgets.has('a'), false, 'Do not register a cached failed proxy again');
  ui.setWidget('b', () => guarded);
  assert.equal(host.widgets.has('b'), false, 'Do not register a failed proxy returned directly either');
  assert.equal(notices.filter(message => message.includes('shared render failed')).length, 1);
});

test('failure of a component first wrapped as a footer also releases its widget key', async t => {
  const { host, ui } = await setup(t);
  const shared = { invalidate() {}, render(): string[] { throw new Error('footer and widget failed'); } };
  ui.setFooter(() => shared); ui.setWidget('a', () => shared);
  assert.deepEqual(host.widgets.get('a')!.component.render(80), []);
  assert.equal(host.widgets.has('a'), false);
  ui.setWidget('a', () => shared);
  assert.equal(host.widgets.has('a'), false);
});

for (const action of ['clear', 'replace', 'shutdown'] as const) {
  test(`throwing widget disposal runs once during ${action}`, async t => {
    const { host, ui, notices } = await setup(t);
    let disposed = 0;
    const component = { invalidate() {}, render() { return ['local']; }, dispose() { disposed++; throw new Error('dispose failed'); } };
    ui.setWidget('a', () => component);
    if (action === 'shutdown') await host.shutdown();
    else ui.setWidget('a', action === 'replace' ? ['replacement'] : undefined);
    assert.equal(disposed, 1);
    assert.equal(notices.filter(message => message.includes('dispose failed')).length, 1);
    if (action === 'replace') assert.equal(host.widgets.get('a')!.component.render(80)[0].trimEnd(), 'replacement');
    else assert.equal(host.widgets.has('a'), false);
  });
}
