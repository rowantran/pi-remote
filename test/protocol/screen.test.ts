import assert from 'node:assert/strict';
import test from 'node:test';
import { ScreenState } from '../../src/protocol/screen.js';
import type { CompanionMessage } from '../../src/protocol/companion.js';

const frame = (sections: Extract<CompanionMessage, { type: 'frame' }>['sections'], reset = false): CompanionMessage => ({
  type: 'frame', width: 80, layout: 'known', reset, sections, editorFocused: true, dropdownRows: 0, hardwareCursor: false,
});

test('a snapshot rebuilds the current screen, editor, history and session from nothing', () => {
  const state = new ScreenState();
  state.apply({ type: 'editorInstalled', editor: 'default', bindings: {} });
  state.apply({ type: 'history', text: 'first prompt' });
  state.apply(frame({ 0: { start: 0, remove: 0, insert: ['a', 'b'] }, 6: { start: 0, remove: 0, insert: ['footer'] } }, true));
  state.apply(frame({ 0: { start: 1, remove: 1, insert: ['B', 'c'] } }));
  state.apply({ type: 'editor', barrier: 'x:1', state: { text: 'draft', cursor: { line: 0, col: 5 } } });
  const copy = new ScreenState();
  for (const message of state.snapshot()) copy.apply(message);
  assert.deepEqual(copy.snapshot(), state.snapshot());
  const rebuilt = state.snapshot().find(message => message.type === 'frame') as Extract<CompanionMessage, { type: 'frame' }>;
  assert.equal(rebuilt.reset, true);
  assert.deepEqual(rebuilt.sections[0]!.insert, ['a', 'B', 'c']);
  assert.deepEqual(state.snapshot().map(message => message.type), ['editorInstalled', 'history', 'frame', 'editor']);
});

test('a new editor clears the history and draft of the previous one', () => {
  const state = new ScreenState();
  state.apply({ type: 'editorInstalled', editor: 'default', bindings: {} });
  state.apply({ type: 'history', text: 'old' });
  state.apply({ type: 'editor', barrier: 'x:1', state: { text: 'draft', cursor: { line: 0, col: 5 } } });
  state.apply({ type: 'editorInstalled', editor: 'extension', bindings: {} });
  assert.deepEqual(state.snapshot().map(message => message.type), ['editorInstalled']);
});
