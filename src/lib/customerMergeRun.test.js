// src/lib/customerMergeRun.test.js
//
// A CUSTOMER MERGE, END TO END, AND STOPPED AT EVERY STEP (26 Sep 2026).
//
// There is no transaction across Ops and Platform, so the merge must survive stopping between any
// two writes and being asked again. This drives supabase/functions/_shared/customerMergeRun.js in
// the same order as customer-merge/index.ts (read, plan, apply) against two in memory databases
// that enforce the unique indexes the live tables have (customers phone and email per org, one
// membership per company, one card per programme, visit records per venue, campaign and
// automation keys). Every write is then made to fail in turn, twice over: once before it lands
// ("fetch failed") and once after ("the answer was lost"). Each time the merge is asked again and
// must end EXACTLY where a clean run ends: no stamp or point counted twice, none lost.
// What it cannot run is Deno and PostgREST themselves.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planMerge } from '../../supabase/functions/_shared/customerMergePlan.js';
import {
  readMergeFacts, countSourceRows, applyMerge, readSurvivor, MergeStepError,
} from '../../supabase/functions/_shared/customerMergeRun.js';
import { fakeDb, newFault } from './fixtures/fakeSupabaseDb.js';

/** What customer-merge/index.ts does for action 'merge', minus the door. */
async function merge(clients, { targetId, sourceId, now, phoneChoice = null }) {
  const facts = await readMergeFacts(clients, { targetId, sourceId });
  const plan = planMerge({ ...facts, now, phoneChoice });
  if (!plan.ok) return { plan, applied: null };
  const applied = await applyMerge(clients, plan);
  return { plan, applied };
}

// The volatile columns (stamped with the clock) are compared for presence, not value.
function settled(state) {
  const s = JSON.parse(JSON.stringify(state));
  for (const r of s.customers || []) { r.updated_at = r.updated_at ? 'set' : null; r.deleted_at = r.deleted_at ? 'set' : null; }
  const sortRows = (rows) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const k of Object.keys(s)) s[k] = sortRows(s[k]);
  return s;
}

// ── Ela, exactly as she is live (read only, 26 Sep 2026) ──────────────────────
const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const ELA = 'cd96ff83-22ca-4af1-9af9-7ca5de9f6597';
const BLANK = 'c462cbfc-be83-4ee9-9459-91ea0a682215';
const PROGRAM = '0afb5e8b-1e95-402a-83ec-5b3e750d7977';

function elaWorld() {
  const ops = {
    customers: [
      { id: BLANK, org_id: ORG, phone: '+447415748167', phone_raw: null, email: null, name: '', notes: null, marketing_opt_in: false, marketing_opt_in_at: null, created_at: '2026-09-26 13:25:59.631026+00', updated_at: '2026-09-26 13:25:59.631026+00', deleted_at: null, allergens: [], birthday: null, welcome_sent_at: null, first_name: null, last_name: null, is_local: null, source: null, sources: [], tags: [], no_shows: 0, shopper_reference: null, stored_payment_method_id: null },
      { id: ELA, org_id: ORG, phone: null, phone_raw: null, email: 'elastettner@hotmail.com', name: 'Ela Stettner', notes: null, marketing_opt_in: false, marketing_opt_in_at: null, created_at: '2026-09-26 12:20:18.020496+00', updated_at: '2026-09-26 12:20:18.020496+00', deleted_at: null, allergens: [], birthday: null, welcome_sent_at: null, first_name: 'Ela', last_name: 'Stettner', is_local: null, source: 'import', sources: ['import', 'import:d843efc0-b887-4b5a-a209-0aa69a703d1e'], tags: [], no_shows: 0, shopper_reference: null, stored_payment_method_id: null },
    ],
    stamp_transactions: [
      { id: '37eabaf3-3231-4298-b652-a7811a93792f', customer_id: ELA, program_id: PROGRAM, location_id: LEEDS, stamps: 2, type: 'earn', note: 'Imported from another system', created_at: '2026-09-26 12:20:17.411+00', idempotency_key: `import:d843efc0-b887-4b5a-a209-0aa69a703d1e:${ELA}:${PROGRAM}`, order_ref: 'import:d843efc0-b887-4b5a-a209-0aa69a703d1e' },
    ],
  };
  const platform = {
    customer_loyalty: [
      { id: '80c45795-9c27-4485-bf93-8b00eccce709', customer_id: BLANK, company_id: ORG, points_balance: 0, points_earned_total: 0, points_redeemed_total: 0, points_expired_total: 0, tier_id: null, tier_qualified_at: null, visit_count: 0, lifetime_spend_minor: 0, member_code: 'SRV-UEMY79', referral_code: 'WTZFD49E', referred_by: null, birthday: null, wallet_pass_serial: null, enrolled_at: '2026-09-26 13:25:59.762038+00', last_earn_at: null, last_redeem_at: null, points_expire_at: null },
      { id: '74afebf8-5a6b-4755-b1c2-f31f3ca95826', customer_id: ELA, company_id: ORG, points_balance: 0, points_earned_total: 0, points_redeemed_total: 0, points_expired_total: 0, tier_id: null, tier_qualified_at: null, visit_count: 0, lifetime_spend_minor: 0, member_code: 'SRV-Q43HGG', referral_code: 'REF-DTJYCZ', referred_by: null, birthday: null, wallet_pass_serial: null, enrolled_at: '2026-09-26 12:20:17.411+00', last_earn_at: null, last_redeem_at: null, points_expire_at: null },
    ],
    customer_stamp_cards: [
      { id: 'e7e0f1d6-d057-4bfb-8ad7-eab1863a8c7b', customer_id: ELA, program_id: PROGRAM, company_id: ORG, stamps_collected: 2, completed_count: 0, last_stamp_at: '2026-09-26 12:20:17.411+00', created_at: '2026-09-26 12:20:19.166375+00' },
    ],
    stamp_card_programs: [{ id: PROGRAM, company_id: ORG, name: 'Free Drink', stamps_required: 10, active: true }],
  };
  return { ops, platform };
}

function clientsFor(world, fault = newFault()) {
  return { ops: fakeDb(world.ops, fault), platform: fakeDb(world.platform, fault), fault };
}

test('the fake enforces the live unique indexes (giving Ela the email while the shell holds it would fail)', async () => {
  const c = clientsFor({ ops: { customers: [{ id: 'a', org_id: ORG, email: 'x@y.com', deleted_at: null }, { id: 'b', org_id: ORG, email: null, deleted_at: null }] }, platform: {} });
  const res = await c.ops.from('customers').update({ email: 'X@y.com' }).eq('id', 'b');
  assert.equal(res.error.code, '23505');
  assert.match(res.error.message, /idx_customers_org_email/);
});

test('Ela: one profile with her name, email, phone, membership SRV-Q43HGG and 2 stamps', async () => {
  const c = clientsFor(elaWorld());
  const { plan, applied } = await merge(c, { targetId: BLANK, sourceId: ELA, now: '2026-09-26T20:00:00Z' });
  assert.equal(plan.ok, true);
  assert.equal(plan.target_id, ELA, 'named the other way round, the imported profile is still kept');
  const ops = c.ops.dump(); const pf = c.platform.dump();
  const ela = ops.customers.find((r) => r.id === ELA);
  const shell = ops.customers.find((r) => r.id === BLANK);
  assert.equal(ela.phone, '+447415748167');
  assert.equal(ela.name, 'Ela Stettner');
  assert.equal(ela.email, 'elastettner@hotmail.com');
  assert.equal(ela.deleted_at, null);
  assert.deepEqual(ela.tags, [`merged:${BLANK}`]);
  assert.equal(shell.deleted_at, '2026-09-26T20:00:00Z');
  assert.equal(shell.phone, null);
  assert.equal(shell.email, null);
  assert.deepEqual(shell.tags, [`merged_into:${ELA}`, 'merge_phone:+447415748167', 'merge_done']);
  assert.deepEqual(pf.customer_loyalty.map((m) => m.member_code), ['SRV-Q43HGG']);
  assert.deepEqual(pf.customer_stamp_cards.map((x) => [x.customer_id, x.stamps_collected]), [[ELA, 2]]);
  assert.deepEqual(ops.stamp_transactions.map((x) => x.customer_id), [ELA]);
  assert.ok(applied.steps.includes('membership_delete'));
  assert.ok(applied.steps.includes('fold_profiles'));
  assert.ok(applied.steps.includes('hand_over_contact'));
  // The survivor, as the screens get it.
  const sv = await readSurvivor(c, ELA);
  assert.equal(sv.customer.phone, '+447415748167');
  assert.deepEqual(sv.memberships.map((m) => m.member_code), ['SRV-Q43HGG']);
  assert.deepEqual(sv.stamp_cards.map((x) => x.stamps_collected), [2]);
  // Asked again (a double tap, a retry): nothing changes, not even a clock stamp, and the
  // customers table is not written at all (27 Sep 2026).
  const before = c.ops.dump();
  const writesBefore = c.fault.log.length;
  const again = await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:05:00Z' });
  assert.equal(again.plan.mode, 'resume');
  assert.deepEqual(c.ops.dump(), before);
  assert.deepEqual(c.fault.log.slice(writesBefore).filter((w) => w.startsWith('customers.')), []);
  assert.equal(c.ops.dump().customers.find((r) => r.id === BLANK).deleted_at, '2026-09-26T20:00:00Z', 'the first deletion time stands');
});

// ── a busier pair: points on both, a card on both, visits at one venue on both ──
const A = 'aaaaaaaa-0000-4000-8000-000000000001';   // older, imported, 8 stamps, 120 points
const B = 'bbbbbbbb-0000-4000-8000-000000000002';   // newer, till made, 5 stamps, 40 points
const OTHER_VENUE = '22222222-2222-4222-8222-222222222222';
const COMPANY2 = 'c2c2c2c2-0000-4000-8000-000000000002';

function busyWorld() {
  const cust = (over) => ({ org_id: ORG, phone: null, phone_raw: null, email: null, name: '', notes: null, marketing_opt_in: false, marketing_opt_in_at: null, updated_at: null, deleted_at: null, allergens: [], birthday: null, welcome_sent_at: null, first_name: null, last_name: null, is_local: null, source: null, sources: [], tags: [], no_shows: 0, shopper_reference: null, stored_payment_method_id: null, ...over });
  return {
    ops: {
      customers: [
        cust({ id: A, name: 'Sam Rivers', email: 'sam@example.com', created_at: '2026-01-01T00:00:00Z', source: 'import', sources: ['import'], allergens: ['nuts'], no_shows: 1 }),
        cust({ id: B, name: 'Customer', phone: '+447700900123', phone_raw: '07700 900123', created_at: '2026-09-26T14:00:00Z', marketing_opt_in: true, marketing_opt_in_at: '2026-09-26T14:00:00Z', allergens: ['dairy'], notes: 'Oat milk', no_shows: 2 }),
      ],
      customer_orders: [
        { id: 'o1', customer_id: B, location_id: LEEDS, total: 4.5 },
        { id: 'o2', customer_id: A, location_id: LEEDS, total: 3.2 },
      ],
      closed_checks: [{ id: 'cc1', customer_id: B }],
      loyalty_transactions: [{ id: 'lt1', customer_id: B, company_id: ORG, points: 40, idempotency_key: 'earn:x' }],
      stamp_transactions: [
        { id: 'st1', customer_id: B, program_id: PROGRAM, stamps: 5, idempotency_key: 'stamp:1' },
        { id: 'st2', customer_id: A, program_id: PROGRAM, stamps: 8, idempotency_key: 'import:A' },
      ],
      customer_consents: [{ id: 'cs1', customer_id: B, purpose: 'marketing', consented: true, created_at: '2026-09-26T14:00:00Z' }],
      customer_locations: [
        { customer_id: A, location_id: LEEDS, first_visit_at: '2026-02-01T00:00:00Z', last_visit_at: '2026-09-01T00:00:00Z', visit_count: 3, lifetime_revenue: 12.3, notes: null },
        { customer_id: B, location_id: LEEDS, first_visit_at: '2026-09-26T14:00:00Z', last_visit_at: '2026-09-26T14:00:00Z', visit_count: 1, lifetime_revenue: 4.5, notes: null },
        { customer_id: B, location_id: OTHER_VENUE, first_visit_at: '2026-09-20T00:00:00Z', last_visit_at: '2026-09-20T00:00:00Z', visit_count: 1, lifetime_revenue: 2.1, notes: null },
      ],
      campaign_sends: [
        { id: 'cs-a', campaign_id: 'camp1', customer_id: A, dedupe_key: 'k' },
        { id: 'cs-b1', campaign_id: 'camp1', customer_id: B, dedupe_key: 'k' },
        { id: 'cs-b2', campaign_id: 'camp2', customer_id: B, dedupe_key: 'k' },
      ],
      workflow_enrollments: [
        { id: 'we-a', workflow_id: 'wf1', customer_id: A },
        { id: 'we-b', workflow_id: 'wf1', customer_id: B },
        { id: 'we-b2', workflow_id: 'wf2', customer_id: B },
      ],
      bookings: [{ id: 'bk1', customer_id: B }],
    },
    platform: {
      customer_loyalty: [
        { id: 'm-a', customer_id: A, company_id: ORG, points_balance: 120, points_earned_total: 200, points_redeemed_total: 80, points_expired_total: 0, tier_id: null, tier_qualified_at: null, visit_count: 9, lifetime_spend_minor: 9000, member_code: 'SRV-AAAAAA', referral_code: 'REF-A', referred_by: null, birthday: null, enrolled_at: '2026-01-01T00:00:00Z', last_earn_at: '2026-09-01T00:00:00Z', last_redeem_at: null, points_expire_at: null },
        { id: 'm-b', customer_id: B, company_id: ORG, points_balance: 40, points_earned_total: 40, points_redeemed_total: 0, points_expired_total: 0, tier_id: null, tier_qualified_at: null, visit_count: 1, lifetime_spend_minor: 450, member_code: 'SRV-BBBBBB', referral_code: 'REF-B', referred_by: null, birthday: null, enrolled_at: '2026-09-26T14:00:00Z', last_earn_at: '2026-09-26T14:00:00Z', last_redeem_at: null, points_expire_at: null },
        { id: 'm-b2', customer_id: B, company_id: COMPANY2, points_balance: 7, points_earned_total: 7, points_redeemed_total: 0, points_expired_total: 0, tier_id: null, tier_qualified_at: null, visit_count: 1, lifetime_spend_minor: 100, member_code: 'SRV-B2B2B2', referral_code: 'REF-B2', referred_by: null, birthday: null, enrolled_at: '2026-09-26T14:00:00Z', last_earn_at: null, last_redeem_at: null, points_expire_at: null },
        { id: 'm-friend', customer_id: 'friend', company_id: ORG, points_balance: 0, points_earned_total: 0, points_redeemed_total: 0, points_expired_total: 0, visit_count: 0, lifetime_spend_minor: 0, member_code: 'SRV-FRIEND', referral_code: 'REF-F', referred_by: 'm-b', enrolled_at: '2026-09-26T15:00:00Z' },
      ],
      customer_stamp_cards: [
        { id: 'c-a', customer_id: A, program_id: PROGRAM, company_id: ORG, stamps_collected: 8, completed_count: 1, last_stamp_at: '2026-09-01T00:00:00Z' },
        { id: 'c-b', customer_id: B, program_id: PROGRAM, company_id: ORG, stamps_collected: 5, completed_count: 0, last_stamp_at: '2026-09-26T14:00:00Z' },
      ],
      stamp_card_programs: [{ id: PROGRAM, company_id: ORG, name: 'Free Drink', stamps_required: 10 }],
      loyalty_redemption_claims: [{ idempotency_key: 'redeem:1', membership_id: 'm-b', points: 10 }],
    },
  };
}

async function cleanBusyRun() {
  const c = clientsFor(busyWorld());
  const r = await merge(c, { targetId: A, sourceId: B, now: '2026-09-26T20:00:00Z' });
  return { c, ...r };
}

test('a busy pair: balances add up once, history moves, clashes stay behind and are counted', async () => {
  const { c, plan, applied } = await cleanBusyRun();
  assert.equal(plan.ok, true);
  assert.equal(plan.target_id, A, 'both have history: the older one is kept');
  const ops = c.ops.dump(); const pf = c.platform.dump();
  const a = ops.customers.find((r) => r.id === A);
  const b = ops.customers.find((r) => r.id === B);
  assert.equal(a.name, 'Sam Rivers');
  assert.equal(a.phone, '+447700900123');
  assert.equal(a.phone_raw, '07700 900123');
  assert.equal(a.email, 'sam@example.com');
  assert.equal(a.marketing_opt_in, true);
  assert.deepEqual(a.allergens, ['nuts', 'dairy']);
  assert.equal(a.notes, 'Oat milk');
  assert.equal(a.no_shows, 3);
  assert.ok(b.deleted_at);
  assert.equal(b.phone, null);
  assert.equal(b.phone_raw, null);
  // Platform: one membership per company, summed; B's other company moved; the friend's referral follows.
  const mA = pf.customer_loyalty.find((m) => m.id === 'm-a');
  assert.deepEqual([mA.points_balance, mA.points_earned_total, mA.points_redeemed_total, mA.visit_count, mA.lifetime_spend_minor], [160, 240, 80, 10, 9450]);
  assert.equal(mA.member_code, 'SRV-AAAAAA');
  assert.equal(pf.customer_loyalty.some((m) => m.id === 'm-b'), false);
  assert.equal(pf.customer_loyalty.find((m) => m.id === 'm-b2').customer_id, A);
  assert.equal(pf.customer_loyalty.find((m) => m.id === 'm-friend').referred_by, 'm-a');
  assert.equal(pf.loyalty_redemption_claims[0].membership_id, 'm-a');
  // 8 + 5 stamps of 10: one more completed card and 3 stamps.
  assert.deepEqual(pf.customer_stamp_cards.map((x) => [x.id, x.customer_id, x.stamps_collected, x.completed_count]), [['c-a', A, 3, 2]]);
  // Ops history.
  for (const t of ['customer_orders', 'closed_checks', 'loyalty_transactions', 'stamp_transactions', 'customer_consents', 'bookings']) {
    assert.equal(ops[t].some((r) => r.customer_id === B), false, t);
  }
  const leeds = ops.customer_locations.filter((r) => r.location_id === LEEDS);
  assert.deepEqual(leeds.map((r) => [r.customer_id, r.visit_count, r.lifetime_revenue, r.first_visit_at]), [[A, 4, 16.8, '2026-02-01T00:00:00Z']]);
  assert.equal(ops.customer_locations.find((r) => r.location_id === OTHER_VENUE).customer_id, A);
  assert.deepEqual(ops.campaign_sends.map((r) => [r.id, r.customer_id]).sort(), [['cs-a', A], ['cs-b1', B], ['cs-b2', A]]);
  assert.deepEqual(ops.workflow_enrollments.map((r) => [r.id, r.customer_id]).sort(), [['we-a', A], ['we-b', B], ['we-b2', A]]);
  assert.deepEqual(applied.stayed, { campaign_sends: 1, workflow_enrollments: 1 });
});

test('stopped at EVERY write, before it lands or after, then asked again: exactly the clean result', async () => {
  const clean = await cleanBusyRun();
  const want = { ops: settled(clean.c.ops.dump()), platform: settled(clean.c.platform.dump()) };
  const totalWrites = clean.c.fault.writes;
  assert.ok(totalWrites >= 15, `a busy merge is many writes (${totalWrites})`);
  for (const mode of ['before', 'after']) {
    for (let k = 0; k < totalWrites; k += 1) {
      const fault = newFault();
      fault.at = k; fault.mode = mode;
      const c = clientsFor(busyWorld(), fault);
      await assert.rejects(() => merge(c, { targetId: A, sourceId: B, now: '2026-09-26T20:00:00Z' }), (e) => e instanceof MergeStepError, `${mode} ${k}`);
      fault.at = null;
      // Asked again later, maybe the other way round.
      const again = await merge(c, { targetId: k % 2 ? B : A, sourceId: k % 2 ? A : B, now: '2026-09-26T20:10:00Z' });
      assert.equal(again.plan.ok, true, `${mode} ${k}: ${JSON.stringify(again.plan.refusals)}`);
      assert.equal(again.plan.target_id, A, `${mode} ${k}`);
      assert.deepEqual({ ops: settled(c.ops.dump()), platform: settled(c.platform.dump()) }, want, `${mode} at write ${k} (${fault.log[k]})`);
    }
  }
});

test('Ela, stopped at every write and asked again: one profile, 2 stamps, her phone', async () => {
  const clean = clientsFor(elaWorld());
  await merge(clean, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' });
  const want = { ops: settled(clean.ops.dump()), platform: settled(clean.platform.dump()) };
  for (const mode of ['before', 'after']) {
    for (let k = 0; k < clean.fault.writes; k += 1) {
      const fault = newFault();
      fault.at = k; fault.mode = mode;
      const c = clientsFor(elaWorld(), fault);
      await assert.rejects(() => merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' }));
      fault.at = null;
      await merge(c, { targetId: BLANK, sourceId: ELA, now: '2026-09-26T20:10:00Z' });
      assert.deepEqual({ ops: settled(c.ops.dump()), platform: settled(c.platform.dump()) }, want, `${mode} ${k}`);
    }
  }
});

// ── 27 Sep 2026 (first review): asking again never rewrites the survivor ─────────
//
// The first cut rebuilt the survivor from the folded in row on every resume, so Merge pressed
// again after a finished merge put back a phone staff had changed since and switched marketing
// on again. A resume now writes none of the survivor's profile fields.

/** Every write made to fail in turn (before it lands, and after with the answer lost), then asked again the other way round. */
async function crashEverywhere(world, { targetId, sourceId, phoneChoice = null }) {
  const clean = clientsFor(world());
  const first = await merge(clean, { targetId, sourceId, now: '2026-09-26T20:00:00Z', phoneChoice });
  assert.equal(first.plan.ok, true, JSON.stringify(first.plan.refusals));
  const want = { ops: settled(clean.ops.dump()), platform: settled(clean.platform.dump()) };
  const stoppedAt = new Set();
  for (const mode of ['before', 'after']) {
    for (let k = 0; k < clean.fault.writes; k += 1) {
      const fault = newFault();
      fault.at = k; fault.mode = mode;
      const c = clientsFor(world(), fault);
      await assert.rejects(() => merge(c, { targetId, sourceId, now: '2026-09-26T20:00:00Z', phoneChoice }), (e) => {
        stoppedAt.add(e.step);
        return e instanceof MergeStepError;
      }, `${mode} ${k}`);
      fault.at = null;
      const again = await merge(c, { targetId: sourceId, sourceId: targetId, now: '2026-09-26T20:10:00Z', phoneChoice });
      assert.equal(again.plan.ok, true, `${mode} ${k}: ${JSON.stringify(again.plan.refusals)}`);
      assert.deepEqual({ ops: settled(c.ops.dump()), platform: settled(c.platform.dump()) }, want, `${mode} at write ${k} (${fault.log[k]})`);
    }
  }
  return { clean, stoppedAt };
}

/** The busy pair, but the kept profile has its own phone and staff choose the folded in one. */
function chosenPhoneWorld() {
  const w = busyWorld();
  Object.assign(w.ops.customers.find((r) => r.id === A), { phone: '+447700900999', phone_raw: '07700 900999' });
  return w;
}

/** The busy pair, but the kept profile has no email and the folded in one does (both contacts move). */
function emailWorld() {
  const w = busyWorld();
  w.ops.customers.find((r) => r.id === A).email = null;
  w.ops.customers.find((r) => r.id === B).email = 'river@example.com';
  return w;
}

test('merge, change the survivor\'s phone and email, merge again: they stay (and nothing is written to the profile)', async () => {
  const c = clientsFor(elaWorld());
  await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' });
  assert.equal(c.ops.dump().customers.find((r) => r.id === ELA).phone, '+447415748167');
  // Staff give Ela a new phone and email afterwards.
  await c.ops.from('customers').update({ phone: '+447000000001', phone_raw: '07000 000001', email: 'ela.new@example.com' }).eq('id', ELA);
  const before = c.ops.dump().customers.find((r) => r.id === ELA);
  const writes = c.fault.log.length;
  const again = await merge(c, { targetId: BLANK, sourceId: ELA, now: '2026-09-27T20:00:00Z' });
  assert.equal(again.plan.ok, true);
  assert.equal(again.plan.mode, 'resume');
  const ela = c.ops.dump().customers.find((r) => r.id === ELA);
  assert.deepEqual(ela, before, 'every field as staff left it, updated_at included');
  assert.equal(ela.phone, '+447000000001');
  assert.equal(ela.email, 'ela.new@example.com');
  assert.deepEqual(c.fault.log.slice(writes).filter((x) => x.startsWith('customers.')), []);
});

test('merge, turn marketing off, merge again: it stays off', async () => {
  const w = elaWorld();
  Object.assign(w.ops.customers.find((r) => r.id === BLANK), { marketing_opt_in: true, marketing_opt_in_at: '2026-09-26T13:26:00Z' });
  const c = clientsFor(w);
  await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' });
  assert.equal(c.ops.dump().customers.find((r) => r.id === ELA).marketing_opt_in, true, 'yes on either profile is yes');
  await c.ops.from('customers').update({ marketing_opt_in: false }).eq('id', ELA);
  const again = await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-27T20:00:00Z' });
  assert.equal(again.plan.mode, 'resume');
  assert.equal(c.ops.dump().customers.find((r) => r.id === ELA).marketing_opt_in, false);
});

test('a phone staff removed after the merge is not put back by merging again (merge_done)', async () => {
  const c = clientsFor(elaWorld());
  await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' });
  await c.ops.from('customers').update({ phone: null, phone_raw: null }).eq('id', ELA);
  const again = await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-27T20:00:00Z' });
  assert.deepEqual(again.plan.customers.move, {});
  assert.equal(c.ops.dump().customers.find((r) => r.id === ELA).phone, null);
});

test('chosen phone: stopped at every write and asked again ends exactly where a clean run ends', async () => {
  const { clean, stoppedAt } = await crashEverywhere(chosenPhoneWorld, { targetId: A, sourceId: B, phoneChoice: 'source' });
  const a = clean.ops.dump().customers.find((r) => r.id === A);
  assert.deepEqual([a.phone, a.phone_raw], ['+447700900123', '07700 900123'], 'the chosen number, both keys');
  const b = clean.ops.dump().customers.find((r) => r.id === B);
  assert.deepEqual(b.tags.filter((t) => t.startsWith('merge_')), ['merge_dropped_phone:+447700900999', 'merge_phone:+447700900123', 'merge_phone_raw:07700 900123', 'merge_done']);
  for (const step of ['membership_fold', 'card_fold', 'fold_profiles', 'hand_over_contact', 'merge_finished']) assert.ok(stoppedAt.has(step), step);
});

test('phone and email both handed over: stopped at every write and asked again ends exactly where a clean run ends', async () => {
  const { clean } = await crashEverywhere(emailWorld, { targetId: A, sourceId: B });
  const a = clean.ops.dump().customers.find((r) => r.id === A);
  assert.deepEqual([a.phone, a.email], ['+447700900123', 'river@example.com']);
  assert.ok(clean.fault.log.filter((x) => x === 'customers.update').length >= 3, 'phone, email, then merge_done');
});

test('stopped before the hand over, then the survivor changed: the resume keeps the change and still finishes', async () => {
  const fault = newFault();
  const c = clientsFor(emailWorld(), fault);
  // The fold is the first customers write; stop at the one after it (the phone hand over).
  const clean = clientsFor(emailWorld());
  await merge(clean, { targetId: A, sourceId: B, now: '2026-09-26T20:00:00Z' });
  fault.at = clean.fault.log.indexOf('customers.upsert') + 1;
  await assert.rejects(() => merge(c, { targetId: A, sourceId: B, now: '2026-09-26T20:00:00Z' }), (e) => e.step === 'hand_over_contact');
  fault.at = null;
  assert.equal(c.ops.dump().customers.find((r) => r.id === A).phone, null, 'stopped between the fold and the hand over');
  await c.ops.from('customers').update({ phone: '+447000000002', marketing_opt_in: false }).eq('id', A);
  const again = await merge(c, { targetId: A, sourceId: B, now: '2026-09-26T20:30:00Z' });
  assert.equal(again.plan.mode, 'resume');
  assert.ok(again.plan.warnings.some((w) => w.code === 'phone_kept'));
  const a = c.ops.dump().customers.find((r) => r.id === A);
  assert.equal(a.phone, '+447000000002', 'the number typed since stays');
  assert.equal(a.marketing_opt_in, false, 'and so does the marketing choice');
  assert.equal(a.email, 'river@example.com', 'the email, still empty and free, is handed over');
  assert.ok(c.ops.dump().customers.find((r) => r.id === B).tags.includes('merge_done'));
});

test('stopped before the hand over, then somebody else signed up with that phone: the merge finishes without it', async () => {
  const fault = newFault();
  const c = clientsFor(elaWorld(), fault);
  const clean = clientsFor(elaWorld());
  await merge(clean, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' });
  fault.at = clean.fault.log.indexOf('customers.upsert') + 1;
  await assert.rejects(() => merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' }), (e) => e.step === 'hand_over_contact');
  fault.at = null;
  const NEWBIE = 'ffffffff-0000-4000-8000-00000000000a';
  await c.ops.from('customers').upsert([{ id: NEWBIE, org_id: ORG, name: '', phone: '+447415748167', email: null, deleted_at: null, tags: [] }]);
  const again = await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T21:00:00Z' });
  assert.equal(again.plan.ok, true);
  assert.ok(again.plan.warnings.some((w) => w.code === 'phone_taken'));
  const ela = c.ops.dump().customers.find((r) => r.id === ELA);
  assert.equal(ela.phone, null, 'never two live profiles on one loyalty login');
  assert.ok(c.ops.dump().customers.find((r) => r.id === BLANK).tags.includes('merge_done'), 'finished, not stuck on the unique index');
});

test('a value filled on the survivor between the plan and the hand over is never overwritten', async () => {
  const fault = newFault();
  const c = clientsFor(elaWorld(), fault);
  const clean = clientsFor(elaWorld());
  await merge(clean, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' });
  fault.at = clean.fault.log.indexOf('customers.upsert') + 1;
  await assert.rejects(() => merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' }));
  fault.at = null;
  // The resume is planned while the survivor has no phone...
  const facts = await readMergeFacts(c, { targetId: ELA, sourceId: BLANK });
  const plan = planMerge({ ...facts, now: '2026-09-26T20:40:00Z' });
  assert.deepEqual(plan.customers.move, { phone: '+447415748167' });
  // ...and staff type one before it runs.
  await c.ops.from('customers').update({ phone: '+447000000003' }).eq('id', ELA);
  await applyMerge(c, plan);
  assert.equal(c.ops.dump().customers.find((r) => r.id === ELA).phone, '+447000000003');
});

test('a forged merged_into tag on a deleted blank row hands nothing over (first review)', async () => {
  const w = elaWorld();
  Object.assign(w.ops.customers.find((r) => r.id === BLANK), {
    phone: null, deleted_at: '2026-09-26T19:00:00Z',
    tags: [`merged_into:${ELA}`, 'merge_phone:+447999999999', 'merge_email:someone@example.com'],
  });
  w.ops.customers.find((r) => r.id === ELA).email = null;
  const c = clientsFor(w);
  const { plan, applied } = await merge(c, { targetId: ELA, sourceId: BLANK, now: '2026-09-26T20:00:00Z' });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusals[0].code, 'merge_trail_broken');
  assert.equal(applied, null);
  assert.equal(c.fault.writes, 0);
  assert.equal(c.ops.dump().customers.find((r) => r.id === ELA).phone, null);
});

test('two different phones: refused, and NOTHING is written until staff choose', async () => {
  const w = busyWorld();
  w.ops.customers[0].phone = '+447700900999';
  const c = clientsFor(w);
  const { plan, applied } = await merge(c, { targetId: A, sourceId: B, now: '2026-09-26T20:00:00Z' });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusals[0].code, 'different_phones');
  assert.equal(applied, null);
  assert.equal(c.fault.writes, 0);
  await assert.rejects(() => applyMerge(c, plan), (e) => e instanceof MergeStepError && e.step === 'plan');
  // Staff keep the folded in profile's phone.
  const chosen = await merge(c, { targetId: A, sourceId: B, now: '2026-09-26T20:01:00Z', phoneChoice: 'source' });
  assert.equal(chosen.plan.ok, true);
  const a = c.ops.dump().customers.find((r) => r.id === A);
  assert.equal(a.phone, '+447700900123');
  assert.equal(a.phone_raw, '07700 900123');
  assert.ok(c.ops.dump().customers.find((r) => r.id === B).tags.includes('merge_dropped_phone:+447700900999'));
});

test('a failed read stops the merge before anything is written (never "nothing there")', async () => {
  for (const table of ['customers', 'customer_loyalty', 'customer_stamp_cards', 'customer_orders', 'customer_consents']) {
    const fault = newFault();
    fault.readFail = table;
    const c = clientsFor(busyWorld(), fault);
    await assert.rejects(() => merge(c, { targetId: A, sourceId: B, now: '2026-09-26T20:00:00Z' }), (e) => e instanceof MergeStepError && e.step.startsWith('read_'), table);
    assert.equal(fault.writes, 0, table);
  }
});

test('customers of another business: nothing else is read, and the plan refuses', async () => {
  const w = busyWorld();
  w.ops.customers[1].org_id = 'ffffffff-0000-4000-8000-000000000000';
  const fault = newFault();
  const c = clientsFor(w, fault);
  const facts = await readMergeFacts(c, { targetId: A, sourceId: B });
  assert.deepEqual([facts.memberships, facts.cards, facts.activity], [[], [], {}]);
  assert.equal(planMerge({ ...facts, now: '2026-09-26T20:00:00Z' }).refusals[0].code, 'different_org');
});

test('the preview counts what would move, per table, and writes nothing', async () => {
  const c = clientsFor(busyWorld());
  const counts = await countSourceRows(c, B);
  assert.equal(counts.customer_orders, 1);
  assert.equal(counts.customer_locations, 2);
  assert.equal(counts.campaign_sends, 2);
  assert.equal(counts.wifi_captures, 0);
  assert.equal(c.fault.writes, 0);
});
