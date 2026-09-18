// Lockdown step 1 (18 Sep 2026, Peter: "ok yes then build whats needed").
// Pins every rule of the step:
//   1. the profile venue field is locked: user_accessible_locations() is user_locations only, a
//      login reads and updates only its own profile (full_name), the venue, company and Back
//      Office access columns are written only by the server (profile-admin), and every Back
//      Office screen that changed them goes through it, with the Back Office's own session
//   2. online gift card purchases (and their codes) are readable only by the server
//   3. the promo code wildcard is gone: exact code, the venue's own company only
//   4. the gift card branch is finished: no profile staff arm (a), WiFi Join rewards reads the
//      org from Ops (b), one card per purchase and processor outages retried (e), the refund
//      toast says what staff can do (f), the authority report sees till earn and gift-redeem (g)
// Edge functions cannot run under node, so their decisions live in pure _shared modules tested
// here, and the wiring is pinned by reading the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  decideSignedIn, decideSetActiveLocation, decideClaimOrg, decideAdoptLocation,
  decideSetBoAccess, decideTeamRead, decideAdminSetLocation,
} from '../../supabase/functions/_shared/profileAdmin.ts';
import { normalisePromoCode, escapeLike, promoRowMatches, pickPromoRow } from '../../supabase/functions/_shared/promoLookup.ts';
import {
  purchaseCardId, issueLedgerKey, proofReasonRetryable, processorErrorReason, fulfilResponseRetryable,
} from '../../supabase/functions/_shared/giftFulfilPlan.ts';
import { opsIdsOf, companyOrgIds, locationInCompany, customerInCompany } from '../../supabase/functions/_shared/orgScope.ts';
import { callProfileAdmin, backOfficeToken, staffScreenLocation, PROFILE_ADMIN_UNREACHABLE } from './profileAdmin.js';
import { purchasesFromGiftList } from './giftPurchasesRead.js';
import { giftReversalFailedMessage } from './giftCommit.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const sqlCode = (src) => src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const fnSrc = (name) => code(read(`../../supabase/functions/${name}/index.ts`));

const me = { id: '00000000-0000-4000-8000-0000000000a1', is_anonymous: false };
const anon = { id: '00000000-0000-4000-8000-0000000000a2', is_anonymous: true };
const LOC = '33333333-3333-4333-8333-333333333333';
const LOC2 = '55555555-5555-4555-8555-555555555555';
const ORG = '66666666-6666-4666-8666-666666666666';
const ORG2 = '77777777-7777-4777-8777-777777777777';

// ── 1. The Ops migration ──────────────────────────────────────────────────────
test('ops migration: one transaction with a lock timeout, pinned backfill first, access is user_locations plus super admin, profiles own row only, venue columns server only', () => {
  const raw = read('../../supabase/migrations/20260918d_OPS_profile_venue_lock.sql');
  const sql = sqlCode(raw).toLowerCase();
  // One transaction, and it never queues behind a long lock (every till reads user_profiles).
  const b = sql.search(/^begin;$/m);
  const lt = sql.indexOf("set local lock_timeout = '5s';");
  const c = sql.search(/^commit;$/m);
  assert.ok(b >= 0 && lt > b && c > lt, 'begin; set local lock_timeout; ... commit;');
  for (const k of ['create policy', 'drop policy', 'revoke ', 'create trigger', 'create or replace function', 'insert into public.user_locations', 'drop function']) {
    assert.ok(sql.indexOf(k) > lt && sql.lastIndexOf(k) < c, `${k} inside the transaction, after the lock timeout`);
  }
  assert.ok(sql.includes("to_regclass('public.billing_state') is not null"), 'refuses to run on the Platform DB');

  // Backfill BEFORE the function stops reading the profile, PINNED to the confirmed ids.
  const backfill = sql.indexOf('insert into public.user_locations (user_id, location_id, role)');
  const fn = sql.indexOf('create or replace function public.user_accessible_locations()');
  assert.ok(backfill > 0 && fn > backfill, 'the legacy owner keeps access: backfill runs first');
  assert.ok(sql.includes('v_confirmed uuid[] := array[]::uuid[];'), 'ships with NO confirmed id: Peter pastes the one he checked');
  assert.ok(sql.includes("coalesce(p.role, '') <> 'super_admin'"), 'a super admin is never a candidate');
  assert.ok(sql.includes('not coalesce(u.is_anonymous, false)'), 'real logins only');
  assert.ok(/where not \(user_id = any\(v_confirmed\)\);\s+if v_count > 0 then\s+raise exception 'stopped, nothing changed/.test(sql), 'an unconfirmed candidate stops everything');
  assert.ok(sql.includes("raise exception 'stopped, nothing changed. these confirmed ids are not candidates"), 'a typo stops everything');
  const ins = sql.slice(backfill, sql.indexOf('on conflict (user_id, location_id) do nothing;', backfill));
  assert.ok(ins.includes('where k.user_id = any(v_confirmed)'), 'only confirmed ids are inserted');
  assert.ok(raw.includes('supabase/queries/profile_venue_backfill_candidates.sql'), 'names the read only list to check first');
  assert.ok(read('../../supabase/queries/profile_venue_backfill_candidates.sql').toLowerCase().includes("coalesce(p.role, '') <> 'super_admin'"), 'the list matches the migration');

  // Every historical permissive policy name goes, then anything else permissive that is live.
  for (const name of ['"allow authenticated access"', '"allow all"', '"users read own profile"', '"users update own profile"',
    'up_select_self', 'up_select_super_admin', 'up_update_self', 'up_update_super_admin', 'user_profiles_super_admin_select_all']) {
    assert.ok(sql.includes(`drop policy if exists ${name} on public.user_profiles;`), name);
  }
  assert.ok(/tablename = 'user_profiles' and permissive = 'permissive'\s+and policyname not in \('up_select_own_or_super_admin', 'up_update_own', 'up_insert_super_admin', 'up_delete_super_admin'\)\s+loop\s+execute format\('drop policy %i on public\.user_profiles'/.test(sql), 'sweeps any other permissive policy');
  assert.ok(/create policy up_select_own_or_super_admin on public\.user_profiles\s+as permissive for select to public\s+using \(id = auth\.uid\(\) or public\.is_super_admin\(\)\)/.test(sql));
  assert.ok(/create policy up_update_own on public\.user_profiles\s+as permissive for update to public\s+using \(id = auth\.uid\(\)\)\s+with check \(id = auth\.uid\(\)\)/.test(sql));
  assert.ok(sql.includes('revoke update (location_id, org_id, bo_access) on table public.user_profiles from authenticated;'));
  assert.ok(!/grant update/.test(sql), 'nothing is granted back');
  assert.ok(sql.includes('create trigger user_profiles_venue_guard') && sql.includes('before update on public.user_profiles'));
  assert.ok(sql.includes('create trigger user_locations_venue_guard') && sql.includes('before update on public.user_locations'));
  assert.ok(sql.includes("new.location_id is distinct from old.location_id or new.user_id is distinct from old.user_id"), 'a venue link can never be moved');
  assert.equal((sql.match(/if v_jwt_role not in \('authenticated', 'anon'\) then\s+return new;/g) || []).length, 2);
  // The stale same org RPC is gone.
  assert.ok(sql.includes('drop function if exists public.set_bo_access(uuid, boolean);'));

  // It proves itself, and ANY unexpected probe rolls the whole thing back.
  assert.ok(raw.includes('Through pos_can_access():') && raw.includes('Policies calling it directly:'));
  assert.ok(sql.includes("raise exception 'probe_rollback'"));
  assert.ok(sql.includes("raise exception 'self test failed, nothing was changed:%', v_fail;"), 'a failed probe raises');
  const probe = sql.slice(sql.indexOf('do $probe$'), sql.indexOf('$probe$;'));
  assert.ok(probe.indexOf("raise exception 'self test failed") > probe.lastIndexOf("perform set_config('servos.p_anon'"), 'raises after every probe ran');
  for (const [flag, expected] of [['p_own_venue', 'blocked'], ['p_other_row', 'blocked'], ['p_read_others', 'only their own'],
    ['p_own_name', 'still works'], ['p_move_link', 'blocked'], ['p_access', 'own venue only'], ['p_admin_reads', 'sees all'],
    ['p_admin_far', 'reaches every venue'], ['p_anon', 'nothing']]) {
    const at = probe.indexOf(`perform set_config('servos.${flag}', v_flag, false);`);
    assert.ok(at > 0, flag);
    assert.ok(probe.slice(at, at + 200).includes(`if v_flag <> '${expected}' then v_fail := v_fail`), `${flag} must be ${expected} or the migration raises`);
  }
  assert.ok(sql.indexOf('commit;') > sql.indexOf('$probe$;'), 'the self test runs before commit');
  for (const k of ['owner_sets_own_venue', 'owner_edits_another_login', 'owner_reads_profiles', 'owner_moves_venue_link', 'owner_access', 'you_read_all_profiles', 'you_at_an_unlinked_venue', 'anonymous_session', 'logins_with_venue_but_no_link']) {
    assert.ok(sql.includes(`as ${k}`), k);
  }
});

// ── 1. profile-admin decisions ────────────────────────────────────────────────
test('profile-admin: only a real login, and only the venue, company and access it may change', () => {
  assert.equal(decideSignedIn(null).status, 401);
  assert.equal(decideSignedIn(anon).ok, false, 'the Back Office never acts on an anonymous session');

  // Opening venue: linked venues only (super admin: any real venue). Never access by itself.
  assert.deepEqual(decideSetActiveLocation({ caller: me, isSuperAdmin: false, locationId: LOC, linkedLocationIds: [LOC], locationExists: true }), { ok: true });
  assert.equal(decideSetActiveLocation({ caller: me, isSuperAdmin: false, locationId: LOC2, linkedLocationIds: [LOC], locationExists: true }).status, 403, 'THE HOLE: pointing your profile at another venue');
  assert.equal(decideSetActiveLocation({ caller: anon, isSuperAdmin: true, locationId: LOC, linkedLocationIds: [LOC], locationExists: true }).ok, false);
  assert.deepEqual(decideSetActiveLocation({ caller: me, isSuperAdmin: true, locationId: LOC2, linkedLocationIds: [], locationExists: true }), { ok: true });
  assert.equal(decideSetActiveLocation({ caller: me, isSuperAdmin: true, locationId: LOC2, linkedLocationIds: [], locationExists: false }).status, 400);

  // Company: only an empty profile, only an organisation nobody else is in.
  assert.deepEqual(decideClaimOrg({ caller: me, isSuperAdmin: false, profileOrgId: null, orgExists: true, orgHasOtherMembers: false }), { ok: true });
  assert.equal(decideClaimOrg({ caller: me, isSuperAdmin: false, profileOrgId: null, orgExists: true, orgHasOtherMembers: true }).status, 403, 'joining somebody else\'s company');
  assert.equal(decideClaimOrg({ caller: me, isSuperAdmin: false, profileOrgId: ORG2, orgExists: true, orgHasOtherMembers: false }).status, 409, 'never moves an existing login');

  // New venue: the creator's own company, unclaimed.
  const adopt = { caller: me, isSuperAdmin: false, profileOrgId: ORG, locationOrgId: ORG, locationExists: true, locationHasOtherUsers: false, orgHasOtherMembers: false, alreadyLinked: false };
  assert.deepEqual(decideAdoptLocation(adopt), { ok: true });
  assert.equal(decideAdoptLocation({ ...adopt, locationHasOtherUsers: true }).status, 403, 'somebody else\'s venue');
  assert.equal(decideAdoptLocation({ ...adopt, locationOrgId: ORG2 }).status, 403, 'another company\'s venue');
  assert.equal(decideAdoptLocation({ ...adopt, profileOrgId: null, orgHasOtherMembers: true }).status, 403);
  assert.deepEqual(decideAdoptLocation({ ...adopt, locationHasOtherUsers: true, alreadyLinked: true }), { ok: true }, 'already linked: a no op');

  // Back Office access: owner or manager of the venue, a login of that venue, never self, never a super admin.
  const bo = { caller: me, isSuperAdmin: false, callerRoleAtLocation: 'manager', targetId: 'u2', targetLinkedToLocation: true, targetRole: 'manager' };
  assert.deepEqual(decideSetBoAccess(bo), { ok: true });
  assert.equal(decideSetBoAccess({ ...bo, callerRoleAtLocation: 'staff' }).status, 403);
  assert.equal(decideSetBoAccess({ ...bo, callerRoleAtLocation: null }).status, 403);
  assert.equal(decideSetBoAccess({ ...bo, targetLinkedToLocation: false }).status, 403, 'a login of another venue');
  assert.equal(decideSetBoAccess({ ...bo, targetRole: 'super_admin', isSuperAdmin: true }).status, 403);
  assert.equal(decideSetBoAccess({ ...bo, targetId: me.id }).status, 403);

  // Team emails: staff of the venue only. Admin portal: super admin, and a venue the user is linked to.
  assert.equal(decideTeamRead({ caller: me, isSuperAdmin: false, callerLinked: false }).status, 403);
  assert.deepEqual(decideTeamRead({ caller: me, isSuperAdmin: false, callerLinked: true }), { ok: true });
  assert.equal(decideAdminSetLocation({ caller: me, isSuperAdmin: false, targetExists: true, locationId: LOC, targetLinkedToLocation: true }).status, 403);
  assert.equal(decideAdminSetLocation({ caller: me, isSuperAdmin: true, targetExists: true, locationId: LOC, targetLinkedToLocation: false }).status, 400, 'an opening venue is always a linked one');
  assert.deepEqual(decideAdminSetLocation({ caller: me, isSuperAdmin: true, targetExists: true, locationId: null, targetLinkedToLocation: false }), { ok: true });
});

test('profile-admin wiring: every write after its decision, service role, and a marker on every reply', () => {
  const src = fnSrc('profile-admin');
  assert.ok(src.includes("new Response(JSON.stringify({ fn: 'profile-admin', ...b })"), 'every reply is marked');
  assert.ok(src.indexOf('const signedIn = decideSignedIn(user);') < src.indexOf("const action = String(body?.action ?? '');"));
  const pairs = [
    ['set_active_location', 'decideSetActiveLocation(', ".update({ location_id: locationId }).eq('id', caller.id)"],
    ['claim_org', 'decideClaimOrg(', ".update({ org_id: orgId }).eq('id', caller.id).is('org_id', null)"],
    ['adopt_location', 'decideAdoptLocation(', ".from('user_locations')\n        .upsert("],
    ['set_bo_access', 'decideSetBoAccess(', ".update({ bo_access: body.bo_access }).eq('id', targetId)"],
    ['team_profiles', 'decideTeamRead(', ".select('id, email, bo_access').in('id', [...allowed])"],
    ['admin_set_location', 'decideAdminSetLocation(', ".update({ location_id: locationId }).eq('id', targetId)"],
  ];
  for (const [action, decide, write] of pairs) {
    const at = src.indexOf(`if (action === '${action}') {`);
    assert.ok(at > 0, action);
    const d = src.indexOf(decide, at);
    const w = src.indexOf(write, at);
    assert.ok(d > at && w > d, `${action}: decided before it writes`);
    assert.ok(src.indexOf('if (!d.ok) return refuse(d);', d) < w, `${action}: stops when refused`);
  }
  // Team emails only for logins LINKED to this venue (user_locations), never via staff_members.
  assert.ok(src.includes("admin.from('user_locations').select('user_id').eq('location_id', locationId).in('user_id', wanted)"));
  assert.ok(!src.includes("from('staff_members')"), 'staff_members.auth_user_id is never proof a login belongs to a venue');
  assert.ok(src.includes("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')"));
});

// ── 1. The browser side ──────────────────────────────────────────────────────
test('the Back Office calls profile-admin with its OWN session; never mints one; never falls back to a table write', async () => {
  const good = async () => ({ data: { session: { access_token: 'tok', user: { id: me.id, is_anonymous: false } } } });
  const anonSession = async () => ({ data: { session: { access_token: 'tok', user: { id: anon.id, is_anonymous: true } } } });
  await assert.rejects(backOfficeToken(async () => ({ data: { session: null } })), /Sign in to Back Office/);
  await assert.rejects(backOfficeToken(anonSession), /not a device session/);
  assert.equal(await backOfficeToken(good), 'tok');

  const calls = [];
  const reply = (status, body) => async (url, init) => { calls.push({ url, init }); return { status, ok: status < 300, json: async () => body }; };
  const deps = (status, body) => ({ functionsUrl: 'https://x/functions/v1', getSession: good, fetchImpl: reply(status, body) });

  const ok = await callProfileAdmin('set_active_location', { location_id: LOC }, deps(200, { fn: 'profile-admin', ok: true }));
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, 'https://x/functions/v1/profile-admin');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'set_active_location', location_id: LOC });

  // A refusal from profile-admin is shown in its own words.
  await assert.rejects(callProfileAdmin('set_active_location', {}, deps(403, { fn: 'profile-admin', error: 'You do not have access to that location' })), /do not have access/);
  await assert.rejects(callProfileAdmin('admin_set_location', {}, deps(404, { fn: 'profile-admin', error: 'Unknown user' })), /Unknown user/);
  // Not deployed: in a browser the gateway 404 has no CORS headers, so fetch itself throws. The
  // screen says the server could not be reached and that nothing changed; no old write runs.
  const cors404 = { functionsUrl: 'https://x/functions/v1', getSession: good, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } };
  await assert.rejects(callProfileAdmin('set_active_location', {}, cors404), (e) => e.message === PROFILE_ADMIN_UNREACHABLE);
  // Seen from a non browser caller, the platform's own 404 is not our reply either.
  await assert.rejects(callProfileAdmin('set_active_location', {}, deps(404, { code: 'NOT_FOUND', message: 'Requested function was not found' })), /Could not reach the server \(profile-admin\).*HTTP 404/);
  assert.match(PROFILE_ADMIN_UNREACHABLE, /Nothing was changed/);
  assert.equal(callProfileAdmin.length, 3, 'no fourth (fallback) argument');

  // The pure helper never imports the Supabase client (so it cannot sign anybody in).
  const helper = code(read('./profileAdmin.js'));
  assert.ok(!/ensureAuthToken|signIn/.test(helper));
  assert.ok(!/legacy/.test(helper), 'no fallback path left');
  const client = code(read('./profileAdminClient.js'));
  assert.ok(!/ensureAuthToken|signIn/.test(client));
  assert.ok(client.includes('export function profileAdmin(action, body) {'), 'the client takes no fallback');

  // The Staff screen works on the venue Back Office is ON (the switcher's choice), else the opening venue.
  assert.equal(staffScreenLocation({ location_id: LOC }, LOC2), LOC2);
  assert.equal(staffScreenLocation({ location_id: LOC }, null), LOC);
  assert.equal(staffScreenLocation({ location_id: LOC }, 'loc-demo'), LOC);
  assert.equal(staffScreenLocation(null, 'loc-demo'), null);
});

test('every Back Office write of a venue, company or access flag goes through profile-admin, with no direct write left', () => {
  const sites = [
    ['../backoffice/LocationSwitcher.jsx', 'set_active_location', ".update({ location_id: opsLocId })"],
    ['../backoffice/sections/CompanyAdmin.jsx', 'claim_org', ".update({ org_id: data.id })"],
    ['../backoffice/sections/CompanyAdmin.jsx', 'adopt_location', ".update(patch)"],
    ['../backoffice/sections/StaffManager.jsx', 'set_bo_access', ".update({ bo_access: next })"],
    ['../admin/CompanyAdminApp.jsx', 'admin_set_location', "method:'PATCH', body:{ location_id: locationId }"],
  ];
  for (const [file, action, old] of sites) {
    const src = code(read(file));
    const call = src.indexOf(`profileAdmin('${action}'`);
    assert.ok(call > 0, `${file}: calls ${action}`);
    assert.equal(src.indexOf(old), -1, `${file}: the old direct write is gone`);
    const args = src.slice(call, src.indexOf(');', call));
    assert.ok(!/async \(\) =>/.test(args), `${file}: ${action} has no fallback closure`);
  }
  const staff = code(read('../backoffice/sections/StaffManager.jsx'));
  assert.ok(!staff.includes(".update({ location_id: locationId }).eq('id', user.id)"), 'Staff no longer writes the profile venue');
  assert.ok(staff.includes("profileAdmin('team_profiles', { location_id: locationId, user_ids: linkedIds });"), 'team emails come from the server only');
  assert.ok(!/from\('user_profiles'\)\s*\.select\('id, email, bo_access'\)/.test(staff), 'no direct read of other logins');
  const admin = code(read('../admin/CompanyAdminApp.jsx'));
  assert.ok(!admin.includes("user_profiles?location_id=eq.${locId}`, { method:'PATCH'"), 'deleting a venue leaves the profile venue to ON DELETE SET NULL');
  assert.ok(!admin.includes("sbFetch(`user_profiles?id=eq.${userId}`, { method:'PATCH'"), 'no admin portal PATCH of a profile venue');
});

// ── 2. Online gift card purchases: server only ───────────────────────────────
test('platform migration: gift_card_purchases is service role only; old codes cleared in a later file', () => {
  const sql = sqlCode(read('../../supabase/migrations/20260918_PLATFORM_gift_purchases_server_only.sql')).toLowerCase();
  assert.ok(sql.includes("to_regclass('public.user_locations') is not null"), 'refuses to run on the Ops DB');
  assert.ok(sql.includes('drop policy if exists gift_card_purchases_service on public.gift_card_purchases;'));
  assert.ok(sql.includes('drop policy if exists gift_card_purchases_company_read on public.gift_card_purchases;'));
  assert.ok(/create policy gift_card_purchases_service on public\.gift_card_purchases\s+for all to service_role using \(true\) with check \(true\);/.test(sql));
  assert.ok(!/to public/.test(sql) && !/to anon/.test(sql), 'no browser policy');
  assert.ok(sql.includes('revoke all on table public.gift_card_purchases from anon, authenticated;'));
  assert.ok(!/^\s*(begin|commit);/m.test(sql));
  const clear = sqlCode(read('../../supabase/migrations/20260918b_PLATFORM_gift_purchases_clear_codes.sql')).toLowerCase();
  assert.ok(clear.includes('set fulfilled_code = null') && clear.includes('c.code_plain is not null') && clear.includes('upper(c.code_plain) = upper(p.fulfilled_code)'), 'only where the card keeps the same code');
});

test('no browser reads gift_card_purchases; Back Office goes through gift-list (staff only); the code is never copied onto the purchase', async () => {
  const gc = code(read('../backoffice/sections/GiftCards.jsx'));
  assert.ok(gc.includes("await callGift('gift-list', { kind: 'purchases', limit: 50 })"));
  const direct = gc.indexOf(".from('gift_card_purchases')");
  assert.ok(direct > gc.indexOf('purchasesFromGiftList(j, async () => {'), 'the direct read is only the fallback for an older gift-list');
  for (const f of ['../surfaces/gift/GiftSuccessSurface.jsx', '../surfaces/gift/GiftPurchaseSurface.jsx', '../surfaces/gift/GiftBalanceSurface.jsx']) {
    assert.ok(!read(f).includes('gift_card_purchases'), f);
  }
  assert.deepEqual(await purchasesFromGiftList({ purchases: [{ id: 'p' }] }, () => { throw new Error('no'); }), [{ id: 'p' }]);
  assert.deepEqual(await purchasesFromGiftList({ cards: [] }, async () => ['legacy']), ['legacy']);

  const list = fnSrc('gift-list');
  const gate = list.indexOf('const authority = decideGiftListAuthority({ user: caller, staff });');
  const kind = list.indexOf("if (body.kind === 'purchases') {");
  assert.ok(gate > 0 && kind > gate, 'purchases are staff only, company scoped');
  assert.ok(list.slice(kind).includes(".eq('company_id', companyId)"));

  const ful = fnSrc('gift-fulfill');
  assert.ok(!/fulfilled_code:/.test(ful), 'gift-fulfill never writes the plaintext code on the purchase');
  const resend = fnSrc('gift-resend');
  assert.ok(resend.includes('const resendCode = card.code_plain || purchase.fulfilled_code || null;'));
  assert.ok(resend.includes('code: formatCode(resendCode),'));
  const status = fnSrc('gift-purchase-status');
  assert.ok(!/fulfilled_code|code_plain/.test(status), 'the success page never gets a code');
});

// ── 3. Promo code wildcard ───────────────────────────────────────────────────
test('promo codes: exact match only, never a wildcard or a prefix, never another company', () => {
  for (const bad of ['%', '_', '*', 'A%', 'BDAY-%', 'BDAY-*', '%BDAY%', 'B_AY', '', '   ', '-', 'A-', 'A B', "A'", 'A,B', null, 42]) {
    assert.equal(normalisePromoCode(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(normalisePromoCode(' bday-7f3k9 '), 'BDAY-7F3K9');
  assert.equal(normalisePromoCode('SUMMER10'), 'SUMMER10');
  assert.equal(escapeLike('A%B_C\\D*'), 'A\\%B\\_C\\\\D\\*');

  const mine = { code: 'bday-7f3k9', org_id: ORG };
  const theirs = { code: 'BDAY-7F3K9', org_id: ORG2 };
  const prefixSibling = { code: 'BDAY-7F3K99', org_id: ORG };
  assert.equal(promoRowMatches(mine, 'BDAY-7F3K9', ORG), true, 'case insensitive');
  assert.equal(promoRowMatches(theirs, 'BDAY-7F3K9', ORG), false, "another company's code never matches");
  assert.equal(promoRowMatches(prefixSibling, 'BDAY-7F3K9', ORG), false, 'a prefix never matches');
  assert.equal(pickPromoRow([theirs, prefixSibling, mine], 'BDAY-7F3K9', ORG), mine);
  assert.equal(pickPromoRow([theirs], 'BDAY-7F3K9', ORG), null);
  assert.equal(promoRowMatches(mine, 'BDAY-7F3K9', ''), false, 'no venue org, no code');

  const src = fnSrc('promo-redeem');
  const ev = src.slice(src.indexOf('async function evaluate('));
  assert.ok(ev.includes('const code = normalisePromoCode(codeStr);'));
  assert.ok(ev.includes('const orgId = await orgForLocation(locationId);'));
  assert.ok(ev.includes(".eq('org_id', orgId)\n    .ilike('code', escapeLike(code))"), 'scoped to the venue org, escaped');
  assert.ok(ev.includes('const row = pickPromoRow(rows, code, orgId);'));
  assert.ok(!src.includes(".ilike('code', code)"), 'raw input never reaches ilike');
  // Both actions use the same lookup.
  assert.equal((src.match(/await evaluate\(body\?\.code, locationId, customerId, subtotal\)/g) || []).length, 2);
});

// ── 4a/4b. No profile staff arm; org from Ops ────────────────────────────────
test('WiFi Join rewards: loyalty-enroll reads the org from the Ops venue (Platform locations has no org_id)', () => {
  const platform = [{ id: 'p1', ops_location_id: LOC }, { id: 'p2', ops_location_id: LOC2 }, { id: 'p3', ops_location_id: null }];
  assert.deepEqual(opsIdsOf(platform), [LOC, LOC2]);
  assert.deepEqual([...companyOrgIds([{ id: LOC, org_id: ORG }, { id: LOC2, org_id: ORG }, { id: 'x', org_id: null }])], [ORG]);
  assert.equal(locationInCompany(platform, LOC), true, 'wifi-capture sends the Ops id');
  assert.equal(locationInCompany(platform, 'p1'), true);
  assert.equal(locationInCompany(platform, 'elsewhere'), false);
  assert.equal(customerInCompany({ org_id: ORG }, new Set([ORG])), true);
  assert.equal(customerInCompany({ org_id: ORG2 }, new Set([ORG])), false);
  assert.equal(customerInCompany({ org_id: null }, new Set([ORG])), false);

  const enroll = fnSrc('loyalty-enroll');
  assert.ok(enroll.includes(".select('id, ops_location_id')\n    .eq('company_id', companyId)"), 'no org_id asked of Platform');
  assert.ok(enroll.includes("await opsAdmin.from('locations').select('id, org_id').in('id', opsIds.map(uuidOr0))"));
  // No function asks Platform locations for org_id any more.
  for (const fn of ['loyalty-enroll', 'loyalty-member-lookup', 'gift-fulfill']) {
    const src = fnSrc(fn);
    assert.ok(!/from\('locations'\)\s*\.select\('[^']*org_id[^']*'\)\s*\.(eq|or)\('(id|ops_location_id|company_id)/.test(src.replace(/opsAdmin\s*\.from\('locations'\)\s*\.select\('[^']*'\)/g, '')), `${fn}: org from Ops only`);
  }
});

// ── 4e. One card per purchase; outages retried ───────────────────────────────
test('gift-fulfill: the card id is the purchase\'s own, so a retry or takeover can never issue twice', async () => {
  const a = await purchaseCardId('11111111-2222-4333-8444-555555555555');
  const b = await purchaseCardId('11111111-2222-4333-8444-555555555555');
  const c = await purchaseCardId('11111111-2222-4333-8444-555555555556');
  assert.equal(a, b, 'same purchase, same card id');
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a valid uuid for gift_cards.id');
  assert.equal(issueLedgerKey('p-1'), 'issue:purchase:p-1');

  const src = fnSrc('gift-fulfill');
  const claim = src.indexOf(".update({ status: 'fulfilling', updated_at: claimedAt })");
  const derive = src.indexOf('const cardId = await purchaseCardId(purchase.id);');
  const lookFirst = src.indexOf(".from('gift_cards').select(cardCols).eq('id', cardId).maybeSingle();");
  const gen = src.indexOf('const code = generateCode();');
  assert.ok(claim > 0 && derive > claim && lookFirst > derive && gen > lookFirst, 'claim, derive, look for the card, only then make a code');
  assert.ok(src.slice(lookFirst, gen).includes('if (!card) {'), 'a card already there is used, not replaced');
  assert.ok(src.includes('        id: cardId,'), 'the card is inserted under the purchase\'s id');
  assert.ok(src.includes("if (cardErr.code === '23505') {"), 'a racer\'s card is adopted');
  assert.ok(src.includes('idempotency_key: issueLedgerKey(purchase.id),'), 'one issue ledger row');
  assert.ok(src.includes("if (txErr && txErr.code !== '23505') {"));
  const done = src.indexOf("status: 'fulfilled',");
  const email = src.indexOf('functions/v1/send-receipt');
  assert.ok(done > 0 && email > done, 'the email only after the purchase says fulfilled');
});

test('a processor outage is retryable; "not paid" stays final; the webhooks make Stripe and Ryft retry', () => {
  assert.equal(proofReasonRetryable('processor_unreachable'), true);
  for (const s of ['ryft_0', 'ryft_429', 'ryft_500', 'ryft_503', 'ryft_408']) assert.equal(proofReasonRetryable(s), true, s);
  for (const s of ['not_paid', 'amount_short', 'session_not_for_purchase', 'currency_mismatch', 'ryft_404', 'ryft_401', 'processor_rejected', 'processor_unverifiable', 'no_merchant_account']) {
    assert.equal(proofReasonRetryable(s), false, s);
  }
  assert.equal(processorErrorReason({ type: 'StripeConnectionError' }), 'processor_unreachable');
  assert.equal(processorErrorReason({ type: 'StripeAPIError', statusCode: 500 }), 'processor_unreachable');
  assert.equal(processorErrorReason({ type: 'StripeRateLimitError', statusCode: 429 }), 'processor_unreachable');
  assert.equal(processorErrorReason({ type: 'StripeInvalidRequestError', statusCode: 404 }), 'processor_rejected');
  assert.equal(processorErrorReason(new TypeError('fetch failed')), 'processor_unreachable');

  assert.equal(fulfilResponseRetryable(503, { retryable: true }), true);
  assert.equal(fulfilResponseRetryable(500, { error: 'Card creation failed' }), true);
  assert.equal(fulfilResponseRetryable(0, null), true, 'gift-fulfill unreachable');
  assert.equal(fulfilResponseRetryable(409, { code: 'fulfil_in_progress' }), true, 'taken over after 10 minutes');
  assert.equal(fulfilResponseRetryable(402, { code: 'payment_not_proven' }), false);
  assert.equal(fulfilResponseRetryable(403, {}), false);
  assert.equal(fulfilResponseRetryable(404, {}), false);

  const ful = fnSrc('gift-fulfill');
  assert.ok(ful.includes('if (proofReasonRetryable(proof.reason)) {'));
  assert.ok(/code: 'processor_unavailable', reason: proof\.reason, retryable: true,\n\s+\}, 503\);/.test(ful));
  assert.ok(ful.includes("return { ok: false, reason: processorErrorReason(e) };"));

  const st = fnSrc('stripe-webhook-connect');
  assert.ok(st.includes('} else if (fulfilResponseRetryable(status, fulfillData)) {\n          throw new RetryableWebhookError('));
  assert.ok(st.includes("return new Response('retry later', { status: 503 });"), 'Stripe is told to retry');
  assert.ok(st.includes('String(prior?.processing_error || \'\').startsWith(RETRYABLE_PREFIX)'), 'and the retried delivery is processed, not answered as a duplicate');
  assert.ok(st.includes(".eq('id', meta.purchase_id).eq('status', 'pending');"), 'never rewinds a fulfilled purchase to paid');

  const ry = fnSrc('ryft-webhook');
  assert.ok(ry.includes('if (fulfilResponseRetryable(status, body)) {\n    throw new RetryableWebhookError('));
  assert.ok(ry.includes("await platformAdmin.from('ryft_webhook_events').delete().eq('event_id', eventId);"), 'the retried event is not a duplicate');
  assert.ok(ry.includes("status: 503, headers: { 'Content-Type': 'application/json' } });"));
  assert.ok(ry.includes(".eq('id', p.id).eq('status', 'pending');"));
});

// ── 4f. The refund toast ─────────────────────────────────────────────────────
test('a failed gift card reversal tells staff what they can actually do', () => {
  const m = giftReversalFailedMessage({ code_last4: '1234', applied: 1250 }, 'Only staff or a paired till can do this', (x) => `£${(x / 100).toFixed(2)}`);
  assert.equal(m, 'Gift card ending 1234: £12.50 NOT put back on the card (Only staff or a paired till can do this). Give the customer that amount another way, or issue them a new gift card for it in Back Office, Gift cards, Issue card.');
  assert.ok(!/restore it from back office/i.test(m));
  assert.ok(!/[–—]/.test(m), 'no dashes');
  assert.ok(giftReversalFailedMessage({}, null).includes('the gift card amount'));
  const store = read('../store/index.js');
  assert.ok(!store.includes('Restore it from Back Office'));
  assert.ok(!store.includes('check the balance in Back Office'));
  assert.equal((store.match(/giftReversalFailedMessage\(leg, r\.error \|\| 'reversal failed'/g) || []).length, 2, 'refund and cancelled card machine job');
});

// ── 4g. The authority report ─────────────────────────────────────────────────
test('the authority report sees till earn (channel is the order type) and gift-redeem card_id refusals; report mode kept', () => {
  const rep = read('../../supabase/queries/caller_authority_report.sql');
  const body = sqlCode(rep);
  assert.ok(!/\b(insert|update|delete|drop|alter|create)\b/i.test(body), 'read only');
  assert.ok(body.includes("'card_id_without_code')"), 're-pair list includes gift-redeem by card id');
  assert.ok(!body.includes("a.channel in ('pos', 'kiosk', 'bar', 'tables', 'mpos')"), 'no channel list that misses order types');
  assert.ok(body.includes("coalesce(lower(a.channel), '') not in ('online', 'qr', 'catering')"));
  assert.ok(body.includes("count(*) filter (where a.fn = 'gift-redeem' and a.reason = 'card_id_without_code')"));
  // Report mode stays the default for loyalty earn, redeem and refund.
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(/LOYALTY_AUTHORITY_MODE/.test(u));
  for (const fn of ['loyalty-earn', 'loyalty-redeem', 'loyalty-refund']) {
    assert.ok(!fnSrc(fn).includes("modeOverride: 'enforce'"), `${fn} stays in report mode`);
  }
});

test('no em or en dashes in anything this step added', () => {
  for (const f of [
    '../../supabase/migrations/20260918d_OPS_profile_venue_lock.sql',
    '../../supabase/migrations/20260918e_OPS_venues_write_fence.sql',
    '../../supabase/queries/profile_venue_backfill_candidates.sql',
    '../../supabase/queries/lockdown_step1_predeploy_checks.sql',
    './accessibleLocations.js',
    '../../supabase/migrations/20260918_PLATFORM_gift_purchases_server_only.sql',
    '../../supabase/migrations/20260918b_PLATFORM_gift_purchases_clear_codes.sql',
    '../../supabase/functions/_shared/profileAdmin.ts',
    '../../supabase/functions/_shared/promoLookup.ts',
    '../../supabase/functions/_shared/giftFulfilPlan.ts',
    '../../supabase/functions/_shared/orgScope.ts',
    '../../supabase/functions/_shared/staffAccess.ts',
    '../../supabase/functions/profile-admin/index.ts',
    './profileAdmin.js', './profileAdminClient.js', './giftPurchasesRead.js',
  ]) {
    assert.ok(!/[–—]/.test(read(f)), f);
  }
});
