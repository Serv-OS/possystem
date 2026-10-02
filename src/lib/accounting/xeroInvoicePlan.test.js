/**
 * xeroInvoicePlan.test.js: the daily sales invoice per site (30 Sep 2026).
 * Run: `npm test`, or `node --test src/lib/accounting/xeroInvoicePlan.test.js`.
 *
 * Pinned:
 *   1. Lines by sales group and VAT rate, minus lines per discount group, tips, service and
 *      gift cards to their accounts, Site tracking on every line. The VAT on the lines of each
 *      rate is the till's VAT to the penny (Huddersfield 28 Sep: Xero works out 1.33 on a line
 *      the till booked 1.34 on; the invoice sends 1.34).
 *   2. The payments come to the invoice total, one per clearing account, and equal what the
 *      older bank transaction posting received per account; the credit note and its refunds
 *      equal what it spent.
 *   3. Numbering SOS-LEEDS-20260929, the -R credit note, the reference and contact, site codes
 *      from slugs (LEEDS, HUDDERSFIELD, STATION, a digit on a clash).
 *   4. A US venue (tax added on top) posts Exclusive: amounts before tax, TaxAmount set, total
 *      equal to the money. The till works US tax out after discounts and loyalty or promo
 *      credits, so all of tax_amount is on the goods lines and the discount and credit lines
 *      carry none (a $10 item with a $2 reward posts 10.00 + 0.80 and -2.00).
 *   5. Refunds only: a credit note and no invoice. A payment kind with no clearing account and
 *      a 0% Xero rate carrying VAT refuse the day; a group with no account goes to Other sales.
 *   6. Payloads are deterministic (so idempotency keys are stable); fee and cash hooks stay off.
 *   7. An item's own discount posts as its discount line; the groups keep their full sales.
 *   8. A retry after a partial post stops before sending anything when what is already in Xero
 *      no longer matches the day (a late check, a remapped clearing account, a new site code).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planXeroInvoiceDay, planView, planSteps, stepIdempotencyKey, invoiceNumber, creditNoteNumber, takingsReference,
  contactName, siteNameFrom, siteCodeFromSlug, dayLabel, xeroDocLink, clearingKeys, clearingLabel, validateInvoiceMapping, paymentAccount,
  seenFromGrouped, retryConflicts,
} from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { buildGroupedDay, makeGroupResolver } from '../../../supabase/functions/_shared/accountingGroups.js';
import { planXeroDay } from '../../../supabase/functions/_shared/xeroPostingPlan.js';
import { revenueTaxRates } from '../../../supabase/functions/_shared/xeroTax.js';
import { businessDayWindow } from '../../../supabase/functions/_shared/businessDay.js';
import {
  UK, DAY, DATE, UK_TAX, CATEGORIES, saleRows, refundRows, mapping, DETAIL, SITE, at, atMs, breakdown, rng, generatedCheck,
} from './xeroInvoiceFixtures.js';

const grouped = (sales, refunds = [], m = mapping(), taxRates = UK_TAX, day = DAY, venue = UK) =>
  buildGroupedDay({ day, saleRows: sales, refundRows: refunds, venue, taxRates, resolver: makeGroupResolver(m, CATEGORIES) });
const plan = (g, m = mapping(), detail = DETAIL, extra = {}) => planXeroInvoiceDay(g, { mapping: m, detail, site: m.site || SITE, date: DATE, currency: 'GBP', ...extra });
const cents = (n) => Math.round(n * 100);
const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);

test('the fixture day: lines by group and rate, VAT per rate is the till VAT to the penny', () => {
  const g = grouped(saleRows(), refundRows());
  const p = plan(g);
  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.notReady, []);
  const inv = p.invoice;
  assert.equal(inv.number, 'SOS-LEEDS-20260929');
  assert.equal(inv.lineAmountTypes, 'Inclusive');
  assert.deepEqual(inv.lines.map((l) => [l.description, l.account, l.taxType, l.amount, l.tax]), [
    ['Food 20%', '202', 'OUTPUT2', 596, 99],
    ['Hot drinks 20%', '201', 'OUTPUT2', 1935, 323],
    ['Customer discounts 20%', '401', 'OUTPUT2', -30, -5],
    ['Loyalty rewards 20%', '403', 'OUTPUT2', -100, -17],
    ['Staff discounts 20%', '402', 'OUTPUT2', -150, -25],
    ['Food 0%', '202', 'ZERORATEDOUTPUT', 400, 0],
    ['Tips and gratuities', '825', 'NONE', 50, 0],
    ['Service charge', '826', 'NONE', 100, 0],
  ]);
  // VAT per Xero rate, from the payload itself, against the till.
  const payloadVat = {};
  for (const li of inv.payload.LineItems) payloadVat[li.TaxType] = cents((payloadVat[li.TaxType] || 0) / 100 + li.TaxAmount) ;
  assert.equal(cents(inv.payload.LineItems.filter((l) => l.TaxType === 'OUTPUT2').reduce((s, l) => s + l.TaxAmount, 0)), g.summary.sales.totals.byRate['rate:r20'].tax);
  assert.equal(g.summary.sales.totals.byRate['rate:r20'].tax, 375);
  for (const t of p.vatTie) assert.equal(t.invoiceVat, t.tillVat, `${t.side} ${t.key}`);
  // Tracking on every line; the site's contact; no email anywhere; paid on the day.
  assert.ok(inv.payload.LineItems.every((l) => l.Tracking?.[0]?.Name === 'Location' && l.Tracking[0].Option === 'Leeds'));
  assert.deepEqual(inv.payload.Contact, { ContactID: DETAIL.site.contactId });
  assert.equal(inv.payload.Type, 'ACCREC');
  assert.equal(inv.payload.Status, 'AUTHORISED');
  assert.equal(inv.payload.Date, DATE);
  assert.equal(inv.payload.DueDate, DATE);
  assert.equal(inv.payload.Reference, 'Coffee Boy Leeds takings Tue 29 Sep 2026');
  assert.equal(inv.payload.CurrencyCode, 'GBP');
  // The total is the day's money, and the payments come to it.
  assert.equal(inv.total, g.summary.sales.totals.gross);
  assert.equal(cents(sumBy(inv.payload.LineItems, (l) => l.UnitAmount)), inv.total);
  assert.equal(sumBy(p.payments, (x) => x.amount), inv.total);
  assert.deepEqual(p.payments.map((x) => [x.key, x.amount, x.reference]), [
    ['PAY:CARDCLR', 830 + 400 + 280 + 800, 'SOS-LEEDS-20260929 Card'],
    ['PAY:CASHTILL', 266 + 225, 'SOS-LEEDS-20260929 Cash'],
  ]);
  // Xero's Payments name the account { Code } or { AccountID } (line items use AccountCode).
  assert.deepEqual(p.payments[0].payload, { Invoice: { InvoiceNumber: 'SOS-LEEDS-20260929' }, Account: { Code: 'CARDCLR' }, Date: DATE, Amount: 23.1, Reference: 'SOS-LEEDS-20260929 Card' });
  assert.deepEqual(paymentAccount('6026f133-3895-4787-9b7a-31497b0d8fc9'), { AccountID: '6026f133-3895-4787-9b7a-31497b0d8fc9' });
  assert.equal(paymentAccount(''), null);
  assert.equal(inv.payload.LineItems[0].AccountCode, '202', 'line items take AccountCode');
  // The refund: a credit note with its refund payment from card clearing.
  assert.equal(p.creditNote.number, 'SOS-LEEDS-20260929-R');
  assert.equal(p.creditNote.payload.Type, 'ACCRECCREDIT');
  assert.equal(p.creditNote.total, 380);
  assert.deepEqual(p.refundPayments.map((x) => [x.key, x.amount]), [['REFUND:CARDCLR', 380]]);
  assert.deepEqual(p.refundPayments[0].payload.CreditNote, { CreditNoteNumber: 'SOS-LEEDS-20260929-R' });
  // The refunded latte is one 20% line with its own VAT (not 1.85 at 20% carrying 0.63).
  assert.deepEqual(p.creditNote.lines.map((l) => [l.description, l.amount, l.tax, l.xeroCalc]), [['Hot drinks 20%', 380, 63, 63]]);
  assert.ok(!p.warnings.some((w) => w.code === 'vat_override_large'));
  assert.deepEqual(p.hooks, { feeBill: null, cashVariance: null });
  assert.deepEqual(planSteps(p).map((s) => s.key), ['INVOICE', 'PAY:CARDCLR', 'PAY:CASHTILL', 'CREDIT', 'REFUND:CARDCLR']);
});

test('the Huddersfield 28 Sep case: the till booked 1.34, Xero would work out 1.33, the invoice sends 1.34', () => {
  const row = { id: 'H', closed_at: at(2), total: 8.0, tip: 0, service: 0, tax_amount: 1.34, tax_breakdown: breakdown([{ id: 'r20', gross: 8.0, tax: 1.34 }]),
    items: [{ uid: 'h1', cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 8.0, taxRateId: 'r20' }], tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'adyen' }] };
  const p = plan(grouped([row]));
  const line = p.invoice.lines[0];
  assert.equal(line.tax, 134);
  assert.equal(line.xeroCalc, 133);
  assert.equal(p.invoice.payload.LineItems[0].TaxAmount, 1.34);
  assert.deepEqual(p.vatTie.map((t) => [t.tillVat, t.invoiceVat, t.xeroCalc]), [[134, 134, 133]]);
  assert.ok(!p.warnings.some((w) => w.code === 'vat_override_large'), 'a penny is within tolerance');
});

test('payments per account equal the older posting per account; the credit note equals its refunds', () => {
  const g = grouped(saleRows(), refundRows());
  const p = plan(g);
  const old = planXeroDay(g.summary, { mapping: { paymentMap: { card: 'CARDCLR', cash: 'CASHTILL' } }, detail: DETAIL, site: SITE });
  const receive = Object.fromEntries(old.transactions.filter((t) => t.direction === 'RECEIVE').map((t) => [t.accountId, t.totals.gross]));
  const spend = Object.fromEntries(old.transactions.filter((t) => t.direction === 'SPEND').map((t) => [t.accountId, t.totals.gross]));
  assert.deepEqual(Object.fromEntries(p.payments.map((x) => [x.account, x.amount])), receive);
  assert.deepEqual(Object.fromEntries(p.refundPayments.map((x) => [x.account, x.amount])), spend);
  assert.equal(p.invoice.total - p.creditNote.total, sumBy(Object.values(receive), (v) => v) - sumBy(Object.values(spend), (v) => v));
  // The same VAT as the older posting books: the till's.
  const oldVat = old.transactions.filter((t) => t.direction === 'RECEIVE').reduce((s, t) => s + t.vat.booked, 0);
  assert.equal(p.totals.vat, oldVat);
});

test('generated days: every rate ties, payments equal the invoice, the credit note equals the refunds', () => {
  for (const seed of [1, 7, 42, 2026]) {
    const r = rng(seed);
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push(generatedCheck(r, `s${seed}-${i}`, (i % 20) / 1.1));
    const refunds = rows.filter((_, i) => i % 4 === 1).map((row) => ({ ...row, refunds: [{ id: 'x', amount: Math.min(row.total, row.items[0].price), tipAmount: 0, serviceAmount: 0,
      tenderMethod: row.tenders.some((t) => t.method === 'card') ? 'card' : 'cash', cardStatus: 'accepted', timestamp: atMs(21), items: [{ ...row.items[0], refundQty: 1 }] }] }));
    const m = mapping({ clearing: { card: 'CARDCLR', cash: 'CASHTILL' } });
    const g = grouped(rows, refunds, m);
    const p = plan(g, m);
    assert.deepEqual(p.blocked, [], `seed ${seed}`);
    assert.equal(p.invoice.total, g.summary.sales.totals.gross);
    assert.equal(sumBy(p.payments, (x) => x.amount), p.invoice.total);
    assert.equal(p.creditNote.total, g.summary.refunds.totals.gross);
    assert.equal(sumBy(p.refundPayments, (x) => x.amount), p.creditNote.total);
    for (const t of p.vatTie) assert.equal(t.invoiceVat, t.tillVat, `seed ${seed} ${t.side} ${t.key}`);
    assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount)), p.invoice.total);
  }
});

test('numbering, references, contact, site names and codes', () => {
  assert.equal(invoiceNumber('LEEDS', '2026-09-29'), 'SOS-LEEDS-20260929');
  assert.equal(creditNoteNumber('LEEDS', '2026-09-29'), 'SOS-LEEDS-20260929-R');
  assert.equal(dayLabel('2026-09-29'), 'Tue 29 Sep 2026');
  assert.equal(dayLabel('2026-10-04'), 'Sun 4 Oct 2026');
  assert.equal(takingsReference('Coffee Boy Leeds', '2026-09-29'), 'Coffee Boy Leeds takings Tue 29 Sep 2026');
  assert.equal(contactName('Coffee Boy Leeds'), 'Coffee Boy Leeds (ServOS takings)');
  assert.equal(siteNameFrom('Coffee Boy  - Headingly'), 'Coffee Boy Headingly');
  assert.equal(siteNameFrom('Coffee Boy - Barnsley Train Station'), 'Coffee Boy Barnsley Train Station');
  assert.equal(siteNameFrom(' Coffee Boy Leeds '), 'Coffee Boy Leeds');
  // Coffee Boy's live slugs (Platform locations.online_slug).
  const slugs = ['coffee-boy-leeds', 'coffee-boy-huddersfield', 'coffeeboystation', 'coffee-boy-headingly', 'coffee-boy-barnsley', 'coffee-boy-preston'];
  const others = (s) => slugs.filter((x) => x !== s);
  assert.equal(siteCodeFromSlug('coffee-boy-leeds', others('coffee-boy-leeds')), 'LEEDS');
  assert.equal(siteCodeFromSlug('coffee-boy-huddersfield', others('coffee-boy-huddersfield')), 'HUDDERSFIELD');
  assert.equal(siteCodeFromSlug('coffeeboystation', others('coffeeboystation')), 'STATION');
  assert.equal(siteCodeFromSlug('coffee-boy-headingly', others('coffee-boy-headingly')), 'HEADINGLY');
  assert.equal(siteCodeFromSlug('coffee-boy-leeds', others('coffee-boy-leeds'), ['LEEDS']), 'LEEDS2', 'a digit when taken');
  assert.equal(siteCodeFromSlug('coffee-boy-leeds', others('coffee-boy-leeds'), ['LEEDS', 'LEEDS2']), 'LEEDS3');
  assert.equal(siteCodeFromSlug('the-grand-hotel-restaurant-and-bar', []), 'BAR');
  assert.equal(siteCodeFromSlug('downtown', []), 'DOWNTOWN');
  assert.equal(siteCodeFromSlug('', []), 'SITE');
  assert.match(siteCodeFromSlug('a-very-long-location-name-indeed', ['a-other']), /^[A-Z0-9]{2,12}$/);
  // Links open the right organisation when Xero gave us its short code.
  assert.equal(xeroDocLink('invoice', 'abc', '!xkcD'), 'https://go.xero.com/organisationlogin/default.aspx?shortcode=!xkcD&redirecturl=/AccountsReceivable/View.aspx?InvoiceID=abc');
  assert.equal(xeroDocLink('credit_note', 'cn1'), 'https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=cn1');
  assert.equal(xeroDocLink('bank', 'bt1'), 'https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=bt1');
  assert.equal(xeroDocLink('invoice', null), null);
  // Clearing keys, most specific first.
  assert.deepEqual(clearingKeys({ kind: 'card', processor: 'adyen' }), ['card:adyen', 'card']);
  assert.deepEqual(clearingKeys({ kind: 'card', processor: null }), ['card:none', 'card']);
  assert.deepEqual(clearingKeys({ kind: 'other', method: 'deliveroo' }), ['other:deliveroo', 'other']);
  assert.deepEqual(clearingKeys({ kind: 'cash' }), ['cash']);
  assert.equal(clearingLabel('card:adyen'), 'Card (Adyen)');
  assert.equal(clearingLabel('card:none'), 'Card (other machine)');
  assert.equal(clearingLabel('gift_card'), 'Gift cards');
});

test('a processor specific clearing account wins over the card default', () => {
  const rows = saleRows();
  rows[4].tenders = [{ method: 'card', amount: 8.0, tip: 0, processor: null }];   // taken on another machine
  const m = mapping({ clearing: { 'card:adyen': 'ADYENCLR', card: 'OTHERCARD', cash: 'CASHTILL' } });
  const p = plan(grouped(rows, [], m), m);
  assert.deepEqual(p.payments.map((x) => [x.account, x.amount, x.reference]), [
    ['ADYENCLR', 830 + 400 + 280, 'SOS-LEEDS-20260929 Card (Adyen)'],
    ['OTHERCARD', 800, 'SOS-LEEDS-20260929 Card'],
    ['CASHTILL', 491, 'SOS-LEEDS-20260929 Cash'],
  ]);
});

test('a US venue posts Exclusive: amounts before tax, TaxAmount set, the total is the money', () => {
  const US_TAX = [{ id: 'ny', name: 'NYC Sales Tax', code: 'NYC', rate: 0.08875, type: 'exclusive', is_default: true, active: true }];
  const US_XERO = revenueTaxRates([
    { TaxType: 'NONE', Name: 'Tax Exempt', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 0 },
    { TaxType: 'TAX001', Name: 'NYC Sales Tax', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 8.875 },
  ]);
  const NY = { timezone: 'America/New_York', dayStart: '04:00' };
  const day = businessDayWindow(DATE, NY.timezone, NY.dayStart);
  const row = { id: 'US1', closed_at: new Date(day.fromMs + 3600000).toISOString(), total: 12.89, tip: 2.0, service: 0, tax_amount: 0.89,
    tax_breakdown: { totalTax: 0.89, total: 10.89, hasExclusiveTax: true, breakdown: [{ rate: { id: 'ny', rate: 0.08875, type: 'exclusive' }, gross: 10, tax: 0.8875 }] },
    items: [{ uid: 'u1', cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 10, taxRateId: 'ny' }],
    tenders: [{ method: 'card', amount: 10.89, tip: 2.0, processor: 'adyen' }] };
  const m = mapping({ taxDefault: 'TAX001' });
  const g = buildGroupedDay({ day, saleRows: [row], venue: NY, taxRates: US_TAX, resolver: makeGroupResolver(m, CATEGORIES) });
  const p = planXeroInvoiceDay(g, { mapping: m, detail: { salesTaxRates: US_XERO, site: DETAIL.site }, site: SITE, date: DATE, currency: 'USD' });
  assert.deepEqual(p.blocked, []);
  const inv = p.invoice;
  assert.equal(inv.lineAmountTypes, 'Exclusive');
  assert.equal(inv.payload.LineAmountTypes, 'Exclusive');
  const sale = inv.payload.LineItems[0];
  assert.deepEqual([sale.Description, sale.TaxType, sale.UnitAmount, sale.TaxAmount], ['Hot drinks', 'TAX001', 10, 0.89]);
  const tip = inv.payload.LineItems[1];
  assert.deepEqual([tip.Description, tip.TaxType, tip.UnitAmount, tip.TaxAmount], ['Tips and gratuities', 'NONE', 2, 0]);
  assert.equal(cents(sumBy(inv.payload.LineItems, (l) => l.UnitAmount + l.TaxAmount)), 1289);
  assert.equal(inv.total, 1289);
  assert.equal(sumBy(p.payments, (x) => x.amount), 1289);
  // A US venue with no sales tax rate chosen: No VAT carrying tax refuses the day.
  const bad = planXeroInvoiceDay(g, { mapping: mapping(), detail: { salesTaxRates: US_XERO }, site: SITE, date: DATE });
  assert.ok(bad.blocked.some((b) => b.code === 'zero_rate_with_vat'));
});

// A US day at 10% added-on tax (the till taxes what is left after discounts and credits).
const US10_TAX = [{ id: 'st', name: 'Sales tax', code: 'ST', rate: 0.1, type: 'exclusive', is_default: true, active: true }];
const US10_XERO = revenueTaxRates([
  { TaxType: 'NONE', Name: 'Tax Exempt', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 0 },
  { TaxType: 'TAX001', Name: 'Sales Tax', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 10 },
]);
const NY = { timezone: 'America/New_York', dayStart: '04:00' };
function usPlan(rows, refunds = []) {
  const day = businessDayWindow(DATE, NY.timezone, NY.dayStart);
  const m = mapping({ taxDefault: 'TAX001' });
  const at1 = new Date(day.fromMs + 3600000).toISOString();
  const g = buildGroupedDay({ day, saleRows: rows.map((r) => ({ closed_at: at1, ...r })), refundRows: refunds, venue: NY, taxRates: US10_TAX, resolver: makeGroupResolver(m, CATEGORIES) });
  return { g, p: planXeroInvoiceDay(g, { mapping: m, detail: { salesTaxRates: US10_XERO, site: DETAIL.site }, site: SITE, date: DATE, currency: 'USD' }) };
}
const usBreakdown = (tax, total) => ({ totalTax: tax, total, hasExclusiveTax: true, breakdown: [{ rate: { id: 'st', rate: 0.1, type: 'exclusive' }, gross: total - tax, tax }] });

test('US: a loyalty reward lowers the taxed amount, so all the tax is on the goods and the reward carries none', () => {
  // Reviewer's case, 30 Sep: a $10 item, a $2 loyalty reward, $0.80 tax, card $8.80. Before, the
  // invoice booked 0.65 of tax (0.15 of it pro rata on the reward) against 0.80 collected.
  const row = { id: 'USL', total: 10.8, tip: 0, service: 0, tax_amount: 0.8, tax_breakdown: usBreakdown(0.8, 8.8),
    items: [{ uid: 'u1', cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 10, taxRateId: 'st' }],
    tenders: [{ method: 'loyalty', amount: 2.0, tip: 0 }, { method: 'card', amount: 8.8, tip: 0, processor: 'adyen' }] };
  const { p } = usPlan([row]);
  assert.deepEqual(p.blocked, []);
  const li = p.invoice.payload.LineItems;
  assert.deepEqual(li.map((l) => [l.Description, l.TaxType, l.UnitAmount, l.TaxAmount]), [
    ['Hot drinks', 'TAX001', 10, 0.8],
    ['Loyalty rewards', 'TAX001', -2, 0],
  ]);
  assert.equal(cents(sumBy(li, (l) => l.TaxAmount)), 80, 'the tax booked is tax_amount');
  assert.equal(cents(sumBy(li, (l) => l.UnitAmount + l.TaxAmount)), 880, 'the invoice is the money');
  assert.deepEqual(p.vatTie.map((t) => [t.tillVat, t.invoiceVat, t.xeroCalc]), [[80, 80, 80]]);
  assert.equal(sumBy(p.payments, (x) => x.amount), 880);
  assert.ok(!p.warnings.some((w) => w.code === 'vat_override_large'), 'per rate, Xero works out the same');
});

test('US: a check discount is before tax, so gross sales and discounts match the POS reports', () => {
  // A $10 item, a $2 check discount, tax 0.80, card 8.80. Before: goods 9.82 and discount -1.82.
  const row = { id: 'USD', total: 8.8, tip: 0, service: 0, tax_amount: 0.8, tax_breakdown: usBreakdown(0.8, 8.8),
    items: [{ uid: 'u1', cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 10, taxRateId: 'st' }],
    discounts: [{ id: 'd', label: 'Custom $2.00', type: 'amount', value: 2, scope: 'check', amount: 2, itemUids: null }],
    tenders: [{ method: 'card', amount: 8.8, tip: 0, processor: 'adyen' }] };
  const { p } = usPlan([row]);
  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.invoice.payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.TaxAmount]), [
    ['Hot drinks', 10, 0.8],
    ['Customer discounts', -2, 0],
  ]);
  assert.deepEqual(p.vatTie.map((t) => [t.tillVat, t.invoiceVat]), [[80, 80]]);
  // Generated US days with discounts and credits: the tax on the invoice is always tax_amount.
  const r = rng(99);
  const rows = [];
  let taxSum = 0;
  for (let i = 0; i < 60; i++) {
    const price = Math.round((2 + r() * 20) * 100) / 100;
    const disc = r() < 0.4 ? Math.round(price * 0.2 * 100) / 100 : 0;
    const credit = r() < 0.3 ? Math.min(1.5, price - disc) : 0;
    const net = Math.round((price - disc - credit) * 100) / 100;
    const tax = Math.round(net * 10) / 100;
    taxSum += Math.round(tax * 100);
    rows.push({ id: `g${i}`, total: net + tax + credit, tip: 0, service: 0, tax_amount: tax, tax_breakdown: usBreakdown(tax, net + tax),
      items: [{ uid: `g${i}a`, cat: i % 2 ? 'cat-hot_1e945c26' : 'cat-food_1e945c26', itemId: 'm', qty: 1, price, taxRateId: 'st' }],
      discounts: disc ? [{ label: 'Custom 20%', type: 'percent', value: 20, scope: 'check', amount: disc }] : [],
      tenders: [...(credit ? [{ method: 'loyalty', amount: credit, tip: 0 }] : []), { method: 'card', amount: Math.round((net + tax) * 100) / 100, tip: 0, processor: 'adyen' }] });
  }
  const gen = usPlan(rows).p;
  assert.deepEqual(gen.blocked, []);
  assert.equal(cents(sumBy(gen.invoice.payload.LineItems, (l) => l.TaxAmount)), taxSum);
  assert.equal(cents(sumBy(gen.invoice.payload.LineItems, (l) => l.UnitAmount + l.TaxAmount)), gen.invoice.total);
  assert.ok(gen.invoice.payload.LineItems.filter((l) => /discounts|rewards/i.test(l.Description)).every((l) => l.TaxAmount === 0));
});

test("an item's own discount posts as its discount line (the staff 50% on a muffin)", () => {
  const row = { id: 'SD', closed_at: at(2), total: 5.3, tip: 0, service: 0, tax_amount: 0.88, tax_breakdown: breakdown([{ id: 'r20', gross: 5.3, tax: 0.8833 }]),
    items: [
      { uid: 's1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' },
      { uid: 's2', cat: 'cat-cake_1e945c26', itemId: 'm-muffin', qty: 1, price: 3.0, taxRateId: 'r20', discount: { id: 'disc-s2', label: 'Staff Discount 50%', type: 'percent', value: 50 } },
    ],
    tenders: [{ method: 'card', amount: 5.3, tip: 0, processor: 'adyen' }] };
  const p = plan(grouped([row]));
  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.invoice.lines.map((l) => [l.description, l.account, l.amount]), [
    ['Food 20%', '202', 300], ['Hot drinks 20%', '201', 380], ['Staff discounts 20%', '402', -150],
  ]);
  assert.equal(sumBy(p.invoice.lines, (l) => l.tax), 88);
  assert.deepEqual(seenFromGrouped(grouped([row])).discountGroups, ['staff'], 'the Ready checklist asks for the staff discount account');
});

test('a retry stops before sending when what Xero already holds no longer matches the day', () => {
  const p = plan(grouped(saleRows(), refundRows()));
  const inv = { status: 'posted', id: 'inv-1', number: 'SOS-LEEDS-20260929', total: p.invoice.total / 100 };
  const card = { status: 'posted', id: 'pay-1', reference: 'SOS-LEEDS-20260929 Card', total: p.payments[0].amount / 100 };
  // The same day: nothing in the way (the cash payment is still to send).
  assert.deepEqual(retryConflicts(p, { INVOICE: inv, 'PAY:CARDCLR': card }), []);
  assert.deepEqual(retryConflicts(p, {}), []);
  assert.deepEqual(retryConflicts(p, null), []);
  // A late check since the invoice was sent: its total in Xero is not the day's now.
  const late = retryConflicts(p, { INVOICE: { ...inv, total: 20.01 } });
  assert.equal(late[0].code, 'posted_amount_changed');
  assert.match(late[0].message, /SOS-LEEDS-20260929 is in Xero for 20\.01; the day now comes to 28\.01/);
  // Card moved to another clearing account: the card money already paid is not in the plan.
  const moved = retryConflicts(p, { INVOICE: inv, 'PAY:OLDCARD': { ...card } });
  assert.equal(moved[0].code, 'posted_not_in_plan');
  // A payment already sent for a different amount.
  assert.equal(retryConflicts(p, { INVOICE: inv, 'PAY:CARDCLR': { ...card, total: 1 } })[0].code, 'posted_amount_changed');
  // The site code changed while the invoice's answer was lost: never looked up under the new number.
  const code = retryConflicts(p, { INVOICE: { status: 'sending', number: 'SOS-LDS-20260929', total: 28.01 } });
  assert.equal(code[0].code, 'number_changed');
  assert.match(code[0].message, /Put the site code back to LDS/);
  assert.equal(retryConflicts(p, { CREDIT: { status: 'sending', number: 'SOS-LDS-20260929-R' } })[0].code, 'number_changed');
  // A 'sending' record under the same number is looked up, not refused.
  assert.deepEqual(retryConflicts(p, { INVOICE: { status: 'sending', number: 'SOS-LEEDS-20260929', total: 1 } }), []);
  // Older model keys are never compared here (dayModel keeps those days on the older model).
  assert.deepEqual(retryConflicts(p, { 'RECEIVE:x': { status: 'posted', total: 5 } }), []);
});

test('a day with refunds only posts a credit note and no invoice', () => {
  const p = plan(grouped([], refundRows()));
  assert.equal(p.invoice, null);
  assert.deepEqual(p.payments, []);
  assert.equal(p.creditNote.total, 380);
  assert.deepEqual(planSteps(p).map((s) => s.key), ['CREDIT', 'REFUND:CARDCLR']);
});

test('refused and warned: money with no clearing account, a 0% rate with VAT, a group with no account', () => {
  const noCash = mapping({ clearing: { card: 'CARDCLR' } });
  const p1 = plan(grouped(saleRows(), [], noCash), noCash);
  const b = p1.blocked.find((x) => x.code === 'clearing_unmapped');
  assert.ok(b && /Cash/.test(b.message), 'cash is money: never guessed');
  assert.equal(b.key, 'cash');

  const zero = mapping({ taxRateMap: { r20: 'ZERORATEDOUTPUT' } });
  const p2 = plan(grouped(saleRows(), [], zero), zero);
  assert.ok(p2.blocked.some((x) => x.code === 'zero_rate_with_vat'));

  const noFood = mapping({ groups: { 'hot-drinks': { name: 'Hot drinks', account: '201' } } });
  const p3 = plan(grouped(saleRows(), [], noFood), noFood);
  assert.deepEqual(p3.blocked, []);
  const w = p3.warnings.find((x) => x.code === 'group_unmapped');
  assert.deepEqual(w.groups, ['Food']);
  assert.ok(p3.invoice.lines.filter((l) => l.group === 'food').every((l) => l.account === '200'), 'Other sales');

  const noOther = mapping({ otherSalesAccount: undefined, groups: {} });
  const p4 = plan(grouped(saleRows(), [], noOther), noOther);
  assert.ok(p4.notReady.some((x) => x.code === 'other_sales'));

  const noSite = mapping({ site: { name: 'Coffee Boy Leeds' } });
  const p5 = planXeroInvoiceDay(grouped(saleRows(), [], noSite), { mapping: noSite, detail: DETAIL, site: noSite.site, date: DATE });
  assert.ok(p5.notReady.some((x) => x.code === 'site_code'));

  // A ServOS rate with no Xero sales rate refuses the day and names it (for the rate rows on screen).
  const tax5 = [...UK_TAX, { id: 'r5', name: 'Reduced', code: 'VAT5', rate: 0.05, type: 'inclusive', is_default: false, active: true }];
  const five = { id: 'F', closed_at: at(2), total: 2.1, tip: 0, service: 0, tax_amount: 0.1,
    tax_breakdown: { totalTax: 0.1, total: 2.1, hasExclusiveTax: false, breakdown: [{ rate: { id: 'r5', rate: 0.05, type: 'inclusive', name: 'Reduced' }, gross: 2.1, tax: 0.1 }] },
    items: [{ uid: 'f1', cat: 'cat-food_1e945c26', itemId: 'm1', qty: 1, price: 2.1, taxRateId: 'r5' }], tenders: [{ method: 'cash', amount: 2.1, tip: 0 }] };
  const only20 = revenueTaxRates([{ TaxType: 'OUTPUT2', Name: '20%', Status: 'ACTIVE', CanApplyToRevenue: 'true', EffectiveRate: '20' }]);
  const p6 = plan(grouped([five], [], mapping(), tax5), mapping(), { ...DETAIL, salesTaxRates: only20 });
  assert.deepEqual(p6.blockedRates, [{ key: 'rate:r5', name: 'Reduced', pct: 5 }]);
  assert.match(p6.blocked.find((x) => x.code === 'tax_rate_unmapped').message, /Reduced \(5%\)/);
});

test('gift cards sold post at No VAT to the gift card liability; spends are a payment from it', () => {
  const sold = { id: 'GS', closed_at: at(2), total: 23.8, tip: 0, service: 0, tax_amount: 0.63,
    tax_breakdown: breakdown([{ id: 'r20', gross: 3.8, tax: 0.6333 }, { id: 'rnv', gross: 20, tax: 0 }]),
    items: [{ uid: 'g1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' }, { uid: 'g2', cat: 'cat-gift_1e945c26', itemId: 'gift', qty: 1, price: 20, taxRateId: 'rnv', isGiftCard: true }],
    tenders: [{ method: 'card', amount: 23.8, tip: 0, processor: 'adyen' }] };
  const spent = { id: 'GR', closed_at: at(3), total: 3.8, tip: 0, service: 0, tax_amount: 0.63, tax_breakdown: breakdown([{ id: 'r20', gross: 3.8, tax: 0.6333 }]),
    items: [{ uid: 's1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' }], tenders: [{ method: 'gift_card', amount: 3.8, tip: 0 }] };
  const p = plan(grouped([sold, spent]));
  assert.deepEqual(p.blocked, []);
  const gift = p.invoice.lines.find((l) => l.kind === 'gift');
  assert.deepEqual([gift.description, gift.account, gift.taxType, gift.amount, gift.tax], ['Gift cards sold', '830', 'NONE', 2000, 0]);
  assert.ok(!p.invoice.payload.LineItems.some((l) => l.TaxType === 'ZERORATEDOUTPUT' && /Gift/.test(l.Description)), 'never zero rated');
  assert.deepEqual(p.payments.map((x) => [x.account, x.amount]), [['CARDCLR', 2380], ['830', 380]]);
  for (const t of p.vatTie) assert.equal(t.invoiceVat, t.tillVat);
});

test('deterministic payloads and stable idempotency keys; fee and cash hooks stay off', () => {
  const a = plan(grouped(saleRows(), refundRows()));
  const b = plan(grouped(saleRows().reverse(), refundRows()));
  assert.deepEqual(a.invoice.payload, b.invoice.payload);
  assert.deepEqual(a.payments, b.payments);
  const sa = planSteps(a), sb = planSteps(b);
  assert.deepEqual(sa.map((s) => stepIdempotencyKey('loc-1', DATE, s)), sb.map((s) => stepIdempotencyKey('loc-1', DATE, s)));
  const key = stepIdempotencyKey('loc-1', DATE, sa[0]);
  assert.match(key, /^servos-loc-1-2026-09-29-INVOICE-[0-9a-f]{8}$/);
  const other = plan(grouped(saleRows().slice(1), refundRows()));
  assert.notEqual(stepIdempotencyKey('loc-1', DATE, planSteps(other)[0]), key, 'a changed invoice gets a new key');

  const withHooks = planXeroInvoiceDay(grouped(saleRows()), { mapping: mapping(), detail: DETAIL, site: SITE, date: DATE, fees: { commission: 123 }, cash: { variance: -49 } });
  assert.deepEqual(withHooks.hooks, { feeBill: null, cashVariance: null });
  assert.match(validateInvoiceMapping({ feeBill: { enabled: true } }), /not available yet/);
  assert.match(validateInvoiceMapping({ cashVariance: { enabled: true } }), /not available yet/);
});

test('the view for the Back Office is in major units and keeps the exact payloads', () => {
  const p = plan(grouped(saleRows(), refundRows()));
  const v = planView(p);
  assert.equal(v.number, 'SOS-LEEDS-20260929');
  assert.equal(v.tracking, 'Location: Leeds');
  assert.equal(v.invoice.total, 28.01);
  assert.equal(v.invoice.lines[1].vat, 3.23);
  assert.deepEqual(v.invoice.payload, p.invoice.payload);
  assert.equal(v.payments[0].amount, 23.1);
  assert.equal(v.creditNote.total, 3.8);
  assert.deepEqual(v.totals, { sales: 28.01, refunds: 3.8, vat: 3.75 });
});

test('no tracking when the site is alone on its Xero; the contact by name before it exists', () => {
  const m = mapping({ tracking: { none: true } });
  const p = planXeroInvoiceDay(grouped(saleRows(), [], m), { mapping: m, detail: { salesTaxRates: DETAIL.salesTaxRates }, site: SITE, date: DATE });
  assert.ok(p.invoice.payload.LineItems.every((l) => !l.Tracking));
  assert.deepEqual(p.invoice.payload.Contact, { Name: 'Coffee Boy Leeds (ServOS takings)' });
  // The option names read from Xero at post time win over the saved ones (renamed in Xero).
  const live = planXeroInvoiceDay(grouped(saleRows()), { mapping: mapping(), detail: { ...DETAIL, site: { ...DETAIL.site, tracking: { categoryId: 'tc-1', categoryName: 'Site', optionId: 'to-leeds', optionName: 'Leeds city' } } }, site: SITE, date: DATE });
  assert.deepEqual(live.invoice.payload.LineItems[0].Tracking, [{ Name: 'Site', Option: 'Leeds city' }]);
});

test('what a day holds for the Ready checklist: groups, discount groups, money kinds, tips, service, gift cards', () => {
  const seen = seenFromGrouped(grouped(saleRows(), refundRows()));
  assert.deepEqual(seen.groups, ['food', 'hot-drinks']);
  assert.deepEqual(seen.discountGroups, ['customer', 'loyalty', 'staff']);
  assert.deepEqual(seen.moneyKeys, ['card:adyen', 'cash']);
  assert.equal(seen.tips, true);
  assert.equal(seen.service, true);
  assert.equal(seen.gift, false);
  assert.equal(seen.deposits, false);
  assert.equal(seen.unresolvedShare, 0);
  assert.equal(seen.names['hot-drinks'], 'Hot drinks');
});
