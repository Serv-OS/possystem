// Multi site menu: the Menu Manager lock lists are read in FULL (18 Oct 2026, v5.11.75).
//
// msm_managed_items and msm_managed_groups return a table, so PostgREST's max rows (1,000 on both
// projects) cut them with no error (reference_postgrest_max_rows_cap), the same fault class as
// msm_sold_recently (msmSoldCap.test.js). A site selling more than 1,000 of the group menu's
// products showed every product past the first 1,000 UNLOCKED in Menu Manager, the lock count read
// 1,000, and the store's isMsmManaged() let the site edit head office fields there. Both reads now
// page in a fixed order (the venue id is unique at a site, so the pages are exact); a failed page is
// null (Menu Manager behaves as today), never a shorter list. Ids here are made up; the sizes are
// the scale target (2,000 of the group's products sold at one site), well past tonight's biggest
// site (534 managed products).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgrestClient } from '@supabase/postgrest-js';
import { createMsmData } from './msmData.js';
import { fakeClient } from './fakeClient.js';
import { loadMsmManaged, isMsmManaged, isMsmManagedGroup, msmManagedState, setMsmManaged } from './msmManaged.js';

const LOC = 'loc-00';
const pad = (i) => String(i).padStart(5, '0');
// The functions have no order of their own: answer in a scrambled order every time.
function scramble(rows) {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows;
}
const itemRows = (n) => scramble(Array.from({ length: n }, (_, i) => ({ venue_item_id: `vi-${pad(i)}`, product_id: `p-${pad(i)}`, kept: i % 3 ? [] : ['price'] })));
const groupRows = (n) => scramble(Array.from({ length: n }, (_, i) => ({ venue_group_id: `vg-${pad(i)}`, group_id: `g-${pad(i)}`, kept: [], option_ids: [`vo-${pad(i)}-a`, `vo-${pad(i)}-b`] })));
const fn = (rows) => (args) => (args?.p_location === LOC ? { data: rows.map((r) => ({ ...r })), error: null } : { data: [], error: null });
const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

test('the stand in cuts msm_managed_items and msm_managed_groups at 1,000 rows, as PostgREST does', async () => {
  const client = fakeClient({}, { rpcs: { msm_managed_items: fn(itemRows(2000)), msm_managed_groups: fn(groupRows(1200)) } });
  const items = await client.rpc('msm_managed_items', { p_location: LOC });
  const groups = await client.rpc('msm_managed_groups', { p_location: LOC });
  assert.equal(items.data.length, 1000, 'one unpaged call loses products with no error');
  assert.equal(groups.data.length, 1000, 'one unpaged call loses groups with no error');
  assert.equal(items.error, null);
  assert.equal(groups.error, null);
});

test('managedItems reads all 2,000 managed products at one site, each once (two full pages and an empty one that says that is all)', async () => {
  const rows = itemRows(2000);
  const client = fakeClient({}, { rpcs: { msm_managed_items: fn(rows) } });
  const m = await createMsmData({ client }).managedItems(LOC);
  assert.ok(m instanceof Map);
  assert.equal(m.size, 2000, `${m.size} of 2000 came back`);
  assert.deepEqual(new Set(m.keys()), new Set(rows.map((r) => r.venue_item_id)));
  assert.deepEqual(m.get('vi-00999'), { productId: 'p-00999', kept: ['price'] });
  assert.deepEqual(m.get('vi-01999'), { productId: 'p-01999', kept: [] }, 'the last product, past row 1,000 of any order');
  // A full page cannot say whether more follow, so exactly 2,000 rows is 2 full pages and 1 empty.
  assert.equal(client.calls.filter((c) => c.rpc === 'msm_managed_items').length, 3, 'two full pages and one empty page');
  assert.ok(client.calls.every((c) => c.args.p_location === LOC), 'every page asks for the same site');
});

test('managedGroups reads all 1,200 managed option groups at one site, with their option ids, in 2 pages', async () => {
  const rows = groupRows(1200);
  const client = fakeClient({}, { rpcs: { msm_managed_groups: fn(rows) } });
  const m = await createMsmData({ client }).managedGroups(LOC);
  assert.ok(m instanceof Map);
  assert.equal(m.size, 1200, `${m.size} of 1200 came back`);
  assert.deepEqual(new Set(m.keys()), new Set(rows.map((r) => r.venue_group_id)));
  assert.deepEqual(m.get('vg-01199'), { groupId: 'g-01199', kept: [], optionIds: ['vo-01199-a', 'vo-01199-b'] });
  assert.equal(client.calls.filter((c) => c.rpc === 'msm_managed_groups').length, 2, 'two pages');
});

test('a small site (534 managed products, tonight\'s biggest) is one page and the same Map as before', async () => {
  const rows = itemRows(534);
  const client = fakeClient({}, { rpcs: { msm_managed_items: fn(rows) } });
  const m = await createMsmData({ client }).managedItems(LOC);
  assert.equal(m.size, 534);
  assert.equal(client.calls.length, 1, 'one page');
  assert.deepEqual(m.get('vi-00000'), { productId: 'p-00000', kept: ['price'] });
});

test('a page that fails gives null for both (Menu Manager behaves as today), never 1,000 of 2,000', async () => {
  let ni = 0, ng = 0;
  const client = fakeClient({}, { rpcs: {
    msm_managed_items: (args) => (++ni === 2 ? { data: null, error: TIMEOUT } : fn(itemRows(2000))(args)),
    msm_managed_groups: (args) => (++ng === 2 ? { data: null, error: TIMEOUT } : fn(groupRows(1200))(args)),
  } });
  const api = createMsmData({ client });
  assert.equal(await api.managedItems(LOC), null, 'a failed second page is null, not the first 1,000');
  assert.equal(await api.managedGroups(LOC), null);
  // Not installed (the function is missing), switched off (an empty table) and no site: as before.
  const missing = createMsmData({ client: fakeClient({}) });
  assert.equal(await missing.managedItems(LOC), null);
  assert.equal(await missing.managedGroups(LOC), null);
  const off = createMsmData({ client: fakeClient({}, { rpcs: { msm_managed_items: () => ({ data: [], error: null }) } }) });
  assert.equal((await off.managedItems(LOC)).size, 0);
  assert.equal(await api.managedItems(null), null);
  assert.equal(await createMsmData({ client: null }).managedItems(LOC), null);
  // The store with a null list: nothing locked, as today.
  setMsmManaged(LOC, null, null);
  assert.equal(msmManagedState().ids.size, 0);
  assert.equal(isMsmManaged('vi-00001'), false);
});

test('the store gate sees every one of 2,000 managed products and 1,200 groups (the lock count and isMsmManaged)', async () => {
  const client = fakeClient({}, { rpcs: {
    msm_managed_items: fn(itemRows(2000)),
    msm_managed_groups: fn(groupRows(1200)),
    msm_managed_at: () => ({ data: { on: true, groups: [], items: [] }, error: null }),
  } });
  await loadMsmManaged(createMsmData({ client }), LOC);
  const s = msmManagedState();
  assert.equal(s.locationId, LOC);
  assert.equal(s.ids.size, 2000, 'the lock count Menu Manager shows');
  assert.equal(s.groups.size, 1200);
  assert.equal(isMsmManaged('vi-00999'), true);
  assert.equal(isMsmManaged('vi-01999'), true, 'product 2,000 is head office\'s too: the site cannot edit its fields');
  assert.equal(isMsmManagedGroup('vg-01199'), true);
  assert.deepEqual(s.kept.get('vi-00999'), ['price']);
  assert.deepEqual([...s.groupOptions.get('vg-01199')], ['vo-01199-a', 'vo-01199-b']);
  assert.equal(isMsmManaged('vi-02000'), false, 'a product the group menu does not manage stays the site\'s own');
  setMsmManaged(null, null, null);
});

// The real supabase-js query builder (postgrest-js) against a stand in for PostgREST that applies
// order, offset and LIMIT 1000 the way the live Data API does to a function that returns a table.
function postgrestStandIn(byFn, cap = 1000) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const name = u.pathname.split('/').pop();
    seen.push(`${name}${u.search}`);
    const args = init.body ? JSON.parse(init.body) : {};
    let out = (byFn[name] || (() => []))(args);
    const order = (u.searchParams.get('order') || '').split(',').filter(Boolean).map((o) => o.split('.'));
    if (order.length) out = [...out].sort((a, b) => { for (const [c, dir] of order) { if (a[c] === b[c]) continue; const cmp = String(a[c]) < String(b[c]) ? -1 : 1; return dir === 'desc' ? -cmp : cmp; } return 0; });
    const offset = Number(u.searchParams.get('offset') || 0);
    const limit = Math.min(Number(u.searchParams.get('limit') || Infinity), cap);
    return new Response(JSON.stringify(out.slice(offset, offset + limit)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

test('with the real supabase-js builder: one plain call gets 1,000; managedItems and managedGroups get every row, in order', async () => {
  const items = itemRows(2000), groups = groupRows(1200);
  const s = postgrestStandIn({
    msm_managed_items: (a) => (a.p_location === LOC ? items : []),
    msm_managed_groups: (a) => (a.p_location === LOC ? groups : []),
  });
  const client = new PostgrestClient('http://stand-in/rest/v1', { fetch: s.fetch });
  const plain = await client.rpc('msm_managed_items', { p_location: LOC });
  assert.equal(plain.data.length, 1000, 'the stand in caps like the Data API');
  s.seen.length = 0;
  const api = createMsmData({ client });
  const m = await api.managedItems(LOC);
  assert.equal(m.size, 2000);
  assert.deepEqual(new Set(m.keys()), new Set(items.map((r) => r.venue_item_id)));
  assert.equal(s.seen.length, 3, 'two full pages and the empty one that says that is all');
  assert.ok(s.seen.every((q) => /order=venue_item_id\.asc/.test(q)), s.seen.join(' '));
  assert.match(s.seen[1], /offset=1000/);
  assert.match(s.seen[2], /offset=2000/);
  s.seen.length = 0;
  const g = await api.managedGroups(LOC);
  assert.equal(g.size, 1200);
  assert.equal(s.seen.length, 2);
  assert.ok(s.seen.every((q) => /order=venue_group_id\.asc/.test(q)), s.seen.join(' '));
  assert.match(s.seen[1], /offset=1000/);
});
