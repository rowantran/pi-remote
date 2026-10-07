import assert from 'node:assert/strict';
import test from 'node:test';
import type { Component, Terminal } from '@earendil-works/pi-tui';
import { ScheduledTuiAltScreen, type RenderClock } from '../src/scheduled-tui.js';
import { RemoteTui } from '../src/tui.js';
import type { RemoteConnection, Snapshot } from '../src/protocol.js';

class FakeClock implements RenderClock {
  time = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  cancelled: (() => void)[] = [];
  now() { return this.time; }
  schedule(callback: () => void, delayMs: number) {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(id); this.cancelled.push(callback); };
  }
  get pending() { return this.timers.size; }
  fireNextEarly(byMs: number) {
    const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next);
    this.timers.delete(next[0]);
    this.time = next[1].at - byMs;
    next[1].callback();
  }
  advance(ms: number) {
    const end = this.time + ms;
    let iterations = 0;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      assert.ok(++iterations < 100, 'timer loop did not settle');
      this.timers.delete(next[0]);
      this.time = Math.max(this.time, next[1].at);
      next[1].callback();
    }
    this.time = Math.max(this.time, end);
  }
}

class FakeTerminal implements Terminal {
  columns = 80; rows = 12; kittyProtocolActive = false;
  output = '';
  frameStarts: number[] = [];
  input: (data: string) => void = () => {};
  constructor(private now: () => number) {}
  start(input: (data: string) => void, _resize: () => void) { this.input = input; }
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.output += data;
    if (data.startsWith('\x1b[?2026h')) this.frameStarts.push(this.now());
  }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {}
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function launch(t: any, interval = 8) {
  const clock = new FakeClock();
  const terminal = new FakeTerminal(() => clock.now());
  const tui = new ScheduledTuiAltScreen(terminal, true, undefined, { renderIntervalMs: interval }, clock);
  const starts: number[] = [];
  let onRender = () => {};
  const component: Component = {
    render() { starts.push(clock.now()); onRender(); return ['content']; },
    invalidate() {}, handleInput() {},
  };
  tui.addChild(component);
  tui.setFocus(component);
  tui.start();
  t.after(() => tui.stop({ preserveScreen: true }));
  return { clock, terminal, tui, starts, setOnRender: (callback: () => void) => { onRender = callback; } };
}

test('normal requests coalesce and run at 8 ms frame-start intervals', t => {
  const { tui, clock, starts } = launch(t);
  tui.requestRender(); tui.requestRender();
  assert.equal(clock.pending, 1);
  clock.advance(0);
  assert.deepEqual(starts, [0]);
  clock.advance(1);
  tui.requestRender(); tui.requestRender();
  clock.advance(6);
  assert.deepEqual(starts, [0]);
  clock.advance(1);
  assert.deepEqual(starts, [0, 8]);
  assert.equal(clock.pending, 0);
  clock.advance(8);
  tui.requestRender();
  clock.advance(0);
  assert.deepEqual(starts, [0, 8, 16]);
});

test('fractional timer delays never shorten the minimum frame-start interval', t => {
  const { tui, clock, starts } = launch(t);
  clock.advance(0);
  clock.advance(1.5);
  tui.requestRender();
  clock.advance(6.5);
  assert.deepEqual(starts, [0]);
  clock.advance(0.5);
  assert.deepEqual(starts, [0, 8.5]);
});

test('an early timer callback rechecks the frame-start deadline', t => {
  const { tui, clock, starts } = launch(t);
  clock.advance(0);
  tui.requestRender();
  clock.fireNextEarly(0.25);
  assert.deepEqual(starts, [0]);
  assert.equal(clock.pending, 1);
  clock.advance(0.25);
  assert.deepEqual(starts, [0]);
  clock.advance(0.75);
  assert.deepEqual(starts, [0, 8.75]);
});

test('a delayed callback uses its actual start, not the earlier timer deadline', t => {
  const { tui, clock, starts } = launch(t);
  clock.advance(0);
  tui.requestRender();
  clock.time = 20; // Simulate other work blocking the event loop past the 8 ms deadline.
  clock.advance(0);
  assert.deepEqual(starts, [0, 20]);
  tui.requestRender();
  clock.advance(7);
  assert.deepEqual(starts, [0, 20]);
  clock.advance(1);
  assert.deepEqual(starts, [0, 20, 28]);
});

test('frame CPU time counts toward the interval instead of adding another 8 ms', t => {
  const { tui, clock, starts, setOnRender } = launch(t);
  setOnRender(() => { clock.time += 3; });
  clock.advance(0);
  assert.equal(clock.now(), 3);
  tui.requestRender();
  clock.advance(4);
  assert.deepEqual(starts, [0]);
  clock.advance(1);
  assert.deepEqual(starts, [0, 8]);
});

test('a reentrant request survives a render longer than the interval', t => {
  const { tui, clock, starts, setOnRender } = launch(t);
  setOnRender(() => {
    if (starts.length !== 1) return;
    clock.time += 2;
    tui.requestRender(); tui.requestRender();
    clock.time += 10;
  });
  clock.advance(0);
  assert.deepEqual(starts, [0]);
  assert.equal(clock.pending, 1);
  clock.advance(0);
  assert.deepEqual(starts, [0, 12]);
  assert.equal(clock.pending, 0);
});

test('a reentrant request in a fast frame waits only until its next frame-start deadline', t => {
  const { tui, clock, starts, setOnRender } = launch(t);
  setOnRender(() => { if (starts.length === 1) tui.requestRender(); });
  clock.advance(0);
  clock.advance(7);
  assert.deepEqual(starts, [0]);
  clock.advance(1);
  assert.deepEqual(starts, [0, 8]);
});

test('forced requests retain reset semantics, coalesce immediately, and cancel normal timers', async t => {
  const { tui, clock, starts } = launch(t);
  clock.advance(0);
  assert.equal(tui.fullRedraws, 1);
  clock.advance(1);
  tui.requestRender();
  tui.requestRender(true); tui.requestRender(true);
  await flush();
  assert.deepEqual(starts, [0, 1]);
  assert.equal(tui.fullRedraws, 2, 'identical content still gets a forced full redraw');
  clock.advance(20);
  assert.deepEqual(starts, [0, 1]);
});

test('normal requests made after a force request do not add a second frame', async t => {
  const { tui, clock, starts } = launch(t);
  clock.advance(0);
  clock.advance(1);
  tui.requestRender(true);
  tui.requestRender();
  await flush();
  assert.equal(clock.pending, 0);
  clock.advance(20);
  assert.deepEqual(starts, [0, 1]);
});

test('focused input stays immediate and updates the next normal frame deadline', async t => {
  const { tui, clock, terminal, starts } = launch(t);
  clock.advance(0);
  clock.advance(2);
  tui.requestRender();
  terminal.input('x'); terminal.input('y');
  await flush();
  assert.deepEqual(starts, [0, 2]);
  assert.equal(clock.pending, 0);
  tui.requestRender();
  clock.advance(6);
  assert.deepEqual(starts, [0, 2]);
  clock.advance(2);
  assert.deepEqual(starts, [0, 2, 10]);
});

test('renderNow cancels normal and queued native immediate frames and preserves force', async t => {
  const { tui, clock, starts } = launch(t);
  clock.advance(0);
  clock.advance(2);
  tui.requestRender();
  tui.renderNow();
  assert.equal(clock.pending, 0);
  assert.deepEqual(starts, [0, 2]);
  clock.advance(2);
  tui.requestRender(true);
  tui.renderNow(false); // The earlier forced request already reset Pi's render state.
  await flush();
  clock.advance(20);
  assert.deepEqual(starts, [0, 2, 4]);
  assert.equal(tui.fullRedraws, 2, 'renderNow(false) must not discard a pending force');
  tui.renderNow(true);
  assert.equal(tui.fullRedraws, 3, 'explicit renderNow(true) still forces a full redraw');
});

test('stop cancels normal and native immediate requests with no late writes', async t => {
  const { tui, clock, terminal, starts } = launch(t);
  clock.advance(0);
  clock.advance(1);
  tui.requestRender();
  terminal.input('x');
  tui.stop({ preserveScreen: true });
  const output = terminal.output;
  tui.requestRender(); tui.requestRender(true); tui.renderNow();
  clock.advance(100);
  for (const callback of clock.cancelled) callback();
  await flush();
  assert.equal(terminal.output, output);
  assert.deepEqual(starts, [0]);
});

test('stop/restart cannot revive an old immediate callback or cancelled local timer', async t => {
  const { tui, clock, terminal, starts } = launch(t);
  clock.advance(0);
  clock.advance(1);
  tui.requestRender();
  terminal.input('x');
  tui.requestRender(true);
  tui.stop({ preserveScreen: true });
  tui.start();
  for (const callback of clock.cancelled) callback();
  await flush();
  assert.deepEqual(starts, [0]);
  clock.advance(0);
  assert.deepEqual(starts, [0, 1], 'restart gets a fresh initial frame without the old interval');
  clock.advance(100);
  assert.deepEqual(starts, [0, 1]);
});

test('configured intervals are honored and invalid intervals are rejected', t => {
  const { tui, clock, starts } = launch(t, 12);
  clock.advance(0);
  tui.requestRender();
  clock.advance(11);
  assert.deepEqual(starts, [0]);
  clock.advance(1);
  assert.deepEqual(starts, [0, 12]);
  for (const renderIntervalMs of [-1, Infinity, NaN]) {
    assert.throws(() => new ScheduledTuiAltScreen(new FakeTerminal(() => 0), false, undefined, { renderIntervalMs }), RangeError);
  }
});

function snapshot(): Snapshot {
  return {
    slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
    state: {}, entries: [], leafId: null, ui: [], seq: 0,
    live: {
      busy: false, compacting: false, tools: {}, steering: [], followUp: [],
      messages: [{ role: 'user', timestamp: 1, content: Array.from({ length: 100 }, (_, i) => `transcript line ${i}`).join('\n') }],
    },
  };
}

for (const interval of [8, 16]) {
  test(`RemoteTui wheel and PageUp route through the ${interval} ms scheduler without an upstream 16 ms timer`, async t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tick = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
    const terminal = new FakeTerminal(() => now);
    const connection: RemoteConnection = {
      async request<T>() { return {} as T; }, onEvent: () => () => {}, onDisconnect: () => () => {}, close() {},
    };
    // Omit the default option in the 8 ms case to verify constructor wiring.
    const ui = new RemoteTui(connection, 'slot', snapshot(), terminal, interval === 8 ? {} : { renderIntervalMs: interval });
    const finished = ui.run();
    t.after(() => ui.detach());
    tick(0);
    assert.deepEqual(terminal.frameStarts, [0]);
    const initialTop = ui.tui.viewportTop;
    tick(1);
    terminal.input('\x1b[<64;5;3M'); // SGR wheel up inside the transcript.
    terminal.input('\x1b[5~'); // PageUp is consumed by the viewport, not the editor.
    await flush();
    assert.ok(ui.tui.viewportTop < initialTop);
    assert.deepEqual(terminal.frameStarts, [0]);
    tick(interval - 2);
    assert.deepEqual(terminal.frameStarts, [0]);
    tick(1);
    assert.deepEqual(terminal.frameStarts, [0, interval]);
    terminal.input('\x1b[5~');
    tick(interval - 1);
    assert.deepEqual(terminal.frameStarts, [0, interval]);
    tick(1);
    assert.deepEqual(terminal.frameStarts, [0, interval, interval * 2]);
    ui.detach();
    const output = terminal.output;
    tick(100);
    await finished;
    assert.equal(terminal.output, output);
  });
}
