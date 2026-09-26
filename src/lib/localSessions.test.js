// v5.9.71 VENUE FENCE for table sessions (lib/localSessions.js). Peter, 26 Sep 2026: Provo's demo
// orders were published under Coffee Boy Leeds by a browser following the Back Office venue
// switch. "We cannot have data leak."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BACKUP_KEY, SNAPSHOT_KEY, LOC_KEY, tagSession, sessionVenueOk, keepVenueSessions,
  readLocalSessions, stampLocalSessionsFor, clearLocalSessions, localSessionsOwner,
} from './localSessions.js';

const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
};
const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';
const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const demo = (id) => ({ id, items: [{ name: 'Latte' }], seatedAt: 1786124809674, server: 'Alex Carter' });

test('a session is tagged once with its venue and never re-tagged', () => {
  const s = tagSession(demo('ORD-1'), PROVO);
  assert.equal(s._loc, PROVO);
  assert.equal(tagSession(s, LEEDS)._loc, PROVO, 'a tag is never overwritten');
  assert.equal(tagSession(null, LEEDS), null);
  assert.equal(tagSession(demo('x'), '')._loc, undefined);
});

test('a tagged session is fine at its own venue only; an untagged one is judged by its table', () => {
  assert.equal(sessionVenueOk(tagSession(demo('a'), PROVO), PROVO), true);
  assert.equal(sessionVenueOk(tagSession(demo('a'), PROVO), LEEDS), false);
  assert.equal(sessionVenueOk(demo('a'), LEEDS), true, 'untagged (pre release) passes the venue check');
  assert.equal(sessionVenueOk(null, LEEDS), false);
  const r = keepVenueSessions({ t1: tagSession(demo('a'), PROVO), t2: demo('b'), t3: tagSession(demo('c'), LEEDS) }, LEEDS, new Set(['t3']));
  assert.deepEqual(Object.keys(r.kept), ['t3']);
  assert.equal(r.dropped, 2, 'Provo tag dropped; untagged t2 not on this plan dropped');
});

test("Provo's stores at Leeds: owner says Provo, so nothing is restored and the stores are cleared", () => {
  const store = fakeStore({
    [LOC_KEY]: PROVO,
    [BACKUP_KEY]: JSON.stringify({ 't-1776905960241': demo('ORD-1003') }),
    [SNAPSHOT_KEY]: JSON.stringify({ v: '4.5.2', ts: 1, sessions: { 't-1776905987058': demo('ORD-1004') } }),
  });
  const r = readLocalSessions(LEEDS, { knownTableIds: new Set(['t-1776905960241']), store });
  assert.equal(r.foreign, true);
  assert.equal(r.owner, PROVO);
  assert.deepEqual(r.backup, {});
  assert.deepEqual(r.snapshot, {});
  assert.equal(store.getItem(BACKUP_KEY), null, 'cleared');
  assert.equal(store.getItem(SNAPSHOT_KEY), null, 'cleared');
  assert.equal(localSessionsOwner(store), null);
});

test('a store from before the release (no owner) is trusted only for tables on THIS plan', () => {
  const store = fakeStore({
    [BACKUP_KEY]: JSON.stringify({ 't-1776905960241': demo('ORD-1003'), 'leeds-t7': demo('ORD-9') }),
    [SNAPSHOT_KEY]: JSON.stringify({ v: '4.5.2', ts: 1, sessions: { 'leeds-t8': demo('ORD-10'), 't1': demo('ORD-2') } }),
  });
  const r = readLocalSessions(LEEDS, { knownTableIds: new Set(['leeds-t7', 'leeds-t8']), store });
  assert.equal(r.foreign, false);
  assert.deepEqual(Object.keys(r.backup), ['leeds-t7']);
  assert.deepEqual(Object.keys(r.snapshot), ['leeds-t8']);
  assert.equal(r.dropped, 2);
  // the plan unknown (floor read failed): nothing untagged is trusted
  const none = readLocalSessions(LEEDS, { knownTableIds: null, store });
  assert.deepEqual(none.backup, {});
  assert.deepEqual(none.snapshot, {});
});

test("the venue's own stores come back only for tables on its plan (v5.9.72), minus anything tagged elsewhere", () => {
  const store = fakeStore({
    [LOC_KEY]: LEEDS,
    [BACKUP_KEY]: JSON.stringify({ 'leeds-t7': demo('ORD-9'), 'x': tagSession(demo('ORD-1003'), PROVO), 't-1783614852190': tagSession(demo('ORD-1003'), LEEDS) }),
  });
  const r = readLocalSessions(LEEDS, { knownTableIds: new Set(['leeds-t7']), store });
  assert.deepEqual(Object.keys(r.backup), ['leeds-t7']);
  assert.equal(r.dropped, 2, 'the Provo tag and the Leeds-tagged ghost on a table Leeds does not have are both dropped');
  // a venue with NO tables (Leeds that morning) rescues nothing from its local store
  assert.deepEqual(readLocalSessions(LEEDS, { knownTableIds: new Set(), store: fakeStore({ [LOC_KEY]: LEEDS, [BACKUP_KEY]: JSON.stringify({ 't1': demo('QR') }) }) }).backup, {});
  // the plan unknown (floor read failed) with a matching owner: kept, so an offline till never loses a real order
  const off = readLocalSessions(LEEDS, { knownTableIds: null, store: fakeStore({ [LOC_KEY]: LEEDS, [BACKUP_KEY]: JSON.stringify({ 'leeds-t7': demo('ORD-9') }) }) });
  assert.deepEqual(Object.keys(off.backup), ['leeds-t7']);
});

test('writers stamp the owner; clearing removes all three keys; no store or venue is harmless', () => {
  const store = fakeStore();
  stampLocalSessionsFor(LEEDS, store);
  assert.equal(localSessionsOwner(store), LEEDS);
  stampLocalSessionsFor('', store);
  assert.equal(localSessionsOwner(store), LEEDS);
  store.setItem(BACKUP_KEY, '{}'); store.setItem(SNAPSHOT_KEY, '{}');
  clearLocalSessions(store);
  assert.deepEqual(store.keys(), []);
  assert.deepEqual(readLocalSessions(LEEDS, { store: null }), { backup: {}, snapshot: {}, foreign: false, owner: null, dropped: 0 });
  assert.equal(readLocalSessions('', { store }).foreign, false);
});

test('pins: every reader and writer of the local stores goes through the fence; the till publishes for its boot venue only', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const sb = read('../sync/SyncBridge.jsx');
  assert.match(sb, /useStore\.setState\(\{ bootLocationId: locationId \}\)/, 'the boot venue is latched');
  assert.match(sb, /readLocalSessions\(locationId, \{ knownTableIds: known \}\)/, 'boot reads the local stores through the fence');
  assert.match(sb, /bootSessions\[row\.table_id\] = tagSession\(row\.session, locationId\)/, "this venue's rows are tagged");
  assert.doesNotMatch(sb, /JSON\.parse\(localStorage\.getItem\('rpos-session-backup'\)/, 'no raw read of the backup at boot');
  assert.doesNotMatch(sb, /JSON\.parse\(localStorage\.getItem\('rpos-session-snapshot'\)/, 'no raw read of the snapshot at boot');
  assert.match(sb, /stampLocalSessionsFor\(state\.bootLocationId\)/, 'the snapshot writer stamps the owner');
  const ss = read('../sync/SessionSync.js');
  assert.match(ss, /if \(bootLoc && _locationId !== bootLoc\) \{/, 'publishing for another venue is refused');
  assert.match(ss, /if \(!sessionVenueOk\(t\.session, _locationId\)\) \{/, 'a session tagged elsewhere is never published');
  assert.match(ss, /stampLocalSessionsFor\(_locationId\)/);
  assert.match(read('../sync/SessionReconciler.js'), /stampLocalSessionsFor\(_locationId\)/);
  assert.match(read('../sync/MasterSync.js'), /stampLocalSessionsFor\(locationId\)/);
  const wl = read('../store/waitlistSlice.js');
  assert.match(wl, /readLocalSessions\(locId, \{ knownTableIds: new Set\(floor\.map\(\(t\) => t\.id\)\) \}\)/);
  assert.doesNotMatch(wl, /localStorage\.getItem\('rpos-session-backup'\)/);
  const store = read('../store/index.js');
  assert.ok((store.match(/_loc: ?venueTag\(\)/g) || []).length >= 6, 'every place a table session is created tags it');
  assert.match(store, /bootLocationId: null,/);
  const mig = read('../../supabase/migrations/20260926a_OPS_active_sessions_venue_fence.sql');
  assert.match(mig, /create trigger active_sessions_venue_fence/);
  assert.match(mig, /is distinct from new\.location_id::text/);
});
