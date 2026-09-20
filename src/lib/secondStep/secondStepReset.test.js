// src/lib/secondStep/secondStepReset.test.js
// Lost phone recovery rules (supabase/functions/_shared/second-step-reset-rules.ts), plus
// static checks on the second-step-reset edge function that uses them (docs/SECOND_STEP.md).
// Whoever can reset you can, with your password, become you: so the rules are strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  resetDecision, ownedVenues, reachableVenues, hasOwnerLevelLink, factorSummary, STAFF_ROLES,
} from '../../../supabase/functions/_shared/second-step-reset-rules.ts';

const A = 'venue-a';
const B = 'venue-b';
const owner = (id, venues, extra = []) => ({ id, isSuperAdmin: false, links: [...venues.map((v) => ({ venueId: v, role: 'owner' })), ...extra] });
const staff = (id, venues, role = 'manager', profileVenueId = null) => ({ id, isSuperAdmin: false, links: venues.map((v) => ({ venueId: v, role })), profileVenueId });
const servos = (id) => ({ id, isSuperAdmin: true, links: [] });

test('nobody resets themselves this way, not even ServOS', () => {
  assert.equal(resetDecision(owner('o1', [A]), { ...staff('o1', [A]) }).code, 'self');
  assert.equal(resetDecision(servos('s1'), { ...servos('s1') }).code, 'self');
});

test('a ServOS super admin may reset anyone else: owners and other super admins included', () => {
  assert.equal(resetDecision(servos('s1'), owner('o1', [A])).ok, true);
  assert.equal(resetDecision(servos('s1'), servos('s2')).ok, true);
  assert.equal(resetDecision(servos('s1'), staff('m1', [A])).ok, true);
  assert.equal(resetDecision(servos('s1'), staff('lonely', [])).ok, true, 'even a login with no venue');
});

test('an owner may reset staff whose every venue they own', () => {
  assert.deepEqual(resetDecision(owner('o1', [A]), staff('m1', [A])), { ok: true, code: 'ok', reason: 'Owner of every venue they can reach' });
  assert.equal(resetDecision(owner('o1', [A, B]), staff('m1', [A, B])).ok, true);
  assert.equal(resetDecision(owner('o1', [A]), staff('m1', [A], 'Staff')).ok, true, 'role names are case blind');
  assert.equal(resetDecision(owner('o1', [A]), staff('m1', [A]), A).ok, true, 'acting from their venue');
});

test('an owner may NOT reset an owner, a super admin, or anyone above manager or staff', () => {
  assert.equal(resetDecision(owner('o1', [A]), owner('o2', [A])).code, 'super_admin_only');
  assert.equal(resetDecision(owner('o1', [A]), servos('s1')).code, 'super_admin_only');
  assert.equal(resetDecision(owner('o1', [A]), staff('x', [A], 'admin')).code, 'super_admin_only');
  assert.equal(resetDecision(owner('o1', [A]), staff('x', [A], null)).code, 'super_admin_only', 'an unknown role is treated as senior');
  // a manager here who OWNS another business's venue
  const mixed = { id: 'm1', isSuperAdmin: false, links: [{ venueId: A, role: 'manager' }, { venueId: B, role: 'owner' }] };
  assert.equal(resetDecision(owner('o1', [A]), mixed).code, 'super_admin_only');
});

test('an owner may NOT reset someone who can also reach a venue they do not own', () => {
  assert.equal(resetDecision(owner('o1', [A]), staff('m1', [A, B])).code, 'not_your_staff');
  // user_accessible_locations() also lets user_profiles.location_id in: that venue counts too
  assert.equal(resetDecision(owner('o1', [A]), staff('m1', [A], 'manager', B)).code, 'not_your_staff');
  assert.equal(resetDecision(owner('o1', [A]), staff('m1', [A], 'manager', A)).ok, true);
  // acting from a venue the target does not work at
  assert.equal(resetDecision(owner('o1', [A, B]), staff('m1', [A]), B).code, 'not_your_staff');
});

test('managers cannot reset anyone; a login with no venue is ServOS only', () => {
  const manager = staff('boss', [A]);
  assert.equal(resetDecision(manager, staff('m1', [A])).code, 'not_owner');
  assert.equal(resetDecision(owner('o1', [A]), staff('ghost', [])).code, 'super_admin_only');
  assert.equal(resetDecision(owner('o1', [A]), { id: '', isSuperAdmin: false, links: [] }).code, 'bad_request');
});

test('user_profiles.role "owner" (the sign up default) grants nothing: only owner venue links do', () => {
  // the caller's profile may say owner, but with only manager links they own nothing
  const profileOwner = { id: 'p1', isSuperAdmin: false, links: [{ venueId: A, role: 'manager' }] };
  assert.equal(resetDecision(profileOwner, staff('m1', [A])).code, 'not_owner');
});

test('helpers: owned and reachable venues, owner level links, factor counts', () => {
  assert.deepEqual([...ownedVenues([{ venueId: A, role: 'OWNER' }, { venueId: B, role: 'manager' }])], [A]);
  assert.deepEqual([...reachableVenues({ links: [{ venueId: A, role: 'manager' }], profileVenueId: B })].sort(), [A, B]);
  assert.equal(hasOwnerLevelLink([{ venueId: A, role: 'manager' }, { venueId: B, role: 'staff' }]), false);
  assert.equal(hasOwnerLevelLink([{ venueId: A, role: 'owner' }]), true);
  assert.deepEqual([...STAFF_ROLES].sort(), ['manager', 'staff']);
  assert.deepEqual(factorSummary([
    { factor_type: 'totp', status: 'verified' }, { factor_type: 'webauthn', status: 'verified' },
    { factor_type: 'totp', status: 'unverified' }, { factor_type: 'phone', status: 'verified' },
  ]), { authenticator_app: 1, face_id: 1, other: 1, passkeys: 0, set_up: true });
  assert.deepEqual(factorSummary(null), { authenticator_app: 0, face_id: 0, other: 0, passkeys: 0, set_up: false });
  // A passkey is a second step on its own: somebody with nothing but a passkey IS set up.
  assert.deepEqual(factorSummary(null, 2), { authenticator_app: 0, face_id: 0, other: 0, passkeys: 2, set_up: true });
});

test('a reset takes the passkeys too, and never reports a clean reset when one is left behind', () => {
  const src = fs.readFileSync(new URL('../../../supabase/functions/second-step-reset/index.ts', import.meta.url), 'utf8');
  // A lost phone may hold a passkey, and a passkey signs in with no password at all.
  assert.match(src, /removePasskeys\(targetId, webauthnGone\)/, 'the reset must clear passkeys');
  assert.match(src, /second_step_passkeys/, 'our own record of who holds a passkey');
  assert.match(src, /if \(keys\.left > 0 && outcome !== 'failed'\) outcome = 'partial'/, 'a passkey left behind is a partial reset');
  assert.match(src, /passkeys_left/, 'the operator is told how many are still out there');
  // The team list counts passkeys, so a passkey only person does not read as "not set up".
  assert.match(src, /factorSummary\(t\.user\.factors, passkeyCount\.get\(id\) \?\? 0\)/);
});

test('the second-step-reset function: aal2 always, getUser, audit before removing, rules from the shared file', () => {
  const src = fs.readFileSync(new URL('../../../supabase/functions/second-step-reset/index.ts', import.meta.url), 'utf8');
  const need = src.indexOf('requireAal2(req');
  const getUser = src.indexOf('admin.auth.getUser(');
  const decide = src.indexOf('resetDecision(caller, t.target, locationId)');
  const audit = src.indexOf("from('second_step_resets').insert(");
  const del = src.indexOf('admin.auth.admin.mfa.deleteFactor(');
  assert.ok(need > 0 && getUser > need, 'the aal2 check comes first, then the token is proven with getUser');
  assert.ok(decide > 0 && audit > decide && del > audit, 'decide, then audit, then remove');
  assert.match(src, /if \(me\.is_anonymous\)/, 'anonymous callers refused');
  assert.match(src, /Nothing was reset/, 'no audit table means no reset');
  assert.match(src, /send-receipt/, 'the person is emailed');
  assert.doesNotMatch(src, /console\.(log|info)\([^)]*email/i, 'no personal data in logs');
});
