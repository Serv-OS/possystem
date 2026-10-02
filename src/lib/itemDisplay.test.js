// src/lib/itemDisplay.test.js
//
// Peter, 2 Oct 2026, Coffee Boy Leeds, live: "it's not showing the product, just the size; this
// is back, the variant issue." QR order QR-FAUOB: the line was stored as
//   name "Mont Blanc — Big Boy", kitchenName "Big Boy"
// and the Orders screen, the kitchen screen and the docket all read kitchenName first.
//
// The 20 Sep fix (20260921b) taught the SERVER the override rule, but the page itself was
// sending the size row's raw kitchen_name ("Big Boy"), which the server accepts because it is
// one of the row's own names. These tests pin both halves: what the page puts on the line, and
// what staff screens show for a line that is already stored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { kitchenOverride, kitchenLineName, isSizeOnlyKitchenName } from './itemDisplay.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the live Leeds line shows the product and the size', () => {
  const line = { name: 'Mont Blanc — Big Boy', kitchenName: 'Big Boy', parentId: 'm-1789995447762_5c26956b' };
  assert.equal(isSizeOnlyKitchenName(line), true);
  assert.equal(kitchenLineName(line), 'Mont Blanc — Big Boy');
});

test('a line with no kitchen name shows its name, exactly as before', () => {
  assert.equal(kitchenLineName({ name: 'Latte — Big Boy ', kitchenName: null }), 'Latte — Big Boy ');
  assert.equal(kitchenLineName({ name: 'Tuna & Cheese Toastie' }), 'Tuna & Cheese Toastie');
});

test('a real kitchen name the venue typed still wins', () => {
  assert.equal(kitchenLineName({ name: 'Soup of the day', kitchenName: 'SOUP' }), 'SOUP');
  assert.equal(kitchenLineName({ name: 'Americano — Small', kitchenName: 'AMER SM' }), 'AMER SM');
  // a kitchen name that only happens to share a word is not the size at the end of the name
  assert.equal(kitchenLineName({ name: 'Big Boy Breakfast', kitchenName: 'Big Boy' }), 'Big Boy');
});

test('a name that is already full is never doubled', () => {
  assert.equal(kitchenLineName({ name: 'Mont Blanc — Big Boy', kitchenName: 'Mont Blanc — Big Boy' }), 'Mont Blanc — Big Boy');
  assert.equal(isSizeOnlyKitchenName({ name: 'Mont Blanc — Big Boy', kitchenName: 'Mont Blanc — Big Boy' }), false);
});

test('case, spaces and the database spelling do not matter', () => {
  assert.equal(kitchenLineName({ name: 'Latte — Big Boy ', kitchenName: ' big boy' }), 'Latte — Big Boy ');
  assert.equal(kitchenLineName({ name: 'Pepsi Max — Regular', kitchen_name: 'Regular' }), 'Pepsi Max — Regular');
  assert.equal(kitchenLineName(null), '');
  assert.equal(isSizeOnlyKitchenName(null), false);
});

test('the page puts the override on the line, never the raw column', () => {
  // What OnlineItemSheet hands to addToCart for a size: the size row, renamed "<product> — <size>".
  const size = { id: 'm-1789995489544_5c26956b', name: 'Big Boy', menu_name: 'Mont Blanc — Big Boy', kitchen_name: 'Big Boy', receipt_name: 'Big Boy' };
  assert.equal(kitchenOverride(size), null, 'the default kitchen name is not an override');
  assert.equal(kitchenOverride({ ...size, kitchen_name: 'MB BIG' }), 'MB BIG');
  const online = read('../surfaces/online/OnlineSurface.jsx');
  assert.ok(online.includes('kitchenName: kitchenOverride(item),'), 'online and QR basket lines use the override rule');
  assert.ok(!online.includes('kitchenName: item.kitchen_name || item.kitchenName || null'), 'the raw column is gone');
  const catering = read('../surfaces/catering/CateringSurface.jsx');
  assert.ok(catering.includes('kitchenName: kitchenOverride(item),'), 'catering basket lines too');
});

test('every staff screen that reads a channel line uses the one resolver', () => {
  const store = read('../store/index.js');
  // the kitchen screen ticket and the paper docket of an online, QR or kiosk order
  assert.ok(store.includes('name: kitchenLineName(i),'), 'kitchen screen ticket');
  assert.ok(store.includes('kitchenName: kitchenLineName(i),'), 'kitchen docket');
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.ok(hub.includes('{kitchenLineName(item)}'), 'the QR card on the Orders screen');
  assert.ok(!hub.includes('{item.kitchenName || item.name}'));
  assert.ok(!hub.includes('{item.kitchenName || item.receiptName || item.name}'));
});
