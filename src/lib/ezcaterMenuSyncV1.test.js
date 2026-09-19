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
  LINK_PAGE_SIZE, exactName, singleSizeExactName, isMissingSyncColumn, isMissingLinksTable,
} from '../../supabase/functions/_shared/ezcaterMenuSync.ts';
import { runMenuSync, dueLocations, runDueSyncs, CRON_BUDGET_MS, MIGRATION_FILE } from '../../supabase/functions/_shared/ezcaterMenuSyncRun.ts';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
  // Their "Farmhouse Salad" is sold only as "Serves 1": its full name is "Farmhouse Salad
  // Serves 1", which is not our "Farmhouse Salad" exactly, so staff decide (exact means exact).
  assert.equal(by(buildLinkKey({ name: 'Farmhouse Salad' }, 'item')).menu_item_id, null);
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
  assert.deepEqual(skinny.ez_ids, ['s-wreck-skinny-v2', 's-wreck-skinny'], 'the new published id first, the old one kept');
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

// ── Review round (18 Sep 2026): exact means exact ──────────────────────────────────────────

const menuOf = (...items) => ({ id: 'm-x', name: 'X', startDate: null, endDate: null,
  categories: [{ id: 'c', name: 'Cat', items }] });
const syncPlan = (menus, ourItems, extra = {}) => planMenuSync({
  entries: flattenMenus(menus), existing: [], ourItems, ourGroups: [], locationId: LOC, nowIso: NOW,
  complete: true, menuOk: true, ...extra,
});

test('exact means exact: the two reproduced wrong links no longer happen (real flattened plain rows)', () => {
  // 1. ezCater single size "Sandwich Platter Large" used to auto link our "Sandwich Platter"
  //    (normaliseItemName dropped "large").
  const platter = menuOf({ id: 'i-p', name: 'Sandwich Platter Large', sizes: [size('s-p', 'Serves 12')] });
  const pRows = flattenMenus([platter]);
  assert.equal(pRows.length, 1);
  assert.equal(pRows[0].ezSizeName, null, 'a single size item is still one plain row');
  assert.equal(pRows[0].exactName, 'sandwich platter large serves 12');
  assert.equal(syncPlan([platter], [{ id: 'm-plat', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  // The same item whose only size repeats its own size word, or has no size at all.
  const platter2 = menuOf({ id: 'i-p2', name: 'Sandwich Platter Large', sizes: [size('s-p2', 'Large')] });
  assert.equal(syncPlan([platter2], [{ id: 'm-plat', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([platter2], [{ id: 'm-plat-l', name: 'Sandwich Platter Large' }]).inserts[0].menu_item_id, 'm-plat-l');
  const bare = menuOf({ id: 'i-p3', name: 'Sandwich Platter Large', sizes: [] });
  assert.equal(syncPlan([bare], [{ id: 'm-plat', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);

  // 2. ezCater "Caesar Salad" with its only size "Large" used to auto link our "Caesar Salad
  //    Small" (the flattener threw the only size name away).
  const caesar = menuOf({ id: 'i-c', name: 'Caesar Salad', sizes: [size('s-c', 'Large')] });
  const cRows = flattenMenus([caesar]);
  assert.equal(cRows.length, 1);
  assert.equal(cRows[0].ezKey, 'caesar salad');
  assert.equal(cRows[0].exactName, 'caesar salad large', 'the only size takes part in the name');
  assert.equal(syncPlan([caesar], [{ id: 'm-cs', name: 'Caesar Salad Small' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([caesar], [{ id: 'm-c', name: 'Caesar Salad' }]).inserts[0].menu_item_id, null,
    'nor our plain Caesar Salad: Large is on their side only');
  assert.equal(syncPlan([caesar], [{ id: 'm-cl', name: 'Caesar Salad (Large)' }, { id: 'm-cs', name: 'Caesar Salad Small' }]).inserts[0].menu_item_id, 'm-cl',
    'the same words, only punctuation differs: linked');
  // A container word on ONE side is a different name too, both ways round.
  const tray = menuOf({ id: 'i-t', name: 'Caesar Salad Half Tray', sizes: [] });
  assert.equal(syncPlan([tray], [{ id: 'm-ch', name: 'Caesar Salad Half' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([menuOf({ id: 'i-t2', name: 'Caesar Salad Half', sizes: [] })], [{ id: 'm-cht', name: 'Caesar Salad Half Tray' }]).inserts[0].menu_item_id, null);
});

test('exact means exact: the Potbelly shape (Italian Boxed Lunch, only size Box) still auto links', () => {
  // HKX77V's line: item "Italian Boxed Lunch", its only size "Box", serves 1.
  const potbelly = menuOf({ id: '279b6bf4', name: 'Italian Boxed Lunch', originalItemId: 'b4d95922', sizes: [
    size('0226b68c-492c-5a38-b528-fd62a1c1e828', 'Box', { serves: 1, originalItemSizeId: 'b4fb83a2' }),
  ] });
  const rows = flattenMenus([potbelly]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exactName, 'italian boxed lunch', '"Box" repeats "Boxed", so it adds nothing');
  assert.deepEqual(rows[0].ids, ['0226b68c-492c-5a38-b528-fd62a1c1e828'], 'the size id, never the item id');
  const p = syncPlan([potbelly], [{ id: 'm-ibl', name: 'Italian Boxed Lunch' }, { id: 'm-it', name: 'Italian' }]);
  assert.equal(p.inserts[0].menu_item_id, 'm-ibl');
  // The rule for container words: a Box (or Tray) the item name does not already say is part of
  // the name, so "Turkey Sandwich" sold only as a Box is not our plain "Turkey Sandwich".
  assert.equal(singleSizeExactName('Turkey Sandwich', 'Box'), 'turkey sandwich box');
  const turkey = menuOf({ id: 'i-ts', name: 'Turkey Sandwich', sizes: [size('s-ts', 'Box')] });
  assert.equal(syncPlan([turkey], [{ id: 'm-ts', name: 'Turkey Sandwich' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([turkey], [{ id: 'm-tsb', name: 'Turkey Sandwich Box' }]).inserts[0].menu_item_id, 'm-tsb');
  const trayOf = menuOf({ id: 'i-it', name: 'Italian Boxed Lunch', sizes: [size('s-tray', 'Tray')] });
  assert.equal(syncPlan([trayOf], [{ id: 'm-ibl', name: 'Italian Boxed Lunch' }]).inserts[0].menu_item_id, null,
    'a Tray of the boxed lunch is not the boxed lunch');
  assert.equal(singleSizeExactName('Cookie Trays', 'Tray'), 'cookie trays');
  assert.equal(exactName('  Crème  Brûlée & Chef’s (Large) '), 'creme brulee and chefs large');
});

test('exact means exact: one key described two ways, two of ours with one name, and multi size rows', () => {
  // "Sandwich Platter Tray" and "Sandwich Platter" share the key "sandwich platter" (the key drops
  // a trailing tray). Which one is ours is a guess, so the merged row is never auto linked.
  const two = menuOf(
    { id: 'a', name: 'Sandwich Platter', sizes: [] },
    { id: 'b', name: 'Sandwich Platter Tray', sizes: [] },
  );
  const rows = flattenMenus([two]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].noAuto, true);
  assert.equal(syncPlan([two], [{ id: 'm-sp', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  // Two of ours with the same exact name: never a guess.
  assert.equal(syncPlan([menuOf({ id: 'c', name: 'Brownie', sizes: [] })],
    [{ id: 'm1', name: 'Brownie' }, { id: 'm2', name: 'brownie' }]).inserts[0].menu_item_id, null);
  // A multi size row links only its full name; a container word on one side links nothing.
  const multi = menuOf({ id: 'd', name: 'Caesar Salad', sizes: [size('s-h', 'Half Tray'), size('s-f', 'Full Tray')] });
  const mp = syncPlan([multi], [{ id: 'm-half', name: 'Caesar Salad Half' }, { id: 'm-full', name: 'Caesar Salad Full Tray' }]);
  assert.equal(mp.inserts.find((r) => r.ez_key === sizeRowKey('Caesar Salad', 'Half Tray')).menu_item_id, null,
    'our "Caesar Salad Half" lacks their Tray');
  assert.equal(mp.inserts.find((r) => r.ez_key === sizeRowKey('Caesar Salad', 'Full Tray')).menu_item_id, 'm-full');
});

// ── Review round: the order time id rule, failed reads, kept ids ───────────────────────────

test('order time matches on the SIZE id only, never the order line item id (HKX77V)', () => {
  const synced = [{ kind: 'item', ez_key: sizeRowKey('Italian Boxed Lunch', 'Box'), ez_name: 'Italian Boxed Lunch', ez_size_name: 'Box',
    ez_ids: ['0226b68c-492c-5a38-b528-fd62a1c1e828'], menu_item_id: 'm-ibl', option_id: null, source: 'auto', matched_by: 'name', seen_count: 0 }];
  const idx = indexPublishedIds(synced);
  const hk = { name: 'Italian Boxed Lunch', sizeName: 'Box', ezItemId: '5f5b503b', ezSizeId: '0226b68c-492c-5a38-b528-fd62a1c1e828' };
  assert.equal(sizeRouteFor(hk, idx).mode, 'size');
  // An item id that happens to be on a row matches nothing: only ezSizeId is read.
  const byItemId = indexPublishedIds([{ ...synced[0], ez_ids: ['5f5b503b'] }]);
  assert.equal(sizeRouteFor(hk, byItemId).mode, 'unmatched');
  assert.equal(sizeRouteFor({ ...hk, ezSizeId: null }, byItemId).mode, 'unmatched');
});

test('a failed link read never falls back to name guessing; only a proven missing column does', async () => {
  const failing = (error) => ({
    from: (name) => {
      const b = {
        select() { return b; }, eq() { return b; }, order() { return b; }, range() { return b; },
        is() { return b; }, not() { return b; }, in() { return b; },
        then(ok, no) {
          const out = name === 'ezcater_item_links' ? { data: null, error }
            : { data: name === 'menu_items' ? MENU_ROWS : GROUP_ROWS, error: null };
          return Promise.resolve(out).then(ok, no);
        },
      };
      return b;
    },
  });
  // A timeout, a permission fault, a network fault, an unrelated error that names a column:
  // sizeIds stays true, nothing is written, every sized line is unmatched.
  for (const error of [
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: '42501', message: 'permission denied for table ezcater_item_links' },
    { message: 'FetchError: network down' },
    { code: 'XX000', message: 'something about column ez_ids broke' },
  ]) {
    const input = await readMatchInputs(failing(error), LOC);
    assert.equal(input.sizeIds, true, error.message);
    assert.equal(input.linksOk, false);
    const p = planLineMatches({ lines: [line('A Wreck Original', 's-anything', 'Original'), line('Farmhouse Salad', null, null)],
      ...input, locationId: LOC, nowIso: NOW });
    assert.equal(p.lines[0].itemId, null, 'a sized line prints by name: ' + error.message);
    assert.equal(p.lines[1].itemId, 'm-salad', 'an unsized line keeps the old name rule');
    // linksOk false: matchQueueRow saves none of the plan's writes.
  }
  // A read that throws is no different.
  const throwing = { from: () => { throw new Error('boom'); } };
  assert.equal((await readMatchInputs(throwing, LOC)).sizeIds, true);
  // The missing column, PROVEN: the rules before the migration, including the name match of a sized line.
  const sb = fakeSb(TABLES(SYNCED.map(({ ez_ids, ez_size_name, ...r }) => ({ ...r, location_id: LOC }))), { noSyncColumns: true });
  const before = await readMatchInputs(sb, LOC);
  assert.equal(before.sizeIds, false);
  assert.equal(before.linksOk, true);
  const bp = planLineMatches({ lines: [line('A Wreck', 's-x', 'Original')], ...before, locationId: LOC, nowIso: NOW });
  assert.equal(bp.lines[0].itemId, 'm-wreck-orig');
  // No links table at all (20260917 not run) is proven too: no sync can have run.
  const noTable = await readMatchInputs(failing({ code: '42P01', message: 'relation "public.ezcater_item_links" does not exist' }), LOC);
  assert.equal(noTable.sizeIds, false);
  assert.equal(isMissingSyncColumn({ code: '42703', message: 'column ezcater_item_links.ez_ids does not exist' }), true);
  assert.equal(isMissingSyncColumn({ code: 'PGRST204', message: "Could not find the 'ez_size_name' column of 'ezcater_item_links' in the schema cache" }), true);
  assert.equal(isMissingSyncColumn({ code: 'XX000', message: 'something about column ez_ids broke' }), false);
  assert.equal(isMissingSyncColumn({ code: '57014', message: 'statement timeout' }), false);
  assert.equal(isMissingLinksTable({ code: '42P01', message: 'relation "public.menu_items" does not exist' }), false, 'another table is not proof');
});

test('a republish keeps the old size id: an order matched before it still matches when modified later', async () => {
  const sb = fakeSb(TABLES());
  const first = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]), nowMs: NOW_MS });
  assert.equal(first.ok, true, first.message);
  // The caterer republishes: every published size id changes.
  const repub = JSON.parse(JSON.stringify(POTBELLY));
  for (const c of repub.categories) for (const it of c.items) for (const z of it.sizes) z.id = z.id + '-v2';
  const second = await runMenuSync(sb, LOC, { reason: 'daily', makeAsk: () => fakeAsk([repub]), nowMs: NOW_MS + 86_400_000 });
  assert.equal(second.status, 'ok', 'a complete read');
  const big = row(sb, sizeRowKey('A Wreck', 'Bigs'));
  assert.deepEqual(big.ez_ids, ['s-wreck-big-v2', 's-wreck-big'], 'a complete sync adds, never replaces');
  // The order placed before the republish carries the OLD id; ezCater sends a change later.
  const input = await readMatchInputs(sb, LOC);
  const oldLine = planLineMatches({ lines: [line('A Wreck', 's-wreck-big', 'Bigs')], ...input, locationId: LOC, nowIso: NOW });
  assert.equal(oldLine.lines[0].itemId, 'm-wreck-big', 'the old id still routes');
  const newLine = planLineMatches({ lines: [line('A Wreck', 's-wreck-big-v2', 'Bigs')], ...input, locationId: LOC, nowIso: NOW });
  assert.equal(newLine.lines[0].itemId, 'm-wreck-big');
  // Should an id ever sit on two rows, the existing checks still answer unmatched.
  const clash = indexPublishedIds([
    { kind: 'item', ez_key: 'a|size:x', ez_size_name: 'X', ez_ids: ['new', 'shared'], menu_item_id: 'm1' },
    { kind: 'item', ez_key: 'b|size:y', ez_size_name: 'Y', ez_ids: ['shared'], menu_item_id: 'm2' },
    { kind: 'item', ez_key: 'c', ez_size_name: null, ez_ids: ['plain-and-size'], menu_item_id: 'm3' },
    { kind: 'item', ez_key: 'c|size:z', ez_size_name: 'Z', ez_ids: ['plain-and-size'], menu_item_id: 'm3' },
  ]);
  assert.deepEqual(sizeRouteFor({ ezSizeId: 'shared', sizeName: 'X' }, clash), { mode: 'unmatched', reason: 'size rows disagree' });
  assert.deepEqual(sizeRouteFor({ ezSizeId: 'plain-and-size', sizeName: 'Z' }, clash), { mode: 'unmatched', reason: 'id on a plain row and a size row' });
  assert.equal(sizeRouteFor({ ezSizeId: 'new', sizeName: 'X' }, clash).mode, 'size');
});

test('a null menu is a partial read: status partial, nothing replaced', async () => {
  // ezCater lists two current menus but answers the second with menu: null.
  const ask = async (op, q, vars) => {
    if (op === 'ServOsEzMenus') return { menus: { nodes: [{ id: 'menu-1', name: 'P' }, { id: 'menu-null', name: 'Gone' }] } };
    if (vars.id === 'menu-null') return { menu: null };
    return fakeAsk([POTBELLY])(op, q, vars);
  };
  const got = await readCatererMenus(ask, 'cat-1', '2026-09-18');
  assert.equal(got.missing, 1);
  assert.equal(got.menus.length, 1);
  assert.equal((await readCatererMenus(fakeAsk([POTBELLY]), 'cat-1', '2026-09-18')).missing, 0);
  const sb = fakeSb(TABLES([
    { location_id: LOC, kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', menu_item_id: 'm-salad', option_id: null, source: 'manual', matched_by: 'u', seen_count: 2, ez_ids: ['s-salad-lunch'] },
  ]));
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => ask, nowMs: NOW_MS });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'partial');
  assert.match(r.message, /no menu for 1 current menu/);
  assert.deepEqual(row(sb, 'farmhouse salad').ez_ids.sort(), ['s-salad', 's-salad-lunch'], 'nothing taken away');
  assert.equal(row(sb, 'farmhouse salad').menu_item_id, 'm-salad');
});

test('the daily run stays under call_edge_fn 25 s timeout; the rest wait for the next run', async () => {
  assert.ok(CRON_BUDGET_MS < 25_000);
  assert.equal(CRON_BUDGET_MS, 18_000);
  const venues = (n) => Array.from({ length: n }, (_, i) => 'v' + (i + 1));
  const sbOf = (n) => fakeSb({ ezcater_caterers: venues(n).map((v) => ({ location_id: v, active: true })), ezcater_menu_syncs: [] });
  let t = 0;
  const ran = [];
  const takes = (ms) => async (_sb, loc) => { ran.push(loc); t += ms; return { ok: true, status: 'ok', message: '' }; };
  // 7 s a venue: v1 from 0 s, v2 from 7 s; at 14 s the slowest (7 s) would end past 18 s: stop.
  const out = await runDueSyncs(sbOf(5), () => null, { clock: () => t, runOne: takes(7_000) });
  assert.deepEqual(ran, ['v1', 'v2']);
  assert.equal(out.stoppedForTime, true);
  assert.equal(out.left, 3, 'three venues wait for the next hourly run');
  assert.equal(out.due, 5);
  assert.ok(t < 25_000);
  // A bigger budget is refused (it can only shrink): 3 s a venue, starts at 0..15 s, never at 18 s.
  t = 0; ran.length = 0;
  const big = await runDueSyncs(sbOf(10), () => null, { clock: () => t, runOne: takes(3_000), budgetMs: 600_000 });
  assert.equal(big.ran.length, 6);
  assert.equal(big.left, 4);
  assert.ok(t < 25_000, 'finished at ' + t);
  // A spent budget starts nothing.
  t = 0; ran.length = 0;
  const none = await runDueSyncs(sbOf(5), () => null, { clock: () => t, runOne: takes(1), budgetMs: 0 });
  assert.equal(none.ran.length, 0);
  assert.equal(none.left, 5);
});

test('the sync migration is 20260919m and every reference names it', () => {
  const root = new URL('../../', import.meta.url);
  assert.equal(MIGRATION_FILE, '20260919m_OPS_ezcater_menu_sync_v1.sql');
  assert.ok(existsSync(new URL('supabase/migrations/' + MIGRATION_FILE, root)));
  assert.ok(!existsSync(new URL('supabase/migrations/20260918e_OPS_ezcater_menu_sync_v1.sql', root)));
  const same = readdirSync(new URL('supabase/migrations/', root)).filter((f) => f.startsWith('20260919m'));
  assert.deepEqual(same, [MIGRATION_FILE], 'nothing else uses 20260919m');
  for (const f of ['supabase/functions/_shared/ezcaterMenuSync.ts', 'supabase/functions/_shared/ezcater-match-ingest.ts',
    'supabase/functions/_shared/ezcaterMenuSyncRun.ts', 'supabase/functions/ezcater-connect/index.ts', 'DECISIONS.md',
    'supabase/migrations/' + MIGRATION_FILE]) {
    const text = readFileSync(new URL(f, root), 'utf8');
    assert.ok(!text.includes('20260918e'), f + ' still names 20260918e');
  }
});
