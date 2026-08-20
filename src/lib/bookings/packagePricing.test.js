/**
 * packagePricing.test.js — the v5.7.21 pricing decision table
 * (model × line type × price_override). Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { packageItemsFor, packageLinePrice } from './packagePricing.js';

const MENU = [
  { id: 'm-steak', name: 'Ribeye', price: 32, allergens: [] },
  { id: 'm-fish', name: 'Sea bass', price: 26, allergens: ['fish'] },
  { id: 'm-fizz', name: 'Prosecco', price: 9, allergens: [] },
];

const L = (over = {}) => ({
  id: `l-${Math.random().toString(36).slice(2, 6)}`,
  itemId: null, displayName: 'Line', qtyPerCover: 1, course: 1,
  priceOverride: null, isPreorderChoice: false, ...over,
});

const pkg = (paymentModel, lines) => ({ id: 'pk-1', name: 'Test', paymentModel, lines });

// ── packageLinePrice: the table itself ───────────────────────────────────────
test('prepay: null and 0 overrides are included (0.00); >0 is an explicit upcharge', () => {
  assert.equal(packageLinePrice('prepay', null, 32), 0);
  assert.equal(packageLinePrice('prepay', 0, 32), 0);
  assert.equal(packageLinePrice('prepay', 5, 32), 5);
});

test('deposit: null inherits the live menu price, 0 is included, >0 overrides', () => {
  assert.equal(packageLinePrice('deposit', null, 32), 32);
  assert.equal(packageLinePrice('deposit', 0, 32), 0);
  assert.equal(packageLinePrice('deposit', 12, 32), 12);
  assert.equal(packageLinePrice('deposit', null, undefined), 0); // no menu match → 0, never NaN
});

// ── fixed lines ──────────────────────────────────────────────────────────────
test('prepay fixed lines land at 0.00 even with a blank override that would inherit £32', () => {
  const items = packageItemsFor({
    pkg: pkg('prepay', [L({ itemId: 'm-steak', displayName: 'Ribeye' })]),
    covers: 4, menuItems: MENU,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].price, 0);
  assert.equal(items[0].qty, 4); // qty_per_cover × covers
});

test('deposit fixed lines inherit the live menu price', () => {
  const items = packageItemsFor({
    pkg: pkg('deposit', [L({ itemId: 'm-fizz', displayName: 'Prosecco', qtyPerCover: 1 })]),
    covers: 2, menuItems: MENU,
  });
  assert.equal(items[0].price, 9);
  assert.equal(items[0].qty, 2);
});

// ── choice lines never auto-materialise ──────────────────────────────────────
test('choice lines never land on the tab, with or without preorders', () => {
  const p = pkg('prepay', [
    L({ itemId: 'm-fizz', displayName: 'Prosecco', course: 0 }),
    L({ itemId: 'm-steak', displayName: 'Ribeye', isPreorderChoice: true }),
    L({ itemId: 'm-fish', displayName: 'Sea bass', isPreorderChoice: true }),
  ]);
  const noPicks = packageItemsFor({ pkg: p, covers: 2, menuItems: MENU });
  assert.equal(noPicks.length, 1); // fixed fizz only — options do NOT load for everyone
  assert.equal(noPicks[0].itemId, 'm-fizz');

  const withPicks = packageItemsFor({
    pkg: p, covers: 2, menuItems: MENU,
    preorders: [{ id: 'r1', seat: 1, itemId: 'm-steak', displayName: 'Ribeye', course: 1 }],
  });
  assert.equal(withPicks.length, 2); // fizz + the one actual pick
});

// ── picks ────────────────────────────────────────────────────────────────────
test('prepay pick matched to its choice line prices at 0.00 (Provo: was £32 menu price)', () => {
  const p = pkg('prepay', [L({ itemId: 'm-steak', displayName: 'Ribeye', isPreorderChoice: true })]);
  const [pick] = packageItemsFor({
    pkg: p, covers: 1, menuItems: MENU,
    preorders: [{ id: 'r1', seat: 1, guestName: 'Ana', itemId: 'm-steak', displayName: 'Ribeye', course: 1 }],
  });
  assert.equal(pick.price, 0);
  assert.match(pick.notes, /Seat 1/);
});

test('a pick matches by display name when the line has no itemId link', () => {
  const p = pkg('prepay', [L({ displayName: 'Sea bass', isPreorderChoice: true, priceOverride: 4 })]);
  const [pick] = packageItemsFor({
    pkg: p, covers: 1, menuItems: MENU,
    preorders: [{ id: 'r1', seat: 1, itemId: null, displayName: 'sea bass', course: 2 }],
  });
  assert.equal(pick.price, 4); // matched → the explicit upcharge, not menu £26
});

test('an UNMATCHED prepay pick falls to 0.00, never the menu price', () => {
  const p = pkg('prepay', [L({ itemId: 'm-steak', displayName: 'Ribeye', isPreorderChoice: true })]);
  const [pick] = packageItemsFor({
    pkg: p, covers: 1, menuItems: MENU,
    preorders: [{ id: 'r1', seat: 1, itemId: 'm-fish', displayName: 'Off-menu special', course: 2 }],
  });
  assert.equal(pick.price, 0);
});

test('an unmatched deposit pick prices at the live menu price', () => {
  const p = pkg('deposit', [L({ itemId: 'm-steak', displayName: 'Ribeye', isPreorderChoice: true })]);
  const [pick] = packageItemsFor({
    pkg: p, covers: 1, menuItems: MENU,
    preorders: [{ id: 'r1', seat: 1, itemId: 'm-fish', displayName: 'Sea bass special', course: 2 }],
  });
  assert.equal(pick.price, 26);
});

// ── the v5.7.23 free-food gate: prepay zero-pricing needs CAPTURED money ─────
test('prepay WITHOUT captured credit prices like deposit (unpaid party pays real prices)', () => {
  const p = pkg('prepay', [
    L({ itemId: 'm-fizz', displayName: 'Prosecco', course: 0 }),
    L({ itemId: 'm-steak', displayName: 'Ribeye', isPreorderChoice: true }),
  ]);
  const items = packageItemsFor({
    pkg: p, covers: 2, menuItems: MENU, prepayCaptured: false,
    preorders: [{ id: 'r1', seat: 1, itemId: 'm-steak', displayName: 'Ribeye', course: 1 }],
  });
  const fizz = items.find((i) => i.itemId === 'm-fizz');
  const pick = items.find((i) => i.itemId === 'm-steak');
  assert.equal(fizz.price, 9);   // live menu price, not 0.00
  assert.equal(pick.price, 32);  // live menu price, not 0.00
});

test('prepay WITH captured credit keeps the 0.00 pricing (flag defaults to captured)', () => {
  const p = pkg('prepay', [L({ itemId: 'm-steak', displayName: 'Ribeye' })]);
  const [explicit] = packageItemsFor({ pkg: p, covers: 1, menuItems: MENU, prepayCaptured: true });
  const [defaulted] = packageItemsFor({ pkg: p, covers: 1, menuItems: MENU });
  assert.equal(explicit.price, 0);
  assert.equal(defaulted.price, 0);
});

test('an unmatched pick on an UNPAID prepay booking prices at the menu price', () => {
  const p = pkg('prepay', [L({ itemId: 'm-steak', displayName: 'Ribeye', isPreorderChoice: true })]);
  const [pick] = packageItemsFor({
    pkg: p, covers: 1, menuItems: MENU, prepayCaptured: false,
    preorders: [{ id: 'r1', seat: 1, itemId: 'm-fish', displayName: 'Sea bass special', course: 2 }],
  });
  assert.equal(pick.price, 26);
});

test('the gate never touches deposit packages', () => {
  const p = pkg('deposit', [L({ itemId: 'm-fizz', displayName: 'Prosecco' })]);
  const [a] = packageItemsFor({ pkg: p, covers: 1, menuItems: MENU, prepayCaptured: false });
  const [b] = packageItemsFor({ pkg: p, covers: 1, menuItems: MENU, prepayCaptured: true });
  assert.equal(a.price, 9);
  assert.equal(b.price, 9);
});

test('prepay upcharge (override > 0) survives onto the pick', () => {
  const p = pkg('prepay', [L({ itemId: 'm-steak', displayName: 'Ribeye', isPreorderChoice: true, priceOverride: 8 })]);
  const [pick] = packageItemsFor({
    pkg: p, covers: 1, menuItems: MENU,
    preorders: [{ id: 'r1', seat: 2, itemId: 'm-steak', displayName: 'Ribeye', course: 1 }],
  });
  assert.equal(pick.price, 8);
});
