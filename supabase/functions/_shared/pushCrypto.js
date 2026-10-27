// supabase/functions/_shared/pushCrypto.js
// MARKER 5.11.102 push crypto
//
// The cryptography for app push (5.11.102), pure JavaScript on Web Crypto (the same in Deno and in
// Node), so src/lib/pushCrypto.test.js proves it without a network:
//   * ES256 JSON Web Tokens: the APNs provider token (the .p8 key) and the Web Push VAPID token.
//   * Web Push message encryption, RFC 8291 (aes128gcm, RFC 8188): a phone's push service only ever
//     sees ciphertext.
//   * The APNs payload shape.
// No Firebase anywhere: iOS goes straight to Apple, Android and browsers through the standard Web
// Push protocol with our own VAPID keys.

const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();

export const b64u = {
  enc(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** An ES256 JWT signed with a P-256 private CryptoKey (Web Crypto gives the raw r||s JWS wants). */
export async function es256Jwt(header, payload, privateKey) {
  const head = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256', ...header })));
  const body = b64u.enc(te.encode(JSON.stringify(payload)));
  const sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, te.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u.enc(new Uint8Array(sig))}`;
}

/** The APNs .p8 key (PEM, PKCS 8) as a signing key. Line breaks may arrive as "\n" text. */
export async function importP8(pem) {
  const clean = String(pem || '').replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  if (!clean) throw new Error('no APNs key');
  return subtle().importKey('pkcs8', b64u.dec(clean.replace(/\+/g, '-').replace(/\//g, '_')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The VAPID private key (the 32 byte d, base64url) with its public key (65 byte raw, base64url). */
export async function importVapidPrivate(publicB64u, privateB64u) {
  const pub = b64u.dec(publicB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('bad VAPID public key');
  const jwk = { kty: 'EC', crv: 'P-256', d: privateB64u, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true };
  return subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The APNs provider token: kid = Key ID, iss = Team ID, iat now (Apple accepts it for up to an hour). */
export async function apnsJwt({ keyId, teamId, key, now = Date.now() }) {
  return es256Jwt({ kid: keyId }, { iss: teamId, iat: Math.floor(now / 1000) }, key);
}

/** The Web Push Authorization header (RFC 8292): vapid t=<jwt>, k=<public key>. */
export async function vapidAuthHeader({ endpoint, subject, publicKey, privateKey, now = Date.now(), ttlSeconds = 12 * 3600 }) {
  const aud = new URL(endpoint).origin;
  const t = await es256Jwt({}, { aud, exp: Math.floor(now / 1000) + ttlSeconds, sub: subject }, privateKey);
  return `vapid t=${t}, k=${publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * Encrypt one Web Push message (RFC 8291). p256dh and auth come from the browser's subscription
 * (base64url). Returns the request body: salt | record size | key id length | our public key | ciphertext.
 * asKeyPair and salt may be given (tests); normally fresh ones are made for every message.
 */
export async function encryptWebPush({ p256dh, auth, payload, salt = null, asKeyPair = null, recordSize = 4096 }) {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const kp = asKeyPair || await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  const uaKey = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const s = salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(s, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(s, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const data = typeof payload === 'string' ? te.encode(payload) : payload;
  if (data.length > recordSize - 17 - 86) throw new Error('payload too large');
  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, recordSize);
  return concat(s, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export const apnsHost = (environment) => (environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com');

/** The APNs JSON body. data rides along for the app (conversation id, kind) outside aps. */
export function apnsPayload({ title, body, threadId = null, data = {}, urgent = false }) {
  const aps = { alert: { title: String(title || '').slice(0, 120), body: String(body || '').slice(0, 300) }, sound: 'default' };
  if (threadId) aps['thread-id'] = String(threadId);
  if (urgent) aps['interruption-level'] = 'time-sensitive';
  return { aps, ...data };
}
