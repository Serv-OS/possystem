/** poItemList.test.js: the New purchase order item table rules over 1,500 synthetic items. Run: `npm test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foldText, buildPoItemRows, filterSortPoItems, sortPoItemRows, pinnedLines, categoriesOf, areasOf, countLine,
  applyQty, lineForRow, dropEmptyLines, unlistedLineCheck, rowMatches, rowLineValue, itemArea, supplierPack, relineForSupplier,
} from './poItemList.js';

const SUP = 'sup-bakehouse';
const OTHER = 'sup-dairy';
const CATS = ['Bread', 'Pastry', 'Flour', 'Dairy', 'Crème fraîche'];
const AREAS = ['Dry store', 'Walk in', 'Freezer', ''];

/** 1,500 items; 1,200 listed by the supplier, 300 by another supplier only. */
function synthetic(n = 1500) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const mine = i < 1200;
    items.push({
      id: `it-${i}`, name: i === 7 ? 'Crème brûlée base' : `Item ${String(i).padStart(4, '0')}`, kind: 'PURCHASED', baseUnit: 'each',
      sku: `SKU-${i}`, category: CATS[i % CATS.length], storageLocation: AREAS[i % AREAS.length],
      onHand: i % 3, archivedAt: null, conversions: [],
      supplierProducts: [{
        id: `sp-${i}`, supplierId: mine ? SUP : OTHER, supplierSku: `BH${i}`, packQty: 1, innerQty: 6, innerUnit: 'each',
        packPrice: 12, netPackPrice: 10, isPreferred: true,
      }],
    });
  }
  return items;
}
const pars = { 'it-1': { parLevel: 10 }, 'it-2': { parLevel: 1 } };   // it-1 on hand 1 (below), it-2 on hand 2 (not below)
const onOrder = { 'it-4': 12 };

test('foldText: case and accents fold so creme finds Crème', () => {
  assert.equal(foldText('Crème Brûlée'), 'creme brulee');
  assert.equal(foldText(null), '');
});

test('build: one row per item the supplier lists, archived and made items left out, pack and price from the pack', () => {
  const items = synthetic();
  items[5].archivedAt = '2026-01-01';
  items[6].kind = 'MADE';
  const rows = buildPoItemRows({ items, supplierId: SUP, lines: [], pars, onOrder });
  assert.equal(rows.length, 1198);
  const r = rows.find(x => x.key === 'it-1');
  assert.equal(r.netPrice, 10);
  assert.equal(r.supplierSku, 'BH1');
  assert.equal(r.innerQty, 6);
  assert.equal(r.belowPar, true);
  assert.equal(rows.find(x => x.key === 'it-2').belowPar, false);
  assert.equal(rows.find(x => x.key === 'it-4').onOrder, 12);
  assert.equal(r.extra, false);
  assert.equal(r.line, null);
});

test('build: with two packs from one supplier the row is the PREFERRED pack, as the Order pad prices it', () => {
  const items = synthetic(10);
  // the bottle was added first (first by created_at), the case was starred later
  items[3].supplierProducts = [
    { id: 'sp-bottle', supplierId: SUP, supplierSku: 'B1', packQty: 1, innerQty: 2, innerUnit: 'l', packPrice: 3, netPackPrice: 2.5, isPreferred: false },
    { id: 'sp-case', supplierId: SUP, supplierSku: 'C6', packQty: 6, innerQty: 2, innerUnit: 'l', packPrice: 15, netPackPrice: 12.5, isPreferred: true, purchaseTaxRateId: 'vat-20' },
  ];
  items[3].baseUnit = 'l';
  const row = buildPoItemRows({ items, supplierId: SUP, lines: [], pars: { 'it-3': { parLevel: 20 } } }).find(r => r.key === 'it-3');
  assert.equal(row.sp.id, 'sp-case');
  assert.equal(row.packQty, 6);
  assert.equal(row.innerQty, 2);
  assert.equal(row.netPrice, 12.5);
  assert.equal(row.supplierSku, 'C6');
  assert.equal(row.suggestedPacks, 2);   // on hand 0, par 20 l, 12 l a case -> 2 cases, not 10 bottles
  const l = lineForRow(row, '2');
  assert.equal(l.supplierProductId, 'sp-case');
  assert.equal(l.unitPrice, 12.5);
  assert.equal(l.purchaseTaxRateId, 'vat-20');
  // with no star the first pack on file is used; another supplier's pack never is
  assert.equal(supplierPack({ supplierProducts: [{ id: 'a', supplierId: SUP }, { id: 'b', supplierId: SUP }] }, SUP).id, 'a');
  assert.equal(supplierPack({ supplierProducts: [{ id: 'a', supplierId: OTHER, isPreferred: true }] }, SUP), null);
  assert.equal(supplierPack(null, SUP), null);
});

test('build: suggested packs is the Order pad rule (top up to par with no history, whole packs)', () => {
  const rows = buildPoItemRows({ items: synthetic(10), supplierId: SUP, lines: [], pars: { 'it-1': { parLevel: 10 } } });
  // on hand 1, par 10, need 9, pack of 6 -> 2 packs
  assert.equal(rows.find(x => x.key === 'it-1').suggestedPacks, 2);
  // no par, no history -> nothing suggested
  assert.equal(rows.find(x => x.key === 'it-3').suggestedPacks, 0);
});

test('build: a line for an item the supplier does not list is an extra row with the line pack and price', () => {
  const items = synthetic(1300);
  const lines = [{ inventoryItemId: 'it-1250', description: 'Item 1250', qtyPacks: '2', packQty: 1, innerQty: 1, innerUnit: 'kg', unitPrice: 4.5 }];
  const rows = buildPoItemRows({ items, supplierId: SUP, lines });
  const x = rows.find(r => r.key === 'it-1250');
  assert.ok(x, 'extra row present');
  assert.equal(x.extra, true);
  assert.equal(x.netPrice, 4.5);
  assert.equal(x.innerUnit, 'kg');
  assert.equal(x.lineQty, 2);
  assert.equal(rowLineValue(x), 9);
  assert.equal(rows.length, 1201);
});

test('build: a line with no supplier chosen gives no supplier rows, only the lines', () => {
  const rows = buildPoItemRows({ items: synthetic(20), supplierId: '', lines: [{ inventoryItemId: 'it-3', qtyPacks: 1, unitPrice: 2 }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extra, true);
});

test('sort: lines on the order first in the order added, then A to Z', () => {
  const items = synthetic(50);
  const lines = [{ inventoryItemId: 'it-30', qtyPacks: '1', unitPrice: 10 }, { inventoryItemId: 'it-10', qtyPacks: '3', unitPrice: 10 }];
  const sorted = sortPoItemRows(buildPoItemRows({ items, supplierId: SUP, lines }));
  assert.equal(sorted[0].key, 'it-30');
  assert.equal(sorted[1].key, 'it-10');
  assert.equal(sorted[1].lineQty, 3);
  assert.equal(sorted[2].key, 'it-7');   // Creme brulee base sorts before Item 0000
  assert.equal(sorted[3].key, 'it-0');
});

test('sort: a pinned order freezes the top rows, so a quantity typed on a row does not move it while typing', () => {
  const items = synthetic(50);
  const before = [{ inventoryItemId: 'it-30', qtyPacks: '1', unitPrice: 10 }];
  const pinned = pinnedLines(before);
  assert.deepEqual([...pinned.entries()], [['it-30', 0]]);
  // a quantity is typed on it-45: the live lines now hold it, but the pinned order does not move it
  const after = [...before, { inventoryItemId: 'it-45', qtyPacks: '2', unitPrice: 10 }];
  const rows = buildPoItemRows({ items, supplierId: SUP, lines: after });
  const frozen = filterSortPoItems(rows, { pinned });
  assert.equal(frozen[0].key, 'it-30');
  assert.equal(frozen[1].key, 'it-7');   // Creme brulee base, the first name A to Z
  assert.equal(frozen.findIndex(r => r.key === 'it-45'), frozen.findIndex(r => r.key === 'it-44') + 1);
  // the next time the list is pinned (filters changed, order reopened) it-45 leads with the others
  const live = filterSortPoItems(rows, { pinned: pinnedLines(after) });
  assert.deepEqual(live.slice(0, 2).map(r => r.key), ['it-30', 'it-45']);
  // and with no pinned map the live lines lead, as sortPoItemRows alone does
  assert.deepEqual(filterSortPoItems(rows, {}).slice(0, 2).map(r => r.key), ['it-30', 'it-45']);
});

test('search: name, SKU and supplier code, accent and case insensitive, every word must match', () => {
  const rows = buildPoItemRows({ items: synthetic(), supplierId: SUP, lines: [] });
  assert.equal(filterSortPoItems(rows, { q: 'creme' }).length, 1);
  assert.equal(filterSortPoItems(rows, { q: 'CRÈME brulee' }).length, 1);
  assert.equal(filterSortPoItems(rows, { q: 'sku-42' })[0].key, 'it-42');
  assert.equal(filterSortPoItems(rows, { q: 'bh42' }).map(r => r.key).includes('it-42'), true);
  assert.equal(filterSortPoItems(rows, { q: 'item 0042' }).length, 1);
  assert.equal(filterSortPoItems(rows, { q: 'nothing here' }).length, 0);
  assert.equal(rowMatches({ name: 'A', sku: '', supplierSku: '' }, ''), true);
});

test('filters: category, area, below par only, on order only, on this order only, and the count line', () => {
  const items = synthetic();
  const lines = [{ inventoryItemId: 'it-9', qtyPacks: '1', unitPrice: 10 }];
  const rows = buildPoItemRows({ items, supplierId: SUP, lines, pars, onOrder });
  assert.deepEqual(categoriesOf(rows), ['Bread', 'Crème fraîche', 'Dairy', 'Flour', 'Pastry']);
  assert.deepEqual(areasOf(rows), ['Dry store', 'Freezer', 'Walk in']);
  assert.equal(filterSortPoItems(rows, { category: 'Bread' }).length, 240);
  assert.equal(filterSortPoItems(rows, { area: 'Freezer' }).length, 300);
  assert.equal(filterSortPoItems(rows, { category: 'Bread', area: 'Dry store' }).length, 60);
  assert.deepEqual(filterSortPoItems(rows, { belowPar: true }).map(r => r.key), ['it-1']);
  assert.deepEqual(filterSortPoItems(rows, { onOrderOnly: true }).map(r => r.key), ['it-4']);
  assert.deepEqual(filterSortPoItems(rows, { onThisOrder: true }).map(r => r.key), ['it-9']);
  assert.equal(countLine(60, 1200), '60 of 1,200 items shown');
  assert.equal(countLine(1200, 1200), '1,200 items');
  assert.equal(countLine(1, 1), '1 item');
});

test('filters: category and area spellings fold, so Dry store and dry store are one option that matches both', () => {
  const items = synthetic(12);
  items.forEach((it, i) => { it.storageLocation = i % 2 ? 'dry store' : 'Dry store'; it.category = i % 3 ? 'bread' : 'Bread'; });
  const rows = buildPoItemRows({ items, supplierId: SUP, lines: [] });
  assert.deepEqual(areasOf(rows), ['Dry store']);
  assert.deepEqual(categoriesOf(rows), ['Bread']);
  assert.equal(filterSortPoItems(rows, { area: 'Dry store' }).length, 12);
  assert.equal(filterSortPoItems(rows, { area: 'dry store' }).length, 12);
  assert.equal(filterSortPoItems(rows, { category: 'Bread', area: 'DRY STORE' }).length, 12);
  assert.equal(filterSortPoItems(rows, { area: 'Freezer' }).length, 0);
});

test('filters: on this order only keeps a pinned row whose box was just cleared, so it does not vanish under the cursor', () => {
  const items = synthetic(20);
  const before = [{ inventoryItemId: 'it-5', qtyPacks: '2', unitPrice: 10 }];
  const pinned = pinnedLines(before);
  const row = buildPoItemRows({ items, supplierId: SUP, lines: before }).find(r => r.key === 'it-5');
  const after = applyQty(before, row, '');
  assert.equal(after.length, 0);
  const rows = buildPoItemRows({ items, supplierId: SUP, lines: after });
  assert.deepEqual(filterSortPoItems(rows, { onThisOrder: true, pinned }).map(r => r.key), ['it-5']);
  // the next pin (filter change, order reopened) lets it go
  assert.deepEqual(filterSortPoItems(rows, { onThisOrder: true, pinned: pinnedLines(after) }), []);
  assert.deepEqual(filterSortPoItems(rows, { onThisOrder: true }), []);
});

test('scale: search and filter over 1,500 items stay instant (in memory, one pass)', () => {
  const rows = buildPoItemRows({ items: synthetic(), supplierId: SUP, lines: [], pars, onOrder });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) filterSortPoItems(rows, { q: `item ${String(i * 7).padStart(4, '0')}`, category: '', area: '' });
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `20 searches over 1,500 rows took ${ms.toFixed(0)} ms`);
});

test('applyQty: a number adds a line with the supplier pack and price, a change updates it, an empty box removes it', () => {
  const rows = buildPoItemRows({ items: synthetic(20), supplierId: SUP, lines: [] });
  const row = rows.find(r => r.key === 'it-3');
  let lines = applyQty([], row, '2');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].inventoryItemId, 'it-3');
  assert.equal(lines[0].qtyPacks, '2');
  assert.equal(lines[0].unitPrice, 10);
  assert.equal(lines[0].innerQty, 6);
  assert.equal(lines[0].supplierProductId, 'sp-3');
  lines = applyQty(lines, row, '0.');          // typing keeps the string
  assert.equal(lines[0].qtyPacks, '0.');
  lines = applyQty(lines, row, '');
  assert.equal(lines.length, 0);
  assert.equal(applyQty(lines, row, '').length, 0);   // clearing an empty row changes nothing
  // line order is preserved when a second item joins
  const row2 = rows.find(r => r.key === 'it-1');
  lines = applyQty(applyQty([], row, '1'), row2, '4');
  assert.deepEqual(lines.map(l => l.inventoryItemId), ['it-3', 'it-1']);
  assert.deepEqual(dropEmptyLines([...lines, { inventoryItemId: 'it-5', qtyPacks: '0' }, { inventoryItemId: 'it-6', qtyPacks: '' }]).map(l => l.inventoryItemId), ['it-3', 'it-1']);
});

test('lineForRow: an extra row keeps the line pack, price and VAT rate', () => {
  const items = synthetic(5);
  const lines = [{ inventoryItemId: 'it-9', description: 'Gone item', qtyPacks: '2', packQty: 2, innerQty: 5, innerUnit: 'kg', unitPrice: 7, purchaseTaxRateId: 'vat-0' }];
  const row = buildPoItemRows({ items, supplierId: SUP, lines }).find(r => r.extra);
  const l = lineForRow(row, '3');
  assert.equal(l.inventoryItemId, 'it-9');
  assert.equal(l.packQty, 2); assert.equal(l.innerQty, 5); assert.equal(l.innerUnit, 'kg'); assert.equal(l.unitPrice, 7);
  assert.equal(l.purchaseTaxRateId, 'vat-0');
  assert.equal(l.description, 'Gone item');
});

test('unlistedLineCheck: an item the supplier does not list needs a pack with a unit and a price above zero', () => {
  assert.equal(unlistedLineCheck({ packQty: 1, innerQty: 6, innerUnit: 'each', unitPrice: 4 }).ok, true);
  assert.match(unlistedLineCheck({ packQty: 0, innerQty: 6, innerUnit: 'each', unitPrice: 4 }).reason, /pack/);
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: '', innerUnit: 'each', unitPrice: 4 }).reason, /pack/);
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: 6, innerUnit: ' ', unitPrice: 4 }).reason, /unit/);
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: 6, innerUnit: 'each', unitPrice: 0 }).reason, /price/);
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: 6, innerUnit: 'each', unitPrice: '' }).reason, /price/);
});

test('unlistedLineCheck: the unit must convert to the item unit, or receiving would refuse the whole sent order', () => {
  const flour = { baseUnit: 'g', conversions: [], itemName: 'Flour' };
  assert.equal(unlistedLineCheck({ packQty: 1, innerQty: 16, innerUnit: 'kg', unitPrice: 9 }, flour).ok, true);
  assert.equal(unlistedLineCheck({ packQty: 1, innerQty: 16, innerUnit: 'KG ', unitPrice: 9 }, flour).ok, true);
  const bad = unlistedLineCheck({ packQty: 1, innerQty: 2, innerUnit: 'crate', unitPrice: 9 }, flour);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /crate cannot be converted to Flour's unit \(g\)/);
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: 2, innerUnit: 'l', unitPrice: 9 }, flour).reason, /Units tab/);
  // a bridge on the item makes the unit good
  assert.equal(unlistedLineCheck({ packQty: 1, innerQty: 2, innerUnit: 'crate', unitPrice: 9 }, { ...flour, conversions: [{ fromQty: 1, fromUnit: 'crate', toQty: 12000, toUnit: 'g' }] }).ok, true);
  // the unit is checked before the price, so one message at a time in the order the boxes sit
  assert.match(unlistedLineCheck({ packQty: 1, innerQty: 2, innerUnit: 'crate', unitPrice: '' }, flour).reason, /crate/);
  // no item unit given: the old check, unit words only
  assert.equal(unlistedLineCheck({ packQty: 1, innerQty: 2, innerUnit: 'crate', unitPrice: 9 }).ok, true);
});

test('relineForSupplier: lines are rebuilt from the new supplier pack at the same packs, items it does not sell come off', () => {
  const items = synthetic(1300);
  items[2].supplierProducts.push({ id: 'sp-dairy-2', supplierId: OTHER, supplierSku: 'D2', packQty: 12, innerQty: 1, innerUnit: 'each', packPrice: 30, netPackPrice: 25, isPreferred: false, purchaseTaxRateId: 'vat-0' });
  const lines = [
    { id: 'pl-1', inventoryItemId: 'it-2', description: 'Item 0002', qtyPacks: '3', packQty: 1, innerQty: 6, innerUnit: 'each', unitPrice: 10, supplierProductId: 'sp-2' },
    { id: 'pl-2', inventoryItemId: 'it-9', description: 'Item 0009', qtyPacks: '1', packQty: 1, innerQty: 6, innerUnit: 'each', unitPrice: 10, supplierProductId: 'sp-9' },
    { inventoryItemId: 'it-gone', description: 'Old item', qtyPacks: '1', packQty: 1, innerQty: 1, innerUnit: 'each', unitPrice: 1 },
  ];
  const { lines: kept, dropped } = relineForSupplier(lines, items, OTHER);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'pl-1');
  assert.equal(kept[0].qtyPacks, '3');
  assert.equal(kept[0].packQty, 12);
  assert.equal(kept[0].unitPrice, 25);
  assert.equal(kept[0].supplierProductId, 'sp-dairy-2');
  assert.equal(kept[0].purchaseTaxRateId, 'vat-0');
  assert.deepEqual(dropped, ['Item 0009', 'Old item']);
  // back to the first supplier: the one kept line is priced off its pack again
  assert.equal(relineForSupplier(kept, items, SUP).lines[0].supplierProductId, 'sp-2');
  assert.deepEqual(relineForSupplier([], items, SUP), { lines: [], dropped: [] });
});

test('itemArea: reads whichever field names the storage area', () => {
  assert.equal(itemArea({ storageLocation: 'Dry store' }), 'Dry store');
  assert.equal(itemArea({ storageArea: 'Walk in', storageLocation: 'old' }), 'Walk in');
  assert.equal(itemArea(null), '');
});

test('no long dashes in the module or its words', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./poItemList.js', import.meta.url), 'utf8');
  assert.equal(/[\u2013\u2014]/.test(src), false, 'poItemList.js carries a long dash');
});

// v5.11.96 (multi site stock Drop 3, contract 2.3): the cover is the one delivery rule (coverFromRules).
import { coverOf } from './poItemList.js';
import fs from 'node:fs';
import { coverDaysFromSchedule } from './purchasingRules.js';

test('coverOf: with only today\'s weekday it is exactly the old coverDaysFromSchedule', () => {
  const schedules = [['tue', 'thu'], [1, 2, 3, 4, 5, 6], ['mon'], ['sun'], [], null, ['noday'], ['fri', 'sat', 'sun']];
  for (const days of schedules) {
    for (let dow = 0; dow < 7; dow++) {
      assert.equal(coverOf({ deliveryDays: days, todayDow: dow }), coverDaysFromSchedule(days, dow), `${JSON.stringify(days)} on day ${dow}`);
    }
  }
});

test('coverOf: with the venue clock the cut off counts', () => {
  // Wed 21 Oct 2026; Tue and Thu deliveries ordered by the day before at 14:00
  assert.equal(coverOf({ deliveryDays: ['tue', 'thu'], cutoffTime: '14:00', nowVenue: { ymd: '2026-10-21', hm: '10:00' } }), 6);
  assert.equal(coverOf({ deliveryDays: ['tue', 'thu'], cutoffTime: '14:00', nowVenue: { ymd: '2026-10-21', hm: '15:00' } }), 8);
  const rules = [{ delivery_dow: 4, order_by_dow: 4, order_by_time: '06:00' }];
  assert.equal(coverOf({ rules, nowVenue: { ymd: '2026-10-22', hm: '05:00' } }), 7, 'the rows win over the columns');
  assert.equal(coverOf({ deliveryDays: [], nowVenue: { ymd: '2026-10-22', hm: '05:00' } }), null);
});

test('buildPoItemRows reads the cover through coverOf (no old rule left)', () => {
  const src = fs.readFileSync(new URL('./poItemList.js', import.meta.url), 'utf8');
  assert.match(src, /const sched = coverOf\(\{ deliveryDays, todayDow, rules, cutoffTime, exceptions, nowVenue \}\);/);
  assert.doesNotMatch(src, /coverDaysFromSchedule\(/);
});
