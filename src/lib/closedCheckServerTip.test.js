/**
 * closedCheckServerTip.test.js - which realtime closed_checks UPDATEs may move a till's
 * copy of the money (serverTipChanged / serverTipFields in closedCheckRefundFields.js).
 *
 * Two server writers change money on a closed check after it closed: US tip on the printed
 * receipt (a payment_intents leg with a `capture` key, v5.7.5) and the reader tip heal (a card
 * tender with `tip_added_at`, v5.11.16). Any other UPDATE (a refund) must keep the old merge:
 * refunds and status only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { serverTipChanged, serverTipFields } from './closedCheckRefundFields.js';

test('capture legs: unchanged behaviour (legs, tip, total)', () => {
  const row = { tip: 3, total: 38, payment_intents: [{ id: 'P', amountMinor: 3800, capture: 'captured' }], tenders: [{ method: 'card', amount: 35, tip: 0 }] };
  assert.equal(serverTipChanged(row), true);
  assert.deepEqual(serverTipFields(row), { paymentIntents: row.payment_intents, tip: 3, total: 38 });
});

test('a tender with tip_added_at: tenders, tip, total (and the legs when the row has them)', () => {
  const tenders = [{ method: 'card', amount: 7.25, tip: 0.72, psp_ref: 'TX', tip_added_at: '2026-09-30T08:00:00Z' }];
  const row = { tip: 0.72, total: 7.97, payment_intents: null, tenders };
  assert.equal(serverTipChanged(row), true);
  assert.deepEqual(serverTipFields(row), { tenders, tip: 0.72, total: 7.97 });
  const withLegs = { ...row, payment_intents: [{ id: 'TX', amountMinor: 797 }] };
  assert.deepEqual(serverTipFields(withLegs), { paymentIntents: withLegs.payment_intents, tenders, tip: 0.72, total: 7.97 });
});

test('a plain refund row changes nothing but what it always did', () => {
  const row = { tip: 0, total: 7.25, status: 'refunded', refunds: [{ amount: 7.25 }], payment_intents: [{ id: 'TX', amountMinor: 725 }], tenders: [{ method: 'card', amount: 7.25, tip: 0, psp_ref: 'TX' }] };
  assert.equal(serverTipChanged(row), false);
  assert.deepEqual(serverTipFields(row), {});
  assert.deepEqual(serverTipFields(null), {});
  assert.deepEqual(serverTipFields({ tenders: null, payment_intents: null }), {});
});

test('realtime merges through serverTipFields on the closed_checks UPDATE', () => {
  const src = readFileSync(new URL('./realtime.js', import.meta.url), 'utf8');
  // 8 Oct 2026: closedCheckTaxFields rides in the same import (every copy carries the VAT booked).
  assert.match(src, /import \{ closedCheckRefundFields, closedCheckTaxFields, serverTipFields \} from '\.\/closedCheckRefundFields'/);
  assert.match(src, /\.\.\.serverTipFields\(check\),/);
});
