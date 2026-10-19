// charges.parity.test.js: service charges, tips, delivery fees and booking money follow the till (v5.11.78).
// Run: node --test src/lib/parity/charges.parity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, SERVICE_DEVICE, STORE_MENU, ctxUK, basket } from './fixtures.js';
import { posLines, posTotals } from './pos.js';
import { computeCheckTotals, sessionTotalsMinor } from '../payments/checkTotals.js';
import { headlessService, qrTabCloseFields } from '../headlessTax.js';
import { recordCheckBasis, creditDiscountsFromPayment } from '../taxBasis.js';
import { tendersFromPaymentInfo } from '../accounting/tenders.js';
import { roundVat } from '../taxRule.js';
import { readRepo, between } from './src.js';

const TZ = 'Europe/London';

// ── Counter eat in service charge (confirmed major: charged, booked as goods) ─────────────────────
test('counter eat in: the service charge the checkout charged is booked as service, as the reader close books it', () => {
  const items = posLines(basket('service-charge'));
  const bill = computeCheckTotals({ items, checkDiscounts: [], covers: 1, orderType: 'dine-in', deviceConfig: SERVICE_DEVICE, discountRules: RULES, timezone: TZ, taxCtx: ctxUK() });
  assert.ok(bill.service > 0, 'a walk in eat in sale on a profile with a service charge is charged it');
  const modal = roundVat(bill.service);   // recordWalkInClosed books paymentInfo.service, rounded once
  const reader = headlessService({ serviceMinor: Math.round(bill.service * 100), subtotalMinor: Math.round(bill.subtotal * 100), totalMinor: Math.round(bill.total * 100) }, bill.tax);
  assert.equal(modal, reader);
  const store = readRepo('src/store/index.js');
  assert.match(between(store, 'recordWalkInClosed: (walkInOrder', 'refundCheck: async'), /service: \(paymentInfo\.service != null && Number\.isFinite\(Number\(paymentInfo\.service\)\)\) \? \(roundVat\(Number\(paymentInfo\.service\)\) \?\? 0\) : 0,/);
  const co = readRepo('src/surfaces/CheckoutModal.jsx');
  assert.equal((co.match(/service: Number\.isFinite\(Number\(service\)\) \? Number\(service\) : 0,/g) || []).length, 2, 'both closes hand over the service charged');
});

// ── MPOS charges the till's bill (confirmed major, with the MPOS discount blocker beside it) ──────
test('MPOS: the handheld charges, shows and prints the till\'s bill (discounts, deals, service, added on tax)', () => {
  for (const f of ['src/surfaces/mpos/MTender.jsx', 'src/surfaces/mpos/MCartSheet.jsx']) {
    const src = readRepo(f);
    assert.match(src, /getPOSTotals\(\)/, f);
    assert.doesNotMatch(src, /i\.discount\.value \/ 100\) : base/, `${f}: an amount discount is never read as a percent`);
  }
  assert.match(readRepo('src/surfaces/mpos/MTableView.jsx'), /return computeCheckTotals\(\{\n\s+items, checkDiscounts: session\.discounts \|\| \[\], covers: session\.covers \|\| 1,/);
  const m = readRepo('src/surfaces/MPOSSurface.jsx');
  assert.match(m, /const withService = flow\.context\.payment\?\.service != null && Number\.isFinite\(svc\) \? \{ service: svc \} : \{\};/);
  // Table Pay stamps a table with the same maths (sessionTotalsMinor = computeCheckTotals).
  const session = { items: posLines(basket('service-charge')), discounts: [], covers: 4 };
  const stamp = sessionTotalsMinor(session, { deviceConfig: SERVICE_DEVICE, discountRules: RULES, timezone: TZ, taxCtx: ctxUK() });
  const till = posTotals(basket('service-charge'));
  assert.equal(stamp.totalMinor, Math.round(till.total * 100));
});

// ── QR tab rounds (confirmed major: later rounds dropped offers and service, carried a hidden tip) ─
test('QR tab: a round added to a tab is the pay now bill with no tip, and every close books the service charge as service', async () => {
  const { qrBillTotal } = await import('../publicCheckTax.js');
  assert.equal(typeof qrBillTotal, 'function');
  // 22.00 of goods, a 10% offer, 12.5% QR service charge, a 1.00 tip on pay now.
  const goods = 22, offer = 2.2, discounted = goods - offer, service = +(discounted * 0.125).toFixed(2);
  const payNow = qrBillTotal({ discountedSubtotal: discounted, exclusiveTax: 0, serviceCharge: service, tip: 1 });
  const round = qrBillTotal({ discountedSubtotal: discounted, exclusiveTax: 0, serviceCharge: service, tip: 0 });
  assert.equal(payNow, 23.28);
  assert.equal(round, 22.28, 'the round is the same bill, no tip (it was 22.00 + a hidden tip)');
  // Two rounds settle: service booked as service, out of the goods and the VAT share.
  const rounds = [
    { customer: { tip: 1, service_charge: service }, items: [{ itemId: 'burger', price: 9, qty: 2, mods: [] }, { itemId: 'coke', price: 2.5, qty: 1, mods: [] }, { itemId: 'fries', price: 1.5, qty: 1, mods: [] }] },
    { customer: { tip: 0, service_charge: service }, items: [{ itemId: 'burger', price: 9, qty: 2, mods: [] }, { itemId: 'coke', price: 2.5, qty: 1, mods: [] }, { itemId: 'fries', price: 1.5, qty: 1, mods: [] }] },
  ];
  const f = qrTabCloseFields(rounds, payNow + round, { menuItems: STORE_MENU, taxRates: ctxUK().taxRates, taxCtx: ctxUK(), hasTaxConfig: true });
  assert.equal(f.service, +(service * 2).toFixed(2));
  assert.equal(f.tip, 1);
  assert.equal(f.subtotal, +(payNow + round - 1 - service * 2).toFixed(2), 'the service charge is never goods');
  const qr = readRepo('src/surfaces/qr/QrCheckout.jsx');
  assert.match(qr, /tip: 0,\n\s+service_charge: serviceCharge,\n\s+\};/, 'the round\'s own figures, after the round 1 spread');
  assert.match(qr, /total: roundTotal,/);
  assert.match(readRepo('src/surfaces/OrdersHub.jsx'), /service: \+\(surcharge \+ tabService\)\.toFixed\(2\),/);
  assert.match(readRepo('src/lib/orderPayment.js'), /const service = Math\.min\(qrTabService\(rows\), Math\.max\(0, \+\(paid - tip\)\.toFixed\(2\)\)\);/);
  const sql = readRepo('supabase/migrations/20261019a_OPS_channel_parity.sql');
  assert.match(between(sql, 'CREATE OR REPLACE FUNCTION public.settle_qr_tab(', '$function$;'), /'service', v_service,/);
});

// ── Catering delivery fee (confirmed major: booked as service AND delivery) ───────────────────────
test('catering: the delivery fee is the order\'s delivery fee, never the service charge, as online books it', () => {
  const cat = readRepo('src/surfaces/catering/CateringCheckout.jsx');
  assert.doesNotMatch(cat, /service: deliveryFee/);
  assert.match(cat, /subtotal, service: 0, tip, total, method: 'card',/);
  assert.match(cat, /closedAt: closedAt, total, method: 'card', service: 0, tip,/, 'the emailed receipt too');
  const row = (source) => ({ source, service: 0, customer: { delivery_fee: 15 } });
  assert.deepEqual(recordCheckBasis(row('catering')), recordCheckBasis(row('online')));
});

// ── Catering pay later paid at the till (confirmed major: fee, options and promo lost) ────────────
test('catering pay later at the till: charged what the customer agreed (options, its own delivery fee, its promo)', async () => {
  const { placedOrderForTill, placedPromoFor, quoteForWalkIn } = await import('../orderPlacedFrom.js');
  const o = {
    ref: 'CA-AB12C', source: 'catering', type: 'delivery', total: 55,
    items: [{ itemId: 'platter', name: 'Platter', price: 30, qty: 1, mods: [{ name: 'Extra cheese', price: 10 }], taxRateId: 'r20', taxOverrides: {} }],
    customer: { delivery_fee: 20, delivery_mode: 'self', promo_code: 'P5', promo_discount: 5 },
  };
  const placed = placedOrderForTill(o);
  assert.equal(placed.items[0].price, 40, 'the option is inside the line price, the till\'s contract');
  assert.equal(placed.deliveryQuote.customerFeeMinor, 2000);
  assert.equal(placed.deliveryQuote.fromOrder, true, 'never a fresh quote');
  assert.equal(placed.deliveryQuote.orderRef, o.ref, 'bound to this order');
  assert.equal(placed.discounts, undefined, 'the promo is never a check discount');
  const walkIn = { ref: o.ref, items: placed.items, placedPromo: placed.promo };
  const promo = placedPromoFor(walkIn, { tableId: null, orderType: 'delivery' });
  assert.deepEqual({ code: promo.code, amount: promo.amount, alreadyRedeemed: promo.alreadyRedeemed }, { code: 'P5', amount: 5, alreadyRedeemed: true });
  const bill = computeCheckTotals({ items: placed.items, checkDiscounts: walkIn.discounts || [], covers: 1, orderType: 'delivery', deliveryQuote: quoteForWalkIn(placed.deliveryQuote, walkIn), taxCtx: ctxUK(), creditDiscounts: creditDiscountsFromPayment({ promoRedemption: promo }) });
  assert.equal(bill.total - promo.amount, o.total, 'the till takes the queue row\'s total (the promo comes off as its credit)');
  // A till order reopened from Orders is left exactly as it is.
  const tillOrder = { source: 'pos', items: o.items, customer: {} };
  assert.equal(placedOrderForTill(tillOrder).items, o.items);
  assert.equal(placedOrderForTill(tillOrder).promo, null);
  assert.match(readRepo('src/surfaces/POSSurface.jsx'), /if \(isQuoteOfOrder\(useStore\.getState\(\)\.deliveryQuote, useStore\.getState\(\)\.walkInOrder\)\) return;/);
  assert.match(readRepo('src/store/index.js'), /if \(orderType === 'delivery' && _dq\?\.available && _dq\.fromOrder\) \{/);
  const hub = readRepo('src/surfaces/OrdersHub.jsx');
  assert.match(hub, /const placed = placedOrderForTill\(o\);/);
  assert.match(hub, /\.\.\.\(placed\.promo \? \{ placedPromo: placed\.promo \} : \{\}\),/);
  assert.doesNotMatch(hub, /placed\.discounts/);
});

// Round 1 fix (19 Oct 2026): the promo of a placed order was a check discount at the till, so the
// UK VAT was scaled down by it and the reports counted a discount, while pay now books a promo tender.
test('the same placed order books the same VAT, tenders and discounts paid now on the page or later at the till', async () => {
  const { placedOrderForTill, placedPromoFor, quoteForWalkIn } = await import('../orderPlacedFrom.js');
  const { computeOrderTaxUnified } = await import('../taxCompute.js');
  const { creditDiscounts } = await import('../taxBasis.js');
  const { tender, finishTenders, tillTenders } = await import('../accounting/tenders.js');
  const { recordedDiscountMinor } = await import('../../../supabase/functions/_shared/tradingSales.js');
  const { chargedShare } = await import('../../../supabase/functions/_shared/vatRederive.js');
  for (const type of ['collection', 'delivery']) {
    const fee = type === 'delivery' ? 7.5 : 0;
    const cart = [{ itemId: 'platter', name: 'Platter', price: 30, qty: 1, mods: [{ id: 'x', name: 'Extra', price: 10 }], taxRateId: 'r20', taxOverrides: {} }];
    const promoAmt = 5;
    // Pay now on the catering page (CateringCheckout taxBk, total and tenders).
    const nowTax = computeOrderTaxUnified(cart.map((l) => ({ price: l.price + l.mods.reduce((m, x) => m + x.price, 0), qty: l.qty, itemId: l.itemId, taxRateId: l.taxRateId, taxOverrides: l.taxOverrides })), ctxUK(), type, { discounts: creditDiscounts({ promo: promoAmt }), deliveryFee: fee });
    const nowTotal = +(40 + fee - promoAmt).toFixed(2);
    const nowRecord = { items: [{ uid: 'a', itemId: 'platter', price: 40, qty: 1 }], discounts: [{ type: 'promo', source: 'promo', code: 'P5', amount: promoAmt }], tenders: finishTenders([tender('promo', promoAmt), tender('card', nowTotal, 0)]) };
    // The same order placed pay later, opened from Orders and paid at the till.
    const o = { ref: 'CA-ZZ9', source: 'catering', type, total: nowTotal, items: cart, customer: { promo_code: 'P5', promo_discount: promoAmt, ...(fee ? { delivery_fee: fee, delivery_mode: 'self' } : {}) } };
    const placed = placedOrderForTill(o);
    const walkIn = { ref: o.ref, items: placed.items, placedPromo: placed.promo };
    const held = placedPromoFor(walkIn, { tableId: null, orderType: type });   // CheckoutModal's first promoApplied
    const payInfo = { promoRedemption: held };
    const bill = computeCheckTotals({ items: walkIn.items, checkDiscounts: walkIn.discounts || [], covers: 1, orderType: type, deliveryQuote: quoteForWalkIn(placed.deliveryQuote, walkIn), taxCtx: ctxUK(), creditDiscounts: creditDiscountsFromPayment(payInfo) });
    const grand = +(bill.total - held.amount).toFixed(2);
    const tillRecord = { items: [{ uid: 'a', itemId: 'platter', price: 40, qty: 1 }], discounts: [{ source: 'promo', code: held.code, type: held.type, value: held.value, amount: held.amount }], tenders: finishTenders(tillTenders({ method: 'card', tillMoney: grand, promoCredit: held.amount })) };
    assert.equal(grand, nowTotal, `${type}: the customer pays the same`);
    assert.equal(roundVat(bill.tax?.totalTax), roundVat(nowTax?.totalTax), `${type}: the same VAT (6.67 on 40.00 of goods)`);
    assert.equal(roundVat(bill.tax?.totalTax), 6.67);
    assert.deepEqual(tillRecord.tenders.map((t) => [t.method, t.amount]), nowRecord.tenders.map((t) => [t.method, t.amount]), `${type}: a promo tender and the card`);
    assert.deepEqual([recordedDiscountMinor(tillRecord), recordedDiscountMinor(nowRecord)], [0, 0], `${type}: no discount in the reports either way`);
    assert.equal(chargedShare(tillRecord, tillRecord.items).share, chargedShare(nowRecord, nowRecord.items).share);
  }
  // The checkout starts with the order's promo only when it is paying that walk in order.
  const p = placedOrderForTill({ ref: 'CA-1', source: 'online', type: 'collection', items: [], customer: { promo_code: 'X', promo_discount: 2 } }).promo;
  assert.equal(placedPromoFor({ ref: 'CA-1', placedPromo: p }, { tableId: 't4' }), null, 'never on a table');
  assert.equal(placedPromoFor({ ref: 'CA-1', placedPromo: p }, { orderType: 'bar-tab' }), null, 'never on a bar tab');
  assert.equal(placedPromoFor({ ref: 'CA-2', placedPromo: p }, {}), null, 'never on another order');
  const co = readRepo('src/surfaces/CheckoutModal.jsx');
  assert.match(co, /const \[promoApplied, setPromoApplied\] = useState\(\(\) => placedPromoFor\(useStore\.getState\(\)\.walkInOrder, \{ tableId, orderType \}\)\);/);
  assert.match(co, /promoCredit,\n\s+bookingPayment: bookingRecord,/, 'the held promo is the till\'s promo tender');
  const store = readRepo('src/store/index.js');
  assert.match(between(store, 'redeemPromoCode: async (promo, record, customer) => {', 'recordWalkInClosedCheck:'), /if \(promo\?\.alreadyRedeemed\) return \{ ok: true, skipped: 'already_redeemed' \};/, 'a code used when the order was placed is never used again');
});

// Round 1 fix (19 Oct 2026): an opened order's delivery fee stayed on the till after Clear, and the
// next delivery sale charged it, sent no courier and logged no surcharge.
test('a placed order\'s delivery fee counts only while that order is on the till: open, Clear, a new delivery order quotes afresh', async () => {
  const { placedOrderForTill, quoteForWalkIn, isQuoteOfOrder } = await import('../orderPlacedFrom.js');
  const o = { ref: 'CA-77', source: 'catering', type: 'delivery', items: [{ itemId: 'platter', name: 'Platter', price: 30, qty: 1, mods: [] }], customer: { delivery_fee: 7.5 } };
  const placed = placedOrderForTill(o);
  const bill = (walkIn, quote) => computeCheckTotals({ items: walkIn?.items || [], covers: 1, orderType: 'delivery', deliveryQuote: quoteForWalkIn(quote, walkIn), taxCtx: ctxUK() });
  // 1. Opened from Orders: its own 7.50 is on the bill and the till does not quote.
  const opened = { id: 'ORD-77', ref: o.ref, items: placed.items };
  assert.equal(bill(opened, placed.deliveryQuote).deliveryFee, 7.5);
  assert.equal(isQuoteOfOrder(placed.deliveryQuote, opened), true);
  // 2. Clear, then a new phone order on Delivery (no ref yet, or its own new ref): never the old fee.
  for (const next of [{ id: 'ORD-2', items: [{ uid: 'b', itemId: 'burger', price: 9, qty: 1 }] }, { id: 'ORD-3', ref: '#6721', items: [{ uid: 'b', itemId: 'burger', price: 9, qty: 1 }] }, null]) {
    assert.equal(bill(next, placed.deliveryQuote).deliveryFee, 0, 'the abandoned order\'s fee is no quote here');
    assert.equal(isQuoteOfOrder(placed.deliveryQuote, next), false, 'so the till quotes afresh (POSSurface)');
    assert.equal(quoteForWalkIn(placed.deliveryQuote, next), null, 'and the close stamps, logs and dispatches by the fresh quote only');
  }
  // A till's own quote is passed exactly as it is (the same object: nothing moves for a till delivery sale).
  const live = { available: true, customerFeeMinor: 450, dispatchable: true, mode: 'uber' };
  assert.equal(quoteForWalkIn(live, { id: 'x', items: [] }), live);
  assert.equal(quoteForWalkIn(live, null), live);
  assert.equal(quoteForWalkIn(null, opened), null);
  const store = readRepo('src/store/index.js');
  assert.match(store, /clearWalkIn: \(\) => set\(s => \(\{ walkInOrder:null, customer:null, orderType:defaultOrderTypeFor\(s\.deviceConfig\), pendingLoyaltyReward:null, deliveryQuote:null \}\)\),/);
  assert.match(store, /deliveryQuote: quoteForWalkIn\(get\(\)\.deliveryQuote, activeTableId \? null : walkInOrder\),/, 'getPOSTotals');
  const close = between(store, 'recordWalkInClosed: (walkInOrder', 'refundCheck: async');
  assert.match(close, /deliveryQuote: quoteForWalkIn\(get\(\)\.deliveryQuote, walkInOrder\),/, 'the VAT the close books');
  assert.match(close, /const _dq = quoteForWalkIn\(get\(\)\.deliveryQuote, walkInOrder\);/, 'the fee it stamps, logs and dispatches');
  assert.doesNotMatch(close, /deliveryQuote: get\(\)\.deliveryQuote/);
  assert.match(readRepo('src/surfaces/MPOSSurface.jsx'), /deliveryQuote: quoteForWalkIn\(st\.deliveryQuote, order\),/);
});

// ── Booking money on MPOS (confirmed major: charged twice) ───────────────────────────────────────
test('booking deposit on the handheld: taken off the bill and booked exactly as the till\'s checkout books it', async () => {
  const { bookingLegsForBill } = await import('../bookings/bookingCredit.js');
  const { bookingCloseInfo } = await import('../bookings/bookingCloseInfo.js');
  const booking = { bookingId: 'b1', prepaidMinor: 0, depositMinor: 8000 };
  const legs = bookingLegsForBill(booking, 80);
  assert.deepEqual(legs, { bookingId: 'b1', appliedMinor: 8000, legs: [{ method: 'booking_deposit', amountMinor: 8000 }] });
  // 120.00 bill, the card takes 40.00 plus a 5.00 tip.
  const info = bookingCloseInfo({ method: 'card', grand: 45, tip: 5, paymentIntentId: 'psp9' }, legs, 80);
  assert.equal(info.grand, 125, 'booked gross: card money plus booking money');
  assert.equal(info.method, 'booking+card');
  assert.deepEqual(info.paymentIntents, [{ id: 'psp9', amountMinor: 4500 }, { id: null, amountMinor: 8000, method: 'booking_deposit' }]);
  const tenders = tendersFromPaymentInfo({ ...info, paymentIntentId: 'psp9' }, { total: info.grand, tip: 5 });
  assert.deepEqual(tenders.map((t) => [t.method, t.amount, t.tip]), [['booking_deposit', 80, 0], ['card', 40, 5]]);
  const t = readRepo('src/surfaces/mpos/MTender.jsx');
  assert.match(t, /const bookingPayment = booking \? bookingLegsForBill\(booking, bookingApplied\) : null;/);
  assert.match(readRepo('src/surfaces/CheckoutModal.jsx'), /const bookingLegsFor = \(\) => bookingLegsForBill\(bookingInfo, bookingApplied\);/);
});

// ── A service charge never carries VAT, on any channel (Peter, 19 Oct 2026: "service charge has no VAT") ──
// v5.11.81: Peter's decision makes the rule. Every channel's own money code is run with a service
// charge and without; the VAT booked is the VAT of the goods, never more. US added on tax on a
// service charge follows the tax profile (a separate question) and is checked to stay as it is.
test('service charge: no VAT on the till, a table, MPOS, Table Pay, reader closes, a bar tab, the kiosk, online, QR, catering, HubRise, ezCater and Xero', async () => {
  const { headlessTaxBreakdown } = await import('../headlessTax.js');
  const { tabCloseTax } = await import('../barTabTax.js');
  const { computeOrderTaxUnified } = await import('../taxCompute.js');
  const { buildChannelCloseFields } = await import('../channelMoney.js');
  const { ezcaterClosedCheck } = await import('../../../supabase/functions/_shared/ezcaterCatering.js');
  const { serviceTaxType } = await import('../../../supabase/functions/_shared/xeroTax.js');
  const { UK_RATES } = await import('./fixtures.js');
  const v = (t) => roundVat(t?.totalTax);
  const b = basket('service-charge');   // dine in, 4 covers, 4 burgers and 4 cokes, 12.5% service
  const items = posLines(b);
  const bill = (deviceConfig, checkDiscounts = []) => computeCheckTotals({ items, checkDiscounts, covers: 4, orderType: 'dine-in', deviceConfig, discountRules: RULES, timezone: TZ, taxCtx: ctxUK() });
  for (const disc of [[], [{ id: 'd', type: 'percent', value: 10 }]]) {
    const withSvc = bill(SERVICE_DEVICE, disc);
    const goods = v(bill({}, disc).tax);
    assert.ok(withSvc.service > 0, 'the bill carries a service charge');
    // The till counter, a table, MPOS (getPOSTotals) and the Table Pay stamp all run computeCheckTotals.
    assert.equal(v(withSvc.tax), goods, 'till, table, MPOS: VAT on the goods only');
    assert.equal(withSvc.tax.serviceTax, undefined, 'no tax line on the service charge');
    // A reader close (pay at table, Table Pay, another till's job) books from the frozen draft.
    const draft = { items, discounts: disc, covers: 4, orderType: 'dine-in', serviceMinor: Math.round(withSvc.service * 100) };
    assert.equal(v(headlessTaxBreakdown(draft, { taxRates: UK_RATES, taxCtx: ctxUK(), deviceConfig: SERVICE_DEVICE, discountRules: RULES, timezone: TZ })), goods, 'reader close');
    // QR pay now and online: the seam with the service charge in the basis (QrCheckout goodsTaxBreakdown).
    assert.equal(v(computeOrderTaxUnified(items, ctxUK(), 'dine-in', { discounts: disc, service: withSvc.service })), v(computeOrderTaxUnified(items, ctxUK(), 'dine-in', { discounts: disc })), 'QR and online');
  }
  // A bar tab handed a service figure books the VAT of its lines only.
  const tab = tabCloseTax(items, ctxUK(), { paymentInfo: { grand: 60, service: 7.5 } });
  assert.equal(tab.taxAmount, v(computeOrderTaxUnified(items, ctxUK(), 'bar-tab')), 'bar tab');
  // A QR tab books its rounds' service charge as service, out of the goods its VAT is on.
  const rounds = [{ customer: { tip: 0, service_charge: 2.5 }, items: [{ itemId: 'burger', price: 9, qty: 2, mods: [] }, { itemId: 'coke', price: 2.5, qty: 1, mods: [] }] }];
  const qrTab = qrTabCloseFields(rounds, 23, { menuItems: STORE_MENU, taxRates: UK_RATES, taxCtx: ctxUK(), hasTaxConfig: true });
  assert.equal(qrTab.service, 2.5);
  assert.equal(qrTab.taxAmount, roundVat(20.5 - 20.5 / 1.2), 'QR tab: VAT on the 20.50 of goods, never on the 2.50 service');
  // The kiosk and catering charge no service charge at all; online and catering book service 0.
  assert.doesNotMatch(readRepo('src/lib/kioskVat.js'), /service/, 'the kiosk tax call has no service charge in it');
  assert.match(readRepo('src/surfaces/catering/CateringCheckout.jsx'), /subtotal, service: 0, tip, total, method: 'card',/);
  // HubRise: a platform service fee is booked as service and adds no VAT.
  const hubItems = [{ id: 'h1', itemId: 'burger', name: 'Burger', price: 9, qty: 2, mods: [] }];
  const hub = (charges) => buildChannelCloseFields({ channel: 'delivery', total: 18, items: hubItems, customer: { payments: [], charges } }, { menuItems: STORE_MENU, taxRates: UK_RATES });
  const withFee = hub([{ name: 'Service fee', type: 'other', amount: 1.5 }]);
  assert.equal(withFee.service, 1.5);
  assert.equal(withFee.taxAmount, hub([]).taxAmount, 'HubRise');
  // ezCater: a misc fee is booked as the sale's service; the tax is ezCater's own figure, unchanged by it.
  const ez = (fees) => ezcaterClosedCheck({ ref: 'EZ-9', location_id: 'L', type: 'collection', event_date: '2026-11-02', collection_time: '12:00',
    items: [{ name: 'Box lunch', qty: 10, price: 12, lineSubunits: 12000 }],
    customer: { channel: 'ezcater', ezcater_lifecycle: 'accepted', ezcater_order_id: 'u-9', catererReceivesTip: true, catererReceivesDeliveryFee: true,
      totals: { subtotal: 120, tip: 0, deliveryFee: 10, feesAndDiscounts: fees }, tax: { salesTax: 8.7, salesTaxRemittance: 0 } } });
  const ezFee = ez([{ name: 'Delivery fee', amount: 10 }, { name: 'Setup fee', amount: 15 }]);
  assert.equal(ezFee.service, 15, 'the setup fee is booked as service, never the delivery fee');
  assert.equal(ezFee.tax_amount, ez([{ name: 'Delivery fee', amount: 10 }]).tax_amount, 'ezCater');
  assert.equal(ezFee.total, 120 + 8.7 + 10 + 15, 'the sale is what ezCater charged');
  // Xero: a VAT venue's service charge line posts No VAT whatever is set.
  const std = { key: 'rate:s', rateId: 's', pct: 20, mode: 'inclusive' };
  for (const mapping of [{}, { serviceTaxable: true }, { serviceTax: 'OUTPUT2' }]) assert.equal(serviceTaxType({ mapping, revenueRates: null, detail: {} }, std), 'NONE', JSON.stringify(mapping));
});

test('service charge: random UK baskets never book VAT on a service charge, on the seam every channel calls (property)', async () => {
  const { computeOrderTaxUnified } = await import('../taxCompute.js');
  const ids = ['burger', 'coke', 'sarnie', 'toastie', 'water', 'latte', 'baby-l', 'cake-slice'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 400; n++) {
    const ot = ['dine-in', 'takeaway', 'delivery', 'collection'][Math.floor(rnd() * 4)];
    const b = { orderType: ot, menuId: null, lines: ids.filter(() => rnd() < 0.5).map((itemId) => ({ itemId, qty: 1 + Math.floor(rnd() * 3) })) };
    if (!b.lines.length) continue;
    const items = posLines(b);
    const service = Math.round(rnd() * 3000) / 100;
    const disc = rnd() < 0.5 ? [{ type: 'amount', value: Math.round(rnd() * 500) / 100 }] : [];
    const a = computeOrderTaxUnified(items, ctxUK(), ot, { discounts: disc, service, deliveryFee: 0 });
    const z = computeOrderTaxUnified(items, ctxUK(), ot, { discounts: disc, service: 0, deliveryFee: 0 });
    assert.equal(a.totalTax, z.totalTax, JSON.stringify({ b, service }));
    assert.equal(a.serviceTax, undefined);
  }
});

test('service charge, US: added on tax on a service charge still follows the tax profile (unchanged)', async () => {
  const { computeOrderTaxUnified } = await import('../taxCompute.js');
  const { ctxUS } = await import('./fixtures.js');
  const lines = [{ uid: 'u', itemId: 'burger', cat: 'food', price: 17, qty: 1, taxRateId: null, taxOverrides: {} }];
  const withSvc = computeOrderTaxUnified(lines, ctxUS(), 'dine-in', { discounts: [], service: 2 });
  const without = computeOrderTaxUnified(lines, ctxUS(), 'dine-in', { discounts: [], service: 0 });
  assert.ok(withSvc.exclusiveTax > without.exclusiveTax, 'San Mateo taxes a mandatory service charge');
});
