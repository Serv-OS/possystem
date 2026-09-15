// New kiosk design basket rules (lib/kioskBasket.js): the merge key and the reprice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { kioskLineKeyV2, kioskAddedLineKey, repriceKioskCart } from './kioskBasket.js';
import { kioskLineKey } from './kioskLine.js';

const pizza = { id: 'p1', name: 'Margherita', price: 9.5 };
const note = (text) => ({ label: text, price: 0, groupLabel: 'Note', _instruction: true });
const mozz = { label: 'Extra mozzarella', price: 1.5, groupLabel: 'Add anything?', itemId: 'cheese' };
const honey = { label: 'Chilli honey', price: 1, groupLabel: 'Add anything?' };

test('different notes give different keys', () => {
  const a = kioskLineKeyV2({ item: pizza, mods: [note('no basil')] });
  const b = kioskLineKeyV2({ item: pizza, mods: [note('extra crispy')] });
  const c = kioskLineKeyV2({ item: pizza, mods: [] });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('pick order does not matter', () => {
  assert.equal(
    kioskLineKeyV2({ item: pizza, mods: [mozz, honey] }),
    kioskLineKeyV2({ item: pizza, mods: [honey, mozz] }),
  );
});

test('repeated picks (quantity groups) count', () => {
  assert.notEqual(
    kioskLineKeyV2({ item: pizza, mods: [mozz] }),
    kioskLineKeyV2({ item: pizza, mods: [mozz, mozz] }),
  );
});

test('a different size gives a different key; a quick add merges with an empty sheet add', () => {
  const lager = { id: 'd1' };
  assert.notEqual(kioskLineKeyV2({ item: lager, variant: { id: 'half' }, mods: [] }), kioskLineKeyV2({ item: lager, variant: { id: 'pint' }, mods: [] }));
  assert.equal(kioskLineKeyV2({ item: pizza, variant: null, mods: [] }), kioskLineKeyV2({ item: pizza }));
});

test('a note typed like a pick does not collide with a real pick', () => {
  assert.notEqual(
    kioskLineKeyV2({ item: pizza, mods: [{ label: 'Chilli honey', price: 0, groupLabel: 'Note', _instruction: true }] }),
    kioskLineKeyV2({ item: pizza, mods: [{ label: 'Chilli honey', price: 0, groupLabel: 'Note' }] }),
  );
});

test('the v2 key never equals the current kiosk key, so the two cannot be mixed up', () => {
  assert.notEqual(kioskLineKeyV2({ item: pizza, mods: [] }), kioskLineKey(pizza, null, {}));
});

const priced = (id, extra) => ({ id, pricing: { base: 5, dineIn: 5, takeaway: 4 }, ...extra });

test('reprice: base plus picks for eat in and take away', () => {
  const items = [priced('burger')];
  const cart = [{ key: 'k', item: items[0], variant: null, qty: 2, modsArray: [mozz, note('no onion')], linePrice: 6.5, lineTotal: 13 }];
  const out = repriceKioskCart(cart, items, 'takeaway', null);
  assert.notEqual(out, cart);
  assert.equal(out[0].linePrice, 5.5);
  assert.equal(out[0].lineTotal, 11);
  assert.equal(out[0].key, 'k');
  const back = repriceKioskCart(out, items, 'dineIn', null);
  assert.equal(back[0].linePrice, 6.5);
  assert.equal(back[0].lineTotal, 13);
});

test('reprice: a size line is priced from the size row', () => {
  const parent = { id: 'lager', pricing: { base: 0 } };
  const pint = { id: 'pint', parent_id: 'lager', pricing: { base: 5.3, takeaway: 4.8, menus: { happy: { all: 3 } } } };
  const cart = [{ key: 'k', item: parent, variant: { id: 'pint' }, qty: 1, modsArray: [], linePrice: 5.3, lineTotal: 5.3 }];
  assert.equal(repriceKioskCart(cart, [parent, pint], 'takeaway', null)[0].linePrice, 4.8);
  assert.equal(repriceKioskCart(cart, [parent, pint], 'dineIn', 'happy')[0].linePrice, 3);
});

test('reprice: a row that is gone stays unchanged, and no change returns the same array', () => {
  const items = [priced('burger')];
  const cart = [
    { key: 'a', item: { id: 'gone' }, qty: 1, modsArray: [], linePrice: 9, lineTotal: 9 },
    { key: 'b', item: items[0], qty: 1, modsArray: [], linePrice: 5, lineTotal: 5 },
    { key: 'c', item: { id: 'lager' }, variant: { id: 'gone-size' }, qty: 1, modsArray: [], linePrice: 3, lineTotal: 3 },
  ];
  const same = repriceKioskCart(cart, items, 'dineIn', null);
  assert.equal(same, cart);
  const out = repriceKioskCart(cart, items, 'takeaway', null);
  assert.equal(out[0], cart[0]);
  assert.equal(out[2], cart[2]);
  assert.equal(out[1].linePrice, 4);
  assert.deepEqual(repriceKioskCart(null, items, 'dineIn'), []);
});

test('options with the same name and price that link different items never merge', () => {
  const skin = { label: 'Fries', price: 0, groupLabel: 'Side', itemId: 'i-fries-skin' };
  const plain = { label: 'Fries', price: 0, groupLabel: 'Side', itemId: 'i-fries-plain' };
  assert.notEqual(kioskLineKeyV2({ item: pizza, mods: [skin] }), kioskLineKeyV2({ item: pizza, mods: [plain] }));
  assert.equal(kioskLineKeyV2({ item: pizza, mods: [skin] }), kioskLineKeyV2({ item: pizza, mods: [{ ...skin }] }));
});

test('kioskAddedLineKey matches the key addToCart builds (note appended, size id)', () => {
  assert.equal(
    kioskAddedLineKey({ item: pizza, mods: [mozz], instructions: '  no basil ' }),
    kioskLineKeyV2({ item: pizza, mods: [mozz, note('no basil')] }),
  );
  assert.equal(
    kioskAddedLineKey({ item: { id: 'd1' }, variantItem: { id: 'pint', name: 'Pint' }, mods: [] }),
    kioskLineKeyV2({ item: { id: 'd1' }, variant: { id: 'pint' }, mods: [] }),
  );
  assert.equal(kioskAddedLineKey({ item: pizza, mods: [], instructions: '   ' }), kioskLineKeyV2({ item: pizza, mods: [] }));
});
