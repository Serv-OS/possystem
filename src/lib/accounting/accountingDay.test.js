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
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { businessDayWindow } from '../../../supabase/functions/_shared/businessDay.js';
import {
  buildAccountingDay, checkTenders, checkTenderParts, refundParts, allocate, toMinor,
  canonicalMethod, tenderKind, isVoidedCheck, checkTaxMinor,
} from '../../../supabase/functions/_shared/accountingDay.js';
import { planXeroDay, requiredDefaults, accountRef, DEFAULT_ACCOUNTS, KIND_ACCOUNT, shortHash } from '../../../supabase/functions/_shared/xeroPostingPlan.js';
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
  assert.deepEqual(card.map((l) => [l.UnitAmount, l.AccountCode, l.TaxType]), [[18, '200', 'OUTPUT2'], [3, 'SOSTIPS', 'NONE'], [2, 'SOSSVCCHG', 'OUTPUT2']]);
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

// ── deploy: each function ships the shared accounting files it imports ─────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoIo = {
  read: (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'),
  exists: (p) => { try { return fs.statSync(path.join(ROOT, p)).isFile(); } catch { return false; } },
  list: (d) => { try { return fs.readdirSync(path.join(ROOT, d)); } catch { return []; } },
};

test('deploy: xero-sales, xero-config and xero-bills ship the shared files they need', () => {
  const sales = sharedDepsOf('xero-sales', repoIo);
  for (const f of ['businessDay.js', 'accountingDay.js', 'xeroPostingPlan.js', 'accountingData.ts', 'syncRun.ts', 'xero.ts']) {
    assert.ok(sales.includes(`supabase/functions/_shared/${f}`), `xero-sales ships ${f}`);
  }
  const config = sharedDepsOf('xero-config', repoIo);
  for (const f of ['businessDay.js', 'accountingDay.js', 'accountingData.ts', 'xero.ts']) {
    assert.ok(config.includes(`supabase/functions/_shared/${f}`), `xero-config ships ${f}`);
  }
  assert.ok(sharedDepsOf('xero-bills', repoIo).includes('supabase/functions/_shared/syncRun.ts'));
  // The pure rules import nothing but each other, so `npm test` loads exactly what ships.
  for (const f of ['businessDay.js', 'accountingDay.js', 'xeroPostingPlan.js']) {
    const src = repoIo.read(`supabase/functions/_shared/${f}`);
    assert.doesNotMatch(src, /from\s+['"](?!\.\/)/, `${f} has no outside imports`);
  }
});
