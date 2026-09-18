/**
 * ezcaterMenuSync.test.js
 *
 * "Sync ezCater menu" (18 Sep 2026): every item, size and option on the venue's current ezCater
 * menus is written to ezcater_item_links BEFORE any order, matched by name at sync time, and an
 * order line carrying a published id lands on the synced row.
 *
 *   supabase/functions/_shared/ezcaterMenu.ts           reading the menu (schema driven query)
 *   supabase/functions/_shared/ezcaterMenuSync.ts       the plan, the writes, the re-syncs
 *   supabase/functions/_shared/ezcater-match-ingest.ts  an order resolving to a synced row, paging
 *
 * We may not call ezCater's live API, so the menu here has the Potbelly Test shape proven live:
 * categories, sized items, option groups (Bread 1-1, Chip Selection 1-1, Add 0-1), every size
 * with an originalItemSizeId different from its id.
 *
 * Run: `npm test`, or `node --test src/lib/ezcaterMenuSync.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickLevelFields, buildMenuSelection, menuSelectionFor, currentMenus, flattenMenu, listMenus, PROVEN_MENU_SELECTION,
} from '../../supabase/functions/_shared/ezcaterMenu.ts';
import {
  syncEntities, planMenuSync, syncVenueMenus, resyncForUnseen, syncDue, sizeRowKey, SIZE_KEY_SEP,
  applyMenuSync, nextPriorIds, EZ_PRIOR_IDS_MAX, liveUnresolved, claimSyncLock, dueVenuesInOrder, syncDueVenues,
} from '../../supabase/functions/_shared/ezcaterMenuSync.ts';
import {
  planLineMatches, readAllLinks, unseenMenuIds, matchQueueRow, menuItemsForMatch, modifierGroupsForMatch,
  decideWithSyncedRow, hasSyncedKind,
} from '../../supabase/functions/_shared/ezcater-match-ingest.ts';
import { toRow, saveBody, syncSummary, rowsFrom, replacedBySizes } from './ezcaterItemRows.js';

const LOC = 'loc-1';
const NOW = '2026-09-18T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

// ── An in memory Supabase: select/eq/is/not/in/order/range/limit/maybeSingle, insert, upsert, update

function fakeDb(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  const log = [];
  const keysFor = (table, opts) => String(opts?.onConflict || (table === 'ezcater_menu_syncs' ? 'location_id' : 'id')).split(',');
  const from = (table) => {
    const st = { op: 'select', filters: [], orders: [], range: null, lim: null, single: false, payload: null, opts: null };
    const run = async () => {
      const rows = (db[table] = db[table] || []);
      const match = (r) => st.filters.every((f) => f(r));
      if (st.op === 'select') {
        let hit = rows.filter(match);
        if (st.orders.length) {
          hit = hit.slice().sort((a, b) => {
            for (const c of st.orders) { const x = String(a[c] ?? ''); const y = String(b[c] ?? ''); if (x !== y) return x < y ? -1 : 1; }
            return 0;
          });
        }
        if (st.range) hit = hit.slice(st.range[0], st.range[1] + 1);
        if (st.lim != null) hit = hit.slice(0, st.lim);
        const data = st.single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => JSON.parse(JSON.stringify(r)));
        return { data, error: null };
      }
      if (st.op === 'upsert') {
        const list = Array.isArray(st.payload) ? st.payload : [st.payload];
        const keys = keysFor(table, st.opts);
        for (const p of list) {
          const found = rows.find((r) => keys.every((k) => r[k] === p[k]));
          if (found) { if (!st.opts?.ignoreDuplicates) Object.assign(found, JSON.parse(JSON.stringify(p))); }
          else rows.push(JSON.parse(JSON.stringify(p)));
        }
        log.push({ table, op: 'upsert', n: list.length });
        return { data: null, error: null };
      }
      if (st.op === 'insert') {
        // A real INSERT: a row with the same primary key is a unique violation, as in Postgres.
        const list = Array.isArray(st.payload) ? st.payload : [st.payload];
        const keys = keysFor(table, null);
        for (const p of list) {
          if (rows.some((r) => keys.every((k) => r[k] === p[k]))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        for (const p of list) rows.push(JSON.parse(JSON.stringify(p)));
        log.push({ table, op: 'insert', n: list.length });
        return { data: null, error: null };
      }
      if (st.op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(st.payload)));
        log.push({ table, op: 'update', n: hit.length, payload: st.payload });
        // .update().select() returns the rows it changed, as PostgREST does.
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      return { data: null, error: null };
    };
    const api = {
      select() { return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
      not(c, op, v) { if (op === 'is' && v === null) st.filters.push((r) => r[c] != null); return api; },
      order(c) { st.orders.push(c); return api; },
      range(a, z) { st.range = [a, z]; return api; },
      limit(n) { st.lim = n; return api; },
      maybeSingle() { st.single = true; return run(); },
      single() { st.single = true; return run(); },
      then(ok, bad) { return run().then(ok, bad); },
    };
    return api;
  };
  return { from, db, log };
}

// ── Our menu ────────────────────────────────────────────────────────────────

const OUR_ITEMS = [
  { id: 'm-turkey', name: 'Turkey Breast' },
  { id: 'm-wreck', name: 'A Wreck' },
  { id: 'm-soup-s', name: 'Soup Small' },
  { id: 'm-soup-l', name: 'Soup Large' },
  { id: 'm-chili-s', name: 'Chili Small' },
  { id: 'm-chips', name: 'Chips' },
  { id: 'm-box', name: 'Box Lunch' },
  { id: 'm-wreck-2', name: 'Wreck Deluxe' },
];
const OUR_GROUPS = [
  { id: 'g-bread', name: 'Bread', options: [{ id: 'o-white', name: 'White' }, { id: 'o-wheat', name: 'Wheat' }] },
  { id: 'g-add', name: 'Add', options: [{ id: 'o-bacon', name: 'Bacon' }] },
  { id: 'g-chips', name: 'Chip Selection', options: [{ id: 'o-seasalt', name: 'Sea Salt' }] },
];

const at = (rows) => rows.map((r) => ({ ...r, location_id: LOC }));

// ── The ezCater menu, Potbelly Test shaped ───────────────────────────────────

const v = (name, pub, orig) => ({ id: pub, name, originalCustomizationValueId: orig });
const bread = (tag, ver) => ({
  id: `ct-bread-${tag}-${ver}`, name: 'Bread', originalCustomizationTypeId: `orig-ct-bread-${tag}`, selectionRangeStart: 1, selectionRangeEnd: 1,
  values: [v('White', `pub-white-${tag}-${ver}`, `orig-white-${tag}`), v('Wheat', `pub-wheat-${tag}-${ver}`, `orig-wheat-${tag}`)],
});
const add = (tag, ver) => ({
  id: `ct-add-${tag}-${ver}`, name: 'Add', originalCustomizationTypeId: `orig-ct-add-${tag}`, selectionRangeStart: 0, selectionRangeEnd: 1,
  values: [v('Bacon', `pub-bacon-${tag}-${ver}`, `orig-bacon-${tag}`), v('Avocado', `pub-avocado-${tag}-${ver}`, `orig-avocado-${tag}`)],
});
const size = (name, tag, ver, customizationTypes = []) => ({
  id: `pub-${tag}-${ver}`, name, status: 'ACTIVE', originalItemSizeId: `orig-${tag}`, customizationTypes,
});

/** ver changes every published id (a republish); originals stay. wreckName tests a rename. */
function potbelly(ver = 'v1', { wreckName = 'A Wreck' } = {}) {
  return {
    id: 'menu-potbelly', name: 'Potbelly Test', startDate: '2026-01-01', endDate: null,
    categories: [
      {
        id: `cat-sand-${ver}`, name: 'Sandwiches', originalCategoryId: 'orig-cat-sand',
        items: [
          { id: `item-turkey-${ver}`, name: 'Turkey Breast', originalItemId: 'orig-item-turkey', sizes: [size('Original', 'turkey', ver, [bread('turkey', ver), add('turkey', ver)])] },
          { id: `item-wreck-${ver}`, name: wreckName, originalItemId: 'orig-item-wreck', sizes: [size('Original', 'wreck', ver, [bread('wreck', ver)])] },
        ],
      },
      {
        id: `cat-soup-${ver}`, name: 'Soups', originalCategoryId: 'orig-cat-soup',
        items: [
          { id: `item-soup-${ver}`, name: 'Soup', originalItemId: 'orig-item-soup', sizes: [size('Small', 'soup-s', ver), size('Large', 'soup-l', ver)] },
          { id: `item-chili-${ver}`, name: 'Chili', originalItemId: 'orig-item-chili', sizes: [size('Small', 'chili-s', ver), size('Large', 'chili-l', ver)] },
        ],
      },
      {
        id: `cat-sides-${ver}`, name: 'Sides', originalCategoryId: 'orig-cat-sides',
        items: [
          {
            id: `item-chips-${ver}`, name: 'Chips', originalItemId: 'orig-item-chips',
            sizes: [size('Bag', 'chips', ver, [{
              id: `ct-chips-${ver}`, name: 'Chip Selection', originalCustomizationTypeId: 'orig-ct-chips', selectionRangeStart: 1, selectionRangeEnd: 1,
              values: [v('Sea Salt', `pub-seasalt-${ver}`, 'orig-seasalt'), v('BBQ', `pub-bbq-${ver}`, 'orig-bbq')],
            }])],
          },
        ],
      },
      {
        id: `cat-box-${ver}`, name: 'Boxed Lunches', originalCategoryId: 'orig-cat-box',
        items: [
          { id: `item-box-${ver}`, name: 'Box Lunch', originalItemId: 'orig-item-box', sizes: [size('Serves 10', 'box-10', ver), size('Serves 20', 'box-20', ver)] },
        ],
      },
    ],
  };
}

// ── ezCater's schema, as __type answers ──────────────────────────────────────

const S = (name) => ({ name, type: { kind: 'SCALAR', name: 'String', ofType: null }, args: [] });
const E = (name) => ({ name, type: { kind: 'ENUM', name: 'Status', ofType: null }, args: [] });
const L = (name, type) => ({ name, type: { kind: 'NON_NULL', name: null, ofType: { kind: 'LIST', name: null, ofType: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: type } } } }, args: [] });
const O = (name, type) => ({ name, type: { kind: 'OBJECT', name: type, ofType: null }, args: [] });
const SCHEMA = {
  Query: { name: 'Query', fields: [O('menu', 'Menu'), O('menus', 'MenuBaseConnection'), O('order', 'Order')] },
  MenuBaseConnection: { name: 'MenuBaseConnection', fields: [L('nodes', 'MenuBase'), O('pageInfo', 'PageInfo')] },
  PageInfo: { name: 'PageInfo', fields: [S('hasNextPage'), S('endCursor')] },
  Menu: { name: 'Menu', fields: [S('id'), S('name'), S('startDate'), S('endDate'), L('categories', 'Category'), L('tablewareItems', 'Tableware')] },
  Category: { name: 'Category', fields: [S('id'), S('name'), S('description'), S('originalCategoryId'), L('items', 'Item')] },
  Item: { name: 'Item', fields: [S('id'), S('name'), S('noteToCaterer'), S('originalItemId'), L('sizes', 'Size')] },
  Size: { name: 'Size', fields: [S('id'), S('name'), S('serves'), E('status'), S('originalItemSizeId'), L('customizationTypes', 'CustomizationType')] },
  CustomizationType: { name: 'CustomizationType', fields: [S('id'), S('name'), S('originalCustomizationTypeId'), S('selectionRangeStart'), S('selectionRangeEnd'), L('values', 'CustomizationValue')] },
  // No status here, and a money OBJECT: neither may be asked for as a leaf.
  CustomizationValue: { name: 'CustomizationValue', fields: [S('id'), S('name'), S('originalCustomizationValueId'), O('price', 'Money')] },
};

/** A fake ezCater: schema, a paged menu list (one old menu, one current), and the menu itself. */
function fakeEz(menu, { refuseSchema = false, calls = [] } = {}) {
  return async (op, query, vars = {}) => {
    calls.push({ op, query, vars });
    if (op === 'ServOsEzRootType') { if (refuseSchema) throw new Error('introspection disabled'); return { __schema: { queryType: { name: 'Query' } } }; }
    if (op === 'ServOsEzMenuType') { if (refuseSchema) throw new Error('introspection disabled'); return { __type: SCHEMA[vars.name] || null }; }
    if (op === 'ServOsEzMenus') {
      if (!vars.after) return { menus: { nodes: [{ id: 'menu-old', name: 'Old', startDate: '2025-01-01', endDate: '2025-12-31' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } };
      return { menus: { nodes: [{ id: menu.id, name: menu.name, startDate: menu.startDate, endDate: menu.endDate }], pageInfo: { hasNextPage: false, endCursor: null } } };
    }
    if (op === 'ServOsEzMenu') {
      assert.equal(vars.id, menu.id, 'only the current menu is read');
      return { menu };
    }
    throw new Error('unexpected operation ' + op);
  };
}

const baseTables = (extra = {}) => ({
  ezcater_item_links: [],
  ezcater_menu_syncs: [],
  ezcater_caterers: [{ caterer_uuid: 'cat-1', location_id: LOC, connection_id: 'conn-1', active: true }],
  ezcater_connections: [{ id: 'conn-1', api_token: 'tok', api_url: null, status: 'connected' }],
  menu_items: at(OUR_ITEMS),
  modifier_groups: at(OUR_GROUPS),
  locations: [{ id: LOC, timezone: 'America/New_York' }],
  catering_site_settings: [],
  ...extra,
});

const sync = (sb, menu, opts = {}) => syncVenueMenus(sb, null, LOC, { askFactory: () => fakeEz(menu, opts), nowIso: opts.nowIso || NOW, nowMs: Date.parse(opts.nowIso || NOW) });
const row = (sb, kind, key) => sb.db.ezcater_item_links.find((r) => r.kind === kind && r.ez_key === key);

// ── Reading the menu ─────────────────────────────────────────────────────────

test('menu query is built from ezCater\'s own schema: only fields that exist, leaves only, original ids included', async () => {
  const calls = [];
  const sel = await menuSelectionFor(fakeEz(potbelly(), { calls }));
  assert.equal(sel.source, 'schema');
  assert.equal(sel.menusPaged, true);
  assert.match(sel.selection, /values \{ id name originalCustomizationValueId \}/);
  assert.doesNotMatch(sel.selection, /price/, 'an object is never asked for as a leaf');
  assert.doesNotMatch(sel.selection, /values \{[^}]*status/, 'a field the type lacks is never asked for');
  assert.match(sel.selection, /sizes \{ id name status originalItemSizeId customizationTypes/);
  assert.ok(calls.every((c) => /^(query) ServOs\w+/.test(c.query)), 'every operation is named');
});

test('menu query falls back to the fields proven live when introspection is refused', async () => {
  const sel = await menuSelectionFor(fakeEz(potbelly(), { refuseSchema: true }));
  assert.equal(sel.source, 'proven');
  assert.equal(sel.selection, PROVEN_MENU_SELECTION);
});

test('pickLevelFields refuses a level with no id or name, and skips a child that needs arguments', () => {
  assert.equal(pickLevelFields({ fields: [S('name')] }, { want: ['id', 'name'], child: [] }), null);
  const needs = { ...L('items', 'Item'), args: [{ name: 'first', defaultValue: null, type: { kind: 'NON_NULL' } }] };
  const p = pickLevelFields({ fields: [S('id'), S('name'), needs] }, { want: ['id', 'name'], child: ['items'] });
  assert.equal(p.child, null);
  assert.equal(buildMenuSelection([{ leaves: ['id', 'name'], child: null }]), '{ id name }');
});

test('menus are paged, and only the current ones are read', async () => {
  const all = await listMenus(fakeEz(potbelly()), 'cat-1', 'pageInfo { hasNextPage endCursor }');
  assert.deepEqual(all.map((m) => m.id), ['menu-old', 'menu-potbelly']);
  assert.deepEqual(currentMenus(all, '2026-09-18').map((m) => m.id), ['menu-potbelly']);
  assert.deepEqual(currentMenus([{ id: 'x', startDate: '2026-10-01' }], '2026-09-18'), [], 'not started yet');
});

test('flattenMenu: every size and every option value, with published and original ids', () => {
  const f = flattenMenu(potbelly());
  assert.equal(f.sizes.length, 9, 'turkey 1, wreck 1, soup 2, chili 2, chips 1, box lunch 2');
  const soupL = f.sizes.find((z) => z.sizeId === 'pub-soup-l-v1');
  assert.equal(soupL.sizeOriginalId, 'orig-soup-l');
  assert.equal(soupL.sizeCount, 2);
  assert.equal(f.values.find((x) => x.valueId === 'pub-white-turkey-v1').valueOriginalId, 'orig-white-turkey');
});

// ── Keys ─────────────────────────────────────────────────────────────────────

test('keys: one size is the NAME key an order lands on; several sizes are one row each, never colliding with a name key', () => {
  assert.equal(sizeRowKey('Turkey Breast', 'Original', 1), 'turkey breast');
  assert.equal(sizeRowKey('Soup', 'Large', 2), 'soup' + SIZE_KEY_SEP + 'large');
  // A size that is only catering noise still makes two different rows.
  assert.notEqual(sizeRowKey('Box Lunch', 'Serves 10', 2), sizeRowKey('Box Lunch', 'Serves 20', 2));
});

// ── The sync ─────────────────────────────────────────────────────────────────

test('a Potbelly shaped menu syncs every row ONCE, with every published id on exactly one row', async () => {
  const sb = fakeDb(baseTables());
  const r = await sync(sb, potbelly());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.complete, true);
  const links = sb.db.ezcater_item_links;
  const keys = links.map((l) => l.kind + ':' + l.ez_key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate rows');
  assert.deepEqual(links.filter((l) => l.kind === 'item').map((l) => l.ez_key).sort(), [
    'a wreck', 'box lunch#serves 10', 'box lunch#serves 20', 'chili#large', 'chili#small', 'chips', 'soup#large', 'soup#small', 'turkey breast',
  ]);
  assert.equal(links.filter((l) => l.kind === 'option').length, 6, 'White, Wheat, Bacon, Avocado, Sea Salt, BBQ');
  const all = links.flatMap((l) => l.ez_ids);
  assert.equal(new Set(all).size, all.length, 'each published id on one row');
  assert.equal(all.length, 9 + 4 + 2 + 2, '9 sizes, bread on two sandwiches, add on one, two chip choices');
  assert.deepEqual(row(sb, 'option', 'bread|white').ez_ids.sort(), ['pub-white-turkey-v1', 'pub-white-wreck-v1']);
  assert.ok(links.every((l) => l.seen_count === 0 && l.last_seen_at === null), 'not yet ordered');
  assert.equal(row(sb, 'item', 'soup#large').ez_size_name, 'Large');
  assert.equal(row(sb, 'item', 'soup#large').ez_category, 'Soups');
  assert.equal(sb.db.ezcater_menu_syncs[0].status, 'ok');
});

test('exact names auto link at sync time; a size clash and an ambiguous name do not', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly());
  assert.equal(row(sb, 'item', 'turkey breast').menu_item_id, 'm-turkey');
  assert.equal(row(sb, 'item', 'turkey breast').source, 'auto');
  assert.equal(row(sb, 'item', 'chili#small').menu_item_id, 'm-chili-s');
  assert.equal(row(sb, 'item', 'chili#large').menu_item_id, null, 'their Large never links to our Small');
  assert.equal(row(sb, 'item', 'soup#large').menu_item_id, null, 'two of ours share the name: a person picks');
  assert.equal(row(sb, 'option', 'bread|white').option_id, 'o-white');
  assert.equal(row(sb, 'option', 'chip selection|bbq').option_id, null);
  const r = await sync(sb, potbelly(), { nowIso: '2026-09-18T12:30:00.000Z' });
  assert.equal(r.counts.matched + r.counts.needsDecision + r.counts.notOnOurMenu, r.counts.rows);
});

test('syncing twice duplicates nothing and keeps a person\'s matches', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly());
  const before = sb.db.ezcater_item_links.length;
  // Staff decide in Back Office between the two syncs.
  Object.assign(row(sb, 'item', 'soup#large'), { menu_item_id: 'm-soup-l', source: 'manual', matched_by: 'user-1' });
  Object.assign(row(sb, 'option', 'bread|wheat'), { option_id: 'o-white', source: 'manual', matched_by: 'user-1' });
  Object.assign(row(sb, 'option', 'chip selection|bbq'), { matched_by: 'ignored', source: 'manual' });
  const r = await sync(sb, potbelly(), { nowIso: '2026-09-19T12:00:00.000Z' });
  assert.equal(r.ok, true);
  assert.equal(sb.db.ezcater_item_links.length, before);
  assert.equal(r.counts.inserted, 0);
  assert.equal(r.counts.updated, 0, 'nothing changed on ezCater, nothing rewritten');
  assert.equal(row(sb, 'item', 'soup#large').menu_item_id, 'm-soup-l');
  assert.equal(row(sb, 'option', 'bread|wheat').option_id, 'o-white', 'even a match the rules would not make');
  assert.equal(row(sb, 'option', 'chip selection|bbq').matched_by, 'ignored');
});

test('a republish with NEW published ids keeps every match through the original ids, even across a rename', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly('v1'));
  Object.assign(row(sb, 'item', 'soup#large'), { menu_item_id: 'm-soup-l', source: 'manual', matched_by: 'user-1' });
  Object.assign(row(sb, 'item', 'a wreck'), { menu_item_id: 'm-wreck-2', source: 'manual', matched_by: 'user-1' });
  const matchedBefore = sb.db.ezcater_item_links.filter((l) => l.menu_item_id || l.option_id).length;

  // ezCater republished: every published id is new, and "A Wreck" is now "The Wreck".
  const r = await sync(sb, potbelly('v2', { wreckName: 'The Wreck' }), { nowIso: '2026-09-19T12:00:00.000Z' });
  assert.equal(r.ok, true);
  assert.equal(row(sb, 'item', 'soup#large').menu_item_id, 'm-soup-l');
  assert.deepEqual(row(sb, 'item', 'soup#large').ez_ids, ['pub-soup-l-v2'], 'the published id moved to the new one');
  const renamed = row(sb, 'item', 'the wreck');
  assert.equal(renamed.menu_item_id, 'm-wreck-2', 'carried by original id, not guessed by name');
  assert.equal(renamed.source, 'manual');
  assert.deepEqual(row(sb, 'item', 'a wreck').ez_ids, [], 'the old name is no longer on the menu');
  assert.equal(row(sb, 'item', 'a wreck').menu_item_id, 'm-wreck-2', 'its own decision is untouched');
  const matchedAfter = sb.db.ezcater_item_links.filter((l) => (l.menu_item_id || l.option_id) && l.ez_ids.length).length;
  assert.equal(matchedAfter, matchedBefore, 'every match is still on the menu');
  assert.ok(sb.db.ezcater_item_links.flatMap((l) => l.ez_ids).every((id) => id.endsWith('-v2')), 'no stale published id anywhere');
});

test('a part read ezCater menu clears nothing, and a part read menu of OURS links nothing', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly());
  const failing = async (op, q, vars) => { if (op === 'ServOsEzMenu') throw new Error('timeout'); return fakeEz(potbelly('v2'))(op, q, vars); };
  const r = await syncVenueMenus(sb, null, LOC, { askFactory: () => failing, nowIso: NOW, nowMs: NOW_MS });
  assert.equal(r.ok, false);
  assert.deepEqual(row(sb, 'item', 'turkey breast').ez_ids, ['pub-turkey-v1'], 'nothing marked gone');

  const plan = planMenuSync({
    entities: syncEntities([flattenMenu(potbelly())]), links: [], ourItems: menuItemsForMatch(at(OUR_ITEMS)),
    ourGroups: modifierGroupsForMatch(at(OUR_GROUPS)), menuOk: false, complete: true, locationId: LOC, nowIso: NOW,
  });
  assert.ok(plan.inserts.every((i) => i.menu_item_id === null && i.option_id === null));
});

test('before the migration, sync says so and writes nothing', async () => {
  const sb = fakeDb(baseTables());
  const orig = sb.from;
  sb.from = (t) => {
    const q = orig(t);
    if (t !== 'ezcater_item_links') return q;
    const sel = q.select;
    q.select = (cols) => { sel(cols); if (/ez_ids/.test(cols)) { q.then = (ok) => Promise.resolve({ data: null, error: { code: '42703', message: 'column ezcater_item_links.ez_ids does not exist' } }).then(ok); } return q; };
    return q;
  };
  const r = await syncVenueMenus(sb, null, LOC, { askFactory: () => fakeEz(potbelly()), nowIso: NOW, nowMs: NOW_MS });
  assert.equal(r.ok, false);
  assert.equal(r.enabled, false);
  assert.match(r.error, /20260918_OPS_ezcater_menu_sync\.sql/);
  assert.equal(sb.db.ezcater_item_links.length, 0);
});

// ── An order resolving to the synced row ─────────────────────────────────────

const ourItems = menuItemsForMatch(at(OUR_ITEMS));
const ourGroups = modifierGroupsForMatch(at(OUR_GROUPS));
const line = (o) => ({ itemId: null, qty: 1, price: 10, mods: [], ...o });

test('a real order line with a synced published id lands on the synced row, and the name alone would not have', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly());
  Object.assign(row(sb, 'item', 'soup#large'), { menu_item_id: 'm-soup-l', source: 'manual', matched_by: 'user-1' });
  const links = sb.db.ezcater_item_links;

  const lines = [
    line({ name: 'Soup', ezSizeId: 'pub-soup-l-v1', sizeName: 'Large' }),
    line({ name: 'Turkey Breast', ezSizeId: 'pub-turkey-v1', mods: [{ label: 'Wheat', groupLabel: 'Bread', ezItemId: 'pub-wheat-turkey-v1', itemId: null, qty: 1 }] }),
  ];
  const plan = planLineMatches({ lines, ourItems, ourGroups, links, locationId: LOC, nowIso: NOW });
  assert.equal(plan.lines[0].itemId, 'm-soup-l', 'the size a person matched');
  assert.equal(plan.lines[1].itemId, 'm-turkey');
  assert.equal(plan.lines[1].mods[0].optionId, 'o-wheat');
  assert.deepEqual(plan.writes, [], 'no name only sighting is written beside the synced rows');
  const bumped = plan.bumps.map((b) => b.kind + ':' + b.ezKey).sort();
  assert.deepEqual(bumped, ['item:soup#large', 'item:turkey breast', 'option:bread|wheat']);
  assert.deepEqual(plan.unseen, []);

  // Without the id, "Soup" is two of ours: nothing is guessed, exactly as before.
  const byName = planLineMatches({ lines: [line({ name: 'Soup' })], ourItems, ourGroups, links, locationId: LOC, nowIso: NOW });
  assert.equal(byName.lines[0].itemId, null);
});

test('an order with published ids we have not synced (a republish) still matches by name and asks for a re-sync', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly('v1'));
  const lines = [line({ name: 'Turkey Breast', ezSizeId: 'pub-turkey-v9' })];
  const plan = planLineMatches({ lines, ourItems, ourGroups, links: sb.db.ezcater_item_links, locationId: LOC, nowIso: NOW });
  assert.equal(plan.lines[0].itemId, 'm-turkey', 'the name still matches it, as before');
  assert.deepEqual(plan.unseen, ['pub-turkey-v9']);
  assert.deepEqual(unseenMenuIds(lines, []), [], 'never synced: nothing is "unseen"');

  // matchQueueRow hands the unseen ids back, and the re-sync is throttled per venue.
  const m = await matchQueueRow(sb, LOC, { ref: 'EZ-1', location_id: LOC, items: lines, customer: {} }, { nowIso: NOW, budgetMs: 0 });
  assert.deepEqual(m.unseen, ['pub-turkey-v9']);
  const first = await resyncForUnseen(sb, null, LOC, m.unseen, { askFactory: () => fakeEz(potbelly('v9')), nowMs: NOW_MS + 16 * 60_000 });
  assert.equal(first.ok, true);
  assert.deepEqual(row(sb, 'item', 'turkey breast').ez_ids, ['pub-turkey-v9']);
  const again = await resyncForUnseen(sb, null, LOC, ['x'], { askFactory: () => fakeEz(potbelly('v9')), nowMs: NOW_MS + 17 * 60_000 });
  assert.equal(again.skipped, 'synced recently');
});

test('no order is ever held up: a matching failure still returns the row', async () => {
  const sb = fakeDb(baseTables());
  sb.from = () => { throw new Error('socket hang up'); };
  const orderRow = { ref: 'EZ-2', location_id: LOC, items: [line({ name: 'Soup', ezSizeId: 'pub-soup-l-v1' })], customer: {} };
  const m = await matchQueueRow(sb, LOC, orderRow, { nowIso: NOW, budgetMs: 0 });
  assert.equal(m.row, orderRow);
  assert.deepEqual(m.unseen, []);
});

// ── Paging ───────────────────────────────────────────────────────────────────

test('link reads page past 1000 rows, and an id on row 2,401 still resolves', async () => {
  const many = [];
  for (let i = 0; i < 2400; i++) many.push({ location_id: LOC, kind: 'item', ez_key: `filler ${String(i).padStart(5, '0')}`, ez_name: `Filler ${i}`, source: 'auto', ez_ids: [`pub-f-${i}`], ez_original_ids: [] });
  many.push({ location_id: LOC, kind: 'item', ez_key: 'zzz soup#large', ez_name: 'Zzz Soup', ez_size_name: 'Large', source: 'manual', menu_item_id: 'm-soup-l', matched_by: 'u', ez_ids: ['pub-last'], ez_original_ids: [] });
  const sb = fakeDb(baseTables({ ezcater_item_links: many }));
  const r = await readAllLinks(sb, LOC);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.equal(r.synced, true);
  assert.equal(r.rows.length, 2401);
  const plan = planLineMatches({ lines: [line({ name: 'Zzz Soup', ezSizeId: 'pub-last' })], ourItems, ourGroups, links: r.rows, locationId: LOC, nowIso: NOW });
  assert.equal(plan.lines[0].itemId, 'm-soup-l');
});

// ── Daily re-sync timing ─────────────────────────────────────────────────────

test('daily re-sync: due after a day, not while a failed attempt is under an hour old', () => {
  assert.equal(syncDue(null, NOW_MS), true);
  assert.equal(syncDue({ last_synced_at: NOW, last_attempt_at: NOW }, NOW_MS + 60 * 60_000), false);
  assert.equal(syncDue({ last_synced_at: NOW, last_attempt_at: NOW }, NOW_MS + 24 * 60 * 60_000), true);
  assert.equal(syncDue({ last_synced_at: NOW, last_attempt_at: new Date(NOW_MS + 24 * 3600_000).toISOString() }, NOW_MS + 24 * 3600_000 + 5 * 60_000), false);
});

// ── The screen ───────────────────────────────────────────────────────────────

test('screen: a size row shows its size, saves under its own key, and the sync line uses the three words', () => {
  const r = toRow({ kind: 'item', ez_key: 'soup#large', ez_name: 'Soup', ez_size_name: 'Large', ez_ids: ['p'], synced_at: NOW, source: 'auto', seen_count: 0 });
  assert.equal(r.displayName, 'Soup, Large');
  assert.equal(r.onMenu, true);
  assert.equal(saveBody(r, { menuItemId: 'm-soup-l' }).body.ez_key, 'soup#large');
  assert.equal(saveBody(toRow({ kind: 'item', ez_key: 'soup', ez_name: 'Soup', source: 'auto' }), { menuItemId: 'x' }).body.ez_key, 'soup');
  const s = syncSummary({ last_synced_at: NOW, status: 'ok', menus: ['Potbelly Test'], counts: { items: 7, sizes: 9, options: 6, matched: 9, needsDecision: 3, notOnOurMenu: 3 } }, NOW_MS + 5 * 60_000);
  assert.equal(s.when, 'Last synced 5 minutes ago from Potbelly Test.');
  assert.equal(s.what, '7 items, 9 sizes, 6 options. 9 matched, 3 need a decision, 3 not on our menu.');
  assert.equal(syncSummary(null, NOW_MS).when, 'Not synced yet.');
  assert.ok(!/[\u2013\u2014]/.test(JSON.stringify(s)), 'no dashes in copy');
});

// \u2500\u2500 Review round 4 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

test('R4 item 1: a sized line lands on its size row, never on an old name only row for the item', async () => {
  // "soup" was matched by staff to our Soup Small BEFORE the sync (an order by name).
  const sb = fakeDb(baseTables({ ezcater_item_links: [{ location_id: LOC, kind: 'item', ez_key: 'soup', ez_name: 'Soup', source: 'manual', menu_item_id: 'm-soup-s', matched_by: 'user-1', ez_ids: ['pub-soup-old'], ez_prior_ids: [], ez_original_ids: [] }] }));
  await sync(sb, potbelly());
  Object.assign(row(sb, 'item', 'soup#large'), { menu_item_id: 'm-soup-l', source: 'auto', matched_by: 'name' });
  const links = sb.db.ezcater_item_links;
  const large = [line({ name: 'Soup', ezSizeId: 'pub-soup-l-v1', sizeName: 'Large' })];

  const plan = planLineMatches({ lines: large, ourItems, ourGroups, links, locationId: LOC, nowIso: NOW });
  assert.equal(plan.lines[0].itemId, 'm-soup-l', 'the Large the id says, not the Small the old name row says');
  assert.deepEqual(plan.bumps.map((b) => b.ezKey), ['soup#large']);
  assert.deepEqual(plan.upgrades, []);

  // Same with only part of our menu read (the saved links only path).
  const part = planLineMatches({ lines: large, ourItems, ourGroups, links, locationId: LOC, nowIso: NOW, menuOk: false });
  assert.equal(part.lines[0].itemId, 'm-soup-l');

  // A size row nobody has matched yet: the line is NOT matched (prints by name), never the old Small.
  const small = [line({ name: 'Soup', ezSizeId: 'pub-soup-s-v1', sizeName: 'Small' })];
  assert.equal(row(sb, 'item', 'soup#small').menu_item_id, null);
  assert.equal(planLineMatches({ lines: small, ourItems, ourGroups, links, locationId: LOC, nowIso: NOW }).lines[0].itemId, null);
  assert.equal(planLineMatches({ lines: small, ourItems, ourGroups, links, locationId: LOC, nowIso: NOW, menuOk: false }).lines[0].itemId, null);

  // decideWithSyncedRow directly: a person's name match never beats a size row.
  const d = decideWithSyncedRow({ action: 'linked', itemId: 'm-soup-s', source: 'manual' }, { ezKey: 'soup#large', menuItemId: 'm-soup-l', source: 'auto' }, 'item', new Set(['m-soup-s', 'm-soup-l']));
  assert.equal(d.itemId, 'm-soup-l');

  // The screen: the old "soup" row left the menu and is replaced by its size rows, so it is not
  // offered for matching. Its old id moved to the prior ids.
  assert.deepEqual(row(sb, 'item', 'soup').ez_ids, []);
  assert.deepEqual(row(sb, 'item', 'soup').ez_prior_ids, ['pub-soup-old']);
  assert.deepEqual([...replacedBySizes(links)], ['soup']);
  const shown = rowsFrom(links).map((r) => r.ezKey);
  assert.ok(!shown.includes('soup'), 'hidden');
  assert.ok(shown.includes('soup#large') && shown.includes('soup#small'));
  assert.ok(shown.includes('turkey breast'), 'a one size item is never hidden');
});

test('R4 item 2: a staff clear is a decision; no sync and no order auto matches over it', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly());
  assert.equal(row(sb, 'item', 'turkey breast').menu_item_id, 'm-turkey');
  // items_save with no target: source manual, no target, matched_by null.
  Object.assign(row(sb, 'item', 'turkey breast'), { menu_item_id: null, source: 'manual', matched_by: null });
  Object.assign(row(sb, 'option', 'bread|white'), { option_id: null, menu_item_id: null, source: 'manual', matched_by: null });

  const r = await sync(sb, potbelly(), { nowIso: '2026-09-19T12:00:00.000Z' });
  assert.equal(r.ok, true);
  assert.equal(row(sb, 'item', 'turkey breast').menu_item_id, null, 'the clear stuck');
  assert.equal(row(sb, 'item', 'turkey breast').source, 'manual');
  assert.equal(row(sb, 'option', 'bread|white').option_id, null);

  // An order: the exact name no longer auto links over the person's clear, and nothing is written.
  const lines = [line({ name: 'Turkey Breast', ezSizeId: 'pub-turkey-v1', mods: [{ label: 'White', groupLabel: 'Bread', ezItemId: 'pub-white-turkey-v1', itemId: null, qty: 1 }] })];
  const plan = planLineMatches({ lines, ourItems, ourGroups, links: sb.db.ezcater_item_links, locationId: LOC, nowIso: NOW });
  assert.equal(plan.lines[0].itemId, null);
  assert.equal(plan.lines[0].mods[0].optionId ?? null, null);
  assert.deepEqual(plan.upgrades, []);

  // The SQL guard: a decision planned while the row was undecided is not written once staff clear it.
  const sb2 = fakeDb(baseTables());
  await sync(sb2, potbelly(), { nowIso: '2026-09-17T12:00:00.000Z' });
  Object.assign(row(sb2, 'item', 'turkey breast'), { menu_item_id: null, source: 'auto', matched_by: null });
  const p = planMenuSync({
    entities: syncEntities([flattenMenu(potbelly())]), links: JSON.parse(JSON.stringify(sb2.db.ezcater_item_links)),
    ourItems, ourGroups, menuOk: true, complete: true, locationId: LOC, nowIso: NOW,
  });
  assert.ok(p.decisions.some((x) => x.ezKey === 'turkey breast'));
  Object.assign(row(sb2, 'item', 'turkey breast'), { source: 'manual' });   // staff clear lands first
  await applyMenuSync(sb2, LOC, p);
  assert.equal(row(sb2, 'item', 'turkey breast').menu_item_id, null);
});

test('R4 item 3: an original id carries only when unique, only onto an undecided row, never over a decision', () => {
  const entities = syncEntities([flattenMenu(potbelly('v2', { wreckName: 'The Wreck' }))]);
  const base = { entities, ourItems, ourGroups, menuOk: true, complete: true, locationId: LOC, nowIso: NOW };
  const old = (extra) => ({ location_id: LOC, kind: 'item', ez_key: 'a wreck', ez_name: 'A Wreck', source: 'manual', menu_item_id: 'm-wreck-2', matched_by: 'u', ez_ids: ['pub-wreck-v1'], ez_prior_ids: [], ez_original_ids: ['orig-wreck'], ...extra });
  const inserted = (plan) => plan.inserts.find((i) => i.ez_key === 'the wreck');

  // Unique: carried onto the new, undecided row.
  assert.equal(inserted(planMenuSync({ ...base, links: [old()] })).menu_item_id, 'm-wreck-2');

  // The same original on two saved rows says nothing certain: not carried (the name rule decides).
  const two = planMenuSync({ ...base, links: [old(), old({ ez_key: 'wreck old', ez_name: 'Wreck Old', menu_item_id: 'm-turkey' })] });
  assert.notEqual(inserted(two).menu_item_id, 'm-wreck-2');
  assert.notEqual(inserted(two).menu_item_id, 'm-turkey');

  // The row already has its own decision (an automatic name match): never overwritten.
  const own = { location_id: LOC, kind: 'item', ez_key: 'the wreck', ez_name: 'The Wreck', source: 'auto', menu_item_id: 'm-wreck', matched_by: 'name', ez_ids: [], ez_prior_ids: [], ez_original_ids: [] };
  const kept = planMenuSync({ ...base, links: [old(), own] });
  assert.ok(!kept.decisions.some((x) => x.ezKey === 'the wreck'), 'no decision written over its own');

  // The same original twice in THIS read: not carried either.
  const dup = new Map(entities);
  dup.set('item:wreck twin', { ...entities.get('item:the wreck'), key: 'wreck twin', name: 'Wreck Twin', ids: ['pub-twin'] });
  const twice = planMenuSync({ ...base, entities: dup, links: [old()] });
  assert.ok(!twice.inserts.some((i) => i.menu_item_id === 'm-wreck-2'));
});

test('R4 item 4: a republish ADDS the new published ids; an order on the previous version still lands on its size', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly('v1'));
  Object.assign(row(sb, 'item', 'soup#large'), { menu_item_id: 'm-soup-l', source: 'manual', matched_by: 'user-1' });
  await sync(sb, potbelly('v2'), { nowIso: '2026-09-19T12:00:00.000Z' });
  assert.deepEqual(row(sb, 'item', 'soup#large').ez_ids, ['pub-soup-l-v2']);
  assert.deepEqual(row(sb, 'item', 'soup#large').ez_prior_ids, ['pub-soup-l-v1']);
  await sync(sb, potbelly('v3'), { nowIso: '2026-09-20T12:00:00.000Z' });
  assert.deepEqual(row(sb, 'item', 'soup#large').ez_prior_ids, ['pub-soup-l-v2', 'pub-soup-l-v1'], 'newest first');

  const onOld = [line({ name: 'Soup', ezSizeId: 'pub-soup-l-v1', sizeName: 'Large' })];
  const plan = planLineMatches({ lines: onOld, ourItems, ourGroups, links: sb.db.ezcater_item_links, locationId: LOC, nowIso: NOW });
  assert.equal(plan.lines[0].itemId, 'm-soup-l');
  assert.deepEqual(plan.unseen, [], 'an old id is known, not a reason to re-sync');

  // Capped, newest first.
  const many = Array.from({ length: 300 }, (_, i) => `old-${i}`);
  const kept = nextPriorIds(['cur-1'], many, ['cur-2']);
  assert.equal(kept.length, EZ_PRIOR_IDS_MAX);
  assert.equal(kept[0], 'cur-1');
  assert.ok(!kept.includes('cur-2'));
});

test('R4 item 5: ids a re-sync could not find are remembered and do not re-sync again', async () => {
  const sb = fakeDb(baseTables());
  await sync(sb, potbelly('v1'));
  const first = await resyncForUnseen(sb, null, LOC, ['pub-ghost'], { askFactory: () => fakeEz(potbelly('v1')), nowMs: NOW_MS + 16 * 60_000 });
  assert.equal(first.ok, true);
  assert.ok(sb.db.ezcater_menu_syncs[0].unresolved_ids['pub-ghost'], 'remembered');
  const again = await resyncForUnseen(sb, null, LOC, ['pub-ghost'], { askFactory: () => fakeEz(potbelly('v1')), nowMs: NOW_MS + 60 * 60_000 });
  assert.equal(again.skipped, 'looked for already');
  const fresh = await resyncForUnseen(sb, null, LOC, ['pub-ghost', 'pub-new'], { askFactory: () => fakeEz(potbelly('v1')), nowMs: NOW_MS + 60 * 60_000 });
  assert.equal(fresh.ok, true, 'a new id still re-syncs');
  assert.ok(sb.db.ezcater_menu_syncs[0].unresolved_ids['pub-new']);
  assert.ok(sb.db.ezcater_menu_syncs[0].unresolved_ids['pub-ghost'], 'the older one is still remembered');
  // After the back off the old ones may be tried again (the daily sync would have anyway).
  assert.equal(liveUnresolved({ 'pub-ghost': NOW }, NOW_MS + 24 * 3600_000).size, 0);
});

test('R4 item 5: options that could not be read never make every customizationId "unseen"', () => {
  const links = [
    { kind: 'item', ez_key: 'turkey breast', ez_ids: ['pub-turkey-v1'] },
    { kind: 'option', ez_key: 'bread|white', ez_ids: [] },   // the value level was not readable
  ];
  const lines = [line({ name: 'Turkey Breast', ezSizeId: 'pub-turkey-v1', mods: [{ label: 'White', groupLabel: 'Bread', ezItemId: 'cust-1' }] })];
  assert.deepEqual(unseenMenuIds(lines, links), []);
  const lines2 = [line({ name: 'Turkey Breast', ezSizeId: 'pub-turkey-v9', mods: [{ label: 'White', ezItemId: 'cust-1' }] })];
  assert.deepEqual(unseenMenuIds(lines2, links), ['pub-turkey-v9'], 'items still count');
  assert.equal(hasSyncedKind(links, 'option'), false);
});

test('R4 item 5: one sync per venue, claimed atomically, both for a new venue and an existing one', async () => {
  const sb = fakeDb(baseTables());
  const [a, b] = await Promise.all([sync(sb, potbelly()), sync(sb, potbelly())]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, 'exactly one ran');
  assert.equal([a, b].filter((r) => r.skipped === 'running').length, 1);
  assert.equal(sb.db.ezcater_menu_syncs.length, 1);

  const later = '2026-09-19T12:00:00.000Z';
  const [c, d] = await Promise.all([sync(sb, potbelly(), { nowIso: later }), sync(sb, potbelly(), { nowIso: later })]);
  assert.equal([c, d].filter((r) => r.ok).length, 1, 'the conditional update lets one through');

  // A lock still running is respected, a stale one is taken over.
  Object.assign(sb.db.ezcater_menu_syncs[0], { status: 'running', last_attempt_at: later });
  const ms = Date.parse(later);
  assert.equal((await claimSyncLock(sb, LOC, 'staff', new Date(ms + 60_000).toISOString(), ms + 60_000)).claimed, false);
  assert.equal((await claimSyncLock(sb, LOC, 'staff', new Date(ms + 6 * 60_000).toISOString(), ms + 6 * 60_000)).claimed, true);
});

test('R4 item 5: the hourly due sync is fair: longest waiting first, within its budget', async () => {
  const h = 3600_000;
  const states = new Map([
    ['loc-a', { status: 'error', last_attempt_at: new Date(NOW_MS - 2 * h).toISOString(), last_synced_at: new Date(NOW_MS - 30 * h).toISOString() }],
    ['loc-c', { status: 'ok', last_attempt_at: new Date(NOW_MS - 25 * h).toISOString(), last_synced_at: new Date(NOW_MS - 25 * h).toISOString() }],
    ['loc-d', { status: 'ok', last_attempt_at: new Date(NOW_MS - 1 * h).toISOString(), last_synced_at: new Date(NOW_MS - 1 * h).toISOString() }],
  ]);
  assert.deepEqual(dueVenuesInOrder(['loc-a', 'loc-b', 'loc-c', 'loc-d'], states, NOW_MS), ['loc-b', 'loc-c', 'loc-a']);

  const venues = ['loc-a', 'loc-b', 'loc-c'];
  const caterers = venues.map((id, i) => ({ caterer_uuid: 'cat-' + i, location_id: id, connection_id: 'conn-1', active: true }));
  const sb = fakeDb(baseTables({
    ezcater_caterers: caterers,
    ezcater_menu_syncs: [...states].filter(([id]) => venues.includes(id)).map(([id, s]) => ({ location_id: id, ...s })),
    menu_items: [], modifier_groups: [],
  }));
  const out = await syncDueVenues(sb, null, { askFactory: () => fakeEz(potbelly()), nowMs: NOW_MS, maxVenues: 2, concurrency: 1 });
  assert.deepEqual(out.map((o) => o.locationId), ['loc-b', 'loc-c'], 'the two waiting longest; the recent failure waits');
  assert.ok(out.every((o) => o.ok), JSON.stringify(out));

  // A budget that runs out: a venue not reached comes back skipped, still due for next hour.
  const slow = () => async (op, q, vars) => { await new Promise((r) => setTimeout(r, 30)); return fakeEz(potbelly())(op, q, vars); };
  const sb2 = fakeDb(baseTables({ ezcater_caterers: caterers, menu_items: [], modifier_groups: [] }));
  const cut = await syncDueVenues(sb2, null, { askFactory: slow, nowMs: NOW_MS, concurrency: 1, budgetMs: 50 });
  assert.equal(cut.length, 3);
  assert.ok(cut.some((o) => o.skipped), 'unreached venues are reported, not dropped');
});
