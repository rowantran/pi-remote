import './shims/globals.js';
import { RemoteTui } from '../../tui/tui.js';
import { ReconnectingConnection } from '../../client/reconnect.js';
import { configureVirtualFiles } from './shims/vfs.js';
import { browserPresentationOptions, browserTerminalTheme, loadBrowserPresentation, presentationWarning, type BrowserPresentationConfig } from './presentation.js';
import { WebSocketConnection } from './connection.js';
import { XtermTerminal } from './terminal.js';
import { NativeInput } from './input.js';
import { installTouchScroll } from './touch.js';
import { Notifications } from './notifications.js';
import { TranscriptCache, ReadOnlyConnection } from './cache.js';
import { SessionTabs, slotLabel } from './tabs.js';

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
const tabs = new SessionTabs(api, element('tabs'), { select: slotId => openSlot(slotId), close: slotId => { void closeTab(slotId).catch(report); } });
const LAST_SLOT = 'pi-remote-last-slot';
const RECENT_DIRS = 'pi-remote-recent-dirs';

function report(error: unknown): void {
  notice.textContent = error instanceof Error ? error.message : String(error); notice.hidden = false;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { ready = false; offlinePreview = false; attaching++; currentSlot = undefined; clearDisplay(); void transcriptCache.clear(); if (!pairDialog.open) pairDialog.showModal(); }
    let text = ''; try { text = await response.text(); } catch {}
    try { const message = JSON.parse(text).error; if (typeof message === 'string') text = message; } catch {}
    throw new Error(text.slice(0, 500) || `Request failed (${response.status})`);
  }
  return await response.json() as T;
}
function lastSlot(): string | undefined {
  try { const saved = localStorage.getItem(LAST_SLOT); return saved && /^[a-f0-9-]{36}$/i.test(saved) ? saved : undefined; }
  catch { return undefined; }
}
/** An explicit link wins. Otherwise reopen the last tab, or the first open tab. A device with
 * no tabs yet (installed before tabs existed) reopens its last session, which becomes a tab. */
function desiredSlot(): string | undefined {
  const explicit = new URLSearchParams(location.hash.slice(1)).get('slot');
  if (explicit) return explicit;
  const saved = lastSlot();
  if (!tabs.slotIds.length) return saved;
  return saved && tabs.has(saved) ? saved : tabs.slotIds[0];
}
function openSlot(slotId: string): void {
  const hash = new URLSearchParams({ slot: slotId }).toString();
  if (location.hash.slice(1) === hash) { if (slotId !== currentSlot) void attach(slotId).catch(report); }
  else location.hash = hash;
}
function recentDirectories(): string[] {
  try { const value = JSON.parse(localStorage.getItem(RECENT_DIRS) ?? '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8) : []; }
  catch { return []; }
}
function rememberDirectory(cwd: string): void {
  try { localStorage.setItem(RECENT_DIRS, JSON.stringify([cwd, ...recentDirectories().filter(item => item !== cwd)].slice(0, 8))); } catch {}
}

async function makeConnection(onTransport?: (value: WebSocketConnection) => void): Promise<ReconnectingConnection> {
  return ReconnectingConnection.connect(async () => {
    const value = await WebSocketConnection.connect(); onTransport?.(value); return value;
  });
}
/** One short-lived daemon connection for the session list, directory suggestions, and create. */
let sessionsConnection: Promise<ReconnectingConnection> | undefined;
function dialogConnection(): Promise<ReconnectingConnection> {
  const pending = sessionsConnection ??= makeConnection();
  pending.catch(() => { if (sessionsConnection === pending) sessionsConnection = undefined; });
  return pending;
}
function closeDialogConnection(): void {
  const pending = sessionsConnection; sessionsConnection = undefined;
  void pending?.then(conn => conn.close(), () => {});
}
async function refreshTabs(): Promise<void> {
  const conn = await makeConnection();
  try { tabs.update(await conn.request('list')); } finally { conn.close(); }
}
async function showSlots(): Promise<void> {
  const conn = await dialogConnection();
  const slots = await conn.request('list');
  tabs.update(slots);
  const list = element('slot-list'); list.replaceChildren();
  const running = slots.filter(slot => slot.status !== 'exited').sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  for (const slot of running) {
    const button = document.createElement('button');
    const open = tabs.has(slot.id);
    button.textContent = `${slotLabel(slot)} · ${slot.cwd}${open ? ' · open' : ''}`;
    if (open) button.classList.add('open');
    button.addEventListener('click', () => { slotsDialog.close(); openSlot(slot.id); });
    list.append(button);
  }
  if (!list.children.length) list.textContent = 'No running sessions. Start one below.';
  const input = element<HTMLInputElement>('new-session-cwd');
  const directories = [...new Set([...recentDirectories(), ...running.map(slot => slot.cwd)])];
  if (!input.value) input.value = directories[0] ?? '';
  showDirectories(directories);
  element('new-session-error').textContent = '';
  if (!slotsDialog.open) slotsDialog.showModal();
}
function showDirectories(values: readonly string[]): void {
  const options = element('new-session-dirs');
  options.replaceChildren(...[...new Set(values)].slice(0, 50).map(value => Object.assign(document.createElement('option'), { value })));
}
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let completionGeneration = 0;
function completeDirectory(): void {
  clearTimeout(completionTimer);
  const generation = ++completionGeneration;
  const prefix = element<HTMLInputElement>('new-session-cwd').value;
  if (!prefix || !slotsDialog.open) return;
  completionTimer = setTimeout(() => {
    void dialogConnection().then(conn => conn.request('complete_path', { prefix, directoriesOnly: true })).then(result => {
      if (generation === completionGeneration) showDirectories([...result.items.filter(item => item.directory).map(item => item.value), ...recentDirectories()]);
    }).catch(() => { /* Suggestions are optional; typing a full path still works. */ });
  }, 200);
}
let creating = false;
async function createSession(): Promise<void> {
  if (creating) return;
  const input = element<HTMLInputElement>('new-session-cwd');
  const error = element('new-session-error');
  const button = element<HTMLButtonElement>('create-session');
  const cwd = input.value.trim();
  if (!cwd) return;
  creating = true; button.disabled = true; button.textContent = 'Starting…'; error.textContent = '';
  try {
    const conn = await dialogConnection();
    // Sent once. If the result is unknown, the session may exist: never retry automatically.
    const slot = await conn.request('create', { cwd });
    rememberDirectory(cwd);
    if (slot.status === 'exited') throw new Error(`Pi exited during startup: ${slot.error ?? 'unknown error'}`);
    slotsDialog.close();
    openSlot(slot.id);
  } catch (cause) {
    error.textContent = `${cause instanceof Error ? cause.message : String(cause)} Refresh the list before trying again.`;
  } finally { creating = false; button.disabled = false; button.textContent = 'Start session'; }
}
/** Closing a tab stops its notifications on this device; the session keeps running. */
async function closeTab(slotId: string): Promise<void> {
  const next = await tabs.close(slotId);
  if (slotId !== currentSlot) return;
  try { localStorage.removeItem(LAST_SLOT); } catch {}
  if (next) { openSlot(next); return; }
  attaching++; clearDisplay(); currentSlot = undefined;
  history.replaceState(null, '', '/');
  element('session-name').textContent = 'Pi Remote'; status.textContent = '';
  await showSlots();
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
      currentSlot = cached.slot.id; tabs.setActive(cached.slot.id);
      element('session-name').textContent = slotLabel(cached.slot, 'Saved session');
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
    tabs.update(slots);
    const slot = slots.find(slot => slot.id === reference || String(slot.number) === reference);
    if (!slot) throw new Error('Session not found. Choose another session.');
    // Viewing a session opens it as a tab, which also subscribes this device to its notifications.
    await tabs.open(slot.id);
    if (generation !== attaching) { conn.close(); return; }
    const snapshot = await conn.request('attach', { slotId: slot.id, filterTranscript: true });
    if (generation !== attaching) { conn.close(); return; }
    clearDisplay();
    currentSlot = slot.id; connection = conn; tabs.setActive(slot.id);
    try { localStorage.setItem(LAST_SLOT, slot.id); } catch {}
    if (!location.hash) history.replaceState(null, '', `/#${new URLSearchParams({ slot: slot.id })}`);
    element('session-name').textContent = slotLabel(slot);
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
    await tabs.load();
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
slotsDialog.addEventListener('close', () => { clearTimeout(completionTimer); completionGeneration++; closeDialogConnection(); });
element('new-session-form').addEventListener('submit', event => { event.preventDefault(); void createSession(); });
element('new-session-cwd').addEventListener('input', completeDirectory);
element('menu-button').addEventListener('click', () => { menuDialog.showModal(); void notifications.refresh().catch(report); });
element('close-menu').addEventListener('click', () => menuDialog.close());
element('reconnect').addEventListener('click', () => { menuDialog.close(); void boot().catch(report); });
element('clear-cache').addEventListener('click', () => { void transcriptCache.clear().then(() => { menuDialog.close(); report('Saved transcripts cleared. Prompt drafts remain on this device.'); }); });
element('unpair').addEventListener('click', () => {
  void api('/api/logout', {}).then(async () => {
    ready = false; attaching++; currentSlot = undefined; clearDisplay(); await transcriptCache.clear();
    try { for (const key of Object.keys(localStorage)) if (key.startsWith('pi-remote-draft:') || key === LAST_SLOT || key === RECENT_DIRS) localStorage.removeItem(key); } catch {}
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
  else if (ready) {
    // Another window may have changed tabs, and other sessions may have new names.
    void tabs.load().then(refreshTabs).catch(() => {});
    if (currentSlot) transport?.disconnect(new Error('Resuming after background suspension'));
  }
});
window.addEventListener('online', () => {
  if (offlinePreview) void boot().catch(report);
  else if (ready && currentSlot) transport?.disconnect(new Error('Network changed'));
});
void boot().catch(report);
