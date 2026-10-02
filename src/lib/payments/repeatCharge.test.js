/**
 * repeatCharge.test.js - the server side double charge net
 * (supabase/functions/_shared/repeatCharge.js), run under plain node like terminalKick.test.js.
 *
 * The money rule (Coffee Boy Huddersfield, 30 Sep 2026): a card payment this till or this
 * reader just took, for the same items, must never be taken again without a human saying
 * "different customer". Fixtures are the live rows of that day (ids shortened), read from
 * Ops on 30 Sep: 97c6176c then bcdcefd6 and 7da9f45c (R5737, charged twice as R5739),
 * b06007e2 then 462ab409 (R6282, near miss), and Leeds 28 Sep R9926 then R9927 (rung again
 * with two waters added, R9927 refunded). The Leeds £4.10 pairs of 30 Sep must not fire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findPossibleRepeat, repeatRefusal, repeatWarning, repeatMessage, repeatDetail, repeatAckRecord, shouldCheckRepeat,
  itemSignature, isSubsetBasket, itemSummary, bookedState, fmtTime, fmtCard, fmtMoney,
  findSameCardRepeat, sameCardAlert, cardKeyOf,
  REPEAT_WINDOW_MS, SAME_BASKET_WINDOW_MS, SAME_CARD_WINDOW_MS, LIVE_STATUSES, CHARGED_STATUSES,
  REPEAT_CHECKED_SOURCES, REPEAT_PRIOR_SOURCES,
} from '../../../supabase/functions/_shared/repeatCharge.js';

const TZ = 'Europe/London';
const HUD = '5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9';
const HUD_TILL = 'ff1b5fb8-2406-4854-bdb0-37cc8af45361';
const HUD_READER = 'a264a739-adb3-40fe-a5f1-628f906505b1';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const LEEDS_TILL = '4b682001-4374-4b24-9541-0cf8e74e57f7';
const LEEDS_READER = '98be89ef-dda8-467b-9187-d48a82653d47';

const skinnyCaramel = [
  { id: 'opt-1', name: 'Skinny Milk', label: 'Skinny Milk', price: 0, groupLabel: 'Milk Options' },
  { id: 'opt-2', name: 'Caramel Syrup', label: 'Caramel Syrup', price: 0.7, groupLabel: 'Syrup Options' },
];
const HUD_ITEMS = [
  { name: 'Cappuccino — Big Boy', qty: 1, price: 4.7, mods: skinnyCaramel },
  { name: 'Latte — Big Boy ', qty: 1, price: 4.7, mods: skinnyCaramel },
  { name: 'Chocolonely - Milk Choc', qty: 1, price: 2.25, mods: [] },
];
const VISA_9810 = { brand: 'visa', last4: '9810', read_method: 'CLESS_CHIP', application_name: 'Visa Debit' };

const draft = (items, orderRef, over = {}) => ({
  tableId: null, tableLabel: null, sessionId: null, orderType: 'takeaway', covers: 0,
  staffId: '41ba015a-9042-4741-a323-4669244a294c', items, orderRef, source: 'pos_send_to_terminal', ...over,
});

// 97c6176c: the payment that was booked in the background as R5737.
const job97c = {
  id: '97c6176c-0131-4fa7-ab58-6079ee63f8d7', status: 'reconciled',
  check_key: `${HUD}:walkin:-:chk-1790768566981-528328`, closed_check_id: 'chk-1790768566981-528328',
  pos_device_id: HUD_TILL, target_terminal_id: HUD_READER, location_id: HUD,
  due_minor: 1165, charge_minor: 1165, tip_minor: null, currency: 'GBP',
  created_at: '2026-09-30T11:42:49.330Z', dispatched_at: '2026-09-30T11:42:50.388Z', settled_at: '2026-09-30T11:43:29.541Z',
  card: VISA_9810, check_draft: draft(HUD_ITEMS, 'R5737'),
  booked: { id: 'chk-1790768566981-528328', ref: 'R5737', source: 'pos_send_to_terminal', refunded: false, status: 'paid', total: 11.65 },
};
// bcdcefd6: the re-ring 14 s after approval (the customer gave up: '108').
const reqBcd = {
  job_id: 'bcdcefd6-cc31-45b8-819b-970c3851e549', check_key: `${HUD}:walkin:-:chk-1790768594328-064605`,
  location_id: HUD, pos_device_id: HUD_TILL, target_terminal_id: HUD_READER, due_minor: 1165,
  check_draft: draft(HUD_ITEMS, 'R5738'),
};
const T_BCD = Date.parse('2026-09-30T11:43:43.303Z');
// 7da9f45c: the one that charged the card again (R5739), 2 min 20 s after the first approval.
const req7da = { ...reqBcd, job_id: '7da9f45c-0e0a-4ad3-9b50-1889e82eb135', check_key: `${HUD}:walkin:-:chk-1790768747349-c91eec`, check_draft: draft(HUD_ITEMS, 'R5739') };
const T_7DA = Date.parse('2026-09-30T11:45:49.477Z');

test('Huddersfield 12:43: bcdcefd6 is refused as unfinished (R5737 booked in the background, same items, 14 s later)', () => {
  const hit = findPossibleRepeat(reqBcd, [job97c], T_BCD);
  assert.ok(hit, 'must fire');
  assert.equal(hit.tier, 'unfinished');
  assert.equal(hit.same_items, true);
  assert.equal(hit.job.job_id, job97c.id);
  assert.equal(hit.job.ref, 'R5737');
  assert.equal(hit.job.booked, 'background');
  assert.equal(hit.adoptable, false, 'approved is not live: nothing to watch, only to book');
  assert.equal(repeatMessage(hit, { tz: TZ }),
    '£11.65 was already paid on this card machine at 12:43 (Visa ••9810), R5737, same items. Do not charge again.');
  const refusal = repeatRefusal(hit, null, { tz: TZ });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.code, 'POSSIBLE_REPEAT');
  assert.equal(refusal.detail.job_id, job97c.id);
  assert.equal(refusal.detail.tier, 'unfinished');
  assert.equal(refusal.detail.items, '1x Cappuccino — Big Boy, 1x Latte — Big Boy, 1x Chocolonely - Milk Choc');
  assert.deepEqual(refusal.detail.card, { brand: 'visa', last4: '9810' });
});

test('Huddersfield 12:45: 7da9f45c (the one that charged the card again) is refused too, with bcdcefd6 declined in between', () => {
  const declined = {
    id: 'bcdcefd6-cc31-45b8-819b-970c3851e549', status: 'declined', check_key: reqBcd.check_key, closed_check_id: 'chk-1790768594328-064605',
    pos_device_id: HUD_TILL, target_terminal_id: HUD_READER, location_id: HUD, due_minor: 1165, charge_minor: 1165,
    created_at: '2026-09-30T11:43:43.303Z', settled_at: '2026-09-30T11:45:40.294Z', decline_reason: '108 Shopper cancelled tx', card: null,
    check_draft: draft(HUD_ITEMS, 'R5738'), booked: null,
  };
  const hit = findPossibleRepeat(req7da, [declined, job97c], T_7DA);
  assert.ok(hit);
  assert.equal(hit.tier, 'unfinished');
  assert.equal(hit.job.job_id, job97c.id, 'the declined re-ring is not a charge; the approved one is');
});

test('the same payment 10 min 1 s after approval is outside the net; 9 min 59 s is inside', () => {
  const approvedAt = Date.parse(job97c.settled_at);
  assert.ok(findPossibleRepeat(req7da, [job97c], approvedAt + REPEAT_WINDOW_MS - 1000));
  assert.equal(findPossibleRepeat(req7da, [job97c], approvedAt + REPEAT_WINDOW_MS + 1000), null);
});

test('a refunded prior never fires, whichever column says so', () => {
  const refundedFlag = { ...job97c, booked: { ...job97c.booked, refunded: true } };
  const refundedStatus = { ...job97c, booked: { ...job97c.booked, status: 'refunded' } };
  const voided = { ...job97c, booked: { ...job97c.booked, voided: true } };
  for (const j of [refundedFlag, refundedStatus, voided]) assert.equal(findPossibleRepeat(reqBcd, [j], T_BCD), null);
  assert.equal(bookedState(refundedStatus.booked), 'refunded');
});

test('a different till on a different reader never fires; the same reader from another till does', () => {
  const otherTill = { ...reqBcd, pos_device_id: 'till-drive-thru', target_terminal_id: 'reader-drive-thru' };
  assert.equal(findPossibleRepeat(otherTill, [job97c], T_BCD), null);
  const sameReader = { ...reqBcd, pos_device_id: 'till-drive-thru' };
  assert.equal(findPossibleRepeat(sameReader, [job97c], T_BCD)?.tier, 'unfinished');
  const sameTillOtherReader = { ...reqBcd, target_terminal_id: 'reader-2' };
  assert.equal(findPossibleRepeat(sameTillOtherReader, [job97c], T_BCD)?.tier, 'unfinished');
});

test('the same check_key is a retry, never a repeat (idx_tj_one_live_per_check owns it); another venue is ignored', () => {
  assert.equal(findPossibleRepeat({ ...reqBcd, check_key: job97c.check_key }, [job97c], T_BCD), null);
  assert.equal(findPossibleRepeat({ ...reqBcd, location_id: LEEDS }, [job97c], T_BCD), null);
  assert.equal(findPossibleRepeat(reqBcd, [{ ...job97c, simulated: true }], T_BCD), null);
  assert.equal(findPossibleRepeat(reqBcd, [{ ...job97c, status: 'unknown' }], T_BCD), null, 'a manager releases unknowns');
});

test('Leeds £4.10 pairs (30 Sep): same amount, background booked, DIFFERENT basket 9 min later does not fire', () => {
  const latte = {
    id: '3b5718b9-4f93-449d-9b9e-c8533f55f5d8', status: 'reconciled', check_key: `${LEEDS}:walkin:-:chk-a`, closed_check_id: 'chk-a',
    pos_device_id: LEEDS_TILL, target_terminal_id: LEEDS_READER, location_id: LEEDS, due_minor: 410, charge_minor: 410,
    created_at: '2026-09-30T11:17:31.984Z', settled_at: '2026-09-30T11:17:55.000Z', card: { brand: 'mc', last4: '1300' },
    check_draft: draft([{ name: 'Latte — Big Boy ', qty: 1, price: 4.1, mods: [] }], 'R11480'),
    booked: { id: 'chk-a', ref: 'R11480', source: 'pos_send_to_terminal', refunded: false, status: 'paid' },
  };
  const mocha = {
    job_id: 'c3e9d9e6-5627-4c31-b3fd-2ea67762f11b', check_key: `${LEEDS}:walkin:-:chk-b`, location_id: LEEDS,
    pos_device_id: LEEDS_TILL, target_terminal_id: LEEDS_READER, due_minor: 410,
    check_draft: draft([{ name: 'Mocha — Small Boy', qty: 1, price: 4.1, mods: [] }], 'R11481'),
  };
  assert.equal(findPossibleRepeat(mocha, [latte], Date.parse('2026-09-30T11:26:34.623Z')), null);
  // Same drink, different milk: a different line, so still not a repeat.
  const oatLatte = { ...mocha, check_draft: draft([{ name: 'Latte — Big Boy', qty: 1, price: 4.1, mods: [{ name: 'Oat Milk', price: 0 }] }], 'R11481') };
  assert.equal(findPossibleRepeat(oatLatte, [latte], Date.parse('2026-09-30T11:19:00Z')), null);
});

test('Leeds 28 Sep: R9926 booked in the background, rung again as R9927 with two waters added: unfinished (subset), any amount', () => {
  const pac = { name: 'Pain Au Choc', qty: 2, price: 2.65, mods: [] };
  const toast = { name: 'Cheese on Toast', qty: 1, price: 4.05, mods: [{ id: 'opt-w', name: 'White Toast', label: 'White Toast', price: 0 }] };
  const water = { name: 'Harrogate Still', qty: 1, price: 1.6, mods: [] };
  const r9926 = {
    id: 'bca72083-6db4-4ba2-9b4d-10c355ff852d', status: 'reconciled', check_key: `${LEEDS}:walkin:-:chk-1790609128634-5cc0f8`,
    closed_check_id: 'chk-1790609128634-5cc0f8', pos_device_id: LEEDS_TILL, target_terminal_id: LEEDS_READER, location_id: LEEDS,
    due_minor: 935, charge_minor: 1028, tip_minor: 93, created_at: '2026-09-28T15:25:30.389Z', dispatched_at: '2026-09-28T15:25:31.649Z',
    settled_at: '2026-09-28T15:25:53.751Z', card: { brand: 'visa', last4: '2844' }, check_draft: draft([pac, toast], 'R9926'),
    booked: { id: 'chk-1790609128634-5cc0f8', ref: 'R9926', source: 'pos_send_to_terminal', refunded: false, status: 'paid' },
  };
  const r9927 = {
    job_id: '4877eae7-fac1-4c3a-bacc-8b47d809d38e', check_key: `${LEEDS}:walkin:-:chk-1790609147396-a5dcd3`, location_id: LEEDS,
    pos_device_id: LEEDS_TILL, target_terminal_id: LEEDS_READER, due_minor: 1255,
    check_draft: draft([pac, toast, water, water], 'R9927'),
  };
  const hit = findPossibleRepeat(r9927, [r9926], Date.parse('2026-09-28T15:26:25.538Z'));
  assert.ok(hit);
  assert.equal(hit.tier, 'unfinished');
  assert.equal(hit.same_items, false);
  assert.equal(hit.subset_items, true);
  assert.equal(hit.same_amount, false, '£9.35 then £12.55: the amount is not what matters here');
  assert.equal(repeatMessage(hit, { tz: TZ }),
    '£10.28 was already paid on this card machine at 16:25 (Visa ••2844), R9926, 3 of these items. Do not charge again.');
  // Two waters as one line of qty 2 is the same basket as two lines of qty 1.
  assert.equal(itemSignature([pac, toast, water, water]), itemSignature([pac, toast, { ...water, qty: 2 }]));
  // The reverse (the SMALLER basket after the bigger one was paid) is not a subset.
  assert.equal(isSubsetBasket([pac, toast, water, water], [pac, toast]), false);
});

test('Huddersfield 16:38: b06007e2 approved and booked in the background, 462ab409 sent 0.6 s later: unfinished', () => {
  const items = [{ name: 'Voss Still', qty: 1, price: 2.5, mods: [] }, { name: 'Cappuccino — Big Boy', qty: 1, price: 4, mods: [] }];
  const b06 = {
    id: 'b06007e2-a111-4e3b-9748-f768ff169cdc', status: 'approved', check_key: `${HUD}:walkin:-:chk-1790782664379-7b4b89`,
    closed_check_id: 'chk-1790782664379-7b4b89', pos_device_id: HUD_TILL, target_terminal_id: HUD_READER, location_id: HUD,
    due_minor: 650, charge_minor: 650, created_at: '2026-09-30T15:37:46.687Z', dispatched_at: '2026-09-30T15:37:47.775Z',
    settled_at: '2026-09-30T15:38:10.205Z', card: { brand: 'visa', last4: '9443' }, check_draft: draft(items, 'R6282'),
    booked: null,   // 0.6 s after approval the reconciler has not booked it yet
  };
  const req462 = {
    job_id: '462ab409-6556-4b11-b179-99504f9c7413', check_key: `${HUD}:walkin:-:chk-1790782688455-5168a2`, location_id: HUD,
    pos_device_id: HUD_TILL, target_terminal_id: HUD_READER, due_minor: 650, check_draft: draft(items, 'R6283'),
  };
  const hit = findPossibleRepeat(req462, [b06], Date.parse('2026-09-30T15:38:10.793Z'));
  assert.equal(hit?.tier, 'unfinished');
  assert.equal(hit.job.booked, 'none');
  assert.equal(hit.job.ref, 'R6282', 'the ref comes from the draft when nothing is booked yet');
  assert.equal(repeatMessage(hit, { tz: TZ }),
    '£6.50 was already paid on this card machine at 16:38 (Visa ••9443), R6282, same items. Do not charge again.');
});

test('the same basket 4 min after a sale the checkout finished itself is the same_basket ADVISORY, never a refusal; 6 min is nothing', () => {
  const finished = { ...job97c, booked: { ...job97c.booked, source: null } };   // R9927 style: source null = the checkout booked it
  const at = Date.parse(job97c.settled_at);
  const hit = findPossibleRepeat(reqBcd, [finished], at + 4 * 60_000);
  assert.equal(hit?.tier, 'same_basket');
  assert.equal(repeatMessage(hit, { tz: TZ }),
    '£11.65 for the same items was paid on this card machine at 12:43 (Visa ••9810), R5737. If this is the same customer, press Cancel payment.');
  // Review 30 Sep: 12 of 13 live same_basket hits were another customer (Leeds 10:44, three flat
  // whites 13 s apart in a queue), and MPOS or a stale till cannot answer a 409. So: the job goes
  // ahead and the warning rides on the 200 body for the card screen.
  assert.equal(repeatRefusal(hit, null, { tz: TZ }), null, 'same_basket never refuses');
  assert.equal(repeatRefusal(hit, 'some-other-job', { tz: TZ }), null);
  const warn = repeatWarning(hit, { tz: TZ });
  assert.equal(warn.tier, 'same_basket');
  assert.equal(warn.ref, 'R5737');
  assert.equal(warn.job_id, job97c.id);
  assert.equal(warn.same_items, true);
  assert.match(warn.message, /press Cancel payment\.$/);
  assert.equal(repeatWarning(findPossibleRepeat(reqBcd, [job97c], T_BCD), { tz: TZ }), null, 'unfinished is a refusal, not an advisory');
  assert.equal(repeatWarning(null), null);
  assert.equal(findPossibleRepeat(reqBcd, [finished], at + SAME_BASKET_WINDOW_MS + 60_000), null);
  // A finished sale with an extra item added is a normal second order, not a warning.
  const bigger = { ...reqBcd, due_minor: 1390, check_draft: draft([...HUD_ITEMS, { name: 'Voss Still', qty: 1, price: 2.25, mods: [] }], 'R5738') };
  assert.equal(findPossibleRepeat(bigger, [finished], at + 60_000), null);
  // The finished sale with source 'pos' counts as a checkout booking too.
  assert.equal(bookedState({ source: 'pos' }), 'checkout');
  assert.equal(bookedState(null), 'none');
});

test('a live job on the same reader is TERMINAL_BUSY with the detail, adoptable only from the same till, never overridable', () => {
  const live = { ...job97c, status: 'charging', settled_at: null, card: null, booked: null };
  const hit = findPossibleRepeat(reqBcd, [live], Date.parse('2026-09-30T11:43:14.300Z'));
  assert.equal(hit.tier, 'live');
  assert.equal(hit.adoptable, true);
  assert.equal(repeatMessage(hit, { tz: TZ }),
    'The card machine is still taking £11.65 for the order sent at 12:42 (R5737). If it is this customer, do not send it again.');
  const refusal = repeatRefusal(hit, live.id, { tz: TZ });
  assert.equal(refusal.code, 'TERMINAL_BUSY', 'repeat_ok_job_id does not release a live tender');
  assert.equal(refusal.detail.adoptable, true);
  assert.equal(refusal.detail.closed_check_id, 'chk-1790768566981-528328');
  assert.equal(refusal.detail.order_ref, 'R5737');
  // Another till asking for the same reader: busy, but not adoptable (its checkout cannot book this draft).
  const other = findPossibleRepeat({ ...reqBcd, pos_device_id: 'till-2' }, [live], Date.parse('2026-09-30T11:43:14.300Z'));
  assert.equal(other.tier, 'live');
  assert.equal(other.adoptable, false);
  // A table label reads as the table.
  const table = { ...live, check_draft: draft(HUD_ITEMS, 'R5737', { tableId: 'T3', tableLabel: 'T3' }) };
  assert.match(repeatMessage(findPossibleRepeat(reqBcd, [table], T_BCD), { tz: TZ }), /taking £11\.65 for T3 sent at 12:42/);
  for (const s of LIVE_STATUSES) assert.equal(findPossibleRepeat(reqBcd, [{ ...live, status: s }], T_BCD).tier, 'live');
  assert.equal(findPossibleRepeat(reqBcd, [{ ...live, status: 'pending' }], T_BCD), null, 'a PAX job nobody has claimed is not on a reader yet');
});

test('live beats unfinished beats same_basket; among equals the newest wins', () => {
  const at = Date.parse(job97c.settled_at) + 60_000;
  const live = { ...job97c, id: 'live-1', check_key: 'k-live', status: 'charging', booked: null };
  const older = { ...job97c, id: 'old-1', check_key: 'k-old', created_at: '2026-09-30T11:40:00Z', settled_at: '2026-09-30T11:40:30Z' };
  assert.equal(findPossibleRepeat(reqBcd, [older, job97c, live], at).job.job_id, 'live-1');
  assert.equal(findPossibleRepeat(reqBcd, [older, job97c], at).job.job_id, job97c.id);
  assert.equal(findPossibleRepeat(reqBcd, [job97c, older], at).job.job_id, job97c.id, 'order of the rows does not matter');
});

test('repeat_ok_job_id is honoured for THAT job only, and the confirmation is recorded on the draft', () => {
  const hit = findPossibleRepeat(reqBcd, [job97c], T_BCD);
  assert.equal(repeatRefusal(hit, job97c.id, { tz: TZ }), null, 'staff confirmed this exact payment: let the job through');
  assert.equal(repeatRefusal(hit, 'some-other-job', { tz: TZ })?.code, 'POSSIBLE_REPEAT', 'a stale ack for another job is not an ack');
  assert.equal(repeatRefusal(hit, undefined, { tz: TZ })?.code, 'POSSIBLE_REPEAT');
  assert.equal(repeatRefusal(hit, null, { tz: TZ })?.code, 'POSSIBLE_REPEAT');
  const ack = repeatAckRecord(hit, { staffId: 'staff-1', now: T_BCD });
  assert.deepEqual(ack, { jobId: job97c.id, tier: 'unfinished', ref: 'R5737', staffId: 'staff-1', at: '2026-09-30T11:43:43.303Z' });
  assert.equal(repeatRefusal(null, job97c.id), null);
});

test('only the till checkout is checked as a sender (MPOS shows a 409 as a dead error, review 30 Sep); MPOS priors still count', () => {
  assert.deepEqual([...REPEAT_CHECKED_SOURCES], ['pos_send_to_terminal']);
  assert.deepEqual([...REPEAT_PRIOR_SOURCES], ['pos_send_to_terminal', 'mpos_cloud_terminal']);
  assert.equal(shouldCheckRepeat({ source: 'pos_send_to_terminal' }), true);
  for (const s of ['mpos_cloud_terminal', 'pos_split_leg', 'adyen_pay_at_table', 'kiosk', 'mpos_adyen_local', undefined, null]) {
    assert.equal(shouldCheckRepeat({ source: s }), false, String(s));
  }
  assert.equal(shouldCheckRepeat(null), false);
  // An MPOS prior on the shared reader, booked in the background, still stops a till re-ring.
  const mposPrior = { ...job97c, pos_device_id: 'mpos-1', check_draft: draft(HUD_ITEMS, 'R5737', { source: 'mpos_cloud_terminal' }) };
  assert.equal(findPossibleRepeat(reqBcd, [mposPrior], T_BCD)?.tier, 'unfinished');
});

test('split legs, kiosk, pay at table and partial legs never count as a prior (review 30 Sep: two £10.00 split legs blocked the next £10.00 customer)', () => {
  // SplitModal's draft: { source, portionLabel, totalMinor }, no items, closed_check_id chk-split-<leg>
  // that never becomes a closed_checks row (the whole bill books under getCheckId()).
  const legAt = Date.parse('2026-09-30T11:00:00Z');
  const leg = (n) => ({
    ...job97c, id: `leg-${n}`, check_key: `${HUD}:split:leg-${n}`, closed_check_id: `chk-split-leg-${n}`, status: 'approved',
    due_minor: 1000, charge_minor: 1000, booked: null,
    created_at: new Date(legAt - 20_000).toISOString(), dispatched_at: new Date(legAt - 19_000).toISOString(), settled_at: new Date(legAt + n * 30_000).toISOString(),
    check_draft: { source: 'pos_split_leg', portionLabel: `Portion ${n} of 2`, totalMinor: 1000 },
  });
  const tenner = { ...reqBcd, due_minor: 1000, check_draft: draft([{ name: 'Sandwich', qty: 1, price: 10 }], 'R6001') };
  assert.equal(findPossibleRepeat(tenner, [leg(1), leg(2)], legAt + 6 * 60_000), null, 'two split legs of £10.00 then a £10.00 counter sale 6 min later');
  // A kiosk job that shares the reader, items and all: not a till sale to repeat.
  const kiosk = { ...job97c, pos_device_id: null, check_draft: draft(HUD_ITEMS, 'K12', { source: 'kiosk' }), booked: null };
  assert.equal(findPossibleRepeat(reqBcd, [kiosk], T_BCD), null, 'kiosk prior');
  // Pay at table on the reader.
  const patt = { ...job97c, pos_device_id: null, check_draft: draft(HUD_ITEMS, 'R5737', { source: 'adyen_pay_at_table' }), booked: null };
  assert.equal(findPossibleRepeat(reqBcd, [patt], T_BCD), null, 'pay at table prior');
  // A partial leg from a till (one card of several on one bill) is never a whole sale.
  const partial = { ...job97c, check_draft: draft(HUD_ITEMS, 'R5737', { partial: true }) };
  assert.equal(findPossibleRepeat(reqBcd, [partial], T_BCD), null, 'partial leg');
  // The live tier is unchanged: a split leg still on the reader is TERMINAL_BUSY (the index says so too).
  assert.equal(findPossibleRepeat(tenner, [{ ...leg(1), status: 'charging', settled_at: null, pos_device_id: 'till-2', target_terminal_id: 'reader-2' }], legAt), null, 'a split leg from another till on another reader: not ours');
  assert.equal(findPossibleRepeat(tenner, [{ ...leg(1), status: 'charging', settled_at: null }], legAt)?.tier, 'live', 'a split leg still on OUR reader is busy');
});

test('old draft shapes with no items fall back to the amount for the unfinished tier (a checked source only)', () => {
  const noItemsPrior = { ...job97c, check_draft: draft([], 'R5737') };
  assert.equal(findPossibleRepeat(reqBcd, [noItemsPrior], T_BCD)?.tier, 'unfinished', 'same amount, prior has no items');
  assert.equal(findPossibleRepeat({ ...reqBcd, due_minor: 1200 }, [noItemsPrior], T_BCD), null, 'different amount, nothing to compare');
  // With items on both sides the amount alone is not enough (Leeds rule).
  assert.equal(findPossibleRepeat({ ...reqBcd, check_draft: draft([{ name: 'Flat White', qty: 1, price: 11.65 }], 'R5738') }, [job97c], T_BCD), null);
});

test('formatting: money by currency, venue wall clock, card brand names, item summary caps at 4', () => {
  assert.equal(fmtMoney(1165, 'GBP'), '£11.65');
  assert.equal(fmtMoney(470, 'USD'), '$4.70');
  assert.equal(fmtMoney(470, 'XYZ'), '4.70 XYZ');
  assert.equal(fmtTime('2026-09-30T11:43:29.541Z', 'Europe/London'), '12:43');
  assert.equal(fmtTime('2026-09-30T11:43:29.541Z', 'America/Los_Angeles'), '04:43');
  assert.equal(fmtTime('2026-09-30T11:43:29.541Z', 'Not/AZone'), '12:43', 'a bad zone falls back to London');
  assert.equal(fmtTime(null, TZ), '');
  assert.equal(fmtCard({ brand: 'visa', last4: '9810' }), 'Visa ••9810');
  assert.equal(fmtCard({ brand: 'mc', last4: '1300' }), 'Mastercard ••1300');
  assert.equal(fmtCard(null), '');
  const many = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => ({ name: n, qty: 1, price: 1 }));
  assert.equal(itemSummary(many), '1x A, 1x B, 1x C, 1x D and 2 more');
  assert.equal(itemSummary([]), '');
  const d = repeatDetail(job97c, job97c.booked, { now: T_BCD });
  assert.equal(d.age_ms, T_BCD - Date.parse(job97c.settled_at));
  assert.equal(d.item_count, 3);
  assert.equal(d.amount_minor, 1165);
  // No em or en dashes as punctuation in the staff copy (product names are the venue's own words).
  for (const t of ['live', 'unfinished', 'same_basket']) {
    const msg = repeatMessage({ tier: t, same_items: true, job: { ...d, items: 'x', table_label: null } }, { tz: TZ });
    assert.ok(!/[–—]/.test(msg), msg);
  }
});

test('after the fact: the same card, the same amount, another check inside 15 min is found; a refund, another card or another amount is not', () => {
  const second = {
    id: '7da9f45c-0e0a-4ad3-9b50-1889e82eb135', status: 'approved', location_id: HUD, closed_check_id: 'chk-1790768747349-c91eec',
    due_minor: 1165, charge_minor: 1165, currency: 'GBP', card: VISA_9810, settled_at: '2026-09-30T11:47:08.126Z',
    check_draft: draft(HUD_ITEMS, 'R5739'),
  };
  const prior = findSameCardRepeat(second, [job97c], Date.parse(second.settled_at));
  assert.equal(prior?.job_id, job97c.id);
  assert.equal(prior.ref, 'R5737');
  const alert = sameCardAlert(second, prior, { tz: TZ });
  assert.equal(alert.title, 'Possible double charge: £11.65 twice on Visa ••9810');
  assert.equal(alert.body, 'Visa ••9810 paid £11.65 for R5737 at 12:43 and again for R5739 at 12:47. If it is one customer, refund one of them in History.');
  assert.ok(!/[–—]/.test(alert.title + alert.body));
  // Not the same check (a re-read of its own row), not another card, not another amount, not refunded, not 16 min ago.
  assert.equal(findSameCardRepeat(second, [{ ...job97c, closed_check_id: second.closed_check_id }]), null);
  assert.equal(findSameCardRepeat(second, [{ ...job97c, card: { brand: 'visa', last4: '9443' } }]), null);
  assert.equal(findSameCardRepeat(second, [{ ...job97c, charge_minor: 1200 }]), null);
  assert.equal(findSameCardRepeat(second, [{ ...job97c, booked: { ...job97c.booked, refunded: true } }]), null);
  const late = { ...job97c, settled_at: new Date(Date.parse(second.settled_at) - SAME_CARD_WINDOW_MS - 60_000).toISOString() };
  assert.equal(findSameCardRepeat(second, [late], Date.parse(second.settled_at)), null);
  assert.equal(findSameCardRepeat({ ...second, card: null }, [job97c]), null, 'no card block, nothing to match on');
  assert.equal(cardKeyOf({ brand: 'Visa', last4: '9810' }), 'visa|9810');
  assert.equal(cardKeyOf({ brand: 'visa' }), null);
  assert.deepEqual([...CHARGED_STATUSES], ['approved', 'reconciled']);
});
