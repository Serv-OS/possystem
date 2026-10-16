// noShowChargeParity.test.js: the no show charge rules exist twice because Deno cannot import
// from src/: supabase/functions/_shared/noShowCharge.js (booking-charge) and
// src/lib/bookings/noShowCharge.js (host stand, Back Office). If they drift, the stand could
// offer a charge the server refuses, or name a check the server never wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as src from './noShowCharge.js';
import * as copy from '../../../supabase/functions/_shared/noShowCharge.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

test('PARITY: the two files are byte identical', () => {
  const a = readFileSync(here('./noShowCharge.js'), 'utf8');
  const b = readFileSync(here('../../../supabase/functions/_shared/noShowCharge.js'), 'utf8');
  assert.equal(a, b, 'copy supabase/functions/_shared/noShowCharge.js over src/lib/bookings/noShowCharge.js (or back)');
});

test('PARITY: same exports and the same check ids', () => {
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(src).sort());
  assert.deepEqual(copy.chargeCheckIds('bk-9', 2), src.chargeCheckIds('bk-9', 2));
});
