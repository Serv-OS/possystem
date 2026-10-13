/**
 * xeroRefundLines.test.js: refunds as minus lines on the day's Xero sales invoice (13 Oct 2026).
 * Run: `npm test`, or `node --test src/lib/accounting/xeroRefundLines.test.js`.
 *
 * The venue's accountant: "Refunds are coming in as separate invoices. This would be much easier
 * for us if the refunds were included in the original invoice." Their last till (Lightspeed) put
 * a refund on the day's invoice as a minus line.
 *
 * Pinned:
 *   1 to 6    A refund made on a day is a minus line at the end of THAT day's invoice, starting
 *             "Refund: ", on the same account, tax type and tracking the credit note used, with
 *             the till's refunded VAT as a minus TaxAmount. Tips, service charge, gift cards and
 *             a loyalty credit put back all move. The invoice total is sales less refunds.
 *   7 to 11   The whole day falls back to the credit note, with a plain warning saying why, when
 *             the invoice could not be valid in Xero: a clearing account refunded more than it
 *             took, refunds as large as the sales, refunds and no sales, or more VAT refunded
 *             than charged. A payment that nets to zero is left out.
 *   12, 13    To the penny against the credit note way: per account and tax type, per clearing
 *             account, and in total. US (tax added on) too.
 *   14 to 20  A day is never mixed. The way is read from the log row (refundWayStarted) and
 *             recorded before anything is sent (refundWayToRecord). A half posted day finishes
 *             the way it was started, old or new, and nothing is sent twice. A lost answer is
 *             found. A day whose refund lines Xero refuses goes the credit note way next time.
 *   21, 22    Days posted with a credit note still read correctly in the history and in the
 *             "changed since it was posted" check; the replace day flow keeps working.
 *   23, 24    The words are plain, with no dashes; xero-sales and xero-config are wired to the
 *             pure functions tested here; nothing about being Ready or the figures tick moved.
 *   25 to 28  (review, 13 Oct 2026) Only Xero's own "no" to the invoice a run sent says anything
 *             about its refund lines. A lock date, or an invoice Xero refuses without its refund
 *             lines too, never leaves a day as a credit note day: it stays free and goes with
 *             its refund lines once the cause is put right. A failed lookup or a number Xero
 *             says is taken says nothing. A day switched after a refusal keeps saying why.
 *   29        The Back Office screens: what the invoice preview and the Postings history say,
 *             and when, for a new day, a day that fell back, a day posted before this, and an
 *             answer from an older server.
 *
 * "The credit note way" in these tests is the same day planned with started 'credit_note': the
 * plan a day started before 13 Oct 2026 gets, the same payloads as before that date.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planXeroInvoiceDay, planView, planSteps, retryConflicts, dayModel, mappingHash, invoiceReadiness, seenFromGrouped, xeroDocLink,
  refundWayStarted, refundWayToRecord, invoiceRefusal, refusalPatch, refusalWords, isNumberTaken, dayNumbers, postedDayChanges, historyDocs,
} from '../../../supabase/functions/_shared/xeroInvoicePlan.js';
import { postInvoiceDay } from '../../../supabase/functions/_shared/xeroInvoicePost.ts';
import { claimSyncRun, readSyncRow } from '../../../supabase/functions/_shared/syncRun.ts';
import { allDeletedPatch, previewView, xeroErrorWords } from '../../../supabase/functions/_shared/xeroReplacePlan.js';
import { previewWords, historyRefundNote } from '../../backoffice/sections/xero/xeroUi.js';
import { buildGroupedDay, makeGroupResolver } from '../../../supabase/functions/_shared/accountingGroups.js';
import { revenueTaxRates } from '../../../supabase/functions/_shared/xeroTax.js';
import { businessDayWindow } from '../../../supabase/functions/_shared/businessDay.js';
import {
  UK, DAY, DATE, UK_TAX, CATEGORIES, saleRows, refundRows, mapping, DETAIL, SITE, at, atMs, breakdown, rng, generatedCheck,
} from './xeroInvoiceFixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const grouped = (sales, refunds = [], m = mapping()) =>
  buildGroupedDay({ day: DAY, saleRows: sales, refundRows: refunds, venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(m, CATEGORIES) });
const plan = (g, extra = {}, m = mapping()) => planXeroInvoiceDay(g, { mapping: m, detail: DETAIL, site: m.site || SITE, date: DATE, currency: 'GBP', ...extra });
const creditNoteWay = (g, m = mapping()) => plan(g, { started: 'credit_note' }, m);
const cents = (n) => Math.round(n * 100);
const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);
const row = (l) => [l.description, l.account, l.taxType, l.amount, l.tax];
const refundLines = (p) => p.invoice.lines.filter((l) => l.refund).map(row);
const pays = (p) => p.payments.map((x) => [x.key, x.amount, x.reference]);
const steps = (p) => planSteps(p).map((s) => s.key);
const saidWhy = (p) => p.warnings.filter((w) => w.code === 'refunds_as_credit_note');
const DASH = /[\u2013\u2014]/;

// ── the days ─────────────────────────────────────────────────────────────────

const [A, B, C, D, E] = saleRows();
const leg = (minor) => [{ status: 'accepted', amountMinor: minor, processor: 'adyen' }];
const refund = (o) => ({ taxAmount: 0, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', isFullRefund: false, timestamp: atMs(6), ...o });
const refundOf = (check, o) => [{ ...check, refunds: [refund(o)] }];
const LATTE = { cat: 'cat-hot_1e945c26', itemId: 'm-latte', price: 3.8, qty: 1, refundQty: 1, taxRateId: 'r20' };
const SANDWICH = { cat: 'cat-food_1e945c26', itemId: 'm-sand', price: 4.0, qty: 1, refundQty: 1, taxRateId: 'r20', taxOverrides: { takeaway: 'r0', 'dine-in': 'r20' } };
const AMERICANO = { cat: 'cat-hot_1e945c26', itemId: 'm-americano', price: 2.0, qty: 1, refundQty: 1, taxRateId: 'r20' };
const dayBefore = (check, id) => ({ ...check, id, closed_at: new Date(DAY.fromMs - 5 * 3600000).toISOString() });

/** The fixture day: five checks (28.01) and a card refund of the 3.80 latte. */
const plainDay = () => grouped(saleRows(), refundRows());
/** The latte (20%) and the sandwich (0%) of check A refunded to the card, 7.80; the tip kept. */
const twoRatesDay = () => grouped(saleRows(), refundOf(A, { id: 'r2', amount: 7.8, taxAmount: 0.63, legs: leg(780), items: [LATTE, SANDWICH] }));
/** Check A refunded in full to the card with its 0.50 tip, 8.30. */
const tipsDay = () => grouped(saleRows(), refundOf(A, { id: 'r3', amount: 8.3, taxAmount: 0.63, tipAmount: 0.5, isFullRefund: true, legs: leg(830) }));
/** Check C (card 4.00, cash 2.25, service 1.00) refunded in full: 4.00 back to the card, the rest in cash. */
const serviceDay = () => grouped(saleRows(), refundOf(C, { id: 'r4', amount: 6.25, taxAmount: 0.88, serviceAmount: 1.0, isFullRefund: true, legs: leg(400) }));
/** Check D (a 3.80 latte: 1.00 loyalty credit, 2.80 card) refunded in full: the credit is put back. */
const loyaltyDay = () => grouped(saleRows(), refundOf(D, { id: 'r5', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: leg(280), items: [LATTE] }));
/** A gift card sold with a latte, and the gift card refunded to the card the same day. */
const GIFT_CHECK = { id: 'GS', closed_at: at(2), total: 23.8, tip: 0, service: 0, tax_amount: 0.63,
  tax_breakdown: breakdown([{ id: 'r20', gross: 3.8, tax: 0.6333 }, { id: 'rnv', gross: 20, tax: 0 }]),
  items: [{ uid: 'g1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' }, { uid: 'g2', cat: 'cat-gift_1e945c26', itemId: 'gift', qty: 1, price: 20, taxRateId: 'rnv', isGiftCard: true }],
  tenders: [{ method: 'card', amount: 23.8, tip: 0, processor: 'adyen' }] };
const giftDay = () => grouped([GIFT_CHECK, E], refundOf(GIFT_CHECK, { id: 'rg', amount: 20, legs: leg(2000), items: [{ uid: 'g2', cat: 'cat-gift_1e945c26', itemId: 'gift', qty: 1, refundQty: 1, price: 20, taxRateId: 'rnv', isGiftCard: true }] }));
/** Every sale by card (A and E, 16.30), and 2.00 refunded in CASH for one americano. */
const cashShortDay = () => grouped([A, E], refundOf(E, { id: 'r7', amount: 2.0, taxAmount: 0.34, tenderMethod: 'cash', cardStatus: null, items: [AMERICANO] }));
/** One 2.80 card sale, and an 8.00 card refund of a check closed the day before. */
const largerDay = () => grouped([D], refundOf(dayBefore(E, 'Y'), { id: 'r8', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: leg(800) }));
/** One 8.00 card sale, refunded in full the same day. */
const equalDay = () => grouped([E], refundOf(E, { id: 'r8b', amount: 8.0, taxAmount: 1.34, isFullRefund: true, legs: leg(800) }));
/** A refund and no sales. */
const noSalesDay = () => grouped([], refundRows());
/** Card sales (A, E) and one cash sale (B, 2.66), and B refunded in full in cash. */
const zeroNetDay = () => grouped([A, B, E], refundOf(B, { id: 'r10', amount: 2.66, taxAmount: 0.44, tenderMethod: 'cash', cardStatus: null, isFullRefund: true }));
/** One 0% sale (8.00 card), and a 3.80 card refund of a 20% check from the day before. */
const ZERO_RATED = { id: 'Z', closed_at: at(2), total: 8.0, tip: 0, service: 0, tax_amount: 0, tax_breakdown: breakdown([{ id: 'r0', gross: 8.0, tax: 0 }], 'takeaway'),
  items: [{ uid: 'z1', cat: 'cat-food_1e945c26', itemId: 'm-sand', qty: 2, price: 4.0, taxRateId: 'r20', taxOverrides: { takeaway: 'r0', 'dine-in': 'r20' } }], tenders: [{ method: 'card', amount: 8.0, tip: 0, processor: 'adyen' }] };
const vatNegativeDay = () => grouped([ZERO_RATED], refundOf({ ...dayBefore(D, 'YL'), tenders: [{ method: 'card', amount: 3.8, tip: 0, processor: 'adyen' }] }, { id: 'r11', amount: 3.8, taxAmount: 0.63, isFullRefund: true, legs: leg(380) }));
/** A latte paid by gift card the day before, put back on the gift card today (no gift card was spent today). */
const GIFT_SPENT = { id: 'GR', closed_at: new Date(DAY.fromMs - 5 * 3600000).toISOString(), total: 3.8, tip: 0, service: 0, tax_amount: 0.63, tax_breakdown: breakdown([{ id: 'r20', gross: 3.8, tax: 0.6333 }]),
  items: [{ uid: 's1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' }], tenders: [{ method: 'gift_card', amount: 3.8, tip: 0 }] };
const giftPutBackDay = () => grouped(saleRows(), refundOf(GIFT_SPENT, { id: 'rgb', amount: 3.8, taxAmount: 0.63, tenderMethod: 'gift_card', cardStatus: null, isFullRefund: true }));
/** No VAT on either side: two 0% sandwiches sold by card (8.00), one refunded to the card (4.00). */
const zeroVatDay = () => grouped([ZERO_RATED], refundOf(ZERO_RATED, { id: 'rz', amount: 4.0, taxAmount: 0, legs: leg(400), items: [SANDWICH] }));
/** Card sales only (A and E); 2.00 refunded in cash and 3.80 put back on a gift card: two accounts short. */
const twoShortDay = () => grouped([A, E], [
  ...refundOf(E, { id: 'r7', amount: 2.0, taxAmount: 0.34, tenderMethod: 'cash', cardStatus: null, items: [AMERICANO] }),
  ...refundOf(GIFT_SPENT, { id: 'rgb', amount: 3.8, taxAmount: 0.63, tenderMethod: 'gift_card', cardStatus: null, isFullRefund: true }),
]);

const LINES_DAYS = { plainDay, twoRatesDay, tipsDay, serviceDay, loyaltyDay, giftDay, zeroNetDay, zeroVatDay };
const FALL_BACK_DAYS = { cashShortDay: 'account_short', largerDay: 'total_not_positive', equalDay: 'total_not_positive', noSalesDay: 'no_sales', vatNegativeDay: 'vat_negative', giftPutBackDay: 'account_short', twoShortDay: 'account_short' };
const DAYS = { plainDay, twoRatesDay, tipsDay, serviceDay, loyaltyDay, giftDay, zeroNetDay, zeroVatDay, cashShortDay, largerDay, equalDay, noSalesDay, vatNegativeDay, giftPutBackDay, twoShortDay };

/** Generated days. `rich`: full refunds too, with their tips, service charge and loyalty credit. */
function generatedDay(seed, rich) {
  const r = rng(seed);
  const rows = [];
  const count = rich && seed % 3 === 0 ? 6 : rich ? 80 : 120;
  for (let i = 0; i < count; i++) rows.push(generatedCheck(r, `s${seed}-${i}`, (i % 20) / 1.1));
  const part = (check) => refund({ id: 'x', amount: Math.min(check.total, check.items[0].price), timestamp: atMs(21), legs: undefined,
    tenderMethod: check.tenders.some((t) => t.method === 'card') ? 'card' : 'cash', items: [{ ...check.items[0], refundQty: 1 }] });
  const refunds = rows.filter((_, i) => i % (rich ? 3 : 4) === 1).map((check) => {
    if (!rich || r() >= 0.5) return { ...check, refunds: [part(check)] };
    const cardMinor = Math.round(check.tenders.filter((t) => t.method === 'card').reduce((s, t) => s + t.amount + (t.tip || 0), 0) * 100);
    return { ...check, refunds: [refund({ id: 'f', amount: check.total, tipAmount: check.tip, serviceAmount: check.service, tenderMethod: cardMinor ? 'card' : 'cash', isFullRefund: true, timestamp: atMs(21),
      legs: cardMinor ? leg(Math.min(cardMinor, Math.round(check.total * 100))) : [] })] };
  });
  const m = mapping({ clearing: { card: 'CARDCLR', cash: 'CASHTILL' } });
  return { g: grouped(rows, refunds, m), m };
}

// ── 1 to 6: the minus lines ──────────────────────────────────────────────────

test('1. a plain day: the refund is the last line of the day\'s invoice, a minus line with the till\'s VAT', () => {
  const g = plainDay();
  const p = plan(g);
  assert.deepEqual([p.refundWay, p.refundWayReason], ['lines', null]);
  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.notReady, []);
  assert.deepEqual(p.invoice.lines.map(row), [
    ['Food 20%', '202', 'OUTPUT2', 596, 99],
    ['Hot drinks 20%', '201', 'OUTPUT2', 1935, 323],
    ['Customer discounts 20%', '401', 'OUTPUT2', -30, -5],
    ['Loyalty rewards 20%', '403', 'OUTPUT2', -100, -17],
    ['Staff discounts 20%', '402', 'OUTPUT2', -150, -25],
    ['Food 0%', '202', 'ZERORATEDOUTPUT', 400, 0],
    ['Tips and gratuities', '825', 'NONE', 50, 0],
    ['Service charge', '826', 'NONE', 100, 0],
    ['Refund: Hot drinks 20%', '201', 'OUTPUT2', -380, -63],
  ]);
  assert.deepEqual(p.invoice.lines.map((l) => !!l.refund), [false, false, false, false, false, false, false, false, true]);
  // Exactly what Xero receives for the refund: a minus amount and a minus TaxAmount.
  assert.deepEqual(p.invoice.payload.LineItems.at(-1), {
    Description: 'Refund: Hot drinks 20%', Quantity: 1, UnitAmount: -3.8, AccountCode: '201', TaxType: 'OUTPUT2', TaxAmount: -0.63,
    Tracking: [{ Name: 'Location', Option: 'Leeds' }],
  });
  assert.equal(p.invoice.payload.LineItems.length, 9);
  assert.equal(p.invoice.payload.Type, 'ACCREC');
  assert.equal(p.invoice.number, 'SOS-LEEDS-20260929');
  // The total is sales less refunds, and each clearing account is paid its takings less its refunds.
  assert.equal(p.invoice.total, 2421);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount)), 2421);
  assert.deepEqual(pays(p), [['PAY:CARDCLR', 1930, 'SOS-LEEDS-20260929 Card'], ['PAY:CASHTILL', 491, 'SOS-LEEDS-20260929 Cash']]);
  assert.deepEqual(p.payments[0].payload, { Invoice: { InvoiceNumber: 'SOS-LEEDS-20260929' }, Account: { Code: 'CARDCLR' }, Date: DATE, Amount: 19.3, Reference: 'SOS-LEEDS-20260929 Card' });
  assert.equal(sumBy(p.payments, (x) => x.amount), p.invoice.total);
  // No credit note, no refund payment: two kinds of step only.
  assert.equal(p.creditNote, null);
  assert.deepEqual(p.refundPayments, []);
  assert.deepEqual(steps(p), ['INVOICE', 'PAY:CARDCLR', 'PAY:CASHTILL']);
  assert.equal(p.creditNoteNumber, 'SOS-LEEDS-20260929-R', 'still named, for a day that needs one');
  // The totals keep their meaning, and both sides still tie to the till.
  assert.deepEqual(p.totals, { sales: 2801, refunds: 380, vat: 375, refundVat: 63 });
  assert.deepEqual(p.vatTie.map((t) => [t.side, t.key, t.tillVat, t.invoiceVat]), [['sales', 'rate:r20', 375, 375], ['sales', 'rate:r0', 0, 0], ['refunds', 'rate:r20', 63, 63]]);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.TaxAmount)), 375 - 63, 'the VAT on the invoice is the VAT charged less the VAT refunded');
  assert.deepEqual(saidWhy(p), []);
});

test('2. refunds across two VAT rates: one minus line per sales group and rate', () => {
  const p = plan(twoRatesDay());
  assert.deepEqual([p.refundWay, p.blocked], ['lines', []]);
  assert.deepEqual(refundLines(p), [['Refund: Hot drinks 20%', '201', 'OUTPUT2', -380, -63], ['Refund: Food 0%', '202', 'ZERORATEDOUTPUT', -400, 0]]);
  assert.equal(p.invoice.total, 2021);
  assert.deepEqual(pays(p).map(([k, a]) => [k, a]), [['PAY:CARDCLR', 1530], ['PAY:CASHTILL', 491]]);
});

test('3. a refunded tip is a minus line on the tips account with no VAT', () => {
  const p = plan(tipsDay());
  assert.deepEqual([p.refundWay, p.blocked], ['lines', []]);
  assert.deepEqual(refundLines(p), [
    ['Refund: Hot drinks 20%', '201', 'OUTPUT2', -380, -63], ['Refund: Food 0%', '202', 'ZERORATEDOUTPUT', -400, 0], ['Refund: Tips', '825', 'NONE', -50, 0],
  ]);
  const tip = p.invoice.payload.LineItems.at(-1);
  assert.deepEqual([tip.Description, tip.UnitAmount, tip.AccountCode, tip.TaxType, tip.TaxAmount], ['Refund: Tips', -0.5, '825', 'NONE', 0]);
  assert.equal(p.invoice.total, 1971);
  assert.deepEqual(pays(p).map(([k, a]) => [k, a]), [['PAY:CARDCLR', 1480], ['PAY:CASHTILL', 491]]);
});

test('4. a refunded service charge is a minus line on the service charge account', () => {
  const p = plan(serviceDay());
  assert.deepEqual([p.refundWay, p.blocked], ['lines', []]);
  assert.deepEqual(refundLines(p), [
    ['Refund: Food 20%', '202', 'OUTPUT2', -150, -25], ['Refund: Hot drinks 20%', '201', 'OUTPUT2', -375, -63], ['Refund: Service charge', '826', 'NONE', -100, 0],
  ]);
  assert.equal(p.invoice.total, 2176);
  // The refund went back 4.00 to the card and 2.25 in cash, so both accounts net.
  assert.deepEqual(pays(p).map(([k, a]) => [k, a]), [['PAY:CARDCLR', 1910], ['PAY:CASHTILL', 266]]);
});

test('5. a loyalty credit put back is a PLUS line (it was a minus line on the credit note)', () => {
  const p = plan(loyaltyDay());
  assert.deepEqual([p.refundWay, p.blocked], ['lines', []]);
  assert.deepEqual(refundLines(p), [['Refund: Hot drinks 20%', '201', 'OUTPUT2', -380, -63], ['Refund: Loyalty rewards 20%', '403', 'OUTPUT2', 100, 17]]);
  // 3.80 of goods back, 1.00 of it was credit, so 2.80 of money: 28.01 less 2.80.
  assert.equal(p.invoice.total, 2521);
  assert.deepEqual(pays(p).map(([k, a]) => [k, a]), [['PAY:CARDCLR', 2030], ['PAY:CASHTILL', 491]]);
  assert.equal(p.totals.refunds, 280);
});

test('6. every refund line is the credit note\'s line with the sign turned and "Refund: " in front', () => {
  // The rule, written out here on its own: same kind, group, rate, account and tax type.
  const NAME = { gift: 'Gift cards', tip: 'Tips', service: 'Service charge' };
  const turned = (l) => ({ ...l, refund: true, description: `Refund: ${NAME[l.kind] || l.description}`, amount: 0 - l.amount, tax: 0 - l.tax, xeroCalc: 0 - l.xeroCalc });
  const days = [...Object.values(LINES_DAYS).map((f) => f()), ...[1, 7].map((s) => generatedDay(s, false).g), ...[5, 6].map((s) => generatedDay(s, true).g)];
  for (const g of days) {
    const p = plan(g);
    const old = creditNoteWay(g);
    assert.equal(p.refundWay, 'lines');
    assert.deepEqual(p.invoice.lines.filter((l) => l.refund), old.creditNote.lines.map(turned));
    // Refund lines come last, after every sales line exactly as the credit note way has them.
    assert.deepEqual(p.invoice.lines.slice(0, old.invoice.lines.length), old.invoice.lines);
    assert.equal(p.invoice.lines.length, old.invoice.lines.length + old.creditNote.lines.length);
    assert.ok(p.invoice.lines.filter((l) => l.refund).every((l) => l.description.startsWith('Refund: ')));
  }
  // Gift cards keep the gift card liability account and No VAT.
  const gift = plan(giftDay()).invoice.lines.find((l) => l.refund && l.kind === 'gift');
  assert.deepEqual([gift.description, gift.account, gift.taxType, gift.tax], ['Refund: Gift cards', '830', 'NONE', 0]);
  assert.ok(gift.amount < 0);
});

// ── 7 to 11: when the day falls back to the credit note ──────────────────────

test('7. a cash refund on a day with no cash takings: the whole day goes the credit note way, and says why', () => {
  const g = cashShortDay();
  const p = plan(g);
  assert.deepEqual([p.refundWay, p.refundWayReason], ['credit_note', 'account_short']);
  assert.deepEqual(saidWhy(p), [{ code: 'refunds_as_credit_note', reason: 'account_short',
    message: 'More was refunded by Cash on this day than was taken by Cash, and Xero does not take a minus payment. The refunds go to Xero as a credit note.' }]);
  assert.deepEqual(p.blocked, []);
  assert.equal(p.invoice.total, 1630);
  assert.equal(p.creditNote.total, 200);
  assert.deepEqual(p.refundPayments.map((x) => [x.key, x.amount]), [['REFUND:CASHTILL', 200]]);
  assert.deepEqual(steps(p), ['INVOICE', 'PAY:CARDCLR', 'CREDIT', 'REFUND:CASHTILL']);
  assert.ok(p.invoice.lines.every((l) => !l.refund), 'no refund line on the invoice of a credit note day');
  // The same documents and payments as a day started the credit note way.
  const old = creditNoteWay(g);
  assert.deepEqual(p.invoice, old.invoice);
  assert.deepEqual(p.creditNote, old.creditNote);
  assert.deepEqual(p.payments, old.payments);
  assert.deepEqual(p.refundPayments, old.refundPayments);
  // A gift card put back when no gift card was spent that day: the gift card account is short.
  const gift = plan(giftPutBackDay());
  assert.deepEqual([gift.refundWay, gift.refundWayReason], ['credit_note', 'account_short']);
  assert.match(saidWhy(gift)[0].message, /^More was refunded by Gift cards on this day than was taken by Gift cards, /);
  assert.deepEqual(gift.refundPayments.map((x) => [x.key, x.amount]), [['REFUND:830', 380]]);
  // A later attempt of the same day (its row now says 'credit_note') still gives the real reason:
  // the row keeps the warnings of the last attempt only, so "it was started that way" would lose it.
  for (const [name, f] of Object.entries(DAYS).filter(([k]) => k in FALL_BACK_DAYS)) {
    const first = plan(f()), again = creditNoteWay(f());
    assert.equal(again.refundWayReason, FALL_BACK_DAYS[name], name);
    assert.deepEqual(saidWhy(again), saidWhy(first), name);
  }
  assert.equal(saidWhy(creditNoteWay(g))[0].message, 'More was refunded by Cash on this day than was taken by Cash, and Xero does not take a minus payment. The refunds go to Xero as a credit note.');
  // Only a day whose refunds WOULD fit today says it was started that way (a day sent before 13 Oct 2026).
  assert.deepEqual(saidWhy(creditNoteWay(plainDay())).map((w) => [w.reason, w.message]), [['started_credit_note', 'This day was started in Xero with its refunds as a credit note, so it stays that way.']]);
  // Two accounts short: the names are joined with "and".
  assert.equal(saidWhy(plan(twoShortDay()))[0].message, 'More was refunded by Cash and Gift cards on this day than was taken by Cash and Gift cards, and Xero does not take a minus payment. The refunds go to Xero as a credit note.');
});

test('8. refunds larger than the sales, or equal to them: Xero takes no invoice of zero or less', () => {
  for (const [g, salesTotal] of [[largerDay(), 280], [equalDay(), 800]]) {
    const p = plan(g);
    assert.deepEqual([p.refundWay, p.refundWayReason], ['credit_note', 'total_not_positive']);
    assert.equal(saidWhy(p)[0].message, 'The refunds on this day come to as much as its sales or more, and Xero does not take an invoice of zero or less. The refunds go to Xero as a credit note.');
    assert.deepEqual(p.blocked, []);
    assert.equal(p.invoice.total, salesTotal);
    assert.equal(p.creditNote.total, 800);
    assert.deepEqual(steps(p), ['INVOICE', 'PAY:CARDCLR', 'CREDIT', 'REFUND:CARDCLR']);
  }
});

test('9. refunds and no sales: a credit note and no invoice', () => {
  const p = plan(noSalesDay());
  assert.deepEqual([p.refundWay, p.refundWayReason], ['credit_note', 'no_sales']);
  assert.equal(saidWhy(p)[0].message, 'This day has refunds and no sales, so there is no invoice to put them on. The refunds go to Xero as a credit note.');
  assert.equal(p.invoice, null);
  assert.deepEqual(p.payments, []);
  assert.equal(p.creditNote.total, 380);
  assert.deepEqual(steps(p), ['CREDIT', 'REFUND:CARDCLR']);
});

test('10. an account that nets to zero gets no payment (Xero takes no payment of zero)', () => {
  const p = plan(zeroNetDay());
  assert.deepEqual([p.refundWay, p.refundWayReason, p.blocked], ['lines', null, []]);
  assert.deepEqual(refundLines(p), [['Refund: Food 20%', '202', 'OUTPUT2', -266, -44]]);
  assert.equal(p.invoice.total, 1630);
  assert.deepEqual(pays(p), [['PAY:CARDCLR', 1630, 'SOS-LEEDS-20260929 Card']]);
  assert.deepEqual(steps(p), ['INVOICE', 'PAY:CARDCLR'], 'no PAY:CASHTILL step');
  assert.equal(sumBy(p.payments, (x) => x.amount), p.invoice.total);
});

test('11. more VAT refunded than charged that day: the credit note way', () => {
  const g = vatNegativeDay();
  const p = plan(g);
  assert.deepEqual([p.refundWay, p.refundWayReason], ['credit_note', 'vat_negative']);
  assert.equal(saidWhy(p)[0].message, 'The VAT on the refunds of this day is more than the VAT on its sales. The refunds go to Xero as a credit note.');
  // The money alone would have fitted (8.00 taken by card, 3.80 refunded to it).
  assert.equal(p.invoice.total, 800);
  assert.equal(p.creditNote.total, 380);
  assert.deepEqual([p.totals.vat, p.totals.refundVat], [0, 63]);
  assert.deepEqual(p.invoice, creditNoteWay(g).invoice);
  assert.deepEqual(p.creditNote, creditNoteWay(g).creditNote);
  // The same VAT on both sides is NOT more refunded than charged: a day with no VAT at all (a 0%
  // only day, a venue with no VAT, a US state with no sales tax) has its refunds on the invoice.
  const zero = plan(zeroVatDay());
  assert.deepEqual([zero.refundWay, zero.refundWayReason, zero.blocked], ['lines', null, []]);
  assert.deepEqual([zero.totals.vat, zero.totals.refundVat], [0, 0]);
  assert.deepEqual(zero.invoice.lines.map(row), [['Food 0%', '202', 'ZERORATEDOUTPUT', 800, 0], ['Refund: Food 0%', '202', 'ZERORATEDOUTPUT', -400, 0]]);
  assert.deepEqual(pays(zero).map(([k, a]) => [k, a]), [['PAY:CARDCLR', 400]]);
  assert.deepEqual(steps(zero), ['INVOICE', 'PAY:CARDCLR']);
  assert.deepEqual(saidWhy(zero), []);
});

// ── 12, 13: to the penny ─────────────────────────────────────────────────────

test('12. to the penny: the invoice with refund lines is the credit note way\'s invoice less its credit note', () => {
  const bucket = (items, sign, acc = {}) => {
    for (const li of items) {
      const e = acc[`${li.AccountCode}|${li.TaxType}`] || (acc[`${li.AccountCode}|${li.TaxType}`] = { net: 0, vat: 0 });
      e.net += sign * cents(li.UnitAmount); e.vat += sign * cents(li.TaxAmount);
    }
    return acc;
  };
  const byAccount = (list) => Object.fromEntries(list.map((x) => [x.account, x.amount]));
  const days = [
    ...Object.entries(DAYS).map(([name, f]) => ({ name, g: f(), m: mapping() })),
    ...[1, 7, 42, 2026].map((seed) => ({ name: `seed ${seed}`, ...generatedDay(seed, false) })),
    ...[5, 6, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18].map((seed) => ({ name: `rich seed ${seed}`, ...generatedDay(seed, true) })),
  ];
  let asLines = 0, fellBack = 0;
  const kinds = new Set();
  for (const { name, g, m } of days) {
    const n = plan(g, {}, m);
    const old = creditNoteWay(g, m);
    assert.deepEqual(n.blocked, [], name);
    assert.deepEqual(old.blocked, [], name);
    // Whichever way: the day's totals and the VAT per rate against the till do not move.
    assert.deepEqual(n.totals, old.totals, name);
    assert.deepEqual(n.vatTie, old.vatTie, name);
    if (n.refundWay !== 'lines') {
      fellBack += 1;
      assert.equal(n.refundWay, 'credit_note', name);
      assert.deepEqual(n.invoice?.payload, old.invoice?.payload, name);
      assert.deepEqual(n.creditNote.payload, old.creditNote.payload, name);
      assert.deepEqual(n.payments, old.payments, name);
      assert.deepEqual(n.refundPayments, old.refundPayments, name);
      assert.deepEqual(planSteps(n), planSteps(old), name);
      continue;
    }
    asLines += 1;
    for (const l of n.invoice.lines.filter((x) => x.refund)) kinds.add(l.kind);
    // Per account and tax type: the net amount and the net VAT Xero books.
    assert.deepEqual(bucket(n.invoice.payload.LineItems, 1), bucket(old.creditNote.payload.LineItems, -1, bucket(old.invoice.payload.LineItems, 1)), name);
    // Per clearing account: what it took less what it refunded (nothing where that is zero).
    const took = byAccount(old.payments), gave = byAccount(old.refundPayments);
    assert.deepEqual(byAccount(n.payments), Object.fromEntries(Object.keys(took).map((k) => [k, took[k] - (gave[k] || 0)]).filter(([, v]) => v !== 0)), name);
    assert.ok(Object.keys(gave).every((k) => k in took), `${name}: every refund came out of an account that took money`);
    for (const x of n.payments) assert.equal(x.reference, old.payments.find((o) => o.key === x.key).reference, `${name}: the reference the credit note way gives`);
    // In total.
    assert.equal(n.invoice.total, old.invoice.total - old.creditNote.total, name);
    assert.equal(n.invoice.total, g.summary.sales.totals.gross - g.summary.refunds.totals.gross, name);
    assert.equal(cents(sumBy(n.invoice.payload.LineItems, (l) => l.UnitAmount)), n.invoice.total, name);
    assert.equal(cents(sumBy(n.invoice.payload.LineItems, (l) => l.TaxAmount)), n.totals.vat - n.totals.refundVat, name);
    assert.equal(sumBy(n.payments, (x) => x.amount), n.invoice.total, name);
    assert.ok(n.payments.every((x) => x.amount > 0), name);
    assert.ok(n.invoice.total > 0, name);
    // Never a minus zero in what is sent or shown.
    assert.ok(n.invoice.lines.every((l) => !Object.is(l.amount, -0) && !Object.is(l.tax, -0) && !Object.is(l.xeroCalc, -0)), name);
    assert.ok(n.invoice.payload.LineItems.every((l) => !Object.is(l.UnitAmount, -0) && !Object.is(l.TaxAmount, -0)), name);
    assert.equal(n.creditNote, null, name);
    assert.deepEqual(n.refundPayments, [], name);
  }
  assert.ok(asLines >= 20, `${asLines} days with refund lines`);
  assert.equal(fellBack, Object.keys(FALL_BACK_DAYS).length);
  for (const k of ['sales', 'discount', 'gift', 'tip', 'service']) assert.ok(kinds.has(k), `a refund line of kind ${k} was checked`);
});

test('13. US (tax added on): the refund line is the amount before tax, with the tax as a minus TaxAmount', () => {
  const US_TAX = [{ id: 'st', name: 'Sales tax', code: 'ST', rate: 0.1, type: 'exclusive', is_default: true, active: true }];
  const US_XERO = revenueTaxRates([
    { TaxType: 'NONE', Name: 'Tax Exempt', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 0 },
    { TaxType: 'TAX001', Name: 'Sales Tax', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 10 },
  ]);
  const NY = { timezone: 'America/New_York', dayStart: '04:00' };
  const day = businessDayWindow(DATE, NY.timezone, NY.dayStart);
  const check = (id) => ({ id, closed_at: new Date(day.fromMs + 3600000).toISOString(), total: 11, tip: 0, service: 0, tax_amount: 1,
    tax_breakdown: { totalTax: 1, total: 11, hasExclusiveTax: true, breakdown: [{ rate: { id: 'st', rate: 0.1, type: 'exclusive' }, gross: 10, tax: 1 }] },
    items: [{ uid: `${id}1`, cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 10, taxRateId: 'st' }], tenders: [{ method: 'card', amount: 11, tip: 0, processor: 'adyen' }] });
  const m = mapping({ taxDefault: 'TAX001' });
  const refunds = [{ ...check('U1'), refunds: [refund({ id: 'r', amount: 11, taxAmount: 1, isFullRefund: true, timestamp: day.fromMs + 7200000, legs: leg(1100) })] }];
  const g = buildGroupedDay({ day, saleRows: [check('U1'), check('U2')], refundRows: refunds, venue: NY, taxRates: US_TAX, resolver: makeGroupResolver(m, CATEGORIES) });
  const p = planXeroInvoiceDay(g, { mapping: m, detail: { salesTaxRates: US_XERO, site: DETAIL.site }, site: SITE, date: DATE, currency: 'USD' });
  assert.deepEqual([p.refundWay, p.blocked], ['lines', []]);
  assert.equal(p.invoice.payload.LineAmountTypes, 'Exclusive');
  assert.deepEqual(p.invoice.payload.LineItems.map((l) => [l.Description, l.TaxType, l.UnitAmount, l.TaxAmount]), [
    ['Hot drinks', 'TAX001', 20, 2],
    ['Refund: Hot drinks', 'TAX001', -10, -1],
  ]);
  assert.equal(cents(sumBy(p.invoice.payload.LineItems, (l) => l.UnitAmount + l.TaxAmount)), 1100, 'the invoice is the money');
  assert.equal(p.invoice.total, 1100);
  assert.deepEqual(p.payments.map((x) => [x.key, x.amount]), [['PAY:CARDCLR', 1100]]);
  assert.ok(!p.warnings.some((w) => w.code === 'vat_override_large'));
});

// ── 14, 15: the way a day was started, read from its log row ─────────────────

test('14. refundWayStarted: what an earlier attempt sent decides, and a day with nothing sent is free', () => {
  const sending = { status: 'sending' }, posted = { status: 'posted', id: 'x' };
  // Nothing of the sales invoice was sent: free to decide. A left over marker is ignored.
  assert.equal(refundWayStarted(null), null);
  assert.equal(refundWayStarted(undefined), null);
  assert.equal(refundWayStarted({}), null);
  assert.equal(refundWayStarted({ postings: {} }), null);
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: {} }), null);
  assert.equal(refundWayStarted({ refundWay: 'credit_note', postings: {} }), null);
  assert.equal(refundWayStarted({ refundWay: 'lines', refundLinesRefused: { at: 'T' }, postings: {} }), null);
  assert.equal(refundWayStarted({ postings: { INVOICE: null } }), null, 'a record that is not one');
  // The older bank transaction keys are not the sales invoice (any status).
  assert.equal(refundWayStarted({ postings: { 'RECEIVE:a': posted, 'SPEND:a': { status: 'deleted' } } }), null);
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { 'RECEIVE:a': sending } }), null);
  // A credit note or a refund payment, sending or posted: the credit note way, whatever the marker says.
  assert.equal(refundWayStarted({ postings: { CREDIT: sending } }), 'credit_note');
  assert.equal(refundWayStarted({ postings: { CREDIT: posted } }), 'credit_note');
  assert.equal(refundWayStarted({ postings: { 'REFUND:CARDCLR': sending } }), 'credit_note');
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { INVOICE: posted, 'REFUND:CARDCLR': posted } }), 'credit_note');
  // An invoice or a payment with no 'lines' marker: sent for the gross figure (every day before 13 Oct 2026).
  assert.equal(refundWayStarted({ postings: { INVOICE: sending } }), 'credit_note');
  assert.equal(refundWayStarted({ postings: { INVOICE: posted } }), 'credit_note');
  assert.equal(refundWayStarted({ refundWay: null, postings: { INVOICE: posted, 'PAY:CARDCLR': posted } }), 'credit_note');
  assert.equal(refundWayStarted({ refundWay: 'credit_note', postings: { 'PAY:CARDCLR': posted } }), 'credit_note');
  // The 'lines' marker with an invoice or payment record: the new way.
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { INVOICE: sending } }), 'lines');
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { INVOICE: posted } }), 'lines');
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { INVOICE: posted, 'PAY:CARDCLR': sending } }), 'lines');
  // Refused by Xero: only the marker, the refusal, and nothing but the invoice still 'sending'.
  const refusal = { at: '2026-10-14T03:10:00.000Z', message: 'Xero API /Invoices failed: 400' };
  assert.equal(refundWayStarted({ refundWay: 'lines', refundLinesRefused: refusal, postings: { INVOICE: sending } }), 'refused');
  assert.equal(refundWayStarted({ refundWay: 'lines', refundLinesRefused: refusal, postings: { INVOICE: posted } }), 'lines', 'the invoice is in Xero: never switched');
  assert.equal(refundWayStarted({ refundWay: 'lines', refundLinesRefused: refusal, postings: { INVOICE: sending, 'PAY:CARDCLR': sending } }), 'lines');
  // After the switch (the 'credit_note' marker) it stays the credit note way and keeps saying
  // Xero's refusal is why, however far the day has got: never "it was started that way".
  assert.equal(refundWayStarted({ refundWay: 'credit_note', refundLinesRefused: refusal, postings: { INVOICE: sending } }), 'refused');
  assert.equal(refundWayStarted({ refundWay: 'credit_note', refundLinesRefused: refusal, postings: { INVOICE: posted, 'PAY:CARDCLR': sending } }), 'refused');
  assert.equal(refundWayStarted({ refundWay: 'credit_note', refundLinesRefused: refusal, postings: { INVOICE: posted, 'PAY:CARDCLR': posted, CREDIT: sending } }), 'refused');
  assert.equal(refundWayStarted({ refundWay: 'credit_note', refundLinesRefused: null, postings: { INVOICE: sending } }), 'credit_note', 'no refusal on the row');
  for (const d of [{ refundWay: 'credit_note', refundLinesRefused: refusal, postings: { INVOICE: posted, CREDIT: sending } }, { refundWay: 'credit_note', refundLinesRefused: refusal, postings: { INVOICE: sending } }]) {
    assert.equal(plan(plainDay(), { started: refundWayStarted(d) }).refundWay, 'credit_note');
    assert.equal(refundWayToRecord(refundWayStarted(d), plan(plainDay())), 'credit_note');
  }
  // Xero refused the invoice for a cause that was not its refund lines: nothing is in Xero, so
  // the day is free, whatever markers are left. Only while that refused invoice is all there is.
  const notLines = { status: 'sending', refusedNotLines: { at: 'T', words: 'A lock date.' } };
  assert.equal(refundWayStarted({ refundWay: null, postings: { INVOICE: notLines } }), null);
  assert.equal(refundWayStarted({ refundWay: 'credit_note', postings: { INVOICE: notLines } }), null);
  assert.equal(refundWayStarted({ refundWay: 'lines', refundLinesRefused: refusal, postings: { INVOICE: notLines } }), null);
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { INVOICE: { ...notLines, status: 'posted', id: 'x' } } }), 'lines', 'in Xero: the mark means nothing');
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { INVOICE: notLines, 'PAY:CARDCLR': sending } }), 'lines');
  assert.equal(refundWayStarted({ postings: { INVOICE: notLines, CREDIT: sending } }), 'credit_note');
  // The older model keys beside it change nothing (dayModel keeps such days on the older model anyway).
  assert.equal(refundWayStarted({ refundWay: 'lines', postings: { INVOICE: sending, 'RECEIVE:a': posted } }), 'lines');
});

test('15. refundWayToRecord: the marker saved before anything is sent', () => {
  const lines = plan(plainDay()), fallBack = plan(cashShortDay()), none = plan(grouped(saleRows()));
  assert.deepEqual([lines.refundWay, fallBack.refundWay, none.refundWay], ['lines', 'credit_note', null]);
  assert.equal(refundWayToRecord(null, lines), 'lines');
  assert.equal(refundWayToRecord(null, fallBack), 'credit_note');
  assert.equal(refundWayToRecord(null, none), null, 'no refunds: no marker, so a late refund goes as a credit note against the gross invoice');
  assert.equal(refundWayToRecord(null, null), null);
  // What an earlier attempt started always stands.
  assert.equal(refundWayToRecord('lines', none), 'lines');
  assert.equal(refundWayToRecord('lines', fallBack), 'lines');
  assert.equal(refundWayToRecord('credit_note', lines), 'credit_note');
  assert.equal(refundWayToRecord('credit_note', none), 'credit_note');
  // Refused by Xero: from now on the credit note way.
  assert.equal(refundWayToRecord('refused', lines), 'credit_note');
  assert.equal(refundWayToRecord('refused', none), 'credit_note');
});

// ── 16 to 20: half posted days, with the real SyncRun and postInvoiceDay ─────

// xero_sync_log in memory: the calls SyncRun makes (as xeroReplaceDay.test.js has it).
function fakeTable(seed) {
  const rows = [];
  let clock = Date.parse('2026-10-14T03:00:00Z');
  const stamp = () => new Date(clock++).toISOString().replace('Z', '+00:00');
  const match = (r, f) => Object.entries(f).every(([k, v]) => (k === 'updated_at' ? Date.parse(r[k]) === Date.parse(v) : r[k] === v));
  const view = (r) => ({ id: r.id, status: r.status, xero_id: r.xero_id, detail: structuredClone(r.detail), updated_at: r.updated_at });
  const builder = (op, payload) => {
    const f = {};
    const q = {
      eq(k, v) { f[k] = v; return q; },
      select() { return q; },
      maybeSingle() { return q; },
      then(res, rej) {
        const hit = rows.filter((r) => match(r, f));
        let out;
        if (op === 'select') out = { data: hit.length ? view(hit[0]) : null, error: null };
        else if (op === 'insert') { const made = { id: `row-${rows.length + 1}`, xero_id: null, ...structuredClone(payload), updated_at: stamp() }; rows.push(made); out = { data: [view(made)], error: null }; }
        else { for (const r of hit) Object.assign(r, structuredClone(payload), { updated_at: stamp() }); out = { data: hit.map(view), error: null }; }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  const sb = { rows, from: () => ({ select: () => builder('select'), insert: (p) => builder('insert', p), update: (p) => builder('update', p) }) };
  if (seed) rows.push({ id: 'row-1', location_id: 'leeds', kind: 'daily_sales', ref_date: DATE, ref_id: null, xero_id: null, ...structuredClone(seed), updated_at: stamp() });
  return sb;
}
const KEY = { table: 'xero_sync_log', locationId: 'leeds', kind: 'daily_sales', refDate: DATE };
const CONTACT = DETAIL.site.contactId;
const CTX = { token: 't', tenantId: 'T', locationId: 'leeds', date: DATE, contactId: CONTACT, shortCode: null };

// A fake Xero behind fetch, holding invoices, credit notes and payments, with the rules Xero
// keeps: a number is used once, an invoice is never below zero, a payment is above zero and no
// more than what is still due. `refuse(method, path, body)` may answer with a Response instead;
// `lose(method, path)` true means Xero did it and the answer never arrived. fetch is put back after.
async function withXero(fn, { refuse = () => null, lose = () => false, seed = null } = {}) {
  const real = globalThis.fetch;
  const x = { invoices: [], creditNotes: [], payments: [], calls: [], puts: () => x.calls.filter((c) => c.startsWith('PUT')) };
  if (seed) seed(x);
  let n = 0;
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const invalid = (message) => answer(400, { ErrorNumber: 10, Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: message }] }] });
  const total = (p) => Math.round(sumBy(p.LineItems, (l) => l.UnitAmount) * 100) / 100;
  const due = (doc, id) => Math.round((doc.Total - sumBy(x.payments.filter((p) => (p.Invoice?.InvoiceID || p.CreditNote?.CreditNoteID) === id), (p) => p.Amount)) * 100) / 100;
  const handle = (method, where, body) => {
    if (method === 'PUT' && where === '/Invoices') {
      const p = body.Invoices[0];
      if (x.invoices.some((i) => i.InvoiceNumber === p.InvoiceNumber)) return invalid('Invoice # must be unique.');
      if (total(p) < 0) return invalid('Invoice total must not be negative.');
      const inv = { InvoiceID: `inv-${++n}`, InvoiceNumber: p.InvoiceNumber, Type: 'ACCREC', Status: 'AUTHORISED', Total: total(p), Contact: { ContactID: p.Contact.ContactID }, sent: p };
      x.invoices.push(inv);
      return answer(200, { Invoices: [inv] });
    }
    if (method === 'GET' && where.startsWith('/Invoices?InvoiceNumbers=')) {
      const number = decodeURIComponent(where.split('=')[1]);
      return answer(200, { Invoices: x.invoices.filter((i) => i.InvoiceNumber === number) });
    }
    if (method === 'PUT' && where === '/CreditNotes') {
      const p = body.CreditNotes[0];
      if (x.creditNotes.some((c) => c.CreditNoteNumber === p.CreditNoteNumber)) return invalid('Credit Note # must be unique.');
      const cn = { CreditNoteID: `cn-${++n}`, CreditNoteNumber: p.CreditNoteNumber, Type: 'ACCRECCREDIT', Status: 'AUTHORISED', Total: total(p), Contact: { ContactID: p.Contact.ContactID }, sent: p };
      x.creditNotes.push(cn);
      return answer(200, { CreditNotes: [cn] });
    }
    if (method === 'GET' && where.startsWith('/CreditNotes?where=')) {
      const number = /CreditNoteNumber=="([^"]+)"/.exec(decodeURIComponent(where))[1];
      return answer(200, { CreditNotes: x.creditNotes.filter((c) => c.CreditNoteNumber === number) });
    }
    if (method === 'PUT' && where === '/Payments') {
      const p = body.Payments[0];
      const doc = p.Invoice ? x.invoices.find((i) => i.InvoiceID === p.Invoice.InvoiceID) : x.creditNotes.find((c) => c.CreditNoteID === p.CreditNote?.CreditNoteID);
      if (!doc) return invalid('The document for this payment could not be found.');
      if (!(p.Amount > 0)) return invalid('Payment amount must be greater than 0.');
      if (p.Amount > due(doc, doc.InvoiceID || doc.CreditNoteID) + 0.001) return invalid('Payment amount exceeds the amount outstanding.');
      const pay = { PaymentID: `pay-${++n}`, Status: 'AUTHORISED', Amount: p.Amount, Reference: p.Reference, Invoice: p.Invoice, CreditNote: p.CreditNote, Account: p.Account };
      x.payments.push(pay);
      return answer(200, { Payments: [pay] });
    }
    if (method === 'GET' && where.startsWith('/Payments?where=')) {
      const reference = /Reference=="([^"]+)"/.exec(decodeURIComponent(where))[1];
      return answer(200, { Payments: x.payments.filter((p) => p.Reference === reference) });
    }
    return answer(500, { Message: `unexpected ${method} ${where}` });
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const where = u.pathname.replace('/api.xro/2.0', '') + u.search;
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    x.calls.push(`${method} ${where.split('?')[0]}`);
    const refused = refuse(method, where, body);
    if (refused) return refused;
    const res = handle(method, where, body);
    if (lose(method, where)) throw new Error('network connection lost');
    return res;
  };
  try { return await fn(x); } finally { globalThis.fetch = real; }
}

// One attempt, as xero-sales makes it (the same calls in the same order; test 24 pins them there):
// claim the row, read the way from the row this run HOLDS, plan, record the way, then post. What
// Xero's "no" to the invoice says about the refund lines (invoiceRefusal) is recorded on the row.
async function attempt(sb, g, runId) {
  const { run } = await claimSyncRun(sb, KEY, { runId });
  const started = refundWayStarted(run.detail);
  const refusedBefore = run.postings.INVOICE?.refusedNotLines || null;
  let p = null;
  try {
    p = plan(g, { started });
    await run.save({ detail: { model: 'sales_invoice', warnings: p.warnings, refundWay: refundWayToRecord(started, p) } });
    const res = await postInvoiceDay(run, p, CTX);
    await run.finish('ok', { detail: { documents: res.documents, error: null } }, { ok: true, posted: res.posted, skipped: res.skipped });
    return { ok: true, res, plan: p, started };
  } catch (e) {
    const done = Object.values(run.postings).filter((x) => x?.status === 'posted').length;
    const xeroWords = xeroErrorWords(e.message);
    const refusal = invoiceRefusal(p, { started, postings: run.postings, before: refusedBefore, error: { status: e?.status, message: e.message, words: xeroWords } });
    const error = refusal ? refusalWords(refusal, xeroWords) : e.message;
    const refused = refusalPatch(refusal, run.postings, { at: '2026-10-14T03:10:00.000Z', message: e.message, words: xeroWords });
    await run.finish(done ? 'partial' : 'error', { detail: { error, ...refused } }, { ok: false, posted: done });
    return { ok: false, e, plan: p, started, refusal, refused: refusal === 'lines', error };
  }
}
// The row as the Postings history gets it (xero-config history_detail): the way and the postings.
const asHistory = (r) => ({ refundWay: r.detail.refundWay || null, postings: r.detail.postings });
// Xero's answer to a document it will not take.
const xero400 = (message) => new Response(JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ InvoiceNumber: 'SOS-LEEDS-20260929', ValidationErrors: [{ Message: message }] }] }), { status: 400 });
const posted = (r) => Object.entries(r.detail.postings).map(([k, p]) => [k, p.status, p.total]);

test('16. a half posted NEW way day finishes the new way: only the payment that failed is sent again', async () => {
  const g = plainDay();
  let failed = false;
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, g, 'A1');
    assert.equal(first.ok, false);
    assert.equal(first.started, null);
    assert.equal(first.refused, false, 'a 503 on a payment is not a refusal of the refund lines');
    let r = await readSyncRow(sb, KEY);
    assert.equal(r.status, 'partial');
    assert.equal(r.detail.refundWay, 'lines', 'the way is on the row');
    assert.equal(r.detail.refundLinesRefused, undefined);
    assert.deepEqual(posted(r), [['INVOICE', 'posted', 24.21], ['PAY:CARDCLR', 'posted', 19.3], ['PAY:CASHTILL', 'sending', 4.91]]);
    assert.equal(historyRefundNote(asHistory(r)), 'Refunds are on the invoice as minus lines.', 'the invoice is in Xero');
    assert.ok(r.detail.postings.INVOICE.payload.LineItems.some((l) => l.Description === 'Refund: Hot drinks 20%' && l.UnitAmount === -3.8), 'the row keeps exactly what was sent');
    x.calls.length = 0;
    const second = await attempt(sb, g, 'A2');
    assert.equal(second.started, 'lines');
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual(x.puts(), ['PUT /Payments'], 'one more send: the cash payment');
    assert.deepEqual([second.res.posted, second.res.skipped], [1, 2]);
    assert.deepEqual(x.invoices.map((i) => [i.InvoiceNumber, i.Total]), [['SOS-LEEDS-20260929', 24.21]]);
    assert.equal(x.creditNotes.length, 0);
    assert.deepEqual(x.payments.map((p) => [p.Reference, p.Amount]), [['SOS-LEEDS-20260929 Card', 19.3], ['SOS-LEEDS-20260929 Cash', 4.91]]);
    r = await readSyncRow(sb, KEY);
    assert.equal(r.status, 'ok');
    assert.equal(r.detail.refundWay, 'lines');
    assert.deepEqual(r.detail.documents.map((d) => [d.type, d.total]), [['invoice', 24.21], ['payment', 19.3], ['payment', 4.91]]);
  }, { refuse: (method, where, body) => (method === 'PUT' && where === '/Payments' && /Cash$/.test(body.Payments[0].Reference) && !failed ? (failed = true, new Response('Service Unavailable', { status: 503 })) : null) });
});

test('17. a lost answer on the new way: the invoice is found by its number, never sent twice', async () => {
  const g = plainDay();
  let lost = false;
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, g, 'C1');
    assert.equal(first.ok, false);
    assert.equal(first.refused, false);
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay], ['error', 'lines']);
    assert.deepEqual(posted(r), [['INVOICE', 'sending', 24.21]]);
    assert.equal(historyRefundNote(asHistory(r)), '', 'the answer was lost: nothing is confirmed in Xero yet');
    const second = await attempt(sb, g, 'C2');
    assert.equal(second.started, 'lines', 'an invoice still "sending" under the lines marker is the new way');
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual(x.invoices.map((i) => i.Total), [24.21], 'one invoice, at sales less refunds');
    assert.equal(x.puts().filter((c) => c === 'PUT /Invoices').length, 1);
    assert.equal(x.creditNotes.length, 0);
    assert.deepEqual(x.payments.map((p) => p.Amount), [19.3, 4.91]);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay], ['ok', 'lines']);
    assert.equal(historyRefundNote(asHistory(r)), 'Refunds are on the invoice as minus lines.');
  }, { lose: (method, where) => (method === 'PUT' && where === '/Invoices' && !lost ? (lost = true) : false) });
});

// A row as the code before 13 Oct 2026 leaves it: no refundWay, the invoice in Xero for the
// gross 28.01 and both payments posted, the credit note still to send.
const oldWayHalfPosted = () => ({ status: 'partial', detail: { model: 'sales_invoice', history: [], postings: {
  INVOICE: { status: 'posted', type: 'invoice', id: 'inv-old', number: 'SOS-LEEDS-20260929', reference: 'Coffee Boy Leeds takings Tue 29 Sep 2026', total: 28.01, xeroStatus: 'AUTHORISED' },
  'PAY:CARDCLR': { status: 'posted', type: 'payment', id: 'pay-old-1', reference: 'SOS-LEEDS-20260929 Card', total: 23.1 },
  'PAY:CASHTILL': { status: 'posted', type: 'payment', id: 'pay-old-2', reference: 'SOS-LEEDS-20260929 Cash', total: 4.91 },
} } });
const oldWayInXero = (x) => {
  x.invoices.push({ InvoiceID: 'inv-old', InvoiceNumber: 'SOS-LEEDS-20260929', Type: 'ACCREC', Status: 'AUTHORISED', Total: 28.01, Contact: { ContactID: CONTACT } });
  x.payments.push({ PaymentID: 'pay-old-1', Status: 'AUTHORISED', Amount: 23.1, Reference: 'SOS-LEEDS-20260929 Card', Invoice: { InvoiceID: 'inv-old' } });
  x.payments.push({ PaymentID: 'pay-old-2', Status: 'AUTHORISED', Amount: 4.91, Reference: 'SOS-LEEDS-20260929 Cash', Invoice: { InvoiceID: 'inv-old' } });
};

test('18. a half posted OLD way day finishes the old way: only its credit note and refund payment are sent', async () => {
  const g = plainDay();
  const seeded = oldWayHalfPosted();
  assert.equal(refundWayStarted(seeded.detail), 'credit_note');
  assert.deepEqual(retryConflicts(creditNoteWay(g), seeded.detail.postings), [], 'planned the way it was started, nothing is in the way');
  // Planned the new way it would have stopped: the invoice in Xero is the gross figure. This is why the row decides.
  const wrong = retryConflicts(plan(g), seeded.detail.postings);
  assert.deepEqual(wrong.filter((c) => c.key === 'INVOICE').map((c) => [c.code, c.message]),
    [['posted_amount_changed', 'SOS-LEEDS-20260929 is in Xero for 28.01; the day now comes to 24.21.']]);
  await withXero(async (x) => {
    const sb = fakeTable(seeded);
    const res = await attempt(sb, g, 'B1');
    assert.equal(res.started, 'credit_note');
    assert.equal(res.ok, true, res.e?.message);
    assert.deepEqual(x.calls, ['PUT /CreditNotes', 'PUT /Payments'], 'nothing else is sent or looked up');
    assert.deepEqual(x.invoices.map((i) => [i.InvoiceID, i.Total]), [['inv-old', 28.01]], 'never a second invoice');
    assert.deepEqual(x.creditNotes.map((c) => [c.CreditNoteNumber, c.Total]), [['SOS-LEEDS-20260929-R', 3.8]]);
    assert.deepEqual(x.payments.slice(2).map((p) => [p.Reference, p.Amount, !!p.CreditNote]), [['SOS-LEEDS-20260929-R Card', 3.8, true]]);
    // The credit note sent is the one the code before 13 Oct 2026 sent: plus figures, no "Refund: ".
    assert.deepEqual(x.creditNotes[0].sent.LineItems.map((l) => [l.Description, l.UnitAmount, l.TaxAmount]), [['Hot drinks 20%', 3.8, 0.63]]);
    const r = await readSyncRow(sb, KEY);
    assert.equal(r.status, 'ok');
    assert.equal(r.detail.refundWay, 'credit_note', 'recorded now, so it can never be read another way');
    assert.deepEqual(r.detail.documents.map((d) => [d.type, d.total]), [['invoice', 28.01], ['payment', 23.1], ['payment', 4.91], ['credit_note', 3.8], ['refund', 3.8]]);
    assert.deepEqual(saidWhy(res.plan).map((w) => w.reason), ['started_credit_note']);
  }, { seed: oldWayInXero });
});

test('19. a new way day that changed after part of it was sent never switches to a credit note', () => {
  // Started with its refunds on the invoice; now the refund would not fit (cash refunded, none taken).
  const p = plan(cashShortDay(), { started: 'lines' });
  assert.deepEqual([p.refundWay, p.refundWayReason], ['lines', 'started_lines']);
  assert.deepEqual(p.blocked.map((b) => [b.code, b.message]), [['refund_lines_changed',
    'This day was started in Xero with its refunds on the invoice, and the day has changed since, so the refunds no longer fit on it. Finish the day in Xero by hand.']]);
  assert.equal(p.creditNote, null);
  assert.deepEqual(p.refundPayments, []);
  assert.deepEqual(saidWhy(p), []);
  assert.ok(!steps(p).some((k) => k === 'CREDIT' || k.startsWith('REFUND:')), 'nothing of the credit note way is planned');
  // The same when the sales are gone: no invoice, no credit note, the block stands.
  const none = plan(noSalesDay(), { started: 'lines' });
  assert.deepEqual([none.invoice, none.creditNote, none.blocked.map((b) => b.code)], [null, null, ['refund_lines_changed']]);
  assert.deepEqual(steps(none), []);
  // Started with refund lines and the refund is no longer part of the day: the invoice in Xero
  // (24.21) is not the day now (28.01), and the retry stops as any changed day does.
  const gone = plan(grouped(saleRows(), []), { started: 'lines' });
  assert.deepEqual([gone.refundWay, gone.blocked], [null, []]);
  assert.deepEqual(retryConflicts(gone, { INVOICE: { status: 'posted', id: 'inv-1', number: 'SOS-LEEDS-20260929', total: 24.21 } }).map((c) => [c.code, c.message]),
    [['posted_amount_changed', 'SOS-LEEDS-20260929 is in Xero for 24.21; the day now comes to 28.01.']]);
  // A refund that grew: the new way plan no longer matches what is posted either.
  const grew = plan(tipsDay(), { started: 'lines' });
  assert.equal(retryConflicts(grew, { INVOICE: { status: 'posted', id: 'inv-1', number: 'SOS-LEEDS-20260929', total: 24.21 } })[0].code, 'posted_amount_changed');
  // The lines themselves not adding up to the day's refunds stops the day in its own words.
  const g = plainDay();
  g.summary.refunds.totals.gross += 1;
  assert.deepEqual(plan(g).blocked.map((b) => [b.code, b.message]), [['refund_totals_mismatch', "The refund lines come to 3.80 but the day's refunds are 3.81. Nothing was posted."]]);
  assert.deepEqual(creditNoteWay(g).blocked.map((b) => b.message), ["The credit note lines come to 3.80 but the day's refunds are 3.81. Nothing was posted."]);
});

test('20. Xero refuses an invoice with refund lines: the row says so, and the next attempt sends a credit note', async () => {
  const g = plainDay();
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, g, 'E1');
    assert.equal(first.ok, false);
    assert.equal(first.e.status, 400);
    assert.equal(first.refused, true);
    assert.equal(x.invoices.length, 0, 'nothing of the day is in Xero');
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay], ['error', 'lines']);
    assert.deepEqual(posted(r), [['INVOICE', 'sending', 24.21]]);
    assert.ok(r.detail.refundLinesRefused?.at && /400/.test(r.detail.refundLinesRefused.message));
    assert.equal(first.error, 'Xero did not take this day with its refunds on the invoice: A rule nobody knew about. Nothing was posted. The next push sends the refunds as a credit note.');
    assert.equal(r.detail.error, first.error);
    // The opened day in the Postings history never says the refunds are on the invoice: Xero refused it.
    assert.equal(historyRefundNote(asHistory(r)), '');
    // invoiceRefusal: only Xero's own 400 to the invoice this run sent, only a plan with refund
    // lines, only while nothing else of the day is on the row.
    const sending = r.detail.postings;
    const err = { status: 400, message: first.e.message, words: xeroErrorWords(first.e.message) };
    const says = (pl, postings, error) => invoiceRefusal(pl, { started: null, postings, before: null, error });
    assert.match(err.message, /^Xero API \/Invoices failed: 400 /);
    assert.equal(says(first.plan, sending, err), 'lines');
    assert.equal(says(first.plan, sending, { ...err, status: '400' }), 'lines');
    assert.equal(says(first.plan, sending, { ...err, status: 500 }), null);
    assert.equal(says(first.plan, sending, { ...err, status: undefined }), null);
    assert.equal(says(first.plan, sending, null), null);
    assert.equal(invoiceRefusal(first.plan), null);
    assert.equal(says(first.plan, sending, { ...err, message: err.message.replace('/Invoices failed', '/Invoices?InvoiceNumbers=SOS-LEEDS-20260929 failed') }), null, 'a lookup that failed is not Xero refusing the invoice');
    assert.equal(says(first.plan, sending, { ...err, message: err.message.replace('/Invoices failed', '/Payments failed') }), null);
    assert.equal(says(first.plan, sending, { ...err, message: 'network connection lost' }), null);
    assert.equal(says(creditNoteWay(g), sending, err), null, 'a credit note plan has no refund lines to refuse');
    assert.equal(says(plan(grouped(saleRows())), sending, err), null, 'a day with no refunds');
    assert.equal(says(null, sending, err), null, 'refused before a plan was made');
    assert.equal(says(plan(noSalesDay(), { started: 'lines' }), sending, err), null, 'no invoice in the plan');
    assert.equal(says(first.plan, { ...sending, 'PAY:CARDCLR': { status: 'posted', id: 'p' } }, err), null);
    assert.equal(says(first.plan, { INVOICE: { status: 'posted', id: 'i' }, 'PAY:CARDCLR': { status: 'sending' } }, err), null, 'the invoice is in Xero');
    assert.equal(says(first.plan, { INVOICE: { status: 'posted', id: 'i' } }, err), null);
    assert.equal(says(first.plan, {}, err), null);
    assert.equal(says(first.plan, null, err), null);
    assert.deepEqual(refusalPatch(null, sending, { at: 'T', message: 'm', words: 'w' }), {});
    assert.equal(refusalWords(null, 'w'), '');
    assert.equal(refundWayStarted(r.detail), 'refused');
    // The next attempt: the credit note way, in full.
    const second = await attempt(sb, g, 'E2');
    assert.equal(second.started, 'refused');
    assert.equal(second.ok, true, second.e?.message);
    assert.deepEqual([second.plan.refundWay, second.plan.refundWayReason], ['credit_note', 'xero_refused']);
    assert.deepEqual(saidWhy(second.plan).map((w) => [w.reason, w.message]), [['xero_refused', 'Xero did not take this day with its refunds on the invoice, so the refunds go to Xero as a credit note.']]);
    assert.deepEqual(x.invoices.map((i) => i.Total), [28.01]);
    assert.deepEqual(x.creditNotes.map((c) => c.Total), [3.8]);
    assert.deepEqual(x.payments.map((p) => [p.Reference, p.Amount]), [['SOS-LEEDS-20260929 Card', 23.1], ['SOS-LEEDS-20260929 Cash', 4.91], ['SOS-LEEDS-20260929-R Card', 3.8]]);
    assert.ok(x.calls.indexOf('GET /Invoices') < x.calls.lastIndexOf('PUT /Invoices'), 'the number is looked up before the invoice is sent again');
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay], ['ok', 'credit_note']);
    assert.equal(refundWayStarted(r.detail), 'refused', 'a credit note day, and the row still says Xero refused its refund lines');
    assert.equal(plan(g, { started: refundWayStarted(r.detail) }).refundWay, 'credit_note');
    assert.equal(historyRefundNote(asHistory(r)), '');
  }, { refuse: (method, where, body) => (method === 'PUT' && where === '/Invoices' && body.Invoices[0].LineItems.some((l) => /^Refund: /.test(l.Description))
    ? new Response(JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: 'A rule nobody knew about.' }] }] }), { status: 400 }) : null) });
});

// ── 21, 22: what reads a posted day ──────────────────────────────────────────

test('21. a day posted with a credit note still reads correctly: history, links, and "changed since posted"', () => {
  const g = plainDay();
  const doc = (key, type, number, reference, total, xeroId) => ({ key, type, number, reference, total, xeroId, status: 'AUTHORISED', link: null });
  const documents = [
    doc('INVOICE', 'invoice', 'SOS-LEEDS-20260929', 'Coffee Boy Leeds takings Tue 29 Sep 2026', 28.01, 'inv-1'),
    doc('PAY:CARDCLR', 'payment', null, 'SOS-LEEDS-20260929 Card', 23.1, 'pay-1'),
    doc('PAY:CASHTILL', 'payment', null, 'SOS-LEEDS-20260929 Cash', 4.91, 'pay-2'),
    doc('CREDIT', 'credit_note', 'SOS-LEEDS-20260929-R', 'Coffee Boy Leeds takings Tue 29 Sep 2026 refunds', 3.8, 'cn-1'),
    doc('REFUND:CARDCLR', 'refund', null, 'SOS-LEEDS-20260929-R Card', 3.8, 'pay-3'),
  ];
  const postings = Object.fromEntries(documents.map((d) => [d.key, { status: 'posted', type: d.type, id: d.xeroId, number: d.number, reference: d.reference, total: d.total }]));
  const oldRow = { status: 'ok', detail: { model: 'sales_invoice', postings, documents } };   // no refundWay: posted before 13 Oct 2026
  // The Postings tab: the five documents in order, Open in Xero on the invoice and the credit note.
  const docs = historyDocs({ documents, postings: null }, '!abc');
  assert.deepEqual(docs.map((d) => [d.type, d.number, d.total]), [
    ['invoice', 'SOS-LEEDS-20260929', 28.01], ['payment', null, 23.1], ['payment', null, 4.91], ['credit_note', 'SOS-LEEDS-20260929-R', 3.8], ['refund', null, 3.8],
  ]);
  assert.deepEqual(docs.map((d) => d.link), [xeroDocLink('invoice', 'inv-1', '!abc'), null, null, xeroDocLink('credit_note', 'cn-1', '!abc'), null]);
  assert.match(docs[3].link, /ViewCreditNote\.aspx\?creditNoteID=cn-1$/);
  // A link saved with the day is kept.
  assert.equal(historyDocs({ documents: [{ ...documents[0], link: 'https://go.xero.com/kept' }] }, null)[0].link, 'https://go.xero.com/kept');
  // A day not finished, read from its postings: CREDIT is a credit note, and only what is in Xero is listed.
  const part = historyDocs({ documents: null, postings: {
    INVOICE: { status: 'posted', id: 'inv-1', number: 'SOS-LEEDS-20260929', total: 28.01 },
    CREDIT: { status: 'posted', id: 'cn-1', number: 'SOS-LEEDS-20260929-R', total: 3.8 },
    'REFUND:CARDCLR': { status: 'sending', reference: 'SOS-LEEDS-20260929-R Card', total: 3.8 },
  } }, null);
  assert.deepEqual(part.map((d) => [d.type, d.number, d.total, !!d.link]), [['invoice', 'SOS-LEEDS-20260929', 28.01, true], ['credit_note', 'SOS-LEEDS-20260929-R', 3.8, true]]);
  // An older bank transactions day reads as before.
  assert.deepEqual(historyDocs({ lines: [{ bankTransactionID: 'bt-1', reference: 'ServOS takings', total: 5, direction: 'takings' }, { reference: 'not sent' }] }, null).map((d) => [d.type, d.xeroId]), [['bank', 'bt-1']]);
  assert.deepEqual(historyDocs({}, null), []);
  // A new way day: its invoice and payments, nothing else.
  const newDocs = [doc('INVOICE', 'invoice', 'SOS-LEEDS-20260929', 'r', 24.21, 'inv-9'), doc('PAY:CARDCLR', 'payment', null, 'SOS-LEEDS-20260929 Card', 19.3, 'pay-8'), doc('PAY:CASHTILL', 'payment', null, 'SOS-LEEDS-20260929 Cash', 4.91, 'pay-9')];
  assert.deepEqual(historyDocs({ documents: newDocs }, null).map((d) => d.type), ['invoice', 'payment', 'payment']);
  // Never mixed, and the model does not change.
  assert.equal(dayModel(oldRow, 'sales_invoice', '2026-09-01', DATE), 'sales_invoice');
  assert.equal(refundWayStarted(oldRow.detail), 'credit_note');
  // "Changed since it was posted": planned the way it was posted, nothing has changed.
  assert.deepEqual(postedDayChanges(plan(g, { started: refundWayStarted(oldRow.detail) }), documents), []);
  // Planned the new way, the same unchanged day would wrongly read as changed (so the row decides).
  assert.deepEqual(postedDayChanges(plan(g), documents), ['SOS-LEEDS-20260929: posted 28.01, now 24.21', 'SOS-LEEDS-20260929-R: posted 3.80, now 0.00']);
  // A new way day, compared the new way: unchanged.
  const newRow = { refundWay: 'lines', postings: Object.fromEntries(newDocs.map((d) => [d.key, { status: 'posted', id: d.xeroId, total: d.total }])) };
  assert.equal(refundWayStarted(newRow), 'lines');
  assert.deepEqual(postedDayChanges(plan(g, { started: 'lines' }), newDocs), []);
  // A late refund on a day posted with no refunds is still reported, as a credit note that is not in Xero.
  const noRefundDocs = [doc('INVOICE', 'invoice', 'SOS-LEEDS-20260929', 'r', 28.01, 'inv-1')];
  const noRefundRow = { postings: { INVOICE: { status: 'posted', id: 'inv-1', total: 28.01 } } };
  assert.deepEqual(postedDayChanges(plan(g, { started: refundWayStarted(noRefundRow) }), noRefundDocs), ['SOS-LEEDS-20260929-R: posted 0.00, now 3.80']);
  // And a late check on a new way day, as the invoice total.
  assert.deepEqual(postedDayChanges(plan(grouped([...saleRows(), { ...E, id: 'late' }], refundRows()), { started: 'lines' }), newDocs), ['SOS-LEEDS-20260929: posted 24.21, now 32.21']);
  assert.deepEqual(postedDayChanges(null, null), []);
});

test('22. replace day: once the old entries are removed the day is free, and both numbers are still checked', () => {
  const g = plainDay();
  const bank = { model: 'bank_tx', lines: [], warnings: [], refundWay: 'lines',   // a left over marker changes nothing
    postings: { 'RECEIVE:acc': { status: 'deleted', id: 'bt-1', reference: 'ServOS takings 2026-09-29', total: 28.01 }, 'SPEND:acc': { status: 'deleted', id: 'bt-2', reference: 'ServOS refunds 2026-09-29', total: 3.8 } },
    replace: { state: 'deleting', by: { id: 'u1' }, at: '2026-10-14T09:00:00.000Z', old: [], was: { status: 'ok', lines: [], warnings: [] } } };
  assert.equal(refundWayStarted(bank), null, 'before: only the old bank transactions');
  const after = { ...bank, ...allDeletedPatch(bank, '2026-10-14T09:00:05.000Z') };
  assert.deepEqual(after.postings, {});
  assert.equal(after.replace.state, 'deleted');
  assert.equal(refundWayStarted(after), null, 'after: nothing of a sales invoice was sent');
  const p = plan(g, { started: refundWayStarted(after) });
  assert.equal(p.refundWay, 'lines');
  assert.equal(refundWayToRecord(refundWayStarted(after), p), 'lines');
  // The preview shows the invoice at sales less refunds, and no credit note row.
  const view = previewView({ plan: p });
  assert.deepEqual(view.invoice, { number: 'SOS-LEEDS-20260929', total: 24.21 });
  assert.equal(view.creditNote, null);
  assert.equal(view.canReplace, true);
  // Before anything is deleted the credit note number is checked too: the fall back would need it.
  assert.deepEqual(dayNumbers(p), { invoice: 'SOS-LEEDS-20260929', creditNote: 'SOS-LEEDS-20260929-R' });
  assert.deepEqual(dayNumbers(plan(cashShortDay())), { invoice: 'SOS-LEEDS-20260929', creditNote: 'SOS-LEEDS-20260929-R' });
  assert.deepEqual(dayNumbers(plan(noSalesDay())), { invoice: null, creditNote: 'SOS-LEEDS-20260929-R' });
  assert.deepEqual(dayNumbers(plan(grouped(saleRows()))), { invoice: 'SOS-LEEDS-20260929', creditNote: null }, 'a day with no refunds never uses the credit note number');
  assert.deepEqual(dayNumbers(null), { invoice: null, creditNote: null });
  // A fall back day in the preview still shows its credit note.
  assert.deepEqual(previewView({ plan: plan(cashShortDay()) }).creditNote, { number: 'SOS-LEEDS-20260929-R', total: 2 });
});

// ── 23, 24: words and wiring ─────────────────────────────────────────────────

test('23. the words: every refund line starts "Refund: ", and nothing a person reads has a dash', () => {
  const said = [];
  const reasons = new Set();
  for (const [name, f] of Object.entries(DAYS)) {
    for (const started of [null, 'lines', 'credit_note', 'refused']) {
      const p = plan(f(), { started });
      for (const l of p.invoice?.lines || []) {
        if (l.refund) assert.ok(l.description.startsWith('Refund: ') && l.description.length > 'Refund: '.length, `${name}: ${l.description}`);
        else assert.ok(!l.description.startsWith('Refund'), `${name}: ${l.description}`);
        said.push(l.description);
      }
      for (const l of p.creditNote?.lines || []) assert.ok(!l.description.startsWith('Refund: '), `${name}: the credit note keeps its own words (${l.description})`);
      for (const w of p.warnings) { said.push(w.message); if (w.code === 'refunds_as_credit_note') { reasons.add(w.reason); assert.ok(w.message, `${name} ${w.reason}`); } }
      for (const b of p.blocked) said.push(b.message);
      const view = planView(p);
      assert.deepEqual([view.refundWay, view.refundWayReason], [p.refundWay, p.refundWayReason]);
    }
  }
  assert.deepEqual([...reasons].sort(), ['account_short', 'no_sales', 'started_credit_note', 'total_not_positive', 'vat_negative', 'xero_refused']);
  const g = plainDay();
  g.summary.refunds.totals.gross += 1;
  said.push(...plan(g).blocked.map((b) => b.message));
  // A "differs from what Xero would work out" note on a refund line names it as one.
  const gift = plan(giftDay()).warnings.find((w) => w.code === 'vat_override_large');
  assert.match(gift.message, /Refund: Hot drinks 20%: ServOS 0\.00, Xero would work out 0\.53/);
  assert.doesNotMatch(creditNoteWay(giftDay()).warnings.find((w) => w.code === 'vat_override_large').message, /Refund: /);
  assert.ok(said.length > 100);
  for (const s of said) assert.doesNotMatch(s, DASH, s);
  // The US words say "sales tax", not VAT.
  const us = planXeroInvoiceDay({ summary: { ...vatNegativeDay().summary, defaultTaxBucket: { key: 'excl' } }, groups: vatNegativeDay().groups }, { mapping: mapping(), detail: DETAIL, site: SITE, date: DATE });
  const usWhy = us.warnings.find((w) => w.code === 'refunds_as_credit_note');
  if (usWhy?.reason === 'vat_negative') assert.equal(usWhy.message, 'The sales tax on the refunds of this day is more than the sales tax on its sales. The refunds go to Xero as a credit note.');
  // Back Office: the sentences are there, and the lines they are on have no dash.
  const screens = {
    'src/backoffice/sections/xero/xeroUi.js': ["line?.refund ? 'Refund'", 'Refunds are the minus lines at the end. Sales ', ' makes the invoice total.', 'Payments on the invoice, takings less refunds (it shows as Paid)', 'per rate on the refund lines', 'Refunds are on the invoice as minus lines.'],
    // The setup words belong to the invoice; the refund sentence says WHICH day's invoice (the day
    // the refund was made, never the day of the sale) and what to search for in Xero ("Refund:").
    'src/backoffice/sections/XeroIntegration.jsx': ['paid into its clearing accounts (set up under {tabName}). A refund is a minus line on the invoice of the day it was made.'],
    'src/backoffice/sections/xero/SiteSetup.jsx': ['are minus lines on the invoice of the day the refund was made, each starting “Refund:”. A day whose refunds cannot go on its invoice sends them as a credit note.', 'A credit note, when a day needs one, is <b>{creditNoteNumber('],
    'supabase/functions/_shared/xeroInvoicePlan.js': ['Xero did not take this day with its refunds on the invoice: ', ' Nothing was posted. The next push sends the refunds as a credit note.', 'Xero did not take this day: ', ' Nothing was posted. Put that right, then push again.'],
  };
  for (const [file, phrases] of Object.entries(screens)) {
    const lines = read(file).split('\n');
    for (const phrase of phrases) {
      const on = lines.filter((l) => l.includes(phrase));
      assert.ok(on.length >= 1, `${file}: ${phrase}`);
      for (const l of on) assert.doesNotMatch(l, DASH, `${file}: ${phrase}`);
    }
  }
  // The old promises are gone from the screens.
  assert.ok(!read('src/backoffice/sections/xero/SiteSetup.jsx').includes('Refunds post as a credit note'));
  assert.ok(!read('src/backoffice/sections/XeroIntegration.jsx').includes('with a credit note for refunds'));
  assert.ok(!read('src/backoffice/sections/XeroIntegration.jsx').includes('Refunds are minus lines on the same invoice (set up under'), 'refund lines are not a setting to find under a tab');
  assert.ok(!read('src/backoffice/sections/xero/SiteSetup.jsx').includes('same day’s invoice'));
  for (const kind of ['lines', 'other']) for (const w of ['A rule nobody knew about.', 'The account is archived', 'Stop!']) assert.doesNotMatch(refusalWords(kind, w), DASH);
  assert.equal(refusalWords('other', 'The account is archived'), 'Xero did not take this day: The account is archived. Nothing was posted. Put that right, then push again.');
  assert.equal(refusalWords('lines', 'Stop!'), 'Xero did not take this day with its refunds on the invoice: Stop! Nothing was posted. The next push sends the refunds as a credit note.');
  // Old days still have their words: the credit note and refund payment labels stay.
  const history = read('src/backoffice/sections/xero/PostingsHistory.jsx');
  assert.match(history, /credit_note: 'Credit note', payment: 'Payment', refund: 'Refund'/);
  // The screens take what they say, and when, from the tested functions (test 29), and decide nothing themselves.
  const preview = read('src/backoffice/sections/xero/InvoicePreview.jsx');
  assert.match(preview, /const words = previewWords\(view, \{ tw, fmt: \(n\) => money\(n, cur\) \}\);/);
  assert.match(preview, /<Doc doc=\{view\.invoice\} title="Sales invoice" [^>]*tagFor=\{words\.tagFor\} \/>\n\s+\{words\.note && <div [^>]*>\{words\.note\}<\/div>\}/);
  assert.match(preview, /<Payments list=\{view\.payments\} [^>]*title=\{words\.paymentsTitle\} \/>/);
  assert.match(preview, /<Doc doc=\{words\.creditNote\} title="Credit note for refunds" [^>]*tagFor=\{words\.tagFor\} \/>/);
  assert.match(preview, /<Payments list=\{words\.refundPayments\} [^>]*title="Refund payments" \/>/);
  assert.match(preview, /\{tie\(refunds, words\.refundTieTitle\)\}/);
  assert.match(preview, /<div style=\{\{ fontSize: 11, color: 'var\(--t4\)' \}\}>\{tagFor\(l\)\}<\/div>/);
  assert.match(preview, /<Lines lines=\{doc\.lines\} [^>]*tagFor=\{tagFor\} \/>/);
  assert.doesNotMatch(preview.replace(/^\s*\/\/.*$/gm, ''), /refundWay|asLines|l\.refund/, 'no refund decision is made in the screen itself');
  assert.match(history, /const refundNote = historyRefundNote\(d\);/);
  assert.match(history, /\{refundNote && <div [^>]*>\{refundNote\}<\/div>\}/);
  assert.doesNotMatch(history.replace(/^\s*\/\/.*$/gm, ''), /refundWay/, 'the history screen decides nothing about refunds itself');
});

test('24. xero-sales and xero-config are wired to these functions; Ready and the figures tick did not move', () => {
  const sales = read('supabase/functions/xero-sales/index.ts');
  const config = read('supabase/functions/xero-config/index.ts');
  // Every plan of a day in xero-sales is made the way its row says.
  const calls = sales.split('\n').filter((l) => l.includes('planXeroInvoiceDay(') && !l.trim().startsWith('//') && !l.trim().startsWith('planXeroInvoiceDay,'));
  assert.equal(calls.length, 5, 'the already compare, the Ready check, the dry run, the real post and the replace');
  for (const l of calls) assert.match(l, /, started(: refundWayStarted\(prior\.detail\))? \}\)/, l.trim().slice(0, 80));
  // The real post: decided on the row the run HOLDS, after the model check, and recorded before anything is sent.
  const day = sales.slice(sales.indexOf('async function invoiceDay('), sales.indexOf('async function replaceDay('));
  const order = ['await claimSyncRun(sb, key)', "await modelChanged(run, cfgRow, date, 'sales_invoice', auto, base)", 'const started = refundWayStarted(run.detail);',
    'const refusedBefore = run.postings.INVOICE?.refusedNotLines || null;', 'invoiceNotReady(grouped, mapping, cfgRow?.detail, siteArg, date, venue, started)', '\n    plan = planXeroInvoiceDay(grouped, { mapping, detail, site: siteArg, date, currency: venue.currency, started });', 'refundWay: refundWayToRecord(started, plan)', 'await postInvoiceDay(run, plan,'];
  const at0 = order.map((w) => day.indexOf(w));
  assert.ok(at0.every((i) => i > 0), `all there: ${at0}`);
  assert.deepEqual([...at0].sort((a, b) => a - b), at0, 'in this order');
  assert.match(day, /const started = refundWayStarted\(prior\?\.detail\);\n\s+const plan = planXeroInvoiceDay\(/, 'a dry run shows the way the row started');
  // What Xero's "no" to the invoice says about the refund lines is judged by the tested function,
  // from the row as this run claimed it, and recorded on the row with the words the person reads.
  assert.match(day, /const xeroWords = xeroErrorWords\(msg\);\n\s+const refusal = invoiceRefusal\(plan, \{ started, postings: run\.postings, before: refusedBefore, error: \{ status: \(e as any\)\?\.status, message: msg, words: xeroWords \} \}\);/);
  assert.match(day, /const said = refusal \? refusalWords\(refusal, xeroWords\)\n/);
  assert.match(day, /const refused = refusalPatch\(refusal, run\.postings, \{ at: new Date\(\)\.toISOString\(\), message: msg, words: xeroWords \}\);/);
  assert.match(day, /detail: \{ model: 'sales_invoice', window, error, notReady, problems, \.\.\.refused \}/);
  // One rule for "that number is taken", used by the post and by the refusal rule.
  const post = read('supabase/functions/_shared/xeroInvoicePost.ts');
  assert.match(post, /retryConflicts, isNumberTaken \} from '\.\/xeroInvoicePlan\.js';/);
  assert.doesNotMatch(post, /const isNumberTaken/);
  assert.match(post, /if \(isDoc && isNumberTaken\(\(e as Error\)\?\.message \|\| ''\)\) \{/);
  // The already answer compares the day the way it was posted.
  const already = sales.slice(sales.indexOf('async function invoiceAlreadyAnswer('), sales.indexOf('function invoiceNotReady('));
  assert.match(already, /started: refundWayStarted\(prior\.detail\) \}\);\n\s+const changed: string\[\] = postedDayChanges\(plan, docs\);/);
  // Replace: the way from the row in the preview and in the run, and both numbers checked.
  const replace = sales.slice(sales.indexOf('async function replaceDay('), sales.indexOf('Deno.serve('));
  assert.match(replace, /invoiceNotReady\(grouped, mapping, cfgRow\?\.detail, siteArg, date, venue, refundWayStarted\(prior\?\.detail\)\)/);
  assert.match(replace, /const started = refundWayStarted\(run\.detail\);/);
  assert.equal((replace.match(/numbersTaken\(api, dayNumbers\(plan\)\)/g) || []).length, 2);
  // The push hands the row it read to the dry run.
  assert.match(sales, /invoiceDay\(\{ base, locationId, date, venue, clock, auto, dryRun, cfgRow: cfg, key, fromMs, prior \}\)/);
  // xero-config: the history documents come from the tested function, and the detail says the way.
  assert.doesNotMatch(config, /function historyDocs/);
  assert.match(config, /dayModel, historyDocs,\n\} from '\.\.\/_shared\/xeroInvoicePlan\.js';/);
  assert.match(config, /const docs = historyDocs\(row, shortCodes\[r\.location_id\] \|\| null\);/);
  assert.match(config, /refundWay: d\.refundWay \|\| null,/);
  // No new setting, no new mapping key, nothing that could make a live site Not Ready.
  const m = mapping();
  assert.equal(mappingHash(m), 'f637af9c', 'the figures tick of every live site still stands (the hash of the fixture choices is what it was on 12 Oct 2026)');
  assert.equal(mappingHash({ ...m, refundWay: 'lines', refundLines: true }), mappingHash(m));
  const ready = invoiceReadiness({ ...m, figuresChecked: { hash: mappingHash(m) }, invoiceStartDate: '2026-09-01' }, { seen: seenFromGrouped(plainDay()) });
  assert.deepEqual(ready.items.map((i) => [i.key, i.ok]), [['site', true], ['tracking', true], ['groups', true], ['discounts', true], ['tips', true], ['clearing', true], ['figures', true], ['start', true]]);
  assert.equal(ready.ready, true);
  // A day with refund lines asks for nothing the credit note way did not.
  for (const f of Object.values(LINES_DAYS)) assert.deepEqual(plan(f()).notReady, creditNoteWay(f()).notReady);
  const noTips = mapping({ tipsAccount: undefined });
  assert.deepEqual(plan(tipsDay(), {}, noTips).notReady, creditNoteWay(tipsDay(), noTips).notReady);
  // A missing clearing account still refuses the day whichever way, in the same words.
  const noCash = mapping({ clearing: { card: 'CARDCLR' } });
  assert.deepEqual(plan(serviceDay(), {}, noCash).blocked.filter((b) => b.code === 'clearing_unmapped'), creditNoteWay(serviceDay(), noCash).blocked.filter((b) => b.code === 'clearing_unmapped'));
  assert.equal(plan(serviceDay(), {}, noCash).blocked.filter((b) => b.code === 'clearing_unmapped').length, 2, 'the cash taken and the cash refunded');
  assert.ok(!plan(serviceDay(), {}, noCash).blocked.some((b) => b.code === 'payments_mismatch'));
});

// ── 25 to 28: what Xero's "no" to an invoice says about its refund lines (review, 13 Oct 2026) ──

const LOCK = 'The document date cannot be before the period lock date, currently set at 30 Sep 2026';

test('25. a lock date is never read as Xero refusing the refund lines: the day goes with them once the lock is moved', async () => {
  const g = plainDay();
  let locked = true;
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, g, 'L1');
    assert.equal(first.ok, false);
    assert.equal(first.e.status, 400);
    assert.deepEqual([first.started, first.plan.refundWay, first.refusal], [null, 'lines', 'other']);
    assert.equal(first.error, `Xero did not take this day: ${LOCK}. Nothing was posted. Put that right, then push again.`);
    assert.doesNotMatch(first.error, /credit note|refunds on the invoice/, "Xero's own words, and no promise of a credit note");
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.error, r.detail.refundWay, r.detail.refundLinesRefused], ['error', first.error, null, null]);
    assert.deepEqual(posted(r), [['INVOICE', 'sending', 24.21]]);
    assert.deepEqual(r.detail.postings.INVOICE.refusedNotLines, { at: '2026-10-14T03:10:00.000Z', words: LOCK });
    assert.ok(r.detail.postings.INVOICE.payload.LineItems.some((l) => l.Description === 'Refund: Hot drinks 20%'), 'the row still shows exactly what was sent');
    assert.equal(refundWayStarted(r.detail), null, 'nothing is in Xero: the day is free');
    assert.equal(historyRefundNote(asHistory(r)), '');
    // The next hourly run, the lock still on: tried the same way, never the credit note way.
    const second = await attempt(sb, g, 'L2');
    assert.deepEqual([second.started, second.plan.refundWay, second.refusal], [null, 'lines', 'other']);
    assert.equal(refundWayStarted((await readSyncRow(sb, KEY)).detail), null);
    assert.equal(x.invoices.length + x.creditNotes.length + x.payments.length, 0, 'nothing of the day is in Xero');
    assert.equal(x.puts().filter((c) => c === 'PUT /CreditNotes').length, 0);
    // The lock date is moved in Xero: the day posts with its refunds on the invoice, as asked for.
    locked = false;
    const third = await attempt(sb, g, 'L3');
    assert.equal(third.ok, true, third.e?.message);
    assert.deepEqual([third.started, third.plan.refundWay], [null, 'lines']);
    assert.deepEqual(x.invoices.map((i) => i.Total), [24.21]);
    assert.equal(x.creditNotes.length, 0);
    assert.deepEqual(x.payments.map((p) => [p.Reference, p.Amount]), [['SOS-LEEDS-20260929 Card', 19.3], ['SOS-LEEDS-20260929 Cash', 4.91]]);
    assert.deepEqual(saidWhy(third.plan), []);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay, refundWayStarted(r.detail)], ['ok', 'lines', 'lines']);
    assert.equal(r.detail.postings.INVOICE.refusedNotLines, undefined, 'the mark went the moment the invoice was sent again');
    assert.equal(historyRefundNote(asHistory(r)), 'Refunds are on the invoice as minus lines.');
  }, { refuse: (method, where) => (locked && method === 'PUT' && where === '/Invoices' ? xero400(LOCK) : null) });
  // Xero's other lock date sentence reads the same.
  const alone = { INVOICE: { status: 'sending' } };
  const err = (words) => ({ status: 400, message: `Xero API /Invoices failed: 400 ${JSON.stringify({ Elements: [{ ValidationErrors: [{ Message: words }] }] })}`, words });
  assert.equal(invoiceRefusal(plan(g), { postings: alone, error: err('The document date cannot be before the end of year lock date, currently set at 31 Mar 2026') }), 'other');
  // A day with no refund lines on its invoice (the credit note way, or no refunds) has none to
  // refuse: nothing about it changes, lock date or not.
  assert.equal(invoiceRefusal(creditNoteWay(g), { started: 'credit_note', postings: alone, error: err(LOCK) }), null);
  assert.equal(invoiceRefusal(plan(cashShortDay()), { postings: alone, error: err(LOCK) }), null);
  assert.equal(invoiceRefusal(plan(grouped(saleRows())), { postings: alone, error: err(LOCK) }), null);
  // Only Xero's own words count, never the invoice it sends back with them.
  assert.equal(invoiceRefusal(plan(g), { postings: alone, error: { ...err('A rule nobody knew about.'), message: 'Xero API /Invoices failed: 400 {"Elements":[{"Reference":"Lock date drinks"}]}' } }), 'lines');
});

test('26. Xero refuses the invoice with its refund lines AND without them: the lines were not the cause, and the day is free again', async () => {
  const g = plainDay();
  const WHY = "Account code '201' has been archived, or has been deleted. Each line item must reference a valid account.";
  let broken = true;
  await withXero(async (x) => {
    const sb = fakeTable();
    // 1. With its refund lines: refused. Nothing shows another cause yet, so the row says the lines were refused.
    const first = await attempt(sb, g, 'M1');
    assert.deepEqual([first.started, first.plan.refundWay, first.refusal], [null, 'lines', 'lines']);
    let r = await readSyncRow(sb, KEY);
    assert.equal(refundWayStarted(r.detail), 'refused');
    // 2. Without them (the credit note way), refused as well: the refund lines were not the cause.
    const second = await attempt(sb, g, 'M2');
    assert.deepEqual([second.started, second.plan.refundWay, second.plan.refundWayReason, second.refusal], ['refused', 'credit_note', 'xero_refused', 'other']);
    assert.equal(second.error, `Xero did not take this day: ${WHY} Nothing was posted. Put that right, then push again.`);
    assert.doesNotMatch(second.error, /credit note|refunds on the invoice/, "Xero's own words only");
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.error, r.detail.refundWay, r.detail.refundLinesRefused], ['error', second.error, null, null]);
    assert.deepEqual(posted(r), [['INVOICE', 'sending', 28.01]]);
    assert.equal(r.detail.postings.INVOICE.refusedNotLines.words, WHY);
    assert.equal(refundWayStarted(r.detail), null, 'free again: never left as a credit note day when nothing is in Xero');
    // 3. Still not put right (the next hourly run): tried with its refund lines, refused in the
    // same words. It stays free, and never goes round to "the next push sends a credit note" again.
    const third = await attempt(sb, g, 'M3');
    assert.deepEqual([third.started, third.plan.refundWay, third.refusal], [null, 'lines', 'other']);
    assert.equal(third.error, second.error);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([refundWayStarted(r.detail), r.detail.refundLinesRefused], [null, null]);
    assert.deepEqual(posted(r), [['INVOICE', 'sending', 24.21]]);
    assert.equal(x.invoices.length + x.creditNotes.length + x.payments.length, 0, 'nothing of the day is in Xero');
    // 4. The account is put right: the day posts with its refunds on the invoice. No credit note, no word of one.
    broken = false;
    const fourth = await attempt(sb, g, 'M4');
    assert.equal(fourth.ok, true, fourth.e?.message);
    assert.deepEqual([fourth.started, fourth.plan.refundWay], [null, 'lines']);
    assert.deepEqual(x.invoices.map((i) => i.Total), [24.21]);
    assert.equal(x.creditNotes.length, 0);
    assert.deepEqual(x.payments.map((p) => p.Amount), [19.3, 4.91]);
    assert.deepEqual(saidWhy(fourth.plan), []);
    assert.ok(!fourth.plan.warnings.some((w) => /credit note/.test(w.message)));
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay, refundWayStarted(r.detail)], ['ok', 'lines', 'lines']);
  }, { refuse: (method, where) => (broken && method === 'PUT' && where === '/Invoices' ? xero400(WHY) : null) });
  // The rule on its own.
  const alone = { INVOICE: { status: 'sending' } };
  const err = (words, status = 400) => ({ status, message: `Xero API /Invoices failed: ${status} ${JSON.stringify({ Elements: [{ ValidationErrors: [{ Message: words }] }] })}`, words });
  const lines = plan(g), gross = creditNoteWay(g);
  assert.equal(invoiceRefusal(gross, { started: 'refused', postings: alone, error: err('A') }), 'other', 'refused without its refund lines too');
  assert.equal(invoiceRefusal(gross, { started: 'refused', postings: alone, error: err('A', 503) }), null, 'only Xero saying no');
  assert.equal(invoiceRefusal(gross, { started: 'refused', postings: { ...alone, 'PAY:CARDCLR': { status: 'sending' } }, error: err('A') }), null);
  assert.equal(invoiceRefusal(gross, { started: 'refused', postings: { INVOICE: { status: 'posted', id: 'i' } }, error: err('A') }), null);
  assert.equal(invoiceRefusal(gross, { started: 'credit_note', postings: alone, error: err('A') }), null, 'a day on the credit note way for its own reasons goes on as it did');
  assert.equal(invoiceRefusal(lines, { postings: alone, before: { at: 'T', words: 'A' }, error: err('A') }), 'other', 'the words that refused it without its refund lines');
  assert.equal(invoiceRefusal(lines, { postings: alone, before: { at: 'T', words: 'A' }, error: err('B') }), 'lines', 'other words: judged afresh');
  assert.equal(invoiceRefusal(lines, { postings: alone, before: { at: 'T', words: '' }, error: err('') }), 'lines', 'no words are not the same words');
  // What each writes on the row.
  const sent = { INVOICE: { status: 'sending', total: 24.21 }, 'RECEIVE:a': { status: 'deleted' } };
  assert.deepEqual(refusalPatch('lines', sent, { at: 'T', message: 'm'.repeat(600), words: 'w' }), { refundLinesRefused: { at: 'T', message: 'm'.repeat(500) } });
  assert.deepEqual(refusalPatch('other', sent, { at: 'T', message: 'm', words: 'w' }),
    { refundLinesRefused: null, refundWay: null, postings: { INVOICE: { status: 'sending', total: 24.21, refusedNotLines: { at: 'T', words: 'w' } }, 'RECEIVE:a': { status: 'deleted' } } });
  assert.deepEqual(sent.INVOICE, { status: 'sending', total: 24.21 }, 'the postings handed in are not changed');
});

test('27. a day switched after a refusal keeps saying why, and finishes the credit note way with nothing sent twice', async () => {
  const g = plainDay();
  let phase = 1;   // 1 the refund lines are refused; 2 the invoice without them fails (503); 3 its cash payment fails; 4 all well
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, g, 'N1');
    assert.equal(first.refusal, 'lines');
    phase = 2;
    const second = await attempt(sb, g, 'N2');
    assert.deepEqual([second.started, second.ok, second.refusal], ['refused', false, null]);
    let r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.detail.refundWay, posted(r)], ['credit_note', [['INVOICE', 'sending', 28.01]]]);
    assert.ok(r.detail.refundLinesRefused?.at, 'the refusal stays on the row');
    assert.equal(refundWayStarted(r.detail), 'refused', 'nothing is in Xero yet: never "started in Xero as a credit note"');
    phase = 3;
    const third = await attempt(sb, g, 'N3');
    assert.deepEqual([third.started, third.ok, third.refusal], ['refused', false, null]);
    assert.deepEqual(saidWhy(third.plan).map((w) => w.reason), ['xero_refused']);
    r = await readSyncRow(sb, KEY);
    assert.equal(r.status, 'partial');
    assert.deepEqual(posted(r), [['INVOICE', 'posted', 28.01], ['PAY:CARDCLR', 'posted', 23.1], ['PAY:CASHTILL', 'sending', 4.91]]);
    assert.equal(refundWayStarted(r.detail), 'refused', 'part of it is in Xero now: still the credit note way, still saying why');
    phase = 4;
    x.calls.length = 0;
    const fourth = await attempt(sb, g, 'N4');
    assert.equal(fourth.ok, true, fourth.e?.message);
    assert.deepEqual([fourth.started, fourth.plan.refundWay, fourth.plan.refundWayReason], ['refused', 'credit_note', 'xero_refused']);
    assert.deepEqual(saidWhy(fourth.plan).map((w) => w.message), ['Xero did not take this day with its refunds on the invoice, so the refunds go to Xero as a credit note.']);
    assert.deepEqual(x.puts(), ['PUT /Payments', 'PUT /CreditNotes', 'PUT /Payments'], 'only what was still to send');
    assert.deepEqual(x.invoices.map((i) => i.Total), [28.01]);
    assert.deepEqual(x.creditNotes.map((c) => c.Total), [3.8]);
    assert.deepEqual(x.payments.map((p) => [p.Reference, p.Amount]), [['SOS-LEEDS-20260929 Card', 23.1], ['SOS-LEEDS-20260929 Cash', 4.91], ['SOS-LEEDS-20260929-R Card', 3.8]]);
    r = await readSyncRow(sb, KEY);
    assert.deepEqual([r.status, r.detail.refundWay], ['ok', 'credit_note']);
    assert.deepEqual(r.detail.warnings.filter((w) => w.code === 'refunds_as_credit_note').map((w) => w.reason), ['xero_refused'], 'the finished row says why its refunds are a credit note');
  }, { refuse: (method, where, body) => {
    if (method === 'PUT' && where === '/Invoices' && phase === 1) return xero400('A rule nobody knew about.');
    if (method === 'PUT' && where === '/Invoices' && phase === 2) return new Response('Service Unavailable', { status: 503 });
    if (method === 'PUT' && where === '/Payments' && phase === 3 && /Cash$/.test(body.Payments[0].Reference)) return new Response('Service Unavailable', { status: 503 });
    return null;
  } });
});

test('28. a lookup that fails, or a number Xero says is taken, says nothing about the refund lines', async () => {
  const g = plainDay();
  // The answer to the invoice with its refund lines is lost and the invoice IS in Xero at sales
  // less refunds. Then the lookup of its number fails with a 400. The day must still finish.
  let lost = false, lookups = 0;
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, g, 'P1');
    assert.equal(first.ok, false);
    assert.deepEqual(x.invoices.map((i) => i.Total), [24.21]);
    const second = await attempt(sb, g, 'P2');
    assert.equal(second.ok, false);
    assert.equal(second.e.status, 400);
    assert.match(second.e.message, /^Xero API \/Invoices\?InvoiceNumbers=SOS-LEEDS-20260929 failed: 400 /);
    assert.equal(second.refusal, null, 'the lookup failed: that is not Xero refusing the invoice');
    const r = await readSyncRow(sb, KEY);
    assert.equal(r.detail.refundLinesRefused, undefined);
    assert.equal(refundWayStarted(r.detail), 'lines');
    const third = await attempt(sb, g, 'P3');
    assert.equal(third.ok, true, third.e?.message);
    assert.deepEqual(x.invoices.map((i) => i.Total), [24.21], 'the one invoice, found and paid');
    assert.equal(x.puts().filter((c) => c === 'PUT /Invoices').length, 1);
    assert.equal(x.creditNotes.length, 0);
    assert.deepEqual(x.payments.map((p) => p.Amount), [19.3, 4.91]);
  }, {
    lose: (method, where) => (method === 'PUT' && where === '/Invoices' && !lost ? (lost = true) : false),
    refuse: (method, where) => (method === 'GET' && where.startsWith('/Invoices?InvoiceNumbers=') && ++lookups === 1 ? xero400('The request could not be read.') : null),
  });
  // Xero says the number is taken and the lookup finds nothing: the invoice may be there, so the
  // day goes on the way it was started and is never switched.
  await withXero(async (x) => {
    const sb = fakeTable();
    const first = await attempt(sb, g, 'Q1');
    assert.equal(first.ok, false);
    assert.equal(first.e.status, 400);
    assert.ok(isNumberTaken(first.e.message));
    assert.equal(first.refusal, null);
    assert.deepEqual(x.calls, ['PUT /Invoices', 'GET /Invoices']);
    const r = await readSyncRow(sb, KEY);
    assert.equal(r.detail.refundLinesRefused, undefined);
    assert.equal(r.detail.postings.INVOICE.refusedNotLines, undefined);
    assert.deepEqual([r.detail.refundWay, refundWayStarted(r.detail)], ['lines', 'lines']);
  }, { refuse: (method, where) => (method === 'PUT' && where === '/Invoices' ? xero400('Invoice # must be unique.') : null) });
  assert.equal(isNumberTaken('Xero API /Invoices failed: 400 {"Message":"Invoice # must be unique."}'), true);
  assert.equal(isNumberTaken('Credit Note # must be unique'), true);
  assert.equal(isNumberTaken("Account code '201' has been archived"), false);
  assert.equal(isNumberTaken(null), false);
});

// ── 29: the Back Office screens ──────────────────────────────────────────────

test('29. Back Office: what the preview and the Postings history say about refunds, and when', () => {
  const fmt = (n) => `£${Number(n).toFixed(2)}`;
  const g = plainDay();
  const newDay = planView(plan(g));                      // refunds on the invoice
  const fellBack = planView(plan(cashShortDay()));       // refunds that cannot go on the invoice
  const oldDay = planView(creditNoteWay(g));             // a day started before 13 Oct 2026
  // The answer of an older xero-sales: no refundWay, and no refund flag on any line.
  const bare = (doc) => (doc ? { ...doc, lines: doc.lines.map((l) => ({ kind: l.kind, description: l.description, account: l.account, taxType: l.taxType, amount: l.amount, vat: l.vat, xeroVat: l.xeroVat })) } : null);
  const olderServer = { ...oldDay, invoice: bare(oldDay.invoice), creditNote: bare(oldDay.creditNote) };
  delete olderServer.refundWay; delete olderServer.refundWayReason;

  // A new day: one note under the invoice, the payments titled as takings less refunds, no credit note.
  const w = previewWords(newDay, { tw: 'VAT', fmt });
  assert.equal(w.asLines, true);
  assert.deepEqual([newDay.totals.sales, newDay.totals.refunds, newDay.totals.vat], [28.01, 3.8, 3.75]);
  assert.equal(w.note, 'Refunds are the minus lines at the end. Sales £28.01 less refunds £3.80 makes the invoice total.');
  assert.equal(w.paymentsTitle, 'Payments on the invoice, takings less refunds (it shows as Paid)');
  assert.equal(w.creditNote, null);
  assert.deepEqual(w.refundPayments, []);
  assert.equal(w.refundTieTitle, 'VAT per rate on the refund lines');
  assert.deepEqual(newDay.invoice.lines.map(w.tagFor), ['Sales', 'Sales', 'Discount', 'Discount', 'Discount', 'Sales', 'Tips', 'Service', 'Refund']);
  assert.equal(previewWords(newDay, { tw: 'Tax', fmt }).refundTieTitle, 'Tax per rate on the refund lines');
  assert.equal(previewWords(newDay).note, 'Refunds are the minus lines at the end. Sales 28.01 less refunds 3.80 makes the invoice total.');
  // A refunded tip, service charge and gift card are tagged Refund too, and only they are.
  for (const f of [tipsDay, serviceDay, giftDay, loyaltyDay]) {
    const v = planView(plan(f()));
    assert.deepEqual(v.invoice.lines.map((l) => previewWords(v).tagFor(l) === 'Refund'), v.invoice.lines.map((l) => l.description.startsWith('Refund: ')));
  }
  assert.deepEqual(['sales', 'discount', 'gift', 'tip', 'service', 'new_kind', undefined].map((kind) => w.tagFor({ kind })), ['Sales', 'Discount', 'Gift cards', 'Tips', 'Service', 'new_kind', '']);
  assert.equal(w.tagFor({ kind: 'gift', refund: true }), 'Refund');

  // A day that fell back, a day posted before this, and an older server's answer: exactly as
  // before. The credit note and its refund payments show, and nothing speaks of minus lines.
  for (const [name, v] of Object.entries({ fellBack, oldDay, olderServer })) {
    const o = previewWords(v, { tw: 'VAT', fmt });
    assert.equal(o.asLines, false, name);
    assert.equal(o.note, '', name);
    assert.equal(o.paymentsTitle, 'Payments on the invoice (it shows as Paid)', name);
    assert.ok(o.creditNote && o.creditNote === v.creditNote, `${name}: the credit note shows`);
    assert.equal(o.creditNote.number, 'SOS-LEEDS-20260929-R', name);
    assert.ok(o.refundPayments.length === 1 && o.refundPayments === v.refundPayments, `${name}: its refund payment shows`);
    assert.equal(o.refundTieTitle, 'VAT per rate on refunds', name);
    assert.ok([...v.invoice.lines, ...v.creditNote.lines].every((l) => o.tagFor(l) !== 'Refund'), `${name}: no line is tagged Refund`);
    assert.deepEqual(v.creditNote.lines.map(o.tagFor), v.creditNote.lines.map(() => 'Sales'), name);
  }
  assert.equal(previewWords(olderServer, { tw: 'Tax' }).refundTieTitle, 'Tax per rate on refunds');
  // No refunds, no invoice, nothing at all.
  const quiet = previewWords(planView(plan(grouped(saleRows()))), { fmt });
  assert.deepEqual([quiet.asLines, quiet.note, quiet.paymentsTitle, quiet.creditNote, quiet.refundPayments], [false, '', 'Payments on the invoice (it shows as Paid)', null, []]);
  const noInvoice = planView(plan(noSalesDay(), { started: 'lines' }));
  assert.deepEqual([noInvoice.refundWay, noInvoice.invoice], ['lines', null]);
  assert.equal(previewWords(noInvoice, { fmt }).note, '', 'no invoice on the screen, so no note about its lines');
  assert.deepEqual([previewWords(null).asLines, previewWords(null).note, previewWords(undefined).creditNote, previewWords({}).refundPayments], [false, '', null, []]);

  // The Postings history, an opened day: the note only once the invoice with the lines IS in Xero.
  const NOTE = 'Refunds are on the invoice as minus lines.';
  const day = (refundWay, postings) => ({ refundWay, postings });
  assert.equal(historyRefundNote(day('lines', { INVOICE: { status: 'posted' }, 'PAY:CARDCLR': { status: 'posted' } })), NOTE);
  assert.equal(historyRefundNote(day('lines', { INVOICE: { status: 'posted' }, 'PAY:CARDCLR': { status: 'sending' } })), NOTE, 'partly posted, the invoice is in Xero');
  assert.equal(historyRefundNote(day('lines', { INVOICE: { status: 'sending' } })), '', 'refused by Xero, or the answer lost');
  assert.equal(historyRefundNote(day('lines', {})), '', 'blocked before anything was sent');
  assert.equal(historyRefundNote(day('lines', null)), '');
  assert.equal(historyRefundNote(day('credit_note', { INVOICE: { status: 'posted' }, CREDIT: { status: 'posted' } })), '', 'a day that fell back');
  assert.equal(historyRefundNote(day(null, { INVOICE: { status: 'posted' }, CREDIT: { status: 'posted' } })), '', 'a day posted before 13 Oct 2026');
  assert.equal(historyRefundNote({ postings: { INVOICE: { status: 'posted' } } }), '', 'an older server sends no refundWay');
  assert.equal(historyRefundNote(null), '');
  assert.doesNotMatch(NOTE + w.note + w.paymentsTitle + w.refundTieTitle, DASH);
});
