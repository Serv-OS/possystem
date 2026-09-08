/**
 * quote.test.js — distance/radius, Uber quote normalisation (both endpoint families),
 * staleness. Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { haversineMiles, withinRadiusMiles, normalizeUberQuote, isQuoteStale, toEpochMs } from './quote.js';

test('haversineMiles: ~known distance + null on missing coords', () => {
  // London Bridge → Big Ben ≈ 1.4 miles
  const d = haversineMiles({ lat: 51.5079, lng: -0.0877 }, { lat: 51.5007, lng: -0.1246 });
  assert.ok(d > 1.4 && d < 1.8, `expected ~1.6mi, got ${d}`);
  assert.equal(haversineMiles({ lat: 1, lng: 1 }, null), null);
  assert.equal(haversineMiles({ lat: 1 }, { lat: 2, lng: 2 }), null);
});

test('withinRadiusMiles: inclusive bound; unknown distance is NOT within', () => {
  assert.equal(withinRadiusMiles(2.9, 3), true);
  assert.equal(withinRadiusMiles(3, 3), true);
  assert.equal(withinRadiusMiles(3.1, 3), false);
  assert.equal(withinRadiusMiles(null, 3), false);
});

test('normalizeUberQuote: classic /delivery_quotes shape', () => {
  const now = 1_700_000_000_000;
  const q = normalizeUberQuote(
    { id: 'qt_abc', fee: 480, currency: 'gbp', dropoff_eta: new Date(now + 32 * 60000).toISOString(), expires: new Date(now + 15 * 60000).toISOString() },
    now,
  );
  assert.equal(q.quoteId, 'qt_abc');
  assert.equal(q.feeMinor, 480);
  assert.equal(q.currency, 'GBP');
  assert.equal(q.etaMinutes, 32);
  assert.equal(q.expiresAtMs, now + 15 * 60000);
});

test('normalizeUberQuote: eats /estimates shape (estimate_id + delivery_fee.total + etd ms)', () => {
  const now = 1_700_000_000_000;
  const q = normalizeUberQuote(
    { estimate_id: 'est_1', delivery_fee: { total: 555, currency_code: 'GBP' }, etd: now + 25 * 60000, expires_at: now + 15 * 60000 },
    now,
  );
  assert.equal(q.quoteId, 'est_1');
  assert.equal(q.feeMinor, 555);
  assert.equal(q.currency, 'GBP');
  assert.equal(q.etaMinutes, 25);
  assert.equal(q.expiresAtMs, now + 15 * 60000);
});

test('normalizeUberQuote: unusable payload → null', () => {
  assert.equal(normalizeUberQuote(null), null);
  assert.equal(normalizeUberQuote({ nope: true }), null);
});

test('toEpochMs: ms passthrough, seconds upscaled, ISO parsed', () => {
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs('2023-11-14T22:13:20.000Z'), Date.parse('2023-11-14T22:13:20.000Z'));
  assert.equal(toEpochMs(null), null);
});

test('isQuoteStale: expired/near-expiry/null are stale; fresh is not', () => {
  const now = 1_700_000_000_000;
  assert.equal(isQuoteStale(now - 1, now), true);          // expired
  assert.equal(isQuoteStale(now + 10_000, now), true);     // within 30s margin
  assert.equal(isQuoteStale(now + 5 * 60000, now), false); // 5 min left
  assert.equal(isQuoteStale(null, now), true);             // unknown → stale
});
