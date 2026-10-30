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
  assert.match(bar, /discounts: \[\.\.\.stampDiscountAmounts\(allItems, manualDiscounts\), \.\.\.\(bill\.autoDiscounts \|\| \[\]\)\],/);
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
  assert.match(co, /basket: \{ subtotal: promoBasis, lines, delivery_fee: Number\(deliveryFee\) \|\| 0 \},/);   // v5.11.81: + the lines
  assert.match(co, /setPromoApplied\(heldPromo\(code, data, promoBasis, lines, Number\(deliveryFee\) \|\| 0\)\);/);
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
  assert.match(k, /basket: \{ subtotal: promoBasket, \.\.\.\(Array\.isArray\(promoLines\) \? \{ lines: promoLines \} : \{\}\) \},/);
  assert.doesNotMatch(k, /basket: \{ subtotal: total \}/, 'never the grand total with the tip in it');
  assert.match(k, /<ScreenGiftPromo brandColor=\{brandColor\} total=\{grandTotal\} promoBasket=\{promoBasketValue\(\{ discountedSub: discountedSubtotal \}\)\}/);
  const submit = between(k, 'const submitOrder = useCallback(async (nameOverride, phoneOverride, cardPayment) => {', 'tableNumber, resetSession]);');
  assert.match(submit, /basketValue: promoBasketValue\(\{ discountedSub: discountedSubtotal \}\),/);
  assert.doesNotMatch(submit, /basketValue: subtotal,/);
  const v2 = readRepo('src/surfaces/kiosk/useKioskCheckout.js');
  assert.match(v2, /const promoBasket = kioskPromoBasket\(discountedSubtotal\);/);
  assert.equal((v2.match(/api\.validatePromo\(\{ code, locationId, customerId, subtotal: promoBasket, lines: promoLines \}\)/g) || []).length, 2, 'the code box and the re-check');
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
  // v5.11.81: shown capped at what is left of the bill (shownCheckDiscounts), never the typed value.
  assert.match(readRepo('src/surfaces/POSSurface.jsx'), /money\(shownDisc\[di\]\)/);
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

// v5.11.81 (confirmed minor): the till's discount line shows what the bill takes off.
test('the till discount line shows the capped value: 10.00 off a 6.00 bill reads -6.00, as the bill takes', async () => {
  const { shownCheckDiscounts } = await import('../taxBasis.js');
  assert.deepEqual(shownCheckDiscounts([{ type: 'amount', value: 10 }], 6), [6]);
  assert.deepEqual(shownCheckDiscounts([{ type: 'percent', value: 10 }, { type: 'amount', value: 20 }], 15), [1.5, 13.5], 'in order, never past the bill');
  assert.deepEqual(shownCheckDiscounts([{ type: 'amount', value: 2 }], 6), [2], 'a discount inside the bill is shown as typed');
  const t = computeCheckTotals({ items: [{ uid: 'a', itemId: 'x', price: 6, qty: 1 }], checkDiscounts: [{ type: 'amount', value: 10 }], covers: 1, orderType: 'takeaway' });
  assert.equal(t.discountedSub, 0, 'the bill takes 6.00');
});

// ── A QR tab's record carries the deals each round took (v5.11.81, partly fixed major) ───────────
test('QR tab: every close books the deal lines the server applied to each round, summed per rule (settle on the server too)', async () => {
  const { qrTabDealLines } = await import('../headlessTax.js');
  const rounds = [
    { customer: { order_pricing: { goods_minor: 1500, auto_minor: 300, auto_rules: [{ rule_id: 'r-meal', name: 'Meal deal', saving_minor: 300 }] } } },
    { customer: { order_pricing: { goods_minor: 1500, auto_minor: 300, auto_rules: [{ rule_id: 'r-meal', name: 'Meal deal', saving_minor: 300 }] } } },
    { customer: {} },   // a round an old page placed: nothing to add
  ];
  const lines = qrTabDealLines(rounds);
  assert.deepEqual(lines, [{ id: 'r-meal', label: 'Meal deal', type: 'amount', value: 6, amount: 6, scope: 'check', isAuto: true, source: 'auto' }]);
  // The same deal line the till books for the meal deal (toAppliedDiscount), counted once in reports.
  const pos = posTotals(basket('auto-discount'));
  assert.equal(pos.autoDiscounts[0].value * 2, lines[0].value);
  assert.equal(recordedDiscountMinor({ discounts: lines, tenders: [{ method: 'card', amount: 24, tip: 0 }] }), 600);
  assert.deepEqual(qrTabDealLines([]), []);
  for (const f of ['src/surfaces/OrdersHub.jsx', 'src/surfaces/qr/TabResumeScreen.jsx', 'src/lib/orderPayment.js']) {
    assert.doesNotMatch(between(readRepo(f), 'foldLineMods(', 'subtotal'), /discounts: \[\],/, `${f}: never an empty deal list`);
  }
  assert.equal((readRepo('src/surfaces/OrdersHub.jsx').match(/discounts: qrTabDealLines\(/g) || []).length, 2);
  const sql = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
  const settle = between(sql, 'CREATE OR REPLACE FUNCTION public.settle_qr_tab(', '$function$;');
  assert.match(settle, /'discounts', v_deals,/);
  assert.doesNotMatch(settle, /'discounts', '\[\]'::jsonb,/);
});

// ── An ezCater order changed after it was booked (v5.11.81, confirmed minor) ─────────────────────
test('ezCater: a changed order voids its booking and books a new revision (never an in place edit the stock trigger holds); the same order again books nothing', async () => {
  const { ezcaterClosedCheck, ezcaterSalePlan, ezcaterLiveRevisionIds } = await import('../../../supabase/functions/_shared/ezcaterCatering.js');
  const row = (qty) => ({
    ref: 'EZ-7', location_id: 'L', type: 'collection', event_date: '2026-11-02', collection_time: '12:00',
    items: [{ name: 'Box lunch', qty, price: 12, lineSubunits: 1200 * qty }],
    customer: { channel: 'ezcater', ezcater_lifecycle: 'accepted', ezcater_order_id: 'u-7', catererReceivesTip: true, catererReceivesDeliveryFee: true,
      totals: { subtotal: 12 * qty, tip: 0, deliveryFee: 0, feesAndDiscounts: [{ name: 'Promo', amount: -5 }] }, tax: { salesTax: 0.87 * qty, salesTaxRemittance: 0 } },
  });
  const first = ezcaterClosedCheck(row(10), { venueTz: 'America/Denver' });
  assert.deepEqual(first.discounts.map((d) => [d.source, d.amount]), [['channel', 5]], 'ezCater discounts are booked as discount lines');
  const p1 = ezcaterSalePlan(first, []);
  assert.equal(p1.action, 'insert');
  assert.equal(p1.row.id, 'chk-ez-u-7');
  const booked = [{ ...p1.row, status: 'paid' }];
  assert.deepEqual(ezcaterSalePlan(ezcaterClosedCheck(row(10), { venueTz: 'America/Denver' }), booked), { action: 'none' }, 'the same order sent again books nothing');
  const changed = ezcaterSalePlan(ezcaterClosedCheck(row(12), { venueTz: 'America/Denver' }), booked);
  assert.equal(changed.action, 'amend');
  assert.deepEqual(changed.voidIds, ['chk-ez-u-7']);
  assert.equal(changed.row.id, 'chk-ez-u-7-r2', 'a new revision, never the booked row re-written');
  const after = [{ ...booked[0], status: 'voided', voided: true }, { ...changed.row, status: 'paid' }];
  assert.equal(ezcaterSalePlan(ezcaterClosedCheck(row(14), { venueTz: 'America/Denver' }), after).row.id, 'chk-ez-u-7-r3');
  assert.deepEqual(ezcaterLiveRevisionIds('chk-ez-u-7', after), ['chk-ez-u-7-r2'], 'a cancel voids the live revision');
  assert.deepEqual(ezcaterLiveRevisionIds('chk-ez-u-7', [{ id: 'chk-ez-u-70', status: 'paid' }]), [], 'never another order whose id starts the same');
});

// ── Bar tabs take a manual discount, as the counter does (v5.11.81, confirmed minor) ──────────────
test('bar tab: a manual 10% discount on the tab charges, taxes and records what the counter does for the same lines', () => {
  const b = { ...basket('manual-discount') };   // 2 burgers, 10% off (dine in at the counter)
  const lines = posLines(b);
  const pos = posTotals(b);
  const tab = { id: 't1', total: lines.reduce((s0, l) => s0 + l.price * l.qty, 0), rounds: [{ items: lines }] };
  const bill = tabBill(tab, ctxUK(), [], { discountRules: RULES, timezone: TZ, checkDiscounts: b.checkDiscounts });
  assert.equal(bill.total, pos.total, 'the tab charges 16.20, as the counter');
  assert.equal(bill.checkDiscount, 1.8);
  const rec = tabCloseTax(lines, ctxUK(), { bill, paymentInfo: { grand: bill.total }, discountRules: RULES, timezone: TZ, checkDiscounts: b.checkDiscounts });
  assert.equal(rec.taxAmount, vat(pos.tax), 'VAT on what the tab charged');
  // No discount: the bill is exactly what it was.
  assert.equal(tabBill(tab, ctxUK(), [], { discountRules: RULES, timezone: TZ }).total, 18);
  const bar = readRepo('src/surfaces/BarSurface.jsx');
  assert.match(bar, /checkDiscounts: \(useStore\.getState\(\)\.barTabDiscounts \|\| \{\}\)\[tab\?\.id\] \|\| \[\],/);
  assert.match(bar, /discounts: \[\.\.\.stampDiscountAmounts\(allItems, manualDiscounts\), \.\.\.\(bill\.autoDiscounts \|\| \[\]\)\],/);
  assert.match(bar, /<DiscountModal\n\s+items=\{tabItems\}\n\s+subtotal=\{goods\}\n\s+checkOnly/);
  const store = readRepo('src/store/index.js');
  assert.match(store, /addTabDiscount: \(tabId, discount\) => \{/);
  assert.match(store, /const d = scrubDiscount\(discount\);/, 'the manager is a name tag, never the staff record');
});

// ── A promo code follows its own offer rules on every channel (v5.11.81, confirmed minor) ────────
test('promo code: an offer for some categories, a free item, free delivery and bonus points work the same on the till, kiosk, online, catering and the server', async () => {
  const { promoDiscountForBasket, promoBasketLines } = await import('../../../supabase/functions/_shared/promoMath.js');
  const { computeDiscount } = await import('../../../supabase/functions/_shared/promo.ts');
  // A till basket: 2 lattes (coffee, 3.20 each) and a toastie (food, 6.60), no deals: 13.00.
  const till = [
    { uid: 'a', itemId: 'latte', cat: 'coffee', price: 3.2, qty: 2 },
    { uid: 'b', itemId: 'toastie', cat: 'food', price: 6.6, qty: 1 },
  ];
  const lines = promoBasketLines(till);
  const off = (offer) => promoDiscountForBasket(offer, { subtotal: 13, lines, deliveryFee: 2.5 }).amount;
  assert.equal(off({ reward_type: 'percent', reward_value: 20, include_category_ids: ['coffee'] }), 1.28, '20% of the coffee only, never of the toastie');
  assert.equal(off({ reward_type: 'percent', reward_value: 20, exclude_category_ids: ['coffee'] }), 1.32);
  assert.equal(off({ reward_type: 'free_item', reward_value: 0, reward_item_id: 'latte' }), 3.2, 'one latte free');
  assert.equal(promoDiscountForBasket({ reward_type: 'free_item', reward_item_id: 'cake' }, { subtotal: 13, lines }).missing, true, 'not in the basket: said, never "applied" for nothing');
  assert.equal(off({ reward_type: 'free_delivery' }), 2.5, 'the delivery fee');
  assert.equal(promoDiscountForBasket({ reward_type: 'points_bonus', reward_value: 50 }, { subtotal: 13, lines }).points, 50);
  // A size of the free item counts, at its own price.
  assert.equal(promoDiscountForBasket({ reward_type: 'free_item', reward_item_id: 'latte' }, { subtotal: 4, lines: [{ itemId: 'latte-l', parentId: 'latte', cat: 'coffee', price: 4, qty: 1 }] }).amount, 4);
  // No rule and no lines: exactly the old figures (promo.ts computeDiscount on a subtotal).
  for (const o of [{ reward_type: 'percent', reward_value: 10 }, { reward_type: 'fixed', reward_value: 5 }, { reward_type: 'free_item', reward_value: 0, reward_item_id: 'latte' }]) {
    assert.deepEqual({ ...computeDiscount(o, 13) }, { ...promoDiscountForBasket(o, { subtotal: 13 }) });
  }
  assert.equal(computeDiscount({ reward_type: 'percent', reward_value: 10 }, 12.35).amount, 1.24, 'pounds, rounded once, as before');
  // A page line keeps its options apart; the basket line folds them in, as the server values a line.
  assert.deepEqual(promoBasketLines([{ itemId: 'latte', cat: 'coffee', price: 3.2, qty: 1, mods: [{ price: 0.5 }] }], { modsInPrice: false })[0].price, 3.7);
  // Every channel sends its lines; the server's public order maths is the same, in pence (20261020a).
  assert.match(readRepo('src/surfaces/CheckoutModal.jsx'), /const lines = promoBasketLines\(items\);/);
  assert.match(readRepo('src/surfaces/KioskApp.jsx'), /promoLines=\{promoBasketLines\(cart\)\}/);
  assert.match(between(readRepo('src/surfaces/KioskApp.jsx'), 'const submitOrder = useCallback(', 'tableNumber, resetSession]);'), /basketLines: promoBasketLines\(cart\),/);
  assert.match(readRepo('src/surfaces/kiosk/useKioskCheckout.js'), /const promoLines = useMemo\(\(\) => promoBasketLines\(cart\), \[cart\]\);/);
  assert.equal((readRepo('src/surfaces/online/OnlineCheckout.jsx').match(/promoBasketLines\(cart, \{ modsInPrice: false \}\)/g) || []).length, 2);
  assert.equal((readRepo('src/surfaces/catering/CateringCheckout.jsx').match(/promoBasketLines\(cart, \{ modsInPrice: false \}\)/g) || []).length, 2);
  assert.match(readRepo('src/store/index.js'), /basketLines: Array\.isArray\(promo\.basketLines\) \? promo\.basketLines : null,/);
  const fn = readRepo('supabase/functions/promo-redeem/index.ts');
  assert.match(fn, /const discount = computeDiscountForBasket\(offer, \{/);
  assert.match(fn, /if \(\(discount as any\)\.missing\) return \{ reason: 'free_item_not_in_basket' as const/);
  const sql = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
  const promoFn = between(sql, 'CREATE OR REPLACE FUNCTION public._public_order_promo(', '$function$;');
  assert.match(promoFn, /p_lines jsonb DEFAULT NULL::jsonb, p_delivery_minor bigint DEFAULT 0\)/);
  assert.match(promoFn, /when 'free_delivery' then greatest\(0, coalesce\(p_delivery_minor, 0\)\) \/ 100\.0/);
  assert.match(sql, /drop function if exists public\._public_order_promo\(text, text, bigint, text, boolean\);/);
  assert.equal((between(sql, 'CREATE OR REPLACE FUNCTION public.place_public_order(', '$function$;').match(/v_check_id, (false|true), v_val -> 'lines',/g) || []).length, 2);
  // Bonus points are credited with the sale (loyalty-earn reads the check's own promo line).
  const earn = readRepo('supabase/functions/loyalty-earn/index.ts');
  assert.match(earn, /const codes = promoCodesOnCheck\(check as any\);/);
  assert.match(earn, /pointsEarned \+= promoBonus;/);
});

// ── v5.11.81 round 1 fix: a QR tab close with a deal reports the same net sales as QR pay now ────────
// Each round's money is already after its deal. The tab closes booked the deal lines on a subtotal
// worked out from that money, and reports (salesStats, report_day_sums) take net = subtotal less
// discounts, so the deal came off twice. 2 pizzas at 10.00, a 5.00 deal, 15.00 charged: net 10 on
// every tab close, 15 on QR pay now. The deal total now goes back onto the subtotal.
test('QR tab close with a deal: net sales equal the same sale paid now (every close path)', async () => {
  const { computeSalesStats } = await import('../salesStats.js');
  const { qrTabDealLines, qrTabCloseFields, qrGrossSubtotal } = await import('../headlessTax.js');
  const { shortTabClosedCheck } = await import('../orderPayment.js');
  const items = [{ id: 'p', name: 'Pizza', price: 10, qty: 2, mods: [] }];
  const round = { ref: 'QR-1', location_id: 'L', total: 15, items,
    customer: { tip: 0, service_charge: 0, order_pricing: { goods_minor: 2000, auto_minor: 500, value_minor: 1500,
      auto_rules: [{ rule_id: 'r1', name: '2 for 15', saving_minor: 500 }] } } };
  const deals = qrTabDealLines([round]);
  const net = (c) => computeSalesStats([{ total: 15, taxAmount: 2.5, status: 'paid', service: 0, tip: 0, ...c }]).net;
  const payNow = net({ subtotal: 20, discounts: [{ value: 5, amount: 5 }] });
  assert.equal(payNow, 15);
  // The phone's close (TabResume) and the till's two Orders closes, through the shared rule.
  const vat = qrTabCloseFields([round], 15, {});
  assert.equal(net({ subtotal: qrGrossSubtotal(vat.subtotal, deals), discounts: deals }), payNow, 'TabResume close');
  assert.equal(net({ subtotal: qrGrossSubtotal(15, deals), discounts: deals }), payNow, 'Orders force close');
  // The till's short close, the real writer.
  const sc = shortTabClosedCheck({ rows: [round], allItems: items, firstRow: round, payment_intent_id: 'PSP_X', processor: 'adyen' },
    { paidMinor: 1500, dueMinor: 1500 }, { taxFor: () => ({ taxAmount: 2.5, exclusiveTax: 0 }) });
  assert.equal(sc.subtotal, 20);
  assert.equal(net({ subtotal: sc.subtotal, discounts: sc.discounts }), payNow, 'short close');
  // No deal: the subtotal is exactly what it was.
  assert.equal(qrGrossSubtotal(12.5, []), 12.5);
  // Wiring: every writer adds the deals back, and so does settle_qr_tab on the server.
  const hub = readRepo('src/surfaces/OrdersHub.jsx');
  assert.match(hub, /subtotal: qrGrossSubtotal\(tab\.total - tabTip - tabService - qrTax\.exclusiveTax, qrTabDealLines\(tab\.rows\)\),/);
  assert.match(hub, /subtotal: qrGrossSubtotal\(\(Number\(o\.total\) \|\| 0\) - qrTip - qrService - qrTax\.exclusiveTax, qrTabDealLines\(\[o\]\)\),/);
  assert.match(readRepo('src/surfaces/qr/TabResumeScreen.jsx'), /subtotal: qrGrossSubtotal\(vat\.subtotal, qrTabDealLines\(rounds\)\),/);
  const sql = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
  assert.match(sql, /'subtotal', greatest\(0, v_booked - v_tip - v_added - v_service\) \+ v_deal_total,/);
  assert.match(sql, /select coalesce\(sum\(public\._fence_num_or_null\(d ->> 'amount'\)\), 0\)\n\s+into v_deal_total\n\s+from jsonb_array_elements\(v_deals\) d;/);
});
