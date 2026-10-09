import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager, type FileEntry, type SessionTreeNode } from '@earendil-works/pi-coding-agent';
import type { RecordValue } from '../src/protocol.js';
import { sessionTree } from '../src/session-tree.js';

const timestamp = '2026-01-01T00:00:00.000Z';
function entry(id: string, parentId: string | null, time = timestamp): RecordValue {
  return { type: 'custom', customType: 'test', id, parentId, timestamp: time };
}
function label(id: string, parentId: string | null, targetId: string, value: string | undefined, time = timestamp): RecordValue {
  return { type: 'label', id, parentId, targetId, label: value, timestamp: time };
}
function nativeTree(entries: readonly RecordValue[]): SessionTreeNode[] {
  return SessionManager.inMemory('/remote', undefined, entries.slice() as FileEntry[]).getTree();
}
function nodesById(tree: SessionTreeNode[]): Map<string, SessionTreeNode> {
  const nodes = new Map<string, SessionTreeNode>();
  const pending = [...tree];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.set(node.entry.id, node);
    for (const child of node.children) pending.push(child);
  }
  return nodes;
}

test('matches native empty and header-only sessions and excludes headers from the tree', () => {
  const header = { type: 'session', version: 3, id: 'session', cwd: '/remote', timestamp };
  for (const entries of [[], [header], [header, entry('root', null)]]) {
    assert.deepEqual(sessionTree(entries), nativeTree(entries));
    assert.ok(!nodesById(sessionTree(entries)).has(header.id));
  }
  assert.deepEqual(sessionTree([header]), []);
});

test('matches native branched sessions after label changes, clears, and relabeling', () => {
  const manager = SessionManager.inMemory('/remote');
  const root = manager.appendMessage({ role: 'user', content: 'Root prompt', timestamp: 1 });
  const firstBranch = manager.appendMessage({ role: 'user', content: 'First branch', timestamp: 2 });
  manager.appendLabelChange(firstBranch, 'first branch');
  manager.appendLabelChange(root, 'root bookmark');
  manager.branch(root);
  const secondBranch = manager.appendMessage({ role: 'user', content: 'Second branch', timestamp: 3 });
  manager.appendCustomEntry('extension', { value: 'kept in tree' });

  const compare = () => {
    const entries = [manager.getHeader()!, ...manager.getEntries()];
    const tree = sessionTree(entries);
    assert.deepEqual(tree, manager.getTree());
    assert.equal(nodesById(tree).size, manager.getEntries().length, 'label and custom entries remain in the tree');
    return nodesById(tree);
  };
  let nodes = compare();
  assert.equal(nodes.get(firstBranch)!.label, 'first branch', 'labels on an inactive branch are resolved');
  assert.equal(nodes.get(root)!.label, 'root bookmark');
  manager.appendLabelChange(firstBranch, 'updated from another branch');
  nodes = compare();
  assert.equal(nodes.get(firstBranch)!.label, 'updated from another branch');
  assert.equal(nodes.get(firstBranch)!.labelTimestamp, manager.getEntries().at(-1)!.timestamp);

  for (const clear of ['', undefined]) {
    manager.appendLabelChange(root, 'temporary');
    compare();
    manager.appendLabelChange(root, clear);
    nodes = compare();
    assert.equal(nodes.get(root)!.label, undefined);
    assert.equal(nodes.get(root)!.labelTimestamp, undefined);
  }
  manager.appendLabelChange(root, 'restored');
  manager.appendLabelChange(secondBranch, 'second branch');
  nodes = compare();
  assert.equal(nodes.get(root)!.label, 'restored');
  assert.equal(nodes.get(secondBranch)!.label, 'second branch');
});

test('keeps native root order, resolves forward parents, and stably sorts every child list by timestamp', () => {
  const entries = [
    entry('later-root', null, '2026-01-03T00:00:00Z'),
    entry('z-equal', 'later-root', '2026-01-01T01:00:00Z'),
    entry('newest', 'later-root', '2026-01-01T00:00:00-02:00'),
    entry('a-equal', 'later-root', '2026-01-01T02:00:00+01:00'),
    entry('oldest', 'later-root'),
    entry('nested-newest', 'z-equal', '2026-01-02T00:00:00Z'),
    entry('nested-oldest', 'z-equal'),
    entry('forward-child', 'earlier-root'),
    entry('earlier-root', null, '2025-01-01T00:00:00Z'),
  ];
  const tree = sessionTree(entries);
  assert.deepEqual(tree, nativeTree(entries));
  assert.deepEqual(tree.map(node => node.entry.id), ['later-root', 'earlier-root']);
  assert.deepEqual(tree[0].children.map(node => node.entry.id), ['oldest', 'z-equal', 'a-equal', 'newest']);
  assert.deepEqual(tree[0].children[1].children.map(node => node.entry.id), ['nested-oldest', 'nested-newest']);
  assert.equal(tree[1].children[0].entry.id, 'forward-child');
});

test('matches native orphan and self-parent roots, including their labels and descendants', () => {
  const entries = [
    entry('orphan-child', 'orphan'), entry('orphan', 'missing-parent'),
    entry('self', 'self'), entry('self-child', 'self'), entry('root', null),
    label('orphan-label', 'root', 'orphan', 'orphan bookmark'),
    label('self-label', 'self-child', 'self', 'self bookmark'),
  ];
  const tree = sessionTree(entries);
  assert.deepEqual(tree, nativeTree(entries));
  assert.deepEqual(tree.map(node => node.entry.id), ['orphan', 'self', 'root']);
  assert.equal(tree[0].children[0].entry.id, 'orphan-child');
  assert.equal(tree[0].label, 'orphan bookmark');
  assert.equal(tree[1].children[0].entry.id, 'self-child');
  assert.equal(tree[1].label, 'self bookmark');
});

test('resolves labels in file order without sanitizing opaque IDs, label text, or timestamps', () => {
  const opaqueId = '用户\x1b]0;opaque-id\x07';
  const opaqueLabel = '  bookmark 世界\x1b[2J\n  ';
  const earlier = '2025-01-01T00:00:00Z';
  const entries = [
    label('forward-label', null, opaqueId, 'first label'),
    entry('__proto__', null), entry('constructor', '__proto__'), entry(opaqueId, 'constructor'),
    label('replacement', '__proto__', opaqueId, opaqueLabel, earlier),
    label('label-on-label', opaqueId, 'replacement', 'label entry bookmark'),
    label('clear-me', opaqueId, 'constructor', 'removed'),
    label('clear', opaqueId, 'constructor', ''),
    label('missing-target', null, 'not-an-entry', 'missing'),
  ];
  const tree = sessionTree(entries);
  assert.deepEqual(tree, nativeTree(entries));
  const nodes = nodesById(tree);
  assert.equal(nodes.get(opaqueId)!.entry.parentId, 'constructor');
  assert.equal(nodes.get(opaqueId)!.label, opaqueLabel);
  assert.equal(nodes.get(opaqueId)!.labelTimestamp, earlier, 'the last label wins even with an older timestamp');
  assert.equal(nodes.get('replacement')!.label, 'label entry bookmark');
  assert.equal(nodes.get('constructor')!.label, undefined);
  assert.equal(nodes.get('constructor')!.labelTimestamp, undefined);
  assert.ok(!nodes.has('not-an-entry'), 'labels do not create target entries');
});

test('does not mutate frozen entries and returns independent tree structure with native entry references', () => {
  const entries = [entry('root', null), entry('later', 'root', '2026-01-02T00:00:00Z'), entry('earlier', 'root'),
    label('bookmark', 'earlier', 'root', 'root label')];
  entries[0].data = Object.freeze({ nested: Object.freeze(['unchanged']) });
  const before = structuredClone(entries);
  for (const value of entries) Object.freeze(value);
  Object.freeze(entries);
  const tree = sessionTree(entries);
  assert.deepEqual(tree, nativeTree(entries));
  assert.deepEqual(entries, before);
  const secondTree = sessionTree(entries);
  assert.notEqual(tree, secondTree);
  assert.notEqual(tree[0], secondTree[0]);
  assert.notEqual(tree[0].children, secondTree[0].children);
  assert.equal(tree[0].entry, entries[0], 'native getTree retains entry references');
  tree[0].children.length = 0;
  tree[0].label = 'local change';
  assert.equal(secondTree[0].children.length, 2);
  assert.equal(secondTree[0].label, 'root label');
  assert.deepEqual(entries, before);
});

test('constructs a deep chain iteratively and matches native nodes without recursive assertions', () => {
  const depth = 30_000;
  const entries = Array.from({ length: depth }, (_, index) => entry(`node-${index}`, index ? `node-${index - 1}` : null));
  entries.push(label('deep-label', `node-${depth - 1}`, `node-${depth - 1}`, 'deep bookmark'));
  const tree = sessionTree(entries);
  const native = nativeTree(entries);
  assert.equal(tree.length, 1);
  assert.equal(native.length, 1);
  let node = tree[0], expected = native[0], count = 0;
  while (node) {
    assert.equal(node.entry, expected.entry);
    assert.equal(node.label, expected.label);
    assert.equal(node.labelTimestamp, expected.labelTimestamp);
    assert.equal(node.children.length, expected.children.length);
    count++;
    node = node.children[0];
    expected = expected.children[0];
  }
  assert.equal(count, depth + 1);
});
