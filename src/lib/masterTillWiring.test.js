// src/lib/masterTillWiring.test.js
//
// Source pins for the master till fence (12 Oct 2026, Coffee Boy Preston).
//
// QR drinks in a sub category landed on the Food screen. Another app instance had routed them:
// one whose shared storage said "master" and which held no category tree. The rule and the gate
// are pure and tested beside themselves (masterTill, masterTillDevice, channelRouteGate,
// ChannelAutoRouter). This file pins the WIRING, by reading the source: every reader of the flag
// goes through the one rule, the config has one writer, the master question is asked at the
// automatic call sites only, and nothing added after the kitchen claim can stop a ticket.
// Peter: "both lets fix so this cant happen plus you need to fix the master thing".

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { venueHoldsMenu, buildRouteStamp, countParentLinks, noticeLines, fallbackNotice } from './channelRouteGate.js';
import { channelFallbackCentre } from './productionRouting.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));   // .../src/
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const count = (s, text) => s.split(text).length - 1;
const between = (s, from, to) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, 'start marker not found: ' + from);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, 'end marker not found: ' + to);
  return s.slice(a, b);
};
/** Every source file under src, as a path from src with forward slashes. Tests and the changelog are left out. */
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|jsx)$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
      const rel = path.relative(SRC, full).split(path.sep).join('/');
      if (rel === 'lib/changelog.js') continue;   // release notes quote old code and may not be edited
      out.push(rel);
    }
  };
  walk(SRC);
  return out;
};

const STORE = read('store/index.js');
const APP = read('App.jsx');
const REALTIME = read('lib/realtime.js');
const ROUTE = between(STORE, 'routeKioskOrderPrints: async', '\n  printHubriseReceipt: async');
const SWEEP = between(STORE, 'releaseDueCateringOrders: async', 'fireCourse: (courseNum)');
const CLAIM_END = ".select('ref, type');";

// ── one reader, one writer ───────────────────────────────────────────────────

test('the flag has one reader: no file but the rule, its device reader and the profile mapper reads isMaster off an object', () => {
  const allowed = new Set([
    'lib/masterTill.js',                       // the rule
    'lib/masterTillDevice.js',                 // the thin reader and the one writer
    'backoffice/sections/DeviceProfiles.jsx',  // the Master POS switch on the profile form
    'sync/PrintRetrier.js',                    // a comment; the caller gates it
    'App.jsx',                                 // the profile mapper, one line
  ]);
  const files = sourceFiles();
  assert.ok(files.length > 300, 'the walk found the source tree');
  const readers = files.filter((rel) => /\.isMaster\b/.test(read(rel)));
  for (const rel of readers) assert.ok(allowed.has(rel), `${rel} reads .isMaster. Ask lib/masterTillDevice.js (isMasterTillHere / readMasterTill) instead.`);
  for (const rel of allowed) assert.ok(readers.includes(rel), `${rel} is in the allowed list but no longer reads it: tidy the list`);
  // App.jsx: exactly one, the mapper from the profile.
  const appLines = APP.split('\n').filter((l) => /\.isMaster\b/.test(l));
  assert.equal(appLines.length, 1);
  assert.equal(appLines[0].trim(), 'isMaster: profile.isMaster === true,');
  // PrintRetrier: only its comment.
  const retrier = read('sync/PrintRetrier.js').split('\n').filter((l) => /\.isMaster\b/.test(l));
  assert.equal(retrier.length, 1);
  assert.match(retrier[0], /^\s*\*/);
});

test('no file that touches the device config key reads the master answer another way (a destructure, a string key)', () => {
  const mayNameIt = new Set(['lib/masterTill.js', 'lib/masterTillDevice.js', 'App.jsx', 'lib/realtime.js']);
  for (const rel of sourceFiles()) {
    const src = read(rel);
    if (!src.includes('rpos-device-config') || mayNameIt.has(rel)) continue;
    assert.ok(!/\bisMaster\b/.test(src), `${rel} touches rpos-device-config and names isMaster`);
  }
  // realtime.js names it only as the local answer of the one rule.
  const rt = REALTIME.split('\n').filter((l) => /\bisMaster\b/.test(l)).map((l) => l.trim());
  assert.deepEqual(rt, [
    'const isMaster = isMasterTillHere(locationId);',
    "if (isMaster && !row.kitchen_routed_at && (src !== 'hubrise' || hubriseAuto)) {",
  ]);
  // The store does not name it at all.
  assert.ok(!/\bisMaster\b/.test(STORE));
});

test('the config has one writer: only the two spread writes that keep every other key remain, and nothing removes the key', () => {
  const setters = [];
  const removers = [];
  for (const rel of sourceFiles()) {
    const src = read(rel);
    if (src.includes("setItem('rpos-device-config'") || src.includes('setItem("rpos-device-config"')) setters.push(rel);
    if (src.includes("removeItem('rpos-device-config'") || src.includes('removeItem("rpos-device-config"')) removers.push(rel);
  }
  // KDSSurface writes { ...cfg, centreId } and POSSurface writes { ...ls, orderNotifications }:
  // both spread what is stored, so the stamp and the master answer ride through untouched.
  assert.deepEqual(setters.sort(), ['surfaces/POSSurface.jsx', 'surfaces/kds/KDSSurface.jsx']);
  assert.ok(read('surfaces/kds/KDSSurface.jsx').includes("localStorage.setItem('rpos-device-config', JSON.stringify({ ...cfg, centreId: id }));"));
  assert.ok(read('surfaces/POSSurface.jsx').includes("localStorage.setItem('rpos-device-config', JSON.stringify({ ...ls, orderNotifications: data.order_notifications !== false }));"));
  assert.deepEqual(removers, []);
  // The one writer goes through its named key.
  const dev = read('lib/masterTillDevice.js');
  assert.match(dev, /export const DEVICE_CONFIG_KEY = 'rpos-device-config';/);
  assert.match(dev, /storage\.setItem\(DEVICE_CONFIG_KEY, JSON\.stringify\(stampDeviceConfig\(config, till\)\)\);/);
  // And it never imports the Supabase client module, so node:test can load the rule.
  assert.ok(!/from '\.\/supabase/.test(dev));
  assert.ok(!/^import /m.test(read('lib/masterTill.js')), 'the rule is pure: no imports');
  assert.ok(!/^import /m.test(read('lib/channelRouteGate.js')), 'the gate rules are pure: no imports');
});

// ── realtime.js: the live route and the catch up scan ────────────────────────

test('realtime.js: the live order is offered to the gate by the one rule, and the old backfill read feeds the catch up scan', () => {
  assert.equal(count(REALTIME, 'const isMaster = isMasterTillHere(locationId);'), 1);
  assert.equal(count(REALTIME, 'offerLiveOrder(queueRowToRouteOrder(row));'), 1);
  // The offer sits inside the same condition as before, and the HubRise receipt follows it.
  assert.match(REALTIME, /if \(isMaster && !row\.kitchen_routed_at && \(src !== 'hubrise' \|\| hubriseAuto\)\) \{\n(?:\s*\/\/[^\n]*\n)*\s*offerLiveOrder\(queueRowToRouteOrder\(row\)\);\n\s*\/\/ Auto-accepted HubRise order[^\n]*\n\s*if \(hubriseAuto && isHubriseAutoReceipt\(locationId\)\) \{/);
  // The read is the same one the boot backfill made.
  const fetchFn = between(REALTIME, 'const fetchUnroutedChannelOrders = async () => {', 'startChannelAutoRouter({');
  assert.ok(fetchFn.includes(".select('ref, type, source, items, customer, sent_at, status, collection_time, is_asap')"));
  assert.ok(fetchFn.includes(".eq('location_id', locationId)"));
  assert.ok(fetchFn.includes(".in('source', ['kiosk', 'online', 'qr', 'hubrise'])"));
  assert.ok(fetchFn.includes(".is('kitchen_routed_at', null)"));
  assert.ok(fetchFn.includes(".neq('status', 'collected')"));
  assert.ok(fetchFn.includes('.limit(100);'));
  assert.ok(fetchFn.includes('return null;'), 'a failed read answers null, so the next trigger looks again');
  assert.equal(count(REALTIME, 'startChannelAutoRouter({ store, venueId: locationId, fetchUnrouted: fetchUnroutedChannelOrders });'), 1);
  // The order channel subscribing again asks for a catch up.
  assert.equal(count(REALTIME, "if (status === 'SUBSCRIBED') requestCatchUp('subscribed');"), 1);
  assert.match(between(REALTIME, '.channel(`order_queue:${locationId}`)', '.channel(`bar_tabs:${locationId}`)'), /\.subscribe\(\(status\) => \{\n\s*if \(status === 'SUBSCRIBED'\) requestCatchUp\('subscribed'\);\n\s*\}\);/);
  // The gate stops with the channels.
  assert.ok(between(REALTIME, 'export function stopRealtime() {', '\n}').includes('stopChannelAutoRouter();'));
});

test('realtime.js routes nothing by itself and reads no flag', () => {
  assert.equal(count(REALTIME, 'routeKioskOrderPrints'), 0, 'the route is called by sync/ChannelAutoRouter.js only');
  assert.ok(!/\.isMaster\b/.test(REALTIME));
  for (const line of REALTIME.split('\n')) {
    assert.ok(!(line.includes('rpos-device-config') && /isMaster/.test(line)), line.trim());
  }
  // The only callers of the route in the whole app, automatic and by hand.
  const callers = sourceFiles().filter((rel) => read(rel).includes('routeKioskOrderPrints?.('));
  assert.deepEqual(callers.sort(), ['store/index.js', 'surfaces/OrdersHub.jsx', 'sync/ChannelAutoRouter.js']);
  const auto = read('sync/ChannelAutoRouter.js');
  assert.equal(count(auto, 'routeKioskOrderPrints?.('), 2);
  assert.ok(auto.includes("routeKioskOrderPrints?.(order, { trigger: 'backfill' });"));
  assert.ok(auto.includes("routeKioskOrderPrints?.(order, { trigger: 'live' });"));
});

// ── the store: the sweep, the route, the tree ────────────────────────────────

test('store sweep: the one rule first, then the venue, then the menu gate, and a waiting tick lets go of its latch', () => {
  const rule = SWEEP.indexOf('if (!isMasterTillHere()) return;');
  const latch = SWEEP.indexOf('useStore._cateringReleaseRunning = true;');
  const gate = SWEEP.indexOf('autoRouteGate(useStore.getState(), locId)');
  const query = SWEEP.indexOf("supabase.from('order_queue')");
  assert.ok(rule > 0, 'the one rule');
  assert.ok(latch > rule && gate > latch && query > gate, 'rule, latch, gate, then the read');
  assert.ok(SWEEP.includes("if (sweepGate !== 'route' && sweepGate !== 'route-blind') { useStore._cateringReleaseRunning = false; return; }"));
  assert.equal(count(SWEEP, "}, { trigger: 'catering' });"), 1);
  assert.ok(!SWEEP.includes("localStorage.getItem('rpos-device-config')"), 'no storage read of the flag');
  // The courier is booked inside the row loop, after the gate: a tick that waits books none.
  assert.ok(SWEEP.indexOf('dispatchDelivery(') > query);
});

test('the master question is never inside the route, and the route reads no category tree from the network (local first)', () => {
  for (const word of ['isMasterTillHere', 'readMasterTill', 'autoRouteGate', 'routeGateDecision', 'masterTillDecision']) {
    assert.ok(!ROUTE.includes(word), `routeKioskOrderPrints must not ask ${word}: a person's press is never refused and never waits`);
  }
  assert.ok(!ROUTE.includes("from('menu_categories')"), 'D1: no new network read on the routing path');
  // The network reads of the route's main path are the ones it always made.
  assert.equal(count(ROUTE, ".from('print_routing')"), 1);
  assert.equal(count(STORE, 'const makeRoutingCtx = (orderType) => ({'), 1, 'makeRoutingCtx still takes one argument');
});

test('routeKioskOrderPrints wiring: force rides in opts, the deferred call keeps its opts, every row carries the stamp', () => {
  assert.equal(count(ROUTE, 'if (!opts?.force && routedBefore(order.ref)) {'), 1);
  assert.ok(!ROUTE.includes('!order.force'), 'the old read off the order is gone');
  assert.equal(count(ROUTE, 'routeKioskOrderPrints?.(order, opts), cappedWait);'), 1);
  assert.equal(count(STORE, 'meta: withRouteStamp(_kdsMeta, routeStamp),'), 1);
  assert.ok(!ROUTE.includes('meta: _kdsMeta,'), 'no row is written without the stamp wrapper');
  // The stamp is built from named values of this page, never by spreading the device record.
  const stamp = between(ROUTE, 'routeStamp = buildRouteStamp({', '});');
  for (const key of ['deviceId: who.deviceId', 'deviceName: who.deviceName', 'mode: who.mode', 'version: VERSION', 'trigger: opts?.trigger',
    'categoryCount: (st.menuCategories || []).length', 'parentLinks: countParentLinks(routingCtx.catParents)', 'menuHeld: menu.ready',
    'fallbackNames: unrouted.map(i => i?.name)', 'at: Date.now()']) {
    assert.ok(stamp.includes(key), key);
  }
  assert.ok(!stamp.includes('...'), 'nothing is spread into the stamp');
  assert.ok(!/deviceSecret|readLocalDevice|thisDeviceName/.test(stamp));
});

test('nothing new before the claim, and nothing new can stop the ticket', () => {
  const claimAt = ROUTE.indexOf(CLAIM_END);
  assert.ok(claimAt > 0);
  const beforeClaim = ROUTE.slice(0, claimAt);
  for (const word of ['buildRouteStamp', 'venueHoldsMenu', 'routerIdentity', 'fallbackNotice', 'noticeLines', 'withRouteStamp', 'logActivity']) {
    assert.ok(!beforeClaim.includes(word), `${word} must come after the claim`);
  }
  // No new wait before the claim: the venue (when it is not already known) and the claim itself.
  assert.equal(count(beforeClaim, 'await '), 2);
  assert.ok(ROUTE.indexOf('buildRouteStamp(') > claimAt);
  // The stamp block: both values start null, one try, a catch that only warns.
  const block = between(ROUTE, '// 12 Oct 2026 (Preston, D5 + D6): who routed this and with what, and which lines had no screen.', 'const SRC_LABEL');
  assert.match(block, /let routeStamp = null;\n\s*let routeWords = null;\n\s*try \{\n[\s\S]*routeStamp = buildRouteStamp\(\{[\s\S]*routeWords = fallbackNotice\(\{[\s\S]*\n\s*\} catch \(e\) \{ console\.warn\('\[routeKioskOrderPrints\] route stamp failed:', e\?\.message \|\| e\); \}\n/);
  assert.equal(count(block, 'try {'), 1);
  // v5.5.861: a second const named for the channel label is declared just below, and using it up
  // here threw AFTER the claim, so orders were claimed and never printed. Not the word, not once.
  assert.ok(!block.includes('srcLabel'));
  assert.ok(!/\breturn\b/.test(block), 'the block never leaves the action');
  assert.ok(!/\bawait\b/.test(block), 'the block waits for nothing');
  // It sits after the fallback bucket (it needs the lines that fell back) and before the labels.
  assert.ok(ROUTE.indexOf('const unrouted = order.items.filter') < ROUTE.indexOf(block.slice(0, 40)));
});

// The two blocks added after the claim, RUN as they are written in the store (the source text is
// lifted out and given its free names), so a typo, a name used before it exists or a throw that
// escapes shows up here and not on a master till with a paid order in its hands.
const STAMP_BLOCK = between(ROUTE, '      let routeStamp = null;', '\n\n      // v5.5.126: source-correct labels');
const STAMP_NAMES = ['useStore', 'routerIdentity', 'venueHoldsMenu', 'channelFallbackCentre', 'buildRouteStamp', 'countParentLinks',
  'fallbackNotice', 'noticeLines', 'VERSION', 'locId', 'unrouted', 'routingConfig', 'routingCtx', 'allMenuItems', 'opts', 'order', 'console'];
const runStampBlock = (over = {}) => {
  const warned = [];
  const env = {
    useStore: { getState: () => ({ menuCategories: [{ id: 'coffee', location_id: 'loc-A' }, { id: 'hot', location_id: 'loc-A' }], bootLocationId: 'loc-A', _catsReadLocationId: 'loc-A' }) },
    routerIdentity: () => ({ deviceId: 'dev-1', deviceName: 'POS', mode: 'pos' }),
    venueHoldsMenu, channelFallbackCentre, buildRouteStamp, countParentLinks, fallbackNotice, noticeLines,
    VERSION: '5.11.51', locId: 'loc-A', unrouted: [],
    routingConfig: { centres: [{ id: 'food', name: 'Food', printer: null }, { id: 'in', name: 'Drinks In', printer: null }], routing: {} },
    routingCtx: { catParents: { coffee: 'hot', hot: null } }, allMenuItems: [{ id: 'm-latte' }],
    opts: { trigger: 'live' }, order: { ref: 'QR-QRJZK', source: 'qr' },
    console: { warn: (...a) => warned.push(a.join(' ')) },
    ...over,
  };
  const fn = new Function(...STAMP_NAMES, STAMP_BLOCK + '\n      return { routeStamp, routeWords };');
  return { ...fn(...STAMP_NAMES.map((n) => env[n])), warned };
};

test('the stamp block, run as written: a healthy master till stamps the ticket and has nothing to say', () => {
  const out = runStampBlock();
  assert.deepEqual({ ...out.routeStamp, at: null }, {
    v: 1, deviceId: 'dev-1', deviceName: 'POS', mode: 'pos', version: '5.11.51', trigger: 'live',
    cats: 2, links: 1, menu: true, fallback: [], fallbackCount: 0, at: null,
  });
  assert.ok(Math.abs(Date.parse(out.routeStamp.at) - Date.now()) < 5000, 'stamped with the route time');
  assert.equal(out.routeWords, null, 'no notice: the menu was held and every line had a screen');
  assert.deepEqual(out.warned, []);
});

test('the stamp block, run as written: the Preston ticket (no tree, a Latte with no screen) is stamped and has its words', () => {
  const latte = { itemId: 'm-latte', name: 'Latte Big Boy', qty: 1 };
  const out = runStampBlock({
    useStore: { getState: () => ({ menuCategories: [], bootLocationId: null, _catsReadLocationId: null }) },
    routingCtx: { catParents: {} }, unrouted: [latte], opts: {},
  });
  assert.equal(out.routeStamp.cats, 0);
  assert.equal(out.routeStamp.links, 0);
  assert.equal(out.routeStamp.menu, false);
  assert.equal(out.routeStamp.trigger, 'unknown', 'a caller that names no trigger');
  assert.deepEqual(out.routeStamp.fallback, ['Latte Big Boy']);
  assert.deepEqual(out.routeWords, {
    toast: 'QR-QRJZK: Latte Big Boy went to Food. This till had no menu yet. Check the kitchen screens.',
    title: 'Order sent without the menu',
    body: 'QR-QRJZK: this till had no menu yet. Latte Big Boy went to Food.',
  });
  // The menu held, the line still had no screen (a category no centre takes): the other notice.
  const held = runStampBlock({ unrouted: [latte] });
  assert.equal(held.routeStamp.menu, true);
  assert.equal(held.routeWords.toast, 'QR-QRJZK: Latte Big Boy went to Food. No kitchen screen is set for it.');
  // A delivery app line that is not in our menu is left to the existing toast: stamped, not said twice.
  const hubrise = runStampBlock({ unrouted: [{ id: 'sku-unknown', name: 'Mystery' }], order: { ref: 'HR-1', source: 'hubrise' } });
  assert.deepEqual(hubrise.routeStamp.fallback, ['Mystery']);
  assert.equal(hubrise.routeWords, null);
  // No centres at all: nothing fell back to anywhere, the existing "did not print" toast speaks.
  const none = runStampBlock({ unrouted: [latte], routingConfig: { centres: [], routing: {} } });
  assert.equal(none.routeWords, null);
});

test('the stamp block, run as written: whatever fails inside it, nothing escapes and the ticket goes without the stamp', () => {
  const boom = (name) => () => { throw new Error(name + ' broke'); };
  for (const name of ['routerIdentity', 'venueHoldsMenu', 'channelFallbackCentre', 'buildRouteStamp', 'countParentLinks']) {
    const out = runStampBlock({ [name]: boom(name), unrouted: [{ name: 'Latte' }] });
    assert.equal(out.routeStamp, null, name);
    assert.equal(out.routeWords, null, name);
    assert.equal(out.warned.length, 1, name);
    assert.match(out.warned[0], /route stamp failed: .* broke/);
  }
  // The words fail after the stamp was built: the stamp is kept, the notice is left off.
  const late = runStampBlock({ fallbackNotice: boom('fallbackNotice'), unrouted: [{ name: 'Latte' }] });
  assert.equal(late.routeStamp.fallbackCount, 1);
  assert.equal(late.routeWords, null);
  // Junk in the store, a null routing context, no opts, junk lines: still a plain stamp.
  const junk = runStampBlock({ useStore: { getState: () => ({}) }, routingCtx: {}, opts: undefined, unrouted: [null, undefined, {}], routingConfig: {} });
  assert.equal(junk.routeStamp.v, 1);
  assert.equal(junk.routeStamp.cats, 0);
  assert.equal(junk.routeStamp.menu, false);
  assert.deepEqual(junk.warned, []);
});

test('the notice block, run as written: one delayed toast, one info event, and a failure there never escapes', () => {
  const from = ROUTE.indexOf('      try {\n        if (routeWords && Object.keys(byCentre).length > 0) {');
  assert.ok(from > 0);
  const endMark = "} catch (e) { console.warn('[routeKioskOrderPrints] route notice failed:', e?.message || e); }";
  const block = ROUTE.slice(from, ROUTE.indexOf(endMark, from) + endMark.length);
  const names = ['routeWords', 'byCentre', 'typeFallback', 'useStore', 'logActivity', 'locId', 'order', 'routeStamp', 'setTimeout', 'console'];
  const run = (over = {}) => {
    const timers = []; const toasts = []; const events = []; const warned = [];
    const env = {
      routeWords: { toast: 'T', title: 'Ti', body: 'B' }, byCentre: { food: [{}] }, typeFallback: false,
      useStore: { getState: () => ({ showToast: (...a) => toasts.push(a) }) },
      logActivity: (loc, ev) => { events.push([loc, ev]); return Promise.reject(new Error('offline')); },
      locId: 'loc-A', order: { ref: 'QR-1' }, routeStamp: { deviceName: 'POS' },
      setTimeout: (fn, ms) => { timers.push(ms); fn(); }, console: { warn: (...a) => warned.push(a.join(' ')) },
      ...over,
    };
    new Function(...names, block)(...names.map((n) => env[n]));
    return { timers, toasts, events, warned };
  };
  const a = run();
  assert.deepEqual(a.timers, [3200]);
  assert.deepEqual(a.toasts, [['T', 'warning', 9000]]);
  assert.deepEqual(a.events, [['loc-A', { kind: 'ops', severity: 'info', title: 'Ti', body: 'B', refType: 'kitchen_route', refId: 'QR-1', actorName: 'POS' }]]);
  // Behind the order type warning when there is one.
  assert.deepEqual(run({ typeFallback: true }).timers, [6200]);
  // Nothing to say, or nothing was routed: no toast, no event.
  for (const over of [{ routeWords: null }, { byCentre: {} }]) {
    const q = run(over);
    assert.deepEqual([q.timers, q.toasts, q.events], [[], [], []]);
  }
  // The stamp could not be built: the event still goes, with no actor.
  assert.equal(run({ routeStamp: null }).events[0][1].actorName, null);
  // logActivity throwing at once (not just rejecting) is caught and only warned.
  const thrown = run({ logActivity: () => { throw new Error('no client'); } });
  assert.equal(thrown.warned.length, 1);
  assert.match(thrown.warned[0], /route notice failed: no client/);
});

test('the stamp can never cost a ticket: one more try with the same rows and the meta as it was', () => {
  const insert = between(ROUTE, "let { error: kdsErr } = await supabase.from('kds_tickets').insert(tickets);", "reportSave('kitchen ticket', kdsErr);");
  assert.match(insert, /if \(kdsErr && routeStamp && !isMissingColumnError\(kdsErr, 'meta'\)\) \{/);
  assert.ok(insert.includes("const again = await supabase.from('kds_tickets').insert(tickets.map(t => ({ ...t, meta: _kdsMeta })));"));
  assert.ok(insert.includes("kdsErr = again.error && again.error.code !== '23505' ? again.error : null;"));
  // The missing column retry still follows, unchanged.
  const retry = insert.indexOf("if (kdsErr && isMissingColumnError(kdsErr, 'meta')) {");
  assert.ok(retry > insert.indexOf('const again ='));
  assert.ok(insert.includes('tickets.map(t => { const { meta: _meta, ...rest } = t; return rest; })'));
});

test('notices never block: raised last, after the status write, in their own try, and the event is not waited for', () => {
  const statusWrite = ROUTE.indexOf("status: 'received' }, kind: 'queue_status'");
  const notice = ROUTE.indexOf("refType: 'kitchen_route'");
  assert.ok(statusWrite > 0 && notice > statusWrite, 'the notice comes after the status write');
  const line = ROUTE.split('\n').find((l) => l.includes("refType: 'kitchen_route'"));
  assert.match(line, /^\s*logActivity\(locId, \{ kind: 'ops', severity: 'info', title: routeWords\.title, body: routeWords\.body, refType: 'kitchen_route', refId: order\.ref, actorName: routeStamp\?\.deviceName \|\| null \}\)\.catch\(\(\) => \{\}\);$/);
  assert.ok(!ROUTE.includes('await logActivity'));
  const tail = ROUTE.slice(statusWrite);
  assert.match(tail, /try \{\n\s*if \(routeWords && Object\.keys\(byCentre\)\.length > 0\) \{\n\s*setTimeout\(\(\) => useStore\.getState\(\)\.showToast\?\.\(routeWords\.toast, 'warning', 9000\), typeFallback \? 6200 : 3200\);\n\s*logActivity\(/);
  assert.ok(tail.includes("} catch (e) { console.warn('[routeKioskOrderPrints] route notice failed:', e?.message || e); }"));
  // The existing delivery app toast is still there, once, and is not reworded.
  assert.equal(count(ROUTE, 'item(s) not in our menu'), 1);
  assert.equal(count(ROUTE, "if (typeFallback) useStore.getState().showDelayedToast?.(orderTypeFallbackMessage(typeKey), 'warning');"), 1);
});

test('person triggers: Accept, Send to kitchen again and a catering order opened early route now, stamped manual, with no gate', () => {
  const accept = between(STORE, '_acceptOrderCore: (ref, delayMinutes) => {', 'acceptOrderByRef: (ref) =>');
  assert.equal(count(accept, "}, { trigger: 'manual' });"), 1);
  for (const word of ['isMasterTillHere', 'readMasterTill', 'autoRouteGate']) assert.ok(!accept.includes(word), word);
  const hub = read('surfaces/OrdersHub.jsx');
  assert.equal(count(hub, "{ force: true, trigger: 'manual' }"), 1);
  assert.equal(count(hub, "sentAt: Date.now() }, { trigger: 'manual' }); }"), 1);
  for (const word of ['isMasterTillHere', 'readMasterTill', 'autoRouteGate']) assert.ok(!hub.includes(word), word);
  // The Orders screen is mounted once, inside the till shell: a non till mode cannot open it.
  assert.equal(count(APP, '<OrdersHub'), 1);
  const shell = between(APP, '<ShiftBar version={VERSION}', '// Kiosk card problems park over EVERY staff body');
  assert.equal(count(shell, "{surface==='orders'     && <OrdersHub />}"), 1);
});

test('the tree: the till\'s own two copies merged, the live store first, this venue\'s snapshot only', () => {
  const fn = between(STORE, 'const buildCatParentMap = () => {', '\n};');
  assert.ok(fn.includes('fromStore = catParentMapOf(useStore.getState().menuCategories || []);'));
  // tabVenue(): a till's paired venue; in Back Office the venue THIS tab resolved, never the
  // key every tab shares (staleTabWiring.test.js pins that for this part of the store).
  assert.ok(fn.includes('catParentMapOf(snapshotCategoriesFor(snap, tabVenue()));'));
  assert.match(STORE, /export const tabVenue = \(\) => \(isBackOfficeMode\(\) && getResolvedLocationIdSync\(\)\) \|\| getActiveLocationSync\(\);/);
  assert.ok(fn.includes('return mergeCatParentMaps(fromStore, fromSnapshot);'));
  assert.ok(!/\bawait\b|supabase/.test(fn), 'no network');
  assert.match(STORE, /const makeRoutingCtx = \(orderType\) => \(\{\n\s*menuItems: useStore\.getState\(\)\.menuItems \|\| \[\],\n\s*catParents: buildCatParentMap\(\),\n\s*orderType,\n\}\);/);
});

test('SyncBridge marks the category read from the read it already makes; the store declares the flag', () => {
  const sync = read('sync/SyncBridge.jsx');
  assert.match(sync, /const catsRes\s+= unwrap\(catsSt\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(!catsRes\.error && Array\.isArray\(catsRes\.data\)\) useStore\.setState\(\{ _catsReadLocationId: locationId \}\);\n/);
  assert.equal(count(sync, '_catsReadLocationId'), 1);
  assert.equal(count(sync, 'fetchMenuCategories(locationId),'), 1, 'no second category read');
  assert.match(STORE, /\n {2}_catsReadLocationId: null,\n/);
  assert.equal(count(STORE, '_catsReadLocationId: null,'), 1);
});

// ── App.jsx: the role, the session mark, the writer, the clears ──────────────

test('App.jsx role: the heartbeat, the print engines and the child monitor follow the one rule', () => {
  assert.equal(count(APP, 'const verdict = readMasterTill({ venueId: locId });'), 1);
  assert.equal(count(APP, 'const isMasterDevice = verdict.master;'), 1);
  assert.equal(count(APP, 'isMaster: isMasterDevice,'), 1, 'the print orchestrator takes the same answer');
  assert.match(APP, /if \(isMasterDevice\) \{\n\s*const \{ startPrintRetrier \} = await import\('\.\/sync\/PrintRetrier\.js'\);/);
  // Storage says master and the rule says no: said out loud, and never the child monitor.
  const refused = between(APP, 'if (verdict.storedMaster) {', '} else {');
  assert.ok(!refused.includes('startChildMonitor'));
  assert.ok(refused.includes("useStore.getState().showToast?.(MASTER_REFUSED_TOAST, 'error', 15000);"));
  assert.ok(refused.includes('logActivity(locId, masterRefusedEvent({ deviceId: pairedDevice.id, deviceName: pairedDevice.name })).catch(() => {});'));
  // A normal till still monitors the master after 20 s, as before.
  assert.match(APP, /\} else \{\n\s*await new Promise\(r => setTimeout\(r, 20_000\)\);\n\s*if \(!stopped\) startChildMonitor\(\{ locationId: locId \}\);\n\s*\}/);
  assert.equal(count(APP, 'startChildMonitor({ locationId: locId });'), 1);
  assert.ok(APP.includes('startChildHeartbeat({ deviceId: pairedDevice.id, locationId: locId, deviceName: pairedDevice.name, version: VERSION });'));
});

test('App.jsx session mark: set in the same statement that calls the device valid, cleared when the till shell goes', () => {
  assert.equal(count(APP, 'const [deviceValid, setDeviceValidState] = useState(null);'), 1);
  assert.equal(count(APP, 'const setDeviceValid = (v) => { markTillSession(v === true ? pairedDevice?.id : null); setDeviceValidState(v); };'), 1);
  // Nothing sets the screen state past the wrapper.
  assert.equal(count(APP, 'setDeviceValidState('), 1);
  assert.match(APP, /return \(\) => \{\n\s*markTillSession\(null\);[^\n]*\n\s*supabase\.removeChannel\(channel\);/);
  // The kicked and pairing states go through the same wrapper, so they drop the mark.
  assert.ok(count(APP, "setDeviceValid('kicked');") >= 2);
  assert.ok(count(APP, 'setDeviceValid(false);') >= 2);
});

test('App.jsx writer: storage is written outside the change gate, and the compare keys carry no stamp', () => {
  const apply = between(APP, 'const applyDeviceConfig = (config, { announce = false } = {}) => {', '\n  };');
  const save = apply.indexOf('saveDeviceConfig(config, { force: changed });');
  const gate = apply.indexOf('if (!changed) return;');
  assert.ok(save > 0 && gate > save, 'the write comes before the gate');
  assert.ok(apply.includes('const changed = deviceConfigChanged(prev, config);'));
  assert.ok(apply.includes('const masterFlipped = !!tillSession() && masterFlagDiffers(prev, config);'));
  assert.ok(apply.includes("if (masterFlipped) setTimeout(() => useStore.getState().showToast(MASTER_CHANGED_TOAST, 'warning', 12000), 3000);"));
  const keys = between(APP, 'const CONFIG_COMPARE_KEYS = [', '];');
  assert.ok(!keys.includes('ownerDeviceId') && !keys.includes('ownerLocationId'), 'a stamp key there would reset the order type on every till');
  assert.ok(keys.includes("'isMaster'"));
  // The handset sync writes through the same writer.
  const mpos = between(APP, 'function MposDeviceProfileSync({ pairedDevice }) {', '\n}\n');
  assert.equal(count(mpos, 'saveDeviceConfig(next, { force: true });'), 1);
  // App.jsx itself never writes or removes the key.
  assert.ok(!APP.includes("setItem('rpos-device-config'"));
  assert.ok(!APP.includes("removeItem('rpos-device-config'"));
});

test('App.jsx clears: a removed till, an unpaired till and a till with no profile are no master; a failed profile read keeps the stored answer', () => {
  const removed = between(APP, "if (decision === 'removed') {", "if (decision === 'pair') {");
  assert.match(removed, /localStorage\.removeItem\('rpos-device'\);\n(?:\s*\/\/[^\n]*\n)*\s*clearMasterFlag\(\);\n\s*setDeviceValid\(false\);/);
  const pair = between(APP, "if (decision === 'pair') {", '// Unknown: keep everything, keep working, the banner explains.');
  assert.match(pair, /clearMasterFlag\(\);\n\s*setDeviceValid\(false\);\n\s*return;/);
  assert.ok(!pair.includes("removeItem('rpos-device')"), 'the pairing record is kept, as before');
  // No profile on the device row.
  assert.match(APP, /\} catch\(e\) \{\}\n\s*\} else \{\n(?:\s*\/\/[^\n]*\n)*\s*clearMasterFlag\(\);\n\s*\}/);
  assert.equal(count(APP, 'clearMasterFlag();'), 3);
  // Only a fresh read of the profile row may turn master on or off.
  assert.ok(APP.includes('if (dbProfile) { profile = profileRowToProfile(dbProfile); profileFromDb = true; }'));
  assert.ok(APP.includes('applyDeviceConfig(profileFromDb ? cfg : keepStoredMaster(cfg));'));
  assert.ok(APP.includes('applyDeviceConfig(keepStoredMaster(minConfig));'));
  // The silent refresh and the live profile channel only ever apply a fresh profile row.
  assert.ok(APP.includes('applyDeviceConfig(configFromProfile(profileRowToProfile(dbProfile)));'));
  assert.ok(APP.includes('applyDeviceConfig(configFromProfile(profileRowToProfile(payload.new)), { announce: true });'));
});

test('App.jsx: the PIN screen draws the toast, so a till that signs out after each sale still sees the notices', () => {
  assert.equal(count(APP, 'body = <><PINScreen />{toast && <Toast toast={toast} />}</>;'), 1);
  assert.ok(!APP.includes('body = <PINScreen />;'));
});

// ── pairing, Back Office, the tenant fence ───────────────────────────────────

test('PairingScreen: a new pairing forgets the old config first, then writes through the one writer', () => {
  const ps = read('surfaces/PairingScreen.jsx');
  const device = ps.indexOf("localStorage.setItem('rpos-device', JSON.stringify(deviceEntry));");
  const forget = ps.indexOf('forgetDeviceConfig();');
  const firstSave = ps.indexOf('saveDeviceConfig({');
  assert.ok(device > 0 && forget > device && firstSave > forget, 'the pairing, then forget, then the new config');
  assert.equal(count(ps, 'forgetDeviceConfig();'), 1);
  assert.equal(count(ps, 'saveDeviceConfig({'), 2);
  assert.equal(count(ps, '}, { force: true });'), 2);
  assert.ok(!ps.includes("setItem('rpos-device-config'"));
  // Neither config a pairing writes says master: only the profile row can.
  assert.ok(!/\bisMaster\b/.test(ps));
});

test('Back Office cannot take the till down: the POS buttons drop only the placeholder, and the fence keeps the config', () => {
  const bo = read('backoffice/BackOfficeApp.jsx');
  assert.equal(count(bo, 'dropAdminPlaceholder();'), 2);
  assert.ok(!bo.includes("removeItem('rpos-device'"), 'neither the pairing nor its config is removed here');
  assert.ok(bo.includes("onClick={() => { dropAdminPlaceholder(); localStorage.setItem('rpos-device-mode','pos'); window.location.href = '?mode=pos'; }}"));
  assert.ok(bo.includes('<a href="?mode=pos" onClick={() => { dropAdminPlaceholder(); }}'));
  const keep = between(read('lib/supabase.js'), 'const TENANT_FENCE_KEEP = new Set([', ']);');
  assert.ok(keep.includes("'rpos-device-config',"));
  assert.ok(keep.includes("'rpos-device',"));
  // The only places the pairing record is removed: the till's own "removed" branch and the placeholder drop.
  const removers = sourceFiles().filter((rel) => read(rel).includes("removeItem('rpos-device')"));
  assert.deepEqual(removers, ['App.jsx']);
  assert.equal(count(APP, "removeItem('rpos-device')"), 1);
});

test('Back Office screens: Devices says when the master set up is wrong, and Device profiles says what a master is', () => {
  const reg = read('backoffice/sections/DeviceRegistry.jsx');
  assert.ok(reg.includes("import { masterSetupReport } from '../../lib/masterTill';"));
  assert.ok(reg.includes('const masterReport = masterSetupReport({ devices, profiles: masterFacts?.profiles, heartbeats: masterFacts?.heartbeats, now: masterFacts?.readAt });'));
  assert.match(reg, /\{masterReport\.lines\.map\(\(l, i\) => \(\n\s*<div key=\{i\} style=\{\{ \.\.\.MASTER_LINE\[l\.level\],[^\n]*\}\}>\{l\.text\}<\/div>\n\s*\)\)\}/);
  assert.ok(reg.indexOf('{masterReport.lines.map(') < reg.indexOf('Registered devices ({devices.length})'), 'above the device list');
  // The two small reads, for the same venue as the device list. No write, no schema change.
  assert.ok(reg.includes("supabase.from('device_profiles').select('id, is_master').eq('location_id', locId),"));
  assert.ok(reg.includes("supabase.from('device_heartbeats').select('device_id, role, last_seen').eq('location_id', locId),"));
  for (const level of ['error', 'warn', 'ok']) assert.match(reg, new RegExp(`\\n  ${level}:\\s+\\{ background:`), level);
  const prof = read('backoffice/sections/DeviceProfiles.jsx');
  assert.equal(count(prof, 'The master till sends QR, online and kiosk orders to the kitchen. Set it on one till per venue. A handheld or kiosk cannot be the master.'), 1);
  assert.ok(!prof.includes('Designate this terminal as the network master'));
});

// ── house rules for the new files ────────────────────────────────────────────

test('the new files hold no long dashes and never the text N/A', () => {
  for (const rel of ['lib/masterTill.js', 'lib/masterTillDevice.js', 'lib/channelRouteGate.js', 'sync/ChannelAutoRouter.js']) {
    const src = read(rel);
    assert.ok(!/[\u2013\u2014]/.test(src), rel + ' holds a long dash');
    assert.ok(!/N\/A/.test(src), rel + ' holds N/A');
  }
});
