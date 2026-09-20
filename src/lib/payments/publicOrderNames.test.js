// src/lib/payments/publicOrderNames.test.js
//
// Peter, 20 Sep 2026, live: an online order for "Americano - Small" reached the kitchen as
// just "Small". The server prices each line from the menu by id and puts the menu's own words
// on it, so a doctored page cannot relabel a cheap item as an expensive one. For a SIZE the
// menu row is called "Small" and its kitchen_name and receipt_name default to the same word,
// so the line lost its product name. The closed check was right all along; the kitchen ticket
// and the Orders Hub line were not.
//
// The rule the whole app uses is src/lib/itemDisplay.js: an override counts ONLY when it
// differs from that row's own name. These tests pin that rule in the SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { kitchenOverride, receiptOverride } from '../itemDisplay.js';

const SQL = readFileSync(new URL('../../../supabase/migrations/20260921b_OPS_public_order_line_names.sql', import.meta.url), 'utf8');

/** The SQL's rule, mirrored: what the server ends up putting on the line. */
function serverLineNames({ row, pageKitchen, pageReceipt, acceptedNames }) {
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const accepted = acceptedNames.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  const menuKitchen = row.kitchen_name && !same(row.kitchen_name, row.name) ? row.kitchen_name : null;
  const menuReceipt = row.receipt_name && !same(row.receipt_name, row.name) ? row.receipt_name : null;
  const keepK = pageKitchen === menuKitchen || accepted.includes(String(pageKitchen || '').toLowerCase());
  const keepR = pageReceipt === menuReceipt || accepted.includes(String(pageReceipt || '').toLowerCase());
  return {
    kitchenName: keepK ? pageKitchen : menuKitchen,
    receiptName: keepR ? pageReceipt : menuReceipt,
  };
}

test('a size keeps its product name on the kitchen ticket (Peter, 20 Sep)', () => {
  // The real rows behind OL-0NWKJ at Provo.
  const size = { name: 'Small', menu_name: 'Small', kitchen_name: 'Small', receipt_name: 'Small' };
  const out = serverLineNames({
    row: size,
    pageKitchen: 'Americano — Small',
    pageReceipt: 'Americano — Small',
    acceptedNames: ['Small', 'Americano — Small'],
  });
  assert.equal(out.kitchenName, 'Americano — Small', 'the kitchen sees the product, not just the size');
  assert.equal(out.receiptName, 'Americano — Small');
});

test('a real override still wins, so an operator who typed one keeps it', () => {
  const row = { name: 'Small', kitchen_name: 'AMER SM', receipt_name: 'Americano small' };
  const out = serverLineNames({
    row,
    pageKitchen: 'Something The Page Made Up',
    pageReceipt: 'Also Made Up',
    acceptedNames: ['Small', 'Americano — Small'],
  });
  assert.equal(out.kitchenName, 'AMER SM');
  assert.equal(out.receiptName, 'Americano small');
});

test('the mirror agrees with the app resolver it copies', () => {
  // itemDisplay is what every screen uses; the server must not disagree with it.
  assert.equal(kitchenOverride({ name: 'Small', kitchenName: 'Small' }), null, 'same word is not an override');
  assert.equal(kitchenOverride({ name: 'Small', kitchenName: 'AMER SM' }), 'AMER SM');
  assert.equal(receiptOverride({ name: 'Small', receiptName: 'Small' }), null);
  assert.equal(receiptOverride({ name: 'Small', receiptName: 'Americano small' }), 'Americano small');
});

test('the migration carries the rule, and the old one is gone', () => {
  assert.match(SQL, /v_k_menu/, 'the kitchen name is worked out first');
  assert.match(SQL, /v_r_menu/, 'and the receipt name');
  assert.match(SQL, /lower\(v_k_menu\) = lower\(btrim\(coalesce\(r\.name, ''\)\)\)/, 'same word as the row means no override');
  assert.doesNotMatch(SQL, /jsonb_build_object\('kitchenName', nullif\(r\.kitchen_name, ''\)\)/, 'the old rule is gone');
  // it refuses on a database that has not had the payment half, and checks itself
  assert.match(SQL, /The payment half \(20260919a2\) has not run/);
  assert.match(SQL, /Self test: the new naming rule is not in the function/);
  assert.match(SQL, /ROLL BACK/);
});
