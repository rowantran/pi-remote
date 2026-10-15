import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeviceStore } from './devices.js';
import { privateDirectory, privateFile, readPrivateJson } from './private-state.js';

export const TAB_FILE = 'tabs.json';
/** Enough for a phone tab strip; also bounds push fan-out checks and stored state. */
export const MAX_TABS = 24;
const MAX_DEVICES = 100;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface State { version: 1; devices: Record<string, string[]> }
export class TabError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function slotId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) throw new TabError(400, 'Invalid session ID');
  return value.toLowerCase();
}
function validateState(value: any): State {
  if (!value || value.version !== 1 || !value.devices || typeof value.devices !== 'object' || Array.isArray(value.devices)
    || Object.keys(value.devices).length > MAX_DEVICES) throw new Error('Invalid web tab state');
  for (const [device, tabs] of Object.entries(value.devices)) {
    if (!UUID.test(device) || !Array.isArray(tabs) || tabs.length > MAX_TABS || new Set(tabs).size !== tabs.length
      || tabs.some(tab => typeof tab !== 'string' || !UUID.test(tab))) throw new Error('Invalid stored web tabs');
  }
  return value as State;
}

/** Per-device "sessions I am interested in". The phone shows them as tabs, and push
 * delivers a session's notifications only to devices that have it open. Opening or
 * closing a tab never creates, attaches, or stops a Pi session. One server process
 * owns this file; the CLI does not write it. */
export class TabStore {
  private state!: State;
  private writes = Promise.resolve();
  private readonly file: string;
  private constructor(private stateDir: string, private devices: DeviceStore) { this.file = join(stateDir, TAB_FILE); }
  static async open(stateDir: string, devices: DeviceStore): Promise<TabStore> {
    const store = new TabStore(await privateDirectory(stateDir), devices);
    const stored = await readPrivateJson(store.file);
    store.state = stored === undefined ? { version: 1, devices: {} } : validateState(stored);
    return store;
  }
  list(deviceId: string): string[] { return [...(this.state.devices[deviceId] ?? [])]; }
  has(deviceId: string, slot: string): boolean { return this.state.devices[deviceId]?.includes(slot.toLowerCase()) ?? false; }
  async open(deviceId: string, value: unknown): Promise<string[]> {
    const slot = slotId(value);
    const tabs = this.list(deviceId);
    if (tabs.includes(slot)) return tabs;
    if (tabs.length >= MAX_TABS) throw new TabError(409, `Close a tab first (limit ${MAX_TABS})`);
    // Drop revoked devices before adding one, which also bounds the device count.
    const valid = new Set((await this.devices.list()).map(device => device.id));
    for (const id of Object.keys(this.state.devices)) if (!valid.has(id)) delete this.state.devices[id];
    if (!valid.has(deviceId)) throw new TabError(401, 'Device pairing required');
    this.state.devices[deviceId] = [...tabs, slot];
    await this.save();
    return this.list(deviceId);
  }
  async close(deviceId: string, value: unknown): Promise<string[]> {
    const slot = slotId(value);
    const tabs = this.list(deviceId);
    if (!tabs.includes(slot)) return tabs;
    if (tabs.length === 1) delete this.state.devices[deviceId];
    else this.state.devices[deviceId] = tabs.filter(tab => tab !== slot);
    await this.save();
    return this.list(deviceId);
  }
  async forget(deviceId: string): Promise<void> {
    if (!(deviceId in this.state.devices)) return;
    delete this.state.devices[deviceId];
    await this.save();
  }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state) + '\n';
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = join(this.stateDir, `.tabs-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { privateFile(await file.stat()); await file.writeFile(snapshot); await file.sync(); }
      finally { await file.close(); }
      try { await rename(temporary, this.file); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    return this.writes;
  }
  async flush(): Promise<void> { await this.writes.catch(() => {}); }
}

/** Paired, identity-checked requests only (the caller authenticates). */
export async function handleTabsApi(tabs: TabStore, request: IncomingMessage, response: ServerResponse, deviceId: string,
  readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>): Promise<boolean> {
  const path = (request.url ?? '').split('?')[0];
  const json = (status: number, value: unknown) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); };
  if (path === '/api/tabs' && request.method === 'GET') json(200, { slotIds: tabs.list(deviceId) });
  else if ((path === '/api/tabs/open' || path === '/api/tabs/close') && request.method === 'POST') {
    const body = await readBody(request);
    json(200, { slotIds: path === '/api/tabs/open' ? await tabs.open(deviceId, body.slotId) : await tabs.close(deviceId, body.slotId) });
  } else return false;
  return true;
}
