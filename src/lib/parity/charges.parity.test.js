// charges.parity.test.js: service charges, tips, delivery fees and booking money follow the till (v5.11.78).
// Run: node --test src/lib/parity/charges.parity.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, SERVICE_DEVICE, STORE_MENU, ctxUK, basket } from './fixtures.js';
import { posLines, posTotals } from './pos.js';
import { computeCheckTotals, sessionTotalsMinor } from '../payments/checkTotals.js';
import { headlessService, qrTabCloseFields } from '../headlessTax.js';
import { recordCheckBasis } from '../taxBasis.js';
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
  const { placedOrderForTill } = await import('../orderPlacedFrom.js');
  const o = {
    source: 'catering', type: 'delivery', total: 55,
    items: [{ itemId: 'platter', name: 'Platter', price: 30, qty: 1, mods: [{ name: 'Extra cheese', price: 10 }], taxRateId: 'r20', taxOverrides: {} }],
    customer: { delivery_fee: 20, delivery_mode: 'self', promo_code: 'P5', promo_discount: 5 },
  };
  const placed = placedOrderForTill(o);
  assert.equal(placed.items[0].price, 40, 'the option is inside the line price, the till\'s contract');
  assert.equal(placed.deliveryQuote.customerFeeMinor, 2000);
  assert.equal(placed.deliveryQuote.fromOrder, true, 'never a fresh quote');
  const bill = computeCheckTotals({ items: placed.items, checkDiscounts: placed.discounts, covers: 1, orderType: 'delivery', deliveryQuote: placed.deliveryQuote, taxCtx: ctxUK() });
  assert.equal(bill.total, o.total, 'the till charges the queue row\'s total');
  // A till order reopened from Orders is left exactly as it is.
  const tillOrder = { source: 'pos', items: o.items, customer: {} };
  assert.equal(placedOrderForTill(tillOrder).items, o.items);
  assert.match(readRepo('src/surfaces/POSSurface.jsx'), /if \(useStore\.getState\(\)\.deliveryQuote\?\.fromOrder\) return;/);
  assert.match(readRepo('src/store/index.js'), /if \(orderType === 'delivery' && _dq\?\.available && _dq\.fromOrder\) \{/);
  assert.match(readRepo('src/surfaces/OrdersHub.jsx'), /const placed = placedOrderForTill\(o\);/);
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
