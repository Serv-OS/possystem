// node --test: the pure rules of the stock-nightly run (supabase/functions/stock-nightly/rules.js,
// v5.11.84, multi site stock Drop 0, plan 7.3 step 15). The run itself is driven end to end in
// stockEdgeRoles.test.js. Drainer release (20261023a, contract 3.5): the run also reads
// stock_drainer_health after upkeep and keeps the answer as drainer_health; that step is driven end
// to end here (index.ts loaded as it ships, node strips the types, the client import is a stand in).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import {
  nightlyAccess, clockRows, clockTime, nightlyDay, mapLimit, isMissingFunction, drainerHealthOf, NIGHTLY_KEY_CHECK, DRAINER_HEALTH,
} from '../../../supabase/functions/stock-nightly/rules.js';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('https://esm.sh/@supabase/supabase-js')) {
      return { url: 'data:text/javascript,export const createClient = (...a) => globalThis.__nightlyClient(...a);', shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const OPS1 = '10000000-0000-4000-8000-000000000001';
const OPS2 = '10000000-0000-4000-8000-000000000002';
const PL1 = 'c0000000-0000-4000-8000-000000000001';
const PL2 = 'c0000000-0000-4000-8000-000000000002';

test('who may start the run: the service role or the right cron key; everything else refuses (fails closed)', () => {
  assert.deepEqual(nightlyAccess({ service: true }), { ok: true, by: 'service_role', status: 200, reason: null });
  assert.deepEqual(nightlyAccess({ key: 'k', check: { data: true, error: null } }), { ok: true, by: 'cron_key', status: 200, reason: null });
  assert.equal(nightlyAccess({}).reason, 'no_cron_key');
  assert.equal(nightlyAccess({ key: 'k', check: { data: false, error: null } }).reason, 'wrong_cron_key');
  assert.equal(nightlyAccess({ key: 'k', check: { data: null, error: null } }).reason, 'wrong_cron_key', 'only a real true lets it in');
  assert.equal(nightlyAccess({ key: 'k', check: { data: 'true', error: null } }).ok, false);
  assert.deepEqual(nightlyAccess({ key: 'k', check: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.stock_nightly_cron_ok' } } }), { ok: false, by: null, status: 503, reason: 'needs_database_update' }, 'before 20261021a: refused, never open');
  assert.equal(nightlyAccess({ key: 'k', check: { data: null, error: { code: '57014', message: 'timeout' } } }).reason, 'cron_key_check_failed');
  assert.equal(nightlyAccess({ key: 'k', check: null }).ok, false);
  assert.equal(isMissingFunction({ code: '42883', message: 'x' }), true);
  assert.equal(isMissingFunction(null), false);
  assert.equal(NIGHTLY_KEY_CHECK, 'stock_nightly_cron_ok');
});

test('the venue clock rows: keyed by the Platform row\'s Ops id, HH:MM day start, no zone guessed, one row per Ops venue', () => {
  const { rows, skipped } = clockRows([
    { id: PL1, ops_location_id: OPS1, timezone: 'Europe/London', business_day_start: '05:00:00' },
    { id: PL2, ops_location_id: OPS2, timezone: ' America/Denver ', business_day_start: null },
    { id: 'c0000000-0000-4000-8000-000000000003', ops_location_id: null, timezone: 'Europe/London', business_day_start: '06:00' },
    { id: 'c0000000-0000-4000-8000-000000000004', ops_location_id: OPS1, timezone: 'Europe/London', business_day_start: '07:00' },
    { id: 'c0000000-0000-4000-8000-000000000005', ops_location_id: '10000000-0000-4000-8000-000000000005', timezone: '', business_day_start: '06:00' },
  ]);
  assert.deepEqual(rows, [
    { ops_location_id: OPS1, platform_location_id: PL1, timezone: 'Europe/London', business_day_start: '05:00' },
    { ops_location_id: OPS2, platform_location_id: PL2, timezone: 'America/Denver', business_day_start: null },
  ]);
  assert.deepEqual(skipped.map((s) => s.why), ['no_ops_location', 'duplicate_ops_location', 'no_timezone']);
  assert.deepEqual(clockRows(null), { rows: [], skipped: [] });
  assert.equal(clockTime('6:30'), '06:30');
  assert.equal(clockTime('23:59:59'), '23:59');
  assert.equal(clockTime('24:00'), null);
  assert.equal(clockTime(''), null);
  assert.equal(clockTime(null), null);
});

test('the day rebuilt is the last one that fully ended on the venue\'s own clock (DST nights included)', () => {
  const at = (iso) => Date.parse(iso);
  // 03:40 UTC on a BST night is 04:40 in London: before the 06:00 start, so 20 Oct is still trading
  assert.deepEqual(nightlyDay(at('2026-10-21T03:40:00Z'), { timezone: 'Europe/London', day_start: '06:00:00' }, null),
    { day: '2026-10-19', timezone: 'Europe/London', day_start: '06:00', clock_known: true });
  // a 03:00 start: 20 Oct ended at 02:00 UTC
  assert.equal(nightlyDay(at('2026-10-21T03:40:00Z'), { timezone: 'Europe/London', day_start: '03:00' }, null).day, '2026-10-20');
  // a US venue: 03:40 UTC is 20:40 the evening before in Los Angeles
  assert.equal(nightlyDay(at('2026-10-21T03:40:00Z'), { timezone: 'America/Los_Angeles', day_start: '06:00' }, null).day, '2026-10-19');
  // no clock row: the Ops timezone and 06:00, said so
  assert.deepEqual(nightlyDay(at('2026-10-21T12:00:00Z'), null, 'Europe/London'), { day: '2026-10-20', timezone: 'Europe/London', day_start: '06:00', clock_known: false });
  // no zone at all, or a zone that is not real: the house default, never the server's own zone
  assert.equal(nightlyDay(at('2026-10-21T12:00:00Z'), null, null).timezone, 'Europe/London');
  assert.equal(nightlyDay(at('2026-10-21T12:00:00Z'), { timezone: 'Mars/Base', day_start: '06:00' }, null).timezone, 'Europe/London');
  // the UK clocks go back on 25 Oct (02:00 BST to 01:00 GMT) and the US on 1 Nov: one day each
  assert.equal(nightlyDay(at('2026-10-26T03:40:00Z'), { timezone: 'Europe/London', day_start: '06:00' }, null).day, '2026-10-24');
  assert.equal(nightlyDay(at('2026-10-26T07:00:00Z'), { timezone: 'Europe/London', day_start: '06:00' }, null).day, '2026-10-25');
  assert.equal(nightlyDay(at('2026-11-02T15:00:00Z'), { timezone: 'America/Denver', day_start: '06:00' }, null).day, '2026-11-01');
});

test('mapLimit keeps order, runs a few at a time, and turns one failure into an error row', async () => {
  let running = 0, most = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    if (n === 4) throw new Error('four');
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, { error: 'four' }, 50, 60, 70]);
  assert.ok(most <= 3, `${most} at once`);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});

test('the run calls the contract functions with the contract arguments, and writes nothing directly (source)', () => {
  const src = read('supabase/functions/stock-nightly/index.ts');
  assert.match(src, /await ops\.rpc\(NIGHTLY_KEY_CHECK, \{ p_key: key \}\)/);
  assert.match(src, /call\('venue_clock_sync', \{ p_rows: rows \}\)/);
  assert.match(src, /\['stock', 'stock_day_sums_rebuild'\], \['sales', 'sales_day_sums_rebuild'\]/);
  assert.match(src, /call\(fn, \{ p_location: v\.id, p_from: d\.day, p_to: d\.day \}\)/);
  assert.match(src, /call\(fn, \{ p_location: v\.id, p_day: d\.day \}\)/);
  assert.match(src, /call\('stock_nightly_upkeep'\)/);
  assert.match(src, /plat\.from\('locations'\)\.select\('id, ops_location_id, timezone, business_day_start'\)/);
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete)\(/, 'every write is a database function');
  assert.doesNotMatch(src, /secondStepRefusal/, 'not a login function: the cron key is its fence');
  assert.match(src, /--no-verify-jwt/, 'the deploy line says no JWT (pg_net sends only the key)');
  // every list read pages past the 1,000 row cap
  for (const what of ['Platform locations', 'venues', 'venue clocks']) assert.match(src, new RegExp(`pagedRows\\('${what}'`), what);
});

// -- drainer release (20261023a): the drainer's health in the run summary --------------------

test('drainerHealthOf: the answer as given, { missing: true } before 20261023a, any other failure kept as words', () => {
  assert.equal(DRAINER_HEALTH, 'stock_drainer_health');
  const answer = { ok: true, at: '2026-10-24T03:41:00Z', venues: [{ location_id: OPS1, mode: 'central', dead: 0 }] };
  assert.equal(drainerHealthOf({ data: answer, error: null }), answer, 'the database answer itself, untouched');
  const notOk = { ok: false, at: '2026-10-24T03:41:00Z', venues: [{ location_id: OPS1, dead: 2 }] };
  assert.deepEqual(drainerHealthOf({ data: notOk }), notOk, 'an unhealthy answer is kept as it is');
  assert.deepEqual(drainerHealthOf({ error: { code: 'PGRST202', message: 'Could not find the function public.stock_drainer_health without parameters in the schema cache' } }), { missing: true });
  assert.deepEqual(drainerHealthOf({ error: { code: '42883', message: 'function public.stock_drainer_health() does not exist' } }), { missing: true });
  assert.deepEqual(drainerHealthOf({ error: { code: '57014', message: 'canceling statement due to statement timeout' } }),
    { error: 'stock_drainer_health: canceling statement due to statement timeout', code: '57014' });
  assert.deepEqual(drainerHealthOf({ error: { code: '42501' } }), { error: 'stock_drainer_health: 42501', code: '42501' });
  for (const data of [null, undefined, [], 'ok', 7]) {
    assert.deepEqual(drainerHealthOf({ data }), { error: 'stock_drainer_health: no answer', code: null }, String(data));
  }
  assert.deepEqual(drainerHealthOf(), { error: 'stock_drainer_health: no answer', code: null });
});

test('the run reads the drainer health after upkeep, with its own service role client (source)', () => {
  const src = read('supabase/functions/stock-nightly/index.ts');
  const upkeep = src.indexOf("call('stock_nightly_upkeep')");
  const health = src.indexOf('await ops.rpc(DRAINER_HEALTH)');
  assert.ok(upkeep > 0 && health > upkeep, 'health is read after upkeep');
  assert.ok(health < src.indexOf('summary.ok = errors.length === 0'), 'and before the summary is closed');
  assert.match(src, /const ops = createClient\(SUPABASE_URL, SERVICE_ROLE,/, 'ops is the service role client');
  assert.match(src, /summary\.drainer_health = drainerHealthOf\(\{ data, error \}\)/);
  const step = src.slice(health, src.indexOf('summary.ok = errors.length === 0'));
  assert.doesNotMatch(step, /errors\.push/, 'the health step never adds to errors');
});

// The run end to end: index.ts as it ships, against stand in databases.
const ENV = {
  SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  PLATFORM_SUPABASE_URL: 'https://platform.test', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'platform-key',
};
const missing = (name) => ({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} without parameters in the schema cache` } });

function fakeDb({ tables = {}, rpc = {} } = {}) {
  const log = [];
  const from = (table) => {
    const st = { filters: [], range: null, limit: null };
    const run = () => {
      log.push({ table });
      let rows = (tables[table] || []).filter((r) => st.filters.every((f) => f(r)));
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) rows = rows.slice(0, st.limit);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const q = {
      select() { return q; },
      order() { return q; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return q; },
      in(k, v) { st.filters.push((r) => v.includes(r[k])); return q; },
      limit(n) { st.limit = n; return q; },
      range(a, b) { st.range = [a, b]; return q; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return q;
  };
  return {
    log, from,
    rpc: async (name, args) => {
      log.push({ rpc: name, args });
      const f = rpc[name];
      return f ? f(args) : missing(name);
    },
  };
}

const dbs = {};
const clients = [];
let nightly;
async function loadNightly() {
  if (nightly) return nightly;
  globalThis.__nightlyClient = (url, key) => {
    clients.push({ url, key });
    return new Proxy({}, { get: (_t, prop) => dbs[url][prop] });
  };
  globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { nightly = h; } };
  await import('../../../supabase/functions/stock-nightly/index.ts');
  assert.equal(typeof nightly, 'function', 'Deno.serve was called');
  return nightly;
}

const OPS_TABLES = {
  locations: [{ id: OPS1, timezone: 'Europe/London' }, { id: OPS2, timezone: 'America/Denver' }],
  inventory_items: [{ id: 'inv-1', location_id: OPS1 }],
  venue_clock: [{ location_id: OPS1, timezone: 'Europe/London', day_start: '06:00:00' }],
};
const PLATFORM_TABLES = { locations: [{ id: PL1, ops_location_id: OPS1, timezone: 'Europe/London', business_day_start: '06:00:00' }] };
const HEALTHY_STEPS = {
  venue_clock_sync: () => ({ data: { ok: true, upserted: 1, mismatches: [], missing: [] }, error: null }),
  stock_day_sums_rebuild: () => ({ data: { ok: true, days: 1, rows: 3 }, error: null }),
  sales_day_sums_rebuild: () => ({ data: { ok: true, days: 1, rows: 2 }, error: null }),
  stock_day_sums_check: () => ({ data: { ok: true }, error: null }),
  sales_day_sums_check: () => ({ data: { ok: true, net_checked: true }, error: null }),
  stock_nightly_upkeep: () => ({ data: { pin_tries_purged: 0, site_items_archived: 0, company_rows_archived: 0 }, error: null }),
};

async function runNightly(rpc) {
  const handler = await loadNightly();
  const ops = fakeDb({ tables: OPS_TABLES, rpc: { ...HEALTHY_STEPS, ...rpc } });
  dbs[ENV.SUPABASE_URL] = ops;
  dbs[ENV.PLATFORM_SUPABASE_URL] = fakeDb({ tables: PLATFORM_TABLES });
  const log0 = console.log;
  console.log = (...a) => { if (!String(a[0]).startsWith('[stock-nightly]')) log0(...a); };   // the run's one summary line
  let res;
  try {
    res = await handler(new Request('https://ops.test/functions/v1/stock-nightly', {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` }, body: JSON.stringify({ action: 'run' }),
    }));
  } finally { console.log = log0; }
  const rpcs = ops.log.filter((x) => x.rpc).map((x) => x.rpc);
  return { status: res.status, body: await res.json(), rpcs, log: ops.log };
}

test('the run keeps the drainer health answer as drainer_health, read once after upkeep with the service role', async () => {
  const answer = { ok: true, at: '2026-10-24T03:41:00Z', venues: [{ location_id: OPS1, mode: 'central', pending: 0, held: 0, dead: 0 }] };
  const asked = [];
  const r = await runNightly({ stock_drainer_health: (args) => { asked.push(args); return { data: answer, error: null }; } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body.errors));
  assert.deepEqual(r.body.drainer_health, answer);
  assert.deepEqual(r.rpcs.filter((n) => n === DRAINER_HEALTH), [DRAINER_HEALTH], 'asked once');
  assert.equal(r.rpcs.indexOf(DRAINER_HEALTH), r.rpcs.indexOf('stock_nightly_upkeep') + 1, 'straight after upkeep');
  assert.equal(asked[0]?.p_location, undefined, 'every venue (no venue named)');
  // the client the health is read with is the Ops one, made with the service role key
  assert.ok(clients.some((c) => c.url === ENV.SUPABASE_URL && c.key === ENV.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(!clients.some((c) => c.url === ENV.SUPABASE_URL && c.key !== ENV.SUPABASE_SERVICE_ROLE_KEY), 'no other Ops client');
});

test('an unhealthy drainer answer is kept as it is and does not fail the run', async () => {
  const answer = { ok: false, at: '2026-10-24T03:41:00Z', venues: [{ location_id: OPS1, dead: 3, repair_failing: 1 }] };
  const r = await runNightly({ stock_drainer_health: () => ({ data: answer, error: null }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.errors, []);
  assert.deepEqual(r.body.drainer_health, answer);
});

test('before 20261023a runs (PGRST202 or 42883) the summary says { missing: true } and the run is still ok', async () => {
  let r = await runNightly({});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.drainer_health, { missing: true });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.errors, []);
  r = await runNightly({ stock_drainer_health: () => ({ data: null, error: { code: '42883', message: 'function public.stock_drainer_health() does not exist' } }) });
  assert.deepEqual(r.body.drainer_health, { missing: true });
  assert.equal(r.body.ok, true);
});

test('any other health failure is recorded in the summary and never fails the run', async () => {
  let r = await runNightly({ stock_drainer_health: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, 'the run is not failed by a health read');
  assert.deepEqual(r.body.errors, []);
  assert.deepEqual(r.body.drainer_health, { error: 'stock_drainer_health: canceling statement due to statement timeout', code: '57014' });
  r = await runNightly({ stock_drainer_health: () => { throw new Error('network down'); } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.drainer_health.error, /network down/);
  // the other steps failing does not stop the health read either
  r = await runNightly({
    stock_nightly_upkeep: () => ({ data: null, error: { message: 'boom' } }),
    stock_drainer_health: () => ({ data: { ok: true, venues: [] }, error: null }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, 'upkeep failed, so the run says so');
  assert.ok(r.body.errors.some((e) => /upkeep: stock_nightly_upkeep: boom/.test(e)));
  assert.deepEqual(r.body.drainer_health, { ok: true, venues: [] }, 'the health is still read and kept');
});
