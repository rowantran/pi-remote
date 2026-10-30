import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { TUI_KEYBINDINGS, type Terminal } from '@earendil-works/pi-tui';
import { PiScreen, STATUS_KEY } from '../../src/tui/pi-screen.js';
import { answerQueries } from '../../src/daemon/pi-terminal.js';
import { decodeBarrier, type PiExtensionMessage, type EditorState } from '../../src/protocol/pi-extension.js';

class FakeTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = true;
  writes: string[] = [];
  start() {} stop() {} async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {} setProgramStatus() {}
}

const bindings = Object.fromEntries(Object.entries(TUI_KEYBINDINGS).map(([id, definition]) => [id, definition.defaultKeys])) as Record<string, string | string[]>;
const state = (text: string, col = text.length): EditorState => ({ text, cursor: { line: 0, col } });

/** A client with Pi's default editor focused, recording what it sends to Pi. */
function setup(options: ConstructorParameters<typeof PiScreen>[2] = {}) {
  const sent: string[] = [], writes: string[] = [];
  const client = new PiScreen(new FakeTerminal(), {
    send: data => { writes.push(data); sent.push(...data.split(/(?<=\x1b\\)/)); }, resize() {},
  }, options);
  const receive = (message: PiExtensionMessage) => client.receive(message);
  receive({ type: 'editorInstalled', editor: 'default', bindings: { ...bindings, 'app.model.select': 'ctrl+l' } });
  receive({ type: 'frame', width: 80, layout: 'known', reset: true, editorFocused: true, dropdownRows: 0, hardwareCursor: false, sections: {
    0: { start: 0, remove: 0, insert: ['transcript'] },
    4: { start: 0, remove: 0, insert: ['── pi border ──', '', '──'] },
    6: { start: 0, remove: 0, insert: ['footer'] },
  } });
  /** Keys Pi received, without barriers, and the barrier sent after each one. */
  const keys = () => sent.map(data => {
    const index = data.indexOf('\x1b_');
    return index === -1 ? { key: data } : { key: data.slice(0, index), barrier: Number(decodeBarrier(data.slice(index))!.split(':')[1]) };
  });
  /** This client's barrier for key number `n`. */
  const barrier = (n: number) => `${decodeBarrier(sent.find(data => data.includes('\x1b_'))!.slice(sent.find(data => data.includes('\x1b_'))!.indexOf('\x1b_')))!.split(':')[0]}:${n}`;
  return { client, receive, sent, writes, keys, barrier, text: () => client.editor!.getText() };
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('editor keys show locally at once and go to Pi with a barrier, in one write per burst', async () => {
  const { client, keys, text, writes } = setup();
  assert.equal(client.editorLocal, true);
  for (const key of 'hi') client.input(key);
  assert.equal(text(), 'hi');
  await flush();
  assert.deepEqual(keys(), [{ key: 'h', barrier: 1 }, { key: 'i', barrier: 2 }]);
  assert.equal(writes.length, 1, 'keys from one burst share one write');
  assert.equal(client.unconfirmedKeys, 2);
});

test('a matching report confirms keys without changing the local editor', async () => {
  const { client, receive, text, barrier } = setup();
  for (const key of 'abc') client.input(key);
  await flush(); receive({ type: 'editor', barrier: barrier(2), state: state('ab') });
  assert.equal(text(), 'abc');
  assert.equal(client.unconfirmedKeys, 1);
});

test('a different report takes Pi state and replays newer keys', async () => {
  const { client, receive, text, barrier } = setup();
  for (const key of 'ab') client.input(key);
  client.input('\r'); // Enter: the local editor clears, like Pi's.
  assert.equal(text(), '');
  for (const key of 'cd') client.input(key);
  // Pi did something the local editor could not know: it restored the text after Enter.
  await flush(); receive({ type: 'editor', barrier: barrier(3), state: state('restored') });
  assert.equal(text(), 'restoredcd');
  assert.equal(client.unconfirmedKeys, 2);
});

test('a report after another client\'s keys replaces local state and replays this client\'s keys', async () => {
  const { client, receive, text } = setup();
  client.input('m');
  await flush();
  receive({ type: 'editor', barrier: 'other:7', state: state('theirs') });
  assert.equal(text(), 'theirsm');
  assert.equal(client.unconfirmedKeys, 1);
});

test('a change Pi makes on its own replaces the confirmed local state', async () => {
  const { client, receive, text, barrier } = setup();
  client.input('x');
  await flush(); receive({ type: 'editor', barrier: barrier(1), state: state('x') });
  await flush(); receive({ type: 'editor', barrier: barrier(1), state: state('from an extension') });
  assert.equal(text(), 'from an extension');
});

test('app shortcuts go to Pi without changing local text', async () => {
  const { client, keys, text } = setup();
  client.input('a');
  client.input('\x0c'); // Ctrl+L: Pi opens its model picker.
  assert.equal(text(), 'a');
  await flush();
  assert.equal(keys()[1]!.key, '\x0c');
});

test('while Pi shows its dropdown, dropdown keys wait for Pi and its rows are shown', async () => {
  const { client, receive, keys, text, barrier } = setup();
  client.input('/');
  receive({ type: 'frame', width: 80, layout: 'known', reset: false, editorFocused: true, dropdownRows: 2, hardwareCursor: false, sections: {
    4: { start: 0, remove: 3, insert: ['── pi border ──', '/', '──', '→ model', '  scoped-models'] },
  } });
  client.input('\t');
  assert.equal(text(), '/', 'Tab is not applied locally');
  await flush();
  assert.equal(keys().at(-1)!.key, '\t');
  await flush(); receive({ type: 'editor', barrier: barrier(2), state: state('/model ') });
  assert.equal(text(), '/model ');
  const lines = client.tui.render(80).join('\n');
  assert.match(lines, /→ model/);
  assert.match(lines, /── pi border ──/, "Pi's top border replaces the local one");
});

test('pickers get raw keys and Pi rendering', async () => {
  const { client, receive, sent } = setup();
  receive({ type: 'frame', width: 80, layout: 'known', reset: false, editorFocused: false, dropdownRows: 0, hardwareCursor: false, sections: {
    4: { start: 0, remove: 3, insert: ['Select model', '→ model-a'] },
  } });
  assert.equal(client.editorLocal, false);
  client.input('\x1b[B');
  await flush();
  assert.deepEqual(sent, ['\x1b[B'], 'no barrier, no local editing');
  assert.match(client.tui.render(80).join('\n'), /→ model-a/);
});

test('an unknown layout shows all of Pi output and forwards every key', async () => {
  const { client, receive, sent } = setup();
  receive({ type: 'frame', width: 80, layout: 'unknown', reset: true, editorFocused: false, dropdownRows: 0, hardwareCursor: false, sections: {
    0: { start: 0, remove: 0, insert: ['whole screen'] },
  } });
  client.input('q');
  await flush();
  assert.deepEqual(sent, ['q']);
  assert.match(client.tui.render(80).join('\n'), /whole screen/);
});

test('an extension editor without a local copy waits for Pi; with a copy it is local', () => {
  const without = setup();
  without.receive({ type: 'editorInstalled', editor: 'extension', bindings });
  assert.equal(without.client.editorLocal, false);
  const created: string[] = [];
  const withCopy = setup({ editorFactory: (tui, theme, keybindings) => { created.push('caret'); return new CustomEditor(tui, theme, keybindings as never); } });
  withCopy.receive({ type: 'editorInstalled', editor: 'extension', bindings });
  assert.deepEqual(created, ['caret']);
  assert.equal(withCopy.client.editorLocal, true);
});

test('lines wider than the local window are cut until Pi renders at the new width', () => {
  const { client, receive } = setup();
  receive({ type: 'frame', width: 120, layout: 'known', reset: false, editorFocused: true, dropdownRows: 0, hardwareCursor: false, sections: {
    0: { start: 0, remove: 1, insert: ['x'.repeat(120)] },
  } });
  const wide = client.tui.render(80).map(line => line.replace(/\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g, '')).filter(line => line.length > 80);
  assert.deepEqual(wide, []);
});

test('Ctrl+/ opens and closes the status panel without reaching Pi', async () => {
  let samples = 0;
  const { client, sent } = setup({ status: { lines: () => ['STATUS LINE'], sample: async () => { samples++; } } });
  assert.equal(STATUS_KEY, 'ctrl+/');
  client.input('\x1b[47;5u');
  assert.equal(client.tui.hasOverlay(), true);
  assert.equal(samples, 1);
  client.toggleStatus();
  assert.equal(client.tui.hasOverlay(), false);
  await flush();
  assert.deepEqual(sent, []);
});

test('terminal queries from Pi are answered with the client terminal values', () => {
  const answers = { kittyFlags: 7, background: { r: 0, g: 0, b: 0 }, cell: { width: 9, height: 18 } };
  assert.equal(answerQueries('\x1b[>7u\x1b[?u\x1b[c', answers), '\x1b[?7u\x1b[?62;22c');
  assert.equal(answerQueries('\x1b]11;?\x07\x1b[16t', answers), '\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[6;18;9t');
  assert.equal(answerQueries('\x1b[?u', {}), '', 'no kitty answer when the client terminal does not use it');
  assert.equal(answerQueries('xx\x1b[c', answers, 5), '', 'queries already answered in the previous read');
  assert.equal(answerQueries('xx\x1b[c', answers, 3), '\x1b[?62;22c', 'a query that ends in the new data');
});
