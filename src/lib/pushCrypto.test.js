// src/lib/pushCrypto.test.js
//
// 5.11.102 push: the cryptography in _shared/pushCrypto.js. Web Push messages are decrypted here the
// way a browser does (RFC 8291) to prove the encryption; the JWTs are verified with the public key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { webPushHostOk } from '../../supabase/functions/_shared/webPushHosts.js';
import { b64u, es256Jwt, importP8, importVapidPrivate, apnsJwt, vapidAuthHeader, encryptWebPush, apnsHost, apnsPayload } from '../../supabase/functions/_shared/pushCrypto.js';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

async function verifyJwt(jwt, publicKey) {
  const [h, p, s] = jwt.split('.');
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64u.dec(s), te.encode(`${h}.${p}`));
}
const part = (jwt, i) => JSON.parse(new TextDecoder().decode(b64u.dec(jwt.split('.')[i])));

test('base64url round trips and has no padding', () => {
  const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
  assert.deepEqual(b64u.dec(b64u.enc(bytes)), bytes);
  assert.doesNotMatch(b64u.enc(bytes), /[+/=]/);
});

test('APNs provider token from a .p8 key: ES256, kid and iss, verifies with the public key', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const key = await importP8(pem.replace(/\n/g, '\\n'));   // a secret pasted with \n text still works
  const jwt = await apnsJwt({ keyId: 'BK8FTNHUJ3', teamId: 'LYQ8K25MGZ', key, now: 1_700_000_000_000 });
  assert.deepEqual(part(jwt, 0), { typ: 'JWT', alg: 'ES256', kid: 'BK8FTNHUJ3' });
  assert.deepEqual(part(jwt, 1), { iss: 'LYQ8K25MGZ', iat: 1_700_000_000 });
  const pub = await subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await verifyJwt(jwt, pub), true);
  await assert.rejects(importP8(''));
});

test('VAPID header: aud is the push service origin, exp within a day, k is our public key', async () => {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubRaw = b64u.enc(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const d = (await subtle.exportKey('jwk', kp.privateKey)).d;
  const key = await importVapidPrivate(pubRaw, d);
  const h = await vapidAuthHeader({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', subject: 'https://serv-os.app', publicKey: pubRaw, privateKey: key, now: 1_700_000_000_000 });
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.ok(m && m[2] === pubRaw);
  assert.deepEqual(part(m[1], 1), { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://serv-os.app' });
  assert.equal(await verifyJwt(m[1], kp.publicKey), true);
  await assert.rejects(importVapidPrivate('AAAA', d));
});

async function hkdf(salt, ikm, info, n) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, n * 8));
}
// What a browser does with the body (RFC 8291 section 3 and RFC 8188).
async function browserDecrypt(body, uaKeys, authSecret) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await subtle.exportKey('raw', uaKeys.publicKey));
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeys.privateKey, 256));
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(authSecret, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  assert.equal(pt[pt.length - 1], 2, 'the last record delimiter');
  return { rs, text: new TextDecoder().decode(pt.slice(0, -1)) };
}

test('Web Push encryption decrypts in a browser to the same message, fresh salt and keys each time', async () => {
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const sub = { p256dh: b64u.enc(new Uint8Array(await subtle.exportKey('raw', ua.publicKey))), auth: b64u.enc(auth) };
  const msg = JSON.stringify({ title: 'Cara in Leeds', body: 'Fire drill at 3', data: { c: 'x' } });
  const a = await encryptWebPush({ ...sub, payload: msg });
  const b = await encryptWebPush({ ...sub, payload: msg });
  assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16), 'a fresh salt per message');
  const out = await browserDecrypt(a, ua, auth);
  assert.equal(out.text, msg);
  assert.equal(out.rs, 4096);
  await assert.rejects(encryptWebPush({ p256dh: 'AAAA', auth: sub.auth, payload: 'x' }));
  await assert.rejects(encryptWebPush({ ...sub, payload: 'x'.repeat(5000) }));
});

test('APNs: the host follows the device environment; the payload carries title, body and data', () => {
  assert.equal(apnsHost('sandbox'), 'api.sandbox.push.apple.com');
  assert.equal(apnsHost('production'), 'api.push.apple.com');
  assert.equal(apnsHost(undefined), 'api.push.apple.com');
  const p = apnsPayload({ title: 'Dev', body: 'hi', threadId: 'c1', data: { conversation_id: 'c1' }, urgent: true });
  assert.deepEqual(p, { aps: { alert: { title: 'Dev', body: 'hi' }, sound: 'default', 'thread-id': 'c1', 'interruption-level': 'time-sensitive' }, conversation_id: 'c1' });
});

test('es256Jwt signs any header and payload', async () => {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwt = await es256Jwt({ kid: 'k' }, { a: 1 }, kp.privateKey);
  assert.equal(await verifyJwt(jwt, kp.publicKey), true);
  assert.equal(jwt.split('.')[2].length, 86, 'a 64 byte raw signature');
});

test('review fix S7: Web Push only to the browsers\' own push services', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/QK', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.equal(webPushHostOk(ok), true, ok);
  }
  for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x',
    'https://user@web.push.apple.com/x', 'https://169.254.169.254/latest', 'not a url', '', null]) {
    assert.equal(webPushHostOk(bad), false, String(bad));
  }
});
