import './shims/globals.js';
import { RemoteTui } from '../tui/tui.js';
import { ReconnectingConnection } from '../client/reconnect.js';
import type { SlotInfo } from '../protocol/types.js';
import { configureVirtualFiles } from './shims/vfs.js';
import { browserPresentationOptions, browserTerminalTheme, loadBrowserPresentation, presentationWarning, type BrowserPresentationConfig } from './presentation.js';
import { WebSocketConnection } from './connection.js';
import { XtermTerminal } from './terminal.js';
import { NativeInput } from './input.js';
import { installTouchScroll } from './touch.js';
import { Notifications } from './notifications.js';
import { TranscriptCache, ReadOnlyConnection } from './cache.js';

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
let offlinePreview = false;
let removeTouch: ReturnType<typeof installTouchScroll> | undefined;
const nativeInput = new NativeInput(report);
const notifications = new Notifications(api, () => currentSlot, report);
const transcriptCache = new TranscriptCache();

function report(error: unknown): void {
  notice.textContent = error instanceof Error ? error.message : String(error); notice.hidden = false;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { ready = false; offlinePreview = false; attaching++; currentSlot = undefined; clearDisplay(); void transcriptCache.clear(); if (!pairDialog.open) pairDialog.showModal(); }
    let text = ''; try { text = await response.text(); } catch {}
    throw new Error(text.slice(0, 500) || `Request failed (${response.status})`);
  }
  return await response.json() as T;
}
function desiredSlot(): string | undefined {
  const explicit = new URLSearchParams(location.hash.slice(1)).get('slot');
  if (explicit) return explicit;
  try { const saved = localStorage.getItem('pi-remote-last-slot'); return saved && /^[a-f0-9-]{36}$/i.test(saved) ? saved : undefined; }
  catch { return undefined; }
}

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
function clearDisplay(): void {
  nativeInput.release();
  client?.detach(); client = undefined; connection?.close(); connection = undefined;
  removeTouch?.dispose(); removeTouch = undefined;
  terminal?.dispose(); terminal = undefined;
}
async function attach(reference: string, offline = false): Promise<void> {
  const generation = ++attaching;
  clearDisplay(); currentSlot = undefined;
  status.textContent = 'Connecting…';
  const presentation = await browserPresentationOptions(report);
  if (generation !== attaching) return;
  const cached = await transcriptCache.load(reference);
  if (generation !== attaching) return;
  if (cached) {
    try {
      const readOnly = new ReadOnlyConnection();
      const draft = nativeInput.prepare(cached.slot.id);
      currentSlot = cached.slot.id;
      element('session-name').textContent = `${cached.slot.number ?? ''} · ${cached.slot.sessionName ?? 'Saved session'}`;
      terminal = new XtermTerminal(element('terminal'), undefined, browserTerminalTheme()); terminal.useNativeInput();
      client = new RemoteTui(readOnly, cached.slot.id, cached, terminal, { ...presentation, externalInput: nativeInput.callbacks });
      nativeInput.bind(client, readOnly, cached.slot.id, draft); nativeInput.setConnected(false);
      const preview = client;
      removeTouch = installTouchScroll(element('terminal'), terminal, lines => preview.scrollTranscript(lines));
      void preview.run().catch(() => {}); void preview.initialize().catch(() => {});
      status.textContent = 'Saved · reconnecting';
    } catch { clearDisplay(); }
  }
  if (offline) {
    status.textContent = cached ? 'Saved · offline' : 'Offline';
    report(cached ? 'Saved transcript only. Sending is disabled until the devbox reconnects.' : 'Offline. No saved transcript is available for this session.');
    return;
  }
  const conn = await makeConnection(value => { if (generation === attaching) transport = value; });
  try {
    const slots = await conn.request('list');
    const slot = slots.find(slot => slot.id === reference || String(slot.number) === reference);
    if (!slot) throw new Error('Session not found. Choose another session.');
    const snapshot = await conn.request('attach', { slotId: slot.id, filterTranscript: true });
    if (generation !== attaching) { conn.close(); return; }
    clearDisplay();
    currentSlot = slot.id; connection = conn;
    try { localStorage.setItem('pi-remote-last-slot', slot.id); } catch {}
    if (!location.hash) history.replaceState(null, '', `/#${new URLSearchParams({ slot: slot.id })}`);
    element('session-name').textContent = `${slot.number ?? ''} · ${slot.sessionName ?? 'Unnamed'}`;
    notice.hidden = !presentationWarning;
    const draft = nativeInput.prepare(slot.id);
    terminal = new XtermTerminal(element('terminal'), undefined, browserTerminalTheme());
    terminal.useNativeInput();
    client = new RemoteTui(conn, slot.id, snapshot, terminal, { ...presentation, host: location.hostname, externalInput: nativeInput.callbacks, onSnapshot: snapshot => transcriptCache.schedule(snapshot) });
    nativeInput.bind(client, conn, slot.id, draft);
    const scrollClient = client;
    removeTouch = installTouchScroll(element('terminal'), terminal, lines => scrollClient.scrollTranscript(lines));
    status.textContent = 'Connected';
    conn.onDisconnect(() => { if (connection === conn) { status.textContent = 'Reconnecting…'; nativeInput.setConnected(false); } });
    conn.onReconnect(() => { if (connection === conn) { status.textContent = 'Connected'; nativeInput.setConnected(true); } });
    const thisClient = client;
    void thisClient.run().then(() => { if (client === thisClient) { status.textContent = thisClient.stoppedSlot ? 'Stopped' : 'Detached'; nativeInput.release(); } }).catch(report);
    void thisClient.initialize().catch(report);
  } catch (error) { conn.close(); throw error; }
}
async function boot(): Promise<void> {
  try {
    const auth = await api<{ paired?: boolean; authenticated?: boolean }>('/api/status');
    if (auth.paired === false || auth.authenticated === false) { ready = false; offlinePreview = false; attaching++; currentSlot = undefined; clearDisplay(); void transcriptCache.clear(); if (!pairDialog.open) pairDialog.showModal(); return; }
    const config = await api<BrowserPresentationConfig>('/api/config');
    configureVirtualFiles(config);
    await loadBrowserPresentation(config, report);
    await browserPresentationOptions(report);
  } catch (error) {
    // Fetch rejection, not an online HTTP 401/403, permits a device-local read-only preview.
    const slot = desiredSlot();
    if (!(error instanceof TypeError) || !slot) throw error;
    ready = false; offlinePreview = true;
    await attach(slot, true); return;
  }
  offlinePreview = false; ready = true;
  void notifications.initialize().catch(report);
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
element('menu-button').addEventListener('click', () => { menuDialog.showModal(); void notifications.refresh().catch(report); });
element('close-menu').addEventListener('click', () => menuDialog.close());
element('reconnect').addEventListener('click', () => { menuDialog.close(); void boot().catch(report); });
element('clear-cache').addEventListener('click', () => { void transcriptCache.clear().then(() => { menuDialog.close(); report('Saved transcripts cleared. Prompt drafts remain on this device.'); }); });
element('unpair').addEventListener('click', () => {
  void api('/api/logout', {}).then(async () => {
    ready = false; attaching++; currentSlot = undefined; clearDisplay(); await transcriptCache.clear();
    try { for (const key of Object.keys(localStorage)) if (key.startsWith('pi-remote-draft:') || key === 'pi-remote-last-slot') localStorage.removeItem(key); } catch {}
    location.reload();
  }).catch(report);
});
const keys: Record<string, string> = { escape: '\x1b', up: '\x1b[A', down: '\x1b[B', enter: '\r', tools: '\x0f', thinking: '\x14' };
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-key]')) {
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => {
    const key = button.dataset.key!;
    if (menuDialog.contains(button)) menuDialog.close();
    terminal?.sendKey(keys[key]!);
  });
}
nativeInput.onStop = () => terminal?.sendKey(keys.escape!);
element('composer').addEventListener('submit', () => { removeTouch?.stop(); client?.followLatest(); });
// Hardware keyboards keep native text navigation; only explicit command-Enter submits.
nativeInput.textarea.addEventListener('keydown', event => {
  // A hardware keyboard's Escape keeps its laptop meaning (interrupt or cancel).
  if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); terminal?.sendKey(keys.escape!); return; }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); void nativeInput.submit(); }
});
window.addEventListener('hashchange', () => { const slot = desiredSlot(); if (ready && slot) void attach(slot).catch(report); });
// A socket can look open after iOS suspends the page. A foreground reconnect gets an
// authoritative snapshot, never replays commands, and preserves remote work.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (offlinePreview) void boot().catch(report);
  else if (ready && currentSlot) transport?.disconnect(new Error('Resuming after background suspension'));
});
window.addEventListener('online', () => {
  if (offlinePreview) void boot().catch(report);
  else if (ready && currentSlot) transport?.disconnect(new Error('Network changed'));
});
void boot().catch(report);
