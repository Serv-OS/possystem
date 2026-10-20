// node --test: the Drop 0 edge functions run for real against a stand in database (v5.11.84, multi
// site stock Drop 0, plan 6.2, 4.23, 7.3 step 15 and 9.6). Each index.ts is loaded as it ships: its
// types are stripped by node, the Supabase client import becomes a stand in that answers from plain
// rows, and Deno.serve hands the handler to the test. So the reach rules, the staff PIN rule, the
// stock only snapshot, the nightly run and the venue clock hook are proven by the code that deploys,
// not by reading it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENV = {
  SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  PLATFORM_SUPABASE_URL: 'https://platform.test', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'platform-key',
};

// -- a stand in for supabase-js: enough of the query builder for these functions --
function makeDb({ tables = {}, users = {}, rpc = {} } = {}) {
  const log = [];
  let seq = 0;
  const T = (name) => (tables[name] ||= []);
  function from(table) {
    const st = { op: 'select', filters: [], payload: null, range: null, limit: null, head: false, single: null };
    const match = (r) => st.filters.every(([op, k, v]) => {
      const x = r[k];
      if (op === 'eq') return x === v;
      if (op === 'neq') return x !== v;
      if (op === 'in') return v.includes(x);
      if (op === 'is') return v === null ? x == null : x === v;
      if (op === 'notis') return v === null ? x != null : x !== v;
      if (op === 'gte') return x >= v;
      if (op === 'lt') return x < v;
      if (op === 'like') return String(x ?? '').startsWith(String(v).replace(/%$/, ''));
      return true;
    });
    const run = () => {
      log.push({ table, op: st.op, filters: st.filters.slice(), payload: st.payload });
      if (st.op === 'insert') {
        const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: p.id || `${table}-${++seq}`, ...p }));
        T(table).push(...list);
        return { data: st.single || !Array.isArray(st.payload) ? list[0] : list, error: null };
      }
      let rows = T(table).filter(match);
      if (st.op === 'update') { rows.forEach((r) => Object.assign(r, st.payload)); return { data: rows, error: null }; }
      if (st.op === 'delete') { tables[table] = T(table).filter((r) => !rows.includes(r)); return { data: rows, error: null }; }
      if (st.head) return { data: null, count: rows.length, error: null };
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) rows = rows.slice(0, st.limit);
      if (st.single === 'maybe') return { data: rows[0] || null, error: null };
      if (st.single === 'one') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data: rows, error: null };
    };
    const q = {
      select(cols, opts) { if (st.op === 'select') { st.cols = cols; if (opts?.head) st.head = true; } return q; },
      insert(p) { st.op = 'insert'; st.payload = p; return q; },
      update(p) { st.op = 'update'; st.payload = p; return q; },
      delete() { st.op = 'delete'; return q; },
      eq(k, v) { st.filters.push(['eq', k, v]); return q; },
      neq(k, v) { st.filters.push(['neq', k, v]); return q; },
      in(k, v) { st.filters.push(['in', k, v]); return q; },
      is(k, v) { st.filters.push(['is', k, v]); return q; },
      not(k, op, v) { if (op === 'is') st.filters.push(['notis', k, v]); return q; },
      gte(k, v) { st.filters.push(['gte', k, v]); return q; },
      lt(k, v) { st.filters.push(['lt', k, v]); return q; },
      like(k, v) { st.filters.push(['like', k, v]); return q; },
      order() { return q; },
      limit(n) { st.limit = n; return q; },
      range(a, b) { st.range = [a, b]; return q; },
      maybeSingle() { st.single = 'maybe'; return Promise.resolve(run()); },
      single() { st.single = 'one'; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  }
  return {
    log, tables,
    auth: { getUser: async (token) => ({ data: { user: users[token] || null }, error: users[token] ? null : { message: 'invalid JWT' } }) },
    from,
    rpc: async (name, args) => {
      log.push({ rpc: name, args });
      const f = rpc[name];
      return f ? f(args) : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  };
}

const dbs = {};
globalThis.__edgeTest = {
  createClient: (url) => new Proxy({}, { get: (_t, prop) => (dbs[url] || dbs[ENV.SUPABASE_URL])[prop] }),
};

// Load supabase/functions/<fn>/index.ts as it ships and hand back its Deno.serve handler.
async function loadEdge(fn) {
  const file = path.join(ROOT, 'supabase/functions', fn, 'index.ts');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';", 'const createClient = (...a) => globalThis.__edgeTest.createClient(...a);');
  src = src.replace("import { secondStepRefusal } from '../_shared/second-step.ts';", 'const secondStepRefusal = async () => null;');
  src = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel) => `from '${pathToFileURL(path.resolve(path.dirname(file), rel)).href}'`);
  assert.doesNotMatch(src, /from 'https:/, `${fn}: an import the test cannot stand in for`);
  const out = path.join(os.tmpdir(), `edge-${fn}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  let handler = null;
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  assert.equal(typeof handler, 'function', `${fn}: Deno.serve was not called`);
  return handler;
}

const post = (handler, body, { token = null, headers = {} } = {}) => handler(new Request('https://ops.test/functions/v1/x', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body),
}));
const answer = async (res) => ({ status: res.status, body: await res.json() });

// -- the company (synthetic ids and neutral words only: the repo is public) --
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const L1 = '10000000-0000-4000-8000-000000000001';   // company A
const L2 = '20000000-0000-4000-8000-000000000002';   // company B
const ITEM = '30000000-0000-4000-8000-000000000003';
const COUNT = '40000000-0000-4000-8000-000000000004';
const COUNT_B = '40000000-0000-4000-8000-0000000000b4';
const STAFF = '50000000-0000-4000-8000-000000000005';
const MANAGER_STAFF = '50000000-0000-4000-8000-000000000006';

const USERS = {
  'tok-all': { id: 'u-all' },                         // Stock control all in company A, linked nowhere
  'tok-owner': { id: 'u-owner' },                     // owner of company A, linked nowhere
  'tok-linked': { id: 'u-linked' },                   // manager linked to L1
  'tok-other': { id: 'u-other' },                     // Stock control all in company B
  'tok-dev': { id: 'u-dev', is_anonymous: true },     // a Manager phone paired to L1
  'tok-anon': { id: 'u-anon', is_anonymous: true },   // a customer or till session
};

function opsTables() {
  return {
    locations: [{ id: L1, org_id: A, timezone: 'Europe/London', name: 'Site One' }, { id: L2, org_id: B, timezone: 'America/Los_Angeles', name: 'Site Two' }],
    user_profiles: [
      { id: 'u-all', role: 'manager', org_id: A, stock_control: 'all', full_name: 'Stock Lead' },
      { id: 'u-owner', role: 'owner', org_id: A, stock_control: null, full_name: 'Company Owner' },
      { id: 'u-linked', role: 'manager', org_id: A, stock_control: null, full_name: 'Site Manager' },
      { id: 'u-other', role: 'manager', org_id: B, stock_control: 'all', full_name: 'Other Lead' },
    ],
    user_locations: [{ user_id: 'u-linked', location_id: L1 }],
    ops_devices: [{ id: 'd1', device_uid: 'u-dev', location_id: L1, active: true, claimed_at: '2026-10-01T00:00:00Z' }],
    staff_members: [
      { id: STAFF, location_id: L1, pin: '1111', role: 'staff', name: 'Floor Staff', active: true, permissions: [] },
      { id: MANAGER_STAFF, location_id: L1, pin: '2222', role: 'manager', name: 'Duty Manager', active: true, permissions: [] },
    ],
    stock_counts: [
      { id: COUNT, location_id: L1, status: 'DRAFT', storage_area: 'all', started_at: '2026-10-20T07:00:00Z', name: 'Phone count: whole venue' },
      { id: COUNT_B, location_id: L2, status: 'DRAFT', storage_area: 'all', started_at: '2026-10-20T07:00:00Z', name: 'Phone count: whole venue' },
    ],
    inventory_items: [{ id: ITEM, location_id: L1, name: 'Flour', base_unit: 'g', on_hand: 4, current_cost: 1.5, is_tracked: true, archived_at: null, kind: 'PURCHASED' }],
    stock_count_lines: [],
    wf_timesheets: [],
    wf_time_off: [],
    wf_audit: [],
  };
}

const saveBody = (loc, count) => ({ action: 'stock.count_save', ops_location_id: loc, target_id: count, entries: [{ item_id: ITEM, qty_base: 5, counted_at: new Date().toISOString() }], sent_at: new Date().toISOString() });

let approveFn;
let snapshotFn;
let nightlyFn;
let locationAdminFn;
test('the functions load as they ship', async () => {
  dbs[ENV.SUPABASE_URL] = makeDb({ tables: opsTables(), users: USERS });
  approveFn = await loadEdge('manager-approve');
  snapshotFn = await loadEdge('manager-snapshot');
  nightlyFn = await loadEdge('stock-nightly');
  locationAdminFn = await loadEdge('location-admin');
});

test('manager-approve: a Stock control all login is refused timesheets and time off where it is not linked, and allowed the stock steps', async () => {
  const db = makeDb({ tables: opsTables(), users: USERS });
  dbs[ENV.SUPABASE_URL] = db;
  for (const action of ['timesheet.approve', 'timeoff.decide', 'timesheet.clock_out']) {
    const r = await answer(await post(approveFn, { action, ops_location_id: L1, target_id: 'x', decision: 'approved' }, { token: 'tok-all' }));
    assert.deepEqual([r.status, r.body.error], [403, 'no access to this location'], action);
  }
  const saved = await answer(await post(approveFn, saveBody(L1, COUNT), { token: 'tok-all' }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.ok, saved.body.saved], [true, 1]);
  assert.equal(db.tables.stock_count_lines.length, 1);
  // po.raise passes the fence too (it then asks for a supplier)
  const raise = await answer(await post(approveFn, { action: 'po.raise', ops_location_id: L1, lines: [] }, { token: 'tok-all' }));
  assert.deepEqual([raise.status, raise.body.error], [400, 'Pick a supplier for this order']);
  // never in another company
  const other = await answer(await post(approveFn, saveBody(L2, COUNT_B), { token: 'tok-all' }));
  assert.deepEqual([other.status, other.body.error], [403, 'no access to this location']);
  const otherLead = await answer(await post(approveFn, saveBody(L1, COUNT), { token: 'tok-other' }));
  assert.deepEqual([otherLead.status, otherLead.body.error], [403, 'no access to this location'], 'Stock control all in company B reaches nothing in company A');
});

test('manager-approve: the owner of the company reaches every action at an unlinked site (the owner rule); a linked manager as before', async () => {
  const db = makeDb({ tables: opsTables(), users: USERS });
  dbs[ENV.SUPABASE_URL] = db;
  const owner = await answer(await post(approveFn, { action: 'timesheet.approve', ops_location_id: L1, target_id: 'ts-missing' }, { token: 'tok-owner' }));
  assert.deepEqual([owner.status, owner.body.error], [404, 'timesheet not found for this location'], 'past the fence, then the sheet is looked up');
  const linked = await answer(await post(approveFn, { action: 'timeoff.decide', ops_location_id: L1, target_id: 'to-missing', decision: 'approved' }, { token: 'tok-linked' }));
  assert.deepEqual([linked.status, linked.body.error], [404, 'time-off request not found for this location']);
  const anon = await answer(await post(approveFn, saveBody(L1, COUNT), { token: 'tok-anon' }));
  assert.deepEqual([anon.status, anon.body.error], [403, 'no access to this location'], 'a session that is not a paired phone');
});

test('manager-approve: on a paired phone any staff PIN counts and logs waste; only a manager PIN approves, and the PIN holder is stored', async () => {
  const db = makeDb({
    tables: opsTables(), users: USERS,
    rpc: {
      stock_opening_costs: () => ({ data: {}, error: null }),
      approve_stock_count: ({ p_count_id }) => {
        const c = db.tables.stock_counts.find((x) => x.id === p_count_id);
        c.status = 'APPROVED';
        return { data: { ok: true, posted: 1, total: 1 }, error: null };
      },
      stock_record_waste: () => ({ data: { ok: true, id: 'waste-1' }, error: null }),
    },
  });
  dbs[ENV.SUPABASE_URL] = db;
  const staffSave = await answer(await post(approveFn, { ...saveBody(L1, COUNT), pin: '1111' }, { token: 'tok-dev' }));
  assert.deepEqual([staffSave.status, staffSave.body.saved], [200, 1], JSON.stringify(staffSave.body));
  const areas = await answer(await post(approveFn, { action: 'stock.areas', ops_location_id: L1, target_id: 'areas', pin: '1111' }, { token: 'tok-dev' }));
  assert.equal(areas.status, 200);
  const waste = await answer(await post(approveFn, { action: 'stock.waste', ops_location_id: L1, target_id: ITEM, pin: '1111', qty_base: 2, reason: 'Spilt or dropped' }, { token: 'tok-dev' }));
  assert.deepEqual([waste.status, waste.body.ok], [200, true]);
  assert.ok(db.tables.wf_audit.some((r) => r.action === 'stock.waste' && r.actor_name === 'Floor Staff'), 'waste is audited with the PIN holder');
  // a staff PIN cannot approve a count, sign a timesheet or raise an order
  for (const action of ['stock.count_approve', 'timesheet.approve', 'po.raise']) {
    const r = await answer(await post(approveFn, { action, ops_location_id: L1, target_id: COUNT, pin: '1111' }, { token: 'tok-dev' }));
    assert.deepEqual([r.status, r.body.error], [403, 'not allowed to approve'], action);
  }
  assert.equal(db.tables.stock_counts.find((c) => c.id === COUNT).status, 'DRAFT');
  // a Back Office login with no PIN cannot approve a count either
  const noPin = await answer(await post(approveFn, { action: 'stock.count_approve', ops_location_id: L1, target_id: COUNT }, { token: 'tok-linked' }));
  assert.deepEqual([noPin.status, noPin.body.error], [403, 'PIN required']);
  // a manager PIN approves, through the one database call, and the PIN holder goes on the count
  const ok = await answer(await post(approveFn, { action: 'stock.count_approve', ops_location_id: L1, target_id: COUNT, pin: '2222' }, { token: 'tok-dev' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.approved_by_pin, 'Duty Manager');
  const count = db.tables.stock_counts.find((c) => c.id === COUNT);
  assert.deepEqual([count.status, count.approved_by_staff_id, count.approved_by_staff_name], ['APPROVED', MANAGER_STAFF, 'Duty Manager']);
  assert.ok(db.log.some((x) => x.rpc === 'stock_opening_costs'), 'opening costs asked of the server');
  assert.ok(db.tables.wf_audit.some((r) => r.action === 'stock.count_approve' && r.actor_id === MANAGER_STAFF));
  // a wrong PIN
  const wrong = await answer(await post(approveFn, { action: 'stock.count_save', ops_location_id: L1, target_id: COUNT, pin: '9999', entries: [] }, { token: 'tok-dev' }));
  assert.deepEqual([wrong.status, wrong.body.error], [403, 'PIN not recognised']);
});

test('manager-approve: a first count with no cost is answered so the phone can name the items', async () => {
  const db = makeDb({
    tables: opsTables(), users: USERS,
    rpc: {
      stock_opening_costs: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
      approve_stock_count: () => ({ data: { ok: false, code: 'needs_cost', needs_cost: [{ item_id: ITEM, name: 'Flour' }] }, error: null }),
    },
  });
  dbs[ENV.SUPABASE_URL] = db;
  const r = await answer(await post(approveFn, { action: 'stock.count_approve', ops_location_id: L1, target_id: COUNT, pin: '2222' }, { token: 'tok-dev' }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.code, r.body.needs_cost.map((n) => n.name)], [false, 'needs_cost', ['Flour']]);
  assert.match(r.body.error, /Flour has no cost here yet/);
  assert.equal(db.tables.wf_audit.length, 0, 'nothing approved, nothing audited');
});

test('manager-approve: a receive on a database without stock_receive books nothing (the old cost writer is gone)', async () => {
  const PO = '60000000-0000-4000-8000-000000000006';
  const LINE = '70000000-0000-4000-8000-000000000007';
  const tables = opsTables();
  tables.purchase_orders = [{ id: PO, location_id: L1, status: 'SENT', supplier_id: null, reference: 'PO-1' }];
  tables.po_lines = [{ id: LINE, po_id: PO, location_id: L1, inventory_item_id: ITEM, description: 'Flour', qty_packs: 1, pack_qty: 1, inner_qty: 1000, inner_unit: 'g', unit_price: 2, sort_order: 0 }];
  tables.inventory_item_conversions = [];
  tables.tax_rates = [];
  tables.deliveries = [];
  const db = makeDb({ tables, users: USERS });
  dbs[ENV.SUPABASE_URL] = db;
  const r = await answer(await post(approveFn, { action: 'po.receive', ops_location_id: L1, target_id: PO, pin: '2222', receipts: [{ line_id: LINE, qty_packs: 1, unit_price: 2 }] }, { token: 'tok-dev' }));
  assert.equal(r.status, 503);
  assert.match(r.body.error, /needs a database update\. Nothing was received/);
  assert.ok(!db.log.some((x) => x.rpc === 'post_stock_movement' || x.table === 'item_cost_history' || (x.table === 'inventory_items' && x.op === 'update')), 'no movement, no cost history, no cost written');
  assert.equal(db.tables.purchase_orders[0].status, 'SENT', 'the order stays open');
});

test('manager-snapshot: Stock control all alone gets the stock blocks only; sales, floor, team and Ops are never read', async () => {
  const db = makeDb({ tables: { ...opsTables(), closed_checks: [{ id: 'c1', location_id: L1, closed_at: new Date().toISOString() }] }, users: USERS });
  dbs[ENV.SUPABASE_URL] = db;
  const r = await answer(await post(snapshotFn, { action: 'snapshot', ops_location_id: L1 }, { token: 'tok-all' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.scope, 'stock');
  assert.deepEqual([r.body.money, r.body.floor, r.body.team, r.body.ops], [null, null, null, null]);
  assert.equal(r.body.kitchen.trackedItems, 1);
  for (const t of ['closed_checks', 'wf_timesheets', 'wf_shifts', 'wf_staff', 'active_sessions', 'floor_tables', 'wf_time_off', 'maintenance_requests', 'ops_alerts', 'wf_sales_forecast']) {
    assert.ok(!db.log.some((x) => x.table === t), `${t} was read for a stock only login`);
  }
  // the owner and a linked manager get the whole snapshot
  for (const token of ['tok-owner', 'tok-linked']) {
    dbs[ENV.SUPABASE_URL] = makeDb({ tables: opsTables(), users: USERS });
    const full = await answer(await post(snapshotFn, { action: 'snapshot', ops_location_id: L1 }, { token }));
    assert.equal(full.status, 200, token);
    assert.equal(full.body.scope, 'all');
    assert.ok(full.body.money && full.body.team && Array.isArray(full.body.floor) && full.body.ops, token);
  }
  // a paired phone too
  dbs[ENV.SUPABASE_URL] = makeDb({ tables: opsTables(), users: USERS });
  const phone = await answer(await post(snapshotFn, { action: 'snapshot', ops_location_id: L1 }, { token: 'tok-dev' }));
  assert.equal(phone.body.scope, 'all');
  // Stock control all in another company: refused
  dbs[ENV.SUPABASE_URL] = makeDb({ tables: opsTables(), users: USERS });
  const other = await answer(await post(snapshotFn, { action: 'snapshot', ops_location_id: L1 }, { token: 'tok-other' }));
  assert.equal(other.status, 403);
});

test('manager-snapshot: an archived supplier price is not offered; before 20261021a every price is read, as before', async () => {
  const SUP = '80000000-0000-4000-8000-000000000008';
  const base = () => {
    const t = opsTables();
    t.par_levels = [{ id: 'p1', location_id: L1, inventory_item_id: ITEM, par_level: 10, reorder_point: 5 }];
    t.suppliers = [{ id: SUP, location_id: L1, name: 'Supplier One', delivery_days: null }];
    t.tax_rates = [];
    t.inventory_item_conversions = [];
    t.supplier_products = [
      { id: 'sp-old', location_id: L1, inventory_item_id: ITEM, supplier_id: SUP, pack_qty: 1, inner_qty: 500, inner_unit: 'g', pack_price: 9, is_preferred: true, archived_at: '2026-10-19T00:00:00Z' },
      { id: 'sp-live', location_id: L1, inventory_item_id: ITEM, supplier_id: SUP, pack_qty: 1, inner_qty: 1000, inner_unit: 'g', pack_price: 2, is_preferred: false, archived_at: null },
    ];
    return t;
  };
  dbs[ENV.SUPABASE_URL] = makeDb({ tables: base(), users: USERS });
  const r = await answer(await post(snapshotFn, { action: 'snapshot', ops_location_id: L1 }, { token: 'tok-linked' }));
  assert.equal(r.body.kitchen.items[0].pack.id, 'sp-live');
  // the database before 20261021a: the archived_at filter is an error, so every row is read
  const before = makeDb({ tables: base(), users: USERS });
  const from0 = before.from;
  before.from = (table) => {
    const q = from0(table);
    if (table === 'supplier_products') {
      const is0 = q.is;
      let broken = false;
      q.is = (k, v) => { if (k === 'archived_at') broken = true; return is0(k, v); };
      const then0 = q.then;
      q.then = (res, rej) => (broken ? Promise.resolve({ data: null, error: { code: '42703', message: 'column supplier_products.archived_at does not exist' } }).then(res, rej) : then0(res, rej));
    }
    return q;
  };
  dbs[ENV.SUPABASE_URL] = before;
  const b = await answer(await post(snapshotFn, { action: 'snapshot', ops_location_id: L1 }, { token: 'tok-linked' }));
  assert.equal(b.status, 200);
  assert.equal(b.body.kitchen.items[0].pack.id, 'sp-old', 'the preferred price, as before the migration');
});

test('stock-nightly: only the service role or the cron key starts it; a database without the check refuses', async () => {
  dbs[ENV.SUPABASE_URL] = makeDb({ tables: opsTables() });
  let r = await answer(await post(nightlyFn, { action: 'run' }));
  assert.deepEqual([r.status, r.body.reason], [401, 'no_cron_key']);
  r = await answer(await post(nightlyFn, { action: 'run' }, { headers: { 'x-cron-key': 'k'.repeat(64) } }));
  assert.deepEqual([r.status, r.body.reason], [503, 'needs_database_update']);
  dbs[ENV.SUPABASE_URL] = makeDb({ tables: opsTables(), rpc: { stock_nightly_cron_ok: () => ({ data: false, error: null }) } });
  r = await answer(await post(nightlyFn, { action: 'run' }, { headers: { 'x-cron-key': 'wrong' } }));
  assert.deepEqual([r.status, r.body.reason], [401, 'wrong_cron_key']);
  r = await answer(await post(nightlyFn, { action: 'something' }, { token: ENV.SUPABASE_SERVICE_ROLE_KEY }));
  assert.equal(r.status, 400);
  const anon = await answer(await post(nightlyFn, { action: 'run' }, { token: 'tok-linked' }));
  assert.equal(anon.status, 401, 'a signed in login is not the cron');
});

test('stock-nightly: the clock from the Platform keyed by the Ops id, yesterday\'s day totals for the venues that hold stock, then upkeep', async () => {
  const calls = [];
  const rec = (name, data) => (args) => { calls.push({ name, args }); return { data, error: null }; };
  const ops = makeDb({
    tables: { ...opsTables(), venue_clock: [{ location_id: L1, timezone: 'Europe/London', day_start: '05:00:00' }] },
    rpc: {
      stock_nightly_cron_ok: ({ p_key }) => ({ data: p_key === 'k'.repeat(64), error: null }),
      venue_clock_sync: rec('venue_clock_sync', { ok: true, upserted: 1, mismatches: [], missing: [L2] }),
      stock_day_sums_rebuild: rec('stock_day_sums_rebuild', { ok: true, days: 1, rows: 3 }),
      sales_day_sums_rebuild: rec('sales_day_sums_rebuild', { ok: true, days: 1, rows: 2 }),
      stock_day_sums_check: rec('stock_day_sums_check', { ok: true }),
      sales_day_sums_check: rec('sales_day_sums_check', { ok: true, net_checked: false }),
      stock_nightly_upkeep: rec('stock_nightly_upkeep', { pin_tries_purged: 0, site_items_archived: 0, company_rows_archived: 0 }),
    },
  });
  const platform = makeDb({ tables: { locations: [
    { id: 'c0000000-0000-4000-8000-000000000001', ops_location_id: L1, timezone: 'Europe/London', business_day_start: '05:00:00' },
    { id: 'c0000000-0000-4000-8000-000000000002', ops_location_id: null, timezone: 'Europe/London', business_day_start: null },
    { id: 'c0000000-0000-4000-8000-000000000003', ops_location_id: L2, timezone: null, business_day_start: null },
  ] } });
  dbs[ENV.SUPABASE_URL] = ops;
  dbs[ENV.PLATFORM_SUPABASE_URL] = platform;
  const r = await answer(await post(nightlyFn, { action: 'run' }, { headers: { 'x-cron-key': 'k'.repeat(64) } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body.errors));
  assert.equal(r.body.by, 'cron_key');
  const sync = calls.find((c) => c.name === 'venue_clock_sync');
  assert.deepEqual(sync.args.p_rows, [{ ops_location_id: L1, platform_location_id: 'c0000000-0000-4000-8000-000000000001', timezone: 'Europe/London', business_day_start: '05:00' }]);
  assert.deepEqual(r.body.clock.skipped.map((s) => s.why), ['no_ops_location', 'no_timezone']);
  // only L1 holds stock: one venue rebuilt, on its own clock, the last day that has fully ended
  const rebuilds = calls.filter((c) => c.name === 'stock_day_sums_rebuild');
  assert.equal(rebuilds.length, 1);
  assert.equal(rebuilds[0].args.p_location, L1);
  assert.equal(rebuilds[0].args.p_from, rebuilds[0].args.p_to);
  assert.equal(r.body.days[0].day_start, '05:00');
  assert.equal(r.body.days[0].clock_known, true);
  assert.ok(calls.some((c) => c.name === 'sales_day_sums_rebuild' && c.args.p_location === L1));
  assert.ok(calls.some((c) => c.name === 'stock_day_sums_check' && c.args.p_day === rebuilds[0].args.p_from));
  assert.equal(calls[calls.length - 1].name, 'stock_nightly_upkeep', 'upkeep runs last');
  assert.deepEqual(r.body.clock.missing, [L2]);
});

test('stock-nightly: a failed step is named, the other steps still run', async () => {
  const ops = makeDb({
    tables: opsTables(),
    rpc: {
      venue_clock_sync: () => ({ data: null, error: { message: 'boom' } }),
      stock_day_sums_rebuild: () => ({ data: { ok: true }, error: null }),
      sales_day_sums_rebuild: () => ({ data: null, error: { message: 'statement timeout' } }),
      stock_day_sums_check: () => ({ data: { ok: false }, error: null }),
      sales_day_sums_check: () => ({ data: { ok: true }, error: null }),
      stock_nightly_upkeep: () => ({ data: { pin_tries_purged: 2 }, error: null }),
    },
  });
  dbs[ENV.SUPABASE_URL] = ops;
  dbs[ENV.PLATFORM_SUPABASE_URL] = makeDb({ tables: { locations: [{ id: 'c0000000-0000-4000-8000-000000000001', ops_location_id: L1, timezone: 'Europe/London', business_day_start: null }] } });
  const r = await answer(await post(nightlyFn, { action: 'run' }, { token: ENV.SUPABASE_SERVICE_ROLE_KEY }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.by, 'service_role');
  assert.ok(r.body.errors.some((e) => /venue clock: venue_clock_sync: boom/.test(e)));
  assert.ok(r.body.errors.some((e) => /sales_day_sums_rebuild .* statement timeout/.test(e)));
  assert.ok(r.body.errors.some((e) => /stock_day_sums_check .* totals do not agree/.test(e)));
  assert.deepEqual(r.body.upkeep, { pin_tries_purged: 2 });
  assert.equal(r.body.days[0].clock_known, false, 'no venue_clock row: the Ops timezone and 06:00');
  assert.equal(r.body.days[0].day_start, '06:00');
});

test('location-admin: a saved timezone or day start is sent to the Ops venue clock; any other save is not; a failure never fails the save', async () => {
  const PLAT = 'c0000000-0000-4000-8000-000000000001';
  const run = async (patch, { syncError = null } = {}) => {
    const calls = [];
    dbs[ENV.SUPABASE_URL] = makeDb({ tables: opsTables(), users: USERS, rpc: { venue_clock_sync: (args) => { calls.push(args); return { data: syncError ? null : { ok: true }, error: syncError }; } } });
    dbs[ENV.PLATFORM_SUPABASE_URL] = makeDb({ tables: { locations: [{ id: PLAT, ops_location_id: L1, name: 'Site One', timezone: 'Europe/London', business_day_start: '06:00:00', currency: 'GBP' }] } });
    const r = await answer(await post(locationAdminFn, { action: 'save_location', ops_location_id: L1, patch }, { token: 'tok-linked' }));
    return { r, calls };
  };
  let { r, calls } = await run({ timezone: 'Europe/Dublin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls, [{ p_rows: [{ ops_location_id: L1, platform_location_id: PLAT, timezone: 'Europe/Dublin', business_day_start: '06:00' }] }]);
  ({ r, calls } = await run({ business_day_start: '05:30' }));
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0].p_rows[0].business_day_start, '05:30');
  ({ r, calls } = await run({ currency: 'EUR' }));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0, 'not a clock change');
  ({ r, calls } = await run({ timezone: 'Europe/Paris' }, { syncError: { code: 'PGRST202', message: 'Could not find the function public.venue_clock_sync' } }));
  assert.equal(r.status, 200, 'the Platform save stands');
  assert.equal(r.body.ok, true);
});

test('po-send and xero-bills: the stock reach (link, owner, Stock control all in the venue\'s own company), nothing wider', async () => {
  const poSend = await loadEdge('po-send');
  const xeroBills = await loadEdge('xero-bills');
  // po-send proves the token and the link row with plain HTTP calls under the caller's own token
  const fetch0 = globalThis.fetch;
  try {
    for (const [tok, user, expect] of [['tok-all', USERS['tok-all'], 404], ['tok-owner', USERS['tok-owner'], 404], ['tok-other', USERS['tok-other'], 403]]) {
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith('/auth/v1/user')) return new Response(JSON.stringify(user), { status: 200 });
        if (u.includes('/rest/v1/user_locations')) return new Response('[]', { status: 200 });
        return new Response('{}', { status: 404 });
      };
      dbs[ENV.SUPABASE_URL] = makeDb({ tables: { ...opsTables(), purchase_orders: [], po_lines: [] }, users: USERS });
      const r = await answer(await post(poSend, { po_id: 'po-missing', location_id: L1 }, { token: tok }));
      assert.equal(r.status, expect, `po-send ${tok}: ${JSON.stringify(r.body)}`);
      if (expect === 404) assert.equal(r.body.error, 'PO not found', 'past the fence');
      // xero-bills, a dry run of an invoice that is not there: past the fence it is a 404
      dbs[ENV.SUPABASE_URL] = makeDb({ tables: { ...opsTables(), xero_sync_log: [], supplier_invoices: [] }, users: USERS });
      const x = await answer(await post(xeroBills, { locationId: L1, invoiceId: 'inv-missing', dryRun: true }, { token: tok }));
      assert.equal(x.status, expect, `xero-bills ${tok}: ${JSON.stringify(x.body)}`);
    }
    // a linked manager as before, and a session that is not a login is refused
    dbs[ENV.SUPABASE_URL] = makeDb({ tables: { ...opsTables(), xero_sync_log: [], supplier_invoices: [] }, users: USERS });
    assert.equal((await post(xeroBills, { locationId: L1, invoiceId: 'inv-missing', dryRun: true }, { token: 'tok-linked' })).status, 404);
    assert.equal((await post(xeroBills, { locationId: L1, invoiceId: 'inv-missing', dryRun: true }, { token: 'tok-anon' })).status, 403);
  } finally {
    globalThis.fetch = fetch0;
  }
});
