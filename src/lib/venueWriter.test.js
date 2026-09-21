// venueWriter.test.js — who may write at a venue, and who may not.
//
// The live fault this rule was written for (21 Sep 2026): Coffee Boy Barnsley
// Train Station refused every save with "no access to this location" because its
// owner held one user_locations row, for a different venue. Nine edge functions
// each carried their own copy of the check and every one of them said no.
//
// These tests hold the two halves together: the decision must grant an owner
// their own organisation, and must never grant anything to an anonymous session,
// whose profile row is stamped 'owner' by the insert default.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decideVenueWriter, isVenueWriter } from '../../supabase/functions/_shared/venueWriter.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const user = { id: 'u1' };
const base = { user, role: 'manager', orgId: null, linked: false, venueOrgId: 'ORG-A' };

test('a link row is access, whatever the role', () => {
  assert.deepEqual(decideVenueWriter({ ...base, linked: true }), { ok: true, via: 'user_locations' });
  assert.deepEqual(decideVenueWriter({ ...base, role: 'staff', linked: true }), { ok: true, via: 'user_locations' });
});

test('a super admin holds every venue', () => {
  assert.deepEqual(decideVenueWriter({ ...base, role: 'super_admin' }), { ok: true, via: 'super_admin' });
  // even one with no organisation of its own
  assert.deepEqual(decideVenueWriter({ ...base, role: 'super_admin', venueOrgId: null }), { ok: true, via: 'super_admin' });
});

test('an owner holds every venue in their own organisation', () => {
  assert.deepEqual(
    decideVenueWriter({ ...base, role: 'owner', orgId: 'ORG-A', venueOrgId: 'ORG-A' }),
    { ok: true, via: 'owner_org' },
  );
});

test('an owner holds NOTHING in another organisation', () => {
  assert.equal(decideVenueWriter({ ...base, role: 'owner', orgId: 'ORG-B', venueOrgId: 'ORG-A' }).ok, false);
});

test('a manager does not get the whole company', () => {
  assert.equal(decideVenueWriter({ ...base, role: 'manager', orgId: 'ORG-A', venueOrgId: 'ORG-A' }).ok, false);
});

test('a null organisation on either side is never a match', () => {
  // Kiosk, online and QR sessions hold a profile row stamped 'owner' with no org.
  assert.equal(decideVenueWriter({ ...base, role: 'owner', orgId: null, venueOrgId: null }).ok, false);
  assert.equal(decideVenueWriter({ ...base, role: 'owner', orgId: 'ORG-A', venueOrgId: null }).ok, false);
});

test('an anonymous session is never a writer, whatever its profile says', () => {
  const anon = { id: 'anon1', is_anonymous: true };
  assert.equal(decideVenueWriter({ ...base, user: anon, role: 'super_admin' }).ok, false);
  assert.equal(decideVenueWriter({ ...base, user: anon, role: 'owner', orgId: 'ORG-A', venueOrgId: 'ORG-A' }).ok, false);
  assert.equal(decideVenueWriter({ ...base, user: anon, linked: true }).ok, false);
});

test('no user at all is not a writer', () => {
  assert.equal(decideVenueWriter({ ...base, user: null }).ok, false);
  assert.equal(decideVenueWriter(null).ok, false);
});

// ── against a fake client, the shape the edge functions actually call ───────
const clientWith = ({ ul = null, prof = null, loc = null, throws = false }) => ({
  from(table) {
    const answer = { user_locations: ul, user_profiles: prof, locations: loc }[table] ?? null;
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => {
        if (throws) throw new Error('network');
        return { data: answer };
      },
    };
    return chain;
  },
});

test('isVenueWriter: the owner of the venue org passes with no link row', async () => {
  const ops = clientWith({ ul: null, prof: { role: 'owner', org_id: 'ORG-A' }, loc: { org_id: 'ORG-A' } });
  assert.equal(await isVenueWriter(ops, user, 'LOC-1'), true);
});

test('isVenueWriter: an owner of a different company is refused', async () => {
  const ops = clientWith({ ul: null, prof: { role: 'owner', org_id: 'ORG-B' }, loc: { org_id: 'ORG-A' } });
  assert.equal(await isVenueWriter(ops, user, 'LOC-1'), false);
});

test('isVenueWriter: a failed read is "not a writer", never a crash', async () => {
  const ops = clientWith({ throws: true });
  assert.equal(await isVenueWriter(ops, user, 'LOC-1'), false);
});

test('isVenueWriter: missing arguments refuse without touching the database', async () => {
  assert.equal(await isVenueWriter(null, user, 'LOC-1'), false);
  assert.equal(await isVenueWriter(clientWith({}), null, 'LOC-1'), false);
  assert.equal(await isVenueWriter(clientWith({}), user, ''), false);
});

// ── the copies are gone ────────────────────────────────────────────────────
test('no edge function keeps its own copy of the venue access check', () => {
  const fns = ['location-admin', 'marketing-campaigns', 'marketing-segments', 'marketing-compliance',
    'marketing-domains', 'review-admin', 'review-google', 'review-sync', 'review-request'];
  for (const fn of fns) {
    const src = read(`../../supabase/functions/${fn}/index.ts`);
    assert.match(src, /isVenueWriter/, `${fn} must use the shared rule`);
    assert.doesNotMatch(
      src,
      /role === 'super_admin'/,
      `${fn} still decides venue access on its own — it will refuse an owner at a new venue`,
    );
  }
});

test('the migration that matches this rule is in the repo', () => {
  const sql = read('../../supabase/migrations/20260921u_OPS_owner_holds_own_company.sql');
  assert.match(sql, /p\.role = 'owner'/);
  assert.match(sql, /l\.org_id = p\.org_id/);
  assert.match(sql, /is_super_admin\(\)/);
  // additive only: the existing arms must still be there
  assert.match(sql, /from public\.user_locations ul/);
});
