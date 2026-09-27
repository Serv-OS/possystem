// src/lib/customerMergePlan.test.js
//
// THE RULES OF A CUSTOMER MERGE (26 Sep 2026). Coffee Boy Leeds: Ela Stettner's imported profile
// (email, 2 stamps, no phone) and the blank profile the portal made from her phone could not be
// put together, so her name and email never saved and the till said "DB error". Peter: "it should
// have matched the profile together". supabase/functions/_shared/customerMergePlan.js decides a
// merge; every rule below is somebody's loyalty account.
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MERGE_TABLES, MERGE_TAG, CUSTOMER_UPSERT_COLUMNS, MEMBERSHIP_UPSERT_COLUMNS, CARD_UPSERT_COLUMNS,
  isBlankName, samePhone, maskPhone, maskEmail, mergedIntoOf, tagValue, union, earlier, later, addDecimal,
  historyOf, isBlankShell, chooseSurvivor, mergeCustomerFields, planMemberships, planStampCards,
  planCustomerLocations, partitionClashes, planMerge, staffMergeRole, canStaffMerge, decideMergeCaller,
  validateMergeRequest, uniqueClashOf, profileCard, survivorForCaller, exactIlike,
} from '../../supabase/functions/_shared/customerMergePlan.js';

// ── Ela, as she is live (read only, 26 Sep 2026) ──────────────────────────────
const ORG = 'cd97f0f0-4807-4e45-801e-56114b22128a';
const ELA = 'cd96ff83-22ca-4af1-9af9-7ca5de9f6597';
const BLANK = 'c462cbfc-be83-4ee9-9459-91ea0a682215';
const PROGRAM = '0afb5e8b-1e95-402a-83ec-5b3e750d7977';
const NOW = '2026-09-26T20:00:00.000Z';

const elaRow = () => ({
  id: ELA, org_id: ORG, phone: null, phone_raw: null, email: 'elastettner@hotmail.com', name: 'Ela Stettner',
  notes: null, marketing_opt_in: false, marketing_opt_in_at: null, created_at: '2026-09-26 12:20:18.020496+00',
  updated_at: '2026-09-26 12:20:18.020496+00', deleted_at: null, allergens: [], birthday: null, welcome_sent_at: null,
  first_name: 'Ela', last_name: 'Stettner', is_local: null, source: 'import',
  sources: ['import', 'import:d843efc0-b887-4b5a-a209-0aa69a703d1e'], tags: [], no_shows: 0,
  shopper_reference: null, stored_payment_method_id: null,
});
const blankRow = () => ({
  id: BLANK, org_id: ORG, phone: '+447415748167', phone_raw: null, email: null, name: '', notes: null,
  marketing_opt_in: false, marketing_opt_in_at: null, created_at: '2026-09-26 13:25:59.631026+00',
  updated_at: '2026-09-26 13:25:59.631026+00', deleted_at: null, allergens: [], birthday: null, welcome_sent_at: null,
  first_name: null, last_name: null, is_local: null, source: null, sources: [], tags: [], no_shows: 0,
  shopper_reference: null, stored_payment_method_id: null,
});
const elaMembership = () => ({
  id: '74afebf8-5a6b-4755-b1c2-f31f3ca95826', customer_id: ELA, company_id: ORG, points_balance: 0, points_earned_total: 0,
  points_redeemed_total: 0, points_expired_total: 0, tier_id: null, tier_qualified_at: null, visit_count: 0,
  lifetime_spend_minor: 0, member_code: 'SRV-Q43HGG', referral_code: 'REF-DTJYCZ', referred_by: null, birthday: null,
  wallet_pass_serial: null, enrolled_at: '2026-09-26 12:20:17.411+00', last_earn_at: null, last_redeem_at: null, points_expire_at: null,
});
const blankMembership = () => ({
  ...elaMembership(), id: '80c45795-9c27-4485-bf93-8b00eccce709', customer_id: BLANK, member_code: 'SRV-UEMY79',
  referral_code: 'WTZFD49E', enrolled_at: '2026-09-26 13:25:59.762038+00',
});
const elaCard = () => ({
  id: 'e7e0f1d6-d057-4bfb-8ad7-eab1863a8c7b', customer_id: ELA, program_id: PROGRAM, company_id: ORG,
  stamps_collected: 2, completed_count: 0, last_stamp_at: '2026-09-26 12:20:17.411+00', created_at: '2026-09-26 12:20:19.166375+00',
});
const programs = [{ id: PROGRAM, name: 'Free Drink', stamps_required: 10 }];
const elaInput = (over = {}) => ({
  a: elaRow(), b: blankRow(), memberships: [elaMembership(), blankMembership()], cards: [elaCard()], programs,
  activity: { [ELA]: { orders: 0, ledger: 1 }, [BLANK]: { orders: 0, ledger: 0 } }, latestConsent: null, now: NOW, ...over,
});

test('Ela: the imported profile is kept, gets her phone, and the blank one is folded in', () => {
  const plan = planMerge(elaInput());
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.mode, 'fresh');
  assert.equal(plan.target_id, ELA);
  assert.equal(plan.source_id, BLANK);
  assert.equal(plan.swapped, false);
  assert.equal(plan.source_blank, true, 'the portal shell is the till case');
  assert.deepEqual(plan.customers.move, { phone: '+447415748167' });
  const t = plan.customers.target;
  assert.equal(t.name, 'Ela Stettner');
  assert.equal(t.email, 'elastettner@hotmail.com');
  assert.equal(t.phone, null, 'the phone is handed over only after the blank profile lets go of it');
  assert.deepEqual(t.tags, [`merged:${BLANK}`]);
  assert.equal(t.deleted_at, null);
  const s = plan.customers.source;
  assert.equal(s.phone, null);
  assert.equal(s.email, null);
  assert.equal(s.deleted_at, NOW);
  assert.equal(s.name, '', 'name is NOT NULL: the shell keeps its empty name');
  assert.deepEqual(s.tags, [`merged_into:${ELA}`, 'merge_phone:+447415748167']);
  // The empty membership adds nothing: no fold statement, just the delete (and its referrals).
  assert.deepEqual(plan.memberships.moves, []);
  assert.deepEqual(plan.memberships.upserts, []);
  assert.deepEqual(plan.memberships.deletes, [{ id: '80c45795-9c27-4485-bf93-8b00eccce709' }]);
  assert.deepEqual(plan.memberships.kept_codes, ['SRV-Q43HGG']);
  assert.deepEqual(plan.memberships.dropped_codes, ['SRV-UEMY79']);
  assert.deepEqual(plan.stamp_cards, { moves: [], upserts: [], deletes: [], rolled: [] });
  assert.equal(plan.summary[0], 'Ela Stettner is kept. The profile with no name is folded into it and removed from the customer list.');
  assert.ok(plan.summary.some((l) => l === 'Ela Stettner gets the phone ••••••••8167.'));
  assert.ok(plan.warnings.some((w) => w.code === 'member_code_retired' && /SRV-UEMY79 stops working; SRV-Q43HGG is kept/.test(w.message)));
});

test('whichever way round they are named, the profile with history is kept', () => {
  const plan = planMerge(elaInput({ a: blankRow(), b: elaRow() }));
  assert.equal(plan.target_id, ELA);
  assert.equal(plan.source_id, BLANK);
  assert.equal(plan.swapped, true);
  assert.deepEqual(plan.customers.move, { phone: '+447415748167' });
});

test('history: import, points, stamps, orders and ledger rows each count; otherwise the older profile wins', () => {
  const plain = { id: 'x', name: 'A', sources: [], created_at: '2026-01-01' };
  assert.equal(historyOf(plain).any, false);
  assert.equal(historyOf({ ...plain, source: 'import' }).any, true);
  assert.equal(historyOf({ ...plain, sources: ['import:batch'] }).imported, true);
  assert.equal(historyOf(plain, [{ points_balance: 0, points_earned_total: 5 }]).points, 5);
  assert.equal(historyOf(plain, [], [{ stamps_collected: 0, completed_count: 1 }]).stamps, 1);
  assert.equal(historyOf(plain, [], [], { orders: 2 }).orders, 2);
  assert.equal(historyOf(plain, [], [], { ledger: 1 }).any, true);
  assert.equal(historyOf(plain, [{ visit_count: 3 }]).any, true);

  const older = { id: 'o', created_at: '2026-01-01T00:00:00Z' };
  const newer = { id: 'n', created_at: '2026-06-01T00:00:00Z' };
  const none = { any: false }; const some = { any: true };
  assert.equal(chooseSurvivor(newer, older, none, none).target.id, 'o');
  assert.equal(chooseSurvivor(newer, older, some, some).target.id, 'o');
  assert.equal(chooseSurvivor(newer, older, some, none).target.id, 'n', 'history beats age');
  assert.equal(chooseSurvivor(older, newer, none, some).swapped, true);
  const tie = { id: 't', created_at: '2026-01-01T00:00:00Z' };
  assert.equal(chooseSurvivor(tie, older, none, none).target.id, 't', 'a tie keeps the caller\'s order');
});

test('a blank shell: no name, no email, no import, no points, stamps, visits, orders or ledger rows', () => {
  const h0 = historyOf(blankRow());
  assert.equal(isBlankShell(blankRow(), h0), true);
  assert.equal(isBlankShell({ ...blankRow(), name: 'Customer' }, h0), true, "the till's default name");
  assert.equal(isBlankShell({ ...blankRow(), name: '  customer ' }, h0), true);
  assert.equal(isBlankShell({ ...blankRow(), name: 'Ela' }, h0), false);
  assert.equal(isBlankShell({ ...blankRow(), first_name: 'Ela' }, h0), false);
  assert.equal(isBlankShell({ ...blankRow(), email: 'a@b.com' }, h0), false);
  assert.equal(isBlankShell(blankRow(), { ...h0, points: 1 }), false);
  assert.equal(isBlankShell(blankRow(), { ...h0, stamps: 1 }), false);
  assert.equal(isBlankShell(blankRow(), { ...h0, orders: 1 }), false);
  assert.equal(isBlankShell(blankRow(), { ...h0, ledger: 1 }), false);
  assert.equal(isBlankShell(blankRow(), { ...h0, imported: true }), false);
  assert.equal(isBlankShell(null), false);
  assert.equal(isBlankName(''), true);
  assert.equal(isBlankName(null), true);
  assert.equal(isBlankName('Customer'), true);
  assert.equal(isBlankName('Customers'), false);
});

test('refusals: same customer, not found, another business, deleted, merged elsewhere', () => {
  assert.equal(planMerge(elaInput({ b: elaRow() })).refusals[0].code, 'same_customer');
  assert.equal(planMerge(elaInput({ b: null })).refusals[0].code, 'not_found');
  assert.equal(planMerge(elaInput({ b: { ...blankRow(), org_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })).refusals[0].code, 'different_org');
  const del = planMerge(elaInput({ b: { ...blankRow(), deleted_at: '2026-09-26T15:00:00Z' } }));
  assert.equal(del.ok, false);
  assert.equal(del.refusals[0].code, 'deleted');
  const elsewhere = planMerge(elaInput({ b: { ...blankRow(), deleted_at: '2026-09-26T15:00:00Z', tags: ['merged_into:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] } }));
  assert.equal(elsewhere.refusals[0].code, 'merged_elsewhere');
  assert.match(elsewhere.refusals[0].message, /bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
  const targetGone = planMerge(elaInput({ a: { ...elaRow(), deleted_at: '2026-09-26T15:00:00Z' } }));
  assert.equal(targetGone.ok, false);
});

test('two different phones are refused until a person chooses; one number written twice is not', () => {
  const t = { ...elaRow(), phone: '+447700900001' };
  const refused = planMerge(elaInput({ a: t }));
  assert.equal(refused.ok, false);
  assert.equal(refused.refusals[0].code, 'different_phones');
  assert.match(refused.refusals[0].message, /••••••••0001 and ••••••••8167/);

  const keepSource = planMerge(elaInput({ a: { ...t, phone_raw: '07700 900001' }, phoneChoice: 'source' }));
  assert.equal(keepSource.ok, true);
  assert.deepEqual(keepSource.customers.move, { phone: '+447415748167' });
  // 27 Sep 2026: the kept profile lets go of BOTH keys of its old number in the fold statement,
  // then takes the chosen one like a profile with no phone (the hand over only fills a null).
  assert.equal(keepSource.customers.target.phone, null);
  assert.equal(keepSource.customers.target.phone_raw, null);
  assert.ok(keepSource.customers.source.tags.includes('merge_dropped_phone:+447700900001'));
  assert.ok(keepSource.warnings.some((w) => w.code === 'phone_replaced'));
  // A folded in profile with only a raw form: the kept profile ends with THAT number, not its old
  // phone next to the new raw form (first review, 27 Sep 2026).
  const rawOnly = planMerge(elaInput({ a: t, b: { ...blankRow(), phone: null, phone_raw: '07999 999999' }, phoneChoice: 'source' }));
  assert.equal(rawOnly.ok, true);
  assert.deepEqual(rawOnly.customers.move, { phone_raw: '07999 999999' });
  assert.equal(rawOnly.customers.target.phone, null, 'the old phone does not stay beside the new raw form');
  assert.ok(rawOnly.summary.includes('Ela Stettner gets the phone •••••••9999.'));

  const keepTarget = planMerge(elaInput({ a: t, phoneChoice: 'target' }));
  assert.equal(keepTarget.ok, true);
  assert.deepEqual(keepTarget.customers.move, {});
  assert.ok(keepTarget.customers.source.tags.includes('merge_dropped_phone:+447415748167'));

  // '07415 748167' on the kept profile's raw form and '+447415748167' are one number.
  const same = planMerge(elaInput({ a: { ...elaRow(), phone: null, phone_raw: '07415 748167' } }));
  assert.equal(same.ok, true);
  assert.deepEqual(same.customers.move, { phone: '+447415748167' }, 'the missing key is filled, the raw form kept');
  assert.equal(samePhone('+447415748167', '07415748167'), true);
  assert.equal(samePhone('+447415748167', '+447415748168'), false);
  assert.equal(samePhone('12345', '12345'), true);
  assert.equal(samePhone('', '12345'), false);
  assert.equal(samePhone('0044 7415 748167', '+447415748167'), true, '00 is the international prefix');
  assert.equal(samePhone('447415748167', '07415 748167'), true);
  assert.equal(samePhone('7415748167', '+447415748167'), true);
  // 27 Sep 2026 (first review): the last nine digits used to decide, so a UK and a US number
  // with the same tail were "one number" and the second was dropped without a word.
  assert.equal(samePhone('+447415748167', '+17415748167'), false);
  assert.equal(samePhone('07415748167', '+44123407415748167'), false, 'a country code is one to three digits');
  const twoCountries = planMerge(elaInput({ a: { ...elaRow(), phone: '+17415748167' } }));
  assert.equal(twoCountries.ok, false);
  assert.equal(twoCountries.refusals[0].code, 'different_phones', 'refused until a person chooses, never silently dropped');
});

test('fill blanks, never overwrite: name, email, birthday, first and last names', () => {
  const t = { ...blankRow(), id: 'tttttttt-tttt-4ttt-8ttt-tttttttttttt', phone: null, created_at: '2025-01-01', name: 'Customer', birthday: null };
  const s = { ...elaRow(), id: 'ssssssss-ssss-4sss-8sss-ssssssssssss', birthday: '1990-02-03', source: null, sources: [] };
  const f = mergeCustomerFields(t, s, { now: NOW });
  assert.equal(f.target.name, 'Ela Stettner', 'a blank name is filled');
  assert.equal(f.target.first_name, 'Ela');
  assert.equal(f.target.birthday, '1990-02-03');
  assert.deepEqual(f.move, { email: 'elastettner@hotmail.com' });
  assert.ok(f.source.tags.includes('merge_email:elastettner@hotmail.com'));

  const t2 = { ...elaRow(), birthday: '1990-01-01' };
  const s2 = { ...blankRow(), name: 'Ella S', first_name: 'Ella', email: 'other@example.com', birthday: '1991-01-01' };
  const f2 = mergeCustomerFields(t2, s2, { now: NOW });
  assert.equal(f2.target.name, 'Ela Stettner');
  assert.equal(f2.target.email, 'elastettner@hotmail.com');
  assert.equal(f2.target.birthday, '1990-01-01');
  assert.equal(f2.target.first_name, 'Ela');
  assert.equal(f2.move.email, undefined, 'the kept email stays');
  assert.ok(f2.source.tags.includes('merge_dropped_email:other@example.com'));
  const codes = f2.warnings.map((w) => w.code);
  assert.ok(codes.includes('name_differs'));
  assert.ok(codes.includes('email_dropped'));
  assert.ok(codes.includes('birthday_differs'));
  // The same email in another case is the same email: nothing moves, nothing is dropped.
  const f3 = mergeCustomerFields(elaRow(), { ...blankRow(), email: 'ElaStettner@Hotmail.com' }, { now: NOW });
  assert.equal(f3.move.email, undefined);
  assert.equal(f3.warnings.some((w) => w.code === 'email_dropped'), false);
});

test('marketing is yes if either said yes, unless the newest consent record says no', () => {
  const t = { ...elaRow(), marketing_opt_in: false };
  const s = { ...blankRow(), marketing_opt_in: true, marketing_opt_in_at: '2026-09-26T13:30:00Z' };
  const yes = mergeCustomerFields(t, s, { now: NOW, latestConsent: true });
  assert.equal(yes.target.marketing_opt_in, true);
  assert.equal(yes.target.marketing_opt_in_at, '2026-09-26T13:30:00Z');
  const unknown = mergeCustomerFields(t, s, { now: NOW, latestConsent: null });
  assert.equal(unknown.target.marketing_opt_in, true);
  const no = mergeCustomerFields(t, s, { now: NOW, latestConsent: false });
  assert.equal(no.target.marketing_opt_in, false);
  assert.ok(no.warnings.some((w) => w.code === 'marketing_off'));
  const both = mergeCustomerFields({ ...t, marketing_opt_in: true, marketing_opt_in_at: '2026-01-01T00:00:00Z' }, s, { now: NOW });
  assert.equal(both.target.marketing_opt_in_at, '2026-01-01T00:00:00Z', 'the earlier yes');
  const neither = mergeCustomerFields(t, blankRow(), { now: NOW });
  assert.equal(neither.target.marketing_opt_in, false);
});

test('unions and sums: allergens, sources, tags, notes, no shows, welcome, the stored card pair', () => {
  const t = { ...elaRow(), allergens: ['nuts'], notes: 'Oat milk', no_shows: 1, welcome_sent_at: '2026-09-26T12:30:00Z', tags: ['merged:earlier-id'] };
  const s = {
    ...blankRow(), allergens: ['nuts', 'dairy'], notes: 'Oat milk', no_shows: 2, welcome_sent_at: '2026-09-20T00:00:00Z',
    sources: ['wifi'], tags: ['vip'], shopper_reference: 'shop-1', stored_payment_method_id: 'pm-1',
  };
  const f = mergeCustomerFields(t, s, { now: NOW });
  assert.deepEqual(f.target.allergens, ['nuts', 'dairy']);
  assert.deepEqual(f.target.sources, ['import', 'import:d843efc0-b887-4b5a-a209-0aa69a703d1e', 'wifi']);
  assert.deepEqual(f.target.tags, ['merged:earlier-id', 'vip', `merged:${BLANK}`]);
  assert.equal(f.target.notes, 'Oat milk', 'the same note is not written twice');
  assert.equal(f.target.no_shows, 3);
  assert.equal(f.source.no_shows, 0);
  assert.equal(f.target.welcome_sent_at, '2026-09-20T00:00:00Z');
  assert.equal(f.target.shopper_reference, 'shop-1');
  assert.equal(f.target.stored_payment_method_id, 'pm-1');
  const f2 = mergeCustomerFields({ ...t, notes: null }, { ...s, notes: 'Table 4 regular' }, { now: NOW });
  assert.equal(f2.target.notes, 'Table 4 regular');
  const f3 = mergeCustomerFields({ ...t, shopper_reference: 'mine', stored_payment_method_id: null }, s, { now: NOW });
  assert.equal(f3.target.shopper_reference, 'mine');
  assert.equal(f3.target.stored_payment_method_id, null, 'never one half of a pair from each');
});

test('both customers rows carry exactly the same keys (one bulk upsert, no column left to a default)', () => {
  const plan = planMerge(elaInput());
  assert.deepEqual(Object.keys(plan.customers.target).sort(), [...CUSTOMER_UPSERT_COLUMNS].sort());
  assert.deepEqual(Object.keys(plan.customers.source).sort(), [...CUSTOMER_UPSERT_COLUMNS].sort());
  assert.ok(Array.isArray(plan.customers.target.sources) && Array.isArray(plan.customers.source.sources), 'sources is NOT NULL');
  assert.equal(typeof plan.customers.source.name, 'string', 'name is NOT NULL');
});

test('memberships: a company only the source has moves; one both have is summed and the source zeroed', () => {
  const T = 't-cust'; const S = 's-cust';
  const t = { id: 'm-t', customer_id: T, company_id: 'c1', points_balance: 10, points_earned_total: 30, points_redeemed_total: 20, points_expired_total: 0, visit_count: 4, lifetime_spend_minor: 2000, member_code: 'SRV-T', enrolled_at: '2026-05-01T00:00:00Z', last_earn_at: '2026-09-01T00:00:00Z', tier_id: null, referred_by: null };
  const s = { id: 'm-s', customer_id: S, company_id: 'c1', points_balance: 5, points_earned_total: 5, points_redeemed_total: 0, points_expired_total: 1, visit_count: 1, lifetime_spend_minor: 500, member_code: 'SRV-S', enrolled_at: '2026-01-01T00:00:00Z', last_earn_at: '2026-09-20T00:00:00Z', tier_id: 'tier-gold', tier_qualified_at: '2026-02-01T00:00:00Z', referred_by: 'm-x' };
  const s2 = { id: 'm-s2', customer_id: S, company_id: 'c2', points_balance: 7, member_code: 'SRV-S2' };
  const mp = planMemberships(T, S, [t], [s, s2]);
  assert.deepEqual(mp.moves, [{ id: 'm-s2', company_id: 'c2', member_code: 'SRV-S2' }]);
  assert.equal(mp.upserts.length, 2);
  const [zero, next] = mp.upserts;
  assert.equal(zero.id, 'm-s');
  assert.equal(zero.customer_id, S);
  for (const f of ['points_balance', 'points_earned_total', 'points_redeemed_total', 'points_expired_total', 'visit_count', 'lifetime_spend_minor']) assert.equal(zero[f], 0, f);
  assert.equal(next.id, 'm-t');
  assert.equal(next.points_balance, 15);
  assert.equal(next.points_earned_total, 35);
  assert.equal(next.points_redeemed_total, 20);
  assert.equal(next.points_expired_total, 1);
  assert.equal(next.visit_count, 5);
  assert.equal(next.lifetime_spend_minor, 2500);
  assert.equal(next.enrolled_at, '2026-01-01T00:00:00Z', 'the earlier enrolment');
  assert.equal(next.last_earn_at, '2026-09-20T00:00:00Z');
  assert.equal(next.tier_id, 'tier-gold', 'a missing tier is filled');
  assert.equal(next.referred_by, 'm-x');
  assert.deepEqual(Object.keys(next).sort(), [...MEMBERSHIP_UPSERT_COLUMNS].sort());
  assert.deepEqual(Object.keys(zero).sort(), [...MEMBERSHIP_UPSERT_COLUMNS].sort());
  assert.deepEqual(mp.referrals, [{ from: 'm-s', to: 'm-t' }]);
  assert.deepEqual(mp.deletes, [{ id: 'm-s' }]);
  assert.deepEqual(mp.kept_codes, ['SRV-T', 'SRV-S2']);
  assert.deepEqual(mp.dropped_codes, ['SRV-S']);
  // A zeroed source (a retry after the fold landed) adds nothing and writes nothing again.
  const again = planMemberships(T, S, [next], [zero]);
  assert.deepEqual(again.upserts, []);
  assert.deepEqual(again.deletes, [{ id: 'm-s' }]);
  // Referred by the source itself, or by itself: never kept.
  const selfRef = planMemberships(T, S, [{ ...t, referred_by: 'm-s' }], [s]);
  assert.equal(selfRef.upserts[1].referred_by, 'm-x');
  const loop = planMemberships(T, S, [{ ...t, referred_by: null }], [{ ...s, referred_by: 'm-t' }]);
  assert.equal(loop.upserts[1].referred_by, null);
});

test('stamp cards: summed per programme, a full card rolls into a completed one, the later stamp date kept', () => {
  const T = 't-cust'; const S = 's-cust';
  const t = { id: 'c-t', customer_id: T, program_id: PROGRAM, company_id: ORG, stamps_collected: 8, completed_count: 1, last_stamp_at: '2026-09-01T00:00:00Z' };
  const s = { id: 'c-s', customer_id: S, program_id: PROGRAM, company_id: ORG, stamps_collected: 5, completed_count: 0, last_stamp_at: '2026-09-20T00:00:00Z' };
  const other = { id: 'c-o', customer_id: S, program_id: 'p2', company_id: ORG, stamps_collected: 3, completed_count: 0 };
  const cp = planStampCards(T, S, [t], [s, other], programs);
  assert.deepEqual(cp.moves, [{ id: 'c-o', program_id: 'p2' }]);
  const [zero, next] = cp.upserts;
  assert.deepEqual([zero.id, zero.stamps_collected, zero.completed_count], ['c-s', 0, 0]);
  assert.deepEqual([next.id, next.stamps_collected, next.completed_count], ['c-t', 3, 2], '8 + 5 of 10 is one more reward and 3 stamps');
  assert.equal(next.last_stamp_at, '2026-09-20T00:00:00Z');
  assert.deepEqual(Object.keys(next).sort(), [...CARD_UPSERT_COLUMNS].sort());
  assert.deepEqual(cp.deletes, [{ id: 'c-s' }]);
  assert.deepEqual(cp.rolled, [{ program_id: PROGRAM, cards: 1 }]);
  // Without the programme's size nothing rolls (never a guess).
  const unknown = planStampCards(T, S, [t], [s], []);
  assert.equal(unknown.upserts[1].stamps_collected, 13);
  // Ela's portal shell had no card: her 2 stamps stay where they are.
  assert.deepEqual(planStampCards(ELA, BLANK, [elaCard()], [], programs), { moves: [], upserts: [], deletes: [], rolled: [] });
  // The warning says it in words.
  const plan = planMerge(elaInput({ cards: [elaCard(), { ...s, customer_id: BLANK, stamps_collected: 9 }] }));
  assert.ok(plan.warnings.some((w) => w.code === 'stamps_rolled_over' && /Free Drink/.test(w.message)));
});

test('venue visit records: summed at a venue both know, moved otherwise, never float dust', () => {
  const T = 't'; const S = 's';
  const tRows = [{ customer_id: T, location_id: 'L1', first_visit_at: '2026-03-01', last_visit_at: '2026-09-01', visit_count: 3, lifetime_revenue: '12.30', notes: 'Window seat' }];
  const sRows = [
    { customer_id: S, location_id: 'L1', first_visit_at: '2026-01-01', last_visit_at: '2026-09-10', visit_count: 2, lifetime_revenue: '4.50', notes: 'Window seat' },
    { customer_id: S, location_id: 'L2', first_visit_at: '2026-02-01', last_visit_at: '2026-02-01', visit_count: 1, lifetime_revenue: '3.10', notes: null },
  ];
  const lp = planCustomerLocations(T, S, tRows, sRows);
  assert.deepEqual(lp.moves, [{ location_id: 'L2' }]);
  const [zero, next] = lp.upserts;
  assert.deepEqual([zero.customer_id, zero.location_id, zero.visit_count, zero.lifetime_revenue], [S, 'L1', 0, 0]);
  assert.equal(next.visit_count, 5);
  assert.equal(next.lifetime_revenue, 16.8);
  assert.equal(next.first_visit_at, '2026-01-01');
  assert.equal(next.last_visit_at, '2026-09-10');
  assert.equal(next.notes, 'Window seat');
  assert.deepEqual(lp.deletes, [{ location_id: 'L1' }]);
  assert.equal(addDecimal('0.1', '0.2'), 0.3);
});

test('rows under a unique key: the ones the survivor already has stay behind; a NULL never clashes', () => {
  const s = [
    { id: 1, campaign_id: 'c1', dedupe_key: 'k' },
    { id: 2, campaign_id: 'c2', dedupe_key: 'k' },
    { id: 3, campaign_id: 'c1', dedupe_key: null },
  ];
  const t = [{ id: 9, campaign_id: 'c1', dedupe_key: 'k' }, { id: 10, campaign_id: 'c1', dedupe_key: null }];
  assert.deepEqual(partitionClashes(s, t, ['campaign_id', 'dedupe_key']), { move: [2, 3], stay: [1] });
  assert.deepEqual(partitionClashes([{ id: 'e', workflow_id: 'w' }], [{ id: 'f', workflow_id: 'w' }], ['workflow_id']), { move: [], stay: ['e'] });
});

test('every Ops table with a customer_id column is listed (information_schema, 26 Sep 2026)', () => {
  assert.deepEqual(MERGE_TABLES.map((t) => t.table).sort(), [
    'bookings', 'campaign_sends', 'closed_checks', 'customer_consents', 'customer_locations', 'customer_orders',
    'loyalty_transactions', 'marketing_messages', 'marketing_suppressions', 'promo_codes', 'promo_redemptions',
    'review_feedback', 'stamp_transactions', 'waitlist_entries', 'wifi_captures', 'workflow_enrollments', 'workflow_step_sends',
  ]);
  assert.deepEqual(MERGE_TABLES.find((t) => t.table === 'campaign_sends').unique, ['campaign_id', 'dedupe_key']);
  assert.deepEqual(MERGE_TABLES.find((t) => t.table === 'workflow_enrollments').unique, ['workflow_id']);
  assert.equal(MERGE_TABLES.find((t) => t.table === 'customer_locations').sum, true);
  for (const t of MERGE_TABLES) assert.ok(t.label && t.one && !/[–—]/.test(t.label + t.one), t.table);
});

test('a merge that stopped half way is finished (resume), never refused as deleted, and never rewrites the survivor', () => {
  // After the one statement that folds the profiles, before the phone was handed over.
  const shell = { ...blankRow(), phone: null, deleted_at: '2026-09-26T20:00:01Z', tags: [`merged_into:${ELA}`, 'merge_phone:+447415748167'] };
  const ela = { ...elaRow(), tags: [`merged:${BLANK}`] };
  for (const [a, b] of [[ela, shell], [shell, ela]]) {
    const plan = planMerge(elaInput({ a, b, memberships: [elaMembership()] }));
    assert.equal(plan.ok, true);
    assert.equal(plan.mode, 'resume');
    assert.equal(plan.target_id, ELA);
    assert.deepEqual(plan.customers.move, { phone: '+447415748167' });
    // 27 Sep 2026 (first review): no profile row is written in a resume, survivor or source.
    assert.equal(plan.customers.target, null, 'the survivor is never rebuilt from the folded in row');
    assert.equal(plan.customers.source, null, 'the first deletion time and trail stand');
    assert.deepEqual(plan.customers.finish, { tags: [...shell.tags, 'merge_done'] });
    assert.equal(plan.summary[0], 'The profile with no name was already folded into Ela Stettner; this finishes the job.');
  }
  assert.equal(mergedIntoOf(shell.tags), ELA);
  assert.equal(mergedIntoOf(['merged_into:not-a-uuid']), null);
  assert.equal(tagValue(shell.tags, MERGE_TAG.PHONE), '+447415748167');
});

test('resume hands over only into a field that is still empty, only what nobody else holds, and never after merge_done', () => {
  const shell = (tags) => ({ ...blankRow(), phone: null, deleted_at: '2026-09-26T20:00:01Z', tags: [`merged_into:${ELA}`, ...tags] });
  const ela = (over = {}) => ({ ...elaRow(), email: null, tags: [`merged:${BLANK}`], ...over });
  const run = (a, b, holders = []) => planMerge(elaInput({ a, b, memberships: [elaMembership()], holders }));
  const trail = ['merge_phone:+447415748167', 'merge_phone_raw:07415 748167', 'merge_email:ela@example.com'];

  // Both still empty and free: both handed over.
  const free = run(ela(), shell(trail));
  assert.deepEqual(free.customers.move, { phone: '+447415748167', phone_raw: '07415 748167', email: 'ela@example.com' });
  assert.deepEqual(free.warnings.filter((w) => !/member_code/.test(w.code)), []);

  // Staff gave her another phone and email since: both stay, and the preview says why.
  const changed = run(ela({ phone: '+447000000001', email: 'new@example.com' }), shell(trail));
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.customers.move, {});
  assert.deepEqual(changed.warnings.map((w) => w.code).filter((c) => c !== 'member_code_retired').sort(), ['email_kept', 'phone_kept']);
  assert.equal(changed.customers.target, null);

  // The same number already there (the hand over landed, the answer was lost): nothing, no warning.
  const same = run(ela({ phone: '+447415748167', phone_raw: '07415 748167', email: 'ELA@example.com' }), shell(trail));
  assert.deepEqual(same.customers.move, {});
  assert.deepEqual(same.warnings.filter((w) => w.code !== 'member_code_retired'), []);

  // Only the raw form of the SAME number typed since (Back Office writes phone_raw): the key is filled.
  const rawTyped = run(ela({ phone_raw: '07415 748167' }), shell(trail));
  assert.deepEqual(rawTyped.customers.move, { phone: '+447415748167', email: 'ela@example.com' });
  // The raw form of ANOTHER number typed since: that number stays, nothing is added beside it.
  const otherRaw = run(ela({ phone_raw: '07000 000001' }), shell(trail));
  assert.equal(otherRaw.customers.move.phone, undefined);
  assert.ok(otherRaw.warnings.some((w) => w.code === 'phone_kept'));

  // Somebody else signed up with the phone or the email since: not handed over, the merge still finishes.
  const taken = run(ela(), shell(trail), [
    { id: 'eeeeeeee-0000-4000-8000-000000000001', phone: '+447415748167', phone_raw: null, email: null },
    { id: 'eeeeeeee-0000-4000-8000-000000000002', phone: null, phone_raw: null, email: 'Ela@Example.com' },
  ]);
  assert.equal(taken.ok, true);
  assert.deepEqual(taken.customers.move, {});
  assert.ok(taken.warnings.some((w) => w.code === 'phone_taken'));
  assert.ok(taken.warnings.some((w) => w.code === 'email_taken'));
  assert.ok(taken.customers.finish, 'still marked done');
  // The survivor and the folded in profile themselves are never "somebody else"; a deleted row neither.
  const selfHeld = run(ela(), shell(trail), [
    { id: ELA, phone: null, email: null },
    { id: BLANK, phone: '+447415748167', email: 'ela@example.com' },
    { id: 'eeeeeeee-0000-4000-8000-000000000003', phone: '+447415748167', deleted_at: '2026-09-20T00:00:00Z' },
  ]);
  assert.equal(selfHeld.customers.move.phone, '+447415748167');

  // After merge_done nothing is handed over again, even into a field staff emptied on purpose.
  const done = run(ela(), shell([...trail, 'merge_done']));
  assert.equal(done.ok, true);
  assert.deepEqual(done.customers.move, {});
  assert.equal(done.customers.finish, null);
  assert.equal(done.summary[0], 'The profile with no name is already merged into Ela Stettner. Nothing on Ela Stettner is changed.');

  // Staff chose the folded in profile's phone: the fold statement already cleared the survivor's
  // own, so the resume fills it exactly as the first run would have.
  const chose = run(ela(), shell(['merge_dropped_phone:+447700900001', 'merge_phone:+447415748167']));
  assert.deepEqual(chose.customers.move, { phone: '+447415748167' });
});

test('resume needs BOTH halves of the trail: a merged_into tag alone never hands a phone over', () => {
  // The first review's forged case: a deleted blank row tagged merged_into Ela with somebody
  // else's phone. Ela carries no merged:<that row> tag, so it is refused and nothing is planned.
  const forged = { ...blankRow(), phone: null, deleted_at: '2026-09-26T19:00:00Z', tags: [`merged_into:${ELA}`, 'merge_phone:+447999999999', 'merge_email:someone@example.com'] };
  for (const [a, b] of [[elaRow(), forged], [forged, elaRow()]]) {
    const plan = planMerge(elaInput({ a, b }));
    assert.equal(plan.ok, false);
    assert.equal(plan.refusals[0].code, 'merge_trail_broken');
    assert.equal(plan.customers, null);
    assert.doesNotMatch(plan.refusals[0].message, /[–—]/);
  }
  // The survivor's tag names ANOTHER profile: still refused.
  const other = planMerge(elaInput({ a: { ...elaRow(), tags: ['merged:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] }, b: forged }));
  assert.equal(other.refusals[0].code, 'merge_trail_broken');
});

test('who may merge: owner or manager of the venue, the org owner, a company owner or admin, a super admin; a till only for a blank shell', () => {
  const user = { id: 'u1', is_anonymous: false };
  const base = { user, venueOrgId: ORG, customersOrgId: ORG, profileRole: null, profileOrgId: null, linkRole: null, companyRole: null, device: false, sourceBlank: false };
  assert.deepEqual(decideMergeCaller({ ...base, profileRole: 'super_admin' }), { ok: true, as: 'staff', via: 'super_admin' });
  assert.equal(decideMergeCaller({ ...base, linkRole: 'manager' }).via, 'venue_role');
  assert.equal(decideMergeCaller({ ...base, linkRole: 'owner' }).via, 'venue_role');
  assert.equal(decideMergeCaller({ ...base, linkRole: 'staff' }).code, 'not_allowed');
  assert.equal(decideMergeCaller({ ...base, linkRole: 'viewer' }).code, 'not_allowed');
  assert.equal(decideMergeCaller({ ...base, profileRole: 'owner', profileOrgId: ORG }).via, 'owner_org');
  assert.equal(decideMergeCaller({ ...base, profileRole: 'owner', profileOrgId: 'another-org' }).code, 'not_allowed');
  assert.equal(decideMergeCaller({ ...base, profileRole: 'owner', profileOrgId: null }).code, 'not_allowed');
  assert.equal(decideMergeCaller({ ...base, companyRole: 'admin' }).via, 'company_role');
  assert.equal(decideMergeCaller({ ...base, profileRole: 'manager' }).code, 'not_allowed', 'a manager needs the venue');
  // An anonymous session is never staff, whatever its profile says (kiosk, online, QR).
  const anon = { ...base, user: { id: 'k1', is_anonymous: true }, profileRole: 'super_admin', linkRole: 'owner' };
  assert.equal(decideMergeCaller(anon).code, 'not_allowed');
  // The till case.
  assert.deepEqual(decideMergeCaller({ ...anon, device: true, sourceBlank: true }), { ok: true, as: 'device', via: 'device' });
  const tillNotBlank = decideMergeCaller({ ...anon, device: true, sourceBlank: false });
  assert.equal(tillNotBlank.code, 'device_needs_blank_source');
  assert.equal(tillNotBlank.status, 403);
  // The venue must be the customers' business, for everybody.
  assert.equal(decideMergeCaller({ ...base, profileRole: 'super_admin', venueOrgId: 'x' }).code, 'other_org');
  assert.equal(decideMergeCaller({ ...anon, device: true, sourceBlank: true, customersOrgId: null }).code, 'other_org');
  assert.equal(decideMergeCaller({ service: true, venueOrgId: ORG, customersOrgId: ORG }).as, 'service');
  assert.equal(decideMergeCaller({ service: true, venueOrgId: 'x', customersOrgId: ORG }).code, 'other_org');
  assert.equal(decideMergeCaller({ ...base, user: null }).status, 401);
  // The Back Office button uses the same rule.
  assert.equal(canStaffMerge({ linkRole: 'manager' }), true);
  assert.equal(canStaffMerge({ linkRole: 'staff' }), false);
  assert.equal(canStaffMerge({ profileRole: 'owner', profileOrgId: ORG, venueOrgId: ORG }), true);
  assert.equal(staffMergeRole({ ...base, user: { id: '', is_anonymous: false }, profileRole: 'super_admin' }), null);
});

test('the request: action, two customer ids, the venue, an optional phone choice', () => {
  const ok = validateMergeRequest({ action: 'preview', target_id: ELA, source_id: BLANK, location_id: '1e252e7c-c875-4971-b91d-1e945c26956b' });
  assert.deepEqual(ok, { ok: true, action: 'preview', targetId: ELA, sourceId: BLANK, locationId: '1e252e7c-c875-4971-b91d-1e945c26956b', phoneChoice: null });
  assert.equal(validateMergeRequest({ ...ok, action: 'merge', target_id: ELA, source_id: BLANK, location_id: ELA, phone_choice: 'source' }).phoneChoice, 'source');
  assert.equal(validateMergeRequest({ action: 'delete', target_id: ELA, source_id: BLANK, location_id: ELA }).ok, false);
  assert.equal(validateMergeRequest({ action: 'merge', target_id: 'nope', source_id: BLANK, location_id: ELA }).ok, false);
  assert.equal(validateMergeRequest({ action: 'merge', target_id: ELA, source_id: BLANK }).ok, false);
  assert.equal(validateMergeRequest({ action: 'merge', target_id: ELA, source_id: BLANK, location_id: ELA, phone_choice: 'both' }).ok, false);
  assert.equal(validateMergeRequest(null).ok, false);
});

test('a unique index refusal names the field; anything else is not a clash', () => {
  assert.equal(uniqueClashOf({ code: '23505', message: 'duplicate key value violates unique constraint "idx_customers_org_email"', details: 'Key (org_id, lower(email))=(x, y) already exists.' }), 'email');
  assert.equal(uniqueClashOf({ code: '23505', message: 'duplicate key value violates unique constraint "idx_customers_org_phone"' }), 'phone');
  assert.equal(uniqueClashOf({ message: 'duplicate key value violates unique constraint "idx_customers_org_phone"' }), 'phone');
  assert.equal(uniqueClashOf({ code: '23505', message: 'duplicate key value violates unique constraint "customers_pkey"' }), null);
  assert.equal(uniqueClashOf({ code: '42501', message: 'permission denied' }), null);
  assert.equal(uniqueClashOf(null), null);
});

test('masks, dates and unions', () => {
  assert.equal(maskPhone('+447415748167'), '••••••••8167');
  assert.equal(maskPhone('123'), '•••');
  assert.equal(maskPhone(null), '');
  assert.equal(maskEmail('elastettner@hotmail.com'), 'e•••@hotmail.com');
  assert.equal(maskEmail('nope'), '•••');
  assert.equal(maskEmail(''), '');
  assert.equal(earlier('2026-01-02', '2026-01-01'), '2026-01-01');
  assert.equal(earlier(null, '2026-01-01'), '2026-01-01');
  assert.equal(earlier(null, null), null);
  assert.equal(later('2026-01-02', '2026-01-01'), '2026-01-02');
  assert.equal(later('2026-01-02', null), '2026-01-02');
  assert.deepEqual(union(['a', 'b'], null, ['b', 'c', '', null]), ['a', 'b', 'c']);
});

test('the preview card shows masked contact, points, codes, stamps and orders', () => {
  const plan = planMerge(elaInput());
  const card = profileCard(elaRow(), plan.target_history, [elaMembership(), blankMembership()], [elaCard()], programs);
  assert.deepEqual(card, {
    id: ELA, name: 'Ela Stettner', phone: '', email: 'e•••@hotmail.com', created_at: '2026-09-26 12:20:18.020496+00',
    deleted: false, imported: true, orders: 0, points: 0, member_codes: ['SRV-Q43HGG'],
    stamps: [{ program_id: PROGRAM, name: 'Free Drink', stamps_required: 10, stamps_collected: 2, completed_count: 0 }],
  });
  const shell = profileCard(blankRow(), plan.source_history, [elaMembership(), blankMembership()], [], programs);
  assert.equal(shell.name, 'No name');
  assert.equal(shell.phone, '••••••••8167');
  assert.equal(profileCard(null), null);
});

test('a till gets back only what its screen shows; staff get the whole survivor (27 Sep 2026)', () => {
  const row = {
    id: ELA, name: 'Ela Stettner', phone: '+447415748167', email: 'elastettner@hotmail.com', marketing_opt_in: true,
    allergens: ['nuts'], notes: 'Regular, pays by card', tags: [`merged:${BLANK}`], sources: ['import'],
  };
  assert.deepEqual(survivorForCaller(row, 'device'), {
    id: ELA, name: 'Ela Stettner', phone: '+447415748167', email: 'elastettner@hotmail.com', marketing_opt_in: true, allergens: ['nuts'],
  }, 'never the notes, the tags or the sources (the customer fence, 20260921)');
  assert.equal(survivorForCaller(row, 'staff'), row);
  assert.equal(survivorForCaller(row, 'service'), row);
  assert.equal(survivorForCaller(null, 'device'), null);
  assert.deepEqual(survivorForCaller({ id: ELA, name: null }, 'device').allergens, []);
  // The holders read and the Back Office clash lookup share one exact email pattern.
  assert.equal(exactIlike(' ela_s%x@hotmail.com '), 'ela\\_s\\%x@hotmail.com');
});

test('no dash punctuation in anything a person reads', () => {
  const plan = planMerge(elaInput({ a: { ...elaRow(), phone: '+447700900001' } }));
  const words = [...plan.refusals, ...plan.warnings].map((x) => x.message).concat(plan.summary);
  for (const w of words) assert.doesNotMatch(w, /[–—]/, w);
  const d = decideMergeCaller({ user: { id: 'k', is_anonymous: true }, venueOrgId: ORG, customersOrgId: ORG, device: true, sourceBlank: false });
  assert.doesNotMatch(d.error, /[–—]/);
});
