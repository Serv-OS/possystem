// src/lib/channelRouteGate.test.js
//
// The pure rules around the channel auto route (lib/channelRouteGate.js).
//
// LIVE, 12 Oct 2026, Coffee Boy Preston. A QR Latte went to the Food screen: the app that routed
// it held no category tree, the line found no kitchen screen, and it fell to the first centre in
// silence. Three rules stop that: a router must hold THIS venue's menu, the master till waits a
// short, bounded time for it (never per order, and a paid order always reaches the kitchen), and
// every channel ticket records who routed it and with what.
// Peter, on a draft that read the tree from the database for each order: "if it reads from the
// data base each time we are moving away from offline mode not towards". Nothing here reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MENU_WAIT_MS, CATCH_UP_MIN_GAP_MS, CATCH_UP_RETRY_MS, catchUpRetryDelay, venueHoldsMenu, routeGateDecision,
  queueRowToRouteOrder, autoRoutable, ROUTE_TRIGGERS, countParentLinks, buildRouteStamp, noticeLines, fallbackNotice, tidyName,
} from './channelRouteGate.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const noLongDash = (s) => !/[\u2013\u2014]/.test(s);

// ── the wait ─────────────────────────────────────────────────────────────────

test('the menu wait is 20 seconds, far under the catering cron grace; the catch up gap is 30 seconds', () => {
  assert.equal(MENU_WAIT_MS, 20_000);
  assert.equal(CATCH_UP_MIN_GAP_MS, 30_000);
  // The server cron takes a due catering order no device has routed, as ONE unsplit ticket,
  // once it is GRACE_MIN minutes late. A wait near that would hand catering to the cron.
  const cron = read('../../supabase/functions/catering-release/index.ts');
  const m = /const GRACE_MIN\s*=\s*(\d+)/.exec(cron);
  assert.ok(m, 'GRACE_MIN is still declared in the catering release function');
  assert.equal(Number(m[1]), 3);
  assert.ok(MENU_WAIT_MS < (Number(m[1]) * 60_000) / 3, 'under a third of the cron grace');
});

test('a failed catch up read is tried again by the till: 10 s, 20 s, 40 s, then every 60 s', () => {
  // Review, 12 Oct 2026: the master till is the only router and the catch up read is its only
  // second look. A read that failed armed nothing, so the next look waited for a wake or a rejoin.
  assert.equal(CATCH_UP_RETRY_MS, 10_000);
  assert.deepEqual([1, 2, 3, 4, 5, 50].map((n) => catchUpRetryDelay(n)), [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  // Never zero, never a tight loop, whatever it is handed.
  for (const junk of [0, -3, NaN, undefined, null, 'x']) assert.equal(catchUpRetryDelay(junk), 10_000, String(junk));
  assert.equal(catchUpRetryDelay(1, 0), 10_000);
  assert.equal(catchUpRetryDelay(1, NaN), 10_000);
  // The tests of the runner hand it a short base; the shape is the same.
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => catchUpRetryDelay(n, 20)), [20, 40, 80, 120, 120]);
  // Slower than the rate limit gap at its slowest, so a till that is offline asks once a minute.
  assert.ok(catchUpRetryDelay(99) >= CATCH_UP_MIN_GAP_MS);
});

// ── does this page hold this venue's menu ────────────────────────────────────

test('venueHoldsMenu: a category of this venue is the menu; an empty store is not', () => {
  const cats = [{ id: 'c1', location_id: 'loc-A' }];
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: cats }), { ready: true, why: 'categories' });
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [{ id: 'c1', locationId: 'loc-A' }] }), { ready: true, why: 'categories' });
  // The customer display, the pairing screen, a Back Office tab on another venue: no tree.
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [] }), { ready: false, why: 'not-loaded' });
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: undefined }), { ready: false, why: 'not-loaded' });
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [null, undefined] }), { ready: false, why: 'not-loaded' });
  // Boot started for this venue is not proof on its own: the list is still empty.
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [], bootLocationId: 'loc-A' }), { ready: false, why: 'not-loaded' });
});

test('venueHoldsMenu: a brand new venue with no categories is ready only once its category read SUCCEEDED', () => {
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [], catsReadLocationId: 'loc-A' }), { ready: true, why: 'none-on-file' });
  // The successful read was for another venue.
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [], catsReadLocationId: 'loc-B', bootLocationId: 'loc-A' }), { ready: false, why: 'not-loaded' });
});

test('venueHoldsMenu: a venue WITH categories is ready only when they are in the store, never on the read alone', () => {
  // Review, 12 Oct 2026. The boot's category read found 41 rows; they reach the store several
  // awaited reads later. SyncBridge sets the "read" mark ONLY for a read with no rows, so in
  // that window the store is empty, the mark is unset and the answer is "not loaded": wait.
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [], bootLocationId: 'loc-A', catsReadLocationId: null }), { ready: false, why: 'not-loaded' });
  // The rows land (the boot patch): ready, for the right reason.
  const landed = Array.from({ length: 41 }, (_, i) => ({ id: 'c' + i, location_id: 'loc-A' }));
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: landed, bootLocationId: 'loc-A', catsReadLocationId: null }), { ready: true, why: 'categories' });
});

test('venueHoldsMenu: another venue\'s categories are never this venue\'s menu, even after a successful read', () => {
  const other = [{ id: 'x', location_id: 'loc-B' }];
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: other, bootLocationId: 'loc-A', catsReadLocationId: 'loc-A' }), { ready: false, why: 'other-venue' });
  // One row of this venue among others is enough.
  assert.equal(venueHoldsMenu({ venueId: 'loc-A', categories: [...other, { id: 'c1', location_id: 'loc-A' }] }).ready, true);
});

test('venueHoldsMenu: rows that name no venue (a very old push) count only in a page that booted for this venue', () => {
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [{ id: 'x' }], bootLocationId: 'loc-A' }), { ready: true, why: 'untagged' });
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [{ id: 'x' }], bootLocationId: null }), { ready: false, why: 'other-venue' });
  assert.deepEqual(venueHoldsMenu({ venueId: 'loc-A', categories: [{ id: 'x' }], bootLocationId: 'loc-B' }), { ready: false, why: 'other-venue' });
  // A mixed list where one row names another venue is not "untagged".
  assert.equal(venueHoldsMenu({ venueId: 'loc-A', categories: [{ id: 'x' }, { id: 'y', location_id: 'loc-B' }], bootLocationId: 'loc-A' }).ready, false);
});

test('venueHoldsMenu: no venue id is never ready', () => {
  for (const venueId of [undefined, null, '']) {
    assert.deepEqual(venueHoldsMenu({ venueId, categories: [{ id: 'c', location_id: 'loc-A' }], bootLocationId: 'loc-A', catsReadLocationId: 'loc-A' }), { ready: false, why: 'no-venue' });
  }
  assert.deepEqual(venueHoldsMenu(), { ready: false, why: 'no-venue' });
});

// ── may the auto route go ────────────────────────────────────────────────────

test('routeGateDecision: skip, route, wait, route-blind', () => {
  const g = (o) => routeGateDecision({ master: true, booted: true, menuReady: false, now: 1000, deadlineAt: 2000, ...o });
  // Not the master: never, menu or no menu.
  assert.equal(g({ master: false, menuReady: true }), 'skip');
  assert.equal(g({ master: false, now: 99_999 }), 'skip');
  // The menu is held: at once.
  assert.equal(g({ menuReady: true }), 'route');
  assert.equal(g({ menuReady: true, booted: false }), 'route');
  // No menu yet, before the deadline: wait, claim nothing.
  assert.equal(g({}), 'wait');
  assert.equal(g({ now: 1999 }), 'wait');
  // At and after the deadline: a paid order always reaches the kitchen.
  assert.equal(g({ now: 2000 }), 'route-blind');
  assert.equal(g({ now: 99_999 }), 'route-blind');
  // A page whose sync never started for this venue can never hold the menu: it never routes blind.
  assert.equal(g({ booted: false, now: 99_999 }), 'wait');
  // No deadline (no till session) or a junk clock: wait.
  assert.equal(g({ deadlineAt: null, now: 99_999 }), 'wait');
  assert.equal(g({ deadlineAt: undefined, now: 99_999 }), 'wait');
  assert.equal(g({ now: NaN }), 'wait');
  assert.equal(routeGateDecision(), 'skip');
});

// ── the order shape ──────────────────────────────────────────────────────────

test('queueRowToRouteOrder: an order_queue row gives exactly the order realtime always built', () => {
  const row = {
    ref: 'QR-QRJZK', source: 'qr', type: 'dine-in', status: 'received',
    items: [{ itemId: 'm-latte-big', name: 'Latte Big Boy', qty: 1 }],
    customer: { name: 'Katie', tableLabel: 'Table 9' },
    sent_at: '2026-10-11T12:35:56.000Z', collection_time: '13:00', is_asap: true,
    kitchen_routed_at: null, total: 4.2,
  };
  assert.deepEqual(queueRowToRouteOrder(row, 5), {
    ref: 'QR-QRJZK', source: 'qr', type: 'dine-in', tableLabel: 'Table 9',
    items: row.items, customer: row.customer, collectionTime: '13:00', isASAP: true,
    sentAt: Date.parse('2026-10-11T12:35:56.000Z'),
  });
  // The old defaults.
  assert.deepEqual(queueRowToRouteOrder({ source: 'kiosk' }, 777), {
    ref: '', source: 'kiosk', type: null, tableLabel: null, items: [], customer: null, collectionTime: null, isASAP: false, sentAt: 777,
  });
  assert.deepEqual(Object.keys(queueRowToRouteOrder(null, 1)), ['ref', 'source', 'type', 'tableLabel', 'items', 'customer', 'collectionTime', 'isASAP', 'sentAt']);
  assert.equal(queueRowToRouteOrder(null, 1).sentAt, 1);
  assert.ok(Math.abs(queueRowToRouteOrder({ ref: 'x' }).sentAt - Date.now()) < 2000, 'no sent_at: now');
});

test('autoRoutable: a delivery app order waiting for Accept is left for staff, everything else may go', () => {
  assert.equal(autoRoutable({ source: 'hubrise', status: 'received' }), false);
  assert.equal(autoRoutable({ source: 'hubrise', status: null }), false);
  assert.equal(autoRoutable({ source: 'hubrise', status: 'prep' }), true);
  for (const source of ['qr', 'kiosk', 'online']) assert.equal(autoRoutable({ source, status: 'received' }), true, source);
  assert.equal(autoRoutable(null), true);
});

// ── the stamp on the ticket ──────────────────────────────────────────────────

test('buildRouteStamp, the shape: twelve plain keys, small', () => {
  const s = buildRouteStamp({
    deviceId: 'fddabb63-0a68-4be9-a7ca-83cbf38d6960', deviceName: 'POS', mode: 'pos', version: '5.11.51', trigger: 'live',
    categoryCount: 41, parentLinks: 28, menuHeld: true, fallbackNames: [], at: Date.parse('2026-10-12T09:00:00Z'),
  });
  assert.deepEqual(s, {
    v: 1, deviceId: 'fddabb63-0a68-4be9-a7ca-83cbf38d6960', deviceName: 'POS', mode: 'pos', version: '5.11.51', trigger: 'live',
    cats: 41, links: 28, menu: true, fallback: [], fallbackCount: 0, at: '2026-10-12T09:00:00.000Z',
  });
  assert.deepEqual(Object.keys(s), ['v', 'deviceId', 'deviceName', 'mode', 'version', 'trigger', 'cats', 'links', 'menu', 'fallback', 'fallbackCount', 'at']);
  assert.ok(JSON.stringify(s).length < 250, String(JSON.stringify(s).length));
  // The Preston ticket as it would have read: no tree, the Latte fell back.
  const blind = buildRouteStamp({ deviceId: 'd', deviceName: 'Test', mode: 'pos', version: '5.11.35', trigger: 'live', categoryCount: 0, parentLinks: 0, menuHeld: false, fallbackNames: ['Latte Big Boy'], at: 0 });
  assert.equal(blind.cats, 0);
  assert.equal(blind.links, 0);
  assert.equal(blind.menu, false);
  assert.deepEqual(blind.fallback, ['Latte Big Boy']);
  assert.equal(blind.fallbackCount, 1);
  assert.equal(blind.at, '1970-01-01T00:00:00.000Z');
});

test('buildRouteStamp, small and safe: capped names, known triggers only, never throws on junk', () => {
  const big = buildRouteStamp({
    deviceId: 'x'.repeat(200), deviceName: 'y'.repeat(200), mode: 'm'.repeat(99), version: 'v'.repeat(99), trigger: 'zzz',
    fallbackNames: Array.from({ length: 150 }, (_, i) => 'Item name that is very very very long indeed number ' + i), at: Date.now(),
  });
  assert.equal(big.fallback.length, 5);
  assert.equal(big.fallbackCount, 150);
  assert.ok(big.fallback.every((n) => n.length <= 40));
  assert.equal(big.deviceId.length, 64);
  assert.equal(big.deviceName.length, 40);
  assert.equal(big.mode.length, 24);
  assert.equal(big.version.length, 16);
  assert.equal(big.trigger, 'unknown');
  assert.ok(JSON.stringify(big).length < 700, String(JSON.stringify(big).length));
  assert.deepEqual([...ROUTE_TRIGGERS], ['live', 'backfill', 'manual', 'catering']);
  assert.ok(Object.isFrozen(ROUTE_TRIGGERS));
  for (const trigger of ROUTE_TRIGGERS) assert.equal(buildRouteStamp({ trigger }).trigger, trigger);
  assert.equal(buildRouteStamp({}).trigger, 'unknown');
  // Nothing, a null device, an empty mode, undefined names, a junk time: a plain object, no throw.
  assert.deepEqual(buildRouteStamp(), { v: 1, deviceId: null, deviceName: null, mode: null, version: null, trigger: 'unknown', cats: 0, links: 0, menu: false, fallback: [], fallbackCount: 0, at: null });
  const junk = buildRouteStamp({ deviceId: null, deviceName: undefined, mode: '', fallbackNames: [undefined, null, 5, ''], categoryCount: 'x', parentLinks: NaN, menuHeld: 'yes', at: NaN });
  assert.deepEqual(junk, { v: 1, deviceId: null, deviceName: null, mode: null, version: null, trigger: 'unknown', cats: 0, links: 0, menu: false, fallback: ['5'], fallbackCount: 1, at: null });
  assert.doesNotThrow(() => buildRouteStamp({ fallbackNames: 'not a list' }));
  assert.doesNotThrow(() => JSON.stringify(buildRouteStamp({ fallbackNames: [{}, [], () => 1] })));
});

test('countParentLinks: the parents a tree names; nothing for an empty tree or junk', () => {
  assert.equal(countParentLinks({ coffee: 'hot', hot: null, teas: 'tea', tea: null }), 2);
  assert.equal(countParentLinks({ a: null, b: null }), 0);
  assert.equal(countParentLinks({}), 0);
  for (const junk of [null, undefined, 'x', 7]) assert.equal(countParentLinks(junk), 0);
});

// ── no silent fallback ───────────────────────────────────────────────────────

test('noticeLines: every fallback line is named, except the ones the delivery app toast already names', () => {
  const known = { itemId: 'b', name: 'Cookie' };
  const unknown = { id: 'a', name: 'Mystery' };
  // HubRise: a line not in our menu is left to the existing "not in our menu" toast, never doubled.
  assert.deepEqual(noticeLines({ unrouted: [unknown, known], source: 'hubrise', menuItems: [{ id: 'b' }] }), [known]);
  assert.deepEqual(noticeLines({ unrouted: [unknown], source: 'hubrise', menuItems: [{ id: 'b' }] }), []);
  // QR, kiosk, online: every line, known or not.
  for (const source of ['qr', 'kiosk', 'online', 'catering', undefined]) {
    assert.deepEqual(noticeLines({ unrouted: [unknown, known], source, menuItems: [] }), [unknown, known], String(source));
  }
  // Junk.
  assert.deepEqual(noticeLines(), []);
  assert.deepEqual(noticeLines({ unrouted: null, source: 'qr' }), []);
  assert.deepEqual(noticeLines({ unrouted: [null, undefined], source: 'hubrise', menuItems: null }), []);
});

test('fallbackNotice: nothing to say when the menu was held and every line had a screen', () => {
  assert.equal(fallbackNotice({ ref: 'QR-1', names: [], menuHeld: true }), null);
  assert.equal(fallbackNotice({ ref: 'QR-1', names: [], centreName: 'Food' }), null);
  assert.equal(fallbackNotice({ ref: 'QR-1', names: [null, '', undefined], menuHeld: true }), null);
  assert.equal(fallbackNotice(), null);
});

test('fallbackNotice: the three notices, word for word', () => {
  // 1. A line with no kitchen screen, the till had its menu.
  assert.deepEqual(fallbackNotice({ ref: 'QR-QRJZK', names: ['Latte Big Boy'], centreName: 'Food', menuHeld: true }), {
    toast: 'QR-QRJZK: Latte Big Boy went to Food. No kitchen screen is set for it.',
    title: 'No kitchen screen for an item',
    body: 'QR-QRJZK: Latte Big Boy went to Food. Set a kitchen screen for it in Back Office, Production printing. If this till shows Sync now, tap it.',
  });
  // 2. The till had no menu yet and lines fell back.
  assert.deepEqual(fallbackNotice({ ref: 'QR-QRJZK', names: ['Latte Big Boy', 'Tea XL Boy'], centreName: 'Food', menuHeld: false }), {
    toast: 'QR-QRJZK: Latte Big Boy, Tea XL Boy went to Food. This till had no menu yet. Check the kitchen screens.',
    title: 'Order sent without the menu',
    body: 'QR-QRJZK: this till had no menu yet. Latte Big Boy, Tea XL Boy went to Food.',
  });
  // 3. The till had no menu yet, every line still found a screen.
  assert.deepEqual(fallbackNotice({ ref: 'QR-QRJZK', names: [], menuHeld: false }), {
    toast: 'QR-QRJZK went to the kitchen before this till had its menu. Check the kitchen screens.',
    title: 'Order sent without the menu',
    body: 'QR-QRJZK: this till had no menu yet. Check it reached the right screen.',
  });
});

test('fallbackNotice: three names then "and N more"; it and them; a missing screen name; no long dashes', () => {
  const five = fallbackNotice({ ref: 'OL-1', names: ['A', 'B', 'C', 'D', 'E'], centreName: 'Food', menuHeld: true });
  assert.equal(five.toast, 'OL-1: A, B, C and 2 more went to Food. No kitchen screen is set for them.');
  assert.match(five.body, /Set a kitchen screen for them in Back Office/);
  const three = fallbackNotice({ ref: 'OL-1', names: ['A', 'B', 'C'], centreName: 'Food', menuHeld: true });
  assert.equal(three.toast, 'OL-1: A, B, C went to Food. No kitchen screen is set for them.');
  const one = fallbackNotice({ ref: 'OL-1', names: ['A'], centreName: 'Food', menuHeld: true });
  assert.match(one.toast, /No kitchen screen is set for it\.$/);
  const two = fallbackNotice({ ref: 'OL-1', names: ['A', 'B'], centreName: 'Food' });
  assert.match(two.toast, /No kitchen screen is set for them\.$/);
  // No centre name (no centres at all is handled by the caller; a centre with no name reads like this).
  assert.equal(fallbackNotice({ ref: 'OL-1', names: ['A'], menuHeld: true }).toast, 'OL-1: A went to the first screen. No kitchen screen is set for it.');
  assert.equal(fallbackNotice({ names: ['A'], centreName: 'Food', menuHeld: true }).toast, 'An order: A went to Food. No kitchen screen is set for it.');
  // A very long name is cut, never the whole toast.
  const long = fallbackNotice({ ref: 'OL-1', names: ['x'.repeat(90)], centreName: 'Food', menuHeld: true });
  assert.ok(long.toast.includes('x'.repeat(40) + ' went to Food'));
  assert.ok(!long.toast.includes('x'.repeat(41)));
  const all = [five, three, one, two,
    fallbackNotice({ ref: 'R', names: ['A'], centreName: 'Food', menuHeld: false }),
    fallbackNotice({ ref: 'R', names: [], menuHeld: false })];
  for (const n of all) for (const w of [n.toast, n.title, n.body]) {
    assert.ok(noLongDash(w), w);
    assert.ok(!/N\/A/i.test(w), w);
  }
});

// ── names as staff read them (review, 12 Oct 2026) ───────────────────────────

// The live Preston names, read from closed_checks. Written with escapes so this file holds no
// long dash: a sized line is stored as product, long dash, size, and the size ends in a space.
const LATTE = 'Latte \u2014 Big Boy ';
const TEA = 'Tea \u2014 XL Boy';
const CHOC = 'Choc Boy \u2013 XL Boy';

test('tidyName: the long dash becomes a space, runs of spaces become one, the ends are trimmed', () => {
  assert.equal(tidyName(LATTE), 'Latte Big Boy');
  assert.equal(tidyName(TEA), 'Tea XL Boy');
  assert.equal(tidyName(CHOC), 'Choc Boy XL Boy');
  assert.equal(tidyName('  Flat   White  '), 'Flat White');
  assert.equal(tidyName('Latte\u2014Oat'), 'Latte Oat');
  // A plain hyphen is part of a name and stays.
  assert.equal(tidyName('Half-and-half'), 'Half-and-half');
  assert.equal(tidyName('Wrap - Large'), 'Wrap - Large');
  for (const junk of [null, undefined, '']) assert.equal(tidyName(junk), '');
  assert.equal(tidyName(5), '5');
  assert.equal(tidyName(' \u2014 '), '');
});

test('fallbackNotice with the live names: no long dash and no double space in any word staff read', () => {
  const one = fallbackNotice({ ref: 'QR-QRJZK', names: [LATTE], centreName: 'Food', menuHeld: true });
  assert.equal(one.toast, 'QR-QRJZK: Latte Big Boy went to Food. No kitchen screen is set for it.');
  assert.equal(one.body, 'QR-QRJZK: Latte Big Boy went to Food. Set a kitchen screen for it in Back Office, Production printing. If this till shows Sync now, tap it.');
  const blind = fallbackNotice({ ref: 'QR-UNGQA', names: [LATTE, TEA, CHOC], centreName: 'Food', menuHeld: false });
  assert.equal(blind.toast, 'QR-UNGQA: Latte Big Boy, Tea XL Boy, Choc Boy XL Boy went to Food. This till had no menu yet. Check the kitchen screens.');
  for (const n of [one, blind]) for (const w of [n.toast, n.title, n.body]) {
    assert.ok(noLongDash(w), w);
    assert.ok(!/ {2}/.test(w), 'double space: ' + w);
  }
  // A name that is only a dash and spaces is no name: nothing to say when the menu was held.
  assert.equal(fallbackNotice({ ref: 'QR-1', names: [' \u2014 '], centreName: 'Food', menuHeld: true }), null);
  // The cut can end on a space: it is trimmed, so the toast never gets a double space from it.
  const cutOnSpace = fallbackNotice({ ref: 'R', names: ['x'.repeat(39) + ' tail'], centreName: 'Food', menuHeld: true });
  assert.ok(cutOnSpace.toast.startsWith('R: ' + 'x'.repeat(39) + ' went to Food.'), cutOnSpace.toast);
});

test('buildRouteStamp keeps the names tidied the same way', () => {
  const s = buildRouteStamp({ fallbackNames: [LATTE, TEA, ' \u2014 ', null] });
  assert.deepEqual(s.fallback, ['Latte Big Boy', 'Tea XL Boy']);
  assert.equal(s.fallbackCount, 2);
  assert.ok(noLongDash(JSON.stringify(s)));
});
