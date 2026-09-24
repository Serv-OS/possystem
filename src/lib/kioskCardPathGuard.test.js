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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SRC = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');

const BLOCKS = [
  {
    name: 'submitOrder',
    start: 'const submitOrder = useCallback(async (nameOverride, phoneOverride) => {',
    end: 'tableNumber, resetSession]);',
    length: 17280,
    sha256: 'd843c8fd7ddf9bde47d5f789160f9a70feacc9ef00659a9aea31965f730a191c',
  },
  {
    name: 'ScreenPay logic',
    start: "const [cardState, setCardState] = useState('idle');",
    end: 'const cardDueAmount = total;',
    length: 10964,
    sha256: '0975f4b933039dcdd81b9bce90375ec98829e4dedff71033b579cd6f2cb6d6e9',
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
  test(`card path guard: ${b.name} is unchanged since v5.9.12`, () => {
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
  // The old flow's pay screen line, unchanged: submitOrder with the customer name and phone.
  assert.equal(count(SRC, 'onPaid={() => submitOrder(customerName, customerPhone)}'), 1);
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
