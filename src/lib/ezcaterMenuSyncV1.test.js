/**
 * ezcaterMenuSyncV1.test.js
 *
 * "Sync ezCater menu", the conservative version (feat/ezcater-menu-sync-v1), after review round 3:
 *   supabase/functions/_shared/ezcaterMenuSync.ts      rules: rows, keys, exact auto links, id routes
 *   supabase/functions/_shared/ezcaterMenuSyncRun.ts   the job: claim, read, plan, write
 *   supabase/functions/_shared/ezcater-match-ingest.ts the order time rules, paged link reads
 *
 * THE RULES UNDER TEST
 *   A  once 20260919m has run, orders only use matches made before the order: a line matches only
 *      by its published size id on a synced row holding a staff match or an exact auto link from a
 *      sync. No name matching at order time at all; nothing written but seen counters.
 *   B  every sync decides every automatic row again from the whole menu (kept, moved or cleared);
 *      a staff decision is never changed, and one whose ezCater name or size changed since the
 *      staff saved it is flagged for staff to look at again (and orders do not use it until then)
 *   C  an option auto links only when its group AND its value are exact
 *   D  what the earlier rounds fixed: failed or partial link reads print by name, ids kept across a
 *      republish, the NOT NULL source default, the 18 s cron budget, the migration name 20260919m
 *
 * No live ezCater call: ezCater is a fake `ask` answering in the shape proven live on 18 Sep 2026.
 * Run: `npm test`, or `node --test src/lib/ezcaterMenuSyncV1.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  flattenMenus, planMenuSync, autoTargetFor, sizeRowKey, sizeRouteFor, optionRouteFor, indexPublishedIds,
  currentMenus, venueDate, readCatererMenus, readAllLinks, MENU_QUERY, MENU_QUERY_NO_OPTIONS,
  LINK_PAGE_SIZE, exactName, singleSizeExactName, sizeAddsWords, fullNameOf, lookAgainOf,
  isMissingSyncColumn, isMissingLinksTable, writeSyncPlan, trustedTarget, isSyncedRow,
} from '../../supabase/functions/_shared/ezcaterMenuSync.ts';
import { runMenuSync, dueLocations, runDueSyncs, CRON_BUDGET_MS, MIGRATION_FILE } from '../../supabase/functions/_shared/ezcaterMenuSyncRun.ts';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  planLineMatches, planSyncedLineMatches, planNameMatches, readMatchInputs, saveLinkWrites, matchQueueRow,
} from '../../supabase/functions/_shared/ezcater-match-ingest.ts';
import { buildLinkKey } from '../../supabase/functions/_shared/ezcaterMatch.ts';
import { orderItemsToLines } from '../../supabase/functions/_shared/ezcater-map.ts';
import {
  toRow, rowsFrom, saveBody, applySaved, theirLabel, suggestionsFor, countRows,
  liveRows, offMenuRows, lookAgainCount, lookAgainNote, offMenuLine,
} from './ezcaterItemRows.js';

const NOW = '2026-09-18T15:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const LOC = 'loc-1';
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

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
// The same salad on a second current menu, under a new published id.
const LUNCH = {
  id: 'menu-2', name: 'Lunch', startDate: null, endDate: null,
  categories: [{ id: 'c-9', name: 'Sandwiches', items: [
    { id: 'i2', name: 'Farmhouse Salad', sizes: [size('s-salad-2', 'Serves 1')] },
  ] }],
};
const OLD = { id: 'menu-0', name: 'Old', startDate: '2025-01-01', endDate: '2025-12-31', categories: [] };
// HKX77V's item, exactly as the live menu read has it (18 Sep 2026).
const HKX77V_SIZE_ID = '0226b68c-492c-5a38-b528-fd62a1c1e828';
const HKX77V_MENU = {
  id: 'menu-hk', name: 'Boxed Lunches', startDate: null, endDate: null,
  categories: [{ id: 'c-hk', name: 'Boxed Lunches', items: [
    { id: '279b6bf4', name: 'Italian Boxed Lunch', originalItemId: 'b4d95922', sizes: [
      size(HKX77V_SIZE_ID, 'Box', { serves: 1, originalItemSizeId: 'b4fb83a2' }),
    ] },
  ] }],
};

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

// ── The real schema, read from the migrations ──────────────────────────────────────────────
// Every column of a table as the migrations leave it, in file order: NOT NULL or not, and
// whether it has a default. The fake below rejects an insert or upsert exactly as Postgres does:
// ON CONFLICT builds the whole insert tuple first, so a NOT NULL column with no default that the
// payload leaves out fails the statement even when the row already exists.

const MIGRATIONS_DIR = new URL('../../supabase/migrations/', import.meta.url);

function schemaOf(table, files) {
  const list = files || readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const cols = new Map();
  const t = table.replace(/[^a-z0-9_]/gi, '');
  for (const f of list) {
    const sql = readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8').replace(/--[^\n]*/g, '');
    const create = sql.match(new RegExp(`create table if not exists public\\.${t}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'));
    if (create) {
      for (const raw of create[1].split('\n')) {
        const line = raw.trim().replace(/,$/, '');
        const pk = line.match(/^primary key\s*\(([^)]*)\)/i);
        if (pk) { for (const c of pk[1].split(',')) { const e = cols.get(c.trim()); if (e) e.notNull = true; } continue; }
        const cm = line.match(/^([a-z_][a-z0-9_]*)\s+(.+)$/i);
        if (!cm || /^(constraint|unique|check|foreign|primary)$/i.test(cm[1])) continue;
        cols.set(cm[1], { notNull: /\bnot null\b|\bprimary key\b/i.test(cm[2]), hasDefault: /\bdefault\b/i.test(cm[2]) });
      }
    }
    const alter = `alter table (?:if exists )?(?:only )?public\\.${t}\\s+`;
    for (const m of sql.matchAll(new RegExp(alter + 'add column (?:if not exists )?([a-z_][a-z0-9_]*)\\s+([^;]*);', 'gi'))) {
      if (!cols.has(m[1])) cols.set(m[1], { notNull: /\bnot null\b/i.test(m[2]), hasDefault: /\bdefault\b/i.test(m[2]) });
    }
    for (const m of sql.matchAll(new RegExp(alter + 'alter column ([a-z_][a-z0-9_]*)\\s+(set|drop) (default|not null)', 'gi'))) {
      const c = cols.get(m[1]);
      if (!c) continue;
      if (m[3].toLowerCase() === 'default') c.hasDefault = m[2].toLowerCase() === 'set';
      else c.notNull = m[2].toLowerCase() === 'set';
    }
  }
  return cols;
}

/**
 * Postgres' answer to one insert or upsert of `rows` (PostgREST sends the union of the rows'
 * keys as the column list: a key another row has becomes NULL, a key no row has takes the
 * column default). null when every row is accepted, else the error.
 */
function notNullError(schema, rows) {
  if (!schema || !schema.size) return null;
  const named = new Set(rows.flatMap((r) => Object.keys(r || {})));
  for (const r of rows) {
    for (const [col, c] of schema) {
      if (!c.notNull) continue;
      const v = named.has(col) ? (r[col] === undefined ? null : r[col]) : (c.hasDefault ? 'default' : null);
      if (v === null) return { code: '23502', message: `null value in column "${col}" of relation violates not-null constraint` };
    }
  }
  return null;
}

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

/**
 * `failUpdate(table, patch, eq)` returns the error one update should fail with, or null.
 * `noSyncColumns` is the database before 20260919m: a select naming a sync column fails whole.
 */
function fakeSb(tables, { claim = 'claim-1', rpcError = null, noSyncColumns = false, failLinkPageFrom = null, failUpdate = null,
  noApiUrl = false, schemas = { ezcater_item_links: schemaOf('ezcater_item_links') } } = {}) {
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
      if (failLinkPageFrom != null && name === 'ezcater_item_links' && st.op === 'select' && st.range && st.range[0] >= failLinkPageFrom) {
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      if (noSyncColumns && st.op === 'select' && /ez_ids|ez_size_name|decided_as/.test(st.cols)) {
        return { data: null, error: { code: '42703', message: 'column ezcater_item_links.ez_ids does not exist' } };
      }
      if (noApiUrl && name === 'ezcater_connections' && st.op === 'select' && /api_url/.test(st.cols)) {
        return { data: null, error: { code: '42703', message: 'column ezcater_connections.api_url does not exist' } };
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
        // The insert tuple is checked BEFORE conflict resolution, for every row, as Postgres does.
        const bad = notNullError(schemas[name], rows);
        if (bad) return { data: null, error: bad };
        const defaults = schemas[name] ? { source: 'auto' } : {};
        const named = new Set(rows.flatMap((r) => Object.keys(r || {})));
        for (const r of rows) {
          const prev = list.find((e) => sameKey(e, r));
          // DO UPDATE sets only the columns the payload named; DO NOTHING sets none.
          if (prev) { if (!st.opts?.ignoreDuplicates) Object.assign(prev, r); continue; }
          const fresh = { ...r };
          for (const [k, v] of Object.entries(defaults)) if (!named.has(k) && schemas[name].get(k)?.hasDefault) fresh[k] = v;
          list.push(fresh);
        }
        return { data: null, error: null };
      }
      calls.push({ op: 'update', table: name, patch: st.patch, eq: { ...st.eq }, nulls: { ...st.nulls } });
      const refused = failUpdate ? failUpdate(name, st.patch, st.eq) : null;
      if (refused) return { data: null, error: refused };
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
/** A row without some of its columns. */
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
/** The columns 20260919m adds: a row read before it has none of them. */
const SYNC_COLUMNS = ['ez_ids', 'ez_size_name', 'ez_only_size', 'synced_at', 'decided_as'];
/** The only columns an order may move on a synced row. */
const COUNTERS = ['seen_count', 'last_seen_at', 'updated_at'];
const row = (sb, key) => links(sb).find((r) => r.ez_key === key);
const menuOf = (...items) => ({ id: 'm-x', name: 'X', startDate: null, endDate: null,
  categories: [{ id: 'c', name: 'Cat', items }] });
const syncPlan = (menus, ourItems, extra = {}) => planMenuSync({
  entries: flattenMenus(menus), existing: [], ourItems, ourGroups: [], locationId: LOC, nowIso: NOW,
  complete: true, menuOk: true, ...extra,
});
/** An order line as ezcater-map.ts builds it: the published size id and size name, no item match. */
const line = (name, ezSizeId, sizeName, extra = {}) => ({ itemId: null, name, ezSizeId, sizeName, qty: 1, price: 10, mods: [], ...extra });

/**
 * What ezcater-connect items_save writes for one Item matching card save (the edge function is
 * Deno and cannot be imported here; a static test below holds this mirror to it): the card's
 * saveBody, then an existing row UPDATED by its key (never renamed: a sync may have refreshed its
 * name since the screen loaded), a name with no row yet inserted, both recording what the screen
 * showed as decided_as (fullNameOf).
 */
function itemsSave(sb, dbRow, choice, userId = 'user-1') {
  const shown = toRow({ ...dbRow, look_again: lookAgainOf(dbRow).lookAgain }, { syncReady: true });
  const body = saveBody(shown, choice).body;
  const matchedBy = body.ignored ? 'ignored' : ((body.menu_item_id || body.option_id) ? userId : null);
  if (body.size_row) {
    const hit = links(sb).find((x) => x.kind === 'item' && x.ez_key === body.ez_key && x.ez_size_name);
    Object.assign(hit, { menu_item_id: body.menu_item_id, option_id: null, source: 'manual', matched_by: matchedBy,
      decided_as: fullNameOf({ kind: 'item', name: body.ez_name, sizeName: body.seen_size || body.ez_key.split('|size:')[1] }) });
    return body;
  }
  const key = buildLinkKey({ name: body.ez_name, groupLabel: body.ez_group || '' }, body.kind);
  const decision = { menu_item_id: body.menu_item_id, option_id: body.option_id, source: 'manual', matched_by: matchedBy,
    decided_as: fullNameOf({ kind: body.kind, name: body.ez_name, group: body.ez_group || '', onlySize: body.kind === 'item' ? (body.seen_size || '') : '' }) };
  const hit = links(sb).find((x) => x.kind === body.kind && x.ez_key === key);
  if (hit) Object.assign(hit, decision);
  else links(sb).push({ location_id: LOC, kind: body.kind, ez_key: key, ez_name: body.ez_name, ez_group: body.ez_group, seen_count: 0, ...decision });
  return body;
}

/**
 * END TO END, as production runs it, on one fake database enforcing the real NOT NULL rules:
 * each entry of `menus` is synced in turn (readMatchInputs, flattenMenus, planMenuSync,
 * writeSyncPlan: what runMenuSync does), `after[i]` runs after sync i (a staff save, one of our
 * items renamed), then the order goes through readMatchInputs, planLineMatches and saveLinkWrites,
 * and the same order through matchQueueRow on a copy of the database.
 */
async function pipeline({ menus, ours, groups = [], existing = [], after = [], lines }) {
  const t = TABLES(existing.map((r) => ({ location_id: LOC, ...r })));
  t.menu_items = ours.map((i) => ({ ...i, location_id: LOC, menu_name: null, pricing: { base: 9 }, archived: false }));
  t.modifier_groups = groups.map((g) => ({ ...g, location_id: LOC }));
  const sb = fakeSb(t);
  const plans = [];
  for (let i = 0; i < menus.length; i++) {
    plans.push(await syncOnce(sb, menus[i]));
    if (after[i]) await after[i](sb);
  }
  const decisions = () => links(sb).map((r) => omit(r, COUNTERS));
  const copy = JSON.parse(JSON.stringify(sb.store));
  const before = decisions();
  const lp = await orderThrough(sb, lines);
  const q = await matchQueueRow(fakeSb(copy), LOC, { ref: 'EZ-1', items: lines, customer: {} }, { nowIso: NOW, budgetMs: 0 });
  return { sb, plans, out: lp.lines, lp, before, after: decisions(), queued: q.row.items, ran: q.ran,
    row: (key) => links(sb).find((r) => r.ez_key === key) };
}

/** One sync as runMenuSync runs it, after its claim: readMatchInputs, flattenMenus, planMenuSync, writeSyncPlan. */
async function syncOnce(sb, menus) {
  const input = await readMatchInputs(sb, LOC);
  assert.equal(input.sizeIds, true);
  assert.equal(input.linksOk, true);
  const plan = planMenuSync({ entries: flattenMenus(menus), existing: input.links, ourItems: input.ourItems,
    ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: input.menuOk });
  const wrote = await writeSyncPlan(sb, LOC, plan, NOW);
  assert.deepEqual(wrote.errors, []);
  return plan;
}

/** One order through readMatchInputs, planLineMatches and saveLinkWrites. */
async function orderThrough(sb, lines) {
  const input = await readMatchInputs(sb, LOC);
  const lp = planLineMatches({ lines, ...input, locationId: LOC, nowIso: NOW });
  await saveLinkWrites(sb, LOC, lp.writes, lp.bumps, NOW, lp.upgrades);
  return lp;
}

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

test('full names: what a person sees, what "changed" compares, and what an exact link needs', () => {
  assert.equal(fullNameOf({ kind: 'item', name: 'Turkey Sandwich', onlySize: 'Box' }), 'Turkey Sandwich Box');
  assert.equal(fullNameOf({ kind: 'item', name: 'Italian Boxed Lunch', onlySize: 'Box' }), 'Italian Boxed Lunch', 'Box repeats Boxed');
  assert.equal(fullNameOf({ kind: 'item', name: 'Caesar Salad', sizeName: 'Half Tray' }), 'Caesar Salad Half Tray');
  assert.equal(fullNameOf({ kind: 'item', name: 'Turkey Sandwich' }), 'Turkey Sandwich');
  assert.equal(fullNameOf({ kind: 'option', name: 'White', group: 'Bread' }), 'Bread: White');
  assert.equal(sizeAddsWords('Cookie Trays', 'Tray'), false);
  assert.equal(sizeAddsWords('Caesar Salad', ''), false, 'a size with no name adds nothing');
  assert.equal(singleSizeExactName('Caesar Salad', 'Large'), 'caesar salad large');
  assert.equal(exactName('  Crème  Brûlée & Chef\u2019s (Large) '), 'creme brulee and chefs large');
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
  assert.equal(by(sizeRowKey('A Wreck', 'Bigs')).matched_by, 'exact', 'a sync auto link is marked exact');
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
  // Cookie Tray Serves 10 and Serves 20: never linked to our one Cookie Tray.
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

test('exact means exact: a size or container word on one side only never links', () => {
  // ezCater single size "Sandwich Platter Large" is not our "Sandwich Platter".
  const platter = menuOf({ id: 'i-p', name: 'Sandwich Platter Large', sizes: [size('s-p', 'Serves 12')] });
  assert.equal(flattenMenus([platter])[0].exactName, 'sandwich platter large serves 12');
  assert.equal(syncPlan([platter], [{ id: 'm-plat', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  const platter2 = menuOf({ id: 'i-p2', name: 'Sandwich Platter Large', sizes: [size('s-p2', 'Large')] });
  assert.equal(syncPlan([platter2], [{ id: 'm-plat', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([platter2], [{ id: 'm-plat-l', name: 'Sandwich Platter Large' }]).inserts[0].menu_item_id, 'm-plat-l');
  // "Caesar Salad" sold only as "Large" is neither our "Caesar Salad Small" nor our plain "Caesar Salad".
  const caesar = menuOf({ id: 'i-c', name: 'Caesar Salad', sizes: [size('s-c', 'Large')] });
  assert.equal(flattenMenus([caesar])[0].ezKey, 'caesar salad');
  assert.equal(syncPlan([caesar], [{ id: 'm-cs', name: 'Caesar Salad Small' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([caesar], [{ id: 'm-c', name: 'Caesar Salad' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([caesar], [{ id: 'm-cl', name: 'Caesar Salad (Large)' }, { id: 'm-cs', name: 'Caesar Salad Small' }]).inserts[0].menu_item_id, 'm-cl',
    'the same words, only punctuation differs: linked');
  // A container word on ONE side is a different name too, both ways round.
  assert.equal(syncPlan([menuOf({ id: 'i-t', name: 'Caesar Salad Half Tray', sizes: [] })], [{ id: 'm-ch', name: 'Caesar Salad Half' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([menuOf({ id: 'i-t2', name: 'Caesar Salad Half', sizes: [] })], [{ id: 'm-cht', name: 'Caesar Salad Half Tray' }]).inserts[0].menu_item_id, null);
  // "Turkey Sandwich" sold only as a Box is not our plain "Turkey Sandwich"; the Potbelly Box is.
  const turkey = menuOf({ id: 'i-ts', name: 'Turkey Sandwich', sizes: [size('s-ts', 'Box')] });
  assert.equal(syncPlan([turkey], [{ id: 'm-ts', name: 'Turkey Sandwich' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([turkey], [{ id: 'm-tsb', name: 'Turkey Sandwich Box' }]).inserts[0].menu_item_id, 'm-tsb');
  const p = syncPlan([HKX77V_MENU], [{ id: 'm-ibl', name: 'Italian Boxed Lunch' }, { id: 'm-it', name: 'Italian' }]);
  assert.equal(p.inserts[0].menu_item_id, 'm-ibl');
  assert.deepEqual(p.inserts[0].ez_ids, [HKX77V_SIZE_ID], 'the size id, never the item id');
});

test('exact means exact: one key described two ways, two of ours with one name, and multi size rows', () => {
  // "Sandwich Platter Tray" and "Sandwich Platter" share the key "sandwich platter" (the key drops
  // a trailing tray). Which one is ours is a guess, so the merged row is never auto linked, and it
  // shows the same description whatever order the menus come in.
  const a = { id: 'a', name: 'Sandwich Platter', sizes: [] };
  const b = { id: 'b', name: 'Sandwich Platter Tray', sizes: [] };
  const rows = flattenMenus([menuOf(a, b)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].noAuto, true);
  assert.equal(rows[0].ezName, flattenMenus([menuOf(b, a)])[0].ezName, 'stable whatever the menu order');
  assert.equal(syncPlan([menuOf(a, b)], [{ id: 'm-sp', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  // Two of ours with the same exact name: never a guess.
  assert.equal(syncPlan([menuOf({ id: 'c', name: 'Brownie', sizes: [] })],
    [{ id: 'm1', name: 'Brownie' }, { id: 'm2', name: 'brownie' }]).inserts[0].menu_item_id, null);
  // A multi size row links only its full name; a container word on one side links nothing.
  const multi = menuOf({ id: 'd', name: 'Caesar Salad', sizes: [size('s-h', 'Half Tray'), size('s-f', 'Full Tray')] });
  const mp = syncPlan([multi], [{ id: 'm-half', name: 'Caesar Salad Half' }, { id: 'm-full', name: 'Caesar Salad Full Tray' }]);
  assert.equal(mp.inserts.find((r) => r.ez_key === sizeRowKey('Caesar Salad', 'Half Tray')).menu_item_id, null);
  assert.equal(mp.inserts.find((r) => r.ez_key === sizeRowKey('Caesar Salad', 'Full Tray')).menu_item_id, 'm-full');
});

// ── RULE C: an option needs its group AND its value exact ──────────────────────────────────

const subWith = (group, values) => menuOf({ id: 'i-sub', name: 'Sub', sizes: [
  size('s-sub', '', { customizationTypes: [{ id: 'ct-1', name: group, values }] }),
] });

test('RULE C: an option auto links only when the group AND the value are exact (Bread: White is never our Cheese White)', () => {
  const entries = flattenMenus([subWith('Bread', [{ id: 'v-w', name: 'White' }])]);
  const white = entries.find((e) => e.kind === 'option');
  assert.equal(white.ezGroup, 'Bread');
  const cheese = { id: 'g-cheese', name: 'Cheese', options: [{ id: 'o-w-cheese', name: 'White' }] };
  const bread = { id: 'g-bread', name: 'Bread', options: [{ id: 'o-w-bread', name: 'White', itemId: 'm-white-bread' }] };
  assert.equal(autoTargetFor(white, [], [cheese]), null, 'our White in the Cheese group is a different thing');
  assert.deepEqual(autoTargetFor(white, [], [cheese, bread]), { menuItemId: 'm-white-bread', optionId: 'o-w-bread' });
  // Two groups of ours called Bread, each with a White: a guess, so nothing.
  assert.equal(autoTargetFor(white, [], [bread, { ...bread, id: 'g-bread-2', options: [{ id: 'o-w-2', name: 'White' }] }]), null);
  // A group that is not the same exact name, or no group at all: nothing.
  assert.equal(autoTargetFor(white, [], [{ ...bread, name: 'Bread Choice' }]), null);
  assert.equal(autoTargetFor({ ...white, ezGroup: null }, [], [bread]), null);
  // A value that differs: nothing.
  assert.equal(autoTargetFor({ ...white, ezName: 'White Roll', exactName: 'white roll' }, [], [bread]), null);
  // One key, two groups ("Bread" and "Bread Size" both key as "bread"): never auto linked.
  const two = flattenMenus([subWith('Bread', [{ id: 'v-1', name: 'White' }]),
    { ...subWith('Bread Size', [{ id: 'v-2', name: 'White' }]), id: 'm-y' }]).filter((e) => e.kind === 'option');
  assert.equal(two.length, 1);
  assert.equal(two[0].noAuto, true);
  assert.equal(autoTargetFor(two[0], [], [bread]), null);
});

test('RULE C end to end: Bread White routes to our Bread White, never to our Cheese White', async () => {
  const lines = orderItemsToLines([{ uuid: 'ol-1', name: 'Sub', menuItemSizeId: 's-sub', menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: 'v-w', customizationTypeId: 'ct-1', customizationTypeName: 'Bread', name: 'White', quantity: 1 }] }]);
  const cheese = { id: 'g-cheese', name: 'Cheese', options: [{ id: 'o-w-cheese', name: 'White' }] };
  const bread = { id: 'g-bread', name: 'Bread', options: [{ id: 'o-w-bread', name: 'White' }] };
  const menus = [[subWith('Bread', [{ id: 'v-w', name: 'White' }])]];
  const ours = [{ id: 'm-sub', name: 'Sub' }];
  const onlyCheese = await pipeline({ menus, ours, groups: [cheese], lines });
  assert.equal(onlyCheese.out[0].mods[0].optionId, null);
  assert.equal(onlyCheese.queued[0].mods[0].optionId, null);
  assert.equal(onlyCheese.row(buildLinkKey({ name: 'White', groupLabel: 'Bread' }, 'option')).option_id, null);
  const withBread = await pipeline({ menus, ours, groups: [cheese, bread], lines });
  assert.equal(withBread.out[0].itemId, 'm-sub');
  assert.equal(withBread.out[0].mods[0].optionId, 'o-w-bread');
  assert.equal(withBread.queued[0].mods[0].optionId, 'o-w-bread');
});

// ── RULE A: orders only use matches made before the order ──────────────────────────────────

const SYNCED = [
  { kind: 'item', ez_key: sizeRowKey('A Wreck', 'Bigs'), ez_name: 'A Wreck', ez_size_name: 'Bigs', ez_ids: ['s-wreck-big'], synced_at: NOW,
    menu_item_id: 'm-wreck-big', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 },
  { kind: 'item', ez_key: sizeRowKey('A Wreck', 'Skinny'), ez_name: 'A Wreck', ez_size_name: 'Skinny', ez_ids: ['s-wreck-skinny'], synced_at: NOW,
    menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0 },
  // A synced plain row holding an OLD order time name link (matched_by 'name'): not trusted.
  { kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', ez_only_size: 'Serves 1', ez_ids: ['s-salad'], synced_at: NOW,
    menu_item_id: 'm-salad', option_id: null, source: 'auto', matched_by: 'name', seen_count: 3 },
  // A staff match on a synced row, still the name the staff saw.
  { kind: 'item', ez_key: 'chicken salad large', ez_name: 'Chicken Salad Large', ez_only_size: 'Regular', ez_ids: ['s-chick'], synced_at: NOW,
    menu_item_id: 'm-chick-small', option_id: null, source: 'manual', matched_by: 'u-1', decided_as: 'Chicken Salad Large Regular', seen_count: 1 },
  // An OLD staff name match made before any sync (no ids): orders never reach it by name.
  { kind: 'item', ez_key: 'a wreck', ez_name: 'A Wreck', ez_size_name: null, ez_ids: [], menu_item_id: 'm-wreck-orig', option_id: null,
    source: 'manual', matched_by: 'user-1', seen_count: 9 },
  // An OLD staff match stored under the LEGACY key (size word dropped) for "Caesar Salad Large".
  { kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad Large', ez_ids: [], menu_item_id: 'm-c', option_id: null,
    source: 'manual', matched_by: 'user-1', seen_count: 4 },
];
const OURS_A = [...OUR_ITEMS, { id: 'm-c', name: 'Caesar Salad Large' }, { id: 'm-code', name: 'Coded', itemCode: 'A12' }];
const planA = (lines, extra = {}) => planLineMatches({
  lines, ourItems: OURS_A, ourGroups: OUR_GROUPS, links: SYNCED, locationId: LOC, nowIso: NOW, sizeIds: true, ...extra,
});

test('RULE A: a line matches only by its published size id on a synced row with a staff match or an exact auto link', () => {
  const p = planA([
    line('A Wreck', 's-wreck-big', 'Bigs'),
    line('A Wreck', 's-wreck-skinny', 'Skinny'),
    line('Farmhouse Salad', 's-salad', 'Serves 1'),
    line('Chicken Salad Large', 's-chick', 'Regular'),
  ]);
  assert.equal(p.lines[0].itemId, 'm-wreck-big', 'an exact auto link from a sync');
  assert.equal(p.lines[0].match.source, 'menuSync');
  assert.equal(p.lines[1].itemId, null, 'a synced row nobody decided');
  assert.equal(p.lines[2].itemId, null, 'an old name link is not a trusted decision');
  assert.equal(p.lines[3].itemId, 'm-chick-small', 'a staff match');
  assert.equal(p.writes.length, 0, 'an order writes no link row');
  assert.equal(p.upgrades.length, 0, 'an order fills nothing in');
  // Only the seen counters of the synced rows the ids landed on.
  assert.deepEqual(p.bumps.map((b) => b.ezKey).sort(), [sizeRowKey('A Wreck', 'Bigs'), sizeRowKey('A Wreck', 'Skinny'), 'chicken salad large', 'farmhouse salad'].sort());
  assert.equal(p.bumps.find((b) => b.ezKey === 'farmhouse salad').seenCount, 4);
});

test('RULE A: no name matching at order time: exact names, old staff name rows, legacy keys, posItemId and item codes all print by name', () => {
  const lines = [
    line('A Wreck Original', null, null),                          // our exact name, no size id
    line('A Wreck', 's-republished-999', 'Original'),              // an old staff name row "a wreck"
    line('Caesar Salad Large', null, null),                        // an old staff row under the legacy key
    line('Caesar Salad Large', 's-new', 'Large'),                  // the same, with an unknown size id
    line('Something', null, null, { itemId: 'm-wreck-big' }),      // a posItemId naming our item
    line('Coded', null, null, { itemId: 'A12' }),                  // a posItemId carrying our item code
    line('Farmhouse Salad', null, null),                           // a synced row's own name, no size id
  ];
  const p = planA(lines);
  assert.deepEqual(p.lines.map((l) => l.itemId), lines.map(() => null), 'every line prints by name');
  assert.ok(p.lines.every((l) => l.match.matched === false));
  assert.equal(p.writes.length + p.upgrades.length + p.bumps.length, 0, 'nothing written, nothing counted');
  // The same lines BEFORE the migration are matched by name, exactly as main does.
  const before = planLineMatches({ lines, ourItems: OURS_A, ourGroups: OUR_GROUPS,
    links: SYNCED.map((r) => omit(r, SYNC_COLUMNS)), locationId: LOC, nowIso: NOW });
  assert.equal(before.lines[0].itemId, 'm-wreck-orig');
  assert.equal(before.lines[1].itemId, 'm-wreck-orig');
  assert.equal(before.lines[2].itemId, 'm-c');
  assert.equal(before.lines[4].itemId, 'm-wreck-big');
  assert.equal(before.lines[5].itemId, 'm-code');
});

test('RULE A: a customization matches only by its published id (customizationId) on a synced option row with a trusted decision', () => {
  const optRows = [
    { kind: 'option', ez_key: buildLinkKey({ name: 'Multigrain', groupLabel: 'Bread' }, 'option'), ez_name: 'Multigrain', ez_group: 'Bread',
      ez_ids: ['v-multi'], synced_at: NOW, menu_item_id: null, option_id: 'o-multi', source: 'auto', matched_by: 'exact', seen_count: 0 },
    { kind: 'option', ez_key: buildLinkKey({ name: 'White', groupLabel: 'Bread' }, 'option'), ez_name: 'White', ez_group: 'Bread',
      ez_ids: ['v-white'], synced_at: NOW, menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0 },
    { kind: 'option', ez_key: buildLinkKey({ name: 'Rye', groupLabel: 'Bread' }, 'option'), ez_name: 'Rye', ez_group: 'Bread',
      ez_ids: [], menu_item_id: null, option_id: 'o-rye', source: 'manual', matched_by: 'u', seen_count: 0 },
  ];
  const [l] = orderItemsToLines([{ uuid: 'ol-9', name: 'A Wreck', menuItemSizeId: 's-wreck-big', menuItemSizeName: 'Bigs', quantity: 1, customizations: [
    { customizationId: 'v-multi', customizationTypeName: 'Bread', name: 'Multigrain', quantity: 1 },
    { customizationId: 'v-white', customizationTypeName: 'Bread', name: 'White', quantity: 1 },
    { customizationId: null, customizationTypeName: 'Bread', name: 'Multigrain', quantity: 1 },
    { customizationId: 'v-rye-new', customizationTypeName: 'Bread', name: 'Rye', quantity: 1, posCustomizationId: 'o-rye' },
  ] }]);
  assert.equal(l.mods[0].ezItemId, 'v-multi', 'the mapper carries customizationId as ezItemId');
  const p = planA([l], { links: [...SYNCED, ...optRows] });
  assert.equal(p.lines[0].itemId, 'm-wreck-big');
  assert.deepEqual(p.lines[0].mods.map((m) => m.optionId), ['o-multi', null, null, null]);
  assert.equal(p.lines[0].mods[3].itemId, null, 'a posCustomizationId is not used after the migration');
  assert.equal(p.writes.length, 0);
  assert.equal(optionRouteFor({ ezItemId: 'v-multi' }, indexPublishedIds(optRows, 'option')).mode, 'synced');
  assert.equal(optionRouteFor({ label: 'Multigrain', groupLabel: 'Bread' }, indexPublishedIds(optRows, 'option')).mode, 'unmatched');
});

test('RULE A: the synced order path has no name matcher in it at all', () => {
  const src = read('../../supabase/functions/_shared/ezcater-match-ingest.ts');
  const start = src.indexOf('export function planSyncedLineMatches(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(start > 0 && body.length > 500);
  for (const name of ['autoLinkDecision', 'findLink', 'applyLinks', 'indexLinks', 'legacyLinkKey', 'linkKeyCandidates',
    'buildLinkKey', 'indexItemCodes', 'rawName', 'isSyncedRow']) {
    assert.ok(!body.includes(name + '('), 'planSyncedLineMatches calls ' + name);
  }
  // It is chosen by the link read alone: sizeIds (the sync columns came back), never a guess.
  const dispatch = src.slice(src.indexOf('export function planLineMatches('), start);
  assert.match(dispatch, /if \(input\.linksFailed\) \{[\s\S]*?\n {2}\}\n {2}if \(input\.sizeIds\) return planSyncedLineMatches\(input\);\n {2}return planNameMatches\(input\);/);
});

test('RULE A: before 20260919m nothing changes: planLineMatches IS the rules main has', () => {
  const lines = [line('A Wreck', 's-x', 'Original'), line('Chicken Salad Small', null, null), line('Brand New', null, null),
    { ...line('A Wreck Bigs', null, null), mods: [{ label: 'Multigrain', groupLabel: 'Bread', itemId: null }] }];
  const input = { lines, ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS, links: [], locationId: LOC, nowIso: NOW };
  assert.deepEqual(planLineMatches(input), planNameMatches(input));
  assert.deepEqual(planLineMatches({ ...input, sizeIds: false }), planNameMatches(input));
  const p = planNameMatches(input);
  assert.equal(p.lines[1].itemId, 'm-chick-small');
  assert.equal(p.lines[3].mods[0].optionId, 'o-multi');
  assert.ok(p.writes.length >= 3, 'sightings are written, as before');
  // The body has nothing of the sync in it.
  const src = read('../../supabase/functions/_shared/ezcater-match-ingest.ts');
  const start = src.indexOf('export function planNameMatches(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.doesNotMatch(body, /sizeIds|synced|trustedTarget|sizeRouteFor/);
});

test('sizeRouteFor: conflicting rows and gone items never guess', () => {
  const idx = indexPublishedIds([
    { kind: 'item', ez_key: 'a|size:x', ez_size_name: 'X', ez_ids: ['dup'], menu_item_id: 'm1', source: 'manual' },
    { kind: 'item', ez_key: 'a', ez_size_name: null, ez_ids: ['dup'], menu_item_id: 'm2', source: 'manual' },
    { kind: 'item', ez_key: 'b|size:x', ez_size_name: 'X', ez_ids: ['two'], menu_item_id: 'm1', source: 'manual' },
    { kind: 'item', ez_key: 'b|size:y', ez_size_name: 'Y', ez_ids: ['two'], menu_item_id: 'm3', source: 'manual' },
  ]);
  assert.deepEqual(sizeRouteFor({ ezSizeId: 'dup', sizeName: 'X' }, idx), { mode: 'unmatched', reason: 'id on a plain row and a size row' });
  assert.deepEqual(sizeRouteFor({ ezSizeId: 'two', sizeName: 'X' }, idx), { mode: 'unmatched', reason: 'size rows disagree' });
  assert.deepEqual(sizeRouteFor({ ezSizeId: null, sizeName: null }, idx), { mode: 'unmatched', reason: 'no size id' });
  const gone = planA([line('A Wreck', 's-wreck-big', 'Bigs')], { ourItems: OURS_A.filter((i) => i.id !== 'm-wreck-big') });
  assert.equal(gone.lines[0].itemId, null, 'a row pointing at a deleted item routes nothing');
  // Our menu not read whole: the target cannot be proven gone, and the decision still stands.
  assert.equal(planA([line('A Wreck', 's-wreck-big', 'Bigs')], { ourItems: [], menuOk: false }).lines[0].itemId, 'm-wreck-big');
});

test('order time matches on the SIZE id only, never the order line item id (HKX77V)', () => {
  const synced = [{ kind: 'item', ez_key: 'italian boxed lunch', ez_name: 'Italian Boxed Lunch', ez_only_size: 'Box',
    ez_ids: [HKX77V_SIZE_ID], synced_at: NOW, menu_item_id: 'm-ibl', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 }];
  const [hk] = orderItemsToLines([{ uuid: '5f5b503b', name: 'Italian Boxed Lunch', menuItemSizeId: HKX77V_SIZE_ID, menuItemSizeName: 'Box', quantity: 1, customizations: [] }]);
  assert.equal(hk.ezItemId, '5f5b503b');
  assert.equal(sizeRouteFor(hk, indexPublishedIds(synced)).mode, 'synced');
  assert.equal(planSyncedLineMatches({ lines: [hk], links: synced, ourItems: [{ id: 'm-ibl', name: 'Italian Boxed Lunch' }] }).lines[0].itemId, 'm-ibl');
  // An item id that happens to be on a row matches nothing: only ezSizeId is read.
  const byItemId = indexPublishedIds([{ ...synced[0], ez_ids: ['5f5b503b'] }]);
  assert.equal(sizeRouteFor(hk, byItemId).mode, 'unmatched');
  assert.equal(sizeRouteFor({ ...hk, ezSizeId: null }, byItemId).mode, 'unmatched');
});

// ── RULE B: every sync decides every automatic row again ───────────────────────────────────

const item = (id, name, sizes) => ({ id, name, sizes });

test('RULE B end to end: Caesar Salad sold only as Regular, republished only as Large, ends on our exact "Caesar Salad Large" or unmatched, never Regular', async () => {
  const v1 = menuOf(item('i-c', 'Caesar Salad', [size('c-reg', 'Regular')]));
  const v2 = menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]));
  const lines = [line('Caesar Salad', 'c-lg', 'Large'), line('Caesar Salad', 'c-reg', 'Regular')];
  const both = await pipeline({ menus: [[v1], [v2]], lines,
    ours: [{ id: 'm-cr', name: 'Caesar Salad Regular' }, { id: 'm-cl', name: 'Caesar Salad Large' }] });
  assert.equal(both.plans[0].inserts[0].menu_item_id, 'm-cr', 'sync 1: Regular, exactly');
  const r = both.row('caesar salad');
  assert.equal(r.menu_item_id, 'm-cl', 'sync 2: moved to our exact Large');
  assert.equal(r.matched_by, 'exact');
  assert.equal(r.ez_only_size, 'Large');
  assert.deepEqual(r.ez_ids, ['c-lg'], 'the Regular id belonged to a different product and is dropped');
  assert.equal(both.out[0].itemId, 'm-cl');
  assert.equal(both.queued[0].itemId, 'm-cl');
  assert.equal(both.out[1].itemId, null, 'a change to an old Regular order prints by name, never as Large');
  assert.equal(both.queued[1].itemId, null);
  assert.equal(both.lp.writes.length + both.lp.upgrades.length, 0);
  assert.deepEqual(both.after, both.before, 'the order changed no decision');
  // We only sell Regular: the link is taken off, and nothing ever routes to Regular again.
  const reg = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-cr', name: 'Caesar Salad Regular' }] });
  assert.equal(reg.row('caesar salad').menu_item_id, null);
  assert.equal(reg.row('caesar salad').matched_by, null);
  assert.equal(reg.plans[1].counts.cleared, 1);
  for (const l of [...reg.out, ...reg.queued, ...both.out, ...both.queued]) assert.notEqual(l.itemId, 'm-cr');
});

test('RULE B end to end: Turkey Sandwich unsized, republished sold only as Box', async () => {
  const v1 = menuOf(item('i-t', 'Turkey Sandwich', [size('t-0', '')]));
  const v2 = menuOf(item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]));
  const lines = [line('Turkey Sandwich', 't-box', 'Box'), line('Turkey Sandwich', 't-0', null)];
  const plain = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-t', name: 'Turkey Sandwich' }] });
  assert.equal(plain.plans[0].inserts[0].menu_item_id, 'm-t', 'sync 1: unsized, our plain Turkey Sandwich');
  assert.equal(plain.row('turkey sandwich').menu_item_id, null, 'sync 2: a Box is not our plain Turkey Sandwich');
  assert.deepEqual(plain.out.map((l) => l.itemId), [null, null]);
  assert.deepEqual(plain.queued.map((l) => l.itemId), [null, null]);
  const box = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-t', name: 'Turkey Sandwich' }, { id: 'm-tb', name: 'Turkey Sandwich Box' }] });
  assert.equal(box.row('turkey sandwich').menu_item_id, 'm-tb', 'moved to our exact Turkey Sandwich Box');
  assert.deepEqual(box.out.map((l) => l.itemId), ['m-tb', null]);
  assert.deepEqual(box.queued.map((l) => l.itemId), ['m-tb', null]);
  // With no sizes at all the first time, the same answer.
  const noSizes = planMenuSync({ entries: flattenMenus([menuOf(item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]))]),
    existing: syncPlan([menuOf(item('i-t', 'Turkey Sandwich', []))], [{ id: 'm-t', name: 'Turkey Sandwich' }]).inserts,
    ourItems: [{ id: 'm-t', name: 'Turkey Sandwich' }], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.deepEqual(noSizes.redecides.map((r) => [r.was.menuItemId, r.menuItemId]), [['m-t', null]]);
});

test('RULE B end to end: Italian unsized, then sold only as Small', async () => {
  const v1 = menuOf(item('i-i', 'Italian', [size('it-0', '')]));
  const v2 = menuOf(item('i-i', 'Italian', [size('it-s', 'Small')]));
  const lines = [line('Italian', 'it-s', 'Small'), line('Italian', 'it-0', null)];
  const plain = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-i', name: 'Italian' }] });
  assert.equal(plain.plans[0].inserts[0].menu_item_id, 'm-i');
  assert.equal(plain.row('italian').menu_item_id, null);
  assert.deepEqual([...plain.out, ...plain.queued].map((l) => l.itemId), [null, null, null, null]);
  const small = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-i', name: 'Italian' }, { id: 'm-is', name: 'Italian Small' }] });
  assert.equal(small.row('italian').menu_item_id, 'm-is');
  assert.deepEqual(small.out.map((l) => l.itemId), ['m-is', null]);
  assert.deepEqual(small.queued.map((l) => l.itemId), ['m-is', null]);
});

test('RULE B end to end: Sandwich Platter renamed Sandwich Platter Tray (the same key)', async () => {
  const v1 = menuOf(item('i-sp', 'Sandwich Platter', [size('sp-1', '')]));
  const v2 = menuOf(item('i-sp', 'Sandwich Platter Tray', [size('sp-2', '')]));
  assert.equal(flattenMenus([v1])[0].ezKey, flattenMenus([v2])[0].ezKey, 'one key, the trailing tray is dropped');
  const lines = [line('Sandwich Platter Tray', 'sp-2', null), line('Sandwich Platter', 'sp-1', null)];
  const plain = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-sp', name: 'Sandwich Platter' }] });
  assert.equal(plain.plans[0].inserts[0].menu_item_id, 'm-sp');
  const r = plain.row('sandwich platter');
  assert.equal(r.menu_item_id, null, 'our Sandwich Platter is not their Sandwich Platter Tray');
  assert.equal(r.ez_name, 'Sandwich Platter Tray', 'the row shows the name ezCater uses now');
  assert.deepEqual(r.ez_ids, ['sp-2']);
  assert.deepEqual([...plain.out, ...plain.queued].map((l) => l.itemId), [null, null, null, null]);
  const tray = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-sp', name: 'Sandwich Platter' }, { id: 'm-spt', name: 'Sandwich Platter Tray' }] });
  assert.equal(tray.row('sandwich platter').menu_item_id, 'm-spt');
  assert.deepEqual(tray.out.map((l) => l.itemId), ['m-spt', null]);
});

test('RULE B end to end: our item renamed (on the menu, and off it)', async () => {
  const menu = menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]));
  const lines = [line('Caesar Salad', 'c-lg', 'Large')];
  const ours = [{ id: 'm-cl', name: 'Caesar Salad Large' }];
  const rename = (id, name) => (sb) => { sb.store.menu_items.find((i) => i.id === id).name = name; };
  const gone = await pipeline({ menus: [[menu], [menu]], lines, ours, after: [rename('m-cl', 'Large Caesar')] });
  assert.equal(gone.row('caesar salad').menu_item_id, null, 'our item no longer has that exact name');
  assert.equal(gone.out[0].itemId, null);
  assert.equal(gone.queued[0].itemId, null);
  const moved = await pipeline({ menus: [[menu], [menu]], lines, ours: [...ours, { id: 'm-cl2', name: 'Big Caesar' }],
    after: [(sb) => { rename('m-cl', 'Large Caesar')(sb); rename('m-cl2', 'Caesar Salad Large')(sb); }] });
  assert.equal(moved.row('caesar salad').menu_item_id, 'm-cl2', 'moved to the one item of ours with that exact name now');
  assert.equal(moved.out[0].itemId, 'm-cl2');
  // Off the current menu: kept while it still names exactly that item of ours, cleared once it does not.
  const other = menuOf(item('i-o', 'Other', [size('o-1', '')]));
  const kept = await pipeline({ menus: [[menu], [other]], lines, ours });
  assert.equal(kept.row('caesar salad').menu_item_id, 'm-cl');
  assert.equal(kept.out[0].itemId, 'm-cl', 'a change to an order placed before still routes');
  const offGone = await pipeline({ menus: [[menu], [other]], lines, ours, after: [rename('m-cl', 'Large Caesar')] });
  assert.equal(offGone.row('caesar salad').menu_item_id, null);
  assert.equal(offGone.out[0].itemId, null);
});

test('RULE B: every automatic row is decided again, not only old name links; a staff row never is', () => {
  const entries = flattenMenus([menuOf(
    item('a', 'Apple Pie', [size('ap', '')]), item('b', 'Brownie', [size('br', '')]),
    item('c', 'Cookie', [size('co', '')]), item('d', 'Donut', [size('do', '')]), item('e', 'Eclair', [size('ec', '')]),
  )]);
  const ours = [{ id: 'm-ap', name: 'Apple Pie' }, { id: 'm-br2', name: 'Brownie' }, { id: 'm-co', name: 'Cookie' }, { id: 'm-do', name: 'Donut' }];
  const existing = [
    { kind: 'item', ez_key: 'apple pie', ez_name: 'Apple Pie', ez_ids: ['ap'], synced_at: NOW, menu_item_id: 'm-ap', source: 'auto', matched_by: 'exact' },
    { kind: 'item', ez_key: 'brownie', ez_name: 'Brownie', ez_ids: ['br'], synced_at: NOW, menu_item_id: 'm-br-old', source: 'auto', matched_by: 'exact' },
    { kind: 'item', ez_key: 'cookie', ez_name: 'Cookie', ez_ids: [], menu_item_id: 'm-co', source: 'auto', matched_by: 'name' },
    { kind: 'item', ez_key: 'donut', ez_name: 'Donut', ez_ids: [], menu_item_id: null, source: 'auto', matched_by: null },
    { kind: 'item', ez_key: 'eclair', ez_name: 'Eclair', ez_ids: ['ec'], synced_at: NOW, menu_item_id: 'm-do', source: 'manual', matched_by: 'u', decided_as: 'Eclair' },
  ];
  const plan = planMenuSync({ entries, existing, ourItems: ours, ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  const by = (k) => plan.redecides.find((r) => r.ezKey === k);
  assert.equal(by('apple pie'), undefined, 'still exact: nothing to write');
  assert.deepEqual([by('brownie').was.menuItemId, by('brownie').menuItemId, by('brownie').matchedBy], ['m-br-old', 'm-br2', 'exact'], 'an exact link moved');
  assert.deepEqual([by('cookie').menuItemId, by('cookie').matchedBy], ['m-co', 'exact'], 'an old name link that is exact becomes exact');
  assert.deepEqual([by('donut').menuItemId, by('donut').matchedBy], ['m-do', 'exact'], 'an undecided row is filled');
  assert.equal(by('eclair'), undefined, 'a staff decision is never decided again');
  assert.equal(plan.counts.redecided, 3);
});

test('RULE B: a staff save between the read and the write always wins', async () => {
  const v1 = [menuOf(item('i-c', 'Caesar Salad', [size('c-reg', 'Regular')]))];
  const v2 = [menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]))];
  const ours = [{ id: 'm-cr', name: 'Caesar Salad Regular' }, { id: 'm-cl', name: 'Caesar Salad Large' }];
  const t = TABLES();
  t.menu_items = ours.map((i) => ({ ...i, location_id: LOC, archived: false }));
  const sb = fakeSb(t);
  const sync = async (menus, between) => {
    const input = await readMatchInputs(sb, LOC);
    const plan = planMenuSync({ entries: flattenMenus(menus), existing: input.links, ourItems: input.ourItems, ourGroups: input.ourGroups,
      locationId: LOC, nowIso: NOW, complete: true, menuOk: input.menuOk });
    if (between) between();
    return { plan, wrote: await writeSyncPlan(sb, LOC, plan, NOW) };
  };
  await sync(v1);
  assert.equal(row(sb, 'caesar salad').menu_item_id, 'm-cr');
  // Sync 2 plans to move the link to Large; a person matches it (seeing the Regular name) first.
  const { plan } = await sync(v2, () => itemsSave(sb, row(sb, 'caesar salad'), { menuItemId: 'm-cr' }));
  assert.equal(plan.redecides.length, 1);
  const r = row(sb, 'caesar salad');
  assert.equal(r.menu_item_id, 'm-cr', "the person's decision stands");
  assert.equal(r.source, 'manual');
  assert.equal(r.decided_as, 'Caesar Salad Regular', 'what their screen showed');
  assert.deepEqual(r.ez_ids, ['c-lg'], 'the ezCater facts are still refreshed');
  // It was saved against the Regular name, so it is flagged, and orders do not use it until checked.
  assert.equal(lookAgainOf(r).lookAgain, true);
  const lp = await orderThrough(sb, [line('Caesar Salad', 'c-lg', 'Large')]);
  assert.equal(lp.lines[0].itemId, null);
  // The same with a fill: a person answers an undecided row while the sync runs.
  const sb2 = fakeSb({ ...TABLES([{ location_id: LOC, kind: 'item', ez_key: 'donut', ez_name: 'Donut', ez_ids: ['do'], synced_at: NOW,
    menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0 }]),
  menu_items: [{ id: 'm-do', name: 'Donut', location_id: LOC }, { id: 'm-do2', name: 'Glazed', location_id: LOC }] });
  const input = await readMatchInputs(sb2, LOC);
  const fill = planMenuSync({ entries: flattenMenus([menuOf(item('d', 'Donut', [size('do', '')]))]), existing: input.links,
    ourItems: input.ourItems, ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.equal(fill.redecides[0].menuItemId, 'm-do');
  itemsSave(sb2, row(sb2, 'donut'), { menuItemId: 'm-do2' });
  await writeSyncPlan(sb2, LOC, fill, NOW);
  assert.equal(row(sb2, 'donut').menu_item_id, 'm-do2');
  assert.equal(row(sb2, 'donut').source, 'manual');
});

test('RULE B: a save from a screen loaded before a sync never hides the change that sync made', async () => {
  const t = TABLES();
  t.menu_items = [{ id: 'm-sp', name: 'Sandwich Platter', location_id: LOC, archived: false }];
  const sb = fakeSb(t);
  await syncOnce(sb, [menuOf(item('i-sp', 'Sandwich Platter', [size('sp-1', '')]))]);
  const screen = rowsFrom([{ ...row(sb, 'sandwich platter') }], { syncReady: true })[0];   // the card, loaded now
  assert.equal(screen.ezName, 'Sandwich Platter');
  // ezCater renames it under the same key, and a sync runs before the person presses anything.
  await syncOnce(sb, [menuOf(item('i-sp', 'Sandwich Platter Tray', [size('sp-2', '')]))]);
  assert.equal(row(sb, 'sandwich platter').ez_name, 'Sandwich Platter Tray');
  // The person matches it from the old screen.
  itemsSave(sb, { ...row(sb, 'sandwich platter'), ez_name: screen.ezName, ez_only_size: screen.ezOnlySize }, { menuItemId: 'm-sp' });
  const r = row(sb, 'sandwich platter');
  assert.equal(r.ez_name, 'Sandwich Platter Tray', 'the save never writes the old name back');
  assert.equal(r.decided_as, 'Sandwich Platter', 'what the screen showed');
  assert.equal(lookAgainOf(r).lookAgain, true);
  const lp = await orderThrough(sb, [line('Sandwich Platter Tray', 'sp-2', null)]);
  assert.equal(lp.lines[0].itemId, null, 'the Tray prints by name until someone has seen it');
});

test('RULE B: our menu read only in part links nothing new, and still takes off an exact link whose ezCater name changed', () => {
  const entries = flattenMenus([menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]), item('i-b', 'Brownie', [size('br', '')]),
    item('i-d', 'Donut', [size('do', '')]))]);
  const existing = [
    { kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', ez_only_size: 'Regular', ez_ids: ['c-reg'], synced_at: NOW,
      menu_item_id: 'm-cr', source: 'auto', matched_by: 'exact' },
    { kind: 'item', ez_key: 'brownie', ez_name: 'Brownie', ez_ids: ['br'], synced_at: NOW, menu_item_id: 'm-br', source: 'auto', matched_by: 'exact' },
  ];
  const plan = planMenuSync({ entries, existing, ourItems: [], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: false });
  assert.deepEqual(plan.redecides.map((r) => [r.ezKey, r.menuItemId]), [['caesar salad', null]], 'the changed one is cleared, the same one kept');
  assert.ok(plan.inserts.every((r) => r.menu_item_id === null), 'nothing new linked');
  assert.deepEqual(plan.refreshes.find((r) => r.ez_key === 'brownie').ez_ids, ['br']);
});

test('RULE B: a failed decision write keeps that row exactly as it was: no new ids land next to an old decision', async () => {
  const sb = fakeSb({ ...TABLES([{ location_id: LOC, kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', ez_only_size: 'Regular',
    ez_ids: ['c-reg'], synced_at: NOW, menu_item_id: 'm-cr', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 }]),
  menu_items: [{ id: 'm-cr', name: 'Caesar Salad Regular', location_id: LOC }] }, {
    failUpdate: (name, patch) => (name === 'ezcater_item_links' && 'matched_by' in patch ? { code: '57014', message: 'statement timeout' } : null),
  });
  const input = await readMatchInputs(sb, LOC);
  const plan = planMenuSync({ entries: flattenMenus([menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]))]), existing: input.links,
    ourItems: input.ourItems, ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  const wrote = await writeSyncPlan(sb, LOC, plan, NOW);
  assert.ok(wrote.errors.some((e) => /^decide: statement timeout/.test(e)));
  const r = row(sb, 'caesar salad');
  assert.deepEqual(r.ez_ids, ['c-reg'], 'the refresh was held back');
  assert.equal(r.ez_only_size, 'Regular');
  assert.equal(r.menu_item_id, 'm-cr');
  // So the Large order prints by name, and the Regular order still goes where it always went.
  const lp = await orderThrough(sb, [line('Caesar Salad', 'c-lg', 'Large'), line('Caesar Salad', 'c-reg', 'Regular')]);
  assert.deepEqual(lp.lines.map((l) => l.itemId), [null, 'm-cr']);
});

test('RULE B: a staff match is never changed; when its ezCater name or size changes, staff look again and orders print it by name until they do', async () => {
  const cases = [
    { name: 'Caesar Regular to Large', v1: item('i', 'Caesar Salad', [size('x1', 'Regular')]), v2: item('i', 'Caesar Salad', [size('x2', 'Large')]),
      key: 'caesar salad', ours: [{ id: 'm-cr', name: 'Caesar Salad Regular' }], was: 'Caesar Salad Regular', l: line('Caesar Salad', 'x2', 'Large') },
    { name: 'Turkey unsized to Box', v1: item('i', 'Turkey Sandwich', [size('x1', '')]), v2: item('i', 'Turkey Sandwich', [size('x2', 'Box')]),
      key: 'turkey sandwich', ours: [{ id: 'm-t', name: 'Turkey Sandwich' }], was: 'Turkey Sandwich', l: line('Turkey Sandwich', 'x2', 'Box') },
    { name: 'Italian unsized to Small', v1: item('i', 'Italian', [size('x1', '')]), v2: item('i', 'Italian', [size('x2', 'Small')]),
      key: 'italian', ours: [{ id: 'm-i', name: 'Italian' }], was: 'Italian', l: line('Italian', 'x2', 'Small') },
    { name: 'Sandwich Platter to Sandwich Platter Tray', v1: item('i', 'Sandwich Platter', [size('x1', '')]), v2: item('i', 'Sandwich Platter Tray', [size('x2', '')]),
      key: 'sandwich platter', ours: [{ id: 'm-sp', name: 'Sandwich Platter' }], was: 'Sandwich Platter', l: line('Sandwich Platter Tray', 'x2', null) },
  ];
  for (const c of cases) {
    const target = c.ours[0].id;
    // Staff match it after sync 1 (a person, not the exact rule, so it is theirs).
    const p = await pipeline({ menus: [[menuOf(c.v1)], [menuOf(c.v2)]], ours: [...c.ours, { id: 'm-other', name: 'Other' }], lines: [c.l],
      after: [(sb) => itemsSave(sb, row(sb, c.key), { menuItemId: target })] });
    const r = p.row(c.key);
    assert.equal(r.menu_item_id, target, c.name + ': the decision is never changed');
    assert.equal(r.source, 'manual', c.name);
    assert.equal(r.matched_by, 'user-1', c.name);
    assert.equal(r.decided_as, c.was, c.name + ': what the staff saw');
    assert.equal(p.plans[1].counts.lookAgain, 1, c.name + ': counted for the sync message');
    assert.equal(p.plans[1].redecides.length, 0, c.name);
    assert.equal(lookAgainOf(r).lookAgain, true, c.name);
    assert.equal(trustedTarget(r), null, c.name + ': not used by orders until checked');
    assert.equal(p.out[0].itemId, null, c.name + ': prints by name');
    assert.equal(p.queued[0].itemId, null, c.name);
    // The card flags it, saying what the staff saw.
    const shown = rowsFrom([{ ...r, look_again: lookAgainOf(r).lookAgain }], { syncReady: true })[0];
    assert.equal(shown.lookAgain, true, c.name);
    assert.equal(shown.state, 'matched', c.name);
    assert.match(lookAgainNote(shown), new RegExp('It was: ' + c.was + '\\.'));
    // "Still right": the same answer saved again records what the screen shows now, and it routes.
    itemsSave(p.sb, r, { menuItemId: target });
    assert.equal(lookAgainOf(p.row(c.key)).lookAgain, false, c.name);
    const again = await orderThrough(p.sb, [c.l]);
    assert.equal(again.lines[0].itemId, target, c.name + ': routes once checked');
  }
  // A staff match whose name did not change is simply used, and not flagged.
  const same = await pipeline({ menus: [[menuOf(cases[0].v1)], [menuOf(cases[0].v1)]], ours: cases[0].ours, lines: [line('Caesar Salad', 'x1', 'Regular')],
    after: [(sb) => itemsSave(sb, row(sb, 'caesar salad'), { menuItemId: 'm-cr' })] });
  assert.equal(same.plans[1].counts.lookAgain, 0);
  assert.equal(same.out[0].itemId, 'm-cr');
});

test('RULE B: a staff match made before 20260919m gets what it showed recorded once, before the names change', async () => {
  // Saved on an order time sighting before the sync existed: the screen showed only "Turkey Sandwich".
  const legacy = { kind: 'item', ez_key: 'turkey sandwich', ez_name: 'Turkey Sandwich', ez_group: null, menu_item_id: 'm-t', option_id: null,
    source: 'manual', matched_by: 'user-3', seen_count: 5, last_seen_at: NOW };
  const p = await pipeline({ menus: [[menuOf(item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]))]], existing: [legacy],
    ours: [{ id: 'm-t', name: 'Turkey Sandwich' }], lines: [line('Turkey Sandwich', 't-box', 'Box')] });
  assert.equal(p.plans[0].baselines.length, 1);
  const r = p.row('turkey sandwich');
  assert.equal(r.decided_as, 'Turkey Sandwich', 'the name the screen showed then');
  assert.equal(r.ez_only_size, 'Box');
  assert.equal(r.menu_item_id, 'm-t');
  assert.equal(r.seen_count, 5 + 1, 'counters are the only thing an order moves');
  assert.equal(lookAgainOf(r).lookAgain, true, 'never matched knowing it is a Box');
  assert.equal(p.out[0].itemId, null);
  // A baseline that cannot be written holds that row's refresh back, so the change is never missed.
  const sb = fakeSb({ ...TABLES([{ location_id: LOC, ...legacy }]), menu_items: [{ id: 'm-t', name: 'Turkey Sandwich', location_id: LOC }] }, {
    failUpdate: (name, patch) => ('decided_as' in patch ? { message: 'network down' } : null) });
  const input = await readMatchInputs(sb, LOC);
  const plan = planMenuSync({ entries: flattenMenus([menuOf(item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]))]), existing: input.links,
    ourItems: input.ourItems, ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  const wrote = await writeSyncPlan(sb, LOC, plan, NOW);
  assert.ok(wrote.errors.some((e) => /^baseline:/.test(e)));
  assert.equal(row(sb, 'turkey sandwich').ez_only_size ?? null, null, 'not refreshed');
  assert.equal(isSyncedRow(row(sb, 'turkey sandwich')), false);
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
  itemsSave(sb, row(sb, sizeRowKey('A Wreck', 'Skinny')), { menuItemId: 'm-wreck-orig' }, 'user-7');
  itemsSave(sb, row(sb, sizeRowKey('A Wreck', 'Bigs')), { ignored: true }, 'user-7');
  // ezCater republishes: new published ids.
  const repub = JSON.parse(JSON.stringify(POTBELLY));
  repub.categories[0].items[0].sizes[2].id = 's-wreck-skinny-v2';
  const second = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([repub, LUNCH]), nowMs: NOW_MS + 60_000 });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.counts.inserted, 0, 'nothing new on the second sync');
  assert.equal(second.counts.lookAgain, 0, 'nothing changed under the staff decisions');
  assert.equal(links(sb).length, 11, 'no duplicates');
  const skinny = row(sb, sizeRowKey('A Wreck', 'Skinny'));
  assert.equal(skinny.menu_item_id, 'm-wreck-orig', 'the staff match is kept');
  assert.equal(skinny.matched_by, 'user-7');
  assert.deepEqual(skinny.ez_ids, ['s-wreck-skinny-v2', 's-wreck-skinny'], 'the same product: the new published id first, the old one kept');
  const big = row(sb, sizeRowKey('A Wreck', 'Bigs'));
  assert.equal(big.matched_by, 'ignored', '"Not on our menu" is kept');
  assert.equal(big.menu_item_id, null);
  // A second identical sync writes no decision at all.
  const third = await runMenuSync(sb, LOC, { reason: 'daily', makeAsk: () => fakeAsk([repub, LUNCH]), nowMs: NOW_MS + 120_000 });
  assert.equal(third.counts.redecided, 0);
  assert.equal(third.counts.inserted, 0);
});

test('the sync message says what changed, in plain words', async () => {
  const sb = fakeSb({ ...TABLES([
    { location_id: LOC, kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', ez_only_size: 'Regular', ez_ids: ['c-reg'], synced_at: NOW,
      menu_item_id: 'm-cr', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 },
    { location_id: LOC, kind: 'item', ez_key: 'turkey sandwich', ez_name: 'Turkey Sandwich', ez_ids: ['t-0'], synced_at: NOW,
      menu_item_id: 'm-t', option_id: null, source: 'manual', matched_by: 'u', decided_as: 'Turkey Sandwich', seen_count: 0 },
  ]), menu_items: [{ id: 'm-cr', name: 'Caesar Salad Regular', location_id: LOC }, { id: 'm-t', name: 'Turkey Sandwich', location_id: LOC }] });
  const menu = { id: 'menu-9', name: 'M', startDate: null, endDate: null, categories: [{ id: 'c', name: 'C', items: [
    item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]), item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]),
  ] }] };
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([menu]), nowMs: NOW_MS });
  assert.equal(r.status, 'ok', r.message);
  assert.match(r.message, /1 automatic match taken off because the names no longer match exactly/);
  assert.match(r.message, /1 of your matches to check again: ezCater changed the name or size, so those print by name until you do/);
  assert.doesNotMatch(r.message, /[\u2013\u2014]/);
});

test('a partial read never takes a live id away', async () => {
  const sb = fakeSb(TABLES([
    { location_id: LOC, kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', ez_only_size: 'Serves 1', synced_at: NOW,
      menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0, ez_ids: ['s-salad-old'] },
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

test('the sync works before 20260917_OPS_ezcater_api_url.sql has run (found against real Postgres)', async () => {
  const sb = fakeSb(TABLES(), { noApiUrl: true });
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]), nowMs: NOW_MS });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.status, 'ok');
  assert.equal(links(sb).length, 11, 'every item, size and option of the menu');
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

test('link reads page past 1000 rows, for the sync and for orders', async () => {
  const many = [];
  for (let i = 0; i < 2500; i++) {
    many.push({ location_id: LOC, kind: 'item', ez_key: 'item ' + String(i).padStart(5, '0'), ez_name: 'Item ' + i, synced_at: NOW,
      menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0, ez_ids: ['id-' + i], ez_size_name: null });
  }
  many.push({ ...many[0], ez_key: 'a wreck|size:bigs', ez_name: 'A Wreck', ez_size_name: 'Bigs', ez_ids: ['s-wreck-big'], menu_item_id: 'm-wreck-big', matched_by: 'exact' });
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

// ── RULE D: what the earlier rounds fixed ──────────────────────────────────────────────────

test('RULE D: a failed or partial link read never falls back to name guessing; only a proven missing column does', async () => {
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
  // A timeout, a permission fault, a network fault, an unrelated error that names a column.
  for (const error of [
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: '42501', message: 'permission denied for table ezcater_item_links' },
    { message: 'FetchError: network down' },
    { code: 'XX000', message: 'something about column ez_ids broke' },
  ]) {
    const input = await readMatchInputs(failing(error), LOC);
    assert.equal(input.sizeIds, true, error.message);
    assert.equal(input.linksOk, false);
    assert.equal(input.linksFailed, true, error.message);
    const p = planLineMatches({ lines: [line('A Wreck Original', 's-anything', 'Original'), line('Farmhouse Salad', null, null)],
      ...input, locationId: LOC, nowIso: NOW });
    assert.deepEqual(p.lines.map((l) => l.itemId), [null, null], 'every line prints by name: ' + error.message);
    assert.equal(p.writes.length + p.bumps.length + p.upgrades.length, 0, 'nothing written');
  }
  const throwing = { from: () => { throw new Error('boom'); } };
  assert.equal((await readMatchInputs(throwing, LOC)).linksFailed, true);
  // The missing column, PROVEN: the rules before the migration, name matching included.
  const sb = fakeSb(TABLES(SYNCED.map((r) => ({ ...omit(r, SYNC_COLUMNS), location_id: LOC }))), { noSyncColumns: true });
  const before = await readMatchInputs(sb, LOC);
  assert.equal(before.sizeIds, false);
  assert.equal(before.linksOk, true);
  assert.equal(planLineMatches({ lines: [line('A Wreck', 's-x', 'Original')], ...before, locationId: LOC, nowIso: NOW }).lines[0].itemId, 'm-wreck-orig');
  // No links table at all (20260917 not run) is proven too.
  const noTable = await readMatchInputs(failing({ code: '42P01', message: 'relation "public.ezcater_item_links" does not exist' }), LOC);
  assert.equal(noTable.sizeIds, false);
  assert.equal(noTable.linksFailed, false);
  assert.equal(isMissingSyncColumn({ code: '42703', message: 'column ezcater_item_links.ez_ids does not exist' }), true);
  assert.equal(isMissingSyncColumn({ code: '42703', message: 'column ezcater_item_links.decided_as does not exist' }), true);
  assert.equal(isMissingSyncColumn({ code: 'PGRST204', message: "Could not find the 'decided_as' column of 'ezcater_item_links' in the schema cache" }), true);
  assert.equal(isMissingSyncColumn({ code: 'XX000', message: 'something about column ez_ids broke' }), false);
  assert.equal(isMissingSyncColumn({ code: '57014', message: 'statement timeout' }), false);
  assert.equal(isMissingLinksTable({ code: '42P01', message: 'relation "public.menu_items" does not exist' }), false, 'another table is not proof');
});

test('RULE D: a partial link read (the second page fails, or the budget runs out) matches nothing and writes nothing', async () => {
  const many = [];
  for (let i = 0; i < 1500; i++) {
    many.push({ location_id: LOC, kind: 'item', ez_key: 'item ' + String(i).padStart(5, '0'), ez_name: 'Item ' + i, synced_at: NOW,
      menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0, ez_ids: ['id-' + i], ez_size_name: null });
  }
  const orderRow = { ref: 'EZ-2', customer: {}, items: [line('Chicken Salad Small', null, null), line('A Wreck Original', 's-anything', 'Original')] };
  const sb = fakeSb(TABLES(many.map((r) => ({ ...r }))), { failLinkPageFrom: 1000 });
  const input = await readMatchInputs(sb, LOC);
  assert.equal(input.linksFailed, true);
  const before = JSON.stringify(links(sb));
  const out = await matchQueueRow(sb, LOC, orderRow, { nowIso: NOW, budgetMs: 0 });
  assert.equal(out.ran, false);
  assert.equal(out.row, orderRow, 'the order goes through exactly as ezCater sent it');
  assert.equal(JSON.stringify(links(sb)), before, 'nothing written');
  assert.ok(!sb.calls.some((c) => (c.op === 'upsert' || c.op === 'update') && c.table === 'ezcater_item_links'));
  assert.equal((await readMatchInputs(fakeSb(TABLES()), LOC, { deadline: 0 })).linksFailed, true);
});

test('RULE D: a republish keeps the old size id while the product is the same, so a change to an older order still matches', async () => {
  const sb = fakeSb(TABLES());
  const first = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]), nowMs: NOW_MS });
  assert.equal(first.ok, true, first.message);
  const repub = JSON.parse(JSON.stringify(POTBELLY));
  for (const c of repub.categories) for (const it of c.items) for (const z of it.sizes) z.id = z.id + '-v2';
  const second = await runMenuSync(sb, LOC, { reason: 'daily', makeAsk: () => fakeAsk([repub]), nowMs: NOW_MS + 86_400_000 });
  assert.equal(second.status, 'ok');
  assert.deepEqual(row(sb, sizeRowKey('A Wreck', 'Bigs')).ez_ids, ['s-wreck-big-v2', 's-wreck-big'], 'unioned: the same product');
  const input = await readMatchInputs(sb, LOC);
  assert.equal(planLineMatches({ lines: [line('A Wreck', 's-wreck-big', 'Bigs')], ...input, locationId: LOC, nowIso: NOW }).lines[0].itemId, 'm-wreck-big');
  assert.equal(planLineMatches({ lines: [line('A Wreck', 's-wreck-big-v2', 'Bigs')], ...input, locationId: LOC, nowIso: NOW }).lines[0].itemId, 'm-wreck-big');
});

test('RULE D: a null menu is a partial read: status partial, nothing replaced', async () => {
  const ask = async (op, q, vars) => {
    if (op === 'ServOsEzMenus') return { menus: { nodes: [{ id: 'menu-1', name: 'P' }, { id: 'menu-null', name: 'Gone' }] } };
    if (vars.id === 'menu-null') return { menu: null };
    return fakeAsk([POTBELLY])(op, q, vars);
  };
  const got = await readCatererMenus(ask, 'cat-1', '2026-09-18');
  assert.equal(got.missing, 1);
  assert.equal((await readCatererMenus(fakeAsk([POTBELLY]), 'cat-1', '2026-09-18')).missing, 0);
  const sb = fakeSb(TABLES([
    { location_id: LOC, kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', ez_only_size: 'Serves 1', synced_at: NOW,
      menu_item_id: 'm-salad', option_id: null, source: 'manual', matched_by: 'u', decided_as: 'Farmhouse Salad Serves 1', seen_count: 2, ez_ids: ['s-salad-lunch'] },
  ]));
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => ask, nowMs: NOW_MS });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'partial');
  assert.match(r.message, /no menu for 1 current menu/);
  assert.deepEqual(row(sb, 'farmhouse salad').ez_ids.sort(), ['s-salad', 's-salad-lunch'], 'nothing taken away');
  assert.equal(row(sb, 'farmhouse salad').menu_item_id, 'm-salad');
});

test('RULE D: the daily run stays under call_edge_fn 25 s timeout; the rest wait for the next run', async () => {
  assert.ok(CRON_BUDGET_MS < 25_000);
  assert.equal(CRON_BUDGET_MS, 18_000);
  const venues = (n) => Array.from({ length: n }, (_, i) => 'v' + (i + 1));
  const sbOf = (n) => fakeSb({ ezcater_caterers: venues(n).map((v) => ({ location_id: v, active: true })), ezcater_menu_syncs: [] });
  let t = 0;
  const ran = [];
  const takes = (ms) => async (_sb, loc) => { ran.push(loc); t += ms; return { ok: true, status: 'ok', message: '' }; };
  const out = await runDueSyncs(sbOf(5), () => null, { clock: () => t, runOne: takes(7_000) });
  assert.deepEqual(ran, ['v1', 'v2']);
  assert.equal(out.stoppedForTime, true);
  assert.equal(out.left, 3);
  t = 0; ran.length = 0;
  const big = await runDueSyncs(sbOf(10), () => null, { clock: () => t, runOne: takes(3_000), budgetMs: 600_000 });
  assert.equal(big.ran.length, 6);
  assert.ok(t < 25_000, 'finished at ' + t);
  t = 0; ran.length = 0;
  const none = await runDueSyncs(sbOf(5), () => null, { clock: () => t, runOne: takes(1), budgetMs: 0 });
  assert.equal(none.ran.length, 0);
});

test('RULE D: the sync migration is 20260919m and every reference names it', () => {
  const root = new URL('../../', import.meta.url);
  assert.equal(MIGRATION_FILE, '20260919m_OPS_ezcater_menu_sync_v1.sql');
  assert.ok(existsSync(new URL('supabase/migrations/' + MIGRATION_FILE, root)));
  assert.ok(!existsSync(new URL('supabase/migrations/20260918e_OPS_ezcater_menu_sync_v1.sql', root)));
  const same = readdirSync(new URL('supabase/migrations/', root)).filter((f) => f.startsWith('20260919m'));
  assert.deepEqual(same, [MIGRATION_FILE], 'nothing else uses 20260919m');
  for (const f of ['supabase/functions/_shared/ezcaterMenuSync.ts', 'supabase/functions/_shared/ezcater-match-ingest.ts',
    'supabase/functions/_shared/ezcaterMenuSyncRun.ts', 'supabase/functions/ezcater-connect/index.ts', 'DECISIONS.md',
    'supabase/migrations/' + MIGRATION_FILE, 'docs/EZCATER_V1_RELEASE.md']) {
    assert.ok(!readFileSync(new URL(f, root), 'utf8').includes('20260918e'), f + ' still names 20260918e');
  }
});

test('RULE D: the NOT NULL source default: a refresh never names source, and every write passes the real schema', async () => {
  const before = schemaOf('ezcater_item_links', ['20260917_OPS_ezcater_item_links.sql']);
  assert.deepEqual(before.get('source'), { notNull: true, hasDefault: false }, '20260917 alone: source NOT NULL, no default');
  const now = schemaOf('ezcater_item_links');
  assert.deepEqual(now.get('source'), { notNull: true, hasDefault: true }, '20260919m gives source a default');
  assert.ok(now.has('ez_only_size') && now.has('decided_as'));
  const required = [...now].filter(([, c]) => c.notNull && !c.hasDefault).map(([k]) => k).sort();
  assert.deepEqual(required, ['ez_key', 'ez_name', 'kind', 'location_id']);

  const staff = { location_id: LOC, kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', ez_group: null, ez_only_size: 'Serves 1',
    synced_at: NOW, menu_item_id: 'm-salad', option_id: null, source: 'manual', matched_by: 'user-1', decided_as: 'Farmhouse Salad Serves 1',
    seen_count: 2, ez_ids: ['s-old'] };
  const plan = planMenuSync({ entries: flattenMenus([POTBELLY]), existing: [staff], ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS,
    locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.ok(plan.refreshes.length === 1 && !('source' in plan.refreshes[0]), 'the refresh never names source');
  const old = fakeSb(TABLES([{ ...staff }]), { schemas: { ezcater_item_links: before } });
  const bad = await writeSyncPlan(old, LOC, plan, NOW);
  assert.ok(bad.errors.some((e) => /^refresh: null value in column "source"/.test(e)), bad.errors.join('; '));
  const sb = fakeSb(TABLES([{ ...staff }]));
  const good = await writeSyncPlan(sb, LOC, plan, NOW);
  assert.deepEqual(good.errors, []);
  assert.equal(row(sb, 'farmhouse salad').source, 'manual');
  assert.equal(row(sb, 'farmhouse salad').menu_item_id, 'm-salad');
  assert.deepEqual(row(sb, 'farmhouse salad').ez_ids, ['s-salad', 's-old']);
  assert.equal(notNullError(now, plan.inserts), null, 'sync inserts');
  // The order time sighting inserts (before the migration only, now) pass both schemas too.
  const lp = planLineMatches({ lines: [line('Chicken Salad Small', null, null), line('Something New', null, null)],
    ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS, links: [], locationId: LOC, nowIso: NOW });
  assert.ok(lp.writes.length >= 1);
  assert.equal(notNullError(now, lp.writes), null);
  assert.equal(notNullError(before, lp.writes), null);
});

// ── The Potbelly menu, end to end ──────────────────────────────────────────────────────────

test('the Potbelly menu end to end: exact names route by published id, everything else prints by name', async () => {
  const lines = orderItemsToLines([
    { uuid: 'ol-1', name: 'A Wreck', menuItemSizeId: 's-wreck-orig', menuItemSizeName: 'Original', quantity: 1,
      customizations: [{ customizationId: 'v-multi', customizationTypeName: 'Bread', name: 'Multigrain', quantity: 1 }] },
    { uuid: 'ol-2', name: 'A Wreck', menuItemSizeId: 's-wreck-big', menuItemSizeName: 'Bigs', quantity: 1, customizations: [] },
    { uuid: 'ol-3', name: 'A Wreck', menuItemSizeId: 's-wreck-skinny', menuItemSizeName: 'Skinny', quantity: 1,
      customizations: [{ customizationId: 'v-white', customizationTypeName: 'Bread', name: 'White', quantity: 1 }] },
    { uuid: 'ol-4', name: 'Italian', menuItemSizeId: 's-it-small', menuItemSizeName: 'Small', quantity: 1, customizations: [] },
    { uuid: 'ol-5', name: 'Italian', menuItemSizeId: 's-it-large', menuItemSizeName: 'Large', quantity: 1, customizations: [] },
    { uuid: 'ol-6', name: 'Farmhouse Salad', menuItemSizeId: 's-salad', menuItemSizeName: 'Serves 1', quantity: 1, customizations: [] },
    { uuid: 'ol-7', name: 'Chicken Salad Large', menuItemSizeId: 's-chick', menuItemSizeName: 'Regular', quantity: 1, customizations: [] },
    { uuid: 'ol-8', name: 'Cookie Tray', menuItemSizeId: 's-cookie-10', menuItemSizeName: 'Serves 10', quantity: 1, customizations: [] },
    { uuid: '5f5b503b', name: 'Italian Boxed Lunch', menuItemSizeId: HKX77V_SIZE_ID, menuItemSizeName: 'Box', quantity: 1, customizations: [] },
    { uuid: 'ol-10', name: 'A Wreck Original', menuItemSizeId: null, menuItemSizeName: null, quantity: 1, customizations: [] },
  ]);
  const ours = [...OUR_ITEMS, { id: 'm-ibl', name: 'Italian Boxed Lunch' }];
  const p = await pipeline({ menus: [[POTBELLY, HKX77V_MENU], [POTBELLY, HKX77V_MENU]], ours, groups: OUR_GROUPS, lines });
  const want = ['m-wreck-orig', 'm-wreck-big', null, 'm-italian-small', null, null, null, null, 'm-ibl', null];
  assert.deepEqual(p.out.map((l) => l.itemId), want, 'planLineMatches');
  assert.deepEqual(p.queued.map((l) => l.itemId), want, 'matchQueueRow');
  assert.equal(p.out[0].mods[0].optionId, 'o-multi', 'Bread: Multigrain, exact group and value');
  assert.equal(p.out[2].mods[0].optionId, null, 'Bread: White is not on our menu');
  assert.equal(p.plans[1].counts.inserted, 0, 'the second sync inserts nothing');
  assert.equal(p.plans[1].counts.redecided, 0, 'and changes no decision');
  assert.equal(p.lp.writes.length + p.lp.upgrades.length, 0, 'the order wrote no link');
  assert.deepEqual(p.after, p.before);
  assert.equal(p.ran, true);
});

// ── The Item matching card ─────────────────────────────────────────────────────────────────

test('a size row shows its size, suggests on item and size, and saves by its synced key with what it showed', () => {
  const r = toRow({ kind: 'item', ez_key: 'a wreck|size:skinny', ez_name: 'A Wreck', ez_size_name: 'Skinny', seen_count: 0, synced_at: NOW });
  assert.equal(r.sizeRow, true);
  assert.equal(theirLabel(r), 'A Wreck (Skinny)');
  const sug = suggestionsFor(r, [{ id: 'a', name: 'A Wreck Skinny' }, { id: 'b', name: 'A Wreck Bigs' }], [], { limit: 2 });
  assert.equal(sug[0].id, 'a');
  const body = saveBody(r, { menuItemId: 'a' }).body;
  assert.equal(body.size_row, true);
  assert.equal(body.ez_key, 'a wreck|size:skinny');
  assert.equal(body.menu_item_id, 'a');
  assert.equal(body.seen_size, 'Skinny');
  const plain = saveBody(toRow({ kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad' }), { menuItemId: 'm' }).body;
  assert.equal(plain.size_row, undefined);
  assert.equal(plain.ez_key, 'farmhouse salad');
  assert.equal(plain.seen_size, null);
});

test('a single size item carries its one size to the card, into suggestions and into what a save records', () => {
  const entries = flattenMenus([menuOf({ id: 'i-t', name: 'Turkey Sandwich', sizes: [size('s-t', 'Box')] },
    { id: 'i-m', name: 'Italian', sizes: [size('a', 'Small'), size('b', 'Large')] })]);
  const plain = entries.find((e) => e.ezKey === 'turkey sandwich');
  assert.equal(plain.ezOnlySize, 'Box');
  const plan = planMenuSync({ entries, existing: [], ourItems: [], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.equal(plan.inserts.find((r) => r.ez_key === 'turkey sandwich').ez_only_size, 'Box');
  assert.ok(plan.inserts.filter((r) => r.ez_size_name).every((r) => r.ez_only_size === null), 'size rows carry no only size');
  const again = planMenuSync({ entries, existing: plan.inserts, ourItems: [], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.equal(again.refreshes.find((r) => r.ez_key === 'turkey sandwich').ez_only_size, 'Box');
  const r = toRow({ kind: 'item', ez_key: 'turkey sandwich', ez_name: 'Turkey Sandwich', ez_only_size: 'Box', synced_at: NOW, seen_count: 0 });
  assert.equal(theirLabel(r), 'Turkey Sandwich, sold only as Box');
  const sug = suggestionsFor(r, [{ id: 'plain', name: 'Turkey Sandwich' }, { id: 'box', name: 'Turkey Sandwich Box' }], [], { limit: 2 });
  assert.equal(sug[0].id, 'box', 'suggested on its item AND its one size');
  const body = saveBody(r, { menuItemId: 'box' }).body;
  assert.equal(body.ez_key, 'turkey sandwich', 'saved by its plain key as before');
  assert.equal(body.seen_size, 'Box');
  // A synced row holding only an old order time name link is listed as not matched yet.
  assert.equal(toRow({ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', ez_only_size: 'Large', synced_at: NOW,
    menu_item_id: 'm-c', source: 'auto', matched_by: 'name' }).state, 'unmatched');
  assert.equal(toRow({ kind: 'item', ez_key: 'x', ez_name: 'X', synced_at: NOW, menu_item_id: 'm', source: 'auto', matched_by: 'exact' }).state, 'matched');
});

test('the card: matches to check again sort right after the unmatched ones, say what the staff saw, and a save clears them', () => {
  const rows = rowsFrom([
    { kind: 'item', ez_key: 'apple', ez_name: 'Apple', synced_at: NOW, menu_item_id: 'm-a', source: 'manual', matched_by: 'u', last_seen_at: '2026-09-18T12:00:00Z' },
    { kind: 'item', ez_key: 'brownie', ez_name: 'Brownie', synced_at: NOW, menu_item_id: null, source: 'auto', matched_by: null, last_seen_at: '2026-09-10T12:00:00Z' },
    { kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', ez_only_size: 'Large', synced_at: NOW, menu_item_id: 'm-c', source: 'manual', matched_by: 'u',
      decided_as: 'Caesar Salad Regular', look_again: true, last_seen_at: '2026-09-01T12:00:00Z' },
  ], { syncReady: true });
  assert.deepEqual(rows.map((r) => r.ezKey), ['brownie', 'caesar salad', 'apple']);
  assert.equal(lookAgainCount(rows), 1);
  assert.equal(countRows(rows).outstanding, 1, 'the unmatched count is unchanged');
  assert.equal(lookAgainNote(rows[1]), 'Changed on ezCater since this was matched. It was: Caesar Salad Regular. Orders print it by name until you check it.');
  assert.doesNotMatch(lookAgainNote(rows[1]), /[\u2013\u2014]/);
  const after = applySaved(rows, saveBody(rows[1], { menuItemId: 'm-c' }).body);
  assert.equal(after.length, 3, 'the same row, saved');
  assert.equal(after.find((r) => r.ezKey === 'caesar salad').lookAgain, false);
  assert.equal(lookAgainCount(after), 0);
});

test('the card: once the sync is set up, rows no sync wrote are not listed (orders never use them); before it, nothing changes', () => {
  const raw = [
    { kind: 'item', ez_key: 'old sighting', ez_name: 'Old Sighting', menu_item_id: 'm-x', source: 'manual', matched_by: 'u' },
    { kind: 'item', ez_key: 'synced', ez_name: 'Synced', synced_at: NOW, ez_ids: ['s1'], menu_item_id: null, source: 'auto', matched_by: null },
  ];
  const ready = rowsFrom(raw, { syncReady: true });
  assert.deepEqual(liveRows(ready).map((r) => r.ezKey), ['synced']);
  assert.deepEqual(offMenuRows(ready).map((r) => r.ezKey), ['old sighting']);
  assert.match(offMenuLine(1), /^1 older name is not on the synced ezCater menu\./);
  assert.equal(offMenuLine(0), '');
  const before = rowsFrom(raw);
  assert.equal(offMenuRows(before).length, 0, 'before 20260919m every row is listed as it always was');
  assert.equal(before.find((r) => r.ezKey === 'old sighting').state, 'matched');
  // The card component uses these, hides the codes block once the sync is set up, and offers "Still right".
  const jsx = read('../backoffice/sections/EzcaterItemMatching.jsx');
  assert.match(jsx, /rowsFrom\(links\?\.links, \{ syncReady: ready \}\)/);
  assert.match(jsx, /const live = useMemo\(\(\) => liveRows\(rows\), \[rows\]\);/);
  assert.match(jsx, /\{codesOn && !syncReady && \(/);
  assert.match(jsx, />Still right<\/button>/);
});

test('ezcater-connect: items_list flags look again with the sync rules; items_save records what the screen showed', () => {
  const src = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.match(src, /ez_size_name, ez_only_size, ez_category, synced_at, decided_as'\);/);
  assert.match(src, /const l = lookAgainOf\(r\); return \{ \.\.\.r, look_again: l\.lookAgain, now_as: l\.now \};/);
  // The size row branch: what the screen showed, never read back from the row.
  assert.match(src, /const seenSize = String\(body\?\.seen_size \|\| ''\)\.trim\(\) \|\| sizeKey\.split\('\|size:'\)\[1\] \|\| '';/);
  assert.match(src, /decided_as: decidedAs,/);
  // The plain branch: the same rule the itemsSave mirror above uses, an existing row updated and
  // never renamed, and the retry without decided_as before the migration.
  assert.match(src, /decision\.decided_as = fullNameOf\(\{\n\s+kind, name: ezName, group: ezGroup \|\| '', onlySize: kind === 'item' \? String\(body\?\.seen_size \|\| ''\)\.trim\(\) : '',\n\s+\}\)\.slice\(0, 500\);/);
  assert.match(src, /const updateRow = \(\) => sb\.from\('ezcater_item_links'\)\.update\(decision\)\n\s+\.eq\('location_id', opsLocationId\)\.eq\('kind', kind\)\.eq\('ez_key', ezKey\)\.select\('ez_key'\);/);
  const branch = src.slice(src.indexOf('const decision: Record<string, unknown> = {'), src.indexOf('const updateRow = () =>'));
  assert.doesNotMatch(branch, /ez_name/, 'the update never writes the name');
  assert.match(src, /if \(error && isMissingSyncColumn\(error\)\) \{\n\s+delete decision\.decided_as;/);
  assert.match(src, /const fresh: Record<string, unknown> = \{ location_id: opsLocationId, kind, ez_key: ezKey, ez_name: ezName, ez_group: ezGroup, \.\.\.decision \};/);
});

// ── The decision record and the release note ───────────────────────────────────────────────

test('ADR-024 states the simpler rule in plain words; 20260919m carries the default and the columns', () => {
  const adr = read('../../DECISIONS.md');
  const a24 = adr.slice(adr.indexOf('## ADR-024'));
  assert.match(a24, /orders only use matches made before the order: exact names found by the sync, or matches staff saved/);
  assert.match(a24, /no name matching at order time/i);
  assert.match(a24, /decides every automatic row again/);
  assert.match(a24, /look again/i);
  assert.match(a24, /group AND the value/);
  assert.match(a24, /Known limit/);
  assert.match(a24, /differ only by a trailing tray or pan word/);
  assert.match(a24, /matched_by 'exact'/);
  assert.doesNotMatch(a24, /[\u2013\u2014]/);
  const sql = read('../../supabase/migrations/' + MIGRATION_FILE);
  assert.match(sql, /alter table public\.ezcater_item_links alter column source set default 'auto';/);
  assert.match(sql, /add column if not exists ez_only_size text;/);
  assert.match(sql, /add column if not exists decided_as text;/);
  assert.doesNotMatch(sql, /[\u2013\u2014]/);
});

test('the release note: step 7 in plain words, and step 4 proves the new menu sync code is live', () => {
  const note = read('../../docs/EZCATER_V1_RELEASE.md');
  const step7 = note.slice(note.indexOf('## 7. Menu sync'), note.indexOf('## Known gap'));
  assert.match(step7, /after the sync is set up, orders only use matches made before the order: exact names found by the sync, or matches staff saved/i);
  assert.match(step7, /Check again/);
  // Step 4: a line only the new code has, for each function this branch changes.
  const connectMarker = note.match(/`ezcater-connect` must contain `([^`]+)`/);
  assert.ok(connectMarker, 'connect marker line');
  assert.ok(read('../../supabase/functions/_shared/ezcaterMenuSyncRun.ts').includes(connectMarker[1]));
  const webhookMarker = note.match(/`ezcater-webhook` must also contain `event read failed` and `([^`]+)`/);
  assert.ok(webhookMarker, 'webhook marker line');
  assert.ok(read('../../supabase/functions/_shared/ezcater-match-ingest.ts').includes(webhookMarker[1]));
  assert.doesNotMatch(note, /[\u2013\u2014]/);
});
