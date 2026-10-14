import type { RemoteConnection, Snapshot } from '../protocol/types.js';
import type { DaemonMethod, MethodResult, RequestArgs } from '../protocol/methods.js';
import { filterSnapshot } from '../protocol/transcript-filter.js';
import { emptyLive } from '../protocol/live.js';

const DATABASE = 'pi-remote-transcripts';
const STORE = 'snapshots';
const MAX_BYTES = 8 * 1024 * 1024;
interface Cached { slotId: string; savedAt: number; snapshot: Snapshot }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'slotId' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore, accept: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    operation(tx.objectStore(STORE), result => { value = result; });
  });
}

/** Do not retain stale interaction or running-state artifacts, or mutate the live view. */
export function snapshotForCache(snapshot: Snapshot): Snapshot {
  const filtered = filterSnapshot(snapshot);
  return {
    ...filtered,
    ui: filtered.ui.filter(record => !['input', 'editor', 'confirm', 'select', 'set_editor_text'].includes(record.method)),
    live: { ...emptyLive(), messages: filtered.live.messages },
  };
}

/** Device-local display cache only. Never pass its contents to a daemon command or model. */
export class TranscriptCache {
  private pending?: Snapshot;
  private scheduled = false;
  private generation = 0;
  schedule(snapshot: Snapshot): void {
    this.pending = snapshot;
    if (this.scheduled) return;
    this.scheduled = true;
    const generation = this.generation;
    const save = () => {
      this.scheduled = false;
      const latest = this.pending; this.pending = undefined;
      if (generation === this.generation && latest) void this.save(latest, generation);
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(save, { timeout: 3000 });
    else setTimeout(save, 0);
  }
  private async save(snapshot: Snapshot, generation: number): Promise<void> {
    if (snapshot.historyComplete !== true) return;
    let db: IDBDatabase | undefined;
    try {
      // Clear interaction and running-state artifacts; saved bytes are a read-only preview.
      const display = snapshotForCache(snapshot);
      const bytes = new TextEncoder().encode(JSON.stringify(display)).length;
      if (bytes > MAX_BYTES) return;
      db = await database();
      if (generation !== this.generation) return;
      await transaction<void>(db, 'readwrite', store => {
        store.put({ slotId: display.slot.id, savedAt: Date.now(), snapshot: display } satisfies Cached);
        const all = store.getAll();
        all.onsuccess = () => {
          const records = (all.result as Cached[]).sort((a, b) => b.savedAt - a.savedAt);
          for (const record of records.slice(3)) store.delete(record.slotId);
        };
      });
    } catch { /* Quota/private browsing/cache errors never affect remote work or typing. */ }
    finally { db?.close(); }
  }
  async load(reference: string): Promise<Snapshot | undefined> {
    let db: IDBDatabase | undefined;
    try {
      db = await database();
      const records = await transaction<Cached[]>(db, 'readonly', (store, accept) => {
        const request = store.getAll(); request.onsuccess = () => accept(request.result);
      });
      const record = records.find(record => record.slotId === reference || String(record.snapshot?.slot?.number) === reference);
      const snapshot = record?.snapshot;
      if (snapshot?.historyComplete !== true || !snapshot.slot?.id || !Array.isArray(snapshot.entries) || !snapshot.live || !Array.isArray(snapshot.ui) || !Number.isSafeInteger(snapshot.seq)) return undefined;
      return snapshot;
    } catch { return undefined; }
    finally { db?.close(); }
  }
  async clear(): Promise<void> {
    this.generation++; this.pending = undefined;
    let db: IDBDatabase | undefined;
    try { db = await database(); await transaction<void>(db, 'readwrite', store => { store.clear(); }); }
    catch {} finally { db?.close(); }
  }
}

/** A cached transcript can paint and accept a local draft but has no submission authority. */
export class ReadOnlyConnection implements RemoteConnection {
  request<M extends DaemonMethod>(_method: M, ..._args: RequestArgs<M>): Promise<MethodResult<M>> { return Promise.reject(new Error('Cached transcript only. Nothing was sent.')); }
  onEvent(): () => void { return () => {}; }
  onDisconnect(listener: (error: Error) => void): () => void {
    let active = true; queueMicrotask(() => { if (active) listener(new Error('Showing a saved transcript while reconnecting')); });
    return () => { active = false; };
  }
  close(): void {}
}
