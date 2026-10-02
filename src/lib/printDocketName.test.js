// src/lib/printDocketName.test.js
//
// Peter, 2 Oct 2026, Coffee Boy Leeds, live: "it's not showing the product, just the size; this
// is back, the variant issue." The paper docket had the mirror of it: every name was cut at 22
// characters, and on a size line the size is the END of the name, so a long drink printed the
// product and lost the size. 59 of the 118 size lines at Leeds are longer than 22 characters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { docketNameLines, buildKitchenTicketDoc } from './printDoc.js';

const textOf = (doc) => JSON.stringify(doc);

test('a name that fits prints exactly as before, on one line', () => {
  assert.deepEqual(docketNameLines('Mont Blanc — Big Boy'), ['MONT BLANC — BIG BOY']);   // 20 characters
  assert.deepEqual(docketNameLines('Fish'), ['FISH']);
  assert.deepEqual(docketNameLines('Latte — Big Boy'), ['LATTE — BIG BOY']);
  assert.deepEqual(docketNameLines(''), ['']);
  assert.deepEqual(docketNameLines(null), ['']);
  assert.deepEqual(docketNameLines('1234567890123456789012'), ['1234567890123456789012'], '22 exactly');
});

test('a long size line keeps its size: product, then the size on a second line', () => {
  assert.deepEqual(docketNameLines('Blueberry Iced Matcha — Big Boy'), ['BLUEBERRY ICED MATCHA', 'BIG BOY']);
  assert.deepEqual(docketNameLines('Blueberry Iced Matcha — Small Boy'), ['BLUEBERRY ICED MATCHA', 'SMALL BOY']);
  // a very long product is still cut at 22, the size is never lost
  assert.deepEqual(docketNameLines('Salted Caramel Hot Chocolate Deluxe — Big Boy'), ['SALTED CARAMEL HOT CHO', 'BIG BOY']);
  // only the LAST long dash is the size
  assert.deepEqual(docketNameLines('Ham — Cheese Toastie Special — Large'), ['HAM — CHEESE TOASTIE S', 'LARGE']);
});

test('a long name with no size is cut at 22, exactly as before', () => {
  assert.deepEqual(docketNameLines('Tuna & Cheese Toastie Meal Deal'), ['TUNA & CHEESE TOASTIE ']);
  assert.deepEqual(docketNameLines('A very long product name here — '), ['A VERY LONG PRODUCT NA'], 'a dash with nothing after it');
  assert.deepEqual(docketNameLines(' — Only a size but far too long to fit'), [' — ONLY A SIZE BUT FAR'], 'a dash with nothing before it');
});

test('the docket prints both lines in big print, the size before the mods', () => {
  const doc = buildKitchenTicketDoc({ table: 'Table T6', centreName: 'Drinks', sentAt: 0,
    items: [{ qty: 2, name: 'Blueberry Iced Matcha — Big Boy', kitchenName: 'Blueberry Iced Matcha — Big Boy', course: 1, fired: true, mods: ['Oat milk'] }] }, { cols: 42 });
  const t = textOf(doc);
  const product = t.indexOf('2x BLUEBERRY ICED MATCHA');
  const size = t.indexOf('  BIG BOY');
  const mod = t.indexOf('  Oat milk');
  assert.ok(product > 0 && size > product && mod > size, 'product, size, then the mod');
  assert.ok(!t.includes('BLUEBERRY ICED MATCHA —'), 'no dangling dash');
  // a short name: one line, no second line
  const short = textOf(buildKitchenTicketDoc({ table: 'Table T6', centreName: 'Drinks', sentAt: 0,
    items: [{ qty: 1, name: 'Mont Blanc — Big Boy', course: 1, fired: true }] }, { cols: 42 }));
  assert.ok(short.includes('MONT BLANC — BIG BOY') || short.includes('MONT BLANC — BIG BOY'));
  assert.ok(!short.includes('  BIG BOY'));
});
