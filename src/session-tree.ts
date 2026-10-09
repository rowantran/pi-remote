import type { SessionTreeNode } from '@earendil-works/pi-coding-agent';
import type { RecordValue } from './protocol.js';

/** Reconstruct Pi's session tree without changing the entries or their order. */
export function sessionTree(entries: readonly RecordValue[]): SessionTreeNode[] {
  const sessionEntries = entries.filter(entry => entry.type !== 'session');
  const labels = new Map<string, { label: string; timestamp: string }>();
  // Labels apply across branches. The last change in file order wins, not the newest timestamp.
  for (const entry of sessionEntries) {
    if (entry.type !== 'label') continue;
    if (entry.label) labels.set(entry.targetId, { label: entry.label, timestamp: entry.timestamp });
    else labels.delete(entry.targetId);
  }

  const nodes = new Map<string, SessionTreeNode>();
  for (const entry of sessionEntries) {
    const resolved = labels.get(entry.id);
    nodes.set(entry.id, {
      entry: entry as SessionTreeNode['entry'], children: [],
      label: resolved?.label, labelTimestamp: resolved?.timestamp,
    });
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of sessionEntries) {
    const node = nodes.get(entry.id)!;
    const parent = nodes.get(entry.parentId);
    if (entry.parentId === null || entry.parentId === entry.id || !parent) roots.push(node);
    else parent.children.push(node);
  }

  // Root order stays in file order. Sort each child list directly, without walking a deep tree.
  // Array.sort is stable, so equal timestamps keep their original order, as in SessionManager.
  for (const node of nodes.values()) {
    node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
  }
  return roots;
}
