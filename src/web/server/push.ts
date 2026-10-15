import { createECDH, ECDH, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import webpush from 'web-push';
import type { DeviceStore } from './devices.js';
import type { TabStore } from './tabs.js';
import { privateDirectory, privateFile, readPrivateJson } from './private-state.js';
import { readJsonBody, type AuthenticatedContext } from './server.js';
import type { SlotInfo } from '../../protocol/types.js';

export interface BellNotice { id: string; slot: SlotInfo; kind: 'done' | 'blocked' | 'error' }
interface Subscription { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }
interface State { version: 1; keys: { publicKey: string; privateKey: string }; subscriptions: { deviceId: string; subscription: Subscription }[]; seen: string[] }
type Sender = typeof webpush.sendNotification;
export interface PushOptions {
  stateDir: string; origin: string; devices: DeviceStore; allowedLogins: readonly string[];
  /** A session's notifications go only to devices that have it open as a tab. */
  tabs: Pick<TabStore, 'has'>;
  /** Tests replace only delivery, never production endpoint validation. */
  send?: Sender;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}
const HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 80);

function decode(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid Web Push key');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw new Error('Invalid Web Push key');
  return bytes;
}
export function validateSubscription(value: any): Subscription {
  if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string' || value.endpoint.length > 4096 || !value.keys) throw new Error('Invalid push subscription');
  let url: URL;
  try { url = new URL(value.endpoint); } catch { throw new Error('Invalid push endpoint'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Error('Use a supported HTTPS browser push endpoint');
  const point = decode(value.keys.p256dh, 65);
  if (point[0] !== 4) throw new Error('Invalid Web Push public key');
  try { ECDH.convertKey(point, 'prime256v1'); }
  catch { throw new Error('Invalid Web Push public key'); }
  decode(value.keys.auth, 16);
  const expirationTime = value.expirationTime ?? null;
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)) throw new Error('Invalid push expiration');
  // web-push uses legacy url.parse internally. Give it the URL we actually validated,
  // not a differently parsed raw string such as https:/web.push.apple.com/path.
  return { endpoint: url.href, expirationTime, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
function validateState(value: any): State {
  if (!value || value.version !== 1 || !value.keys || !Array.isArray(value.subscriptions) || value.subscriptions.length > 100 || !Array.isArray(value.seen) || value.seen.length > 256) throw new Error('Invalid push state');
  const key = createECDH('prime256v1'); key.setPrivateKey(decode(value.keys.privateKey, 32));
  if (key.getPublicKey().toString('base64url') !== value.keys.publicKey) throw new Error('Invalid stored VAPID key pair');
  const ids = new Set<string>();
  for (const item of value.subscriptions) {
    if (!item || !UUID.test(item.deviceId) || ids.has(item.deviceId)) throw new Error('Invalid stored push device');
    ids.add(item.deviceId); item.subscription = validateSubscription(item.subscription);
  }
  if (value.seen.some((id: unknown) => typeof id !== 'string' || !id || id.length > 256)) throw new Error('Invalid stored notification identity');
  return value as State;
}

/** No Apple account or APNs signing key: this uses standards-based Web Push and local VAPID keys.
 * Push endpoints/keys are private state; they are never returned from status or logged. */
export class PushService {
  private state!: State;
  private writes = Promise.resolve();
  private deliveries = Promise.resolve();
  private queued = 0;
  private closed = false;
  private monitor = 'disconnected';
  private error?: string;
  private readonly now: () => number;
  private readonly file: string;
  private constructor(private options: PushOptions) { this.now = options.now ?? Date.now; this.file = join(options.stateDir, 'push.json'); }
  static async open(options: PushOptions): Promise<PushService> {
    if (new URL(options.origin).protocol !== 'https:' || new URL(options.origin).origin !== options.origin) throw new Error('Web Push needs the exact HTTPS application origin');
    await privateDirectory(options.stateDir);
    const service = new PushService(options);
    const stored = await readPrivateJson(service.file);
    service.state = stored === undefined ? { version: 1, keys: webpush.generateVAPIDKeys(), subscriptions: [], seen: [] } : validateState(stored);
    if (stored === undefined) await service.save();
    return service;
  }
  setMonitorStatus(status: string): void { this.monitor = status; }
  get publicKey(): string { return this.state.keys.publicKey; }
  private save(): Promise<void> {
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = join(this.options.stateDir, `.push-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { privateFile(await file.stat()); await file.writeFile(JSON.stringify(this.state) + '\n'); await file.sync(); }
      finally { await file.close(); }
      try { await rename(temporary, this.file); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    return this.writes;
  }
  async handleApi(request: IncomingMessage, response: ServerResponse, context: AuthenticatedContext): Promise<boolean> {
    const path = (request.url ?? '').split('?')[0];
    if (!path.startsWith('/api/push')) return false;
    if (this.closed) { response.statusCode = 503; response.end('Push service is shutting down'); return true; }
    const json = (status: number, value: unknown) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    try {
      if (path === '/api/push' && request.method === 'GET') {
        json(200, { publicKey: this.publicKey, subscribed: this.state.subscriptions.some(item => item.deviceId === context.device.id), monitor: this.monitor, ...(this.error ? { warning: this.error } : {}) });
      } else if (path === '/api/push/subscribe' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const subscription = validateSubscription(body.subscription);
        if (subscription.expirationTime !== null && subscription.expirationTime !== undefined && subscription.expirationTime <= this.now()) throw new Error('Push subscription has expired');
        this.state.subscriptions = this.state.subscriptions.filter(item => item.deviceId !== context.device.id && item.subscription.endpoint !== subscription.endpoint);
        this.state.subscriptions.push({ deviceId: context.device.id, subscription });
        await this.save(); json(200, { subscribed: true });
      } else if (path === '/api/push/unsubscribe' && request.method === 'POST') {
        await readJsonBody(request);
        this.state.subscriptions = this.state.subscriptions.filter(item => item.deviceId !== context.device.id);
        await this.save(); json(200, { subscribed: false });
      } else if (path === '/api/push/test' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (typeof body.slotId !== 'string' || !UUID.test(body.slotId)) throw new Error('Select a session first');
        const item = this.state.subscriptions.find(item => item.deviceId === context.device.id);
        if (!item) throw new Error('Enable notifications first');
        const sent = await this.deliver(context.device.id, item.subscription, { version: 1, id: randomUUID(), slotId: body.slotId, sessionName: 'Test notification', kind: 'done' });
        if (!sent) throw new Error('The subscription is no longer available');
        json(200, { sent: true });
      } else return false;
    } catch {
      // Subscription URLs and keys can occur in library exceptions. Never reflect them.
      json(400, { error: 'Push request failed. Check the subscription, notification permission, and outbound HTTPS.' });
    }
    return true;
  }
  /** Called once per monitor bell. No transcript text, model content, or tool output enters a push. */
  notify(notice: BellNotice): Promise<void> {
    if (this.closed || !notice.id || notice.id.length > 256 || !UUID.test(notice.slot.id) || this.state.seen.includes(notice.id)) return Promise.resolve();
    if (this.queued >= 256) { this.error = 'Notification queue is full; some notifications were dropped.'; return Promise.resolve(); }
    this.state.seen = [...this.state.seen.slice(-255), notice.id]; this.queued++;
    const payload = { version: 1, id: notice.id, slotId: notice.slot.id, slotNumber: notice.slot.number,
      sessionName: clean(notice.slot.sessionName ?? ''), kind: notice.kind };
    const job = this.deliveries.then(async () => {
      await this.save();
      const valid = new Set((await this.options.devices.list()).filter(device => this.options.allowedLogins.includes(device.login)).map(device => device.id));
      this.state.subscriptions = this.state.subscriptions.filter(item => valid.has(item.deviceId));
      // A single device's failed push must not prevent delivery to the next device.
      for (const item of [...this.state.subscriptions]) {
        if (this.closed) break;
        if (!this.options.tabs.has(item.deviceId, notice.slot.id)) continue;
        try { await this.deliver(item.deviceId, item.subscription, payload, notice.slot.id); }
        catch { this.error = 'Push delivery failed; check notification settings and outbound HTTPS.'; }
      }
      await this.save();
    });
    this.deliveries = job.catch(() => { this.error = 'Push delivery failed; check private state permissions and outbound HTTPS.'; }).finally(() => { this.queued--; });
    return this.deliveries;
  }
  /** `tabSlot` is set for session bells: closing that tab cancels pending retries. Explicit
   * test notifications omit it. */
  private async deliver(deviceId: string, subscription: Subscription, payload: unknown, tabSlot?: string): Promise<boolean> {
    const active = async () => {
      const device = await this.options.devices.get(deviceId);
      return !this.closed && !!device && this.options.allowedLogins.includes(device.login)
        && (tabSlot === undefined || this.options.tabs.has(deviceId, tabSlot))
        && this.state.subscriptions.some(item => item.deviceId === deviceId && item.subscription.endpoint === subscription.endpoint
          && item.subscription.keys.auth === subscription.keys.auth && item.subscription.keys.p256dh === subscription.keys.p256dh);
    };
    if (!await active()) return false;
    const expired = () => { this.state.subscriptions = this.state.subscriptions.filter(item => item.deviceId !== deviceId || item.subscription.endpoint !== subscription.endpoint); };
    if (subscription.expirationTime && subscription.expirationTime <= this.now()) { expired(); await this.save(); return false; }
    for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
      if (!await active()) return false;
      try {
        await (this.options.send ?? webpush.sendNotification)(subscription, JSON.stringify(payload), {
          vapidDetails: { subject: this.options.origin, ...this.state.keys }, TTL: 3600, urgency: 'normal', timeout: 10_000,
        });
        return true;
      } catch (error: any) {
        if (error.statusCode === 404 || error.statusCode === 410) { expired(); await this.save(); return false; }
        if (attempt === 2 || (error.statusCode && error.statusCode !== 408 && error.statusCode !== 429 && error.statusCode < 500)) throw new Error('Push delivery failed');
        await (this.options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000 * 2 ** attempt);
        if (!await active()) return false;
      }
    }
    return false;
  }
  async close(): Promise<void> { this.closed = true; await this.deliveries; await this.writes; }
}
