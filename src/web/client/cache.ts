import type { RemoteConnection, SlotInfo } from '../../protocol/types.js';
import type { CompanionMessage } from '../../protocol/companion.js';
import type { DaemonMethod, MethodResult, RequestArgs } from '../../protocol/methods.js';

const DATABASE = 'pi-remote-transcripts';
const STORE = 'snapshots';
const MAX_BYTES = 8 * 1024 * 1024;
/** A slot's screen: frames and the session, without prompt history or the draft. */
export interface SavedScreen { slot: SlotInfo; messages: CompanionMessage[] }
interface Cached { slotId: string; savedAt: number; screen?: SavedScreen }
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

/** Device-local display cache only. Never pass its contents to a daemon command or model. */
export class TranscriptCache {
  private generation = 0;
  private pendingScreen?: SavedScreen;
  private scheduledScreen = false;
  /** Save a slot's screen when the browser is idle; only the latest one is written. */
  scheduleScreen(slot: SlotInfo, messages: CompanionMessage[]): void {
    this.pendingScreen = { slot, messages: messages.filter(message => message.type === 'frame' || message.type === 'session') };
    if (this.scheduledScreen) return;
    this.scheduledScreen = true;
    const generation = this.generation;
    const save = () => {
      this.scheduledScreen = false;
      const latest = this.pendingScreen; this.pendingScreen = undefined;
      if (generation === this.generation && latest) void this.put({ slotId: latest.slot.id, savedAt: Date.now(), screen: latest }, generation);
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(save, { timeout: 3000 });
    else setTimeout(save, 0);
  }
  async loadScreen(reference: string): Promise<SavedScreen | undefined> {
    let db: IDBDatabase | undefined;
    try {
      db = await database();
      const records = await transaction<Cached[]>(db, 'readonly', (store, accept) => {
        const request = store.getAll(); request.onsuccess = () => accept(request.result);
      });
      const screen = records.find(record => record.screen && (record.slotId === reference || String(record.screen.slot?.number) === reference))?.screen;
      return screen?.slot?.id && Array.isArray(screen.messages) ? screen : undefined;
    } catch { return undefined; }
    finally { db?.close(); }
  }
  private async put(record: Cached, generation: number): Promise<void> {
    let db: IDBDatabase | undefined;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
      if (bytes > MAX_BYTES) return;
      db = await database();
      if (generation !== this.generation) return;
      await transaction<void>(db, 'readwrite', store => {
        store.put(record);
        const all = store.getAll();
        all.onsuccess = () => {
          const records = (all.result as Cached[]).sort((a, b) => b.savedAt - a.savedAt);
          for (const record of records.slice(3)) store.delete(record.slotId);
        };
      });
    } catch { /* Quota/private browsing/cache errors never affect remote work or typing. */ }
    finally { db?.close(); }
  }
  async clear(): Promise<void> {
    this.generation++; this.pendingScreen = undefined;
    let db: IDBDatabase | undefined;
    try { db = await database(); await transaction<void>(db, 'readwrite', store => { store.clear(); }); }
    catch {} finally { db?.close(); }
  }
}

/** A saved screen can paint and accept a local draft but has no submission authority. */
export class ReadOnlyConnection implements RemoteConnection {
  request<M extends DaemonMethod>(_method: M, ..._args: RequestArgs<M>): Promise<MethodResult<M>> { return Promise.reject(new Error('Saved screen only. Nothing was sent.')); }
  onEvent(): () => void { return () => {}; }
  onDisconnect(listener: (error: Error) => void): () => void {
    let active = true; queueMicrotask(() => { if (active) listener(new Error('Showing a saved transcript while reconnecting')); });
    return () => { active = false; };
  }
  close(): void {}
}
