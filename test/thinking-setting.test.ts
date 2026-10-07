import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { readPiDoubleEscapeAction, readPiHideThinkingBlock } from '../src/local-theme.js';
import type { RemoteConnection, Snapshot } from '../src/protocol.js';
import { RemoteTui } from '../src/tui.js';

class FakeTerminal implements Terminal {
  columns = 100; rows = 30; kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const connection: RemoteConnection = {
  request: async () => ({}) as any, onEvent: () => () => {}, onDisconnect: () => () => {}, close() {},
};
const snapshot = (): Snapshot => ({
  slot: { id: 'slot', cwd: '/remote', createdAt: '', status: 'running', clients: 1 },
  state: {}, leafId: 'a', ui: [], seq: 0,
  entries: [{ type: 'message', id: 'a', parentId: null, message: { role: 'assistant', timestamp: 1, stopReason: 'stop', content: [
    { type: 'thinking', thinking: 'reasoning sentinel' }, { type: 'text', text: 'answer sentinel' },
  ] } }],
  live: { busy: false, compacting: false, messages: [], tools: {}, steering: [], followUp: [] },
});

test('reads only the global hideThinkingBlock setting; missing or invalid means visible', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-thinking-'));
  t.after(() => rm(dir, { recursive: true }));
  const settings = join(dir, 'settings.json');
  assert.equal(await readPiHideThinkingBlock(dir), false);
  await writeFile(settings, JSON.stringify({ hideThinkingBlock: true, theme: 'dark' }));
  assert.equal(await readPiHideThinkingBlock(dir), true);
  await writeFile(settings, JSON.stringify({ hideThinkingBlock: false }));
  assert.equal(await readPiHideThinkingBlock(dir), false);
  await writeFile(settings, '{ invalid');
  assert.equal(await readPiHideThinkingBlock(dir), false);
});

test('reads doubleEscapeAction from the local agent directory without changing settings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-escape-'));
  const original = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(dir, { recursive: true });
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  const settings = join(dir, 'settings.json');
  assert.equal(await readPiDoubleEscapeAction(), 'tree');
  for (const action of ['tree', 'fork', 'none', true, 'invalid', undefined]) {
    const source = JSON.stringify({ doubleEscapeAction: action });
    await writeFile(settings, source);
    assert.equal(await readPiDoubleEscapeAction(), action === 'fork' || action === 'none' ? action : 'tree');
    assert.equal(await readFile(settings, 'utf8'), source);
  }
  await writeFile(settings, '{ invalid');
  assert.equal(await readPiDoubleEscapeAction(), 'tree');
});

test('hideThinkingBlock applies to the first frame and Ctrl+T toggles the view', async t => {
  for (const hideThinkingBlock of [undefined, false, true]) {
    const terminal = new FakeTerminal();
    const ui = new RemoteTui(connection, 'slot', snapshot(), terminal, { hideThinkingBlock });
    const finished = ui.run();
    t.after(async () => { ui.detach(); await finished; });
    const screen = () => { ui.tui.renderNow(); return stripTerminalSequences(ui.tui.getScreenLines().join('\n')); };
    assert.match(screen(), /answer sentinel/);
    assert.equal(/reasoning sentinel/.test(screen()), !hideThinkingBlock);
    terminal.input('\x14');
    assert.equal(/reasoning sentinel/.test(screen()), !!hideThinkingBlock);
  }
});
