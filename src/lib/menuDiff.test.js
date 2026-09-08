import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMenuChange, diffMenuSnapshots, priceDelta } from './menuDiff.js';

const item = (id, price, extra = {}) => ({ id, name: `Item ${id}`, pricing: { base: price }, ...extra });
const snap = (items) => ({ menuItems: items });

test('no change → silent (null)', () => {
  const a = snap([item('1', 3), item('2', 5)]);
  const b = snap([item('1', 3), item('2', 5)]);
  assert.equal(describeMenuChange(a, b), null);
});

test('first push (no prior baseline) → silent', () => {
  assert.equal(describeMenuChange(null, snap([item('1', 3)])), null);
  assert.equal(describeMenuChange(snap([]), snap([item('1', 3)])), null);
});

test('base price change → one precise note', () => {
  const a = snap([item('1', 3.2, { name: 'Latte' })]);
  const b = snap([item('1', 3.5, { name: 'Latte' })]);
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '1 price updated');
  assert.equal(ev.body, 'Latte £3.20 → £3.50');
});

test('multiple price changes → count + list', () => {
  const a = snap([item('1', 3, { name: 'A' }), item('2', 5, { name: 'B' })]);
  const b = snap([item('1', 4, { name: 'A' }), item('2', 6, { name: 'B' })]);
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '2 prices updated');
  assert.equal(ev.body, 'A £3.00 → £4.00, B £5.00 → £6.00');
});

test('more than 4 price changes → "+N more"', () => {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const a = snap(ids.map(i => item(i, 1)));
  const b = snap(ids.map(i => item(i, 2)));
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '6 prices updated');
  assert.match(ev.body, /\+2 more$/);
});

test('new / removed / renamed items but NO price change → silent (operator chose price-only)', () => {
  const a = snap([item('1', 3, { name: 'Old' })]);
  const bAdded = snap([item('1', 3, { name: 'Old' }), item('2', 5)]);
  const bRemoved = snap([]);
  const bRenamed = snap([item('1', 3, { name: 'New name' })]);
  assert.equal(describeMenuChange(a, bAdded), null);
  assert.equal(describeMenuChange(a, bRemoved), null);
  assert.equal(describeMenuChange(a, bRenamed), null);
});

test('order-type override change (base unchanged) still counts as a price change', () => {
  const a = snap([item('1', 3, { name: 'Latte', pricing: { base: 3, takeaway: 2.5 } })]);
  const b = snap([item('1', 3, { name: 'Latte', pricing: { base: 3, takeaway: 2.8 } })]);
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '1 price updated');
  assert.match(ev.body, /takeaway/);
  assert.match(ev.body, /£2\.50 → £2\.80/);
});

test('archived item is treated as removed, not a price change', () => {
  const a = snap([item('1', 3), item('2', 5)]);
  const b = snap([item('1', 3), item('2', 5, { archived: true })]);
  const { removed, priceChanges } = diffMenuSnapshots(a, b);
  assert.equal(priceChanges.length, 0);
  assert.deepEqual(removed, ['Item 2']);
  assert.equal(describeMenuChange(a, b), null); // removal alone → silent
});

test('spacers are ignored entirely', () => {
  const a = snap([item('1', 3), { id: 's1', type: 'spacer' }]);
  const b = snap([item('1', 3), { id: 's1', type: 'spacer' }]);
  assert.equal(describeMenuChange(a, b), null);
});

test('price stored as string vs number is not a false positive', () => {
  const a = snap([item('1', 3.2)]);
  const b = snap([{ id: '1', name: 'Item 1', pricing: { base: '3.2' } }]);
  assert.equal(describeMenuChange(a, b), null);
});

test('string→different value is a real change', () => {
  const a = snap([{ id: '1', name: 'X', pricing: { base: '3.20' } }]);
  const b = snap([{ id: '1', name: 'X', pricing: { base: '3.60' } }]);
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '1 price updated');
});

test('item with legacy top-level price (no pricing object) diffs correctly', () => {
  const a = snap([{ id: '1', name: 'Bun', price: 2 }]);
  const b = snap([{ id: '1', name: 'Bun', price: 2.5 }]);
  const ev = describeMenuChange(a, b);
  assert.equal(ev.body, 'Bun £2.00 → £2.50');
});

test('priceDelta prefers base delta over override', () => {
  const p = { name: 'Z', pricing: { base: 3, takeaway: 2 } };
  const n = { name: 'Z', pricing: { base: 4, takeaway: 1 } };
  assert.equal(priceDelta(p, n), 'Z £3.00 → £4.00');
});

test('custom formatter is honoured (non-GBP)', () => {
  const a = snap([item('1', 3, { name: 'Taco' })]);
  const b = snap([item('1', 4, { name: 'Taco' })]);
  const ev = describeMenuChange(a, b, (x) => `$${x.toFixed(2)}`);
  assert.equal(ev.body, 'Taco $3.00 → $4.00');
});

// ── per-menu / per-channel pricing tiers (pricing.menus) ──────────────────────
test('per-menu tier price change is caught (base unchanged)', () => {
  const a = snap([{ id: '1', name: 'Pizza', pricing: { base: 9, menus: { m1: { all: 9 } } } }]);
  const b = snap([{ id: '1', name: 'Pizza', pricing: { base: 9, menus: { m1: { all: 11 } } } }]);
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '1 price updated');
  assert.match(ev.body, /Pizza \(menu price updated\)/);
});

test('adding a per-menu tier where none existed is a price change', () => {
  const a = snap([{ id: '1', name: 'Pizza', pricing: { base: 9, menus: {} } }]);
  const b = snap([{ id: '1', name: 'Pizza', pricing: { base: 9, menus: { m1: { all: 8 } } } }]);
  assert.equal(describeMenuChange(a, b).title, '1 price updated');
});

test('pricing.menus key order does not cause a false positive', () => {
  const a = snap([{ id: '1', name: 'P', pricing: { base: 9, menus: { m1: { all: 9, deliveroo: 11 } } } }]);
  const b = snap([{ id: '1', name: 'P', pricing: { base: 9, menus: { m1: { deliveroo: 11, all: 9 } } } }]);
  assert.equal(describeMenuChange(a, b), null);
});

// ── modifier-option surcharges (modifierGroupDefs) ────────────────────────────
const mods = (opts) => [{ id: 'g1', name: 'Extras', options: opts }];

test('modifier option surcharge change is announced', () => {
  const a = { menuItems: [item('1', 3)], modifierGroupDefs: mods([{ id: 'o1', name: 'Extra cheese', price: 1.5 }]) };
  const b = { menuItems: [item('1', 3)], modifierGroupDefs: mods([{ id: 'o1', name: 'Extra cheese', price: 2 }]) };
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '1 price updated');
  assert.equal(ev.body, 'Extra cheese £1.50 → £2.00');
});

test('item price AND modifier price changing → both counted', () => {
  const a = { menuItems: [item('1', 3, { name: 'Burger' })], modifierGroupDefs: mods([{ id: 'o1', name: 'Bacon', price: 1 }]) };
  const b = { menuItems: [item('1', 3.5, { name: 'Burger' })], modifierGroupDefs: mods([{ id: 'o1', name: 'Bacon', price: 1.5 }]) };
  const ev = describeMenuChange(a, b);
  assert.equal(ev.title, '2 prices updated');
  assert.match(ev.body, /Burger £3\.00 → £3\.50/);
  assert.match(ev.body, /Bacon £1\.00 → £1\.50/);
});

test('a NEW modifier option is not a price change (stays silent)', () => {
  const a = { menuItems: [item('1', 3)], modifierGroupDefs: mods([{ id: 'o1', name: 'Cheese', price: 1 }]) };
  const b = { menuItems: [item('1', 3)], modifierGroupDefs: mods([{ id: 'o1', name: 'Cheese', price: 1 }, { id: 'o2', name: 'Bacon', price: 2 }]) };
  assert.equal(describeMenuChange(a, b), null);
});

test('modifier option price unchanged → silent', () => {
  const a = { menuItems: [item('1', 3)], modifierGroupDefs: mods([{ id: 'o1', name: 'Cheese', price: 1 }]) };
  const b = { menuItems: [item('1', 3)], modifierGroupDefs: mods([{ id: 'o1', name: 'Cheese', price: 1 }]) };
  assert.equal(describeMenuChange(a, b), null);
});

test('first push with only modifier defs (no menuItems) still diffs on next push', () => {
  const a = { menuItems: [], modifierGroupDefs: mods([{ id: 'o1', name: 'Cheese', price: 1 }]) };
  const b = { menuItems: [], modifierGroupDefs: mods([{ id: 'o1', name: 'Cheese', price: 1.5 }]) };
  assert.equal(describeMenuChange(a, b).title, '1 price updated');
});
