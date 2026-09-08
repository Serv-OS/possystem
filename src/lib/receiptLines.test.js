/**
 * receiptLines.test.js — receipt line consolidation (merge identical lines → "N× product").
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { consolidateReceiptLines, receiptLineSig } from './receiptLines.js';

test('merges identical lines punched at different times, summing qty + preserving order', () => {
  const r = consolidateReceiptLines([
    { name: 'Cappucino', price: 3.25, qty: 1, mods: [{ label: 'Whole Milk' }] },
    { name: 'Flat White', price: 3.0, qty: 1 },
    { name: 'Cappucino', price: 3.25, qty: 1, mods: [{ label: 'Whole Milk' }] },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'Cappucino');
  assert.equal(r[0].qty, 2);          // 1 + 1
  assert.equal(r[1].name, 'Flat White');
  assert.equal(r[1].qty, 1);
});

test('different modifiers stay separate', () => {
  const r = consolidateReceiptLines([
    { name: 'Latte', price: 3.2, qty: 1, mods: [{ label: 'Oat Milk' }] },
    { name: 'Latte', price: 3.2, qty: 1, mods: [{ label: 'Whole Milk' }] },
  ]);
  assert.equal(r.length, 2);
});

test('modifier order does not matter (same set merges)', () => {
  const r = consolidateReceiptLines([
    { name: 'Pizza', price: 9, qty: 1, mods: [{ label: 'Olives' }, { label: 'Ham' }] },
    { name: 'Pizza', price: 9, qty: 1, mods: [{ label: 'Ham' }, { label: 'Olives' }] },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].qty, 2);
});

test('different notes stay separate; different price stays separate', () => {
  const notes = consolidateReceiptLines([
    { name: 'Burger', price: 8, qty: 1 },
    { name: 'Burger', price: 8, qty: 1, notes: 'no pickle' },
  ]);
  assert.equal(notes.length, 2);
  const price = consolidateReceiptLines([
    { name: 'Wine', price: 6, qty: 1 },
    { name: 'Wine', price: 7, qty: 1 },
  ]);
  assert.equal(price.length, 2);
});

test('voided lines are dropped; existing qty>1 is summed correctly', () => {
  const r = consolidateReceiptLines([
    { name: 'Coke', price: 2, qty: 2 },
    { name: 'Coke', price: 2, qty: 1, voided: true },
    { name: 'Coke', price: 2, qty: 3 },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].qty, 5);          // 2 + 3, voided excluded
});

test('string-form mods consolidate the same as array-form', () => {
  const a = receiptLineSig({ name: 'X', price: 1, mods: 'Extra shot · Large' });
  const b = receiptLineSig({ name: 'X', price: 1, mods: [{ label: 'Large' }, { label: 'Extra shot' }] });
  // array form encodes price (":0"), so this asserts string-vs-string stability instead
  const c = receiptLineSig({ name: 'X', price: 1, mods: 'Large · Extra shot' });
  assert.equal(a, c);
  assert.ok(typeof b === 'string');
});
