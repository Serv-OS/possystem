// src/lib/signupGate.test.js
// 5.11.123: sign ups are closed by the Before User Created hook; anonymous sign ins always pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { decideUserCreation, maskEmail, parseHookSecrets, verifyStandardWebhook, signStandardWebhook, CLOSED_MESSAGE } from '../../supabase/functions/_shared/signupGate.js';

const subtle = webcrypto.subtle;
const anonUser = { id: 'u1', aud: 'authenticated', email: '', is_anonymous: true, app_metadata: { provider: 'anonymous', providers: ['anonymous'] } };
const emailUser = { id: 'u2', aud: 'authenticated', email: 'someone@example.com', is_anonymous: false, app_metadata: { provider: 'email', providers: ['email'] } };
const wrap = (user) => ({ metadata: { uuid: 'x', time: '2026-10-30T00:00:00Z', name: 'before-user-created', ip_address: '1.2.3.4' }, user });

test('anonymous sign in is allowed (kiosk, online, QR, gift, catering keep working)', () => {
  assert.deepEqual(decideUserCreation(wrap(anonUser)), { allow: true, status: 200, body: {}, reason: 'anonymous', who: '' });
  // Older payload shape: no is_anonymous flag, provider says it.
  assert.equal(decideUserCreation(wrap({ ...anonUser, is_anonymous: undefined })).allow, true);
  assert.equal(decideUserCreation(wrap({ ...anonUser, is_anonymous: undefined, app_metadata: { providers: ['anonymous'] } })).allow, true);
});

test('an email sign up is refused with the plain message, 403, http_code in the body', () => {
  const d = decideUserCreation(wrap(emailUser));
  assert.equal(d.allow, false); assert.equal(d.status, 403); assert.equal(d.reason, 'closed');
  assert.deepEqual(d.body, { error: { message: CLOSED_MESSAGE, http_code: 403 } });
  assert.equal(d.who, 's***@e***.com');
  assert.ok(!CLOSED_MESSAGE.includes('!'));
});

test('magic link, OAuth and invite users are refused too; a broken payload is refused, never allowed', () => {
  for (const u of [
    { ...emailUser, app_metadata: { provider: 'google', providers: ['google'] } },
    { ...emailUser, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { invited: true } },
    { ...emailUser, is_anonymous: false, app_metadata: {} },
  ]) assert.equal(decideUserCreation(wrap(u)).allow, false, JSON.stringify(u.app_metadata));
  assert.equal(decideUserCreation(null).allow, false);
  assert.equal(decideUserCreation({}).allow, false);
  assert.equal(decideUserCreation({ user: null }).allow, false);
  // A person who is anonymous AND has an email is not anonymous.
  assert.equal(decideUserCreation(wrap({ ...emailUser, is_anonymous: false, app_metadata: { provider: 'email', providers: ['email', 'anonymous'] } })).allow, false);
});

test('maskEmail shows a pattern, never the address', () => {
  assert.equal(maskEmail('peter@posup.co.uk'), 'p***@p***.uk');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail('nonsense'), 'n***');
});

test('secrets: the dashboard form, several, and the raw base64', () => {
  const raw = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  assert.equal(parseHookSecrets(`v1,whsec_${raw}`).length, 1);
  assert.equal(parseHookSecrets(`v1,whsec_${raw}|v1,whsec_${raw}`).length, 2);
  assert.equal(parseHookSecrets(raw).length, 1);
  assert.equal(parseHookSecrets('').length, 0);
  assert.equal(Buffer.from(parseHookSecrets(`v1,whsec_${raw}`)[0]).toString(), '0123456789abcdef0123456789abcdef');
});

test('signature: a request signed as Supabase signs it passes; a tampered body, an old timestamp or no secret does not', async () => {
  const secret = `v1,whsec_${Buffer.from('a-32-byte-secret-for-the-hook-ok').toString('base64')}`;
  const rawBody = JSON.stringify(wrap(emailUser));
  const nowS = 1_800_000_000;
  const sig = await signStandardWebhook({ id: 'msg_1', ts: String(nowS), rawBody, secret, subtle });
  const headers = new Map([['webhook-id', 'msg_1'], ['webhook-timestamp', String(nowS)], ['webhook-signature', sig]]);
  const secrets = parseHookSecrets(secret);
  assert.deepEqual(await verifyStandardWebhook({ headers, rawBody, secrets, nowS, subtle }), { ok: true, why: 'ok' });
  assert.equal((await verifyStandardWebhook({ headers, rawBody: rawBody + ' ', secrets, nowS, subtle })).why, 'bad_signature');
  assert.equal((await verifyStandardWebhook({ headers, rawBody, secrets, nowS: nowS + 6 * 60, subtle })).why, 'timestamp');
  assert.equal((await verifyStandardWebhook({ headers, rawBody, secrets: [], nowS, subtle })).why, 'no_secret');
  assert.equal((await verifyStandardWebhook({ headers: new Map(), rawBody, secrets, nowS, subtle })).why, 'missing_headers');
  // Two signatures in the header (key rotation): any match passes.
  const two = new Map(headers); two.set('webhook-signature', `v1,AAAA ${sig}`);
  assert.equal((await verifyStandardWebhook({ headers: two, rawBody, secrets, nowS, subtle })).ok, true);
});

test('the function answers from the payload even when the signature fails, logs one masked line, and is deployed without JWT checks', () => {
  const fn = readFileSync(new URL('../../supabase/functions/auth-before-user-created/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /const sig = await verifyStandardWebhook\(/);
  assert.match(fn, /const d = decideUserCreation\(payload\);/);
  assert.match(fn, /return json\(d\.body, d\.status\);/);
  assert.ok(!/if \(!sig\.ok\) return/.test(fn), 'a bad signature never changes the answer (a wrong secret must not take the kiosks down)');
  assert.match(fn, /who: d\.who/);
  assert.ok(!/payload\?\.user\?\.email/.test(fn), 'the address itself is never logged');
  assert.match(fn, /--no-verify-jwt/);
  assert.match(fn, /BEFORE_USER_CREATED_HOOK_SECRET/);
});

test('every account ServOS makes goes through auth.admin.createUser, which the hook never sees', () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.match(read('supabase/functions/create-user/index.ts'), /auth\.admin\.createUser\(/);
  assert.match(read('supabase/functions/staff-portal/index.ts'), /auth\.admin\.createUser\(/);
  // No client code signs up with an email or a provider; only anonymous.
  const client = ['src/lib/authSession.js', 'src/surfaces/gift/GiftPurchaseSurface.jsx', 'src/surfaces/online/OnlineCheckout.jsx'].map(read).join('\n');
  assert.ok(!/\.signUp\(|signInWithOtp\(|signInWithOAuth\(/.test(client));
  assert.match(client, /signInAnonymously\(\)/);
});
