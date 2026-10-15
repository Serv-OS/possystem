// Which pages are a KITCHEN SCREEN for the table fence (lib/queueDeleteRule.js showsKitchenScreen,
// 12 Oct 2026). The rule on its own, then source pins that hold every caller to it. The same rule
// run end to end through the real sync code is sync/sessionKitchenFence.test.js.
//
// v5.9.72 (Leeds, 26 Sep 2026) stopped a kitchen screen publishing tables, but tested the page's
// mode word (kds). A tablet paired as a Kitchen Display inside a till mode page was missed, and a
// till inside the kitchen app was stopped by mistake.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  showsKitchenScreen, queueDeviceRole, QUEUE_READER_MODES, QUEUE_OFFICE_MODES,
} from './queueDeleteRule.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

// ── The rule ─────────────────────────────────────────────────────────────────────────────────

test('a kitchen screen is a kitchen screen in every shape it takes in the field', () => {
  // The ServOS KDS app opens ?mode=kds. This was the only shape the old test stopped.
  assert.equal(showsKitchenScreen({ mode: 'kds' }), true);
  assert.equal(showsKitchenScreen({ mode: 'kds', deviceType: 'kds', defaultSurface: 'kds', profileName: 'Kitchen Display' }), true);
  assert.equal(showsKitchenScreen({ mode: 'KDS' }), true, 'the mode word is not case sensitive');
  // Paired as a Kitchen Display (devices.type kds) in a till mode page: missed until now.
  assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'kds' }), true);
  assert.equal(showsKitchenScreen({ mode: '', deviceType: 'kds', defaultSurface: 'kds', profileName: 'Kitchen Display' }), true);
  assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'KDS', defaultSurface: 'tables', profileName: 'Main counter' }), true, 'the pairing type wins: App.jsx shows the kitchen screen');
  // A POS pairing on a profile that boots straight to the kitchen screen: missed until now.
  assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'pos', defaultSurface: 'kds', profileName: 'Drinks screen' }), true);
  assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'pos', defaultSurface: 'kds' }), true);
  // The kitchen app on a POS pairing with a kitchen profile.
  assert.equal(showsKitchenScreen({ mode: 'kds', deviceType: 'pos', defaultSurface: 'kds', profileName: 'Kitchen pass' }), true);
});

test('a page that SHOWS a till is never a kitchen screen, even inside the kitchen app', () => {
  // The kitchen app paired with a till's code on a till profile: App.jsx shows the PIN pad and the
  // till. The old mode word test stopped its tables reaching the other tills.
  assert.equal(showsKitchenScreen({ mode: 'kds', deviceType: 'pos', defaultSurface: 'tables', profileName: 'Main counter' }), false);
  assert.equal(showsKitchenScreen({ mode: 'kds', deviceType: 'pos', defaultSurface: 'pos', profileName: 'Main counter' }), false);
  assert.equal(showsKitchenScreen({ mode: 'kds', deviceType: 'pos' }), false, 'a POS pairing whose profile has not loaded shows the PIN pad');
  assert.equal(showsKitchenScreen({ mode: 'kds', deviceType: 'handheld', defaultSurface: 'pos', profileName: 'Server handheld' }), false);
  // A counter, bar or server till that only OPENS on its kitchen view.
  for (const profileName of ['Main counter', 'Bar terminal', 'Server handheld', 'COUNTER 2']) {
    assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'pos', defaultSurface: 'kds', profileName }), false, profileName);
    assert.equal(showsKitchenScreen({ mode: 'kds', deviceType: 'pos', defaultSurface: 'kds', profileName }), false, profileName);
  }
  // Every ordinary till.
  for (const defaultSurface of ['tables', 'pos', 'bar', 'orders', 'mpos']) {
    assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'pos', defaultSurface, profileName: 'Kitchen till' }), false, defaultSurface);
  }
});

test('anything unknown is not a kitchen screen: a real till is never stopped from publishing a table', () => {
  assert.equal(showsKitchenScreen(), false);
  assert.equal(showsKitchenScreen({}), false);
  assert.equal(showsKitchenScreen({ mode: null, deviceType: undefined }), false);
  assert.equal(showsKitchenScreen({ mode: 'pos' }), false);
  assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'something-new' }), false);
  assert.equal(showsKitchenScreen({ mode: '', deviceType: 'pos', defaultSurface: null, profileName: null }), false);
});

test('a page App.jsx returns for before the till shell is never a kitchen screen, whatever a shared browser holds', () => {
  // One browser can hold a kitchen pairing in storage and open Back Office, the Bookings host
  // stand or the handset page in another tab. None of them shows the kitchen screen.
  const kitchenStorage = { deviceType: 'kds', defaultSurface: 'kds', profileName: 'Kitchen Display' };
  for (const mode of [...QUEUE_OFFICE_MODES, ...QUEUE_READER_MODES, 'mpos']) {
    assert.equal(showsKitchenScreen({ mode, ...kitchenStorage }), false, mode);
    assert.equal(showsKitchenScreen({ mode }), false, mode);
  }
  // The Bookings host stand is named here because it SEATS tables: stopping it would lose them.
  assert.ok(QUEUE_READER_MODES.includes('bookings'));
  assert.equal(showsKitchenScreen({ mode: 'bookings', ...kitchenStorage }), false);
});

test('a kiosk profile is not a kitchen screen (a reader of the orders list, left alone for tables)', () => {
  const kiosk = { mode: 'pos', deviceType: 'pos', defaultSurface: 'kiosk', profileName: 'Kiosk' };
  assert.equal(queueDeviceRole(kiosk), 'reader');
  assert.equal(showsKitchenScreen(kiosk), false);
  assert.equal(showsKitchenScreen({ mode: 'pos', deviceType: 'kiosk', defaultSurface: 'kiosk', profileName: 'Kiosk' }), false);
});

test('the kitchen screen rule and the orders list rule never disagree', () => {
  // Every mix of mode, pairing type, default surface and profile name. A kitchen screen is always
  // a reader of the orders list; a till or Back Office is never a kitchen screen; and inside the
  // till shell the only reader that is not a kitchen screen is a kiosk profile.
  const modes = [undefined, '', 'pos', 'kds', 'KDS', 'mpos', 'bar', ...QUEUE_OFFICE_MODES, ...QUEUE_READER_MODES];
  const types = [undefined, null, 'pos', 'kds', 'kiosk', 'handheld', 'clock', 'admin'];
  const surfaces = [undefined, 'tables', 'pos', 'bar', 'kds', 'kiosk', 'mpos'];
  const names = [undefined, 'Kitchen Display', 'Drinks screen', 'Main counter', 'Bar terminal', 'Server handheld', 'Kiosk'];
  const early = new Set([...QUEUE_OFFICE_MODES, ...QUEUE_READER_MODES, 'mpos']);
  let kitchens = 0;
  for (const mode of modes) for (const deviceType of types) for (const defaultSurface of surfaces) for (const profileName of names) {
    const p = { mode, deviceType, defaultSurface, profileName };
    const role = queueDeviceRole(p);
    const kitchen = showsKitchenScreen(p);
    const at = JSON.stringify(p);
    if (kitchen) { kitchens += 1; assert.equal(role, 'reader', at); }
    if (role !== 'reader') assert.equal(kitchen, false, at);
    if (early.has(String(mode || '').toLowerCase())) assert.equal(kitchen, false, at);
    else if (role === 'reader' && !kitchen) assert.equal(defaultSurface, 'kiosk', at);
  }
  assert.ok(kitchens > 50, 'the grid does reach kitchen screens');
});

// ── Source pins: every caller is held to the rule ────────────────────────────────────────────

const GATE = 'if (readShowsKitchenScreen(useStore.getState().deviceConfig)) return;';

test('SessionSync: no table is published or put back from a kitchen screen, by the rule not the mode word', () => {
  const ss = read('../sync/SessionSync.js');
  assert.ok(ss.includes("import { readShowsKitchenScreen } from '../lib/queueDevice';"));
  assert.ok(!ss.includes('getDeviceMode'), 'the page is judged by the rule, not by the mode word alone');

  const flush = ss.slice(ss.indexOf('export async function flushSessions()'), ss.indexOf('export function scheduleFlush()'));
  const gate = flush.indexOf(GATE);
  assert.ok(gate > 0, 'the flush returns on a kitchen screen');
  for (const step of ['getLocationId()', 'queueWrite(', '.upsert(', 'mustChangeRows(', "localStorage.setItem('rpos-session-backup'"]) {
    assert.ok(flush.indexOf(step) > gate, `${step} comes after the gate`);
  }

  const reassert = ss.slice(ss.indexOf('export function reassertSession(tableId)'), ss.indexOf('export async function flushSingleSession('));
  const rGate = reassert.indexOf(GATE);
  assert.ok(rGate > 0, 'the put back returns on a kitchen screen');
  assert.ok(rGate < reassert.indexOf('delete _lastSent[tableId];'), 'before the latch is dropped');
  assert.ok(rGate < reassert.indexOf('scheduleFlush();'), 'and before a flush is asked for');
  assert.ok(rGate < reassert.indexOf('useStore.setState('), 'and before its own floor is touched');
});

test('SessionSync: the named seat and move writes are not fenced (the host stands seat through them)', () => {
  const ss = read('../sync/SessionSync.js');
  assert.equal(ss.split(GATE).length - 1, 2, 'two gates: the flush and the put back, no more');
  const single = ss.slice(ss.indexOf('export async function flushSingleSession('), ss.indexOf('export async function persistTransfer('));
  const move = ss.slice(ss.indexOf('export async function persistTransfer('), ss.indexOf('export async function loadSessions()'));
  assert.ok(!single.includes('readShowsKitchenScreen') && !move.includes('readShowsKitchenScreen'));
});

test('SessionReconciler asks on every pass, before it reads or writes anything', () => {
  const rc = read('../sync/SessionReconciler.js');
  assert.ok(rc.includes("import { readShowsKitchenScreen } from '../lib/queueDevice';"));
  const pass = rc.slice(rc.indexOf('const reconcile = async () => {'), rc.indexOf('// First reconcile immediately'));
  const gate = pass.indexOf(GATE);
  assert.ok(gate > 0);
  for (const step of [".from('active_sessions')", 'mustChangeRows(', 'reassertSession(', 'useStore.setState(']) {
    assert.ok(pass.indexOf(step) > gate, `${step} comes after the gate`);
  }
  // It is inside the pass, so it is asked every 10 seconds, not once when the reconciler starts.
  assert.ok(rc.indexOf(GATE) > rc.indexOf('const reconcile = async () => {'));
  assert.equal(rc.split(GATE).length - 1, 1);
});

test('SyncBridge starts the reconciler on every page: the mode word test is gone', () => {
  const sb = read('../sync/SyncBridge.jsx');
  assert.ok(sb.includes('    if (!isMock) startSessionReconciler();'));
  assert.ok(!/getDeviceMode\(\) !== 'kds'/.test(sb));
  assert.ok(!sb.includes('getDeviceMode'), 'no unused import left behind');
});

test('the thin reader asks both rules about the same page', () => {
  const qd = read('./queueDevice.js');
  assert.ok(qd.includes("import { queueDeviceRole, showsKitchenScreen } from './queueDeleteRule';"));
  assert.ok(qd.includes('return queueDeviceRole(readPage(deviceConfig));'));
  assert.ok(qd.includes('return showsKitchenScreen(readPage(deviceConfig));'));
  assert.equal(qd.split("localStorage.getItem('rpos-device')").length - 1, 1, 'one place reads the pairing');
});

test('why only kitchen screens: the kitchen surface never touches a table, the host stand seats them', () => {
  // Safe to stop: the kitchen surface holds tickets, never tables.
  for (const file of ['../surfaces/kds/KDSSurface.jsx', '../surfaces/kds/KdsTicketCard.jsx', '../surfaces/kds/KdsSettingsSheet.jsx']) {
    const src = read(file);
    for (const word of ['seatTable', 'clearTable', 'transferTable', 'flushSessions', 'flushSingleSession', 's.tables']) {
      assert.ok(!src.includes(word), `${file}: no ${word}`);
    }
  }
  // Not safe to stop: the Bookings host stand runs under SyncBridge and seats tables in the store,
  // so the table flush is part of how its seats reach the tills (and where the bill is stamped).
  const app = read('../App.jsx');
  assert.ok(app.includes("if (deviceMode === 'bookings') return <><KioskAutoUpdate /><SyncBridge onSyncPulse={handleSyncPulse}/><BookingsSurface /></>;"));
  const bs = read('../store/bookingsSlice.js');
  assert.ok(bs.includes('get().seatTable?.(b.primaryTableId,') && bs.includes('get().seatTableWithItems?.(b.primaryTableId,'));
  assert.ok(read('../surfaces/bookings/BookingsSurface.jsx').includes('startSessionReconciler();'), 'and it runs the reconciler that heals a seat');
});

test('the rule file stays pure with the new function in it', () => {
  const src = read('./queueDeleteRule.js');
  assert.ok(src.includes('export function showsKitchenScreen({ mode, deviceType, defaultSurface, profileName } = {}) {'));
  assert.ok(!/^import /m.test(src), 'no imports');
  assert.ok(!/localStorage|window\.|document\.|fetch\(/.test(src), 'no storage, no browser, no network');
});
