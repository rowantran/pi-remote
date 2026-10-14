import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketConnection } from '../../src/web/connection.js';

/** Browser WebSocket boundary double; expected records are independent daemon envelopes. */
class BrowserSocket extends EventTarget {
  static OPEN = 1;
  static latest: BrowserSocket;
  readyState = 0;
  bufferedAmount = 0;
  sent: any[] = [];
  closed = false;
  readonly url: string;
  constructor(url: string | URL) {
    super(); this.url = String(url); BrowserSocket.latest = this;
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send(text: string) {
    const record = JSON.parse(text); this.sent.push(record);
    if (record.method === 'hello') queueMicrotask(() => this.record({ type: 'result', id: record.id, success: true, data: { protocol: 1, piVersion: '1.0.4', pid: 2 } }));
  }
  record(record: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(record) })); }
  close() { this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('browser transport handshakes, buffers early events, correlates replies, and never replays an uncertain prompt', async t => {
  const ws = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: BrowserSocket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://devbox.example.test/#slot=1' } });
  t.after(() => {
    if (ws) Object.defineProperty(globalThis, 'WebSocket', ws); else delete (globalThis as any).WebSocket;
    if (location) Object.defineProperty(globalThis, 'location', location); else delete (globalThis as any).location;
  });
  const connection = await WebSocketConnection.connect();
  const socket = BrowserSocket.latest;
  assert.equal(socket.url, 'wss://devbox.example.test/ws');
  assert.deepEqual(socket.sent[0].params, { protocol: 1, piVersion: '1.0.4' });
  const event = { type: 'event', slotId: 'slot-a', seq: 7, event: { type: 'agent_start' } };
  socket.record(event);
  const events: unknown[] = [];
  connection.onEvent(event => events.push(event));
  assert.deepEqual(events, [event]);

  const first = connection.request('rpc', { slotId: 'slot-a', command: { type: 'get_state' } });
  const second = connection.request('list');
  socket.record({ type: 'result', id: socket.sent[2].id, success: true, data: [{ id: 'slot-a', number: 4 }] });
  socket.record({ type: 'result', id: socket.sent[1].id, success: true, data: { isStreaming: false } });
  assert.deepEqual(await first, { isStreaming: false });
  assert.deepEqual(await second, [{ id: 'slot-a', number: 4 }]);

  const prompt = connection.request('rpc', { slotId: 'slot-a', command: { type: 'prompt', message: 'run exactly once' } });
  const rejection = assert.rejects(prompt, /outcome may be unknown.*not replayed/);
  socket.close();
  await rejection;
  await assert.rejects(connection.request('list'), /Connection closed/);
  assert.equal(socket.sent.filter(record => record.params.command?.type === 'prompt').length, 1);
  const errors: Error[] = [];
  connection.onDisconnect(error => errors.push(error));
  await Promise.resolve();
  assert.equal(errors.length, 1, 'late disconnect subscribers receive the terminal failure');
});

test('malformed server data closes only the browser transport and rejects pending work', async t => {
  const oldWs = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: BrowserSocket });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://devbox.example.test' } });
  t.after(() => {
    if (oldWs) Object.defineProperty(globalThis, 'WebSocket', oldWs); else delete (globalThis as any).WebSocket;
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete (globalThis as any).location;
  });
  const connection = await WebSocketConnection.connect();
  const pending = connection.request('list');
  const rejected = assert.rejects(pending, /Invalid daemon record/);
  BrowserSocket.latest.record({ type: 'untrusted' });
  await rejected;
  assert.equal(BrowserSocket.latest.closed, true);
});
