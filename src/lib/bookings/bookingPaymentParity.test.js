/**
 * bookingPaymentParity.test.js — the payment gate rules exist twice because
 * Deno cannot import from src/: supabase/functions/_shared/bookingPayment.js
 * (booking-widget, adyen-webhook) and src/lib/bookings/bookingPayment.js (the
 * web app). If they drift, the Back Office could accept a package the widget
 * refuses, or the host stand could undo a no-show the server would call unpaid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as src from './bookingPayment.js';
import * as copy from '../../../supabase/functions/_shared/bookingPayment.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

test('PARITY: the two files are byte-identical', () => {
  const a = readFileSync(here('./bookingPayment.js'), 'utf8');
  const b = readFileSync(here('../../../supabase/functions/_shared/bookingPayment.js'), 'utf8');
  assert.equal(a, b, 'copy src/lib/bookings/bookingPayment.js over supabase/functions/_shared/bookingPayment.js (or back)');
});

test('PARITY: same exports and same answers', () => {
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(src).sort());
  const pkg = { payment_model: 'prepay', price: 120, price_unit: 'per_cover' };
  const rules = { card_capture_enabled: true, hold_per_cover: 20, card_capture_min_covers: 2 };
  for (const covers of [1, 2, 5]) {
    assert.deepEqual(copy.paymentDue({ covers, pkg, rules }), src.paymentDue({ covers, pkg, rules }));
    assert.deepEqual(copy.paymentDue({ covers, rules }), src.paymentDue({ covers, rules }));
  }
  assert.deepEqual(
    copy.promotionDecision({ status: 'expired', nextStatus: 'prepaid', tablesFree: false }),
    src.promotionDecision({ status: 'expired', nextStatus: 'prepaid', tablesFree: false }),
  );
});
