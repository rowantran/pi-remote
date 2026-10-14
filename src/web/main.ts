import './shims/globals.js';
import { RemoteTui } from '../tui/tui.js';
import { ReconnectingConnection } from '../client/reconnect.js';
import type { SlotInfo } from '../protocol/types.js';
import { configureVirtualFiles, type VirtualFiles } from './shims/vfs.js';
import { WebSocketConnection } from './connection.js';
import { XtermTerminal } from './terminal.js';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing app element: ${id}`);
  return node as T;
}
const notice = element('notice');
const status = element('status');
const pairDialog = element<HTMLDialogElement>('pair-dialog');
const slotsDialog = element<HTMLDialogElement>('slots-dialog');
const menuDialog = element<HTMLDialogElement>('menu-dialog');
let client: RemoteTui | undefined;
let transport: WebSocketConnection | undefined;
let connection: ReconnectingConnection | undefined;
let terminal: XtermTerminal | undefined;
let attaching = 0;
let currentSlot: string | undefined;
let ready = false;

function report(error: unknown): void {
  notice.textContent = error instanceof Error ? error.message : String(error); notice.hidden = false;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) { ready = false; if (!pairDialog.open) pairDialog.showModal(); }
    throw new Error(text.slice(0, 500) || `Request failed (${response.status})`);
  }
  return await response.json() as T;
}
function desiredSlot(): string | undefined { return new URLSearchParams(location.hash.slice(1)).get('slot') ?? undefined; }

async function makeConnection(onTransport?: (value: WebSocketConnection) => void): Promise<ReconnectingConnection> {
  return ReconnectingConnection.connect(async () => {
    const value = await WebSocketConnection.connect(); onTransport?.(value); return value;
  });
}
async function showSlots(): Promise<void> {
  const conn = await makeConnection();
  let slots: SlotInfo[];
  try { slots = await conn.request('list'); } finally { conn.close(); }
  const list = element('slot-list'); list.replaceChildren();
  for (const slot of slots.filter(slot => slot.status !== 'exited').sort((a, b) => (b.number ?? 0) - (a.number ?? 0))) {
    const button = document.createElement('button');
    button.textContent = `${slot.number ?? slot.id} · ${slot.sessionName ?? 'Unnamed'} · ${slot.cwd}`;
    button.addEventListener('click', () => { slotsDialog.close(); location.hash = new URLSearchParams({ slot: slot.id }).toString(); if (slot.id === currentSlot) void attach(slot.id).catch(report); });
    list.append(button);
  }
  if (!list.children.length) list.textContent = 'No running sessions. Start one with pi-remote new on your laptop.';
  if (!slotsDialog.open) slotsDialog.showModal();
}
async function attach(reference: string): Promise<void> {
  const generation = ++attaching;
  client?.detach(); client = undefined; connection?.close(); connection = undefined;
  terminal?.dispose(); terminal = undefined;
  status.textContent = 'Connecting…';
  const conn = await makeConnection(value => { if (generation === attaching) transport = value; });
  try {
    const slots = await conn.request('list');
    const slot = slots.find(slot => slot.id === reference || String(slot.number) === reference);
    if (!slot) throw new Error('Session not found. Choose another session.');
    const snapshot = await conn.request('attach', { slotId: slot.id, filterTranscript: true });
    if (generation !== attaching) { conn.close(); return; }
    currentSlot = slot.id; connection = conn;
    element('session-name').textContent = `${slot.number ?? ''} · ${slot.sessionName ?? 'Unnamed'}`;
    notice.hidden = true;
    terminal = new XtermTerminal(element('terminal'));
    client = new RemoteTui(conn, slot.id, snapshot, terminal, { host: location.hostname, theme: 'dark', bell: true, hideThinkingBlock: true });
    status.textContent = 'Connected';
    conn.onDisconnect(() => { status.textContent = 'Reconnecting…'; });
    conn.onReconnect(() => { status.textContent = 'Connected'; });
    const thisClient = client;
    void thisClient.run().then(() => { if (client === thisClient) status.textContent = thisClient.stoppedSlot ? 'Stopped' : 'Detached'; }).catch(report);
    void thisClient.initialize().catch(report);
  } catch (error) { conn.close(); throw error; }
}
async function boot(): Promise<void> {
  const auth = await api<{ paired?: boolean; authenticated?: boolean }>('/api/status');
  if (auth.paired === false || auth.authenticated === false) { if (!pairDialog.open) pairDialog.showModal(); return; }
  configureVirtualFiles(await api<VirtualFiles>('/api/config'));
  ready = true;
  const slot = desiredSlot();
  if (slot) await attach(slot); else await showSlots();
}

element<HTMLFormElement>('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  const code = element<HTMLInputElement>('pair-code');
  const label = element<HTMLInputElement>('device-name');
  void api('/api/pair', { code: code.value.trim(), label: label.value.trim() }).then(() => {
    code.value = ''; pairDialog.close(); void boot().catch(report);
  }).catch(error => { element('pair-error').textContent = error instanceof Error ? error.message : String(error); });
});
element('slots-button').addEventListener('click', () => { void showSlots().catch(report); });
element('refresh-slots').addEventListener('click', () => { void showSlots().catch(report); });
element('close-slots').addEventListener('click', () => slotsDialog.close());
element('menu-button').addEventListener('click', () => menuDialog.showModal());
element('close-menu').addEventListener('click', () => menuDialog.close());
element('reconnect').addEventListener('click', () => { menuDialog.close(); void boot().catch(report); });
const keys: Record<string, string> = { escape: '\x1b', up: '\x1b[A', down: '\x1b[B', enter: '\r', tools: '\x0f', thinking: '\x14', latest: '\x1b[1;5F' };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-key]')) button.addEventListener('click', () => terminal?.sendKey(keys[button.dataset.key!]!));
window.addEventListener('hashchange', () => { const slot = desiredSlot(); if (ready && slot) void attach(slot).catch(report); });
// A socket can look open after iOS suspends the page. A foreground reconnect gets an
// authoritative snapshot, never replays commands, and preserves remote work.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ready && currentSlot) transport?.disconnect(new Error('Resuming after background suspension'));
});
window.addEventListener('online', () => { if (ready && currentSlot) transport?.disconnect(new Error('Network changed')); });
void boot().catch(report);
