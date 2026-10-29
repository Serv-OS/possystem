// giftAtTill.test.js (Drop C, v5.11.118, 29 Oct 2026): a gift card sold at the till.
// The line is money in, not sales: outside tax, never discounted, no loyalty, no kitchen; the
// customer receipt shows it with no VAT share and a second slip prints the card. Pure rules first,
// then the wiring (the button, the pay complete hook, History) read off the source files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  giftCardSaleLine, isGiftCardSaleLine, isTaxExemptLine, isNoDiscountLine, cleanGiftAmountMinor,
  normaliseGiftCode, formatGiftCodeInput, giftLinesTotal, GIFT_CARD_PRESETS_MINOR,
} from './giftCardLine.js';
import { computeOrderTaxUnified } from './taxCompute.js';
import { calculateOrderTax } from './tax.js';
import { checkDiscountAmount, linesAfterItemDiscounts, allocateCheckBasis, stampDiscountAmounts } from './taxBasis.js';
import { evaluateAutoDiscounts } from './discountEngine.js';
import { computeCheckTotals } from './payments/checkTotals.js';
import { loyaltyEarnItems } from './loyaltyEarnItems.js';
import { buildGiftCardSlipDoc, buildCustomerReceiptDoc } from './printDoc.js';
import {
  giftIssueBody, giftLoadBody, giftLineSlots, giftActivationWords, loadGiftCardAtTill, issueGiftCardAtTill,
  giftCardsOnCheck, plainError,
} from './giftAtTill.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const VAT20 = { id: 'vat20', name: 'VAT', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true };
const US8 = { id: 'us8', name: 'Sales Tax', code: 'US', rate: 0.08, type: 'exclusive', is_default: true, active: true };
const food = { uid: 'f1', itemId: 'burger', name: 'Burger', price: 12, qty: 1, taxRateId: 'vat20' };
const gift = giftCardSaleLine(2000, 'g1');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// ── the line ─────────────────────────────────────────────────────────────────────────────────

test('the store line: one card = one line, outside tax, never discounted, no stock, no kitchen', () => {
  assert.deepEqual(gift, {
    uid: 'g1', itemId: 'gift_card', kind: 'gift_card_sale', name: 'Gift card', price: 20, qty: 1,
    mods: [], notes: '', allergens: [], seat: 'shared', course: 1,
    taxExempt: true, noDiscount: true, noStock: true, noKitchen: true, fired: false, status: 'pending',
  });
  assert.ok(isGiftCardSaleLine(gift) && isTaxExemptLine(gift) && isNoDiscountLine(gift));
  assert.ok(!isGiftCardSaleLine(food) && !isTaxExemptLine(food) && !isNoDiscountLine(food));
  assert.equal(giftCardSaleLine(2550, 'x').price, 25.5);
  assert.equal(giftLinesTotal([food, gift, { ...gift, uid: 'g2', voided: true }, { ...gift, uid: 'g3', price: 10 }]), 30);
});

test('the amount rule: 5.00 to 500.00, presets 10 20 25 50, anything else refused', () => {
  assert.deepEqual([...GIFT_CARD_PRESETS_MINOR], [1000, 2000, 2500, 5000]);
  assert.equal(cleanGiftAmountMinor('20'), 2000);
  assert.equal(cleanGiftAmountMinor('£25.50'), 2550);
  assert.equal(cleanGiftAmountMinor(5), 500);
  assert.equal(cleanGiftAmountMinor('500'), 50000);
  assert.equal(cleanGiftAmountMinor('4.99'), null);
  assert.equal(cleanGiftAmountMinor('500.01'), null);
  assert.equal(cleanGiftAmountMinor(''), null);
  assert.equal(cleanGiftAmountMinor('abc'), null);
  assert.equal(cleanGiftAmountMinor('1.234'), null);
});

test('a card code: 16 letters and digits, dashes and spaces optional, formatted as typed', () => {
  assert.equal(normaliseGiftCode('abcd1234efgh5678'), 'ABCD-1234-EFGH-5678');
  assert.equal(normaliseGiftCode('ABCD-1234-EFGH-5678'), 'ABCD-1234-EFGH-5678');
  assert.equal(normaliseGiftCode('ABCD 1234 EFGH 567'), null);
  assert.equal(formatGiftCodeInput('abcd12'), 'ABCD-12');
  assert.equal(formatGiftCodeInput('ABCD-1234-EFGH-5678-ZZZZ'), 'ABCD-1234-EFGH-5678');
});

// ── tax ──────────────────────────────────────────────────────────────────────────────────────

test('UK: the VAT is only on the item; the gift card is in the money but in no rate line', () => {
  const t = computeOrderTaxUnified([food, gift], { taxRates: [VAT20] }, 'takeaway');
  near(t.totalTax, 2, 'VAT on the burger only (12 - 12/1.2)');
  near(t.total, 32, 'the check total keeps the gift card');
  near(t.subtotal, 30, 'net = 10 burger + 20 gift card');
  assert.equal(t.breakdown.length, 1);
  assert.equal(t.breakdown[0].items, 1, 'the gift card is not counted in the rate line');
  near(t.breakdown[0].gross, 12, 'the rate line gross is the burger');
  assert.equal(t.fallbacks, undefined, 'no fallback note for the gift card');
  // byte for byte the burger alone, apart from the gift money in the totals
  const alone = computeOrderTaxUnified([food], { taxRates: [VAT20] }, 'takeaway');
  near(alone.totalTax, t.totalTax, 'same VAT with or without the gift card');
});

test('US: no sales tax on the gift card, on the parity path and the check basis (engine) path', () => {
  const usFood = { ...food, taxRateId: 'us8', price: 10 };
  const t = computeOrderTaxUnified([usFood, gift], { taxRates: [US8] }, 'takeaway');
  near(t.exclusiveTax, 0.8, '8% of the 10.00 item only');
  near(t.total, 30.8, 'goods + tax');
  // a 10% check discount puts a US check on the engine path (the basis moves the added-on tax)
  const t2 = computeOrderTaxUnified([usFood, gift], { taxRates: [US8] }, 'takeaway', { discounts: [{ type: 'percent', value: 10 }], service: 0, deliveryFee: 0 });
  near(t2.exclusiveTax, 0.72, '8% of 9.00 (the discount never touches the gift card)');
  assert.ok(Array.isArray(t2.lineTaxes) && t2.lineTaxes.length === 2 && t2.lineTaxes[1] === 0, 'the gift line carries 0 tax');
});

test('calculateOrderTax (the legacy engine) and a taxExempt line without the kind agree', () => {
  const leg = calculateOrderTax([food, gift], [VAT20], 'takeaway');
  near(leg.totalTax, 2, 'legacy VAT on the burger only');
  near(leg.total, 32, 'legacy total keeps the gift');
  const exempt = { uid: 'e', itemId: 'x', name: 'Exempt thing', price: 5, qty: 1, taxExempt: true };
  near(calculateOrderTax([exempt], [VAT20], 'takeaway').totalTax, 0, 'taxExempt alone is enough');
});

// ── discounts ────────────────────────────────────────────────────────────────────────────────

test('the discount basis leaves the gift card out; a percent discount is of the other lines', () => {
  assert.equal(linesAfterItemDiscounts([food, gift]), 12);
  assert.equal(checkDiscountAmount({ type: 'percent', value: 10 }, linesAfterItemDiscounts([food, gift])), 1.2);
  const alloc = allocateCheckBasis([food, gift], { discounts: [{ type: 'percent', value: 10 }], service: 1.5, deliveryFee: 0 });
  near(alloc.discount, 1.2, '10% of the burger');
  near(alloc.lines[0].netValue, 10.8, 'the burger takes the whole discount');
  near(alloc.lines[1].netValue, 20, 'the gift card is whole');
  near(alloc.lines[1].serviceShare, 0, 'the gift card takes no service share');
  near(alloc.lines[0].serviceShare, 1.5, 'the burger takes all the service');
  // an amount discount bigger than the burger never spreads onto the gift card
  const big = allocateCheckBasis([food, gift], { discounts: [{ type: 'amount', value: 15 }], service: 0, deliveryFee: 0 });
  near(big.lines[1].netValue, 20, 'amount discount cannot reach the gift card');
  near(big.lines[0].netValue, 0, 'the burger is fully discounted');
  const stamped = stampDiscountAmounts([food, gift], [{ id: 'd', type: 'percent', value: 10, label: '10% off' }]);
  near(stamped[0].amount, 1.2, 'the closed check records the discount on the burger only');
});

test('computeCheckTotals: subtotal keeps the card, discount and service do not touch it; no gift = unchanged', () => {
  const base = { checkDiscounts: [{ id: 'd', type: 'percent', value: 10, label: '10%' }], orderType: 'takeaway', taxRates: [VAT20] };
  const withGift = computeCheckTotals({ ...base, items: [food, gift] });
  near(withGift.subtotal, 32, 'subtotal keeps the gift card');
  near(withGift.checkDiscount, 1.2, '10% of the burger only');
  near(withGift.discountedSub, 30.8, 'bill before tax');
  near(withGift.total, 30.8, 'UK: nothing added on');
  near(withGift.tax.totalTax, 1.8, 'VAT follows the burger discount (10.80 -> 1.80), not the gift');
  const without = computeCheckTotals({ ...base, items: [food] });
  near(without.checkDiscount, 1.2, 'the same discount without a gift line');
  near(without.tax.totalTax, 1.8, 'the same VAT without a gift line');
  // an amount discount larger than the other lines stops at them
  const capped = computeCheckTotals({ items: [food, gift], checkDiscounts: [{ id: 'd', type: 'amount', value: 50, label: '50 off' }], orderType: 'takeaway' });
  near(capped.discountedSub, 20, 'the gift card is still paid for');
});

test('auto discounts never trigger on, or reward, a gift card line', () => {
  const rule = { id: 'r', name: '2 for 1', active: true, triggerType: 'buy_x', triggerCategoryIds: [], triggerQty: 2, rewardQty: 1, rewardType: 'percent', rewardValue: 100 };
  const two = [{ ...gift, uid: 'g1' }, { ...gift, uid: 'g2' }];
  assert.deepEqual(evaluateAutoDiscounts(two, [rule], 'pos'), [], 'two gift cards fire nothing');
  const r = evaluateAutoDiscounts([food, { ...food, uid: 'f2' }, gift], [rule], 'pos');
  for (const ad of r) for (const ai of ad.appliedItems || []) assert.notEqual(ai.uid, 'g1', 'the reward never lands on the gift card');
});

test('loyalty earns nothing on a gift card line (flagged isGiftCard, which loyalty-earn skips)', () => {
  const rows = loyaltyEarnItems([food, gift], []);
  assert.equal(rows[0].isGiftCard, false);
  assert.equal(rows[1].isGiftCard, true);
});

// ── printing ─────────────────────────────────────────────────────────────────────────────────

const texts = (doc) => doc.ops.filter((o) => o.t === 'text' || o.t === 'twoCol' || o.t === 'twoColTrunc' || o.t === 'centeredLine')
  .map((o) => (o.t === 'text' ? o.s : o.t === 'centeredLine' ? o.s : `${o.l} | ${o.r}`));

test('the gift card slip: venue, GIFT CARD, the spaced code, the value, the balance address, the check, a cut', () => {
  const doc = buildGiftCardSlipDoc({
    location: { name: 'Coffee Boy', address: '1 High St\nLeeds', currency: 'GBP' },
    card: { code: 'ABCD-1234-EFGH-5678', balance_minor: 2000, currency: 'GBP', balance_url: 'https://app.serv-os.app/gift/ABCD5678' },
    check: { ref: 'R42', server: 'Jane' },
  }, { cols: 42 });
  const t = texts(doc);
  assert.ok(t.includes('Coffee Boy'), 'venue name');
  assert.ok(t.includes('GIFT CARD'), 'GIFT CARD heading');
  assert.ok(t.includes('A B C D  -  1 2 3 4  -  E F G H  -  5 6 7 8'), 'the code large and spaced');
  assert.ok(t.includes('£20.00'), 'the value');
  assert.ok(t.includes('Check your balance at') && t.includes('https://app.serv-os.app/gift/ABCD5678'), 'balance address');
  assert.ok(t.some((s) => s.startsWith('Check | ')), 'the check ref');
  assert.ok(!t.some((s) => /VAT/i.test(s)), 'no VAT line on a gift slip');
  assert.equal(doc.ops[doc.ops.length - 1].t, 'cut', 'ends with a cut');
  assert.ok(doc.ops.some((o) => o.t === 'divider'), 'a divider');
});

test('the customer receipt: the gift line prints as Gift card with no VAT share; VAT is on the item only', () => {
  const items = [food, gift];
  const tax = computeOrderTaxUnified(items, { taxRates: [VAT20] }, 'takeaway');
  const doc = buildCustomerReceiptDoc({
    location: { name: 'Coffee Boy', currency: 'GBP' },
    check: { ref: 'R42', server: 'Jane', orderType: 'takeaway', method: 'cash' },
    items,
    totals: { subtotal: 32, service: 0, tip: 0, grand: 32, taxBreakdown: tax },
  }, { cols: 42 });
  const t = texts(doc);
  const giftAt = t.findIndex((s) => s === 'Gift card | £20.00');
  assert.ok(giftAt >= 0, 'the gift card line with its price');
  assert.equal(t[giftAt + 1], '  No VAT', 'the no VAT note under it');
  const vat = t.filter((s) => /of which/.test(s));
  assert.equal(vat.length, 1, 'one VAT line');
  assert.ok(vat[0].endsWith('| £2.00'), `VAT is the burger's 2.00 only: ${vat[0]}`);
  assert.ok(t.includes('TOTAL | £32.00'), 'the total keeps the gift card');
});

// ── the server contract ──────────────────────────────────────────────────────────────────────

test('gift-issue and gift-load bodies follow the server contract exactly', () => {
  assert.deepEqual(giftIssueBody({ amountMinor: 2000, locationId: 'loc1', closedCheckId: 'chk-1', staffId: 's1' }),
    { amount: 2000, location_id: 'loc1', channel: 'pos', closed_check_id: 'chk-1', staff_id: 's1' });
  assert.deepEqual(giftIssueBody({ amountMinor: 2000, locationId: 'loc1', closedCheckId: 'chk-1' }),
    { amount: 2000, location_id: 'loc1', channel: 'pos', closed_check_id: 'chk-1' });
  assert.deepEqual(giftLoadBody({ code: 'abcd1234efgh5678', amountMinor: 2000, locationId: 'loc1', closedCheckId: 'chk-1' }),
    { action: 'load', code: 'ABCD-1234-EFGH-5678', amount_minor: 2000, location_id: 'loc1', closed_check_id: 'chk-1' });
  assert.equal(giftLoadBody({ code: 'short', amountMinor: 2000 }), null);
});

test('the calls: bearer token, plain errors, status cards; never a throw', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    if (url.endsWith('/gift-issue')) return { ok: true, status: 200, json: async () => ({ ok: true, card_id: 'c1', code: 'ABCD-1234-EFGH-5678', code_last4: '5678', balance_minor: body.amount, balance_url: 'https://x/b' }) };
    if (body.action === 'status') return { ok: true, status: 200, json: async () => ({ ok: true, cards: [{ card_id: 'c1', code_last4: '5678', type: 'issue', amount_minor: 2000, balance_minor: 2000 }] }) };
    if (body.code === 'VOID-VOID-VOID-VOID') return { ok: false, status: 409, json: async () => ({ error: 'Card is voided' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, card_id: 'c2', code_last4: body.code.slice(-4), balance_minor: 4500, loaded_minor: body.amount_minor, topped_up: true }) };
  };
  const transport = { functionsUrl: 'https://f/functions/v1', token: 'tok', fetchImpl };
  const issued = await issueGiftCardAtTill({ amountMinor: 2000, locationId: 'loc1', closedCheckId: 'chk-1' }, transport);
  assert.equal(issued.ok, true);
  assert.equal(issued.code, 'ABCD-1234-EFGH-5678');
  assert.equal(calls[0].url, 'https://f/functions/v1/gift-issue');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  const loaded = await loadGiftCardAtTill({ code: 'wxyz0000wxyz1234', amountMinor: 2000, locationId: 'loc1', closedCheckId: 'chk-1' }, transport);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.topped_up, true);
  assert.equal(giftActivationWords(loaded), 'Card ending 1234 topped up to 45.00');
  const refused = await loadGiftCardAtTill({ code: 'VOIDVOIDVOIDVOID', amountMinor: 2000, locationId: 'loc1', closedCheckId: 'chk-1' }, transport);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Card is voided');
  const bad = await loadGiftCardAtTill({ code: 'nope', amountMinor: 2000 }, transport);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /16 letters and digits/);
  const status = await giftCardsOnCheck({ locationId: 'loc1', closedCheckId: 'chk-1' }, transport);
  assert.equal(status.cards.length, 1);
  const noToken = await issueGiftCardAtTill({ amountMinor: 2000 }, { ...transport, token: null });
  assert.equal(noToken.ok, false);
  const down = await issueGiftCardAtTill({ amountMinor: 2000 }, { ...transport, fetchImpl: async () => { throw new Error('offline'); } });
  assert.match(down.error, /offline/);
  assert.equal(plainError({}, 404), 'Card not found');
});

test('lines match the recorded cards in order by amount, so a retry never issues twice', () => {
  const lines = [{ ...gift, uid: 'a' }, { ...gift, uid: 'b', price: 10 }, { ...gift, uid: 'c' }];
  const cards = [{ card_id: 'c1', code_last4: '1111', type: 'load', amount_minor: 2000, balance_minor: 2000 }];
  const slots = giftLineSlots(lines, cards);
  assert.equal(slots.length, 3);
  assert.equal(slots[0].card?.card_id, 'c1', 'the first 20.00 line took the 20.00 card');
  assert.equal(slots[1].card, null);
  assert.equal(slots[2].card, null, 'the second 20.00 line still needs a card');
  assert.equal(giftActivationWords(null), 'Gift card not yet issued');
  assert.equal(giftActivationWords(cards[0]), 'Card ending 1111 loaded with 20.00');
  assert.equal(giftActivationWords({ code_last4: '5678', type: 'issue', amount_minor: 2000, balance_minor: 2000 }), 'New card ending 5678 printed, 20.00');
});

// ── wiring ───────────────────────────────────────────────────────────────────────────────────

test('wiring: the store action, the till button and modal, pay complete opens the activation, History shows the status', () => {
  const store = read('../store/index.js');
  assert.match(store, /addGiftCardLine: \(amountMinor\) =>/, 'store action beside addCustomItem');
  assert.match(store, /giftCardSaleLine\(minor, uid\(\)\)/, 'the one line shape');
  assert.match(store, /giftLinesTotal\(orderRecord\.items/, 'loyalty earn basis leaves the gift card out');
  assert.match(store, /if \(target && isNoDiscountLine\(target\)\) return;/, 'no item discount on a gift card');

  const till = read('../surfaces/POSSurface.jsx');
  // v5.11.120 (Peter): the button lives in the left bar under Orders and only when gift cards are on
  assert.ok(!/data-testid="sell-gift-card"/.test(till), 'no gift button in the top bar any more');
  assert.match(till, /useEffect\(\(\) => \{ if \(giftSaleRequest\) \{ setGiftAmount\(''\); setShowGift\(true\); \} \}, \[giftSaleRequest\]\);/, 'the picker opens on the left bar request');
  const app = read('../App.jsx');
  assert.match(app, /\{ id:'orders',  label:'Orders', icon:'orders' \},\n  \{ id:'gift',    label:'Gift',   icon:'gift' \}/, 'Gift sits right under Orders');
  assert.match(app, /if \(n\.id === 'gift' && giftCardsOn !== true\) return false;/, 'hidden unless the company has gift cards on');
  assert.match(app, /if \(n\.id === 'gift'\) \{ setSurface\('pos'\); requestGiftSale\(\); \}/, 'opens the picker on the POS');
  assert.match(store, /set\(\{ giftCardsOn: res\.ok && j\?\.enabled === true \}\)/, 'the switch is the public gift config');
  assert.match(till, /data-testid="gift-amount-modal"/, 'the amount picker');
  assert.match(till, /GIFT_CARD_PRESETS_MINOR\.map/, 'presets 10 20 25 50');
  assert.match(till, /addGiftCardLine\(m\)/, 'Add calls the store action');
  assert.match(till, /const soldGiftLines = giftLinesOf\(items\);/, 'the gift lines are read before the close');
  const pay = till.slice(till.indexOf('const handlePayComplete'), till.indexOf('const seatList = useMemo'));
  assert.ok(pay.indexOf('recordWalkInClosed(') < pay.indexOf('setGiftActivate({'), 'the modal opens AFTER the close has run');
  assert.match(pay, /closedCheckId: closed\?\.id/, 'with the closed check id the store assigned');
  assert.match(till, /<GiftActivateModal\s/, 'renders GiftActivateModal');
  assert.match(till, /data-testid="gift-line-no-vat"/, 'the order list shows no VAT on the line');
  assert.match(till, /items=\{items\.filter\(i=>!isNoDiscountLine\(i\)\)/, 'the discount picker never offers the gift line');

  const modal = read('../components/GiftActivateModal.jsx');
  assert.match(modal, /data-testid="gift-code-input"/, 'the code box');
  assert.match(modal, /data-testid="gift-print-new"/, 'Print new card');
  assert.match(modal, /GIFT_LATER_WARNING/, 'Later warns');
  assert.match(modal, /printService\.printGiftCardSlip\(/, 'prints the slip after issue');
  assert.match(modal, /giftCardsOnCheck\(/, 'asks what the check already recorded');
  assert.match(modal, /e\.key === 'Enter'/, 'a scanner types the code and presses Enter');

  const history = read('../components/CheckHistory.jsx');
  assert.match(history, /function GiftCardsCard\(/, 'History status card');
  assert.match(history, /giftCardsOnCheck\(\{ locationId/, 'History calls status');
  assert.match(history, /Gift card not yet issued/, 'History words for a pending card');
  assert.match(history, /data-testid="history-gift-code"/, 'History: Card code');
  assert.match(history, /data-testid="history-gift-print"/, 'History: Print new card');
  assert.match(history, /closedCheckId=\{selectedCheck\.id\}/, 'History reuses the modal with the stored check id');

  const printer = read('./printer.js');
  assert.match(printer, /async printGiftCardSlip\(\{ location, card, check \}, printerId = null, opts = \{\}\)/, 'printer transport');
  assert.match(printer, /reason: 'no-printer'/, 'fails closed');
  assert.match(printer, /buildGiftCardSlipDoc/, 'uses the slip doc');
});
