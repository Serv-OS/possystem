// Lockdown step 1, review round four (18 Sep 2026). Pins every rule the reviewers asked for:
//   1. a verified super admin reaches a venue he is NOT linked to (database, staff rule, Back
//      Office switcher, Staff screen, gift cards), and nobody else does through a profile venue
//   2. the Ops venues table is no longer world writable; a forged org_id (or id) change is refused
//   3. the backfill is pinned to the user ids Peter confirms
//   4. one transaction with a lock timeout, every historical policy dropped, a self test that
//      raises, the new names (20260918d, 20260918e), the stale set_bo_access RPC dropped
//   5. the spoofing routes: raw Platform id as staff key (a), staff_members as proof of a login
//      (b), offer takeover, offer of another org, wildcard void (c)
//   6. grant Back Office access at the active venue, workforce-compute and the admin portal
//      never treat the profile venue as access, delayed gift payments still issue the card,
//      a read only pre deploy check
//   7. the deploy order (the app cannot reach a function that is not deployed)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decideStaffAccess, staffLocationKeys } from '../../supabase/functions/_shared/staffAccess.ts';
import {
  decideSetActiveLocation, decideSetBoAccess, decideTeamRead, teamProfileIds,
} from '../../supabase/functions/_shared/profileAdmin.ts';
import { planSaveOffer, offerInOrg, normalisePromoCode } from '../../supabase/functions/_shared/promoLookup.ts';
import { mergeAccessibleLocations, usersWithAccess } from './accessibleLocations.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const exists = (rel) => fs.existsSync(fileURLToPath(new URL(rel, import.meta.url)));
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const sqlCode = (src) => src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const fnSrc = (name) => code(read(`../../supabase/functions/${name}/index.ts`));
const MIG_D = '../../supabase/migrations/20260918d_OPS_profile_venue_lock.sql';
const MIG_E = '../../supabase/migrations/20260918e_OPS_venues_write_fence.sql';

const peter = { id: '00000000-0000-4000-8000-00000000beef', is_anonymous: false };
const owner = { id: '00000000-0000-4000-8000-0000000000a1', is_anonymous: false };
const HIS = '11111111-1111-4111-8111-111111111111';      // a venue Peter IS linked to
const CUSTOMER = '22222222-2222-4222-8222-222222222222'; // a customer venue he is NOT linked to
const OPS_BHM = '33333333-3333-4333-8333-333333333333';  // Birmingham's Ops id
const PLAT_BHM = 'a1b2c3d4-0002-4000-8000-000000000002'; // Birmingham's Platform id (not an Ops id)
const CO = '44444444-4444-4444-8444-444444444444';
const ORG = '66666666-6666-4666-8666-666666666666';
const ORG2 = '77777777-7777-4777-8777-777777777777';

// ── 1. Super admin at a venue he is not linked to ─────────────────────────────
test('1. the database gives a VERIFIED super admin every venue, through the one function every policy uses', () => {
  const sql = sqlCode(read(MIG_D)).toLowerCase();
  const at = sql.indexOf('create or replace function public.user_accessible_locations()');
  const body = sql.slice(at, sql.indexOf('$function$;', at));
  assert.ok(body.includes('select l.id::text from public.locations l where public.is_super_admin()'), 'super admin arm');
  assert.ok(/returns setof text\s+language sql\s+stable/.test(body) && !/security definer/.test(body), 'STABLE, invoker, same signature (RLS performance unchanged)');
  assert.ok(!/user_profiles/.test(body), 'never the profile venue');
  // is_super_admin() is false for an anonymous session (live since 20260805c) and guarded by 20260915c.
  const base = read('../../supabase/migrations/20260805c_anon_fences.sql');
  assert.ok(/function public\.is_super_admin\(\)[\s\S]{0,200}select not public\.is_anon_session\(\)/.test(base));
  // pos_can_access (latest 20260729f) asks user_accessible_locations(), so it inherits the arm.
  const pca = read('../../supabase/migrations/20260729f_batch_scheduling.sql');
  assert.equal((pca.match(/in \(select user_accessible_locations\(\)\) then return true;/g) || []).length, 2);
  // The migration proves it live: Peter at an unlinked venue, pos_can_access (both overloads),
  // ops_can_write and the full venue list, or it raises.
  assert.ok(sql.includes('public.pos_can_access(v_admin_far)') && sql.includes('public.pos_can_access(v_admin_far::text)') && sql.includes('public.ops_can_write(v_admin_far)'));
  assert.ok(sql.includes("if v_flag <> 'reaches every venue' then v_fail := v_fail"), 'locked out super admin = migration raises');
});

test('1. the edge function staff rule, the Back Office switcher and the Staff screen agree for Peter at an unlinked venue', () => {
  // Gift cards, loyalty admin: requireStaff -> callerIsStaffFor -> decideStaffAccess.
  const facts = { user: peter, role: 'super_admin', userLocationIds: [HIS], companyRoleCompanyIds: [], locationKeys: [CUSTOMER], companyId: CO };
  assert.deepEqual(decideStaffAccess(facts), { ok: true, via: 'super_admin' });
  assert.equal(decideStaffAccess({ ...facts, role: 'owner' }).ok, false, 'an owner is not staff of a venue they are not linked to');
  assert.equal(decideStaffAccess({ ...facts, user: { ...peter, is_anonymous: true } }).ok, false, 'never an anonymous session');
  const lu = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(lu.includes('const staff = await callerIsStaffFor(p.caller, p.locationId, p.companyId);'), 'gift and loyalty admin use the same rule');

  // Switcher: profile-admin lets the super admin open any real venue; nobody else an unlinked one.
  assert.deepEqual(decideSetActiveLocation({ caller: peter, isSuperAdmin: true, locationId: CUSTOMER, linkedLocationIds: [HIS], locationExists: true }), { ok: true });
  assert.equal(decideSetActiveLocation({ caller: owner, isSuperAdmin: false, locationId: CUSTOMER, linkedLocationIds: [HIS], locationExists: true }).status, 403);
  // Back Office then resolves the venue: for Peter the opening venue (the one he switched to) is
  // in the accessible list; for anybody else only linked venues are.
  const junction = [{ role: 'owner', locations: { id: HIS, name: 'His', timezone: 'Europe/London' } }];
  const peterList = mergeAccessibleLocations(junction, { role: 'super_admin', locations: { id: CUSTOMER, name: 'Customer', timezone: 'Europe/London' } });
  assert.deepEqual(peterList.map((l) => l.id).sort(), [HIS, CUSTOMER].sort());
  const ownerList = mergeAccessibleLocations(junction, { role: 'owner', locations: { id: CUSTOMER, name: 'Customer' } });
  assert.deepEqual(ownerList.map((l) => l.id), [HIS], 'a self set profile venue is never listed as access');
  assert.deepEqual(mergeAccessibleLocations(null, null), []);
  const db = code(read('./db.js'));
  const falAt = db.indexOf('export const fetchAccessibleLocations');
  const fal = db.slice(falAt, db.indexOf('\n};', falAt));
  assert.ok(fal.includes('mergeAccessibleLocations(') && fal.includes(".select('role, location_id, locations(id, name, timezone)')"));
  assert.ok(!fal.includes('byId.set(profile.data.locations.id'), 'the unconditional profile arm is gone');

  // Staff screen: team emails and the access switch for the super admin at that venue.
  assert.deepEqual(decideTeamRead({ caller: peter, isSuperAdmin: true, callerLinked: false }), { ok: true });
  assert.deepEqual(decideSetBoAccess({ caller: peter, isSuperAdmin: true, callerRoleAtLocation: null, targetId: owner.id, targetLinkedToLocation: true, targetRole: 'manager' }), { ok: true });
  // Staff members themselves are read through pos_can_access (user_accessible_locations arm).
  // Granting access at the customer venue files the new login under THAT venue's company.
  const cu = fnSrc('create-user');
  const at = cu.indexOf('if (isSuper && locationId) {');
  assert.ok(at > 0 && cu.indexOf("from('locations').select('org_id').eq('id', locationId)", at) > at, 'org from the venue for a super admin');
  assert.ok(at < cu.indexOf("if (!email || !password || !orgId)"), 'before the org is used');
});

// ── 2. The venues table ───────────────────────────────────────────────────────
test('2. Ops locations: every permissive policy replaced by four scoped ones, anon write grants gone, one transaction', () => {
  const raw = read(MIG_E);
  const sql = sqlCode(raw).toLowerCase();
  const b = sql.search(/^begin;$/m);
  const lt = sql.indexOf("set local lock_timeout = '5s';");
  const c = sql.search(/^commit;$/m);
  assert.ok(b >= 0 && lt > b && c > sql.indexOf('$probe$;'), 'begin; lock_timeout; ... self test; commit;');
  assert.ok(sql.includes("raise exception 'run 20260918d_ops_profile_venue_lock.sql first. nothing changed.'"), 'refuses to run before 20260918d');
  assert.ok(sql.includes("to_regclass('public.billing_state') is not null"), 'refuses the Platform DB');
  for (const n of ['"allow all"', '"allow authenticated access"', '"users can update own location settings"']) {
    assert.ok(sql.includes(`drop policy if exists ${n} on public.locations;`), n);
  }
  assert.ok(/tablename = 'locations' and permissive = 'permissive'\s+and policyname not in \('locations_read', 'locations_update', 'locations_insert', 'locations_delete'\)/.test(sql), 'sweeps anything else');
  // Read stays open (customer pages, pairing) and never calls user_accessible_locations (recursion).
  assert.ok(/create policy locations_read on public\.locations\s+as permissive for select to public\s+using \(true\);/.test(sql));
  // Writes: staff of THAT venue (super admin through the same function), never an anonymous session.
  assert.ok(/create policy locations_update on public\.locations\s+as permissive for update to public\s+using\s+\(not public\.is_anon_session\(\) and id::text in \(select public\.user_accessible_locations\(\)\)\)\s+with check \(not public\.is_anon_session\(\) and id::text in \(select public\.user_accessible_locations\(\)\)\);/.test(sql));
  const ins = sql.slice(sql.indexOf('create policy locations_insert'), sql.indexOf('drop policy if exists locations_delete on public.locations;', sql.indexOf('create policy locations_insert')));
  assert.ok(ins.includes('not public.is_anon_session()') && ins.includes('public.is_super_admin()') && ins.includes('org_id = (select up.org_id from public.user_profiles up where up.id = auth.uid())'), 'insert into own company only');
  assert.ok(/create policy locations_delete on public\.locations\s+as permissive for delete to public\s+using \(public\.is_super_admin\(\)\);/.test(sql));
  assert.ok(!/create policy[^;]*on public\.locations[^;]*for (update|insert|delete|all)[^;]*\(true\)/.test(sql), 'no write policy is true');
  assert.ok(sql.includes('revoke insert, update, delete on table public.locations from anon;'));
  assert.ok(sql.includes('revoke truncate on table public.locations from anon, authenticated;'), 'TRUNCATE ignores RLS');
  assert.ok(sqlCode(read(MIG_D)).includes('revoke truncate on table public.user_profiles from anon, authenticated;'));
  // The migration documents the audit of every browser writer.
  for (const f of ['LocationSettings.jsx', 'MenuManager.jsx', 'MultiLocation.jsx', 'PrintMenu.jsx', 'PrintRouting.jsx', 'ReceiptBranding.jsx', 'TaxManager.jsx', 'AdyenTerminals.jsx', 'orderScreenData.js', 'CompanyAdmin.jsx', 'CompanyAdminApp.jsx']) {
    assert.ok(raw.includes(f), `audit names ${f}`);
  }
});

test('2. every browser write of Ops locations is a Back Office or admin portal screen (no till, kiosk, KDS or customer page)', () => {
  // Walk src and find every .from('locations') write on the Ops client. A new writer on a device
  // or customer surface would be refused by 20260918e, so it must fail here first.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const found = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(jsx?|mjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (!/from\(['"`]locations['"`]\)/.test(l) || /platformSupabase|platformAdmin/.test(l)) return;
        const around = lines.slice(Math.max(0, i - 3), i + 8).join('\n');
        if (/platformSupabase\s*\n?\s*\.from\(['"`]locations/.test(lines.slice(Math.max(0, i - 2), i + 1).join('\n'))) return;
        if (/\.(update|insert|upsert|delete)\(/.test(around)) found.add(p.slice(root.length));
      });
    }
  };
  walk(root.replace(/\/$/, ''));
  const allowed = [
    'backoffice/sections/AdyenTerminals.jsx', 'backoffice/sections/CompanyAdmin.jsx', 'backoffice/sections/LocationSettings.jsx',
    'backoffice/sections/MenuManager.jsx', 'backoffice/sections/MultiLocation.jsx', 'backoffice/sections/PrintMenu.jsx',
    'backoffice/sections/PrintRouting.jsx', 'backoffice/sections/ReceiptBranding.jsx', 'backoffice/sections/TaxManager.jsx',
    'lib/db.js', 'lib/orderScreen/orderScreenData.js',
  ];
  assert.ok(found.size >= 8, 'the scan sees the known Back Office writers');
  for (const f of found) assert.ok(allowed.includes(f.replace(/^\/+/, '')), `unexpected Ops locations writer: ${f}`);
  // db.js's writer is saveQuickScreenIds, called only by the Back Office menu screen.
  const callers = [];
  const walk2 = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk2(p); continue; }
      if (/\.(jsx?)$/.test(e.name) && !/\.test\./.test(e.name) && !p.endsWith('/lib/db.js') && !p.endsWith('changelog.js')
        && fs.readFileSync(p, 'utf8').includes('saveQuickScreenIds')) callers.push(p.slice(root.length).replace(/^\/+/, ''));
    }
  };
  walk2(root.replace(/\/$/, ''));
  assert.deepEqual(callers, ['backoffice/sections/MenuManager.jsx']);
});

test('2. a forged org_id (or id) change is refused unless a super admin makes it; API inserts get a server id', () => {
  const sql = sqlCode(read(MIG_E)).toLowerCase();
  const fn = sql.slice(sql.indexOf('create or replace function public.locations_org_guard()'), sql.indexOf('drop trigger if exists locations_org_guard'));
  assert.ok(/if v_jwt_role not in \('authenticated', 'anon'\) then\s+return new;/.test(fn), 'service role and the editor pass');
  assert.ok(/if public\.is_super_admin\(\) then\s+return new;/.test(fn), 'the super admin may move a venue');
  assert.ok(/if tg_op = 'insert' then\s+new\.id := gen_random_uuid\(\);/.test(fn), 'API inserts never choose their id');
  assert.ok(fn.includes('if new.org_id is distinct from old.org_id or new.id is distinct from old.id then'));
  assert.ok(fn.includes("raise exception 'a venue''s company and id can only be changed by the platform'"));
  assert.ok(/create trigger locations_org_guard\s+before insert or update on public\.locations/.test(sql));
  // Probes: forged org change, id change, other company insert, chosen id replaced, and the
  // super admin still saves at an unlinked venue. Any other outcome raises.
  for (const [flag, expected] of [['v_anon_key', 'blocked'], ['v_anon_session', 'blocked'], ['v_reads', 'reads all'],
    ['v_own_save', 'works'], ['v_other_venue', 'blocked'], ['v_org_change', 'blocked'], ['v_id_change', 'blocked'],
    ['v_insert_other', 'blocked'], ['v_insert_own', 'works, server id'], ['v_delete', 'blocked'], ['v_admin_save', 'works']]) {
    const at = sql.indexOf(`perform set_config('servos.${flag}', v_flag, false);`);
    assert.ok(at > 0, flag);
    assert.ok(sql.slice(at, at + 200).includes(`if v_flag <> '${expected.replace(/'/g, "''")}' then v_fail := v_fail`), `${flag} must be ${expected}`);
  }
  assert.ok(sql.includes('update public.locations set org_id = v_other_org where id = v_loc;'), 'the forged org change is really tried');
  assert.ok(sql.includes("raise exception 'self test failed, nothing was changed:%', v_fail;"));
});

// ── 3. The pinned backfill ────────────────────────────────────────────────────
test('3. the backfill links ONLY the ids Peter confirms and stops with the list otherwise', () => {
  const sql = sqlCode(read(MIG_D)).toLowerCase();
  const blk = sql.slice(sql.indexOf('do $backfill$'), sql.indexOf('$backfill$;'));
  assert.ok(blk.includes('v_confirmed uuid[] := array[]::uuid[];'));
  assert.ok(blk.includes('create temp table _venue_link_candidates on commit drop as'));
  assert.ok(blk.includes("coalesce(p.role, '') <> 'super_admin'") && blk.includes('not coalesce(u.is_anonymous, false)'));
  // The message lists each candidate with what Peter needs to judge it.
  for (const k of ['email', 'user_id', 'venue', 'same company', 'signed up']) assert.ok(blk.includes(k), k);
  const stop = blk.indexOf("raise exception 'stopped, nothing changed. % login(s)");
  const ins = blk.indexOf('insert into public.user_locations');
  assert.ok(stop > 0 && ins > stop, 'stops before inserting anything');
  assert.ok(blk.slice(ins).includes('where k.user_id = any(v_confirmed)'));
  assert.ok(!/insert into public\.user_locations[\s\S]*from public\.user_profiles p/.test(blk), 'never inserts straight from every profile');
  // The read only list Peter runs first.
  const q = read('../../supabase/queries/profile_venue_backfill_candidates.sql');
  assert.ok(!/\b(insert|update|delete|alter|drop|create)\b/i.test(sqlCode(q)), 'read only');
  assert.ok(q.includes('same_company') && q.includes('signed_up'));
});

// ── 4. Naming, lock timeout, historical policies, stale RPC ───────────────────
test('4. the profile migration is 20260918d, the venues fence 20260918e; nothing still points at the old name', () => {
  assert.ok(exists(MIG_D) && exists(MIG_E));
  assert.ok(!exists('../../supabase/migrations/20260918c_OPS_profile_venue_lock.sql'));
  assert.ok(exists('../../supabase/migrations/20260918c_OPS_sections_per_location.sql'), 'main keeps its own 20260918c');
  const files = [
    '../../supabase/functions/_shared/staffAccess.ts', '../../supabase/functions/_shared/loyalty-utils.ts',
    '../../supabase/functions/_shared/loyalty-authority.ts', '../../supabase/functions/_shared/profileAdmin.ts',
    '../../supabase/functions/profile-admin/index.ts', './profileAdmin.js', '../../INVARIANTS.md',
    './lockdownStep1.test.js', './loyaltyGiftCardRound3.test.js',
  ];
  for (const f of files) assert.ok(!/20260918c_OPS_profile_venue_lock|since 20260918c|lockdown step 1, migration 20260918c/.test(read(f)), f);
  const inv = read('../../INVARIANTS.md');
  assert.ok(inv.includes('migration 20260918d') && inv.includes('migration 20260918e'));
  // The stale RPC: dropped, and nothing in the app calls it.
  assert.ok(sqlCode(read(MIG_D)).includes('drop function if exists public.set_bo_access(uuid, boolean);'));
  assert.ok(!/rpc\(['"]set_bo_access/.test(read('../backoffice/sections/StaffManager.jsx')));
});

// ── 5a. A Platform id is never a staff key of its own ─────────────────────────
test('5a. callerIsStaffFor matches ONLY the resolved Ops id (the drifted venues)', () => {
  const platform = [{ id: PLAT_BHM, ops_location_id: OPS_BHM, company_id: CO }];
  // The till sends the Ops id: that is the key.
  assert.deepEqual(staffLocationKeys(OPS_BHM, platform), { keys: [OPS_BHM], companyId: CO });
  // A Platform id resolves to its Ops id ONLY, never itself as well.
  assert.deepEqual(staffLocationKeys(PLAT_BHM, platform), { keys: [OPS_BHM], companyId: CO });
  // THE ATTACK: an Ops venue created with id = Birmingham's Platform id, and its creator linked to it.
  const attacker = { user: owner, role: 'owner', userLocationIds: [PLAT_BHM], companyRoleCompanyIds: [] };
  const r = staffLocationKeys(PLAT_BHM, platform);
  assert.equal(decideStaffAccess({ ...attacker, locationKeys: r.keys, companyId: r.companyId }).ok, false, 'not staff of Birmingham');
  // The real Birmingham staff still are, by either id.
  const real = { user: owner, role: 'owner', userLocationIds: [OPS_BHM], companyRoleCompanyIds: [] };
  assert.equal(decideStaffAccess({ ...real, ...(() => { const k = staffLocationKeys(PLAT_BHM, platform); return { locationKeys: k.keys, companyId: k.companyId }; })() }).ok, true);
  // A Platform row with no mapping is nothing; an Ops only venue is itself with no company.
  assert.deepEqual(staffLocationKeys(PLAT_BHM, [{ id: PLAT_BHM, ops_location_id: null, company_id: CO }]), { keys: [], companyId: CO });
  assert.deepEqual(staffLocationKeys(OPS_BHM, []), { keys: [OPS_BHM], companyId: null });
  // A row whose ops_location_id IS the id wins over another row whose Platform id collides.
  assert.deepEqual(staffLocationKeys(OPS_BHM, [{ id: OPS_BHM, ops_location_id: 'x', company_id: 'other' }, { id: PLAT_BHM, ops_location_id: OPS_BHM, company_id: CO }]), { keys: [OPS_BHM], companyId: CO });
  // Wiring: the raw id is never pushed as a key any more.
  const u = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  const fn = u.slice(u.indexOf('export async function callerIsStaffFor'), u.indexOf('const UUID_ONLY'));
  assert.ok(!fn.includes('locationKeys.push(String(locationId))'), 'raw id no longer a key');
  assert.ok(fn.includes('const resolved = staffLocationKeys(String(locationId), pls || []);') && fn.includes('locationKeys = resolved.keys;'));
  assert.ok(fn.includes('company = resolved.companyId;'));
});

// ── 5b. staff_members.auth_user_id is never proof ─────────────────────────────
test('5b. set_bo_access and team_profiles accept only a user_locations link as proof a login belongs to the venue', () => {
  const bo = { caller: owner, isSuperAdmin: false, callerRoleAtLocation: 'owner', targetId: 'u2', targetRole: 'manager' };
  assert.equal(decideSetBoAccess({ ...bo, targetLinkedToLocation: false }).status, 403, 'named on a staff row only: refused');
  assert.deepEqual(decideSetBoAccess({ ...bo, targetLinkedToLocation: true }), { ok: true });
  assert.deepEqual(teamProfileIds(['a', 'b', 'c', 'a'], ['b', 'c', 'z']), ['b', 'c']);
  assert.deepEqual(teamProfileIds(['a'], []), [], 'a login only on staff_members is not shown');
  const src = fnSrc('profile-admin');
  const set = src.slice(src.indexOf("if (action === 'set_bo_access') {"), src.indexOf("if (action === 'team_profiles') {"));
  assert.ok(set.includes('targetLinkedToLocation: !!tLink,'), 'only the venue link');
  assert.ok(!set.includes('staff_members') && !set.includes('tStaff'));
  const team = src.slice(src.indexOf("if (action === 'team_profiles') {"), src.indexOf("if (action === 'admin_set_location') {"));
  assert.ok(team.includes('teamProfileIds(wanted,') && !team.includes('staff_members'));
});

// ── 5c. Offers and codes ──────────────────────────────────────────────────────
test('5c. save_offer never takes over another company\'s offer; promo-redeem checks the offer\'s org; void is exact', () => {
  assert.deepEqual(planSaveOffer(undefined, null, ORG), { ok: true, mode: 'insert' });
  assert.deepEqual(planSaveOffer('', null, ORG), { ok: true, mode: 'insert' });
  assert.deepEqual(planSaveOffer('off-1', { id: 'off-1', org_id: ORG }, ORG), { ok: true, mode: 'update', id: 'off-1' });
  assert.equal(planSaveOffer('off-2', { id: 'off-2', org_id: ORG2 }, ORG).status, 404, 'THE TAKEOVER: another company\'s offer id');
  assert.equal(planSaveOffer('off-3', null, ORG).status, 404, 'an unknown id is never inserted with that id');
  assert.equal(planSaveOffer({ $ne: 1 }, null, ORG).status, 400);
  assert.equal(planSaveOffer(undefined, null, null).ok, false);
  assert.equal(offerInOrg({ org_id: ORG }, ORG), true);
  assert.equal(offerInOrg({ org_id: ORG2 }, ORG), false);
  assert.equal(offerInOrg(null, ORG), false);
  assert.equal(normalisePromoCode('%'), null);

  const ma = fnSrc('marketing-admin');
  const save = ma.slice(ma.indexOf("if (action === 'save_offer') {"), ma.indexOf("if (action === 'issue_code') {"));
  assert.ok(!save.includes("onConflict: 'id'") && !save.includes('row.id = incoming.id'), 'no upsert on a caller id');
  assert.ok(save.indexOf('planSaveOffer(') < save.indexOf(".update(row).eq('id', plan.id).eq('org_id', org_id)"), 'decided before it writes, org scoped');
  assert.ok(save.includes("if (!plan.ok) return json({ error: plan.error }, plan.status);"));
  const lookup = ma.slice(ma.indexOf("if (action === 'lookup_code') {"), ma.indexOf("if (action === 'void_code') {"));
  const voidc = ma.slice(ma.indexOf("if (action === 'void_code') {"), ma.indexOf("if (action === 'offer_stats') {"));
  for (const [name, blk] of [['lookup_code', lookup], ['void_code', voidc]]) {
    assert.ok(blk.includes('normalisePromoCode(body.code)') && blk.includes('escapeLike(code)') && blk.includes('pickPromoRow(rows, code, org_id)'), name);
    assert.ok(!blk.includes(".ilike('code', code)"), `${name}: no raw ilike`);
  }
  assert.ok(voidc.includes(".eq('id', row.id).eq('org_id', org_id)"), 'voids ONE row');
  assert.ok(lookup.includes(".eq('id', row.offer_id).eq('org_id', org_id)"));

  const pr = fnSrc('promo-redeem');
  assert.ok(pr.includes(".from('offers').select('*').eq('id', row.offer_id).eq('org_id', orgId)"), 'offer loaded in the venue org');
  assert.ok(pr.includes('offerInOrg(offerRow, orgId) ? offerRow : null'));
  assert.ok(!/\.from\('offers'\)\.select\('\*'\)\.eq\('id', row\.offer_id\)\.maybeSingle\(\)/.test(pr), 'no unscoped offer read left');
});

// ── 6. Smaller items ──────────────────────────────────────────────────────────
test('6. Grant Back Office access sends the active venue; workforce-compute and the admin portal ignore the profile venue', () => {
  const staff = code(read('../backoffice/sections/StaffManager.jsx'));
  const grant = staff.slice(staff.indexOf('const grantBOAccess = async'), staff.indexOf('const toggleBOAccess = async'));
  assert.ok(grant.includes('const locId = staffLocationId || staffScreenLocation(meProfile, getActiveLocationSync());'));
  assert.ok(grant.includes("if (!locId) { setGrantError('Choose a venue at the top of Back Office first');"));
  assert.ok(grant.includes('locationId: locId,') && !grant.includes('locationId: locId || null'), 'never null');

  const wc = fnSrc('workforce-compute');
  const fn = wc.slice(wc.indexOf('async function assertAccess'), wc.indexOf('Deno.serve('));
  assert.ok(!fn.includes('prof?.location_id') && !fn.includes("select('location_id, role')"), 'no profile venue arm');
  assert.ok(fn.includes('if (!user?.id || user.is_anonymous) return false;'));
  assert.ok(fn.includes(".eq('user_id', user.id).eq('location_id', loc)") && fn.includes("prof?.role === 'super_admin'"));
  assert.ok(wc.includes('assertAccess(user, String(location_id))'));

  const users = [
    { id: 'a', location_id: CUSTOMER, user_locations: [] },           // profile venue only
    { id: 'b', location_id: null, user_locations: [{ location_id: CUSTOMER }] },
    { id: 'c', location_id: HIS, user_locations: [{ location_id: HIS }] },
  ];
  assert.deepEqual(usersWithAccess(users, CUSTOMER).map((u) => u.id), ['b']);
  assert.deepEqual(usersWithAccess(null, CUSTOMER), []);
  const admin = code(read('../admin/CompanyAdminApp.jsx'));
  assert.ok(admin.includes('const usersForLocation = (locId) => usersWithAccess(allUsers.length > 0 ? allUsers : users, locId);'));
  assert.ok(!admin.includes('u.location_id === locId ||'));
});

test('6. a delayed gift card payment still issues the card; a read only pre deploy check lists stuck purchases', () => {
  const wh = fnSrc('stripe-webhook-connect');
  assert.ok(/case 'checkout\.session\.completed':\s+case 'checkout\.session\.async_payment_succeeded': \{/.test(wh), 'both events fulfil');
  assert.ok(wh.includes("const GIFT_SESSION_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);"));
  assert.ok(wh.includes('GIFT_SESSION_EVENTS.has(event.type)'), 'a replayed delayed payment event is processed again');
  assert.ok(wh.includes("(session as any).payment_status !== 'paid'"), 'an unpaid session still never marks the purchase paid');
  const q = read('../../supabase/queries/lockdown_step1_predeploy_checks.sql');
  assert.ok(!/\b(insert|update|delete|alter|drop|create|grant|revoke)\b/i.test(sqlCode(q)), 'read only');
  assert.ok(q.includes("status in ('paid', 'fulfilling', 'fulfilled')") && q.includes('gift_card_id is null'));
  assert.ok(q.includes('id <> ops_location_id'), 'lists the drifted venues to check for id collisions');
});

// ── 7. Deploy order and no misleading fallback ─────────────────────────────────
test('7. the profile migration states the deploy order: migrations, then functions, then the app, then Platform', () => {
  const raw = read(MIG_D);
  const plan = raw.slice(raw.indexOf('-- DEPLOY ORDER'), raw.indexOf('-- SCREENS THAT CHANGE'));
  const order = ['20260918_OPS_caller_authority_log.sql', 'THIS FILE, then 20260918e_OPS_venues_write_fence.sql', 'Deploy every changed or importing edge function', 'Merge, so Vercel ships the app', '20260918_PLATFORM_gift_purchases_server_only.sql'];
  let last = -1;
  for (const step of order) {
    const at = plan.indexOf(step);
    assert.ok(at > last, `${step} in order`);
    last = at;
  }
  assert.ok(read('../../supabase/functions/profile-admin/index.ts').includes('It must be DEPLOYED before the app that calls it ships'));
});

const DASHES = new RegExp('[\\u2013\\u2014]');
test('no em or en dashes in anything round four added', () => {
  for (const f of [MIG_D, MIG_E, '../../supabase/queries/profile_venue_backfill_candidates.sql',
    '../../supabase/queries/lockdown_step1_predeploy_checks.sql', './accessibleLocations.js', './lockdownStep1Round4.test.js']) {
    assert.ok(!DASHES.test(read(f)), f);
  }
});
