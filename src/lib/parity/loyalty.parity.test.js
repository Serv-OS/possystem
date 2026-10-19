// loyalty.parity.test.js: rewards, promo codes and stamps follow the till's rules on every channel (v5.11.78).
// Run: node --test src/lib/parity/loyalty.parity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepo, between } from './src.js';

// ── A bar tab commits the promo code it gave (confirmed major) ───────────────────────────────────
test('bar tab: the checkout\'s promo code (and any staged reward) is committed against the check, as at the counter', () => {
  const store = readRepo('src/store/index.js');
  const fn = between(store, 'recordWalkInClosedCheck: (record, paymentInfo = {}) => {', 'recordWalkInClosed: (walkInOrder');
  assert.ok(fn, 'recordWalkInClosedCheck takes the checkout\'s paymentInfo');
  assert.match(fn, /if \(pay\.promoRedemption\) get\(\)\.redeemPromoCode\?\.\(pay\.promoRedemption, fullRecord, fullRecord\.customer\);/);
  assert.match(fn, /if \(pay\.loyaltyRedemption\?\.pending_commit\) get\(\)\.redeemLoyaltyAtCommit\?\.\(pay\.loyaltyRedemption, fullRecord, fullRecord\.customer\);/);
  assert.match(fn, /discounts: \[\.\.\.\(record\.discounts \|\| \[\]\), \.\.\.promoDiscountEntry\(pay\.promoRedemption\)\]/, 'the promo line, as the counter books it');
  assert.match(readRepo('src/surfaces/BarSurface.jsx'), /\}, payInfo \|\| \{\}\);\n\s+closeTab\(tab\.id\);/);
});

// ── A reader sale another till books keeps the reward and the code (confirmed major) ─────────────
test('reader close: a check another till books carries the reward and promo tenders and commits them once', async () => {
  const { closerCreditsMinor, closerGrandMinor, closerCardIntents } = await import('../payments/terminalJobCloser.js');
  assert.equal(typeof closerCreditsMinor, 'function');
  // 8.20 of goods, a 3.60 stamp reward, 4.60 on the card (the live 1 Oct case).
  const credits = closerCreditsMinor({ loyaltyRedemption: { discount_value: 360, pending_commit: true }, promoRedemption: null });
  assert.deepEqual(credits, { loyaltyMinor: 360, promoMinor: 0, creditMinor: 360 });
  assert.equal(closerGrandMinor({ chargeMinor: 460, creditMinor: credits.creditMinor }), 820, 'booked gross, as the till books it');
  assert.deepEqual(closerCardIntents({ transactionId: 'psp1', chargeMinor: 460, creditMinor: 360 }), [{ id: 'psp1', amountMinor: 460 }], 'the card leg names only what the card took');
  const co = readRepo('src/surfaces/CheckoutModal.jsx');
  assert.match(co, /loyaltyRedemption: loyaltyApplied \|\| null,\n\s+promoRedemption: promoApplied \|\| null,/);
  const store = readRepo('src/store/index.js');
  const close = between(store, 'closeApprovedTerminalJob: async (job) => {', '_reverseTerminalJobGift: async (');
  assert.match(close, /tender\('loyalty', credits\.loyaltyMinor \/ 100, 0, \{ rewards: rewardsRecord\(d\.loyaltyRedemption\) \}\),\n\s+tender\('promo', credits\.promoMinor \/ 100\),/);
  assert.match(close, /if \(d\.promoRedemption\) get\(\)\.redeemPromoCode\?\.\(d\.promoRedemption, record, null\);/);
  assert.match(close, /if \(d\.loyaltyRedemption\?\.pending_commit\) get\(\)\.redeemLoyaltyAtCommit\?\.\(d\.loyaltyRedemption, record, null\);/);
});

// ── A customer page's guest earns like a till customer (confirmed majors: QR, online, catering) ───
test('order key earn: the till\'s rule (the phone on a paid order earns), proven by the order\'s own key', async () => {
  const { decideOrderProofEarn, usableOrderKey } = await import('../../../supabase/functions/_shared/earnFromCheck.ts');
  const check = { id: 'chk-1', ref: 'QR-ABCDE', source: 'qr', status: 'paid', customer: { phone: '07700 900123' } };
  const base = { channel: 'qr', orderKey: 'tok_0123456789abcdef', check, keyOk: true, customer: { orgId: 'o1', phone: '+447700900123' }, venueOrgId: 'o1' };
  assert.deepEqual(decideOrderProofEarn(base), { ok: true });
  assert.equal(decideOrderProofEarn({ ...base, orderKey: '0123' }).ok, false, 'a phone\'s last 4 never proves an order');
  assert.equal(usableOrderKey('0123'), false);
  assert.equal(decideOrderProofEarn({ ...base, keyOk: false }).ok, false, 'the key must prove THIS order');
  assert.equal(decideOrderProofEarn({ ...base, customer: { orgId: 'o1', phone: '+447700900999' } }).ok, false, 'only the phone on the check earns');
  assert.equal(decideOrderProofEarn({ ...base, customer: { orgId: 'o2', phone: '+447700900123' } }).ok, false, 'never another organisation\'s customer');
  assert.equal(decideOrderProofEarn({ ...base, check: { ...check, source: null } }).ok, false, 'a till check earns through the till');
  assert.equal(decideOrderProofEarn({ ...base, check: { ...check, status: 'refunded' } }).ok, false);
  assert.equal(decideOrderProofEarn({ ...base, channel: 'pos' }).ok, false);
  for (const ch of ['online', 'catering']) assert.deepEqual(decideOrderProofEarn({ ...base, channel: ch, check: { ...check, source: ch } }), { ok: true }, ch);
});

test('order key earn: loyalty-earn asks for it ONLY after its fence refused, and every page sends its key, check and channel', () => {
  const fn = readRepo('supabase/functions/loyalty-earn/index.ts');
  assert.match(fn, /if \(!fenceGate\.allow && \(body as any\)\.order_key\) \{/);
  assert.match(fn, /const gate = viaOrder \? \{ \.\.\.fenceGate, allow: true \} : fenceGate;\n\s+if \(!gate\.allow\) return gate\.response!;/);
  const lookup = readRepo('src/lib/customerLookup.js');
  assert.match(lookup, /channel: orderRecord\.channel \|\| 'online',/);
  assert.match(lookup, /\.\.\.\(orderKeyUsable\(orderKey\) \? \{ order_key: String\(orderKey\)\.trim\(\) \} : \{\}\),/);
  const qr = readRepo('src/surfaces/qr/QrCheckout.jsx');
  assert.match(qr, /orderRecord: \{ ref, checkId: closedCheckRow\?\.id \|\| null, total, items, type: 'dine-in', channel: 'qr' \},/);
  assert.match(qr, /memberToken: loyalty\?\.token \|\| null,/);
  const cat = readRepo('src/surfaces/catering/CateringCheckout.jsx');
  const now = between(cat, 'const finalizeNow = async (paymentIntent) => {', '// ── Confirmation');
  assert.match(now, /attributeOnlineOrder\(\{/);
  assert.match(now, /orderRecord: \{ ref, checkId, total: Math\.max\(0, subtotal - discount\), items: buildItems\(\), type: fulfilment, channel: 'catering' \},/);
  const later = between(cat, 'const placeLater = async () => {', 'const startPayNow = async () => {');
  assert.doesNotMatch(later, /attributeOnlineOrder/, 'a pay later order is attributed by the till when it is paid there (never twice)');
});

// ── A full refund puts stamps back as they were (confirmed major) ────────────────────────────────
test('refund: a full refund takes back the stamps the sale earned, never a reward already used', async () => {
  const { planStampClawback } = await import('../../../supabase/functions/_shared/stampAdjust.js');
  assert.equal(typeof planStampClawback, 'function');
  // 7 stamps + 5 earned on a 10 stamp card rolled to 1 completed card and 2 stamps.
  assert.deepEqual(planStampClawback({ stamps_collected: 2, completed_count: 1 }, 0, { stamps: 5, stampsRequired: 10 }), { stamps_collected: 7, completed_count: 0, clawed: 5 });
  // The completed card's reward was already used: only the 2 loose stamps come back.
  assert.deepEqual(planStampClawback({ stamps_collected: 2, completed_count: 1 }, 1, { stamps: 5, stampsRequired: 10 }), { stamps_collected: 0, completed_count: 1, clawed: 2 });
  const refund = readRepo('supabase/functions/loyalty-refund/index.ts');
  assert.match(refund, /let customer_id: string \| null = bodyCustomerId \? String\(bodyCustomerId\) : null;/);
  assert.match(refund, /idempotency_key: claimKey,/);
  assert.match(refund, /\.eq\('id', card\.id\)\.eq\('stamps_collected', card\.stamps_collected\)\.eq\('completed_count', card\.completed_count\)/, 'the card moves only from the state it was read in');
  const store = readRepo('src/store/index.js');
  assert.match(store, /const loyaltyToReverse = nextStatus === 'refunded' \|\| \(partLoyalty && \(partLoyalty\.share > 0 \|\| partLoyalty\.items\.length > 0\)\);/);
  assert.match(store, /if \(loyaltyToReverse && \(check\?\.customer\?\.phone \|\| check\?\.customer_id \|\| check\?\.loyalty \|\| check\?\.loyaltyRedemption\)\) \{/);
  assert.match(store, /\.\.\.\(customerId \? \{ customer_id: customerId \} : \{\}\),/);
  assert.doesNotMatch(store, /loyalty reversal skipped — no customer_id on check/);
});

// ── A part refund takes back what the refunded part earned (v5.11.81: the v5.11.78 regression) ───
test('part refund: points by the share of the goods refunded, stamps by the qualifying lines refunded, never the reward used; a later full refund takes only what is left', async () => {
  const P = await import('../../../supabase/functions/_shared/loyaltyPartRefund.js');
  const { partRefundLoyaltyBody, loyaltyEarnItems } = await import('../loyaltyEarnItems.js');
  // 5 coffees at 3.00 earned 15 points and 5 stamps; 1 coffee refunded.
  assert.equal(P.partRefundPoints({ earned: 15, alreadyTaken: 0, share: 0.2 }), 3);
  assert.equal(P.partRefundStamps({ earned: 5, alreadyTaken: 0, refundedQualifying: 1 }), 1);
  // A second part refund of 4 more coffees, then nothing is left for the full refund.
  assert.equal(P.partRefundPoints({ earned: 15, alreadyTaken: 3, share: 0.8 }), 12);
  assert.equal(P.remainingAfterParts({ earned: 15, alreadyTaken: 15 }), 0);
  assert.equal(P.partRefundStamps({ earned: 5, alreadyTaken: 4, refundedQualifying: 3 }), 1, 'never more than the check earned');
  assert.equal(P.partRefundPoints({ earned: 15, share: 'x' }), 0, 'a bad share takes nothing');
  assert.equal(P.partRefundKey('chk-1', 'ref-9'), 'refund:chk-1:ref-9');
  assert.equal(P.isPartRefundKey('refund:chk-1:ref-9', 'chk-1'), true);
  assert.equal(P.isPartRefundKey('refund:chk-1', 'chk-1'), false, 'the full refund row is not a part');
  assert.equal(P.isPartRefundKey('refund:chk-1x:ref-9', 'chk-1'), false);
  // The till's body: the share of the goods money returned and the lines at the quantity refunded.
  const body = partRefundLoyaltyBody({ refundId: 'ref-9', bd: { itemsAmount: 3 }, chargedGoods: 15, refundItems: [{ uid: 'a', itemId: 'flat', name: 'Flat white', cat: 'coffee', price: 3, qty: 5, refundQty: 1 }], menuItems: [] });
  assert.deepEqual({ part: body.part, refund_id: body.refund_id, share: body.share }, { part: true, refund_id: 'ref-9', share: 0.2 });
  assert.deepEqual(body.items, loyaltyEarnItems([{ uid: 'a', itemId: 'flat', name: 'Flat white', cat: 'coffee', price: 3, qty: 1 }], []), 'the earn\'s own line shape, qty = refunded');
  // The function: a part refund claims its own rows and never gives a used reward back.
  const fn = readRepo('supabase/functions/loyalty-refund/index.ts');
  assert.match(fn, /const idempotencyKey = part \? partRefundKey\(String\(closed_check_id\), refundId\) : fullRefundKey;/);
  assert.match(fn, /const claimKey = part \? partStampKey\(earnKey, refundId\) : fullKey;/);
  assert.match(fn, /\/\/ v5\.11\.81: a part refund leaves a reward used on the check used \(the visit happened\)\.\n\s+if \(!part\) \{/);
  assert.match(fn, /netReversal \+= partTaken;/, 'a full refund after part refunds never takes the same points twice');
  assert.match(fn, /toClaw = remainingAfterParts\(\{ earned, alreadyTaken \}\);/);
  const store = readRepo('src/store/index.js');
  assert.match(store, /\? partRefundLoyaltyBody\(\{ refundId, bd, chargedGoods: chargedGoodsOf\(chkBefore\), refundItems, menuItems: get\(\)\.menuItems \|\| \[\] \}\)/);
  assert.match(store, /staff_id: manager\?\.id \|\| null,\n\s+\.\.\.\(partLoyalty \|\| \{\}\),/);
});

// ── One earn label per surface, customer_id stamped by check id (v5.11.81) ───────────────────────
test('earn: every till surface earns as pos, each customer surface as itself; the customer is stamped on the check by its id, never by a ref that recycles', async () => {
  const { earnChannelFor } = await import('../loyaltyEarnItems.js');
  for (const ot of ['dine-in', 'takeaway', 'delivery', 'drive-thru', 'bar-tab', 'collection']) assert.equal(earnChannelFor({ orderType: ot }), 'pos', ot);
  assert.equal(earnChannelFor({ source: 'kiosk' }), 'kiosk');
  assert.equal(earnChannelFor({ source: 'hubrise', orderType: 'delivery' }), 'hubrise');
  assert.equal(earnChannelFor({ channel: 'qr' }), 'qr');
  assert.equal(earnChannelFor({ channel: 'catering', source: 'catering' }), 'catering');
  const store = readRepo('src/store/index.js');
  assert.match(store, /channel: earnChannelFor\(orderRecord\),\n/);
  assert.doesNotMatch(store, /channel: orderRecord\.orderType \|\| orderRecord\.source \|\| 'pos',/);
  assert.match(store, /match: \{ id: orderRecord\.id, location_id: locId \}, kind: 'customer_stamp'/);
  assert.doesNotMatch(store, /match: \{ ref: orderRecord\.ref, location_id: locId \}/);
  assert.match(store, /closed_check_id: orderRecord\.id \|\| orderRecord\.ref \|\| null,/);
});

// ── A gift card gets its share of a part refund back (v5.11.81) ──────────────────────────────────
test('part refund: the gift card that paid part of the bill gets its share back, the card leg the rest, never more than was spent', async () => {
  const { giftPartRefundPlan } = await import('../giftCommit.js');
  // 20.00 bill: 8.00 on a gift card, 12.00 on a bank card. A 5.00 part refund: 2.00 back on the gift card.
  const leg = { card_id: 'g1', idempotency_key: 'giftcommit:chk-1:g1', applied: 800, code_last4: '1234' };
  const check = { id: 'chk-1', total: 20, giftCard: leg, tenders: [{ method: 'gift_card', amount: 8, tip: 0 }, { method: 'card', amount: 12, tip: 0 }], refunds: [] };
  const plan = giftPartRefundPlan(check, 500);
  assert.equal(plan.totalMinor, 200);
  assert.deepEqual(plan.legs.map((x) => [x.leg.card_id, x.amountMinor]), [['g1', 200]]);
  // After parts that put back 7.00 already, only 1.00 is left on that spend.
  const later = { ...check, refunds: [{ amount: 17.5, giftLegs: [{ card_id: 'g1', key: leg.idempotency_key, minor: 700 }] }] };
  assert.equal(giftPartRefundPlan(later, 1000).totalMinor, 100);
  // A leg whose commit failed (no key) was never debited, so nothing goes back to it.
  assert.equal(giftPartRefundPlan({ ...check, giftCard: { ...leg, idempotency_key: null } }, 500).totalMinor, 0);
  assert.equal(giftPartRefundPlan({ ...check, giftCard: null }, 500).totalMinor, 0);
  // The till: the card leg is asked for the rest only; a cash payout asks the gift card for nothing.
  const store = readRepo('src/store/index.js');
  // v5.11.81 round 1: the split is one pure function the store calls (payments/refundSplit.js).
  assert.match(store, /const split = refundMoneySplit\(\{ check: chkBefore, amount, isFullRefund: !!isFullRefund, cashPayout, legs: legLookup\.legs, legRefunds \}\);/);
  const split = readRepo('src/lib/payments/refundSplit.js');
  assert.match(split, /const giftPart = \(!isFullRefund && !cashPayout\) \? giftPartRefundPlan\(check, amountMinor\) : \{ legs: \[\], totalMinor: 0 \};/);
  assert.match(split, /const wantMinor = Math\.max\(0, amountMinor - giftPart\.totalMinor\);/);
  assert.match(store, /\.\.\.\(_partMinor != null \? \{ amountMinor: _partMinor, refundId \} : \{\}\),/);
  // The function: its own claim per part refund, capped at the spend less what parts put back.
  const fn = readRepo('supabase/functions/gift-reverse-redeem/index.ts');
  assert.match(fn, /const refundKey = part \? `\$\{partPrefix\}\$\{refundId\}` : fullKey;/);
  assert.match(fn, /const restoreAmount = part \? Math\.min\(partMinor as number, Math\.max\(0, spent - putBack\)\) : Math\.max\(0, spent - putBack\);/);
  assert.match(fn, /if \(total === null \|\| total > spent\) \{/, 'a race can never put back more than was spent');
});

// ── v5.11.81 round 1 fix: kiosk and online part refunds reach the whole bill, as the till's ─────────
// The kiosk, the online page and a reader close book `total` as the CARD part; the till books the
// whole bill. Refunding line by line must give the same money back on both rows, the gift card its
// share, the card never more than it took. Runs the store's own split (payments/refundSplit.js).
async function refundLineByLine(check, { legRefundsFor = null } = {}) {
  const { refundBreakdown, cardLegsOf, refundBillOf } = await import('../payments/refundMath.js');
  const { refundMoneySplit } = await import('../payments/refundSplit.js');
  let c = check;
  const steps = [];
  for (const it of check.items) {
    const items = [{ ...it, refundQty: 1 }];
    const bd = refundBreakdown(c, { items });
    if (!(bd.amount > 0)) { steps.push({ amount: 0, gift: 0, card: 0, status: c.status }); continue; }
    const legs = cardLegsOf(c);
    const split = refundMoneySplit({ check: c, amount: bd.amount, legs, legRefunds: legRefundsFor ? legRefundsFor(legs, bd) : null });
    const entry = {
      id: `r${steps.length + 1}`, amount: bd.amount, tipAmount: bd.tip, serviceAmount: bd.service,
      ...(split.giftPart.totalMinor > 0 ? { giftMinor: split.giftPart.totalMinor, giftLegs: split.giftPart.legs.map((x) => ({ card_id: x.leg.card_id, key: x.leg.idempotency_key, minor: x.amountMinor })) } : {}),
      legs: split.allocations.map((a) => ({ id: a.id, amountMinor: a.refundMinor, status: 'succeeded' })),
    };
    const refunds = [...(c.refunds || []), entry];
    const done = refunds.reduce((s, r) => s + r.amount, 0);
    c = { ...c, refunds, status: done >= refundBillOf(c) - 0.005 ? 'refunded' : 'partial_refund' };
    steps.push({ amount: bd.amount, gift: split.giftPart.totalMinor / 100, card: split.allocations.reduce((s, a) => s + a.refundMinor, 0) / 100, status: c.status });
  }
  return { steps, gift: steps.reduce((s, x) => s + x.gift, 0), card: steps.reduce((s, x) => s + x.card, 0) };
}
const burgerRow = (total) => ({
  id: 'chk-bill', ref: 'R1', subtotal: 15, tip: 0, service: 0, total,
  items: [{ uid: 'a', name: 'Burger', price: 7.5, qty: 1 }, { uid: 'b', name: 'Burger', price: 7.5, qty: 1 }], discounts: [],
  tenders: [{ method: 'gift_card', amount: 10, tip: 0 }, { method: 'card', amount: 5, tip: 0, psp_ref: 'psp1', processor: 'adyen' }],
  processor: 'adyen', stripePaymentIntentId: 'psp1',
  giftCard: { card_id: 'gc1', idempotency_key: 'k1', applied: 1000 },
  refunds: [], status: 'paid',
});

test('part refunds: a kiosk or online row (total = card part) gives back the same as the till row, line by line', async () => {
  const till = await refundLineByLine(burgerRow(15));
  const kiosk = await refundLineByLine(burgerRow(5));
  assert.deepEqual(kiosk.steps.map((x) => x.amount), till.steps.map((x) => x.amount), 'each line gives back the same money');
  assert.equal(Math.round((kiosk.gift + kiosk.card) * 100) / 100, 15, 'the whole 15.00 comes back');
  assert.equal(Math.round(kiosk.gift * 100) / 100, 10, 'the gift card gets all its 10.00 back');
  assert.ok(kiosk.card <= 5, 'the card never gives back more than the 5.00 it took');
  assert.equal(kiosk.steps[0].status, 'partial_refund', 'the first line does not close the sale');
  assert.equal(kiosk.steps[1].status, 'refunded');
});

test('part refunds: a kiosk order paid all by gift card (total 0) can be refunded', async () => {
  const { refundBreakdown } = await import('../payments/refundMath.js');
  const row = { ...burgerRow(0), tenders: undefined, stripePaymentIntentId: null, processor: null, giftCard: { card_id: 'gc1', idempotency_key: 'k1', applied: 1500 } };
  assert.equal(refundBreakdown(row, { isFullRefund: true }).amount, 15);
  const one = await refundLineByLine(row);
  assert.equal(Math.round(one.gift * 100) / 100, 15, 'every penny goes back to the gift card');
  assert.equal(one.card, 0);
});

test('part refunds: per leg picks on a split card check never send the gift share to the cards as well', async () => {
  const { refundBreakdown, cardLegsOf } = await import('../payments/refundMath.js');
  const { refundMoneySplit } = await import('../payments/refundSplit.js');
  // Legs 5.00 and 5.00 on two cards plus a 10.00 gift card, a 20.00 bill; a 10.00 part refund.
  const row = {
    id: 'chk-split', total: 20, tip: 0, service: 0, subtotal: 20, discounts: [], refunds: [], status: 'paid', processor: 'adyen',
    items: [{ uid: 'a', price: 10, qty: 1 }, { uid: 'b', price: 10, qty: 1 }],
    paymentIntents: [{ id: 'p1', amountMinor: 500 }, { id: 'p2', amountMinor: 500 }],
    tenders: [{ method: 'gift_card', amount: 10, tip: 0 }, { method: 'card', amount: 5, psp_ref: 'p1' }, { method: 'card', amount: 5, psp_ref: 'p2' }],
    giftCard: { card_id: 'gc1', idempotency_key: 'k1', applied: 1000 },
  };
  const bd = refundBreakdown(row, { items: [{ ...row.items[0], refundQty: 1 }] });
  assert.equal(bd.amount, 10);
  const legs = cardLegsOf(row);
  // The operator (or the old default) asks the cards for the whole 10.00.
  const split = refundMoneySplit({ check: row, amount: bd.amount, legs, legRefunds: { p1: 500, p2: 500 } });
  const out = split.giftPart.totalMinor + split.allocations.reduce((s, a) => s + a.refundMinor, 0);
  assert.equal(split.giftPart.totalMinor, 500);
  assert.equal(out, 1000, 'exactly 10.00 goes out for a 10.00 refund (was 15.00)');
  // The refund screens default the picks to the card share only.
  const ch = readRepo('src/components/CheckHistory.jsx');
  assert.match(ch, /const cardShareMinor=Math\.max\(0,toMinor\(refundTotal\)-giftShareMinor\);/);
  const bo = readRepo('src/backoffice/sections/Transactions.jsx');
  assert.match(bo, /const cardShareMinor = Math\.max\(0, toMinor\(refundAmount\) - giftShareMinor\);/);
  const store = readRepo('src/store/index.js');
  assert.match(store, /const status = totalRefunded >= refundBillOf\(chk\) - 0\.005 \? 'refunded' : 'partial_refund';/);
});

// ── A QR tab earns like a QR pay now order (v5.11.81, partly fixed major) ─────────────────────────
test('QR tab: a settled tab earns for the phone on it (the phone, by the tab\'s own key; the till, by its bound device)', () => {
  const resume = readRepo('src/surfaces/qr/TabResumeScreen.jsx');
  assert.match(resume, /if \(tabCustomer\.phone && settled\.checkId\) \{/);
  assert.match(resume, /orderRecord: \{ ref: tab\.tab_ref, checkId: settled\.checkId, total: runningTotal, items: \(rounds \|\| \[\]\)\.flatMap\(r => r\.items \|\| \[\]\), type: 'dine-in', channel: 'qr' \},/);
  assert.match(resume, /trackKey: chooseTrackKey\(\{ trackToken: tab\.track_token \|\| null, paymentIntentId: tab\.payment_intent_id \|\| null \}\),/);
  assert.match(readRepo('src/surfaces/qr/QrCheckout.jsx'), /track_token: placed\?\.trackToken \|\| null,/, 'the opener keeps the tab\'s own key');
  assert.match(readRepo('src/lib/publicOrder.js'), /checkId: data\.check_id \?\? null \};/, 'settle_qr_tab answers the check id');
  const hub = readRepo('src/surfaces/OrdersHub.jsx');
  assert.match(hub, /orderRecord: \{ id: record\.id, ref: record\.ref, items: record\.items \|\| \[\], total: record\.total, source: 'qr' \},/);
  assert.equal((hub.match(/earnQrSale\(/g) || []).length, 3, 'its three closes (force close, one round, closed short)');
});

// ── Earn has a durable retry like redeem (v5.11.81, confirmed minor) ─────────────────────────────
test('earn: a loyalty earn that did not land is parked durably and replayed (once, server side), as a redemption is', () => {
  const cr = readRepo('src/lib/commitRedemptions.js');
  assert.match(cr, /export async function parkEarn\(earnBody, lastError, \{ retryable = true \} = \{\}\) \{/);
  assert.match(cr, /id: `earn:loyalty:\$\{checkId\}`,\n\s+fn: 'loyalty-earn',\n\s+body: earnBody,/, 'replayed verbatim: earn:<check> is the idempotency anchor');
  assert.match(cr, /\|\| \(res\.status === 409 && j\?\.code === 'check_not_found'\),/, 'a check that has not landed yet is worth a retry');
  const store = readRepo('src/store/index.js');
  const fn = between(store, '  attributeOrderToCustomer: async', '\n  },\n');
  assert.match(fn, /parkEarn\(earnBody, e\?\.message \|\| 'network error'\)/, 'a transport failure');
  assert.match(fn, /if \(earnReplyRetryable\(res\.status, j\)\) parkEarn\(earnBody, j\.error \|\| `HTTP \$\{res\.status\}`\)/, 'a refusal that can still succeed');
  assert.doesNotMatch(fn, /res\.status !== 404\) \{\n\s+console\.warn\('\[loyalty-earn\] HTTP', res\.status, j\.error \|\| ''\);\n\s+\}/, 'never only a console warning');
});

// ── The gift code gate on the server search path (v5.11.81, confirmed minor) ──────────────────────
test('gift code: any 16 letters or digits is a code on the server search path too (Back Office search box), as on the till since v5.11.67', async () => {
  const { isFullGiftCode, classifyGiftLookup } = await import('../../../supabase/functions/_shared/gift-authority.ts');
  assert.equal(isFullGiftCode('C246 89C2 7769 AA08'), true, 'a seeded or imported card with 0, 1, I or O');
  assert.equal(classifyGiftLookup({ search: 'C24689C27769AA08' }), 'code', 'a code holder\'s exact lookup, never the staff search');
  assert.equal(classifyGiftLookup({ search: 'Sam Smith' }), 'staff_search');
  assert.equal(classifyGiftLookup({ search: 'AA08' }), 'staff_search');
  const fn = readRepo('supabase/functions/gift-lookup/index.ts');
  assert.match(fn, /if \(isFullGiftCode\(cleaned\)\) \{/);
  assert.doesNotMatch(fn, /\/\^\[A-Z2-9\]\{16\}\$\//);
});

// ── Manager PIN: asked every time on the handheld, as on the till (v5.11.81, confirmed minor) ─────
test('manager PIN: the handheld asks every time, as the till does (no 90 second grace window)', () => {
  const pin = readRepo('src/surfaces/mpos/MManagerPin.jsx');
  assert.doesNotMatch(pin, /GRACE_MS/);
  assert.doesNotMatch(pin, /setItem\('mpos-last-manager-auth'/, 'an approval is never kept');
  assert.match(pin, /export function getCachedManagerAuth\(\) \{\n\s+try \{ sessionStorage\.removeItem\('mpos-last-manager-auth'\); \} catch \{ \/\* storage blocked \*\/ \}\n\s+return null;\n\}/);
});
