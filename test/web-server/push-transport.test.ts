import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import webpush from 'web-push';
import { validateSubscription } from '../../src/web-server/push.js';

test('real Web Push transport uses the validated canonical endpoint, never a null hostname or localhost', async t => {
  const requests: RequestOptions[] = [];
  let encryptedBytes = 0;
  // Keep web-push's URL parsing, encryption, VAPID signing, and request construction real.
  // Replace only the final HTTPS transport so this regression cannot access the network.
  t.mock.method(https, 'request', (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    requests.push(options);
    const request = new Writable({
      write(chunk: Buffer, _encoding, done) { encryptedBytes += chunk.length; done(); },
    });
    request.once('finish', () => {
      const response = new PassThrough();
      Object.assign(response, { statusCode: 201, headers: {} });
      onResponse(response as unknown as IncomingMessage);
      response.end();
    });
    return request as unknown as ClientRequest;
  });

  const curve = createECDH('prime256v1'); curve.generateKeys();
  const keys = { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  const vapidDetails = { subject: 'https://devbox.example.test', ...webpush.generateVAPIDKeys() };
  for (const endpoint of ['https:/web.push.apple.com/probe', 'https:web.push.apple.com/probe', 'https://web.push.apple.com/probe']) {
    const subscription = validateSubscription({ endpoint, keys });
    assert.equal(subscription.endpoint, 'https://web.push.apple.com/probe');
    const result = await webpush.sendNotification(subscription, 'Transport regression', { vapidDetails });
    assert.equal(result.statusCode, 201);
  }

  assert.equal(requests.length, 3);
  for (const options of requests) {
    assert.equal(options.hostname, 'web.push.apple.com');
    assert.ok(options.port == null || String(options.port) === '443');
    assert.equal(options.path, '/probe');
    assert.equal(options.method, 'POST');
  }
  assert.ok(encryptedBytes > 0, 'real web-push encryption must produce the outgoing body');
});
