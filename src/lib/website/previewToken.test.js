// node --test: the /preview token website-admin issues (HMAC SHA-256 over site id + expiry,
// hex, 30 minutes). The same code signs in Deno and verifies in Node (api/site.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { signPreviewToken, verifyPreviewToken, LIMITS } from '../../../supabase/functions/_shared/websiteRules.js';

const SITE = '6f1c2a40-9b7e-4c3a-9a1e-2b6d4e8f0a11';
const SECRET = 'test-secret-do-not-use';
const NOW = Date.parse('2026-10-31T10:00:00Z');

test('round trip: a signed token verifies and names the site', async () => {
  const { token, expires_at } = await signPreviewToken(SITE, SECRET, { now: NOW });
  assert.match(token, /^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/);
  assert.equal(expires_at, new Date(NOW + LIMITS.PREVIEW_TOKEN_MS).toISOString());
  assert.equal(LIMITS.PREVIEW_TOKEN_MS, 30 * 60 * 1000);
  const v = await verifyPreviewToken(token, SECRET, { now: NOW + 60_000 });
  assert.deepEqual(v, { ok: true, site_id: SITE });
});

test('expired, tampered, wrong secret and malformed tokens are refused without throwing', async () => {
  const { token } = await signPreviewToken(SITE, SECRET, { now: NOW });
  assert.deepEqual(await verifyPreviewToken(token, SECRET, { now: NOW + LIMITS.PREVIEW_TOKEN_MS + 1 }), { ok: false, reason: 'expired' });
  assert.deepEqual(await verifyPreviewToken(token, 'other', { now: NOW }), { ok: false, reason: 'bad_signature' });
  const [id, exp, sig] = token.split('.');
  const later = `${id}.${Number(exp) + 100000}.${sig}`;
  assert.deepEqual(await verifyPreviewToken(later, SECRET, { now: NOW }), { ok: false, reason: 'bad_signature' });
  const otherSite = `${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}.${exp}.${sig}`;
  assert.deepEqual(await verifyPreviewToken(otherSite, SECRET, { now: NOW }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(await verifyPreviewToken('nonsense', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(await verifyPreviewToken('', SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(await verifyPreviewToken(null, SECRET), { ok: false, reason: 'malformed' });
  assert.deepEqual(await verifyPreviewToken(token, '', { now: NOW }), { ok: false, reason: 'no_secret' });
});

test('signing needs a site id and a secret', async () => {
  await assert.rejects(() => signPreviewToken('not-a-uuid', SECRET), /site id/);
  await assert.rejects(() => signPreviewToken(SITE, ''), /WEBSITE_PREVIEW_SECRET/);
});
