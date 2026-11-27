// 5.12.115: "Sold as": which order types a product can be sold on (src/lib/soldAs.js).
// Peter, 26 Nov 2026: "a prime example is Wine: they only serve this on dine in orders, never
// online or to be taken away", and "grey it out and say not available for X order type when clicked".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOLD_AS_TYPES, SOLD_AS_WORDS, soldAsKey, notSoldAs, soldAsList, isSoldAs, notSoldAsWords, soldAsSummary,
  withNotSoldAs, toggleSoldAs, sameSoldAs, linesNotSoldAs, switchBlockedWords,
} from './soldAs.js';
import { ORDER_TYPE_KEYS } from './tillOrderType.js';
import { channelVisible } from './channelMenu.js';

const wine = { id: 'wine', name: 'House Wine', visibility: { pos: true, kiosk: true, online: true, notSoldAs: ['takeaway', 'collection', 'delivery', 'drive-thru'] } };
const pizza = { id: 'pizza', name: 'Margherita', visibility: { pos: true, kiosk: true, online: true } };
const old = { id: 'old', name: 'Old row' };   // saved before this rule: no visibility at all

test('the order types are the app\'s own (the POS, device profiles, the kiosk, online)', () => {
  assert.deepEqual([...SOLD_AS_TYPES], [...ORDER_TYPE_KEYS]);
  for (const k of SOLD_AS_TYPES) assert.ok(SOLD_AS_WORDS[k], `${k} has words`);
});

test('every spelling of an order type lands on the one key', () => {
  for (const [said, key] of [
    ['dine-in', 'dine-in'], ['dineIn', 'dine-in'], ['eat-in', 'dine-in'], ['bar-tab', 'dine-in'], ['qr', 'dine-in'], ['table', 'dine-in'],
    ['takeaway', 'takeaway'], ['take-away', 'takeaway'], ['Takeaway', 'takeaway'],
    ['collection', 'collection'], ['collect', 'collection'], ['pickup', 'collection'],
    ['delivery', 'delivery'], ['drive-thru', 'drive-thru'], ['driveThru', 'drive-thru'], ['drivethru', 'drive-thru'],
  ]) assert.equal(soldAsKey(said), key, said);
  for (const none of [null, undefined, '', '  ', 'catering-banquet', 42]) assert.equal(soldAsKey(none), null);
});

test('wine: dine in only. Sold at a table, a bar tab and by QR; not to take away, collect, deliver or drive thru', () => {
  for (const ok of ['dine-in', 'bar-tab', 'qr', 'dineIn']) assert.equal(isSoldAs(wine, ok), true, ok);
  for (const no of ['takeaway', 'collection', 'delivery', 'drive-thru', 'driveThru']) assert.equal(isSoldAs(wine, no), false, no);
  assert.deepEqual(soldAsList(wine), ['dine-in']);
  assert.equal(soldAsSummary(wine), 'Dine in only');
  assert.equal(notSoldAsWords(wine, 'takeaway'), 'House Wine is not available for Takeaway.');
  assert.equal(notSoldAsWords(wine, 'drive-thru'), 'House Wine is not available for Drive thru.');
});

test('a product nobody has touched is sold on every order type, and no order type blocks nothing', () => {
  for (const p of [pizza, old, { id: 'x', visibility: null }, { id: 'y', visibility: { notSoldAs: [] } }, { id: 'z', visibility: { notSoldAs: 'takeaway' } }]) {
    for (const t of SOLD_AS_TYPES) assert.equal(isSoldAs(p, t), true);
    assert.deepEqual(notSoldAs(p), []);
    assert.equal(soldAsSummary(p), '');
  }
  // A walk in order before an order type is picked, or one the app does not know: never blocked.
  for (const t of [null, undefined, '', 'something-else']) assert.equal(isSoldAs(wine, t), true);
  assert.equal(isSoldAs(null, 'takeaway'), true);
});

test('a size follows its product, in the store shape and as a database row', () => {
  const large = { id: 'wine-l', name: 'Large', parentId: 'wine' };
  const largeRow = { id: 'wine-l', name: 'Large', parent_id: 'wine' };
  assert.equal(isSoldAs(large, 'takeaway', [wine, large]), false);
  assert.equal(isSoldAs(largeRow, 'takeaway', new Map([['wine', wine]])), false);
  assert.equal(isSoldAs(large, 'dine-in', [wine, large]), true);
  assert.equal(isSoldAs(large, 'takeaway'), true, 'with no rows to look its product up in, it is judged on its own');
  // A size can also be blocked on its own.
  assert.equal(isSoldAs({ id: 's', parentId: 'pizza', visibility: { notSoldAs: ['delivery'] } }, 'delivery', [pizza]), false);
});

test('the list is kept beside the Visible on switches and never touches them', () => {
  const v = { pos: true, kiosk: false, online: true, onlineDelivery: false };
  const dineOnly = withNotSoldAs(v, ['takeaway', 'delivery']);
  assert.deepEqual(dineOnly, { pos: true, kiosk: false, online: true, onlineDelivery: false, notSoldAs: ['takeaway', 'delivery'] });
  assert.deepEqual(v, { pos: true, kiosk: false, online: true, onlineDelivery: false }, 'the one passed in is not changed');
  assert.deepEqual(withNotSoldAs(dineOnly, []), v, 'sold on everything again: the key is taken off');
  // Where it shows is read exactly as before with the list there.
  const row = { visibility: dineOnly };
  assert.equal(channelVisible(row, 'pos'), true);
  assert.equal(channelVisible(row, 'kiosk'), false);
  assert.equal(channelVisible(row, 'online', 'delivery'), false);
  // Any spelling in, the app's spelling out, each once, in the app's order, unknown ones dropped.
  assert.deepEqual(withNotSoldAs({}, ['driveThru', 'takeaway', 'take-away', 'nonsense']).notSoldAs, ['takeaway', 'drive-thru']);
  assert.equal(withNotSoldAs(null, []), null, 'nothing set and nothing to block stays as it was');
  assert.equal(withNotSoldAs(undefined, []), undefined);
  assert.deepEqual(withNotSoldAs(null, ['delivery']), { notSoldAs: ['delivery'] });
});

test('ticking and unticking one order type', () => {
  let v = { pos: true };
  v = toggleSoldAs(v, 'takeaway', false);
  v = toggleSoldAs(v, 'delivery', false);
  assert.deepEqual(v, { pos: true, notSoldAs: ['takeaway', 'delivery'] });
  v = toggleSoldAs(v, 'takeaway', true);
  assert.deepEqual(v, { pos: true, notSoldAs: ['delivery'] });
  v = toggleSoldAs(v, 'delivery', true);
  assert.deepEqual(v, { pos: true });
  assert.equal(sameSoldAs({ visibility: { notSoldAs: ['delivery', 'takeaway'] } }, { visibility: { pos: false, notSoldAs: ['takeaway', 'delivery'] } }), true);
  assert.equal(sameSoldAs(wine, pizza), false);
});

test('the short line on a card: one type only, not for one type, or the ones it is sold on', () => {
  const s = (list) => soldAsSummary({ visibility: { notSoldAs: list } });
  assert.equal(s(['delivery']), 'Not for Delivery');
  assert.equal(s(['takeaway', 'collection', 'delivery', 'drive-thru']), 'Dine in only');
  assert.equal(s(['delivery', 'drive-thru', 'collection']), 'Dine in, Takeaway only');
  assert.equal(s([...SOLD_AS_TYPES]), 'Not sold on any order type');
});

test('switching the order type: the lines that cannot stay, and the words for it', () => {
  const items = [wine, pizza, { id: 'wine-l', name: 'Large', parentId: 'wine' }];
  const lines = [{ uid: 'a', itemId: 'pizza', name: 'Margherita' }, { uid: 'b', itemId: 'wine', name: 'House Wine' }, { uid: 'c', itemId: 'wine-l', name: 'House Wine, Large' }, { uid: 'd', itemId: 'gone', name: 'Deleted product' }];
  assert.deepEqual(linesNotSoldAs(lines, 'takeaway', items).map((l) => l.uid), ['b', 'c']);
  assert.deepEqual(linesNotSoldAs(lines, 'dine-in', items), []);
  assert.deepEqual(linesNotSoldAs(lines, null, items), [], 'no order type named: nothing is in the way');
  assert.equal(switchBlockedWords([{ name: 'House Wine' }], 'takeaway'), 'House Wine is not available for Takeaway. Take it off the order first.');
  assert.equal(switchBlockedWords([{ name: 'House Wine' }, { name: 'Prosecco' }], 'collection'), 'House Wine and Prosecco are not available for Collection. Take them off the order first.');
  assert.equal(switchBlockedWords([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'A' }], 'delivery'), 'A, B and 1 more are not available for Delivery. Take them off the order first.');
  assert.equal(switchBlockedWords([], 'takeaway'), '');
});
