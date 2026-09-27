// Every reader sale refund finds its card leg (28 Sep 2026, Leeds R6404).
//
// 27 Sep, Coffee Boy Leeds: a 9.90 Adyen reader sale (send to terminal) was booked by a
// kitchen screen's terminal job reconciler while POS 1 reloaded for a release. POS 1 knew
// the check only from the realtime INSERT, whose hand built copy had no card reference, no
// processor and no tenders. Staff refunded 3.80 (Americano) and the till said "issue the
// card refund manually (no linked card payment found)". No REFUND ever reached Adyen.
// The day before, R1964 was booked by POS 1's own reconciler (full record) and refunded
// to the card fine. These tests lock the three layers of the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cardLegsOf, allocateToLegs, legRefundedMinor } from './refundMath.js';
import { resolveRefundCardLegs, checkSaysCard } from './refundCardLegs.js';
import { closedCheckRefundFields } from '../closedCheckRefundFields.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PSP = 'dDxw001790514710084.Z4P33VXKF8DJ4LX3';

// The closed_checks row as it is in the Ops DB (payment columns and what the copy kept).
const leedsRow = () => ({
  id: 'chk-1790514704775-51d46e', ref: 'R6404', location_id: '1e252e7c-c875-4971-b91d-1e945c26956b',
  source: 'pos_send_to_terminal', processor: 'adyen', method: 'card', payment_method: null,
  total: '9.90', subtotal: '9.90', tip: '0', status: 'paid', order_type: 'dine-in',
  stripe_payment_intent_id: PSP, payment_intents: null, gift_card: null, loyalty: null,
  tenders: [{ tip: 0, amount: 9.9, method: 'card', psp_ref: PSP, processor: 'adyen' }],
  refunds: [], items: [{ uid: 'i36', name: 'Americano — Big Boy', price: 3.8, qty: 1 }],
});

// What realtime.js built from that row before this release: no card fields at all.
const oldRealtimeCopy = (row) => ({
  id: row.id, ref: row.ref, orderType: row.order_type, items: row.items, discounts: [],
  subtotal: row.subtotal, tip: row.tip, total: row.total, method: row.method,
  status: row.status, refunds: row.refunds || [],
});

// ── The shared row map ──────────────────────────────────────────────────────

test('the row map carries the card reference, processor and tenders', () => {
  const f = closedCheckRefundFields(leedsRow());
  assert.equal(f.stripePaymentIntentId, PSP);
  assert.equal(f.processor, 'adyen');
  assert.equal(f.paymentIntents, null);
  assert.equal(f.tenders[0].psp_ref, PSP);
  assert.equal(f.source, 'pos_send_to_terminal');
});

test('the row map keeps the defaults the boot loaders always used', () => {
  assert.deepEqual(closedCheckRefundFields({}), {
    giftCard: null, stripePaymentIntentId: null, paymentIntents: null,
    processor: 'stripe', loyalty: null, source: 'pos', tenders: null,
  });
  assert.equal(closedCheckRefundFields({ tenders: 'junk' }).tenders, null);
});

test('R6404 through the new realtime copy refunds 3.80 to the Adyen card', () => {
  const row = leedsRow();
  const copy = { ...oldRealtimeCopy(row), ...closedCheckRefundFields(row) };
  const legs = cardLegsOf(copy);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].id, PSP);
  assert.equal(legs[0].processor, 'adyen');
  assert.equal(legs[0].amountMinor, 990);
  const { allocations } = allocateToLegs(legs, 380, null, legRefundedMinor(copy));
  assert.deepEqual(allocations.map((a) => [a.id, a.refundMinor, a.processor]), [[PSP, 380, 'adyen']]);
});

// ── cardLegsOf fallbacks ────────────────────────────────────────────────────

test('the old realtime copy had no card leg (the bug)', () => {
  assert.deepEqual(cardLegsOf(oldRealtimeCopy(leedsRow())), []);
});

test('tenders psp_ref is a card leg when it is the only record, with the tender processor', () => {
  const copy = { ...oldRealtimeCopy(leedsRow()), tenders: leedsRow().tenders };
  const legs = cardLegsOf(copy);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].id, PSP);
  assert.equal(legs[0].processor, 'adyen');   // never the 'stripe' default
  assert.equal(legs[0].amountMinor, 990);
});

test('a tender leg is amount plus tip (what the reader charged)', () => {
  const legs = cardLegsOf({ total: 12, tenders: [{ method: 'card', amount: 10, tip: 2, psp_ref: 'P1', processor: 'adyen' }] });
  assert.equal(legs[0].amountMinor, 1200);
});

test('a reader split books one leg per card tender, gift and cash tenders never', () => {
  const legs = cardLegsOf({
    total: 30, processor: 'adyen',
    tenders: [
      { method: 'card', amount: 10, tip: 0, psp_ref: 'A', processor: 'adyen' },
      { method: 'card', amount: 12, tip: 1, psp_ref: 'B', processor: 'adyen' },
      { method: 'gift_card', amount: 5, tip: 0, gift_card_id: 'g1' },
      { method: 'cash', amount: 2, tip: 0 },
      { method: 'card', amount: 3, tip: 0 },   // no psp_ref: nothing to refund by
    ],
  });
  assert.deepEqual(legs.map((l) => [l.id, l.amountMinor]), [['A', 1000], ['B', 1300]]);
});

test('snake_case columns on a raw row copy (MasterSync) are read too', () => {
  const single = cardLegsOf({ total: 9.9, processor: 'adyen', stripe_payment_intent_id: PSP });
  assert.deepEqual(single.map((l) => [l.id, l.amountMinor, l.processor]), [[PSP, 990, 'adyen']]);
  const split = cardLegsOf({ total: 20, processor: 'adyen', payment_intents: [{ id: 'L1', amountMinor: 1200 }, { id: 'L2', amountMinor: 800 }] });
  assert.deepEqual(split.map((l) => l.id), ['L1', 'L2']);
});

test('a check with no processor takes its card tender processor for the single id leg', () => {
  const legs = cardLegsOf({ total: 9.9, stripePaymentIntentId: PSP, tenders: leedsRow().tenders });
  assert.equal(legs[0].processor, 'adyen');
});

test('existing precedence is unchanged: legs list, then the single id, then tenders', () => {
  const tenders = [{ method: 'card', amount: 9.9, tip: 0, psp_ref: 'TENDER', processor: 'adyen' }];
  const withList = cardLegsOf({ total: 9.9, processor: 'adyen', paymentIntents: [{ id: 'LIST', amountMinor: 990 }], stripePaymentIntentId: 'ID', tenders });
  assert.deepEqual(withList.map((l) => l.id), ['LIST']);
  const withId = cardLegsOf({ total: 9.9, processor: 'adyen', stripePaymentIntentId: 'ID', tenders });
  assert.deepEqual(withId.map((l) => [l.id, l.amountMinor]), [['ID', 990]]);
  // A legs list whose only entries have no id (booking credit) still has no card leg.
  assert.deepEqual(cardLegsOf({ total: 5, paymentIntents: [{ id: null, amountMinor: 500, method: 'booking_prepaid' }], tenders }), []);
  // The check's own processor still wins over a tender for the single id leg.
  assert.equal(cardLegsOf({ total: 1, processor: 'ryft', stripePaymentIntentId: 'ps_1', tenders: [{ method: 'card', amount: 1, psp_ref: 'ps_1', processor: 'adyen' }] })[0].processor, 'ryft');
});

test('a cash sale has no card leg', () => {
  assert.deepEqual(cardLegsOf({ total: 4.1, method: 'cash', processor: 'stripe', tenders: [{ method: 'cash', amount: 4.1, tip: 0 }] }), []);
});

// ── resolveRefundCardLegs: the row is the record when the copy is short ──────

test('a copy with a card leg never reads the database', async () => {
  let reads = 0;
  const copy = { ...oldRealtimeCopy(leedsRow()), ...closedCheckRefundFields(leedsRow()) };
  const r = await resolveRefundCardLegs(copy, { readRow: async () => { reads += 1; return leedsRow(); } });
  assert.equal(r.from, 'memory');
  assert.equal(r.legs.length, 1);
  assert.equal(reads, 0);
});

test('a card check with no leg in memory takes the leg from its row (R6404)', async () => {
  const r = await resolveRefundCardLegs(oldRealtimeCopy(leedsRow()), { readRow: async () => leedsRow() });
  assert.equal(r.from, 'database');
  assert.equal(r.lookupFailed, false);
  assert.deepEqual(r.legs.map((l) => [l.id, l.processor, l.amountMinor]), [[PSP, 'adyen', 990]]);
});

test('a row with only tenders still gives the leg', async () => {
  const row = { ...leedsRow(), stripe_payment_intent_id: null };
  const r = await resolveRefundCardLegs(oldRealtimeCopy(leedsRow()), { readRow: async () => row });
  assert.deepEqual(r.legs.map((l) => [l.id, l.processor]), [[PSP, 'adyen']]);
});

test('a failed read is reported, never treated as "no card"', async () => {
  const r = await resolveRefundCardLegs(oldRealtimeCopy(leedsRow()), { readRow: async () => { throw new Error('Card payment lookup timed out after 5000 ms'); } });
  assert.equal(r.lookupFailed, true);
  assert.deepEqual(r.legs, []);
  assert.match(r.error, /timed out/);
});

test('no row, or a row with no card, is "no card" (the old manual message), not a failure', async () => {
  const none = await resolveRefundCardLegs(oldRealtimeCopy(leedsRow()), { readRow: async () => null });
  assert.deepEqual([none.from, none.lookupFailed, none.legs.length], ['none', false, 0]);
  const legacy = await resolveRefundCardLegs(oldRealtimeCopy(leedsRow()), { readRow: async () => ({ processor: 'stripe', stripe_payment_intent_id: null, payment_intents: null, tenders: null }) });
  assert.deepEqual([legacy.from, legacy.lookupFailed, legacy.legs.length], ['none', false, 0]);
});

test('a cash payout, a cash sale and training never read the row', async () => {
  let reads = 0;
  const readRow = async () => { reads += 1; return leedsRow(); };
  await resolveRefundCardLegs(oldRealtimeCopy(leedsRow()), { cashPayout: true, readRow });
  await resolveRefundCardLegs({ total: 4.1, method: 'cash' }, { readRow });
  await resolveRefundCardLegs(oldRealtimeCopy(leedsRow()), { readRow: null });   // training passes no reader
  assert.equal(reads, 0);
});

test('checkSaysCard: a card or split PART of the method, or a card tender; never gift card alone', () => {
  assert.equal(checkSaysCard({ method: 'card' }), true);
  assert.equal(checkSaysCard({ method: 'split' }), true);
  assert.equal(checkSaysCard({ method: 'loyalty+gift_card+card' }), true);
  assert.equal(checkSaysCard({ method: 'promo+split' }), true);
  assert.equal(checkSaysCard({ method: 'cash' }), false);
  assert.equal(checkSaysCard({ method: 'gift_card' }), false);
  assert.equal(checkSaysCard({ method: 'loyalty+gift_card' }), false);
  assert.equal(checkSaysCard({ method: 'booking_prepaid' }), false);
  assert.equal(checkSaysCard({ method: 'cash', tenders: [{ method: 'card', amount: 1 }] }), true);
});

test('a gift card only sale never reads the row (never waits, never refused offline)', async () => {
  let reads = 0;
  const r = await resolveRefundCardLegs({ total: 10, method: 'gift_card', giftCard: { card_id: 'g1' } }, { readRow: async () => { reads += 1; throw new Error('offline'); } });
  assert.deepEqual([r.from, r.lookupFailed, reads], ['none', false, 0]);
});

// ── Wiring: every row to copy path uses the one map; the refund resolves first ─

test('realtime INSERT and UPDATE copies, MasterSync and both boot loaders use closedCheckRefundFields', () => {
  const realtime = read('../realtime.js');
  const checks = realtime.slice(realtime.indexOf('Closed checks — live sync'), realtime.indexOf('Walk-in / takeaway / delivery orders'));
  assert.equal((checks.match(/\.\.\.closedCheckRefundFields\(check\)/g) || []).length, 2, 'INSERT and UPDATE append');
  assert.ok(read('../../sync/MasterSync.js').includes('...closedCheckRefundFields(c)'));
  const db = read('../db.js');
  assert.equal((db.match(/\.\.\.closedCheckRefundFields\(c\)/g) || []).length, 2, 'fetchClosedChecks and fetchClosedChecksRange');
  assert.ok(!db.includes("stripePaymentIntentId: c.stripe_payment_intent_id"), 'no hand copy left in db.js');
});

test('the row read is venue filtered, time boxed, and treats a missing row as a failed read', () => {
  const db = read('../db.js');
  const fn = db.slice(db.indexOf('export const fetchClosedCheckCardRow'), db.indexOf('export const POS_HISTORY_DAYS'));
  assert.ok(fn.includes(".eq('location_id', locationId)"), 'filtered by the venue');
  assert.ok(fn.includes("withTimeout(") && fn.includes('5000'), 'never hangs the refund screen');
  assert.ok(fn.includes('if (error) throw'), 'a read error throws');
  assert.ok(fn.includes('if (!data) throw'), 'an invisible row throws: refuse, never "manual"');
  assert.ok(fn.indexOf('if (isMock') < fn.indexOf('withTimeout('), 'mock mode never reads');
});

test('refundCheck finds the card before it records the refund, and refuses on a failed lookup', () => {
  const store = read('../../store/index.js');
  const body = store.slice(store.indexOf('refundCheck: async'), store.indexOf('retryRefundReversal: async'));
  const lookup = body.indexOf('resolveRefundCardLegs(chkFound');
  const reread = body.indexOf('const chkBefore = get().closedChecks.find(c => c.id === checkId);');
  assert.ok(lookup > 0, 'the lookup runs');
  assert.ok(reread > lookup, 'the check is read again after the lookup waited');
  assert.ok(reread < body.indexOf('const bd = refundBreakdown(chkBefore'), 'so the money is worked out from what is left now');
  assert.ok(lookup < body.indexOf('const refundId'), 'before a refund entry exists');
  assert.ok(body.includes('readRow: isTrainingMode() ? null'), 'training never reads');
  assert.ok(body.includes('if (legLookup.lookupFailed)'), 'a failed read refuses');
  assert.ok(body.indexOf('if (!chkBefore) {', reread) > reread && body.indexOf('if (!chkBefore) {', reread) < body.indexOf('const bd = refundBreakdown(chkBefore'), 'a check gone during the wait stops the refund');
  assert.ok(body.includes('const legs = legLookup.legs;'), 'the reversal uses the resolved legs');
  assert.ok(!body.includes('cardLegsOf(check)'), 'no second, copy only lookup');
});

test('both refund screens show the legs the store will refund (never "no card" while it refunds)', () => {
  for (const [rel, name] of [['../../components/CheckHistory.jsx', 'POS History'], ['../../backoffice/sections/Transactions.jsx', 'Back Office']]) {
    const src = read(rel);
    assert.ok(src.includes('useRefundCardLegs('), `${name} uses the shared hook`);
    assert.ok(!src.includes('cardLegsOf('), `${name} has no copy only leg list left`);
    const box = src.indexOf('No card payment is linked');
    assert.ok(box > 0, `${name} still explains a check with no card`);
    const gate = src.lastIndexOf('legs', box);
    assert.ok(/!legsChecking\s*&&\s*!legsFailed\s*&&\s*legs\.length\s*===\s*0/.test(src.slice(gate - 60, box)), `${name} shows it only once the row read found no card`);
    assert.ok(/disabled=\{[^}]*legsChecking/.test(src), `${name} cannot refund while the card is being checked`);
  }
  const hook = read('./useRefundCardLegs.js');
  assert.ok(hook.includes('resolveRefundCardLegs(check') && hook.includes('fetchClosedCheckCardRow(checkId)'), 'the hook makes the store\'s own lookup');
  assert.ok(hook.includes('!isTrainingMode()'), 'training never reads, like the store');
  assert.ok(read('../../components/CheckHistory.jsx').includes("if(step==='card_terminal'&&isSplitCard)setStep('legs')"), 'a split found late still goes through the picker');
});
