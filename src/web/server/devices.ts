import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, privateFile, readPrivateJson, unlinkOwned } from './private-state.js';

export const DEVICE_COOKIE = '__Host-pi-remote-device';
export const DEVICE_FILE = 'devices.json';
export interface Device { id: string; label: string; login: string; createdAt: string }
interface StoredDevice extends Device { tokenHash: string }
interface Pairing { hash: string; expiresAt: number }
interface State { version: 1; devices: StoredDevice[]; pairings: Pairing[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sameHash = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const publicDevice = ({ id, label, login, createdAt }: StoredDevice): Device => ({ id, label, login, createdAt });

function stateValue(value: any): State {
  if (value === undefined) return { version: 1, devices: [], pairings: [] };
  if (!value || value.version !== 1 || !Array.isArray(value.devices) || !Array.isArray(value.pairings) || value.devices.length > 100 || value.pairings.length > 32) throw new Error('Invalid web device state');
  const ids = new Set<string>();
  for (const device of value.devices) {
    if (!device || typeof device.id !== 'string' || !/^[a-f0-9-]{36}$/.test(device.id) || ids.has(device.id)
      || typeof device.label !== 'string' || !validLabel(device.label) || typeof device.login !== 'string' || !device.login || device.login.length > 256
      || typeof device.createdAt !== 'string' || !Number.isFinite(Date.parse(device.createdAt)) || !isHash(device.tokenHash)) throw new Error('Invalid stored web device');
    ids.add(device.id);
  }
  for (const pairing of value.pairings) if (!pairing || !isHash(pairing.hash) || !Number.isSafeInteger(pairing.expiresAt)) throw new Error('Invalid stored pairing');
  return value as State;
}
function validLabel(label: string): boolean { return label === label.trim() && label.length > 0 && label.length <= 100 && !/[\x00-\x1f\x7f]/.test(label); }

/** Both CLI and server use atomic, owner-private state. Tokens and codes are never persisted in plaintext. */
export class DeviceStore {
  readonly file: string;
  constructor(readonly stateDir: string, private now: () => number = Date.now) { this.file = join(stateDir, DEVICE_FILE); }
  private async read(): Promise<State> {
    await privateDirectory(this.stateDir);
    return stateValue(await readPrivateJson(this.file));
  }
  private async transaction<T>(update: (state: State) => T): Promise<T> {
    await privateDirectory(this.stateDir);
    const lockPath = join(this.stateDir, 'devices.lock');
    const deadline = Date.now() + 3000;
    let lock;
    while (!lock) {
      try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        // No stale-lock reclamation: an interrupted writer requires manual inspection.
        if (Date.now() >= deadline) throw new Error('Web device state is locked; inspect devices.lock manually');
        await delay(20);
      }
    }
    const owner = await lock.stat();
    let temporary: string | undefined;
    let temporaryOwner;
    try {
      privateFile(owner);
      const state = await this.read();
      const result = update(state);
      temporary = join(this.stateDir, `.devices-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        temporaryOwner = await file.stat();
        privateFile(temporaryOwner);
        await file.writeFile(JSON.stringify(state) + '\n');
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.file);
      return result;
    } finally {
      if (temporary && temporaryOwner) await unlinkOwned(temporary, temporaryOwner);
      await lock.close();
      await unlinkOwned(lockPath, owner);
    }
  }
  async issuePairingCode(ttlMs = 10 * 60_000): Promise<{ code: string; expiresAt: number }> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 60 * 60_000) throw new Error('Invalid pairing lifetime');
    const code = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    await this.transaction(state => {
      state.pairings = state.pairings.filter(pair => pair.expiresAt > this.now());
      if (state.pairings.length >= 32) throw new Error('Too many outstanding pairing codes');
      state.pairings.push({ hash: hash(code), expiresAt });
    });
    return { code, expiresAt };
  }
  async pair(code: unknown, label: unknown, login: string): Promise<{ device: Device; token: string } | undefined> {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code) || typeof label !== 'string' || !validLabel(label) || !login || login.length > 256) return undefined;
    return this.transaction(state => {
      const match = state.pairings.findIndex(pair => pair.expiresAt > this.now() && sameHash(pair.hash, hash(code)));
      if (match === -1) return undefined;
      if (state.devices.length >= 100) throw new Error('Device limit reached; revoke an unused device');
      state.pairings.splice(match, 1);
      const token = randomBytes(32).toString('base64url');
      const device: StoredDevice = { id: randomUUID(), label, login, createdAt: new Date(this.now()).toISOString(), tokenHash: hash(token) };
      state.devices.push(device);
      return { device: publicDevice(device), token };
    });
  }
  async authenticate(token: string | undefined, login: string): Promise<Device | undefined> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const digest = hash(token);
    const device = (await this.read()).devices.find(device => device.login === login && sameHash(device.tokenHash, digest));
    return device && publicDevice(device);
  }
  async list(): Promise<Device[]> { return (await this.read()).devices.map(publicDevice); }
  async get(id: string): Promise<Device | undefined> { return (await this.list()).find(device => device.id === id); }
  async revoke(id: string): Promise<boolean> {
    return this.transaction(state => {
      const before = state.devices.length;
      state.devices = state.devices.filter(device => device.id !== id);
      return state.devices.length !== before;
    });
  }
}

/** Duplicate or malformed device cookies fail closed, even if another value is valid. */
export function deviceToken(cookie: string | undefined): string | undefined {
  if (!cookie || cookie.length > 8192 || /[\x00-\x1f\x7f]/.test(cookie)) return undefined;
  let found: string | undefined;
  for (const item of cookie.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) { if (item.trim() === DEVICE_COOKIE) return undefined; continue; }
    if (item.slice(0, separator).trim() !== DEVICE_COOKIE) continue;
    if (found !== undefined) return undefined;
    const value = item.slice(separator + 1).trim();
    // Do not URL-decode or accept quoted credentials; the issued token is base64url.
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    found = value;
  }
  return found;
}
export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}
