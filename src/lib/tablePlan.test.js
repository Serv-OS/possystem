// Table plan edits stick (lib/tablePlan.js, lib/tablePlanDb.js). Peter, 18 Sep 2026: "found a bug
// on table plans: if you rename, delete them etc, on refresh they come back and names go back."
//
// Review round two: no device clock decides anything; an open order's table is rebuilt on every
// boot path; Back Office never writes a retired table back and its writes are compare-and-set; an
// old push can add only what the database has; the delete guard sees split checks and QR tabs.
//
// These tests drive the REAL functions. Each till and Back Office tab is a "device" with its own
// localStorage and its own (possibly wrong) clock; the database is an in-memory double with its own
// clock that behaves like PostgREST before and after the migrations (floor_table_tombstones, then
// floor_tables.updated_at + floor_plan_read). The boot helper follows SyncBridge's order exactly
// (cached push, latest push, parallel read, closed checks, then bootTables), and the source-shape
// tests at the bottom pin that SyncBridge, the store, useSupabaseInit and Back Office still call
// these functions in that order.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  mergeDefinitions, applyPlanRead, applyTombstones, pruneClosedRemoved, rebuildOrphans,
  mergeBroadcastTables, applyPushTables, bootTables, admits, tombBeats, newerDef,
  mergeTombs, tombstonesFromRows, normaliseFloorRow, deleteRefusalReason, writeRefusal,
  loadPlanState, savePlanState, recordTombstone, forgetTombstone, pushSeqFor, nextSeq,
  _resetForTests,
} from './tablePlan.js';
import { saveTableChecked, openOrdersFor } from './tablePlanDb.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const LOC = 'loc-provo';
const HOUR = 3600_000;
const realNow = Date.now;

// ── Devices: own storage, own clock ─────────────────────────────────────────────────────────

function makeDevice(name, { skew = 0 } = {}) {
  return { name, skew, mem: new Map(), tables: [], closedChecks: [], backup: {}, snapshot: {}, cachedPush: null, activeTableId: null };
}
function onDevice(dev, fn) {
  const prevLs = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (dev.mem.has(k) ? dev.mem.get(k) : null),
    setItem: (k, v) => { dev.mem.set(k, String(v)); },
    removeItem: (k) => { dev.mem.delete(k); },
  };
  Date.now = () => realNow() + dev.skew;
  _resetForTests();
  try { return fn(); } finally {
    Date.now = realNow;
    if (prevLs === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLs;
  }
}
// sessionClosure.isSessionClosed, over the device's closed checks (same key: table + seatedAt).
const closedFor = (dev) => (tableId, session) => !!session?.seatedAt
  && dev.closedChecks.some(c => c.tableId === tableId && c.seatedAt === session.seatedAt);

// ── The database double ─────────────────────────────────────────────────────────────────────
// mode 'none'  = neither migration has run
// mode 'tombs' = 20260918 only (tombstone table, deleted_at default now())
// mode 'both'  = 20260918 + 20260918b (server updated_at, trigger deleted_at, floor_plan_read)

function makeDb(mode = 'both') {
  const db = {
    mode, clock: 1_900_000_000_000, rows: new Map(), tombs: new Map(), sessions: new Map(), orderQueue: [],
    latestPush: null, fail: new Set(), calls: [],
  };
  db.tick = () => (db.clock += 1000);
  db.iso = (ms) => new Date(ms).toISOString();
  db.hasUpdatedAt = mode === 'both';
  db.hasTombs = mode !== 'none';
  db.put = (row) => {
    const r = { location_id: LOC, x: 10, y: 20, w: 80, h: 80, shape: 'rect', max_covers: 4, section: 'main', sort_order: 0, ...row };
    if (db.hasUpdatedAt) r.updated_at = db.iso(db.tick());
    db.rows.set(r.id, r);
    return r;
  };
  db.readPlan = () => ({ tables: [...db.rows.values()].map(r => ({ ...r })), at: db.hasUpdatedAt ? db.clock : 0 });
  db.tombRows = () => (db.hasTombs ? [...db.tombs.values()].map(t => ({ ...t })) : null);
  db.deleteRow = (id, label = null) => {
    db.rows.delete(id);
    if (db.hasTombs) db.tombs.set(id, { table_id: id, label, deleted_at: db.iso(db.tick()) });
  };
  db.client = makeClient(db);
  return db;
}

function makeClient(db) {
  const tableRows = (t) => {
    if (t === 'floor_tables') return [...db.rows.values()];
    if (t === 'active_sessions') return [...db.sessions.entries()].map(([table_id, session]) => ({ location_id: LOC, table_id, session }));
    if (t === 'order_queue') return db.orderQueue;
    if (t === 'floor_table_tombstones') return [...db.tombs.values()];
    return [];
  };
  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.one = false; }
    select() { return this; }
    insert(row) { this.op = 'insert'; this.row = row; return this; }
    update(p) { this.op = 'update'; this.patch = p; return this; }
    eq(c, v) { this.f.push(r => (r[c] ?? null) === v); if (c === 'updated_at' && !db.hasUpdatedAt) this.badCol = c; return this; }
    is(c, v) { this.f.push(r => (r[c] ?? null) === v); return this; }
    neq(c, v) { this.f.push(r => r[c] !== v); return this; }
    like(c, pat) {
      const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$');
      this.f.push(r => re.test(String(r[c] ?? ''))); return this;
    }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.one = true; return this; }
    then(res, rej) { return Promise.resolve().then(() => this.exec()).then(res, rej); }
    exec() {
      db.calls.push(`${this.op}:${this.t}`);
      if (db.fail.has(this.t)) return { data: null, error: { message: 'network down' } };
      if (this.badCol) return { data: null, error: { code: '42703', message: `column ${this.badCol} does not exist` } };
      if (this.op === 'insert') {
        if (db.rows.has(this.row.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        return { data: [{ ...db.put(this.row) }], error: null };
      }
      const hits = tableRows(this.t).filter(r => this.f.every(fn => fn(r)));
      if (this.op === 'update') {
        const out = hits.map(r => {
          const n = { ...r, ...this.patch };
          if (db.hasUpdatedAt) n.updated_at = db.iso(db.tick());
          db.rows.set(n.id, n);
          return { ...n };
        });
        return { data: out, error: null };
      }
      if (this.one) return { data: hits[0] ? { ...hits[0] } : null, error: null };
      return { data: hits.map(r => ({ ...r })), error: null };
    }
  }
  return { from: (t) => new Q(t) };
}

// ── Back Office actions (what FloorPlanBuilder + Push to POS do, on the database double) ────────

function boRename(db, id, label) { const r = db.rows.get(id); db.put({ ...r, label }); }
function boMove(db, id, x) { const r = db.rows.get(id); db.put({ ...r, x }); }
function boDelete(db, bo, id) {
  const label = db.rows.get(id)?.label || null;
  db.deleteRow(id, label);
  // This machine keeps its own mark too; with the tombstone table it is the server's time.
  onDevice(bo, () => {
    const t = db.tombs.get(id);
    recordTombstone(LOC, id, t ? { at: Date.parse(t.deleted_at), srv: true, label } : { at: Date.now(), srv: false, label });
  });
}
// Push to POS (BackOfficeApp.handlePush): tables from a FRESH read, stamped, plus tombstones.
function boPush(db, bo, { version } = {}) {
  return onDevice(bo, () => {
    const readSeq = nextSeq();
    const fp = db.readPlan();
    const st = loadPlanState(LOC);
    const tombs = mergeTombs(st.tombs, tombstonesFromRows(db.tombRows(), readSeq), { cleared: st.cleared });
    const inRead = new Set(fp.tables.map(r => r.id));
    for (const [id, t] of Object.entries(tombs)) if (!t.srv && inRead.has(id)) delete tombs[id];
    const snap = {
      version: version ?? `push-${db.tick()}`,
      locationId: LOC,
      tables: fp.tables.map(r => { const t = normaliseFloorRow(r, { locationId: LOC }); return { id: t.id, label: t.label, x: t.x, y: t.y, w: t.w, h: t.h, shape: t.shape, maxCovers: t.maxCovers, section: t.section, sortOrder: t.sortOrder, locationId: LOC, srvAt: t.srvAt, srvIso: t.srvIso }; }),
      tablePlan: { v: 2, fromRead: true, srvReadAt: fp.at },
      tableTombstones: Object.fromEntries(Object.entries(tombs).map(([id, t]) => [id, { at: t.at, srv: t.srv, ...(t.label ? { label: t.label } : {}) }])),
    };
    db.latestPush = snap;
    return snap;
  });
}
// A Back Office tab still on the OLD code: its store's tables, no stamps, no tombstones.
function oldBoPush(db, tables) {
  const snap = { version: `old-${db.tick()}`, locationId: LOC, tables: tables.map(t => ({ ...t })) };
  db.latestPush = snap;
  return snap;
}

// ── Till actions (SyncBridge / store.applyConfigUpdate / TablePlanSync, same order) ────────────

function applyPush(dev, snap) {
  if (!snap) return;
  const seq = pushSeqFor(LOC, snap.version);          // setConfigUpdate: first observation
  const st = loadPlanState(LOC);
  const r = applyPushTables(dev.tables, snap, { tombs: st.tombs, plan: st.plan, pushSeq: seq, cleared: st.cleared, isClosed: closedFor(dev) });
  savePlanState(LOC, { tombs: r.tombs });
  dev.tables = r.tables;
  dev.cachedPush = snap;                               // rpos-config-cache
}
function livePush(dev, snap) { onDevice(dev, () => applyPush(dev, snap)); }

// SyncBridge boot. Real mode: the store starts EMPTY (cached tables stripped), the cached snapshot
// is applied, then the latest push, then the parallel read (plan + sessions + tombstones), then the
// closed checks, then bootTables at apply time.
function boot(dev, db, { online = true } = {}) {
  onDevice(dev, () => {
    dev.tables = [];
    if (dev.cachedPush) applyPush(dev, dev.cachedPush);
    if (online && db.latestPush) applyPush(dev, db.latestPush);
    const readSeq = nextSeq();
    const fp = online ? db.readPlan() : null;
    const tombRows = online ? db.tombRows() : null;
    const sessions = {};
    if (online) for (const [id, s] of db.sessions) sessions[id] = s;
    for (const [id, s] of Object.entries(dev.backup)) if (!sessions[id]) sessions[id] = s;
    for (const [id, s] of Object.entries(dev.snapshot)) if (!sessions[id]) sessions[id] = s;
    const st = loadPlanState(LOC);
    const snap = online ? db.latestPush : dev.cachedPush;
    const pushSeq = snap ? pushSeqFor(LOC, snap.version) : 0;
    let tombs = mergeTombs(st.tombs, snap?.tableTombstones, { seq: pushSeq, cleared: st.cleared });
    tombs = mergeTombs(tombs, tombstonesFromRows(tombRows, readSeq), { cleared: st.cleared });
    const rows = fp ? fp.tables.map(t => normaliseFloorRow(t, { locationId: LOC, readSeq })) : null;
    const { tables, read: r } = bootTables({ local: dev.tables, floorRows: rows, srvReadAt: fp?.at || 0, readSeq, tombs, sessions, isClosed: closedFor(dev), labels: st.labels });
    savePlanState(LOC, { plan: r?.plan || null, tombs, cleared: r?.cleared || null, labels: r?.labels || null });
    dev.tables = tables;
  });
}
// TablePlanSync.refreshTablePlan (push arrived / online / foreground / every few minutes).
function refresh(dev, db) {
  onDevice(dev, () => {
    const readSeq = nextSeq();
    const fp = db.readPlan();
    const st = loadPlanState(LOC);
    const tombs = mergeTombs(st.tombs, tombstonesFromRows(db.tombRows(), readSeq), { cleared: st.cleared });
    const rows = fp.tables.map(t => normaliseFloorRow(t, { locationId: LOC, readSeq }));
    const r = applyPlanRead({ local: dev.tables, rows, srvReadAt: fp.at, readSeq, tombs, isClosed: closedFor(dev), mode: 'full' });
    if (r) { dev.tables = pruneClosedRemoved(r.tables, closedFor(dev)); savePlanState(LOC, { plan: r.plan, tombs, cleared: r.cleared, labels: r.labels }); }
  });
}
// SessionReconciler: open active_sessions rows whose table this device lacks get a table.
function reconcile(dev, db) {
  onDevice(dev, () => {
    const st = loadPlanState(LOC);
    const open = new Map([...db.sessions].filter(([id, s]) => !closedFor(dev)(id, s)));
    dev.tables = rebuildOrphans(pruneClosedRemoved(dev.tables, closedFor(dev)), open, { isClosed: closedFor(dev), labels: st.labels, tombs: st.tombs });
  });
}

const byId = (dev, id) => dev.tables.find(t => t.id === id);
const ids = (dev) => dev.tables.map(t => t.id).sort();
const labelOf = (dev, id) => byId(dev, id)?.label;
const sess = (n = 2, extra = {}) => ({ id: 'ORD-' + Math.random().toString(36).slice(2, 8), seatedAt: 1_700_000_000_000 + n, items: Array.from({ length: n }, (_, i) => ({ uid: 'i' + i })), ...extra });
function venue(mode) {
  const db = makeDb(mode);
  db.put({ id: 't1', label: 'T1' }); db.put({ id: 't4', label: 'T4' }); db.put({ id: 't5', label: 'T5' });
  return db;
}
const MODES = ['none', 'tombs', 'both'];

// ── 1. Peter's report: rename and delete, then refresh ──────────────────────────────────────

for (const mode of MODES) {
  test(`[${mode}] rename then refresh keeps the new name, even though the cached push has the old one`, () => {
    const db = venue(mode); const bo = makeDevice('bo');
    const till = makeDevice('sunmi');
    boPush(db, bo);                     // the last push has T4
    boot(till, db);
    assert.equal(labelOf(till, 't4'), 'T4');
    boRename(db, 't4', 'Window');       // Back Office rename, NOT pushed
    boot(till, db);                     // refresh: cached push (T4) first, then the read
    assert.equal(labelOf(till, 't4'), 'Window');
    onDevice(till, () => applyPush(till, till.cachedPush));   // the banner applies the old push again
    assert.equal(labelOf(till, 't4'), 'Window', 'an older push never puts the old name back');
  });

  test(`[${mode}] delete then refresh keeps it deleted, even though the last push still has it`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('ipad');
    boPush(db, bo);
    boot(till, db);
    boDelete(db, bo, 't5');             // NOT pushed
    boot(till, db);
    assert.deepEqual(ids(till), ['t1', 't4']);
    onDevice(till, () => applyPush(till, till.cachedPush));
    assert.deepEqual(ids(till), ['t1', 't4'], 'the old push cannot walk it back in');
    boot(till, db);
    assert.deepEqual(ids(till), ['t1', 't4']);
  });

  test(`[${mode}] a pushed rename and delete reach a till that is running (no reboot)`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('mpos');
    boPush(db, bo); boot(till, db);
    boRename(db, 't4', 'Window'); boDelete(db, bo, 't5');
    livePush(till, boPush(db, bo));
    assert.equal(labelOf(till, 't4'), 'Window');
    assert.deepEqual(ids(till), ['t1', 't4']);
  });

  test(`[${mode}] rename and delete reach a running till WITHOUT a push (the plan refresh)`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('sunmi');
    boPush(db, bo); boot(till, db);
    boRename(db, 't4', 'Window'); boDelete(db, bo, 't5');
    refresh(till, db);
    assert.equal(labelOf(till, 't4'), 'Window');
    assert.deepEqual(ids(till), ['t1', 't4']);
  });
}

// ── 2. Device clocks decide nothing ─────────────────────────────────────────────────────────

for (const mode of MODES) {
  for (const skew of [5 * HOUR, -5 * HOUR]) {
    test(`[${mode}] clock ${skew > 0 ? 'hours ahead' : 'hours behind'}: offline boot, then a table Back Office added is on the floor`, () => {
      const db = venue(mode); const bo = makeDevice('bo');
      const sunmi = makeDevice('sunmi', { skew });
      boPush(db, bo);
      boot(sunmi, db);                                   // online boot with a wrong clock
      db.put({ id: 't9', label: 'T9' });                 // Back Office adds T9 and pushes
      livePush(sunmi, boPush(db, bo));
      assert.ok(byId(sunmi, 't9'), 'the live push adds it');
      boot(sunmi, db, { online: false });                // reboot OFFLINE: cached push + saved plan
      assert.ok(byId(sunmi, 't9'), 'the offline boot keeps it (the old build hid it behind a future read time)');
      assert.deepEqual(ids(sunmi), ['t1', 't4', 't5', 't9']);
      // Back Office adds another table while the Sunmi is offline; it comes back online.
      db.put({ id: 't10', label: 'T10' });
      refresh(sunmi, db);
      assert.ok(byId(sunmi, 't10'));
    });

    test(`[${mode}] clock ${skew > 0 ? 'ahead' : 'behind'}: a pushed rename lands at once, not at the next reboot`, () => {
      const db = venue(mode); const bo = makeDevice('bo');
      const till = makeDevice('ipad', { skew });
      boPush(db, bo); boot(till, db);
      boRename(db, 't4', 'Window');
      livePush(till, boPush(db, bo));
      assert.equal(labelOf(till, 't4'), 'Window');
    });
  }
}

test('no rule in tablePlan.js reads the device clock', () => {
  const src = read('./tablePlan.js');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(code, /Date\.now\(\)/);
  assert.doesNotMatch(code, /new Date\(\)/);
});

// ── 3. A re-created id is not hidden by its old delete ──────────────────────────────────────

for (const mode of MODES) {
  test(`[${mode}] a deleted id that is re-created shows again, and the old tombstone never hides it again`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('sunmi');
    boot(till, db);
    boDelete(db, bo, 't5');
    livePush(till, boPush(db, bo));                   // the push carries the tombstone
    assert.ok(!byId(till, 't5'));
    db.put({ id: 't5', label: 'T5 again' });          // re-created (a seed, an import)
    refresh(till, db);
    assert.equal(labelOf(till, 't5'), 'T5 again');
    onDevice(till, () => applyPush(till, till.cachedPush));   // the same old push, with its tombstone
    assert.equal(labelOf(till, 't5'), 'T5 again', 'the old delete does not win over the re-created row');
    boot(till, db);
    assert.equal(labelOf(till, 't5'), 'T5 again');
    // Back Office pushes the plan with T5 back in it; the old delete is still in the tombstone
    // table (or on the Back Office machine). A till that boots OFFLINE from that push shows T5, and
    // so does a brand new till that never saw the delete.
    livePush(till, boPush(db, bo));
    boot(till, db, { online: false });
    assert.equal(labelOf(till, 't5'), 'T5 again', 'offline boot from the new push');
    const fresh = makeDevice('fresh');
    livePush(fresh, db.latestPush);
    boot(fresh, db, { online: false });
    assert.equal(labelOf(fresh, 't5'), 'T5 again', 'a till that never saw the delete');
  });
}

test('server tombstone against server times: later delete wins, later re-create wins', () => {
  assert.equal(tombBeats({ at: 200, srv: true }, { srvAt: 100 }), true);
  assert.equal(tombBeats({ at: 200, srv: true }, { srvAt: 300 }), false);
  assert.equal(tombBeats({ at: 200, srv: true }, { srvAt: 200 }), false, 'only a LATER delete wins');
  assert.equal(tombBeats({ at: 200, srv: true, seq: 5 }, { srvAt: 0, _seq: 3 }), true, 'an unstamped copy is older than any server time');
  assert.equal(tombBeats({ at: 999, srv: false, seq: 5 }, { srvAt: 100 }), false, 'a local mark never out-dates a server time');
});

// ── 4. Old code pushes add only what the database has ───────────────────────────────────────

for (const mode of MODES) {
  test(`[${mode}] an OLD Back Office push (no stamps) cannot rename back or re-add a deleted table`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('sunmi');
    const staleStore = [...db.rows.values()].map(r => ({ id: r.id, label: r.label, x: r.x, y: r.y, w: r.w, h: r.h, shape: r.shape, maxCovers: r.max_covers, section: r.section }));
    boRename(db, 't4', 'Window'); boDelete(db, bo, 't5');
    boot(till, db);
    livePush(till, oldBoPush(db, staleStore));        // T4 and T5 in the old tab's store
    assert.equal(labelOf(till, 't4'), 'Window');
    assert.deepEqual(ids(till), ['t1', 't4']);
    boot(till, db);                                   // and at the next boot, from the cache
    assert.equal(labelOf(till, 't4'), 'Window');
    assert.deepEqual(ids(till), ['t1', 't4']);
  });

  test(`[${mode}] an old push's NEW table appears once a plan read confirms it (the push triggers one)`, () => {
    const db = venue(mode); const till = makeDevice('ipad');
    boot(till, db);
    db.put({ id: 't9', label: 'T9' });                // an old Back Office tab adds T9 (it writes floor_tables)
    livePush(till, oldBoPush(db, [...db.rows.values()].map(r => ({ id: r.id, label: r.label }))));
    assert.ok(!byId(till, 't9'), 'unstamped: not taken on the push alone');
    refresh(till, db);                                 // rpos-config-push -> TablePlanSync
    assert.ok(byId(till, 't9'));
  });
}

test('a brand new till (no plan read yet) takes an old push as before, then its read decides', () => {
  const db = venue('none'); const till = makeDevice('new');
  boRename(db, 't4', 'Window');
  const stale = oldBoPush(db, [{ id: 't1', label: 'T1' }, { id: 't4', label: 'T4' }, { id: 't5', label: 'T5' }]);
  db.rows.delete('t5');
  onDevice(till, () => applyPush(till, stale));
  assert.deepEqual(ids(till), ['t1', 't4', 't5'], 'nothing better to go on');
  boot(till, db);
  assert.deepEqual(ids(till), ['t1', 't4']);
  assert.equal(labelOf(till, 't4'), 'Window');
});

test('a v2 push whose read failed goes out unstamped and is judged like an old one', () => {
  const plan = { seq: 10, ids: ['t1'], srvReadAt: 0 };
  const r = applyPushTables([{ id: 't1', label: 'T1', _seq: 10 }], { version: 'v', tablePlan: { v: 2, fromRead: false }, tables: [{ id: 't1', label: 'Old' }, { id: 't5', label: 'T5' }] }, { plan, pushSeq: 99 });
  assert.equal(r.tables.find(t => t.id === 't1').label, 'T1');
  assert.ok(!r.tables.find(t => t.id === 't5'));
});

// ── 5. An open order's table is rebuilt (cold boot, every source) ───────────────────────────

for (const mode of MODES) {
  for (const source of ['active_sessions', 'rpos-session-backup', 'rpos-session-snapshot']) {
    test(`[${mode}] TRUE cold boot: open order on a deleted table (only in ${source}) keeps its table`, () => {
      const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('sunmi');
      boPush(db, bo); boot(till, db);
      const order = sess(3);
      if (source === 'active_sessions') db.sessions.set('t5', order);
      if (source === 'rpos-session-backup') till.backup.t5 = order;
      if (source === 'rpos-session-snapshot') till.snapshot.t5 = order;
      db.deleteRow('t5', 'T5');                        // deleted while the order was open (offline till)
      boot(till, db);                                  // empty store, stripped cache
      const t5 = byId(till, 't5');
      assert.ok(t5, 'the table is there');
      assert.equal(t5.planRemoved, true);
      assert.equal(t5.session, order, 'with its order');
      assert.equal(t5.label, 'T5', 'with its name');
    });
  }

  test(`[${mode}] cold boot on a BRAND NEW device (no cache at all): the table is rebuilt from the session`, () => {
    const db = venue(mode); const till = makeDevice('fresh');
    const order = sess(2);
    db.sessions.set('t5', order);
    db.deleteRow('t5', 'T5');
    boot(till, db);
    const t5 = byId(till, 't5');
    assert.ok(t5);
    assert.equal(t5.session, order);
    assert.equal(t5.planRemoved, true);
    assert.equal(t5.label, mode === 'none' ? 'Removed table' : 'T5', 'the tombstone row carries the name once it exists');
  });

  test(`[${mode}] a CLOSED session (paid, row left behind) does not keep or rebuild a deleted table`, () => {
    const db = venue(mode); const till = makeDevice('ipad');
    boot(till, db);
    const order = sess(2);
    db.sessions.set('t5', order); till.backup.t5 = order;
    till.closedChecks.push({ tableId: 't5', seatedAt: order.seatedAt });
    db.deleteRow('t5', 'T5');
    boot(till, db);
    assert.ok(!byId(till, 't5'));
  });

  test(`[${mode}] split checks: T1 deleted with its own check closed and T1.2 open: both stay reachable until T1.2 closes`, () => {
    const db = venue(mode); const till = makeDevice('sunmi');
    boot(till, db);
    const parent = sess(1), child = sess(2);
    till.closedChecks.push({ tableId: 't1', seatedAt: parent.seatedAt });
    db.sessions.set('t1-2', child);
    db.deleteRow('t1', 'T1');
    boot(till, db);
    assert.ok(byId(till, 't1'), 'parent placeholder kept for its open child');
    assert.equal(byId(till, 't1').planRemoved, true);
    assert.equal(byId(till, 't1-2').parentId, 't1');
    assert.equal(byId(till, 't1-2').session, child);
    assert.equal(byId(till, 't1-2').label, 'T1.2');
    // The child is paid: both go.
    till.closedChecks.push({ tableId: 't1-2', seatedAt: child.seatedAt });
    db.sessions.delete('t1-2');
    refresh(till, db);
    assert.ok(!byId(till, 't1'));
    assert.ok(!byId(till, 't1-2'));
  });
}

test('another till\'s order on a deleted table appears on this till (SessionReconciler rebuild)', () => {
  const db = venue('both'); const bo = makeDevice('bo'); const till = makeDevice('ipad');
  boPush(db, bo); boot(till, db);
  boDelete(db, bo, 't5');
  refresh(till, db);
  assert.ok(!byId(till, 't5'));
  const order = sess(2);
  db.sessions.set('t5', order);                     // an offline till syncs its order on T5
  reconcile(till, db);
  assert.equal(byId(till, 't5')?.session, order);
  assert.equal(byId(till, 't5')?.planRemoved, true);
  assert.equal(byId(till, 't5')?.label, 'T5');
});

test('rebuildOrphans skips a session that MOVED to a table this device holds', () => {
  const order = sess(2);
  const out = rebuildOrphans([{ id: 't4', label: 'T4', session: order }], { t5: order });
  assert.deepEqual(out.map(t => t.id), ['t4']);
});

test('useSupabaseInit can never drop a table before SyncBridge has checked sessions (upsertOnly)', () => {
  const local = [{ id: 't5', label: 'T5', _seq: 1 }];
  const r = applyPlanRead({ local, rows: [normaliseFloorRow({ id: 't1', label: 'T1' }, { readSeq: 9 })], readSeq: 9, mode: 'upsertOnly' });
  assert.deepEqual(r.tables.map(t => t.id).sort(), ['t1', 't5']);
  assert.equal(r.dropped.length, 0);
  const src = read('./useSupabaseInit.js');
  assert.match(src, /refreshTablePlan\(\{ locationId: locId, mode: 'upsertOnly'/);
  assert.doesNotMatch(src, /applyPlanRead\(/);
});

// ── 6. Back Office: compare-and-set, never a blind upsert ──────────────────────────────────

function boTab(db, id) {
  const r = db.rows.get(id);
  return { ...normaliseFloorRow(r, { locationId: LOC }), locationId: LOC };
}

for (const mode of ['none', 'both']) {
  test(`[${mode}] a STALE Back Office tab cannot put back an old name or position`, async () => {
    const db = venue(mode);
    const tabA = boTab(db, 't4');                      // read an hour ago
    const tabB = boTab(db, 't4');
    const b = await saveTableChecked(db.client, { ...tabB, label: 'Window' }, LOC);
    assert.equal(b.ok, true);
    const a = await saveTableChecked(db.client, { ...tabA, x: 300 }, LOC);
    assert.equal(a.ok, false);
    assert.equal(a.conflict, 'changed');
    assert.equal(db.rows.get('t4').label, 'Window', 'the newer edit survives');
    assert.equal(db.rows.get('t4').x, 10);
  });

  test(`[${mode}] a STALE Back Office tab cannot resurrect a deleted table`, async () => {
    const db = venue(mode);
    const tabA = boTab(db, 't5');
    db.deleteRow('t5', 'T5');
    const a = await saveTableChecked(db.client, { ...tabA, x: 99 }, LOC);
    assert.equal(a.ok, false);
    assert.equal(a.conflict, 'deleted');
    assert.equal(db.rows.has('t5'), false);
  });

  test(`[${mode}] two edits in a row from one tab: the second is checked against the first's result`, async () => {
    const db = venue(mode);
    let t = boTab(db, 't4');
    const r1 = await saveTableChecked(db.client, { ...t, x: 50 }, LOC);
    assert.equal(r1.ok, true);
    t = { ...t, x: 50, ...(() => { const n = normaliseFloorRow(r1.row, { locationId: LOC }); return { _base: n._base, srvAt: n.srvAt, srvIso: n.srvIso }; })() };
    const r2 = await saveTableChecked(db.client, { ...t, label: 'Door' }, LOC);
    assert.equal(r2.ok, true);
    assert.equal(db.rows.get('t4').label, 'Door');
    assert.equal(db.rows.get('t4').x, 50);
  });

  test(`[${mode}] a new table is INSERTED: an id that already exists is refused, never overwritten`, async () => {
    const db = venue(mode);
    const ok = await saveTableChecked(db.client, { id: 't9', label: 'T9', _isNew: true, locationId: LOC }, LOC);
    assert.equal(ok.ok, true);
    const dup = await saveTableChecked(db.client, { id: 't4', label: 'Imposter', _isNew: true, locationId: LOC }, LOC);
    assert.equal(dup.conflict, 'exists');
    assert.equal(db.rows.get('t4').label, 'T4');
  });
}

test('a retired (planRemoved) or tombstoned table is refused before any request', async () => {
  const db = venue('both');
  const r = await saveTableChecked(db.client, { ...boTab(db, 't4'), planRemoved: true }, LOC);
  assert.equal(r.ok, false);
  assert.equal(db.calls.length, 0, 'nothing sent');
  assert.equal(writeRefusal({ ...boTab(db, 't4'), planRemoved: true }), 'removed');
  const t4 = boTab(db, 't4');
  assert.equal(writeRefusal(t4, { t4: { at: t4.srvAt + 1000, srv: true } }), 'deleted');
  assert.equal(writeRefusal({ id: 'tx', label: 'X' }), 'no-base', 'a table this tab never read cannot be written');
  assert.equal(writeRefusal({ id: 'tx', label: 'X', _isNew: true }), null);
});

test('FloorPlanBuilder: planRemoved is off the canvas, shown read only, and every write is compare-and-set', () => {
  const src = read('../backoffice/sections/FloorPlanBuilder.jsx');
  assert.match(src, /const tablesForThisLocation = tablesAtThisLocation\.filter\(t => !t\.planRemoved\)/);
  assert.match(src, /Deleted, still has an open order/);
  assert.match(src, /saveFloorTableChecked\(table, locId\)/);
  assert.match(src, /writeRefusal\(table, loadPlanState\(locId\)\.tombs\)/);
  assert.doesNotMatch(src, /upsertFloorTable\(/);
  const store = read('../store/index.js');
  const upd = store.slice(store.indexOf('updateTableLayout: (id, patch) => {'), store.indexOf('addTableToLayout:'));
  assert.doesNotMatch(upd, /upsertFloorTable\(/, 'no write on every drag mousemove');
  const add = store.slice(store.indexOf('addTableToLayout: async'), store.indexOf('removeTableFromLayout:'));
  assert.doesNotMatch(add, /upsertFloorTable\(/);
  assert.match(add, /_isNew: true/);
});

// ── 7. The delete guard ─────────────────────────────────────────────────────────────────────

test('delete guard: split child open on a till while the parent is closed', async () => {
  const db = venue('both');
  const parent = sess(1), child = sess(2);
  db.sessions.set('t1', parent); db.sessions.set('t1-2', child);
  const closed = (id, s) => id === 't1' && s === parent;
  const g = await openOrdersFor(db.client, LOC, 't1');
  assert.deepEqual(g.failed, []);
  assert.match(deleteRefusalReason({ id: 't1', label: 'T1' }, { ...g, isClosed: closed }), /open split check on a till/);
  db.sessions.delete('t1-2');
  const g2 = await openOrdersFor(db.client, LOC, 't1');
  assert.equal(deleteRefusalReason({ id: 't1', label: 'T1' }, { ...g2, isClosed: closed }), null, 'a closed leftover never blocks');
  // ...and a child in THIS browser only (not yet written) blocks too.
  assert.match(deleteRefusalReason({ id: 't1', label: 'T1' }, { tables: [{ id: 't1-2', parentId: 't1', session: child }] }), /open split check/);
});

test('delete guard: an open QR tab (order_queue customer jsonb, by id or label) blocks', async () => {
  const db = venue('both');
  db.orderQueue.push({ location_id: LOC, source: 'qr', status: 'new', customer: { tab_open: true, tableId: 'T4' } });
  const g = await openOrdersFor(db.client, LOC, 't4');
  assert.match(deleteRefusalReason({ id: 't4', label: 'T4' }, g), /open QR tab/);
  db.orderQueue[0].customer.tab_closed = true;
  assert.equal(deleteRefusalReason({ id: 't4', label: 'T4' }, await openOrdersFor(db.client, LOC, 't4')), null);
});

test('delete guard: any check that cannot run refuses', async () => {
  for (const leg of ['active_sessions', 'order_queue']) {
    const db = venue('both');
    db.fail.add(leg);
    const g = await openOrdersFor(db.client, LOC, 't4');
    assert.ok(g.failed.length > 0, leg);
    assert.match(deleteRefusalReason({ id: 't4', label: 'T4' }, g), /Could not check T4 for open orders/);
  }
  assert.match(deleteRefusalReason({ id: 't4', label: '4' }, { failed: ['location'] }), /Could not check Table 4/);
});

test('delete guard: a session still in a till\'s write debounce is caught by the second look', () => {
  const src = read('../backoffice/sections/FloorPlanBuilder.jsx');
  const body = src.slice(src.indexOf('const removeSelectedTable = async'), src.indexOf('const sectionColor ='));
  const first = body.indexOf('fetchTableOpenOrders(locId, table.id)');
  const wait = body.indexOf('setTimeout(r, 1500)');
  const second = body.indexOf('fetchTableOpenOrders(locId, table.id)', first + 1);
  const del = body.indexOf("from('floor_tables').delete()");
  assert.ok(first > 0 && wait > first && second > wait && del > second, 'look, wait, look again, then delete');
  assert.match(body, /removeTableFromLayout\(table\.id, \{ dbDeleted: true, tomb \}\)/, 'no second delete that could fail and put it back');
});

test('removeTableFromLayout: a network error never forgets the tombstone; only a row that is provably still there is put back', () => {
  const store = read('../store/index.js');
  const rm = store.slice(store.indexOf('removeTableFromLayout: (id, {'), store.indexOf('// ── Tables (source of truth'));
  assert.match(rm, /if \(dbDeleted\) \{ reportSave\('table delete', null\); return; \}/);
  assert.match(rm, /if \(await stillThere\(\)\) putBack\(error\)/);
  assert.match(rm, /if \(await stillThere\(\)\) putBack\(e\)/);
  assert.ok(rm.indexOf('forgetTombstone(') > rm.indexOf('const putBack'), 'forgetTombstone only inside putBack');
});

// ── 8. The memory note scenarios (feedback_tables_never_lost) ───────────────────────────────

for (const mode of MODES) {
  test(`[${mode}] refresh mid order: the order is on its table after the reboot`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('sunmi');
    boPush(db, bo); boot(till, db);
    const order = sess(4);
    till.backup.t4 = order;                              // written locally, not yet in active_sessions
    boot(till, db);
    assert.equal(byId(till, 't4').session, order);
    assert.equal(byId(till, 't4').status, 'occupied');
    assert.ok(!byId(till, 't4').planRemoved);
  });

  test(`[${mode}] Back Office pushes during service: every table and order survives`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('ipad');
    boot(till, db);
    const o1 = sess(3);
    till.tables = till.tables.map(t => t.id === 't1' ? { ...t, session: o1, status: 'occupied', firedCourses: [1] } : t);
    for (const snap of [{ version: 'menu-only' }, { version: 'empty', tables: [] }, { version: 'partial', tables: [{ id: 't1', label: 'T1' }] }, boPush(db, bo)]) {
      livePush(till, { locationId: LOC, ...snap });
      assert.deepEqual(ids(till), ['t1', 't4', 't5'], snap.version);
      assert.equal(byId(till, 't1').session, o1);
      assert.deepEqual(byId(till, 't1').firedCourses, [1]);
    }
  });

  test(`[${mode}] wake from sleep OFFLINE: no table lost, and every saved order is on its table`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('sunmi');
    boPush(db, bo); boot(till, db);
    const o4 = sess(2), o5 = sess(3);
    till.backup.t4 = o4; till.snapshot.t5 = o5;
    boot(till, db, { online: false });
    assert.deepEqual(ids(till), ['t1', 't4', 't5']);
    assert.equal(byId(till, 't4').session, o4, 'the old build attached no session at all on a failed read');
    assert.equal(byId(till, 't5').session, o5);
  });

  test(`[${mode}] a failed or EMPTY plan read never removes a table`, () => {
    const db = venue(mode); const bo = makeDevice('bo'); const till = makeDevice('ipad');
    boPush(db, bo); boot(till, db);
    const saved = db.rows; db.rows = new Map();          // the read comes back empty
    boot(till, db);
    assert.deepEqual(ids(till), ['t1', 't4', 't5']);
    db.rows = saved;
    assert.equal(applyPlanRead({ local: till.tables, rows: null }), null);
    assert.equal(applyPlanRead({ local: till.tables, rows: [] }), null);
  });
}

test('cross tab race: a stale tab broadcasting a deleted table cannot re-add it or an old name', () => {
  const plan = { seq: 20, ids: ['t1', 't4'], srvReadAt: 0 };
  const fresh = [{ id: 't1', label: 'T1', _seq: 20 }, { id: 't4', label: 'Window', _seq: 20 }];
  const stale = [{ id: 't1', label: 'T1', _seq: 5 }, { id: 't4', label: 'T4', _seq: 5 }, { id: 't5', label: 'T5', _seq: 5 }];
  const out = mergeBroadcastTables(fresh, stale, null, { plan, tombs: { t5: { at: 1, srv: false, seq: 18 } } });
  assert.deepEqual(out.map(t => t.id).sort(), ['t1', 't4']);
  assert.equal(out.find(t => t.id === 't4').label, 'Window');
  // The stale tab, receiving the fresh one, learns the name and drops T5 by the shared tombstone.
  const back = mergeBroadcastTables(stale, fresh, null, { plan, tombs: { t5: { at: 1, srv: false, seq: 18 } } });
  assert.deepEqual(back.map(t => t.id).sort(), ['t1', 't4']);
  assert.equal(back.find(t => t.id === 't4').label, 'Window');
});

test('cross tab race: an incoming copy with an OPEN order on a tombstoned table is kept, with the order', () => {
  const order = sess(2);
  const tombs = { t5: { at: 1, srv: false, seq: 18 } };
  // This tab still has T5 (no order) and the tombstone; the other tab has T5 WITH an order.
  const mine = [{ id: 't1', label: 'T1', _seq: 20 }, { id: 't5', label: 'T5', _seq: 5 }];
  const theirs = [{ id: 't1', label: 'T1', _seq: 20 }, { id: 't5', label: 'T5', _seq: 5, session: order, status: 'occupied' }];
  const out = mergeBroadcastTables(mine, theirs, null, { tombs });
  const t5 = out.find(t => t.id === 't5');
  assert.ok(t5, 'the first build discarded it here');
  assert.equal(t5.session, order);
  assert.equal(t5.planRemoved, true);
  // This tab never had T5 at all: same result.
  const out2 = mergeBroadcastTables([mine[0]], theirs, null, { tombs });
  assert.equal(out2.find(t => t.id === 't5')?.session, order);
});

test('cross tab race: the v4.5.3 session rules still hold (fewer items, active table, newer local)', () => {
  const big = sess(3), small = sess(1);
  const local = [{ id: 't1', label: 'T1', session: big }, { id: 't4', label: 'T4', session: big }];
  const incoming = [{ id: 't1', label: 'T1', session: small }, { id: 't4', label: 'T4', session: null }];
  let warned = 0;
  const out = mergeBroadcastTables(local, incoming, null, { warn: () => { warned++; } });
  assert.equal(out.find(t => t.id === 't1').session, big);
  assert.equal(out.find(t => t.id === 't4').session, big);
  assert.equal(warned, 2);
  const active = mergeBroadcastTables([{ id: 't1', session: small }], [{ id: 't1', session: big }], 't1');
  assert.equal(active[0].session, small, 'the active table is never touched');
  // A Back Office tab's in-flight edit flags never travel to a till tab.
  const fromBo = mergeBroadcastTables([], [{ id: 't9', label: 'T9', _pending: true, _isNew: true, _seq: 3 }], null, {});
  assert.equal(fromBo[0]._pending, undefined);
  assert.equal(fromBo[0]._isNew, undefined);
});

// ── 9. Plan read concurrency (fixed: the first build's test asserted the opposite of the boot) ──

test('a table observed AFTER the read began is kept; one observed before it and absent is retired', () => {
  const readSeq = 10;
  const local = [
    { id: 't9', label: 'T9', _seq: 12 },                 // Back Office added it while the read was in flight
    { id: 't8', label: 'T8', _seq: 4 },                  // known before the read; the read lacks it: deleted
    { id: 't7', label: 'T7', _seq: 4, session: sess(1) },// same, but an order is open on it
  ];
  const r = applyPlanRead({ local, rows: [normaliseFloorRow({ id: 't1', label: 'T1' }, { readSeq })], readSeq });
  assert.deepEqual(r.tables.map(t => t.id).sort(), ['t1', 't7', 't9']);
  assert.deepEqual(r.dropped, ['t8']);
  assert.equal(r.tables.find(t => t.id === 't7').planRemoved, true);
  // With server times: srvAt after the read's server time is kept, at or before it is retired.
  const r2 = applyPlanRead({
    local: [{ id: 'a', srvAt: 500, _seq: 1 }, { id: 'b', srvAt: 300, _seq: 1 }],
    rows: [normaliseFloorRow({ id: 't1', updated_at: new Date(100).toISOString() }, { readSeq: 5 })],
    srvReadAt: 400, readSeq: 5,
  });
  assert.deepEqual(r2.tables.map(t => t.id).sort(), ['a', 't1']);
  // The boot itself: the cached push was observed BEFORE the boot read, so its deleted table goes.
  const src = read('../sync/SyncBridge.jsx');
  const boot = src.slice(src.indexOf('const rpos'), src.length);
  assert.ok(src.indexOf("useStore.getState().applyConfigUpdate();\n                console.log('[SyncBridge] applied cached config snapshot") < src.indexOf('const planReadSeq = nextSeq();'), 'cache applied before the read seq is taken');
  assert.ok(boot);
});

test('observation order, not clocks, for unstamped copies; server time beats it when present', () => {
  assert.equal(newerDef({ _seq: 5 }, { _seq: 4 }), true);
  assert.equal(newerDef({ _seq: 4 }, { _seq: 4 }), false, 'ties keep the local copy');
  assert.equal(newerDef({ srvAt: 10, _seq: 1 }, { srvAt: 0, _seq: 99 }), true, 'stamped beats unstamped');
  assert.equal(newerDef({ srvAt: 0, _seq: 99 }, { srvAt: 10, _seq: 1 }), false);
  assert.equal(newerDef({ _seq: 9 }, { _seq: 1, _pending: true }), false, 'an edit in flight is never replaced');
  assert.equal(admits({ id: 'x', _seq: 3 }, { seq: 5, ids: [] }), false);
  assert.equal(admits({ id: 'x', _seq: 6 }, { seq: 5, ids: [] }), true);
  assert.equal(admits({ id: 'x', _seq: 0 }, { seq: 5, ids: ['x'] }), true);
  assert.equal(admits({ id: 'x', srvAt: 50, _seq: 99 }, { seq: 5, ids: [], srvReadAt: 60 }), false, 'server times decide when both exist');
  assert.equal(admits({ id: 'x', _seq: 0 }, null), true);
});

// ── 10. Plan state persistence ──────────────────────────────────────────────────────────────

test('plan state: per location, an older read never replaces a newer one, cleared tombstones stay cleared', () => {
  const dev = makeDevice('d');
  onDevice(dev, () => {
    const a = nextSeq(), b = nextSeq();
    assert.ok(b > a, 'the counter only goes up');
    savePlanState(LOC, { plan: { seq: b, ids: ['t1'] } });
    savePlanState(LOC, { plan: { seq: a, ids: ['old'] } });
    assert.deepEqual(loadPlanState(LOC).plan.ids, ['t1']);
    recordTombstone(LOC, 't5', { at: 123, label: 'T5' });
    assert.equal(loadPlanState(LOC).tombs.t5.at, 123);
    savePlanState(LOC, { cleared: { t5: 123 } });
    assert.equal(loadPlanState(LOC).tombs.t5, undefined);
    savePlanState(LOC, { tombs: { t5: { at: 123, srv: false, seq: 1 } } });
    assert.equal(loadPlanState(LOC).tombs.t5, undefined, 'the same delete cannot come back from an old push');
    savePlanState(LOC, { tombs: { t5: { at: 456, srv: false, seq: 9 } } });
    assert.equal(loadPlanState(LOC).tombs.t5.at, 456, 'a NEW delete of the same id does');
    forgetTombstone(LOC, 't5');
    assert.equal(loadPlanState(LOC).tombs.t5, undefined);
    assert.deepEqual(loadPlanState('other').plan, null, 'no bleed across locations');
    const s1 = pushSeqFor(LOC, 'v1'); nextSeq(); const s2 = pushSeqFor(LOC, 'v1');
    assert.equal(s1, s2, 'a push keeps its first observation');
  });
});

test('tombstone rows parse to server tombstones; the first build\'s plain numbers still load', () => {
  const r = tombstonesFromRows([{ table_id: 't5', deleted_at: new Date(2000).toISOString(), label: 'T5' }, { nope: 1 }], 7);
  assert.deepEqual(r, { t5: { at: 2000, srv: true, seq: 7, label: 'T5' } });
  const m = mergeTombs({ t5: 1000 }, r);
  assert.equal(m.t5.srv, true, 'a server tombstone replaces a local one');
});

test('floor_tables rows map to the store shape with version marks and the compare-and-set base', () => {
  const t = normaliseFloorRow({ id: 't1', label: 'T1', max_covers: 6, section: 'patio', sort_order: 3, location_id: 'L', updated_at: '2026-09-18T10:00:00.123+00:00' }, { readSeq: 4 });
  assert.equal(t.section, 'patio');
  assert.equal(t.maxCovers, 6);
  assert.equal(t.sortOrder, 3);
  assert.equal(t.locationId, 'L');
  assert.equal(t.srvAt, Date.parse('2026-09-18T10:00:00.123+00:00'));
  assert.equal(t.srvIso, '2026-09-18T10:00:00.123+00:00', 'kept verbatim for the compare');
  assert.equal(t._seq, 4);
  assert.deepEqual(t._base, { label: 'T1', x: undefined, y: undefined, w: undefined, h: undefined, shape: undefined, maxCovers: 6, section: 'patio', sortOrder: 3 });
});

// ── 11. Every path goes through the module ──────────────────────────────────────────────────

test('SyncBridge boot: tables are computed AFTER closed checks, from the store at apply time, via bootTables', () => {
  const sb = read('../sync/SyncBridge.jsx');
  const checks = sb.indexOf('const checksRes = await fetchClosedChecks(');
  const patchSet = sb.indexOf('if (Object.keys(patch).length) useStore.setState(patch);');
  const boot = sb.indexOf('bootTables({');
  assert.ok(checks > 0 && patchSet > checks && boot > patchSet, 'closed checks, then patch, then tables');
  assert.match(sb.slice(boot - 400, boot), /const cur = useStore\.getState\(\)\.tables \|\| \[\];/);
  assert.match(sb, /fetchFloorPlanVersioned\(locationId\)/);
  assert.match(sb, /sessions: bootSessions, isClosed: isSessionClosed/);
  assert.match(sb, /mergeBroadcastTables\(localTables, incomingTables, activeId/);
  assert.match(sb, /startTablePlanSync\(\)/);
  assert.doesNotMatch(sb, /planReadStartedAt|defAt/);
});

test('store: pushes go through applyPushTables; first observation recorded in setConfigUpdate', () => {
  const store = read('../store/index.js');
  const apply = store.slice(store.indexOf('applyConfigUpdate: () => {'), store.indexOf('locationSections: snap.locationSections'));
  assert.match(apply, /applyPushTables\(updatedTables, snap, \{ tombs: state\.tombs, plan: state\.plan, pushSeq/);
  assert.doesNotMatch(apply, /label:st\.label/);
  assert.match(store, /setConfigUpdate: \(snapshot\) => \{[\s\S]{0,400}pushSeqFor\(/);
});

test('Back Office: loads through TablePlanSync, pushes a FRESH read with server times and tombstones', () => {
  const bo = read('../backoffice/BackOfficeApp.jsx');
  assert.match(bo, /refreshTablePlan\(\{ locationId, mode: 'full', reason: 'backoffice', backOffice: true \}\)/);
  const push = bo.slice(bo.indexOf('const handlePush = async'), bo.indexOf('// Persist snapshot so POS tabs'));
  assert.match(push, /fetchFloorPlanVersioned\(snapshotLocationId\)/);
  assert.match(push, /srvAt: t\.srvAt \|\| 0/);
  assert.match(push, /tablePlan: pushPlan/);
  assert.match(push, /tableTombstones: pushTombstones/);
  assert.match(push, /at: t\.at, srv: !!t\.srv/, 'the local seq is stripped');
});

test('SessionReconciler rebuilds tables for open orders and prunes with isSessionClosed', () => {
  const rec = read('../sync/SessionReconciler.js');
  assert.match(rec, /pruneClosedRemoved\(newTables, isSessionClosed\)/);
  assert.match(rec, /rebuildOrphans\(prunedTables, orphanSessions/);
  assert.match(rec, /if \(store\._dataLocationId\)/);
});

test('the migrations: tombstones first, then server times; the app works before either runs', () => {
  const m1 = read('../../supabase/migrations/20260918_OPS_floor_table_tombstones.sql');
  assert.match(m1, /create table if not exists public\.floor_table_tombstones/);
  const m2 = read('../../supabase/migrations/20260918b_OPS_floor_tables_server_time.sql');
  assert.match(m2, /add column if not exists updated_at timestamptz/);
  assert.match(m2, /before insert or update on public\.floor_tables/);
  assert.match(m2, /new\.updated_at := date_trunc\('milliseconds', clock_timestamp\(\)\)/);
  assert.match(m2, /before insert or update on public\.floor_table_tombstones/);
  assert.match(m2, /create or replace function public\.floor_plan_read\(p_location_id text\)/);
  assert.match(m2, /security invoker/);
  const db = read('./db.js');
  assert.match(db, /isMissingFunction\(r\.error\)\) _noPlanRpc = true/, 'missing function falls back to the plain read');
  assert.doesNotMatch(db.slice(db.indexOf('export const insertTableTombstone'), db.indexOf('export const insertTableTombstone') + 800), /deleted_at: new Date/, 'deleted_at is never sent from a device');
});
