// Multi site menu: last week's sales are read in FULL (18 Oct 2026, v5.11.75).
//
// msm_sold_recently returns a table, so PostgREST's max rows (1,000 on both projects) cuts it with
// no error (reference_postgrest_max_rows_cap). a seven site company had 1,259 sold site and product pairs in
// 7 days, so 259 pairs read as "not sold" and their "sold N times and will come off the till" tick
// vanished. soldRecently now pages the function in a fixed order; a failed page is "could not check
// sales", never an empty list. Ids here are made up; only the counts match the live sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgrestClient } from '@supabase/postgrest-js';
import { createMsmData, salesMap } from './msmData.js';
import { fakeClient } from './fakeClient.js';
import { riskChecks } from './msmRisk.js';
import { demoMsm } from './msmDemo.js';

// The per site counts seen tonight (5 trading sites, 1,259 pairs).
const SIZES = [236, 257, 275, 233, 258];
function soldRows(sizes = SIZES) {
  const rows = [];
  sizes.forEach((n, s) => {
    for (let i = 0; i < n; i++) rows.push({ location_id: `loc-${String(s).padStart(2, '0')}`, venue_item_id: `vi-${s}-${String(i).padStart(4, '0')}`, sold: 1 + (i % 9) });
  });
  // The function has a group by and no order: answer in a scrambled order every time.
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows;
}
const keyOf = (r) => `${r.location_id}|${r.venue_item_id}`;
const fn = (rows) => (args) => ({ data: rows.filter((r) => !args?.p_item_ids || args.p_item_ids.includes(r.venue_item_id)).map((r) => ({ ...r })), error: null });

test('the stand in cuts a function result at 1,000 rows, as PostgREST does', async () => {
  const rows = soldRows();
  const client = fakeClient({}, { rpcs: { msm_sold_recently: fn(rows) } });
  const plain = await client.rpc('msm_sold_recently', { p_menu: 'm', p_days: 7, p_item_ids: null });
  assert.equal(rows.length, 1259);
  assert.equal(plain.data.length, 1000, 'one unpaged call loses rows with no error');
  assert.equal(plain.error, null);
  const jsonb = fakeClient({}, { rpcs: { one: () => ({ data: { on: true }, error: null }) } });
  assert.deepEqual((await jsonb.rpc('one', {})).data, { on: true }, 'a single value comes back as it is');
});

test('soldRecently reads all 1,259 pairs (a seven site company, live size), each once, through the 1,000 row cap', async () => {
  const rows = soldRows();
  const client = fakeClient({}, { rpcs: { msm_sold_recently: fn(rows) } });
  const api = createMsmData({ client });
  const r = await api.soldRecently('m', 7);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1259, `${r.rows.length} of 1259 came back`);
  assert.deepEqual(new Set(r.rows.map(keyOf)), new Set(rows.map(keyOf)));
  assert.equal(new Set(r.rows.map(keyOf)).size, r.rows.length, 'no pair twice');
  assert.equal(client.calls.filter((c) => c.rpc === 'msm_sold_recently').length, 2, 'two pages');
  const m = salesMap(r);
  for (const x of rows) assert.equal(m.get(keyOf(x)), x.sold);
});

// A central menu with one product per sold pair, every one at its own site.
function centralFor(rows) {
  const products = [], productSites = [];
  const sites = [...new Set(rows.map((r) => r.location_id))].map((l) => ({ location_id: l }));
  rows.forEach((r, i) => {
    products.push({ id: `p${i}`, name: `Product ${i}`, archived: false });
    productSites.push({ product_id: `p${i}`, location_id: r.location_id, venue_item_id: r.venue_item_id, active: true });
  });
  return { products, productSites, sites, groups: [], options: [] };
}

test('turning off every product that sold keeps every "will come off the till" tick (1,259, not 1,000)', async () => {
  const rows = soldRows();
  const central = centralFor(rows);
  const changes = central.productSites.map((ps) => ({ target: 'product_site', entity_id: ps.product_id, location_id: ps.location_id, op: 'update', after: { active: false }, before: { active: true } }));
  const api = createMsmData({ client: fakeClient({}, { rpcs: { msm_sold_recently: fn(rows) } }) });
  const sold = salesMap(await api.soldRecently('m', 7));
  const risks = riskChecks(changes, central, sold, null, {}).filter((x) => x.code === 'removes_seller');
  assert.equal(risks.length, 1259, `${risks.length} warnings`);
  assert.ok(risks.every((x) => /sold \d+ times? at .* in the last 7 days and will come off the till/.test(x.words)));
  // The pair that sorts last is past row 1,000 of any order the database picks.
  const last = [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)).at(-1);
  const pid = central.productSites.find((ps) => ps.venue_item_id === last.venue_item_id).product_id;
  assert.ok(risks.some((x) => x.key === `removes_seller|${pid}|${last.location_id}`));
});

test('a page that fails is "could not check sales", never an empty list', async () => {
  const rows = soldRows();
  let n = 0;
  const client = fakeClient({}, { rpcs: { msm_sold_recently: (args) => (++n === 2 ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } : fn(rows)(args)) } });
  const api = createMsmData({ client });
  const r = await api.soldRecently('m', 7);
  assert.equal(r.ok, false);
  assert.deepEqual(r.rows, []);
  assert.equal(salesMap(r), null);
  const central = centralFor(rows.slice(0, 1));
  const risks = riskChecks([{ target: 'product_site', entity_id: 'p0', location_id: rows[0].location_id, op: 'update', after: { active: false }, before: { active: true } }], central, salesMap(r), null, {});
  assert.match(risks[0].words, /We could not check sales, so please check/);
  const none = await createMsmData({ client: null }).soldRecently('m', 7);
  assert.equal(none.ok, false);
});

// The real supabase-js query builder (postgrest-js) against a stand in for PostgREST that applies
// order, offset and LIMIT 1000 the way the live Data API does.
function postgrestStandIn(rows, cap = 1000) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    seen.push(u.search);
    const args = init.body ? JSON.parse(init.body) : {};
    let out = rows.filter((r) => !args.p_item_ids || args.p_item_ids.includes(r.venue_item_id));
    const order = (u.searchParams.get('order') || '').split(',').filter(Boolean).map((o) => o.split('.'));
    if (order.length) out = [...out].sort((a, b) => { for (const [c, dir] of order) { if (a[c] === b[c]) continue; const cmp = String(a[c]) < String(b[c]) ? -1 : 1; return dir === 'desc' ? -cmp : cmp; } return 0; });
    const offset = Number(u.searchParams.get('offset') || 0);
    const limit = Math.min(Number(u.searchParams.get('limit') || Infinity), cap);
    return new Response(JSON.stringify(out.slice(offset, offset + limit)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

test('with the real supabase-js builder: one plain call gets 1,000; soldRecently gets 1,259 of 1,259 in order', async () => {
  const rows = soldRows();
  const s = postgrestStandIn(rows);
  const client = new PostgrestClient('http://stand-in/rest/v1', { fetch: s.fetch });
  const plain = await client.rpc('msm_sold_recently', { p_menu: 'm', p_days: 7, p_item_ids: null });
  assert.equal(plain.data.length, 1000, 'the stand in caps like the Data API');
  s.seen.length = 0;
  const r = await createMsmData({ client }).soldRecently('m', 7);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1259);
  assert.deepEqual(new Set(r.rows.map(keyOf)), new Set(rows.map(keyOf)));
  assert.equal(s.seen.length, 2);
  assert.ok(s.seen.every((q) => /order=location_id\.asc%2Cvenue_item_id\.asc|order=location_id\.asc,venue_item_id\.asc/.test(q)), s.seen.join(' '));
  assert.match(s.seen[1], /offset=1000/);
});

test('bigger companies too: 50 sites with 400 pairs each read whole (20,000 rows, 21 pages)', async () => {
  const rows = soldRows(Array.from({ length: 50 }, () => 400));
  const client = fakeClient({}, { rpcs: { msm_sold_recently: fn(rows) } });
  const r = await createMsmData({ client }).soldRecently('m', 7);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 20000);
  assert.equal(client.calls.length, 21);
});

test('demo mode keeps its made up sales (the demo rpc goes through the same paged read)', async () => {
  const d = demoMsm();
  const r = await d.api.soldRecently('any', 7);
  assert.equal(r.ok, true);
  assert.ok(r.rows.length > 0);
});
