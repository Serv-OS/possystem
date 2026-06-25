/**
 * quoteService.test.js — orchestration over a mocked uber-direct edge fn:
 * normalises the raw quote + applies the surcharge policy, and handles the
 * unavailable/fallback/out-of-radius paths. Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDeliveryQuote } from './quoteService.js';

const NOW = 1_700_000_000_000;
const fakeInvoke = (resp) => async () => resp;

test('happy path: pass-through fee + normalised eta from a classic quote', async () => {
  const resp = {
    ok: true, available: true,
    raw: { id: 'qt1', fee: 480, currency: 'GBP', dropoff_eta: new Date(NOW + 30 * 60000).toISOString(), expires: new Date(NOW + 15 * 60000).toISOString() },
    policy: { mode: 'pass_through' }, currency: 'GBP', distanceMiles: 1.8, radiusMiles: 3, dropoff: { lat: 51.5, lng: -0.1 },
  };
  const r = await getDeliveryQuote({ opsLocationId: 'loc', dropoff: { postcode: 'SW1A 1AA' } }, { invoke: fakeInvoke(resp), now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.trueCostMinor, 480);
  assert.equal(r.customerFeeMinor, 480); // pass-through
  assert.equal(r.etaMinutes, 30);
  assert.equal(r.quoteId, 'qt1');
  assert.equal(r.distanceMiles, 1.8);
});

test('markup policy is applied to the live Uber fee', async () => {
  const resp = {
    ok: true, available: true,
    raw: { estimate_id: 'e1', delivery_fee: { total: 500, currency_code: 'GBP' }, etd: NOW + 20 * 60000, expires_at: NOW + 15 * 60000 },
    policy: { mode: 'markup', markupFixedMinor: 100 }, currency: 'GBP', distanceMiles: 2.2, radiusMiles: 3,
  };
  const r = await getDeliveryQuote({ opsLocationId: 'loc', dropoff: { postcode: 'X' }, orderSubtotalMinor: 2000 }, { invoke: fakeInvoke(resp), now: NOW });
  assert.equal(r.trueCostMinor, 500);
  assert.equal(r.customerFeeMinor, 600); // +£1 fixed
  assert.equal(r.marginMinor, 100);
});

test('out of radius → unavailable with reason, no fee', async () => {
  const resp = { ok: true, available: false, reason: 'out_of_radius', distanceMiles: 7.5, radiusMiles: 3 };
  const r = await getDeliveryQuote({ opsLocationId: 'loc', dropoff: { postcode: 'X' } }, { invoke: fakeInvoke(resp), now: NOW });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'out_of_radius');
  assert.equal(r.distanceMiles, 7.5);
});

test('fallback fee (creds not configured / Uber down) still yields a usable quote, flagged', async () => {
  const resp = { ok: true, available: true, fallback: true, raw: { fee: 480, currency: 'GBP' }, policy: { mode: 'pass_through' }, currency: 'GBP', distanceMiles: 1, radiusMiles: 3 };
  const r = await getDeliveryQuote({ opsLocationId: 'loc', dropoff: { postcode: 'X' } }, { invoke: fakeInvoke(resp), now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.fallback, true);
  assert.equal(r.customerFeeMinor, 480);
});

test('disabled venue → unavailable', async () => {
  const r = await getDeliveryQuote({ opsLocationId: 'loc', dropoff: {} }, { invoke: fakeInvoke({ ok: true, available: false, reason: 'disabled' }), now: NOW });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'disabled');
});

test('transport error degrades to unavailable, never throws', async () => {
  const r = await getDeliveryQuote({ opsLocationId: 'loc', dropoff: {} }, { invoke: async () => { throw new Error('boom'); }, now: NOW });
  assert.equal(r.available, false);
  assert.equal(r.reason, 'transport_error');
});
