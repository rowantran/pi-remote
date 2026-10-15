import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { DeviceStore, type Device } from '../../src/web/server/devices.js';
import { PushService, validateSubscription, type BellNotice } from '../../src/web/server/push.js';
import { TabStore } from '../../src/web/server/tabs.js';
import type { AuthenticatedContext } from '../../src/web/server/server.js';

const origin = 'https://devbox.example.test';
const allowedLogins = ['rowan@example.test'];
function subscription(endpoint = 'https://web.push.apple.com/test-endpoint') {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  return { endpoint, expirationTime: null, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
async function device(store: DeviceStore, label: string, login = 'rowan@example.test') {
  const code = await store.issuePairingCode();
  return (await store.pair(code.code, label, login))!.device;
}
async function call(service: PushService, devices: DeviceStore, paired: Device, path: string, body?: unknown) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  request.method = body === undefined ? 'GET' : 'POST'; request.url = path;
  request.headers = { 'content-type': 'application/json' };
  let result = ''; let status = 200;
  const response = { get statusCode() { return status; }, set statusCode(value) { status = value; }, setHeader() {}, end(text: string) { result = text; } } as unknown as ServerResponse;
  const context: AuthenticatedContext = { origin, devices, tabs: undefined as never, device: paired, login: paired.login };
  assert.equal(await service.handleApi(request, response, context), true);
  return { status, data: JSON.parse(result) };
}
const SLOT = '79e35412-572b-4f77-a04f-a93f12e18c92';
/** Each device has the notified session open unless a test says otherwise. */
async function tabsFor(dir: string, devices: DeviceStore, ...paired: Device[]) {
  const tabs = await TabStore.open(dir, devices);
  for (const device of paired) await tabs.open(device.id, SLOT);
  return tabs;
}
const notice = (id = 'run-1', slot = SLOT): BellNotice => ({ id, kind: 'done', slot: { id: slot, number: 7, sessionName: 'Session\nname', cwd: '/private/work', status: 'running', clients: 0, createdAt: '',
  transcript: 'DO_NOT_SEND_TRANSCRIPT', credentials: 'DO_NOT_SEND_CREDENTIALS' } as any });

test('Web Push uses persistent self-generated VAPID keys, device-scoped subscriptions, minimal payloads, and durable bell deduplication', async t => {
  const dir = await mkdtemp('/tmp/pi-push-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const devices = new DeviceStore(dir); const first = await device(devices, 'phone'); const second = await device(devices, 'tablet');
  const calls: { sub: any; payload: string; options: any }[] = [];
  const send = async (sub: any, payload: any, options: any) => { calls.push({ sub, payload, options }); return { statusCode: 201, body: '', headers: {} }; };
  const tabs = await tabsFor(dir, devices, first, second);
  const service = await PushService.open({ stateDir: dir, origin, devices, tabs, allowedLogins, send }); t.after(() => service.close());
  assert.equal((await stat(join(dir, 'push.json'))).mode & 0o777, 0o600);
  assert.equal(Buffer.from(service.publicKey, 'base64url').length, 65);
  for (const [paired, endpoint] of [[first, 'phone'], [second, 'tablet']] as const) {
    assert.equal((await call(service, devices, paired, '/api/push/subscribe', { subscription: subscription(`https://web.push.apple.com/${endpoint}`) })).status, 200);
  }
  const status = await call(service, devices, first, '/api/push');
  assert.equal(status.data.subscribed, true);
  assert.equal(JSON.stringify(status.data).includes('privateKey'), false);
  assert.equal(JSON.stringify(status.data).includes('endpoint'), false);
  await service.notify(notice()); await service.notify(notice());
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].payload), { version: 1, id: 'run-1', slotId: '79e35412-572b-4f77-a04f-a93f12e18c92', slotNumber: 7, sessionName: 'Session name', kind: 'done' });
  assert.equal(calls[0].options.vapidDetails.subject, origin);
  assert.equal(calls[0].options.TTL, 3600);
  assert.equal(calls[0].payload.includes('/private/work'), false);
  assert.equal(calls[0].payload.includes('DO_NOT_SEND'), false);
  await devices.revoke(first.id);
  await service.notify(notice('run-2'));
  assert.equal(calls.length, 3); assert.equal(calls[2].sub.endpoint, 'https://web.push.apple.com/tablet');
  await service.close();
  const reopened = await PushService.open({ stateDir: dir, origin, devices, tabs, allowedLogins, send }); t.after(() => reopened.close());
  assert.equal(reopened.publicKey, service.publicKey);
  await reopened.notify(notice('run-2')); assert.equal(calls.length, 3);
});

test('expired push endpoints are removed, transient failures retry with bounded backoff, and unsubscribe stops delivery', async t => {
  const dir = await mkdtemp('/tmp/pi-push-retry-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const devices = new DeviceStore(dir), paired = await device(devices, 'phone');
  let attempts = 0; const waits: number[] = [];
  let fail: number | undefined = 503;
  const service = await PushService.open({ stateDir: dir, origin, devices, tabs: await tabsFor(dir, devices, paired), allowedLogins,
    send: async () => { attempts++; if (fail && (fail === 410 || attempts < 3)) throw { statusCode: fail, message: 'PRIVATE_ENDPOINT_DIAGNOSTICS' }; return { statusCode: 201, body: '', headers: {} }; },
    delay: async ms => { waits.push(ms); } }); t.after(() => service.close());
  await call(service, devices, paired, '/api/push/subscribe', { subscription: subscription() });
  await service.notify(notice());
  assert.equal(attempts, 3); assert.deepEqual(waits, [1000, 2000]);
  fail = 410;
  await service.notify(notice('run-gone'));
  assert.equal(attempts, 4);
  assert.equal((await call(service, devices, paired, '/api/push')).data.subscribed, false);
  await service.notify(notice('run-after-gone')); assert.equal(attempts, 4);
  fail = undefined;
  await call(service, devices, paired, '/api/push/subscribe', { subscription: subscription() });
  await call(service, devices, paired, '/api/push/unsubscribe', {});
  await service.notify(notice('run-after-unsubscribe')); assert.equal(attempts, 4);
});

test('push endpoints cannot turn notification sending into a localhost or arbitrary HTTPS request', () => {
  const valid = subscription();
  for (const endpoint of ['http://web.push.apple.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://100.64.0.1/x',
    'https://web.push.apple.com.evil.test/x', 'https://web.push.apple.com:444/x', 'https://user:password@web.push.apple.com/x', 'https://web.push.apple.com/x#fragment']) {
    assert.throws(() => validateSubscription({ ...valid, endpoint }), /push endpoint/i, endpoint);
  }
  for (const host of ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']) {
    assert.equal(validateSubscription({ ...valid, endpoint: `https://${host}/token` }).endpoint, `https://${host}/token`);
  }
  assert.throws(() => validateSubscription({ ...valid, keys: { ...valid.keys, auth: 'invalid' } }), /Web Push key/);
  assert.throws(() => validateSubscription({ ...valid, keys: { ...valid.keys, p256dh: randomBytes(65).toString('base64url') } }), /Web Push public key/);
});

test('removing a Tailscale login also stops delivery to its previously registered devices', async t => {
  const dir = await mkdtemp('/tmp/pi-push-policy-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const devices = new DeviceStore(dir), paired = await device(devices, 'previously allowed');
  let sends = 0;
  const send = async () => { sends++; return { statusCode: 201, body: '', headers: {} }; };
  const tabs = await tabsFor(dir, devices, paired);
  const original = await PushService.open({ stateDir: dir, origin, devices, tabs, allowedLogins, send });
  await call(original, devices, paired, '/api/push/subscribe', { subscription: subscription() });
  await original.close();
  const restarted = await PushService.open({ stateDir: dir, origin, devices, tabs, allowedLogins: ['different-user@example.test'], send });
  t.after(() => restarted.close());
  await restarted.notify(notice('policy-change'));
  assert.equal(sends, 0, 'a valid device cookie must not bypass the current identity allowlist through push');
  assert.ok(await devices.get(paired.id), 'the identity policy, not device deletion, prevents delivery');
});

test('session notifications go only to devices that have that session open as a tab', async t => {
  const dir = await mkdtemp('/tmp/pi-push-tabs-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const devices = new DeviceStore(dir); const phone = await device(devices, 'phone'); const tablet = await device(devices, 'tablet');
  const other = '0b0f5c2e-3a51-4f0e-8d55-9d3f4b7c1a20';
  const tabs = await tabsFor(dir, devices, phone);
  const sent: string[] = [];
  const service = await PushService.open({ stateDir: dir, origin, devices, tabs, allowedLogins,
    send: async sub => { sent.push(sub.endpoint); return { statusCode: 201, body: '', headers: {} }; } });
  t.after(() => service.close());
  for (const [paired, name] of [[phone, 'phone'], [tablet, 'tablet']] as const) {
    await call(service, devices, paired, '/api/push/subscribe', { subscription: subscription(`https://web.push.apple.com/${name}`) });
  }
  await service.notify(notice('open-on-phone'));
  await service.notify(notice('open-nowhere', other));
  assert.deepEqual(sent, ['https://web.push.apple.com/phone']);
  await tabs.open(tablet.id, other); await tabs.close(phone.id, SLOT);
  await service.notify(notice('after-phone-closed'));
  await service.notify(notice('after-tablet-opened', other));
  assert.deepEqual(sent, ['https://web.push.apple.com/phone', 'https://web.push.apple.com/tablet']);
  // An explicit test notification is a user action, not a session subscription.
  await call(service, devices, phone, '/api/push/test', { slotId: other });
  assert.equal(sent.at(-1), 'https://web.push.apple.com/phone');
});

for (const change of ['unsubscribe', 'revoke', 'replace-keys', 'close-tab'] as const) {
  test(`${change} during delivery backoff cancels the previous subscription retry`, async t => {
    const dir = await mkdtemp('/tmp/pi-push-cancel-'); t.after(() => rm(dir, { recursive: true, force: true }));
    const devices = new DeviceStore(dir), paired = await device(devices, 'phone');
    let attempts = 0;
    const tabs = await tabsFor(dir, devices, paired);
    const service = await PushService.open({ stateDir: dir, origin, devices, tabs, allowedLogins,
      send: async () => { attempts++; throw { statusCode: 503 }; },
      delay: async () => {
        if (change === 'revoke') await devices.revoke(paired.id);
        else if (change === 'close-tab') await tabs.close(paired.id, SLOT);
        else await call(service, devices, paired, `/api/push/${change === 'unsubscribe' ? 'unsubscribe' : 'subscribe'}`,
          change === 'unsubscribe' ? {} : { subscription: subscription() });
      } });
    t.after(() => service.close());
    await call(service, devices, paired, '/api/push/subscribe', { subscription: subscription() });
    await service.notify(notice(`cancel-${change}`));
    assert.equal(attempts, 1, 'no outbound request may use authorization removed during the controlled retry wait');
  });
}
