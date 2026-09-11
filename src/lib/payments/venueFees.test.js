/**
 * venueFees.test.js: what a venue paid and received on its card payments,
 * and which rows a venue screen shows.
 * Run: `node --test src/lib/payments/venueFees.test.js`.
 *
 * The contract for BOTH copies: src/lib/payments/venueFees.js and
 * supabase/functions/_shared/venueFees.ts (the TS mirror test at the end).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import * as jsModule from './venueFees.js';
import {
  hasSuccessfulCapture, isUncapturedPayment, isCountedPayment, capturedMinorFor,
  venueFeeFor, venueReceivesFor, isVisiblePayment, summarizeVenueFees,
  PAYOUT_SALE_LINE_TYPES, PAYOUT_VENUE_LINE_TYPES, venuePayoutLine, summarizeVenuePayout,
  isValidTimeZone, venueTimeZoneFor, venueCurrentMonth, venueMonthBoundsIso,
} from './venueFees.js';

const paid = (amount, commission, extra = {}) => ({
  success: true, last_event_code: 'AUTHORISATION', amount_minor: amount, amount_refunded_minor: 0, commission_minor: commission, ...extra,
});

// ── The proven numbers: Adyen's balance platform bookings on two live payments ──
test('£1.00 at 6p: fee 6, venue receives 94', () => {
  const r = paid(100, 6);
  assert.equal(venueFeeFor(r), 6);
  assert.equal(venueReceivesFor(r), 94);
});

test('£2.50 at 7p: fee 7, venue receives 243', () => {
  const r = paid(250, 7);
  assert.equal(venueFeeFor(r), 7);
  assert.equal(venueReceivesFor(r), 243);
});

test('a half refund of £2.50 at 7p: 3.5p rounds half up to 4, venue receives 121', () => {
  const r = paid(250, 7, { amount_refunded_minor: 125, last_event_code: 'REFUND' });
  assert.equal(venueFeeFor(r), 4);
  assert.equal(venueReceivesFor(r), 121);
});

test('the refund ratio rounds half up, and a full refund leaves no fee', () => {
  assert.equal(venueFeeFor(paid(300, 7, { amount_refunded_minor: 100 })), 5);   // 4.67
  assert.equal(venueFeeFor(paid(300, 7, { amount_refunded_minor: 200 })), 2);   // 2.33
  assert.equal(venueFeeFor(paid(200, 5, { amount_refunded_minor: 100 })), 3);   // 2.5
  assert.equal(venueFeeFor(paid(250, 7, { amount_refunded_minor: 250 })), 0);
  assert.equal(venueReceivesFor(paid(250, 7, { amount_refunded_minor: 250 })), 0);
  // over refunded never drives the fee below 0
  assert.equal(venueFeeFor(paid(250, 7, { amount_refunded_minor: 400 })), 0);
});

test('no fee on record gives null for the fee and for what the venue receives', () => {
  assert.equal(venueFeeFor(paid(250, null)), null);
  assert.equal(venueReceivesFor(paid(250, null)), null);
  assert.equal(venueFeeFor(paid(250, undefined)), null);
  assert.equal(venueFeeFor(paid(250, '')), null);
});

test('declined and cancelled payments carry no fee', () => {
  const declined = paid(250, 7, { success: false });
  const cancelled = paid(250, 7, { last_event_code: 'CANCELLATION' });
  assert.equal(venueFeeFor(declined), null);
  assert.equal(venueReceivesFor(declined), null);
  assert.equal(venueFeeFor(cancelled), null);
  assert.equal(venueReceivesFor(cancelled), null);
  assert.equal(isCountedPayment(declined), false);
  assert.equal(isCountedPayment(cancelled), false);
  assert.equal(isUncapturedPayment(declined), false);
  assert.equal(isUncapturedPayment(cancelled), false);
  assert.equal(isCountedPayment(null), false);
  assert.equal(venueFeeFor(null), null);
});

test('numbers that arrive as strings still add up', () => {
  const r = paid('250', '7', { amount_refunded_minor: '125' });
  assert.equal(venueFeeFor(r), 4);
  assert.equal(venueReceivesFor(r), 121);
});

// ── Captures: the payments-admin rule ────────────────────────────────────────
test('a failed capture with no successful capture is not counted and has no fee', () => {
  const r = paid(250, 7, { last_event_code: 'CAPTURE_FAILED' });
  assert.equal(isUncapturedPayment(r), true);
  assert.equal(isCountedPayment(r), false);
  assert.equal(venueFeeFor(r), null);
  assert.equal(venueReceivesFor(r), null);
  // a stale CAPTURE_FAILED over a capture that DID succeed still counts
  const settled = paid(250, 7, { last_event_code: 'CAPTURE_FAILED', applied_mods: ['CAPTURE:X1:false', 'CAPTURE:X2:true'] });
  assert.equal(hasSuccessfulCapture(settled), true);
  assert.equal(isCountedPayment(settled), true);
  assert.equal(venueFeeFor(settled), 7);
  assert.equal(hasSuccessfulCapture({ applied_mods: ['REFUND:X:true', 'CAPTURE:X:false'] }), false);
  assert.equal(hasSuccessfulCapture({ applied_mods: 'CAPTURE:X:true' }), false);
});

test('a hold never captured is not counted; a cancelled hold hit by a failed capture is not counted', () => {
  const openTab = paid(5000, 45, { capture_required: true, captured_at: null });
  assert.equal(isUncapturedPayment(openTab), true);
  assert.equal(isCountedPayment(openTab), false);
  assert.equal(venueFeeFor(openTab), null);
  const tipFailed = paid(2000, 21, { capture_required: true, last_event_code: 'CAPTURE_FAILED', applied_mods: ['CAPTURE:Y:false'] });
  assert.equal(isCountedPayment(tipFailed), false);
  const cancelledThenFailed = paid(2000, 21, { capture_required: true, last_event_code: 'CAPTURE_FAILED', applied_mods: ['CANCELLATION:Z:true', 'CAPTURE:Y:false'] });
  assert.equal(isCountedPayment(cancelledThenFailed), false);
  assert.equal(venueFeeFor(cancelledThenFailed), null);
});

test('a hold is rated only when its captured amount is known and matches the amount', () => {
  // £50.00 hold closed at £32.00 on 0.8% plus 5p. Before the webhook fix the row
  // kept 5000 and 45p: the capture took 3200, so no fee is shown on the hold.
  const stale = paid(5000, 45, {
    capture_required: true, captured_at: '2026-09-10T20:00:00Z', applied_mods: ['CAPTURE:C:true'],
    last_mod_code: 'CAPTURE', last_mod_ok: 'true', last_mod_amount: '3200',
  });
  assert.equal(capturedMinorFor(stale), 3200);
  assert.equal(isCountedPayment(stale), true);
  assert.equal(venueFeeFor(stale), null);
  assert.equal(venueReceivesFor(stale), null);
  // After the webhook fix: amount 3200, fee restamped 31p, raw.captured_minor 3200.
  const fixed = paid(3200, 31, { capture_required: true, captured_at: '2026-09-10T20:00:00Z', applied_mods: ['CAPTURE:C:true'], captured_minor: 3200 });
  assert.equal(venueFeeFor(fixed), 31);
  assert.equal(venueReceivesFor(fixed), 3169);
  // captured_minor wins over a later refund being the last modification
  const refundedLater = { ...fixed, amount_refunded_minor: 1600, last_mod_code: 'REFUND', last_mod_ok: 'true', last_mod_amount: '1600' };
  assert.equal(capturedMinorFor(refundedLater), 3200);
  assert.equal(venueFeeFor(refundedLater), 16);   // 31 x 1600 / 3200 = 15.5, half up
  // a hold captured with no record of the amount is unrated
  assert.equal(venueFeeFor(paid(3200, 31, { capture_required: true, captured_at: '2026-09-10T20:00:00Z' })), null);
  assert.equal(capturedMinorFor({ last_mod_code: 'CAPTURE', last_mod_ok: 'false', last_mod_amount: '3200' }), null);
  // an auto captured payment never needs a captured amount
  assert.equal(venueFeeFor(paid(3200, 31, { capture_required: null })), 31);
});

// ── Visibility ────────────────────────────────────────────────────────────────
test('a live venue shows only live rows unless test rows are asked for', () => {
  assert.equal(isVisiblePayment({ live: true }, 'live', false), true);
  assert.equal(isVisiblePayment({ live: false }, 'live', false), false);
  assert.equal(isVisiblePayment({ live: null }, 'live', false), false);
  assert.equal(isVisiblePayment({}, 'live', undefined), false);
  assert.equal(isVisiblePayment({ live: false }, 'live', true), true);
  assert.equal(isVisiblePayment({ live: null }, 'live', true), true);
  assert.equal(isVisiblePayment({ live: true }, 'LIVE', true), true);
  // only a real true asks for test rows
  assert.equal(isVisiblePayment({ live: false }, 'live', 'true'), false);
});

test('a test venue shows the rows whose live is not true', () => {
  assert.equal(isVisiblePayment({ live: false }, 'test', false), true);
  assert.equal(isVisiblePayment({ live: null }, 'test', false), true);
  assert.equal(isVisiblePayment({}, 'test', false), true);
  assert.equal(isVisiblePayment({ live: true }, 'test', false), false);
  assert.equal(isVisiblePayment({ live: true }, 'test', true), false);
  assert.equal(isVisiblePayment({ live: true }, null, false), false);
});

// ── Sums ──────────────────────────────────────────────────────────────────────
test('summary adds counted payments only; receives waits while any payment is unrated', () => {
  const rated = [
    paid(100, 6),
    paid(250, 7),
    paid(250, 7, { amount_refunded_minor: 125 }),
    paid(900, 20, { success: false, amount_refunded_minor: 0 }),
    paid(900, 20, { last_event_code: 'CANCELLATION', amount_refunded_minor: 900 }),
    paid(700, 11, { last_event_code: 'CAPTURE_FAILED' }),
    paid(5000, 45, { capture_required: true }),
  ];
  assert.deepEqual(summarizeVenueFees(rated), {
    count: 3, gross_minor: 600, refunds_minor: 125, fees_minor: 17, receives_minor: 94 + 243 + 121,
    fees_rated: 3, fees_unrated: 0, unrated_gross_minor: 0, not_captured: 2,
  });
  // the cancelled row's refund never lowers the sums
  assert.equal(summarizeVenueFees(rated).receives_minor, 600 - 125 - 17);
  const withUnrated = [...rated, paid(500, null)];
  assert.deepEqual(summarizeVenueFees(withUnrated), {
    count: 4, gross_minor: 1100, refunds_minor: 125, fees_minor: 17, receives_minor: null,
    fees_rated: 3, fees_unrated: 1, unrated_gross_minor: 500, not_captured: 2,
  });
  assert.deepEqual(summarizeVenueFees(null), {
    count: 0, gross_minor: 0, refunds_minor: 0, fees_minor: 0, receives_minor: 0,
    fees_rated: 0, fees_unrated: 0, unrated_gross_minor: 0, not_captured: 0,
  });
});

// ── Payout lines ──────────────────────────────────────────────────────────────
test('Adyen cost and account lines never reach a venue', () => {
  for (const type of ['Fee', 'MiscCosts', 'PaymentCost', 'SettleCost', 'InvoiceDeduction', 'MerchantPayout', 'DepositCorrection', 'Balancetransfer', '', undefined]) {
    assert.equal(venuePayoutLine({ line_type: type, gross_minor: -12 }, paid(250, 7)), null, String(type));
  }
  assert.ok(PAYOUT_SALE_LINE_TYPES.every((t) => PAYOUT_VENUE_LINE_TYPES.includes(t)));
});

test('a sale line carries the full fee; a refund line gives its share back, as the split booked it', () => {
  const pay = paid(250, 7, { amount_refunded_minor: 125 });
  const sale = venuePayoutLine({ line_type: 'Settled', gross_minor: 250 }, pay);
  const refund = venuePayoutLine({ line_type: 'Refunded', gross_minor: -125 }, pay);
  // batch 1 matches Adyen's booking on the sale: 7p fee, £2.43 to the venue
  assert.deepEqual(sale, { gross_minor: 250, fee_minor: 7, receives_minor: 243, unrated: false });
  // batch 2: a £1.25 refund gives back 3p of the fee, so the venue pays out £1.22
  assert.deepEqual(refund, { gross_minor: -125, fee_minor: -3, receives_minor: -122, unrated: false });
  assert.equal(sale.fee_minor + refund.fee_minor, venueFeeFor(pay));
  assert.equal(sale.receives_minor + refund.receives_minor, venueReceivesFor(pay));
  // a full refund gives the whole fee back
  const full = paid(250, 7, { amount_refunded_minor: 250 });
  assert.deepEqual(venuePayoutLine({ line_type: 'RefundedExternally', gross_minor: -250 }, full), { gross_minor: -250, fee_minor: -7, receives_minor: -243, unrated: false });
  // a reversed refund takes the returned fee again
  assert.deepEqual(venuePayoutLine({ line_type: 'RefundedReversed', gross_minor: 125 }, pay), { gross_minor: 125, fee_minor: 3, receives_minor: 122, unrated: false });
  // a tiny refund that gives nothing back carries a plain 0
  assert.deepEqual(venuePayoutLine({ line_type: 'Refunded', gross_minor: -1 }, paid(250, 7, { amount_refunded_minor: 1 })), { gross_minor: -1, fee_minor: 0, receives_minor: -1, unrated: false });
  // dispute lines carry no fee
  assert.deepEqual(venuePayoutLine({ line_type: 'Chargeback', gross_minor: -250 }, null), { gross_minor: -250, fee_minor: null, receives_minor: -250, unrated: false });
});

test('a sale or refund line with no matched payment or no fee on record is unrated', () => {
  assert.deepEqual(venuePayoutLine({ line_type: 'Settled', gross_minor: 250 }, null), { gross_minor: 250, fee_minor: null, receives_minor: null, unrated: true });
  assert.deepEqual(venuePayoutLine({ line_type: 'SettledExternally', gross_minor: 100 }, paid(100, null)), { gross_minor: 100, fee_minor: null, receives_minor: null, unrated: true });
  assert.deepEqual(venuePayoutLine({ line_type: 'Refunded', gross_minor: -100 }, paid(100, null)), { gross_minor: -100, fee_minor: null, receives_minor: null, unrated: true });
  assert.deepEqual(venuePayoutLine({ line_type: 'Settled', gross_minor: 3200 }, paid(5000, 45, { capture_required: true, captured_at: 'x', last_mod_code: 'CAPTURE', last_mod_ok: 'true', last_mod_amount: 3200 })), { gross_minor: 3200, fee_minor: null, receives_minor: null, unrated: true });
});

test('payout totals: fees null when none known, receives null while any line is unrated', () => {
  const a = venuePayoutLine({ line_type: 'Settled', gross_minor: 100 }, paid(100, 6));
  const b = venuePayoutLine({ line_type: 'Settled', gross_minor: 250 }, paid(250, 7));
  const cost = venuePayoutLine({ line_type: 'Fee', gross_minor: -9 }, null);
  assert.deepEqual(summarizeVenuePayout([a, b, cost]), { line_count: 2, gross_minor: 350, fees_minor: 13, receives_minor: 337, fees_unrated: 0 });
  const unrated = venuePayoutLine({ line_type: 'Settled', gross_minor: 500 }, null);
  assert.deepEqual(summarizeVenuePayout([a, unrated]), { line_count: 2, gross_minor: 600, fees_minor: 6, receives_minor: null, fees_unrated: 1 });
  const dispute = venuePayoutLine({ line_type: 'Chargeback', gross_minor: -50 }, null);
  assert.deepEqual(summarizeVenuePayout([dispute]), { line_count: 1, gross_minor: -50, fees_minor: null, receives_minor: -50, fees_unrated: 0 });
  assert.deepEqual(summarizeVenuePayout([]), { line_count: 0, gross_minor: 0, fees_minor: null, receives_minor: 0, fees_unrated: 0 });
});

test('ONE rule: Payments, the statement and the payouts agree on the same row set', () => {
  // The statement and the Payments tiles both use summarizeVenueFees; a payout
  // is built from venuePayoutLine. All settled in one batch.
  const rows = [
    { psp: 'A', ...paid(100, 6) },
    { psp: 'B', ...paid(250, 7, { amount_refunded_minor: 125 }) },
    { psp: 'C', ...paid(900, 20, { last_event_code: 'CANCELLATION', amount_refunded_minor: 900 }) },
    { psp: 'D', ...paid(700, 11, { last_event_code: 'CAPTURE_FAILED' }) },
  ];
  const lines = [
    { line_type: 'Settled', gross_minor: 100, psp: 'A' },
    { line_type: 'Settled', gross_minor: 250, psp: 'B' },
    { line_type: 'Refunded', gross_minor: -125, psp: 'B' },
  ];
  const byPsp = new Map(rows.map((r) => [r.psp, r]));
  const s = summarizeVenueFees(rows);
  const p = summarizeVenuePayout(lines.map((l) => venuePayoutLine(l, byPsp.get(l.psp))));
  assert.equal(s.receives_minor, 94 + 121);
  assert.equal(p.receives_minor, s.receives_minor);
  assert.equal(p.fees_minor, s.fees_minor);
  assert.equal(s.gross_minor - s.refunds_minor - s.fees_minor, s.receives_minor);
  // Add one payment with no fee: every place says the total is not ready.
  rows.push({ psp: 'E', ...paid(500, null) });
  lines.push({ line_type: 'Settled', gross_minor: 500, psp: 'E' });
  byPsp.set('E', rows[rows.length - 1]);
  const s2 = summarizeVenueFees(rows);
  const p2 = summarizeVenuePayout(lines.map((l) => venuePayoutLine(l, byPsp.get(l.psp))));
  assert.equal(s2.receives_minor, null);
  assert.equal(p2.receives_minor, null);
  assert.equal(s2.fees_unrated, 1);
  assert.equal(s2.unrated_gross_minor, 500);
});

// ── Venue clock ───────────────────────────────────────────────────────────────
test('venue time zone: the row, else by currency', () => {
  assert.equal(venueTimeZoneFor({ timezone: 'Europe/London', currency: 'GBP' }), 'Europe/London');
  assert.equal(venueTimeZoneFor({ timezone: 'America/Chicago', currency: 'USD' }), 'America/Chicago');
  assert.equal(venueTimeZoneFor({ timezone: null, currency: 'USD' }), 'America/New_York');
  assert.equal(venueTimeZoneFor({ timezone: 'Not/AZone', currency: 'usd' }), 'America/New_York');
  assert.equal(venueTimeZoneFor({ timezone: '', currency: 'GBP' }), 'Europe/London');
  assert.equal(venueTimeZoneFor({ currency: 'EUR' }), 'Europe/London');
  assert.equal(venueTimeZoneFor(null), 'Europe/London');
  assert.equal(isValidTimeZone('Europe/London'), true);
  assert.equal(isValidTimeZone('Nope/Nowhere'), false);
  assert.equal(isValidTimeZone(42), false);
});

test('the statement opens on the venue month, not the London month', () => {
  // 01:30 UTC on 1 Oct is 21:30 on 30 Sep in New York.
  const now = new Date('2026-10-01T01:30:00Z');
  assert.equal(venueCurrentMonth('America/New_York', now), '2026-09');
  assert.equal(venueCurrentMonth('Europe/London', now), '2026-10');
  assert.equal(venueCurrentMonth('Nope/Nowhere', now), '2026-10');
});

test('a statement month runs venue midnight to venue midnight, across clock changes', () => {
  assert.deepEqual(venueMonthBoundsIso('2026-09', 'Europe/London'), { fromIso: '2026-08-31T23:00:00.000Z', toIso: '2026-09-30T23:00:00.000Z' });
  // October: starts in summer time, ends in winter time
  assert.deepEqual(venueMonthBoundsIso('2026-10', 'Europe/London'), { fromIso: '2026-09-30T23:00:00.000Z', toIso: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(venueMonthBoundsIso('2026-12', 'Europe/London'), { fromIso: '2026-12-01T00:00:00.000Z', toIso: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(venueMonthBoundsIso('2026-03', 'Europe/London'), { fromIso: '2026-03-01T00:00:00.000Z', toIso: '2026-03-31T23:00:00.000Z' });
  assert.deepEqual(venueMonthBoundsIso('2026-09', 'America/New_York'), { fromIso: '2026-09-01T04:00:00.000Z', toIso: '2026-10-01T04:00:00.000Z' });
  assert.deepEqual(venueMonthBoundsIso('2026-11', 'America/New_York'), { fromIso: '2026-11-01T04:00:00.000Z', toIso: '2026-12-01T05:00:00.000Z' });
  // a bad zone is London, a bad month is null
  assert.deepEqual(venueMonthBoundsIso('2026-09', 'Nope/Nowhere'), venueMonthBoundsIso('2026-09', 'Europe/London'));
  assert.equal(venueMonthBoundsIso('2026-13', 'Europe/London'), null);
  assert.equal(venueMonthBoundsIso('', 'Europe/London'), null);
});

// ── THE TWO COPIES AGREE ─────────────────────────────────────────────────────
const TS_MIRROR = '../../../supabase/functions/_shared/venueFees.ts';
test('TS mirror: every export answers exactly as the JS copy', async (t) => {
  // Skip ONLY when this node cannot strip types at all. Any other import
  // error (a syntax break in the mirror) fails the test.
  if (!process.features?.typescript) { t.skip('this node cannot strip TypeScript types'); return; }
  const ts = await import(TS_MIRROR);
  const jsNames = Object.keys(jsModule).sort();
  const tsNames = Object.keys(ts).filter((k) => typeof ts[k] !== 'undefined').sort();
  assert.deepEqual(tsNames, jsNames, 'the two copies export the same names');
  for (const k of jsNames) {
    if (typeof jsModule[k] !== 'function') assert.deepEqual(ts[k], jsModule[k], `constant ${k}`);
  }
  const amounts = [0, 1, 100, 250, 999, 12345, '250', null];
  const refunds = [0, 1, 50, 125, 250, 400, null, '125'];
  const commissions = [0, 5, 6, 7, 13, null, undefined, '7', 'x'];
  const events = [
    { success: true, last_event_code: 'AUTHORISATION' },
    { success: true, last_event_code: 'CANCELLATION' },
    { success: false, last_event_code: 'AUTHORISATION' },
    { success: true, last_event_code: 'REFUND' },
    { success: true, last_event_code: 'CAPTURE_FAILED' },
    { success: true, last_event_code: 'CAPTURE_FAILED', applied_mods: ['CAPTURE:Q:true'] },
    { success: true, last_event_code: 'AUTHORISATION', capture_required: true },
    { success: true, last_event_code: 'CAPTURE', capture_required: true, captured_at: 'x', captured_minor: 250 },
    { success: true, last_event_code: 'CAPTURE', capture_required: true, captured_at: 'x', last_mod_code: 'CAPTURE', last_mod_ok: 'true', last_mod_amount: '100' },
  ];
  const rows = [];
  for (const amount_minor of amounts) {
    for (const amount_refunded_minor of refunds) {
      for (const commission_minor of commissions) {
        for (const ev of events) {
          const r = { amount_minor, amount_refunded_minor, commission_minor, ...ev };
          rows.push(r);
          assert.equal(ts.hasSuccessfulCapture(r), hasSuccessfulCapture(r));
          assert.equal(ts.isUncapturedPayment(r), isUncapturedPayment(r));
          assert.equal(ts.isCountedPayment(r), isCountedPayment(r));
          assert.equal(ts.capturedMinorFor(r), capturedMinorFor(r));
          assert.equal(ts.venueFeeFor(r), venueFeeFor(r));
          assert.equal(ts.venueReceivesFor(r), venueReceivesFor(r));
          for (const line_type of ['Settled', 'Refunded', 'RefundedReversed', 'Chargeback', 'Fee']) {
            for (const gross_minor of [amount_minor, -125, 125]) {
              const line = { line_type, gross_minor };
              assert.deepEqual(ts.venuePayoutLine(line, r), venuePayoutLine(line, r));
            }
          }
        }
      }
    }
  }
  assert.deepEqual(ts.summarizeVenueFees(rows), summarizeVenueFees(rows));
  const lines = rows.slice(0, 300).map((r, i) => venuePayoutLine({ line_type: ['Settled', 'Refunded', 'Fee'][i % 3], gross_minor: r.amount_minor }, r));
  assert.deepEqual(ts.summarizeVenuePayout(lines), summarizeVenuePayout(lines));
  for (const live of [true, false, null, undefined, 'true']) {
    for (const env of ['live', 'test', 'LIVE', null]) {
      for (const inc of [true, false, 'true', undefined]) {
        assert.equal(ts.isVisiblePayment({ live }, env, inc), isVisiblePayment({ live }, env, inc));
      }
    }
  }
  for (const loc of [{ timezone: 'Europe/London' }, { timezone: 'x', currency: 'USD' }, { currency: 'GBP' }, null, { timezone: 'America/Chicago', currency: 'USD' }]) {
    assert.equal(ts.venueTimeZoneFor(loc), venueTimeZoneFor(loc));
  }
  for (const tz of ['Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'x', null]) {
    assert.equal(ts.isValidTimeZone(tz), isValidTimeZone(tz));
    for (const now of ['2026-10-01T01:30:00Z', '2026-12-31T23:59:00Z', '2026-06-15T12:00:00Z']) {
      assert.equal(ts.venueCurrentMonth(tz, new Date(now)), venueCurrentMonth(tz, new Date(now)));
    }
    for (const month of ['2026-01', '2026-03', '2026-04', '2026-10', '2026-11', '2026-12', 'bad']) {
      assert.deepEqual(ts.venueMonthBoundsIso(month, tz), venueMonthBoundsIso(month, tz));
    }
  }
});
