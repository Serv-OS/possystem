/**
 * reportsData.test.js: createStockReportsApi, the one way the Stock and GP screens talk to the
 * database (v5.11.92, multi site stock Drop 4a, contract 2.1). Run: npm test.
 *
 * A stand in client records every call: each method names its function and sends exactly the
 * contract's arguments; a missing function is needsUpdate with the NEEDS_UPDATE words (never a
 * figure of its own); allPages follows `next` until null or the cap; pollExport stops on a finished
 * job; the download URL is the edge function's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStockReportsApi, pollExport, finishedExport, functionsBaseOf, REPORT_PAGE } from './reportsData.js';
import { NEEDS_UPDATE } from './saveRules.js';

const ORG = 'b1000000-0000-4000-8000-000000000001';
const L1 = 'a1000000-0000-4000-8000-000000000001';
const L2 = 'a1000000-0000-4000-8000-000000000002';
const JOB = 'd1000000-0000-4000-8000-000000000001';

/** rpc answers by function name (a value or a function of the args), and table answers by table. */
function fakeClient({ rpc = {}, tables = {}, supabaseUrl = 'https://example.supabase.co' } = {}) {
  const calls = [];
  const queries = [];
  const builder = (table) => {
    const q = { table, steps: [] };
    queries.push(q);
    const answer = () => {
      const a = tables[table];
      if (a === undefined) return { data: [], error: null };
      return typeof a === 'function' ? a(q) : a;
    };
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(answer()).then(res, rej);
        return (...args) => { q.steps.push([prop, ...args]); return chain; };
      },
    });
    return chain;
  };
  return {
    calls, queries, supabaseUrl,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const a = rpc[fn];
      if (a === undefined) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
      return typeof a === 'function' ? a(args) : a;
    },
    from: (t) => builder(t),
  };
}

const ANSWER = { data: { meta: { report: 'gap', columns: [] }, totals: [{ location_id: L1 }], rows: [], next: null }, error: null };

test('report: stock_report_<name> with the seven arguments, the cap on p_limit', async () => {
  const c = fakeClient({ rpc: { stock_report_gap: ANSWER, stock_report_dashboard: ANSWER } });
  const api = createStockReportsApi(c);
  const r = await api.report('gap', { orgId: ORG, sites: [L1, L2], from: '2026-10-05', to: '2026-10-11', opts: { level: 'item' }, after: { gap_value: -5, company_item_id: 'x' }, limit: 200 });
  assert.deepEqual(c.calls[0], { fn: 'stock_report_gap', args: { p_org: ORG, p_sites: [L1, L2], p_from: '2026-10-05', p_to: '2026-10-11', p_opts: { level: 'item' }, p_after: { gap_value: -5, company_item_id: 'x' }, p_limit: 200 } });
  assert.deepEqual(r, { data: ANSWER.data, error: null, needsUpdate: false, conflict: null, queued: [] });
  await api.report('dashboard', { orgId: ORG, sites: [L1], from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(c.calls[1].args, { p_org: ORG, p_sites: [L1], p_from: '2026-10-05', p_to: '2026-10-11', p_opts: null, p_after: null, p_limit: 1000 });
  await api.report('gap', { orgId: ORG, sites: [L1], from: '2026-10-05', to: '2026-10-11', limit: 5000 });
  assert.equal(c.calls[2].args.p_limit, REPORT_PAGE, 'never over 1,000');
  await api.report('gap', { orgId: ORG, sites: [L1], from: '2026-10-05', to: '2026-10-11', limit: 0 });
  assert.equal(c.calls[3].args.p_limit, 1000, 'nothing asked reads as the default');
});

test('a function the database does not have is NEEDS_UPDATE, never a figure', async () => {
  const api = createStockReportsApi(fakeClient());
  const r = await api.report('value', { orgId: ORG, sites: [L1], from: '2026-10-05', to: '2026-10-11' });
  assert.equal(r.data, null);
  assert.equal(r.needsUpdate, true);
  assert.equal(r.error.message, NEEDS_UPDATE);
  const s = await api.saveTargets(ORG, []);
  assert.equal(s.needsUpdate, true);
  // the database's own refusal comes back as its words
  const refusing = createStockReportsApi(fakeClient({ rpc: { stock_report_gap: { data: null, error: { code: '42501', message: 'Not allowed: this login does not reach River Side.' } } } }));
  const d = await refusing.report('gap', { orgId: ORG, sites: [L1], from: '2026-10-05', to: '2026-10-11' });
  assert.equal(d.needsUpdate, false);
  assert.equal(d.error.message, 'Not allowed: this login does not reach River Side.');
  // no client at all
  const none = createStockReportsApi(null);
  assert.equal((await none.report('gap', {})).error.message, 'No database');
  assert.equal((await none.targets(ORG)).error.message, 'No database');
});

test('allPages follows next until null, repeats the totals from page one, stops at the cap', async () => {
  const pages = [
    { meta: { columns: [{ key: 'a' }] }, totals: [{ location_id: L1, a: 1 }], rows: [{ a: 1 }, { a: 2 }], next: { a: 2 } },
    { meta: { columns: [{ key: 'a' }] }, totals: [{ location_id: L1, a: 1 }], rows: [{ a: 3 }], next: { a: 3 } },
    { meta: { columns: [{ key: 'a' }] }, totals: [{ location_id: L1, a: 1 }], rows: [{ a: 4 }], next: null },
  ];
  let n = 0;
  const c = fakeClient({ rpc: { stock_report_waste: () => ({ data: pages[n++], error: null }) } });
  const api = createStockReportsApi(c);
  const all = await api.allPages('waste', { orgId: ORG, sites: [L1], from: '2026-10-05', to: '2026-10-11', opts: { level: 'item' } });
  assert.deepEqual(all.data.rows.map((r) => r.a), [1, 2, 3, 4]);
  assert.equal(all.data.next, null);
  assert.equal(all.data.capped, false);
  assert.deepEqual(all.data.totals, [{ location_id: L1, a: 1 }]);
  assert.deepEqual(c.calls.map((x) => x.args.p_after), [null, { a: 2 }, { a: 3 }], 'keyset, never an offset');
  assert.ok(c.calls.every((x) => x.args.p_opts.level === 'item'));
  // the cap: 3 rows wanted
  n = 0;
  const capped = await api.allPages('waste', { orgId: ORG, sites: [L1], from: '2026-10-05', to: '2026-10-11' }, { maxRows: 3 });
  assert.deepEqual(capped.data.rows.map((r) => r.a), [1, 2, 3]);
  assert.equal(capped.data.capped, true);
  assert.deepEqual(capped.data.next, { a: 3 });
  // a failed page is a failure
  const bad = createStockReportsApi(fakeClient({ rpc: { stock_report_waste: { data: null, error: { code: '22023', message: 'Pick 1 to 50 sites.' } } } }));
  const f = await bad.allPages('waste', { orgId: ORG, sites: [], from: '2026-10-05', to: '2026-10-11' });
  assert.equal(f.error.message, 'Pick 1 to 50 sites.');
});

test('targets, key ratios, their saves, and the export calls name their function and arguments', async () => {
  const c = fakeClient({ rpc: {
    stock_save_targets: { data: { ok: true, rows: [] }, error: null },
    stock_save_key_ratios: { data: { ok: true, rows: [] }, error: null },
    stock_report_export_start: { data: { ok: true, job_id: JOB }, error: null },
    stock_report_export_cancel: { data: { ok: true }, error: null },
  }, tables: { stock_targets: { data: [{ id: 't1' }], error: null }, stock_key_ratios: { data: [], error: null }, report_export_jobs: { data: [{ id: JOB, status: 'done' }], error: null } } });
  const api = createStockReportsApi(c);
  const t = await api.targets(ORG);
  assert.deepEqual(t.data, [{ id: 't1' }]);
  assert.deepEqual(c.queries[0].steps[0], ['select', 'id, location_id, metric, green_to, amber_to, row_version']);
  assert.deepEqual(c.queries[0].steps[1], ['eq', 'org_id', ORG]);
  assert.deepEqual(c.queries[0].steps.at(-1), ['limit', 1000]);
  await api.keyRatios(ORG);
  assert.deepEqual(c.queries[1].steps[0], ['select', 'id, name, used_item_id, used_unit, sold_rule, recipe_amount, sort_order, archived_at, row_version']);
  assert.ok(c.queries[1].steps.some((s) => s[0] === 'is' && s[1] === 'archived_at'), 'live ratios by default');
  await api.keyRatios(ORG, { archived: true });
  assert.ok(!c.queries[2].steps.some((s) => s[0] === 'is'), 'archived asked for: no filter');
  const rows = [{ location_id: null, metric: 'gp_pct', green_to: 70, amber_to: 65, row_version: null }];
  await api.saveTargets(ORG, rows);
  assert.deepEqual(c.calls.at(-1), { fn: 'stock_save_targets', args: { p_org: ORG, p_rows: rows, p_section: 'reports' } });
  await api.saveKeyRatios(ORG, [{ name: 'Milk per milk drink' }]);
  assert.deepEqual(c.calls.at(-1), { fn: 'stock_save_key_ratios', args: { p_org: ORG, p_rows: [{ name: 'Milk per milk drink' }], p_section: 'reports' } });
  const args = { org: ORG, sites: [L1, L2], from: '2026-10-05', to: '2026-10-11', opts: { level: 'item' } };
  const started = await api.exportStart('gap', args);
  assert.deepEqual(c.calls.at(-1), { fn: 'stock_report_export_start', args: { p_report: 'gap', p_args: args } });
  assert.equal(started.data.job_id, JOB);
  await api.exportCancel(JOB);
  assert.deepEqual(c.calls.at(-1), { fn: 'stock_report_export_cancel', args: { p_job: JOB } });
  const jobs = await api.exportJobs([JOB, JOB, null]);
  assert.deepEqual(jobs.data, [{ id: JOB, status: 'done' }]);
  const jq = c.queries.at(-1);
  assert.deepEqual(jq.steps[0], ['select', 'id, report, status, pages, parts, rows, error, created_at, done_at, expires_at']);
  assert.deepEqual(jq.steps[1], ['in', 'id', [JOB]]);
  assert.deepEqual(await api.exportJobs([]), { data: [], error: null, needsUpdate: false, conflict: null, queued: [] });
  await api.myExports();
  assert.deepEqual(c.queries.at(-1).steps.at(-1), ['limit', 20]);
  assert.deepEqual(c.queries.at(-1).steps.at(-2), ['order', 'created_at', { ascending: false }]);
  // a refusal inside a success answer is an error with the database's words
  const refusing = createStockReportsApi(fakeClient({ rpc: { stock_report_export_start: { data: { ok: false, error: 'An export is already running. Wait for it to finish.' }, error: null } } }));
  const r = await refusing.exportStart('gap', args);
  assert.equal(r.error.message, 'An export is already running. Wait for it to finish.');
});

test('a missing table is NEEDS_UPDATE too', async () => {
  const c = fakeClient({ tables: { stock_targets: { data: null, error: { code: '42P01', message: 'relation "public.stock_targets" does not exist' } } } });
  const r = await createStockReportsApi(c).targets(ORG);
  assert.equal(r.needsUpdate, true);
  assert.equal(r.error.message, NEEDS_UPDATE);
});

test('the download URL is the edge function\'s, from the client or the base given', () => {
  const api = createStockReportsApi(fakeClient({ supabaseUrl: 'https://example.supabase.co' }));
  assert.equal(api.exportDownloadUrl(JOB), `https://example.supabase.co/functions/v1/report-export?action=download&job=${JOB}`);
  assert.equal(functionsBaseOf({ supabaseUrl: 'https://x.supabase.co/' }), 'https://x.supabase.co/functions/v1');
  assert.equal(functionsBaseOf({ functions: { url: 'https://x.supabase.co/functions/v1' } }), 'https://x.supabase.co/functions/v1');
  assert.equal(functionsBaseOf(null, 'https://y.test/functions/v1/'), 'https://y.test/functions/v1');
  assert.equal(functionsBaseOf(null), '/functions/v1');
  assert.equal(createStockReportsApi(fakeClient()).exportDownloadUrl('a b'), 'https://example.supabase.co/functions/v1/report-export?action=download&job=a%20b');
});

test('pollExport follows one job until it is finished, and stops when asked', async () => {
  const statuses = ['waiting', 'running', 'running', 'done'];
  let n = 0;
  const api = { exportJobs: async () => ({ data: [{ id: JOB, status: statuses[Math.min(n++, statuses.length - 1)], rows: n * 1000 }], error: null }) };
  const seen = [];
  const timers = { set: (fn) => { fn(); return 1; }, clear: () => {} };
  await new Promise((resolve) => {
    pollExport(api, JOB, (job) => { seen.push(job.status); if (finishedExport(job)) resolve(); }, { timers });
  });
  assert.deepEqual(seen, ['waiting', 'running', 'running', 'done']);
  assert.equal(n, 4, 'no call after done');
  // failed, cancelled and expired finish it too
  for (const s of ['failed', 'cancelled', 'expired']) assert.ok(finishedExport({ status: s }), s);
  assert.equal(finishedExport({ status: 'running' }), false);
  assert.equal(finishedExport(null), false);
  // the table is not there: one tick with null, then it stops
  const gone = { exportJobs: async () => ({ data: null, error: new Error(NEEDS_UPDATE), needsUpdate: true }) };
  const ticks = [];
  await new Promise((resolve) => { pollExport(gone, JOB, (job, r) => { ticks.push([job, r.needsUpdate]); resolve(); }, { timers }); });
  assert.deepEqual(ticks, [[null, true]]);
  // stop before the first tick lands
  let called = 0;
  const slow = { exportJobs: () => new Promise((r) => setTimeout(() => { called++; r({ data: [] }); }, 5)) };
  const stop = pollExport(slow, JOB, () => { throw new Error('must not tick after stop'); }, { timers });
  stop();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(called, 1);
  // nothing to follow
  assert.equal(typeof pollExport(null, JOB, () => {}), 'function');
  assert.equal(typeof pollExport(api, null, () => {}), 'function');
});

test('menuProducts: the key item search reads live menu_items at the sites asked, through the same client', async () => {
  const c = fakeClient({ tables: { menu_items: { data: [{ id: 'm1', name: 'Latte', location_id: L1 }], error: null } } });
  const api = createStockReportsApi(c);
  const r = await api.menuProducts({ sites: [L1, L2], search: 'lat', limit: 500 });
  assert.equal(r.error, null);
  assert.deepEqual(r.data, [{ id: 'm1', name: 'Latte', location_id: L1 }]);
  const q = c.queries.find((x) => x.table === 'menu_items');
  assert.ok(q, 'asked menu_items');
  assert.deepEqual(q.steps.find((s) => s[0] === 'in'), ['in', 'location_id', [L1, L2]]);
  assert.deepEqual(q.steps.find((s) => s[0] === 'limit'), ['limit', 50]);
  // nothing asked under two letters
  const none = await api.menuProducts({ sites: [L1], search: 'l' });
  assert.deepEqual(none.data, []);
});

// v5.11.100 (Drop 4b): the closing stock journal goes through xero-stock-journal, only 'preview' or 'send'
test('monthEndJournal: preview and send through xero-stock-journal; words come back as errors; nothing else is called', async () => {
  const { monthEndJournalCall, createStockReportsApi } = await import('./reportsData.js');
  const calls = [];
  const client = (answer) => ({ functions: { invoke: async (name, opts) => { calls.push([name, opts.body]); return answer; } } });
  const ok = await monthEndJournalCall(client({ data: { status: 'ready', amount: 120.5 }, error: null }), 'preview', { orgId: 'o', from: '2026-09-01', to: '2026-09-30', tenantId: 't' });
  assert.deepEqual(calls[0], ['xero-stock-journal', { orgId: 'o', from: '2026-09-01', to: '2026-09-30', tenantId: 't', action: 'preview' }]);
  assert.deepEqual(ok.data, { status: 'ready', amount: 120.5 });
  assert.equal(ok.error, null);
  const words = await monthEndJournalCall(client({ data: { error: 'This month was already sent to Xero.' }, error: null }), 'send', {});
  assert.equal(words.error.message, 'This month was already sent to Xero.');
  const refused = await monthEndJournalCall(client({ data: null, error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: { json: async () => ({ error: 'Lock the month at every site of Leeds Ltd first.' }) } }) }), 'send', {});
  assert.equal(refused.error.message, 'Lock the month at every site of Leeds Ltd first.');
  const n = calls.length;
  const bad = await monthEndJournalCall(client({ data: {}, error: null }), 'post', {});
  assert.equal(calls.length, n, 'an unknown action never calls the function');
  assert.match(bad.error.message, /preview or send/);
  assert.match((await monthEndJournalCall(null, 'preview', {})).error.message, /No database/);
  assert.equal(typeof createStockReportsApi(client({ data: {}, error: null })).monthEndJournal, 'function');
});
