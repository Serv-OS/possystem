// discounts.parity.test.js: every channel takes off, books and reports the till's discounts (v5.11.78).
// Run: node --test src/lib/parity/discounts.parity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, SERVICE_DEVICE, ctxUK, basket } from './fixtures.js';
import { posLines, posTotals } from './pos.js';
import { computeCheckTotals } from '../payments/checkTotals.js';
import { evaluateAutoDiscounts, toAppliedDiscount } from '../discountEngine.js';
import { buildScheduleCtx } from '../scheduleCtx.js';
import { tabBill, tabCloseTax } from '../barTabTax.js';
import { headlessService } from '../headlessTax.js';
import { closedCheckRow } from '../closedCheckRow.js';
import { roundVat } from '../taxRule.js';
import { recordedDiscountMinor } from '../../../supabase/functions/_shared/tradingSales.js';
import { chargedShare } from '../../../supabase/functions/_shared/vatRederive.js';
import { readRepo, between } from './src.js';

const vat = (t) => roundVat(t?.totalTax);
const TZ = 'Europe/London';

// ── Automatic deals on a bar tab (confirmed major) ───────────────────────────────────────────────
test('bar tab: the venue\'s automatic deals run on a tab exactly as at the counter (meal deal 15.00 -> 12.00)', () => {
  const b = basket('auto-discount');
  const lines = posLines(b);
  const pos = posTotals({ ...b, orderType: 'dine-in' });
  const tab = { total: lines.reduce((s, l) => s + l.price * l.qty, 0), rounds: [{ items: lines }] };
  const bill = tabBill(tab, ctxUK(), [], { discountRules: RULES, timezone: TZ });
  assert.equal(bill.total, pos.total, 'the tab charges the counter\'s total');
  assert.deepEqual(bill.autoDiscounts, pos.autoDiscounts, 'and books the same deal line');
  const rec = tabCloseTax(lines, ctxUK(), { bill, paymentInfo: { grand: bill.total }, discountRules: RULES, timezone: TZ });
  assert.equal(rec.taxAmount, vat(pos.tax), 'VAT on what the tab charged');
  const bar = readRepo('src/surfaces/BarSurface.jsx');
  assert.match(bar, /discounts: bill\.autoDiscounts \|\| \[\],/);
  assert.match(bar, /discountRules: useStore\.getState\(\)\.discountRules,\n\s+timezone: useStore\.getState\(\)\.locationConfig\?\.timezone,/);
});

test('MPOS: the record written when a close fails after the card carries the deals the bill took off', () => {
  const m = readRepo('src/surfaces/MPOSSurface.jsx');
  assert.match(m, /\.\.\.evaluateAutoDiscounts\(items, st\.discountRules, 'pos', buildScheduleCtx\(st\.locationConfig\?\.timezone\)\)\.map\(toAppliedDiscount\)\],/);
});

// ── Reader closes, Table Pay and pay at table (minor; with a service charge money bug beside it) ──
test('reader close: a check booked from the frozen draft carries the deal lines and the service the bill charged', async () => {
  const { headlessDiscounts } = await import('../headlessTax.js');
  assert.equal(typeof headlessDiscounts, 'function');
  const b = { ...basket('auto-discount'), orderType: 'dine-in', covers: 4, device: 'service' };
  const items = posLines(b);
  const bill = posTotals(b);
  // A draft from the server (Table Pay, pay at table): manual discounts only, no service figure.
  const rpcDraft = { items, discounts: [], subtotalMinor: Math.round(bill.subtotal * 100), totalMinor: Math.round(bill.total * 100) };
  const discs = headlessDiscounts(rpcDraft, { discountRules: RULES, timezone: TZ });
  assert.deepEqual(discs, bill.autoDiscounts, 'the deal is booked, as the till\'s close books it');
  assert.equal(headlessService(rpcDraft, bill.tax, discs), Math.round(bill.service * 100) / 100, 'the 12.5% service charge, never 0.00 because the subtotal was before the deal');
  // A till draft since v5.11.78 freezes both.
  const tillDraft = { ...rpcDraft, autoDiscounts: bill.autoDiscounts, serviceMinor: Math.round(bill.service * 100) };
  assert.deepEqual(headlessDiscounts(tillDraft, { discountRules: [], timezone: TZ }), bill.autoDiscounts);
  assert.equal(headlessService(tillDraft, bill.tax), Math.round(bill.service * 100) / 100);
  const co = readRepo('src/surfaces/CheckoutModal.jsx');
  assert.match(co, /autoDiscounts: Array\.isArray\(billTax\?\.autoDiscounts\) \? billTax\.autoDiscounts : \[\],\n\s+serviceMinor: toMinor\(Number\(service\) \|\| 0\),/);
  const store = readRepo('src/store/index.js');
  assert.match(store, /items, discounts: \[\.\.\.stampDiscountAmounts\(items, headlessDiscs\), \.\.\.promoDiscountEntry\(d\.promoRedemption\)\],/);
});

// ── One promo basket (confirmed major) ───────────────────────────────────────────────────────────
test('promo code: the till checks and records a code on the goods after discounts, as online and the server do', async () => {
  const { promoBasketValue, promoRedeemBasket } = await import('../promoBasis.js');
  // A dine in bill with a 10% manual discount and a 12.5% service charge.
  const b = { ...basket('manual-discount'), covers: 2, device: 'service' };
  const t = posTotals(b);
  assert.ok(t.total > t.discountedSub, 'the bill carries the service charge');
  const tillBasis = promoBasketValue({ discountedSub: t.discountedSub, subtotal: t.subtotal });
  const onlineBasis = t.discountedSub;   // OnlineCheckout: subtotal less offers; the server: goods less auto
  assert.equal(tillBasis, +onlineBasis.toFixed(2));
  // Round 1 fix: the applied promo is built the way CheckoutModal builds it (heldPromo, from the
  // promo-redeem answer), never by hand, so the name the checkout stores is the name the redeem reads.
  const { heldPromo } = await import('../promoBasis.js');
  const validate = { valid: true, code_id: 'c1', offer: { id: 'o1', name: '10% off' }, discount: { type: 'percent', value: 10, amount: +(tillBasis * 0.1).toFixed(2), label: '10% off' } };
  const held = heldPromo('X', validate, tillBasis);
  assert.notEqual(t.subtotal, tillBasis, 'the record\'s subtotal is before the discount');
  assert.equal(promoRedeemBasket(held, { subtotal: t.subtotal }), tillBasis, 'the redeem records the figure it was checked on');
  assert.equal(held.amount, validate.discount.amount);
  assert.equal(promoRedeemBasket({ code: 'X', basis: tillBasis }, { subtotal: t.subtotal }), tillBasis, 'a promo held under the round 0 name still records its basket');
  assert.equal(promoRedeemBasket({ code: 'X' }, { subtotal: t.subtotal }), +t.subtotal.toFixed(2), 'an older held promo with none: the record\'s subtotal');
  const co = readRepo('src/surfaces/CheckoutModal.jsx');
  assert.match(co, /basket: \{ subtotal: promoBasis \},/);
  assert.match(co, /setPromoApplied\(heldPromo\(code, data, promoBasis\)\);/);
  assert.doesNotMatch(co, /basis: promoBasis/, 'one name for the held basket');
  assert.doesNotMatch(co, /basket: \{ subtotal: total \}/, 'never the bill with service and tax in it');
  assert.match(readRepo('src/store/index.js'), /basketValue: promoRedeemBasket\(promo, record\),/);
});

// v5.11.81 (Peter, 19 Oct 2026: "kiosk yes"): the kiosk checked a code on the goods before its
// deals (new design) or on the grand total with the tip in it (old design), and recorded it on the
// goods before the deals. Inside the signed card path: only the promo figure moved (kioskCardPathGuard).
test('promo code on the kiosk: both designs check, value and record a code on the till\'s basket (goods after the deals)', async () => {
  const { promoBasketValue } = await import('../promoBasis.js');
  const { kioskPromoBasket } = await import('../kioskCheckout.js');
  const { computeDiscount } = await import('../../../supabase/functions/_shared/promo.ts');
  const b = basket('auto-discount');   // 15.00 of goods, the meal deal makes it 12.00
  const t = posTotals(b);
  const till = promoBasketValue({ discountedSub: t.discountedSub, subtotal: t.subtotal });
  assert.equal(till, 12);
  // The kiosk's own figures (KioskApp totals: subtotal less its deals on the kiosk channel).
  const kioskLines = posLines(b).map((l, i) => ({ uid: `k${i}`, cat: l.cat, cats: l.cats || null, price: l.price, qty: l.qty }));
  const kioskSub = kioskLines.reduce((s0, l) => s0 + l.price * l.qty, 0);
  const kioskDeals = evaluateAutoDiscounts(kioskLines, RULES, 'kiosk', buildScheduleCtx(TZ)).map(toAppliedDiscount).reduce((s0, d) => s0 + d.value, 0);
  const discountedSubtotal = Math.max(0, +(kioskSub - kioskDeals).toFixed(2));
  assert.equal(kioskPromoBasket(discountedSubtotal), till, 'the kiosk checks the code on the till\'s 12.00, never 15.00');
  const tenPct = { reward_type: 'percent', reward_value: 10 };
  assert.equal(computeDiscount(tenPct, kioskPromoBasket(discountedSubtotal)).amount, 1.2, '10% takes 1.20 off at the kiosk, as at the till');
  assert.equal(computeDiscount(tenPct, till).amount, 1.2);
  // The old design's code box, the new design's code box and re-check, and submitOrder's redeem.
  const k = readRepo('src/surfaces/KioskApp.jsx');
  assert.match(k, /basket: \{ subtotal: promoBasket \},/);
  assert.doesNotMatch(k, /basket: \{ subtotal: total \}/, 'never the grand total with the tip in it');
  assert.match(k, /<ScreenGiftPromo brandColor=\{brandColor\} total=\{grandTotal\} promoBasket=\{promoBasketValue\(\{ discountedSub: discountedSubtotal \}\)\}/);
  const submit = between(k, 'const submitOrder = useCallback(async (nameOverride, phoneOverride, cardPayment) => {', 'tableNumber, resetSession]);');
  assert.match(submit, /basketValue: promoBasketValue\(\{ discountedSub: discountedSubtotal \}\),/);
  assert.doesNotMatch(submit, /basketValue: subtotal,/);
  const v2 = readRepo('src/surfaces/kiosk/useKioskCheckout.js');
  assert.match(v2, /const promoBasket = kioskPromoBasket\(discountedSubtotal\);/);
  assert.equal((v2.match(/api\.validatePromo\(\{ code, locationId, customerId, subtotal: promoBasket \}\)/g) || []).length, 2, 'the code box and the re-check');
  assert.doesNotMatch(v2, /customerId, subtotal \}\)/);
});

// ── One promo record (confirmed major: counted twice on the till, VAT wrong on catering) ──────────
test('promo code: counted once in every report, whichever channel took it (moneyDiscounts)', () => {
  const lines = [{ uid: 'a', itemId: 'burger', price: 18, qty: 1 }];
  const promoTender = { method: 'promo', amount: 5, tip: 0 };
  const card = (amt) => ({ method: 'card', amount: amt, tip: 0 });
  const till = { items: lines, subtotal: 18, total: 18, discounts: [{ source: 'promo', code: 'P5', type: 'amount', value: 5, amount: 5 }], tenders: [promoTender, card(13)] };
  const kiosk = { items: lines, subtotal: 18, total: 13, discounts: [], tenders: [promoTender, card(13)], promo: { code: 'P5', discount_value: 5 } };
  const online = { items: lines, subtotal: 18, total: 13, discounts: [], tenders: [promoTender, card(13)] };
  const catering = { items: lines, subtotal: 18, total: 13, discounts: [{ type: 'promo', source: 'promo', code: 'P5', amount: 5 }], tenders: [promoTender, card(13)] };
  const counted = [till, kiosk, online, catering].map(recordedDiscountMinor);
  assert.deepEqual(counted, [0, 0, 0, 0], 'a promo paid as a tender is never also a discount');
  const shares = [till, kiosk, online, catering].map((r) => chargedShare(r, lines).share);
  assert.deepEqual(shares, [1, 1, 1, 1], 'the daily VAT check books VAT on the goods, as the till does');
  // A row with no promo tender (older rows) keeps every line.
  assert.equal(recordedDiscountMinor({ discounts: [{ source: 'promo', amount: 5 }], tenders: [card(13)] }), 500);
  const cat = readRepo('src/surfaces/catering/CateringCheckout.jsx');
  assert.match(cat, /tenders: finishTenders\(\[tender\('promo', discount\), tender\('card', Math\.max\(0, total - tip\), tip, \{ pspRef: payId, processor \}\)\]\),/);
});

// ── A percent discount's stored amount (confirmed major) ─────────────────────────────────────────
test('a percent discount stores what the bill took off on the lines it closed with, on every writer', () => {
  const items = [{ uid: 'a', itemId: 'coffee', price: 3.7, qty: 1 }, { uid: 'b', itemId: 'cake', price: 4.4, qty: 1 }];
  const t = computeCheckTotals({ items, checkDiscounts: [{ type: 'percent', value: 10 }], covers: 1, orderType: 'dine-in' });
  const row = closedCheckRow({ id: 'c', items, discounts: [
    { id: 'd1', label: 'Custom 10%', type: 'percent', value: 10, amount: 0.37, scope: 'check' },   // applied at 3.70
    { id: 'd2', label: 'Manager 10%', type: 'percent', value: 10, appliedBy: 'MPOS' },             // MPOS: no amount
    { type: 'amount', value: 1, isAuto: true, appliedItems: [] },                                   // a deal: as charged
    { source: 'promo', code: 'P', type: 'percent', value: 10, amount: 0.5 },                         // promo: the server's figure
  ] }, 'loc');
  assert.equal(Math.round(row.discounts[0].amount * 100) / 100, Math.round(t.checkDiscount * 100) / 100, '0.81, never the stale 0.37');
  assert.equal(Math.round(row.discounts[1].amount * 100) / 100, 0.81, 'MPOS reads 0.81, never 10.00');
  assert.equal(row.discounts[2].amount, undefined, 'a deal line is left as it is');
  assert.equal(row.discounts[3].amount, 0.5, 'a promo keeps the server\'s figure');
  assert.match(readRepo('src/surfaces/POSSurface.jsx'), /money\(checkDiscountAmount\(d, subtotal\)\)/);
  assert.match(readRepo('src/surfaces/mpos/MOrderActions.jsx'), /label: d\.label, type: d\.type, value: d\.value, scope: 'check',/);
});

// ── Automatic deals reach an item through its "Also in" category on every channel (round 1) ──────
test('automatic deals: an item in the deal only through its "Also in" category gets the deal on the till and a bar tab, as on the kiosk, online, QR and the server', async () => {
  const { lineCategories } = await import('../lineCategories.js');
  const { MENU, raw } = await import('./fixtures.js');
  const b = { id: 'cats', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'wrap', qty: 1 }, { itemId: 'fries', qty: 1 }, { itemId: 'coke', qty: 1 }] };
  const till = posLines(b);
  assert.deepEqual(till[0].cats, ['mains'], 'the till line carries the item\'s Also in categories');
  const save = (lines, ch) => evaluateAutoDiscounts(lines, RULES, ch, buildScheduleCtx(TZ)).map(toAppliedDiscount).reduce((s0, d) => s0 + d.value, 0);
  const pos = save(till, 'pos');
  assert.equal(pos, 2, '14.00 of goods for the 12.00 meal deal');
  assert.equal(posTotals(b).total, 12);
  // a bar tab round builds the same line (tillLine.js), so its bill takes the same deal
  const tab = tabBill({ total: 14, rounds: [{ items: till }] }, ctxUK(), [], { discountRules: RULES, timezone: TZ });
  assert.equal(tab.total, 12);
  // the online and QR page line (OnlineSurface addToCart) and catering's: lineCategories over the raw rows
  const page = b.lines.map((l, i) => ({ uid: `p${i}`, ...lineCategories(raw(l.itemId), MENU), price: till[i].price, qty: 1 }));
  // the kiosk line: l.item is the product row (KioskApp autoDiscounts)
  const kiosk = b.lines.map((l, i) => ({ uid: `k${i}`, cat: raw(l.itemId).cat, cats: raw(l.itemId).cats || null, price: till[i].price, qty: 1 }));
  assert.deepEqual({ online: save(page, 'online'), qr: save(page, 'qr'), kiosk: save(kiosk, 'kiosk') }, { online: pos, qr: pos, kiosk: pos });
  const store = readRepo('src/store/index.js');
  assert.match(store, /cat: tillLineCat\(item, useStore\.getState\(\)\.menuItems\),\n(?:\s*\/\/.*\n)*\s*\.\.\.tillLineCats\(item, useStore\.getState\(\)\.menuItems\),/);
  assert.match(readRepo('src/surfaces/BarSurface.jsx'), /\.\.\.tillLineCats\(item, storeMenuItems \|\| \[\]\),/);
});

test('automatic deals: a size counts under its product\'s categories on the till, the kiosk, the online and QR page, catering and the server', async () => {
  const { lineCategories } = await import('../lineCategories.js');
  const { MENU, raw } = await import('./fixtures.js');
  // the size row still says Cold; its product is a Main, so the meal deal counts it
  const b = { id: 'size-cat', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'pie-big', qty: 1 }, { itemId: 'fries', qty: 1 }, { itemId: 'coke', qty: 1 }] };
  const till = posLines(b);
  assert.equal(till[0].cat, 'mains');
  const save = (lines, ch) => evaluateAutoDiscounts(lines, RULES, ch, buildScheduleCtx(TZ)).map(toAppliedDiscount).reduce((s0, d) => s0 + d.value, 0);
  const pos = save(till, 'pos');
  assert.equal(pos, 4, '16.00 of goods for the 12.00 meal deal');
  const page = b.lines.map((l, i) => ({ uid: `p${i}`, ...lineCategories(raw(l.itemId), MENU), price: till[i].price, qty: 1 }));
  assert.equal(page[0].cat, 'mains', 'the page reads the product\'s category, never the size row\'s stale one');
  const product = (id) => (raw(id).parent_id ? raw(raw(id).parent_id) : raw(id));
  const kiosk = b.lines.map((l, i) => ({ uid: `k${i}`, cat: product(l.itemId).cat, cats: product(l.itemId).cats || null, price: till[i].price, qty: 1 }));
  assert.deepEqual({ online: save(page, 'online'), qr: save(page, 'qr'), kiosk: save(kiosk, 'kiosk') }, { online: pos, qr: pos, kiosk: pos });
  assert.match(readRepo('src/surfaces/online/OnlineSurface.jsx'), /\.\.\.lineCategories\(item, items\),\n\s+parentId: item\.parent_id \|\| item\.parentId \|\| null,/);
  assert.match(readRepo('src/surfaces/catering/CateringSurface.jsx'), /\.\.\.lineCategories\(item, items\), parentId: item\.parent_id \|\| null,/);
  // the server values public orders with the same rule (_public_order_value lines -> _public_order_auto)
  const sql = readRepo('supabase/migrations/20261019a_OPS_channel_parity.sql');
  const fn = between(sql, 'CREATE OR REPLACE FUNCTION public._public_order_value(', '$function$;');
  assert.match(fn, /'cat', case when p\.id is not null and coalesce\(p\.cat, ''\) <> '' then p\.cat else r\.cat end,/);
  assert.match(fn, /'cats', to_jsonb\(coalesce\(case when p\.id is not null and coalesce\(p\.cat, ''\) <> '' then p\.cats else r\.cats end, '\{\}'::text\[\]\)\),/);
});

// ── Automatic deals are the same on the till, kiosk, online and QR (regression guard) ─────────────
test('regression: the meal deal saves the same on the till, kiosk, online and QR pay now', () => {
  const b = basket('auto-discount');
  const lines = posLines(b);
  const save = (ch) => evaluateAutoDiscounts(lines, RULES, ch, buildScheduleCtx(TZ)).map(toAppliedDiscount).reduce((s, d) => s + d.value, 0);
  const pos = save('pos');
  assert.equal(pos, 3);
  for (const ch of ['kiosk', 'online', 'qr']) assert.equal(save(ch), pos, ch);
  assert.equal(SERVICE_DEVICE.serviceCharge.rate, 12.5);
});
