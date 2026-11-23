// itemSticker.test.js: the sticker's words, the count across an order, and the paper it builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stickerUnits, stickerRuns, stickerHeader, stickerHeadline, stickerOrderNo, stickerCount, sideBySide,
} from './itemSticker.js';
import { buildItemStickerDoc } from './printDoc.js';

const textOf = (doc) => doc.ops.filter(o => o.t === 'text').map(o => o.s).join('\n');

test('stickerUnits: one per unit, kitchen only', () => {
  assert.equal(stickerUnits([{ qty: 2 }, { qty: 1 }, { qty: 1, noKitchen: true }, { qty: 0 }]), 4);
  assert.equal(stickerUnits(null), 0);
});

test('stickerRuns: the total is the whole order, offsets follow the centres in order', () => {
  const runs = stickerRuns([[{ qty: 1 }, { qty: 1 }], [{ qty: 1 }]]);
  assert.deepEqual(runs, [{ offset: 0, total: 3 }, { offset: 2, total: 3 }]);
  assert.deepEqual(stickerRuns([]), []);
});

test('stickerHeader: channel and order type words', () => {
  assert.equal(stickerHeader({ channel: 'online', orderType: 'takeaway' }), 'Online ordering · Take away');
  assert.equal(stickerHeader({ channel: 'till', orderType: 'dine-in' }), 'Till · Eat in');
  assert.equal(stickerHeader({ channel: 'hubrise', orderType: 'delivery' }, { channel: 'Deliveroo' }), 'Deliveroo · Delivery');
  assert.equal(stickerHeader({ channel: 'hubrise', orderType: 'delivery' }), 'Delivery app · Delivery');
  assert.equal(stickerHeader({ channel: 'kiosk' }), 'Kiosk');
  assert.equal(stickerHeader(null), 'Order');
});

test('stickerHeadline: the name first, then the table as the kitchen ticket says it', () => {
  assert.equal(stickerHeadline({ customerName: 'Paul Dansie' }, 'T5'), 'Paul Dansie');
  assert.equal(stickerHeadline({}, 'T5'), 'TABLE T5');
  assert.equal(stickerHeadline(null, 'Takeaway · Sarah'), 'Takeaway · Sarah');
  assert.equal(stickerHeadline(null, 'Online OL-123'), 'Online OL-123');
  assert.equal(stickerHeadline(null, ''), 'WALK-IN');
  // A kiosk order keeps its number as the headline, never a name in place of it.
  assert.equal(stickerHeadline({ channel: 'kiosk', customerName: 'Sam' }, 'Kiosk #47'), 'Kiosk #47');
  assert.equal(stickerHeadline({ channel: 'kiosk', customerName: 'Sam' }, 'Table 12 · #47'), 'Table 12 · #47');
});

test('stickerOrderNo and stickerCount', () => {
  assert.equal(stickerOrderNo({ orderNo: '26' }), '#26');
  assert.equal(stickerOrderNo({ orderNo: '#26' }), '#26');
  assert.equal(stickerOrderNo({}), '');
  assert.equal(stickerCount(2, 3), '2 of 3');
  assert.equal(stickerCount(9, 3), '3 of 3');
  assert.equal(stickerCount(0, 0), '1 of 1');
});

test('sideBySide: exactly the width, the left is cut before the right', () => {
  const line = sideBySide('Online ordering · Take away', '2 of 3', 42);
  assert.equal(line.length, 42);
  assert.ok(line.startsWith('Online ordering · Take away'));
  assert.ok(line.endsWith('2 of 3'));
  const tight = sideBySide('A very long channel name that will not fit at all', '12 of 12', 32);
  assert.equal(tight.length, 32);
  assert.ok(tight.endsWith(' 12 of 12'));
  assert.equal(sideBySide('Only left', '', 10), 'Only left');
});

test('buildItemStickerDoc: the Day Break layout, top to bottom', () => {
  const doc = buildItemStickerDoc({
    meta: { channel: 'online', orderType: 'takeaway', customerName: 'Paul Dansie', orderNo: '26' },
    table: 'Online R1226', centreName: 'Pizza oven',
    item: { name: 'Sausage Mushroom', qty: 1, mods: ['Red Pepper Flakes'], notes: 'Well done' },
    index: 1, total: 3, sentAt: Date.UTC(2026, 10, 5, 1, 38),
  }, { cols: 42 });
  const text = textOf(doc);
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('Online ordering · Take away'), lines[0]);
  assert.ok(lines[0].endsWith('1 of 3'), lines[0]);
  assert.equal(lines[1], 'Paul Dansie');
  assert.equal(lines[2], 'SAUSAGE MUSHROOM');
  assert.equal(lines[3], '  Red Pepper Flakes');
  assert.equal(lines[4], '  Well done');
  assert.ok(/2026/.test(lines[5]) && lines[5].endsWith('#26'), lines[5]);
  assert.equal(lines[6], 'Pizza oven');
  assert.ok(doc.ops.some(o => o.t === 'cut'), 'cuts');
  // The name is double width and double height; the item is double height.
  const sizes = doc.ops.filter(o => o.t === 'size').map(o => o.v);
  assert.deepEqual(sizes, ['both', 'height']);
  assert.ok(doc.ops.some(o => o.t === 'color' && o.v === 'red'), 'changes print red');
});

test('buildItemStickerDoc: no meta, no name, no number: the table stands in and the foot has no number', () => {
  const doc = buildItemStickerDoc({ table: 'T7', item: { name: 'Flat White', qty: 1 }, index: 2, total: 2, sentAt: Date.now() }, { cols: 32 });
  const lines = textOf(doc).split('\n');
  assert.ok(lines[0].startsWith('Order'), lines[0]);
  assert.ok(lines[0].endsWith('2 of 2'));
  assert.equal(lines[0].length, 32);
  assert.equal(lines[1], 'TABLE T7');
  assert.equal(lines[2], 'FLAT WHITE');
  assert.ok(!lines[3].includes('#'), lines[3]);
});

test('buildItemStickerDoc: reprint and new customer still show, a long name is cut to the double width line', () => {
  const doc = buildItemStickerDoc({
    meta: { channel: 'till', orderType: 'dine-in', customerName: 'Bartholomew Fitzgerald-Montgomery' },
    item: { name: 'Tea' }, index: 1, total: 1, sentAt: Date.now(), reprint: true, newCustomer: true,
  }, { cols: 42 });
  const lines = textOf(doc).split('\n');
  assert.equal(lines[1].length, 21);
  assert.equal(lines[2], '** REPRINT **');
  assert.equal(lines[3], '** NEW CUSTOMER **');
});

test('no long dashes in the sticker words', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'itemSticker.js'), 'utf8');
  assert.ok(!new RegExp('[\\u2013\\u2014]').test(src));
});
