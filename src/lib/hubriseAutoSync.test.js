// hubriseAutoSync.test.js: the HubRise catalog push the Back Office button and the reconcile run
// share (supabase/functions/_shared/hubrise-catalog.ts, v5.11.81), run end to end against a fake
// database and a fake HubRise. Run: node --test src/lib/hubriseAutoSync.test.js
//
//   - a push reads every menu row (paged past 1,000) and sends the catalog once, then the inventory
//   - it records what it sent (catalog_payload_key) and the menu it sent (the fingerprint)
//   - the automatic run sends NOTHING when the catalog would be the same, and sends a changed one
//   - a product off for Delivery is not on the platforms

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushCatalog } from '../../supabase/functions/_shared/hubrise-catalog.ts';
import { catalogPayloadKey } from '../../supabase/functions/_shared/hubriseAutoSync.js';

const LOC = 'loc-1';

function fakeDb(tables, { fingerprint = 'fp-1' } = {}) {
  const updates = [];
  const from = (name) => {
    const st = { name, filters: [], range: null, single: false, patch: null };
    const rows = () => (tables[name] || []).filter((r) => st.filters.every(([op, k, v]) => (
      op === 'eq' ? String(r[k]) === String(v) : op === 'in' ? v.map(String).includes(String(r[k])) : op === 'lte' ? Number(r[k]) <= v : true)));
    const run = () => {
      if (st.patch) {
        for (const r of rows()) Object.assign(r, st.patch);
        updates.push({ table: name, patch: st.patch });
        return { data: null, error: null };
      }
      let out = rows();
      if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      else out = out.slice(0, 1000);   // the Data API's cap
      if (st.single) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(k, v) { st.filters.push(['eq', k, v]); return q; },
      in(k, v) { st.filters.push(['in', k, v]); return q; },
      lte(k, v) { st.filters.push(['lte', k, v]); return q; },
      range(a, b) { st.range = [a, b]; return Promise.resolve(run()); },
      maybeSingle() { st.single = true; return Promise.resolve(run()); },
      update(p) { st.patch = p; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  };
  return { from, rpc: async (fn) => (fn === 'hubrise_menu_fingerprint' ? { data: fingerprint, error: null } : { data: null, error: { message: 'no' } }), updates, tables };
}

function fakeHubRise() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 'cat-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const conn = (extra = {}) => ({ location_id: LOC, status: 'connected', access_token: 'tok', hubrise_catalog_id: 'cat-1',
  hubrise_location_name: 'Venue', currency: 'GBP', menu_ids: [], catalog_image_ids: {}, catalog_pushed_at: '2026-10-01T00:00:00Z', ...extra });

const menu = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${String(i).padStart(4, '0')}`, location_id: LOC, name: `Item ${i}`, cat: 'c1', pricing: { base: 2 } }));

test('a push reads every row past 1,000, sends the catalog once and records what it sent', async () => {
  const calls = fakeHubRise();
  const db = fakeDb({
    hubrise_connections: [conn()], menu_categories: [{ id: 'c1', location_id: LOC, label: 'Food' }],
    menu_items: [...menu(1500), { id: 'hide', location_id: LOC, name: 'Ice cream', cat: 'c1', pricing: { base: 3 }, visibility: { onlineDelivery: false } }],
    modifier_groups: [], config_pushes: [], tax_rates: [], eighty_six: [{ location_id: LOC, item_id: 'i0001' }], stock_levels: [],
  });
  const out = await pushCatalog(db, LOC);
  assert.equal(out.products, 1500, 'every row, and not the product off for Delivery');
  const puts = calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/catalogs/cat-1'));
  assert.equal(puts.length, 1);
  assert.ok(!puts[0].body.data.products.some((p) => p.ref === 'hide'), 'off for Delivery: not on the platforms');
  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/location/inventory')), 'the inventory follows the catalog');
  const row = db.tables.hubrise_connections[0];
  assert.equal(row.catalog_payload_key, catalogPayloadKey(puts[0].body.data));
  assert.equal(row.catalog_fingerprint, 'fp-1');
  assert.equal(row.menu_fingerprint, 'fp-1');
  assert.deepEqual(row.inventory_ids, ['i0001']);
});

test('the automatic run sends nothing when the catalog would be the same, and a changed one when it is not', async () => {
  let calls = fakeHubRise();
  const tables = {
    hubrise_connections: [conn()], menu_categories: [{ id: 'c1', location_id: LOC, label: 'Food' }], menu_items: menu(3),
    modifier_groups: [], config_pushes: [], tax_rates: [], eighty_six: [], stock_levels: [],
  };
  await pushCatalog(fakeDb(tables), LOC);   // the first push (Push menu)
  calls = fakeHubRise();
  const same = await pushCatalog(fakeDb(tables, { fingerprint: 'fp-2' }), LOC, false, { onlyIfChanged: true });
  assert.equal(same.unchanged, true);
  assert.equal(calls.length, 0, 'not one call to HubRise');
  assert.equal(tables.hubrise_connections[0].catalog_fingerprint, 'fp-2', 'the menu is recorded as on HubRise');
  tables.menu_items[0].pricing = { base: 9 };
  calls = fakeHubRise();
  const changed = await pushCatalog(fakeDb(tables, { fingerprint: 'fp-3' }), LOC, false, { onlyIfChanged: true });
  assert.notEqual(changed.unchanged, true);
  assert.equal(calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/catalogs/cat-1')).length, 1, 'the new price is sent once');
  assert.equal(tables.hubrise_connections[0].catalog_fingerprint, 'fp-3');
});

test('a push never sends a half read 86 list (a failed read is an error, not "nothing is sold out")', async () => {
  fakeHubRise();
  const { outOfStockIds } = await import('../../supabase/functions/_shared/hubrise-ingest.ts');
  const db = fakeDb({ eighty_six: [{ location_id: LOC, item_id: 'a' }], stock_levels: [{ location_id: LOC, item_id: 'b', remaining: 0 }, { location_id: LOC, item_id: 'c', remaining: 4 }] });
  assert.deepEqual([...(await outOfStockIds(db, LOC))].sort(), ['a', 'b']);
  const broken = { from: () => ({ select() { return this; }, eq() { return this; }, lte() { return this; }, limit() { return Promise.resolve({ data: null, error: { message: 'timeout' } }); } }) };
  await assert.rejects(() => outOfStockIds(broken, LOC), /could not be read/);
});
