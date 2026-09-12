/**
 * orderScreenStatus.test.js: the order screen status, channel, name and config rules.
 * Run: `npm test`.
 *
 * These rules are mirrored in SQL (20260911_OPS_order_status_displays.sql). The feed
 * RPC is what real TVs use; these tests pin the same rules so the Back Office preview
 * and the SQL cannot drift apart silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNELS, ORDER_TYPES, STEPS, BUCKETS, DEFAULT_LABELS, DEFAULT_SETTINGS, DEFAULT_THEME,
  channelKeyOf, orderTypeKey, formatOrderName, orderNumberOf, channelLabel, courierLabel,
  newDisplayTemplate, newSection, normaliseDisplay, validateDisplay, evaluateOrder,
  rowFromFeed, visibleRows, sortRows, normalisePairCode, friendlyPairError, isAbsentError,
  sampleOrders, lastSeenLabel, contrastRatio, MIN_LARGE_CONTRAST, resolveNumberClashes,
} from './orderScreenStatus.js';

// ── names follow each section's own Name on screen choice, and number clashes ──

// One section that takes everything, with the name format under test. A section is the only
// control over names: short shortens, full shows the lot, number shows no name at all.
const sectionWith = (nameFormat) => ({
  name: 'One', sections: [{ id: 'only', title: 'Only', channels: CHANNELS.map(c => c.key),
    orderTypes: ORDER_TYPES.map(t => t.key), statuses: [...STEPS], nameFormat }],
  settings: { ...DEFAULT_SETTINGS },
});

test('evaluateOrder: the section name format is the only control over names', () => {
  const NOWX = Date.parse('2026-09-11T12:00:00Z');
  const staffMoved = { createdAt: NOWX - 60000, statusChangedAt: NOWX - 30000, firstSeenAt: NOWX - 60000 };
  const o = { ref: 'R47', source: 'pos', type: 'dine-in', status: 'prep', customer: { name: 'Joseph Walker' }, ...staffMoved };
  const short = evaluateOrder(o, sectionWith('short'), NOWX);
  const full = evaluateOrder(o, sectionWith('full'), NOWX);
  const number = evaluateOrder(o, sectionWith('number'), NOWX);
  assert.equal(short.row.name, 'Joseph W');
  assert.equal(full.row.name, 'Joseph Walker');
  assert.equal(number.row.name, null, 'Order number only shows no name');
  assert.equal(number.row.number, '47');
  // Nothing else about the row moves with the format, and every one of them still shows.
  for (const r of [full, number]) {
    assert.deepEqual({ ...r.row, name: short.row.name }, short.row, 'only the name differs');
    assert.equal(r.visible, true);
  }
  // A customer typed name still waits for a status change made in a separate request.
  const kiosk = { ref: 'R13', source: 'kiosk', type: 'dine-in', status: 'prep', customer: { name: 'Priya Kaur' } };
  const fresh = evaluateOrder({ ...kiosk, createdAt: NOWX - 60000, statusChangedAt: NOWX - 60000, firstSeenAt: NOWX - 60000 }, sectionWith('full'), NOWX);
  assert.equal(fresh.row.name, null, 'kiosk name untouched by staff');
  assert.equal(evaluateOrder({ ...kiosk, ...staffMoved }, sectionWith('full'), NOWX).row.name, 'Priya Kaur');
  // There is no second control: the v5.8.61 screen switch is gone, and a stray saved one is ignored.
  assert.equal('showNamesNow' in DEFAULT_SETTINGS, false);
  assert.equal('showNamesNow' in normaliseDisplay({ settings: { showNamesNow: true } }).settings, false);
  const stray = { ...sectionWith('number'), settings: { ...DEFAULT_SETTINGS, showNamesNow: true } };
  assert.equal(evaluateOrder(o, stray, NOWX).row.name, null, 'an old saved setting changes nothing');
  // The template ships a names section and a numbers section, and both behave that way.
  const tpl = newDisplayTemplate();
  assert.equal(tpl.sections[0].nameFormat, 'short');
  assert.equal(tpl.sections[2].nameFormat, 'number');
  assert.equal(evaluateOrder(o, tpl, NOWX).row.name, 'Joseph W');
});

test('resolveNumberClashes: online, catering and QR codes that clash in a section show 4 characters', () => {
  const row = (key, number, sectionIndex = 1) => ({ key, number, sectionIndex, bucket: 'preparing' });
  const out = resolveNumberClashes([row('OL-AB9ZZ', '9ZZ'), row('OL-CD9ZZ', '9ZZ'), row('CA-XY9ZZ', '9ZZ'), row('OL-QQ123', '123'), row('OL-RR9ZZ', '9ZZ', 2)]);
  assert.deepEqual(out.map(r => r.number), ['B9ZZ', 'D9ZZ', 'Y9ZZ', '123', '9ZZ'], 'another section never clashes');
  const mixed = resolveNumberClashes([row('R47', '47'), row('HR-1', '47'), row('QR-AB047', '047')]);
  assert.deepEqual(mixed.map(r => r.number), ['47', '47', '047'], 'till and app numbers are never widened');
  const withTracking = resolveNumberClashes([row('HR-x', 'A7F'), row('QR-12A7F', 'A7F')]);
  assert.deepEqual(withTracking.map(r => r.number), ['A7F', '2A7F'], 'only the tracking ref row widens');
  assert.deepEqual(resolveNumberClashes(null), []);
  const input = [row('OL-AB9ZZ', '9ZZ'), row('OL-CD9ZZ', '9ZZ')];
  resolveNumberClashes(input);
  assert.equal(input[0].number, '9ZZ', 'input rows are not changed');
});
import { CUSTOMER_TYPED_SOURCES } from './orderScreenStatus.js';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;

// One section that takes every channel, type and step, so a test isolates one rule.
const allDisplay = (settings = {}) => ({
  name: 'All', sections: [{ id: 'all', title: 'All', channels: CHANNELS.map(c => c.key),
    orderTypes: ORDER_TYPES.map(t => t.key), statuses: [...STEPS], nameFormat: 'short' }],
  // The product default is lingerMinutes 0 (collected leaves at once), so the linger rules
  // are tested against an explicit 2 here. A test that wants the default passes 0 itself.
  settings: { ...DEFAULT_SETTINGS, lingerMinutes: 2, ...settings },
});
const order = (o = {}) => ({
  ref: 'R1047', source: 'kiosk', type: 'dine-in', status: 'received', customer: { name: 'Joseph Wong' },
  sentAt: null, createdAt: NOW - 5 * MIN, statusChangedAt: NOW - 4 * MIN, firstSeenAt: NOW - 5 * MIN,
  departedAt: null, departedFrom: null, courier: null, hubrise: null, ...o,
});
const ev = (o, display = allDisplay()) => evaluateOrder(order(o), display, NOW);

// ── channelKeyOf ─────────────────────────────────────────────────────────────

test('channelKeyOf maps delivery apps through HubRise', () => {
  assert.equal(channelKeyOf('hubrise', 'Deliveroo'), 'deliveroo');
  for (const c of ['Uber Eats', 'UberEats', 'uber_eats']) assert.equal(channelKeyOf('hubrise', c), 'ubereats', c);
  for (const c of ['Just Eat', 'JUST-EAT']) assert.equal(channelKeyOf('hubrise', c), 'justeat', c);
  for (const c of ['HubRise', null, 'Takeaway.com']) assert.equal(channelKeyOf('hubrise', c), 'other_app', String(c));
});

test('channelKeyOf maps venue channels and the till', () => {
  assert.equal(channelKeyOf('ezcater', 'ezCater'), 'ezcater');
  for (const s of ['kiosk', 'online', 'qr', 'catering']) assert.equal(channelKeyOf(s, null), s);
  for (const s of ['pos', null, 'pax_table_pay', 'pos_send_to_terminal']) assert.equal(channelKeyOf(s, 'Deliveroo'), 'till', String(s));
});

// ── orderTypeKey ─────────────────────────────────────────────────────────────

test('orderTypeKey normalises spellings', () => {
  assert.equal(orderTypeKey('dine-in'), 'dine-in');
  assert.equal(orderTypeKey('eat_in'), 'dine-in');
  assert.equal(orderTypeKey('Dine In'), 'dine-in');
  assert.equal(orderTypeKey('takeout'), 'takeaway');
  assert.equal(orderTypeKey('takeaway'), 'takeaway');
  assert.equal(orderTypeKey('pickup'), 'collection');
  assert.equal(orderTypeKey('collection'), 'collection');
  assert.equal(orderTypeKey('delivery'), 'delivery');
  assert.equal(orderTypeKey('bar-tab'), null);
  assert.equal(orderTypeKey(null), null);
});

// ── formatOrderName ──────────────────────────────────────────────────────────

test('formatOrderName shortens to first name and last initial', () => {
  assert.equal(formatOrderName('Joseph Wong'), 'Joseph W');
  assert.equal(formatOrderName('Joseph W.'), 'Joseph W');
  assert.equal(formatOrderName('Mary Ann Smith', 'short'), 'Mary S');
  assert.equal(formatOrderName('Madonna', 'short'), 'Madonna');
  assert.equal(formatOrderName('  Joseph    Wong  '), 'Joseph W');
  assert.equal(formatOrderName('Zoë Ölander'), 'Zoë Ö');
});

test('formatOrderName full and number formats', () => {
  assert.equal(formatOrderName('Bartholomew Montgomery Smithson', 'full'), 'Bartholomew Montgomery S');
  // Astral letters count as one code point each. Emoji are not letters, so they never show.
  assert.equal(Array.from(formatOrderName('𝒜'.repeat(30), 'full')).length, 24);
  assert.equal(formatOrderName('😀'.repeat(30), 'full'), null);
  assert.equal(formatOrderName('Joseph Wong', 'number'), null);
  assert.equal(formatOrderName('Joseph   Wong', 'full'), 'Joseph Wong');
});

test('formatOrderName never shows a phone number or an email address', () => {
  for (const n of ['07700-900123', '+447700900123', 'john.smith@example.com', '+44 7700 900123', 'Sam 07700 900123', 'sam@x']) {
    assert.equal(formatOrderName(n, 'short'), null, n);
    assert.equal(formatOrderName(n, 'full'), null, n);
  }
  // Any digit hides the name: stripping digits left broken words on the TV.
  for (const n of ['R2D2 Droid', 'Bob 2nd', 'Flat 12B', 'John (table 4)', 'Agent 007']) {
    assert.equal(formatOrderName(n, 'short'), null, n);
    assert.equal(formatOrderName(n, 'full'), null, n);
  }
  assert.equal(formatOrderName('Louis XIV', 'full'), 'Louis XIV', 'letters that look like numbers still show');
});

test('formatOrderName keeps only letters, spaces, apostrophes and hyphens', () => {
  assert.equal(formatOrderName('SCAMWEBSITE.COM Pays', 'full'), 'SCAMWEBSITECOM Pays');
  assert.equal(formatOrderName('SCAMWEBSITE.COM Pays', 'short'), 'SCAMWEBSITECOM P');
  assert.equal(formatOrderName("Siobhán O'Brien", 'full'), "Siobhán O'Brien");
  assert.equal(formatOrderName('Mary-Jane Smith', 'short'), 'Mary-Jane S');
  assert.equal(formatOrderName('<b>Jo</b>', 'full'), 'bJob');
  assert.equal(formatOrderName('!!! ???', 'short'), null);
  assert.equal(formatOrderName('-', 'short'), null);
  assert.equal(formatOrderName('Walk-in!', 'short'), null, 'a placeholder after cleaning');
});

test('formatOrderName hides placeholders and numbers', () => {
  for (const n of ['Order 5285', 'HubRise customer', 'ezCater customer', 'takeaway', 'dine-in', 'Walk-in', 'Guest', 'Table 4', '12345', '', '   ', '# 47', null]) {
    assert.equal(formatOrderName(n, 'short'), null, String(n));
    assert.equal(formatOrderName(n, 'full'), null, String(n));
  }
});

// ── orderNumberOf ────────────────────────────────────────────────────────────

test('orderNumberOf follows the receipt short number for till refs', () => {
  assert.equal(orderNumberOf({ ref: 'R1247', source: 'pos' }), '47');
  assert.equal(orderNumberOf({ ref: 'R7', source: 'kiosk' }), '7');
  assert.equal(orderNumberOf({ ref: 'R1247', source: 'pos', courierBackend: 'stuart' }), 'R1247');
});

test('orderNumberOf never shows a full online, catering or QR ref (an order tracking lookup key)', () => {
  assert.equal(orderNumberOf({ ref: 'OL-7K2QX', source: 'online' }), '2QX');
  assert.equal(orderNumberOf({ ref: 'OL-9QW3M', source: 'online', courierBackend: 'stuart' }), 'W3M');
  assert.equal(orderNumberOf({ ref: 'CA-4H8PD', source: 'catering' }), '8PD');
  assert.equal(orderNumberOf({ ref: 'QR-ABCDE', source: 'qr' }), 'CDE');
  // Other refs are unchanged.
  assert.equal(orderNumberOf({ ref: '#6720', source: 'pos' }), '#6720');
});

test('orderNumberOf uses the delivery app code', () => {
  assert.equal(orderNumberOf({ ref: 'HR-abcdef123', source: 'hubrise', customer: { collectionCode: 'A7F3' } }), 'A7F3');
  assert.equal(orderNumberOf({ ref: 'HR-abcdef123', source: 'hubrise', customer: { collectionCode: '123456789012345' } }), '012345');
  assert.equal(orderNumberOf({ ref: 'HR-abcdef123', source: 'hubrise', customer: {} }), 'f123');
  assert.equal(orderNumberOf({ ref: 'EZ-1234-5678-abcd', source: 'ezcater', customer: { ezcater_order_number: '9XK22M' } }), '9XK22M');
  assert.equal(orderNumberOf({ ref: 'EZ-1234-5678-abcd', source: 'ezcater', customer: {} }), '8-abcd');
});

test('channelLabel and courierLabel', () => {
  assert.equal(channelLabel({ channel: 'ubereats' }), 'Uber Eats');
  assert.equal(channelLabel({ channel: 'qr' }), 'Table QR');
  assert.equal(channelLabel({ channel: 'other_app', channelName: 'Foodhub' }), 'Foodhub');
  assert.equal(channelLabel({ channel: 'other_app', channelName: null }), 'Delivery app');
  assert.equal(courierLabel('stuart'), 'Stuart');
  assert.equal(courierLabel('uber_api'), 'Uber Direct');
  assert.equal(courierLabel('hubrise_bridge'), 'Courier');
  assert.equal(courierLabel(null), null);
});

// ── evaluateOrder matrix ─────────────────────────────────────────────────────

test('evaluateOrder: live statuses map to buckets', () => {
  assert.deepEqual([ev({}).visible, ev({}).row.bucket], [true, 'received']);
  const fired = ev({ status: 'scheduled', sentAt: NOW - MIN });
  assert.deepEqual([fired.visible, fired.row.bucket], [true, 'received']);
  assert.equal(ev({ status: 'prep' }).row.bucket, 'preparing');
  assert.equal(ev({ status: 'ready' }).row.bucket, 'ready');
  for (const s of ['cancelled', 'paid', 'foo']) {
    const r = ev({ status: s });
    assert.equal(r.visible, false, s);
    assert.equal(r.reason, 'status_hidden', s);
  }
});

test('evaluateOrder: a till pre order with no fire time stays hidden until the till fires it', () => {
  const waiting = ev({ source: 'pos', type: 'collection', status: 'scheduled', sentAt: null, customer: { name: 'Dana Wells' } });
  assert.equal(waiting.visible, false);
  assert.equal(waiting.reason, 'future');
  // Fired: status prep and a sent time.
  const firedNow = ev({ source: 'pos', type: 'collection', status: 'prep', sentAt: NOW - MIN, customer: { name: 'Dana Wells' } });
  assert.equal(firedNow.visible, true);
  assert.equal(firedNow.row.bucket, 'preparing');
});

test('evaluateOrder: customer typed names show only after a server stamped status change', () => {
  assert.deepEqual(CUSTOMER_TYPED_SOURCES, ['kiosk', 'online', 'qr', 'catering']);
  for (const source of CUSTOMER_TYPED_SOURCES) {
    const type = source === 'qr' ? 'dine-in' : 'collection';
    const fresh = ev({ source, type, ref: 'R1047', status: 'prep', statusChangedAt: NOW - 5 * MIN, firstSeenAt: NOW - 5 * MIN });
    assert.equal(fresh.visible, true, source);
    assert.equal(fresh.row.name, null, `${source} untouched shows the number`);
    assert.equal(fresh.row.number, '47');
    const noMark = ev({ source, type, ref: 'R1047', status: 'prep', statusChangedAt: null, firstSeenAt: null });
    assert.equal(noMark.row.name, null, `${source} with no mark`);
    const moved = ev({ source, type, ref: 'R1047', status: 'ready', statusChangedAt: NOW - MIN, firstSeenAt: NOW - 5 * MIN });
    assert.equal(moved.row.name, 'Joseph W', `${source} moved by staff`);
  }
  // Till, delivery app and ezCater names are not customer typed on a public device.
  for (const source of ['pos', 'hubrise', 'ezcater']) {
    const r = ev({ source, type: 'delivery', status: 'prep', statusChangedAt: NOW - 5 * MIN, firstSeenAt: NOW - 5 * MIN, customer: { name: 'Joseph Wong', channel: 'Deliveroo' } });
    assert.equal(r.row.name, 'Joseph W', source);
  }
});

test('evaluateOrder: delivery apps hide until accepted unless the setting is on', () => {
  const hr = { source: 'hubrise', type: 'delivery', status: 'received', customer: { channel: 'Deliveroo', collectionCode: 'A7F3' } };
  assert.equal(ev(hr).visible, false);
  assert.equal(ev(hr).reason, 'unaccepted');
  const on = ev(hr, allDisplay({ showUnacceptedPlatform: true }));
  assert.equal(on.visible, true);
  assert.equal(on.row.bucket, 'received');
  assert.equal(ev({ ...hr, source: 'ezcater' }).reason, 'unaccepted');
});

test('evaluateOrder: live collected lingers from the status change', () => {
  const one = ev({ status: 'collected', statusChangedAt: NOW - 1 * MIN });
  assert.equal(one.visible, true);
  assert.equal(one.row.bucket, 'collected');
  assert.equal(one.row.expiresAtMs, NOW + 1 * MIN);
  const three = ev({ status: 'collected', statusChangedAt: NOW - 3 * MIN });
  assert.equal(three.visible, false);
  assert.equal(three.reason, 'expired');
  const noMark = ev({ status: 'collected', statusChangedAt: null });
  assert.equal(noMark.visible, false);
});

test('evaluateOrder: deleted rows', () => {
  const ready = ev({ status: 'ready', departedAt: NOW - 30000, departedFrom: 'ready' });
  assert.equal(ready.visible, true);
  assert.equal(ready.row.bucket, 'collected');
  const prep = ev({ status: 'prep', departedAt: NOW - 30000, departedFrom: 'prep' });
  assert.equal(prep.visible, false);
  assert.equal(prep.reason, 'removed');
  const zero = ev({ departedAt: NOW - 30000, departedFrom: 'ready' }, allDisplay({ lingerMinutes: 0 }));
  assert.equal(zero.visible, false);
});

test('evaluateOrder: courier pickup and platform completion', () => {
  const picked = ev({ source: 'online', type: 'delivery', status: 'prep', courier: { backend: 'stuart', status: 'pickup', pickedAt: NOW - MIN, updatedAt: NOW - MIN } });
  assert.equal(picked.row.bucket, 'collected');
  assert.equal(picked.visible, true);
  const dropoff = ev({ source: 'online', type: 'delivery', status: 'ready', courier: { backend: 'stuart', status: 'dropoff', pickedAt: null, updatedAt: NOW - MIN } });
  assert.equal(dropoff.row.bucket, 'collected');
  const canceled = ev({ source: 'online', type: 'delivery', status: 'prep', courier: { backend: 'stuart', status: 'canceled', pickedAt: NOW - MIN, updatedAt: NOW - MIN } });
  assert.equal(canceled.row.bucket, 'preparing');
  assert.equal(canceled.row.courier, null);
  const completed = ev({ source: 'hubrise', type: 'delivery', status: 'prep', customer: { channel: 'Just Eat' }, hubrise: { hrStatus: 'completed', updatedAt: NOW - MIN } });
  assert.equal(completed.row.bucket, 'collected');
  assert.equal(completed.visible, true);
});

test('evaluateOrder: an order already picked up does not come back when staff clear it later', () => {
  const stuart = ev({
    source: 'online', type: 'delivery', status: 'ready', ref: 'OL-9QW3M',
    departedAt: NOW - 10000, departedFrom: 'ready',
    courier: { backend: 'stuart', status: 'delivered', pickedAt: NOW - 20 * MIN, updatedAt: NOW - 5 * MIN },
  });
  assert.equal(stuart.visible, false);
  assert.equal(stuart.reason, 'expired');
  const platform = ev({
    source: 'hubrise', type: 'delivery', status: 'ready', customer: { channel: 'Deliveroo' },
    departedAt: NOW - 10000, departedFrom: 'ready', hubrise: { hrStatus: 'completed', updatedAt: NOW - 20 * MIN },
  });
  assert.equal(platform.visible, false);
  assert.equal(platform.reason, 'expired');
  // Picked up 1 minute ago, cleared now: lingers from the pickup.
  const recent = ev({
    source: 'online', type: 'delivery', status: 'ready', departedAt: NOW - 10000, departedFrom: 'ready',
    courier: { backend: 'stuart', status: 'pickup', pickedAt: NOW - MIN, updatedAt: NOW - MIN },
  });
  assert.equal(recent.visible, true);
  assert.equal(recent.row.expiresAtMs, NOW - MIN + 2 * MIN);
  // A canceled courier row is ignored: the delete time is used.
  const canceled = ev({
    source: 'online', type: 'delivery', status: 'ready', departedAt: NOW - 10000, departedFrom: 'ready',
    courier: { backend: 'stuart', status: 'canceled', pickedAt: NOW - 20 * MIN, updatedAt: NOW - 20 * MIN },
  });
  assert.equal(canceled.visible, true);
  assert.equal(canceled.row.expiresAtMs, NOW - 10000 + 2 * MIN);
});

test('evaluateOrder: future pre orders and ezCater allowance', () => {
  const online = ev({ source: 'online', type: 'collection', status: 'prep', sentAt: NOW + 20 * MIN });
  assert.equal(online.visible, false);
  assert.equal(online.reason, 'future');
  assert.equal(ev({ source: 'ezcater', type: 'delivery', status: 'prep', sentAt: NOW + 45 * MIN }).visible, true);
  assert.equal(ev({ source: 'ezcater', type: 'delivery', status: 'prep', sentAt: NOW + 75 * MIN }).reason, 'future');
});

test('evaluateOrder: stale rows use the fire time when there is one', () => {
  const stale = ev({ status: 'prep', createdAt: NOW - 7 * HOUR, statusChangedAt: NOW - 7 * HOUR });
  assert.equal(stale.visible, false);
  assert.equal(stale.reason, 'stale');
  const preorder = ev({ source: 'online', type: 'collection', status: 'prep', sentAt: NOW - HOUR, createdAt: NOW - 72 * HOUR });
  assert.equal(preorder.visible, true);
});

test('evaluateOrder: sections', () => {
  const none = evaluateOrder(order({ type: 'bar-tab' }), allDisplay(), NOW);
  assert.equal(none.reason, 'no_section');
  const two = {
    name: 'Two',
    sections: [
      { id: 'a', title: 'A', channels: ['kiosk'], orderTypes: ['dine-in'], statuses: [...STEPS] },
      { id: 'b', title: 'B', channels: ['kiosk'], orderTypes: ['dine-in'], statuses: [...STEPS] },
    ],
  };
  const r = evaluateOrder(order(), two, NOW);
  assert.equal(r.row.sectionIndex, 0);
  assert.equal(r.row.sectionId, 'a');
  const off = evaluateOrder(order({ status: 'received' }), { ...two, sections: [{ ...two.sections[0], statuses: ['ready'] }] }, NOW);
  assert.equal(off.reason, 'status_off');
});

test('evaluateOrder: a non object section keeps its index, like SQL', () => {
  const d = { name: 'x', sections: [null, { id: 'b', title: 'B', channels: ['kiosk'], orderTypes: ['dine-in'], statuses: [...STEPS] }] };
  const r = evaluateOrder(order(), d, NOW);
  assert.equal(r.visible, true);
  assert.equal(r.row.sectionIndex, 1);
});

test('evaluateOrder: QR dine in only when a section selects it', () => {
  const qr = order({ source: 'qr', type: 'dine-in', status: 'prep', ref: 'QR-ABCDE' });
  assert.equal(evaluateOrder(qr, newDisplayTemplate(), NOW).reason, 'no_section');
  const t = newDisplayTemplate();
  t.sections[0].channels.push('qr');
  const r = evaluateOrder(qr, t, NOW);
  assert.equal(r.visible, true);
  assert.equal(r.row.number, 'CDE');
});

test('evaluateOrder: row shape', () => {
  const r = ev({ source: 'hubrise', type: 'delivery', status: 'ready', ref: 'HR-zz99', customer: { name: 'Jamie Price', channel: 'Foodhub Direct App Channel Name', collectionCode: 'Q12' } });
  assert.deepEqual(Object.keys(r.row).sort(), ['bucket', 'channel', 'channelName', 'courier', 'expiresAtMs', 'key', 'name', 'number', 'orderType', 'sectionId', 'sectionIndex', 'sinceMs'].sort());
  assert.equal(r.row.key, 'HR-zz99');
  assert.equal(r.row.channel, 'other_app');
  assert.equal(r.row.channelName, 'Foodhub Direct App C');
  assert.equal(r.row.name, 'Jamie P');
  assert.equal(r.row.number, 'Q12');
  assert.equal(r.row.sinceMs, NOW - 4 * MIN);
});

// ── rows ─────────────────────────────────────────────────────────────────────

test('sortRows: section, then ready, preparing, received, collected, oldest first, then number', () => {
  const row = (o) => ({ key: o.number, sectionIndex: 0, sinceMs: NOW, ...o });
  const rows = [
    row({ number: 'c', bucket: 'collected' }),
    row({ number: 'r', bucket: 'received' }),
    row({ number: 'p', bucket: 'preparing' }),
    row({ number: 'y2', bucket: 'ready', sinceMs: NOW }),
    row({ number: 'y1', bucket: 'ready', sinceMs: NOW - MIN }),
    row({ number: 's1', bucket: 'ready', sectionIndex: 1 }),
    row({ number: '5', bucket: 'preparing', sinceMs: NOW - HOUR }),
    row({ number: '47', bucket: 'preparing', sinceMs: NOW - HOUR }),
  ];
  const input = [...rows];
  assert.deepEqual(sortRows(rows).map(r => r.number), ['y1', 'y2', '5', '47', 'p', 'r', 'c', 's1']);
  assert.deepEqual(rows, input, 'does not mutate');
});

test('visibleRows drops expired collected rows and rows with no bucket', () => {
  const rows = [
    { key: 'a', bucket: 'collected', expiresAtMs: NOW - 1 },
    { key: 'b', bucket: 'collected', expiresAtMs: NOW },
    { key: 'c', bucket: 'collected', expiresAtMs: NOW + 1 },
    { key: 'd', bucket: 'ready', expiresAtMs: null },
    { key: 'e', bucket: null },
  ];
  assert.deepEqual(visibleRows(rows, NOW).map(r => r.key), ['c', 'd']);
  assert.deepEqual(visibleRows(null, NOW), []);
});

test('rowFromFeed converts the feed row', () => {
  const r = rowFromFeed({
    key: 'abc123', section_id: 's2', section_index: 1, bucket: 'collected', number: '47', name: 'Joseph W',
    channel: 'kiosk', channel_name: null, courier: null, order_type: 'dine-in',
    since: '2026-09-11T11:59:00Z', expires_at: '2026-09-11T12:01:00Z',
  });
  assert.deepEqual(r, {
    key: 'abc123', sectionId: 's2', sectionIndex: 1, bucket: 'collected', number: '47', name: 'Joseph W',
    channel: 'kiosk', channelName: null, courier: null, orderType: 'dine-in',
    sinceMs: NOW - MIN, expiresAtMs: NOW + MIN,
  });
  assert.equal(rowFromFeed(null).bucket, null);
});

// ── normaliseDisplay ─────────────────────────────────────────────────────────

test('normaliseDisplay clamps and defaults settings', () => {
  const n = (settings) => normaliseDisplay({ settings }).settings;
  assert.equal(n({ lingerMinutes: 99 }).lingerMinutes, 30);
  assert.equal(n({ lingerMinutes: -5 }).lingerMinutes, 0);
  assert.equal(n({ lingerMinutes: '7' }).lingerMinutes, 7);
  // Not a whole number, so the default applies (it is 0: collected leaves the screen at once).
  assert.equal(n({ lingerMinutes: '2.5' }).lingerMinutes, DEFAULT_SETTINGS.lingerMinutes);
  assert.equal(n({ lingerMinutes: 2.5 }).lingerMinutes, DEFAULT_SETTINGS.lingerMinutes);
  assert.equal(n({ maxAgeHours: 0 }).maxAgeHours, 1);
  assert.equal(n({ maxAgeHours: 50 }).maxAgeHours, 24);
  assert.equal(n({ maxAgeHours: 'abc' }).maxAgeHours, 6);
  assert.equal(n({ showUnacceptedPlatform: 'true' }).showUnacceptedPlatform, true);
  assert.equal(n({ chime: 'true' }).chime, false);
  assert.deepEqual(normaliseDisplay(null).settings, DEFAULT_SETTINGS);
});

test('normaliseDisplay sections: not an array, too many, non objects', () => {
  assert.deepEqual(normaliseDisplay({ sections: 'x' }).sections, []);
  const six = Array.from({ length: 6 }, (_, i) => ({ ...newSection(i + 1), title: `S${i}` }));
  assert.equal(normaliseDisplay({ sections: six }).sections.length, 4);
  const d = normaliseDisplay({ sections: [42, { id: 'b', title: 'B', channels: ['kiosk', 'nope', 'kiosk'], orderTypes: ['dine-in'], statuses: ['ready', 'collected'], nameFormat: 'weird', extra: 1 }] });
  assert.equal(d.sections.length, 2);
  assert.deepEqual(d.sections[0].channels, []);
  assert.deepEqual(d.sections[0].statuses, []);
  assert.deepEqual(d.sections[1], { id: 'b', title: 'B', subtitle: '', channels: ['kiosk'], orderTypes: ['dine-in'], statuses: ['ready'], nameFormat: 'short', showChannel: true });
});

test('normaliseDisplay drops unknown keys and bad values', () => {
  const d = normaliseDisplay({
    id: 'id1', name: 'Front', foo: 1, orientation: 'sideways', rotate: 45, is_active: false,
    labels: { ready: 'Come get it', bogus: 'x', preparing: '   ' },
    settings: { headerText: 'Hi', bar: 2 },
    theme: { headerBg: 'red', bg: '#112233', logoUrl: 'http://x.test/logo.png', uppercase: false, glow: true },
  });
  assert.equal(d.foo, undefined);
  assert.equal(d.id, 'id1');
  assert.equal(d.orientation, 'portrait');
  assert.equal(d.rotate, 0);
  assert.equal(d.is_active, false);
  assert.deepEqual(d.labels, { ...DEFAULT_LABELS, ready: 'Come get it' });
  assert.equal(d.settings.bar, undefined);
  assert.equal(d.theme.headerBg, DEFAULT_THEME.headerBg);
  assert.equal(d.theme.bg, '#112233');
  assert.equal(d.theme.logoUrl, '');
  assert.equal(d.theme.uppercase, false);
  assert.equal(d.theme.glow, undefined);
  assert.equal(normaliseDisplay({ theme: { logoUrl: 'https://x.test/l.png' } }).theme.logoUrl, 'https://x.test/l.png');
  assert.equal(normaliseDisplay({ rotate: '270', orientation: 'landscape' }).rotate, 270);
  assert.deepEqual(normaliseDisplay(normaliseDisplay(newDisplayTemplate())), normaliseDisplay(newDisplayTemplate()));
});

// ── validateDisplay ──────────────────────────────────────────────────────────

test('validateDisplay: the template passes', () => {
  assert.deepEqual(validateDisplay(newDisplayTemplate()), []);
});

test('validateDisplay: every message fires', () => {
  const t = () => newDisplayTemplate();
  assert.ok(validateDisplay({ ...t(), name: '  ' }).includes('Give this order screen a name.'));
  assert.ok(validateDisplay({ ...t(), sections: [] }).includes('Add at least one section.'));
  const s = t(); s.sections[1] = { ...s.sections[1], title: '', channels: [], orderTypes: [], statuses: [] };
  const msgs = validateDisplay(s);
  for (const m of ['Section 2 needs a title.', 'Section 2 needs at least one place orders come from.', 'Section 2 needs at least one order type.', 'Section 2 needs at least one step to show.']) {
    assert.ok(msgs.includes(m), m);
  }
  assert.ok(validateDisplay({ ...t(), settings: { ...DEFAULT_SETTINGS, lingerMinutes: 31 } }).includes('Keep collected orders for 0 to 30 minutes.'));
  assert.ok(validateDisplay({ ...t(), settings: { ...DEFAULT_SETTINGS, lingerMinutes: '' } }).includes('Keep collected orders for 0 to 30 minutes.'));
  assert.ok(validateDisplay({ ...t(), settings: { ...DEFAULT_SETTINGS, maxAgeHours: 0 } }).includes('Hide orders after 1 to 24 hours.'));
  assert.ok(validateDisplay({ ...t(), theme: { ...DEFAULT_THEME, bg: 'red' } }).includes('Colours must be a colour code like #15C26A.'));
  assert.ok(validateDisplay({ ...t(), settings: { ...DEFAULT_SETTINGS, headerText: 'x'.repeat(41) } }).includes('The header text can be up to 40 characters.'));
});

test('validateDisplay: text that is hard to read on its background blocks the save', () => {
  const MSG = 'Some text is hard to read on its background. Choose a darker or lighter colour.';
  const withTheme = (patch) => validateDisplay({ ...newDisplayTemplate(), theme: { ...DEFAULT_THEME, ...patch } });
  assert.ok(!withTheme({}).includes(MSG), 'default theme is readable');
  assert.ok(withTheme({ bg: '#FFFFFF' }).includes(MSG), 'white page with the default white text');
  assert.ok(withTheme({ text: '#222222' }).includes(MSG), 'dark text on the default dark page');
  assert.ok(withTheme({ headerBg: '#15C26A', headerText: '#FFFFFF' }).includes(MSG), 'white on green header is 2.3');
  assert.ok(withTheme({ readyBg: '#0F1211', readyText: '#0F1211' }).includes(MSG), 'ready pill text same as its background');
  assert.ok(!withTheme({ bg: '#FFFFFF', text: '#111111' }).includes(MSG), 'white page with black text is fine');
  assert.ok(!validateDisplay({ ...newDisplayTemplate(), theme: { bg: '#F5EFE6', text: '#3B2F2F' } }).includes(MSG), 'missing keys use the defaults');
  assert.equal(withTheme({ bg: 'red' }).filter(m => m === MSG).length, 0, 'a bad colour code gets its own message only');
});

test('contrastRatio matches WCAG', () => {
  assert.equal(Math.round(contrastRatio('#FFFFFF', '#000000') * 100) / 100, 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.equal(contrastRatio('#FFFFFF', '#0F1211'), contrastRatio('#0F1211', '#FFFFFF'), 'order does not matter');
  assert.equal(contrastRatio('red', '#000000'), 1, 'not a colour code');
  assert.ok(contrastRatio('#0F1211', '#15C26A') >= MIN_LARGE_CONTRAST);
});

test('validateDisplay: a landscape screen fits up to 3 sections', () => {
  const MSG = 'A landscape screen fits up to 3 sections. Remove one or choose Portrait.';
  const four = newDisplayTemplate();
  four.sections.push({ ...four.sections[0], id: 's4', title: 'Bar' });
  assert.ok(!validateDisplay(four).includes(MSG), 'portrait allows 4');
  assert.ok(validateDisplay({ ...four, orientation: 'landscape' }).includes(MSG));
  assert.ok(!validateDisplay({ ...newDisplayTemplate(), orientation: 'landscape' }).includes(MSG), 'landscape allows 3');
});

// ── pairing ──────────────────────────────────────────────────────────────────

test('normalisePairCode', () => {
  assert.equal(normalisePairCode('k7p2 9xqm'), 'K7P2-9XQM');
  assert.equal(normalisePairCode('K7P29XQM'), 'K7P2-9XQM');
  assert.equal(normalisePairCode('K7P2-9XQM'), 'K7P2-9XQM');
  assert.equal(normalisePairCode('abc'), 'ABC');
  assert.equal(normalisePairCode(null), '');
});

test('friendlyPairError: every row of the table', () => {
  assert.equal(friendlyPairError({ code: 'PGRST202', message: 'Could not find the function public.claim_order_status_screen' }), 'Order screens need a database update first. Ask ServOS support.');
  assert.equal(friendlyPairError({ absent: true }), 'Order screens need a database update first. Ask ServOS support.');
  assert.equal(friendlyPairError('Order screen not found'), 'That order screen no longer exists. Refresh and try again.');
  assert.equal(friendlyPairError(new Error('Pairing code not found')), 'We could not find that code. Check the TV and try again.');
  assert.equal(friendlyPairError('pairing code not found'), 'We could not find that code. Check the TV and try again.');
  assert.equal(friendlyPairError({ message: 'Pairing code expired. Restart the screen to get a new code.' }), 'That code has expired. Restart the TV app to get a new code.');
  assert.equal(friendlyPairError('Screen belongs to another venue'), 'That TV is paired to another venue.');
  assert.equal(friendlyPairError('screen belongs to another location'), 'That TV is paired to another venue.');
  assert.equal(friendlyPairError('That order screen is at a different venue'), 'That order screen belongs to a different venue.');
  assert.equal(friendlyPairError('board is at a different location'), 'That order screen belongs to a different venue.');
  assert.equal(friendlyPairError('Sign in to Back Office to pair a screen'), 'Sign in to Back Office again, then try again.');
  assert.equal(friendlyPairError('No access to this venue'), 'You do not have access to this venue.');
  assert.equal(friendlyPairError('Failed to fetch'), 'Could not pair the TV. Try again.');
  assert.equal(friendlyPairError(null), 'Could not pair the TV. Try again.');
});

test('friendlyPairError: checks run in order', () => {
  // absent before everything
  assert.equal(friendlyPairError({ code: '42883', message: 'Order screen not found' }), 'Order screens need a database update first. Ask ServOS support.');
  // order screen not found before code not found
  assert.equal(friendlyPairError('Order screen not found, code not found'), 'That order screen no longer exists. Refresh and try again.');
  // code not found before expired
  assert.equal(friendlyPairError('code not found or expired'), 'We could not find that code. Check the TV and try again.');
  // expired before another venue
  assert.equal(friendlyPairError('expired, another venue'), 'That code has expired. Restart the TV app to get a new code.');
  // another venue before different venue
  assert.equal(friendlyPairError('another venue, different venue'), 'That TV is paired to another venue.');
  // different venue before sign in
  assert.equal(friendlyPairError('different venue, sign in'), 'That order screen belongs to a different venue.');
  // sign in before no access
  assert.equal(friendlyPairError('Sign in, no access'), 'Sign in to Back Office again, then try again.');
});

test('isAbsentError', () => {
  for (const code of ['PGRST205', '42P01', 'PGRST202', '42883', '42703', 'PGRST204']) assert.equal(isAbsentError({ code }), true, code);
  assert.equal(isAbsentError({ message: 'relation "order_status_displays" does not exist' }), true);
  assert.equal(isAbsentError({ message: 'column menu_board_screens.order_display_id not in schema cache' }), true);
  assert.equal(isAbsentError({ code: 'P0001', message: 'Order screen not found' }), false);
  assert.equal(isAbsentError(null), false);
});

test('lastSeenLabel', () => {
  assert.deepEqual(lastSeenLabel(null, NOW), { online: false, text: 'Never seen' });
  assert.deepEqual(lastSeenLabel(NOW - 2 * MIN, NOW), { online: true, text: 'Online' });
  assert.equal(lastSeenLabel(NOW - 12 * MIN, NOW).text, 'Last seen 12 minutes ago');
  assert.equal(lastSeenLabel(NOW - 3 * HOUR, NOW).text, 'Last seen 3 hours ago');
  assert.equal(lastSeenLabel(NOW - 49 * HOUR, NOW).text, 'Last seen 2 days ago');
});

// ── copy and preview ─────────────────────────────────────────────────────────

test('copy rule: no dashes, under 120 characters', () => {
  const invalid = {
    name: '', sections: [{}, { title: '' }],
    settings: { lingerMinutes: 99, maxAgeHours: 99, headerText: 'x'.repeat(50) }, theme: { bg: 'nope' },
  };
  const strings = [
    ...Object.values(DEFAULT_LABELS),
    ...CHANNELS.map(c => c.label), ...ORDER_TYPES.map(t => t.label),
    DEFAULT_SETTINGS.headerText,
    ...validateDisplay(invalid), ...validateDisplay({ sections: [] }),
    ...validateDisplay({ ...newDisplayTemplate(), orientation: 'landscape', sections: [{}, {}, {}, {}] }),
    ...['absent', 'order screen not found', 'code not found', 'expired', 'another venue', 'different venue', 'sign in', 'no access', 'x']
      .map(m => friendlyPairError(m === 'absent' ? { absent: true } : m)),
    channelLabel({ channel: 'other_app' }), lastSeenLabel(null, NOW).text, lastSeenLabel(NOW - 5 * MIN, NOW).text,
    ...newDisplayTemplate().sections.flatMap(s => [s.title, s.subtitle]),
  ];
  assert.ok(strings.length > 30);
  for (const s of strings) {
    assert.equal(typeof s, 'string');
    assert.ok(!s.includes('\u2014') && !s.includes('\u2013'), s);
    assert.ok(s.length < 120, s);
  }
});

test('BUCKETS and STEPS', () => {
  assert.deepEqual(STEPS, ['received', 'preparing', 'ready']);
  assert.deepEqual(BUCKETS, ['received', 'preparing', 'ready', 'collected']);
});

test('preview never blank: every template section shows sample orders', () => {
  const tpl = newDisplayTemplate();
  const samples = sampleOrders(NOW);
  assert.equal(samples.length, 14);
  const rows = samples.map(o => evaluateOrder(o, tpl, NOW)).filter(r => r.visible).map(r => r.row);
  for (let i = 0; i < tpl.sections.length; i++) {
    assert.ok(rows.some(r => r.sectionIndex === i), `section ${i + 1} has a row`);
  }
  // The placeholder name falls back to the number, and a delivery app shows its code.
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.equal(byKey.R1049.name, null);
  assert.equal(byKey.R1049.number, '49');
  assert.equal(byKey['HR-a1b2c3'].number, 'A7F3');
  assert.equal(byKey['HR-a1b2c3'].name, null, 'delivery section shows number only');
  assert.equal(byKey.R1044, undefined, 'a collected sample leaves at once with the default linger');
  // A venue that chooses a grace period still sees it.
  const keptRows = samples.map(o => evaluateOrder(o, { ...tpl, settings: { ...tpl.settings, lingerMinutes: 2 } }, NOW)).filter(r => r.visible).map(r => r.row);
  assert.equal(keptRows.find(r => r.key === 'R1044').bucket, 'collected');
  assert.equal(byKey['OL-9QW3M'].courier, 'stuart');
  assert.equal(byKey['OL-9QW3M'].number, 'W3M');
  // A kiosk sample still at its first status shows its number, not the typed name.
  assert.equal(byKey.R1055.name, null);
  assert.equal(byKey.R1052.name, 'Priya K');
  assert.equal(tpl.sections[2].title, 'Delivery and app orders');
  for (const o of samples) {
    const created = o.createdAt;
    assert.ok(created <= NOW - 3 * MIN && created >= NOW - 20 * MIN, o.ref);
  }
});

test('default settings take a collected order off the screen at once', () => {
  assert.equal(DEFAULT_SETTINGS.lingerMinutes, 0);
  const withDefaults = { ...allDisplay(), settings: { ...DEFAULT_SETTINGS } };
  // Staff tapped Collected a second ago: with the default it is already gone.
  const justCollected = evaluateOrder(order({ status: 'collected', statusChangedAt: NOW - 1000 }), withDefaults, NOW);
  assert.equal(justCollected.visible, false);
  assert.equal(justCollected.reason, 'expired');
  // A till order deleted from ready is the same: no grace period by default.
  const deleted = evaluateOrder(order({ departedAt: NOW - 1000, departedFrom: 'ready' }), withDefaults, NOW);
  assert.equal(deleted.visible, false);
  // A venue that wants a grace period still gets one.
  const lingering = evaluateOrder(order({ status: 'collected', statusChangedAt: NOW - 1000 }), allDisplay({ lingerMinutes: 2 }), NOW);
  assert.equal(lingering.visible, true);
  assert.equal(lingering.row.bucket, 'collected');
});
