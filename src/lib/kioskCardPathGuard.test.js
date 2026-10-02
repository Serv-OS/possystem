// CARD PATH GUARD for the new kiosk design build (owner rule, non negotiable).
//
// The new screens CALL KioskApp's existing money and order code; they must never change it.
// This test fingerprints the blocks that move money, as they are at v5.8.67, and fails if
// any character inside them changes:
//   submitOrder (idempotency key, gift commit order, PGRST204 retry, stock paths)
//   ScreenPay's logic (processor branch, reader start, cancel, polling)
//   the credits (loyalty, gift, promo, grandTotal)
//   the totals (subtotal, auto discounts, tax, total)
//   updateCartQty
//
// If this fails, the change touched the card path. Undo it, or get the owner's explicit
// sign off and a hardware test before updating a fingerprint here.
//
// FINGERPRINT HISTORY
//   v5.8.65 (the redesign's base): submitOrder 16561 chars d1761dd3..., credits 508 chars
//     919382064c... starting at `const loyaltyCredit = loyaltyRedemption?.discount_value ? ...`.
//   v5.8.67 (kiosk points rewards fix, 8e86b0ed, shipped on develop before the redesign landed).
//   Only these lines moved; ScreenPay, the totals and updateCartQty are byte for byte v5.8.65:
//     credits: the frozen `loyaltyRedemption?.discount_value / 100` became the LIVE figure
//       const loyaltyDiscountMinor = kioskLoyaltyCreditMinor(loyaltyRedemption, { cart,
//         goodsMinor: Math.round(discountedSubtotal * 100), dueMinor: Math.round(total * 100),
//         giftMinor: giftCardPayment?.applied || 0 });
//       const loyaltyCredit = loyaltyDiscountMinor / 100;
//     submitOrder, three code changes plus two comments:
//       closed_checks.loyalty is written only when `loyaltyRedemption && loyaltyDiscountMinor > 0`,
//         and its discount_value is `loyaltyDiscountMinor` (was loyaltyRedemption.discount_value);
//       the loyalty commitRedemption runs only when `loyaltyDiscountMinor > 0 && ...` (the
//         v5.8.67 rule: a reward worth 0p never spends points);
//       the useCallback dependency list gains `loyaltyDiscountMinor` after loyaltyCredit.
//     The gift commit order, the idempotency key (checkIdRef), the PGRST204 retry, both stock
//     paths, the order_queue insert and the 30 second reset are unchanged.
//   v5.8.75 (Peter, 15 Sep 2026, owner sign off "we only use adyen", hardware test on the Provo
//   kiosk's Adyen reader "Counter" before rollout). ScreenPay logic 10819 -> 10964 chars, 3 lines:
//     the processor branch: `if (processor === 'ryft')` became `if (takesCardsOnTerminal(processor))`
//       (lib/payments/processor.js: ryft OR adyen, the POS CheckoutModal rule), plus one comment
//       line. An Adyen venue fell through to the Stripe reader call ("No network reader is
//       assigned") and never reached its paired reader.
//     findPaxTerminal and dispatchTerminalJob are given the kiosk's own `locationId` (a kiosk is
//       paired through rpos-kiosk-id, so getActiveLocationSync() had no venue for it).
//     The job fields (check key, amounts, suppressTip, closed check id, source), polling, cancel,
//     the Stripe branch and every outcome are unchanged.
//   v5.9.12 (19 Sep 2026, US sales tax basis. Peter signed this off when he approved the
//   release; the kiosk hardware test, one card payment on a real reader, follows the
//   deploy). ScreenPay and updateCartQty are byte for byte v5.8.75.
//     totals 2452 -> 2862 chars: the tax lines move into a memo (kioskTaxLines, each line
//       keyed by the same uid evaluateAutoDiscounts saw) and the seam call gains the basis
//       { discounts: autoDiscounts }, so US added-on tax is charged after offers. Inclusive
//       VAT never reads the basis: every UK kiosk figure is identical (taxBasis.test.js
//       UK LOCK fuzz). `total` is the same expression.
//     credits 687 -> 1718 chars: after promoCredit, creditedTaxBreakdown recomputes the tax
//       with the loyalty and promo credits in the basis; taxRelief (0 unless added-on tax
//       drops) comes off grandTotal. The end marker is now the grandTotal line with
//       `- taxRelief`. Loyalty, gift and promo sizing are unchanged.
//     submitOrder 16899 -> 17280 chars: tax / tax_amount read chargedTaxBreakdown (the
//       breakdown with the relief applied, else taxBreakdown: identical for UK), the row
//       gains tax_breakdown ONLY when added-on tax was charged, and the useCallback
//       dependency list gains chargedTaxBreakdown. The gift commit order, the idempotency
//       key, the PGRST204 retry, both stock paths, the order_queue insert and the 30 second
//       reset are unchanged.
//   v5.9.66 (24 Sep 2026, loyalty rewards by CATEGORY. Shipped overnight for the morning; Peter's
//   sign off and one kiosk card payment on a real reader are OWED, flagged in the release note).
//   ScreenPay, the totals, updateCartQty and submitOrder are byte for byte v5.9.12.
//     credits 1718 -> 1768 chars, ONE line: the loyalty credit context gains `categories,` (the
//       kiosk's own menu_categories rows) so lib/kioskLoyaltyReward.js can size a free item
//       reward that names a category. A reward that names no category is sized exactly as
//       before (the category rule is skipped). Gift, promo, tax relief and grandTotal unchanged.
//   v5.11.x (30 Sep 2026, Barnsley kiosk refunds. CARD PATH: Peter's explicit sign off and one
//   kiosk card payment on a real Adyen reader, then "Return to card" from the till, are REQUIRED
//   before this merges). Kiosk card sales on a card machine were booked under their own id with
//   processor 'stripe' (the column default), no card reference and no tenders, so the till could
//   not refund them to the card. The credits, the totals and updateCartQty are byte for byte v5.9.66.
//     ScreenPay logic 10964 -> 11622 chars: the job's closed_check_id is the basket's check id
//       (`ensureCheckId()`, a new ScreenPay prop; the old `chk-kiosk-<uuid>` is the fallback when
//       it is not given), and on approval `onPaid(kioskReaderPayment(finalJob, closedCheckId))`
//       hands the approved job over (was `onPaid()`). The comment above it is rewritten. The
//       processor branch, the check key and nonce, amounts, suppressTip, polling, cancel, the
//       Stripe branch and every other outcome are unchanged.
//     submitOrder 17280 -> 18730 chars: a third parameter `cardPayment` (start marker changed),
//       kept in paidCardRef when isKioskReaderPayment (a click event or nothing never counts); the
//       check id falls back to the job's closed_check_id when checkIdRef is empty; the row gains
//       ...kioskCheckPaymentFields({ reader, tip, giftRecord, loyaltyCredit, promoCredit })
//       (processor, stripe_payment_intent_id and tenders, and NOTHING when no card machine took
//       the money, lib/kioskCardLink.js); after the insert lands the job is marked reconciled.
//       The gift commit order, the idempotency key, the PGRST204 retry, both stock paths, the
//       order_queue insert, the 30 second reset and the dependency list are unchanged.
//     The old kiosk's pay screen line passes the payment on:
//       onPaid={(paid) => submitOrder(customerName, customerPhone, paid)} ensureCheckId={ensureCheckId}
//       and the new design's (KioskFlowV2.jsx) does the same through the engine.
//   Same entry, review round (30 Sep 2026). A payment is tied to its basket, and a basket that is
//   already paid is never charged again:
//     submitOrder 18730 -> 19963 chars: a handed payment is kept in paidCardRef only when it carries
//       the basket's check id (kioskPaymentIsThisBasket). One that lands after a reset (the X or the
//       idle timer inside the 0.8 s before onPaid) is booked once under its own id and never writes
//       paidCardRef or checkIdRef, so the next customer's basket never inherits it. A payment kept
//       from an earlier attempt books only while its amount still matches the basket
//       (kioskHeldPaymentFits), else the customer is asked to fetch a member of staff. The old
//       "check id from the job when checkIdRef is empty" line is gone (a late payment covers it).
//     ScreenPay logic 11622 -> 12669 chars: a new prop heldPayment (a getter of paidCardRef). When
//       the basket holds an approved payment, startCardPayment (mount and Try again) books it
//       through onPaid() and never starts a charge. After the card machine answers ALREADY_PAID
//       this screen never starts another charge either. The comment above the Ryft path is
//       corrected (the check key alone does not stop a second charge).
//     Both pay screen lines pass heldPayment (heldCardPayment on the engine for the new design).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SRC = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');

const BLOCKS = [
  {
    name: 'submitOrder',
    start: 'const submitOrder = useCallback(async (nameOverride, phoneOverride, cardPayment) => {',
    end: 'tableNumber, resetSession]);',
    length: 19963,
    sha256: '2613c18354fd393598a6c8bcedd7b3173858d981ca5153863c8ad20c2e91dc68',
  },
  {
    name: 'ScreenPay logic',
    start: "const [cardState, setCardState] = useState('idle');",
    end: 'const cardDueAmount = total;',
    length: 12669,
    sha256: 'cf7253971568703e4778ce74749fdb11870fdd2e4a26ad8f29d240bc328806d6',
  },
  {
    name: 'credits',
    start: 'const loyaltyDiscountMinor = kioskLoyaltyCreditMinor(loyaltyRedemption, {',
    end: 'const grandTotal = Math.max(0, total - loyaltyCredit - giftCardCredit - promoCredit - taxRelief);',
    length: 1768,
    sha256: 'cad906c1405d546e4c338219f74921489b3d36158acb74d9ab05e684d30aadbd',
  },
  {
    name: 'totals',
    start: 'const subtotal = useMemo(() => cart.reduce((a, l) => a + l.lineTotal, 0), [cart]);',
    end: 'const total = useMemo(() => discountedSubtotal + exclusiveTax + tip, [discountedSubtotal, exclusiveTax, tip]);',
    length: 2862,
    sha256: '4dfc7f6aacef36c47c3b57544557d36ed89e93f2849a4c48a0755878b8f2e77c',
  },
  {
    name: 'updateCartQty',
    start: 'const updateCartQty = useCallback((key, delta) => {',
    end: '}, [resetIdle, dailyCounts]);',
    length: 575,
    sha256: 'df4f5929597f9d8cee8f46fd4b1a28371142b8626264c58165914a0dcfa8c02b',
  },
];

const count = (hay, needle) => hay.split(needle).length - 1;

for (const b of BLOCKS) {
  test(`card path guard: ${b.name} is unchanged since its last signed entry`, () => {
    const i = SRC.indexOf(b.start);
    assert.ok(i >= 0, `${b.name}: start marker not found`);
    const j = SRC.indexOf(b.end, i);
    assert.ok(j > i, `${b.name}: end marker not found after the start`);
    const block = SRC.slice(i, j + b.end.length);
    // The whole block exists exactly once, and the end marker is not repeated, so the
    // fingerprint cannot be satisfied by a stale copy while the live code changed.
    assert.equal(count(SRC, block), 1, `${b.name}: block must appear exactly once`);
    assert.equal(count(SRC, b.end), 1, `${b.name}: end marker must appear exactly once`);
    assert.equal(block.length, b.length, `${b.name}: length changed`);
    assert.equal(crypto.createHash('sha256').update(block).digest('hex'), b.sha256, `${b.name}: content changed`);
  });
}

test('card path guard: the start markers are unique', () => {
  for (const b of BLOCKS) {
    assert.equal(count(SRC, b.start), 1, `${b.name}: start marker must appear exactly once`);
  }
});

test('card path guard: the v5.8.67 reward rule is in submitOrder, and only there', () => {
  const i = SRC.indexOf(BLOCKS[0].start);
  const submit = SRC.slice(i, SRC.indexOf(BLOCKS[0].end, i));
  for (const line of [
    // a reward is recorded on the check only when it took money off, with the live figure
    'loyalty: (loyaltyRedemption && loyaltyDiscountMinor > 0) ? {',
    'discount_value: loyaltyDiscountMinor,',
    // and committed (points or a stamp card spent) only when it took money off
    'if (loyaltyDiscountMinor > 0 && loyaltyRedemption?.pending_commit && (loyaltyRedemption.stampProgramId || loyaltyRedemption.reward_id)) {',
  ]) {
    assert.equal(count(submit, line), 1, `submitOrder must keep: ${line}`);
    assert.equal(count(SRC, line), 1, `only submitOrder may have: ${line}`);
  }
});

test('card path guard: ONE reward money implementation (lib/kioskLoyaltyReward.js)', () => {
  // KioskApp (the live credit and the old flow's tap) and the new design both use it.
  assert.equal(count(SRC, "import { kioskLoyaltyCreditMinor, kioskRewardTapCheck } from '../lib/kioskLoyaltyReward';"), 1);
  const checkout = fs.readFileSync(new URL('./kioskCheckout.js', import.meta.url), 'utf8');
  assert.ok(checkout.includes("from './kioskLoyaltyReward.js';"), 'kioskCheckout.js must stage rewards through kioskLoyaltyReward.js');
  assert.ok(checkout.includes('kioskRewardTapCheck(reward.type, rv, ctx)'), 'the new design taps through the same check');
  // Nothing else turns a reward's value into money: no second copy of the fixed, percent or
  // free item maths in the new design's rules or screens (fixture data aside).
  const dir = new URL('../surfaces/kiosk/', import.meta.url);
  const files = [
    ['src/lib/kioskCheckout.js', checkout],
    ...fs.readdirSync(dir, { recursive: true })
      .filter(f => /\.(js|jsx)$/.test(f) && !f.endsWith('kioskFixtures.js'))
      .map(f => [`src/surfaces/kiosk/${f}`, fs.readFileSync(new URL(f, dir), 'utf8')]),
  ];
  for (const [name, text] of files) {
    assert.ok(!/amount_minor|\.percent\b|discount_value\s*\//.test(text), `${name} must not work out reward money itself`);
  }
});

test('card path guard: the old kiosk still charges through the same ScreenPay call', () => {
  // The old flow's pay screen line: submitOrder with the customer name and phone, and (30 Sep
  // 2026) the card machine payment ScreenPay hands over, with the basket's check id for the job.
  assert.equal(count(SRC, 'onPaid={(paid) => submitOrder(customerName, customerPhone, paid)} ensureCheckId={ensureCheckId} heldPayment={heldCardPayment}'), 1);
  // The new design is gated by the flag helper, once.
  assert.equal(count(SRC, 'const newDesign = kioskNewDesignOn(profile);'), 1);
});

test('card path guard: the new card screen calls ScreenPay\'s own handlers, word for word', () => {
  // D3: exactly one look === 'v2' branch, placed after the logic block, before the old screen.
  assert.equal(count(SRC, "if (look === 'v2') return ("), 1);
  const v2At = SRC.indexOf("if (look === 'v2') return (");
  assert.ok(v2At > SRC.indexOf('const fullyPaid = total <= 0;'));
  assert.ok(v2At < SRC.indexOf("<ScreenHeader title={fullyPaid ? 'Order fully covered!'"));
  const branch = SRC.slice(v2At, SRC.indexOf(');', SRC.indexOf('/>', v2At)));
  // Retry, back and cancel are the same expressions the old card screen uses.
  for (const expr of [
    "() => { setCardState('idle'); setTimeout(startCardPayment, 100); }",
    '() => { pollAbortRef.current = true; cancelReaderAction(); onBack(); }',
    '() => { pollAbortRef.current = true; cancelReaderAction(); onCancel(); }',
  ]) {
    assert.ok(branch.includes(expr), `v2 branch must use: ${expr}`);
    assert.ok(count(SRC, expr) >= 2, `old screen must still use: ${expr}`);
  }
  assert.ok(branch.includes('onPlaceOrder={onPaid}'));
});

test('card path guard: the new design reset and idle rules only apply when the design is on', () => {
  assert.equal(count(SRC, 'if (!kioskResetAllowed(reason, newDesignRef.current)) return;'), 1);
  assert.equal(count(SRC, 'if (newDesignRef.current && idlePausedRef.current) {'), 1);
  // submitOrder's own 30 second reset is untouched (inside the fingerprinted block).
  assert.equal(count(SRC, 'setTimeout(() => resetSession(), 30000);'), 1);
});

test('card path guard: every card surface decides "card machine or Stripe reader" with one rule', () => {
  const proc = fs.readFileSync(new URL('./payments/processor.js', import.meta.url), 'utf8');
  assert.match(proc, /export function takesCardsOnTerminal\(processor\) \{\n  return processor === 'ryft' \|\| processor === 'adyen';\n\}/);
  assert.match(SRC, /if \(takesCardsOnTerminal\(processor\)\) \{ await startRyftTerminalPayment\(\); return; \}/);
  assert.match(SRC, /findPaxTerminal\(\{ posDeviceId: kioskId, locationId \}\)/);
  for (const rel of ['../surfaces/CheckoutModal.jsx', '../components/SplitModal.jsx']) {
    const other = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(other, /takesCardsOnTerminal\(/, rel);
    assert.doesNotMatch(other, /=== 'ryft' \|\| [\w.]+ === 'adyen'/, rel);
  }
  assert.doesNotMatch(SRC, /processor === 'ryft'\) \{ await startRyftTerminalPayment/);
  const jobs = fs.readFileSync(new URL('./payments/terminalJobs.js', import.meta.url), 'utf8');
  assert.match(jobs, /const locationId = explicitLocationId \|\| getActiveLocationSync\(\);/);
  assert.match(jobs, /const locationId = p\?\.locationId \|\| getActiveLocationSync\(\);/);
});

test('card path guard: a kiosk card machine sale is booked linked to its job (30 Sep 2026)', () => {
  // One pure implementation (lib/kioskCardLink.js), imported once.
  assert.equal(count(SRC, "import { kioskReaderPayment, isKioskReaderPayment, kioskPaymentIsThisBasket, kioskHeldPaymentFits, kioskCheckPaymentFields } from '../lib/kioskCardLink';"), 1);
  const submit = SRC.slice(SRC.indexOf(BLOCKS[0].start), SRC.indexOf(BLOCKS[0].end, SRC.indexOf(BLOCKS[0].start)));
  const pay = SRC.slice(SRC.indexOf(BLOCKS[1].start), SRC.indexOf(BLOCKS[1].end, SRC.indexOf(BLOCKS[1].start)));
  // ScreenPay: the job carries the basket's check id, and the approved job is handed over.
  assert.equal(count(pay, "const closedCheckId = (typeof ensureCheckId === 'function' && ensureCheckId())"), 1);
  assert.equal(count(pay, 'const paid = kioskReaderPayment(finalJob, closedCheckId);'), 1);
  assert.equal(count(pay, 'setTimeout(() => onPaid(paid), 800);'), 1);
  // Only the approved branch passes a payment: the Stripe branch and the covered order pass none.
  assert.equal(count(pay, 'setTimeout(() => onPaid(), 800);'), 1);
  // submitOrder: only a real payment is kept, the row is spread with the linked fields, and the
  // job is reconciled only after the insert landed.
  assert.equal(count(submit, 'const handed = isKioskReaderPayment(cardPayment) ? cardPayment : null;'), 1);
  assert.equal(count(submit, '...kioskCheckPaymentFields({'), 1);
  const insertAt = submit.indexOf('if (e1) throw e1;');
  const reconcileAt = submit.indexOf('if (reader?.jobId) markJobReconciled(reader.jobId).catch(() => {});');
  assert.ok(insertAt > 0 && reconcileAt > insertAt, 'the job is reconciled after the sale is booked, never before');
  // A new basket never inherits the last one's card payment.
  assert.equal(count(SRC, 'paidCardRef.current = null;'), 1);
  // The new design passes the payment, the check id and the held payment the same way.
  const flow = fs.readFileSync(new URL('../surfaces/kiosk/KioskFlowV2.jsx', import.meta.url), 'utf8');
  assert.equal(count(flow, 'onPaid={(paid) => engine.submitOrder(...checkout.submitArgs, paid)}'), 1);
  assert.equal(count(flow, 'ensureCheckId={engine.ensureCheckId}'), 1);
  assert.equal(count(flow, 'heldPayment={engine.heldCardPayment}'), 1);
  // The kiosk job is still never booked by a till: its draft has no items.
  const jobs = fs.readFileSync(new URL('./payments/terminalJobs.js', import.meta.url), 'utf8');
  assert.match(jobs, /const RECONCILABLE_SOURCES = \['pax_table_pay', 'pos_send_to_terminal', 'adyen_pay_at_table'\];/);
});

test('card path guard: a payment is tied to its basket, and a paid basket is never charged again (30 Sep 2026 review)', () => {
  const submit = SRC.slice(SRC.indexOf(BLOCKS[0].start), SRC.indexOf(BLOCKS[0].end, SRC.indexOf(BLOCKS[0].start)));
  const pay = SRC.slice(SRC.indexOf(BLOCKS[1].start), SRC.indexOf(BLOCKS[1].end, SRC.indexOf(BLOCKS[1].start)));
  // Only a payment carrying this basket's check id is kept for the basket.
  assert.equal(count(submit, 'const late = !!handed && !kioskPaymentIsThisBasket(handed, checkIdRef.current);'), 1);
  assert.equal(count(submit, 'if (handed && !late) paidCardRef.current = handed;'), 1);
  // Nowhere else in submitOrder writes the refs the next basket reads: paidCardRef once (above),
  // checkIdRef once (the basket's own mint, in the branch a late payment never takes).
  assert.equal(count(submit, 'paidCardRef.current ='), 1);
  assert.equal(count(submit, 'checkIdRef.current ='), 1);
  const lateAt = submit.indexOf('if (late) {');
  const mintAt = submit.indexOf('checkIdRef.current =');
  const elseAt = submit.indexOf('} else {', lateAt);
  assert.ok(lateAt > 0 && elseAt > lateAt && mintAt > elseAt, 'the basket id is minted only when the payment is not late');
  // A late payment books under its own id.
  assert.equal(count(submit, 'checkId = handed.closedCheckId ||'), 1);
  // A held payment is booked only while its amount still matches the basket.
  assert.equal(count(submit, 'if (reader && !handed && !kioskHeldPaymentFits(reader, Math.round(grandTotal * 100))) {'), 1);
  // ScreenPay: a held payment is booked, never charged again, before any charge can start.
  const startAt = pay.indexOf('const startCardPayment = async () => {');
  const heldAt = pay.indexOf("if (isKioskReaderPayment(typeof heldPayment === 'function' ? heldPayment() : null)) {");
  const lockAt = pay.indexOf('if (alreadyPaidRef.current) {');
  const chargeAt = pay.indexOf('if (takesCardsOnTerminal(processor)) { await startRyftTerminalPayment(); return; }');
  assert.ok(startAt > 0 && heldAt > startAt && lockAt > heldAt && chargeAt > lockAt, 'held and ALREADY_PAID checks come before any charge');
  assert.equal(count(pay, "if (e?.code === 'ALREADY_PAID') alreadyPaidRef.current = true;"), 1);
});
