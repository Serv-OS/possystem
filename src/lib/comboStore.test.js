// comboStore.test.js: the store moves a Combo as one. The rules are proven on their own
// (combo.test.js, comboLines.test.js); this reads the store's source so a refactor that quietly
// drops one of the doors fails here. Each test names the line operation it guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isComboPick, isComboParent, comboLinesTotal } from './combo.js';
import { repricedPickLine, comboOrderLines } from './comboLines.js';
import { resolveItemPrice } from './menuPricing.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const STORE = read('../store/index.js');
const between = (start, end) => {
  const a = STORE.indexOf(start);
  assert.ok(a >= 0, `not found: ${start}`);
  const b = STORE.indexOf(end, a + start.length);
  assert.ok(b > a, `not found after it: ${end}`);
  return STORE.slice(a, b);
};
const action = (name, next) => between(`\n  ${name}: `, `\n  ${next}: `);

test('add: one action adds the Combo line and every pick in ONE write, built in one place', () => {
  const add = action('addCombo', 'removeCombo');
  assert.match(add, /comboOrderLines\(\{/);                               // the lines come from lib/comboLines.js, never a second literal
  assert.equal((add.match(/_withOrderItems\(/g) || []).length, 1, 'one write for every line');
  assert.ok(add.indexOf('comboMissing(') < add.indexOf('_withOrderItems('), 'the rules are checked before anything is added');
  assert.match(add, /if \(missing\) return fail\(missing\);/);
  assert.match(add, /refusesNoPriceLine\(item, orderType, menuId, setPrice\)/);   // a Combo with no price is never sold for 0.00
  assert.match(add, /isSoldAs\(item, soldType, menuItems\)/);
  assert.match(add, /get\(\)\.decrementDailyCount\(l\.itemId, 1\);/);      // the Combo, every pick
  assert.match(add, /if \(m\.itemId\) get\(\)\.decrementDailyCount\(m\.itemId, m\.qty \|\| 1\)/);   // and every linked option
  assert.ok(!/addItem\(/.test(add), 'never through the plain add (its price maths would charge a pick)');
  // Combo ids and line ids never come from the per page counter.
  assert.match(STORE, /const newComboId = \(\) => `cmb-\$\{comboRand\(\)\}`;/);
  assert.match(STORE, /uid: comboLineUid,/);
});

test('add: a Combo with steps never becomes one plain line, whoever asks (phone POS, voice, the assistant, a scan)', () => {
  const add = action('addItem', 'addCustomItem');
  assert.match(add, /if \(comboHasSteps\(item\)\) \{\n\s+get\(\)\.showToast\?\.\(comboNotHereWords\(item\), 'error'\);\n\s+return null;/);
  assert.ok(add.indexOf('comboHasSteps(item)') < add.indexOf('const newItem = {'), 'refused before a line is built');
});

test('the lines survive: the screen and the store read the same context', () => {
  const ctx = action('comboContext', 'addCombo');
  assert.match(ctx, /comboPosContext\(\{/);
  assert.match(ctx, /orderType: st\.activeTableId \? 'dine-in' : st\.orderType,/);   // a table is always dine in
});

test('remove (delete): any line of a Combo removes the whole Combo, never after it was sent', () => {
  const rm = action('removeItem', 'clearDraftItems');
  assert.match(rm, /if \(isComboLine\(removed\)\) \{ get\(\)\.removeCombo\(removed\.comboId\); return; \}/);
  const whole = action('removeCombo', 'configureComboPick');
  assert.match(whole, /if \(comboIsSent\(items, comboId\)\) \{/);
  assert.match(whole, /get\(\)\._restoreDailyCounts\(lines\);/);
  assert.match(whole, /list\.filter\(i => i\.comboId !== comboId\)/);
});

test('clear the draft: a Combo that is partly at the kitchen is never half cleared', () => {
  const clear = action('clearDraftItems', 'updateItemQty');
  assert.match(clear, /const isDraft = draftLineTest\(all\);/);
  assert.equal((clear.match(/isDraft\(/g) || []).length, 1);
  assert.match(clear, /all\.filter\(isDraft\)/);
  assert.ok(!/i\.status === 'pending' && !i\.voided\)/.test(clear), 'no second copy of the old test');
});

test('quantity: refused on a Combo, in words', () => {
  const qty = action('updateItemQty', 'updateItemNote');
  assert.match(qty, /if \(isComboLine\(target\)\) \{ get\(\)\.showToast\?\.\(COMBO_WORDS\.qty, 'info'\); return; \}/);
  assert.ok(qty.indexOf('isComboLine(target)') < qty.indexOf('decrementDailyCount'), 'before any count moves');
});

test('seat: the whole Combo moves seat; course: a pick alone (kitchen timing), never the Combo line', () => {
  const seat = action('updateItemSeat', 'updateItemCourse');
  assert.match(seat, /const move = new Set\(comboUids\(t\.session\.items, itemUid\)\);/);
  assert.match(seat, /move\.has\(i\.uid\)\?\{\.\.\.i,seat\}:i/);
  const course = action('updateItemCourse', 'reprintKitchenTickets');
  assert.match(course, /if \(isComboParent\(get\(\)\.getPOSItems\(\)\.find\(i => i\.uid === itemUid\)\)\) return;/);
});

test('options: a pick is changed through its own action, only before the Combo is sent', () => {
  const old = action('configureLineOptions', 'setOrderNote');
  assert.match(old, /if \(isComboLine\(line\)\) return;/);
  const pick = action('configureComboPick', 'duplicateCombo');
  assert.match(pick, /if \(!isComboPick\(line\) \|\| line\.voided \|\| !target\) return false;/);
  assert.match(pick, /if \(comboIsSent\(items, line\.comboId\)\) \{ st\.showToast\?\.\(COMBO_WORDS\.sentChange, 'error'\); return false; \}/);
  assert.match(pick, /if \(target\.id !== entryId && targetParent !== entryId\) return false;/);   // only the step's product, or a size of it
  assert.match(pick, /changedPickLine\(\{/);
});

test('void: a line of a Combo voids the whole Combo, on a table and on a walk in order', () => {
  const v = action('voidItem', 'voidCheck');
  assert.equal((v.match(/voidGroup\(/g) || []).length, 2, 'the walk in branch and the table branch');
  assert.match(v, /voidGroup\(order\.items, item\)/);
  assert.match(v, /voidGroup\(table\.session\.items, item\)/);
  assert.equal((v.match(/gone\.has\(i\.uid\)/g) || []).length, 2);
  assert.ok(!/i\.uid === itemUid \?/.test(v), 'no single line path left');
  assert.equal((v.match(/_restoreDailyCounts\(lines\)/g) || []).length, 2);
  assert.equal((v.match(/voidKitchenLines\(\{ label(: table\.label)?, lines, reason, manager \}\)/g) || []).length, 2);
});

test('discount: a line discount on a Combo goes on the Combo, and comes off the Combo', () => {
  const on = action('addItemDiscount', 'removeItemDiscount');
  assert.match(on, /isComboLine\(target\) \? comboDiscount\(items, target, discount\)/);
  const off = between('\n  removeItemDiscount: ', '\n  // ── KDS ──');
  assert.match(off, /const off = new Set\(comboUids\(items, itemUid\)\);/);
});

test('order type switch: a pick is repriced by its own rule, never from its product', () => {
  const sw = between('  setOrderType: t => set(s => {', 'customer: null,');
  assert.match(sw, /if \(it\.fromPreorder\) return it;/);
  assert.match(sw, /if \(isComboPick\(it\)\) return repricedPickLine\(it, menu\.find\(m => m && m\.id === it\.itemId\), \(row\) => fn\(row, t, s\.activeMenuId\)\);/);
  assert.ok(sw.indexOf('isComboPick(it)') < sw.indexOf('const newUnitPrice = fn(src, t, s.activeMenuId);'), 'before the ordinary reprice');
});

test('refund: a part refund that cuts a Combo is refused before any money moves', () => {
  const r = between('\n  refundCheck: async', 'const legLookup = await resolveRefundCardLegs');
  assert.match(r, /if \(!isFullRefund && !keepsCombosWhole\(\(chkFound\.items \|\| \[\]\)\.filter\(i => i && !i\.voided\), \(refundItems \|\| \[\]\)\.map\(i => i\?\.uid\)\)\) \{/);
  assert.match(r, /Nothing has been refunded\./);
});

test('kitchen: the Combo\'s own line reaches no ticket, docket, sticker or notice on any path', () => {
  // Send (table and walk in), reprint.
  assert.match(STORE, /items\.filter\(isUnsentLine\)\.filter\(i => !i\.noKitchen\)\.forEach\(item => \{/);
  assert.match(STORE, /const items = source\.filter\(i => uidSet\.has\(i\.uid\) && !i\.voided && !i\.noKitchen\);/);
  // Stickers.
  assert.match(STORE, /printItems\.filter\(it => !it\?\.noKitchen\)\.forEach\(/);
  // A bar tab round.
  assert.match(action('addRoundToTab', 'updateTabNote'), /if \(it\.voided \|\| it\.noKitchen\) return;/);
  // The table moved notice.
  assert.match(action('transferTable', 'setActiveTableId'), /const sentItems = fromItems\.filter\(i => i\.status === 'sent' && !i\.voided && !i\.noKitchen\);/);
  // An order sent again from Orders (the channel path), its fallback centre included.
  const route = between('  routeKioskOrderPrints: async', '\n  printHubriseReceipt: async');
  assert.match(route, /order\.items\.forEach\(item => \{[\s\S]{0,400}if \(item\?\.noKitchen\) return;/);
  assert.match(route, /const unrouted = order\.items\.filter\(it => !it\?\.noKitchen && /);
});

test('another the same: the picks are read back from the lines and added as a Combo of their own', () => {
  const dup = between('\n  duplicateCombo: ', '\n  removeItem: ');
  assert.match(dup, /return get\(\)\.addCombo\(item, picksFromLines\(lines, \(\) => comboLineUid\(\)\)\);/);
});

// ── The store's REAL order type switch, run on a Combo ──────────────────────
// (the same way parity/prices.parity.test.js runs it: the action's own body, with the helpers it names)

test('A: the real setOrderType never reprices a set price pick, follows a kept price, and moves the set price', () => {
  const body = between('setOrderType: t => set(s => {', '  customer: null,').trim().replace(/^[A-Za-z]+:\s*/, '').replace(/,\s*$/, '');
  const row = (id, name, pricing, extra = {}) => ({ id, name, menuName: name, type: 'simple', pricing, price: pricing.base, cat: 'c', ...extra });
  const MENU = [
    row('p-marg', 'Margherita', { base: 16, takeaway: 17, delivery: 18 }),
    row('p-speck', 'Speck', { base: 20, delivery: 23 }),
    row('d-six', 'Soda Six Pack', { base: 20, delivery: 22 }),
    row('c-byo', 'Build Your Own Package', { base: 149, delivery: 159 }, { type: 'combo', combo: { steps: [
      { id: 'pz', name: 'Pizzas', selectionType: 'quantity', min: 2, max: 2, pricing: 'set', products: [{ itemId: 'p-marg' }, { itemId: 'p-speck', bump: 2.5 }] },
      { id: 'dr', name: 'Drinks', selectionType: 'multiple', min: 0, max: 99, pricing: 'own', products: [{ itemId: 'd-six' }] },
    ] } }),
  ];
  let n = 0;
  const picks = [
    { key: 'a', stepId: 'pz', entryId: 'p-marg', itemId: 'p-marg', mods: [{ label: 'Extra cheese', price: 1.5 }], configured: true },
    { key: 'b', stepId: 'pz', entryId: 'p-speck', itemId: 'p-speck', mods: [] },
    { key: 'c', stepId: 'dr', entryId: 'd-six', itemId: 'd-six', mods: [] },
  ];
  const { lines } = comboOrderLines({ item: MENU[3], comboId: 'cmb-1', picks, setPrice: 149, priceOf: (r) => resolveItemPrice(r, 'dine-in', null), uid: () => `cl-${++n}`, menuItems: MENU, menuCategories: [], taxRates: [] });
  const loose = { uid: 'i1', itemId: 'p-marg', name: 'Margherita', price: 16, qty: 1, mods: [] };
  let state = { menuItems: MENU, SEED_MENU_ITEMS: [], orderType: 'dine-in', activeTableId: null, activeMenuId: null, tables: [], walkInOrder: { items: [...lines, loose] } };
  const set = (fn) => { const p = typeof fn === 'function' ? fn(state) : fn; state = { ...state, ...p }; };
  state.getItemPrice = (item, ot, menuId = null) => resolveItemPrice(item, ot, menuId);
  const setOrderType = new Function('set', 'get', 'isComboPick', 'repricedPickLine', `return (${body});`)(set, () => state, isComboPick, repricedPickLine);

  assert.deepEqual(lines.map((l) => l.price), [149, 1.5, 2.5, 20]);
  setOrderType('delivery');
  const after = state.walkInOrder.items;
  const price = (id, role) => after.find((l) => l.itemId === id && (role ? l.comboRole === role : !l.comboId)).price;
  assert.equal(price('c-byo', 'parent'), 159, 'the Combo line takes its own delivery price');
  assert.equal(price('p-marg', 'pick'), 1.5, 'a set price pick stays 0.00 plus its option, never the pizza\'s 18.00');
  assert.equal(price('p-speck', 'pick'), 2.5, 'its bump stays, never 23.00');
  assert.equal(price('d-six', 'pick'), 22, 'a pick that keeps its price follows the order type');
  assert.equal(price('p-marg'), 18, 'a pizza rung up on its own is repriced as always');
  assert.equal(comboLinesTotal(after.filter((l) => l.comboId)), 185);
  assert.ok(after.filter(isComboPick).length === 3 && after.filter(isComboParent).length === 1);
  setOrderType('dine-in');
  assert.deepEqual(state.walkInOrder.items.map((l) => l.price), [149, 1.5, 2.5, 20, 16], 'and back again, to the cent');
});
