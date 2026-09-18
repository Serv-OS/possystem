// Floor plan sections (lib/sectionPlan.js). Peter, 18 Sep 2026: "I change the name of main dining to
// up", and on refresh it was Main dining again. The database is an in-memory double that behaves
// like PostgREST on public.sections before migration 20260918c (key on id alone, no `hidden`) and
// after it (key on location_id + id).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_SECTIONS, defaultSections, saveSectionsChecked, readSections, resolveSections, pickPushedSections,
  removeSectionRefusal, tablesForSectionView, effectiveSectionView, orphanSectionTables, OTHER_SECTION,
  loadSavedSections, storeSavedSections, sectionsSignature, isSectionsMigrationMissing, MIGRATION_TEXT,
} from './sectionPlan.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const L1 = 'ab45c80b-416d-4631-93e2-05048e52e0fa';   // Coffee Boy Preston
const L2 = '7218c716-eeb4-4f96-b284-f3500823595c';

// ── The database double ─────────────────────────────────────────────────────────────────────
function makeDb({ migrated = true } = {}) {
  const db = { migrated, rows: new Map(), fail: new Set(), calls: [] };
  const key = (r) => (db.migrated ? `${r.location_id}|${r.id}` : r.id);
  class Q {
    constructor() { this.f = []; this.op = 'select'; }
    select() { return this; }
    eq(c, v) { this.f.push(r => r[c] === v); return this; }
    in(c, vs) { this.f.push(r => vs.includes(r[c])); return this; }
    order(c) { this.ord = c; return this; }
    upsert(rows, opts) { this.op = 'upsert'; this.rows = rows; this.opts = opts; return this; }
    delete() { this.op = 'delete'; return this; }
    then(res, rej) { return Promise.resolve().then(() => this.exec()).then(res, rej); }
    exec() {
      db.calls.push(this.op);
      if (db.fail.has(this.op)) return { data: null, error: { message: 'network down' } };
      if (this.op === 'upsert') {
        if (!db.migrated) {
          if (this.rows.some(r => 'hidden' in r)) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'hidden' column of 'sections' in the schema cache" } };
          return { data: null, error: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' } };
        }
        assert.equal(this.opts?.onConflict, 'location_id,id');
        for (const r of this.rows) db.rows.set(key(r), { ...r });
        return { data: this.rows.map(r => ({ ...r })), error: null };
      }
      const hits = [...db.rows.values()].filter(r => this.f.every(fn => fn(r)));
      if (this.op === 'delete') {
        for (const r of hits) db.rows.delete(key(r));
        return { data: null, error: null };
      }
      const out = this.ord ? [...hits].sort((a, b) => a[this.ord] - b[this.ord]) : hits;
      return { data: out.map(r => ({ ...r })), error: null };
    }
  }
  db.client = { from: (t) => { assert.equal(t, 'sections'); return new Q(); } };
  db.venue = (loc) => [...db.rows.values()].filter(r => r.location_id === loc).sort((a, b) => a.sort_order - b.sort_order);
  return db;
}

// A device: its own localStorage and its own store slice (what store.applySavedSections keeps).
function makeDevice() { return { mem: new Map(), sections: defaultSections(), loc: null, base: null }; }
function onDevice(dev, fn) {
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (dev.mem.has(k) ? dev.mem.get(k) : null),
    setItem: (k, v) => { dev.mem.set(k, String(v)); },
    removeItem: (k) => { dev.mem.delete(k); },
  };
  try { return fn(); } finally {
    if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev;
  }
}
// Mirrors store.applySavedSections: resolve, cache a non-empty read, keep the base.
function applyRead(dev, loc, rows) {
  onDevice(dev, () => {
    const r = resolveSections({ loc, read: rows, current: dev.sections, currentLoc: dev.loc, cached: loadSavedSections(loc) });
    if (Array.isArray(rows) && rows.length) storeSavedSections(loc, r.sections);
    dev.sections = r.sections;
    dev.loc = loc;
    if (r.base !== undefined) dev.base = { loc, sig: r.base };
  });
}
// A Back Office section edit: whole list, checked against the base, as FloorPlanBuilder does.
async function boSave(db, dev, loc, next) {
  const base = dev.base && dev.base.loc === loc ? dev.base.sig : undefined;
  const res = await saveSectionsChecked(db.client, loc, next, { base });
  if (res.ok) onDevice(dev, () => { storeSavedSections(loc, next); dev.sections = next; dev.base = { loc, sig: sectionsSignature(next) }; });
  else if (res.reason === 'changed') applyRead(dev, loc, res.latest);
  return res;
}
const rename = (list, id, label) => list.map(s => (s.id === id ? { ...s, label } : s));
const labels = (list) => list.map(s => s.label);

// ── 1. Rename Main dining to Up, reload, it is Up ───────────────────────────────────────────

test('rename Main dining to Up, reload Back Office: it is Up', async () => {
  const db = makeDb();
  const bo = makeDevice();
  applyRead(bo, L1, (await readSections(db.client, L1)).sections);   // venue has nothing saved
  assert.deepEqual(labels(bo.sections), ['Main dining', 'Bar', 'Patio'], 'defaults exactly as before');
  const res = await boSave(db, bo, L1, rename(bo.sections, 'main', 'Up'));
  assert.equal(res.ok, true);
  // Reload: a fresh tab (empty storage, the store's built in defaults), reading the database.
  const fresh = makeDevice();
  applyRead(fresh, L1, (await readSections(db.client, L1)).sections);
  assert.deepEqual(labels(fresh.sections), ['Up', 'Bar', 'Patio']);
  assert.equal(fresh.sections[0].id, 'main', 'the id stays main, so the 56 tables filed under main stay in it');
});

test('till boot: the saved list wins over the last push (cached and fetched) and the defaults', async () => {
  const db = makeDb();
  const bo = makeDevice();
  applyRead(bo, L1, []);
  await boSave(db, bo, L1, rename(bo.sections, 'main', 'Up'));
  const till = makeDevice();
  // SyncBridge boot order: cached push, fetched push (both carry the old list), then the plan read.
  const oldPush = defaultSections();
  onDevice(till, () => { till.sections = pickPushedSections({ pushed: oldPush, saved: loadSavedSections(L1), current: till.sections }); });
  assert.deepEqual(labels(till.sections), ['Main dining', 'Bar', 'Patio'], 'nothing saved on this till yet: the push applies');
  applyRead(till, L1, (await readSections(db.client, L1)).sections);
  assert.deepEqual(labels(till.sections), ['Up', 'Bar', 'Patio']);
  // Next boot, OFFLINE: the plan read fails; the old push is applied again from its cache.
  till.sections = defaultSections(); till.loc = null;
  onDevice(till, () => { till.sections = pickPushedSections({ pushed: oldPush, saved: loadSavedSections(L1), current: till.sections }); });
  applyRead(till, L1, null);
  assert.deepEqual(labels(till.sections), ['Up', 'Bar', 'Patio'], 'the saved list survives an offline boot and an old push');
});

// ── 2. The first save writes every section on screen ────────────────────────────────────────

test('the first save for a venue on the defaults writes EVERY section, in order', async () => {
  const db = makeDb();
  const bo = makeDevice();
  applyRead(bo, L1, []);
  await boSave(db, bo, L1, rename(bo.sections, 'main', 'Up'));
  const rows = db.venue(L1);
  assert.deepEqual(rows.map(r => [r.id, r.label, r.sort_order]), [['main', 'Up', 0], ['bar', 'Bar', 1], ['patio', 'Patio', 2]]);
  assert.ok(rows.every(r => r.location_id === L1 && r.hidden === false));
});

test('reorder, hide and remove save the whole list; removed rows are deleted only after the upsert', async () => {
  const db = makeDb();
  const bo = makeDevice();
  applyRead(bo, L1, []);
  await boSave(db, bo, L1, [bo.sections[1], bo.sections[0], { ...bo.sections[2], hidden: true }]);
  assert.deepEqual(db.venue(L1).map(r => [r.id, r.sort_order, r.hidden]), [['bar', 0, false], ['main', 1, false], ['patio', 2, true]]);
  db.calls.length = 0;
  await boSave(db, bo, L1, bo.sections.filter(s => s.id !== 'patio'));
  assert.deepEqual(db.venue(L1).map(r => r.id), ['bar', 'main']);
  assert.deepEqual(db.calls, ['select', 'upsert', 'delete']);
});

// ── 3. Two venues can both have 'main' ──────────────────────────────────────────────────────

test("two venues can both keep a section called 'main'", async () => {
  const db = makeDb();
  const a = makeDevice(); const b = makeDevice();
  applyRead(a, L1, []); applyRead(b, L2, []);
  await boSave(db, a, L1, rename(a.sections, 'main', 'Up'));
  await boSave(db, b, L2, rename(b.sections, 'main', 'Downstairs'));
  assert.equal(db.venue(L1).find(r => r.id === 'main').label, 'Up');
  assert.equal(db.venue(L2).find(r => r.id === 'main').label, 'Downstairs');
  const r1 = await readSections(db.client, L1);
  assert.deepEqual(labels(r1.sections), ['Up', 'Bar', 'Patio']);
});

test('Back Office switching venue: a venue with nothing saved shows the defaults, not the last venue', () => {
  const bo = makeDevice();
  applyRead(bo, L1, [{ id: 'main', label: 'Up', sort_order: 0 }]);
  applyRead(bo, L2, []);
  assert.deepEqual(labels(bo.sections), ['Main dining', 'Bar', 'Patio']);
});

// ── 4. Never hide a table ───────────────────────────────────────────────────────────────────

test('removing a section that still has tables is refused in plain words', () => {
  const up = { id: 'main', label: 'Up' };
  const tables = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, section: 'main', locationId: L1 }))
    .concat([{ id: 't1.2', section: 'main', parentId: 't1' }, { id: 'x', section: 'main', locationId: L2 }]);
  const sections = [up, { id: 'bar', label: 'Bar' }];
  assert.equal(removeSectionRefusal(up, { tables, sections, locationId: L1 }), 'Up still has 12 tables, move them first');
  // A table off the plan with an open order on a till still counts.
  assert.equal(removeSectionRefusal({ id: 'bar', label: 'Bar' }, { tables: [{ id: 'b1', section: 'bar', planRemoved: true }], sections }), 'Bar still has 1 table, move them first');
  assert.equal(removeSectionRefusal({ id: 'bar', label: 'Bar' }, { tables, sections, locationId: L1 }), null);
  assert.equal(removeSectionRefusal(up, { tables: [], sections: [up] }), 'Must keep at least one section');
});

test('Back Office: removeSection no longer moves tables to main; the builder checks first', () => {
  const store = read('../store/index.js');
  const rm = store.slice(store.indexOf('  removeSection: (id) => set('), store.indexOf('  // v4.6.56: reorder a section'));
  assert.doesNotMatch(rm, /section:'main'|tables:/);
  const fpb = read('../backoffice/sections/FloorPlanBuilder.jsx');
  assert.match(fpb, /removeSectionRefusal\(sec, \{ tables: tablesAtThisLocation/);
  assert.match(fpb, /if \(!removeSectionSaved\(editingSection\)\) return;/);
});

test('till: a table whose section is gone still shows (All, and an Other view); a removed assigned section shows All', () => {
  const sections = [{ id: 'main', label: 'Up' }, { id: 'bar', label: 'Bar' }, { id: 'snug', label: 'Snug', hidden: true }];
  const tables = [
    { id: 'a', section: 'main' }, { id: 'b', section: 'patio' }, { id: 'c', section: null },
    { id: 'd', section: 'snug' }, { id: 'a.2', section: 'main', parentId: 'a' },
  ];
  assert.deepEqual(tablesForSectionView(tables, sections, 'all').map(t => t.id), ['a', 'b', 'c']);
  assert.deepEqual(tablesForSectionView(tables, sections, OTHER_SECTION).map(t => t.id), ['b', 'c']);
  assert.deepEqual(orphanSectionTables(tables, sections).map(t => t.id), ['b', 'c']);
  assert.equal(effectiveSectionView('patio', sections, tables), 'all', 'a device profile assigned to a removed section');
  assert.equal(effectiveSectionView('main', sections, tables), 'main');
  assert.equal(effectiveSectionView(OTHER_SECTION, sections, [{ id: 'a', section: 'main' }]), 'all');
  const ts = read('../surfaces/TablesSurface.jsx');
  assert.match(ts, /tablesForSectionView\(tables, locationSections, sectionView\)/);
  assert.match(ts, /id: OTHER_SECTION, label: 'Other'/);
  assert.doesNotMatch(ts, /main: 'Main dining'/, 'canvas labels come from the venue list');
});

// ── 5. A failed or empty read keeps the saved sections ──────────────────────────────────────

test('a failed read, or an empty one, never puts the defaults back over saved sections', () => {
  const dev = makeDevice();
  applyRead(dev, L1, [{ id: 'main', label: 'Up', sort_order: 0 }, { id: 'bar', label: 'Bar', sort_order: 1 }]);
  applyRead(dev, L1, null);
  assert.deepEqual(labels(dev.sections), ['Up', 'Bar']);
  applyRead(dev, L1, []);
  assert.deepEqual(labels(dev.sections), ['Up', 'Bar']);
  // Fresh page, storage kept (offline boot): the device's copy of the saved list.
  dev.sections = defaultSections(); dev.loc = null;
  applyRead(dev, L1, null);
  assert.deepEqual(labels(dev.sections), ['Up', 'Bar']);
  // A push never replaces the saved list, and an empty pushed list is a no-op.
  onDevice(dev, () => {
    assert.deepEqual(labels(pickPushedSections({ pushed: DEFAULT_SECTIONS, saved: loadSavedSections(L1), current: dev.sections })), ['Up', 'Bar']);
  });
  const cur = [{ id: 'main', label: 'Pushed name' }];
  assert.equal(pickPushedSections({ pushed: [], saved: null, current: cur }), cur);
  assert.equal(pickPushedSections({ pushed: undefined, saved: null, current: cur }), cur);
});

test('a venue with nothing saved keeps its pushed list exactly as today', () => {
  const dev = makeDevice();
  dev.sections = [{ id: 'main', label: 'Main dining' }, { id: 'terrace', label: 'Terrace' }];
  applyRead(dev, L1, []);
  assert.deepEqual(labels(dev.sections), ['Main dining', 'Terrace']);
});

// ── 6. Before the migration the save reports plainly ────────────────────────────────────────

test('before migration 20260918c: the save fails with reason migration and nothing is written', async () => {
  const db = makeDb({ migrated: false });
  const bo = makeDevice();
  applyRead(bo, L1, []);
  const res = await boSave(db, bo, L1, rename(bo.sections, 'main', 'Up'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'migration');
  assert.equal(db.rows.size, 0);
  assert.match(MIGRATION_TEXT, /^Run the sections database update first/);
  assert.equal(isSectionsMigrationMissing({ code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' }), true);
  assert.equal(isSectionsMigrationMissing({ code: '23505', message: 'duplicate key' }), false);
  const fpb = read('../backoffice/sections/FloorPlanBuilder.jsx');
  assert.match(fpb, /migration: MIGRATION_TEXT/);
  assert.match(fpb, /setLocationSections\(prev\)/, 'a refused save puts the screen back');
});

test('another screen changed the sections: nothing is written, the latest list is shown', async () => {
  const db = makeDb();
  const a = makeDevice(); const b = makeDevice();
  applyRead(a, L1, []);
  await boSave(db, a, L1, rename(a.sections, 'main', 'Up'));
  applyRead(b, L1, (await readSections(db.client, L1)).sections);
  await boSave(db, b, L1, rename(b.sections, 'bar', 'Counter'));
  const res = await boSave(db, a, L1, rename(a.sections, 'patio', 'Garden'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'changed');
  assert.deepEqual(labels(db.venue(L1)), ['Up', 'Counter', 'Patio'], 'the other screen\'s change is kept');
  assert.deepEqual(labels(a.sections), ['Up', 'Counter', 'Patio'], 'the stale tab now shows the latest list');
  assert.equal((await boSave(db, a, L1, rename(a.sections, 'patio', 'Garden'))).ok, true);
});

test('a failed check read refuses the save', async () => {
  const db = makeDb();
  const bo = makeDevice();
  applyRead(bo, L1, []);
  db.fail.add('select');
  const res = await boSave(db, bo, L1, rename(bo.sections, 'main', 'Up'));
  assert.equal(res.reason, 'read');
  assert.equal(db.rows.size, 0);
});

// ── 7. Every load path reads the saved sections ─────────────────────────────────────────────

test('every load path applies the saved sections', () => {
  const tps = read('../sync/TablePlanSync.js');
  assert.match(tps, /applySavedSections\?\.\(loc, secRows\)/);
  const sb = read('../sync/SyncBridge.jsx');
  assert.match(sb, /applySavedSections\?\.\(locationId, Array\.isArray\(floorRes\.data\?\.sections\)/);
  const init = read('./useSupabaseInit.js');
  assert.match(init, /refreshTablePlan\(\{ locationId: locId, mode: 'upsertOnly'/);
  assert.doesNotMatch(init, /locationSections: fpSections/);
  const bo = read('../backoffice/BackOfficeApp.jsx');
  assert.match(bo, /refreshTablePlan\(\{ locationId, mode: 'full', reason: 'backoffice', backOffice: true \}\)/);
  assert.match(bo, /locationSections: pushSections/);
  const store = read('../store/index.js');
  assert.match(store, /pickPushedSections\(\{ pushed: snap\.locationSections, saved: savedSecs/);
  assert.match(store, /applySavedSections: \(loc, rows\) => \{[\s\S]{0,300}resolveSections\(/);
  const fpb = read('../backoffice/sections/FloorPlanBuilder.jsx');
  assert.match(fpb, /saveLocationSections\(next, loc, \{ base \}\)/);
  assert.match(fpb, /\{TILLS_TEXT\}/);
});

// Release review (18 Sep 2026): a plan read landing mid save could put the old list back on
// screen and the next edit then saved over the change; and a handheld whose assigned section
// was removed showed an empty floor.
test('a successful save puts the saved list back on screen', async () => {
  const fs = await import('node:fs');
  const store = fs.readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
  const i = store.indexOf('  markSectionsSaved: (loc, list) => {');
  const fn = store.slice(i, store.indexOf('\n  },', i));
  assert.ok(fn.includes('set({ locationSections: n,'), 'the screen shows what was saved');
});

test('a handheld restricted to a section with no tables left shows tables, not an empty floor', async () => {
  const fs = await import('node:fs');
  const list = fs.readFileSync(new URL('../surfaces/mpos/MTablesList.jsx', import.meta.url), 'utf8');
  const plan = fs.readFileSync(new URL('../surfaces/mpos/MFloorPlan.jsx', import.meta.url), 'utf8');
  assert.ok(list.includes('tables.some(t => t.section === assignedSection) ? assignedSection : null'));
  assert.ok(plan.includes('sections.includes(assignedSection) ? assignedSection : null'));
});
