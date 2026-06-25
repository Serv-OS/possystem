/**
 * status.test.js — Uber → ServOS lifecycle mapping. Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapUberStatus, isTerminalStatus, statusLabel } from './status.js';

test('classic Uber statuses map to the ServOS lifecycle', () => {
  assert.equal(mapUberStatus('pending'), 'pending');
  assert.equal(mapUberStatus('pickup'), 'pickup');
  assert.equal(mapUberStatus('pickup_complete'), 'dropoff');
  assert.equal(mapUberStatus('dropoff'), 'dropoff');
  assert.equal(mapUberStatus('delivered'), 'delivered');
  assert.equal(mapUberStatus('canceled'), 'canceled');
  assert.equal(mapUberStatus('returned'), 'returned');
});

test('eats / courier-trip codes + case-insensitivity', () => {
  assert.equal(mapUberStatus('EN_ROUTE_TO_PICKUP'), 'pickup');
  assert.equal(mapUberStatus('Arrived_At_Dropoff'), 'dropoff');
  assert.equal(mapUberStatus('completed'), 'delivered');
  assert.equal(mapUberStatus('failed'), 'canceled');
});

test('unknown / empty → pending (safe default)', () => {
  assert.equal(mapUberStatus('something_new'), 'pending');
  assert.equal(mapUberStatus(''), 'pending');
  assert.equal(mapUberStatus(null), 'pending');
});

test('terminal detection', () => {
  assert.equal(isTerminalStatus('delivered'), true);
  assert.equal(isTerminalStatus('canceled'), true);
  assert.equal(isTerminalStatus('returned'), true);
  assert.equal(isTerminalStatus('pickup'), false);
  assert.equal(isTerminalStatus('pending'), false);
});

test('labels exist for every lifecycle state', () => {
  for (const s of ['pending', 'pickup', 'dropoff', 'delivered', 'canceled', 'returned']) {
    assert.equal(typeof statusLabel(s), 'string');
    assert.ok(statusLabel(s).length > 0);
  }
});
