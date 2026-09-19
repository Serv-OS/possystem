/**
 * ezcaterMenuSyncV1.test.js
 *
 * "Sync ezCater menu", the conservative version (feat/ezcater-menu-sync-v1), after review round 4
 * (exact by construction):
 *   supabase/functions/_shared/ezcaterMenuSync.ts      rules: one row per exact full name, exact auto links, routes
 *   supabase/functions/_shared/ezcaterMenuSyncRun.ts   the job: claim, read, plan, write
 *   supabase/functions/_shared/ezcater-match-ingest.ts the order time rules, paged link reads
 *
 * THE RULES UNDER TEST
 *   A  once 20260919m has run, orders only use matches made before the order, and only for the
 *      exact name they were made for: a line matches only when its exact full name (its name plus
 *      its size name) is a synced row's, its published size id is on that row, and the row holds a
 *      staff match or an exact auto link from a sync. No guessing; nothing written but seen counters.
 *   B  every sync decides every automatic row again from the whole menu (kept, moved or cleared);
 *      a staff decision is never changed
 *   C  an option is never auto linked (review round 6); only a staff match routes one. The sync
 *      links plain item names that match exactly; options, and names with symbols or emoji, are
 *      for staff to match
 *   D  what the earlier rounds fixed: failed or partial link reads print by name, ids kept across a
 *      republish, the NOT NULL source default, the 18 s cron budget, the migration name 20260919m
 *   E  exact by construction (review round 4): one row per exact full name, so two ezCater products
 *      never share a row, its ids or a decision (the round 3 reviewer's repro cases); the re-decide
 *      writes its ids in the same statement; the bail paths take ezCater's own ids off; a staff
 *      decision from before the sync is carried over as it was, or flagged to look at again
 *
 * No live ezCater call: ezCater is a fake `ask` answering in the shape proven live on 18 Sep 2026.
 * Run: `npm test`, or `node --test src/lib/ezcaterMenuSyncV1.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  flattenMenus, flattenMenusWithNotes, planMenuSync, autoTargetFor, sizeRouteFor, optionRouteFor, indexSyncedRows,
  currentMenus, venueDate, readCatererMenus, readAllLinks, MENU_QUERY, MENU_QUERY_NO_OPTIONS,
  LINK_PAGE_SIZE, exactName, singleSizeExactName, sizeAddsWords, fullNameOf, lookAgainOf,
  isMissingSyncColumn, isMissingLinksTable, writeSyncPlan, trustedTarget, isSyncedRow, finishSync,
  itemIdentity, optionIdentity, syncKeyOf, isSyncKey, identityOfKey, lineIdentity, modIdentity, shownIdentity,
  SYNC_KEY_PREFIX, oldKeysOf, carryOverFor, asciiExactName, isCurrentSyncKey, isEarlierSyncRow, earlierSyncKeysOf,
  optionItemsOf, optionPairOf, decidedAsOf, readableDecidedAs, isPlainName, plainSame, round5ExactName, mayAutoLink,
} from '../../supabase/functions/_shared/ezcaterMenuSync.ts';
import { runMenuSync, dueLocations, runDueSyncs, CRON_BUDGET_MS, MIGRATION_FILE } from '../../supabase/functions/_shared/ezcaterMenuSyncRun.ts';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  planLineMatches, planSyncedLineMatches, planNameMatches, readMatchInputs, saveLinkWrites, matchQueueRow,
  withoutPosIds, linesWithoutPosIds,
} from '../../supabase/functions/_shared/ezcater-match-ingest.ts';
import { buildLinkKey } from '../../supabase/functions/_shared/ezcaterMatch.ts';
import { orderItemsToLines } from '../../supabase/functions/_shared/ezcater-map.ts';
import { sharedDepsOf } from '../../scripts/edgeFnDeps.mjs';
import {
  toRow, rowsFrom, saveBody, applySaved, theirLabel, suggestionsFor, countRows,
  liveRows, offMenuRows, lookAgainCount, lookAgainNote, offMenuLine, olderNote, seenLine, goneCount, goneLine,
  SYNC_KEY_PREFIX as CLIENT_SYNC_KEY_PREFIX, isCurrentOptionKey, readableDecidedAs as clientReadableDecidedAs,
} from './ezcaterItemRows.js';

const NOW = '2026-09-18T15:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const LOC = 'loc-1';
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** The key of the synced row for an item sold under this name and size (or no size). */
const K = (name, sizeName = '') => syncKeyOf(itemIdentity(name, sizeName));
/** The key of the synced row for an option: its item, group and value (review round 5). */
const OK = (item, group, value) => syncKeyOf(optionIdentity(item, group, value));

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
 * `failUpdate(table, patch, eq)` and `failUpsert(table, rows, opts)` return the error one write
 * should fail with, or null. `failLinkRead(columns)` the error a link read should fail with.
 * `failTable` maps a table to the error every read of it fails with.
 * `noSyncColumns` is the database before 20260919m: a select naming a sync column fails whole.
 */
function fakeSb(tables, { claim = 'claim-1', rpcError = null, noSyncColumns = false, failLinkPageFrom = null, failUpdate = null,
  failUpsert = null, failLinkRead = null, failTable = {}, noApiUrl = false,
  schemas = { ezcater_item_links: schemaOf('ezcater_item_links') } } = {}) {
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
      if (failLinkRead && name === 'ezcater_item_links' && st.op === 'select') {
        const e = failLinkRead(st.cols);
        if (e) return { data: null, error: e };
      }
      if (failTable[name] && st.op === 'select') return { data: null, error: failTable[name] };
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
        calls.push({ op: 'upsert', table: name, n: rows.length, ignore: !!st.opts?.ignoreDuplicates, keys: rows.map((r) => r.ez_key) });
        const refusedUp = failUpsert ? failUpsert(name, rows, st.opts) : null;
        if (refusedUp) return { data: null, error: refusedUp };
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
const item = (id, name, sizes) => ({ id, name, sizes });
const syncPlan = (menus, ourItems, extra = {}) => planMenuSync({
  entries: flattenMenus(menus), existing: [], ourItems, ourGroups: [], locationId: LOC, nowIso: NOW,
  complete: true, menuOk: true, ...extra,
});
/** An order line as ezcater-map.ts builds it: its name, the published size id and size name, no item match. */
const line = (name, ezSizeId, sizeName, extra = {}) => ({ itemId: null, name, ezSizeId, sizeName, qty: 1, price: 10, mods: [], ...extra });

/**
 * What ezcater-connect items_save writes for one Item matching card save after 20260919m (the edge
 * function is Deno and cannot be imported here; a static test below holds this mirror to it): the
 * card's saveBody, then the SYNCED row with that key UPDATED (never created, never renamed),
 * recording what the screen showed as decided_as (decidedAsOf: an option's parts apart). A save on
 * a key that is not a current sync key for its kind is refused as a stale page.
 */
function itemsSave(sb, dbRow, choice, userId = 'user-1') {
  const shown = toRow({ ...dbRow, look_again: lookAgainOf(dbRow).lookAgain }, { syncReady: true });
  const built = saveBody(shown, choice);
  assert.ok(built.body, built.error);
  const body = built.body;
  assert.equal(body.synced, true, 'after 20260919m the card saves only synced rows');
  const matchedBy = body.ignored ? 'ignored' : ((body.menu_item_id || body.option_id) ? userId : null);
  assert.ok(isCurrentSyncKey(body.kind, body.ez_key), 'items_save refuses a key that is not current (stale_page)');
  const hit = links(sb).find((x) => x.kind === body.kind && x.ez_key === body.ez_key && x.synced_at);
  assert.ok(hit, 'the edge function only ever updates a synced row');
  Object.assign(hit, { menu_item_id: body.menu_item_id, option_id: body.option_id, source: 'manual', matched_by: matchedBy,
    decided_as: decidedAsOf({ kind: body.kind, name: body.ez_name, group: body.ez_group || '', sizeName: body.kind === 'item' ? (body.seen_size || '') : '', item: body.kind === 'option' ? (body.seen_item || '') : '' }) });
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

test('a Potbelly shaped menu flattens to one row per exact full name: single size items, each size, each option', () => {
  const entries = flattenMenus([POTBELLY, LUNCH]);
  const keys = entries.map((e) => e.kind + ':' + e.ezKey);
  assert.equal(new Set(keys).size, keys.length, 'no key twice');
  assert.deepEqual(keys.sort(), [
    'item:' + K('A Wreck', 'Bigs'), 'item:' + K('A Wreck', 'Original'), 'item:' + K('A Wreck', 'Skinny'),
    'item:' + K('Chicken Salad Large', 'Regular'),
    'item:' + K('Cookie Tray', 'Serves 10'), 'item:' + K('Cookie Tray', 'Serves 20'),
    'item:' + K('Farmhouse Salad', 'Serves 1'),
    'item:' + K('Italian', 'Large'), 'item:' + K('Italian', 'Small'),
    'option:' + OK('A Wreck', 'Bread', 'Multigrain'), 'option:' + OK('A Wreck', 'Bread', 'White'),
  ].sort());
  const salad = entries.find((e) => e.ezName === 'Farmhouse Salad');
  assert.deepEqual(salad.ids.sort(), ['s-salad', 's-salad-2'], 'the same exact name on two menus: one row, both ids');
  assert.equal(salad.ezOnlySize, 'Serves 1');
  assert.equal(salad.ezSizeName, null);
  const big = entries.find((e) => e.ezKey === K('A Wreck', 'Bigs'));
  assert.deepEqual(big.ids, ['s-wreck-big']);
  assert.equal(big.ezSizeName, 'Bigs');
  const multi = entries.find((e) => e.ezName === 'Multigrain');
  assert.deepEqual(multi.ids, ['v-multi'], 'one value id, seen under three sizes, kept once');
  // The key is the exact full name: nothing folded away.
  assert.equal(K('A Wreck', 'Bigs'), 'exact:a wreck bigs');
  assert.equal(K('Caesar Salad (Serves 20)', 'Half Tray'), 'exact:caesar salad (serves 20) half tray', 'plain punctuation is kept, not folded');
  assert.equal(OK('A Wreck', 'Bread', 'White'), 'exact:["a wreck","bread","white"]', 'an option key is structured (round 6)');
  assert.ok(entries.every((e) => isSyncKey(e.ezKey)));
});

test('only current menus are read, on the venue date', () => {
  assert.deepEqual(currentMenus([POTBELLY, LUNCH, OLD], '2026-09-18').map((m) => m.id), ['menu-1', 'menu-2']);
  assert.deepEqual(currentMenus([{ id: 'x', startDate: '2026-09-19' }], '2026-09-18'), []);
  // 03:00 UTC on the 19th is still the 18th in Chicago.
  assert.equal(venueDate(Date.parse('2026-09-19T03:00:00Z'), 'America/Chicago'), '2026-09-18');
});

test('full names and exact full names: what a person sees, what decided_as stores, what a row is keyed by', () => {
  assert.equal(fullNameOf({ kind: 'item', name: 'Turkey Sandwich', onlySize: 'Box' }), 'Turkey Sandwich Box');
  assert.equal(fullNameOf({ kind: 'item', name: 'Italian Boxed Lunch', onlySize: 'Box' }), 'Italian Boxed Lunch Box', 'the full name keeps every word');
  assert.equal(fullNameOf({ kind: 'item', name: 'Caesar Salad', sizeName: 'Half Tray' }), 'Caesar Salad Half Tray');
  assert.equal(fullNameOf({ kind: 'item', name: 'Turkey Sandwich' }), 'Turkey Sandwich');
  assert.equal(fullNameOf({ kind: 'option', name: 'White', group: 'Bread', item: 'Sub' }), 'Sub › Bread: White');
  assert.equal(fullNameOf({ kind: 'option', name: 'White', group: 'Bread' }), 'Bread: White', 'a row from before round 5 had no item');
  assert.equal(itemIdentity('Italian Boxed Lunch', 'Box'), 'italian boxed lunch box');
  assert.equal(itemIdentity('', 'Box'), '', 'no item name, no row');
  assert.notEqual(optionIdentity('Sub', 'Bread White', 'Roll'), optionIdentity('Sub', 'Bread', 'White Roll'), 'the group and the value stay apart');
  assert.notEqual(optionIdentity('Sub Bread', 'White', 'Roll'), optionIdentity('Sub', 'Bread White', 'Roll'), 'the item and the group stay apart');
  assert.equal(optionIdentity('', 'Bread', 'White'), '', 'an option with no item has no row');
  // Round 6: an option's decided_as holds its parts apart and is never parsed out of a display string.
  assert.equal(shownIdentity('option', decidedAsOf({ kind: 'option', item: 'Sub', group: 'Bread', name: 'White Roll' })), optionIdentity('Sub', 'Bread', 'White Roll'));
  assert.equal(shownIdentity('option', decidedAsOf({ kind: 'option', item: 'Sub', group: '', name: 'White' })), optionIdentity('Sub', '', 'White'));
  assert.equal(shownIdentity('option', 'Sub › Bread: White Roll'), '', 'a readable option text is never read back into parts');
  assert.equal(shownIdentity('option', 'Bread: White'), '', 'a name with no item is no synced option row name');
  assert.equal(readableDecidedAs(decidedAsOf({ kind: 'option', item: 'Sub', group: 'Bread', name: 'White' })), 'Sub › Bread: White');
  assert.equal(shownIdentity('item', 'Italian Boxed Lunch Box'), itemIdentity('Italian Boxed Lunch', 'Box'));
  assert.equal(sizeAddsWords('Cookie Trays', 'Tray'), false);
  assert.equal(sizeAddsWords('Caesar Salad', ''), false, 'a size with no name adds nothing');
  assert.equal(singleSizeExactName('Caesar Salad', 'Large'), 'caesar salad large');
  assert.equal(singleSizeExactName('Italian Boxed Lunch', 'Box'), 'italian boxed lunch', 'the Boxed allowance is in the auto link name only');
  // Round 6: a plain name folds case, Latin accents and whitespace ONLY ('&' and brackets stay).
  assert.equal(exactName("  Crème  Brûlée & Chef's (Large) "), "creme brulee & chef's (large)");
  // A name that is not plain (a curly apostrophe) is kept as written, whitespace evened out.
  assert.equal(exactName('  Crème  Brûlée & Chef\u2019s (Large) '), 'Crème Brûlée & Chef\u2019s (Large)');
  assert.equal(isSyncKey('exact:x'), true);
  assert.equal(isSyncKey('x'), false);
  assert.equal(isSyncKey('exact:'), false);
  assert.equal(identityOfKey('exact:sub|bread|white'), 'sub|bread|white');
  assert.equal(isCurrentSyncKey('option', 'exact:sub|bread|white'), false, 'a round 5 option key is not current');
  assert.equal(isCurrentSyncKey('option', OK('Sub', 'Bread', 'White')), true);
  assert.equal(identityOfKey('bread|white'), '');
  // ezCater's own documented example line: "Margherita Pizza" sold as a "12\" Pizza".
  assert.equal(lineIdentity({ name: 'Margherita Pizza', sizeName: '12" Pizza' }), itemIdentity('Margherita Pizza', '12" Pizza'));
  assert.equal(lineIdentity({ name: 'Margherita Pizza', sizeName: null }), 'margherita pizza');
  assert.equal(modIdentity({ label: 'White', groupLabel: 'Bread' }, { name: 'Sub' }), '["sub","bread","white"]');
  assert.equal(modIdentity({ label: 'White', groupLabel: 'Bread' }, null), '', 'a customization with no line has no row');
  // The client mirror of the prefix is the same string.
  assert.equal(CLIENT_SYNC_KEY_PREFIX, SYNC_KEY_PREFIX);
});

// ── Exact names auto link; size clashes do not ─────────────────────────────────────────────

test('exact names auto link: a single size item, a size by its full name; an option never (round 6)', () => {
  const plan = planMenuSync({
    entries: flattenMenus([POTBELLY]), existing: [], ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS,
    locationId: LOC, nowIso: NOW, complete: true, menuOk: true,
  });
  const by = (k) => plan.inserts.find((r) => r.ez_key === k);
  // Their "Farmhouse Salad" is sold only as "Serves 1": its full name is "Farmhouse Salad
  // Serves 1", which is not our "Farmhouse Salad" exactly, so staff decide (exact means exact).
  assert.equal(by(K('Farmhouse Salad', 'Serves 1')).menu_item_id, null);
  assert.equal(by(K('A Wreck', 'Original')).menu_item_id, 'm-wreck-orig');
  assert.equal(by(K('A Wreck', 'Bigs')).menu_item_id, 'm-wreck-big');
  assert.equal(by(K('A Wreck', 'Bigs')).matched_by, 'exact', 'a sync auto link is marked exact');
  // Our Bread group has Multigrain exactly, but options are for staff to match.
  assert.equal(by(OK('A Wreck', 'Bread', 'Multigrain')).option_id, null);
  assert.equal(by(OK('A Wreck', 'Bread', 'Multigrain')).matched_by, null);
  // Every new row is a not yet ordered row carrying its published ids.
  for (const r of plan.inserts) {
    assert.equal(r.seen_count, 0);
    assert.equal(r.last_seen_at, null);
    assert.equal(r.source, 'auto');
    assert.equal(r.decided_as, null);
    assert.ok(Array.isArray(r.ez_ids));
    assert.ok(isSyncKey(r.ez_key));
  }
  assert.deepEqual(by(K('A Wreck', 'Bigs')).ez_ids, ['s-wreck-big']);
});

test('size clashes and guesses do not auto link', () => {
  const plan = planMenuSync({
    entries: flattenMenus([POTBELLY]), existing: [], ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS,
    locationId: LOC, nowIso: NOW, complete: true, menuOk: true,
  });
  const by = (k) => plan.inserts.find((r) => r.ez_key === k);
  // Their single size "Chicken Salad Large" vs our only "Chicken Salad Small": a size clash.
  assert.equal(by(K('Chicken Salad Large', 'Regular')).menu_item_id, null);
  // Their "Italian" Large, and we only sell Italian Small.
  assert.equal(by(K('Italian', 'Large')).menu_item_id, null);
  assert.equal(by(K('Italian', 'Small')).menu_item_id, 'm-italian-small');
  // Skinny: nothing of ours has that name. Never linked to plain "A Wreck" either.
  assert.equal(by(K('A Wreck', 'Skinny')).menu_item_id, null);
  // Cookie Tray Serves 10 and Serves 20: never linked to our one Cookie Tray.
  assert.equal(by(K('Cookie Tray', 'Serves 10')).menu_item_id, null);
  assert.equal(by(K('Cookie Tray', 'Serves 20')).menu_item_id, null);
  // A size lost in our plain name is not the same size.
  assert.equal(autoTargetFor({ kind: 'item', ezKey: 'x', ezName: 'Italian', ezGroup: null, ezSizeName: 'Large', ezCategory: null, ids: [], noAuto: false },
    [{ id: 'a', name: 'Italian' }]), null);
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
  assert.equal(flattenMenus([platter])[0].ezKey, K('Sandwich Platter Large', 'Serves 12'));
  assert.equal(syncPlan([platter], [{ id: 'm-plat', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  const platter2 = menuOf({ id: 'i-p2', name: 'Sandwich Platter Large', sizes: [size('s-p2', 'Large')] });
  assert.equal(syncPlan([platter2], [{ id: 'm-plat', name: 'Sandwich Platter' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([platter2], [{ id: 'm-plat-l', name: 'Sandwich Platter Large' }]).inserts[0].menu_item_id, 'm-plat-l');
  // "Caesar Salad" sold only as "Large" is neither our "Caesar Salad Small" nor our plain "Caesar Salad".
  const caesar = menuOf({ id: 'i-c', name: 'Caesar Salad', sizes: [size('s-c', 'Large')] });
  assert.equal(flattenMenus([caesar])[0].ezKey, 'exact:caesar salad large');
  assert.equal(syncPlan([caesar], [{ id: 'm-cs', name: 'Caesar Salad Small' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([caesar], [{ id: 'm-c', name: 'Caesar Salad' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([caesar], [{ id: 'm-cl', name: 'Caesar Salad (Large)' }, { id: 'm-cs', name: 'Caesar Salad Small' }]).inserts[0].menu_item_id, null,
    'round 6: punctuation is not folded, so brackets on one side only are a different name');
  assert.equal(syncPlan([caesar], [{ id: 'm-cl2', name: '  caesar  SALAD large ' }]).inserts[0].menu_item_id, 'm-cl2',
    'case and whitespace only: linked');
  // A container word on ONE side is a different name too, both ways round.
  assert.equal(syncPlan([menuOf({ id: 'i-t', name: 'Caesar Salad Half Tray', sizes: [] })], [{ id: 'm-ch', name: 'Caesar Salad Half' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([menuOf({ id: 'i-t2', name: 'Caesar Salad Half', sizes: [] })], [{ id: 'm-cht', name: 'Caesar Salad Half Tray' }]).inserts[0].menu_item_id, null);
  // "Turkey Sandwich" sold only as a Box is not our plain "Turkey Sandwich"; the Potbelly Box is.
  const turkey = menuOf({ id: 'i-ts', name: 'Turkey Sandwich', sizes: [size('s-ts', 'Box')] });
  assert.equal(syncPlan([turkey], [{ id: 'm-ts', name: 'Turkey Sandwich' }]).inserts[0].menu_item_id, null);
  assert.equal(syncPlan([turkey], [{ id: 'm-tsb', name: 'Turkey Sandwich Box' }]).inserts[0].menu_item_id, 'm-tsb');
  const p = syncPlan([HKX77V_MENU], [{ id: 'm-ibl', name: 'Italian Boxed Lunch' }, { id: 'm-it', name: 'Italian' }]);
  assert.equal(p.inserts[0].ez_key, 'exact:italian boxed lunch box', 'the key keeps Box');
  assert.equal(p.inserts[0].menu_item_id, 'm-ibl', 'the auto link allows a Box that repeats Boxed');
  assert.deepEqual(p.inserts[0].ez_ids, [HKX77V_SIZE_ID], 'the size id, never the item id');
});

test('exact by construction: names the old keys folded together are separate rows, and what no name can tell apart is never linked', () => {
  // "Sandwich Platter Tray" and "Sandwich Platter" shared the old key "sandwich platter" (it
  // dropped a trailing tray). Now they are two rows, each decided on its own exact name.
  const a = { id: 'a', name: 'Sandwich Platter', sizes: [] };
  const b = { id: 'b', name: 'Sandwich Platter Tray', sizes: [] };
  const rows = flattenMenus([menuOf(a, b)]);
  assert.deepEqual(rows.map((r) => [r.ezKey, r.noAuto]), [[K('Sandwich Platter'), false], [K('Sandwich Platter Tray'), false]]);
  const p = syncPlan([menuOf(a, b)], [{ id: 'm-sp', name: 'Sandwich Platter' }]);
  assert.equal(p.inserts.find((r) => r.ez_key === K('Sandwich Platter')).menu_item_id, 'm-sp');
  assert.equal(p.inserts.find((r) => r.ez_key === K('Sandwich Platter Tray')).menu_item_id, null, 'the Tray is not our Sandwich Platter');
  // Two of ours with the same exact name: never a guess.
  assert.equal(syncPlan([menuOf({ id: 'c', name: 'Brownie', sizes: [] })],
    [{ id: 'm1', name: 'Brownie' }, { id: 'm2', name: 'brownie' }]).inserts[0].menu_item_id, null);
  // A multi size row links only its full name; a container word on one side links nothing.
  const multi = menuOf({ id: 'd', name: 'Caesar Salad', sizes: [size('s-h', 'Half Tray'), size('s-f', 'Full Tray')] });
  const mp = syncPlan([multi], [{ id: 'm-half', name: 'Caesar Salad Half' }, { id: 'm-full', name: 'Caesar Salad Full Tray' }]);
  assert.equal(mp.inserts.find((r) => r.ez_key === K('Caesar Salad', 'Half Tray')).menu_item_id, null);
  assert.equal(mp.inserts.find((r) => r.ez_key === K('Caesar Salad', 'Full Tray')).menu_item_id, 'm-full');
  // One exact full name the menus describe with two different auto link names: never auto linked.
  const boxed = flattenMenus([menuOf({ id: 'x', name: 'Italian Boxed Lunch', sizes: [size('s1', 'Box')] }, { id: 'y', name: 'Italian Boxed Lunch Box', sizes: [] })]);
  assert.equal(boxed.length, 1);
  assert.equal(boxed[0].noAuto, true);
  assert.equal(boxed[0].ezName, 'Italian Boxed Lunch', 'the description that sorts first, whatever the menu order');
  // Two sizes of ONE item with the same name: no row, no ids, and the sync says so.
  const same = flattenMenusWithNotes([menuOf({ id: 'z', name: 'Cookies', sizes: [size('c1', 'Dozen'), size('c2', 'dozen')] },
    { id: 'u', name: 'X', sizes: [size('u1', ''), size('u2', '')] })]);
  assert.deepEqual(same.entries, []);
  assert.deepEqual(same.notes.sameName, ['Cookies (Dozen)', 'Cookies (dozen)', 'X (no size name)', 'X (no size name)']);
  // The size with no name of an item with named sizes: its own row, never auto linked.
  const unnamed = flattenMenus([menuOf({ id: 'i', name: 'Italian', sizes: [size('it-0', ''), size('it-l', 'Large')] })]);
  assert.deepEqual(unnamed.map((e) => [e.ezKey, e.ezSizeName, e.noAuto]), [[K('Italian'), null, true], [K('Italian', 'Large'), 'Large', false]]);
  assert.equal(syncPlan([menuOf({ id: 'i', name: 'Italian', sizes: [size('it-0', ''), size('it-l', 'Large')] })], [{ id: 'm-i', name: 'Italian' }])
    .inserts.find((r) => r.ez_key === K('Italian')).menu_item_id, null);
});

// ── RULE C: an option needs its group AND its value exact ──────────────────────────────────

const subWith = (group, values) => menuOf({ id: 'i-sub', name: 'Sub', sizes: [
  size('s-sub', '', { customizationTypes: [{ id: 'ct-1', name: group, values }] }),
] });

test('RULE C (round 6): an option is NEVER auto linked, however exactly its group and value match ours', () => {
  const entries = flattenMenus([subWith('Bread', [{ id: 'v-w', name: 'White' }])]);
  const white = entries.find((e) => e.kind === 'option');
  assert.equal(white.ezGroup, 'Bread');
  assert.equal(white.ezKey, OK('Sub', 'Bread', 'White'));
  assert.equal(white.noAuto, true, 'every option row is marked never auto linked');
  assert.equal(white.exactName, '');
  const bread = { id: 'g-bread', name: 'Bread', options: [{ id: 'o-w-bread', name: 'White', itemId: 'm-white-bread' }] };
  assert.equal(autoTargetFor(white, [{ id: 'm-white-bread', name: 'White' }]), null);
  assert.equal(autoTargetFor({ ...white, noAuto: false }, [{ id: 'x', name: 'White' }]), null, 'not even with noAuto cleared by hand');
  const p = planMenuSync({ entries, existing: [], ourItems: [{ id: 'm-sub', name: 'Sub' }], ourGroups: [bread], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  const opt = p.inserts.find((r) => r.kind === 'option');
  assert.equal(opt.option_id, null);
  assert.equal(opt.menu_item_id, null);
  assert.equal(opt.source, 'auto');
  assert.equal(opt.matched_by, null);
  assert.equal(p.counts.toDecide >= 1, true, 'it is listed for staff');
  // "Bread" and "Bread Size" shared the old key "bread": two rows now, each for staff.
  const two = flattenMenus([subWith('Bread', [{ id: 'v-1', name: 'White' }]),
    { ...subWith('Bread Size', [{ id: 'v-2', name: 'White' }]), id: 'm-y' }]).filter((e) => e.kind === 'option');
  assert.deepEqual(two.map((e) => [e.ezKey, e.ids, e.noAuto]), [[OK('Sub', 'Bread', 'White'), ['v-1'], true], [OK('Sub', 'Bread Size', 'White'), ['v-2'], true]]);
  // An automatic option decision already on a current row (only a hand edit could make one) is
  // cleared by the next sync and never routes before it.
  const existing = [{ location_id: LOC, kind: 'option', ez_key: OK('Sub', 'Bread', 'White'), ez_name: 'White', ez_group: 'Bread', ez_item_name: 'Sub',
    ez_ids: ['v-w'], synced_at: NOW, menu_item_id: 'm-white-bread', option_id: 'o-w-bread', source: 'auto', matched_by: 'exact' }];
  assert.equal(trustedTarget(existing[0]), null);
  const again = planMenuSync({ entries, existing, ourItems: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.deepEqual(again.redecides.map((r) => [r.ezKey, r.optionId, r.matchedBy]), [[OK('Sub', 'Bread', 'White'), null, null]]);
});

test('RULE C end to end (round 6): Bread White routes only after a staff match, and only to the option staff chose', async () => {
  const lines = orderItemsToLines([{ uuid: 'ol-1', name: 'Sub', menuItemSizeId: 's-sub', menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: 'v-w', customizationTypeId: 'ct-1', customizationTypeName: 'Bread', name: 'White', quantity: 1 }] }]);
  const cheese = { id: 'g-cheese', name: 'Cheese', options: [{ id: 'o-w-cheese', name: 'White' }] };
  const bread = { id: 'g-bread', name: 'Bread', options: [{ id: 'o-w-bread', name: 'White' }] };
  const menus = [[subWith('Bread', [{ id: 'v-w', name: 'White' }])]];
  const ours = [{ id: 'm-sub', name: 'Sub' }];
  const onlyCheese = await pipeline({ menus, ours, groups: [cheese], lines });
  assert.equal(onlyCheese.out[0].mods[0].optionId, null);
  assert.equal(onlyCheese.queued[0].mods[0].optionId, null);
  assert.equal(onlyCheese.row(OK('Sub', 'Bread', 'White')).option_id, null);
  const withBread = await pipeline({ menus, ours, groups: [cheese, bread], lines });
  assert.equal(withBread.out[0].itemId, 'm-sub', 'the plain item still auto links');
  assert.equal(withBread.out[0].mods[0].optionId, null, 'the option waits for staff');
  assert.equal(withBread.queued[0].mods[0].optionId, null);
  const staff = await pipeline({ menus, ours, groups: [cheese, bread], lines,
    after: [(sb) => { itemsSave(sb, row(sb, OK('Sub', 'Bread', 'White')), { optionId: 'o-w-bread' }); }] });
  assert.equal(staff.out[0].mods[0].optionId, 'o-w-bread');
  assert.equal(staff.queued[0].mods[0].optionId, 'o-w-bread');
});

// ── RULE A: orders only use matches made before the order, for the exact name they were made for ──

const SYNCED = [
  { kind: 'item', ez_key: K('A Wreck', 'Bigs'), ez_name: 'A Wreck', ez_size_name: 'Bigs', ez_ids: ['s-wreck-big'], synced_at: NOW,
    menu_item_id: 'm-wreck-big', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 },
  { kind: 'item', ez_key: K('A Wreck', 'Skinny'), ez_name: 'A Wreck', ez_size_name: 'Skinny', ez_ids: ['s-wreck-skinny'], synced_at: NOW,
    menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0 },
  // A synced row holding an automatic link that is not an exact one (only a hand edit could make one): not trusted.
  { kind: 'item', ez_key: K('Farmhouse Salad', 'Serves 1'), ez_name: 'Farmhouse Salad', ez_only_size: 'Serves 1', ez_ids: ['s-salad'], synced_at: NOW,
    menu_item_id: 'm-salad', option_id: null, source: 'auto', matched_by: 'name', seen_count: 3 },
  // A staff match on a synced row, made for its exact name.
  { kind: 'item', ez_key: K('Chicken Salad Large', 'Regular'), ez_name: 'Chicken Salad Large', ez_only_size: 'Regular', ez_ids: ['s-chick'], synced_at: NOW,
    menu_item_id: 'm-chick-small', option_id: null, source: 'manual', matched_by: 'u-1', decided_as: 'Chicken Salad Large Regular', seen_count: 1 },
  // An OLD staff name match saved before the sync: orders never use it after the migration.
  { kind: 'item', ez_key: 'a wreck', ez_name: 'A Wreck', ez_size_name: null, ez_ids: [], menu_item_id: 'm-wreck-orig', option_id: null,
    source: 'manual', matched_by: 'user-1', seen_count: 9 },
  // An OLD staff match stored under the LEGACY key (size word dropped) for "Caesar Salad Large".
  { kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad Large', ez_ids: [], menu_item_id: 'm-c', option_id: null,
    source: 'manual', matched_by: 'user-1', seen_count: 4 },
  // A row saved before the sync that holds a published id anyway (only a hand edit or an older build
  // could): it is not a synced row, so it is never used.
  { kind: 'item', ez_key: 'coded thing', ez_name: 'Coded Thing', ez_ids: ['s-old-format'], synced_at: NOW, menu_item_id: 'm-wreck-orig',
    option_id: null, source: 'manual', matched_by: 'u', seen_count: 0 },
];
const OURS_A = [...OUR_ITEMS, { id: 'm-c', name: 'Caesar Salad Large' }, { id: 'm-code', name: 'Coded', itemCode: 'A12' }];
const planA = (lines, extra = {}) => planLineMatches({
  lines, ourItems: OURS_A, ourGroups: OUR_GROUPS, links: SYNCED, locationId: LOC, nowIso: NOW, sizeIds: true, ...extra,
});

test('RULE A: a line matches only when its exact name and size are a synced row\'s, its size id is on that row, and the row holds a staff match or an exact auto link', () => {
  const p = planA([
    line('A Wreck', 's-wreck-big', 'Bigs'),
    line('A Wreck', 's-wreck-skinny', 'Skinny'),
    line('Farmhouse Salad', 's-salad', 'Serves 1'),
    line('Chicken Salad Large', 's-chick', 'Regular'),
    line('A Wreck', 's-wreck-big', 'Skinny'),       // the Bigs id under the Skinny name
    line('A Wreck', 's-wreck-skinny', 'Bigs'),      // the Skinny id under the Bigs name
    line('Coded Thing', 's-old-format', null),      // an id on a row saved before the sync
  ]);
  assert.deepEqual(p.lines.map((l) => l.itemId), ['m-wreck-big', null, null, 'm-chick-small', null, null, null]);
  assert.equal(p.lines[0].match.source, 'menuSync', 'an exact auto link from a sync');
  assert.equal(p.lines[2].match.matched, false, 'an automatic link that is not exact is not a trusted decision');
  assert.equal(p.writes.length, 0, 'an order writes no link row');
  assert.equal(p.upgrades.length, 0, 'an order fills nothing in');
  // Only the seen counters of the rows the lines landed on: exact name AND id.
  assert.deepEqual(p.bumps.map((b) => b.ezKey).sort(),
    [K('A Wreck', 'Bigs'), K('A Wreck', 'Skinny'), K('Chicken Salad Large', 'Regular'), K('Farmhouse Salad', 'Serves 1')].sort());
  assert.equal(p.bumps.find((b) => b.ezKey === K('Farmhouse Salad', 'Serves 1')).seenCount, 4);
});

test('RULE A: no guessing at order time: exact names without an id, old staff rows, legacy keys, posItemId and item codes all print by name', () => {
  const lines = [
    line('A Wreck Original', null, null),                          // our exact name, no size id
    line('A Wreck', 's-republished-999', 'Original'),              // a name with no synced row
    line('Caesar Salad Large', null, null),                        // an old staff row under the legacy key
    line('Caesar Salad Large', 's-new', 'Large'),                  // the same, with an unknown size id
    line('Something', null, null, { itemId: 'm-wreck-big' }),      // a posItemId naming our item
    line('Coded', null, null, { itemId: 'A12' }),                  // a posItemId carrying our item code
    line('Farmhouse Salad', null, null),                           // a synced row's own name, no size id
    line('A Wreck', 's-wreck-big', null),                          // the Bigs id with no size name
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

test('RULE A: a customization matches only by its exact group and value AND its published id, on a synced option row with a STAFF match', () => {
  const optRows = [
    { kind: 'option', ez_key: OK('A Wreck', 'Bread', 'Multigrain'), ez_name: 'Multigrain', ez_group: 'Bread', ez_item_name: 'A Wreck',
      ez_ids: ['v-multi'], synced_at: NOW, menu_item_id: null, option_id: 'o-multi', source: 'manual', matched_by: 'u-1', seen_count: 0,
      decided_as: decidedAsOf({ kind: 'option', item: 'A Wreck', group: 'Bread', name: 'Multigrain' }) },
    { kind: 'option', ez_key: OK('A Wreck', 'Bread', 'White'), ez_name: 'White', ez_group: 'Bread', ez_item_name: 'A Wreck',
      ez_ids: ['v-white'], synced_at: NOW, menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0 },
    // A staff match saved before the sync: orders never use it after the migration.
    { kind: 'option', ez_key: buildLinkKey({ name: 'Rye', groupLabel: 'Bread' }, 'option'), ez_name: 'Rye', ez_group: 'Bread',
      ez_ids: [], menu_item_id: null, option_id: 'o-rye', source: 'manual', matched_by: 'u', seen_count: 0 },
  ];
  const [l] = orderItemsToLines([{ uuid: 'ol-9', name: 'A Wreck', menuItemSizeId: 's-wreck-big', menuItemSizeName: 'Bigs', quantity: 1, customizations: [
    { customizationId: 'v-multi', customizationTypeName: 'Bread', name: 'Multigrain', quantity: 1 },
    { customizationId: 'v-white', customizationTypeName: 'Bread', name: 'White', quantity: 1 },
    { customizationId: null, customizationTypeName: 'Bread', name: 'Multigrain', quantity: 1 },
    { customizationId: 'v-rye-new', customizationTypeName: 'Bread', name: 'Rye', quantity: 1, posCustomizationId: 'o-rye' },
    { customizationId: 'v-multi', customizationTypeName: 'Bread Size', name: 'Multigrain', quantity: 1 },
  ] }]);
  assert.equal(l.mods[0].ezItemId, 'v-multi', 'the mapper carries customizationId as ezItemId');
  const p = planA([l], { links: [...SYNCED, ...optRows] });
  assert.equal(p.lines[0].itemId, 'm-wreck-big');
  assert.deepEqual(p.lines[0].mods.map((m) => m.optionId), ['o-multi', null, null, null, null]);
  assert.equal(p.lines[0].mods[3].itemId, null, 'a posCustomizationId is not used after the migration');
  assert.equal(p.writes.length, 0);
  const idx = indexSyncedRows(optRows, 'option');
  assert.equal(idx.size, 2, 'the row saved before the sync is never indexed');
  assert.equal(optionRouteFor({ ezItemId: 'v-multi', groupLabel: 'Bread', label: 'Multigrain' }, idx, l).mode, 'synced');
  assert.equal(optionRouteFor({ label: 'Multigrain', groupLabel: 'Bread' }, idx, l).mode, 'unmatched', 'no id, no match');
  // Round 6: an automatic option decision never routes, even an exact one on a current row.
  const autoOpt = { ...optRows[0], source: 'auto', matched_by: 'exact', decided_as: null };
  assert.equal(trustedTarget(autoOpt), null);
  assert.equal(optionRouteFor({ ezItemId: 'v-multi', groupLabel: 'Bread', label: 'Multigrain' }, indexSyncedRows([autoOpt], 'option'), l).optionId, null);
  assert.deepEqual(optionRouteFor({ ezItemId: 'v-multi', groupLabel: 'Bread Size', label: 'Multigrain' }, idx, l),
    { mode: 'unmatched', reason: 'no synced option on this item with this exact name' });
});

test('RULE A: the synced order path has no name guesser in it at all', () => {
  const src = read('../../supabase/functions/_shared/ezcater-match-ingest.ts');
  const start = src.indexOf('export function planSyncedLineMatches(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(start > 0 && body.length > 500);
  for (const name of ['autoLinkDecision', 'findLink', 'applyLinks', 'indexLinks', 'legacyLinkKey', 'linkKeyCandidates',
    'buildLinkKey', 'indexItemCodes', 'rawName', 'normaliseItemName', 'normaliseKeyName', 'indexPublishedIds']) {
    assert.ok(!body.includes(name + '('), 'planSyncedLineMatches calls ' + name);
  }
  assert.ok(body.includes('indexSyncedRows(links, \'item\')') && body.includes('sizeRouteFor(line, itemIdx)'));
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
  assert.doesNotMatch(body, /sizeIds|synced|trustedTarget|sizeRouteFor|exact:/);
});

test('sizeRouteFor: the line\'s exact name picks its one row, the id must be on that row, and gone items never route', () => {
  const idx = indexSyncedRows([
    { kind: 'item', ez_key: K('Caesar Salad', 'Regular'), ez_name: 'Caesar Salad', ez_only_size: 'Regular', ez_ids: ['s1'], menu_item_id: 'm-reg', source: 'auto', matched_by: 'exact' },
    { kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', ez_ids: ['s1', 's2'], menu_item_id: 'm-lg', source: 'auto', matched_by: 'exact' },
    { kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', ez_ids: ['s1'], menu_item_id: 'm-old', source: 'manual' },
  ]);
  assert.equal(idx.has('caesar salad'), false, 'a row saved before the sync is never indexed');
  assert.deepEqual(sizeRouteFor({ name: 'Caesar Salad', sizeName: 'Regular', ezSizeId: 's1' }, idx), { mode: 'synced', ezKey: K('Caesar Salad', 'Regular'), itemId: 'm-reg' });
  assert.deepEqual(sizeRouteFor({ name: 'Caesar Salad', sizeName: 'Large', ezSizeId: 's1' }, idx), { mode: 'synced', ezKey: K('Caesar Salad', 'Large'), itemId: 'm-lg' },
    'one id on two rows (a size renamed in place): the exact name decides');
  assert.deepEqual(sizeRouteFor({ name: 'Caesar Salad', sizeName: 'Regular', ezSizeId: 's2' }, idx), { mode: 'unmatched', reason: 'size id not on the row with this exact name' });
  assert.deepEqual(sizeRouteFor({ name: 'Caesar Salad', sizeName: null, ezSizeId: 's1' }, idx), { mode: 'unmatched', reason: 'no synced row with this exact name' });
  assert.deepEqual(sizeRouteFor({ name: 'Caesar Salad', sizeName: 'Regular', ezSizeId: null }, idx), { mode: 'unmatched', reason: 'no size id' });
  const gone = planA([line('A Wreck', 's-wreck-big', 'Bigs')], { ourItems: OURS_A.filter((i) => i.id !== 'm-wreck-big') });
  assert.equal(gone.lines[0].itemId, null, 'a row pointing at a deleted item routes nothing');
  // Our menu not read whole: the target cannot be proven gone, and the decision still stands.
  assert.equal(planA([line('A Wreck', 's-wreck-big', 'Bigs')], { ourItems: [], menuOk: false }).lines[0].itemId, 'm-wreck-big');
});

test('order time matches the SIZE id on the row of the line\'s exact name, never the order line item id (HKX77V)', () => {
  const synced = [{ kind: 'item', ez_key: K('Italian Boxed Lunch', 'Box'), ez_name: 'Italian Boxed Lunch', ez_only_size: 'Box',
    ez_ids: [HKX77V_SIZE_ID], synced_at: NOW, menu_item_id: 'm-ibl', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 }];
  const [hk] = orderItemsToLines([{ uuid: '5f5b503b', name: 'Italian Boxed Lunch', menuItemSizeId: HKX77V_SIZE_ID, menuItemSizeName: 'Box', quantity: 1, customizations: [] }]);
  assert.equal(hk.ezItemId, '5f5b503b');
  assert.equal(lineIdentity(hk), 'italian boxed lunch box');
  assert.equal(sizeRouteFor(hk, indexSyncedRows(synced)).mode, 'synced');
  assert.equal(planSyncedLineMatches({ lines: [hk], links: synced, ourItems: [{ id: 'm-ibl', name: 'Italian Boxed Lunch' }] }).lines[0].itemId, 'm-ibl');
  // An item id that happens to be on a row matches nothing: only ezSizeId is read.
  const byItemId = indexSyncedRows([{ ...synced[0], ez_ids: ['5f5b503b'] }]);
  assert.equal(sizeRouteFor(hk, byItemId).mode, 'unmatched');
  assert.equal(sizeRouteFor({ ...hk, ezSizeId: null }, byItemId).mode, 'unmatched');
  // The size name is part of the exact name: a line without it is not the Box, whatever its id.
  assert.equal(sizeRouteFor({ ...hk, sizeName: null }, indexSyncedRows(synced)).mode, 'unmatched');
});

// ── RULE B: every sync decides every automatic row again; a rename is a new row ─────────────

test('RULE B end to end: Caesar Salad sold only as Regular, then only as Large, is two rows; each line goes to its own exact name, never the other size', async () => {
  const v1 = menuOf(item('i-c', 'Caesar Salad', [size('c-reg', 'Regular')]));
  const v2 = menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]));
  const lines = [line('Caesar Salad', 'c-lg', 'Large'), line('Caesar Salad', 'c-reg', 'Regular'), line('Caesar Salad', 'c-reg', 'Large')];
  const both = await pipeline({ menus: [[v1], [v2]], lines,
    ours: [{ id: 'm-cr', name: 'Caesar Salad Regular' }, { id: 'm-cl', name: 'Caesar Salad Large' }] });
  assert.equal(both.plans[0].inserts[0].menu_item_id, 'm-cr', 'sync 1: Regular, exactly');
  const reg = both.row(K('Caesar Salad', 'Regular'));
  const lg = both.row(K('Caesar Salad', 'Large'));
  assert.equal(reg.menu_item_id, 'm-cr', 'the Regular row keeps its own match: it is still exactly our Regular');
  assert.deepEqual(reg.ez_ids, ['c-reg']);
  assert.equal(lg.menu_item_id, 'm-cl');
  assert.equal(lg.matched_by, 'exact');
  assert.equal(lg.ez_only_size, 'Large');
  assert.deepEqual(lg.ez_ids, ['c-lg'], 'the Regular id never reaches the Large row');
  assert.deepEqual(both.out.map((l) => l.itemId), ['m-cl', 'm-cr', null], 'a change to an old Regular order is our Regular; a Regular id under the Large name is nothing');
  assert.deepEqual(both.queued.map((l) => l.itemId), ['m-cl', 'm-cr', null]);
  assert.equal(both.lp.writes.length + both.lp.upgrades.length, 0);
  assert.deepEqual(both.after, both.before, 'the order changed no decision');
  // We only sell Regular: the Large row waits for staff, and nothing Large ever reaches our Regular.
  const regOnly = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-cr', name: 'Caesar Salad Regular' }] });
  assert.equal(regOnly.row(K('Caesar Salad', 'Large')).menu_item_id, null);
  assert.deepEqual(regOnly.out.map((l) => l.itemId), [null, 'm-cr', null]);
  assert.deepEqual(regOnly.queued.map((l) => l.itemId), [null, 'm-cr', null]);
});

test('RULE B end to end: Turkey Sandwich sold with no size name, then sold only as Box', async () => {
  const v1 = menuOf(item('i-t', 'Turkey Sandwich', [size('t-0', '')]));
  const v2 = menuOf(item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]));
  const lines = [line('Turkey Sandwich', 't-box', 'Box'), line('Turkey Sandwich', 't-0', null)];
  const plain = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-t', name: 'Turkey Sandwich' }] });
  assert.equal(plain.plans[0].inserts[0].menu_item_id, 'm-t', 'sync 1: no size name, our plain Turkey Sandwich');
  assert.equal(plain.row(K('Turkey Sandwich', 'Box')).menu_item_id, null, 'sync 2: a Box is not our plain Turkey Sandwich');
  assert.equal(plain.row(K('Turkey Sandwich')).menu_item_id, 'm-t', 'the old name keeps its own match');
  assert.deepEqual(plain.out.map((l) => l.itemId), [null, 'm-t']);
  assert.deepEqual(plain.queued.map((l) => l.itemId), [null, 'm-t']);
  const box = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-t', name: 'Turkey Sandwich' }, { id: 'm-tb', name: 'Turkey Sandwich Box' }] });
  assert.equal(box.row(K('Turkey Sandwich', 'Box')).menu_item_id, 'm-tb', 'exactly our Turkey Sandwich Box');
  assert.deepEqual(box.out.map((l) => l.itemId), ['m-tb', 'm-t']);
  assert.deepEqual(box.queued.map((l) => l.itemId), ['m-tb', 'm-t']);
  // With no sizes at all the first time: the Box is a new row, and the plain row is left as it is.
  const noSizes = planMenuSync({ entries: flattenMenus([menuOf(item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]))]),
    existing: syncPlan([menuOf(item('i-t', 'Turkey Sandwich', []))], [{ id: 'm-t', name: 'Turkey Sandwich' }]).inserts,
    ourItems: [{ id: 'm-t', name: 'Turkey Sandwich' }], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.deepEqual(noSizes.inserts.map((r) => [r.ez_key, r.menu_item_id]), [[K('Turkey Sandwich', 'Box'), null]]);
  assert.deepEqual(noSizes.redecides, [], 'the plain row is still exactly our Turkey Sandwich');
});

test('RULE B end to end: Italian with no size name, then sold only as Small', async () => {
  const v1 = menuOf(item('i-i', 'Italian', [size('it-0', '')]));
  const v2 = menuOf(item('i-i', 'Italian', [size('it-s', 'Small')]));
  const lines = [line('Italian', 'it-s', 'Small'), line('Italian', 'it-0', null)];
  const plain = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-i', name: 'Italian' }] });
  assert.equal(plain.plans[0].inserts[0].menu_item_id, 'm-i');
  assert.equal(plain.row(K('Italian', 'Small')).menu_item_id, null);
  assert.deepEqual([...plain.out, ...plain.queued].map((l) => l.itemId), [null, 'm-i', null, 'm-i']);
  const small = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-i', name: 'Italian' }, { id: 'm-is', name: 'Italian Small' }] });
  assert.equal(small.row(K('Italian', 'Small')).menu_item_id, 'm-is');
  assert.deepEqual(small.out.map((l) => l.itemId), ['m-is', 'm-i']);
  assert.deepEqual(small.queued.map((l) => l.itemId), ['m-is', 'm-i']);
});

test('RULE B end to end: Sandwich Platter renamed Sandwich Platter Tray is a new row', async () => {
  const v1 = menuOf(item('i-sp', 'Sandwich Platter', [size('sp-1', '')]));
  const v2 = menuOf(item('i-sp', 'Sandwich Platter Tray', [size('sp-2', '')]));
  assert.notEqual(flattenMenus([v1])[0].ezKey, flattenMenus([v2])[0].ezKey, 'two names, two rows (the old key dropped the tray)');
  const lines = [line('Sandwich Platter Tray', 'sp-2', null), line('Sandwich Platter', 'sp-1', null)];
  const plain = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-sp', name: 'Sandwich Platter' }] });
  assert.equal(plain.plans[0].inserts[0].menu_item_id, 'm-sp');
  const tray = plain.row(K('Sandwich Platter Tray'));
  assert.equal(tray.menu_item_id, null, 'our Sandwich Platter is not their Sandwich Platter Tray');
  assert.equal(tray.ez_name, 'Sandwich Platter Tray');
  assert.deepEqual(tray.ez_ids, ['sp-2']);
  assert.deepEqual(plain.row(K('Sandwich Platter')).ez_ids, ['sp-1'], 'the old name never takes the Tray id');
  assert.deepEqual([...plain.out, ...plain.queued].map((l) => l.itemId), [null, 'm-sp', null, 'm-sp']);
  const both = await pipeline({ menus: [[v1], [v2]], lines, ours: [{ id: 'm-sp', name: 'Sandwich Platter' }, { id: 'm-spt', name: 'Sandwich Platter Tray' }] });
  assert.equal(both.row(K('Sandwich Platter Tray')).menu_item_id, 'm-spt');
  assert.deepEqual(both.out.map((l) => l.itemId), ['m-spt', 'm-sp']);
});

test('RULE B end to end: our item renamed (on the menu, and off it)', async () => {
  const menu = menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]));
  const lines = [line('Caesar Salad', 'c-lg', 'Large')];
  const ours = [{ id: 'm-cl', name: 'Caesar Salad Large' }];
  const rename = (id, name) => (sb) => { sb.store.menu_items.find((i) => i.id === id).name = name; };
  const gone = await pipeline({ menus: [[menu], [menu]], lines, ours, after: [rename('m-cl', 'Large Caesar')] });
  assert.equal(gone.row(K('Caesar Salad', 'Large')).menu_item_id, null, 'our item no longer has that exact name');
  assert.equal(gone.plans[1].counts.cleared, 1);
  assert.equal(gone.out[0].itemId, null);
  assert.equal(gone.queued[0].itemId, null);
  const moved = await pipeline({ menus: [[menu], [menu]], lines, ours: [...ours, { id: 'm-cl2', name: 'Big Caesar' }],
    after: [(sb) => { rename('m-cl', 'Large Caesar')(sb); rename('m-cl2', 'Caesar Salad Large')(sb); }] });
  assert.equal(moved.row(K('Caesar Salad', 'Large')).menu_item_id, 'm-cl2', 'moved to the one item of ours with that exact name now');
  assert.equal(moved.out[0].itemId, 'm-cl2');
  // Off the current menu: kept while it still names exactly that item of ours, cleared once it does not.
  const other = menuOf(item('i-o', 'Other', [size('o-1', '')]));
  const kept = await pipeline({ menus: [[menu], [other]], lines, ours });
  assert.equal(kept.row(K('Caesar Salad', 'Large')).menu_item_id, 'm-cl');
  assert.equal(kept.out[0].itemId, 'm-cl', 'a change to an order placed before still routes');
  const offGone = await pipeline({ menus: [[menu], [other]], lines, ours, after: [rename('m-cl', 'Large Caesar')] });
  assert.equal(offGone.row(K('Caesar Salad', 'Large')).menu_item_id, null);
  assert.equal(offGone.out[0].itemId, null);
});

test('RULE B: every automatic synced row is decided again; a staff row never is; a row saved before the sync is never written', () => {
  const entries = flattenMenus([menuOf(
    item('a', 'Apple Pie', [size('ap', '')]), item('b', 'Brownie', [size('br', '')]),
    item('c', 'Cookie', [size('co', '')]), item('d', 'Donut', [size('do', '')]), item('e', 'Eclair', [size('ec', '')]),
  )]);
  const ours = [{ id: 'm-ap', name: 'Apple Pie' }, { id: 'm-br2', name: 'Brownie' }, { id: 'm-co', name: 'Cookie' }, { id: 'm-do', name: 'Donut' }];
  const existing = [
    { kind: 'item', ez_key: K('Apple Pie'), ez_name: 'Apple Pie', ez_ids: ['ap'], synced_at: NOW, menu_item_id: 'm-ap', source: 'auto', matched_by: 'exact' },
    { kind: 'item', ez_key: K('Brownie'), ez_name: 'Brownie', ez_ids: ['br'], synced_at: NOW, menu_item_id: 'm-br-old', source: 'auto', matched_by: 'exact' },
    // An automatic name link saved before the sync under the old key: not carried, not written.
    { kind: 'item', ez_key: 'cookie', ez_name: 'Cookie', ez_ids: [], menu_item_id: 'm-co', source: 'auto', matched_by: 'name' },
    { kind: 'item', ez_key: K('Donut'), ez_name: 'Donut', ez_ids: ['do'], synced_at: NOW, menu_item_id: null, source: 'auto', matched_by: null },
    { kind: 'item', ez_key: K('Eclair'), ez_name: 'Eclair', ez_ids: ['ec'], synced_at: NOW, menu_item_id: 'm-do', source: 'manual', matched_by: 'u', decided_as: 'Eclair' },
  ];
  const plan = planMenuSync({ entries, existing, ourItems: ours, ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  const by = (k) => plan.redecides.find((r) => r.ezKey === k);
  assert.equal(by(K('Apple Pie')), undefined, 'still exact: nothing to write');
  assert.deepEqual([by(K('Brownie')).was.menuItemId, by(K('Brownie')).menuItemId, by(K('Brownie')).matchedBy], ['m-br-old', 'm-br2', 'exact'], 'an exact link moved');
  assert.deepEqual(by(K('Brownie')).facts.ez_ids, ['br'], 'with its ids in the same write');
  assert.deepEqual([by(K('Donut')).menuItemId, by(K('Donut')).matchedBy], ['m-do', 'exact'], 'an undecided row is filled');
  assert.equal(by(K('Eclair')), undefined, 'a staff decision is never decided again');
  assert.deepEqual(plan.inserts.map((r) => [r.ez_key, r.menu_item_id, r.matched_by]), [[K('Cookie'), 'm-co', 'exact']], 'the Cookie gets its own synced row');
  assert.equal(plan.counts.redecided, 2);
  assert.ok([...plan.inserts, ...plan.refreshes].every((r) => isSyncKey(r.ez_key)) && plan.redecides.every((r) => isSyncKey(r.ezKey)),
    'a sync never writes a row saved before it');
});

test('RULE B: a staff save between the read and the write always wins', async () => {
  const menu = [menuOf(item('i-c', 'Caesar Salad', [size('c-reg', 'Regular')]))];
  const t = TABLES();
  t.menu_items = [{ id: 'm-cr', name: 'Caesar Salad Regular', location_id: LOC, archived: false }, { id: 'm-x', name: 'Other', location_id: LOC, archived: false }];
  const sb = fakeSb(t);
  const sync = async (between) => {
    const input = await readMatchInputs(sb, LOC);
    const plan = planMenuSync({ entries: flattenMenus(menu), existing: input.links, ourItems: input.ourItems, ourGroups: input.ourGroups,
      locationId: LOC, nowIso: NOW, complete: true, menuOk: input.menuOk });
    if (between) between();
    return { plan, wrote: await writeSyncPlan(sb, LOC, plan, NOW) };
  };
  await sync();
  assert.equal(row(sb, K('Caesar Salad', 'Regular')).menu_item_id, 'm-cr');
  // Our items are renamed, so sync 2 plans to move the link to m-x; a person saves m-cr first.
  sb.store.menu_items[0].name = 'Old Caesar';
  sb.store.menu_items[1].name = 'Caesar Salad Regular';
  const { plan, wrote } = await sync(() => itemsSave(sb, row(sb, K('Caesar Salad', 'Regular')), { menuItemId: 'm-cr' }));
  assert.equal(plan.redecides.length, 1);
  assert.equal(plan.redecides[0].menuItemId, 'm-x');
  assert.equal(wrote.redecided, 0, 'the guarded write found the person\'s decision and wrote nothing');
  const r = row(sb, K('Caesar Salad', 'Regular'));
  assert.equal(r.menu_item_id, 'm-cr', "the person's decision stands");
  assert.equal(r.source, 'manual');
  assert.equal(r.decided_as, 'Caesar Salad Regular', 'what their screen showed');
  assert.deepEqual(r.ez_ids, ['c-reg'], 'the ezCater facts are still refreshed');
  assert.equal(lookAgainOf(r).lookAgain, false, 'made for exactly this name');
  const lp = await orderThrough(sb, [line('Caesar Salad', 'c-reg', 'Regular')]);
  assert.equal(lp.lines[0].itemId, 'm-cr');
  // The same with a fill: a person answers an undecided row while the sync runs.
  const sb2 = fakeSb({ ...TABLES([{ location_id: LOC, kind: 'item', ez_key: K('Donut'), ez_name: 'Donut', ez_ids: ['do'], synced_at: NOW,
    menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0 }]),
  menu_items: [{ id: 'm-do', name: 'Donut', location_id: LOC }, { id: 'm-do2', name: 'Glazed', location_id: LOC }] });
  const input = await readMatchInputs(sb2, LOC);
  const fill = planMenuSync({ entries: flattenMenus([menuOf(item('d', 'Donut', [size('do', '')]))]), existing: input.links,
    ourItems: input.ourItems, ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.equal(fill.redecides[0].menuItemId, 'm-do');
  itemsSave(sb2, row(sb2, K('Donut')), { menuItemId: 'm-do2' });
  await writeSyncPlan(sb2, LOC, fill, NOW);
  assert.equal(row(sb2, K('Donut')).menu_item_id, 'm-do2');
  assert.equal(row(sb2, K('Donut')).source, 'manual');
});

test('RULE B: an ezCater rename is a new row: a save from a screen loaded before the sync decides only the name it showed', async () => {
  const t = TABLES();
  t.menu_items = [{ id: 'm-sp', name: 'Sandwich Platter', location_id: LOC, archived: false }];
  const sb = fakeSb(t);
  await syncOnce(sb, [menuOf(item('i-sp', 'Sandwich Platter', [size('sp-1', '')]))]);
  const loaded = { ...row(sb, K('Sandwich Platter')) };   // the card, loaded now
  // ezCater renames it, and a sync runs before the person presses anything.
  await syncOnce(sb, [menuOf(item('i-sp', 'Sandwich Platter Tray', [size('sp-2', '')]))]);
  assert.equal(row(sb, K('Sandwich Platter')).ez_name, 'Sandwich Platter', 'the old name keeps its row');
  assert.equal(row(sb, K('Sandwich Platter Tray')).menu_item_id, null, 'the new name waits for staff');
  // The person presses "Not on our menu" on the old screen: it lands on the name that screen showed.
  itemsSave(sb, loaded, { ignored: true });
  assert.equal(row(sb, K('Sandwich Platter')).matched_by, 'ignored');
  assert.equal(row(sb, K('Sandwich Platter Tray')).matched_by, null, 'the new name is never decided by a screen that never showed it');
  const lp = await orderThrough(sb, [line('Sandwich Platter Tray', 'sp-2', null)]);
  assert.equal(lp.lines[0].itemId, null, 'the Tray prints by name until someone has matched it');
});

test('RULE B: our menu read only in part links nothing new and decides nothing again', () => {
  const entries = flattenMenus([menuOf(item('i-c', 'Caesar Salad', [size('c-lg', 'Large')]), item('i-b', 'Brownie', [size('br', '')]),
    item('i-d', 'Donut', [size('do', '')]))]);
  const existing = [
    { kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', ez_ids: ['c-lg'], synced_at: NOW,
      menu_item_id: 'm-cl', source: 'auto', matched_by: 'exact' },
    { kind: 'item', ez_key: K('Brownie'), ez_name: 'Brownie', ez_ids: ['br'], synced_at: NOW, menu_item_id: 'm-br', source: 'auto', matched_by: 'exact' },
    // Off the current menu.
    { kind: 'item', ez_key: K('Muffin'), ez_name: 'Muffin', ez_ids: ['mu'], synced_at: NOW, menu_item_id: 'm-mu', source: 'auto', matched_by: 'exact' },
  ];
  const plan = planMenuSync({ entries, existing, ourItems: [], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: false });
  assert.deepEqual(plan.redecides, [], 'nothing moved, cleared or set');
  assert.deepEqual(plan.inserts.map((r) => [r.ez_key, r.menu_item_id]), [[K('Donut'), null]], 'nothing new linked');
  assert.deepEqual(plan.refreshes.find((r) => r.ez_key === K('Brownie')).ez_ids, ['br']);
  assert.equal(plan.counts.autoLinked, 2);
});

test('RULE B: a failed decision write keeps that row exactly as it was: its old facts stay with its old decision', async () => {
  // Our Caesar Salad Large was renamed, so the sync clears its exact link; that write fails.
  const sb = fakeSb({ ...TABLES([{ location_id: LOC, kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large',
    ez_ids: ['c-lg'], synced_at: NOW, menu_item_id: 'm-cl', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 }]),
  menu_items: [{ id: 'm-cl', name: 'Large Caesar', location_id: LOC }] }, {
    failUpdate: (name, patch) => (name === 'ezcater_item_links' && 'matched_by' in patch ? { code: '57014', message: 'statement timeout' } : null),
  });
  const input = await readMatchInputs(sb, LOC);
  const plan = planMenuSync({ entries: flattenMenus([menuOf(item('i-c', 'Caesar Salad', [size('c-lg2', 'Large')]))]), existing: input.links,
    ourItems: input.ourItems, ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.equal(plan.redecides.length, 1);
  assert.deepEqual(plan.redecides[0].facts.ez_ids, ['c-lg2', 'c-lg'], 'the decision write carries the new ids');
  const wrote = await writeSyncPlan(sb, LOC, plan, NOW);
  assert.ok(wrote.errors.some((e) => /^decide: statement timeout/.test(e)));
  const r = row(sb, K('Caesar Salad', 'Large'));
  assert.deepEqual(r.ez_ids, ['c-lg'], 'the refresh was held back');
  assert.equal(r.menu_item_id, 'm-cl');
  assert.ok(!sb.calls.some((c) => c.op === 'upsert' && c.keys.includes(K('Caesar Salad', 'Large'))), 'never refreshed on its own');
});

test('RULE B: a staff decision on a synced row is never changed by a sync, and is used as it was', async () => {
  const menu = [menuOf(item('i', 'Caesar Salad', [size('x1', 'Regular')]))];
  const p = await pipeline({ menus: [menu, menu], ours: [{ id: 'm-cr', name: 'Caesar Salad Regular' }, { id: 'm-other', name: 'Other' }],
    after: [(sb) => itemsSave(sb, row(sb, K('Caesar Salad', 'Regular')), { menuItemId: 'm-other' })],
    lines: [line('Caesar Salad', 'x1', 'Regular')] });
  const r = p.row(K('Caesar Salad', 'Regular'));
  assert.equal(r.menu_item_id, 'm-other', 'the person chose a different item: sync 2 never moves it back');
  assert.equal(r.source, 'manual');
  assert.equal(r.decided_as, 'Caesar Salad Regular');
  assert.equal(p.plans[1].redecides.length, 0);
  assert.equal(p.plans[1].counts.lookAgain, 0);
  assert.equal(p.out[0].itemId, 'm-other');
  assert.equal(p.queued[0].itemId, 'm-other');
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
  assert.equal(links(sb).filter((r) => isSyncedRow(r)).length, 11, 'every item, size and option exactly once');
  assert.equal(links(sb).length, 12, 'and the row saved before the sync, untouched');
  const old = row(sb, 'farmhouse salad');
  assert.deepEqual([old.menu_item_id, old.source, old.seen_count, old.ez_ids], [null, 'manual', 4, []], 'a row saved before the sync is never written');
  const salad = row(sb, K('Farmhouse Salad', 'Serves 1'));
  assert.deepEqual(salad.ez_ids.sort(), ['s-salad', 's-salad-2']);
  assert.equal(salad.source, 'auto', 'a staff clear is not a decision to carry');

  // Staff decide two rows between the syncs.
  itemsSave(sb, row(sb, K('A Wreck', 'Skinny')), { menuItemId: 'm-wreck-orig' }, 'user-7');
  itemsSave(sb, row(sb, K('A Wreck', 'Bigs')), { ignored: true }, 'user-7');
  // ezCater republishes: new published ids.
  const repub = JSON.parse(JSON.stringify(POTBELLY));
  repub.categories[0].items[0].sizes[2].id = 's-wreck-skinny-v2';
  const second = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([repub, LUNCH]), nowMs: NOW_MS + 60_000 });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.counts.inserted, 0, 'nothing new on the second sync');
  assert.equal(second.counts.lookAgain, 0, 'the staff decisions were made for these exact names');
  assert.equal(links(sb).length, 12, 'no duplicates');
  const skinny = row(sb, K('A Wreck', 'Skinny'));
  assert.equal(skinny.menu_item_id, 'm-wreck-orig', 'the staff match is kept');
  assert.equal(skinny.matched_by, 'user-7');
  assert.deepEqual(skinny.ez_ids, ['s-wreck-skinny-v2', 's-wreck-skinny'], 'the same exact name: the new published id first, the old one kept');
  const big = row(sb, K('A Wreck', 'Bigs'));
  assert.equal(big.matched_by, 'ignored', '"Not on our menu" is kept');
  assert.equal(big.menu_item_id, null);
  // A second identical sync writes no decision at all.
  const third = await runMenuSync(sb, LOC, { reason: 'daily', makeAsk: () => fakeAsk([repub, LUNCH]), nowMs: NOW_MS + 120_000 });
  assert.equal(third.counts.redecided, 0);
  assert.equal(third.counts.inserted, 0);
});

test('the sync message says what changed, in plain words', async () => {
  const sb = fakeSb({ ...TABLES([
    // An exact link our renamed item no longer matches: taken off.
    { location_id: LOC, kind: 'item', ez_key: K('Caesar Salad', 'Regular'), ez_name: 'Caesar Salad', ez_only_size: 'Regular', ez_ids: ['c-reg'], synced_at: NOW,
      menu_item_id: 'm-cr', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 },
    // Staff matches saved before the sync: one made for exactly the name ezCater sells, one not.
    { location_id: LOC, kind: 'item', ez_key: 'turkey sandwich', ez_name: 'Turkey Sandwich', menu_item_id: 'm-t', option_id: null, source: 'manual', matched_by: 'u', seen_count: 0 },
    { location_id: LOC, kind: 'item', ez_key: 'brownie', ez_name: 'Brownie', menu_item_id: 'm-b', option_id: null, source: 'manual', matched_by: 'u', seen_count: 0 },
  ]), menu_items: [{ id: 'm-cr', name: 'Old Caesar', location_id: LOC }, { id: 'm-t', name: 'Turkey Sandwich', location_id: LOC }, { id: 'm-b', name: 'Brownie', location_id: LOC }] });
  const menu = { id: 'menu-9', name: 'M', startDate: null, endDate: null, categories: [{ id: 'c', name: 'C', items: [
    item('i-c', 'Caesar Salad', [size('c-reg', 'Regular')]), item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]),
    item('i-b', 'Brownie', [size('b-1', '')]), item('i-x', 'Cookies', [size('x1', 'Dozen'), size('x2', 'dozen')]),
  ] }] };
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([menu]), nowMs: NOW_MS });
  assert.equal(r.status, 'ok', r.message);
  assert.match(r.message, /1 of your earlier matches kept/);
  assert.match(r.message, /1 automatic match taken off because the names no longer match exactly/);
  assert.match(r.message, /1 of your matches to check again: the ezCater name is not the one you matched, so those print by name until you press Still right or Change/);
  assert.match(r.message, /2 sizes with the same name as another size of the same item, so they print by name \(give each size its own name on ezCater\): Cookies \(Dozen\); Cookies \(dozen\)/);
  assert.equal(r.counts.sameName, 2);
  assert.doesNotMatch(r.message, /[\u2013\u2014]/);
});

test('a partial read never takes a live id away', async () => {
  const sb = fakeSb(TABLES([
    { location_id: LOC, kind: 'item', ez_key: K('Farmhouse Salad', 'Serves 1'), ez_name: 'Farmhouse Salad', ez_only_size: 'Serves 1', synced_at: NOW,
      menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0, ez_ids: ['s-salad-old'] },
  ]));
  sb.store.ezcater_caterers.push({ caterer_uuid: 'cat-2', connection_id: 'conn-1', location_id: LOC, active: true });
  const ask = async (op, q, vars) => {
    if (vars.catererId === 'cat-2') throw new Error('network down');
    return fakeAsk([POTBELLY])(op, q, vars);
  };
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => ask, nowMs: NOW_MS });
  assert.equal(r.status, 'partial');
  assert.deepEqual(row(sb, K('Farmhouse Salad', 'Serves 1')).ez_ids.sort(), ['s-salad', 's-salad-old']);
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

test('an ok sync stamps last_ok_at with its own synced_at, so the card can tell which names it did not write', async () => {
  const patches = [];
  const sb = { from: () => { const b = { update(p) { patches.push(p); return b; }, eq() { return b; }, then(ok) { return Promise.resolve({ data: null, error: null }).then(ok); } }; return b; } };
  await finishSync(sb, LOC, 'claim-1', 'ok', {}, null, NOW);
  await finishSync(sb, LOC, 'claim-1', 'partial', {}, 'x', NOW);
  assert.equal(patches[0].last_ok_at, NOW);
  assert.equal('last_ok_at' in patches[1], false, 'only an ok sync moves last_ok_at');
  assert.match(read('../../supabase/functions/_shared/ezcaterMenuSyncRun.ts'),
    /await finishSync\(sb, locationId, claim as string, status, counts, problems\.length \? problems\.join\('; '\)\.slice\(0, 1000\) : null, nowIso\);/);
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
    many.push({ location_id: LOC, kind: 'item', ez_key: 'exact:item ' + String(i).padStart(5, '0'), ez_name: 'Item ' + String(i).padStart(5, '0'), synced_at: NOW,
      menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0, ez_ids: ['id-' + i], ez_size_name: null });
  }
  many.push({ ...many[0], ez_key: K('A Wreck', 'Bigs'), ez_name: 'A Wreck', ez_size_name: 'Bigs', ez_ids: ['s-wreck-big'], menu_item_id: 'm-wreck-big', matched_by: 'exact' });
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
  assert.equal(before.linksFailed, false);
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
    many.push({ location_id: LOC, kind: 'item', ez_key: 'exact:item ' + String(i).padStart(5, '0'), ez_name: 'Item ' + i, synced_at: NOW,
      menu_item_id: null, option_id: null, source: 'auto', matched_by: null, seen_count: 0, ez_ids: ['id-' + i], ez_size_name: null });
  }
  const orderRow = { ref: 'EZ-2', customer: {}, items: [line('Chicken Salad Small', null, null), line('A Wreck Original', 's-anything', 'Original')] };
  const sb = fakeSb(TABLES(many.map((r) => ({ ...r }))), { failLinkPageFrom: 1000 });
  const input = await readMatchInputs(sb, LOC);
  assert.equal(input.linksFailed, true);
  const before = JSON.stringify(links(sb));
  const out = await matchQueueRow(sb, LOC, orderRow, { nowIso: NOW, budgetMs: 0 });
  assert.equal(out.ran, false);
  assert.equal(out.row, orderRow, 'the order goes through exactly as ezCater sent it (it carried no id of its own)');
  assert.equal(JSON.stringify(links(sb)), before, 'nothing written');
  assert.ok(!sb.calls.some((c) => (c.op === 'upsert' || c.op === 'update') && c.table === 'ezcater_item_links'));
  assert.equal((await readMatchInputs(fakeSb(TABLES()), LOC, { deadline: 0 })).linksFailed, true);
});

test('RULE D: a republish keeps the old size id while the name is the same, so a change to an older order still matches', async () => {
  const sb = fakeSb(TABLES());
  const first = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => fakeAsk([POTBELLY]), nowMs: NOW_MS });
  assert.equal(first.ok, true, first.message);
  const repub = JSON.parse(JSON.stringify(POTBELLY));
  for (const c of repub.categories) for (const it of c.items) for (const z of it.sizes) z.id = z.id + '-v2';
  const second = await runMenuSync(sb, LOC, { reason: 'daily', makeAsk: () => fakeAsk([repub]), nowMs: NOW_MS + 86_400_000 });
  assert.equal(second.status, 'ok');
  assert.deepEqual(row(sb, K('A Wreck', 'Bigs')).ez_ids, ['s-wreck-big-v2', 's-wreck-big'], 'unioned: the same exact name');
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
    { location_id: LOC, kind: 'item', ez_key: K('Farmhouse Salad', 'Serves 1'), ez_name: 'Farmhouse Salad', ez_only_size: 'Serves 1', synced_at: NOW,
      menu_item_id: 'm-salad', option_id: null, source: 'manual', matched_by: 'u', decided_as: 'Farmhouse Salad Serves 1', seen_count: 2, ez_ids: ['s-salad-lunch'] },
  ]));
  const r = await runMenuSync(sb, LOC, { reason: 'staff', makeAsk: () => ask, nowMs: NOW_MS });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'partial');
  assert.match(r.message, /no menu for 1 current menu/);
  assert.deepEqual(row(sb, K('Farmhouse Salad', 'Serves 1')).ez_ids.sort(), ['s-salad', 's-salad-lunch'], 'nothing taken away');
  assert.equal(row(sb, K('Farmhouse Salad', 'Serves 1')).menu_item_id, 'm-salad');
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

  const staff = { location_id: LOC, kind: 'item', ez_key: K('Farmhouse Salad', 'Serves 1'), ez_name: 'Farmhouse Salad', ez_group: null, ez_only_size: 'Serves 1',
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
  assert.equal(row(sb, K('Farmhouse Salad', 'Serves 1')).source, 'manual');
  assert.equal(row(sb, K('Farmhouse Salad', 'Serves 1')).menu_item_id, 'm-salad');
  assert.deepEqual(row(sb, K('Farmhouse Salad', 'Serves 1')).ez_ids, ['s-salad', 's-old']);
  assert.equal(notNullError(now, plan.inserts), null, 'sync inserts');
  // The order time sighting inserts (before the migration only, now) pass both schemas too.
  const lp = planLineMatches({ lines: [line('Chicken Salad Small', null, null), line('Something New', null, null)],
    ourItems: OUR_ITEMS, ourGroups: OUR_GROUPS, links: [], locationId: LOC, nowIso: NOW });
  assert.ok(lp.writes.length >= 1);
  assert.equal(notNullError(now, lp.writes), null);
  assert.equal(notNullError(before, lp.writes), null);
});

// ── RULE E: exact by construction (review round 4) ─────────────────────────────────────────
// The round 3 reviewer reproduced each of these on the folded keys (zz_repro.test.js). They run
// here end to end: flattenMenus, planMenuSync, writeSyncPlan, readMatchInputs, planLineMatches,
// saveLinkWrites and matchQueueRow. A line with only the id and no name ('x', as the repro sent
// it) never routes at all now: the exact name is part of the rule.

test('RULE E (round 3 repro S1): a staff match on the Large tray never covers the Small tray', async () => {
  const menu = [menuOf(item('l', 'Sandwich Platter (Large)', [size('sL', 'Tray')]), item('s', 'Sandwich Platter (Small)', [size('sS', 'Tray')]))];
  const ours = [{ id: 'our-large', name: 'Sandwich Platter (Large)' }, { id: 'our-small', name: 'Sandwich Platter (Small)' }];
  const p = await pipeline({ menus: [menu, menu], ours,
    after: [(sb) => itemsSave(sb, row(sb, K('Sandwich Platter (Large)', 'Tray')), { menuItemId: 'our-large' })],
    lines: [line('Sandwich Platter (Large)', 'sL', 'Tray'), line('Sandwich Platter (Small)', 'sS', 'Tray'),
      line('x', 'sS', null), line('Sandwich Platter (Large)', 'sS', 'Tray')] });
  assert.equal(p.plans[0].inserts.length, 2, 'two products, two rows');
  assert.deepEqual(p.row(K('Sandwich Platter (Large)', 'Tray')).ez_ids, ['sL']);
  assert.deepEqual(p.row(K('Sandwich Platter (Small)', 'Tray')).ez_ids, ['sS']);
  assert.equal(p.row(K('Sandwich Platter (Large)', 'Tray')).decided_as, 'Sandwich Platter (Large) Tray');
  assert.deepEqual(p.out.map((l) => l.itemId), ['our-large', null, null, null]);
  assert.deepEqual(p.queued.map((l) => l.itemId), ['our-large', null, null, null]);
});

test('RULE E (round 3 repro S2, S2b): when a twin leaves the menu, its leftover id never routes to our plain item', async () => {
  const A = item('a', 'Sandwich Platter', [size('sA', 'Box')]);
  const B = item('b', 'Sandwich Platter Tray', [size('sB', 'Box')]);
  const ours = [{ id: 'our-plat', name: 'Sandwich Platter' }, { id: 'our-box', name: 'Sandwich Platter Box' }];
  const p = await pipeline({ menus: [[menuOf(A), { ...menuOf(B), id: 'm-2' }], [menuOf(A)]], ours,
    lines: [line('Sandwich Platter Tray', 'sB', 'Box'), line('Sandwich Platter', 'sA', 'Box'), line('x', 'sB', null)] });
  assert.deepEqual(p.row(K('Sandwich Platter', 'Box')).ez_ids, ['sA'], 'never the Tray id');
  assert.equal(p.row(K('Sandwich Platter', 'Box')).menu_item_id, 'our-box', 'exactly our Sandwich Platter Box');
  assert.equal(p.row(K('Sandwich Platter Tray', 'Box')).menu_item_id, null);
  assert.deepEqual(p.out.map((l) => l.itemId), [null, 'our-box', null]);
  assert.deepEqual(p.queued.map((l) => l.itemId), [null, 'our-box', null]);
  // S2b: "Caesar Salad" and "Caesar Salad (Serves 20)" sold as a Tray, then the Serves 20 leaves.
  const C = item('c', 'Caesar Salad', [size('sC', '')]);
  const D = item('d', 'Caesar Salad (Serves 20)', [size('sD', 'Tray')]);
  const q = await pipeline({ menus: [[menuOf(C, D)], [menuOf(C)]], ours: [{ id: 'our-cs', name: 'Caesar Salad' }],
    lines: [line('Caesar Salad (Serves 20)', 'sD', 'Tray'), line('Caesar Salad', 'sC', null), line('x', 'sD', null)] });
  assert.deepEqual(q.row(K('Caesar Salad')).ez_ids, ['sC']);
  assert.equal(q.row(K('Caesar Salad')).menu_item_id, 'our-cs');
  assert.equal(q.row(K('Caesar Salad (Serves 20)', 'Tray')).menu_item_id, null);
  assert.deepEqual(q.out.map((l) => l.itemId), [null, 'our-cs', null]);
  assert.deepEqual(q.queued.map((l) => l.itemId), [null, 'our-cs', null]);
});

test('RULE E (round 3 repro S3): our menu read in part, then a product the old keys folded in: its own row, and no link', async () => {
  const t = TABLES();
  t.menu_items = [{ id: 'our-plat', name: 'Sandwich Platter', location_id: LOC, archived: false }];
  const sb = fakeSb(t);
  await syncOnce(sb, [menuOf(item('a', 'Sandwich Platter', [size('sA', '')]))]);
  assert.equal(row(sb, K('Sandwich Platter')).menu_item_id, 'our-plat');
  const input = await readMatchInputs(sb, LOC);
  const plan = planMenuSync({ entries: flattenMenus([menuOf(item('a', 'Sandwich Platter', [size('sA', '')]), item('b', 'Sandwich Platter Tray', [size('sB', '')]))]),
    existing: input.links, ourItems: input.ourItems, ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: false });
  assert.deepEqual((await writeSyncPlan(sb, LOC, plan, NOW)).errors, []);
  assert.deepEqual(row(sb, K('Sandwich Platter')).ez_ids, ['sA'], 'the plain row never takes the Tray id');
  assert.equal(row(sb, K('Sandwich Platter')).menu_item_id, 'our-plat', 'and keeps its own exact link');
  assert.equal(row(sb, K('Sandwich Platter Tray')).menu_item_id, null);
  const lp = await orderThrough(sb, [line('Sandwich Platter Tray', 'sB', null), line('Sandwich Platter', 'sA', null)]);
  assert.deepEqual(lp.lines.map((l) => l.itemId), [null, 'our-plat']);
});

test('RULE E (round 3 repro S4): a size renamed in place keeps its id; the new name routes nothing until the next sync, then only its own match', async () => {
  const ours = [{ id: 'our-reg', name: 'Caesar Salad Regular' }, { id: 'our-lg', name: 'Caesar Salad Large' }];
  const v1 = [menuOf(item('c', 'Caesar Salad', [size('s1', 'Regular')]))];
  const v2 = [menuOf(item('c', 'Caesar Salad', [size('s1', 'Large')]))];
  const lines = [line('Caesar Salad', 's1', 'Large'), line('Caesar Salad', 's1', 'Regular')];
  const early = await pipeline({ menus: [v1], ours, lines });
  assert.deepEqual(early.out.map((l) => l.itemId), [null, 'our-reg'], 'before the next sync the new name has no row: it prints by name');
  assert.deepEqual(early.queued.map((l) => l.itemId), [null, 'our-reg']);
  const later = await pipeline({ menus: [v1, v2], ours, lines });
  assert.deepEqual(later.out.map((l) => l.itemId), ['our-lg', 'our-reg'], 'each name to its own exact match; an old Regular line stays Regular');
  assert.deepEqual(later.queued.map((l) => l.itemId), ['our-lg', 'our-reg']);
  assert.deepEqual(later.row(K('Caesar Salad', 'Large')).ez_ids, ['s1']);
  assert.deepEqual(later.row(K('Caesar Salad', 'Regular')).ez_ids, ['s1']);
});

test('RULE E (round 3 repro): sizes with no name never share a row across items, and two of one item get none', async () => {
  const menu = [menuOf(item('x', 'X', [size('u1', ''), size('u2', '')]), item('y', 'X (Serves 10)', [size('v1', ''), size('v2', 'Large')]))];
  const { entries, notes } = flattenMenusWithNotes(menu);
  assert.deepEqual(entries.map((e) => [e.ezKey, e.ids, e.noAuto]), [[K('X (Serves 10)'), ['v1'], true], [K('X (Serves 10)', 'Large'), ['v2'], false]]);
  assert.deepEqual(notes.sameName, ['X (no size name)', 'X (no size name)']);
  const p = await pipeline({ menus: [menu], ours: [{ id: 'our-x', name: 'X' }, { id: 'our-x10', name: 'X (Serves 10)' }],
    after: [(sb) => itemsSave(sb, row(sb, K('X (Serves 10)')), { menuItemId: 'our-x10' })],
    lines: [line('X', 'u1', null), line('X', 'u2', null), line('X (Serves 10)', 'v1', null), line('X (Serves 10)', 'v2', 'Large'), line('X', 'v1', null)] });
  assert.deepEqual(p.out.map((l) => l.itemId), [null, null, 'our-x10', null, null]);
  assert.deepEqual(p.queued.map((l) => l.itemId), [null, null, 'our-x10', null, null]);
});

test('RULE E (round 3 repro): option values the old keys folded together are separate rows with separate decisions', async () => {
  const menu = [menuOf(item('s', 'Sub', [size('s-sub', '', { customizationTypes: [
    { id: 't1', name: 'Bread', values: [{ id: 'v-w', name: 'White' }, { id: 'v-wl', name: 'White (Large)' }] },
    { id: 't2', name: 'Bread Size', values: [{ id: 'v-bs', name: 'White' }] },
  ] })]))];
  const opt = flattenMenus(menu).filter((e) => e.kind === 'option');
  assert.deepEqual(opt.map((e) => e.ezKey), [OK('Sub', 'Bread', 'White'), OK('Sub', 'Bread', 'White (Large)'), OK('Sub', 'Bread Size', 'White')]);
  const lines = orderItemsToLines([{ uuid: 'o1', name: 'Sub', menuItemSizeId: 's-sub', menuItemSizeName: null, quantity: 1, customizations: [
    { customizationId: 'v-w', customizationTypeName: 'Bread', name: 'White', quantity: 1 },
    { customizationId: 'v-wl', customizationTypeName: 'Bread', name: 'White (Large)', quantity: 1 },
    { customizationId: 'v-bs', customizationTypeName: 'Bread Size', name: 'White', quantity: 1 },
    { customizationId: 'v-bs', customizationTypeName: 'Bread', name: 'White', quantity: 1 },
  ] }]);
  const groups = [{ id: 'g', name: 'Bread', options: [{ id: 'o-white', name: 'White' }] }];
  const auto = await pipeline({ menus: [menu], ours: [{ id: 'm-sub', name: 'Sub' }], groups, lines });
  assert.equal(auto.out[0].itemId, 'm-sub');
  assert.deepEqual(auto.out[0].mods.map((m) => m.optionId), [null, null, null, null], 'round 6: no option is auto linked');
  const p = await pipeline({ menus: [menu], ours: [{ id: 'm-sub', name: 'Sub' }], groups, lines,
    after: [(sb) => { itemsSave(sb, row(sb, OK('Sub', 'Bread', 'White')), { optionId: 'o-white' }); }] });
  assert.deepEqual(p.out[0].mods.map((m) => m.optionId), ['o-white', null, null, null]);
  assert.deepEqual(p.queued[0].mods.map((m) => m.optionId), ['o-white', null, null, null]);
});

test('RULE E (III): a moved decision is written with its ids in ONE statement, so a failed refresh can never leave it next to old ids', async () => {
  // Round 3 reproduced on Postgres: the re-decide landed, the refresh failed, and an old line routed
  // to the new target. Here our Brownie is renamed so the link moves; every refresh upsert fails.
  const sb = fakeSb({ ...TABLES([
    { location_id: LOC, kind: 'item', ez_key: K('Brownie'), ez_name: 'Brownie', ez_ids: ['br-1'], synced_at: '2026-09-17T00:00:00.000Z',
      menu_item_id: 'm-br-old', option_id: null, source: 'auto', matched_by: 'exact', seen_count: 0 },
    { location_id: LOC, kind: 'item', ez_key: K('Cookie'), ez_name: 'Cookie', ez_ids: ['co-1'], synced_at: '2026-09-17T00:00:00.000Z',
      menu_item_id: 'm-co', option_id: null, source: 'manual', matched_by: 'u', decided_as: 'Cookie', seen_count: 0 },
  ]), menu_items: [{ id: 'm-br-old', name: 'Old Brownie', location_id: LOC }, { id: 'm-br', name: 'Brownie', location_id: LOC }, { id: 'm-co', name: 'Cookie', location_id: LOC }] },
  { failUpsert: (name, rows, o) => (name === 'ezcater_item_links' && !o?.ignoreDuplicates ? { code: '57014', message: 'statement timeout' } : null) });
  const input = await readMatchInputs(sb, LOC);
  const plan = planMenuSync({ entries: flattenMenus([menuOf(item('b', 'Brownie', [size('br-2', '')]), item('c', 'Cookie', [size('co-2', '')]))]),
    existing: input.links, ourItems: input.ourItems, ourGroups: input.ourGroups, locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  const wrote = await writeSyncPlan(sb, LOC, plan, NOW);
  const decide = sb.calls.filter((c) => c.op === 'update' && c.table === 'ezcater_item_links');
  assert.equal(decide.length, 1);
  assert.deepEqual(Object.keys(decide[0].patch).sort(), ['ez_category', 'ez_group', 'ez_ids', 'ez_item_name', 'ez_name', 'ez_only_size', 'ez_size_name',
    'matched_by', 'menu_item_id', 'option_id', 'synced_at', 'updated_at']);
  assert.deepEqual([decide[0].patch.menu_item_id, decide[0].patch.ez_ids], ['m-br', ['br-2', 'br-1']], 'the new target and the new ids, one statement');
  assert.equal(wrote.redecided, 1);
  assert.ok(wrote.errors.some((e) => /^refresh: statement timeout/.test(e)), 'the refresh of the other row failed');
  const refreshed = sb.calls.filter((c) => c.op === 'upsert' && !c.ignore).flatMap((c) => c.keys);
  assert.deepEqual(refreshed, [K('Cookie')], 'the moved row was never left to the refresh');
  const br = row(sb, K('Brownie'));
  assert.deepEqual([br.menu_item_id, br.ez_ids, br.synced_at], ['m-br', ['br-2', 'br-1'], NOW], 'decision and ids agree');
  const co = row(sb, K('Cookie'));
  assert.deepEqual([co.menu_item_id, co.ez_ids], ['m-co', ['co-1']], 'a failed refresh leaves a row as it was');
  const lp = await orderThrough(sb, [line('Brownie', 'br-2', null), line('Brownie', 'br-1', null), line('Cookie', 'co-1', null), line('Cookie', 'co-2', null)]);
  assert.deepEqual(lp.lines.map((l) => l.itemId), ['m-br', 'm-br', 'm-co', null]);
});

test('RULE E (IV): every bail path after the migration takes ezCater\'s own ids off; before it (proven) the row is untouched', async () => {
  const withPos = () => ({ ref: 'EZ-9', customer: {}, items: [
    line('A Wreck', 's-wreck-big', 'Bigs', { itemId: 'pos-1', mods: [{ label: 'Multigrain', groupLabel: 'Bread', itemId: 'pos-opt', ezItemId: 'v-multi' }] }),
    line('Brownie', null, null),
  ] });
  const cleared = (out) => out.row.items.every((l) => l.itemId === null && (l.mods || []).every((m) => m.itemId === null));
  const timeout = { code: '57014', message: 'canceling statement due to statement timeout' };
  const many = [];
  for (let i = 0; i < 1500; i++) many.push({ location_id: LOC, kind: 'item', ez_key: 'exact:n ' + i, ez_name: 'N ' + i, synced_at: NOW, source: 'auto', ez_ids: [], seen_count: 0 });
  const cases = [
    ['the link read cut short (after the migration)', fakeSb(TABLES(many), { failLinkPageFrom: 1000 }), {}],
    ['the link read failed (not proven either way)', fakeSb(TABLES(), { failLinkRead: () => timeout }), {}],
    ['neither the links nor the menu read', fakeSb(TABLES(), { failLinkRead: () => timeout, failTable: { menu_items: timeout, modifier_groups: timeout } }), {}],
    ['past the time budget', { from: () => { const b = { select: () => b, eq: () => b, order: () => b, range: () => b, then: () => new Promise(() => {}) }; return b; } }, { budgetMs: 25 }],
    ['an exception inside the job', fakeSb(TABLES()), { get nowIso() { throw new Error('boom'); }, budgetMs: 0 }],
  ];
  for (const [name, sb, opts] of cases) {
    const input = withPos();
    const out = await matchQueueRow(sb, LOC, input, opts);
    assert.equal(out.ran, false, name);
    assert.ok(cleared(out), name + ': no posItemId or posCustomizationId left');
    assert.equal(out.row.customer.ezMatch, undefined, name + ': never stamped as checked');
    assert.equal(out.row.items[0].name, 'A Wreck', name);
    assert.equal(input.items[0].itemId, 'pos-1', name + ': the mapper row itself is not changed');
  }
  // Before the migration (PROVEN by the missing column), the same failure leaves the row exactly as the mapper built it.
  const pre = fakeSb(TABLES(), { noSyncColumns: true, failLinkRead: (cols) => (/ez_ids/.test(cols) ? null : timeout),
    failTable: { menu_items: timeout, modifier_groups: timeout } });
  const preRow = withPos();
  const preOut = await matchQueueRow(pre, LOC, preRow, { nowIso: NOW, budgetMs: 0 });
  assert.equal(preOut.ran, false);
  assert.equal(preOut.row, preRow, 'main: the mapper row, untouched');
  // The planner's own failed read path clears them too, and nothing to clear is the same row.
  assert.deepEqual(planLineMatches({ lines: withPos().items, linksFailed: true, locationId: LOC, nowIso: NOW }).lines.map((l) => l.itemId), [null, null]);
  const plain = { ref: 'EZ-0', items: [line('Brownie', null, null)] };
  assert.equal(withoutPosIds(plain), plain);
  assert.equal(linesWithoutPosIds(plain.items), plain.items);
  assert.equal(withoutPosIds(null), null);
});

test('RULE E (IV): before the migration, a failed second link read falls back exactly as main does: the name rules on the menu, nothing written', async () => {
  const sb = fakeSb(TABLES([{ location_id: LOC, kind: 'item', ez_key: 'a wreck', ez_name: 'A Wreck', menu_item_id: 'm-wreck-orig', option_id: null,
    source: 'manual', matched_by: 'u', seen_count: 2 }]),
  { noSyncColumns: true, failLinkRead: (cols) => (/ez_ids/.test(cols) ? null : { code: '57014', message: 'canceling statement due to statement timeout' }) });
  const input = await readMatchInputs(sb, LOC);
  assert.deepEqual([input.sizeIds, input.linksFailed, input.linksOk, input.links.length, input.menuOk], [false, false, false, 0, true]);
  const orderRow = { ref: 'EZ-3', customer: {}, items: [line('Chicken Salad Small', null, null), line('A Wreck Original', null, null), line('Brand New', null, null)] };
  const out = await matchQueueRow(sb, LOC, orderRow, { nowIso: NOW, budgetMs: 0 });
  assert.equal(out.ran, true);
  assert.deepEqual(out.row.items.map((l) => l.itemId), ['m-chick-small', 'm-wreck-orig', null], 'main\'s name rules on the menu');
  assert.equal(out.inserted + out.bumped, 0);
  assert.ok(!sb.calls.some((c) => (c.op === 'upsert' || c.op === 'update') && c.table === 'ezcater_item_links'), 'nothing written, as main after a failed link read');
  const main = planNameMatches({ lines: orderRow.items, ourItems: input.ourItems, ourGroups: input.ourGroups, links: [], locationId: LOC, nowIso: NOW, menuOk: true });
  assert.deepEqual(out.row.items.map((l) => l.itemId), main.lines.map((l) => l.itemId));
  // A second read cut short by the time budget is not a failed read. The first read already
  // PROVED the venue is before the migration, so the order goes through exactly as the mapper
  // built it, ezCater's own ids and all, as main's own time budget does.
  const fullPage = Array.from({ length: 1000 }, (_, i) => ({ kind: 'item', ez_key: 'k' + i, ez_name: 'K' + i, source: 'auto', seen_count: 0 }));
  const slowSecond = { from: (name) => {
    const st = { cols: '' };
    const b = { select(c) { st.cols = c; return b; }, eq() { return b; }, order() { return b; }, range() { return b; },
      then(ok, no) {
        if (name !== 'ezcater_item_links') return Promise.resolve({ data: name === 'menu_items' ? MENU_ROWS : GROUP_ROWS, error: null }).then(ok, no);
        if (/ez_ids/.test(st.cols)) return Promise.resolve({ data: null, error: { code: '42703', message: 'column ezcater_item_links.ez_ids does not exist' } }).then(ok, no);
        return new Promise((r) => setTimeout(() => r({ data: fullPage, error: null }), 250)).then(ok, no);
      } };
    return b;
  } };
  const cut = await readMatchInputs(slowSecond, LOC, { deadline: Date.now() + 150 });
  assert.deepEqual([cut.sizeIds, cut.linksFailed, cut.linksOk, cut.links.length], [false, true, false, 1000]);
  const posRow = { ref: 'EZ-4', customer: {}, items: [line('Chicken Salad Small', null, null, { itemId: 'pos-9' })] };
  const timed = await matchQueueRow(slowSecond, LOC, posRow, { nowIso: NOW, budgetMs: 150 });
  assert.equal(timed.ran, false);
  assert.equal(timed.row, posRow, 'proven before the migration: untouched, even when the job runs out of time');
});

test('RULE E: a staff decision saved before the sync is carried to the synced row of its product: as it was when the exact names agree, else to check again', async () => {
  const legacy = [
    // The screen showed "Turkey Sandwich"; ezCater sells it only as a Box.
    { kind: 'item', ez_key: 'turkey sandwich', ez_name: 'Turkey Sandwich', ez_group: null, menu_item_id: 'm-t', option_id: null, source: 'manual', matched_by: 'user-3', seen_count: 5, last_seen_at: NOW },
    // Matched under exactly the name ezCater sells ("Serves 1" is noise to the old key, not to the name).
    { kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad Serves 1', menu_item_id: 'm-f', option_id: null, source: 'manual', matched_by: 'user-4', seen_count: 2 },
    // "Not on our menu" on an option.
    { kind: 'option', ez_key: buildLinkKey({ name: 'White', groupLabel: 'Bread' }, 'option'), ez_name: 'White', ez_group: 'Bread', menu_item_id: null, option_id: null, source: 'manual', matched_by: 'ignored', seen_count: 1 },
    // An automatic name link from before: not carried; the exact rule decides the new row.
    { kind: 'item', ez_key: 'italian boxed lunch', ez_name: 'Italian Boxed Lunch', menu_item_id: 'm-ibl-old', option_id: null, source: 'auto', matched_by: 'name', seen_count: 1 },
  ];
  const menu = menuOf(item('i-t', 'Turkey Sandwich', [size('t-box', 'Box')]),
    item('i-f', 'Farmhouse Salad', [size('s-f', 'Serves 1', { customizationTypes: [{ id: 'ct', name: 'Bread', values: [{ id: 'v-w', name: 'White' }] }] })]),
    item('i-hk', 'Italian Boxed Lunch', [size(HKX77V_SIZE_ID, 'Box')]));
  const lines = [line('Turkey Sandwich', 't-box', 'Box'), line('Farmhouse Salad', 's-f', 'Serves 1', { mods: [{ label: 'White', groupLabel: 'Bread', ezItemId: 'v-w', itemId: null }] }),
    line('Italian Boxed Lunch', HKX77V_SIZE_ID, 'Box')];
  const p = await pipeline({ menus: [[menu]], existing: legacy, lines,
    ours: [{ id: 'm-t', name: 'Turkey Sandwich' }, { id: 'm-f', name: 'Farmhouse' }, { id: 'm-ibl', name: 'Italian Boxed Lunch' }, { id: 'm-ibl-old', name: 'IBL' }],
    groups: [{ id: 'g', name: 'Bread', options: [{ id: 'o-w', name: 'White' }] }] });
  const turkey = p.row(K('Turkey Sandwich', 'Box'));
  assert.deepEqual([turkey.menu_item_id, turkey.source, turkey.matched_by, turkey.decided_as], ['m-t', 'manual', 'user-3', 'Turkey Sandwich']);
  assert.equal(lookAgainOf(turkey).lookAgain, true, 'never matched knowing it is a Box');
  const farm = p.row(K('Farmhouse Salad', 'Serves 1'));
  assert.deepEqual([farm.menu_item_id, farm.decided_as, lookAgainOf(farm).lookAgain], ['m-f', 'Farmhouse Salad Serves 1', false], 'the exact name: kept as it was');
  const white = p.row(OK('Farmhouse Salad', 'Bread', 'White'));
  assert.deepEqual([white.matched_by, white.source, lookAgainOf(white).lookAgain], ['ignored', 'manual', false]);
  assert.deepEqual([p.row(K('Italian Boxed Lunch', 'Box')).menu_item_id, p.row(K('Italian Boxed Lunch', 'Box')).source], ['m-ibl', 'auto']);
  assert.deepEqual([p.plans[0].counts.carried, p.plans[0].counts.lookAgain], [2, 1]);
  assert.deepEqual(p.out.map((l) => l.itemId), [null, 'm-f', 'm-ibl'], 'a match to check again is not used until checked');
  assert.deepEqual(p.queued.map((l) => l.itemId), [null, 'm-f', 'm-ibl']);
  assert.equal(p.out[1].mods[0].optionId, null);
  // The rows saved before the sync are exactly as they were, and readable on the card.
  for (const old of legacy) assert.deepEqual(omit(p.row(old.ez_key), COUNTERS), omit({ location_id: LOC, ...old }, COUNTERS));
  // The card flags the Turkey row, saying what was matched; "Still right" records the synced name.
  const shown = rowsFrom(links(p.sb).map((r) => ({ ...r, look_again: lookAgainOf(r).lookAgain })), { syncReady: true });
  const t = shown.find((r) => r.ezKey === K('Turkey Sandwich', 'Box'));
  assert.equal(t.lookAgain, true);
  assert.equal(lookAgainNote(t), 'The ezCater name is not the one that was matched. It was matched as: Turkey Sandwich. Orders print it by name until you check it.');
  itemsSave(p.sb, turkey, { menuItemId: 'm-t' });
  assert.equal(p.row(K('Turkey Sandwich', 'Box')).decided_as, 'Turkey Sandwich Box');
  assert.equal((await orderThrough(p.sb, [lines[0]])).lines[0].itemId, 'm-t', 'routes once checked');
  // Where it looked: the name with its size first, then the name alone, today's key then the legacy one.
  assert.deepEqual(oldKeysOf({ kind: 'item', ezName: 'Caesar Salad', ezSizeName: 'Large', ids: [] }), ['caesar salad large', 'caesar salad']);
  assert.equal(carryOverFor({ kind: 'item', ezKey: K('Brownie'), ezName: 'Brownie', ezSizeName: null, ids: [] }, new Map()), null);
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
  assert.equal(p.out[0].mods[0].optionId, null, 'Bread: Multigrain is exact, but options are for staff to match (round 6)');
  assert.equal(p.out[2].mods[0].optionId, null, 'Bread: White is not on our menu');
  assert.equal(p.plans[1].counts.inserted, 0, 'the second sync inserts nothing');
  assert.equal(p.plans[1].counts.redecided, 0, 'and changes no decision');
  assert.equal(p.lp.writes.length + p.lp.upgrades.length, 0, 'the order wrote no link');
  assert.deepEqual(p.after, p.before);
  assert.equal(p.ran, true);
});

// ── The Item matching card ─────────────────────────────────────────────────────────────────

test('a size row shows its size, suggests on item and size, and saves by its synced key with what it showed', () => {
  const r = toRow({ kind: 'item', ez_key: K('A Wreck', 'Skinny'), ez_name: 'A Wreck', ez_size_name: 'Skinny', seen_count: 0, synced_at: NOW });
  assert.equal(r.synced, true);
  assert.equal(r.sizeRow, true);
  assert.equal(theirLabel(r), 'A Wreck (Skinny)');
  const sug = suggestionsFor(r, [{ id: 'a', name: 'A Wreck Skinny' }, { id: 'b', name: 'A Wreck Bigs' }], [], { limit: 2 });
  assert.equal(sug[0].id, 'a');
  const body = saveBody(r, { menuItemId: 'a' }).body;
  assert.deepEqual(body, { synced: true, kind: 'item', ez_key: K('A Wreck', 'Skinny'), ez_name: 'A Wreck', ez_group: null,
    menu_item_id: 'a', option_id: null, ignored: false, seen_size: 'Skinny', seen_item: null });
  // A row saved before the sync is saved exactly as main saves it: its key rebuilt from its name.
  const plain = saveBody(toRow({ kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad' }), { menuItemId: 'm' }).body;
  assert.deepEqual(plain, { kind: 'item', ez_key: 'farmhouse salad', ez_name: 'Farmhouse Salad', ez_group: null, menu_item_id: 'm', option_id: null, ignored: false });
  const opt = saveBody(toRow({ kind: 'option', ez_key: OK('Sub', 'Bread', 'White'), ez_name: 'White', ez_group: 'Bread', ez_item_name: 'Sub', synced_at: NOW }), { optionId: 'o-w' }).body;
  assert.deepEqual([opt.synced, opt.ez_key, opt.ez_group, opt.option_id, opt.seen_size, opt.seen_item], [true, OK('Sub', 'Bread', 'White'), 'Bread', 'o-w', null, 'Sub']);
  assert.ok(saveBody(toRow({ kind: 'item', ez_key: K('X'), ez_name: 'X', synced_at: NOW }), { optionId: 'o' }).error, 'an item cannot take an option');
});

test('a single size item carries its one size to the card, into suggestions and into what a save records', () => {
  const entries = flattenMenus([menuOf({ id: 'i-t', name: 'Turkey Sandwich', sizes: [size('s-t', 'Box')] },
    { id: 'i-m', name: 'Italian', sizes: [size('a', 'Small'), size('b', 'Large')] })]);
  const plain = entries.find((e) => e.ezKey === K('Turkey Sandwich', 'Box'));
  assert.equal(plain.ezOnlySize, 'Box');
  const plan = planMenuSync({ entries, existing: [], ourItems: [], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.equal(plan.inserts.find((r) => r.ez_key === K('Turkey Sandwich', 'Box')).ez_only_size, 'Box');
  assert.ok(plan.inserts.filter((r) => r.ez_size_name).every((r) => r.ez_only_size === null), 'size rows carry no only size');
  const again = planMenuSync({ entries, existing: plan.inserts, ourItems: [], ourGroups: [], locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  assert.equal(again.refreshes.find((r) => r.ez_key === K('Turkey Sandwich', 'Box')).ez_only_size, 'Box');
  const r = toRow({ kind: 'item', ez_key: K('Turkey Sandwich', 'Box'), ez_name: 'Turkey Sandwich', ez_only_size: 'Box', synced_at: NOW, seen_count: 0 });
  assert.equal(theirLabel(r), 'Turkey Sandwich, sold only as Box');
  const sug = suggestionsFor(r, [{ id: 'plain', name: 'Turkey Sandwich' }, { id: 'box', name: 'Turkey Sandwich Box' }], [], { limit: 2 });
  assert.equal(sug[0].id, 'box', 'suggested on its item AND its one size');
  const body = saveBody(r, { menuItemId: 'box' }).body;
  assert.equal(body.ez_key, K('Turkey Sandwich', 'Box'), 'saved by its synced key');
  assert.equal(body.seen_size, 'Box');
  assert.equal(fullNameOf({ kind: 'item', name: body.ez_name, sizeName: body.seen_size }), 'Turkey Sandwich Box', 'what the edge function records');
  // A synced row holding an automatic link that is not an exact one is listed as not matched yet.
  assert.equal(toRow({ kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', synced_at: NOW,
    menu_item_id: 'm-c', source: 'auto', matched_by: 'name' }).state, 'unmatched');
  assert.equal(toRow({ kind: 'item', ez_key: K('X'), ez_name: 'X', synced_at: NOW, menu_item_id: 'm', source: 'auto', matched_by: 'exact' }).state, 'matched');
});

test('the card: matches to check again sort right after the unmatched ones, say what was matched, and a save clears them', () => {
  const rows = rowsFrom([
    { kind: 'item', ez_key: K('Apple'), ez_name: 'Apple', synced_at: NOW, menu_item_id: 'm-a', source: 'manual', matched_by: 'u', last_seen_at: '2026-09-18T12:00:00Z' },
    { kind: 'item', ez_key: K('Brownie'), ez_name: 'Brownie', synced_at: NOW, menu_item_id: null, source: 'auto', matched_by: null, last_seen_at: '2026-09-10T12:00:00Z' },
    { kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', synced_at: NOW, menu_item_id: 'm-c', source: 'manual', matched_by: 'u',
      decided_as: 'Caesar Salad', look_again: true, last_seen_at: '2026-09-01T12:00:00Z' },
  ], { syncReady: true });
  assert.deepEqual(rows.map((r) => r.ezKey), [K('Brownie'), K('Caesar Salad', 'Large'), K('Apple')]);
  assert.equal(lookAgainCount(rows), 1);
  assert.equal(countRows(rows).outstanding, 1, 'the unmatched count is unchanged');
  assert.equal(lookAgainNote(rows[1]), 'The ezCater name is not the one that was matched. It was matched as: Caesar Salad. Orders print it by name until you check it.');
  assert.doesNotMatch(lookAgainNote(rows[1]), /[\u2013\u2014]/);
  const after = applySaved(rows, saveBody(rows[1], { menuItemId: 'm-c' }).body);
  assert.equal(after.length, 3, 'the same row, saved');
  assert.equal(after.find((r) => r.ezKey === K('Caesar Salad', 'Large')).lookAgain, false);
  assert.equal(lookAgainCount(after), 0);
  // lookAgainOf: only a synced staff decision made for a different name, or with nothing recorded.
  assert.equal(lookAgainOf({ kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', menu_item_id: 'm', source: 'manual', decided_as: 'Caesar Salad Large' }).lookAgain, false);
  assert.equal(lookAgainOf({ kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', menu_item_id: 'm', source: 'manual' }).lookAgain, true, 'nothing recorded');
  assert.equal(lookAgainOf({ kind: 'item', ez_key: 'caesar salad', ez_name: 'Caesar Salad', menu_item_id: 'm', source: 'manual', decided_as: 'Other' }).lookAgain, false, 'a row saved before the sync is never flagged');
  assert.equal(trustedTarget({ kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', menu_item_id: 'm', source: 'manual' }), null);
});

test('the card: once the sync is set up, rows saved before it are listed apart, read only; before it, nothing changes', () => {
  const raw = [
    { kind: 'item', ez_key: 'old sighting', ez_name: 'Old Sighting', menu_item_id: 'm-x', source: 'manual', matched_by: 'u' },
    { kind: 'item', ez_key: K('Synced'), ez_name: 'Synced', synced_at: NOW, ez_ids: ['s1'], menu_item_id: null, source: 'auto', matched_by: null },
  ];
  const ready = rowsFrom(raw, { syncReady: true });
  assert.deepEqual(liveRows(ready).map((r) => r.ezKey), [K('Synced')]);
  assert.deepEqual(offMenuRows(ready).map((r) => r.ezKey), ['old sighting']);
  assert.match(offMenuLine(1), /^1 older name is from before the menu sync\./);
  assert.equal(offMenuLine(0), '');
  assert.equal(olderNote(offMenuRows(ready)[0], [{ id: 'm-x', name: 'Our X' }], []), 'Matched to Our X before the menu sync');
  const before = rowsFrom(raw.slice(0, 1));
  assert.equal(offMenuRows(before).length, 0, 'before 20260919m every row is listed as it always was');
  assert.equal(before.find((r) => r.ezKey === 'old sighting').state, 'matched');
  // The card component uses these, hides the codes block once the sync is set up, offers "Still
  // right", and shows the older rows only when asked, with no save button.
  const jsx = read('../backoffice/sections/EzcaterItemMatching.jsx');
  assert.match(jsx, /rowsFrom\(links\?\.links, \{ syncReady: ready, menuAt: links\?\.last_sync\?\.last_ok_at \|\| null \}\)/);
  assert.match(jsx, /const live = useMemo\(\(\) => liveRows\(rows\), \[rows\]\);/);
  assert.match(jsx, /\{codesOn && !syncReady && \(/);
  assert.match(jsx, />Still right<\/button>/);
  const olderBlock = jsx.slice(jsx.indexOf('{showOlder && offCount > 0 && ('), jsx.indexOf('{shown.slice(0, MAX_SHOWN).map('));
  assert.ok(olderBlock.length > 100 && olderBlock.includes('olderNote(r, ourItems, ourGroups)'));
  assert.doesNotMatch(olderBlock, /onSave|onClick=\{\(\) => (send|save)/, 'the older rows are read only');
});

test('the card: a synced name the last whole sync did not write is listed last as no longer on their menu, and is never work to do', () => {
  const raw = [
    { kind: 'item', ez_key: K('Caesar Salad', 'Regular'), ez_name: 'Caesar Salad', ez_only_size: 'Regular', synced_at: '2026-09-17T15:00:00.000Z',
      menu_item_id: null, source: 'auto', matched_by: null, seen_count: 2 },
    { kind: 'item', ez_key: K('Caesar Salad', 'Large'), ez_name: 'Caesar Salad', ez_only_size: 'Large', synced_at: NOW, menu_item_id: null, source: 'auto', matched_by: null },
  ];
  const rows = rowsFrom(raw, { syncReady: true, menuAt: NOW });
  assert.deepEqual(rows.map((r) => [r.ezKey, r.gone]), [[K('Caesar Salad', 'Large'), false], [K('Caesar Salad', 'Regular'), true]]);
  assert.deepEqual(countRows(rows), { total: 1, matched: 0, ignored: 0, unmatched: 1, outstanding: 1 });
  assert.equal(goneCount(rows), 1);
  assert.match(goneLine(1), /^1 name ezCater no longer sells is listed last\./);
  assert.equal(seenLine(rows[1]), 'No longer on their menu, on 2 orders');
  assert.equal(seenLine(rows[0]), 'On their menu, not ordered yet');
  assert.ok(rowsFrom(raw, { syncReady: true }).every((r) => !r.gone), 'no whole sync known: nothing is gone');
  const jsx = read('../backoffice/sections/EzcaterItemMatching.jsx');
  assert.match(jsx, /\{goneN > 0 && <div style=\{\{ \.\.\.S\.sub, marginTop: 0 \}\}>\{goneLine\(goneN\)\}<\/div>\}/);
});

test('ezcater-connect: items_save updates only a synced row by its key after 20260919m, refuses an out of date page, and is main\'s save before it', () => {
  const src = read('../../supabase/functions/ezcater-connect/index.ts');
  const at = src.indexOf("case 'items_save': {");
  const save = src.slice(at, src.indexOf('default:', at));
  assert.match(save, /const probe = await sb\.from\('ezcater_item_links'\)\.select\('synced_at'\)\.eq\('location_id', opsLocationId\)\.limit\(1\);/);
  // Round 6: only a CURRENT sync key for its kind (a round 4 or round 5 option key is refused).
  assert.match(save, /if \(syncReady && \(body\?\.synced !== true \|\| !isCurrentSyncKey\(kind, syncedKey\)\)\) \{\n\s+return json\(\{ error: 'This page is out of date\. Reload it, then match again\.', code: 'stale_page' \}, 409\);/);
  assert.doesNotMatch(save, /isSyncKey\(/);
  // What the itemsSave mirror above records as decided_as, exactly (an option's parts apart).
  assert.match(save, /const decidedAs = decidedAsOf\(\{\n\s+kind, name: ezName, group: ezGroup \|\| '', sizeName: kind === 'item' \? String\(body\?\.seen_size \|\| ''\)\.trim\(\) : '',\n\s+item: kind === 'option' \? String\(body\?\.seen_item \|\| ''\)\.trim\(\) : '',\n\s+\}\);/);
  // Update only, by the synced key, only a synced row: a save can decide a row, never create one.
  assert.match(save, /\.eq\('location_id', opsLocationId\)\.eq\('kind', kind\)\.eq\('ez_key', syncedKey\)\n\s+\.not\('synced_at', 'is', null\)\n\s+\.select\('ez_key'\);/);
  const synced = save.slice(save.indexOf('if (syncReady) {'), save.indexOf('// BEFORE 20260919m'));
  assert.doesNotMatch(synced, /upsert|insert/);
  // Before the migration: main's save, the key rebuilt from the name and one upsert.
  assert.ok(save.includes("const ezKey = buildLinkKey({ name: ezName, groupLabel: ezGroup || '' }, kind);"));
  assert.ok(save.includes("const { error } = await sb.from('ezcater_item_links').upsert({\n          location_id: opsLocationId,\n          kind,\n          ez_key: ezKey,\n          ez_name: ezName,\n          ez_group: ezGroup,"));
  // items_list: the sync columns asked for first, look again worked out with the sync's rules.
  assert.match(src, /const syncCols = ', ez_size_name, ez_only_size, ez_category, synced_at, decided_as';\n\s+let res = await readAllLinks\(sb, opsLocationId, base \+ syncCols \+ ', ez_item_name'\);/);
  assert.match(src, /const l = lookAgainOf\(r\);/);
  assert.match(src, /return \{ \.\.\.r, look_again: l\.lookAgain, now_as: l\.now, auto_idle: autoIdle \};/);
});

// ── The decision record, the migration and the release note ────────────────────────────────

test('ADR-024 states the exact rule in plain words; 20260919m carries the default and the columns', () => {
  const adr = read('../../DECISIONS.md');
  const a24 = adr.slice(adr.indexOf('## ADR-024'));
  assert.match(a24, /the sync links plain item names that match exactly; options, and names with symbols or emoji, are for staff to match/);
  assert.match(a24, /orders only use matches made before the order: plain item names the sync linked, or matches staff saved, and only for the exact name and size they were made for/);
  assert.match(a24, /Only plain names link on their own \(review round 6/);
  assert.match(a24, /OPTIONS ARE NEVER AUTO LINKED/);
  assert.match(a24, /no name guessing at order time/i);
  assert.match(a24, /Exact by construction/);
  assert.match(a24, /never share a row, its published ids \(`ez_ids`\) or a decision/);
  assert.match(a24, /decides every automatic row again/);
  assert.match(a24, /in ONE statement/);
  assert.match(a24, /carried over, never lost/);
  assert.match(a24, /look again/i);
  assert.match(a24, /An option never auto links \(round 6\)/);
  assert.match(a24, /matched_by 'exact'/);
  assert.match(a24, /Known limit/);
  assert.doesNotMatch(a24, /differ only by a trailing tray or pan word/, 'that limit is fixed');
  assert.doesNotMatch(a24, /[\u2013\u2014]/);
  const sql = read('../../supabase/migrations/' + MIGRATION_FILE);
  assert.match(sql, /alter table public\.ezcater_item_links alter column source set default 'auto';/);
  assert.match(sql, /add column if not exists ez_only_size text;/);
  assert.match(sql, /add column if not exists decided_as text;/);
  assert.match(sql, /EXACT BY CONSTRUCTION/);
  assert.match(sql, /delete from public\.ezcater_item_links where ez_key like 'exact:%';/);
  assert.doesNotMatch(sql, /[\u2013\u2014]/);
});

test('the release note: the menu sync is its own part, after v5.9.9, in plain steps, and proves the new code is live', () => {
  const note = read('../../docs/EZCATER_V1_RELEASE.md');
  const at = note.indexOf('\n# Menu sync, a later release\n');
  assert.ok(at > note.indexOf('## Known gap'), 'after the whole v5.9.9 part');
  const part = note.slice(at);
  assert.deepEqual([...part.matchAll(/^## (\d)\. /gm)].map((m) => Number(m[1])), [1, 2, 3, 4, 5]);
  const where = (re) => { const i = part.search(re); assert.ok(i >= 0, String(re)); return i; };
  const order = [where(/## 1\. Merge and let the app deploy/), where(/Reload every Back Office tab/), where(/## 2\. Deploy the two edge functions/),
    where(/## 3\. Run the migration, outside service/), where(/## 4\. Press Sync straight away/), where(/## 5\. Check your earlier matches once/), where(/## The new rule/)];
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], 'in order: ' + i);
  // The two functions it changes, in order, each with --no-verify-jwt; nothing else.
  const cmds = [...part.matchAll(/^npx supabase functions deploy (\S+) --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt$/gm)].map((m) => m[1]);
  assert.deepEqual(cmds, ['ezcater-connect', 'ezcater-webhook']);
  const root = new URL('../../', import.meta.url);
  const shipsSync = (slug) => sharedDepsOf(slug, {
    read: (p) => readFileSync(new URL(p, root), 'utf8'),
    exists: (p) => existsSync(new URL(p, root)),
    list: (d) => { try { return readdirSync(new URL(d + '/', root)); } catch { return []; } },
  }).includes('supabase/functions/_shared/ezcaterMenuSync.ts');
  assert.ok(shipsSync('ezcater-connect') && shipsSync('ezcater-webhook'), 'both ship the file the marker is in');
  // The live proof reads what Supabase serves into a new empty folder, and the marker is new code only.
  const loop = part.match(/^for fn in (.+); do$/m);
  assert.deepEqual(loop[1].split(' '), ['ezcater-connect', 'ezcater-webhook']);
  assert.match(part, /^LIVE=\$\(mktemp -d\)$/m);
  const marker = part.match(/^grep -a -c '([^']+)' "\$LIVE"\/\*\.eszip$/m);
  assert.ok(marker, 'the grep line');
  assert.ok(read('../../supabase/functions/_shared/ezcaterMenuSync.ts').includes(`'${marker[1]}'`), 'the marker is a string in the shared code');
  const everywhere = (dir) => readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? everywhere(dir + d.name + '/') : [dir + d.name]));
  const holders = everywhere('supabase/functions/').filter((f) => readFileSync(new URL(f, root), 'utf8').includes(marker[1]));
  assert.deepEqual(holders, ['supabase/functions/_shared/ezcaterMenuSync.ts'], 'no code v5.9.9 ships has it');
  // Plain words for Peter.
  assert.match(part, /20260919m_OPS_ezcater_menu_sync_v1\.sql/);
  assert.match(part, /press Sync ezCater menu/);
  assert.match(part, /Tap \*\*Still right\*\*, or \*\*Change\*\*/);
  assert.match(part, /Most single size items are like this/);
  assert.match(part, /an old tab's save is refused, and it says to reload/);
  assert.match(part, /A match is used only for the exact name and size it was made for/);
  assert.match(part, /The sync links plain item names that match exactly; options, and names with symbols or emoji, are for staff to match\./);
  assert.match(part, /Options only use matches staff saved/);
  assert.doesNotMatch(note, /[\u2013\u2014]/);
  assert.doesNotMatch(part, /\S - \S/);
});

test('no em or en dashes in the files this change wrote', () => {
  for (const p of ['../../supabase/functions/_shared/ezcaterMenuSync.ts', '../../supabase/functions/_shared/ezcaterMenuSyncRun.ts',
    '../../supabase/functions/_shared/ezcater-match-ingest.ts', '../../supabase/functions/ezcater-connect/index.ts',
    './ezcaterItemRows.js', '../backoffice/sections/EzcaterItemMatching.jsx', './ezcaterMenuSyncV1.test.js']) {
    assert.doesNotMatch(read(p), /[\u2013\u2014]/, p);
  }
});

// \u2500\u2500 Review round 5: Unicode exact names, options scoped to their item \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Characters are spelled as escapes so the test reads the same in any editor.
const HALF = '\u00bd';
const QUARTER = '\u00bc';
const BIG = '\u5927';
const SMALL = '\u5c0f';
const CHILI = '\u{1F336}';
const SEP = '\u203a';

test('ROUND 6 exact names: a PLAIN name folds case, Latin accents and whitespace only; any other name is kept as written', () => {
  // Plain: letters and digits of any script, spaces, . , ' & ( ) - / and accents.
  for (const n of ['Turkey Sandwich', 'Café Latte', "Chef's Choice (Large)", 'Mac & Cheese', 'Cookies 1/2 Dozen', 'A-1, B.2',
    `Pho ${BIG}`, 'Чай', 'कि', 'が', 'Ｆｕｌｌ']) assert.equal(isPlainName(n), true, n);
  // Not plain: emoji, symbols, '%', superscripts, fraction characters, format, private use, tag,
  // enclosing and variation characters, overlays, '|', curly quotes, '#', '*', '+', '!', '"', ':'.
  for (const n of [`Wings ${CHILI}`, 'Milk 2%', 'Pizza 10²', `Ziti ${HALF} Pan`, 'Tea​', 'A', 'Flag \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
    'Combo #️⃣', 'x̶', 'Wings️', 'A|B', 'Chef’s', 'Combo #1', 'A*', 'Wings + Fries', 'Hot!', '12" Pizza', 'Bread: White',
    'Coke™', 'Ⅻ', '']) assert.equal(isPlainName(n), false, JSON.stringify(n));
  // Plain names fold case, accents on LATIN letters and whitespace, and nothing else.
  assert.equal(exactName('  Crème   Brûlée  '), 'creme brulee');
  assert.equal(exactName('Straße'), exactName('STRASSE'), 'full case folding');
  assert.equal(exactName('Mac & Cheese'), 'mac & cheese');
  assert.notEqual(exactName('Mac & Cheese'), exactName('Mac and Cheese'), "'&' is not folded to 'and'");
  assert.notEqual(exactName('Caesar Salad (Large)'), exactName('Caesar Salad Large'), 'brackets are not folded away');
  assert.notEqual(exactName('Чай'), exactName('Чаи'), "the Cyrillic breve is a letter of its own: 'й' is not 'и'");
  assert.equal(exactName('Чай'), exactName('Чай'), 'the same letter typed in two ways is one name');
  assert.notEqual(exactName('Ｆｕｌｌ'), exactName('Full'), 'no compatibility folding: full width is not plain ASCII');
  assert.notEqual(exactName('कि'), exactName('का'), 'a Devanagari vowel sign is part of the letter');
  assert.notEqual(exactName('が'), exactName('か'), 'a Japanese voicing mark is part of the letter');
  // Any other name is the text as written (composed, whitespace evened out): two differ when their text differs.
  const scot = 'Full Breakfast \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
  const wales = 'Full Breakfast \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}';
  assert.notEqual(exactName(scot), exactName(wales), 'flag tag characters are kept');
  assert.notEqual(exactName('Family \u{1F468}‍\u{1F469}‍\u{1F467}'), exactName('Family \u{1F468}\u{1F469}\u{1F467}'), 'a zero width joiner is kept');
  assert.notEqual(exactName('Combo #️⃣'), exactName('Combo *️⃣'), 'a keycap keeps its base');
  assert.notEqual(exactName('Pizza 10²'), exactName('Pizza 102'), 'a superscript is not a digit');
  assert.notEqual(exactName('Milk 2%'), exactName('Milk 2'), "'%' is not punctuation");
  assert.notEqual(exactName(`Ziti ${HALF} Pan`), exactName(`Ziti ${QUARTER} Pan`));
  assert.notEqual(exactName(`Ziti ${HALF} Pan`), exactName('Ziti 1/2 Pan'), 'no fraction mapping');
  assert.notEqual(exactName(`Wings ${CHILI}`), exactName('Wings'));
  assert.notEqual(exactName(`Wings ${CHILI}`), exactName(`Wings ${CHILI}️`), 'a variation selector is kept too');
  assert.equal(exactName(`  Wings   ${CHILI} `), `Wings ${CHILI}`, 'only whitespace is evened out');
  assert.equal(isPlainName('Te\ufeffa'), false, 'U+FEFF is a format character, not whitespace');
  assert.notEqual(exactName('Te\ufeffa'), exactName('Tea'));
  assert.equal(exactName('Tea\u00a0\u3000Cake'), 'tea cake', 'Unicode whitespace is whitespace');
  assert.equal(exactName('Café ☕'), 'Café ☕', 'composed form');
  // Plain and not plain can never share a form: a plain form holds only plain characters.
  assert.notEqual(exactName('Coke™'), exactName('CokeTM'));
  // The auto link comparison: both plain, and the same after case, accents and whitespace.
  assert.equal(plainSame('  café LATTE', 'Cafe Latte'), true);
  assert.equal(plainSame(`Wings ${CHILI}`, `Wings ${CHILI}`), false, 'the same text, but not plain: never an auto link');
  assert.equal(plainSame('Milk 2%', 'Milk 2%'), false);
  // The rules of earlier rounds, kept only to find rows they wrote.
  assert.equal(round5ExactName(`Ziti ${HALF} Pan`), 'ziti 1/2 pan');
  assert.equal(round5ExactName(scot), round5ExactName(wales), 'round 5 folded the flags together (why it is not used for keys)');
  assert.equal(asciiExactName(`Pho ${BIG}`), 'pho');
});

test('ROUND 5 (ADV1): Ziti half pan and Ziti quarter pan are two rows; a staff match on one never routes the other', async () => {
  const menu = [menuOf(item('h', `Ziti ${HALF} Pan`, [size('sH', '')]), item('q', `Ziti ${QUARTER} Pan`, [size('sQ', '')]))];
  const { entries } = flattenMenusWithNotes(menu);
  assert.deepEqual(entries.map((e) => [e.ezKey, e.ids, e.noAuto]), [[`exact:Ziti ${HALF} Pan`, ['sH'], true], [`exact:Ziti ${QUARTER} Pan`, ['sQ'], true]]);
  const ours = [{ id: 'our-half', name: 'Ziti Half Pan' }, { id: 'our-qtr', name: 'Ziti Quarter Pan' }];
  const p = await pipeline({ menus: [menu, menu], ours,
    after: [(sb) => itemsSave(sb, row(sb, K(`Ziti ${HALF} Pan`)), { menuItemId: 'our-half' })],
    lines: [line(`Ziti ${HALF} Pan`, 'sH', null), line(`Ziti ${QUARTER} Pan`, 'sQ', null), line(`Ziti ${QUARTER} Pan`, 'sH', null)] });
  assert.deepEqual(p.out.map((l) => l.itemId), ['our-half', null, null]);
  assert.deepEqual(p.queued.map((l) => l.itemId), ['our-half', null, null]);
  assert.equal(p.row(K(`Ziti ${QUARTER} Pan`)).menu_item_id, null);
  // Round 6: a name with a fraction character is not plain, so it never auto links: not to our
  // "Ziti 1/2 Pan", and not even to our "Ziti ½ Pan" written the same way. Staff match it.
  const typed = await pipeline({ menus: [menu], ours: [{ id: 'our-12', name: 'Ziti 1/2 Pan' }, { id: 'our-same', name: `Ziti ${HALF} Pan` }],
    lines: [line(`Ziti ${HALF} Pan`, 'sH', null), line(`Ziti ${QUARTER} Pan`, 'sQ', null)] });
  assert.deepEqual(typed.out.map((l) => l.itemId), [null, null]);
  assert.ok(links(typed.sb).every((r) => r.menu_item_id === null && r.matched_by === null));
});

test('ROUND 5 (ADV2): option values half lb and quarter lb are two rows with two decisions', async () => {
  const menu = [menuOf(item('d', 'Deli Tray', [size('s-d', '', { customizationTypes: [
    { id: 't1', name: 'Turkey', values: [{ id: 'v-h', name: `${HALF} lb` }, { id: 'v-q', name: `${QUARTER} lb` }] }] })]))];
  const opt = flattenMenus(menu).filter((e) => e.kind === 'option');
  assert.deepEqual(opt.map((e) => [e.ezKey, e.ids]), [[OK('Deli Tray', 'Turkey', `${HALF} lb`), ['v-h']], [OK('Deli Tray', 'Turkey', `${QUARTER} lb`), ['v-q']]]);
  assert.equal(OK('Deli Tray', 'Turkey', `${HALF} lb`), `exact:["deli tray","turkey","${HALF} lb"]`);
  const groups = [{ id: 'g1', name: 'Turkey', options: [{ id: 'o-half', name: 'Half lb' }, { id: 'o-qtr', name: 'Quarter lb' }] }];
  const mods = (id, name) => orderItemsToLines([{ uuid: 'o1', name: 'Deli Tray', menuItemSizeId: 's-d', menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: id, customizationTypeName: 'Turkey', name, quantity: 1 }] }]);
  const lines = [...mods('v-q', `${QUARTER} lb`), ...mods('v-h', `${HALF} lb`)];
  const p = await pipeline({ menus: [menu], ours: [{ id: 'our-deli', name: 'Deli Tray' }], groups,
    after: [(sb) => itemsSave(sb, row(sb, OK('Deli Tray', 'Turkey', `${HALF} lb`)), { optionId: 'o-half' })], lines });
  assert.deepEqual(p.out.map((l) => l.mods[0].optionId), [null, 'o-half']);
  assert.deepEqual(p.queued.map((l) => l.mods[0].optionId), [null, 'o-half']);
  assert.equal(p.row(OK('Deli Tray', 'Turkey', `${HALF} lb`)).decided_as, JSON.stringify({ item: 'Deli Tray', group: 'Turkey', value: `${HALF} lb` }));
  assert.equal(lookAgainOf(p.row(OK('Deli Tray', 'Turkey', `${HALF} lb`))).was, `Deli Tray ${SEP} Turkey: ${HALF} lb`);
});

test('ROUND 5 (ADV3): "Pho" with a CJK size word and "Wings" with chilies never auto link; round 6: an emoji name never auto links at all', async () => {
  const menu = [menuOf(item('a', `Pho ${BIG}`, [size('sA', '')]), item('b', `Pho ${SMALL}`, [size('sB', '')]),
    item('c', `Wings ${CHILI}`, [size('sC', '')]), item('e', `Wings ${CHILI}${CHILI}${CHILI}`, [size('sE', '')]))];
  const { entries } = flattenMenusWithNotes(menu);
  assert.equal(new Set(entries.map((e) => e.ezKey)).size, 4, 'four products, four rows');
  const p = await pipeline({ menus: [menu], ours: [{ id: 'our-pho', name: 'Pho' }, { id: 'our-w', name: 'Wings' }, { id: 'our-hot', name: `Wings ${CHILI}${CHILI}${CHILI}` }],
    lines: [line(`Pho ${BIG}`, 'sA', null), line(`Pho ${SMALL}`, 'sB', null), line(`Wings ${CHILI}${CHILI}${CHILI}`, 'sE', null), line(`Wings ${CHILI}`, 'sC', null)] });
  assert.deepEqual(p.out.map((l) => l.itemId), [null, null, null, null], 'even our exact emoji name is for staff to match');
  assert.deepEqual(p.queued.map((l) => l.itemId), [null, null, null, null]);
  // A staff match on the emoji name routes that exact name only.
  const s = await pipeline({ menus: [menu], ours: [{ id: 'our-hot', name: `Wings ${CHILI}${CHILI}${CHILI}` }],
    after: [(sb) => itemsSave(sb, row(sb, K(`Wings ${CHILI}${CHILI}${CHILI}`)), { menuItemId: 'our-hot' })],
    lines: [line(`Wings ${CHILI}${CHILI}${CHILI}`, 'sE', null), line(`Wings ${CHILI}`, 'sC', null), line(`Wings ${CHILI}${CHILI}${CHILI}`, 'sC', null)] });
  assert.deepEqual(s.out.map((l) => l.itemId), ['our-hot', null, null]);
});

test('ROUND 5 (ADV4): "Size: Large" on Pizza and on Salad are two rows; one staff match routes only its own item', async () => {
  const menu = [menuOf(
    item('p', 'Pizza', [size('s-p', '', { customizationTypes: [{ id: 't', name: 'Size', values: [{ id: 'v-pl', name: 'Large' }] }] })]),
    item('s', 'Salad', [size('s-s', '', { customizationTypes: [{ id: 't2', name: 'Size', values: [{ id: 'v-sl', name: 'Large' }] }] })]))];
  const opt = flattenMenus(menu).filter((e) => e.kind === 'option');
  assert.deepEqual(opt.map((e) => [e.ezKey, e.ids, e.ezItemName]), [[OK('Pizza', 'Size', 'Large'), ['v-pl'], 'Pizza'], [OK('Salad', 'Size', 'Large'), ['v-sl'], 'Salad']]);
  // Our group is named differently, so nothing auto links: only the staff match decides.
  const groups = [{ id: 'g-sz', name: 'Pizza Size', options: [{ id: 'o-large', name: 'Large' }] }];
  const order = (name, sizeId, valueId) => orderItemsToLines([{ uuid: 'o-' + name, name, menuItemSizeId: sizeId, menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: valueId, customizationTypeName: 'Size', name: 'Large', quantity: 1 }] }]);
  const lines = [...order('Pizza', 's-p', 'v-pl'), ...order('Salad', 's-s', 'v-sl'), ...order('Salad', 's-s', 'v-pl')];
  const p = await pipeline({ menus: [menu], ours: [{ id: 'm-pizza', name: 'Pizza' }, { id: 'm-salad', name: 'Salad' }], groups,
    after: [(sb) => itemsSave(sb, row(sb, OK('Pizza', 'Size', 'Large')), { optionId: 'o-large' })], lines });
  assert.deepEqual(p.out.map((l) => [l.itemId, l.mods[0].optionId]), [['m-pizza', 'o-large'], ['m-salad', null], ['m-salad', null]]);
  assert.deepEqual(p.queued.map((l) => l.mods[0].optionId), ['o-large', null, null]);
  assert.equal(p.row(OK('Salad', 'Size', 'Large')).option_id, null, 'the Salad row is untouched');
  // The route itself, by line: the same customization on another line is another row.
  const idx = indexSyncedRows(links(p.sb), 'option');
  assert.equal(optionRouteFor({ ezItemId: 'v-pl', groupLabel: 'Size', label: 'Large' }, idx, { name: 'Pizza' }).optionId, 'o-large');
  assert.equal(optionRouteFor({ ezItemId: 'v-pl', groupLabel: 'Size', label: 'Large' }, idx, { name: 'Salad' }).mode, 'unmatched');
  assert.equal(optionRouteFor({ ezItemId: 'v-pl', groupLabel: 'Size', label: 'Large' }, idx, null).mode, 'unmatched', 'no line, no row');
  // One customization offered under every size of one item is one row with every id.
  const sized = flattenMenus([menuOf(item('p', 'Pizza', [
    size('s-10', '10 inch', { customizationTypes: [{ id: 't', name: 'Crust', values: [{ id: 'v-10', name: 'Thin' }] }] }),
    size('s-14', '14 inch', { customizationTypes: [{ id: 't', name: 'Crust', values: [{ id: 'v-14', name: 'Thin' }] }] })]))]).filter((e) => e.kind === 'option');
  assert.deepEqual(sized.map((e) => [e.ezKey, e.ids]), [[OK('Pizza', 'Crust', 'Thin'), ['v-10', 'v-14']]]);
});

test('ROUND 5 (ADV5): names that differ only by a size word placement are one product by name; a fraction is never a number', () => {
  const menu = [menuOf(item('a', 'Cookies 12', [size('sA', '')]), item('b', 'Cookies', [size('sB', '12')]),
    item('c', 'Cookies 1/2 Dozen', [size('sC', '')]), item('d', 'Cookies 12 Dozen', [size('sD', '')]))];
  assert.deepEqual(flattenMenus(menu).map((e) => [e.ezKey, e.ids.slice().sort()]), [
    ['exact:cookies 12', ['sA', 'sB']], ['exact:cookies 1/2 dozen', ['sC']], ['exact:cookies 12 dozen', ['sD']]]);
});

test('ROUND 5: a staff option decision from before is kept only where its item is unambiguous, else looked at again', async () => {
  const oldWhite = { kind: 'option', ez_key: buildLinkKey({ name: 'White', groupLabel: 'Bread' }, 'option'), ez_name: 'White', ez_group: 'Bread',
    menu_item_id: null, option_id: 'o-w', source: 'manual', matched_by: 'user-1', seen_count: 3 };
  const bread = (id, name, vid) => item(id, name, [size('s-' + id, '', { customizationTypes: [{ id: 'ct', name: 'Bread', values: [{ id: vid, name: 'White' }] }] })]);
  const groups = [{ id: 'g', name: 'Bread Choice', options: [{ id: 'o-w', name: 'White' }] }];
  const ours = [{ id: 'm-sub', name: 'Sub' }, { id: 'm-wrap', name: 'Wrap' }];
  const order = (name, vid) => orderItemsToLines([{ uuid: 'o-' + name, name, menuItemSizeId: 's-' + name.toLowerCase(), menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: vid, customizationTypeName: 'Bread', name: 'White', quantity: 1 }] }]);
  // Only Sub offers Bread: White: the decision can only have meant Sub's. Kept, recorded with its item.
  const one = await pipeline({ menus: [[menuOf(bread('sub', 'Sub', 'v-1'))]], ours, groups, existing: [oldWhite], lines: order('Sub', 'v-1') });
  const kept = one.row(OK('Sub', 'Bread', 'White'));
  assert.deepEqual([kept.option_id, kept.source, kept.decided_as, lookAgainOf(kept).lookAgain],
    ['o-w', 'manual', decidedAsOf({ kind: 'option', item: 'Sub', group: 'Bread', name: 'White' }), false]);
  assert.deepEqual([one.plans[0].counts.carried, one.plans[0].counts.lookAgain], [1, 0]);
  assert.equal(one.out[0].mods[0].optionId, 'o-w');
  assert.equal(one.queued[0].mods[0].optionId, 'o-w');
  // Sub and Wrap both offer it: which item it was made for is a guess. Both carried, both to check.
  const two = await pipeline({ menus: [[menuOf(bread('sub', 'Sub', 'v-1'), bread('wrap', 'Wrap', 'v-2'))]], ours, groups, existing: [oldWhite],
    lines: [...order('Sub', 'v-1'), ...order('Wrap', 'v-2')] });
  for (const k of [OK('Sub', 'Bread', 'White'), OK('Wrap', 'Bread', 'White')]) {
    const r = two.row(k);
    assert.deepEqual([r.option_id, r.decided_as, lookAgainOf(r).lookAgain], ['o-w', 'Bread: White', true], k);
  }
  assert.deepEqual([two.plans[0].counts.carried, two.plans[0].counts.lookAgain], [0, 2]);
  assert.deepEqual(two.out.map((l) => l.mods[0].optionId), [null, null], 'not used until staff look again');
  assert.deepEqual(two.queued.map((l) => l.mods[0].optionId), [null, null]);
  // "Still right" on Sub records Sub's full name: then Sub routes, Wrap still waits.
  itemsSave(two.sb, two.row(OK('Sub', 'Bread', 'White')), { optionId: 'o-w' });
  assert.equal(readableDecidedAs(two.row(OK('Sub', 'Bread', 'White')).decided_as), `Sub ${SEP} Bread: White`);
  const after = await orderThrough(two.sb, [...order('Sub', 'v-1'), ...order('Wrap', 'v-2')]);
  assert.deepEqual(after.lines.map((l) => l.mods[0].optionId), ['o-w', null]);
  // A partial read of ezCater cannot prove the item is the only one: looked at again.
  const e = flattenMenus([menuOf(bread('sub', 'Sub', 'v-1'))]);
  const partial = planMenuSync({ entries: e, existing: [{ location_id: LOC, ...oldWhite }], ourItems: ours, ourGroups: groups,
    locationId: LOC, nowIso: NOW, complete: false, menuOk: true });
  const ins = partial.inserts.find((r) => r.kind === 'option');
  assert.deepEqual([ins.decided_as, partial.counts.lookAgain, partial.counts.carried], ['Bread: White', 1, 0]);
  // A different value is never carried as kept, even with one item.
  const other = carryOverFor(e.find((x) => x.kind === 'option'), new Map([['option:' + oldWhite.ez_key, { ...oldWhite, decided_as: 'Bread: White Roll' }]]),
    optionItemsOf(e));
  assert.equal(other.decidedAs, 'Bread: White Roll');
  assert.deepEqual([...optionItemsOf(e).entries()].map(([k, v]) => [k, [...v]]), [[optionPairOf('Bread', 'White'), ['sub']]]);
});

test('ROUND 5: an option row a sync keyed without its item is carried from, never routes, and is listed with the older rows', async () => {
  const earlier = { kind: 'option', ez_key: 'exact:bread|white', ez_name: 'White', ez_group: 'Bread', ez_ids: ['v-1', 'v-2'], synced_at: '2026-09-17T00:00:00.000Z',
    menu_item_id: null, option_id: 'o-w', source: 'manual', matched_by: 'user-1', decided_as: 'Bread: White', seen_count: 4 };
  assert.equal(isCurrentSyncKey('option', earlier.ez_key), false);
  assert.equal(isCurrentSyncKey('option', OK('Sub', 'Bread', 'White')), true);
  assert.equal(isCurrentSyncKey('item', 'exact:bread|white'), true, 'an item key has no parts');
  assert.equal(isEarlierSyncRow(earlier), true);
  assert.equal(trustedTarget(earlier), null);
  assert.equal(lookAgainOf(earlier).lookAgain, false, 'never flagged: it can never route');
  assert.equal(indexSyncedRows([earlier], 'option').size, 0);
  assert.deepEqual(earlierSyncKeysOf({ kind: 'option', ezName: 'White', ezGroup: 'Bread', ezItemName: 'Sub', ids: [] }), ['exact:sub|bread|white', 'exact:bread|white']);
  const menu = [menuOf(item('sub', 'Sub', [size('s-sub', '', { customizationTypes: [{ id: 'ct', name: 'Bread', values: [{ id: 'v-1', name: 'White' }] }] })]))];
  const p = await pipeline({ menus: [menu], ours: [{ id: 'm-sub', name: 'Sub' }], groups: [{ id: 'g', name: 'Bread Choice', options: [{ id: 'o-w', name: 'White' }] }],
    existing: [earlier], lines: orderItemsToLines([{ uuid: 'o', name: 'Sub', menuItemSizeId: 's-sub', menuItemSizeName: null, quantity: 1,
      customizations: [{ customizationId: 'v-1', customizationTypeName: 'Bread', name: 'White', quantity: 1 }] }]) });
  const now = p.row(OK('Sub', 'Bread', 'White'));
  assert.deepEqual([now.option_id, readableDecidedAs(now.decided_as), now.ez_item_name, now.ez_ids], ['o-w', `Sub ${SEP} Bread: White`, 'Sub', ['v-1']]);
  assert.equal(p.out[0].mods[0].optionId, 'o-w');
  assert.deepEqual(omit(p.row('exact:bread|white'), COUNTERS), omit({ location_id: LOC, ...earlier }, COUNTERS), 'the earlier row is never written');
  // The card: the earlier row is read only, with the rows from before the sync; the new one shows its item.
  const shown = rowsFrom(links(p.sb).map((r) => ({ ...r, look_again: lookAgainOf(r).lookAgain })), { syncReady: true });
  const old = shown.find((r) => r.ezKey === 'exact:bread|white');
  assert.deepEqual([old.synced, old.offMenu], [false, true]);
  const cur = shown.find((r) => r.ezKey === OK('Sub', 'Bread', 'White'));
  assert.deepEqual([cur.synced, cur.offMenu, cur.ezItemName, theirLabel(cur)], [true, false, 'Sub', 'White, on Sub']);
  assert.equal(saveBody(cur, { optionId: 'o-w' }).body.seen_item, 'Sub');
});

test('ROUND 5: an item row a sync keyed by the ASCII rule passes its decision on only for the name it was made for', async () => {
  // Round 4 folded "Pho \u5927" and "Pho \u5c0f" into one row 'exact:pho'; staff matched it while the card showed "Pho \u5927".
  const merged = { kind: 'item', ez_key: 'exact:pho', ez_name: `Pho ${BIG}`, ez_ids: ['sA', 'sB'], synced_at: '2026-09-17T00:00:00.000Z',
    menu_item_id: 'our-pho-l', option_id: null, source: 'manual', matched_by: 'user-1', decided_as: `Pho ${BIG}`, seen_count: 2 };
  assert.equal(isEarlierSyncRow(merged), true);
  // A current row that another product's ASCII name falls on is its own decision, never carried.
  const wings = { kind: 'item', ez_key: 'exact:wings', ez_name: 'Wings', ez_ids: ['sW'], synced_at: '2026-09-17T00:00:00.000Z',
    menu_item_id: 'our-w', option_id: null, source: 'manual', matched_by: 'user-1', decided_as: 'Wings', seen_count: 2 };
  assert.equal(isEarlierSyncRow(wings), false);
  const menu = [menuOf(item('a', `Pho ${BIG}`, [size('sA', '')]), item('b', `Pho ${SMALL}`, [size('sB', '')]),
    item('w', 'Wings', [size('sW', '')]), item('c', `Wings ${CHILI}`, [size('sC', '')]))];
  const p = await pipeline({ menus: [menu], existing: [merged, wings],
    ours: [{ id: 'our-pho-l', name: 'Pho Large' }, { id: 'our-w', name: 'Chicken Wings' }],
    lines: [line(`Pho ${BIG}`, 'sA', null), line(`Pho ${SMALL}`, 'sB', null), line('Wings', 'sW', null), line(`Wings ${CHILI}`, 'sC', null), line('Pho', 'sA', null)] });
  const big = p.row(K(`Pho ${BIG}`));
  const small = p.row(K(`Pho ${SMALL}`));
  assert.deepEqual([big.menu_item_id, lookAgainOf(big).lookAgain], ['our-pho-l', false], 'the name it was made for: kept');
  assert.deepEqual([small.menu_item_id, lookAgainOf(small).lookAgain], ['our-pho-l', true], 'another name: to check again');
  const chili = p.row(K(`Wings ${CHILI}`));
  assert.deepEqual([chili.menu_item_id, chili.source], [null, 'auto'], 'Wings is not Wings with a chili');
  assert.deepEqual(p.out.map((l) => l.itemId), ['our-pho-l', null, 'our-w', null, null]);
  assert.deepEqual(p.queued.map((l) => l.itemId), ['our-pho-l', null, 'our-w', null, null]);
});

test('ROUND 5: 20260919m adds ez_item_name; the order path never needs it', () => {
  const sql = read('../../supabase/migrations/' + MIGRATION_FILE);
  assert.match(sql, /add column if not exists ez_item_name text;/);
  assert.match(sql, /'decided_as','ez_item_name'\);/);
  assert.match(sql, /drop column if exists ez_item_name/);
  const ingest = read('../../supabase/functions/_shared/ezcater-match-ingest.ts');
  assert.match(ingest, /const o = optionRouteFor\(mod, optIdx, line\);/);
  const sync = read('../../supabase/functions/_shared/ezcaterMenuSync.ts');
  assert.match(sync, /export const LINK_COLUMNS_WITH_SYNC = LINK_COLUMNS \+ ', ez_ids, ez_size_name, ez_only_size, synced_at, decided_as';/);
  const a24 = read('../../DECISIONS.md').slice(read('../../DECISIONS.md').indexOf('## ADR-024'));
  assert.match(a24, /Item scoped options \(review round 5/);
  assert.match(a24, /exactly one item offering them/);
});

test('ROUND 5: the release note says what to do when the first Sync fails', () => {
  const note = read('../../docs/EZCATER_V1_RELEASE.md');
  const part = note.slice(note.indexOf('## 4. Press Sync straight away'), note.indexOf('## 5. Check your earlier matches once'));
  assert.match(part, /### If the first Sync fails/);
  assert.match(part, /\*\*Orders are safe\.\*\* Every ezCater line prints by name/);
  assert.match(part, /\*\*Press Sync ezCater menu again\.\*\*/);
  assert.match(part, /\*\*Where to see the error:\*\*/);
  assert.match(part, /\*\*Call Claude if:\*\*/);
  // The words it quotes are the words the app shows.
  const run = read('../../supabase/functions/_shared/ezcaterMenuSyncRun.ts');
  for (const said of ['Menu sync is not switched on yet', 'Could not read the saved matches', 'No ezCater caterer is linked', 'Some of it did not complete']) {
    assert.ok(part.includes(said) && run.includes(said), said);
  }
  assert.ok(part.includes('The last try did not complete') && read('./ezcaterItemRows.js').includes('The last try did not complete'));
  assert.match(note, /Ran an older copy of it before\?\*\* Run this one anyway/);
  assert.doesNotMatch(part, /[\u2013\u2014]/);
  assert.doesNotMatch(part, /\S - \S/);
});

// ── Review round 6: the sync links plain item names that match exactly; options, and names with
// symbols or emoji, are for staff to match ─────────────────────────────────────────────────────

const SCOT = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
const WALES = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}';
const HASH_KEY = '#️⃣';
const STAR_KEY = '*️⃣';

test('ROUND 6: every round 5 collision is its own row, never auto linked, and its lines print by name; plain items still link', async () => {
  const one = (id, name) => item(id, name, [size('s-' + id, '')]);
  const menu = [menuOf(
    one('scot', `Full Breakfast ${SCOT}`), one('wales', `Full Breakfast ${WALES}`),
    one('hash', `Combo ${HASH_KEY}`), one('star', `Combo ${STAR_KEY}`),
    one('sup', 'Pizza 10²'), one('pct', 'Milk 2%'), one('chai', 'Чай'),
    one('half', `Ziti ${HALF} Pan`), one('qtr', `Ziti ${QUARTER} Pan`),
    one('big', `Pho ${BIG}`), one('small', `Pho ${SMALL}`), one('chili', `Wings ${CHILI}`),
    one('turkey', 'Turkey Sandwich'),
  )];
  const ours = [
    { id: 'our-scot', name: `Full Breakfast ${SCOT}` }, { id: 'our-welsh', name: 'Full Welsh Breakfast' },
    { id: 'our-hash', name: `Combo ${HASH_KEY}` }, { id: 'our-102', name: 'Pizza 102' }, { id: 'our-milk', name: 'Milk 2' },
    { id: 'our-chai', name: 'Чаи' }, { id: 'our-ziti', name: 'Ziti 1/2 Pan' }, { id: 'our-pho', name: 'Pho' },
    { id: 'our-wings', name: 'Wings' }, { id: 'our-turkey', name: 'turkey  sandwich' },
  ];
  const ids = ['scot', 'wales', 'hash', 'star', 'sup', 'pct', 'chai', 'half', 'qtr', 'big', 'small', 'chili', 'turkey'];
  const lines = [
    ...ids.map((id) => line(menu[0].categories[0].items.find((x) => x.id === id).name, 's-' + id, null)),
    // The Welsh line carrying the Scottish id, and the other way round: never either product.
    line(`Full Breakfast ${WALES}`, 's-scot', null), line(`Full Breakfast ${SCOT}`, 's-wales', null),
  ];
  const p = await pipeline({ menus: [menu], ours, lines });
  const itemRows = links(p.sb).filter((r) => r.kind === 'item');
  assert.equal(itemRows.length, ids.length, 'thirteen products, thirteen rows: nothing folded together');
  for (const r of itemRows) {
    if (r.ez_name === 'Turkey Sandwich') continue;
    assert.deepEqual([r.menu_item_id, r.option_id, r.source, r.matched_by], [null, null, 'auto', null], r.ez_name);
    assert.equal(r.ez_ids.length, 1, r.ez_name);
  }
  assert.deepEqual([p.row(K('Turkey Sandwich')).menu_item_id, p.row(K('Turkey Sandwich')).matched_by], ['our-turkey', 'exact'],
    'a plain name, the same after case and whitespace: auto linked');
  const want = [...ids.map((id) => (id === 'turkey' ? 'our-turkey' : null)), null, null];
  assert.deepEqual(p.out.map((l) => l.itemId), want, 'planLineMatches');
  assert.deepEqual(p.queued.map((l) => l.itemId), want, 'matchQueueRow');
  assert.equal(p.plans[0].counts.autoLinked, 1);
  assert.equal(p.plans[0].counts.toDecide, ids.length - 1);
  // A staff match on the Scottish breakfast routes only the Scottish breakfast.
  const s = await pipeline({ menus: [menu], ours, lines,
    after: [(sb) => itemsSave(sb, row(sb, K(`Full Breakfast ${SCOT}`)), { menuItemId: 'our-scot' })] });
  assert.deepEqual(s.out.map((l) => l.itemId), [...ids.map((id) => ({ scot: 'our-scot', turkey: 'our-turkey' }[id] || null)), null, null]);
  assert.equal(lookAgainOf(s.row(K(`Full Breakfast ${SCOT}`))).lookAgain, false);
});

test('ROUND 6: "Size: Large" on Salad and on Pizza is never auto linked, even when our Pizza has exactly Size: Large', async () => {
  const menu = [menuOf(
    item('p', 'Pizza', [size('s-p', '', { customizationTypes: [{ id: 't', name: 'Size', values: [{ id: 'v-pl', name: 'Large' }] }] })]),
    item('s', 'Salad', [size('s-s', '', { customizationTypes: [{ id: 't2', name: 'Size', values: [{ id: 'v-sl', name: 'Large' }] }] })]))];
  const groups = [{ id: 'g-size', name: 'Size', options: [{ id: 'opt-pizza-large', name: 'Large', itemId: null }] }];
  const order = (name, sizeId, valueId) => orderItemsToLines([{ uuid: 'o-' + name, name, menuItemSizeId: sizeId, menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: valueId, customizationTypeName: 'Size', name: 'Large', quantity: 1 }] }]);
  const lines = [...order('Pizza', 's-p', 'v-pl'), ...order('Salad', 's-s', 'v-sl')];
  const p = await pipeline({ menus: [menu, menu], ours: [{ id: 'm-pizza', name: 'Pizza' }, { id: 'm-salad', name: 'Salad' }], groups, lines });
  for (const k of [OK('Pizza', 'Size', 'Large'), OK('Salad', 'Size', 'Large')]) {
    assert.deepEqual([p.row(k).option_id, p.row(k).menu_item_id, p.row(k).matched_by, p.row(k).source], [null, null, null, 'auto'], k);
  }
  assert.deepEqual(p.out.map((l) => [l.itemId, l.mods[0].optionId, l.mods[0].itemId]), [['m-pizza', null, null], ['m-salad', null, null]]);
  assert.deepEqual(p.queued.map((l) => l.mods[0].optionId), [null, null]);
  assert.equal(p.plans[0].counts.options, 2);
  assert.equal(p.plans[1].counts.redecided, 0, 'the second sync writes no option decision either');
});

test('ROUND 6: a staff option match on a group holding ": " (and an item holding " › ") confirms and routes only on its item', async () => {
  const group = 'Step 1: Choose Bread';
  const itemName = `Sandwich ${SEP} Deluxe`;
  const menu = [menuOf(
    item('sw', itemName, [size('s-sw', '', { customizationTypes: [
      { id: 't1', name: group, values: [{ id: 'v-white', name: 'White' }] },
      // The same readable text, split in another place: its own row, never the staff match's.
      { id: 't2', name: 'Step 1', values: [{ id: 'v-other', name: 'Choose Bread: White' }] },
    ] })]),
    item('wr', 'Wrap', [size('s-wr', '', { customizationTypes: [{ id: 't3', name: group, values: [{ id: 'v-wrap', name: 'White' }] }] })]))];
  const key = OK(itemName, group, 'White');
  const twin = OK(itemName, 'Step 1', 'Choose Bread: White');
  assert.notEqual(key, twin);
  assert.equal(fullNameOf({ kind: 'option', item: itemName, group, name: 'White' }), fullNameOf({ kind: 'option', item: itemName, group: 'Step 1', name: 'Choose Bread: White' }),
    'the readable names are the same text: why decided_as keeps the parts apart');
  const groups = [{ id: 'g', name: 'Bread', options: [{ id: 'o-white', name: 'White' }] }];
  const order = (name, sizeId, g, v, id) => orderItemsToLines([{ uuid: 'o-' + id, name, menuItemSizeId: sizeId, menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: id, customizationTypeName: g, name: v, quantity: 1 }] }]);
  const lines = [...order(itemName, 's-sw', group, 'White', 'v-white'), ...order(itemName, 's-sw', 'Step 1', 'Choose Bread: White', 'v-other'),
    ...order('Wrap', 's-wr', group, 'White', 'v-wrap'), ...order('Wrap', 's-wr', group, 'White', 'v-white')];
  const p = await pipeline({ menus: [menu], ours: [], groups, lines,
    after: [(sb) => itemsSave(sb, row(sb, key), { optionId: 'o-white' })] });
  const saved = p.row(key);
  assert.equal(saved.decided_as, JSON.stringify({ item: itemName, group, value: 'White' }));
  assert.equal(lookAgainOf(saved).lookAgain, false, 'confirmed: the parts are compared, never parsed from a display string');
  assert.deepEqual(trustedTarget(saved), { menuItemId: null, optionId: 'o-white' });
  assert.deepEqual(p.out.map((l) => l.mods[0].optionId), ['o-white', null, null, null]);
  assert.deepEqual(p.queued.map((l) => l.mods[0].optionId), ['o-white', null, null, null]);
  // A decision carried with only a readable text (from before round 6) is looked at again, and
  // "Still right" confirms it.
  const carried = { ...saved, decided_as: `${itemName} ${SEP} ${group}: White` };
  assert.equal(lookAgainOf(carried).lookAgain, true);
  assert.equal(lookAgainOf(carried).was, `${itemName} ${SEP} ${group}: White`);
  assert.equal(trustedTarget(carried), null);
  Object.assign(p.row(key), { decided_as: carried.decided_as });
  const shown = toRow({ ...p.row(key), look_again: true }, { syncReady: true });
  assert.equal(shown.lookAgain, true);
  assert.match(lookAgainNote(shown), /It was matched as: Sandwich › Deluxe › Step 1: Choose Bread: White\./);
  itemsSave(p.sb, p.row(key), { optionId: 'o-white' });
  assert.equal(lookAgainOf(p.row(key)).lookAgain, false, 'Still right confirms it');
  const again = await orderThrough(p.sb, lines);
  assert.deepEqual(again.lines.map((l) => l.mods[0].optionId), ['o-white', null, null, null]);
});

test('ROUND 6: a round 4 item decision is carried on every sync, not only the first insert', async () => {
  // Round 4 wrote 'exact:pho' for "Pho 大" and staff matched it. ezCater now also sells a plain "Pho".
  const r4 = { location_id: LOC, kind: 'item', ez_key: 'exact:pho', ez_name: `Pho ${BIG}`, ez_ids: ['sA'], synced_at: '2026-09-17T00:00:00.000Z',
    menu_item_id: 'our-pho-l', option_id: null, source: 'manual', matched_by: 'user-1', decided_as: `Pho ${BIG}`, seen_count: 2 };
  const t = TABLES([r4]);
  t.menu_items = [{ id: 'our-pho-l', name: 'Pho Large', location_id: LOC, menu_name: null, pricing: { base: 9 }, archived: false }];
  t.modifier_groups = [];
  let failFirst = true;
  const sb = fakeSb(t, { failUpsert: (name, rows, opts) => {
    if (failFirst && opts?.ignoreDuplicates && rows.some((r) => r.ez_key === K(`Pho ${BIG}`))) { failFirst = false; return { code: '57014', message: 'timeout' }; }
    return null;
  } });
  const menu = [menuOf(item('a', `Pho ${BIG}`, [size('sA', '')]), item('p', 'Pho', [size('sP', '')]))];
  // First sync: the "Pho" entry falls on 'exact:pho' and refreshes its names; the insert of "Pho 大" fails.
  const input = await readMatchInputs(sb, LOC);
  const plan1 = planMenuSync({ entries: flattenMenus(menu), existing: input.links, ourItems: input.ourItems, locationId: LOC, nowIso: NOW, complete: true, menuOk: true });
  const wrote1 = await writeSyncPlan(sb, LOC, plan1, NOW);
  assert.equal(wrote1.errors.length, 1);
  assert.equal(row(sb, K(`Pho ${BIG}`)), undefined);
  assert.equal(row(sb, 'exact:pho').ez_name, 'Pho');
  assert.equal(isEarlierSyncRow(row(sb, 'exact:pho')), false, 'now the current row of "Pho"');
  assert.equal(lookAgainOf(row(sb, 'exact:pho')).lookAgain, true, 'the decision was made for "Pho 大", not "Pho"');
  // Second sync: "Pho 大" is new, and its decision is still found and carried as it was.
  const plan2 = await syncOnce(sb, menu);
  const big = row(sb, K(`Pho ${BIG}`));
  assert.deepEqual([big.menu_item_id, big.source, big.decided_as, lookAgainOf(big).lookAgain], ['our-pho-l', 'manual', `Pho ${BIG}`, false]);
  assert.equal(plan2.counts.carried, 1);
  const lp = await orderThrough(sb, [line(`Pho ${BIG}`, 'sA', null), line('Pho', 'sP', null)]);
  assert.deepEqual(lp.lines.map((l) => l.itemId), ['our-pho-l', null]);
  // A current row whose decision was made for another name is never carried ("Wings" is not "Wings \u{1F336}").
  const wings = { kind: 'item', ez_key: K('Wings'), ez_name: 'Wings', synced_at: NOW, menu_item_id: 'our-w', option_id: null,
    source: 'manual', matched_by: 'u', decided_as: 'Wings' };
  const e = flattenMenus([menuOf(item('c', `Wings ${CHILI}`, [size('sC', '')]))])[0];
  assert.equal(carryOverFor(e, new Map([['item:' + wings.ez_key, wings]])), null);
});

test('ROUND 6: a round 5 option decision is kept for its own item only; a round 5 automatic option link never routes', async () => {
  const r5staff = { kind: 'option', ez_key: 'exact:pizza|size|large', ez_name: 'Large', ez_group: 'Size', ez_item_name: 'Pizza', ez_ids: ['v-pl'],
    synced_at: '2026-09-18T00:00:00.000Z', menu_item_id: null, option_id: 'o-large', source: 'manual', matched_by: 'user-1',
    decided_as: `Pizza ${SEP} Size: Large`, seen_count: 1 };
  // The round 5 repro: an auto link from Salad's Size: Large to our Pizza's option.
  const r5auto = { kind: 'option', ez_key: 'exact:salad|size|large', ez_name: 'Large', ez_group: 'Size', ez_item_name: 'Salad', ez_ids: ['v-sl'],
    synced_at: '2026-09-18T00:00:00.000Z', menu_item_id: null, option_id: 'o-large', source: 'auto', matched_by: 'exact', seen_count: 0 };
  for (const r of [r5staff, r5auto]) {
    assert.equal(isCurrentSyncKey('option', r.ez_key), false);
    assert.equal(isEarlierSyncRow(r), true);
    assert.equal(trustedTarget(r), null);
  }
  const menu = [menuOf(
    item('p', 'Pizza', [size('s-p', '', { customizationTypes: [{ id: 't', name: 'Size', values: [{ id: 'v-pl', name: 'Large' }] }] })]),
    item('s', 'Salad', [size('s-s', '', { customizationTypes: [{ id: 't2', name: 'Size', values: [{ id: 'v-sl', name: 'Large' }] }] })]))];
  const order = (name, sizeId, valueId) => orderItemsToLines([{ uuid: 'o-' + name + valueId, name, menuItemSizeId: sizeId, menuItemSizeName: null, quantity: 1,
    customizations: [{ customizationId: valueId, customizationTypeName: 'Size', name: 'Large', quantity: 1 }] }]);
  const lines = [...order('Pizza', 's-p', 'v-pl'), ...order('Salad', 's-s', 'v-sl')];
  const p = await pipeline({ menus: [menu], ours: [{ id: 'm-pizza', name: 'Pizza' }, { id: 'm-salad', name: 'Salad' }],
    groups: [{ id: 'g', name: 'Size', options: [{ id: 'o-large', name: 'Large' }] }], existing: [r5staff, r5auto], lines });
  const pizza = p.row(OK('Pizza', 'Size', 'Large'));
  assert.deepEqual([pizza.option_id, pizza.source, pizza.decided_as, lookAgainOf(pizza).lookAgain],
    ['o-large', 'manual', decidedAsOf({ kind: 'option', item: 'Pizza', group: 'Size', name: 'Large' }), false]);
  const salad = p.row(OK('Salad', 'Size', 'Large'));
  assert.deepEqual([salad.option_id, salad.source, salad.matched_by], [null, 'auto', null], 'the round 5 auto link is never carried');
  assert.deepEqual(p.out.map((l) => l.mods[0].optionId), ['o-large', null]);
  assert.deepEqual(p.queued.map((l) => l.mods[0].optionId), ['o-large', null]);
  // The earlier rows are never written, and the card lists them apart, read only.
  assert.deepEqual(omit(p.row('exact:pizza|size|large'), COUNTERS), omit({ location_id: LOC, ...r5staff }, COUNTERS));
  const shown = rowsFrom(links(p.sb).map((r) => ({ ...r, look_again: lookAgainOf(r).lookAgain })), { syncReady: true });
  assert.deepEqual(shown.filter((r) => r.kind === 'option' && r.synced).map((r) => r.ezKey).sort(), [OK('Pizza', 'Size', 'Large'), OK('Salad', 'Size', 'Large')].sort());
  assert.equal(isCurrentOptionKey('exact:pizza|size|large'), false);
  assert.equal(isCurrentOptionKey(OK('Pizza', 'Size', 'Large')), true);
  assert.equal(clientReadableDecidedAs(pizza.decided_as), `Pizza ${SEP} Size: Large`);
  // items_list marks an automatic link that routes nothing (auto_idle); the card never shows it as done.
  const idle = { kind: 'item', ez_key: K(`Wings ${CHILI}`), ez_name: `Wings ${CHILI}`, synced_at: NOW, menu_item_id: 'm-w', source: 'auto', matched_by: 'exact' };
  assert.equal(trustedTarget(idle), null);
  assert.equal(toRow({ ...idle, auto_idle: true }, { syncReady: true }).state, 'unmatched');
  assert.equal(toRow({ ...idle, ez_key: K('Wings'), ez_name: 'Wings', auto_idle: false }, { syncReady: true }).state, 'matched');
  const connect = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.match(connect, /const autoIdle = r\?\.source === 'auto' && !!\(r\?\.menu_item_id \|\| r\?\.option_id\) && !trustedTarget\(r\);/);
  // A round 5 decision whose readable text is not this option's (carried from elsewhere): to check again.
  const e = flattenMenus(menu).find((x) => x.kind === 'option' && x.ezItemName === 'Pizza');
  const other = carryOverFor(e, new Map([['option:exact:pizza|size|large', { ...r5staff, decided_as: `Pizza ${SEP} Size: Large Thin` }]]), optionItemsOf(flattenMenus(menu)));
  assert.equal(other.decidedAs, `Pizza ${SEP} Size: Large Thin`);
  assert.equal(shownIdentity('option', other.decidedAs), '', 'never read back from text');
});
