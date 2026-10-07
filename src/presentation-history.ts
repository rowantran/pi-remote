import type { RecordValue, Snapshot } from './protocol.js';
import { messageKey } from './view.js';

/** Clone and freeze wire data; extension code never receives mutable snapshot objects. */
export function readonlyCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: any): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy); return copy;
}

const EMPTY: RecordValue[] = Object.freeze([]) as unknown as RecordValue[];
const MAX_BRANCHES = 8;
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
function protectedArray(previous: RecordValue[], next: RecordValue[]): RecordValue[] {
  return sameItems(previous, next) ? previous : Object.freeze(next) as unknown as RecordValue[];
}
interface BranchCache { revision: number; entries: RecordValue[] }

/**
 * RemoteView mutates containers, but replaces individual entries/messages rather than editing
 * them. Compare elements, not array identity or seq: status updates must not clone history.
 * Weak copies keep replaced streaming versions out of the retained cache. A small LRU bounds
 * explicit-leaf results, which can otherwise retain a separate ancestor array for every entry.
 */
export class ReadonlyHistory {
  private copies = new WeakMap<RecordValue, RecordValue>();
  private liveEntries = new WeakMap<RecordValue, RecordValue>();
  private readonly branches = new Map<RecordValue, BranchCache>();
  private sources: RecordValue[] = [];
  private entries?: RecordValue[];
  private readonly byId = new Map<string, RecordValue>();
  private headerSource?: RecordValue;
  private revision = 0;
  private defaultStored?: RecordValue[];
  private defaultSources?: RecordValue[];
  private defaultBranch = EMPTY;
  private disposed = false;

  private copy(source: RecordValue): RecordValue {
    let copy = this.copies.get(source);
    if (!copy) { copy = readonlyCopy(source); this.copies.set(source, copy); }
    return copy;
  }
  private sync(sources: RecordValue[]): void {
    if (sameItems(this.sources, sources)) return;
    this.sources = sources.slice();
    // Copy lazily: a header or branch reader need not clone unrelated historical entries.
    this.entries = undefined;
    this.headerSource = sources.find(entry => entry.type === 'session');
    this.byId.clear();
    for (const entry of sources) this.byId.set(entry.id, entry);
    for (const leaf of this.branches.keys()) if (this.byId.get(leaf.id) !== leaf) this.branches.delete(leaf);
    this.revision++;
  }
  getEntries(snapshot: Snapshot): RecordValue[] {
    if (this.disposed) return EMPTY;
    this.sync(snapshot.entries);
    return this.entries ??= protectedArray(EMPTY, this.sources.map(entry => this.copy(entry)));
  }
  getEntry(snapshot: Snapshot, id: string): RecordValue | undefined {
    if (this.disposed) return undefined;
    this.sync(snapshot.entries);
    const source = this.sources.find(entry => entry.id === id);
    return source && this.copy(source);
  }
  getHeader(snapshot: Snapshot): RecordValue | undefined {
    if (this.disposed) return undefined;
    this.sync(snapshot.entries); return this.headerSource && this.copy(this.headerSource);
  }
  private storedBranch(leafId: string | null): RecordValue[] {
    const leaf = leafId ? this.byId.get(leafId) : undefined;
    if (!leaf) return EMPTY;
    const cached = this.branches.get(leaf);
    // Refresh access order even when the cached branch needs no reconstruction.
    this.branches.delete(leaf);
    if (cached?.revision === this.revision) {
      this.branches.set(leaf, cached); return cached.entries;
    }
    const seen = new Set<string>();
    const branch: RecordValue[] = [];
    let id = leafId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const entry = this.byId.get(id);
      if (!entry) break;
      branch.push(this.copy(entry)); id = entry.parentId ?? null;
    }
    const entries = protectedArray(cached?.entries ?? EMPTY, branch.reverse());
    this.branches.set(leaf, { revision: this.revision, entries });
    if (this.branches.size > MAX_BRANCHES) this.branches.delete(this.branches.keys().next().value!);
    return entries;
  }
  private liveEntry(message: RecordValue): RecordValue {
    let entry = this.liveEntries.get(message);
    if (!entry) {
      // Only the cloned message is shared. The synthetic wrapper contains no source objects.
      entry = Object.freeze({ type: 'message', id: `live:${messageKey(message)}`, message: this.copy(message) });
      this.liveEntries.set(message, entry);
    }
    return entry;
  }
  getBranch(snapshot: Snapshot, leafId?: string): RecordValue[] {
    if (this.disposed) return EMPTY;
    this.sync(snapshot.entries);
    const stored = this.storedBranch(leafId ?? snapshot.leafId);
    // An explicit leaf never includes live messages, even if it is the current leaf.
    if (leafId !== undefined) return stored;
    const messages = snapshot.live.messages;
    if (this.defaultStored === stored && this.defaultSources && sameItems(this.defaultSources, messages)) {
      return this.defaultBranch;
    }
    const branch = stored.slice();
    // Preserve stored order and omit live messages that have already been persisted.
    const seen = new Set(stored.filter(entry => entry.type === 'message').map(entry => messageKey(entry.message)));
    for (const message of messages) if (!seen.has(messageKey(message))) branch.push(this.liveEntry(message));
    this.defaultStored = stored;
    // Retain only the current versions, not each version of a streaming message.
    this.defaultSources = messages.slice();
    this.defaultBranch = protectedArray(this.defaultBranch, branch);
    return this.defaultBranch;
  }
  dispose(): void {
    this.disposed = true;
    this.copies = new WeakMap(); this.liveEntries = new WeakMap(); this.branches.clear();
    this.sources = []; this.entries = undefined; this.byId.clear(); this.headerSource = undefined;
    this.defaultStored = undefined; this.defaultSources = undefined; this.defaultBranch = EMPTY;
  }
}
