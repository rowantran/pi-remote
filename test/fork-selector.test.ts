import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { initTheme, TreeSelectorComponent, type SessionTreeNode } from '@earendil-works/pi-coding-agent';
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { ForkSelector } from '../src/fork-selector.js';
import { createRemoteKeybindings } from '../src/keybindings.js';
import { createPresentationTheme } from '../src/presentation.js';

let previousKeybindings = getKeybindings();
beforeEach(() => { previousKeybindings = getKeybindings(); setKeybindings(createRemoteKeybindings()); initTheme('dark', false); });
afterEach(() => setKeybindings(previousKeybindings));

function message(id: string, parentId: string | null, role: 'user' | 'assistant', text: string): SessionTreeNode {
  return { entry: { type: 'message', id, parentId, timestamp: '2026-01-01',
    message: { role, content: [{ type: 'text', text }], timestamp: 1 } }, children: [] } as SessionTreeNode;
}
function setup(tree: SessionTreeNode[], leafId: string) {
  let height = 40;
  const selections: string[] = [], copies: (string | undefined)[] = [];
  const selector = new ForkSelector(tree, leafId, () => height, createPresentationTheme,
    id => selections.push(id), () => {}, text => copies.push(text));
  return { selector, selections, copies, resize: (rows: number) => { height = rows; },
    screen: () => selector.render(160).map(stripTerminalSequences).join('\n') };
}

test('uses native tree rows, starts at the active user, and allows only user fork points', () => {
  const first = message('u1', null, 'user', 'First prompt'), answer = message('a1', 'u1', 'assistant', 'First answer');
  const active = message('u2', 'a1', 'user', 'Active prompt'), leaf = message('a2', 'u2', 'assistant', 'Active answer');
  const abandoned = message('u3', 'a1', 'user', 'Abandoned prompt');
  first.children = [answer]; answer.children = [active, abandoned]; active.children = [leaf];
  const state = setup([first], 'a2');
  const native = new TreeSelectorComponent([first], 'a2', 40, () => {}, () => {}, undefined, 'u2', 'no-tools');
  const rows = (lines: string[]) => lines.filter(line => /(?:user|assistant): /.test(stripTerminalSequences(line)));
  assert.deepEqual(rows(state.selector.render(160)), rows(native.getTreeList().render(160)));
  state.selector.handleInput('\r'); assert.deepEqual(state.selections, ['u2']);
  state.selector.handleInput('\x1b[B');
  assert.match(state.screen(), /Context only/);
  state.selector.handleInput('\r'); assert.deepEqual(state.selections, ['u2']);
  state.selector.handleInput('\x18'); assert.deepEqual(state.copies, ['Active answer']);
});

test('sanitizes remote display and copy text without changing the source or fork IDs', () => {
  const controls = '\x1b[2J\x1b]0;remote-title\x07\x1b]52;c;ZXZpbA==\x07';
  const id = 'user\x1b]0;opaque-id\x07';
  const user = message(id, null, 'user', `${controls}Safe 世界\nsecond line`);
  user.label = `${controls}bookmark`;
  const answer = message('answer', id, 'assistant', `${controls}Clean answer`);
  user.children = [answer];
  const tree = [user], before = JSON.stringify(tree), state = setup(tree, 'answer');
  for (const line of state.selector.render(160)) assert.doesNotMatch(line.replace(/\x1b\[[\d;]*m/g, ''), /[\x00-\x1f\x7f-\x9f]/);
  assert.match(state.screen(), /\[bookmark\] user: Safe 世界 second line/);
  state.selector.handleInput('\x18'); state.selector.handleInput('\r');
  assert.deepEqual(state.copies, ['Safe 世界\nsecond line']);
  assert.deepEqual(state.selections, [id]);
  assert.equal(JSON.stringify(tree), before);
});

test('keeps the selected row visible within narrow and short viewport budgets', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => message(`n${i}`, i ? `n${i - 1}` : null, 'user', `Prompt ${i} 世界 👩‍💻`));
  for (let i = 1; i < nodes.length; i++) nodes[i - 1]!.children = [nodes[i]!];
  const state = setup([nodes[0]!], 'n29');
  for (const height of [1, 3, 5, 12, 40]) {
    state.resize(height);
    for (const width of [1, 8, 80]) {
      const lines = state.selector.render(width);
      assert.ok(lines.length <= height);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.ok(lines.some(line => stripTerminalSequences(line).startsWith('›')));
    }
  }
  state.selector.handleInput('\r'); assert.deepEqual(state.selections, ['n29']);
});
