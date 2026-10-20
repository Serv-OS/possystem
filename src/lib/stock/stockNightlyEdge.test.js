// node --test: the pure rules of the stock-nightly run (supabase/functions/stock-nightly/rules.js,
// v5.11.84, multi site stock Drop 0, plan 7.3 step 15). The run itself is driven end to end in
// stockEdgeRoles.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { nightlyAccess, clockRows, clockTime, nightlyDay, mapLimit, isMissingFunction, NIGHTLY_KEY_CHECK } from '../../../supabase/functions/stock-nightly/rules.js';

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
