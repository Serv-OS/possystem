// moneyFunctionFence.test.js: database fence stage 1, the money edge functions (19 Sep 2026).
//
// Gift cards and loyalty are payments. Every gift, loyalty, promo and card refund function used
// to take ANY JWT as authority, and an anonymous one is free with the public anon key. This pins
// the fix, for every function and every kind of caller:
//   1. the device arm is EXACTLY the device arm of pos_can_access: a session bound to a devices row
//      of the venue (bound_via after 20260919a; the 18 Sep rule before it), or an ops device;
//   2. staff is the fenced user_accessible_locations(): user_locations, a verified super admin, or
//      a company role for the venue's company; never an anonymous session, never a profile venue;
//   3. the till loyalty paths report before 20260919a and enforce by themselves after it; every
//      other money path is enforced always;
//   4. each function asks its gate BEFORE it reads or moves anything.
// The edge functions cannot run under node (Deno.serve, esm.sh), so the facts and decisions live
// in _shared/callerFacts.ts (clients passed in), driven here by a fake Supabase client that answers
// like PostgREST (missing table, missing column, a network failure), and the wiring of each
// function is pinned by reading its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCallerFacts } from '../../supabase/functions/_shared/callerFacts.ts';
import {
  decideDeviceAccess, fenceStateFrom, isMissingSchema, loyaltyModeFor, DEVICE_LIVE_STATUSES,
} from '../../supabase/functions/_shared/deviceAuthority.ts';
import {
  decideGiftCardIdAuthority, decideGiftReverseAuthority, decideCardRefundAuthority, decideGiftFulfilAuthority,
  decideGiftStaffOnly, decideGiftListAuthority, decideGiftLookupAuthority, classifyGiftLookup,
} from '../../supabase/functions/_shared/gift-authority.ts';
import { decideLoyaltyAuthority, applyAuthorityMode } from '../../supabase/functions/_shared/loyalty-authority.ts';
import { decideStaffAccess, staffLocationKeys } from '../../supabase/functions/_shared/staffAccess.ts';
import { createSessionToken, SESSION_TTL_MS } from '../../supabase/functions/_shared/loyalty-session.ts';
import { decideCompanyStaff } from '../../supabase/functions/_shared/companyStaffAccess.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const fnSrc = (name) => code(read(`../../supabase/functions/${name}/index.ts`));

// ── A fake Supabase client that answers like PostgREST ──────────────────────
// Tables are arrays of rows. `missing.tables` answers PGRST205, `missing.columns[table]` answers
// 42703 when a select names that column, `failing` tables answer a network style error.
function fakeClient({ tables = {}, missing = {}, failing = [] } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = { table, filters: [], cols: '*', lim: null, single: false };
      const run = () => {
        calls.push({ table, cols: q.cols });
        if (failing.includes(table)) return { data: null, error: { code: '', message: 'TypeError: fetch failed' } };
        if ((missing.tables || []).includes(table)) {
          return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
        }
        const wanted = String(q.cols).split(',').map((c) => c.trim()).filter(Boolean);
        for (const col of (missing.columns?.[table] || [])) {
          if (wanted.includes(col)) return { data: null, error: { code: '42703', message: `column ${table}.${col} does not exist` } };
        }
        let rows = (tables[table] || []).filter((r) => q.filters.every((f) => f(r)));
        if (q.lim != null) rows = rows.slice(0, q.lim);
        if (q.single) {
          if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      };
      const b = {
        select(cols) { q.cols = cols; return b; },
        eq(c, v) { q.filters.push((r) => String(r[c]) === String(v)); return b; },
        in(c, vals) { const s = new Set((vals || []).map(String)); q.filters.push((r) => s.has(String(r[c]))); return b; },
        or(expr) {
          const parts = String(expr).split(',').map((p) => {
            const [c, op, ...rest] = p.split('.');
            return { c, op, v: rest.join('.') };
          });
          q.filters.push((r) => parts.some(({ c, op, v }) => op === 'eq' && String(r[c]) === v));
          return b;
        },
        limit(n) { q.lim = n; return b; },
        maybeSingle() { q.single = true; return b; },
        then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
      };
      return b;
    },
  };
}

// ── The world ───────────────────────────────────────────────────────────────
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L1 = '11111111-1111-4111-8111-111111111111';   // Ops venue 1, company C1
const L2 = '22222222-2222-4222-8222-222222222222';   // Ops venue 2, company C1
const L3 = '33333333-3333-4333-8333-333333333333';   // Ops venue 3, company C2
const P1 = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';   // Platform ids of the same venues
const P2 = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const P3 = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const C1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const C2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

const who = {
  customer: { id: U(1), is_anonymous: true },        // an online, QR or kiosk customer's browser
  till1: { id: U(2), is_anonymous: true },           // bound till at L1
  till3: { id: U(3), is_anonymous: true },           // bound till at L3 (another company)
  unbound: { id: U(4), is_anonymous: true },         // devices row at L1, claimed before the fence, never bound
  removed: { id: U(5), is_anonymous: true },         // devices row at L1, removed
  opsDevice: { id: U(6), is_anonymous: true },       // HACCP tablet (ops_devices) at L1
  manager1: { id: U(7), is_anonymous: false },       // Back Office, linked to L1
  manager3: { id: U(8), is_anonymous: false },       // Back Office, linked to L3 only
  superAdmin: { id: U(9), is_anonymous: false },
  anonSuper: { id: U(10), is_anonymous: true },      // an anonymous session whose profile says super_admin
  companyRole: { id: U(11), is_anonymous: false },   // Platform company role for C1, no venue link
  profileOnly: { id: U(12), is_anonymous: false },   // profile venue L1, no user_locations row
  stranger: { id: U(13), is_anonymous: false },      // a real login linked to nothing
  boTill: { id: U(14), is_anonymous: false },        // a till signed in with a Back Office login, bound at L1, login not linked
};

const baseTables = () => ({
  ops: {
    devices: [
      { id: U(101), device_uid: who.till1.id, location_id: L1, status: 'active', bound_via: 'grandfathered' },
      { id: U(102), device_uid: who.till3.id, location_id: L3, status: 'online', bound_via: 'claim' },
      { id: U(103), device_uid: who.unbound.id, location_id: L1, status: 'active', bound_via: null },
      { id: U(104), device_uid: who.removed.id, location_id: L1, status: 'removed', bound_via: 'claim' },
      { id: U(105), device_uid: who.boTill.id, location_id: L1, status: 'active', bound_via: 'claim' },
    ],
    ops_devices: [{ device_uid: who.opsDevice.id, location_id: L1, active: true }],
    user_profiles: [
      { id: who.manager1.id, role: 'manager', location_id: L1 },
      { id: who.manager3.id, role: 'owner', location_id: L3 },
      { id: who.superAdmin.id, role: 'super_admin', location_id: null },
      { id: who.anonSuper.id, role: 'super_admin', location_id: null },
      { id: who.profileOnly.id, role: 'owner', location_id: L1 },
      { id: who.stranger.id, role: 'owner', location_id: null },
    ],
    user_locations: [
      { user_id: who.manager1.id, location_id: L1 },
      { user_id: who.manager3.id, location_id: L3 },
    ],
    fence_state: [{ key: 'file_a', value: '20260919a' }],
    closed_checks: [],
  },
  platform: {
    locations: [
      { id: P1, ops_location_id: L1, company_id: C1 },
      { id: P2, ops_location_id: L2, company_id: C1 },
      { id: P3, ops_location_id: L3, company_id: C2 },
    ],
    user_company_roles: [{ user_id: who.companyRole.id, company_id: C1 }],
  },
});

const SECRET = 'test-otp-secret';
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A callerFacts instance on a fresh fake database. stage 'fenced' (20260919a in), 'legacy' (before it). */
function world({ stage = 'fenced', env = {}, tweak = null, failingOps = [] } = {}) {
  const t = baseTables();
  const missing = { tables: [], columns: {} };
  if (stage === 'legacy') {
    t.ops.fence_state = undefined;
    missing.tables.push('fence_state');
    missing.columns.devices = ['bound_via'];
    for (const d of t.ops.devices) delete d.bound_via;
  }
  if (stage === 'rolled_back') t.ops.fence_state = [];    // A's roll back deletes the row; the column stays
  if (tweak) tweak(t);
  const ops = fakeClient({ tables: t.ops, missing, failing: failingOps });
  const platform = fakeClient({ tables: t.platform });
  const logs = [];
  const facts = createCallerFacts({
    ops, platform, otpSecret: SECRET, json: jsonResponse,
    env: (k) => env[k], log: (_line, row) => logs.push(row),
  });
  return { facts, ops, platform, logs, tables: t };
}

// ══ 1. The device arm is pos_can_access ═════════════════════════════════════
test('fence state: file A in is "fenced"; no table, or its roll back, is "legacy"; a blip keeps the last answer', async () => {
  assert.equal(fenceStateFrom({ data: [{ key: 'file_a' }], error: null }), 'fenced');
  assert.equal(fenceStateFrom({ data: [], error: null }), 'legacy', 'the roll back deletes the file_a row');
  assert.equal(fenceStateFrom({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.fence_state' in the schema cache" } }), 'legacy');
  assert.equal(fenceStateFrom({ data: null, error: { code: '42P01', message: 'relation "public.fence_state" does not exist' } }), 'legacy');
  assert.equal(fenceStateFrom({ data: null, error: { code: '', message: 'fetch failed' } }), 'unknown');
  assert.ok(isMissingSchema({ code: '42703', message: 'column devices.bound_via does not exist' }));
  assert.ok(!isMissingSchema({ code: '42501', message: 'permission denied' }));

  assert.equal(await world({ stage: 'fenced' }).facts.fenceState(), 'fenced');
  assert.equal(await world({ stage: 'legacy' }).facts.fenceState(), 'legacy');
  assert.equal(await world({ stage: 'rolled_back' }).facts.fenceState(), 'legacy');
  assert.equal(await world({ failingOps: ['fence_state'] }).facts.fenceState(), 'unknown');
});

test('device arm, after file A: only a session BOUND to a live devices row of THIS venue', async () => {
  const { facts } = world({ stage: 'fenced' });
  const at = async (u, venue) => facts.callerDeviceFor(u, venue);
  assert.deepEqual((await at(who.till1, L1)), { ok: true, via: 'device', reason: null, fence: 'fenced' });
  assert.equal((await at(who.till1, L2)).reason, 'other_venue', 'a till of the same company but another venue');
  assert.equal((await at(who.till3, L1)).reason, 'other_venue', 'a till of another company');
  assert.equal((await at(who.unbound, L1)).reason, 'not_bound', 'a devices row nobody bound is not a device after the fence');
  assert.equal((await at(who.removed, L1)).reason, 'not_live');
  assert.deepEqual(await at(who.opsDevice, L1), { ok: true, via: 'ops_device', reason: null, fence: 'fenced' });
  assert.equal((await at(who.customer, L1)).reason, 'no_device');
  assert.equal((await at(who.manager1, L1)).reason, 'no_device', 'a Back Office login is not a device (it is staff, below)');
  assert.equal((await at(null, L1)).ok, false);
  assert.equal((await at(who.till1, 'not-a-uuid')).ok, false);
  assert.equal((await at(who.till1, null)).ok, false);
});

test('device arm, before file A (fall back safely): the 18 Sep rule, so a till keeps working', async () => {
  const { facts, ops } = world({ stage: 'legacy' });
  assert.deepEqual(await facts.callerDeviceFor(who.till1, L1), { ok: true, via: 'device', reason: null, fence: 'legacy' });
  assert.equal((await facts.callerDeviceFor(who.unbound, L1)).ok, true, 'before the fence a claim is the device link (the live pos_can_access)');
  assert.equal((await facts.callerDeviceFor(who.removed, L1)).ok, false, 'a removed row never counts');
  assert.equal((await facts.callerDeviceFor(who.till1, L2)).ok, false, 'another venue never counts');
  assert.ok(ops.calls.filter((c) => c.table === 'devices').every((c) => !c.cols.includes('bound_via')), 'no bound_via read before the fence');
});

test('device arm after a roll back of file A: back to the 18 Sep rule (the column stays, the row goes)', async () => {
  const { facts } = world({ stage: 'rolled_back' });
  assert.equal((await facts.callerDeviceFor(who.unbound, L1)).ok, true);
});

test('device arm when the fence read fails: the stricter reading, and a missing column still falls back', async () => {
  const strict = world({ stage: 'fenced', failingOps: ['fence_state'] });
  assert.equal((await strict.facts.callerDeviceFor(who.unbound, L1)).reason, 'not_bound');
  assert.equal((await strict.facts.callerDeviceFor(who.till1, L1)).ok, true);
  const old = world({ stage: 'legacy', failingOps: ['fence_state'] });
  const d = await old.facts.callerDeviceFor(who.unbound, L1);
  assert.equal(d.ok, true, 'no bound_via column means the fence has not run: legacy rule');
  assert.equal(d.fence, 'legacy');
});

test('the pure device decision matches pos_can_access row by row', () => {
  const rows = [{ device_uid: 'u', location_id: 'L', status: 'active', bound_via: 'claim' }];
  assert.deepEqual(DEVICE_LIVE_STATUSES, ['active', 'online']);
  assert.equal(decideDeviceAccess({ uid: 'u', opsLocationId: 'L', fence: 'fenced', devices: rows }).ok, true);
  for (const status of ['removed', 'unpaired', 'awaiting_pairing', null]) {
    assert.equal(decideDeviceAccess({ uid: 'u', opsLocationId: 'L', fence: 'fenced', devices: [{ ...rows[0], status }] }).ok, false, String(status));
  }
  assert.equal(decideDeviceAccess({ uid: 'u', opsLocationId: 'L', fence: 'fenced', devices: [{ ...rows[0], bound_via: null }] }).ok, false);
  assert.equal(decideDeviceAccess({ uid: 'u', opsLocationId: 'L', fence: 'unknown', devices: [{ ...rows[0], bound_via: null }] }).ok, false, 'unknown is read strictly');
  assert.equal(decideDeviceAccess({ uid: 'u', opsLocationId: 'L', fence: 'legacy', devices: [{ ...rows[0], bound_via: null }] }).ok, true);
  assert.equal(decideDeviceAccess({ uid: 'u', opsLocationId: 'L', fence: 'fenced', devices: [{ ...rows[0], device_uid: 'other' }] }).ok, false, 'another session\'s row');
  assert.equal(decideDeviceAccess({ uid: 'u', opsLocationId: 'L', fence: 'fenced', opsDevices: [{ device_uid: 'u', location_id: 'L', active: false }] }).ok, false);
});

// ══ 2. Staff is the fenced user_accessible_locations() ══════════════════════
test('staff: a user_locations link, a verified super admin, or a company role; never anonymous, never a profile venue', async () => {
  const { facts } = world();
  const staff = (u, loc, co = null) => facts.callerIsStaffFor(u, loc, co);
  assert.equal(await staff(who.manager1, L1), true);
  assert.equal(await staff(who.manager1, P1), true, 'the Platform id of the same venue resolves to its Ops id');
  assert.equal(await staff(who.manager1, L2), false, 'another venue of the same company is not theirs');
  assert.equal(await staff(who.manager1, L3), false);
  assert.equal(await staff(who.manager3, L1), false);
  assert.equal(await staff(who.superAdmin, L3), true);
  assert.equal(await staff(who.anonSuper, L1), false, 'an anonymous session is never staff, whatever its profile says');
  assert.equal(await staff(who.companyRole, L1), true, 'a company role counts for its own company');
  assert.equal(await staff(who.companyRole, L3), false, 'and never for another');
  assert.equal(await staff(who.profileOnly, L1), false, 'a profile venue is never access (it was self writable)');
  assert.equal(await staff(who.stranger, L1), false);
  assert.equal(await staff(who.till1, L1), false, 'a till is a device, not staff');
  assert.equal(await staff(who.boTill, L1), false, 'a Back Office login not linked to the venue is not its staff');
  assert.equal(await staff(who.manager1, null, C1), true, 'company level: a link to any venue of the company');
  assert.equal(await staff(who.manager1, null, C2), false);
});

test('staff: only the RESOLVED Ops id counts (a drifted Platform id is never read as an Ops id)', () => {
  assert.deepEqual(staffLocationKeys(P1, [{ id: P1, ops_location_id: L1, company_id: C1 }]), { keys: [L1], companyId: C1 });
  assert.deepEqual(staffLocationKeys(L1, [{ id: P1, ops_location_id: L1, company_id: C1 }]), { keys: [L1], companyId: C1 });
  assert.deepEqual(staffLocationKeys(P2, [{ id: P2, ops_location_id: null, company_id: C1 }]), { keys: [], companyId: C1 }, 'a Platform row without a mapping gives nothing');
  // decideCompanyStaff (contract P3) is the company level question of the same rule.
  const f = { user: { id: 'u' }, role: 'owner', userLocationIds: [L2], companyOpsLocationIds: [L1, L2], companyRoleCompanyIds: [], companyId: C1 };
  assert.deepEqual(decideCompanyStaff(f), decideStaffAccess({ ...f, locationKeys: [] }));
});

test('staff or device: the venue must be the company of the call; staff never needs the device read', async () => {
  const { facts, ops } = world();
  assert.deepEqual(await facts.callerStaffOrDevice(who.manager1, L1, C1), { staff: true, device: false, deviceReason: null, opsLocationId: null, fence: null });
  assert.ok(!ops.calls.some((c) => c.table === 'devices'), 'no device read for staff');
  const t = await facts.callerStaffOrDevice(who.till1, L1, C1);
  assert.equal(t.device, true);
  assert.equal(t.opsLocationId, L1);
  assert.equal((await facts.callerStaffOrDevice(who.till1, P1, C1)).device, true, 'a Platform id of the venue works too');
  assert.equal((await facts.callerStaffOrDevice(who.till1, L1, C2)).deviceReason, 'other_venue', 'the venue must be of the company the call resolved');
  assert.equal((await facts.callerStaffOrDevice(who.customer, L1, C1)).device, false);
  assert.equal((await facts.callerStaffOrDevice(null, L1, C1)).deviceReason, 'no_session');
});

// ══ 3. Loyalty: report before file A, enforced after it ═════════════════════
test('the mode follows the fence; LOYALTY_AUTHORITY_MODE can force either; a typo follows the fence', async () => {
  assert.equal(loyaltyModeFor(undefined, 'legacy'), 'report');
  assert.equal(loyaltyModeFor(undefined, 'fenced'), 'enforce');
  assert.equal(loyaltyModeFor(undefined, 'unknown'), 'enforce');
  assert.equal(loyaltyModeFor('enforce', 'legacy'), 'enforce');
  assert.equal(loyaltyModeFor(' Report ', 'fenced'), 'report', 'the escape hatch');
  assert.equal(loyaltyModeFor('enforced', 'legacy'), 'report', 'a typo never starts refusing tills before the fence');
  assert.equal(loyaltyModeFor('enforced', 'fenced'), 'enforce');
  assert.equal(await world({ stage: 'fenced' }).facts.loyaltyMode(), 'enforce');
  assert.equal(await world({ stage: 'legacy' }).facts.loyaltyMode(), 'report');
  assert.equal(await world({ stage: 'legacy', env: { LOYALTY_AUTHORITY_MODE: 'enforce' } }).facts.loyaltyMode(), 'enforce');
  assert.equal(await world({ stage: 'fenced', env: { LOYALTY_AUTHORITY_MODE: 'report' } }).facts.loyaltyMode(), 'report');
});

const CUSTOMER = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const OTHER_CUSTOMER = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
const memberToken = (customerId = CUSTOMER, companyId = C1, at = Date.now()) => createSessionToken(customerId, companyId, '+447700900001', SECRET, at);

// Every kind of caller, and what each loyalty till path says to it after the fence.
async function loyaltyCase(name, caller, extra = {}) {
  return { name, caller, ...extra };
}

test('loyalty-earn and loyalty-redeem, after file A: a bound till, staff, or the member themselves; nobody else', async () => {
  const cases = [
    await loyaltyCase('bound till of the venue', who.till1, { ok: 'device' }),
    await loyaltyCase('ops device of the venue', who.opsDevice, { ok: 'device' }),
    await loyaltyCase('Back Office of the venue', who.manager1, { ok: 'staff' }),
    await loyaltyCase('super admin', who.superAdmin, { ok: 'staff' }),
    await loyaltyCase('company role', who.companyRole, { ok: 'staff' }),
    await loyaltyCase('the member (own token, anonymous browser)', who.customer, { token: await memberToken(), ok: 'member' }),
    await loyaltyCase('the member with no session at all', null, { token: await memberToken(), ok: 'member' }),
    await loyaltyCase('anonymous customer', who.customer, { reason: 'anonymous_no_device' }),
    await loyaltyCase('member token for somebody else', who.customer, { token: await memberToken(OTHER_CUSTOMER), reason: 'member_token_other_customer' }),
    await loyaltyCase('member token of another company', who.customer, { token: await memberToken(CUSTOMER, C2), reason: 'member_token_other_customer' }),
    await loyaltyCase('forged member token', who.customer, { token: 'Zm9vOmJhcjox.deadbeef', reason: 'member_token_invalid' }),
    await loyaltyCase('till of another venue', who.till3, { reason: 'device_other_venue' }),
    await loyaltyCase('devices row nobody bound', who.unbound, { reason: 'device_not_bound' }),
    await loyaltyCase('removed till', who.removed, { reason: 'device_not_bound' }),
    await loyaltyCase('Back Office of another venue', who.manager3, { reason: 'no_location_access' }),
    await loyaltyCase('profile venue only', who.profileOnly, { reason: 'no_location_access' }),
    await loyaltyCase('anonymous session with a super admin profile', who.anonSuper, { reason: 'anonymous_no_device' }),
  ];
  for (const fn of ['loyalty-earn', 'loyalty-redeem']) {
    for (const c of cases) {
      const { facts, logs } = world({ stage: 'fenced' });
      const g = await facts.checkLoyaltyAuthority({
        fn, caller: c.caller, locationId: L1, companyId: C1, customerId: CUSTOMER, memberToken: c.token, closedCheckId: 'chk-1',
      });
      assert.equal(g.mode, 'enforce', `${fn} ${c.name}: enforce after file A`);
      if (c.ok) {
        assert.equal(g.allow, true, `${fn} ${c.name}`);
        assert.equal(g.decision.via, c.ok, `${fn} ${c.name}`);
        assert.equal(logs.length, 0, `${fn} ${c.name}: nothing logged for an allowed call`);
      } else {
        assert.equal(g.allow, false, `${fn} ${c.name}`);
        assert.equal(g.decision.reason, c.reason, `${fn} ${c.name}`);
        assert.equal(g.response.status, c.caller ? 403 : 401);
        assert.equal((await g.response.json()).code, 'loyalty_authority');
        assert.equal(logs.length, 1, `${fn} ${c.name}: one [authority] line`);
        assert.equal(logs[0].outcome, 'refused');
      }
    }
  }
});

test('loyalty-refund: a bound till or staff only; the member\'s own token NEVER refunds', async () => {
  const cases = [
    [who.till1, undefined, true],
    [who.manager1, undefined, true],
    [who.customer, await memberToken(), false],
    [null, await memberToken(), false],
    [who.customer, undefined, false],
    [who.till3, undefined, false],
  ];
  for (const [caller, token, ok] of cases) {
    const { facts } = world({ stage: 'fenced' });
    const g = await facts.checkLoyaltyAuthority({
      fn: 'loyalty-refund', caller, locationId: L1, companyId: C1, customerId: CUSTOMER, memberToken: token,
      closedCheckId: 'chk-1', memberAllowed: false,
    });
    assert.equal(g.allow, ok, `${caller?.id ?? 'no session'} ${token ? 'with token' : ''}`);
    if (!ok && token) assert.equal(g.decision.reason, caller ? 'member_token_not_accepted' : 'member_token_not_accepted');
  }
});

test('before file A the loyalty till paths REPORT: every call goes through, the would-be refusals are logged', async () => {
  for (const [caller, token] of [[who.customer, undefined], [who.till3, undefined], [who.customer, await memberToken(OTHER_CUSTOMER)]]) {
    const { facts, logs } = world({ stage: 'legacy' });
    const g = await facts.checkLoyaltyAuthority({ fn: 'loyalty-redeem', caller, locationId: L1, companyId: C1, customerId: CUSTOMER, memberToken: token });
    assert.equal(g.mode, 'report');
    assert.equal(g.allow, true, 'report never refuses (a till whose link is missing must not lose sales)');
    assert.equal(g.decision.ok, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].outcome, 'would_refuse');
  }
  // A till claimed before the fence passes the 18 Sep device rule, so it is not even logged.
  const { facts, logs } = world({ stage: 'legacy' });
  const g = await facts.checkLoyaltyAuthority({ fn: 'loyalty-earn', caller: who.unbound, locationId: L1, companyId: C1, customerId: CUSTOMER });
  assert.equal(g.decision.via, 'device');
  assert.equal(logs.length, 0);
  // The owner can enforce before the fence if they want to.
  const forced = world({ stage: 'legacy', env: { LOYALTY_AUTHORITY_MODE: 'enforce' } });
  assert.equal((await forced.facts.checkLoyaltyAuthority({ fn: 'loyalty-earn', caller: who.customer, locationId: L1, companyId: C1, customerId: CUSTOMER })).allow, false);
});

test('a member token past its 24 hours counts only for the order it was live for', async () => {
  const issued = Date.now() - SESSION_TTL_MS - 60_000;
  const token = await memberToken(CUSTOMER, C1, issued);
  const { facts } = world({
    tweak: (t) => { t.ops.closed_checks.push({ id: 'chk-old', location_id: L1, closed_at: new Date(issued + 60_000).toISOString() }); },
  });
  const replay = await facts.memberSessionFor(token, { closedCheckId: 'chk-old', locationId: L1 });
  assert.equal(replay?.replay, true);
  assert.equal(await facts.memberSessionFor(token, { closedCheckId: 'chk-new', locationId: L1 }), null, 'an order it was not live for');
  assert.equal(await facts.memberSessionFor(token, {}), null);
  const live = await facts.memberSessionFor(await memberToken(), {});
  assert.deepEqual(live, { customerId: CUSTOMER, companyId: C1, phone: '+447700900001', replay: false });
});

test('a bad member token never locks out a bound till or a manager', async () => {
  for (const caller of [who.till1, who.manager1]) {
    const { facts } = world({ stage: 'fenced' });
    const g = await facts.checkLoyaltyAuthority({ fn: 'loyalty-earn', caller, locationId: L1, companyId: C1, customerId: CUSTOMER, memberToken: 'junk.00' });
    assert.equal(g.allow, true);
  }
});

// ══ 4. The gift card, promo and refund decisions for every caller ═══════════
test('staff only (issue, import, bulk create, config, void, resend, loyalty settings and rewards): nobody else, before or after the fence', async () => {
  for (const stage of ['legacy', 'fenced']) {
    for (const [caller, ok] of [
      [who.manager1, true], [who.superAdmin, true], [who.companyRole, true],
      [who.customer, false], [who.till1, false], [who.opsDevice, false], [who.manager3, false],
      [who.profileOnly, false], [who.anonSuper, false], [who.boTill, false], [null, false],
    ]) {
      const { facts, logs } = world({ stage });
      const r = await facts.requireStaff({ fn: 'gift-issue', caller, locationId: L1, companyId: C1, what: 'issue gift cards' });
      assert.equal(r === null, ok, `${stage} ${caller?.id ?? 'no session'}`);
      if (!ok) {
        assert.equal(r.status, caller ? 403 : 401);
        const j = await r.json();
        assert.equal(j.code, 'staff_only');
        assert.equal(logs.length, 1);
      }
    }
  }
});

test('gift-redeem by card id (no code): staff, a bound till of the venue, or the member who owns the card', async () => {
  const card = { recipient_phone: '07700 900001' };
  const decide = async (caller, stage, extra = {}) => {
    const { facts } = world({ stage });
    const f = await facts.callerStaffOrDevice(caller, L1, C1);
    const session = extra.token ? await facts.memberSessionFor(extra.token) : null;
    return decideGiftCardIdAuthority({
      user: caller, staff: f.staff, device: f.device, companyId: C1,
      memberTokenSent: !!extra.token, memberSession: session,
      cardOnMemberPhone: !!session && extra.owns !== false,
    });
  };
  assert.equal((await decide(who.manager1, 'fenced')).via, 'staff');
  assert.equal((await decide(who.till1, 'fenced')).via, 'device');
  assert.equal((await decide(who.opsDevice, 'fenced')).via, 'device');
  assert.equal((await decide(who.customer, 'fenced', { token: await memberToken() })).via, 'member');
  assert.equal((await decide(who.customer, 'fenced', { token: await memberToken(), owns: false })).reason, 'member_not_card_owner');
  assert.equal((await decide(who.customer, 'fenced')).reason, 'card_id_without_code');
  assert.equal((await decide(who.unbound, 'fenced')).ok, false, 'an unbound till after the fence');
  assert.equal((await decide(who.unbound, 'legacy')).ok, true, 'the same till before the fence (18 Sep rule)');
  assert.equal((await decide(who.till3, 'fenced')).ok, false, 'a till of another company');
  assert.equal((await decide(who.customer, 'fenced', { token: await memberToken(CUSTOMER, C2) })).ok, false, 'a member of another company');
  assert.equal(card.recipient_phone.length > 0, true);
});

test('gift-reverse-redeem (puts money back on a card): staff or a bound till of the venue; never the customer or the member', async () => {
  for (const [caller, stage, ok] of [
    [who.manager1, 'fenced', true], [who.till1, 'fenced', true], [who.opsDevice, 'fenced', true],
    [who.customer, 'fenced', false], [who.customer, 'legacy', false], [who.till3, 'fenced', false],
    [who.unbound, 'fenced', false], [who.unbound, 'legacy', true], [who.manager3, 'fenced', false], [null, 'fenced', false],
  ]) {
    const { facts } = world({ stage });
    const f = await facts.callerStaffOrDevice(caller, L1, C1);
    const d = decideGiftReverseAuthority({ user: caller, staff: f.staff, device: f.device, deviceReason: f.deviceReason });
    assert.equal(d.ok, ok, `${stage} ${caller?.id ?? 'no session'}`);
  }
  const d = decideGiftReverseAuthority({ user: who.unbound, staff: false, device: false, deviceReason: 'not_bound' });
  assert.equal(d.reason, 'device_not_bound');
  assert.match(d.error, /Pair this till again/);
});

test('card refunds (stripe-refund, ryft-refund): the service role, staff, or a bound till of the venue', async () => {
  for (const [caller, ok] of [
    [who.manager1, true], [who.superAdmin, true], [who.till1, true],
    [who.customer, false], [who.till3, false], [who.unbound, false], [who.stranger, false], [who.profileOnly, false], [null, false],
  ]) {
    const { facts } = world({ stage: 'fenced' });
    const f = await facts.callerStaffOrDevice(caller, L1, null);
    const d = decideCardRefundAuthority({ serviceRole: false, user: caller, staff: f.staff, device: f.device, deviceReason: f.deviceReason });
    assert.equal(d.ok, ok, caller?.id ?? 'no session');
  }
  assert.deepEqual(decideCardRefundAuthority({ serviceRole: true, user: null, staff: false, device: false }), { ok: true, via: 'service' });
});

test('gift-fulfill: the webhook (service role) or staff; list and search: staff; lookup by the full code: anybody', () => {
  assert.equal(decideGiftFulfilAuthority({ serviceRole: true, user: null, staff: false }).via, 'webhook');
  assert.equal(decideGiftFulfilAuthority({ serviceRole: false, user: who.manager1, staff: true }).via, 'staff');
  assert.equal(decideGiftFulfilAuthority({ serviceRole: false, user: who.customer, staff: false }).status, 403);
  assert.equal(decideGiftFulfilAuthority({ serviceRole: false, user: null, staff: false }).status, 401);
  assert.equal(decideGiftListAuthority({ user: who.customer, staff: false }).ok, false);
  assert.equal(decideGiftListAuthority({ user: who.anonSuper, staff: true }).ok, false, 'anonymous is never staff');
  assert.equal(decideGiftListAuthority({ user: who.manager1, staff: true }).ok, true);
  assert.equal(classifyGiftLookup({ code: 'ABCD EFGH JKLM NPQR' }), 'code');
  assert.equal(classifyGiftLookup({ search: 'Sam Smith' }), 'staff_search');
  assert.deepEqual(decideGiftLookupAuthority('code', { user: who.customer, staff: false }), { ok: true, view: 'code_holder' });
  assert.equal(decideGiftLookupAuthority('staff_search', { user: who.customer, staff: false }).status, 403);
  assert.equal(decideGiftStaffOnly({ user: who.till1, staff: false }).reason, 'anonymous');
});

test('every caller kind against every loyalty path, in one table (after file A)', async () => {
  const kinds = [
    ['anonymous customer', who.customer, undefined],
    ['member', who.customer, 'member'],
    ['bound till', who.till1, undefined],
    ['unbound till', who.unbound, undefined],
    ['till of another venue', who.till3, undefined],
    ['Back Office of the venue', who.manager1, undefined],
    ['Back Office elsewhere', who.manager3, undefined],
  ];
  const expected = {
    //                          customer member till  unbound other  bo    bo elsewhere
    'loyalty-earn':            [false,   true,  true, false,  false, true, false],
    'loyalty-redeem':          [false,   true,  true, false,  false, true, false],
    'loyalty-refund':          [false,   false, true, false,  false, true, false],
    'loyalty-balance (full)':  [false,   true,  true, false,  false, true, false],
    'loyalty-member-lookup':   [false,   true,  true, false,  false, true, false],
    'loyalty-enroll':          [false,   true,  true, false,  false, true, false],
  };
  for (const [fn, row] of Object.entries(expected)) {
    for (let k = 0; k < kinds.length; k++) {
      const [name, caller, t] = kinds[k];
      const { facts } = world({ stage: 'fenced' });
      const g = await facts.checkLoyaltyAuthority({
        fn, caller, locationId: L1, companyId: C1, customerId: CUSTOMER,
        memberToken: t === 'member' ? await memberToken() : undefined,
        memberAllowed: fn !== 'loyalty-refund',
        modeOverride: fn === 'loyalty-member-lookup' || fn === 'loyalty-enroll' ? 'enforce' : undefined,
      });
      assert.equal(g.allow, row[k], `${fn} / ${name}`);
    }
  }
});

test('report and enforce are the only two outcomes the gate can have', () => {
  const refused = decideLoyaltyAuthority({ user: who.customer, memberTokenSent: false, memberSession: null, staffHasLocation: false, device: false, customerId: 'x', companyId: 'y' });
  assert.deepEqual(applyAuthorityMode(refused, 'report'), { allow: true, record: true, outcome: 'would_refuse' });
  assert.deepEqual(applyAuthorityMode(refused, 'enforce'), { allow: false, record: true, outcome: 'refused' });
});

// ══ 5. Every function asks its gate BEFORE it reads or moves anything ═══════
const before = (src, gate, laterList, label) => {
  const g = src.indexOf(gate);
  assert.ok(g > 0, `${label}: ${gate}`);
  for (const later of laterList) {
    const at = src.indexOf(later, 0);
    assert.ok(at > g, `${label}: ${later} must come after the gate`);
  }
};

test('staff only functions: the gate comes before any read or write', () => {
  for (const [fn, what, laterList] of [
    ['gift-issue', 'issue gift cards', ["from('gift_brand_config')", "from('gift_cards')"]],
    ['gift-import', 'import gift cards', ["from('gift_brand_config')", "from('gift_cards')"]],
    ['gift-bulk-create', 'create gift cards', ["from('gift_brand_config')", "from('gift_cards')"]],
    ['gift-void', 'void gift cards', ["from('gift_cards')", "from('gift_card_transactions')"]],
    ['gift-resend', 'resend gift cards', ["from('gift_cards')", "from('gift_card_purchases')"]],
    ['gift-config', 'change gift card settings', ["from('gift_brand_config')"]],
  ]) {
    const src = fnSrc(fn);
    before(src, `requireStaff({\n    fn: '${fn}'`, laterList, fn);
    assert.ok(src.includes(`what: '${what}'`), `${fn}: says what is refused`);
    assert.ok(src.includes('if (refused) return refused;'), `${fn}: stops on a refusal`);
  }
  const cfg = fnSrc('gift-config');
  assert.ok(!/return json\(\{ config: (data|config|newConfig) \}\)/.test(cfg), 'gift-config never returns the raw row');
  assert.ok(cfg.includes('withoutSecret('), 'the HMAC secret never leaves the server');
  for (const fn of ['loyalty-config', 'loyalty-rewards']) {
    const src = fnSrc(fn);
    assert.ok(src.includes(`requireStaff({\n      fn: '${fn}'`) || src.includes(`requireStaff({\n    fn: '${fn}'`), `${fn}: writes are staff only`);
  }
  const rewards = fnSrc('loyalty-rewards');
  assert.ok(rewards.indexOf('requireStaff(') > rewards.indexOf("if (req.method === 'GET')"), 'loyalty-rewards GET stays open (online checkout reads the catalogue)');
});

test('gift-issue: a body org_id can never point the card at another company', () => {
  const src = fnSrc('gift-issue');
  assert.ok(src.includes("return json({ error: 'org_id does not match the location', code: 'company_mismatch' }, 403);"));
});

test('gift-redeem: a code proves possession; a card id alone meets the gate after the idempotency check and before the debit', () => {
  const src = fnSrc('gift-redeem');
  const hmac = src.indexOf(".eq('code_lookup', lookup)");
  const plain = src.indexOf(".eq('code_plain', normalized)");
  const byId = src.indexOf(".eq('id', card_id)");
  assert.ok(hmac > 0 && plain > hmac && byId > plain, 'HMAC, then code_plain, THEN card id');
  assert.ok(src.includes('if (card) provedByCode = true;'));
  const idem = src.indexOf("from('gift_card_transactions')");
  const gate = src.indexOf('const who = await callerStaffOrDevice(caller,');
  const debit = src.indexOf("rpc('redeem_gift_card_atomic'");
  assert.ok(idem > 0 && gate > idem && debit > gate, 'idempotent retry answered first, then the gate, then the debit');
  assert.ok(src.includes('if (!provedByCode) {'));
  assert.ok(src.includes("return json({ error: authority.error, code: 'gift_card_code_required' }, authority.status);"));
  assert.ok(!src.includes('callerDeviceCompany'), 'the forgeable company level device read is gone');
});

test('gift-reverse-redeem: the gate before any read, the refund row is the claim, the balance moves by compare and swap', () => {
  const src = fnSrc('gift-reverse-redeem');
  before(src, 'const who = await callerStaffOrDevice(caller,', ["from('gift_card_transactions')", "from('gift_cards')"], 'gift-reverse-redeem');
  assert.ok(src.includes("return json({ error: authority.error, code: 'gift_reverse_not_allowed', reason: authority.reason }, authority.status);"));
  assert.ok(src.indexOf(".insert({") < src.indexOf(".eq('balance_minor', cur.balance_minor)"), 'claim first, then compare and swap');
});

test('gift-fulfill: authority, then processor proof, then a claim, THEN a card; the code only to staff', () => {
  const src = fnSrc('gift-fulfill');
  const who = src.indexOf('decideGiftFulfilAuthority({ serviceRole, user: caller, staff })');
  const proof = src.indexOf('const proof = await provePurchasePaid(purchase);');
  const claim = src.indexOf(".update({ status: 'fulfilling', updated_at: claimedAt })");
  const card = src.indexOf(".from('gift_cards')\n      .insert({");
  assert.ok(who > 0 && proof > who && claim > proof && card > claim);
  assert.ok(src.includes('...(callerUserId ? { code: formatCode(normalized) } : {}),'), 'a webhook never gets the code');
  assert.ok(!src.includes('fulfilled_code: normalized'));
});

test('gift-list and gift-lookup: staff before any read; a code holder sees no email, note or history', () => {
  const list = fnSrc('gift-list');
  before(list, 'const staff = await callerIsStaffFor(caller,', ["from('gift_card_purchases')", "from('gift_cards')"], 'gift-list');
  const lookup = fnSrc('gift-lookup');
  before(lookup, 'const authority = decideGiftLookupAuthority(lookupKind, { user: caller, staff });', ["from('gift_cards')"], 'gift-lookup');
  assert.ok(lookup.includes("const shape = (full: Record<string, unknown>) => (authority.view === 'full' ? full : codeHolderView(full));"));
});

test('loyalty-earn, loyalty-redeem and loyalty-refund run the fence before reading or moving anything', () => {
  for (const [fn, firstRead] of [
    ['loyalty-earn', "from('closed_checks')"],
    ['loyalty-refund', "from('loyalty_transactions')"],
    ['loyalty-redeem', "from('stamp_card_programs')"],
  ]) {
    const src = fnSrc(fn);
    const fence = src.indexOf(`checkLoyaltyAuthority({\n    fn: '${fn}',`);
    assert.ok(fence > 0, `${fn}: calls checkLoyaltyAuthority`);
    const stop = src.indexOf('if (!gate.allow) return gate.response!;', fence);
    assert.ok(stop > fence);
    assert.ok(src.indexOf(firstRead) > stop, `${fn}: ${firstRead} comes after the fence`);
  }
  assert.ok(fnSrc('loyalty-refund').includes('memberAllowed: false,'), 'a member never refunds');
  const earn = fnSrc('loyalty-earn');
  assert.ok(earn.includes('const venue = await resolveVenue(String(location_id));'), 'the check is read at the resolved Ops venue');
  assert.ok(earn.includes('decideEarnSource({'), 'earns from the server\'s own closed check');
});

test('loyalty-balance and loyalty-member-lookup: full detail only with authority; the gift cards list is always empty', () => {
  const bal = fnSrc('loyalty-balance');
  assert.ok(bal.includes("if (url.searchParams.get('view') === 'summary') return json(limitedMemberReply(_cfg));"));
  assert.ok(bal.includes('const serviceRole = isServiceRoleRequest(req);'));
  assert.ok(bal.includes('if (gate && !gate.allow) return json(limitedMemberReply(_cfg));'));
  assert.ok(bal.includes("memberToken: req.headers.get('x-member-token'),"));
  assert.ok(!bal.includes("from('gift_cards')"), 'no gift card read at all');
  assert.ok(bal.includes('const giftCards: never[] = [];'));
  const look = fnSrc('loyalty-member-lookup');
  assert.ok(look.includes("modeOverride: 'enforce',"), 'enforced always (no caller in the app)');
  assert.ok(look.includes(".eq('org_id', orgId)"), 'every customer read fenced to the venue org');
});

test('loyalty-enroll and loyalty-otp: enrolment needs authority; gift cards only on the phone proven with the code', () => {
  const enroll = fnSrc('loyalty-enroll');
  assert.ok(enroll.includes('const serviceRole = isServiceRoleRequest(req);'));
  assert.ok(enroll.includes("modeOverride: 'enforce',"));
  assert.ok(enroll.includes('if (!customerInCompany(customer, orgIds)) {'));
  const otp = fnSrc('loyalty-otp');
  assert.ok(!otp.includes('recipient_name'), 'never matches a card by name');
  assert.ok(!otp.includes('recipient_email'), 'never matches a card by email (update_profile sets it unverified)');
  assert.ok(otp.includes('createSessionToken(customer.id, companyId, phone)'), 'the token carries the proven phone');
  assert.ok(otp.includes("{ headers: { 'x-member-token': token } }"), 'the portal refresh proves the member to loyalty-balance');
});

test('promo codes: exact match inside the venue\'s own org, never a wildcard; offers are never taken over', () => {
  const promo = fnSrc('promo-redeem');
  assert.ok(promo.includes('const code = normalisePromoCode(codeStr);'));
  assert.ok(promo.includes(".eq('org_id', orgId)"));
  assert.ok(promo.includes('.ilike(\'code\', escapeLike(code))'));
  assert.ok(promo.includes('const row = pickPromoRow(rows, code, orgId);'));
  assert.ok(!promo.includes(".ilike('code', code)"));
  const admin = fnSrc('marketing-admin');
  assert.ok(admin.includes('const plan = planSaveOffer(incomingId, existing, org_id);'));
  assert.ok(!admin.includes("upsert(row, { onConflict: 'id' })"), 'no upsert on a caller supplied offer id');
});

test('card refunds: the gate comes before the processor is asked; the service role still works', () => {
  for (const fn of ['stripe-refund', 'ryft-refund']) {
    const src = fnSrc(fn);
    assert.ok(src.includes('const serviceRole = isServiceRoleRequest(req);'), fn);
    const gate = src.indexOf('decideCardRefundAuthority({ serviceRole, user: caller, staff: who.staff, device: who.device, deviceReason: who.deviceReason })');
    assert.ok(gate > 0, fn);
    const refund = fn === 'stripe-refund' ? src.indexOf('stripe.refunds.create(') : src.indexOf('refundPaymentSession(sessionId');
    assert.ok(refund > gate, `${fn}: refunds only after the gate`);
    assert.ok(src.indexOf("from('merchant_") > gate, `${fn}: reads the merchant account only after the gate`);
    assert.ok(src.includes("code: 'refund_not_allowed'"), fn);
  }
});

test('workforce pay: user_locations or a super admin, never the profile venue, never anonymous', () => {
  const src = fnSrc('workforce-compute');
  const fn = src.slice(src.indexOf('async function assertAccess'), src.indexOf('Deno.serve'));
  assert.ok(fn.includes('if (!user?.id || user.is_anonymous) return false;'));
  assert.ok(!fn.includes('location_id, role'), 'the profile venue is not read');
  assert.ok(fn.includes(".eq('user_id', user.id).eq('location_id', loc)"));
});

test('the shared layer: authentication is not authority, the device arm reads bound_via after the fence, nothing writes a log table', () => {
  const gcu = read('../../supabase/functions/_shared/gift-card-utils.ts');
  assert.ok(gcu.includes('AUTHENTICATION ONLY, NEVER AUTHORITY'));
  const facts = code(read('../../supabase/functions/_shared/callerFacts.ts'));
  assert.ok(facts.includes("ops.from('fence_state').select('key').eq('key', 'file_a')"));
  assert.ok(facts.includes("'id, device_uid, location_id, status, bound_via'"));
  assert.ok(facts.includes("ops.from('ops_devices')"));
  assert.ok(!facts.includes('caller_authority_log'), 'stage 1 adds no table: the log is the function log');
  assert.ok(!facts.includes("from('user_profiles').select('location_id"), 'the profile venue is never read as access');
  const lu = code(read('../../supabase/functions/_shared/loyalty-utils.ts'));
  assert.ok(lu.includes('const facts = createCallerFacts({'));
  assert.ok(!lu.includes('callerDeviceCompany'));
});

test('no em or en dashes in anything this change added', () => {
  const added = [
    '../../supabase/functions/_shared/callerFacts.ts',
    '../../supabase/functions/_shared/deviceAuthority.ts',
    '../../supabase/functions/_shared/gift-authority.ts',
    '../../supabase/functions/_shared/loyalty-authority.ts',
    '../../supabase/functions/_shared/staffAccess.ts',
    '../../supabase/functions/_shared/companyStaffAccess.js',
    '../../supabase/functions/_shared/loyalty-session.ts',
    '../../supabase/functions/_shared/giftCardMatch.ts',
    '../../supabase/functions/_shared/memberReply.ts',
    '../../supabase/functions/_shared/earnFromCheck.ts',
    '../../supabase/functions/_shared/promoLookup.ts',
    '../../supabase/functions/_shared/orgScope.ts',
    '../../supabase/functions/_shared/authorityLogLimiter.ts',
    '../../supabase/functions/_shared/giftPurchaseProof.ts',
    '../../supabase/functions/_shared/giftFulfilPlan.ts',
    './memberSession.js',
    './moneyFunctionFence.test.js',
  ];
  for (const f of added) assert.ok(!/[\u2013\u2014]/.test(read(f)), `${f} has an em or en dash`);
});
