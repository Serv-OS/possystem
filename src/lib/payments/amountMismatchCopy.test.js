/**
 * amountMismatchCopy.test.js - what the till says when the card machine took a
 * different amount from the bill (src/lib/payments/amountMismatchCopy.js, v5.11.16).
 *
 * The old text said the check was "held until a manager checks it". It never was:
 * the reconciler books it at the bill amount (v5.5.866). Staff reading "held" might
 * take the card again (R3618, 29 Sep 2026).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { amountMismatchCopy, formatMinor, MISMATCH_WHERE } from './amountMismatchCopy.js';

const noDashes = (s) => assert.ok(!/[–—]/.test(s) && !/ - /.test(s), `dash in: ${s}`);

test('Adyen: both amounts, booked automatically, do not charge again, the tip sentence', () => {
  const c = amountMismatchCopy({ reportedMinor: 797, billMinor: 725, currency: 'GBP', processor: 'adyen' });
  assert.equal(c.title, 'Card amount differs from the bill');
  assert.equal(c.body,
    'The card machine took £7.97 and the bill was £7.25. The sale is recorded automatically at the bill amount, '
    + 'so do not take payment again. If the difference is a tip it is added to this sale by itself; otherwise a '
    + `manager is alerted in ${MISMATCH_WHERE}.`);
  assert.ok(!/held until a manager/i.test(c.body));
  noDashes(c.title); noDashes(c.body);
});

test('not Adyen: no promise of a tip being added by itself', () => {
  const c = amountMismatchCopy({ reportedMinor: 2200, billMinor: 2000, currency: 'GBP', processor: 'ryft' });
  assert.ok(c.body.includes('£22.00') && c.body.includes('£20.00'));
  assert.ok(c.body.includes('recorded automatically at the bill amount'));
  assert.ok(!/tip/i.test(c.body));
  noDashes(c.body);
});

test('the card machine took LESS than the bill: say what is still owed, never "do not take payment again"', () => {
  for (const processor of ['pax', 'ryft', 'adyen']) {
    const c = amountMismatchCopy({ reportedMinor: 500, billMinor: 725, currency: 'GBP', processor });
    assert.equal(c.title, 'Card amount differs from the bill');
    assert.equal(c.body,
      'The card machine took £5.00 and the bill was £7.25. £2.25 is still owed. Take it another way and tell a manager: '
      + `the sale is recorded at the bill amount as if the card paid it all, and a manager corrects it in ${MISMATCH_WHERE}.`);
    assert.ok(!/do not take payment again/i.test(c.body));
    assert.ok(!/tip/i.test(c.body), 'a short charge is never a tip');
    noDashes(c.body);
  }
});

test('no reported figure yet: a variant without figures', () => {
  const c = amountMismatchCopy({ reportedMinor: null, billMinor: 725, processor: 'adyen' });
  assert.ok(c.body.startsWith('The card machine took a different amount from the bill.'));
  assert.ok(!c.body.includes('£'));
  assert.ok(c.body.includes('do not take payment again'));
  noDashes(c.body);
  assert.ok(amountMismatchCopy().body.startsWith('The card machine took a different amount'));
});

test('the job currency is used, never a guess', () => {
  const c = amountMismatchCopy({ reportedMinor: 1100, billMinor: 1000, currency: 'USD', processor: 'adyen' });
  assert.ok(c.body.includes('$11.00') && c.body.includes('$10.00'));
  assert.equal(formatMinor(500, 'EUR'), '€5.00');
  assert.equal(formatMinor(123, 'CAD'), '1.23 CAD');
});

test('PaxTerminal shows this copy, and the old "held" text is gone', () => {
  const src = readFileSync(new URL('../../surfaces/PaxTerminal.jsx', import.meta.url), 'utf8');
  assert.ok(!/held until a manager/i.test(src));
  assert.match(src, /import \{ amountMismatchCopy \} from '\.\.\/lib\/payments\/amountMismatchCopy'/);
  assert.match(src, /mismatchCopy\.body/);
  // The bounded re-poll: primitive deps only (the v5.7.12 timer rule), 3 s for at most 20 s.
  assert.match(src, /\}, \[mismatchHeld, heldJobId\]\);/);
  assert.match(src, /MISMATCH_REPOLL_EVERY_MS = 3_000/);
  assert.match(src, /MISMATCH_REPOLL_LIMIT_MS = 20_000/);
});
