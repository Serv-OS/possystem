// Multi site menu round 2, design 3.2: the Menu Manager lock (src/lib/msm/msmLock.js) and its
// wiring in the store (every screen saves through updateMenuItem, updateModifierGroupDef,
// updateModifierGroupOption, removeModifierGroupDef and the bulk VAT tool).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lockedItemPatch, lockedGroupPatch, lockedOptionPatch, droppedWords, itemLock, groupLock } from './msmLock.js';

const latte = { id: 'm-latte', name: 'Latte', menuName: 'Latte', cat: 'c-hot', pricing: { base: 3, takeaway: 2.8, menus: { lunch: { all: 3.2 } } }, centreId: 'bar', sortOrder: 4, colour: '#fff' };

test('a managed product: owned fields are refused, the site keeps its own colour, order, print centre and timed menu prices', () => {
  const r = lockedItemPatch({ menuName: 'Big latte', centreId: 'kitchen', sortOrder: 9, colour: '#000', pricing: { ...latte.pricing, base: 3.5, menus: { lunch: { all: 3.4 } } }, price: 3.5 }, latte, []);
  assert.deepEqual(r.patch.centreId, 'kitchen');
  assert.equal(r.patch.sortOrder, 9);
  assert.equal(r.patch.colour, '#000');
  assert.equal(r.patch.menuName, undefined);
  assert.equal(r.patch.price, undefined);
  // the timed menu price goes through, the Standard price stays as head office set it
  assert.deepEqual(r.patch.pricing, { base: 3, takeaway: 2.8, menus: { lunch: { all: 3.4 } } });
  assert.deepEqual(r.dropped.sort(), ['menu_name', 'pricing']);
});

test('a column the site keeps as its own stays editable', () => {
  const r = lockedItemPatch({ menuName: 'Leeds latte', image: 'x.jpg' }, latte, ['menu_name']);
  assert.equal(r.patch.menuName, 'Leeds latte');
  assert.equal(r.patch.image, undefined);
  assert.deepEqual(r.dropped, ['image']);
});

test('a screen that sends an owned field with the same value is not refused', () => {
  const r = lockedItemPatch({ cat: 'c-hot', sortOrder: 1 }, latte, []);
  assert.deepEqual(r.patch, { cat: 'c-hot', sortOrder: 1 });
  assert.deepEqual(r.dropped, []);
});

test('an order type price change is refused (pricing patch with only owned keys changed)', () => {
  const r = lockedItemPatch({ pricing: { ...latte.pricing, dineIn: 3.1 } }, latte, []);
  assert.equal(r.patch.pricing, undefined);
  assert.deepEqual(r.dropped, ['pricing']);
});

const milk = { id: 'mgd-milk', name: 'Milk', min: 0, max: 1, selectionType: 'single', options: [
  { id: 'opt-oat', name: 'Oat milk', price: 0.5, itemId: 'm-oat' },
  { id: 'opt-own', name: 'Hemp milk', price: 0.6 },
] };

test('a managed option group: name, rules, and head office options are refused; the site\'s own option and an 86 flag go through', () => {
  const r = lockedGroupPatch({
    name: 'Milks', max: 2,
    options: [{ id: 'opt-oat', name: 'Oat', price: 0.9, itemId: 'm-oat', off: true }, { id: 'opt-own', name: 'Hemp', price: 0.7 }, { id: 'opt-new', name: 'Rice milk', price: 0.5 }],
  }, milk, [], ['opt-oat']);
  assert.equal(r.patch.name, undefined);
  assert.equal(r.patch.max, undefined);
  assert.deepEqual(r.patch.options, [
    { id: 'opt-oat', name: 'Oat milk', price: 0.5, itemId: 'm-oat', off: true },
    { id: 'opt-own', name: 'Hemp', price: 0.7 },
    { id: 'opt-new', name: 'Rice milk', price: 0.5 },
  ]);
  assert.deepEqual(r.dropped.sort(), ['max', 'name', 'options']);
});

test('a head office option taken out at the site goes back where it was', () => {
  const r = lockedGroupPatch({ options: [{ id: 'opt-own', name: 'Hemp milk', price: 0.6 }] }, milk, [], ['opt-oat']);
  // put back, the list is as it was: nothing to save, and the person is told why
  assert.equal(r.patch.options, undefined);
  assert.deepEqual(r.dropped, ['options']);
  const r2 = lockedGroupPatch({ options: [{ id: 'opt-own', name: 'Hemp', price: 0.6 }] }, milk, [], ['opt-oat']);
  assert.deepEqual(r2.patch.options.map((o) => o.id), ['opt-oat', 'opt-own']);
});

test('a kept group rule stays editable', () => {
  const r = lockedGroupPatch({ max: 2, maxSelect: 2 }, milk, ['max'], []);
  assert.deepEqual(r.patch, { max: 2, maxSelect: 2 });
});

test('one option: price refused, other keys allowed', () => {
  const r = lockedOptionPatch({ price: 1, soldOut: true }, milk.options[0]);
  assert.deepEqual(r.patch, { soldOut: true });
  assert.deepEqual(r.dropped, ['options']);
  assert.deepEqual(lockedOptionPatch({ price: 1 }, null).patch, { price: 1 });
});

test('words say what was not changed and where to change it, with no codes', () => {
  const w = droppedWords('Latte', ['menu_name', 'pricing']);
  assert.match(w, /^Latte: the name and prices are set by head office in the Multi site menu/);
  assert.doesNotMatch(w, /_/);
  assert.equal(droppedWords('Latte', []), '');
});

test('itemLock and groupLock read the managed state; nothing managed means nothing locked', () => {
  const st = { ids: new Set(['m-latte']), kept: new Map([['m-latte', ['image']]]), groups: new Set(['mgd-milk']), groupKept: new Map(), groupOptions: new Map([['mgd-milk', new Set(['opt-oat'])]]) };
  assert.equal(itemLock(st, 'm-other'), null);
  const l = itemLock(st, 'm-latte');
  assert.equal(l.locked('image'), false);
  assert.equal(l.locked('cat'), true);
  assert.equal(groupLock(st, 'mgd-milk').ownedOptions.has('opt-oat'), true);
  assert.equal(itemLock({ ids: new Set(), kept: new Map() }, 'm-latte'), null);
});

test('the store applies the lock on every edit path', () => {
  const src = readFileSync(new URL('../../store/index.js', import.meta.url), 'utf8');
  const block = (name) => { const i = src.indexOf(`  ${name}: `); assert.ok(i > 0, name); return src.slice(i, i + 700); };
  assert.match(block('updateMenuItem'), /msmItemPatch\(id, patch/);
  assert.match(block('updateModifierGroupDef'), /msmGroupPatch\(id, patch/);
  assert.match(block('updateModifierGroupOption'), /lockedOptionPatch\(/);
  assert.match(block('removeModifierGroupDef'), /isMsmManagedGroup\(id\)/);
  assert.match(src.slice(src.indexOf('applyBulkTaxRates'), src.indexOf('applyBulkTaxRates') + 2200), /isMsmManaged\(a\.id\)/);
});
