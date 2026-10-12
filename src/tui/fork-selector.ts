import { TreeSelectorComponent, type SessionTreeNode, type Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import { safeText } from './view.js';

/** Strip remote terminal controls without changing the ids used for RPC requests. */
function displayValue<T>(value: T): T {
  if (typeof value === 'string') return safeText(value) as T;
  if (Array.isArray(value)) return value.map(displayValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [safeText(key), displayValue(item)]),
  ) as T;
  return value;
}

function displayTree(tree: SessionTreeNode[]): SessionTreeNode[] {
  const roots: SessionTreeNode[] = [];
  const pending = [...tree].reverse().map(node => ({ node, children: roots }));
  // Iterative traversal: a long conversation is a deeply nested tree.
  while (pending.length) {
    const { node, children } = pending.pop()!;
    const copy: SessionTreeNode = {
      ...node, entry: { ...displayValue(node.entry), id: node.entry.id, parentId: node.entry.parentId },
      label: node.label === undefined ? undefined : safeText(node.label),
      labelTimestamp: node.labelTimestamp === undefined ? undefined : safeText(node.labelTimestamp), children: [],
    };
    children.push(copy);
    for (let index = node.children.length - 1; index >= 0; index--) pending.push({ node: node.children[index]!, children: copy.children });
  }
  return roots;
}

/** Pi's own tree rows, search, filters and branch navigation, with fork-specific controls. */
export class ForkSelector implements Component, Focusable {
  focused = false;
  private list: ReturnType<TreeSelectorComponent['getTreeList']>;

  constructor(tree: SessionTreeNode[], leafId: string | null, private height: () => number,
    private theme: () => Theme, onSelect: (entryId: string) => void, onCancel: () => void,
    onCopy: (text: string | undefined) => void) {
    const nodes = new Map<string, SessionTreeNode>();
    const pending = [...tree];
    while (pending.length) {
      const node = pending.pop()!; nodes.set(node.entry.id, node); pending.push(...node.children);
    }
    // Start at the most recent user prompt on the active path, not an unselectable response.
    let initialId = leafId;
    const seen = new Set<string>();
    while (initialId && !seen.has(initialId)) {
      seen.add(initialId);
      const entry = nodes.get(initialId)?.entry;
      if (!entry || (entry.type === 'message' && entry.message.role === 'user')) break;
      initialId = entry.parentId;
    }
    const selector = new TreeSelectorComponent(displayTree(tree), leafId, height(), () => {}, onCancel, undefined, initialId ?? undefined, 'no-tools');
    this.list = selector.getTreeList();
    this.list.onSelect = entryId => { if (this.canFork()) onSelect(entryId); };
    this.list.onLabelEdit = undefined; // Stock RPC cannot save labels. Do not offer local-only edits.
    this.list.onCopy = onCopy;
  }

  private canFork(): boolean {
    const entry = this.list.getSelectedNode()?.entry;
    return entry?.type === 'message' && entry.message.role === 'user';
  }

  handleInput(data: string): void { this.list.handleInput(data); }

  invalidate(): void { this.list.invalidate(); }

  render(width: number): string[] {
    const height = Math.max(1, this.height());
    const theme = this.theme();
    const header = height > 2 ? [theme.bold('  Session Fork')] : [];
    if (height >= 5) header.push(theme.fg('muted', `  Type to search: ${this.list.getSearchQuery()}`));
    const footer = height >= 5 ? [theme.fg('muted', this.canFork()
      ? '  Enter: fork before this prompt into a new session · Esc cancel · Ctrl+D detach'
      : '  Context only — choose a user prompt to fork · Esc cancel · Ctrl+D detach')] : [];
    const rows = this.list.render(width);
    const status = rows.pop()!;
    const statusRows = height > 1 ? [status] : [];
    const available = Math.max(1, height - header.length - footer.length - statusRows.length);
    // Keep the native selected row visible when the terminal shrinks below Pi's list minimum.
    const selected = rows.findIndex(row => stripTerminalSequences(row).startsWith('›'));
    const start = Math.max(0, Math.min(selected - Math.floor(available / 2), rows.length - available));
    return [...header, ...rows.slice(start, start + available), ...statusRows, ...footer]
      .slice(0, height).map(line => truncateToWidth(line, width, ''));
  }
}
