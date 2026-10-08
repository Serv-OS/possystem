// vatRederive.test.js: the VAT audit's live sales, re derived through the released engine (8 Oct 2026).
// Run: `npm test`, or `node --test src/lib/vatRederive.test.js`.
//
// Fixtures are the stored lines, rates and figures the 8 Oct 2026 VAT audit listed from the Ops
// database (Coffee Boy Preston, Leeds, Huddersfield, Barnsley, Headingley; Provo for HubRise), typed
// here as the audit text gave them; nothing reads the live database. Each sale is pushed through the
// same lib path its channel books with, and the VAT must match the stored tax_amount to the penny.
// Where the stored figure was WRONG (the audit's findings), the test pins the right answer instead
// and says so. Rate ids are the live ones where the audit gave them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderTaxUnified, recordedCheckTax } from './taxCompute.js';
import { computeCheckTotals } from './payments/checkTotals.js';
import { publicCheckTaxFields } from './publicCheckTax.js';
import { headlessTaxBreakdown, qrCloseTax } from './headlessTax.js';
import { buildChannelCloseFields } from './channelMoney.js';
import { closedCheckRow } from './closedCheckRow.js';
import { toStoreRate } from './venueTaxRates.js';
import { roundVat, taxFallbacksOf } from './taxRule.js';

// ── the venues' rates, as tax_rates holds them (27 Sep 2026 seed: 20% default, 5%, 0%) ─────────
const rates = (loc, std, red, zero) => [
  toStoreRate({ id: std, name: 'Standard Rate', code: 'VAT20', rate: '0.200000', type: 'inclusive', is_default: true, active: true, location_id: loc }),
  toStoreRate({ id: red, name: 'Reduced Rate', code: 'VAT5', rate: '0.050000', type: 'inclusive', is_default: false, active: true, location_id: loc }),
  toStoreRate({ id: zero, name: 'Zero Rate', code: 'ZERO', rate: '0.000000', type: 'inclusive', is_default: false, active: true, location_id: loc }),
];
const PRESTON = 'ab45c80b-416d-4631-93e2-05048e52e0fa';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const PRESTON_RATES = rates(PRESTON, '229a7558-c675-47e9-bb16-c756815591d9', '0ed7ee06-preston-reduced', '8a476d3a-preston-zero');
const LEEDS_RATES = rates(LEEDS, '6368f6fb-leeds-std', '1913bd65-00cf-4772-90b9-0cb260d8c029', '60168c55-leeds-zero');
const HUDDS_RATES = rates('5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9', 'hudds-std', 'hudds-red', 'hudds-zero');
const BARNSLEY_RATES = rates('c5dd8483-f250-4868-9e46-709a74d78e2a', 'barnsley-std', 'barnsley-red', 'barnsley-zero');
const HEADINGLEY_RATES = rates('24786cbd-efe6-40d9-8424-46e242820abf', 'headingley-std', 'headingley-red', 'headingley-zero');
const [PRESTON_STD] = PRESTON_RATES.map((r) => r.id);
const [LEEDS_STD, LEEDS_RED, LEEDS_ZERO] = LEEDS_RATES.map((r) => r.id);

// ── 1. the QR pay now sales (14 since 25 Sep), as the page booked them ───────────────────────────
// A QR line as QrCheckout builds it for the engine: the item's own rate from the menu row.
const qrLine = (uid, name, price, taxRateId, itemId = `m-${uid}`) => ({ uid, itemId, name, price, qty: 1, cat: null, cats: null, taxProfileId: null, taxRateId, taxOverrides: {} });
// The page's own figure: computeOrderTaxUnified then publicCheckTaxFields (QrCheckout.jsx).
const pageVat = (lines, taxRates) => publicCheckTaxFields(computeOrderTaxUnified(lines, { taxRates }, 'dine-in', { discounts: [], service: 0 })).tax_amount;

// ref, venue rates, gross, item, stored tax_amount, the right answer under the one rule
const QR_SALES = [
  ['QR-HAFUU', PRESTON_RATES, 4.85, 'Preston drink', 0.81, 0.81],
  ['QR-2ODON', PRESTON_RATES, 4.40, 'Preston drink', 0.73, 0.73],
  ['QR-9AWBI', PRESTON_RATES, 4.85, 'Big 5', 0.81, 0.81],
  ['QR-6ZVYQ', PRESTON_RATES, 4.30, 'Latte XL', 0.72, 0.72],
  ['QR-WBDGS', PRESTON_RATES, 8.35, 'Preston drinks', 1.39, 1.39],
  ['QR-I6BI0', PRESTON_RATES, 7.90, 'Preston drinks', 1.32, 1.32],
  ['QR-FAUOB', LEEDS_RATES, 5.60, 'Leeds drink', 0.93, 0.93],
  ['QR-8IFJ5', LEEDS_RATES, 3.85, 'Leeds drink', 0.64, 0.64],
  ['QR-J99J4', LEEDS_RATES, 3.80, 'Leeds drink', 0.63, 0.63],
  ['QR-N2IYX', HUDDS_RATES, 3.75, 'Flat White', 0.63, 0.63],
  // The fault the audit found: the page held no rates and sent null. The right answer is 0.81.
  ['QR-4OGI7', PRESTON_RATES, 4.85, 'Mixed Berry Cooler', null, 0.81],
  // Exactly on a half penny (0.975): the 2 Oct backfill stored the float rounded down, 0.97. One
  // rule, half up (D3): 0.98. History is left alone; this pins what every new sale books.
  ['QR-186RY', PRESTON_RATES, 5.85, 'Preston drink', 0.97, 0.98],
];
// QR-6CYF8 (VAT 0.73) and QR-PVON8 (VAT 0.86) are the other two: the audit text gives their VAT but
// not their gross, so they are not typed here.

test('the QR pay now sales re derive to the stored penny; QR-4OGI7 gives 0.81 and the half penny sale rounds up', () => {
  for (const [ref, taxRates, gross, name, stored, right] of QR_SALES) {
    const vat = pageVat([qrLine(ref, name, gross, taxRates[0].id)], taxRates);
    assert.equal(vat, right, `${ref}: ${gross} at 20% inside the price`);
    if (stored != null && stored !== right) assert.equal(Math.round((right - stored) * 100), 1, `${ref}: a half penny, one penny up under the one rule`);
    else if (stored != null) assert.equal(vat, stored, `${ref}: the stored figure`);
  }
  // The 13 booked sales the audit summed (71.90 gross less the two not typed): the sum of what the
  // one rule gives is the sum of the stored figures plus the one half penny.
  const typed = QR_SALES.filter(([, , , , stored]) => stored != null);
  const storedSum = typed.reduce((s, [, , , , stored]) => s + stored, 0);
  const ruleSum = typed.reduce((s, [ref, taxRates, gross, name]) => s + pageVat([qrLine(ref, name, gross, taxRates[0].id)], taxRates), 0);
  assert.equal(roundVat(ruleSum - storedSum), 0.01, 'QR-186RY is the only sale the rule moves, by one penny');
});

test('QR-4OGI7 the way the audit saw it: a page with no rates sends null; with Preston\'s rates it sends 0.81 and the Standard Rate record', () => {
  const line = qrLine('QR-4OGI7', 'Mixed Berry Cooler', 4.85, PRESTON_STD, 'm-1790046914854_8e52e0fa');
  assert.deepEqual(publicCheckTaxFields(computeOrderTaxUnified([line], { taxRates: [] }, 'dine-in')), { tax_amount: null }, 'what happened on 8 Oct 12:18 UK');
  const f = publicCheckTaxFields(computeOrderTaxUnified([line], { taxRates: PRESTON_RATES }, 'dine-in', { discounts: [], service: 0 }));
  assert.equal(f.tax_amount, 0.81);
  assert.equal(f.tax_breakdown.breakdown[0].rate.id, PRESTON_STD);
  assert.equal(f.tax_breakdown.breakdown[0].rate.isDefault, true);
  assert.equal(f.tax_breakdown.source, 'legacy');
  assert.equal('fallbacks' in f.tax_breakdown, false, 'the item followed its own rule');
  // The Tax report reads a check with a record as booked at that rate.
  const check = { items: [line], orderType: 'dine-in', taxAmount: f.tax_amount, taxBreakdown: f.tax_breakdown, discounts: [] };
  assert.equal(roundVat(recordedCheckTax(check, { taxRates: PRESTON_RATES }).totalTax), 0.81);
});

// ── 2. till sales, through computeCheckTotals as buildCloseRecord and recordWalkInClosed do ─────
const till = (items, taxRates, orderType, checkDiscounts = []) => computeCheckTotals({
  items, checkDiscounts, covers: 1, orderType, taxRates, taxCtx: { taxRates },
});
const tillVat = (...a) => roundVat(till(...a).tax.totalTax);
const line = (uid, name, price, taxRateId, extra = {}) => ({ uid, id: `m-${uid}`, itemId: `m-${uid}`, name, price, qty: 1, mods: [], taxRateId, taxOverrides: {}, ...extra });

test('Leeds till sales: the Bueno donut (takeaway Zero Rate) and the Babyccino sizes (Reduced Rate) book what was stored', () => {
  // R14064, 2 Oct, takeaway: Bueno Filled Donut 4.50, Standard base, takeaway and delivery to Zero Rate.
  const donut = line('r14064', 'Bueno Filled Donut', 4.50, LEEDS_STD, { taxOverrides: { takeaway: LEEDS_ZERO, delivery: LEEDS_ZERO } });
  assert.equal(tillVat([donut], LEEDS_RATES, 'takeaway'), 0, 'R14064: stored 0.00, right under the override');
  assert.equal(till([donut], LEEDS_RATES, 'takeaway').tax.breakdown[0].rate.id, LEEDS_ZERO);
  assert.equal(tillVat([donut], LEEDS_RATES, 'dine-in'), 0.75, 'the 10 dine-in donut sales booked 20%, right');
  // 8 Oct 2026 (D2): collected, the donut follows the takeaway rule. It would have booked 0.75.
  assert.equal(tillVat([donut], LEEDS_RATES, 'collection'), 0);
  // R14180, 3 Oct, dine-in: Babyccino — Milk 1.55 at Reduced 5% plus 4.10 of standard rated lines: 0.76.
  const r14180 = [line('babyccino-milk', 'Babyccino — Milk', 1.55, LEEDS_RED), line('rest', 'Standard rated lines', 4.10, LEEDS_STD)];
  assert.equal(tillVat(r14180, LEEDS_RATES, 'dine-in'), 0.76);
  const bd = till(r14180, LEEDS_RATES, 'dine-in').tax.breakdown;
  assert.deepEqual(bd.map((b) => [b.rate.id, roundVat(b.tax)]), [[LEEDS_STD, 0.68], [LEEDS_RED, 0.07]], 'Standard 0.6833, Reduced 0.0738: the stored split');
  // R14169, 3 Oct, dine-in: Babyccino — Milk 1.05 at 5% plus 12.40 standard: total 13.45, VAT 2.12.
  assert.equal(tillVat([line('babyccino-milk', 'Babyccino — Milk', 1.05, LEEDS_RED), line('rest', 'Standard rated lines', 12.40, LEEDS_STD)], LEEDS_RATES, 'dine-in'), 2.12);
});

test('the three live collection sales (no overrides) book exactly what was stored, before and after D2', () => {
  // Barnsley R7928, 6 Oct: Bakewell Traybake 2.45 + Latte Big 4.00 + English Breakfast Tea Big 2.85 = 9.30, VAT 1.55.
  const r7928 = [line('a', 'Bakewell Traybake', 2.45, 'barnsley-std'), line('b', 'Latte Big', 4.00, 'barnsley-std'), line('c', 'English Breakfast Tea Big', 2.85, 'barnsley-std')];
  assert.equal(tillVat(r7928, BARNSLEY_RATES, 'collection'), 1.55);
  // Barnsley R7716, 6 Oct: Latte Small 3.70, VAT 0.62.
  assert.equal(tillVat([line('a', 'Latte Small', 3.70, 'barnsley-std')], BARNSLEY_RATES, 'collection'), 0.62);
  // Preston R3154, 3 Oct: Iced Latte XL 5.00 + Spiced Maple Pecan Iced Latte XL 5.85, a 1.08 discount, total 9.77, VAT 1.63
  // (the VAT follows the discount: taxShare.inclusiveTaxOnCharged, 27 Sep 2026).
  const r3154 = till([line('a', 'Iced Latte XL', 5.00, PRESTON_STD), line('b', 'Spiced Maple Pecan Iced Latte XL', 5.85, PRESTON_STD)], PRESTON_RATES, 'collection', [{ type: 'amount', value: 1.08, label: 'Discount' }]);
  assert.equal(roundVat(r3154.total), 9.77);
  assert.equal(roundVat(r3154.tax.totalTax), 1.63);
  assert.ok(r3154.tax.share < 1, 'a scaled record, read as booked by the reports');
});

test('an open price till item books the venue default (as stored) and the record now says it had no rule', () => {
  // Huddersfield R4082: "Small ground coffee" typed at the till, 7.95, booked 1.33 at the default 20%
  // (exactly 1.325: half up). Owner question 4: retail coffee may be zero rated; until a rate is
  // chosen at the till the default applies and the sale says so.
  const custom = { uid: 'c1', itemId: 'custom', name: 'Small ground coffee', price: 7.95, qty: 1, mods: [], notes: '' };
  const t = till([custom], HUDDS_RATES, 'dine-in');
  assert.equal(roundVat(t.tax.totalTax), 1.33);
  assert.deepEqual(taxFallbacksOf(t.tax).map((f) => [f.reason, f.lineId, f.name]), [['custom-item', 'c1', 'Small ground coffee']]);
  // the row the till writes carries the two decimal figure, never the float
  const row = closedCheckRow({ id: 'chk-r4082', ref: 'R4082', items: [custom], taxAmount: t.tax.totalTax, taxBreakdown: t.tax, total: 7.95, subtotal: 7.95 }, HUDDS_RATES[0].locationId);
  assert.equal(row.tax_amount, 1.33);
  assert.equal(String(row.tax_amount), '1.33');
  assert.equal(roundVat(row.tax_breakdown.totalTax), 1.33);
});

test('the 814 half penny sales: a till sale of 10.05 at 20% is stored as 1.68 under the one rule (history stays 1.67)', () => {
  const t = till([line('a', 'Two coffees', 10.05, LEEDS_STD)], LEEDS_RATES, 'dine-in');
  assert.ok(Math.abs(t.tax.totalTax - 1.675) < 1e-9, 'the engine keeps the raw figure');
  const row = closedCheckRow({ id: 'x', ref: 'R1', items: t.items, taxAmount: t.tax.totalTax, taxBreakdown: t.tax, total: 10.05, subtotal: 10.05 }, LEEDS);
  assert.equal(row.tax_amount, 1.68);
  assert.equal(closedCheckRow({ id: 'y', ref: 'R2', items: [], taxAmount: null, total: 0, subtotal: 0 }, LEEDS).tax_amount, null, 'not recorded stays null');
});

// ── 3. a card reader close (TerminalJobReconciler), over the frozen draft ───────────────────────
test('Headingley R1677: the reader close books 1.37 on the two drinks (the loyalty tender question is the owner\'s, D1)', () => {
  // Latte 4.60 + Americano 3.60 = 8.20 at 20% inside the price: 1.3667, 1.37. The Americano was a
  // free stamp card drink; the till's rule keeps the VAT on it (plan Fix 5 waits on the owner).
  const draft = { items: [line('a', 'Latte', 4.60, 'headingley-std'), line('b', 'Americano', 3.60, 'headingley-std')], orderType: 'dine-in', discounts: [] };
  const t = headlessTaxBreakdown(draft, { taxRates: HEADINGLEY_RATES, taxCtx: { taxRates: HEADINGLEY_RATES } });
  assert.equal(roundVat(t.totalTax), 1.37);
  // a draft line naming another venue's rate id books the venue default and the record says so
  const foreign = headlessTaxBreakdown({ items: [line('a', 'Latte', 4.60, 'ts-std-other-venue')] }, { taxRates: HEADINGLEY_RATES, taxCtx: { taxRates: HEADINGLEY_RATES } });
  assert.equal(roundVat(foreign.totalTax), 0.77);
  assert.deepEqual(taxFallbacksOf(foreign).map((f) => [f.reason, f.rateId]), [['rate-not-found', 'ts-std-other-venue']]);
});

// ── 4. HubRise (delivery partner) sales at Provo, through buildChannelCloseFields ───────────────
const PROVO_RATES = [
  toStoreRate({ id: 'e917d8ae-provo-vat', name: 'VAT', rate: '0.2', type: 'inclusive', is_default: true, active: true, location_id: 'provo' }),
  toStoreRate({ id: 'provo-reduced', name: 'Reduced Rate', rate: '0.05', type: 'inclusive', is_default: false, active: true, location_id: 'provo' }),
  toStoreRate({ id: 'c0136481-provo-zero', name: 'Zero Rate', rate: '0', type: 'inclusive', is_default: false, active: true, location_id: 'provo' }),
];
const PROVO_MENU = [
  { id: 'm-impmoasl3ng-0', name: 'Og Wings', taxRateId: 'e917d8ae-provo-vat', taxOverrides: {} },
  { id: 'm-impmpmqnen2-6', name: 'Slaw', taxRateId: null, taxOverrides: { delivery: 'c0136481-provo-zero', takeaway: 'c0136481-provo-zero' } },
];

test('HR-7qj99bg (matched lines): Og Wings at VAT, Slaw zero rated on delivery, 3.33 as stored', () => {
  const order = { channel: 'delivery', total: 26.49, items: [
    { id: 'l1', itemId: 'm-impmoasl3ng-0', name: 'Og Wings', price: 19.99, qty: 1, mods: [] },
    { id: 'l2', itemId: 'm-impmpmqnen2-6', name: 'Slaw', price: 6.50, qty: 1, mods: [] },
  ], customer: { payments: [{ amount: 26.49 }] } };
  const f = buildChannelCloseFields(order, { menuItems: PROVO_MENU, taxRates: PROVO_RATES });
  assert.equal(f.taxAmount, 3.33);
  assert.deepEqual(f.taxBreakdown.breakdown.map((b) => [b.rate.id, roundVat(b.tax), roundVat(b.gross)]), [['e917d8ae-provo-vat', 3.33, 19.99], ['c0136481-provo-zero', 0, 6.5]]);
  assert.equal('fallbacks' in f.taxBreakdown, false);
});

test('HR-bkrqmj7 (no line on our menu): booked 0.00 on 41.60; the one rule books the venue default, 6.93, and names every line', () => {
  const order = { channel: 'delivery', total: 41.60, items: [
    { id: 'l1', itemId: '33', name: 'Double Smash Burger', price: 15.90, qty: 1, mods: [] },
    { id: 'l2', itemId: '40', name: 'Buttermilk Chicken Tenders', price: 9.95, qty: 2, mods: [] },
    { id: 'l3', itemId: '23', name: 'Coke', price: 2.90, qty: 2, mods: [] },
  ], customer: { payments: [{ amount: 41.60 }] } };
  const f = buildChannelCloseFields(order, { menuItems: PROVO_MENU, taxRates: PROVO_RATES });
  assert.equal(f.subtotal, 41.60);
  assert.equal(f.taxAmount, 6.93, '41.60 at 20% inside the price');
  assert.equal(f.taxBreakdown.breakdown[0].rate.id, 'e917d8ae-provo-vat');
  assert.deepEqual(taxFallbacksOf(f.taxBreakdown).map((x) => [x.reason, x.lineId, x.name]), [
    ['item-not-on-menu', 'l1', 'Double Smash Burger'], ['item-not-on-menu', 'l2', 'Buttermilk Chicken Tenders'], ['item-not-on-menu', 'l3', 'Coke'],
  ]);
  // and the stored breakdown of that sale (totalTax 0, breakdown []) is what the fault looked like
  assert.notEqual(f.taxAmount, 0);
});

// ── 5. a QR check the till force closes in Orders (qrCloseTax) over order_queue lines ───────────
test('a Preston QR order force closed on the till books the same 0.81 the page would, from the menu rates', () => {
  const menu = [{ id: 'm-1790046914854_8e52e0fa', name: 'Mixed Berry Cooler', taxRateId: PRESTON_STD, taxOverrides: {} }];
  const t = qrCloseTax([{ itemId: 'm-1790046914854_8e52e0fa', name: 'Mixed Berry Cooler', price: 4.85, qty: 1, mods: [] }], { menuItems: menu, taxRates: PRESTON_RATES }, { paidGoods: 4.85 });
  assert.equal(t.taxAmount, 0.81);
  assert.equal(t.taxBreakdown.breakdown[0].rate.id, PRESTON_STD);
});
