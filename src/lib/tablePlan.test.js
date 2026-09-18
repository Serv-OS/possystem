// Table plan edits stick (lib/tablePlan.js). Peter, 18 Sep 2026: "found a bug on table plans:
// if you rename, delete them etc, on refresh they come back and names go back."
//
// The rule: a table's DEFINITION has one owner (the saved plan) and the newer explicit edit wins
// everywhere, including a delete; a table's SESSION is never lost; absence alone never removes a
// table. Every scenario in memory feedback_tables_never_lost is pinned here, plus the new ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  mergeDefinitions, applyPlanRead, applyTombstones, pruneClosedRemoved, isTombstoned,
  mergeTombstones, tombstonesFromRows, normaliseFloorRow, deleteRefusalReason,
  loadPlanState, savePlanState, recordTombstone, forgetTombstone, TOMBSTONE_TTL_MS,
} from './tablePlan.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// A fake localStorage, so the persistence helpers run under node.
function withStorage(fn) {
  const mem = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  try { return fn(mem); } finally { if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev; }
}

const T0 = Math.floor(Date.now() / 1000) * 1000;   // near now: tombstones older than 90 days are pruned
const MIN = 60_000;
const row = (id, label, extra = {}) => ({ id, label, x: 10, y: 20, w: 80, h: 80, shape: 'rect', maxCovers: 4, section: 'main', ...extra });
const sess = (items = 2, extra = {}) => ({ id: 's-' + items, seatedAt: T0 - 5 * MIN, items: Array.from({ length: items }, (_, i) => ({ uid: 'i' + i })), ...extra });
const labels = (ts) => Object.fromEntries(ts.map(t => [t.id, t.label]));
const ids = (ts) => ts.map(t => t.id).sort();

// The latest config push in the database is usually OLDER than the plan: a rename or delete in
// Back Office writes floor_tables straight away and is often never pushed. That push is applied
// at every till boot (cache, then fetch) and again from the "update available" banner.
const stalePush = { version: T0 - 60 * MIN, tables: [row('t1', 'T1'), row('t4', 'T4'), row('t5', 'T5')] };
const snapMerge = (local, snap, state = {}) => mergeDefinitions({
  local, incoming: snap.tables, tombstones: mergeTombstones(state.tombstones, snap.tableTombstones),
  plan: state.plan || null, fallbackAt: snap.version, tie: 'incoming',
}).tables;

// ── Rename ──────────────────────────────────────────────────────────────────────────────────

test('rename then refresh keeps the new name (stale push applied before AND after the plan read)', () => {
  // Boot: cached push first, into an empty store.
  let tables = snapMerge([], stalePush);
  assert.equal(labels(tables).t4, 'T4');
  // The plan read: T4 was renamed to "Window" in Back Office after that push.
  const readAt = T0;
  const r = applyPlanRead({ local: tables, rows: [row('t1', 'T1'), row('t4', 'Window'), row('t5', 'T5')].map(x => normaliseFloorRow(x, { readAt })), readAt });
  tables = r.tables;
  assert.equal(labels(tables).t4, 'Window');
  // The banner (or useSupabaseInit, or a realtime push of the SAME old snapshot) applies it again.
  tables = snapMerge(tables, stalePush, { plan: r.plan });
  assert.equal(labels(tables).t4, 'Window', 'an older push can never put the old name back');
});

test('the OLD code path is what reverted the name (pinned so it is never restored)', () => {
  const src = read('../store/index.js');
  const body = src.slice(src.indexOf('applyConfigUpdate: () => {'), src.indexOf('locationSections: [', src.indexOf('applyConfigUpdate: () => {')));
  assert.doesNotMatch(body, /label:st\.label/, 'applyConfigUpdate must not overwrite labels from the snapshot blindly');
  assert.match(body, /mergeDefinitions\(/);
  assert.match(body, /tableTombstones/);
});

test('a rename pushed from Back Office reaches a till that read the plan earlier', () => {
  const readAt = T0;
  const till = applyPlanRead({ local: [], rows: [row('t4', 'T4')].map(x => normaliseFloorRow(x, { readAt })), readAt }).tables;
  const push = { version: T0 + 10 * MIN, tables: [row('t4', 'Window', { defAt: T0 + 9 * MIN, editAt: T0 + 9 * MIN })] };
  assert.equal(labels(snapMerge(till, push)).t4, 'Window');
  // A legacy push (no defAt) that is newer than the read also wins, by its push time.
  const legacy = { version: T0 + 10 * MIN, tables: [row('t4', 'Door')] };
  assert.equal(labels(snapMerge(till, legacy)).t4, 'Door');
});

test('rename then refresh on EVERY device: each boot read wins over its cached push', () => {
  for (const device of ['sunmi', 'ipad', 'mpos']) {
    let t = snapMerge([], stalePush);
    t = applyPlanRead({ local: t, rows: [row('t4', 'Window')].map(x => normaliseFloorRow(x, { readAt: T0 })), readAt: T0 }).tables;
    assert.equal(labels(t).t4, 'Window', device);
  }
});

test('the field layout moves with the definition, the session stays', () => {
  const local = [{ ...row('t4', 'T4'), defAt: T0, session: sess(3), status: 'occupied', firedCourses: [1] }];
  const out = snapMerge(local, { version: T0 + MIN, tables: [row('t4', 'T4', { x: 300, section: 'patio', defAt: T0 + MIN })] });
  assert.equal(out[0].x, 300);
  assert.equal(out[0].section, 'patio');
  assert.equal(out[0].session, local[0].session, 'the session object is untouched');
  assert.deepEqual(out[0].firedCourses, [1]);
  assert.equal(out[0].status, 'occupied');
});

// ── Delete ──────────────────────────────────────────────────────────────────────────────────

test('delete then refresh keeps it deleted, even though the last push still has it', () => {
  let tables = snapMerge([], stalePush);                  // cached push: T5 is there
  const r = applyPlanRead({ local: tables, rows: [row('t1', 'T1'), row('t4', 'T4')].map(x => normaliseFloorRow(x, { readAt: T0 })), readAt: T0 });
  tables = r.tables;
  assert.deepEqual(ids(tables), ['t1', 't4']);
  // The old push again (banner / realtime / next boot's cache): T5 must not walk back in.
  tables = snapMerge(tables, stalePush, { plan: r.plan });
  assert.deepEqual(ids(tables), ['t1', 't4']);
});

test('delete reaches a device that was OFFLINE during it, through the tombstone in the next push', () => {
  // This till read the plan before the delete and never rebooted.
  const readAt = T0 - 30 * MIN;
  let till = applyPlanRead({ local: [], rows: stalePush.tables.map(x => normaliseFloorRow(x, { readAt })), readAt }).tables;
  assert.ok(ids(till).includes('t5'));
  const push = { version: T0 + MIN, tables: [row('t1', 'T1'), row('t4', 'T4')], tableTombstones: { t5: T0 } };
  till = snapMerge(till, push);
  assert.deepEqual(ids(till), ['t1', 't4']);
});

test('delete reaches a SECOND TAB: a stale tab broadcasting the deleted table cannot re-add it', () => {
  // Fresh tab (Back Office) has read the plan without T5 and holds the tombstone.
  const plan = { readAt: T0, ids: ['t1', 't4'] };
  const fresh = [row('t1', 'T1', { defAt: T0 }), row('t4', 'T4', { defAt: T0 })];
  // A POS tab that never heard of the delete broadcasts its whole tables array.
  const staleTab = stalePush.tables.map(t => ({ ...t, defAt: T0 - 60 * MIN }));
  const noTomb = mergeDefinitions({ local: fresh, incoming: staleTab, plan, tie: 'local' }).tables;
  assert.deepEqual(ids(noTomb), ['t1', 't4'], 'the plan read alone stops it');
  const withTomb = mergeDefinitions({ local: fresh, incoming: staleTab, tombstones: { t5: T0 - MIN }, tie: 'local' }).tables;
  assert.deepEqual(ids(withTomb), ['t1', 't4'], 'the tombstone alone stops it');
  // And the stale tab, receiving the fresh tab's state, drops T5 by the shared tombstone.
  const staleSide = mergeDefinitions({ local: staleTab, incoming: fresh, tombstones: { t5: T0 - MIN }, tie: 'local' }).tables;
  assert.deepEqual(ids(staleSide), ['t1', 't4']);
});

test('a stale tab cannot put an old NAME back into a fresh tab, and learns the new one', () => {
  const fresh = [row('t4', 'Window', { defAt: T0, editAt: T0 })];
  const stale = [row('t4', 'T4', { defAt: T0 - 60 * MIN })];
  assert.equal(mergeDefinitions({ local: fresh, incoming: stale, tie: 'local' }).tables[0].label, 'Window');
  assert.equal(mergeDefinitions({ local: stale, incoming: fresh, tie: 'local' }).tables[0].label, 'Window');
  // Two unstamped copies (both old code): the receiver keeps its own, as before.
  assert.equal(mergeDefinitions({ local: [row('t4', 'A')], incoming: [row('t4', 'B')], tie: 'local' }).tables[0].label, 'A');
});

test('a till whose clock runs AHEAD still honours a delete (tombstones compare edit times, not read times)', () => {
  const readAhead = T0 + 60 * MIN;                      // till clock is an hour fast
  const till = applyPlanRead({ local: [], rows: stalePush.tables.map(x => normaliseFloorRow(x, { readAt: readAhead })), readAt: readAhead }).tables;
  const out = snapMerge(till, { version: T0 + MIN, tables: [row('t1', 'T1')], tableTombstones: { t5: T0 } });
  assert.ok(!ids(out).includes('t5'));
});

// ── Sessions are never lost ─────────────────────────────────────────────────────────────────

test('page refresh mid order keeps the order (plan read keeps the live session)', () => {
  const local = [{ ...row('t4', 'T4'), session: sess(3), status: 'occupied' }];
  const r = applyPlanRead({ local, rows: [row('t4', 'T4')].map(x => normaliseFloorRow(x, { readAt: T0 })), readAt: T0 });
  assert.equal(r.tables[0].session, local[0].session);
});

test('Back Office pushes a new menu while a till has open sessions: every session and table survives', () => {
  const local = [
    { ...row('t1', 'T1'), defAt: T0, session: sess(4), status: 'occupied', firedCourses: [1, 2] },
    { ...row('t4', 'T4'), defAt: T0, session: null, status: 'available' },
  ];
  // A menu-only push (no tables at all), then an empty tables array, then a partial one.
  for (const incoming of [undefined, [], [row('t1', 'T1')]]) {
    const out = mergeDefinitions({ local, incoming, fallbackAt: T0 + MIN, tie: 'incoming' }).tables;
    assert.deepEqual(ids(out), ['t1', 't4'], 'absence in a push never removes a table');
    assert.equal(out.find(t => t.id === 't1').session, local[0].session);
    assert.deepEqual(out.find(t => t.id === 't1').firedCourses, [1, 2]);
  }
});

test('wake from sleep with the database unreachable keeps every table', () => {
  const local = [{ ...row('t1', 'T1'), session: sess(2) }, row('t4', 'T4')];
  assert.equal(applyPlanRead({ local, rows: null, readAt: T0 }), null, 'failed read: caller changes nothing');
  assert.equal(applyPlanRead({ local, rows: undefined, readAt: T0 }), null);
  const r = applyTombstones(local, {});
  assert.equal(r.tables, local, 'no tombstones: the same array, untouched');
  assert.equal(r.changed, false);
});

test('an empty or failed fetch never removes a table', () => {
  const local = [row('t1', 'T1'), row('t4', 'T4')];
  assert.equal(applyPlanRead({ local, rows: [], readAt: T0 }), null, 'empty read is not a plan');
  // The boot code only calls applyPlanRead on a non-empty read, and otherwise only tombstones.
  const sb = read('../sync/SyncBridge.jsx');
  assert.match(sb, /if \(floorRes\.data\?\.tables\?\.length\) \{[\s\S]*applyPlanRead\(/);
  assert.match(sb, /Failed or empty read: absence never removes a table\. Tombstones still do\.[\s\S]*applyTombstones\(cur, tombstones, isOpen\)/);
});

test('a table the plan read lacks is dropped only when no session lives on it', () => {
  const local = [{ ...row('t5', 'T5'), session: sess(2), status: 'occupied' }, row('t6', 'T6')];
  const r = applyPlanRead({ local, rows: [row('t1', 'T1')].map(x => normaliseFloorRow(x, { readAt: T0 })), readAt: T0 });
  assert.deepEqual(r.dropped, ['t6']);
  assert.deepEqual(r.keptOpen, ['t5']);
  assert.equal(r.tables.find(t => t.id === 't5').planRemoved, true);
  assert.equal(r.tables.find(t => t.id === 't5').session, local[0].session);
  // A session known only in the database (cold boot, the store has no session yet) counts too.
  const cold = applyPlanRead({ local: [row('t7', 'T7')], rows: [row('t1', 'T1')], readAt: T0, isOpen: (id) => id === 't7' });
  assert.deepEqual(cold.keptOpen, ['t7']);
});

test('a table Back Office added while the read was in flight is kept', () => {
  const local = [row('t9', 'T9', { defAt: T0 + 1000, editAt: T0 + 1000 })];
  const r = applyPlanRead({ local, rows: [row('t1', 'T1')], readAt: T0 });
  assert.deepEqual(ids(r.tables), ['t1', 't9']);
});

// ── A deleted table with an open order ──────────────────────────────────────────────────────

test('Back Office refuses to delete a table with an open order, in plain words', () => {
  assert.equal(deleteRefusalReason({ label: '4', session: sess(1) }), 'Table 4 has an open order, close or move it first');
  assert.equal(deleteRefusalReason({ label: 'T4' }, { dbSession: sess(1) }), 'T4 has an open order, close or move it first');
  assert.match(deleteRefusalReason({ label: 'T4' }, { checkFailed: true }), /Could not check T4 for an open order, so it was not deleted/);
  assert.equal(deleteRefusalReason({ label: 'T4' }), null);
});

test('a delete that slipped past (till took an order while it missed it) keeps the order reachable, then goes', () => {
  const local = [{ ...row('t5', 'T5'), session: sess(2), status: 'occupied' }, row('t1', 'T1')];
  let out = mergeDefinitions({ local, incoming: [row('t1', 'T1')], tombstones: { t5: T0 }, fallbackAt: T0 + MIN, tie: 'incoming' }).tables;
  const kept = out.find(t => t.id === 't5');
  assert.ok(kept, 'never silently vanishes with an order on it');
  assert.equal(kept.planRemoved, true);
  assert.equal(kept.session, local[0].session);
  // The order is paid: the table goes (reconciler prune, or the next merge).
  const paid = out.map(t => (t.id === 't5' ? { ...t, session: null, status: 'available' } : t));
  assert.deepEqual(ids(pruneClosedRemoved(paid)), ['t1']);
  out = mergeDefinitions({ local: paid, incoming: [row('t1', 'T1')], tombstones: { t5: T0 }, tie: 'incoming' }).tables;
  assert.deepEqual(ids(out), ['t1']);
  // pruneClosedRemoved returns the SAME array when there is nothing to prune (no store churn).
  assert.equal(pruneClosedRemoved(local), local);
});

test('FloorPlanBuilder checks for an open order (store AND database) BEFORE deleting, then records the tombstone', () => {
  const src = read('../backoffice/sections/FloorPlanBuilder.jsx');
  const body = src.slice(src.indexOf('const removeSelectedTable = async'), src.indexOf('const sectionColor ='));
  const check = body.indexOf("from('active_sessions')");
  const refuse = body.indexOf('deleteRefusalReason(');
  const del = body.indexOf("from('floor_tables').delete()");
  assert.ok(check > 0 && refuse > check && del > refuse, 'session check, refusal, then the delete');
  assert.match(body, /if \(reason\) \{ showToast\(reason, 'error'\); return; \}/);
  assert.ok(body.indexOf('recordTombstone(') > del);
  assert.ok(body.indexOf('insertTableTombstone(') > del);
});

// ── Two devices editing the plan at once ────────────────────────────────────────────────────

test('two Back Offices renaming the same table end the same on every till, in any order', () => {
  const base = [row('t4', 'T4', { defAt: T0 })];
  const a = { version: T0 + 2 * MIN, tables: [row('t4', 'Window', { defAt: T0 + MIN, editAt: T0 + MIN })] };
  const b = { version: T0 + 3 * MIN, tables: [row('t4', 'Door', { defAt: T0 + 2 * MIN, editAt: T0 + 2 * MIN })] };
  const ab = snapMerge(snapMerge(base, a), b);
  const ba = snapMerge(snapMerge(base, b), a);
  assert.equal(labels(ab).t4, 'Door');
  assert.equal(labels(ba).t4, 'Door');
});

test('a delete and an edit at once: the later decision wins, in either order', () => {
  const base = [row('t4', 'T4', { defAt: T0 })];
  // Edit AFTER the delete: the table stays (same as the database: the upsert re-created it).
  const editLater = { version: T0 + 3 * MIN, tables: [row('t4', 'Bar 4', { defAt: T0 + 2 * MIN, editAt: T0 + 2 * MIN })] };
  const delEarly = { version: T0 + 2 * MIN, tables: [], tableTombstones: { t4: T0 + MIN } };
  // A till keeps the tombstones it has seen (applyConfigUpdate saves them per location).
  const till = (...pushes) => {
    let tables = base, tombstones = {};
    for (const p of pushes) {
      tombstones = mergeTombstones(tombstones, p.tableTombstones);
      tables = snapMerge(tables, p, { tombstones });
    }
    return tables;
  };
  const x1 = till(delEarly, editLater);
  const x2 = till(editLater, delEarly);
  assert.deepEqual([labels(x1).t4, labels(x2).t4], ['Bar 4', 'Bar 4']);
  // Edit BEFORE the delete: gone, in either order.
  const editEarly = { version: T0 + 2 * MIN, tables: [row('t4', 'Bar 4', { defAt: T0 + MIN, editAt: T0 + MIN })] };
  const delLater = { version: T0 + 3 * MIN, tables: [], tableTombstones: { t4: T0 + 2 * MIN } };
  assert.deepEqual(ids(till(editEarly, delLater)), []);
  assert.deepEqual(ids(till(delLater, editEarly)), []);
});

test('a table created after the till read the plan is added by the push', () => {
  const plan = { readAt: T0, ids: ['t1'] };
  const out = snapMerge([row('t1', 'T1', { defAt: T0 })], { version: T0 + 2 * MIN, tables: [row('t1', 'T1'), row('t9', 'T9', { defAt: T0 + MIN, editAt: T0 + MIN })] }, { plan });
  assert.deepEqual(ids(out), ['t1', 't9']);
});

// ── Tombstone bookkeeping ───────────────────────────────────────────────────────────────────

test('tombstones: newest time per id, expired ones pruned, database rows parsed', () => {
  const now = Date.now();
  const m = mergeTombstones({ a: now - 10, b: now - TOMBSTONE_TTL_MS - 1000 }, { a: now - 5 }, null, { c: 'nope' });
  assert.deepEqual(m, { a: now - 5 });
  const r = tombstonesFromRows([{ table_id: 't5', deleted_at: new Date(T0).toISOString() }, { table_id: 't5', deleted_at: new Date(T0 - 1).toISOString() }, { nope: 1 }]);
  assert.deepEqual(r, { t5: T0 });
  assert.equal(isTombstoned('t5', T0 - 1, r), true);
  assert.equal(isTombstoned('t5', T0 + 1, r), false, 'edited after the delete wins');
  assert.equal(isTombstoned('t6', 0, r), false);
});

test('local plan state: per location, shared by tabs, a refused delete forgets its tombstone', () => withStorage(() => {
  const now = Date.now();
  recordTombstone('loc-a', 't5', now);
  savePlanState('loc-a', { plan: { readAt: now, ids: ['t1'] } });
  savePlanState('loc-a', { plan: { readAt: now - 1000, ids: ['old'] } });     // an older read never wins
  assert.deepEqual(loadPlanState('loc-a').tombstones, { t5: now });
  assert.deepEqual(loadPlanState('loc-a').plan.ids, ['t1']);
  assert.deepEqual(loadPlanState('loc-b'), { plan: null, tombstones: {} }, 'no bleed across locations');
  forgetTombstone('loc-a', 't5');
  assert.deepEqual(loadPlanState('loc-a').tombstones, {});
  assert.deepEqual(loadPlanState(null), { plan: null, tombstones: {} });
}));

test('floor_tables rows map to the store shape: section is `section` (useSupabaseInit read section_id)', () => {
  const t = normaliseFloorRow({ id: 't1', label: 'T1', max_covers: 6, section: 'patio', sort_order: 3, location_id: 'L' }, { readAt: T0 });
  assert.equal(t.section, 'patio');
  assert.equal(t.maxCovers, 6);
  assert.equal(t.sortOrder, 3);
  assert.equal(t.locationId, 'L');
  assert.equal(t.defAt, T0);
  assert.equal(t.editAt, 0, 'a read is not an edit');
  const withUpdated = normaliseFloorRow({ id: 't1', updated_at: new Date(T0 - MIN).toISOString() }, { readAt: T0 });
  assert.equal(withUpdated.editAt, T0 - MIN);
  assert.doesNotMatch(read('./useSupabaseInit.js'), /section:dbT\.section_id/);
});

// ── Every path goes through the module ──────────────────────────────────────────────────────

test('every path that writes table definitions goes through lib/tablePlan.js', () => {
  const sb = read('../sync/SyncBridge.jsx');
  const mts = sb.slice(sb.indexOf('function mergeTablesSafely('), sb.indexOf('function safeApplyIncoming('));
  assert.match(mts, /mergeDefinitions\(/, 'cross tab broadcast');
  assert.match(mts, /loadPlanState\(/);
  assert.match(sb, /fetchTableTombstones\(locationId\)/, 'boot reads the tombstones');
  assert.match(sb, /normaliseFloorRow\(t, \{ locationId, readAt: planReadStartedAt \}\)/);

  const usi = read('./useSupabaseInit.js');
  assert.match(usi, /applyPlanRead\(/);

  const bo = read('../backoffice/BackOfficeApp.jsx');
  const loader = bo.slice(bo.indexOf('const loadLocationData = async'), bo.indexOf('// Map modifier groups from snake_case'));
  assert.match(loader, /applyPlanRead\(/);
  assert.doesNotMatch(loader, /session: null,\n\s*\}\)\);/, 'the Back Office loader no longer nulls sessions');
  const push = bo.slice(bo.indexOf('const handlePush = async'), bo.indexOf('// Persist snapshot so POS tabs'));
  assert.match(push, /tableTombstones: pushTombstones/);
  assert.match(push, /defAt: t\.defAt/);
  assert.match(push, /filter\(t => !t\.planRemoved\)/);

  const store = read('../store/index.js');
  const upd = store.slice(store.indexOf('updateTableLayout: (id, patch) => {'), store.indexOf('addTableToLayout:'));
  assert.match(upd, /defAt, editAt: defAt/);
  const rm = store.slice(store.indexOf('removeTableFromLayout: (id) => {'), store.indexOf('// ── Tables (source of truth'));
  assert.match(rm, /recordTombstone\(/);
  assert.match(rm, /forgetTombstone\(/, 'a refused delete takes its tombstone back');

  const rec = read('../sync/SessionReconciler.js');
  assert.match(rec, /pruneClosedRemoved\(newTables\)/);
});

test('the migration creates the tombstone table and the app works before it runs', () => {
  const sql = read('../../supabase/migrations/20260918_OPS_floor_table_tombstones.sql');
  assert.match(sql, /create table if not exists public\.floor_table_tombstones/);
  assert.match(sql, /primary key \(location_id, table_id\)/);
  assert.match(sql, /enable row level security/);
  const db = read('./db.js');
  assert.match(db, /export const fetchTableTombstones/);
  assert.match(db, /TOMBSTONE_ABSENT = \['42P01', 'PGRST205'/);
});
