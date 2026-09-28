// src/lib/shareCategory.test.js: a shared product's copy sits in THAT venue's copy of its
// category, never nowhere and never another venue's (lib/shareCategory.js).
//
// The ids are Coffee Boy's, 27 Sep 2026: Hot Pizzas made at Barnsley under Food, which Train
// Station owns, six pizzas shared from Barnsley to the five other venues.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  peerCatIdAt, categoryMasterIdOf, resolvePeerCategories, missingCategoryWords,
  fillCopyIfLanded, fillCopiesWaitingFor,
} from './shareCategory.js';

const V = {
  barnsley: 'c5dd8483-f250-4868-9e46-709a74d78e2a',
  trainStation: '3f915972-7107-4f70-9b3d-de80ba9ab0c2',
  huddersfield: '5435c88e-6a58-4ebf-b2a0-b5ed5c9bdaa9',
  leeds: '1e252e7c-c875-4971-b91d-1e945c26956b',
  preston: 'ab45c80b-416d-4631-93e2-05048e52e0fa',
  headingly: '24786cbd-efe6-40d9-8424-46e242820abf',
};
const FOOD = 'cat-1790049850590';          // master at Train Station
const HOT = 'cat-1790477045410';           // master at Barnsley
const PEERS = ['trainStation', 'huddersfield', 'leeds', 'preston', 'headingly'];

const categoryRows = () => {
  const rows = [
    { id: FOOD, location_id: V.trainStation, master_id: FOOD, label: 'Food', scope: 'shared', parent_id: null },
    { id: HOT, location_id: V.barnsley, master_id: HOT, label: 'Hot Pizzas', scope: 'shared', parent_id: `${FOOD}_74d78e2a` },
  ];
  for (const k of ['barnsley', 'huddersfield', 'leeds', 'preston', 'headingly']) {
    rows.push({ id: peerCatIdAt(FOOD, V.trainStation, V[k]), location_id: V[k], master_id: FOOD, label: 'Food', scope: 'shared' });
  }
  return rows;
};

// ── A small PostgREST stand in: select / eq / is / in / order / range / maybeSingle, update
// with .select() handing back the rows it changed, insert. `beforeWrite` runs just before a
// write lands (a second window, or a category arriving, at exactly the wrong moment).
function fakeDb(tables, { failReads = null, beforeWrite = null } = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  const log = [];
  const from = (table) => {
    const q = { op: 'select', filters: [], patch: null, order: null, range: null, single: false, want: false };
    const match = (r) => q.filters.every((f) => f(r));
    const run = () => {
      if (q.op === 'update') {
        if (beforeWrite) beforeWrite({ table, db, patch: q.patch });
        const hit = [];
        db[table] = (db[table] || []).map((r) => {
          if (!match(r)) return r;
          const n = { ...r, ...q.patch };
          hit.push(n);
          return n;
        });
        log.push({ table, op: 'update', ids: hit.map((r) => r.id), patch: q.patch });
        return { data: q.want ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (failReads && failReads(table)) return { data: null, error: { message: 'read failed (fake)' } };
      let rows = (db[table] || []).filter(match).map((r) => ({ ...r }));
      if (q.order) rows.sort((a, b) => (String(a[q.order]) < String(b[q.order]) ? -1 : 1));
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    };
    const b = {
      select() { if (q.op === 'update') q.want = true; return b; },
      eq(c, v) { q.filters.push((r) => r[c] != null && String(r[c]) === String(v)); return b; },
      is(c, v) { q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      in(c, vals) { const s = new Set((vals || []).map(String)); q.filters.push((r) => r[c] != null && s.has(String(r[c]))); return b; },
      order(c) { q.order = c; return b; },
      range(a, z) { q.range = [a, z]; return b; },
      maybeSingle() { q.single = true; return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
    };
    return b;
  };
  return { from, db, log };
}

const presentFrom = (client, locationId) => async (ids) => {
  const { data, error } = await client.from('menu_categories').select('id').eq('location_id', locationId).in('id', ids);
  if (error) throw error;
  return new Set((data || []).map((r) => r.id));
};

const masterOfFrom = (client) => async (id) => {
  const { data } = await client.from('menu_categories').select('*').eq('id', id).maybeSingle();
  if (!data) return null;
  if (!data.master_id || data.master_id === data.id) return data;
  const { data: m } = await client.from('menu_categories').select('*').eq('id', data.master_id).maybeSingle();
  return m || data;
};

test('the venue that owns a category holds the bare id; every other venue the suffixed copy', () => {
  // Train Station owns Food: its Hot Pizzas copy's parent is the bare id. That is right.
  assert.equal(peerCatIdAt(FOOD, V.trainStation, V.trainStation), FOOD);
  assert.equal(peerCatIdAt(FOOD, V.trainStation, V.leeds), `${FOOD}_5c26956b`);
  assert.equal(peerCatIdAt(HOT, V.barnsley, V.trainStation), `${HOT}_ba9ab0c2`);
  assert.equal(peerCatIdAt(HOT, V.barnsley, V.huddersfield), `${HOT}_5c9bdaa9`);
  assert.equal(peerCatIdAt(HOT, null, V.preston), `${HOT}_8e52e0fa`, 'an unknown owner is addressed as a copy');
  assert.equal(categoryMasterIdOf({ id: `${HOT}_5c26956b`, master_id: HOT }), HOT);
  assert.equal(categoryMasterIdOf({ id: HOT, master_id: null }), HOT);
});

test('the 27 Sep share: every venue maps both categories, Train Station to its own bare Food', async () => {
  const cats = categoryRows();
  for (const k of PEERS) cats.push({ id: peerCatIdAt(HOT, V.barnsley, V[k]), location_id: V[k], master_id: HOT, label: 'Hot Pizzas' });
  const client = fakeDb({ menu_categories: cats });
  for (const k of PEERS) {
    let ensured = 0;
    const plan = await resolvePeerCategories({
      sourceIds: [HOT, `${FOOD}_74d78e2a`], peerLocId: V[k],
      masterOf: masterOfFrom(client), presentAt: presentFrom(client, V[k]), ensureAt: async () => { ensured++; },
    });
    assert.equal(plan.idFor(HOT), peerCatIdAt(HOT, V.barnsley, V[k]), k);
    assert.equal(plan.idFor(`${FOOD}_74d78e2a`), k === 'trainStation' ? FOOD : `${FOOD}_${V[k].slice(-8)}`, k);
    assert.deepEqual(plan.missing, [], k);
    assert.equal(plan.unknown, false);
    assert.equal(ensured, 0, 'nothing is created when everything is there');
  }
});

test('a category copy missing at a venue is created first, once, then used', async () => {
  const client = fakeDb({ menu_categories: categoryRows() });   // no Hot Pizzas copies anywhere yet
  const made = [];
  const plan = await resolvePeerCategories({
    sourceIds: [HOT, HOT, `${FOOD}_74d78e2a`], peerLocId: V.leeds,
    masterOf: masterOfFrom(client), presentAt: presentFrom(client, V.leeds),
    ensureAt: async (m) => {
      made.push(m.id);
      client.db.menu_categories.push({ id: `${m.id}_5c26956b`, location_id: V.leeds, master_id: m.id, label: m.label });
    },
  });
  assert.deepEqual(made, [HOT], 'made from the master, once, and only what was missing');
  assert.equal(plan.idFor(HOT), `${HOT}_5c26956b`);
  assert.equal(plan.idFor(`${FOOD}_74d78e2a`), `${FOOD}_5c26956b`);
  assert.deepEqual(plan.missing, []);
});

test('a category that cannot be made there is none, reported, never a dangling id', async () => {
  const client = fakeDb({ menu_categories: categoryRows() });
  const plan = await resolvePeerCategories({
    sourceIds: [HOT, `${FOOD}_74d78e2a`], peerLocId: V.preston,
    masterOf: masterOfFrom(client), presentAt: presentFrom(client, V.preston),
    ensureAt: async () => { throw new Error('refused (fake)'); },
  });
  assert.equal(plan.idFor(HOT), null, 'the copy is written with no category, not `cat-..._8e52e0fa` pointing at nothing');
  assert.equal(plan.wantFor(HOT), `${HOT}_8e52e0fa`, 'what it should get when the category arrives');
  assert.equal(plan.idFor(`${FOOD}_74d78e2a`), `${FOOD}_8e52e0fa`, 'the parent that IS there is still used');
  assert.deepEqual(plan.missing.map((m) => [m.sourceId, m.peerId, m.label]), [[HOT, `${HOT}_8e52e0fa`, 'Hot Pizzas']]);
  assert.match(missingCategoryWords(plan.missing[0]), /category 'Hot Pizzas' \(not at that venue yet; the copy gets it when it arrives\)/);
});

test('a failed read is never taken as "there", and nothing is created on it', async () => {
  const client = fakeDb({ menu_categories: categoryRows() }, { failReads: () => true });
  let ensured = 0;
  const plan = await resolvePeerCategories({
    sourceIds: [HOT], peerLocId: V.leeds,
    masterOf: async () => ({ id: HOT, location_id: V.barnsley, label: 'Hot Pizzas' }),
    presentAt: presentFrom(client, V.leeds), ensureAt: async () => { ensured++; },
  });
  assert.equal(plan.unknown, true);
  assert.equal(plan.idFor(HOT), null);
  assert.equal(ensured, 0);
  assert.match(missingCategoryWords(plan.missing[0], { unknown: true }), /could not be checked there/);
});

test('a category with no master to place is unmapped and said, not written as another venue id', async () => {
  const plan = await resolvePeerCategories({
    sourceIds: ['cat-local-only'], peerLocId: V.leeds,
    masterOf: async () => null, presentAt: async () => new Set(), ensureAt: async () => { throw new Error('not called'); },
  });
  assert.equal(plan.idFor('cat-local-only'), null);
  assert.equal(plan.wantFor('cat-local-only'), null);
  assert.match(missingCategoryWords(plan.missing[0]), /not shared, so it has no copy there/);
});

// ── The race: a product copy and its category copy landing in either order ──────────────────

const pizzaWorld = ({ withHotAt = [] } = {}) => {
  const cats = categoryRows();
  for (const k of withHotAt) cats.push({ id: peerCatIdAt(HOT, V.barnsley, V[k]), location_id: V[k], master_id: HOT, label: 'Hot Pizzas' });
  const item = (id, location_id, extra = {}) => ({ id, location_id, name: id, type: 'simple', sold_alone: true, archived: false, updated_at: '2026-09-27T18:00:07.276029+00:00', ...extra });
  return {
    menu_categories: cats,
    menu_items: [
      // masters at Barnsley
      item('m-1790477204214', V.barnsley, { name: 'Calabrese Pizza', cat: HOT, cats: [`${FOOD}_74d78e2a`], master_id: null }),
      item('m-1790477258966', V.barnsley, { name: 'The Texan Pizza', cat: HOT, cats: [`${FOOD}_74d78e2a`], master_id: null }),
      item('m-latte', V.barnsley, { name: 'Latte', cat: 'cat-coffee', cats: [], master_id: 'm-latte' }),
      item('m-sub-dough', V.barnsley, { name: 'Dough ball', type: 'subitem', sold_alone: true, cat: HOT, cats: [], master_id: 'm-sub-dough' }),
      item('m-sub-oil', V.barnsley, { name: 'Chilli oil', type: 'subitem', sold_alone: false, cat: HOT, cats: [], master_id: 'm-sub-oil' }),
      // copies at Leeds written before Hot Pizzas landed there
      item('m-1790477204214_5c26956b', V.leeds, { cat: null, cats: [`${FOOD}_5c26956b`], master_id: 'm-1790477204214' }),
      item('m-1790477258966_5c26956b', V.leeds, { cat: null, cats: [], master_id: 'm-1790477258966' }),
      item('m-sub-dough_5c26956b', V.leeds, { type: 'subitem', sold_alone: true, cat: null, cats: [], master_id: 'm-sub-dough' }),
      item('m-sub-oil_5c26956b', V.leeds, { type: 'subitem', sold_alone: false, cat: null, cats: [], master_id: 'm-sub-oil' }),
      item('m-latte_5c26956b', V.leeds, { cat: null, cats: [], master_id: 'm-latte' }),
      // not for this fill: an archived copy, a Leeds product of its own, Preston's copy
      item('m-1790477204214_arch', V.leeds, { cat: null, cats: [], master_id: 'm-1790477204214', archived: true }),
      item('m-leeds-own', V.leeds, { cat: null, cats: [], master_id: null }),
      item('m-1790477204214_8e52e0fa', V.preston, { cat: null, cats: [], master_id: 'm-1790477204214' }),
    ],
  };
};
const row = (client, id) => client.db.menu_items.find((r) => r.id === id);

test('race, category second: when Hot Pizzas lands at Leeds, the copies waiting for it there get it', async () => {
  const client = fakeDb(pizzaWorld({ withHotAt: ['leeds'] }));
  const res = await fillCopiesWaitingFor({ client, locationId: V.leeds, catMasterId: HOT, peerCatId: `${HOT}_5c26956b`, now: () => 'T' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.filled.map((f) => f.id).sort(), ['m-1790477204214_5c26956b', 'm-1790477258966_5c26956b', 'm-sub-dough_5c26956b']);
  assert.equal(row(client, 'm-1790477204214_5c26956b').cat, `${HOT}_5c26956b`);
  assert.deepEqual(row(client, 'm-1790477204214_5c26956b').cats, [`${FOOD}_5c26956b`], 'its "also in" is left as it was');
  assert.equal(row(client, 'm-sub-dough_5c26956b').cat, `${HOT}_5c26956b`, 'a sold alone sub item is a product there too');
  assert.equal(row(client, 'm-sub-oil_5c26956b').cat, null, 'an option only sub item never renders in a grid');
  assert.equal(row(client, 'm-latte_5c26956b').cat, null, 'a copy whose master is in another category');
  assert.equal(row(client, 'm-1790477204214_arch').cat, null, 'archived');
  assert.equal(row(client, 'm-leeds-own').cat, null, 'a venue product that is not a copy');
  assert.equal(row(client, 'm-1790477204214_8e52e0fa').cat, null, 'another venue');
  for (const w of client.log) assert.ok(w.ids.every((id) => row(client, id).location_id === V.leeds), 'writes stay at Leeds');
});

test('the fill never replaces a category the venue chose meanwhile (compare and set)', async () => {
  const client = fakeDb(pizzaWorld({ withHotAt: ['leeds'] }), {
    beforeWrite: ({ db }) => {
      // a manager at Leeds puts the Calabrese in their own Specials just before the fill lands
      const r = db.menu_items.find((x) => x.id === 'm-1790477204214_5c26956b');
      if (r.cat == null) { r.cat = 'cat-leeds-specials'; r.updated_at = '2026-09-27T18:05:00+00:00'; }
    },
  });
  const res = await fillCopiesWaitingFor({ client, locationId: V.leeds, catMasterId: HOT, peerCatId: `${HOT}_5c26956b` });
  assert.equal(row(client, 'm-1790477204214_5c26956b').cat, 'cat-leeds-specials');
  assert.ok(res.skipped.some((s) => s.id === 'm-1790477204214_5c26956b'));
});

test('a copy that already has a category is never touched by the fill', async () => {
  const world = pizzaWorld({ withHotAt: ['leeds'] });
  world.menu_items.find((r) => r.id === 'm-1790477258966_5c26956b').cat = 'cat-leeds-own';
  const client = fakeDb(world);
  const res = await fillCopiesWaitingFor({ client, locationId: V.leeds, catMasterId: HOT, peerCatId: `${HOT}_5c26956b` });
  assert.ok(!res.filled.some((f) => f.id === 'm-1790477258966_5c26956b'));
  assert.equal(row(client, 'm-1790477258966_5c26956b').cat, 'cat-leeds-own');
});

test('race, category first: it lands between the check and the product write, and the look after the write fills it', async () => {
  const client = fakeDb(pizzaWorld());
  const present = presentFrom(client, V.headingly);
  // 1. the share checks Headingly: Hot Pizzas is not there, and making it fails this time
  const plan = await resolvePeerCategories({
    sourceIds: [HOT, `${FOOD}_74d78e2a`], peerLocId: V.headingly,
    masterOf: masterOfFrom(client), presentAt: present, ensureAt: async () => { throw new Error('timeout (fake)'); },
  });
  assert.equal(plan.idFor(HOT), null);
  // 2. another window's share lands the category copy (its own fill ran BEFORE our product existed)
  client.db.menu_categories.push({ id: `${HOT}_42820abf`, location_id: V.headingly, master_id: HOT, label: 'Hot Pizzas' });
  // 3. our product copy is written as the plan says: no category, Food as "also in"
  const peerCats = [`${FOOD}_74d78e2a`].map(plan.idFor).filter(Boolean);
  client.db.menu_items.push({ id: 'm-1790477204214_42820abf', location_id: V.headingly, master_id: 'm-1790477204214', cat: null, cats: peerCats, archived: false });
  // 4. the look after the write
  const late = await fillCopyIfLanded({ client, copyId: 'm-1790477204214_42820abf', locationId: V.headingly,
    cat: plan.wantFor(HOT), cats: [], writtenCats: peerCats, presentAt: present, now: () => 'T' });
  assert.equal(late.filled, true);
  assert.equal(row(client, 'm-1790477204214_42820abf').cat, `${HOT}_42820abf`);
  assert.deepEqual(row(client, 'm-1790477204214_42820abf').cats, [`${FOOD}_42820abf`]);
});

test('the look after the write does nothing while the category is still missing, or once the copy has one', async () => {
  const client = fakeDb(pizzaWorld());
  const present = presentFrom(client, V.leeds);
  const still = await fillCopyIfLanded({ client, copyId: 'm-1790477258966_5c26956b', locationId: V.leeds, cat: `${HOT}_5c26956b`, presentAt: present });
  assert.equal(still.filled, false);
  assert.equal(row(client, 'm-1790477258966_5c26956b').cat, null);
  client.db.menu_categories.push({ id: `${HOT}_5c26956b`, location_id: V.leeds, master_id: HOT });
  row(client, 'm-1790477258966_5c26956b').cat = 'cat-leeds-own';
  const kept = await fillCopyIfLanded({ client, copyId: 'm-1790477258966_5c26956b', locationId: V.leeds, cat: `${HOT}_5c26956b`, presentAt: present });
  assert.equal(kept.filled, false);
  assert.equal(row(client, 'm-1790477258966_5c26956b').cat, 'cat-leeds-own');
});

test('both orders end the same way: every waiting copy in its venue\'s Hot Pizzas', async () => {
  // Five venues, the category landing before or after each product copy, alternately.
  const client = fakeDb(pizzaWorld());
  client.db.menu_items = client.db.menu_items.filter((r) => r.location_id === V.barnsley);
  for (const [i, k] of PEERS.entries()) {
    const pid = peerCatIdAt(HOT, V.barnsley, V[k]);
    const land = async () => {
      client.db.menu_categories.push({ id: pid, location_id: V[k], master_id: HOT, label: 'Hot Pizzas' });
      await fillCopiesWaitingFor({ client, locationId: V[k], catMasterId: HOT, peerCatId: pid });
    };
    const categoryFirst = i % 2 === 0;
    if (categoryFirst) await land();
    const plan = await resolvePeerCategories({ sourceIds: [HOT], peerLocId: V[k], masterOf: masterOfFrom(client), presentAt: presentFrom(client, V[k]), ensureAt: async () => {} });
    const copyId = `m-1790477204214_${V[k].slice(-8)}`;
    client.db.menu_items.push({ id: copyId, location_id: V[k], master_id: 'm-1790477204214', cat: plan.idFor(HOT), cats: [], archived: false, type: 'simple', sold_alone: true, updated_at: 'U' });
    if (!plan.idFor(HOT)) await fillCopyIfLanded({ client, copyId, locationId: V[k], cat: plan.wantFor(HOT), presentAt: presentFrom(client, V[k]) });
    if (!categoryFirst) await land();
    assert.equal(row(client, copyId).cat, pid, `${k} (${categoryFirst ? 'category first' : 'product first'})`);
  }
});

// ── Wiring: db.js cannot be imported under node (it builds the Supabase client), so these pin
// that the share paths use the pieces above.
const DB = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
const between = (src, a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `found ${a}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j > i, `found the end of ${a}`);
  return src.slice(i, j);
};

test('wiring: a share checks every category at the venue and looks again after the write', () => {
  assert.ok(DB.includes("from './shareCategory'"), 'static import');
  const share = between(DB, 'export const setMenuItemScope = async', 'export const propagateScopedEdit');
  assert.match(share, /resolvePeerCategories\(/);
  assert.match(share, /ensureAt: \(m\) => ensureCategoryAt\(m, peerLocId, newScope\)/);
  assert.match(share, /const peerCat = catPlan\.idFor\(item\.cat\)/);
  assert.match(share, /srcCats\.map\(catPlan\.idFor\)\.filter\(Boolean\)/);
  assert.match(share, /fillCopyIfLanded\(\{ client: supabase, copyId: peerId,/);
  assert.match(share, /fillCopyIfLanded\(\{ client: supabase, copyId: peerVariantId,/);
  assert.match(share, /missingCategoryWords\(/, 'a missing category is reported');
  assert.doesNotMatch(share, /peerCatForSourceCat/, 'no id from arithmetic alone');
});

test('wiring: a category copy that lands fills the copies waiting for it; one venue mode touches one venue', () => {
  const cat = between(DB, 'export const setMenuCategoryScope = async', 'export const fetchMenuCategoryLinks');
  assert.match(cat, /if \(!existingPeer\) \{[\s\S]*?fillCopiesWaitingFor\(\{ client: supabase, locationId: peerLocId, catMasterId: masterId, peerCatId: peerId \}\)/);
  assert.match(cat, /if \(onlyPeerLocId && peerLocId !== onlyPeerLocId\) continue;/);
  assert.match(cat, /return setMenuCategoryScope\(master, newScope, _visited, opts\)/, 'a copy redirects to its master, keeping the one venue');
  const ensure = between(DB, 'const ensureCategoryAt = async', 'const shareModifierGroupsToLocation');
  assert.match(ensure, /if \(!s \|\| s === 'local'\) return null;/, 'never demotes');
  assert.match(ensure, /\{ onlyPeerLocId: peerLocId \}/);
});

test('wiring: a sold alone sub item copy uses the same check and look after the write', () => {
  const sub = between(DB, 'const shareModifierGroupsToLocation = async', '// Copy one group (recursing');
  assert.match(sub, /resolvePeerCategories\(/);
  assert.match(sub, /ensureAt: \(m\) => ensureCategoryAt\(m, peerLocId, null\)/, 'a local category is not shared from a group copy');
  assert.match(sub, /fillCopyIfLanded\(/);
});
