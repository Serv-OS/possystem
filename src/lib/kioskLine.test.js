// Kiosk sizes: the chosen size must reach every destination after the basket.
// Before, a kiosk "Latte, Large, Oat Milk" left the basket as plain "Latte":
// kitchen ticket, KDS, receipt, closed check, stock and recipe depletion all lost
// the size. The till writes itemId = size, name "Latte — Large", parentId = parent.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kioskVariant,
  kioskLineStockId,
  kioskLineStockIds,
  kioskLineRemaining,
  kioskLineRoom,
  kioskLineKey,
  kioskLineNeed,
  kioskCartUsage,
  kioskOrderItem,
  kioskDepleteItem,
} from './kioskLine.js';
import { kitchenOverride, receiptOverride, displayName } from './itemDisplay.js';
import { resolveCentresForItem } from './productionRouting.js';
import { consolidateReceiptLines } from './receiptLines.js';

// ── Fixture (raw Supabase rows, as the kiosk loads them) ─────────────────────
const LATTE = { id: 'm-latte', name: 'Latte', menu_name: 'Latte', kitchen_name: 'Latte', receipt_name: 'Latte', cat: 'coffee', pricing: { base: 0 } };
const SMALL = { id: 'm-small', name: 'Small', menu_name: 'Small', kitchen_name: 'Small', receipt_name: 'Small', parent_id: 'm-latte', cat: 'coffee', pricing: { base: 1.5 } };
const LARGE = { id: 'm-large', name: 'Large', menu_name: 'Large', kitchen_name: 'Large', receipt_name: 'Large', parent_id: 'm-latte', cat: null, pricing: { base: 3.5 } };
const TEA = { id: 'm-tea', name: 'Tea', menu_name: 'Tea', kitchen_name: 'Tea', receipt_name: 'Tea', cat: 'hot', pricing: { base: 2 } };
const OAT = { label: 'Oat Milk', price: 0.5, groupLabel: 'Milk' };
const WHOLE = { label: 'Whole Milk', price: 0, groupLabel: 'Milk' };

// Mirrors KioskApp addToCart's new line (item stays the parent, name the parent).
function line(item, child, modsArray, linePrice, qty = 1, selections = {}) {
  const variant = kioskVariant(item, child);
  return {
    key: kioskLineKey(item, variant, selections),
    item, variant, name: displayName(item), qty, mods: '', modsArray, instructions: '',
    linePrice, lineTotal: qty * linePrice,
  };
}

// The itemsPayload mapper exactly as it was inline in KioskApp.jsx before this fix.
const legacyOrderItem = (l) => ({
  id: l.item.id,
  name: l.name,
  kitchenName: kitchenOverride(l.item),
  receiptName: receiptOverride(l.item),
  qty: l.qty,
  price: l.linePrice,
  mods: Array.isArray(l.modsArray) ? l.modsArray : [],
  cat: l.item.cat,
  status: 'sent',
  fired: true,
  course: 1,
});
const legacyDepleteItem = (l) => ({ itemId: l.item.id, qty: l.qty,
  mods: (Array.isArray(l.modsArray) ? l.modsArray : []).filter(m => m && m.itemId).map(m => ({ itemId: m.itemId, qty: m.qty || 1 })) });

// 1 ─────────────────────────────────────────────────────────────────────────
test('no size: order item, key and deplete item are exactly what the kiosk wrote before', () => {
  const sel = { 'mgd-milk': ['o-whole'] };
  const l = line(TEA, null, [WHOLE, { label: 'Lemon', price: 0, itemId: 'm-lemon' }], 2, 2, sel);
  assert.equal(l.variant, null);
  assert.deepEqual(kioskOrderItem(l), legacyOrderItem(l));
  assert.deepEqual(Object.keys(kioskOrderItem(l)), Object.keys(legacyOrderItem(l)));
  assert.equal(kioskLineKey(TEA, null, sel), TEA.id + ':' + JSON.stringify(sel));
  assert.deepEqual(kioskDepleteItem(l), legacyDepleteItem(l));
});

// 2 ─────────────────────────────────────────────────────────────────────────
test('closed check and order queue line carries the size id, name and parent id', () => {
  const l = line(LATTE, LARGE, [OAT], 4);
  const o = kioskOrderItem(l);
  assert.equal(o.id, 'm-large');
  assert.equal(o.itemId, 'm-large');
  assert.equal(o.parentId, 'm-latte');
  assert.equal(o.name, 'Latte — Large');
  assert.equal(o.price, 4);                 // size 3.50 + Oat 0.50, not a separate size price
  assert.equal(o.cat, 'coffee');            // parent category
  assert.deepEqual(o.mods, [OAT]);          // the size is not a modifier
  assert.ok(!o.mods.some(m => /Large/.test(m.label)));
  assert.equal(o.qty, 1);
  assert.equal(o.status, 'sent');
  assert.equal(o.fired, true);
  assert.equal(o.course, 1);
});

// 3 ─────────────────────────────────────────────────────────────────────────
test('till parity: the stored name is the till formula for the same rows', () => {
  // InlineItemFlow.jsx: `${item.menuName || item.menu_name || item.name}` + ` — ${variant.menuName || variant.name}`
  const tillName = `${LATTE.menuName || LATTE.menu_name || LATTE.name}${` — ${LARGE.menuName || LARGE.name || LARGE.label}`}`;
  assert.equal(kioskOrderItem(line(LATTE, LARGE, [], 3.5)).name, tillName);
  // Product Mix keys by name, so kiosk and till sales share one row.
  assert.equal(tillName, 'Latte — Large');
  // Customer facing menu names are used when set.
  const renamed = kioskVariant({ ...LATTE, menu_name: 'Oat Latte' }, { ...LARGE, menu_name: 'Big' });
  assert.equal(renamed.lineName, 'Oat Latte — Big');
});

// 4 ─────────────────────────────────────────────────────────────────────────
test('KDS and kitchen print: routed by the parent, printed with the size', () => {
  const config = {
    centres: [{ id: 'bar' }, { id: 'grill' }],
    routing: { bar: { assignedCategories: ['coffee'] }, grill: { assignedCategories: ['food'] } },
  };
  const o = kioskOrderItem(line(LATTE, LARGE, [OAT], 4));
  const ctx = { menuItems: [{ id: 'm-latte', cat: 'coffee' }, { id: 'm-large', cat: null, parentId: 'm-latte' }], catParents: {}, orderType: 'takeaway' };
  assert.deepEqual(resolveCentresForItem(o, config, ctx).centreIds, ['bar']);
  // Even with no category on the line, parentId routes it to the parent's centre.
  assert.deepEqual(resolveCentresForItem({ ...o, cat: null }, config, { ...ctx, menuItems: [{ id: 'm-latte', cat: 'coffee' }] }).centreIds, ['bar']);
  // The KDS ticket and print job read kitchenName || name.
  assert.equal(o.kitchenName || o.name, 'Latte — Large');
  // An explicit kitchen name on the size wins, like the till.
  const withKitchen = kioskOrderItem(line(LATTE, { ...LARGE, kitchen_name: 'LG LATTE' }, [], 3.5));
  assert.equal(withKitchen.kitchenName || withKitchen.name, 'LG LATTE');
  // An item excluded by its size id at a centre is excluded, as on the till.
  const excl = { ...config, routing: { ...config.routing, bar: { assignedCategories: ['coffee'], excludedItems: ['m-large'] } } };
  assert.deepEqual(resolveCentresForItem(o, excl, ctx).centreIds, []);
});

// 5 ─────────────────────────────────────────────────────────────────────────
test('receipt: the size is printed and sizes at the same price stay apart', () => {
  const large = kioskOrderItem(line(LATTE, LARGE, [], 3));
  const small = kioskOrderItem(line(LATTE, { ...SMALL, pricing: { base: 3 } }, [], 3));
  assert.equal(large.receiptName || large.name, 'Latte — Large');
  const withReceipt = kioskOrderItem(line(LATTE, { ...LARGE, receipt_name: 'Large Latte' }, [], 3));
  assert.equal(withReceipt.receiptName || withReceipt.name, 'Large Latte');
  const lines = consolidateReceiptLines([large, small]);
  assert.equal(lines.length, 2);
  const merged = consolidateReceiptLines([large, kioskOrderItem(line(LATTE, LARGE, [], 3))]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].qty, 2);
});

// 6 ─────────────────────────────────────────────────────────────────────────
test('stock count: the size is counted and gated (with its parent, like the till)', () => {
  const cart = [line(LATTE, LARGE, [OAT], 4)];
  const usage = kioskCartUsage(cart);
  assert.deepEqual(usage, { 'm-large': 1, 'm-latte': 1 });
  // The modal's final gate for a second Large with 1 in stock.
  const dailyCounts = { 'm-large': { remaining: 1 } };
  const need = kioskLineNeed({ item: LATTE, variantItem: LARGE, mods: [WHOLE], qty: 1 });
  assert.deepEqual(need, { 'm-large': 1, 'm-latte': 1 });
  const refused = Object.entries(need).some(([rid, want]) => {
    const stock = dailyCounts[rid];
    const avail = stock ? Number(stock.remaining) - (usage[rid] || 0) : Infinity;
    return want > avail;
  });
  assert.equal(refused, true);
  // Only the size is tracked here, so the cap and the plus button follow the size.
  assert.equal(kioskLineRoom(cart[0], dailyCounts, usage), 0);
  assert.equal(kioskLineRemaining(cart[0], dailyCounts), 1);
  // The decrement loop walks the size then the parent (each only if tracked);
  // the recipe id is the size alone.
  assert.deepEqual(kioskLineStockIds(cart[0]), ['m-large', 'm-latte']);
  assert.equal(kioskLineStockId(cart[0]), 'm-large');
  // Linked modifiers still count, times the line qty.
  assert.deepEqual(kioskLineNeed({ item: LATTE, variantItem: LARGE, mods: [{ label: 'Shot', itemId: 'm-shot', qty: 2 }], qty: 3 }), { 'm-large': 3, 'm-latte': 3, 'm-shot': 6 });
  assert.deepEqual(kioskCartUsage([line(LATTE, SMALL, [{ label: 'Shot', itemId: 'm-shot' }], 2, 2)]), { 'm-small': 2, 'm-latte': 2, 'm-shot': 2 });
});

// 6b ────────────────────────────────────────────────────────────────────────
// The decrement loop exactly as KioskApp runs it after payment.
const decrementCalls = (cart, counts) => {
  const calls = [];
  for (const l of cart) for (const id of kioskLineStockIds(l)) if (id && counts[id]) calls.push([id, l.qty || 1]);
  return calls;
};
const gateRefuses = (need, dailyCounts, usage) => Object.entries(need).some(([rid, want]) => {
  const stock = dailyCounts[rid];
  const avail = stock ? Number(stock.remaining) - (usage[rid] || 0) : Infinity;
  return want > avail;
});

test('stock count on the PARENT only (House Wine bottles, sizes untracked) still gates and counts down', () => {
  const WINE = { id: 'm-wine', name: 'House Wine', cat: 'wine' };
  const G175 = { id: 'm-wine-175', name: '175ml', parent_id: 'm-wine', cat: 'wine' };
  const G250 = { id: 'm-wine-250', name: '250ml', parent_id: 'm-wine', cat: 'wine' };
  const dailyCounts = { 'm-wine': { remaining: 2 } };
  const cart = [line(WINE, G175, [], 6), line(WINE, G250, [], 8)];
  const usage = kioskCartUsage(cart);
  assert.equal(usage['m-wine'], 2);
  // A third glass of either size is refused by the modal gate and the add cap.
  assert.equal(gateRefuses(kioskLineNeed({ item: WINE, variantItem: G175, mods: [], qty: 1 }), dailyCounts, usage), true);
  assert.equal(kioskLineRoom({ item: WINE, variant: kioskVariant(WINE, G250) }, dailyCounts, usage), 0);
  // With one glass in the basket, a second is allowed.
  const usage1 = kioskCartUsage([cart[0]]);
  assert.equal(gateRefuses(kioskLineNeed({ item: WINE, variantItem: G250, mods: [], qty: 1 }), dailyCounts, usage1), false);
  assert.equal(kioskLineRoom({ item: WINE, variant: kioskVariant(WINE, G250) }, dailyCounts, usage1), 1);
  // Plus button on a line follows the parent count.
  assert.equal(kioskLineRemaining(cart[0], dailyCounts), 2);
  // After payment the parent is counted down once per glass; untracked sizes are skipped.
  assert.deepEqual(decrementCalls(cart, dailyCounts), [['m-wine', 1], ['m-wine', 1]]);
  // Recipes still deplete on the size.
  assert.equal(kioskDepleteItem(cart[0]).itemId, 'm-wine-175');
});

test('stock count on both the size and the parent: the lower one wins, both count down', () => {
  const dailyCounts = { 'm-large': { remaining: 5 }, 'm-latte': { remaining: 1 } };
  const cart = [line(LATTE, LARGE, [], 3.5)];
  const usage = kioskCartUsage(cart);
  assert.equal(kioskLineRoom({ item: LATTE, variant: kioskVariant(LATTE, LARGE) }, dailyCounts, usage), 0);
  assert.equal(kioskLineRemaining(cart[0], dailyCounts), 1);
  assert.equal(gateRefuses(kioskLineNeed({ item: LATTE, variantItem: LARGE, mods: [], qty: 1 }), dailyCounts, usage), true);
  assert.deepEqual(decrementCalls(cart, dailyCounts), [['m-large', 1], ['m-latte', 1]]);
  // Size lower than parent.
  const dc2 = { 'm-large': { remaining: 1 }, 'm-latte': { remaining: 9 } };
  assert.equal(kioskLineRoom({ item: LATTE, variant: kioskVariant(LATTE, LARGE) }, dc2, {}), 1);
  assert.equal(kioskLineRemaining(cart[0], dc2), 1);
  // Nothing tracked: no cap.
  assert.equal(kioskLineRoom(cart[0], {}, usage), null);
  assert.equal(kioskLineRemaining(cart[0], {}), null);
});

// 7 ─────────────────────────────────────────────────────────────────────────
test('recipe depletion gets the size id and only linked modifiers', () => {
  const l = line(LATTE, LARGE, [OAT, { label: 'Shot', price: 0.5, itemId: 'm-shot', qty: 2 }], 4.5, 2);
  assert.deepEqual(kioskDepleteItem(l), { itemId: 'm-large', qty: 2, mods: [{ itemId: 'm-shot', qty: 2 }] });
});

// 8 ─────────────────────────────────────────────────────────────────────────
test('basket merge: different sizes never merge, the same size and picks do', () => {
  const sel = { __variants__: ['m-large'], 'mgd-milk': ['o-oat'] };
  const selSmall = { __variants__: ['m-small'], 'mgd-milk': ['o-oat'] };
  const vL = kioskVariant(LATTE, LARGE), vS = kioskVariant(LATTE, SMALL);
  assert.notEqual(kioskLineKey(LATTE, vL, sel), kioskLineKey(LATTE, vS, selSmall));
  // Same picks object but different size ids still differ.
  assert.notEqual(kioskLineKey(LATTE, vL, {}), kioskLineKey(LATTE, vS, {}));
  assert.equal(kioskLineKey(LATTE, vL, sel), kioskLineKey(LATTE, kioskVariant(LATTE, LARGE), { ...sel }));
});

// 9 ─────────────────────────────────────────────────────────────────────────
test('old line without a variant field falls back to the parent everywhere', () => {
  const old = { key: 'm-latte:{}', item: LATTE, name: 'Latte', qty: 1, modsArray: [WHOLE], linePrice: 1.5, lineTotal: 1.5 };
  assert.equal(kioskLineStockId(old), 'm-latte');
  assert.deepEqual(kioskOrderItem(old), legacyOrderItem(old));
  assert.deepEqual(kioskDepleteItem(old), legacyDepleteItem(old));
  assert.deepEqual(kioskCartUsage([old]), { 'm-latte': 1 });
  assert.deepEqual(kioskLineStockIds(old), ['m-latte']);
  assert.equal(kioskLineRemaining(old, { 'm-latte': { remaining: 3 } }), 3);
  assert.equal(kioskLineRoom(old, { 'm-latte': { remaining: 3 } }, { 'm-latte': 1 }), 2);
  assert.equal(kioskVariant(LATTE, null), null);
  assert.equal(kioskVariant(LATTE, undefined), null);
  assert.deepEqual(kioskLineNeed({ item: LATTE, variantItem: null, mods: [], qty: 2 }), { 'm-latte': 2 });
});

// 10 ────────────────────────────────────────────────────────────────────────
test('money guard: helpers never change the basket line the money paths read', () => {
  const cart = [line(LATTE, LARGE, [OAT], 4), line(LATTE, SMALL, [WHOLE], 1.5)];
  const snapshot = JSON.parse(JSON.stringify(cart));
  cart.map(kioskOrderItem); cart.map(kioskDepleteItem); kioskCartUsage(cart); cart.forEach(kioskLineStockId);
  assert.deepEqual(JSON.parse(JSON.stringify(cart)), snapshot);
  // Subtotal, Stripe line items and tax inputs all read name / linePrice / item.
  assert.equal(cart.reduce((a, l) => a + l.lineTotal, 0), 5.5);
  assert.deepEqual(cart.map(l => ({ name: l.name, amount: Math.round(l.linePrice * 100), quantity: l.qty })),
    [{ name: 'Latte', amount: 400, quantity: 1 }, { name: 'Latte', amount: 150, quantity: 1 }]);
  assert.deepEqual(cart.map(l => l.item.id), ['m-latte', 'm-latte']);
  // Order line price equals the basket line price, never size plus line.
  assert.deepEqual(cart.map(kioskOrderItem).map(o => o.price), [4, 1.5]);
});
