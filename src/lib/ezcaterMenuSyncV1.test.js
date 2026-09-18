/**
 * ezcaterMenuSyncV1.test.js
 *
 * "Sync ezCater menu", the conservative version (feat/ezcater-menu-sync-v1):
 *   supabase/functions/_shared/ezcaterMenuSync.ts     rules: rows, keys, exact auto links, the size rule
 *   supabase/functions/_shared/ezcaterMenuSyncRun.ts  the job: claim, read, plan, write
 *   supabase/functions/_shared/ezcater-match-ingest.ts the order time rule wired in, paged link reads
 *
 * No live ezCater call: ezCater is a fake `ask` answering in the shape proven live on 18 Sep 2026.
 * Run: `npm test`, or `node --test src/lib/ezcaterMenuSyncV1.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  flattenMenus, planMenuSync, autoTargetFor, sizeRowKey, sizeRouteFor, indexPublishedIds,
  currentMenus, venueDate, readCatererMenus, readAllLinks, MENU_QUERY, MENU_QUERY_NO_OPTIONS,
  LINK_PAGE_SIZE,
} from '../../supabase/functions/_shared/ezcaterMenuSync.ts';
import { runMenuSync, dueLocations } from '../../supabase/functions/_shared/ezcaterMenuSyncRun.ts';
import { planLineMatches, readMatchInputs } from '../../supabase/functions/_shared/ezcater-match-ingest.ts';
import { buildLinkKey } from '../../supabase/functions/_shared/ezcaterMatch.ts';
import { toRow, saveBody, theirLabel, suggestionsFor } from './ezcaterItemRows.js';

const NOW = '2026-09-18T15:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const LOC = 'loc-1';

// ── A Potbelly shaped ezCater menu ─────────────────────────────────────────────────────────
// Sandwiches in three sizes, a single size salad, a tray whose two sizes are both only noise,
// a single size item whose name carries a size word, and options on the sandwiches.

const size = (id, name, extra = {}) => ({ id, name, serves: null, status: 'ACTIVE', originalItemSizeId: 'o-' + id, ...extra });
const opts = [
  { id: 'ct-bread', name: 'Bread', selectionRangeStart: 1, selectionRangeEnd: 1,
    values: [{ id: 'v-multi', name: 'Multigrain' }, { id: 'v-white', name: 'White' }] },
];
const POTBELLY = {
  id: 'menu-1', name: 'Potbelly Catering', startDate: '2026-01-01', endDate: null,
  categories: [
    { id: 'c-1', name: 'Sandwiches', items: [
      { id: 'i-wreck', name: 'A Wreck', originalItemId: 'oi-wreck', sizes: [
        size('s-wreck-orig', 'Original', { customizationTypes: opts }),
        size('s-wreck-big', 'Bigs', { customizationTypes: opts }),
        size('s-wreck-skinny', 'Skinny', { customizationTypes: opts }),
      ] },
      { id: 'i-italian', name: 'Italian', originalItemId: 'oi-it', sizes: [
        size('s-it-small', 'Small'), size('s-it-large', 'Large'),
      ] },
    ] },
    { id: 'c-2', name: 'Salads', items: [
      { id: 'i-salad', name: 'Farmhouse Salad', originalItemId: 'oi-salad', sizes: [size('s-salad', 'Serves 1')] },
      { id: 'i-chick', name: 'Chicken Salad Large', originalItemId: 'oi-chick', sizes: [size('s-chick', 'Regular')] },
    ] },
    { id: 'c-3', name: 'Desserts', items: [
      { id: 'i-cookie', name: 'Cookie Tray', originalItemId: 'oi-cookie', sizes: [
        size('s-cookie-10', 'Serves 10'), size('s-cookie-20', 'Serves 20'),
      ] },
    ] },
  ],
};
// The same sandwich on a second current menu, under a new published id.
const LUNCH = {
  id: 'menu-2', name: 'Lunch', startDate: null, endDate: null,
  categories: [{ id: 'c-9', name: 'Sandwiches', items: [
    { id: 'i2', name: 'Farmhouse Salad', sizes: [size('s-salad-2', 'Serves 1')] },
  ] }],
};
const OLD = { id: 'menu-0', name: 'Old', startDate: '2025-01-01', endDate: '2025-12-31', categories: [] };

// Our menu.
const OUR_ITEMS = [
  { id: 'm-wreck-orig', name: 'A Wreck Original' },
  { id: 'm-wreck-big', name: 'A Wreck Bigs' },
  { id: 'm-italian-small', name: 'Italian Small' },
  { id: 'm-salad', name: 'Farmhouse Salad' },
  { id: 'm-chick-small', name: 'Chicken Salad Small' },
  { id: 'm-cookie', name: 'Cookie Tray' },
];
const OUR_GROUPS = [{ id: 'g-bread', name: 'Bread', options: [
  { id: 'o-multi', name: 'Multigrain', itemId: null }, { id: 'o-rye', name: 'Rye', itemId: null },
] }];

const MENU_ROWS = OUR_ITEMS.map((i) => ({ ...i, location_id: LOC, menu_name: null, pricing: { base: 9 }, archived: false }));
const GROUP_ROWS = OUR_GROUPS.map((g) => ({ ...g, location_id: LOC }));

// ── Fake ezCater and fake Supabase ─────────────────────────────────────────────────────────

function fakeAsk(menus, { refuseValues = false, calls = [] } = {}) {
  return async (op, query, vars) => {
    calls.push({ op, vars });
    if (op === 'ServOsEzMenus') return { menus: { nodes: menus.map(({ id, name, startDate, endDate }) => ({ id, name, startDate, endDate })) } };
    if (op === 'ServOsEzMenu') {
      if (refuseValues && query === MENU_QUERY) {
        const e = new Error('Cannot query field "values" on type "CustomizationType".');
        e.code = 'GRAPHQL_VALIDATION_FAILED';
        throw e;
      }
      const m = menus.find((x) => x.id === vars.id);
      return { menu: m || null };
    }
    throw new Error('unexpected ' + op);
  };
}

function fakeSb(tables, { claim = 'claim-1', rpcError = null, noSyncColumns = false } = {}) {
  const store = JSON.parse(JSON.stringify(tables));
  const calls = [];
  const from = (name) => {
    const st = { op: 'select', cols: '*', eq: {}, nulls: {}, nots: {}, ins: {}, range: null, rows: null, patch: null, opts: null, single: false };
    const match = (r) => Object.entries(st.eq).every(([k, v]) => String(r[k] ?? '') === String(v))
      && Object.entries(st.nulls).every(([k]) => (r[k] ?? null) === null)
      && Object.entries(st.nots).every(([k]) => (r[k] ?? null) !== null)
      && Object.entries(st.ins).every(([k, v]) => v.map(String).includes(String(r[k])));
    const sameKey = (a, b) => a.location_id === b.location_id && a.kind === b.kind && a.ez_key === b.ez_key;
    const run = () => {
      if (noSyncColumns && st.op === 'select' && /ez_ids|ez_size_name/.test(st.cols)) {
        return { data: null, error: { code: '42703', message: 'column ezcater_item_links.ez_ids does not exist' } };
      }
      const list = (store[name] = store[name] || []);
      if (st.op === 'select') {
        let rows = list.filter(match);
        if (name === 'ezcater_item_links') rows = rows.slice().sort((a, b) => (a.kind + a.ez_key < b.kind + b.ez_key ? -1 : 1));
        if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
        calls.push({ op: 'select', table: name, range: st.range });
        if (st.single) return { data: rows[0] || null, error: null };
        return { data: rows.map((r) => ({ ...r })), error: null };
      }
      if (st.op === 'upsert') {
        const rows = Array.isArray(st.rows) ? st.rows : [st.rows];
        calls.push({ op: 'upsert', table: name, n: rows.length, ignore: !!st.opts?.ignoreDuplicates });
        for (const r of rows) {
          const prev = list.find((e) => sameKey(e, r));
          if (prev) { if (!st.opts?.ignoreDuplicates) Object.assign(prev, r); continue; }
          if (!r.source) return { data: null, error: { message: 'null value in column "source"' } };
          list.push({ ...r });
        }
        return { data: null, error: null };
      }
      calls.push({ op: 'update', table: name, patch: st.patch, eq: { ...st.eq } });
      const hit = list.filter(match);
      for (const r of hit) Object.assign(r, st.patch);
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select(c) { if (st.op === 'select') st.cols = c || '*'; return b; },
      eq(k, v) { st.eq[k] = v; return b; },
      is(k) { st.nulls[k] = true; return b; },
      not(k) { st.nots[k] = true; return b; },
      in(k, v) { st.ins[k] = v; return b; },
      order() { return b; },
      range(a, z) { st.range = [a, z]; return b; },
      maybeSingle() { st.single = true; return b; },
      upsert(rows, o) { st.op = 'upsert'; st.rows = rows; st.opts = o; return b; },
      update(p) { st.op = 'update'; st.patch = p; return b; },
      then(ok, no) { return Promise.resolve().then(run).then(ok, no); },
    };
    return b;
  };
  const rpc = async (fn, args) => {
    calls.push({ op: 'rpc', fn, args });
    if (rpcError) return { data: null, error: rpcError };
    return { data: typeof claim === 'function' ? claim() : claim, error: null };
  };
  return { from, rpc, store, calls };
}

const TABLES = (links = []) => ({
  menu_items: MENU_ROWS.map((r) => ({ ...r })),
  modifier_groups: GROUP_ROWS.map((r) => ({ ...r })),
  ezcater_item_links: links,
  ezcater_caterers: [{ caterer_uuid: 'cat-1', connection_id: 'conn-1', location_id: LOC, active: true }],
  ezcater_connections: [{ id: 'conn-1', api_token: 'tok', api_url: null, status: 'connected' }],
  locations: [{ id: LOC, timezone: 'America/Chicago' }],
  ezcater_menu_syncs: [],
});

const links = (sb) => sb.store.ezcater_item_links;
const row = (sb, key) => links(sb).find((r) => r.ez_key === key);

// ── Rows ───────────────────────────────────────────────────────────────────────────────────

test('a Potbelly shaped menu flattens to every row once: plain items, each size, each option', () => {
  const entries = flattenMenus([POTBELLY, LUNCH]);
  const keys = entries.map((e) => e.kind + ':' + e.ezKey);
  assert.equal(new Set(keys).size, keys.length, 'no key twice');
  assert.deepEqual(keys.sort(), [
    'item:' + sizeRowKey('A Wreck', 'Bigs'),
    'item:' + sizeRowKey('A Wreck', 'Original'),
    'item:' + sizeRowKey('A Wreck', 'Skinny'),
    'item:' + buildLinkKey({ name: 'Chicken Salad Large' }, 'item'),
    'item:' + sizeRowKey('Cookie Tray', 'Serves 10'),
    'item:' + sizeRowKey('Cookie Tray', 'Serves 20'),
    'item:' + buildLinkKey({ name: 'Farmhouse Salad' }, 'item'),
    'item:' + sizeRowKey('Italian', 'Large'),
    'item:' + sizeRowKey('Italian', 'Small'),
    'option:' + buildLinkKey({ name: 'Multigrain', groupLabel: 'Bread' }, 'option'),
    'option:' + buildLinkKey({ name: 'White', groupLabel: 'Bread' }, 'option'),
  ].sort());
  const salad = entries.find((e) => e.ezName === 'Farmhouse Salad');
  assert.deepEqual(salad.ids.sort(), ['s-salad', 's-salad-2'], 'the same plain item on two menus: one row, both ids');
  assert.equal(salad.ezSizeName, null);
  const big = entries.find((e) => e.ezKey === sizeRowKey('A Wreck', 'Bigs'));
  assert.deepEqual(big.ids, ['s-wreck-big']);
  assert.equal(big.ezSizeName, 'Bigs');
  const multi = entries.find((e) => e.ezName === 'Multigrain');
  assert.deepEqual(multi.ids, ['v-multi'], 'one value id, seen under three sizes, kept once');
  assert.equal(sizeRowKey('A Wreck', 'Bigs'), 'a wreck|size:bigs');
});

test('only current menus are read, on the venue date', () => {
  assert.deepEqual(currentMenus([POTBELLY, LUNCH, OLD], '2026-09-18').map((m) => m.id), ['menu-1', 'menu-2']);
  assert.deepEqual(currentMenus([{ id: 'x', startDate: '2026-09-19' }], '2026-09-18'), []);
  // 03:00 UTC on the 19th is still the 18th in Chicago.
  assert.equal(venueDate(Date.parse('2026-09-19T03:00:00Z'), 'America/Chicago'), '2026-09-18');
});

// ── Exact names auto link; size clashes do not ─────────────────────────────────────────────

test('exact names auto link: a plain item, a size by its full name, an option', () => {
  const plan = planMenuSync({
    entries: flattenMenus([POTBELLY]), existing: [], ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS,
    locationId: LOC, nowIso: NOW, complete: true, menuOk: true,
  });
  const by = (k) => plan.inserts.find((r) => r.ez_key === k);
  assert.equal(by(buildLinkKey({ name: 'Farmhouse Salad' }, 'item')).menu_item_id, 'm-salad');
  assert.equal(by(sizeRowKey('A Wreck', 'Original')).menu_item_id, 'm-wreck-orig');
  assert.equal(by(sizeRowKey('A Wreck', 'Bigs')).menu_item_id, 'm-wreck-big');
  assert.equal(by(sizeRowKey('A Wreck', 'Bigs')).matched_by, 'name');
  assert.equal(by(buildLinkKey({ name: 'Multigrain', groupLabel: 'Bread' }, 'option')).option_id, 'o-multi');
  // Every new row is a not yet ordered row carrying its published ids.
  for (const r of plan.inserts) {
    assert.equal(r.seen_count, 0);
    assert.equal(r.last_seen_at, null);
    assert.equal(r.source, 'auto');
    assert.ok(Array.isArray(r.ez_ids));
  }
  assert.deepEqual(by(sizeRowKey('A Wreck', 'Bigs')).ez_ids, ['s-wreck-big']);
});

test('size clashes and guesses do not auto link', () => {
  const plan = planMenuSync({
    entries: flattenMenus([POTBELLY]), existing: [], ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS,
    locationId: LOC, nowIso: NOW, complete: true, menuOk: true,
  });
  const by = (k) => plan.inserts.find((r) => r.ez_key === k);
  // Their single size "Chicken Salad Large" vs our only "Chicken Salad Small": a size clash.
  assert.equal(by(buildLinkKey({ name: 'Chicken Salad Large' }, 'item')).menu_item_id, null);
  // Their "Italian" Large, and we only sell Italian Small.
  assert.equal(by(sizeRowKey('Italian', 'Large')).menu_item_id, null);
  assert.equal(by(sizeRowKey('Italian', 'Small')).menu_item_id, 'm-italian-small');
  // Skinny: nothing of ours has that name. Never linked to plain "A Wreck" either.
  assert.equal(by(sizeRowKey('A Wreck', 'Skinny')).menu_item_id, null);
  // Cookie Tray Serves 10 and Serves 20 both key as "cookie" + noise: never linked to our one Cookie Tray.
  assert.equal(by(sizeRowKey('Cookie Tray', 'Serves 10')).menu_item_id, null);
  assert.equal(by(sizeRowKey('Cookie Tray', 'Serves 20')).menu_item_id, null);
  // A single size item never links a size row of ours either way round.
  assert.equal(autoTargetFor({ kind: 'item', ezKey: 'x', ezName: 'Italian', ezGroup: null, ezSizeName: 'Large', ezCategory: null, ids: [], noAuto: false },
    [{ id: 'a', name: 'Italian' }], []), null, 'a size lost in our plain name is not the same size');
  // Our menu read only in part: nothing auto links at all.
  const partial = planMenuSync({
    entries: flattenMenus([POTBELLY]), existing: [], ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS,
    locationId: LOC, nowIso: NOW, complete: true, menuOk: false,
  });
  assert.ok(partial.inserts.every((r) => r.menu_item_id === null && r.option_id === null));
});

// ── The order time rule ────────────────────────────────────────────────────────────────────

const SYNCED = [
  { kind: 'item', ez_key: sizeRowKey('A Wreck', 'Bigs'), ez_name: 'A Wreck', ez_size_name: 'Bigs', ez_ids: ['s-wreck-big'], menu_item_id: 'm-wreck-big', option_id: null, source: 'auto', matched_by: 'name', seen_count: 0 },
  { kind: 'item', ez_key: sizeRowKey('A Wreck', 'Skinny'), ez_name: 'A Wreck', ez_size_name: 'Skinny', ez_ids: ['s-wreck-skinny'], menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0 },
  { kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', ez_size_name: null, ez_ids: ['s-salad'], menu_item_id: 'm-salad', option_id: null, source: 'auto', matched_by: 'name', seen_count: 3 },
  // An OLD name match made before sizes were synced, by a person: "A Wreck" -> the Original.
  { kind: 'item', ez_key: 'a wreck', ez_name: 'A Wreck', ez_size_name: null, ez_ids: [], menu_item_id: 'm-wreck-orig', option_id: null, source: 'manual', matched_by: 'user-1', seen_count: 9 },
];
const line = (name, ezSizeId, sizeName) => ({ itemId: null, name, ezSizeId, sizeName, qty: 1, price: 10, mods: [] });
const plan = (lines, extra = {}) => planLineMatches({
  lines, ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS, links: SYNCED, locationId: LOC, nowIso: NOW, sizeIds: true, ...extra,
});

test('a sized line resolves only through its synced size row, and only when that row has a decision', () => {
  const p = plan([line('A Wreck', 's-wreck-big', 'Bigs'), line('A Wreck', 's-wreck-skinny', 'Skinny')]);
  assert.equal(p.lines[0].itemId, 'm-wreck-big');
  assert.equal(p.lines[0].match.source, 'menuSync');
  assert.equal(p.lines[1].itemId, null, 'a size row nobody decided routes nothing');
  assert.equal(p.writes.length, 0, 'a sized line never writes a name row');
  assert.ok(p.bumps.some((b) => b.ezKey === sizeRowKey('A Wreck', 'Bigs')), 'the size row is counted');
});

test('a sized line with an unknown published id stays unmatched: no guess, no old match carried over', () => {
  // "A Wreck" has an old staff name match, and our menu has the exact names. Still unmatched.
  const p = plan([line('A Wreck', 's-republished-999', 'Original')]);
  assert.equal(p.lines[0].itemId, null);
  assert.equal(p.lines[0].match.matched, false);
  assert.equal(p.writes.length, 0);
  assert.equal(p.upgrades.length, 0);
  assert.ok(!p.bumps.some((b) => b.ezKey === 'a wreck'), 'the old name row is not used');
  // A sized line with no id at all is no different.
  assert.equal(plan([line('A Wreck', null, 'Original')]).lines[0].itemId, null);
  // The same line in the fallback path (menu unreadable) is unmatched too.
  assert.equal(plan([line('A Wreck', 's-republished-999', 'Original')], { menuOk: false }).lines[0].itemId, null);
});

test('a plain item matches by name as today, synced single size or no size at all', () => {
  // Single size item: its size id is on the plain row, so the name rules decide.
  assert.equal(plan([line('Farmhouse Salad', 's-salad', 'Serves 1')]).lines[0].itemId, 'm-salad');
  // No size on the line: name rules, exactly as before.
  assert.equal(plan([line('Farmhouse Salad', null, null)]).lines[0].itemId, 'm-salad');
  // Before the migration (no sync columns) nothing changes: an unknown sized line still matches
  // by name, the behaviour this branch started from.
  const before = planLineMatches({ lines: [line('A Wreck', 's-x', 'Original')], ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS,
    links: SYNCED.map(({ ez_ids, ez_size_name, ...r }) => r), locationId: LOC, nowIso: NOW });
  assert.equal(before.lines[0].itemId, 'm-wreck-orig');
});

test('sizeRouteFor: conflicting rows and gone items never guess', () => {
  const idx = indexPublishedIds([
    { kind: 'item', ez_key: 'a|size:x', ez_size_name: 'X', ez_ids: ['dup'], menu_item_id: 'm1' },
    { kind: 'item', ez_key: 'a', ez_size_name: null, ez_ids: ['dup'], menu_item_id: 'm2' },
    { kind: 'item', ez_key: 'b|size:x', ez_size_name: 'X', ez_ids: ['two'], menu_item_id: 'm1' },
    { kind: 'item', ez_key: 'b|size:y', ez_size_name: 'Y', ez_ids: ['two'], menu_item_id: 'm3' },
  ]);
  assert.equal(sizeRouteFor({ ezSizeId: 'dup', sizeName: 'X' }, idx).mode, 'unmatched');
  assert.equal(sizeRouteFor({ ezSizeId: 'two', sizeName: 'X' }, idx).mode, 'unmatched');
  const gone = planLineMatches({ lines: [line('A Wreck', 's-wreck-big', 'Bigs')], ourItems: OUR_ITEMS.filter((i) => i.id !== 'm-wreck-big'),
    ourGroups: OUR_GROUPS, links: SYNCED, locationId: LOC, nowIso: NOW, sizeIds: true });
  assert.equal(gone.lines[0].itemId, null, 'a size row pointing at a deleted item routes nothing');
});

// ── The job ────────────────────────────────────────────────────────────────────────────────

test('sync writes every row once; syncing twice duplicates nothing and keeps staff decisions', async () => {
  const sb = fakeSb(TABLES([
    // Seen on an order before any sync, and cleared by staff before this deploy.
    { location_id: LOC, kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', ez_group: null, menu_item_id: null, option_id: null, source: 'manual', matched_by: null, seen_count: 4, last_seen_at: '2026-09-10T00:00:00Z', ez_ids: [] },
  ]));
  const ask = fakeAsk([POTBELLY, LUNCH, OLD]);
  const first = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => ask, nowMs: NOW_MS });
  assert.equal(first.ok, true, first.message);
  assert.equal(first.status, 'ok');
  assert.equal(links(sb).length, 11, 'every item, size and option exactly once');
  // The staff clear is kept as it was (not auto linked over), its seen count untouched, its ids refreshed.
  const salad = row(sb, 'farmhouse salad');
  assert.equal(salad.menu_item_id, null);
  assert.equal(salad.source, 'manual');
  assert.equal(salad.seen_count, 4);
  assert.deepEqual(salad.ez_ids.sort(), ['s-salad', 's-salad-2']);

  // Staff decide two rows between the syncs.
  Object.assign(row(sb, sizeRowKey('A Wreck', 'Skinny')), { menu_item_id: 'm-wreck-orig', source: 'manual', matched_by: 'user-7' });
  Object.assign(row(sb, sizeRowKey('A Wreck', 'Bigs')), { menu_item_id: null, source: 'manual', matched_by: 'ignored' });
  // ezCater republishes: new published ids.
  const repub = JSON.parse(JSON.stringify(POTBELLY));
  repub.categories[0].items[0].sizes[2].id = 's-wreck-skinny-v2';
  const second = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([repub, LUNCH]), nowMs: NOW_MS + 60_000 });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.counts.inserted, 0, 'nothing new on the second sync');
  assert.equal(links(sb).length, 11, 'no duplicates');
  const skinny = row(sb, sizeRowKey('A Wreck', 'Skinny'));
  assert.equal(skinny.menu_item_id, 'm-wreck-orig', 'the staff match is kept');
  assert.equal(skinny.matched_by, 'user-7');
  assert.deepEqual(skinny.ez_ids, ['s-wreck-skinny-v2'], 'the published id follows the republish');
  const big = row(sb, sizeRowKey('A Wreck', 'Bigs'));
  assert.equal(big.matched_by, 'ignored', '"Not on our menu" is kept');
  assert.equal(big.menu_item_id, null);
});

test('a partial read never takes a live id away', async () => {
  const sb = fakeSb(TABLES([
    { location_id: LOC, kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', menu_item_id: 'm-salad', option_id: null, source: 'auto', matched_by: 'name', seen_count: 0, ez_ids: ['s-salad-old'] },
  ]));
  sb.store.ezcater_caterers.push({ caterer_uuid: 'cat-2', connection_id: 'conn-1', location_id: LOC, active: true });
  const ask = async (op, q, vars) => {
    if (vars.catererId === 'cat-2') throw new Error('network down');
    return fakeAsk([POTBELLY])(op, q, vars);
  };
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => ask, nowMs: NOW_MS });
  assert.equal(r.status, 'partial');
  assert.deepEqual(row(sb, 'farmhouse salad').ez_ids.sort(), ['s-salad', 's-salad-old']);
});

test('option values ezCater refuses: items and sizes still sync, options say so', async () => {
  const calls = [];
  const got = await readCatererMenus(fakeAsk([POTBELLY], { refuseValues: true, calls }), 'cat-1', '2026-09-18');
  assert.equal(got.optionsRead, false);
  assert.equal(got.menus.length, 1);
  assert.ok(calls.every((c) => c.op !== 'ServOsEzMenu' || c.vars.catererId === 'cat-1'));
  assert.ok(MENU_QUERY_NO_OPTIONS.indexOf('values') === -1);
  assert.match(MENU_QUERY, /^query ServOsEzMenu\(/, 'a named operation');
});

test('one sync per venue: a held claim answers busy, a missing claim function answers not ready', async () => {
  const busy = await runMenuSync(fakeSb(TABLES(), { claim: null }), LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]) });
  assert.equal(busy.status, 'busy');
  const sb = fakeSb(TABLES(), { rpcError: { code: 'PGRST202', message: 'Could not find the function public.ezcater_menu_sync_claim' } });
  const off = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]) });
  assert.equal(off.status, 'not_ready');
  assert.equal(links(sb).length, 0, 'nothing written without the claim');
  const noCols = await runMenuSync(fakeSb(TABLES(), { noSyncColumns: true }), LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]) });
  assert.equal(noCols.status, 'not_ready');
});

test('the daily pass picks venues with no good sync for 20 hours', () => {
  const h = 3600 * 1000;
  const rows = [
    { location_id: 'fresh', last_ok_at: new Date(NOW_MS - 2 * h).toISOString(), started_at: new Date(NOW_MS - 2 * h).toISOString() },
    { location_id: 'stale', last_ok_at: new Date(NOW_MS - 30 * h).toISOString(), started_at: new Date(NOW_MS - 30 * h).toISOString() },
    { location_id: 'failing', last_ok_at: null, started_at: new Date(NOW_MS - 1 * h).toISOString() },
  ];
  assert.deepEqual(dueLocations(['fresh', 'stale', 'failing', 'new', 'new'], rows, NOW_MS), ['new', 'stale']);
});

// ── Paging ─────────────────────────────────────────────────────────────────────────────────

test('link reads page past 1000 rows, for the sync and for orders', async () => {
  const many = [];
  for (let i = 0; i < 2500; i++) {
    many.push({ location_id: LOC, kind: 'item', ez_key: 'item ' + String(i).padStart(5, '0'), ez_name: 'Item ' + i,
      menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0, ez_ids: ['id-' + i], ez_size_name: null });
  }
  many.push({ ...many[0], ez_key: 'a wreck|size:bigs', ez_name: 'A Wreck', ez_size_name: 'Bigs', ez_ids: ['s-wreck-big'], menu_item_id: 'm-wreck-big', matched_by: 'name' });
  const sb = fakeSb(TABLES(many));
  const all = await readAllLinks(sb, LOC, 'kind, ez_key');
  assert.equal(all.rows.length, 2501);
  assert.equal(all.complete, true);
  assert.equal(sb.calls.filter((c) => c.op === 'select' && c.table === 'ezcater_item_links').length, 3);
  assert.equal(LINK_PAGE_SIZE, 1000);
  const input = await readMatchInputs(sb, LOC);
  assert.equal(input.links.length, 2501);
  assert.equal(input.linksOk, true);
  assert.equal(input.sizeIds, true);
  // The size row sits past row 1000 and still routes its line.
  const p = planLineMatches({ lines: [line('A Wreck', 's-wreck-big', 'Bigs')], ...input, locationId: LOC, nowIso: NOW });
  assert.equal(p.lines[0].itemId, 'm-wreck-big');
  // A sync over that many rows inserts only what is new.
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]), nowMs: NOW_MS });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.counts.inserted, 10, 'the size row already there is refreshed, not inserted again');
  assert.equal(links(sb).length, 2511);
});

// ── The Item matching card ─────────────────────────────────────────────────────────────────

test('a size row shows its size, suggests on item and size, and saves by its synced key', () => {
  const r = toRow({ kind: 'item', ez_key: 'a wreck|size:skinny', ez_name: 'A Wreck', ez_size_name: 'Skinny', seen_count: 0, synced_at: NOW });
  assert.equal(r.sizeRow, true);
  assert.equal(theirLabel(r), 'A Wreck (Skinny)');
  const sug = suggestionsFor(r, [{ id: 'a', name: 'A Wreck Skinny' }, { id: 'b', name: 'A Wreck Bigs' }], [], { limit: 2 });
  assert.equal(sug[0].id, 'a');
  const body = saveBody(r, { menuItemId: 'a' }).body;
  assert.equal(body.size_row, true);
  assert.equal(body.ez_key, 'a wreck|size:skinny');
  assert.equal(body.menu_item_id, 'a');
  // A plain row is saved exactly as before.
  const plain = saveBody(toRow({ kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad' }), { menuItemId: 'm' }).body;
  assert.equal(plain.size_row, undefined);
  assert.equal(plain.ez_key, 'farmhouse salad');
});
