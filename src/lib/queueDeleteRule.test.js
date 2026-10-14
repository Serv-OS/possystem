// Who may write the open orders list and bar tabs, and why a row is deleted (lib/queueDeleteRule.js,
// 12 Oct 2026). The rule on its own, then source pins that hold every caller to it. The same rule
// run end to end through the real sync code is sync/queueDeleteFence.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  queueDeviceRole, isKitchenProfile, maySyncQueue, mayRemoveQueueRow, queueDeleteDecision,
  tabDeleteDecision, dropBufferedQueueWrite, QUEUE_READER_MODES, QUEUE_OFFICE_MODES, QUEUE_READER_TYPES,
} from './queueDeleteRule.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

// ── What kind of page is this ────────────────────────────────────────────────────────────────

test('a kitchen screen is a reader in every shape it takes in the field', () => {
  // The ServOS KDS app opens ?mode=kds.
  assert.equal(queueDeviceRole({ mode: 'kds' }), 'reader');
  assert.equal(queueDeviceRole({ mode: 'kds', deviceType: 'kds', defaultSurface: 'kds', profileName: 'Kitchen Display' }), 'reader');
  // Coffee Boy Barnsley drinks screen: paired as a Kitchen Display (devices.type kds) in a till mode page.
  assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'kds' }), 'reader');
  assert.equal(queueDeviceRole({ mode: '', deviceType: 'kds', defaultSurface: 'kds', profileName: 'Kitchen Display' }), 'reader');
  // A POS type device on a profile that boots straight to the kitchen screen.
  assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'pos', defaultSurface: 'kds', profileName: 'Drinks screen' }), 'reader');
  // The kitchen app on a POS type pairing with a kitchen profile still shows the kitchen screen.
  assert.equal(queueDeviceRole({ mode: 'kds', deviceType: 'pos', defaultSurface: 'kds', profileName: 'Kitchen pass' }), 'reader');
});

test('a page that SHOWS a till is a till, even inside the kitchen app', () => {
  // The kitchen app paired with a till's code and a till profile: App.jsx shows the PIN pad and
  // the till. Its orders must reach the other tills, so it is never fenced as a reader.
  assert.equal(queueDeviceRole({ mode: 'kds', deviceType: 'pos', defaultSurface: 'pos', profileName: 'Main counter' }), 'till');
  assert.equal(queueDeviceRole({ mode: 'kds', deviceType: 'pos' }), 'till');
  // A kiosk or clock type paired in the till shell with a till profile shows the till as well.
  assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'kiosk', defaultSurface: 'tables', profileName: 'Main counter' }), 'till');
  assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'clock', defaultSurface: 'pos', profileName: 'Main counter' }), 'till');
});

test('a counter, bar or server till that only OPENS on its kitchen view is still a till', () => {
  for (const profileName of ['Main counter', 'Bar terminal', 'Server handheld', 'COUNTER 2']) {
    assert.equal(isKitchenProfile({ defaultSurface: 'kds', profileName }), false, profileName);
    assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'pos', defaultSurface: 'kds', profileName }), 'till', profileName);
  }
  assert.equal(isKitchenProfile({ defaultSurface: 'kds', profileName: 'Kitchen Display' }), true);
  assert.equal(isKitchenProfile({ defaultSurface: 'kds' }), true);
  assert.equal(isKitchenProfile({ defaultSurface: 'pos', profileName: 'Kitchen Display' }), false);
  assert.equal(isKitchenProfile(), false);
});

test('tills and handsets are tills', () => {
  for (const mode of ['pos', 'bar', 'tables', 'orders', 'ai']) {
    assert.equal(queueDeviceRole({ mode, deviceType: 'pos', defaultSurface: 'pos', profileName: 'Main counter' }), 'till', mode);
  }
  assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'handheld' }), 'till');
  assert.equal(queueDeviceRole({ mode: 'mpos' }), 'till');
  // The handset page is a till whatever a shared browser holds in storage.
  assert.equal(queueDeviceRole({ mode: 'mpos', deviceType: 'kds', defaultSurface: 'kds', profileName: 'Kitchen Display' }), 'till');
});

test('anything unknown reads as a till: a real till is never stopped from sending an order', () => {
  assert.equal(queueDeviceRole(), 'till');
  assert.equal(queueDeviceRole({}), 'till');
  assert.equal(queueDeviceRole({ mode: null, deviceType: undefined }), 'till');
  assert.equal(queueDeviceRole({ mode: 'pos' }), 'till');
  assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'something-new' }), 'till');
});

test('Back Office is the office, in both spellings', () => {
  for (const mode of QUEUE_OFFICE_MODES) {
    assert.equal(queueDeviceRole({ mode }), 'office', mode);
    // A Back Office tab in a browser that also holds a till or a kitchen pairing is still the office.
    assert.equal(queueDeviceRole({ mode, deviceType: 'pos' }), 'office', mode);
    assert.equal(queueDeviceRole({ mode, deviceType: 'kds' }), 'office', mode);
  }
  assert.deepEqual([...QUEUE_OFFICE_MODES], ['office', 'backoffice']);
});

test('kiosks, host stands, displays and clocks are readers', () => {
  for (const mode of QUEUE_READER_MODES) assert.equal(queueDeviceRole({ mode, deviceType: 'pos' }), 'reader', mode);
  for (const mode of ['kiosk', 'waitlist', 'bookings', 'customer-display', 'menuboard', 'orderscreen', 'clock']) {
    assert.ok(QUEUE_READER_MODES.includes(mode), mode);
  }
  assert.ok(!QUEUE_READER_MODES.includes('kds'), 'the kitchen app opens the till shell: what it shows decides');
  for (const deviceType of QUEUE_READER_TYPES) assert.equal(queueDeviceRole({ mode: 'pos', deviceType }), 'reader', deviceType);
  assert.deepEqual([...QUEUE_READER_TYPES], ['kds']);
  // A profile that opens on the kiosk: App.jsx shows the kiosk, never the till.
  assert.equal(queueDeviceRole({ mode: 'pos', deviceType: 'pos', defaultSurface: 'kiosk', profileName: 'Kiosk' }), 'reader');
  assert.equal(queueDeviceRole({ mode: 'KDS' }), 'reader', 'the mode word is not case sensitive');
});

test('every reader mode is a mode App.jsx returns for before the till shell', () => {
  const app = read('../App.jsx');
  const shell = app.indexOf("if (deviceMode === 'clock')");
  assert.ok(shell > 0);
  const before = app.slice(0, shell + 200);
  for (const mode of QUEUE_READER_MODES) {
    if (mode === 'ops') { assert.ok(before.includes("if (deviceMode === 'ops')"), mode); continue; }
    assert.ok(before.includes(`deviceMode === '${mode}'`), `App.jsx handles ${mode} before the till shell`);
  }
});

test('only a till syncs the list; a named staff action may remove a row on a till or in Back Office', () => {
  assert.equal(maySyncQueue('till'), true);
  assert.equal(maySyncQueue('office'), false);
  assert.equal(maySyncQueue('reader'), false);
  assert.equal(maySyncQueue(undefined), false);
  assert.equal(mayRemoveQueueRow('till'), true);
  assert.equal(mayRemoveQueueRow('office'), true);
  assert.equal(mayRemoveQueueRow('reader'), false);
  assert.equal(mayRemoveQueueRow(undefined), false);
});

// ── Why a row is deleted ─────────────────────────────────────────────────────────────────────

test('a page that is not a till never deletes, whatever its list looks like', () => {
  for (const role of ['reader', 'office', undefined]) {
    for (const present of [false, true]) for (const done of [false, true]) for (const pending of [false, true]) for (const doneAtBoot of [false, true]) {
      assert.equal(queueDeleteDecision({ role, present, done, pending, doneAtBoot }), 'none');
    }
    assert.equal(tabDeleteDecision({ role }), 'none');
  }
  assert.equal(queueDeleteDecision(), 'none');
  assert.equal(tabDeleteDecision(), 'none');
});

test('a till: a row that left its list by an action here is deleted by number', () => {
  assert.equal(queueDeleteDecision({ role: 'till', present: false }), 'delete');
  assert.equal(queueDeleteDecision({ role: 'till', present: false, doneAtBoot: true }), 'delete');
  assert.equal(tabDeleteDecision({ role: 'till' }), 'delete');
});

test('a till: staff marked it collected HERE in this session, deleted by number', () => {
  assert.equal(queueDeleteDecision({ role: 'till', present: true, done: true, pending: true }), 'delete');
});

test('a till: the SERVER said collected (another device did it), cleared only while it still says so', () => {
  assert.equal(queueDeleteDecision({ role: 'till', present: true, done: true, pending: false }), 'delete_if_done');
});

test('a till: a row already finished when the app started is never deleted by number', () => {
  assert.equal(queueDeleteDecision({ role: 'till', present: true, done: true, pending: false, doneAtBoot: true }), 'delete_if_done');
  assert.equal(queueDeleteDecision({ role: 'till', present: true, done: true, pending: true, doneAtBoot: true }), 'delete_if_done');
});

test('a till: a row still held and not finished is not deleted (a training order is never published or removed)', () => {
  assert.equal(queueDeleteDecision({ role: 'till', present: true, done: false, pending: true }), 'none');
  assert.equal(queueDeleteDecision({ role: 'till', present: true, done: false, pending: false }), 'none');
});

test('buffered writes: a page that is not a till drops what the list sync made, keeps named actions', () => {
  const syncDelete = { type: 'delete', table: 'order_queue', match: { location_id: 'L1', ref: 'R1' } };
  const syncTabDelete = { type: 'delete', table: 'bar_tabs', match: { id: 'tab-1' } };
  const syncUpsert = { type: 'upsert', table: 'order_queue', payload: { ref: 'R1' }, onConflict: 'location_id,ref' };
  const named = { type: 'delete', table: 'order_queue', match: { location_id: 'L1', ref: 'R1' }, kind: 'queue_delete' };
  const ticket = { type: 'update', table: 'kds_tickets', payload: { status: 'bumped' }, match: { id: 'kt-1' } };
  const sale = { type: 'upsert', table: 'closed_checks', payload: { id: 'c1' } };
  for (const role of ['reader', 'office']) {
    assert.equal(dropBufferedQueueWrite({ role, item: syncDelete }), true, role);
    assert.equal(dropBufferedQueueWrite({ role, item: syncTabDelete }), true, role);
    assert.equal(dropBufferedQueueWrite({ role, item: syncUpsert }), true, role);
    assert.equal(dropBufferedQueueWrite({ role, item: named }), false, `${role}: a named staff action is kept`);
    assert.equal(dropBufferedQueueWrite({ role, item: ticket }), false, `${role}: kitchen tickets are not this rule's`);
    assert.equal(dropBufferedQueueWrite({ role, item: sale }), false, `${role}: a sale is never dropped`);
    assert.equal(dropBufferedQueueWrite({ role, item: null }), false);
  }
  for (const item of [syncDelete, syncTabDelete, syncUpsert, named, ticket, sale]) {
    assert.equal(dropBufferedQueueWrite({ role: 'till', item }), false, 'a till keeps every buffered write');
  }
  assert.equal(dropBufferedQueueWrite(), false);
});

test('the rule is pure: no imports, no storage, no network', () => {
  const src = read('./queueDeleteRule.js');
  assert.ok(!/^\s*import\s/m.test(src), 'no imports');
  assert.ok(!/localStorage|sessionStorage|window\.|document\.|fetch\(|supabase/.test(src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no browser or network in the code');
});

// ── Source pins: every caller is held to the rule ────────────────────────────────────────────

test('QueueSync asks the rule before any write, and the old kitchen fence is gone', () => {
  const qs = read('../sync/QueueSync.js');
  assert.ok(qs.includes("import { maySyncQueue, queueDeleteDecision, tabDeleteDecision } from '../lib/queueDeleteRule';"));
  assert.ok(qs.includes("import { readQueueRole } from '../lib/queueDevice';"));
  const flush = qs.slice(qs.indexOf('export async function flushQueues()'), qs.indexOf('export function scheduleQueueFlush('));
  const gate = flush.indexOf('if (!maySyncQueue(role)) return;');
  assert.ok(gate > 0, 'the flush returns on a page that is not a till');
  assert.ok(flush.indexOf('const role = readQueueRole(useStore.getState().deviceConfig);') < gate);
  for (const write of ['queueWrite(', '.upsert(', '.update(', '.delete()']) {
    assert.ok(flush.indexOf(write) > gate, `${write} comes after the gate`);
  }
  // The v5.9.72 fence emptied `tabs` on a kitchen screen, which made the delete loop read every
  // tab as removed here. It must never come back in that form.
  assert.ok(!/getDeviceMode\(\) === 'kds' \? \[\]/.test(qs), 'the list is never emptied to stop a publish');
  assert.ok(flush.includes('const tabs = state.tabs || [];'));
  assert.ok(!qs.includes('getDeviceMode'), 'the device is judged by the rule, not by the mode word alone');
});

test('QueueSync deletes an order only with the rule\'s reason', () => {
  const qs = read('../sync/QueueSync.js');
  const flush = qs.slice(qs.indexOf('export async function flushQueues()'), qs.indexOf('export function scheduleQueueFlush('));
  assert.ok(flush.includes('const decision = queueDeleteDecision({'));
  assert.ok(flush.includes("role, present: !!held, done: held?.status === 'collected',"));
  assert.ok(flush.includes('pending: !!held && isPendingLocal(held, queueHash), doneAtBoot: _bootDoneQ.has(String(ref)),'));
  assert.ok(flush.includes("if (decision === 'none') continue;"));
  // Every delete of the flush sits after the decision.
  const decided = flush.indexOf('const decision = queueDeleteDecision({');
  assert.equal((flush.match(/queueWrite\(\{ type: 'delete', table: 'order_queue'/g) || []).length, 2, 'two shapes: by number, and only if collected');
  assert.ok(flush.indexOf("queueWrite({ type: 'delete', table: 'order_queue'") > decided);
  assert.ok(flush.includes("queueWrite({ type: 'delete', table: 'order_queue', match: { location_id: _locationId, ref, status: 'collected' } });"), 'the durable copy carries the condition');
  assert.ok(flush.includes(".delete().eq('location_id', _locationId).eq('status', 'collected').in('ref', queueFinished)"), 'and so does the live write');
  assert.equal((flush.match(/\.from\('order_queue'\)\.delete\(\)/g) || []).length, 2, 'no third delete of order_queue in the flush');
  assert.ok(flush.includes("if (tabDeleteDecision({ role }) === 'none') continue;"), 'bar tabs ask the rule too');
  assert.ok(flush.indexOf("if (tabDeleteDecision({ role }) === 'none') continue;") < flush.indexOf("queueWrite({ type: 'delete', table: 'bar_tabs', match: { id } });"));
});

test('QueueSync: a row the server removed is marked dropped before the store change, never deleted again', () => {
  const qs = read('../sync/QueueSync.js');
  const orders = qs.slice(qs.indexOf('export function applyQueueRealtimeEvent('), qs.indexOf('export function applyTabRealtimeEvent('));
  const tabs = qs.slice(qs.indexOf('export function applyTabRealtimeEvent('), qs.indexOf('export function teardownQueueSync('));
  // A delete heard from the server.
  const heard = orders.indexOf("if (next.length !== queue.length || _lastSentQueue[ref] !== undefined) markQueueDropped(ref);");
  assert.ok(heard > 0);
  assert.ok(heard < orders.indexOf('if (next.length !== queue.length) useStore.setState({ orderQueue: next });'), 'marked before the store change wakes the flush');
  // A catering order moved to a later day: evicted from this list, alive on the server.
  assert.ok(orders.includes('if (next.length !== queue.length) { markQueueDropped(row.ref); useStore.setState({ orderQueue: next }); }'));
  assert.equal((orders.match(/useStore\.setState\(\{ orderQueue: next \}\)/g) || []).length, 2, 'the two removals in this handler, both marked');
  const heardTab = tabs.indexOf("if (next.length !== tabs.length || _lastSentTab[id] !== undefined) markTabDropped(id);");
  assert.ok(heardTab > 0 && heardTab < tabs.indexOf('if (next.length !== tabs.length) useStore.setState({ tabs: next });'));
  // markDropped is what stops the flush: it latches 'cleared'.
  assert.ok(qs.includes("export function markQueueDropped(ref) { _lastSentQueue[ref] = 'cleared'; _finishedQueue.set(String(ref), { finishedAt: Date.now() }); }"));
  assert.ok(qs.includes("export function markTabDropped(id) { _lastSentTab[id] = 'cleared'; _finishedTab.set(String(id), { finishedAt: Date.now() }); }"));
});

test('QueueSync remembers which saved orders were already finished at boot', () => {
  const qs = read('../sync/QueueSync.js');
  assert.ok(qs.includes('const _bootDoneQ = new Set();'));
  const cap = qs.slice(qs.indexOf('export function captureQueueBoot()'), qs.indexOf('export async function finishedRefsOnServer('));
  assert.ok(cap.includes("if (o?.ref && o.status === 'collected') _bootDoneQ.add(String(o.ref));"));
  assert.ok(qs.includes('_bootDoneQ.delete(String(o.ref));'), 'a number that is open again is no longer the row finished at boot');
});

test('the store removes an order from the database only on a till or in Back Office', () => {
  const st = read('../store/index.js');
  assert.ok(st.includes("import { mayRemoveQueueRow } from '../lib/queueDeleteRule';"));
  assert.ok(st.includes("import { readQueueRole } from '../lib/queueDevice';"));
  const fn = st.slice(st.indexOf('removeFromQueue: ref => {'), st.indexOf('// ── 86 ──'));
  const gate = fn.indexOf('if (!mayRemoveQueueRow(readQueueRole(get().deviceConfig))) return;');
  assert.ok(gate > 0);
  assert.ok(gate < fn.indexOf("mustChangeRow({ table: 'order_queue', type: 'delete'"), 'the gate comes before the delete');
  // The only order_queue delete in the store is that one.
  assert.equal((st.match(/table: 'order_queue', type: 'delete'/g) || []).length, 1);
  assert.ok(!/\.from\((['"])order_queue\1\)\s*\.delete\(/.test(st), 'no raw delete of order_queue in the store');
});

test('the offline replay drops a kitchen tablet\'s old list writes, and the reconciler wires that guard', () => {
  const oq = read('../sync/OfflineQueue.js');
  const drop = oq.indexOf('if (_guard?.drop && isStateWrite(it)) {');
  assert.ok(drop > 0);
  assert.ok(drop < oq.indexOf('if (_guard && !reconciled && isStateWrite(it)) continue;'), 'dropped whether or not the reconcile pass completed');
  assert.ok(oq.includes('try { drop = _guard.drop(it) === true; } catch { drop = false; }'), 'a guard that throws drops nothing');
  const rec = read('../sync/QueueReconciler.js');
  assert.ok(rec.includes('setReplayGuard({ before: beforeReplay, keep: keepBufferedWrite, drop: dropBufferedWrite });'));
  assert.ok(rec.includes('return dropBufferedQueueWrite({ role: readQueueRole(useStore.getState().deviceConfig), item });'));
});

test('the thin reader gathers the page\'s mode, paired type and profile, nothing else', () => {
  const qd = read('./queueDevice.js');
  assert.ok(qd.includes("JSON.parse(localStorage.getItem('rpos-device') || 'null')?.type"));
  assert.ok(qd.includes('mode: getDeviceMode(),'));
  assert.ok(qd.includes('defaultSurface: deviceConfig?.defaultSurface,') && qd.includes('profileName: deviceConfig?.profileName,'));
});

test('the kitchen profile test is the one App.jsx uses to show the kitchen screen', () => {
  const app = read('../App.jsx');
  assert.ok(app.includes("const isKdsDevice = pairedDeviceType === 'kds'"), 'a paired Kitchen Display');
  assert.ok(app.includes("|| (deviceConfig?.defaultSurface === 'kds'"), 'or a kitchen profile');
  for (const word of ['counter', 'bar', 'server']) {
    assert.ok(app.includes(`&& !deviceConfig?.profileName?.toLowerCase().includes('${word}')`), `App.jsx still excludes ${word} profiles`);
  }
  assert.ok(app.includes("} else if (surface === 'kiosk' || deviceConfig?.defaultSurface === 'kiosk') {"), 'a kiosk profile shows the kiosk, never the till');
});

test('no kitchen, kiosk or order screen surface deletes an order by hand', () => {
  for (const file of ['../surfaces/kds/KDSSurface.jsx', '../surfaces/KioskApp.jsx', '../surfaces/orderScreen/OrderStatusScreen.jsx']) {
    const src = read(file);
    assert.ok(!/\.from\((['"])order_queue\1\)\s*\.delete\(/.test(src), `${file}: no raw delete`);
    assert.ok(!/table: 'order_queue',\s*type: 'delete'/.test(src), `${file}: no counted delete`);
    assert.ok(!src.includes('removeFromQueue'), `${file}: never removes an order`);
  }
});
