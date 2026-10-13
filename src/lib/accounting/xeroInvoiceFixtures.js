// src/lib/accounting/xeroInvoiceFixtures.js
//
// Shared test figures for the daily sales invoice tests (xeroInvoicePlan, accountingGroups,
// xeroModes). A UK day at Coffee Boy Leeds shaped like the live closed_checks rows (30 Sep
// 2026): items with cat, itemId, uid, price (mods included), taxRateId and taxOverrides by
// order type; an item's own discount on the item (items[].discount { label, type, value }, as
// POSSurface saves "Selected items" and category presets); check discounts[] as DiscountModal
// saves them ({ label, type, value, scope 'check', amount }) and auto discounts as the discount
// engine does (toAppliedDiscount: appliedItems [{ uid, saving }]); tenders with method, amount,
// tip and processor; tax_breakdown as the till saves it.

import { businessDayWindow } from '../../../supabase/functions/_shared/businessDay.js';
import { revenueTaxRates } from '../../../supabase/functions/_shared/xeroTax.js';
import { buildGroupedDay, makeGroupResolver } from '../../../supabase/functions/_shared/accountingGroups.js';

export const UK_XERO_RATES = [
  { TaxType: 'INPUT2', Name: '20% (VAT on Expenses)', Status: 'ACTIVE', CanApplyToRevenue: 'false', CanApplyToExpenses: 'true', EffectiveRate: '20.0000' },
  { TaxType: 'OUTPUT2', Name: '20% (VAT on Income)', Status: 'ACTIVE', CanApplyToRevenue: 'true', CanApplyToExpenses: 'false', EffectiveRate: '20.0000' },
  { TaxType: 'RROUTPUT', Name: '5% (VAT on Income)', Status: 'ACTIVE', CanApplyToRevenue: 'true', CanApplyToExpenses: 'false', EffectiveRate: '5.0000' },
  { TaxType: 'ZERORATEDOUTPUT', Name: 'Zero Rated Income', Status: 'ACTIVE', CanApplyToRevenue: 'true', CanApplyToExpenses: 'false', EffectiveRate: '0.0000' },
  { TaxType: 'NONE', Name: 'No VAT', Status: 'ACTIVE', CanApplyToRevenue: 'true', CanApplyToExpenses: 'true', EffectiveRate: '0.0000' },
];

export const UK_TAX = [
  { id: 'r20', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true },
  { id: 'r0', name: 'Zero rated', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true },
  { id: 'rnv', name: 'No VAT', code: 'NOVAT', rate: 0, type: 'inclusive', is_default: false, active: true },
];

export const UK = { timezone: 'Europe/London', dayStart: '06:00' };
export const DATE = '2026-09-29';
export const DAY = businessDayWindow(DATE, UK.timezone, UK.dayStart);
export const at = (h) => new Date(DAY.fromMs + h * 3600000).toISOString();
export const atMs = (h) => DAY.fromMs + h * 3600000;

const rateRow = (id) => UK_TAX.find((t) => t.id === id);
/** A saved tax_breakdown: entries { id, gross, tax } in major units. */
export function breakdown(entries, orderType = 'dine-in') {
  const totalTax = Math.round(entries.reduce((s, e) => s + e.tax, 0) * 100) / 100;
  return {
    totalTax, total: entries.reduce((s, e) => s + e.gross, 0), hasExclusiveTax: false, taxV2: { orderType },
    breakdown: entries.map((e) => ({ rate: { id: e.id, rate: rateRow(e.id).rate, type: 'inclusive', name: rateRow(e.id).name }, gross: e.gross, tax: e.tax, net: e.gross - e.tax })),
  };
}

export const CATEGORIES = [
  { id: 'cat-drinks_1e945c26', parent_id: null, label: 'Drinks', accounting_group: '', master_id: 'cat-drinks', local: true },
  { id: 'cat-hot_1e945c26', parent_id: 'cat-drinks_1e945c26', label: 'Coffee', accounting_group: '', master_id: 'cat-hot', local: true },
  { id: 'cat-food_1e945c26', parent_id: null, label: 'Food', accounting_group: 'Food', master_id: 'cat-food', local: true },
  { id: 'cat-cake_1e945c26', parent_id: 'cat-food_1e945c26', label: 'Cakes', accounting_group: '', master_id: 'cat-cake', local: true },
  { id: 'cat-gift_1e945c26', parent_id: null, label: 'Gift cards', accounting_group: '', master_id: 'cat-gift', local: true },
];

/** Five checks: two rates, a split card and cash bill, a tip, service, a check discount, an item's own discount, a loyalty credit, and the Huddersfield 1.34 VAT. */
export function saleRows() {
  return [
    { id: 'A', closed_at: at(1), total: 8.30, tip: 0.5, service: 0, tax_amount: 0.63,
      tax_breakdown: breakdown([{ id: 'r20', gross: 3.8, tax: 0.6333 }, { id: 'r0', gross: 4.0, tax: 0 }], 'takeaway'),
      items: [
        { uid: 'a1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20', taxOverrides: {} },
        { uid: 'a2', cat: 'cat-food_1e945c26', itemId: 'm-sand', qty: 1, price: 4.0, taxRateId: 'r20', taxOverrides: { takeaway: 'r0', 'dine-in': 'r20' } },
      ],
      tenders: [{ method: 'card', amount: 7.8, tip: 0.5, processor: 'adyen', psp_ref: 'P1' }] },
    { id: 'B', closed_at: at(2), total: 2.66, tip: 0, service: 0, tax_amount: 0.44,
      tax_breakdown: breakdown([{ id: 'r20', gross: 2.655, tax: 0.4425 }]),
      items: [{ uid: 'b1', cat: 'cat-cake_1e945c26', itemId: 'm-cake', qty: 1, price: 2.95, taxRateId: 'r20' }],
      discounts: [{ id: 'd1', type: 'percent', label: 'Custom 10%', scope: 'check', value: 10, amount: 0.295, itemUids: null }],
      tenders: [{ method: 'cash', amount: 2.66, tip: 0 }] },
    { id: 'C', closed_at: at(3), total: 6.25, tip: 0, service: 1.0, tax_amount: 0.88,
      tax_breakdown: breakdown([{ id: 'r20', gross: 5.25, tax: 0.875 }]),
      items: [
        { uid: 'c1', cat: 'cat-hot_1e945c26', itemId: 'm-fw', qty: 1, price: 3.75, taxRateId: 'r20' },
        { uid: 'c2', cat: 'cat-cake_1e945c26', itemId: 'm-muffin', qty: 1, price: 3.0, taxRateId: 'r20', discount: { id: 'disc-c2', label: 'Staff Discount 50%', type: 'percent', value: 50 } },
      ],
      tenders: [{ method: 'card', amount: 4.0, tip: 0, processor: 'adyen' }, { method: 'cash', amount: 2.25, tip: 0 }] },
    { id: 'D', closed_at: at(4), total: 3.8, tip: 0, service: 0, tax_amount: 0.63,
      tax_breakdown: breakdown([{ id: 'r20', gross: 3.8, tax: 0.6333 }]),
      items: [{ uid: 'd1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' }],
      tenders: [{ method: 'loyalty', amount: 1.0, tip: 0 }, { method: 'card', amount: 2.8, tip: 0, processor: 'adyen' }] },
    { id: 'E', closed_at: at(5), total: 8.0, tip: 0, service: 0, tax_amount: 1.34,
      tax_breakdown: breakdown([{ id: 'r20', gross: 8.0, tax: 1.34 }]),
      items: [{ uid: 'e1', cat: 'cat-hot_1e945c26', itemId: 'm-americano', qty: 4, price: 2.0, taxRateId: 'r20' }],
      tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'adyen' }] },
  ];
}

/** Check A with a card refund of the latte, made later the same business day. */
export function refundRows() {
  const a = saleRows()[0];
  return [{ ...a, refunds: [{
    id: 'ref1', amount: 3.8, taxAmount: 0.63, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', isFullRefund: false, timestamp: atMs(6),
    legs: [{ status: 'accepted', amountMinor: 380, processor: 'adyen' }],
    items: [{ cat: 'cat-hot_1e945c26', itemId: 'm-latte', price: 3.8, qty: 1, refundQty: 1, taxRateId: 'r20' }],
  }] }];
}

export const SITE = { name: 'Coffee Boy Leeds', code: 'LEEDS' };

export function mapping(extra = {}) {
  return {
    site: { ...SITE },
    tracking: { categoryId: 'tc-1', categoryName: 'Location', optionId: 'to-leeds', optionName: 'Leeds' },
    groups: { 'hot-drinks': { name: 'Hot drinks', account: '201' }, food: { name: 'Food', account: '202' } },
    categoryGroups: { 'cat-drinks_1e945c26': 'hot-drinks' },
    otherSalesAccount: '200',
    discounts: { accounts: { customer: '401', staff: '402', loyalty: '403', comp: '404', promo: '405' } },
    tipsAccount: '825', serviceAccount: '826', giftLiabilityAccount: '830',
    clearing: { card: 'CARDCLR', cash: 'CASHTILL', gift_card: '830' },
    ...extra,
  };
}

export const DETAIL = { salesTaxRates: revenueTaxRates(UK_XERO_RATES), site: { contactId: '11111111-2222-4333-8444-555555555555' } };

/** A tiny deterministic random source (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A generated UK check like the till writes: 1 to 4 items at 20% or 0% (by order type), maybe a
 * check discount, an item's own discount or an auto discount on one item, maybe service and a
 * tip, paid by card, cash, a loyalty credit or a mix. Figures follow the till: item prices tax
 * inclusive, each discount off the lines it applies to, VAT per rate from the discounted gross.
 */
export function generatedCheck(r, id, hour) {
  const cats = ['cat-hot_1e945c26', 'cat-food_1e945c26', 'cat-cake_1e945c26', 'cat-unknown_1e945c26', null];
  const n = 1 + Math.floor(r() * 4);
  const takeaway = r() < 0.4;
  const items = [];
  for (let i = 0; i < n; i++) {
    const price = Math.round((1 + r() * 9) * 100) / 100;
    const food = r() < 0.4;
    items.push({ uid: `${id}-${i}`, cat: cats[Math.floor(r() * cats.length)], itemId: `m-${Math.floor(r() * 6)}`, qty: 1 + Math.floor(r() * 2), price,
      taxRateId: 'r20', taxOverrides: food ? { takeaway: 'r0', 'dine-in': 'r20' } : {} });
  }
  const rateOf = (it) => (takeaway && it.taxOverrides.takeaway ? 'r0' : 'r20');
  // What each line is charged, as taxBasis.allocateCheckBasis works it out.
  const after = items.map((it) => it.price * it.qty);
  const discounts = [];
  if (r() < 0.35) {
    const pick = r();
    if (pick < 0.4) {
      const pct = [10, 20, 50][Math.floor(r() * 3)];
      const sub = after.reduce((s, v) => s + v, 0);
      const disc = sub * pct / 100;
      discounts.push({ id: `disc-${id}`, label: r() < 0.5 ? `Custom ${pct}%` : 'Staff Drinks', type: 'percent', value: pct, scope: 'check', amount: disc, itemUids: null });
      for (let i = 0; i < after.length; i++) after[i] *= (100 - pct) / 100;
    } else if (pick < 0.75) {
      // An item's own discount (POSSurface "Selected items"): on the item, never in discounts[].
      items[0].discount = { id: `disc-${items[0].uid}`, label: 'Staff meal', type: 'percent', value: 50 };
      after[0] *= 0.5;
    } else {
      // An auto discount on the last item (the discount engine's appliedItems).
      const last = items.length - 1;
      const saving = Math.round(Math.min(1.5, after[last]) * 100) / 100;
      discounts.push({ id: 'rule-1', label: 'Cookie deal', type: 'amount', value: saving, amount: saving, scope: 'check', isAuto: true, appliedItems: [{ uid: items[last].uid, saving }], ruleKind: 'amount' });
      after[last] -= saving;
    }
  }
  const byRate = {};
  items.forEach((it, i) => { byRate[rateOf(it)] = (byRate[rateOf(it)] || 0) + after[i]; });
  const entries = Object.entries(byRate).map(([rid, gross]) => ({ id: rid, gross, tax: rid === 'r20' ? gross / 6 : 0 }));
  const tax = Math.round(entries.reduce((s, e) => s + e.tax, 0) * 100) / 100;
  const goods = Math.round(after.reduce((s, v) => s + v, 0) * 100) / 100;
  const service = r() < 0.2 ? Math.round(goods * 0.1 * 100) / 100 : 0;
  const tip = r() < 0.3 ? Math.round(r() * 300) / 100 : 0;
  const bill = Math.round((goods + service) * 100) / 100;
  const tenders = [];
  const pick = r();
  if (pick < 0.5) tenders.push({ method: 'card', amount: bill, tip, processor: 'adyen' });
  else if (pick < 0.7) tenders.push({ method: 'cash', amount: bill, tip });
  else if (pick < 0.85) {
    const cardPart = Math.round(bill * 0.6 * 100) / 100;
    tenders.push({ method: 'card', amount: cardPart, tip, processor: 'adyen' }, { method: 'cash', amount: Math.round((bill - cardPart) * 100) / 100, tip: 0 });
  } else {
    const credit = Math.min(bill, 1);
    tenders.push({ method: 'loyalty', amount: credit, tip: 0 }, { method: 'card', amount: Math.round((bill - credit) * 100) / 100, tip, processor: 'adyen' });
  }
  return {
    id, closed_at: at(hour), total: Math.round((bill + tip) * 100) / 100, tip, service, tax_amount: tax,
    tax_breakdown: breakdown(entries, takeaway ? 'takeaway' : 'dine-in'), items, discounts, tenders,
  };
}

// ── card fees on the daily invoice (13 Oct 2026) ────────────────────────────────
// Made up days shared by xeroCardFees.test.js: the days the "card fees off changes nothing"
// golden (xeroCardFeesOff.golden.json) is made from, and card payments with a processor
// reference and a fee. No figure here is a real venue's.

const groupedDay = (sales, refunds = [], m = mapping(), day = DAY, venue = UK, taxRates = UK_TAX) =>
  buildGroupedDay({ day, saleRows: sales, refundRows: refunds, venue, taxRates, resolver: makeGroupResolver(m, CATEGORIES) });
export const cardLeg = (minor, extra = {}) => ({ status: 'accepted', amountMinor: minor, processor: 'adyen', ...extra });
export const refundEntry = (o) => ({ taxAmount: 0, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', isFullRefund: false, timestamp: atMs(6), ...o });
export const refundOf = (check, o) => [{ ...check, refunds: [refundEntry(o)] }];
const LATTE = { cat: 'cat-hot_1e945c26', itemId: 'm-latte', price: 3.8, qty: 1, refundQty: 1, taxRateId: 'r20' };
const AMERICANO = { cat: 'cat-hot_1e945c26', itemId: 'm-americano', price: 2.0, qty: 1, refundQty: 1, taxRateId: 'r20' };
const dayBefore = (check, id) => ({ ...check, id, closed_at: new Date(DAY.fromMs - 5 * 3600000).toISOString() });

/** A generated day, as xeroRefundLines.test.js makes them: part refunds, and with `rich` full refunds too. */
export function generatedDay(seed, rich) {
  const r = rng(seed);
  const rows = [];
  const count = rich && seed % 3 === 0 ? 6 : rich ? 80 : 120;
  for (let i = 0; i < count; i++) rows.push(generatedCheck(r, `s${seed}-${i}`, (i % 20) / 1.1));
  const part = (check) => refundEntry({ id: 'x', amount: Math.min(check.total, check.items[0].price), timestamp: atMs(21), legs: undefined,
    tenderMethod: check.tenders.some((t) => t.method === 'card') ? 'card' : 'cash', items: [{ ...check.items[0], refundQty: 1 }] });
  const refunds = rows.filter((_, i) => i % (rich ? 3 : 4) === 1).map((check) => {
    if (!rich || r() >= 0.5) return { ...check, refunds: [part(check)] };
    const cardMinor = Math.round(check.tenders.filter((t) => t.method === 'card').reduce((s, t) => s + t.amount + (t.tip || 0), 0) * 100);
    return { ...check, refunds: [refundEntry({ id: 'f', amount: check.total, tipAmount: check.tip, serviceAmount: check.service, tenderMethod: cardMinor ? 'card' : 'cash', isFullRefund: true, timestamp: atMs(21),
      legs: cardMinor ? [cardLeg(Math.min(cardMinor, Math.round(check.total * 100)))] : [] })] };
  });
  const m = mapping({ clearing: { card: 'CARDCLR', cash: 'CASHTILL' } });
  return { rows, refunds, m, g: groupedDay(rows, refunds, m) };
}

/** A US day (tax added on, Xero "Exclusive"): two 10.00 card sales with 1.00 tax each, one refunded in full. */
export function usDay() {
  const US_TAX = [{ id: 'st', name: 'Sales tax', code: 'ST', rate: 0.1, type: 'exclusive', is_default: true, active: true }];
  const salesTaxRates = revenueTaxRates([
    { TaxType: 'NONE', Name: 'Tax Exempt', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 0 },
    { TaxType: 'TAX001', Name: 'Sales Tax', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 10 },
  ]);
  const venue = { timezone: 'America/New_York', dayStart: '04:00' };
  const day = businessDayWindow(DATE, venue.timezone, venue.dayStart);
  const check = (id) => ({ id, closed_at: new Date(day.fromMs + 3600000).toISOString(), total: 11, tip: 0, service: 0, tax_amount: 1,
    tax_breakdown: { totalTax: 1, total: 11, hasExclusiveTax: true, breakdown: [{ rate: { id: 'st', rate: 0.1, type: 'exclusive' }, gross: 10, tax: 1 }] },
    items: [{ uid: `${id}1`, cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 10, taxRateId: 'st' }], tenders: [{ method: 'card', amount: 11, tip: 0, processor: 'adyen' }] });
  const m = mapping({ taxDefault: 'TAX001' });
  const rows = [check('U1'), check('U2')];
  const refunds = [{ ...check('U1'), refunds: [refundEntry({ id: 'r', amount: 11, taxAmount: 1, isFullRefund: true, timestamp: day.fromMs + 7200000, legs: [cardLeg(1100)] })] }];
  return { day, venue, rows, refunds, m, detail: { salesTaxRates, site: DETAIL.site }, g: groupedDay(rows, refunds, m, day, venue, US_TAX) };
}

/**
 * The days of the golden: no refunds, refunds as minus lines (a plain one, one with a tip, one
 * with a loyalty credit put back), each fall back to a credit note, a US day and two generated
 * days. [{ name, grouped, mapping, detail, site, date, currency }].
 */
export function cardFeesOffDays() {
  const [a, , , d, e] = saleRows();
  const zeroRated = { id: 'Z', closed_at: at(2), total: 8.0, tip: 0, service: 0, tax_amount: 0, tax_breakdown: breakdown([{ id: 'r0', gross: 8.0, tax: 0 }], 'takeaway'),
    items: [{ uid: 'z1', cat: 'cat-food_1e945c26', itemId: 'm-sand', qty: 2, price: 4.0, taxRateId: 'r20', taxOverrides: { takeaway: 'r0', 'dine-in': 'r20' } }], tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'adyen' }] };
  const uk = (name, grouped, m = mapping()) => ({ name, grouped, mapping: m, detail: DETAIL, site: SITE, date: DATE, currency: 'GBP' });
  const us = usDay(), gen = generatedDay(7, false), rich = generatedDay(5, true);
  return [
    uk('noRefunds', groupedDay(saleRows())),
    uk('refundLines', groupedDay(saleRows(), refundRows())),
    uk('refundLinesTip', groupedDay(saleRows(), refundOf(a, { id: 'r3', amount: 8.3, taxAmount: 0.63, tipAmount: 0.5, isFullRefund: true, legs: [cardLeg(830)] }))),
    uk('refundLinesLoyalty', groupedDay(saleRows(), refundOf(d, { id: 'r5', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: [cardLeg(280)], items: [LATTE] }))),
    uk('fallBackAccountShort', groupedDay([a, e], refundOf(e, { id: 'r7', amount: 2.0, taxAmount: 0.34, tenderMethod: 'cash', cardStatus: null, items: [AMERICANO] }))),
    uk('fallBackTotalNotPositive', groupedDay([d], refundOf(dayBefore(e, 'Y'), { id: 'r8', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: [cardLeg(800)] }))),
    uk('fallBackNoSales', groupedDay([], refundRows())),
    uk('fallBackVatNegative', groupedDay([zeroRated], refundOf({ ...dayBefore(d, 'YL'), tenders: [{ method: 'card', amount: 3.8, tip: 0, processor: 'adyen' }] }, { id: 'r11', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: [cardLeg(380)] }))),
    { name: 'usTaxAddedOn', grouped: us.g, mapping: us.m, detail: us.detail, site: SITE, date: DATE, currency: 'USD' },
    uk('generated', gen.g, gen.m),
    uk('generatedRich', rich.g, rich.m),
  ];
}

/** The ways an earlier attempt may have started a day's refunds (refundWayStarted). */
export const STARTED_WAYS = [null, 'lines', 'credit_note', 'refused'];

/**
 * What the golden holds, for every day and every started way: the plan, its view for the Back
 * Office, and each step's key with its Idempotency-Key. `planner` is { planXeroInvoiceDay,
 * planView, planSteps, stepIdempotencyKey }; `mappingExtra` is merged into each day's mapping
 * and `options` into the planner's options, so the test can show that neither moves a byte.
 */
export function cardFeesOffGolden(planner, { mappingExtra = null, options = {} } = {}) {
  const out = {};
  for (const d of cardFeesOffDays()) {
    for (const started of STARTED_WAYS) {
      const m = mappingExtra ? { ...d.mapping, ...mappingExtra } : d.mapping;
      const plan = planner.planXeroInvoiceDay(d.grouped, { mapping: m, detail: d.detail, site: d.site, date: d.date, currency: d.currency, started, ...options });
      out[`${d.name}|${started}`] = { plan, view: planner.planView(plan), steps: planner.planSteps(plan).map((s) => [s.key, planner.stepIdempotencyKey('leeds', d.date, s)]) };
    }
  }
  return out;
}

/** A made up Adyen PSP reference (16 characters) and the till's own key for a reader payment. */
export const psp = (n) => `TESTPSP${String(n).padStart(9, '0')}`;
export const tillRef = (n) => `D9Uy00179181${String(n).padStart(7, '0')}.${psp(n)}`;

/** An adyen_payments row as xeroCardFees.ts reads it: authorised, captured, with the venue's fee. */
export const paymentRow = (n, amountMinor, commissionMinor, extra = {}) => ({
  psp_reference: psp(n), location_id: 'platform-leeds', amount_minor: amountMinor, amount_refunded_minor: 0, success: true, last_event_code: 'AUTHORISATION',
  commission_minor: commissionMinor, authorised_at: at(1), capture_required: false, captured_at: null, applied_mods: null, captured_minor: null, last_mod_code: null, last_mod_ok: null, last_mod_amount: null, ...extra,
});
