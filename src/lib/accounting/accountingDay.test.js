/**
 * accountingDay.test.js — the neutral daily accounting aggregator (Xero now, QuickBooks
 * next) and the Xero posting plan built on it.
 * Run: `npm test`, or `node --test src/lib/accounting/accountingDay.test.js`.
 *
 * Pinned:
 *   1. Sales sit on the business day the check CLOSED in; a UK after-midnight sale is the
 *      night before, a sale after the day's end is the next day.
 *   2. Split bills: closed_checks.tenders posts card and cash separately, service and tax
 *      split across them to the penny. Older rows fall back to their method; an older
 *      split becomes one Unallocated tender, flagged. The online "gift_card:10.00,card:18.00"
 *      list and the till's "gift_card+card" are read from what the row itself proves.
 *   3. Loyalty and promo credit are discounts: never money, never posted as takings.
 *   4. Refunds sit on the day of the REFUND (refunds[].timestamp), split into goods, tax,
 *      tip and service, placed on the tender the money went back to; failed refunds are
 *      not money; a full refund gives the gift card back first.
 *   5. Cancelled (voided) checks are left out.
 *   6. The Xero plan: one Receive Money per clearing account for takings, one Spend Money
 *      for refunds; tips never revenue (Tips Payable by default); gift card, deposits and
 *      unallocated have their own clearing accounts; a method with no mapping is flagged.
 *   7. VAT per rate (28 Sep 2026): given the venue's tax rates, every figure splits by rate
 *      (closed_checks.tax_breakdown, else implied from the booked tax), to the penny; the
 *      plan posts one goods line per Xero sales rate inside the SAME transaction (keys and
 *      references unchanged), never an expense rate, never 20% on zero rated goods; a rate
 *      with no Xero match blocks the day; service charge is No VAT unless opted in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { businessDayWindow } from '../../../supabase/functions/_shared/businessDay.js';
import {
  buildAccountingDay, checkTenders, checkTenderParts, refundParts, allocate, toMinor,
  canonicalMethod, tenderKind, isVoidedCheck, checkTaxMinor, taxContext, checkRateWeights, splitByRate,
} from '../../../supabase/functions/_shared/accountingDay.js';
import {
  planXeroDay, requiredDefaults, accountRef, DEFAULT_ACCOUNTS, KIND_ACCOUNT, shortHash,
  postingStep, idempotencyKey, postingVat, blockedMessage, sampleSaleRows, SAMPLE_TAX_NOTES,
} from '../../../supabase/functions/_shared/xeroPostingPlan.js';
import { revenueTaxRates, healedTaxType } from '../../../supabase/functions/_shared/xeroTax.js';
import { sharedDepsOf } from '../../../scripts/edgeFnDeps.mjs';

const UK = { timezone: 'Europe/London', dayStart: '06:00' };
const DAY = businessDayWindow('2026-09-18', UK.timezone, UK.dayStart);   // 05:00Z 18th .. 05:00Z 19th
const day = (saleRows, refundRows = []) => buildAccountingDay({ day: DAY, saleRows, refundRows, venue: UK });
const byMethod = (list, m) => list.find((r) => r.method === m);
const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);

test('allocate: proportional, whole pennies, adds up exactly', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(1000, [2000, 1000]), [667, 333]);
  assert.deepEqual(allocate(5, [0, 0]), [5, 0]);
  assert.deepEqual(allocate(0, [3, 4]), [0, 0]);
  assert.deepEqual(allocate(-100, [1, 3]), [-25, -75]);
  for (let t = 0; t < 500; t += 7) assert.equal(allocate(t, [3, 5, 11, 0.5]).reduce((a, b) => a + b, 0), t);
  assert.equal(toMinor('0.29'), 29);
  assert.equal(toMinor(12.345), 1235);
  assert.equal(toMinor(null), 0);
});

test('methods fold to one spelling and a kind', () => {
  assert.equal(canonicalMethod(' Gift Card '), 'gift_card');
  assert.equal(canonicalMethod('gift'), 'gift_card');
  assert.equal(tenderKind('card'), 'card');
  assert.equal(tenderKind('card-external'), 'card');
  assert.equal(tenderKind('cash'), 'cash');
  assert.equal(tenderKind('gift_card'), 'gift_card');
  assert.equal(tenderKind('booking_deposit'), 'deposit');
  assert.equal(tenderKind('booking_prepaid'), 'deposit');
  assert.equal(tenderKind('split'), 'unallocated');
  assert.equal(tenderKind('loyalty'), 'discount');
  assert.equal(tenderKind('promo'), 'discount');
  assert.equal(tenderKind('deliveroo'), 'other');
});

test('sales sit on the business day the check closed in', () => {
  const rows = [
    { id: 'fri-eve', closed_at: '2026-09-18T20:00:00Z', total: 10, tip: 0, method: 'card' },
    { id: 'after-midnight', closed_at: '2026-09-19T00:40:00Z', total: 20, tip: 0, method: 'card' },   // 01:40 BST Sat
    { id: 'sat-morning', closed_at: '2026-09-19T05:00:00Z', total: 40, tip: 0, method: 'card' },      // 06:00 BST Sat
    { id: 'fri-early', closed_at: '2026-09-18T04:59:00Z', total: 80, tip: 0, method: 'card' },        // 05:59 BST Fri: Thursday
  ];
  const s = day(rows);
  assert.equal(s.sales.totals.gross, 3000);
  assert.equal(s.sales.totals.count, 2);
  assert.equal(s.fromIso, '2026-09-18T05:00:00.000Z');
});

test('a split bill: card and cash post separately, service and tax split to the penny', () => {
  const row = {
    id: 'split', closed_at: '2026-09-18T19:00:00Z', method: 'split',
    subtotal: 25, tax_amount: 5, service: 3, tip: 3, total: 33,
    tenders: [{ method: 'card', amount: 20, tip: 3, psp_ref: 'PSP1', processor: 'adyen' }, { method: 'cash', amount: 10, tip: 0 }],
  };
  const { parts, legacy } = checkTenderParts(row);
  assert.equal(legacy, false);
  const card = parts.find((p) => p.method === 'card'), cash = parts.find((p) => p.method === 'cash');
  assert.deepEqual([card.gross, card.tip, card.service, card.tax, card.sales], [2300, 300, 200, 333, 1800]);
  assert.deepEqual([cash.gross, cash.tip, cash.service, cash.tax, cash.sales], [1000, 0, 100, 167, 900]);
  assert.equal(card.service + cash.service, 300);
  assert.equal(card.tax + cash.tax, 500);
  assert.equal(card.gross + cash.gross, 3300);
  const s = day([row]);
  assert.equal(byMethod(s.sales.byMethod, 'card').processor, 'adyen');
  assert.equal(s.warnings.length, 0);
});

test('older rows: the method column; an older split is ONE unallocated tender, flagged', () => {
  const plain = checkTenders({ id: 'a', total: 12.5, tip: 1.5, method: 'cash' });
  assert.equal(plain.legacy, true);
  assert.deepEqual(plain.tenders.map((t) => [t.method, t.amount, t.tip]), [['cash', 1100, 150]]);
  const split = checkTenders({ id: 'b', total: 30, tip: 2, method: 'split' });
  assert.deepEqual(split.tenders.map((t) => [t.method, t.kind, t.amount, t.tip]), [['unallocated', 'unallocated', 2800, 200]]);
  assert.deepEqual(split.flags, ['legacy_split_unallocated']);
  // payment_method wins over method, as the old aggregator read it
  assert.equal(checkTenders({ total: 5, payment_method: 'card-external', method: 'card' }).tenders[0].method, 'card_external');
  const s = day([{ id: 'b', closed_at: '2026-09-18T12:00:00Z', total: 30, tip: 2, method: 'split' }]);
  assert.equal(s.warnings[0].code, 'legacy_split_unallocated');
  assert.deepEqual(s.warnings[0].checkIds, ['b']);
});

test("older rows: the online card path's own list is read as written, tip on the card", () => {
  const t = checkTenders({ total: 19, tip: 1, method: 'split', payment_method: 'gift_card:10.00,loyalty:2.00,card:19.00' }).tenders;
  assert.deepEqual(t.map((x) => [x.method, x.kind, x.amount, x.tip]), [
    ['gift_card', 'gift_card', 1000, 0], ['loyalty', 'discount', 200, 0], ['card', 'card', 1800, 100],
  ]);
});

test("older rows: the till's composite methods", () => {
  // gift card sized from the row's own gift_card record (as debited, minor units)
  const g = checkTenders({ total: 30, tip: 2, method: 'gift_card+card', gift_card: { card_id: 'G', applied: 1000 } }).tenders;
  assert.deepEqual(g.map((x) => [x.method, x.amount, x.tip]), [['gift_card', 1000, 0], ['card', 1800, 200]]);
  // a failed gift commit took nothing
  const gf = checkTenders({ total: 30, tip: 0, method: 'gift_card+card', gift_card: { card_id: 'G', applied: 0, commit_error: 'x' } }).tenders;
  assert.deepEqual(gf.map((x) => [x.method, x.amount]), [['card', 3000]]);
  // booking credit from payment_intents
  const b = checkTenders({ total: 50, tip: 0, method: 'booking+cash', payment_intents: [{ id: null, amountMinor: 2000, method: 'booking_deposit' }] }).tenders;
  assert.deepEqual(b.map((x) => [x.method, x.kind, x.amount]), [['booking_deposit', 'deposit', 2000], ['cash', 'cash', 3000]]);
  const bo = checkTenders({ total: 40, tip: 0, method: 'booking_prepaid+booking_deposit', payment_intents: [{ amountMinor: 3000, method: 'booking_prepaid' }, { amountMinor: 1000, method: 'booking_deposit' }] }).tenders;
  assert.deepEqual(bo.map((x) => [x.method, x.amount]), [['booking_prepaid', 3000], ['booking_deposit', 1000]]);
  // a loyalty or promo credit was never stored on the row: cannot be split, unallocated
  const l = checkTenders({ id: 'l', total: 30, tip: 0, method: 'promo+loyalty+gift_card+card' });
  assert.deepEqual(l.tenders.map((x) => x.method), ['unallocated']);
  assert.deepEqual(l.flags, ['legacy_mixed_unallocated']);
  assert.deepEqual(checkTenders({ total: 30, method: 'gift_card+split' }).tenders.map((x) => x.method), ['unallocated']);
});

test('kiosk rows (no tenders: the kiosk card path is guarded) are read exactly from their own fields', () => {
  // KioskApp: total = the CARD amount, tip included, net of gift + loyalty + promo credit
  const row = {
    source: 'kiosk', method: 'split', payment_method: 'split', total: 14, tip: 1,
    gift_card: { card_id: 'G', applied: 1000 }, loyalty: { reward_id: 'R', discount_value: 250 }, promo: { code: 'X', discount_value: 1.5 },
  };
  const { tenders, flags } = checkTenders(row);
  assert.deepEqual(tenders.map((t) => [t.method, t.kind, t.amount, t.tip]), [
    ['gift_card', 'gift_card', 1000, 0], ['loyalty', 'discount', 250, 0], ['promo', 'discount', 150, 0], ['card', 'card', 1300, 100],
  ]);
  assert.deepEqual(flags, []);
  // a plain kiosk card sale ('card-external') is one card tender
  assert.deepEqual(checkTenders({ source: 'kiosk', method: 'card', payment_method: 'card-external', total: 9.5, tip: 0.5 }).tenders.map((t) => [t.method, t.amount, t.tip]), [['card', 900, 50]]);
  // gift card covered everything: no card leg
  assert.deepEqual(checkTenders({ source: 'kiosk', method: 'split', total: 0, tip: 0, gift_card: { applied: 800 } }).tenders.map((t) => t.method), ['gift_card']);
});

test('online gift card or reward only rows (no card charged) are read from their own fields', () => {
  const t = checkTenders({ source: 'online', method: 'split', total: 0, tip: 0, gift_card: { applied: 1200 }, loyalty: { discount_value: 300 } }).tenders;
  assert.deepEqual(t.map((x) => [x.method, x.amount]), [['gift_card', 1200], ['loyalty', 300]]);
  // the card path always wrote its own list, which wins
  const c = checkTenders({ source: 'online', method: 'split', payment_method: 'gift_card:5.00,card:10.00', total: 10, tip: 0, gift_card: { applied: 500 } }).tenders;
  assert.deepEqual(c.map((x) => [x.method, x.amount]), [['gift_card', 500], ['card', 1000]]);
});

test('loyalty and promo credit are discounts: in the summary as credits, never money', () => {
  const s = day([{
    id: 'k', closed_at: '2026-09-18T12:00:00Z', total: 23, tip: 1, service: 0, tax_amount: 5, method: 'split',
    tenders: [{ method: 'gift_card', amount: 5, tip: 0, gift_card_id: 'G' }, { method: 'loyalty', amount: 2, tip: 0 }, { method: 'card', amount: 22, tip: 1 }],
  }]);
  assert.equal(s.sales.totals.gross, 2800);     // card 23 + gift 5; the loyalty 2 is not money
  assert.equal(s.sales.credits.gross, 200);
  assert.equal(byMethod(s.sales.byMethod, 'loyalty').kind, 'discount');
  const plan = planXeroDay(s, { detail: { cardClearingId: 'CARD', giftClearingId: 'GIFT', contactId: 'C', tipsAccountCode: 'SOSTIPS' } });
  assert.deepEqual(plan.transactions.map((t) => t.key), ['RECEIVE:CARD', 'RECEIVE:GIFT']);
  assert.ok(!plan.transactions.some((t) => t.methods.includes('loyalty')));
});

test('tenders that fall short of the total are flagged; tenders above a net total are not', () => {
  // till gross total 30, gift came up short: only 25 was taken
  const short = checkTenders({ total: 30, tip: 0, tenders: [{ method: 'gift_card', amount: 5 }, { method: 'card', amount: 20 }] });
  assert.deepEqual(short.flags, ['tenders_short_of_total']);
  // kiosk: total is the card amount (net of the gift card), tenders list both
  const kiosk = checkTenders({ total: 20, tip: 0, tenders: [{ method: 'gift_card', amount: 10 }, { method: 'card', amount: 20 }] });
  assert.deepEqual(kiosk.flags, []);
});

test('a tip captured after the close (tip on receipt) lands on the card tender', () => {
  // tip_capture raised tip 0 -> 3 and total 20 -> 23; the tenders were written at close
  const t = checkTenders({ total: 23, tip: 3, tenders: [{ method: 'card', amount: 20, tip: 0, psp_ref: 'P' }] }).tenders;
  assert.deepEqual(t.map((x) => [x.amount, x.tip]), [[2000, 300]]);
  // a tip a gift card covered is not moved onto the card (tenders already reach the total)
  const g = checkTenders({ total: 18, tip: 3, tenders: [{ method: 'gift_card', amount: 11 }, { method: 'card', amount: 17, tip: 1 }] }).tenders;
  assert.deepEqual(g.map((x) => [x.method, x.tip]), [['gift_card', 0], ['card', 100]]);
});

test('cancelled (voided) checks are left out, and say so', () => {
  assert.equal(isVoidedCheck({ status: 'voided' }), true);
  assert.equal(isVoidedCheck({ voided: true }), true);
  assert.equal(isVoidedCheck({ status: 'refunded' }), false);
  const s = day([
    { id: 'v', closed_at: '2026-09-18T12:00:00Z', total: 50, tip: 0, method: 'card', status: 'voided' },
    { id: 'ok', closed_at: '2026-09-18T12:00:00Z', total: 10, tip: 0, method: 'card' },
  ]);
  assert.equal(s.sales.totals.gross, 1000);
  assert.equal(s.warnings.find((w) => w.code === 'voided_checks').count, 1);
});

test('tax: stored tax_amount, else the INVARIANTS fallback', () => {
  assert.equal(checkTaxMinor({ tax_amount: 5.5 }), 550);
  assert.equal(checkTaxMinor({ tax_amount: null, total: 36, subtotal: 25, service: 3, tip: 3 }), 500);
  assert.equal(checkTaxMinor({ total: 10, subtotal: 12 }), 0);
});

// ── refunds ───────────────────────────────────────────────────────────────────

const card30 = {
  id: 'c30', closed_at: '2026-09-10T12:00:00Z', method: 'card', subtotal: 25, tax_amount: 5, service: 2, tip: 3, total: 35,
  tenders: [{ method: 'card', amount: 32, tip: 3, psp_ref: 'PSP', processor: 'adyen' }],
};

test('refunds sit on the day of the refund, not the day the check closed', () => {
  const entry = { id: 'r1', timestamp: Date.parse('2026-09-18T21:00:00Z'), amount: 11, tipAmount: 1, serviceAmount: 0.5, taxAmount: 1.5,
    tenderMethod: 'card', legs: [{ processor: 'adyen', amountMinor: 1100, status: 'succeeded' }], cardStatus: 'succeeded' };
  const row = { ...card30, refunds: [entry] };
  const s = day([], [row]);
  const r = byMethod(s.refunds.byMethod, 'card');
  assert.deepEqual([r.gross, r.tip, r.service, r.tax, r.sales], [1100, 100, 50, 150, 950]);
  assert.equal(r.processor, 'adyen');
  // the same row read for the day it closed: the sale, and no refund
  const closeDay = buildAccountingDay({ day: businessDayWindow('2026-09-10', UK.timezone, UK.dayStart), saleRows: [row], refundRows: [row], venue: UK });
  assert.equal(closeDay.sales.totals.gross, 3500);
  assert.equal(closeDay.refunds.totals.gross, 0);
  // an after-midnight refund (00:30 BST on the 19th) is still the 18th's
  const late = { ...card30, refunds: [{ ...entry, timestamp: Date.parse('2026-09-18T23:30:00Z') }] };
  assert.equal(day([], [late]).refunds.totals.gross, 1100);
});

test('a refund with no tip or service split (processor dashboard) is estimated from the check, flagged', () => {
  const r = refundParts({ id: 'ry', timestamp: 1, amount: 17.5, source: 'ryft_reconcile' }, card30);
  assert.deepEqual(r.flags, ['refund_split_estimated']);
  const p = r.parts[0];
  assert.equal(p.gross, 1750);
  assert.equal(p.tip, 150);       // half the check, half the tip
  assert.equal(p.service, 100);
  assert.equal(p.tax, 250);
  // an old item refund (items listed, no split) was the items: all goods
  const old = refundParts({ timestamp: 1, amount: 5, items: [{ name: 'x' }], tenderMethod: 'card' }, card30);
  assert.deepEqual([old.parts[0].tip, old.parts[0].service], [0, 0]);
});

test('failed refunds are not money; a partly failed one counts only what went back', () => {
  const failed = refundParts({ timestamp: 1, amount: 10, failed: true }, card30);
  assert.equal(failed.skipped, true);
  assert.deepEqual(failed.flags, ['refund_failed']);
  assert.equal(refundParts({ timestamp: 1, amount: 10, cardStatus: 'failed', legs: [{ amountMinor: 1000, status: 'failed' }] }, card30).skipped, true);
  const partial = refundParts({ timestamp: 1, amount: 20, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'partial',
    legs: [{ amountMinor: 1200, status: 'succeeded', processor: 'adyen' }, { amountMinor: 800, status: 'failed' }] }, card30);
  assert.equal(partial.amount, 1200);
  assert.deepEqual(partial.parts.map((p) => [p.method, p.gross]), [['card', 1200]]);
  assert.deepEqual(partial.flags, ['refund_partly_failed']);
  const s = day([], [{ ...card30, refunds: [{ timestamp: Date.parse('2026-09-18T12:00:00Z'), amount: 10, failed: true }] }]);
  assert.equal(s.refunds.totals.gross, 0);
  assert.equal(s.warnings[0].code, 'refund_failed');
});

test('cash refunds come out of the drawer; a split check refund goes back where the money came from', () => {
  const split = {
    id: 'sp', closed_at: '2026-09-10T12:00:00Z', method: 'split', subtotal: 30, service: 0, tax_amount: 5, tip: 0, total: 30,
    tenders: [{ method: 'card', amount: 20, tip: 0, psp_ref: 'P' }, { method: 'cash', amount: 10, tip: 0 }],
  };
  const cash = refundParts({ timestamp: 1, amount: 6, tipAmount: 0, serviceAmount: 0, tenderMethod: 'cash' }, split);
  assert.deepEqual(cash.parts.map((p) => [p.method, p.gross]), [['cash', 600]]);
  // full refund, card leg reversed for 20, the other 10 back as...the check's cash tender
  const full = refundParts({ timestamp: 1, amount: 30, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', isFullRefund: true,
    legs: [{ amountMinor: 2000, status: 'succeeded', processor: 'adyen' }] }, split);
  assert.deepEqual(full.parts.map((p) => [p.method, p.gross]), [['card', 2000], ['cash', 1000]]);
  assert.equal(sum(full.parts, 'tax'), 500);
});

test('a full refund puts the gift card and loyalty credit back before any card or cash', () => {
  const row = {
    id: 'g', closed_at: '2026-09-10T12:00:00Z', method: 'gift_card+card', subtotal: 30, service: 0, tax_amount: 5, tip: 2, total: 37,
    tenders: [{ method: 'gift_card', amount: 10, gift_card_id: 'G' }, { method: 'loyalty', amount: 5 }, { method: 'card', amount: 20, tip: 2, psp_ref: 'P' }],
  };
  const r = refundParts({ timestamp: 1, amount: 37, tipAmount: 2, serviceAmount: 0, taxAmount: 5, tenderMethod: 'card', isFullRefund: true,
    legs: [{ amountMinor: 2200, status: 'succeeded', processor: 'adyen' }] }, row);
  assert.deepEqual(r.parts.map((p) => [p.method, p.gross, p.tip]), [['card', 2200, 200], ['gift_card', 1000, 0], ['loyalty', 500, 0]]);
  const s = day([], [{ ...row, refunds: [{ timestamp: Date.parse('2026-09-18T12:00:00Z'), amount: 37, tipAmount: 2, serviceAmount: 0, taxAmount: 5, tenderMethod: 'card', isFullRefund: true, legs: [{ amountMinor: 2200, status: 'succeeded' }] }] }]);
  assert.equal(s.refunds.totals.gross, 3200);   // card + gift card; the loyalty 5 is a credit
  assert.equal(s.refunds.credits.gross, 500);
});

test('the Back Office refunds a cash-paid check with the card button: it is placed on the cash tender', () => {
  const cashRow = { id: 'c', closed_at: '2026-09-10T12:00:00Z', method: 'cash', total: 12, tip: 0, service: 0, tax_amount: 2 };
  const r = refundParts({ timestamp: 1, amount: 12, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', legs: [], cardStatus: 'none' }, cashRow);
  assert.deepEqual(r.parts.map((p) => [p.method, p.gross]), [['cash', 1200]]);
});

test('a refund on an older split check goes to Unallocated, flagged', () => {
  const old = { id: 'o', closed_at: '2026-09-10T12:00:00Z', method: 'split', total: 20, tip: 0 };
  const r = refundParts({ timestamp: 1, amount: 8, tenderMethod: 'card' }, old);
  assert.deepEqual(r.parts.map((p) => [p.method, p.gross]), [['unallocated', 800]]);
  assert.ok(r.flags.includes('refund_unallocated'));
});

test('a refund left pending (the till stopped mid refund) is not posted; a cash one is', () => {
  const r = refundParts({ timestamp: 1, amount: 10, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'pending', legs: [] }, card30);
  assert.equal(r.skipped, true);
  assert.deepEqual(r.flags, ['refund_pending']);
  const cash = refundParts({ timestamp: 1, amount: 10, tipAmount: 0, serviceAmount: 0, tenderMethod: 'cash', cardStatus: 'pending', legs: [] }, card30);
  assert.equal(cash.skipped, false);
  assert.deepEqual(cash.parts.map((p) => [p.method, p.gross]), [['cash', 1000]]);
});

test('a full refund whose card reversal failed still posts the gift card that went back', () => {
  const row = {
    id: 'gf', closed_at: '2026-09-10T12:00:00Z', method: 'gift_card+card', total: 30, tip: 0, service: 0, tax_amount: 5,
    tenders: [{ method: 'gift_card', amount: 10, gift_card_id: 'G' }, { method: 'card', amount: 20, psp_ref: 'P' }],
  };
  const r = refundParts({ timestamp: 1, amount: 30, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', isFullRefund: true, cardStatus: 'failed',
    legs: [{ amountMinor: 2000, status: 'failed', processor: 'adyen' }] }, row);
  assert.equal(r.skipped, false);
  assert.deepEqual(r.parts.map((p) => [p.method, p.gross]), [['gift_card', 1000]]);
  assert.deepEqual(r.flags, ['refund_partly_failed']);
  // all of it on a card that failed: nothing moved
  const none = refundParts({ timestamp: 1, amount: 20, tenderMethod: 'card', cardStatus: 'failed', legs: [{ amountMinor: 2000, status: 'failed' }] }, card30);
  assert.equal(none.skipped, true);
});

test('a full refund on a check whose total is net of credits (kiosk, online) posts the credit on top', () => {
  // kiosk: bill 30, gift card 20, card 10; total = 10 (the card), the refund amount is capped at it
  const row = {
    id: 'kg', source: 'kiosk', closed_at: '2026-09-10T12:00:00Z', method: 'split', total: 10, tip: 0, service: 0, tax_amount: 5,
    gift_card: { card_id: 'G', applied: 2000 },
  };
  const r = refundParts({ timestamp: 1, amount: 10, tipAmount: 0, serviceAmount: 0, taxAmount: 1.67, tenderMethod: 'card', isFullRefund: true,
    legs: [{ amountMinor: 1000, status: 'succeeded', processor: 'adyen' }] }, row);
  assert.deepEqual(r.parts.map((p) => [p.method, p.gross]), [['card', 1000], ['gift_card', 2000]]);
  assert.equal(r.amount, 3000);
  const gift = r.parts.find((p) => p.method === 'gift_card');
  assert.equal(gift.tax, 333);   // two thirds of the check's 5.00 VAT
  // the till (total = the whole bill): the gift card is inside the refund amount, not on top
  const till = { ...row, source: 'pos', total: 30, tenders: [{ method: 'gift_card', amount: 20 }, { method: 'card', amount: 10 }] };
  const t = refundParts({ timestamp: 1, amount: 30, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', isFullRefund: true,
    legs: [{ amountMinor: 1000, status: 'succeeded' }] }, till);
  assert.deepEqual(t.parts.map((p) => [p.method, p.gross]), [['card', 1000], ['gift_card', 2000]]);
  assert.equal(t.amount, 3000);
});

test('an older kiosk mapping (card-external) still applies to plain kiosk card sales', () => {
  const s = day([
    { id: 'k1', source: 'kiosk', closed_at: '2026-09-18T12:00:00Z', method: 'card', payment_method: 'card-external', total: 8, tip: 0 },
    { id: 't1', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 5, tip: 0, tenders: [{ method: 'card', amount: 5 }] },
  ]);
  const plan = planXeroDay(s, { detail: DETAIL, mapping: { paymentMap: { 'card-external': 'KIOSKBANK', card: 'TILLBANK' } } });
  const by = Object.fromEntries(plan.transactions.map((t) => [t.accountId, t.totals.gross]));
  assert.deepEqual(by, { KIOSKBANK: 800, TILLBANK: 500 });
});

test('two refunds on one check, one on the day and one not; duplicate rows count once', () => {
  const row = { ...card30, refunds: [
    { id: 'a', timestamp: Date.parse('2026-09-18T10:00:00Z'), amount: 5, tipAmount: 0, serviceAmount: 0, tenderMethod: 'cash' },
    { id: 'b', timestamp: Date.parse('2026-09-19T10:00:00Z'), amount: 7, tipAmount: 0, serviceAmount: 0, tenderMethod: 'cash' },
  ] };
  const s = day([], [row, row]);
  assert.equal(s.refunds.totals.gross, 500);
  assert.equal(s.refunds.totals.count, 1);
});

test('an empty day is empty; a day of refunds only is not', () => {
  assert.equal(day([]).empty, true);
  assert.equal(day([{ id: 'x', closed_at: '2026-09-18T12:00:00Z', total: 0, tip: 0, method: 'card' }]).empty, true);
  const refundOnly = day([], [{ ...card30, refunds: [{ timestamp: Date.parse('2026-09-18T12:00:00Z'), amount: 5, tipAmount: 0, serviceAmount: 0, tenderMethod: 'cash' }] }]);
  assert.equal(refundOnly.empty, false);
});

// ── the Xero plan ─────────────────────────────────────────────────────────────

const DETAIL = {
  contactId: 'CONTACT', salesAccountCode: '200', taxType: 'OUTPUT2',
  cardClearingId: 'CARD', cashClearingId: 'CASH', giftClearingId: 'GIFT', depositClearingId: 'DEP', unallocatedClearingId: 'UNALLOC',
  tipsAccountCode: 'SOSTIPS', serviceAccountCode: 'SOSSVCCHG',
};

test('Xero: takings per clearing account (Receive), refunds per account (Spend), lines add up', () => {
  const rows = [
    { id: 's1', closed_at: '2026-09-18T19:00:00Z', method: 'split', subtotal: 25, tax_amount: 5, service: 3, tip: 3, total: 33,
      tenders: [{ method: 'card', amount: 20, tip: 3 }, { method: 'cash', amount: 10, tip: 0 }] },
    { id: 's2', closed_at: '2026-09-18T12:00:00Z', method: 'split', total: 12, tip: 0 },
  ];
  const refund = { ...card30, refunds: [{ timestamp: Date.parse('2026-09-18T13:00:00Z'), amount: 11, tipAmount: 1, serviceAmount: 0, taxAmount: 1.5, tenderMethod: 'card',
    legs: [{ amountMinor: 1100, status: 'succeeded', processor: 'adyen' }] }] };
  const s = day(rows, [refund]);
  const { transactions, warnings } = planXeroDay(s, { detail: DETAIL });
  assert.deepEqual(transactions.map((t) => t.key), ['RECEIVE:CARD', 'RECEIVE:CASH', 'RECEIVE:UNALLOC', 'SPEND:CARD']);
  for (const tx of transactions) {
    const lines = tx.payload.LineItems.reduce((a, l) => a + Math.round(l.UnitAmount * 100), 0);
    assert.equal(lines, tx.totals.gross, tx.key);
    assert.equal(tx.payload.LineAmountTypes, 'Inclusive');
    assert.equal(tx.payload.Type, tx.direction);
    assert.equal(tx.payload.BankAccount.AccountID, tx.accountId);
    assert.equal(tx.payload.Contact.ContactID, 'CONTACT');
  }
  const card = transactions[0].payload.LineItems;
  // 28 Sep 2026: service charge is No VAT unless the operator opts in (ServOS books no VAT on it).
  assert.deepEqual(card.map((l) => [l.UnitAmount, l.AccountCode, l.TaxType]), [[18, '200', 'OUTPUT2'], [3, 'SOSTIPS', 'NONE'], [2, 'SOSSVCCHG', 'NONE']]);
  const spend = transactions[3].payload.LineItems;
  assert.deepEqual(spend.map((l) => [l.UnitAmount, l.AccountCode]), [[10, '200'], [1, 'SOSTIPS']]);
  assert.ok(spend[0].Description.startsWith('Refunded sales 2026-09-18'));
  assert.deepEqual(warnings.map((w) => w.code), ['tips_unmapped', 'service_unmapped']);
});

test('Xero: the operator mapping wins; a mapped id or code both work; tips never go to revenue by default', () => {
  const s = day([{ id: 'x', closed_at: '2026-09-18T12:00:00Z', total: 11, tip: 1, service: 0, method: 'card' }]);
  const plan = planXeroDay(s, { detail: DETAIL, mapping: {
    paymentMap: { card: 'MYBANK' }, revenueAccount: '4000', tipsAccount: '2100', taxDefault: 'NONE',
  } });
  const tx = plan.transactions[0];
  assert.equal(tx.accountId, 'MYBANK');
  assert.deepEqual(tx.payload.LineItems.map((l) => [l.AccountCode, l.UnitAmount]), [['4000', 10], ['2100', 1]]);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(accountRef('4000'), { AccountCode: '4000' });
  assert.deepEqual(accountRef('0b5a3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'), { AccountID: '0b5a3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' });
  // An older mapping keyed by the method exactly as the till wrote it still applies.
  const legacy = day([{ id: 'y', closed_at: '2026-09-18T12:00:00Z', total: 5, tip: 0, method: 'Card' }]);
  assert.equal(planXeroDay(legacy, { detail: DETAIL, mapping: { paymentMap: { Card: 'OLDMAP' } } }).transactions[0].accountId, 'OLDMAP');
});

test('Xero: default clearing accounts per kind; an unknown method defaults to card clearing and is flagged', () => {
  assert.equal(KIND_ACCOUNT.gift_card, 'giftClearing');
  assert.equal(KIND_ACCOUNT.deposit, 'depositClearing');
  assert.equal(KIND_ACCOUNT.unallocated, 'unallocatedClearing');
  const s = day([{ id: 'd', closed_at: '2026-09-18T12:00:00Z', total: 25, tip: 0, method: 'card', tenders: [{ method: 'deliveroo', amount: 25 }] }]);
  const plan = planXeroDay(s, { detail: DETAIL });
  assert.equal(plan.transactions[0].accountId, 'CARD');
  assert.equal(plan.warnings[0].code, 'method_defaulted');
  assert.deepEqual(plan.warnings[0].methods, ['deliveroo']);
  assert.deepEqual(requiredDefaults(s, {}), ['cardClearing']);
});

test('Xero: only the default accounts the day needs are provisioned', () => {
  const s = day([
    { id: 'a', closed_at: '2026-09-18T12:00:00Z', total: 11, tip: 1, service: 0, method: 'cash' },
    { id: 'b', closed_at: '2026-09-18T12:00:00Z', total: 5, tip: 0, method: 'x', tenders: [{ method: 'gift_card', amount: 5 }] },
  ]);
  assert.deepEqual(requiredDefaults(s, {}).sort(), ['cashClearing', 'giftClearing', 'tipsPayable']);
  assert.deepEqual(requiredDefaults(s, { tipsAccount: '2100', paymentMap: { cash: 'B' } }), ['giftClearing']);
  for (const k of Object.keys(DEFAULT_ACCOUNTS)) assert.ok(DEFAULT_ACCOUNTS[k].code.length <= 10, `${k} code fits Xero`);
});

test('Xero: references are stable across retries and a changed payload gets a new idempotency hash', () => {
  const s = day([{ id: 'a', closed_at: '2026-09-18T12:00:00Z', total: 10, tip: 0, method: 'card' }]);
  const a = planXeroDay(s, { detail: DETAIL }).transactions[0];
  const b = planXeroDay(day([{ id: 'a', closed_at: '2026-09-18T12:00:00Z', total: 10, tip: 0, method: 'card' }, { id: 'b', closed_at: '2026-09-18T13:00:00Z', total: 4, tip: 0, method: 'card' }]), { detail: DETAIL }).transactions[0];
  assert.equal(a.reference, 'ServOS takings 2026-09-18 (CARD)');
  assert.equal(a.reference, b.reference);
  assert.notEqual(shortHash(JSON.stringify(a.payload)), shortHash(JSON.stringify(b.payload)));
  assert.equal(shortHash('x'), shortHash('x'));
});

test('Xero: odd data (tips and service at or above the money) posts one line for the whole amount', () => {
  const s = day([{ id: 'o', closed_at: '2026-09-18T12:00:00Z', total: 5, tip: 5, service: 0, method: 'card', tenders: [{ method: 'card', amount: 0, tip: 5 }] }]);
  const tx = planXeroDay(s, { detail: DETAIL }).transactions[0];
  assert.equal(tx.payload.LineItems.length, 1);
  assert.equal(tx.payload.LineItems[0].UnitAmount, 5);
});

// ── VAT per rate (28 Sep 2026) ───────────────────────────────────────────────

// Leeds's own rates; Train Station's Standard id is what some Leeds checks booked (25-27 Sep).
const STD = '6368f6fb-5c1e-4a7e-9d0e-3f1f4b2a0001';
const RED = '8b2c1d3e-5c1e-4a7e-9d0e-3f1f4b2a0002';
const ZERO = '9c3d2e4f-5c1e-4a7e-9d0e-3f1f4b2a0003';
const TRAIN_STD = '6a159b5e-7d2f-4c1a-8e3b-5a6b7c8d0004';
const GONE = 'deadbeef-0000-4000-8000-000000000005';   // a rate TaxManager hard deleted
const RATES = [
  { id: STD, name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true },
  { id: RED, name: 'Reduced Rate', code: 'VAT5', rate: 0.05, type: 'inclusive', is_default: false, active: true },
  { id: ZERO, name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true },
];
const K = (id) => `rate:${id}`;
const rday = (saleRows, refundRows = [], taxRates = RATES, d = DAY) => buildAccountingDay({ day: d, saleRows, refundRows, venue: UK, taxRates });
// A till's tax_breakdown record: entries [rateId, rate, gross, tax] in major units.
const breakdown = (entries, extra = {}) => ({
  subtotal: entries.reduce((s, e) => s + e[2] - e[3], 0),
  totalTax: entries.reduce((s, e) => s + e[3], 0),
  total: entries.reduce((s, e) => s + e[2], 0),
  exclusiveTax: 0, hasExclusiveTax: false, source: 'legacy',
  breakdown: entries.map(([id, rate, gross, tax]) => ({ rate: { id, name: 'r', rate, type: 'inclusive' }, tax, net: gross - tax, gross, items: 1 })),
  ...extra,
});
const sumRates = (byRate, k) => Object.values(byRate || {}).reduce((s, v) => s + v[k], 0);

// Xero's /TaxRates for a UK org, as its own example sends it (string flags), INPUT2 FIRST.
const xr = (TaxType, Name, rate, revenue, expense, extra = {}) => ({
  Name, TaxType, Status: 'ACTIVE', CanApplyToAssets: 'true', CanApplyToEquity: 'true', CanApplyToExpenses: String(expense),
  CanApplyToLiabilities: 'true', CanApplyToRevenue: String(revenue), DisplayTaxRate: rate.toFixed(4), EffectiveRate: rate.toFixed(4), ...extra,
});
const UK_TAX_RATES = [
  xr('INPUT2', '20% (VAT on Expenses)', 20, false, true),
  xr('OUTPUT2', '20% (VAT on Income)', 20, true, false),
  xr('RRINPUT', '5% (VAT on Expenses)', 5, false, true),
  xr('RROUTPUT', '5% (VAT on Income)', 5, true, false),
  xr('ZERORATEDINPUT', 'Zero Rated Expenses', 0, false, true),
  xr('ZERORATEDOUTPUT', 'Zero Rated Income', 0, true, false),
  xr('EXEMPTOUTPUT', 'Exempt Income', 0, true, false),
  xr('NONE', 'No VAT', 0, true, true),
];
const UK_DETAIL = { ...DETAIL, salesTaxRates: revenueTaxRates(UK_TAX_RATES) };

// A 30.00 bill: 24.00 at 20% (VAT 4.00) and 6.00 zero rated, paid 20 card and 10 cash.
const mixed = {
  id: 'mix', closed_at: '2026-09-18T19:00:00Z', method: 'split', subtotal: 26, tax_amount: 4, service: 0, tip: 0, total: 30,
  tax_breakdown: breakdown([[STD, 0.2, 24, 4], [ZERO, 0, 6, 0]]),
  tenders: [{ method: 'card', amount: 20, tip: 0 }, { method: 'cash', amount: 10, tip: 0 }],
};

test('per-rate: a 20% + 0% check split card and cash adds up per tender and per rate, 0% tax is 0', () => {
  const { parts, buckets, rateSource } = checkTenderParts(mixed, taxContext(RATES));
  assert.equal(rateSource, 'breakdown');
  assert.deepEqual(buckets.map((b) => b.key), [K(STD), K(ZERO)]);
  const card = parts.find((p) => p.method === 'card'), cash = parts.find((p) => p.method === 'cash');
  assert.deepEqual(card.byRate, { [K(STD)]: { sales: 1600, tax: 267 }, [K(ZERO)]: { sales: 400, tax: 0 } });
  assert.deepEqual(cash.byRate, { [K(STD)]: { sales: 800, tax: 133 }, [K(ZERO)]: { sales: 200, tax: 0 } });
  for (const p of parts) {
    assert.equal(sumRates(p.byRate, 'sales'), p.sales);
    assert.equal(sumRates(p.byRate, 'tax'), p.tax);
  }
  const s = rday([mixed]);
  assert.deepEqual(s.sales.totals.byRate, { [K(STD)]: { sales: 2400, tax: 400 }, [K(ZERO)]: { sales: 600, tax: 0 } });
  assert.deepEqual(byMethod(s.sales.byMethod, 'cash').byRate, cash.byRate);
  assert.deepEqual(s.taxBuckets.map((b) => [b.key, b.pct, b.name]), [[K(STD), 20, 'Standard Rate'], [K(ZERO), 0, 'Zero Rate']]);
  assert.equal(s.defaultTaxBucket.key, K(STD));
  assert.deepEqual(s.warnings, []);
});

test('per-rate: a foreign or deleted rate id folds onto the venue rate with the same percentage', () => {
  const row = (id, entries, total) => ({ id, closed_at: '2026-09-18T12:00:00Z', method: 'card', total, tip: 0, service: 0,
    tax_amount: entries.reduce((s, e) => s + e[3], 0), tax_breakdown: breakdown(entries) });
  const s = rday([
    row('train', [[TRAIN_STD, 0.2, 12, 2]], 12),       // Train Station's id at 20%: Leeds's Standard
    row('edited', [[RED, 0.2, 6, 1]], 6),              // Reduced's id, but booked at 20% before an edit: not Reduced
    row('gone', [[GONE, 0.125, 11.25, 1.25]], 11.25),  // a deleted rate at a % Leeds has none of
  ]);
  assert.deepEqual(s.sales.totals.byRate, { [K(STD)]: { sales: 1800, tax: 300 }, 'pct:12.5': { sales: 1125, tax: 125 } });
  assert.deepEqual(s.taxBuckets.map((b) => [b.key, b.pct]), [[K(STD), 20], ['pct:12.5', 12.5]]);   // highest % first
  // the weights themselves: 0.08875 is 8.875%, never rounded to a whole percent
  const w = checkRateWeights({ tax_breakdown: breakdown([[GONE, 0.08875, 10.8875, 0.8875]]) }, taxContext([]), 1089, 89);
  assert.equal(w.weights[0].bucket.key, 'pct:8.875');
});

test('per-rate: goods with no rate land in none', () => {
  // 8.00 of goods at 20%; a 2.00 item with no rate (no default, unknown SKU) is in no entry
  const row = { id: 'n', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 10, tip: 0, tax_amount: 1.33,
    tax_breakdown: breakdown([[STD, 0.2, 8, 1.3333]], { total: 10 }) };
  const s = rday([row]);
  assert.deepEqual(s.sales.totals.byRate, { [K(STD)]: { sales: 800, tax: 133 }, none: { sales: 200, tax: 0 } });
  assert.equal(s.taxBuckets.at(-1).key, 'none');
});

test('per-rate: a scaled record (share) splits by proportion; a 100% comp splits nothing', () => {
  // half price bill: every rate scaled by 0.5 (taxShare.scaleTaxRecord)
  const half = { id: 'h', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 15, tip: 0, tax_amount: 2,
    tax_breakdown: breakdown([[STD, 0.2, 12, 2], [ZERO, 0, 3, 0]], { share: 0.5 }) };
  assert.deepEqual(rday([half]).sales.totals.byRate, { [K(STD)]: { sales: 1200, tax: 200 }, [K(ZERO)]: { sales: 300, tax: 0 } });
  const comp = { id: 'c', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 0, tip: 0, tax_amount: 0,
    tax_breakdown: breakdown([[STD, 0.2, 0, 0], [ZERO, 0, 0, 0]], { share: 0 }) };
  const s = rday([comp]);
  assert.deepEqual(s.sales.totals.byRate, {});
  assert.deepEqual(s.warnings, []);
});

test('per-rate: no breakdown implies tax at the default rate, rest zero rated, flagged', () => {
  const kiosk = (id, total, tax) => ({ id, source: 'kiosk', closed_at: '2026-09-18T12:00:00Z', method: 'card', payment_method: 'card-external', total, tip: 0, tax_amount: tax });
  const a = rday([kiosk('k1', 15, 2)]);
  assert.deepEqual(a.sales.totals.byRate, { [K(STD)]: { sales: 1200, tax: 200 }, [K(ZERO)]: { sales: 300, tax: 0 } });
  assert.deepEqual(a.warnings.map((w) => [w.code, w.checkIds]), [['tax_split_estimated', ['k1']]]);
  // 1.67 on 10.00 is 20% on all of it, give or take the rounding: no 2p zero rated line
  assert.deepEqual(rday([kiosk('k2', 10, 1.67)]).sales.totals.byRate, { [K(STD)]: { sales: 1000, tax: 167 } });
  // online and QR rows store '[]' (the RPC keeps only an array): the same implied split
  assert.deepEqual(rday([{ ...kiosk('o1', 15, 2), source: 'online', tax_breakdown: [] }]).sales.totals.byRate, a.sales.totals.byRate);
});

test('per-rate: tax_amount null keeps the single default-rate treatment, flagged tax_not_recorded', () => {
  const s = rday([{ id: 'r', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 10, subtotal: 10, tip: 0, tax_amount: null }]);
  assert.deepEqual(s.sales.totals.byRate, { [K(STD)]: { sales: 1000, tax: 0 } });
  assert.deepEqual(s.warnings.map((w) => w.code), ['tax_not_recorded']);
});

test('per-rate: explicit zero tax is all zero rated (none when the venue has no 0% rate)', () => {
  const row = { id: 'z', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 10, tip: 0, tax_amount: 0 };
  assert.deepEqual(rday([row]).sales.totals.byRate, { [K(ZERO)]: { sales: 1000, tax: 0 } });
  assert.deepEqual(rday([row], [], RATES.filter((r) => r.id !== ZERO)).sales.totals.byRate, { none: { sales: 1000, tax: 0 } });
  // a venue with no default rate: the default bucket, as before, flagged
  const nodef = rday([{ ...row, tax_amount: 1 }], [], RATES.map((r) => ({ ...r, is_default: false })));
  assert.deepEqual(nodef.sales.totals.byRate, { default: { sales: 1000, tax: 100 } });
  assert.deepEqual(nodef.warnings.map((w) => w.code), ['tax_no_rates']);
});

// A US venue: 6% state + 2.875% city, both added on; stacked lines each carry the full gross.
const US_RATES = [
  { id: 'a1b2c3d4-0000-4000-8000-00000000000a', name: 'State', rate: 0.06, type: 'exclusive', is_default: true, active: true },
  { id: 'a1b2c3d4-0000-4000-8000-00000000000b', name: 'City', rate: 0.02875, type: 'exclusive', is_default: false, active: true },
];
const usCheck = {
  id: 'us', closed_at: '2026-09-18T19:00:00Z', method: 'card', subtotal: 100, tax_amount: 8.88, service: 0, tip: 0, total: 108.88,
  tax_breakdown: { subtotal: 100, totalTax: 8.875, total: 108.875, exclusiveTax: 8.88, hasExclusiveTax: true, source: 'profiles', breakdown: [
    { rate: { id: 'state', name: 'State', rate: 0.06, type: 'exclusive' }, tax: 6, net: 100, gross: 106, items: 2 },
    { rate: { id: 'city', name: 'City', rate: 0.02875, type: 'exclusive' }, tax: 2.875, net: 100, gross: 102.875, items: 2 },
  ] },
  tenders: [{ method: 'card', amount: 108.88, tip: 0 }],
};

test('per-rate: US added-on tax and stacked lines collapse into excl with the booked tax', () => {
  const s = rday([usCheck], [], US_RATES);
  assert.deepEqual(s.sales.totals.byRate, { excl: { sales: 10888, tax: 888 } });
  assert.deepEqual(s.warnings, []);
  // a kiosk row with no breakdown at a US venue: all added-on, one line as before, nothing estimated
  const k = rday([{ id: 'k', source: 'kiosk', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 10.89, tip: 0, tax_amount: 0.89 }], [], US_RATES);
  assert.deepEqual(k.sales.totals.byRate, { excl: { sales: 1089, tax: 89 } });
  assert.deepEqual(k.warnings, []);
  assert.equal(k.defaultTaxBucket.key, 'excl');
  assert.equal(taxContext(US_RATES).addedOn, true);
  // no default rate marked, but only added-on rates (and a 0% one): still an added-on venue
  assert.equal(taxContext([{ ...US_RATES[0], is_default: false }, { id: 'nt', name: 'No tax', rate: 0, type: 'inclusive', active: true }]).addedOn, true);
  assert.equal(taxContext(RATES).addedOn, false);
});

test("per-rate: a refund on a mixed check splits goods and tax by the check's rates, extra credit included", () => {
  // kiosk: bill 30 (24 at 20%, 6 zero rated), gift card 20, card 10; total = the card
  const row = {
    id: 'kr', source: 'kiosk', closed_at: '2026-09-10T12:00:00Z', method: 'split', total: 10, tip: 0, service: 0, tax_amount: 4,
    gift_card: { card_id: 'G', applied: 2000 }, tax_breakdown: breakdown([[STD, 0.2, 24, 4], [ZERO, 0, 6, 0]]),
  };
  const entry = { timestamp: Date.parse('2026-09-18T12:00:00Z'), amount: 10, tipAmount: 0, serviceAmount: 0, taxAmount: 1.33, tenderMethod: 'card', isFullRefund: true,
    legs: [{ amountMinor: 1000, status: 'succeeded', processor: 'adyen' }] };
  const r = refundParts(entry, row, taxContext(RATES));
  assert.deepEqual(r.parts.map((p) => [p.method, p.sales, p.tax]), [['card', 1000, 133], ['gift_card', 2000, 267]]);
  assert.deepEqual(r.parts[0].byRate, { [K(STD)]: { sales: 800, tax: 133 }, [K(ZERO)]: { sales: 200, tax: 0 } });
  assert.deepEqual(r.parts[1].byRate, { [K(STD)]: { sales: 1600, tax: 267 }, [K(ZERO)]: { sales: 400, tax: 0 } });
  const s = rday([], [{ ...row, refunds: [entry] }]);
  assert.deepEqual(s.refunds.totals.byRate, { [K(STD)]: { sales: 2400, tax: 400 }, [K(ZERO)]: { sales: 600, tax: 0 } });
});

const shuffleRows = [
  mixed,
  { id: 'k1', source: 'kiosk', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 15, tip: 1, tax_amount: 2 },
  { id: 'r5', closed_at: '2026-09-18T13:00:00Z', method: 'card', total: 21, tip: 0, tax_amount: 2.5,
    tax_breakdown: breakdown([[STD, 0.2, 10.5, 1.75], [RED, 0.05, 10.5, 0.5]]), tenders: [{ method: 'card', amount: 21 }] },
  { id: 'c9', closed_at: '2026-09-18T14:00:00Z', method: 'cash', total: 7.2, tip: 0, tax_amount: 1.2, tax_breakdown: breakdown([[TRAIN_STD, 0.2, 7.2, 1.2]]) },
];

test('per-rate: shuffled rows give the same byRate and the same payload hash', () => {
  const a = rday(shuffleRows);
  const b = rday([...shuffleRows].reverse());
  const c = rday([shuffleRows[2], shuffleRows[0], shuffleRows[3], shuffleRows[1]]);
  for (const x of [b, c]) {
    assert.deepEqual(x.sales.totals.byRate, a.sales.totals.byRate);
    assert.deepEqual(Object.keys(x.sales.totals.byRate), Object.keys(a.sales.totals.byRate));
    const pa = planXeroDay(a, { detail: UK_DETAIL }).transactions, px = planXeroDay(x, { detail: UK_DETAIL }).transactions;
    assert.deepEqual(px.map((t) => shortHash(JSON.stringify(t.payload))), pa.map((t) => shortHash(JSON.stringify(t.payload))));
  }
});

test('per-rate: no taxRates passed means no byRate and no new warnings', () => {
  const s = day(shuffleRows);
  assert.equal('byRate' in s.sales.totals, false);
  assert.ok(s.sales.byMethod.every((r) => !('byRate' in r)));
  assert.equal(s.taxBuckets, undefined);
  assert.deepEqual(s.warnings, []);
  assert.equal('byRate' in checkTenderParts(mixed).parts[0], false);
  assert.equal('byRate' in refundParts({ timestamp: 1, amount: 5, tipAmount: 0, serviceAmount: 0, tenderMethod: 'cash' }, mixed).parts[0], false);
  // the split never changes the unsplit figures
  const r = rday(shuffleRows);
  for (const k of ['gross', 'tip', 'service', 'tax', 'sales', 'count']) assert.equal(r.sales.totals[k], s.sales.totals[k], k);
  assert.equal(splitByRate(0, 0, []).constructor, Object);
});

test('Xero: one sales line per VAT rate in the same transaction; keys and references unchanged', () => {
  const plain = planXeroDay(day([mixed]), { detail: UK_DETAIL });
  const plan = planXeroDay(rday([mixed]), { detail: UK_DETAIL });
  assert.deepEqual(plan.transactions.map((t) => [t.key, t.reference]), plain.transactions.map((t) => [t.key, t.reference]));
  assert.deepEqual(plan.transactions.map((t) => t.key), ['RECEIVE:CARD', 'RECEIVE:CASH']);
  const card = plan.transactions[0];
  assert.deepEqual(card.payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.AccountCode, l.TaxType]), [
    ['Sales 2026-09-18 (card) 20%', 16, '200', 'OUTPUT2'],
    ['Sales 2026-09-18 (card) zero rated', 4, '200', 'ZERORATEDOUTPUT'],
  ]);
  for (const tx of plan.transactions) {
    assert.equal(tx.payload.LineItems.reduce((a, l) => a + Math.round(l.UnitAmount * 100), 0), tx.totals.gross, tx.key);
  }
  assert.deepEqual(card.vat, {
    lines: [
      { taxType: 'OUTPUT2', label: '20%', amount: 1600, taxBooked: 267, taxXero: 267, compare: true },
      { taxType: 'ZERORATEDOUTPUT', label: 'zero rated', amount: 400, taxBooked: 0, taxXero: 0, compare: true },
    ],
    booked: 267, xero: 267,
  });
  assert.deepEqual(postingVat(card), { 'OUTPUT2|20%': 16, 'ZERORATEDOUTPUT|zero rated': 4 });
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.warnings, []);
  // a summary built without rates is today's single line, at the default rate
  assert.deepEqual(plain.transactions[0].payload.LineItems.map((l) => [l.Description, l.TaxType]), [['Sales 2026-09-18 (card)', 'OUTPUT2']]);
});

test('Xero: an unmapped zero rate never takes 20%, even with taxDefault OUTPUT2', () => {
  const rows = [mixed, { id: 'n', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 10, tip: 0, tax_amount: 1.33,
    tax_breakdown: breakdown([[STD, 0.2, 8, 1.3333]], { total: 10 }), tenders: [{ method: 'card', amount: 10 }] }];
  for (const detail of [UK_DETAIL, DETAIL]) {   // with the org's list, and a dry run with none cached
    const plan = planXeroDay(rday(rows), { detail, mapping: { taxDefault: 'OUTPUT2' } });
    const lines = plan.transactions[0].payload.LineItems.map((l) => [l.Description.replace('Sales 2026-09-18 (card) ', ''), l.UnitAmount, l.TaxType]);
    assert.deepEqual(lines, [['20%', 24, 'OUTPUT2'], ['zero rated', 4, 'ZERORATEDOUTPUT'], ['no tax rate', 2, 'ZERORATEDOUTPUT']]);
    assert.deepEqual(plan.warnings.map((w) => w.code), ['tax_unrated_goods']);
  }
  // not VAT registered: one No VAT line, exactly as the older taxDefault 'NONE' posted
  for (const mapping of [{ salesNoVat: true }, { taxDefault: 'NONE' }]) {
    const tx = planXeroDay(rday(rows), { detail: UK_DETAIL, mapping }).transactions[0];
    assert.deepEqual(tx.payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.TaxType]), [['Sales 2026-09-18 (card)', 30, 'NONE']]);
  }
});

test('Xero: a rate with no Xero match blocks the day', () => {
  const odd = { id: 'o', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 11.25, tip: 0, tax_amount: 1.25, tax_breakdown: breakdown([[GONE, 0.125, 11.25, 1.25]]) };
  const plan = planXeroDay(rday([odd]), { detail: UK_DETAIL });
  assert.deepEqual(plan.blocked, [{ key: 'pct:12.5', name: '12.5%', pct: 12.5 }]);
  assert.equal(plan.warnings.find((w) => w.code === 'tax_rate_unmapped').blocked.length, 1);
  assert.equal(blockedMessage(plan.blocked), 'No Xero sales tax rate for ServOS rate(s) 12.5% (a rate this venue does not have). Choose one under Account mapping, VAT on sales, then push again. Nothing was posted.');
  // part of the day reached Xero on an earlier attempt: nothing MORE was posted this time
  assert.match(blockedMessage(plan.blocked, { partial: true }), /then push again\. Nothing more was posted\.$/);
  // the pct bucket can be chosen under Account mapping (the screen shows a row for it once refused)
  assert.deepEqual(planXeroDay(rday([odd]), { detail: UK_DETAIL, mapping: { taxRateMap: { 'pct:12.5': 'OUTPUT2' } } }).blocked, []);
  // an org with no 5% sales rate blocks Reduced Rate until it is mapped
  const noFive = { ...DETAIL, salesTaxRates: revenueTaxRates([...UK_TAX_RATES.filter((r) => r.TaxType !== 'RROUTPUT'), xr('TAX002', 'Special sales', 4, true, false)]) };
  const five = { id: 'f', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 10.5, tip: 0, tax_amount: 0.5, tax_breakdown: breakdown([[RED, 0.05, 10.5, 0.5]]) };
  const blocked = planXeroDay(rday([five]), { detail: noFive });
  assert.deepEqual(blocked.blocked, [{ key: K(RED), name: 'Reduced Rate', pct: 5 }]);
  assert.match(blockedMessage(blocked.blocked), /Reduced Rate \(5%\)/);
  const mapped = planXeroDay(rday([five]), { detail: noFive, mapping: { taxRateMap: { [RED]: 'TAX002' } } });
  assert.deepEqual(mapped.blocked, []);
  assert.equal(mapped.transactions[0].payload.LineItems[0].TaxType, 'TAX002');
});

test('Xero: service charge is No VAT by default; serviceTax and serviceTaxable opt in', () => {
  const row = { ...mixed, total: 33, service: 3, tenders: [{ method: 'card', amount: 33, tip: 0 }] };
  const svc = (mapping) => {
    const plan = planXeroDay(rday([row]), { detail: UK_DETAIL, mapping });
    return [plan.transactions[0].payload.LineItems.find((l) => l.Description.startsWith('Service charge')).TaxType, plan.warnings.map((w) => w.code)];
  };
  assert.deepEqual(svc({}), ['NONE', ['service_unmapped']]);
  assert.deepEqual(svc({ serviceTax: 'OUTPUT2' }), ['OUTPUT2', ['service_unmapped', 'vat_differs']]);   // ServOS booked no VAT on it
  assert.equal(svc({ serviceTaxable: true })[0], 'OUTPUT2');                      // the venue default rate
  assert.equal(svc({ serviceTaxable: false, serviceTax: 'OUTPUT2' })[0], 'NONE');
  assert.deepEqual(svc({ serviceTax: 'INPUT2' }), ['NONE', ['service_unmapped', 'tax_mapping_invalid']]);
  assert.equal(svc({ salesNoVat: true, serviceTax: 'OUTPUT2' })[0], 'NONE');
});

test('Xero: US added-on tax posts as today, one sales line at the default rate; lines add to gross', () => {
  const US_DETAIL = { ...DETAIL, taxType: 'NONE' };
  const kiosk = { id: 'k', source: 'kiosk', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 10.89, tip: 0.5, tax_amount: 0.89 };
  for (const mapping of [{}, { taxDefault: 'TAX001' }]) {
    const today = planXeroDay(day([usCheck, kiosk]), { detail: US_DETAIL, mapping }).transactions;
    const now = planXeroDay(rday([usCheck, kiosk], [], US_RATES), { detail: US_DETAIL, mapping });
    assert.deepEqual(now.transactions.map((t) => t.payload), today.map((t) => t.payload));
    assert.deepEqual(now.blocked, []);
    assert.ok(!now.warnings.some((w) => w.code === 'vat_differs'));
  }
  const tx = planXeroDay(rday([usCheck, kiosk], [], US_RATES), { detail: US_DETAIL }).transactions[0];
  // 108.88 + the kiosk's 10.39 (its total 10.89 includes the 0.50 tip)
  assert.deepEqual(tx.payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.TaxType]), [['Sales 2026-09-18 (card)', 119.27, 'NONE'], ['Tips and gratuities 2026-09-18', 0.5, 'NONE']]);
  assert.equal(tx.payload.LineItems.reduce((a, l) => a + Math.round(l.UnitAmount * 100), 0), tx.totals.gross);
});

test('Xero: vat_differs warning', () => {
  // the breakdown says 16.67 of VAT at 20%, the check booked 10.00 (before 27 Sep a discount never lowered it)
  const row = { id: 'd', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 100, tip: 0, tax_amount: 10, tax_breakdown: breakdown([[STD, 0.2, 100, 16.6667]]) };
  const s = rday([row]);
  assert.deepEqual(s.warnings.map((w) => w.code), ['tax_breakdown_mismatch']);
  const plan = planXeroDay(s, { detail: UK_DETAIL });
  assert.deepEqual([plan.transactions[0].vat.booked, plan.transactions[0].vat.xero], [1000, 1667]);
  const w = plan.warnings.find((x) => x.code === 'vat_differs');
  assert.match(w.message, /ServOS takings 2026-09-18 \(CARD\): Xero 16\.67, ServOS 10\.00/);
  // pennies of per line rounding are not worth a warning
  assert.ok(!planXeroDay(rday([mixed]), { detail: UK_DETAIL }).warnings.some((x) => x.code === 'vat_differs'));
});

test('Xero: the Leeds 26 Sep retry', () => {
  // xero_sync_log 26 Sep: the card posting was left 'sending' after Xero refused INPUT2 on 200.
  const CARD_BANK = '6026f133-3895-4787-9b7a-31497b0d8fc9', CASH_BANK = '1f0e2d3c-4b5a-4968-8776-655443322110';
  const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
  const d26 = businessDayWindow('2026-09-26', UK.timezone, UK.dayStart);
  const at = (h) => `2026-09-26T${h}:00:00Z`;
  const rows = [
    { id: 'l1', closed_at: at('12'), method: 'card', total: 1005, tip: 5, tax_amount: 166.67, source: 'pos', tax_breakdown: breakdown([[STD, 0.2, 1000, 166.6667]]), tenders: [{ method: 'card', amount: 1000, tip: 5 }] },
    { id: 'l2', closed_at: at('18'), method: 'card', total: 236.53, tip: 3.44, tax_amount: 38.85, source: 'pos_send_to_terminal', tax_breakdown: breakdown([[TRAIN_STD, 0.2, 233.09, 38.8483]]), tenders: [{ method: 'card', amount: 233.09, tip: 3.44 }] },
    { id: 'l3', closed_at: at('19'), method: 'cash', total: 50, tip: 0, tax_amount: 8.33, source: 'pos', tax_breakdown: breakdown([[TRAIN_STD, 0.2, 50, 8.3333]]) },
    { id: 'l4', closed_at: at('20'), method: 'card', total: 99, tip: 0, tax_amount: 16.5, status: 'voided', tax_breakdown: breakdown([[STD, 0.2, 99, 16.5]]) },
  ];
  const summary = buildAccountingDay({ day: d26, saleRows: rows, venue: UK, taxRates: RATES });
  const mapping = { paymentMap: { card: CARD_BANK, cash: CASH_BANK }, revenueAccount: '200', tipsAccount: '825', serviceAccount: '825', purchaseTax: 'INPUT2' };
  const cached = { ...DETAIL, taxType: 'INPUT2' };
  // the real run re-reads Xero's rates and heals the cached expense rate
  const rev = revenueTaxRates(UK_TAX_RATES);
  const detail = { ...cached, salesTaxRates: rev, taxType: healedTaxType(cached, rev) };
  assert.equal(detail.taxType, 'OUTPUT2');
  const plan = planXeroDay(summary, { mapping, detail });
  const card = plan.transactions.find((t) => t.methods.includes('card'));
  assert.equal(card.key, `RECEIVE:${CARD_BANK}`);
  assert.equal(card.reference, 'ServOS takings 2026-09-26 (6026f133)');
  assert.deepEqual(card.payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.AccountCode, l.TaxType]), [
    ['Sales 2026-09-26 (card) 20%', 1233.09, '200', 'OUTPUT2'],
    ['Tips and gratuities 2026-09-26', 8.44, '825', 'NONE'],
  ]);
  assert.equal(card.vat.xero, 20551);   // what Xero itself worked out on the refused payload
  assert.deepEqual(plan.blocked, []);
  assert.ok(!plan.warnings.some((w) => w.code === 'vat_differs'));
  // the cash transaction posts for the first time
  assert.deepEqual(plan.transactions.map((t) => t.key).sort(), [`RECEIVE:${CARD_BANK}`, `RECEIVE:${CASH_BANK}`].sort());
  assert.deepEqual(plan.transactions.find((t) => t.key === `RECEIVE:${CASH_BANK}`).payload.LineItems.map((l) => [l.UnitAmount, l.TaxType]), [[50, 'OUTPUT2']]);
  // no expense rate anywhere, even on a dry run with only the old cached detail
  for (const d of [detail, cached]) assert.doesNotMatch(JSON.stringify(planXeroDay(summary, { mapping, detail: d }).transactions.map((t) => t.payload)), /INPUT/);
  // retry: the 'sending' posting is looked up by its reference, then sent under a NEW key
  const prev = { status: 'sending', reference: 'ServOS takings 2026-09-26 (6026f133)', idem: `servos-${LEEDS}-2026-09-26-RECEIVE:${CARD_BANK}-0598cad5` };
  assert.equal(postingStep(prev), 'lookup');
  assert.equal(prev.reference, card.reference);
  const idem = idempotencyKey(LEEDS, '2026-09-26', card);
  assert.ok(idem.startsWith(`servos-${LEEDS}-2026-09-26-RECEIVE:${CARD_BANK}-`));
  assert.notEqual(idem, prev.idem);
  assert.equal(postingStep({ status: 'posted' }), 'skip');
  assert.equal(postingStep(undefined), 'send');
});

test('Xero: a rate only checks with no VAT breakdown fed posts at the default rate as before when Xero has no match; a saved breakdown blocks', () => {
  // Provo's pattern: UK style ServOS rates (Standard 20% default), a Xero org with no 20% sales rate.
  const US_ORG = [
    { Name: 'Tax Exempt', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true, CanApplyToExpenses: true, EffectiveRate: 0 },
    { Name: 'NYC Sales Tax', TaxType: 'TAX001', Status: 'ACTIVE', CanApplyToRevenue: true, CanApplyToExpenses: false, EffectiveRate: 8.875 },
  ];
  const detail = { ...DETAIL, taxType: 'NONE', salesTaxRates: revenueTaxRates(US_ORG) };
  const kiosk = { id: 'k', source: 'kiosk', closed_at: '2026-09-18T12:00:00Z', method: 'card', total: 12, tip: 0, tax_amount: 2 };
  const online = { id: 'o', source: 'online', closed_at: '2026-09-18T13:00:00Z', method: 'card', total: 8, subtotal: 8, tip: 0, tax_amount: null, tax_breakdown: [] };
  const s = rday([kiosk, online]);
  assert.deepEqual(s.taxBuckets.map((b) => [b.key, !!b.estimated]), [[K(STD), true]]);
  // exactly what the code before 28 Sep posted: one line at detail.taxType
  const today = planXeroDay(day([kiosk, online]), { detail: { ...DETAIL, taxType: 'NONE' } });
  const plan = planXeroDay(s, { detail });
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.transactions.map((t) => t.payload), today.transactions.map((t) => t.payload));
  assert.deepEqual(plan.transactions[0].payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.TaxType]), [['Sales 2026-09-18 (card)', 20, 'NONE']]);
  assert.match(plan.warnings.find((w) => w.code === 'tax_rate_estimated_default').message, /at Standard Rate \(20%\), which has no Xero sales rate, so they post at No VAT, as before/);
  // mapped under Account mapping: its own line at the chosen rate, no warning
  const mapped = planXeroDay(s, { detail, mapping: { taxRateMap: { [STD]: 'NONE' } } });
  assert.deepEqual(mapped.transactions[0].payload.LineItems.map((l) => [l.Description, l.TaxType]), [['Sales 2026-09-18 (card) 20%', 'NONE']]);
  assert.ok(!mapped.warnings.some((w) => w.code === 'tax_rate_estimated_default'));
  // a till check with a saved 20% breakdown the same day: real, so the day is refused
  const pos = { id: 'p', closed_at: '2026-09-18T14:00:00Z', method: 'card', total: 12, tip: 0, tax_amount: 2, tax_breakdown: breakdown([[STD, 0.2, 12, 2]]) };
  const real = rday([kiosk, pos]);
  assert.equal(real.taxBuckets[0].estimated, undefined);
  assert.deepEqual(planXeroDay(real, { detail }).blocked, [{ key: K(STD), name: 'Standard Rate', pct: 20 }]);
  // a refund's breakdown counts as real too
  const refunded = rday([], [{ ...pos, closed_at: '2026-09-10T12:00:00Z', refunds: [{ timestamp: Date.parse('2026-09-18T15:00:00Z'), amount: 12, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card' }] }]);
  assert.equal(refunded.taxBuckets[0].estimated, undefined);
});

test('Xero: a US venue keeps one sales line and its service charge rate, whatever the breakdown says', () => {
  // TaxManager makes new rates 'inclusive' by default: a US venue's "No tax" 0% rate is one.
  const rates = [...US_RATES, { id: 'a1b2c3d4-0000-4000-8000-00000000000c', name: 'No tax', rate: 0, type: 'inclusive', is_default: false, active: true }];
  // 20.00 taxed at 6% (1.20) and 10.00 on the 0% item, a 10.00 service charge and a 5.00 tip
  const row = { id: 'u', closed_at: '2026-09-18T19:00:00Z', method: 'card', subtotal: 30, tax_amount: 1.2, service: 10, tip: 5, total: 46.2,
    tax_breakdown: { subtotal: 30, totalTax: 1.2, total: 31.2, exclusiveTax: 1.2, hasExclusiveTax: true, source: 'profiles', breakdown: [
      { rate: { id: 'a1b2c3d4-0000-4000-8000-00000000000a', name: 'State', rate: 0.06, type: 'exclusive' }, tax: 1.2, net: 20, gross: 21.2 },
      { rate: { id: 'a1b2c3d4-0000-4000-8000-00000000000c', name: 'No tax', rate: 0, type: 'inclusive' }, tax: 0, net: 10, gross: 10 },
    ] },
    tenders: [{ method: 'card', amount: 41.2, tip: 5 }] };
  const s = rday([row], [], rates);
  assert.deepEqual(s.sales.totals.byRate, { excl: { sales: 3120, tax: 120 } });
  const US_DETAIL = { ...DETAIL, taxType: 'NONE', salesTaxRates: revenueTaxRates([
    { Name: 'Tax Exempt', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 0 },
    { Name: 'NYC Sales Tax', TaxType: 'TAX001', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 8.875 },
  ]) };
  // the lines the code before 28 Sep sent (sales and service at taxDefault, else detail.taxType)
  const lines = (mapping) => planXeroDay(s, { detail: US_DETAIL, mapping }).transactions[0].payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.TaxType]);
  assert.deepEqual(lines({ taxDefault: 'TAX001' }), [['Sales 2026-09-18 (card)', 31.2, 'TAX001'], ['Tips and gratuities 2026-09-18', 5, 'NONE'], ['Service charge 2026-09-18', 10, 'TAX001']]);
  assert.deepEqual(lines({}), [['Sales 2026-09-18 (card)', 31.2, 'NONE'], ['Tips and gratuities 2026-09-18', 5, 'NONE'], ['Service charge 2026-09-18', 10, 'NONE']]);
  assert.deepEqual(lines({ taxDefault: 'TAX001', serviceTax: 'NONE' })[2], ['Service charge 2026-09-18', 10, 'NONE']);
  assert.deepEqual(lines({ taxDefault: 'TAX001', serviceTaxable: false })[2], ['Service charge 2026-09-18', 10, 'NONE']);
});

test('Xero: test figures use the venue\'s own rates and never refuse on a rate the venue does not have', () => {
  const US_ORG = { ...DETAIL, taxType: 'NONE', salesTaxRates: revenueTaxRates([
    { Name: 'Tax Exempt', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 0 },
    { Name: 'Tax on Sales', TaxType: 'OUTPUT', Status: 'ACTIVE', CanApplyToRevenue: true, EffectiveRate: 0 },
  ]) };
  const sample = (taxRates, detail) => {
    const summary = buildAccountingDay({ day: DAY, saleRows: sampleSaleRows(DAY.fromIso, taxRates), venue: UK, taxRates });
    summary.warnings = summary.warnings.filter((w) => !SAMPLE_TAX_NOTES.has(w.code));
    return { summary, plan: planXeroDay(summary, { detail, sample: true }) };
  };
  // a UK venue: 20% and zero rated on its own rate ids, one line per rate
  const uk = sample(RATES, UK_DETAIL);
  assert.deepEqual(uk.summary.taxBuckets.map((b) => b.key), [K(STD), K(ZERO)]);
  assert.deepEqual(uk.plan.blocked, []);
  assert.deepEqual(uk.plan.transactions[0].payload.LineItems.map((l) => [l.Description, l.UnitAmount, l.TaxType]), [
    ['Sales 2026-09-18 (card) 20%', 90, 'OUTPUT2'], ['Sales 2026-09-18 (card) zero rated', 12, 'ZERORATEDOUTPUT'],
    ['Tips and gratuities 2026-09-18', 12, 'NONE'], ['Service charge 2026-09-18', 6, 'NONE'],
  ]);
  assert.equal(uk.summary.sales.totals.tax, 1500);
  assert.deepEqual(uk.summary.warnings, []);
  // a US venue (added-on tax), and venues with no rates or no default: no breakdown, never a
  // 20% the venue does not have, so a US org posts the test as it always did
  for (const rates of [US_RATES, [], RATES.map((r) => ({ ...r, is_default: false }))]) {
    const x = sample(rates, US_ORG);
    assert.ok(!x.summary.taxBuckets.some((b) => b.key.startsWith('pct:')));
    assert.deepEqual(x.plan.blocked, [], JSON.stringify(rates));
    assert.deepEqual(x.summary.warnings, []);
    assert.ok(sampleSaleRows(DAY.fromIso, rates).every((r) => !r.tax_breakdown));
  }
  // a venue with no 0% rate: all of it at the default rate
  assert.deepEqual(sample(RATES.filter((r) => r.id !== ZERO), UK_DETAIL).summary.taxBuckets.map((b) => b.key), [K(STD)]);
});

// ── deploy: each function ships the shared accounting files it imports ─────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoIo = {
  read: (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'),
  exists: (p) => { try { return fs.statSync(path.join(ROOT, p)).isFile(); } catch { return false; } },
  list: (d) => { try { return fs.readdirSync(path.join(ROOT, d)); } catch { return []; } },
};

test('deploy: xero-sales, xero-config and xero-bills ship the shared files they need', () => {
  const sales = sharedDepsOf('xero-sales', repoIo);
  for (const f of ['businessDay.js', 'accountingDay.js', 'xeroPostingPlan.js', 'xeroTax.js', 'accountingData.ts', 'syncRun.ts', 'xero.ts']) {
    assert.ok(sales.includes(`supabase/functions/_shared/${f}`), `xero-sales ships ${f}`);
  }
  const config = sharedDepsOf('xero-config', repoIo);
  for (const f of ['businessDay.js', 'accountingDay.js', 'xeroTax.js', 'accountingData.ts', 'xero.ts']) {
    assert.ok(config.includes(`supabase/functions/_shared/${f}`), `xero-config ships ${f}`);
  }
  assert.ok(sharedDepsOf('xero-bills', repoIo).includes('supabase/functions/_shared/syncRun.ts'));
  // The pure rules import nothing but each other, so `npm test` loads exactly what ships.
  for (const f of ['businessDay.js', 'accountingDay.js', 'xeroPostingPlan.js', 'xeroTax.js']) {
    const src = repoIo.read(`supabase/functions/_shared/${f}`);
    assert.doesNotMatch(src, /from\s+['"](?!\.\/)/, `${f} has no outside imports`);
  }
});
