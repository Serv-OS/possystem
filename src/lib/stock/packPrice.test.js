/** packPrice.test.js: prices in the pack people use, never pence per ml. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packAmount, packPrice, packLabel, packQtyWords, packWordFor, countPackOf, moneyText } from './packPrice.js';

const bottle = { name: 'Bottle', qty_in_base: 2000 };

test('packAmount: unit price times the pack size, null when either is missing', () => {
  assert.equal(packAmount(0.00069, bottle), 1.38);
  assert.equal(packAmount('0.00069', { qtyInBase: 2000 }), 1.38);
  assert.equal(packAmount(null, bottle), null);
  assert.equal(packAmount('', bottle), null);
  assert.equal(packAmount('abc', bottle), null);
  assert.equal(packAmount(0.5, null), null);
  assert.equal(packAmount(0.5, { name: 'Case', qty_in_base: 0 }), null);
  assert.equal(packAmount(0, bottle), 0);
});

test('packPrice: "£1.38 a bottle", each, an before a vowel, empty when there is no price', () => {
  assert.equal(packPrice(0.00069, bottle, 'GBP'), '£1.38 a bottle');
  assert.equal(packPrice(0.31, { name: 'Each', qty_in_base: 1 }, 'GBP'), '£0.31 each');
  assert.equal(packPrice(0.31, { name: 'each', qty_in_base: 1 }, 'GBP'), '£0.31 each');
  assert.equal(packPrice(0.2, { name: 'Egg tray', qty_in_base: 31 }, 'GBP'), '£6.20 an egg tray');
  assert.equal(packPrice(1.5, { name: 'Outer', qty_in_base: 4 }, 'GBP'), '£6.00 an outer');
  assert.equal(packPrice(2, { name: 'Unit of 6', qty_in_base: 6 }, 'GBP'), '£12.00 a unit of 6');
  assert.equal(packPrice(null, bottle, 'GBP'), '');
  assert.equal(packPrice(0.5, null, 'GBP'), '');
});

test('packPrice keeps a name that is not a plain word as typed, and uses the site currency', () => {
  assert.equal(packPrice(0.001, { name: '2L bottle', qty_in_base: 2000 }, 'GBP'), '£2.00 a 2L bottle');
  assert.equal(packPrice(0.5, { name: 'BBQ pack', qty_in_base: 10 }, 'GBP'), '£5.00 a BBQ pack');
  assert.equal(packPrice(0.00069, bottle, 'USD'), '$1.38 a bottle');
  assert.equal(packPrice(0.00069, bottle, 'EUR'), '€1.38 a bottle');
});

test('packPrice with no pack falls back to the base unit and never reads £0.00', () => {
  assert.equal(packPrice(0.0007, { name: 'ml', qty_in_base: 1 }, 'GBP'), '£0.0007 per ml');
  assert.equal(packPrice(0.012, { name: 'g', qty_in_base: 1 }, 'GBP'), '£0.012 per g');
  assert.equal(packPrice(0.05, { name: 'g', qty_in_base: 1 }, 'GBP'), '£0.05 per g');
  assert.equal(moneyText(0, 'GBP'), '£0.00');
  assert.equal(moneyText(-1.5, 'GBP'), '-£1.50');
  assert.equal(moneyText(null, 'GBP'), '');
});

test('packLabel: the unit people count in, in words', () => {
  assert.equal(packLabel(bottle, 'ml'), 'bottle');
  assert.equal(packLabel({ name: 'Each', qty_in_base: 1 }, 'each'), 'each');
  assert.equal(packLabel({ name: 'ml', qty_in_base: 1 }, 'ml'), 'ml');
  assert.equal(packLabel(null, 'kg'), 'kg');
  assert.equal(packLabel({ name: '', qty_in_base: 1 }, 'g'), 'g');
});

test('packQtyWords and packWordFor: "31 bottles", "1 bottle", units and each as they are', () => {
  assert.equal(packQtyWords(31, bottle, 'ml'), '31 bottles');
  assert.equal(packQtyWords(1, bottle, 'ml'), '1 bottle');
  assert.equal(packQtyWords(0, bottle, 'ml'), '0 bottles');
  assert.equal(packQtyWords(2.5, bottle, 'ml'), '2.5 bottles');
  assert.equal(packQtyWords(-2, bottle, 'ml'), '-2 bottles');
  assert.equal(packQtyWords(1 / 3, bottle, 'ml'), '0.333 bottles');
  assert.equal(packQtyWords(500, { name: 'ml', qty_in_base: 1 }, 'ml'), '500 ml');
  assert.equal(packQtyWords(500, null, 'g'), '500 g');
  assert.equal(packQtyWords(3, { name: 'Each', qty_in_base: 1 }, 'each'), '3 each');
  assert.equal(packQtyWords(2, { name: '175ml glass', qty_in_base: 175 }, 'ml'), '2 175ml glasses');
  assert.equal(packQtyWords(4, { name: 'Box', qty_in_base: 12 }, 'each'), '4 boxes');
  assert.equal(packQtyWords(4, { name: 'Berry', qty_in_base: 12 }, 'each'), '4 berries');
  assert.equal(packQtyWords(4, { name: 'Tray', qty_in_base: 30 }, 'each'), '4 trays');
  assert.equal(packQtyWords(4, { name: 'Unit of 6', qty_in_base: 6 }, 'each'), '4 unit of 6');
  assert.equal(packQtyWords(null, bottle, 'ml'), '');
  assert.equal(packWordFor(1, bottle, 'ml'), 'bottle');
  assert.equal(packWordFor(3, bottle, 'ml'), 'bottles');
  assert.equal(packWordFor(3, { name: 'kg', qty_in_base: 1 }, 'kg'), 'kg');
});

test('countPackOf: the read\'s count pack, else the live count default, else the base unit', () => {
  assert.deepEqual(countPackOf({ count_pack: { id: 'p1', name: 'Bottle', qty_in_base: 2000 } }), { id: 'p1', name: 'Bottle', qty_in_base: 2000 });
  const detail = {
    item: { base_unit: 'ml' },
    packs: [
      { id: 'old', name: 'Jug', qty_in_base: 1000, is_count_default: true, archived_at: '2026-10-01T00:00:00Z' },
      { id: 'case', name: 'Case', qty_in_base: 12000, is_count_default: false },
      { id: 'btl', name: 'Bottle', qty_in_base: 2000, is_count_default: true },
    ],
  };
  assert.deepEqual(countPackOf(detail), { id: 'btl', name: 'Bottle', qty_in_base: 2000 });
  assert.deepEqual(countPackOf({ item: { base_unit: 'g' }, packs: [] }), { id: null, name: 'g', qty_in_base: 1 });
  assert.deepEqual(countPackOf({ base_unit: 'each', count_pack: null }), { id: null, name: 'each', qty_in_base: 1 });
  assert.deepEqual(countPackOf(null), { id: null, name: 'each', qty_in_base: 1 });
});

test('a whole round trip: base cost to the pack and back is the figure the database holds', () => {
  const unit = 1.45 / 2000;
  assert.equal(packAmount(unit, bottle), 1.45);
  assert.equal(packPrice(unit, bottle, 'GBP'), '£1.45 a bottle');
});
