/**
 * preorderChoicesParity.test.js — the pre-order choice rules exist twice
 * because Deno cannot import from src/: supabase/functions/_shared/preorderChoices.js
 * (booking-widget validates every guest pick) and src/lib/bookings/preorderChoices.js
 * (the booking page and the host stand). If they drift, the page could offer an
 * option the server silently drops.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as src from './preorderChoices.js';
import * as copy from '../../../supabase/functions/_shared/preorderChoices.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

test('PARITY: the two files are byte-identical', () => {
  const a = readFileSync(here('./preorderChoices.js'), 'utf8');
  const b = readFileSync(here('../../../supabase/functions/_shared/preorderChoices.js'), 'utf8');
  assert.equal(a, b, 'copy src/lib/bookings/preorderChoices.js over supabase/functions/_shared/preorderChoices.js (or back)');
});

test('PARITY: same exports and same answers', () => {
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(src).sort());
  const rows = [
    { id: 'm-1', name: 'Ribeye', assigned_modifier_groups: ['g-1'] },
    { id: 'm-1a', name: '8oz', parent_id: 'm-1' },
  ];
  const groups = [{ id: 'g-1', name: 'Sauce', options: [{ id: 'o-1', name: 'Pepper', price: 2 }] }];
  const args = { lineItemId: 'm-1', variantItemId: 'm-1a', rows, groups, mods: [{ id: 'o-1', price: 0 }] };
  assert.deepEqual(copy.sanitiseChoice(args), src.sanitiseChoice(args));
  assert.equal(copy.itemNeedsSheetReturn(rows[0], rows), src.itemNeedsSheetReturn(rows[0], rows));
});
