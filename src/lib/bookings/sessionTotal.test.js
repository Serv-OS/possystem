/**
 * sessionTotal.test.js — the host stand Floor card total (10 Sep 2026 review).
 * A till line's price already includes its option prices, so the total is
 * price × qty, never price plus the mods again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionTotal } from './sessionTotal.js';

test('a line with paid options is not double counted', () => {
  const session = { items: [
    { name: 'Ribeye · 12oz', price: 38.5, qty: 1, mods: [{ name: 'Peppercorn sauce', price: 2.5 }] },
    { name: 'Chips', price: 4, qty: 2, mods: [] },
  ] };
  assert.equal(sessionTotal(session), 46.5);
});

test('missing qty is one, bad prices are zero, no session is zero', () => {
  assert.equal(sessionTotal({ items: [{ price: 5 }, { price: 'x', qty: 3 }] }), 5);
  assert.equal(sessionTotal(null), 0);
  assert.equal(sessionTotal({}), 0);
});
