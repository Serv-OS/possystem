// drop4a.mjs: proves Drop 4a of multi site stock (supabase/migrations/20261026a_OPS_stock_native_4a.sql and
// its rollback: the head office reports) on the throwaway Ops shaped database run.mjs built, after 0a, its
// revalue file, 0b, Drop 1 (20261024a) and the drainer release (20261023a), Peter's live order. It never
// connects to Supabase. run.mjs --drop4a calls drop4aSections() after its section 1.
//
//   30  the paste: the guard's refusals (no Drop 1, no drainer, a second run, a changed body, not Ops),
//       no Drop 2 table needed; the check row (every column); no site row, ledger row, login or link
//       changed; the sales history backfill queued 15 venue days a minute, newest first; the drain
//       finishing it
//   31  every new table (RLS, grants, read rule, fence, no write policy), the bucket and its owner path
//       policy, the vault key and report_export_cron_ok, the cron job and report_export_run_due (posts
//       only when there is work, only as postgres); every new function (definer, search path, grants)
//   32  the report guard with real roles, JWT claims and the live limits: owner, Stock control all,
//       a sites manager (own site ok, another refused by name), another company, every device and
//       customer session, the anon key, no second step, the service role, 51 sites, 401 days
//   33  every number against an independent oracle (the raw ledger and the checks, each venue day worked
//       out in JS from venue_clock) on a seeded world of sales through the real drainer, receipts, waste,
//       counts, transfers, batches, revalues, refunds and staff, comp and loyalty discounts: sales,
//       theoretical cost both ways, actual cost both ways to the penny, opening and closing, gap, the
//       loyalty, staff and comps line, GP before and after, product GP adding up to site GP, waste,
//       purchases, prices, days on hand, par and stock outs, key ratios, setup health, batches; then
//       the venue clock around the UK clock change (25 Oct 2026) and the US one (1 Nov 2026), a UK
//       and a US site, two currencies never added
//   34  demo history left out of every figure, counted or estimated, own cost rule, sales not yet
//       posted (count and value, GP unchanged), a locked period read from its snapshot, part locked
//   35  paging: every drill level with ties at a page of 3 never repeats or skips a row; totals on every
//       page; the 1,000 cap; columns on every row
//   36  speed: a synthetic company of 50 sites (10 with --quick) by 500 items by 31 days of day totals
//       and two full counts a site: every report under 5 s as the owner under the 8 s limit; 400 days
//   37  exports: start, claim, page as the job's login, part files, finish, download check, cancel,
//       expiry, one at a time, 20 a day, reach lost at run time; then the rollback and 4a again with
//       every number unchanged
//
// Ids and neutral words only (the repo is public).

import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lit, jlit, arr, rng } from './base.mjs';
import { ORG_T, PROVO, LOC2, ORG_S, SOLO, ORG_X, X1, U, I, M, CALLERS, id } from './fixtures.mjs';
import { BASKET_SETUP, basketEvents, insertRow } from './channels.mjs';
import { DISC, PRICE, BM, basketSql, presetKindsSql } from './drainer_fixtures.mjs';
import { jsParts } from './drainer.mjs';
// the web's own rules, so a check holds the database to exactly what a screen shows
import { TARGET_DEFAULTS, ragOf } from '../../../src/lib/stock/targetRules.js';
// the edge function's own CSV rules, so the export proof writes exactly what report-export writes
import { csvPart, partName } from '../../functions/report-export/rules.js';

// -- contract 1.1: the bodies 4a reads and only checks (normalised md5 after the drainer) -------------------
export const D4A_CHECKED = [
  ['public.stock_level(uuid,uuid)', '4287c82be293ef0b2724ee206d71eecc'],
  ['public.stock_reach_locations()', '6805857cee1a521eebe68a9dc3d8fa3e'],
  ['public.stock_co__venue_day(uuid,timestamptz)', '8c9513db8ec56ddb68a1a3f247360742'],
  ['public.stock_co__clock_of(uuid)', '605fce03d4e44064df5cf3b03ecd0350'],
  ['public.stock_co__day_start_at(date,time,text)', '2cb462264587615075225d05a84cd051'],
  ['public._stock_day_sums_apply()', 'ccf9db2e33be2e998bcc540186cca0f9'],
  ['public.stock_day_sums_rebuild(uuid,date,date)', '7f8ccfae7dbe7826623e60dab4f84bcb'],
  ['public.sales_day_sums_rebuild(uuid,date,date)', '007c100176c9438b35c6531916555a79'],
  ['public.stock_site_scope(uuid)', 'e0b54f5aaea4f330e2300248b721141d'],
];
// contract 1.6: the sixteen report functions and who may run them
const SIG7 = '(uuid,uuid[],date,date,jsonb,jsonb,integer)';
export const D4A_REPORTS = ['dashboard', 'league', 'attention', 'value', 'movement', 'gap', 'cogs', 'product_gp', 'waste', 'purchases', 'prices',
  'days_on_hand', 'par', 'key_ratios', 'setup_health', 'batches'];
// contract 1.5 and 1.8: the public functions besides the reports, and who may run them
export const D4A_PUBLIC = [
  ['public.stock_save_targets(uuid,jsonb,text)', ['authenticated']],
  ['public.stock_save_key_ratios(uuid,jsonb,text)', ['authenticated']],
  ['public.stock_report_export_start(text,jsonb)', ['authenticated']],
  ['public.stock_report_export_cancel(uuid)', ['authenticated']],
  ['public.report_export_cron_ok(text)', ['service_role']],
  ['public.report_export_claim(integer)', ['service_role']],
  ['public.report_export_page(uuid)', ['service_role']],
  ['public.report_export_finish(uuid,jsonb)', ['service_role']],
  ['public.report_export_reach_ok(uuid,uuid)', ['service_role']],
  ['public.report_export_run_due()', []],
];
export const D4A_TABLES = {
  stock_targets: { grants: ['authenticated', 'service_role'], read: 'stock_reach_orgs' },
  stock_key_ratios: { grants: ['authenticated'], read: 'stock_reach_orgs' },
  report_export_jobs: { grants: ['authenticated', 'service_role'], read: 'auth.uid()' },
};
const ACTUAL_KINDS = ['SALE_DEPLETION', 'RETURN', 'PRODUCTION_CONSUME', 'PRODUCTION_OUTPUT', 'WASTE', 'STOCK_COUNT_ADJ', 'REVALUE'];
const isDemo = (k) => typeof k === 'string' && (k.startsWith('demo-v1:') || k.startsWith('demo71:') || k.startsWith('seed:'));
const PENNY = 0.005;

// The venue business day of an instant, worked out here without the database: the wall clock in the
// venue's time zone, less the day start. (Independent of stock_co__venue_day: the oracle.)
export function venueDay(epochSec, tz, start = '06:00') {
  const d = new Date(Number(epochSec) * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const wall = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  const [h, m] = String(start).split(':').map(Number);
  return new Date(wall - (h * 60 + (m || 0)) * 60000).toISOString().slice(0, 10);
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export async function drop4aSections(ctx) {
  const { c, ok, section, guarded, FILES, QUICK, SEED = 1 } = ctx;
  const sql = (q, o) => c.sql(q, o);
  const num = (q, o) => c.num(q, o);
  const short = (x, n = 160) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);
  const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const tf = (v) => v === 't' || v === 'true' || v === true;
  const near = (a, b, eps = PENNY) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
  const ONLY = (process.env.STOCKN_D4A_ONLY || '').split(',').filter(Boolean).map(Number);
  const want = (n) => !ONLY.length || ONLY.includes(n);
  const PRE = c.DB;   // 0a, its revalue file, 0b, Drop 1 and the drainer in: the live state on the night 4a runs

  // -- callers, as run.mjs makes them (authenticator, SET ROLE, claims, the live limits) ---------------------
  const anonSession = (sub) => ({ sub, role: 'authenticated', is_anonymous: true, aud: 'authenticated' });
  const loginOf = (sub, aal = 'aal2') => ({ sub, role: 'authenticated', is_anonymous: false, aud: 'authenticated', aal });
  const SCALE_ORG = id('0e000000', 'e1');
  const SCALE_OWNER = id('10000000', 'e1');
  const CALL = {
    ...CALLERS,
    kdsProvo: { login: 'authenticator', role: 'authenticated', claims: anonSession(id('20000000', 'ca1')), what: 'kitchen screen bound to Provo' },
    clockProvo: { login: 'authenticator', role: 'authenticated', claims: anonSession(id('20000000', 'fa1')), what: 'clock in tablet bound to Provo' },
    scaleOwner: { login: 'authenticator', role: 'authenticated', claims: loginOf(SCALE_OWNER), what: 'owner of the scale test company' },
  };
  function callerLines(cl) {
    const lines = ['\\set VERBOSITY verbose', 'begin;'];
    if (cl.claims) lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(cl.claims))}, true) \\g /dev/null`);
    if (cl.role) {
      lines.push(`set local role ${cl.role};`);
      if (cl.role === 'authenticated' || cl.role === 'service_role') lines.push(`set local statement_timeout = '8s';`);
      if (cl.role === 'anon') lines.push(`set local statement_timeout = '3s';`);
      lines.push(`set local lock_timeout = '8s';`);
    }
    return lines;
  }
  function asCaller(key, body, { commit = true } = {}) {
    const cl = CALL[key];
    if (!cl) throw new Error(`no caller ${key}`);
    const lines = callerLines(cl);
    lines.push(body.trim().replace(/;?$/, ';'));
    lines.push(commit ? 'commit;' : 'rollback;');
    const t0 = Date.now();
    const r = c.psql({ login: cl.login, input: lines.join('\n') + '\n', allowFail: true });
    const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr || '');
    return { status: r.status, sqlstate: m ? m[1] : (r.status ? 'error' : null), message: m ? m[2] : (r.stderr || '').trim(), out: (r.stdout || '').trim(), ms: Date.now() - t0 };
  }
  const lastJson = (r) => { try { return JSON.parse(r.out.split('\n').filter(Boolean).pop()); } catch { return null; } };
  const callJ = (key, body, o) => { const r = asCaller(key, body, o); return { ...r, j: lastJson(r) }; };
  const outcome = (r) => (r.sqlstate ? `${r.sqlstate} ${short(r.message, 90)}` : r.status !== 0 ? `fail:${short(r.message, 80)}` : 'ok');
  // one report call: the answer in .j
  const rep = (who, name, { org = ORG_T, sites, from, to, opts = null, after = null, limit = 1000 }) =>
    callJ(who, `select public.stock_report_${name}('${org}', ${arr(sites)}, '${from}', '${to}', ${opts ? jlit(opts) : 'null'}, ${after ? jlit(after) : 'null'}, ${limit})`);
  // every page, following next (keyset); returns { rows, pages, totals: [every page's totals], last }
  function allPages(who, name, args, limit = 1000, maxPages = 400) {
    let after = null; const rows = []; const totals = []; let pages = 0; let last = null;
    for (;;) {
      const r = rep(who, name, { ...args, after, limit });
      if (r.status !== 0 || !r.j) return { error: outcome(r), rows, pages, totals };
      pages++; last = r.j; rows.push(...(r.j.rows || [])); totals.push(JSON.stringify(r.j.totals));
      if (!r.j.next || pages >= maxPages) break;
      after = r.j.next;
    }
    return { rows, pages, totals, last };
  }
  const lastRows = (r) => (r.sets[r.sets.length - 1] || { rows: [] }).rows;
  const tableExists = (t) => sql(`select to_regclass('public.${t}') is not null`) === 't';
  const fnExists = (sig) => sql(`select to_regprocedure('${sig}') is not null`) === 't';
  const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  const aclOf = (sig) => sql(`select coalesce(string_agg(r, ',' order by r), '') from (
      select case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end r
        from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = to_regprocedure('${sig}') and a.privilege_type = 'EXECUTE') z`);
  const pathOf = (sig) => sql(`select coalesce((select substr(x, 13) from unnest(p.proconfig) x where x like 'search_path=%'), '') from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  const drain = () => sql('call public.stock_outbox_drain(10, 200, 0.05, true);');
  const dsDrainAll = () => {
    for (let k = 0; k < 60; k++) {
      sql('call public.stock_day_sums_drain(40, 50);');
      if (num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) === 0) return k + 1;
    }
    return -1;
  };
  const drainAll = () => { for (let k = 0; k < 40 && num(`select count(*) from stock_outbox where status = 'pending' and due_at <= now()`) > 0; k++) drain(); dsDrainAll(); };
  const siteSnap = () => sql(`select md5(string_agg(x, '|' order by x)) from (
      select 'i' || i.id || ':' || coalesce(i.on_hand, 0) || ':' || coalesce(i.current_cost, 0) || ':' || coalesce(i.company_ref::text, '') as x from inventory_items i
      union all select 'm' || count(*) || ':' || coalesce(sum(value_delta), 0) || ':' || coalesce(sum(qty_base), 0) from stock_movements
      union all select 'c' || count(*) from stock_counts union all select 'w' || count(*) from waste_events
      union all select 'd' || count(*) || ':' || coalesce(sum(value), 0) from stock_day_sums
      union all select 's' || count(*) || ':' || coalesce(sum(net), 0) from sales_day_sums) z`);
  const loginSnap = () => sql(`select md5(coalesce((select string_agg(t::text, '|' order by t.id) from user_profiles t), '') || '#' || coalesce((select string_agg(t::text, '|' order by t::text) from user_locations t), ''))`);
  const today = sql(`select current_date::text`);
  const ukToday = sql(`select (public.stock_co__venue_day('${PROVO}', now())).business_day::text`);
  const VNAME = { [PROVO]: 'Provo', [LOC2]: 'Location 2' };

  // ============================================================================================================
  section(30, '30. Drop 4a as the SQL editor runs it: the guard, the check row, nothing at the sites or logins moves, the sales history backfill');
  let pasted = false;
  await guarded('d4a paste', () => {
    c.use(PRE);
    // as live on the night: the drainer's drain has finished the whole ledger it queued
    const drained = dsDrainAll();
    ok(drained > 0 && num(`select count(*) from stock_day_sums_repair`) + num(`select count(*) from sales_day_sums_queue where due_at <= now()`) === 0,
      `the drainer's queue is drained first, as it is live before 4a runs (${drained} runs)`);
    sql('analyze;');
    ok(!tableExists('recipe_cost_daily') && !tableExists('menu_item_stock_facts') && !tableExists('stock_targets'),
      'the database has no Drop 2 table (recipe_cost_daily, menu_item_stock_facts) and no 4a table: 4a must not need Drop 2');
    for (const [sig, m5] of D4A_CHECKED) ok(md5Of(sig) === m5, `${sig.slice(7, sig.indexOf('('))}: the body 4a checks has the md5 the drainer leaves live (${md5Of(sig)})`);
    // the refusals, each on its own copy
    const refusal = (name, prep, words, extra = '') => {
      c.createFrom(name, PRE);
      c.use(name);
      prep();
      const r = c.paste(FILES.d4);
      ok(r.status !== 0 && words.test(r.stderr) && !tableExists('stock_targets') && !fnExists('public.report_export_cron_ok(text)'),
        `${extra}: refused in plain words, nothing changed (${short(r.error, 160)})`);
      c.use(PRE);
    };
    refusal('n_d4_nod1', () => sql(`drop table public.stock_order_rules cascade`), /Run 20261024a_OPS_stock_native_1\.sql first\. Nothing was changed\./, 'without Drop 1');
    refusal('n_d4_nodr', () => sql(`drop trigger stock_movements_day_sums_ins on public.stock_movements`), /Run 20261023a_OPS_stock_drainer_v2\.sql first\. Nothing was changed\./, 'without the drainer release (its trigger missing)');
    refusal('n_d4_nodr2', () => sql(`drop table public.stock_sale_takes cascade`), /Run 20261023a_OPS_stock_drainer_v2\.sql first\. Nothing was changed\./, 'without the drainer release (stock_sale_takes missing)');
    refusal('n_d4_notops', () => sql(`create table public.billing_state (id integer)`), /This is not the Ops database/, 'on another database');
    refusal('n_d4_body', () => {
      const def = sql(`select pg_get_functiondef('public.stock_site_scope(uuid)'::regprocedure)`);
      sql(def.replace(/AS \$function\$/, 'AS $function$\n-- a later change'));
    }, /A stock function changed since this file was written\. Ask Claude for a new file\.[\s\S]*stock_site_scope/, 'a changed body (named)');
    // the backfill: checks closed before the drainer existed (no queue row, no day total), as live
    c.createFrom('n_d4_bf', PRE);
    c.use('n_d4_bf');
    const bfDays = [3, 4, 9, 40, 200, 420].map((k) => addDays(ukToday, -k));
    const bfRows = [];
    for (const [k, d] of bfDays.entries()) {
      for (const loc of [PROVO, LOC2, SOLO]) {
        bfRows.push(insertRow({ id: `bf-${loc.slice(0, 4)}-${k}`, location_id: loc, ref: `BF${k}`, closed_at: `${d}T12:00:00Z`, items: [{ itemId: 'm-unknown', qty: 1, price: 2 }],
          subtotal: 2, total: 2, tax_amount: 0.33, source: 'pos', order_type: 'dine-in', status: 'paid', voided: false, tenders: [{ method: 'cash', amount: 2 }] }));
      }
    }
    sql(`${bfRows.join(';\n')};`);
    sql(`delete from public.sales_day_sums_queue; delete from public.sales_day_sums where location_id in ('${PROVO}', '${LOC2}', '${SOLO}');
         update public.stock_outbox set status = 'done' where left(check_id, 3) = 'bf-';`);
    // a day already totalled is never queued again
    sql(`insert into public.sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net, discount_spread, reward_spread, tax,
           loyalty_qty, staff_qty, comp_qty, loyalty_cost, staff_cost, comp_cost, theo_cost, clock_known)
         values ('${PROVO}', '${addDays(ukToday, -4)}', 'm-unknown', 'dine-in', 1, 2, 1.67, 0, 0, 0.33, 0, 0, 0, 0, 0, 0, 0, true)`);
    // what the backfill must queue, worked out here: from the later of each venue's first check day and 13
    // months ago, to the venue's yesterday, less the days already totalled
    const cutoff = sql(`select (current_date - interval '13 months')::date::text`);
    const expect = {};
    for (const loc of [PROVO, LOC2, SOLO]) {
      const first = bfDays.slice().sort()[0];
      const start = first > cutoff ? first : cutoff;
      const yest = addDays(sql(`select public.stock_co__today('${loc}')::text`), -1);
      let n = 0;
      for (let d = start; d <= yest; d = addDays(d, 1)) if (!(loc === PROVO && d === addDays(ukToday, -4))) n++;
      expect[loc] = n;
    }
    const figBf = siteSnap();
    const rbf = c.paste(FILES.d4);
    ok(rbf.status === 0, `4a applies on a copy with checks and no day totals (${rbf.status ? short(rbf.stderr, 300) : `${rbf.ms} ms`})`);
    const rowsBf = lastRows(rbf);
    const byOrg = Object.fromEntries(rowsBf.map((r) => [r.org_id, r]));
    const qd = pj(sql(`select json_object_agg(location_id, n) from (select location_id, count(*) n from sales_day_sums_queue where reason = 'drop4a_backfill' group by 1) z`)) || {};
    ok([PROVO, LOC2, SOLO].every((l) => Number(qd[l] || 0) === expect[l]),
      `the backfill queues every venue day from the later of the first check and 13 months ago to yesterday, less the days already totalled (${short(qd)}; expected ${short(expect)})`);
    ok(Number(byOrg[ORG_T]?.backfill_days_queued) === expect[PROVO] + expect[LOC2] && Number(byOrg[ORG_S]?.backfill_days_queued) === expect[SOLO]
       && Number(byOrg[ORG_T]?.backfill_minutes) === Math.ceil((expect[PROVO] + expect[LOC2]) / 15),
      `the check row says so: backfill_days_queued ${byOrg[ORG_T]?.backfill_days_queued} and ${byOrg[ORG_S]?.backfill_days_queued}, backfill_minutes ${byOrg[ORG_T]?.backfill_minutes}`);
    const spread = pj(sql(`select json_build_object('max_a_minute', (select max(n) from (select count(*) n from sales_day_sums_queue where reason = 'drop4a_backfill'
                                                                       group by date_trunc('minute', due_at - (select min(due_at) from sales_day_sums_queue where reason = 'drop4a_backfill'))) z),
        'newest_first', (select bool_and(ok) from (select lag(business_day) over (order by due_at, business_day desc, location_id) >= business_day or lag(business_day) over (order by due_at, business_day desc, location_id) is null as ok
                                                    from sales_day_sums_queue where reason = 'drop4a_backfill') z),
        'first_due_now', (select min(due_at) <= now() + interval '1 second' from sales_day_sums_queue where reason = 'drop4a_backfill'))`)) || {};
    ok(spread.max_a_minute <= 15 && spread.newest_first === true && spread.first_due_now === true,
      `15 venue days become due each minute, newest first, the first now (${short(spread)})`);
    ok(siteSnap() === figBf, 'the backfill queues only: no day total, ledger row or site row written by the paste');
    sql(`update sales_day_sums_queue set due_at = now() - interval '1 second' where reason = 'drop4a_backfill'`);
    const steps = dsDrainAll();
    const done = pj(sql(`select json_build_object('left', (select count(*) from sales_day_sums_queue where reason = 'drop4a_backfill'),
        'days', (select count(distinct (location_id, business_day)) from sales_day_sums where left(menu_item_id, 9) = 'm-unknown'))`)) || {};
    const wantDays = bfDays.filter((d) => d >= cutoff).length * 3;
    ok(steps > 0 && done.left === 0 && done.days === wantDays,
      `the drainer's drain finishes the backfill (${steps} runs): nothing left queued, a day total on every day that had a check in the 13 months (${done.days} of ${wantDays})`);
    c.use(PRE);
    // the paste itself on the live state
    const figBefore = siteSnap();
    const logBefore = loginSnap();
    const r = c.paste(FILES.d4);
    pasted = r.status === 0;
    ok(pasted, `4a applies as one paste (${r.status ? short(r.stderr, 600) : `${r.ms} ms`})`);
    const rows = lastRows(r);
    console.log(`     check row: ${short(rows, 1200)}`);
    const orgsWithStock = sql(`select string_agg(distinct l.org_id::text, ',' order by l.org_id::text) from locations l where exists (select 1 from inventory_items i where i.location_id = l.id)`).split(',');
    ok(rows.length === orgsWithStock.length && rows.every((x) => orgsWithStock.includes(x.org_id)), `one check row per company that holds stock (${rows.length})`);
    for (const x of rows) {
      const multi = x.org_id === ORG_T;
      ok(tf(x.multi) === multi && x.new_tables === '3' && x.new_functions === '26' && x.internals_open_to_api === 'f' && x.anon_can_read_reports === 'f'
         && x.bucket_ok === 't' && x.policy_ok === 't' && x.cron_job === 't' && x.vault_key === 't',
        `${x.org_id.slice(0, 8)}: multi ${x.multi}, 3 tables, 26 functions, internals closed, the anon key reads nothing, bucket, policy, cron job and vault key there`);
      ok(multi ? Number(x.dashboard_ms) < 5000 && x.league_rows === '2' : x.dashboard_ms === 'skipped',
        `${x.org_id.slice(0, 8)}: dashboard_ms ${x.dashboard_ms}${multi ? ' (under 5000), league_rows 2' : ' (one site company)'}`);
      const hasDemo = multi && num(`select count(*) from stock_day_sums s join locations l on l.id = s.location_id where l.org_id = '${x.org_id}' and s.demo`) > 0;
      ok(x.site_rows_changed === '0' && x.logins_changed === 'f' && x.backfill_days_queued === '0' && x.backfill_minutes === '0' && tf(x.demo_left_out) === hasDemo,
        `${x.org_id.slice(0, 8)}: site rows changed ${x.site_rows_changed}, logins changed ${x.logins_changed}, backfill ${x.backfill_days_queued}, demo left out ${x.demo_left_out}`);
      for (const col of ['org_id', 'multi', 'new_tables', 'new_functions', 'internals_open_to_api', 'anon_can_read_reports', 'bucket_ok', 'policy_ok', 'cron_job', 'vault_key',
        'backfill_days_queued', 'backfill_minutes', 'dashboard_ms', 'league_rows', 'demo_left_out', 'site_rows_changed', 'logins_changed']) {
        if (!(col in x)) ok(false, `the check row has the column ${col}`);
      }
    }
    ok(siteSnap() === figBefore && loginSnap() === logBefore, 'no site row, ledger row, day total, login or link changed');
    const again = c.paste(FILES.d4);
    ok(again.status !== 0 && /Drop 4a has run already\. Nothing was changed\./.test(again.stderr), `a second paste refuses: 'Drop 4a has run already. Nothing was changed.' (${short(again.error, 80)})`);
  });
  if (!pasted) { ok(false, '4a did not apply: sections 31 to 37 need it'); return; }
  const D4 = c.DB;

  // ============================================================================================================
  section(31, '31. What 4a made: tables, bucket, policy, vault key, cron job, functions and their grants');
  if (want(31)) await guarded('d4a inventory', () => {
    c.use(D4);
    for (const [t, spec] of Object.entries(D4A_TABLES)) {
      ok(sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`) === 't', `${t}: row level security on`);
      const g = sql(`select coalesce(string_agg(distinct grantee || ':' || privilege_type, ',' order by grantee || ':' || privilege_type), '')
                       from information_schema.role_table_grants where table_schema = 'public' and table_name = '${t}' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`);
      ok(g === spec.grants.map((r) => `${r}:SELECT`).join(','), `${t}: grants exactly select to ${spec.grants.join(' and ')} (${g || 'none'})`);
      const pol = sql(`select coalesce(string_agg(policyname || ':' || permissive || ':' || cmd, ',' order by policyname), '') from pg_policies where schemaname = 'public' and tablename = '${t}'`);
      ok(pol === [`${t}_read:PERMISSIVE:SELECT`, 'second_step_fence:RESTRICTIVE:ALL'].sort().join(','), `${t}: policies ${pol} (no write policy)`);
      const q = sql(`select qual from pg_policies where schemaname = 'public' and tablename = '${t}' and policyname = '${t}_read'`);
      ok(q.includes(spec.read) && !/accessible_location|ops_writable/.test(q), `${t}: the read rule reads ${spec.read} and no device read function`);
      ok(sql(`select obj_description('public.${t}'::regclass)`).includes('20261026a'), `${t}: its comment names the Drop`);
    }
    // the read rules with real logins
    sql(`insert into stock_targets (org_id, location_id, metric, green_to, amber_to) values ('${ORG_T}', null, 'gap_pct', 1.5, 2.2), ('${ORG_X}', null, 'gap_pct', 1, 2)`);
    sql(`insert into report_export_jobs (org_id, user_id, report, args, status) values ('${ORG_T}', '${U.ownerT}', 'value', '{}', 'done'), ('${ORG_T}', '${U.mgrProvo}', 'value', '{}', 'done')`);
    const see = (who, q) => { const r = asCaller(who, q); return r.status === 0 ? r.out : outcome(r); };
    ok(see('ownerT', `select count(*) from stock_targets where org_id = '${ORG_T}'`) === '1' && see('soloOwner', `select count(*) from stock_targets`) === '0',
      'stock_targets: the owner reads its company row; the owner of another company reads none');
    ok(see('ownerT', `select count(*) from report_export_jobs`) === '1' && see('mgrProvo', `select count(*) from report_export_jobs`) === '1'
       && see('tillProvo', `select count(*) from report_export_jobs`) === '0' && /42501/.test(see('anonKey', `select count(*) from report_export_jobs`)),
      'report_export_jobs: each login reads its own job only; a till reads none; the anon key cannot read the table');
    ok(/42501/.test(see('ownerT', `insert into stock_targets (org_id, metric, green_to, amber_to) values ('${ORG_T}', 'waste_pct', 1, 2)`))
       && /42501/.test(see('ownerT', `update report_export_jobs set status = 'failed' where user_id = '${U.ownerT}'`)),
      'no login writes a 4a table directly (targets through stock_save_targets, jobs through the export functions)');
    ok(see('noStep', `select count(*) from stock_targets`) === '0', 'without the second step the fence hides every row');
    sql(`delete from stock_targets; delete from report_export_jobs where report = 'value' and args = '{}'::jsonb`);
    // the bucket and its policy
    const b = pj(sql(`select row_to_json(b) from storage.buckets b where id = 'report-exports'`)) || {};
    ok(b.public === false && Number(b.file_size_limit) === 52428800 && JSON.stringify(b.allowed_mime_types) === JSON.stringify(['text/csv', 'application/json']),
      `the bucket report-exports: private, 50 MB a part, CSV and JSON only (${short(b, 200)})`);
    const pq = sql(`select qual || '|' || cmd || '|' || array_to_string(roles, ',') from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'report_exports_owner_read'`);
    ok(/foldername\(name\)\)\[2\] = \(auth\.uid\(\)\)::text/.test(pq) && /is_anon_session/.test(pq) && !/accessible_location|ops_writable/.test(pq) && /\|SELECT\|authenticated$/.test(pq),
      `report_exports_owner_read: select to authenticated, the owner folder ([2] = auth.uid()), never a device read function (${short(pq, 200)})`);
    ok(num(`select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'report_export%'`) === 1,
      'one policy, no insert, update or delete policy: the edge function writes with the service role');
    sql(`insert into storage.objects (bucket_id, name) values ('report-exports', '${ORG_T}/${U.ownerT}/j1/part-0001.csv'), ('report-exports', '${ORG_T}/${U.mgrProvo}/j2/part-0001.csv')`);
    const seeObj = (who) => see(who, `select coalesce(string_agg(split_part(name, '/', 2), ',' order by name), '') from storage.objects where bucket_id = 'report-exports'`);
    ok(seeObj('ownerT') === U.ownerT && seeObj('mgrProvo') === U.mgrProvo && seeObj('tillProvo') === '' && seeObj('customer') === '' && seeObj('anonKey') === '' && seeObj('noStep') === '',
      `the owner path only: each login sees its own folder; a till, a customer, the anon key and a login without the second step see nothing (${seeObj('ownerT').slice(0, 8)}, ${seeObj('mgrProvo').slice(0, 8)})`);
    sql(`delete from storage.objects where bucket_id = 'report-exports'`);
    // the vault key, report_export_cron_ok and report_export_run_due
    const key = sql(`select decrypted_secret from vault.decrypted_secrets where name = 'report_export_cron_key'`);
    ok(key.length >= 32 && /^[0-9a-f]+$/.test(key), `the vault key report_export_cron_key: made by the database, ${key.length} hex characters`);
    const okKey = callJ('service', `select public.report_export_cron_ok(${lit(key)})`);
    const badKey = callJ('service', `select public.report_export_cron_ok('${'0'.repeat(64)}')`);
    const shortKey = callJ('service', `select public.report_export_cron_ok(${lit(key.slice(0, 20))})`);
    ok(okKey.out === 't' && badKey.out === 'f' && shortKey.out === 'f' && callJ('ownerT', `select public.report_export_cron_ok(${lit(key)})`).sqlstate === '42501',
      'report_export_cron_ok: true for the vault key only (a wrong or short key false), service role only, never says the key');
    const cron = sql(`select schedule || '|' || command from cron.job where jobname = 'report-export-run'`);
    ok(cron === '* * * * *|select public.report_export_run_due();', `the cron job report-export-run every minute (${cron})`);
    const calls0 = num(`select count(*) from net.calls`);
    ok(sql(`select public.report_export_run_due()`) === '0' && num(`select count(*) from net.calls`) === calls0, 'report_export_run_due with no work: 0, nothing posted');
    sql(`insert into report_export_jobs (org_id, user_id, report, args) values ('${ORG_T}', '${U.ownerT}', 'value', '{}')`);
    const req = sql(`select public.report_export_run_due()`);
    const call = pj(sql(`select row_to_json(x) from (select url, body, headers, timeout_ms from net.calls order by id desc limit 1) x`)) || {};
    ok(Number(req) > 0 && call.url === 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/report-export' && call.body?.action === 'run'
       && call.headers?.['x-cron-key'] === key && Number(call.timeout_ms) === 25000,
      `with a job waiting it posts {"action": "run"} to /functions/v1/report-export with the x-cron-key header (${short({ url: call.url, body: call.body, t: call.timeout_ms })})`);
    sql(`update report_export_jobs set status = 'done', expires_at = now() - interval '1 minute'`);
    ok(Number(sql(`select public.report_export_run_due()`)) > 0, 'a done job whose file has expired is work too (the runner removes it)');
    sql(`update report_export_jobs set status = 'running', claimed_at = now() - interval '4 minutes'`);
    ok(Number(sql(`select public.report_export_run_due()`)) > 0, 'a running slice silent for 3 minutes is work too');
    sql(`update report_export_jobs set status = 'running', claimed_at = now()`);
    ok(sql(`select public.report_export_run_due()`) === '0', 'a running slice claimed just now is not');
    sql(`delete from report_export_jobs`);
    for (const who of ['ownerT', 'service', 'anonKey']) ok(callJ(who, `select public.report_export_run_due()`).sqlstate === '42501', `report_export_run_due: ${CALL[who].what} refused (pg_cron runs it as postgres)`);
    // every function: definer, search path, grants
    const fns = sql(`select string_agg(p.oid::regprocedure::text, ';' order by 1) from pg_proc p where p.pronamespace = 'public'::regnamespace
                       and (p.proname ~ '^stock_rp__' or p.proname ~ '^report_export_' or p.proname ~ '^stock_report_' or p.proname in ('stock_save_targets', 'stock_save_key_ratios'))`).split(';').filter(Boolean);
    const canon = (s) => s.replace(/\s+/g, '').replace(/^public\./, '');
    const accept = new Map([...D4A_REPORTS.map((n) => [canon(`stock_report_${n}${SIG7}`), n === 'dashboard' || n === 'league' ? ['authenticated', 'service_role'] : ['authenticated']]),
      ...D4A_PUBLIC.map(([s, g]) => [canon(s), g])]);
    const bad = [];
    for (const f of fns) {
      const sig = canon(f);
      const w = accept.get(sig) || [];
      const acl = aclOf(f);
      const path = pathOf(f);
      const def = sql(`select prosecdef from pg_proc where oid = to_regprocedure('${f}')`);
      const wantPath = /^report_export_(cron_ok|run_due)\(/.test(sig) ? ['""', ''] : ['public, pg_temp'];
      if (acl !== ['postgres', ...w].sort().join(',')) bad.push(`${f} acl ${acl}`);
      if (!wantPath.includes(path)) bad.push(`${f} path ${path}`);
      if (def !== 't') bad.push(`${f} not definer`);
    }
    ok(fns.length > 40 && bad.length === 0, `every one of the ${fns.length} functions 4a made: definer, search_path set (the key check and the sender ''), EXECUTE exactly as contract 1.8 (${bad.slice(0, 4).join('; ') || 'all as written'})`);
    ok(D4A_REPORTS.every((n) => fnExists(`public.stock_report_${n}${SIG7}`)) && !fnExists(`public.stock_report_recipe_cost${SIG7}`) && !fnExists(`public.stock_report_allergens${SIG7}`),
      'the sixteen report functions are there; recipe cost and allergens are not (they come with the recipes update)');
  });

  // ============================================================================================================
  section(32, '32. The report guard with real roles, JWT claims and the live limits');
  const T7 = { from: addDays(ukToday, -7), to: ukToday };
  if (want(32)) await guarded('d4a guard', () => {
    c.use(D4);
    sql(`update user_profiles set stock_control = 'all' where id = '${U.mgrAll}'`);
    const SIGN = 'words:Sign in to Back Office to see stock reports.';
    const wantIs = (r, w) => (w === 'ok' ? r.status === 0 && r.j && r.j.meta : w.startsWith('words:') ? r.message === w.slice(6) : r.sqlstate === w);
    const T = (who, what, r, w) => ok(wantIs(r, w), `${CALL[who].what}: ${what} ${w === 'ok' ? 'allowed' : `refused ${w.startsWith('words:') ? `'${w.slice(6)}'` : w}`} (${outcome(r)})`);
    const both = [PROVO, LOC2];
    let r = rep('ownerT', 'league', { sites: both, ...T7 });
    T('ownerT', 'the league of both sites', r, 'ok');
    ok(r.j?.meta?.stock_level === 'all' && r.j?.meta?.level === 'site' && r.j?.meta?.uid === U.ownerT && r.j?.meta?.service === false && r.j?.meta?.multi === true, `the owner's level is all (meta.stock_level ${r.j?.meta?.stock_level}; meta.level is the drill level, ${r.j?.meta?.level})`);
    r = rep('mgrAll', 'league', { sites: both, ...T7 });
    T('mgrAll', 'both sites (Provo reached through the level, no link row)', r, 'ok');
    ok(r.j?.meta?.stock_level === 'all', `and the level is all (${r.j?.meta?.stock_level})`);
    r = rep('mgrProvo', 'league', { sites: [PROVO], ...T7 });
    T('mgrProvo', 'its own site', r, 'ok');
    ok(r.j?.meta?.stock_level === 'sites', `a sites manager's level is sites (${r.j?.meta?.stock_level}): no Fix, no Targets panel`);
    T('mgrProvo', 'its site and another', rep('mgrProvo', 'league', { sites: both, ...T7 }), 'words:Not allowed: this login does not reach Location 2.');
    T('ownerX', 'a company it does not own named as its own', rep('ownerX', 'league', { org: ORG_X, sites: [PROVO], ...T7 }), 'words:Not allowed: Provo is in another company.');
    T('ownerX', 'the test company beyond its one link', rep('ownerX', 'league', { sites: both, ...T7 }), 'words:Not allowed: this login does not reach Location 2.');
    T('soloOwner', 'another company\'s site', rep('soloOwner', 'league', { sites: [PROVO], ...T7 }), 'words:Not allowed: this login does not reach Provo.');
    T('groupMgr', 'another company\'s sites', rep('groupMgr', 'league', { sites: both, ...T7 }), 'words:Not allowed: this login does not reach Provo.');
    T('ownerT', 'a site of another company in the list', rep('ownerT', 'league', { sites: [PROVO, X1], ...T7 }), 'words:Not allowed: Other company site is in another company.');
    T('superAdmin', 'both sites', rep('superAdmin', 'league', { sites: both, ...T7 }), 'ok');
    for (const who of ['tillProvo', 'kioskProvo', 'mposProvo', 'kdsProvo', 'clockProvo', 'opsLoc2', 'customer', 'noStep']) T(who, 'the league', rep(who, 'league', { sites: [PROVO], ...T7 }), SIGN);
    T('anonKey', 'the league (no EXECUTE)', rep('anonKey', 'league', { sites: [PROVO], ...T7 }), '42501');
    r = rep('service', 'league', { sites: both, ...T7 });
    T('service', 'the league (the Owner app)', r, 'ok');
    ok(r.j?.meta?.service === true && r.j?.meta?.stock_level === 'all' && r.j?.meta?.uid == null, 'the service role is trusted for reach and given level all');
    T('service', 'the gap report (authenticated only)', rep('service', 'gap', { sites: both, ...T7 }), '42501');
    T('service', 'the dashboard (the Owner app)', rep('service', 'dashboard', { sites: both, ...T7 }), 'ok');
    T('ownerT', '51 sites', rep('ownerT', 'league', { sites: Array.from({ length: 51 }, (_, k) => id('e9000000', k + 1)), ...T7 }), 'words:Pick 1 to 50 sites.');
    T('ownerT', 'no site', rep('ownerT', 'league', { sites: [], ...T7 }), 'words:Pick 1 to 50 sites.');
    T('ownerT', 'a 401 day range', rep('ownerT', 'league', { sites: both, from: addDays(ukToday, -401), to: ukToday }), 'words:Pick a start and end day, start first, up to 400 days.');
    T('ownerT', 'the end before the start', rep('ownerT', 'league', { sites: both, from: ukToday, to: addDays(ukToday, -1) }), 'words:Pick a start and end day, start first, up to 400 days.');
    T('ownerT', 'a 400 day range', rep('ownerT', 'league', { sites: both, from: addDays(ukToday, -400), to: ukToday }), 'ok');
    // every report function: the owner allowed, a till and the anon key refused, a sites manager refused another site
    const badAll = [];
    for (const n of D4A_REPORTS) {
      const a = rep('ownerT', n, { sites: both, ...T7 });
      const t = rep('tillProvo', n, { sites: [PROVO], ...T7 });
      const k = rep('anonKey', n, { sites: [PROVO], ...T7 });
      const m = rep('mgrProvo', n, { sites: both, ...T7 });
      const s = rep('noStep', n, { sites: [PROVO], ...T7 });
      if (!(a.status === 0 && a.j?.meta)) badAll.push(`${n} owner ${outcome(a)}`);
      if (t.message !== SIGN.slice(6)) badAll.push(`${n} till ${outcome(t)}`);
      if (k.sqlstate !== '42501') badAll.push(`${n} anon ${outcome(k)}`);
      if (m.message !== 'Not allowed: this login does not reach Location 2.') badAll.push(`${n} manager ${outcome(m)}`);
      if (s.message !== SIGN.slice(6)) badAll.push(`${n} no second step ${outcome(s)}`);
    }
    ok(badAll.length === 0, `all sixteen report functions: the owner allowed; a till, the anon key, a login without the second step and a sites manager on another site refused (${badAll.slice(0, 4).join('; ') || 'all as written'})`);
    // the saves and the export start use the same doors
    T('tillProvo', 'stock_save_targets', callJ('tillProvo', `select public.stock_save_targets('${ORG_T}', '[]'::jsonb)`), '42501');
    T('mgrProvo', 'stock_save_targets (a sites manager is not a company editor)', callJ('mgrProvo', `select public.stock_save_targets('${ORG_T}', ${jlit([{ location_id: null, metric: 'gap_pct', green_to: 1, amber_to: 2 }])})`), '42501');
    T('tillProvo', 'stock_report_export_start', callJ('tillProvo', `select public.stock_report_export_start('gap', ${jlit({ org: ORG_T, sites: [PROVO], from: T7.from, to: T7.to })})`), SIGN);
    T('service', 'stock_report_export_start (a job needs a login)', callJ('service', `select public.stock_report_export_start('gap', ${jlit({ org: ORG_T, sites: [PROVO], from: T7.from, to: T7.to })})`), '42501');
    T('anonKey', 'stock_report_export_cancel', callJ('anonKey', `select public.stock_report_export_cancel('${id('ee000000', 1)}')`), '42501');
  });

  // ============================================================================================================
  // THE WORLD: a seeded copy of the test company over the last few weeks (inside the drainer's 31 days)
  section(33, '33. Every number against an independent oracle (the raw ledger and the checks, every venue day worked out here)');
  const N = QUICK ? 9 : 16;
  const rand = rng(SEED + 4);
  const dayOf = (k) => addDays(ukToday, -(N + 1 - k));     // k = 1..N, the last one yesterday
  let world = null;
  if (want(33) || want(34) || want(35) || want(37)) await guarded('d4a world', () => {
    c.createFrom('n_w1', D4);
    c.use('n_w1');
    world = buildWorld();
  });
  function buildWorld() {
    c.psql({ input: BASKET_SETUP });
    c.psql({ input: basketSql() });
    sql(presetKindsSql);
    sql(`insert into venue_clock (location_id, timezone, day_start, synced_at) values ('${PROVO}', 'Europe/London', '06:00', now()), ('${LOC2}', 'Europe/London', '06:30', now())
         on conflict (location_id) do update set timezone = excluded.timezone, day_start = excluded.day_start`);
    sql(`insert into stock_co_site_settings (location_id, org_id, cost_rule_override) values ('${LOC2}', '${ORG_T}', 'deliveries')`);
    sql(`update user_profiles set stock_control = 'all' where id = '${U.mgrAll}'`);
    // the venues went central before the world's history starts (a check closed more than a day before the
    // switch is held, never booked)
    sql(`update stock_depletion_mode set central_since = now() - interval '60 days' where location_id in ('${PROVO}', '${LOC2}')`);
    // the fixture's sale booked before the drainer saved takes is dated before the world, as every such
    // sale is live (they all come before takes_from)
    sql(`update stock_movements set occurred_at = occurred_at - interval '45 days' where left(source_id, 5) = 'seed-' and movement_type = 'SALE_DEPLETION'`);
    drainAll();
    const items = (loc) => pj(sql(`select json_agg(json_build_object('id', id, 'co', company_ref, 'name', name, 'unit', base_unit) order by name, id) from inventory_items where location_id = '${loc}' and archived_at is null`)) || [];
    const its = { [PROVO]: items(PROVO), [LOC2]: items(LOC2) };
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const costOf = (it) => Number(sql(`select coalesce(current_cost, 0) from inventory_items where id = '${it}'`));
    const post = (loc, it, q, type, src, key, at, who = null) => `select public._post_stock_movement('${loc}', '${it}', ${q}, '${type}', null, '${src}', '${key}', '${key}', '${at}', ${who ? `'${who}'` : 'null'}, null, null)`;
    const shared = its[PROVO].filter((a) => a.co && its[LOC2].some((b) => b.co === a.co)).map((a) => [a.id, its[LOC2].find((b) => b.co === a.co).id]);
    const SUPP = { [PROVO]: sql(`select id from suppliers where location_id = '${PROVO}' order by name limit 1`), [LOC2]: sql(`select id from suppliers where location_id = '${LOC2}' order by name limit 1`) };
    const counts = [];
    const ONLY_P = ['cash', 'card', 'split', 'terminal', 'bartab', 'kiosk', 'pat', 'mpos', 'hubrise', 'ezcater', 'ref-uid', 'ref-full', 'staff-check', 'staff-item', 'staff-label', 'comp',
      'loy-tender', 'loy-kind', 'loy-legacy', 'void-made', 'mods', 'drive', 'sealed'];
    const ONLY_L = ['cash', 'kiosk', 'pat', 'mpos', 'hubrise', 'ezcater', 'ref-uid', 'ref-full', 'void-made', 'staff-label', 'loy-tender'];
    const venues = [
      { p: 'p', loc: PROVO, menu: { a: M.pLatte, b: M.pFlat, c: M.pBoard, juice: BM.juice, shot: BM.shot, drive: BM.drive }, dev: { till: 'tillProvo', kiosk: 'kioskProvo', mpos: 'mposProvo' },
        presets: { staff: DISC.pStaff, comp: DISC.pComp, loyalty: DISC.pLoyalty }, only: ONLY_P },
      { p: 'l', loc: LOC2, menu: { a: M.lLatte, b: M.lSoup, c: M.lBread }, dev: { till: 'tillLoc2', kiosk: 'tillLoc2', mpos: 'tillLoc2' }, presets: { staff: DISC.lStaff }, only: ONLY_L },
    ];
    for (let k = 1; k <= N; k++) {
      const d = dayOf(k);
      const at = (h, m = 0) => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
      const out = [];
      for (const v of venues) {
        const loc = v.loc;
        // a delivery: an order sent the day before, received at today's cost, invoiced
        const po = id('a9000000', `${k}${v.p === 'p' ? 1 : 2}`);
        const lines = [pick(its[loc]), pick(its[loc])].filter((x, j, a) => a.findIndex((y) => y.id === x.id) === j);
        const lq = lines.map(() => 2 + Math.floor(rand() * 18));
        const lc = lines.map((x) => costOf(x.id));
        const sub = lines.reduce((s, _, j) => s + lq[j] * lc[j], 0);
        const late = rand() < 0.3;
        out.push(`insert into purchase_orders (id, location_id, supplier_id, reference, status, expected_date, ordered_at, received_at, subtotal, tax)
                  values ('${po}', '${loc}', ${SUPP[loc] ? `'${SUPP[loc]}'` : 'null'}, 'PO-${k}${v.p}', 'RECEIVED', '${late ? addDays(d, -1) : d}', '${addDays(d, -1)}T15:00:00Z', '${at(9)}', ${sub.toFixed(4)}, ${(sub * 0.2).toFixed(4)})`);
        lines.forEach((x, j) => {
          const short1 = j === 0 && rand() < 0.4;
          out.push(`insert into po_lines (location_id, po_id, inventory_item_id, qty_packs, pack_qty, inner_qty, unit_price, qty_received) values ('${loc}', '${po}', '${x.id}', ${lq[j]}, 1, 1, ${lc[j]}, ${short1 ? lq[j] - 1 : lq[j]})`);
          out.push(post(loc, x.id, short1 ? lq[j] - 1 : lq[j], 'PURCHASE_RECEIPT', 'purchase_order', `w:${k}:${v.p}:rcv:${j}`, at(9)));
          out.push(`insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, pack_price, effective_from, source) values ('${loc}', '${x.id}', ${(lc[j] * (0.95 + rand() * 0.15)).toFixed(4)}, ${lc[j]}, '${at(9)}', '${rand() < 0.5 ? 'INVOICE' : 'PO_RECEIPT'}')`);
        });
        if (rand() < 0.7) out.push(`insert into supplier_invoices (location_id, supplier_id, po_id, invoice_number, invoice_date, status, subtotal, tax, total) values ('${loc}', ${SUPP[loc] ? `'${SUPP[loc]}'` : 'null'}, '${po}', 'INV-${k}${v.p}', '${d}', 'POSTED', ${sub.toFixed(4)}, ${(sub * 0.2).toFixed(4)}, ${(sub * 1.2).toFixed(4)})`);
        // waste, entered with a person and a reason
        const nw = 1 + Math.floor(rand() * 2);
        for (let j = 0; j < nw; j++) {
          const x = pick(its[loc]); const q = 1 + Math.floor(rand() * 2); const wid = id('a8000000', `${k}${v.p === 'p' ? 1 : 2}${j}`);
          const who = rand() < 0.5 ? (loc === PROVO ? U.mgrProvo : U.mgrLoc2) : null;
          out.push(post(loc, x.id, -q, 'WASTE', 'waste', `w:${k}:${v.p}:waste:${j}`, at(15, 10 + j), who));
          out.push(`insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, cost_value, source, logged_by, occurred_at)
                    select '${wid}', '${loc}', '${x.id}', ${lit(x.name)}, ${q}, ${lit(x.unit)}, ${q}, '${pick(['Dropped', 'Out of date', 'Spilled'])}', ${q} * coalesce(current_cost, 0), 'backoffice', ${who ? `'${who}'` : 'null'}, '${at(15, 10 + j)}' from inventory_items where id = '${x.id}'`);
        }
        // labour at Provo only (Location 2 says No labour data)
        if (loc === PROVO) out.push(`insert into wf_timesheets (location_id, org_id, clock_in, clock_out, actual_hours, effective_rate, pay_amount, status) values ('${PROVO}', '${ORG_T}', '${at(7)}', '${at(15)}', 8, 11.5, ${rand() < 0.5 ? 'null' : (80 + rand() * 30).toFixed(2)}, 'approved')`);
      }
      // a transfer Provo to Location 2 of a shared item; a batch at Provo; a cost change
      if (shared.length && (k === 2 || rand() < 0.5)) {
        const [pi, li] = pick(shared); const q = 1 + Math.floor(rand() * 3);
        out.push(post(PROVO, pi, -q, 'TRANSFER_OUT', 'transfer', `w:${k}:tro`, at(10)));
        out.push(post(LOC2, li, q, 'TRANSFER_IN', 'transfer', `w:${k}:tri`, at(11)));
      }
      if (k === 3 || rand() < 0.5) {
        const bid = id('a7000000', k); const planned = 10; const actual = 8 + Math.floor(rand() * 3);
        out.push(`insert into production_batches (id, location_id, output_item_id, output_name, planned_qty, actual_qty, output_unit, status, theoretical_cost, actual_cost, produced_at, produced_by, lot_code)
                  values ('${bid}', '${PROVO}', '${I.pSoup}', 'Soup of the Day (10L)', ${planned}, ${actual}, 'l', 'COMPLETED', 4.2, ${(4 + rand()).toFixed(2)}, '${at(10, 30)}', '${U.mgrProvo}', 'LOT${k}')`);
        out.push(post(PROVO, I.pMilk, -2, 'PRODUCTION_CONSUME', 'production', `w:${k}:bc1`, at(10, 30)));
        out.push(post(PROVO, I.pButter, -1, 'PRODUCTION_CONSUME', 'production', `w:${k}:bc2`, at(10, 30)));
        out.push(post(PROVO, I.pSoup, actual, 'PRODUCTION_OUTPUT', 'production', `w:${k}:bo`, at(10, 30)));
      }
      if (k === 4 || rand() < 0.4) {
        const x = pick(its[PROVO]); const old = costOf(x.id); const nw = Number((old * (0.9 + rand() * 0.25) + 0.01).toFixed(4));
        out.push(`insert into stock_movements (location_id, inventory_item_id, qty_base, unit_cost, value_delta, movement_type, source_type, source_id, occurred_at, posted_at, idempotency_key, notes)
                  select '${PROVO}', id, 0, ${nw}, round(coalesce(on_hand, 0) * (${nw} - coalesce(current_cost, 0)), 4), 'REVALUE', 'harness', 'w${k}', '${at(8)}', now(), 'w:${k}:reval', 'Cost changed' from inventory_items where id = '${x.id}';
                  update inventory_items set current_cost = ${nw} where id = '${x.id}'`);
      }
      // demo history at Provo (day 3) and Location 2 (day 4): never in a figure
      if (k === 3) out.push(post(PROVO, I.pEggs, -2, 'WASTE', 'waste', 'demo-v1:w:egg', at(14)), post(PROVO, I.pEggs, -1, 'WASTE', 'waste', 'w:3:egg', at(13)));
      if (k === 4) out.push(post(LOC2, its[LOC2][0].id, 5, 'PURCHASE_RECEIPT', 'purchase_order', 'seed:w:rcv', at(14)));
      // one movement at 05:30 UK on a day: it belongs to the business day before
      if (k === 5) out.push(post(PROVO, I.pCups, -1, 'WASTE', 'waste', `w:${k}:early`, `${d}T04:30:00Z`));
      sql(`${out.join(';\n')};`);
      // the sales of the day through every channel and the real drainer, at midday
      for (const v of venues) {
        const t0 = Date.parse(`${d}T11:00:00Z`) + (v.p === 'p' ? 0 : 1800000);
        const evs = basketEvents({ p: `w${k}${v.p}`, loc: v.loc, t0, menu: v.menu, price: PRICE, dev: v.dev, presets: v.presets, only: v.only }).filter((e) => e.caller !== 'customer');
        for (const ph of ['A', 'B', 'C']) {
          const body = evs.filter((e) => e.phase === ph).map((e) => e.sql);
          if (body.length) sql(`${body.join(';\n')};`);
          drain();
        }
      }
      // a full count at the end of day 2 and day N-1 (and a spot count on day 4, which between counts ignores)
      for (const kind of [k === 2 || k === N - 1 ? 'FULL' : null, k === 4 ? 'SPOT' : null].filter(Boolean)) {
        for (const v of venues) {
          const cid = id('a6000000', `${k}${v.p === 'p' ? 1 : 2}${kind === 'FULL' ? 1 : 2}`);
          const lines = its[v.loc].filter(() => kind === 'FULL' || rand() < 0.3);
          const adj = lines.map(() => (rand() < 0.35 ? (rand() < 0.7 ? -1 : 1) * (1 + Math.floor(rand() * 2)) : 0));
          const appr = `${d}T21:00:00Z`;
          const q = [`insert into stock_counts (id, location_id, name, count_type, status, started_at, approved_at, approved_by) values ('${cid}', '${v.loc}', 'Count ${k}', '${kind}', 'APPROVED', '${d}T20:00:00Z', '${appr}', '${U.ownerT}')`];
          lines.forEach((x, j) => {
            q.push(`insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, expected_qty, variance_qty, unit_cost)
                    select '${v.loc}', '${cid}', id, coalesce(on_hand, 0) + ${adj[j]}, coalesce(on_hand, 0), ${adj[j]}, coalesce(current_cost, 0) from inventory_items where id = '${x.id}'`);
            if (adj[j] !== 0) q.push(post(v.loc, x.id, adj[j], 'STOCK_COUNT_ADJ', 'stock_count', `w:${k}:${v.p}:cnt:${kind}:${j}`, appr));
          });
          sql(`${q.join(';\n')};`);
          counts.push({ id: cid, loc: v.loc, day: d, kind });
        }
      }
    }
    // pars: some below, one over, minimums
    const parQ = [];
    for (const loc of [PROVO, LOC2]) {
      its[loc].slice(0, 6).forEach((x, j) => parQ.push(`insert into par_levels (location_id, inventory_item_id, par_level, min_level)
        select '${loc}', id, case when ${j} = 5 then greatest(1, floor(coalesce(on_hand, 0) / 3)) else coalesce(on_hand, 0) + ${j + 1} end, case when ${j} < 2 then coalesce(on_hand, 0) + 1 else null end from inventory_items where id = '${x.id}'
        on conflict (location_id, inventory_item_id) do update set par_level = excluded.par_level, min_level = excluded.min_level`));
    }
    sql(`${parQ.join(';\n')};`);
    sql(`insert into xero_connections (location_id, tenant_id, tenant_name) values ('${PROVO}', 't1', 'North Ltd'), ('${LOC2}', 't1', 'North Ltd')`);
    // four items worth exactly the same (ties for the keyset proof), loaded with an opening balance
    const ties = [1, 2, 3, 4].map((n) => id('a5000000', n));
    sql(`insert into inventory_items (id, location_id, org_id, name, kind, base_unit, on_hand, current_cost) values
           ${ties.map((t, n) => `('${t}', '${PROVO}', '${ORG_T}', 'Tie item ${n + 1}', 'PURCHASED', 'each', 0, 2)`).join(', ')};
         ${ties.map((t) => `select public._post_stock_movement('${PROVO}', '${t}', 3, 'OPENING_BALANCE', 2, 'stock_count', 'tie', 'tie:${t}', '${dayOf(1)}T10:00:00Z', null, null, null)`).join(';\n')}`);
    drainAll();
    return { its, counts, shared };
  }

  // the oracle's raw data (read once per database): every movement and check of the company, each venue day here
  function oracleData() {
    const clocks = Object.fromEntries((pj(sql(`select json_agg(json_build_object('loc', l.id, 'tz', coalesce(c.timezone, 'Europe/London'), 'start', to_char(coalesce(c.day_start, '06:00'), 'HH24:MI'),
        'currency', coalesce(nullif(l.currency, ''), 'GBP'))) from locations l left join venue_clock c on c.location_id = l.id where l.org_id = '${ORG_T}'`)) || []).map((x) => [x.loc, x]));
    const mv = (pj(sql(`select coalesce(json_agg(json_build_object('loc', m.location_id, 'item', m.inventory_item_id, 'co', i.company_ref, 'type', m.movement_type, 'qty', m.qty_base,
        'v', m.value_delta, 'at', extract(epoch from m.occurred_at), 'key', m.idempotency_key, 'src', m.source_type, 'sid', m.source_id)), '[]') from stock_movements m join inventory_items i on i.id = m.inventory_item_id
        where m.location_id in ('${PROVO}', '${LOC2}')`)) || []).map((m) => ({ ...m, day: venueDay(m.at, clocks[m.loc].tz, clocks[m.loc].start), demo: isDemo(m.key) }));
    const checks = (pj(sql(`select coalesce(json_agg(json_build_object('row', to_jsonb(c), 'at', extract(epoch from c.closed_at))), '[]') from closed_checks c where c.location_id in ('${PROVO}', '${LOC2}')`)) || [])
      .map((x) => ({ row: x.row, loc: x.row.location_id, day: venueDay(x.at, clocks[x.row.location_id].tz, clocks[x.row.location_id].start) }));
    const books = Object.fromEntries([PROVO, LOC2].map((l) => [l, Number(sql(`select coalesce(sum(coalesce(on_hand, 0) * coalesce(current_cost, 0)), 0) from inventory_items where location_id = '${l}'`))]));
    return { clocks, mv, checks, books };
  }
  // the oracle's figures of one site and window (contract 1.6.2 rules, from the raw rows). kf is the
  // site's takes_from: before it a sale's theoretical cost is the ledger's sale take off on the day the
  // stock left; from it, the take off of each check that CLOSED on a day of the window (its own day,
  // wherever the stock left), the way a sale and its cost must sit together
  function oracle(o, loc, from, to, kf = null) {
    const inW = (m) => m.loc === loc && !m.demo && m.day >= from && m.day <= to;
    const sumT = (types) => o.mv.filter((m) => inW(m) && types.includes(m.type)).reduce((s, m) => s + Number(m.v), 0);
    // the sale's own take off (closed_check); what a refund gives back is not unsold (refunded food is waste)
    const saleTake = o.mv.filter((m) => inW(m) && m.type === 'SALE_DEPLETION' && m.src === 'closed_check').reduce((s, m) => s + Number(m.v), 0);
    const known = ['PURCHASE_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT', 'PRODUCTION_OUTPUT', 'PRODUCTION_CONSUME', 'WASTE', 'REVALUE', 'STOCK_COUNT_ADJ', 'OPENING_BALANCE'];
    const other = o.mv.filter((m) => inW(m) && !known.includes(m.type) && !(m.type === 'SALE_DEPLETION' && m.src === 'closed_check')).reduce((s, m) => s + Number(m.v), 0);
    const allV = o.mv.filter((m) => m.loc === loc).reduce((s, m) => s + Number(m.v), 0);
    const valueAt = (d) => allV - o.mv.filter((m) => m.loc === loc && !m.demo && m.day > d).reduce((s, m) => s + Number(m.v), 0);
    const opening = valueAt(addDays(from, -1)); const closing = valueAt(to);
    const received = sumT(['PURCHASE_RECEIPT']); const tin = sumT(['TRANSFER_IN']); const tout = -sumT(['TRANSFER_OUT']); const ob = sumT(['OPENING_BALANCE']);
    const cks = o.checks.filter((x) => x.loc === loc && x.day >= from && x.day <= to && !(x.row.voided === true || ['void', 'voided'].includes(x.row.status || '')));
    const salesNet = cks.reduce((s, x) => s + jsParts(x.row).net_minor, 0) / 100;
    const takeOf = (m) => m.loc === loc && !m.demo && m.type === 'SALE_DEPLETION' && m.src === 'closed_check';
    const oldTake = o.mv.filter((m) => inW(m) && takeOf(m) && (kf == null || m.day < kf)).reduce((s, m) => s + Number(m.v), 0);
    const closedHere = new Set(kf == null ? [] : cks.filter((x) => x.day >= kf).map((x) => x.row.id));
    const closeTake = o.mv.filter((m) => takeOf(m) && closedHere.has(m.sid)).reduce((s, m) => s + Number(m.v), 0);
    const adj = o.mv.filter((m) => inW(m) && m.type === 'STOCK_COUNT_ADJ');
    return {
      sales_net: salesNet, theo: -(oldTake + closeTake), ledger_take: -saleTake, other, opening, closing, received, tin, tout, ob,
      actual1: opening + received + tin + ob - tout - closing, actual2: -sumT(ACTUAL_KINDS),
      waste: -sumT(['WASTE']), gap: sumT(['STOCK_COUNT_ADJ']), surplus: adj.filter((m) => Number(m.v) > 0).reduce((s, m) => s + Number(m.v), 0),
      unaccounted: adj.filter((m) => Number(m.v) < 0).reduce((s, m) => s + Number(m.v), 0),
      made: sumT(['PRODUCTION_OUTPUT']), used: -sumT(['PRODUCTION_CONSUME']), revalue: sumT(['REVALUE']), sold: -saleTake, allV, books: o.books[loc],
      checks: cks.length,
    };
  }
  const siteRow = (ans, loc) => (ans?.totals || []).find((t) => t.location_id === loc) || null;
  const coRows = (ans) => (ans?.totals || []).filter((t) => t.location_id == null);

  if (world) await guarded('d4a oracle', () => {
    c.use('n_w1');
    const o = oracleData();
    const both = [PROVO, LOC2];
    const F = dayOf(3); const Tt = dayOf(N - 1);   // the window between the two full counts
    const FA = dayOf(1); const TA = dayOf(N);       // the whole world
    ok(both.every((l) => near(o.books[l], o.mv.filter((m) => m.loc === l).reduce((s, m) => s + Number(m.v), 0), 0.01)),
      `the world keeps ledger value equal to the books at both sites (${both.map((l) => `${VNAME[l]} ${o.books[l].toFixed(2)}`).join(', ')}): every cost change posted a REVALUE`);
    const nChecks = num(`select count(*) from closed_checks where left(id, 1) = 'w'`);
    const nMv = o.mv.filter((m) => m.day >= FA && m.day <= TA).length;
    const kinds = pj(sql(`select json_object_agg(movement_type, n) from (select movement_type, count(*) n from stock_movements where location_id in ('${PROVO}', '${LOC2}') group by 1) z`)) || {};
    ok(nChecks > 20 * N && ['SALE_DEPLETION', 'PURCHASE_RECEIPT', 'WASTE', 'STOCK_COUNT_ADJ', 'TRANSFER_IN', 'TRANSFER_OUT', 'PRODUCTION_CONSUME', 'PRODUCTION_OUTPUT', 'REVALUE'].every((t) => kinds[t] > 0),
      `the world (seed ${SEED}, ${N} days): ${nChecks} checks through every channel and the real drainer, ${nMv} movements of every kind (${short(kinds, 300)})`);
    ok(num(`select count(*) from stock_outbox where left(check_id, 1) = 'w' and status <> 'done'`) === 0, 'every sale of the world is posted to stock (no outbox event waiting)');
    for (const [label, from, to, opts] of [['between the two full counts (dates)', F, Tt, null], ['the whole world (dates)', FA, TA, null], ['between counts mode', FA, TA, { between_counts: true }]]) {
      const dash = rep('ownerT', 'dashboard', { sites: both, from, to, opts });
      const mov = rep('ownerT', 'movement', { sites: both, from, to, opts });
      const cogs = rep('ownerT', 'cogs', { sites: both, from, to, opts });
      const gap = rep('ownerT', 'gap', { sites: both, from, to, opts });
      ok([dash, mov, cogs, gap].every((r) => r.status === 0 && r.j), `${label}: the dashboard, movement, cost of sales and gap reports answer (${[dash, mov, cogs, gap].map(outcome).join(', ')})`);
      for (const loc of both) {
        const w = (mov.j?.meta?.windows || []).find((x) => x.location_id === loc) || {};
        const wf = w.from_day || from; const wt = w.to_day || to;
        if (opts?.between_counts) ok(wf === F && wt === Tt && w.opening_counted === true && w.closing_counted === true, `${label}, ${VNAME[loc]}: the window is the two FULL counts (${wf} to ${wt}), the spot count ignored, both counted`);
        const x = oracle(o, loc, wf, wt, w.takes_from || null);
        const d = siteRow(dash.j, loc) || {}; const m = siteRow(mov.j, loc) || {}; const cg = siteRow(cogs.j, loc) || {}; const gp = siteRow(gap.j, loc) || {};
        const pre = `${label}, ${VNAME[loc]}`;
        ok(near(d.sales_net, x.sales_net) && near(cg.sales_net, x.sales_net) && near(gp.sales_net, x.sales_net),
          `${pre}: sales ${d.sales_net} = the one sales rule over the venue days' ${x.checks} checks ${x.sales_net.toFixed(2)}`);
        ok(near(d.theo_cost, x.theo) && near(cg.theo_cost, x.theo) && near(x.theo, x.ledger_take),
          `${pre}: theoretical cost ${cg.theo_cost} = the sale take off of the checks closed on these days (the ledger before takes_from ${w.takes_from}) ${x.theo.toFixed(4)} = the ledger's take off by the day the stock left ${x.ledger_take.toFixed(4)} (no sale here is dated ahead)`);
        ok(near(x.actual1, x.actual2) && near(cg.actual_cost, x.actual1) && near(d.actual_cost, x.actual2),
          `${pre}: actual cost ${cg.actual_cost} = opening + purchases + transfers in - transfers out - closing ${x.actual1.toFixed(4)} = minus the consumption ${x.actual2.toFixed(4)} (to the penny)`);
        ok(near(m.opening_value, x.opening) && near(m.closing_value, x.closing), `${pre}: opening ${m.opening_value} and closing ${m.closing_value} = the ledger at the day's end (${x.opening.toFixed(4)}, ${x.closing.toFixed(4)})`);
        ok(near(m.received, x.received) && near(m.transfers_in, x.tin) && near(m.transfers_out, x.tout) && near(m.made, x.made) && near(m.used_in_batches, x.used)
           && near(m.sold_cost, x.sold) && near(m.waste_value, x.waste) && near(m.revalue, x.revalue) && near(m.count_adj, x.gap)
           && near(m.opening_balance, x.ob) && near(m.other, x.other),
          `${pre}: every movement line (received ${m.received}, transfers ${m.transfers_in} in and ${m.transfers_out} out, made ${m.made}, used ${m.used_in_batches}, sold ${m.sold_cost}, waste ${m.waste_value}, revalue ${m.revalue}, counts ${m.count_adj}, opening balances ${m.opening_balance}, refunds given back ${m.other})`);
        ok(near(m.expected_closing, x.opening + x.received + x.ob + x.tin + x.made + x.revalue + x.other - x.sold - x.used - x.tout - x.waste) && near(m.gap, m.count_adj) && near(Number(m.closing_value) - Number(m.expected_closing), x.gap),
          `${pre}: expected closing ${m.expected_closing}; closing less expected = the count adjustments ${x.gap.toFixed(4)}`);
        ok(near(gp.gap_value, x.gap) && near(gp.surplus, x.surplus) && near(gp.unaccounted, x.unaccounted) && near(gp.waste_value, x.waste)
           && (x.sales_net === 0 ? gp.gap_pct == null : near(gp.gap_pct, Math.round((-x.gap / x.sales_net) * 10000) / 100, 0.011)),
          `${pre}: gap ${gp.gap_value} (${gp.gap_pct}% of sales) = the count adjustments; surplus ${gp.surplus}, unaccounted ${gp.unaccounted}, waste ${gp.waste_value}`);
        const sd = pj(sql(`select json_build_object('l', coalesce(sum(loyalty_cost), 0), 's', coalesce(sum(staff_cost), 0), 'c', coalesce(sum(comp_cost), 0),
            'q', coalesce(sum(loyalty_qty + staff_qty + comp_qty), 0)) from sales_day_sums where location_id = '${loc}' and business_day between '${wf}' and '${wt}'`)) || {};
        ok(near(cg.loyalty_cost, sd.l) && near(cg.staff_cost, sd.s) && near(cg.comp_cost, sd.c) && near(cg.comps_cost, sd.l + sd.s + sd.c) && near(cg.comps_qty, sd.q, 1e-6)
           && near(cg.gp_before, x.sales_net - x.theo) && near(cg.gp_after, x.sales_net - x.theo + (sd.l + sd.s + sd.c)),
          `${pre}: the loyalty, staff and comps line ${cg.comps_cost} = the kinds (loyalty ${sd.l}, staff ${sd.s}, comps ${sd.c}); GP before ${cg.gp_before}, after ${cg.gp_after}`);
        ok(x.sales_net === 0 ? cg.gp_pct_theo == null : near(cg.gp_pct_theo, Math.round(((x.sales_net - x.theo) / x.sales_net) * 10000) / 100, 0.011),
          `${pre}: GP % theo ${cg.gp_pct_theo}, actual ${cg.gp_pct_actual}`);
      }
      // company rows: one per currency, the sum of the site rows
      const co = coRows(cogs.j);
      ok(co.length === 1 && co[0].currency === 'GBP' && near(co[0].sales_net, both.reduce((s, l) => s + Number(siteRow(cogs.j, l)?.sales_net || 0), 0))
         && near(co[0].comps_cost, both.reduce((s, l) => s + Number(siteRow(cogs.j, l)?.comps_cost || 0), 0)),
        `${label}: one company row (GBP), the sum of the site rows, site rows first (${(cogs.j?.totals || []).map((t) => t.site).join(', ')})`);
      ok((cogs.j?.totals || []).findIndex((t) => t.location_id == null) === both.length, `${label}: totals are site rows first, then the company`);
    }
    // product GP adds up to site GP, from takes_from on
    const ans = allPages('ownerT', 'product_gp', { sites: both, from: F, to: Tt, opts: { level: 'site_product' } }, 1000);
    const pg = rep('ownerT', 'product_gp', { sites: both, from: F, to: Tt });
    const cg2 = rep('ownerT', 'cogs', { sites: both, from: F, to: Tt });
    for (const loc of both) {
      const prows = ans.rows.filter((r) => r.location_id === loc);
      const sNet = prows.reduce((s, r) => s + Number(r.sales_net), 0); const sTheo = prows.reduce((s, r) => s + Number(r.theo_cost || 0), 0);
      const st = siteRow(pg.j, loc) || {}; const cs = siteRow(cg2.j, loc) || {};
      const takes = (pg.j?.meta?.windows || []).find((w) => w.location_id === loc)?.takes_from;
      ok(near(sNet, st.sales_net) && near(sNet, cs.sales_net) && near(sTheo, st.theo_cost) && near(Number(st.gp), sNet - sTheo),
        `${VNAME[loc]}: product rows add up to the site to the penny (net ${sNet.toFixed(2)} = ${st.sales_net} = cost of sales ${cs.sales_net}; plate cost ${sTheo.toFixed(4)} = ${st.theo_cost}; GP ${st.gp})`);
      ok(takes != null && takes <= F && near(st.theo_cost, cs.theo_cost),
        `${VNAME[loc]}: from takes_from (${takes}) the product plate cost ${st.theo_cost} = the site theoretical cost from the ledger ${cs.theo_cost}`);
    }
    // the night the release goes live: a sale taken off by the old rule (no takes) earlier on the first
    // take day makes takes_from the next day, so no window claims a plate cost it does not have
    // (tried in a transaction that is rolled back: the world's numbers do not move)
    {
      const r = c.psql({ input: `begin;
        set local session_replication_role = replica;
        insert into stock_movements (location_id, inventory_item_id, qty_base, unit_cost, value_delta, movement_type, source_type, source_id, occurred_at, idempotency_key)
        select m.location_id, m.inventory_item_id, -1, m.unit_cost, -coalesce(m.unit_cost, 0), 'SALE_DEPLETION', 'sale', 'old-rule-1',
               (select min(t.occurred_at) from stock_sale_takes t where t.location_id = '${PROVO}') - interval '1 second', 'old-rule-1:1'
          from stock_movements m where m.location_id = '${PROVO}' and m.movement_type = 'SALE_DEPLETION' limit 1;
        select json_build_object('before', (select (public.stock_co__venue_day('${PROVO}', min(t.occurred_at) - interval '1 second')).business_day from stock_sale_takes t where t.location_id = '${PROVO}'),
                                 'first', (select (public.stock_co__venue_day('${PROVO}', min(t.occurred_at))).business_day from stock_sale_takes t where t.location_id = '${PROVO}'),
                                 'takes_from', public.stock_rp__takes_from('${PROVO}'));
        rollback;`, allowFail: true });
      const t = pj((r.stdout || '').trim().split('\n').filter(Boolean).pop()) || {};
      const want = t.before === t.first ? sql(`select ('${t.first}'::date + 1)::text`) : t.first;
      ok(r.status === 0 && t.first && t.takes_from === want,
        `Provo: an old rule sale just before the first take (venue day ${t.before}, first take ${t.first}) gives takes_from ${t.takes_from} (want ${want})${r.status ? `: ${short(r.stderr, 300)}` : ''}`);
    }
    // A sale whose stock leaves on another day than the day it closed (an ezCater order closed for three
    // days ahead: its stock is taken off now, its sale sits on its own day): the theoretical cost sits
    // with the sale, so site GP and product GP agree on both sides of the window edge, and the stock
    // movement still shows the stock leaving today (on a copy: the world does not move)
    {
      const d0 = ukToday;
      const atAhead = `${addDays(today, 3)}T12:00:00Z`;
      const d3 = venueDay(Date.parse(atAhead) / 1000, 'Europe/London', '06:00');
      const look = () => ({
        c0: siteRow(rep('ownerT', 'cogs', { sites: both, from: d0, to: d0 }).j, PROVO) || {},
        c3: siteRow(rep('ownerT', 'cogs', { sites: both, from: d3, to: d3 }).j, PROVO) || {},
        m0: siteRow(rep('ownerT', 'movement', { sites: both, from: d0, to: d0 }).j, PROVO) || {},
        p0: siteRow(rep('ownerT', 'product_gp', { sites: both, from: d0, to: d0 }).j, PROVO) || {},
        p3: siteRow(rep('ownerT', 'product_gp', { sites: both, from: d3, to: d3 }).j, PROVO) || {},
        r3: allPages('ownerT', 'product_gp', { sites: both, from: d3, to: d3, opts: { level: 'site_product' } }, 1000).rows.filter((r) => r.location_id === PROVO),
      });
      const before = look();
      c.createFrom('n_w1_ahead', 'n_w1');
      c.use('n_w1_ahead');
      const pr = Number(PRICE[M.pLatte] || 3);
      const sub = Math.round(4 * pr * 100) / 100;
      sql(insertRow({ id: 'w-ez-ahead', location_id: PROVO, ref: 'WEZAHEAD', closed_at: atAhead, items: [{ itemId: M.pLatte, qty: 4, price: pr, uid: 'ez1' }],
        subtotal: sub, total: sub, tax_amount: Math.round((sub * 0.2 / 1.2) * 100) / 100, service: 0, tip: 0, source: 'ezcater', order_type: 'catering', status: 'paid',
        voided: false, refunds: [], discounts: [], method: 'ezcater', payment_method: 'ezcater', tenders: [{ method: 'ezcater', amount: sub, tip: 0 }] }));
      drainAll();
      sql(`update sales_day_sums_queue set due_at = now() - interval '1 second'`);
      dsDrainAll();
      const mv = pj(sql(`select json_build_object('cost', coalesce(-sum(m.value_delta), 0), 'day', min(v.business_day)::text)
                           from stock_movements m cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) v
                          where m.source_id = 'w-ez-ahead' and m.movement_type = 'SALE_DEPLETION' and m.source_type = 'closed_check'`)) || {};
      const net = Number(sql(`select coalesce(sum(net), 0) from sales_day_sums where location_id = '${PROVO}' and business_day = '${d3}'`)) - Number(before.c3.sales_net || 0);
      const after = look();
      ok(Number(mv.cost) > 0 && mv.day === d0 && d3 > d0 && net > 0,
        `an ezCater order closed for ${d3}: its stock left on ${mv.day} (cost ${Number(mv.cost).toFixed(4)}), its sale (${net.toFixed(2)}) sits on ${d3}`);
      ok(near(after.c0.theo_cost, before.c0.theo_cost) && near(after.c0.sales_net, before.c0.sales_net) && near(after.m0.sold_cost, Number(before.m0.sold_cost || 0) + Number(mv.cost)),
        `${d0}: no sale, so no theoretical cost (${before.c0.theo_cost} then ${after.c0.theo_cost}); the stock movement still shows the stock leaving (sold ${before.m0.sold_cost} then ${after.m0.sold_cost})`);
      ok(near(after.c3.theo_cost, Number(before.c3.theo_cost || 0) + Number(mv.cost)) && near(after.c3.sales_net, Number(before.c3.sales_net || 0) + net),
        `${d3}: the sale and its cost together (sales ${after.c3.sales_net}, theoretical cost ${after.c3.theo_cost})`);
      const sumGp = after.r3.reduce((t, r) => t + Number(r.gp || 0), 0);
      ok([['p0', 'c0'], ['p3', 'c3']].every(([p, q]) => near(after[p].gp, after[q].gp_before) && near(after[p].theo_cost, after[q].theo_cost)) && near(sumGp, after.p3.gp),
        `both sides of the edge: product GP = site GP (${d0}: ${after.p0.gp} = ${after.c0.gp_before}; ${d3}: ${after.p3.gp} = ${after.c3.gp_before} = the product rows ${sumGp.toFixed(4)})`);
      c.use('n_w1');
    }
    // A window that starts before takes_from (the first weeks after the release, or any range over the
    // backfilled months): sales taken off by the old rule, with no takes, two and three days before it.
    // Site theoretical cost is the ledger's before takes_from and the takes' from it; product GP and
    // GP by type are over the days the plate cost is known only, and add up to the site over those
    // days; the loyalty, staff and comps cost is not known, never a 0 (on a copy)
    {
      const kf = sql(`select public.stock_rp__takes_from('${PROVO}')::text`);
      const b1 = addDays(kf, -3); const b2 = addDays(kf, -2); const to = addDays(kf, 2);
      c.createFrom('n_w1_old', 'n_w1');
      c.use('n_w1_old');
      const pr = Number(PRICE[M.pLatte] || 3);
      const old = [['w-old-1', b1], ['w-old-2', b2]];
      c.psql({ input: `begin;
        set local session_replication_role = replica;
        ${old.map(([cid, d]) => `${insertRow({ id: cid, location_id: PROVO, ref: cid.toUpperCase(), closed_at: `${d}T12:00:00Z`, items: [{ itemId: M.pLatte, qty: 2, price: pr }],
          subtotal: 2 * pr, total: 2 * pr, tax_amount: Math.round((2 * pr * 0.2 / 1.2) * 100) / 100, service: 0, tip: 0, source: 'pos', order_type: 'dine-in', status: 'paid', voided: false,
          refunds: [], discounts: [], method: 'cash', payment_method: 'cash', tenders: [{ method: 'cash', amount: 2 * pr, tip: 0 }] })};`).join('\n')}
        commit;` });
      sql(old.map(([cid, d]) => `select public._post_stock_movement('${PROVO}', '${I.pMilk}', -0.4, 'SALE_DEPLETION', null, 'closed_check', '${cid}', 'oldrule:${cid}', '${d}T12:00:00Z', null, null, null)`).join(';\n') + ';');
      sql(`insert into sales_day_sums_queue (location_id, business_day, reason, due_at) values ('${PROVO}', '${b1}', 'harness', now() - interval '1 second'), ('${PROVO}', '${b2}', 'harness', now() - interval '1 second')
           on conflict do nothing;
           update sales_day_sums_queue set due_at = now() - interval '1 second'`);
      dsDrainAll();
      const o2 = oracleData();
      const cg = rep('ownerT', 'cogs', { sites: both, from: b1, to }).j || {};
      const ck = rep('ownerT', 'cogs', { sites: both, from: kf, to }).j || {};
      const wk = allPages('ownerT', 'cogs', { sites: both, from: b1, to, opts: { level: 'week' } }, 1000).rows.filter((r) => r.location_id === PROVO);
      const pg2 = rep('ownerT', 'product_gp', { sites: both, from: b1, to }).j || {};
      const pr2 = allPages('ownerT', 'product_gp', { sites: both, from: b1, to, opts: { level: 'site_product' } }, 1000).rows.filter((r) => r.location_id === PROVO);
      const db2 = rep('ownerT', 'dashboard', { sites: both, from: b1, to }).j || {};
      const x = oracle(o2, PROVO, b1, to, kf);
      const s1 = siteRow(cg, PROVO) || {}; const sk = siteRow(ck, PROVO) || {}; const p1 = siteRow(pg2, PROVO) || {};
      const oldNet = num(`select coalesce(sum(net), 0) from sales_day_sums where location_id = '${PROVO}' and business_day between '${b1}' and '${addDays(kf, -1)}'`);
      ok(oldNet > 0 && sql(`select public.stock_rp__takes_from('${PROVO}')::text`) === kf && (pg2.meta?.windows || []).find((w) => w.location_id === PROVO)?.takes_from === kf,
        `Provo: old rule sales on ${b1} and ${b2} (${oldNet.toFixed(2)} of sales with no takes) before takes_from ${kf}, which they do not move`);
      ok(near(s1.theo_cost, x.theo) && near(s1.sales_net, x.sales_net),
        `${b1} to ${to}: site theoretical cost ${s1.theo_cost} = the ledger's take off before ${kf} and the takes' from it (${x.theo.toFixed(4)}); sales ${s1.sales_net}`);
      ok(s1.comps_cost === null && s1.gp_after === null && (siteRow(db2, PROVO) || {}).comps_pct === null && (coRows(cg)[0] || {}).comps_cost === null
         && (cg.meta?.notes || []).some((n) => n.startsWith('Loyalty, staff and comps cost not known before ') && n.endsWith(' at Provo')),
        `the loyalty, staff and comps cost is not known when sales before takes_from have none (site and company null, never 0): "${(cg.meta?.notes || []).find((n) => n.startsWith('Loyalty')) || 'no line'}" (${short({ c: s1.comps_cost, a: s1.gp_after, p: s1.comps_pct, co: (coRows(cg)[0] || {}).comps_cost })})`);
      ok(near(p1.known_net, sk.sales_net) && near(p1.theo_cost, sk.theo_cost) && near(p1.gp, sk.gp_before) && near(p1.sales_net, s1.sales_net) && p1.known_from === kf,
        `product GP over the days the plate cost is known: sales with a plate cost ${p1.known_net} = the site's from ${kf} ${sk.sales_net}; plate cost ${p1.theo_cost} = ${sk.theo_cost}; GP ${p1.gp} = the site's ${sk.gp_before}; all sales ${p1.sales_net}`);
      const sGp = pr2.reduce((t, r) => t + Number(r.gp || 0), 0); const sKn = pr2.reduce((t, r) => t + Number(r.known_net || 0), 0); const sNet = pr2.reduce((t, r) => t + Number(r.sales_net || 0), 0);
      const latte = pr2.find((r) => r.menu_item_id === M.pLatte) || {};
      ok(near(sGp, p1.gp) && near(sKn, p1.known_net) && near(sNet, p1.sales_net) && near(Number(latte.sales_net) - Number(latte.known_net), oldNet)
         && pr2.every((r) => r.theo_cost == null || near(r.gp, Number(r.known_net) - Number(r.theo_cost))),
        `the product rows add up to the site (GP ${sGp.toFixed(4)}, sales with a plate cost ${sKn.toFixed(2)}, sales ${sNet.toFixed(2)}); the latte's old rule sales ${(Number(latte.sales_net) - Number(latte.known_net)).toFixed(2)} are sales with no plate cost, never GP`);
      const co = coRows(pg2)[0] || {};
      ok(near(co.gp, both.reduce((t, l) => t + Number(siteRow(pg2, l)?.gp || 0), 0)) && near(co.known_net, both.reduce((t, l) => t + Number(siteRow(pg2, l)?.known_net || 0), 0)),
        `the company product row is the sum of the sites over the same days (GP ${co.gp}, sales with a plate cost ${co.known_net})`);
      const types = db2.rows?.by_type || [];
      ok(near(types.reduce((t, r) => t + Number(r.known_net || 0), 0), co.known_net) && near(types.reduce((t, r) => t + Number(r.theo_cost || 0), 0), co.theo_cost)
         && near(types.reduce((t, r) => t + Number(r.sales_net || 0), 0), coRows(db2)[0]?.sales_net),
        `GP by type is over the same known days (sales with a plate cost ${types.map((t) => `${t.type} ${t.known_net}`).join(', ')}), its sales every day's`);
      ok(near(wk.reduce((t, r) => t + Number(r.theo_cost || 0), 0), s1.theo_cost) && near(wk.reduce((t, r) => t + Number(r.sales_net || 0), 0), s1.sales_net),
        `the weeks of Provo add up to its site row (theoretical cost ${wk.reduce((t, r) => t + Number(r.theo_cost || 0), 0).toFixed(4)})`);
      c.use('n_w1');
    }
    const prod = allPages('ownerT', 'product_gp', { sites: both, from: F, to: Tt }, 1000);
    ok(near(prod.rows.reduce((s, r) => s + Number(r.sales_net), 0), coRows(pg.j)[0]?.sales_net) && prod.rows.every((r) => ['Star', 'Plowhorse', 'Puzzle', 'Dog', 'Unknown'].includes(r.class)),
      `company product rows add up to the company row (${prod.rows.length} products), each with a menu engineering class`);
    // waste by reason and person add up to the site; and to the ledger's WASTE line where every entry has one
    const ws = rep('ownerT', 'waste', { sites: both, from: F, to: Tt });
    for (const loc of both) {
      const site = siteRow(ws.j, loc) || {};
      const ev = pj(sql(`select json_build_object('v', coalesce(sum(w.cost_value), 0), 'n', count(*)) from waste_events w cross join lateral public.stock_co__venue_day(w.location_id, w.occurred_at) d
                          where w.location_id = '${loc}' and d.business_day between '${F}' and '${Tt}'`)) || {};
      const byR = allPages('ownerT', 'waste', { sites: both, from: F, to: Tt, opts: { level: 'reason' } }, 1000).rows.filter((r) => r.location_id === loc);
      const byP = allPages('ownerT', 'waste', { sites: both, from: F, to: Tt, opts: { level: 'person' } }, 1000).rows.filter((r) => r.location_id === loc);
      const byI = allPages('ownerT', 'waste', { sites: both, from: F, to: Tt, opts: { level: 'item' } }, 1000).rows.filter((r) => r.location_id === loc);
      ok(near(site.waste_value, ev.v) && Number(site.events) === Number(ev.n) && near(byR.reduce((s, r) => s + Number(r.value), 0), ev.v)
         && near(byP.reduce((s, r) => s + Number(r.value), 0), ev.v) && near(byI.reduce((s, r) => s + Number(r.value), 0), ev.v) && byI.every((r) => r.top_reason),
        `${VNAME[loc]}: waste ${site.waste_value} from ${site.events} entries; by reason, by person and by item each add up to it (each item with its top reason)`);
    }
    // purchases: ordered, received, invoiced
    const pu = rep('ownerT', 'purchases', { sites: both, from: F, to: Tt });
    for (const loc of both) {
      const site = siteRow(pu.j, loc) || {};
      const x = oracle(o, loc, F, Tt);
      const e = pj(sql(`select json_build_object(
          'ordered', (select coalesce(sum(subtotal), 0) from purchase_orders p cross join lateral public.stock_co__venue_day(p.location_id, p.ordered_at) d where p.location_id = '${loc}' and p.status in ('SENT', 'PARTIAL', 'RECEIVED') and d.business_day between '${F}' and '${Tt}'),
          'invoiced', (select coalesce(sum(subtotal), 0) from supplier_invoices v where v.location_id = '${loc}' and v.status = 'POSTED' and v.invoice_date between '${F}' and '${Tt}'))`)) || {};
      ok(near(site.received, x.received) && near(site.ordered, e.ordered) && near(site.invoiced, e.invoiced) && site.on_time_pct != null && site.short_pct != null,
        `${VNAME[loc]}: purchases ordered ${site.ordered}, received ${site.received} (the delivery value), invoiced ${site.invoiced}; on time ${site.on_time_pct}%, short ${site.short_pct}%`);
    }
    ok((pu.j?.meta?.notes || []).includes('Purchases at delivery value until the purchasing update'), 'and the note says purchases are at delivery value until the purchasing update');
    // prices paid: the spread per item from the cost history
    const pr = allPages('ownerT', 'prices', { sites: both, from: F, to: Tt }, 1000);
    const ph = pj(sql(`select json_object_agg(k, json_build_object('lo', lo, 'hi', hi, 'n', n)) from (select h.inventory_item_id::text as k, min(h.base_unit_cost) lo, max(h.base_unit_cost) hi, count(*) n
                         from item_cost_history h cross join lateral public.stock_co__venue_day(h.location_id, h.effective_from) d
                        where h.location_id in ('${PROVO}', '${LOC2}') and h.source in ('INVOICE', 'PO_RECEIPT') and d.business_day between '${F}' and '${Tt}'
                          and (select company_ref from inventory_items where id = h.inventory_item_id) is null group by 1) z`)) || {};
    const coPh = pj(sql(`select json_object_agg(k, json_build_object('lo', lo, 'hi', hi)) from (select i.company_ref::text as k, min(h.base_unit_cost) lo, max(h.base_unit_cost) hi
                         from item_cost_history h join inventory_items i on i.id = h.inventory_item_id cross join lateral public.stock_co__venue_day(h.location_id, h.effective_from) d
                        where h.location_id in ('${PROVO}', '${LOC2}') and h.source in ('INVOICE', 'PO_RECEIPT') and d.business_day between '${F}' and '${Tt}' and i.company_ref is not null group by 1) z`)) || {};
    const prBad = pr.rows.filter((r) => { const e = coPh[r.company_item_id] || ph[r.key?.split(':')[1]]; return !e || !near(r.paid_low, e.lo, 1e-4) || !near(r.paid_high, e.hi, 1e-4); });
    ok(pr.rows.length > 0 && prBad.length === 0, `prices: lowest and highest paid per item across the sites = the cost history (${pr.rows.length} items; ${short(prBad.slice(0, 2))})`);
    // days on hand: value now over the last 28 days' use
    const doh = rep('ownerT', 'days_on_hand', { sites: both, from: F, to: Tt });
    for (const loc of both) {
      const site = siteRow(doh.j, loc) || {};
      const e = pj(sql(`select json_build_object('v', (select coalesce(sum(on_hand * coalesce(current_cost, 0)), 0) from inventory_items where location_id = '${loc}' and archived_at is null and on_hand > 0),
          'u', (select coalesce(-sum(m.value_delta), 0) from stock_movements m join inventory_items i on i.id = m.inventory_item_id and i.archived_at is null
                 cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d
                 cross join lateral public.stock_co__venue_day('${loc}', now()) t
                where m.location_id = '${loc}' and m.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME') and not public.stock_rp__is_demo(m.idempotency_key)
                  and d.business_day between t.business_day - 27 and t.business_day))`)) || {};
      ok(near(site.stock_value_now, e.v) && near(Number(site.daily_use) * 28, e.u, 0.01) && (e.u === 0 ? site.days_on_hand == null : near(site.days_on_hand, Math.round((e.v / (e.u / 28)) * 10) / 10, 0.051)),
        `${VNAME[loc]}: days on hand ${site.days_on_hand} = value now ${site.stock_value_now} over the average day's use of the last 28 days (${(e.u / 28).toFixed(4)})`);
    }
    // par and stock outs against a day by day replay of the ledger
    const par = rep('ownerT', 'par', { sites: both, from: F, to: Tt });
    const outs = allPages('ownerT', 'par', { sites: both, from: F, to: Tt, opts: { level: 'stockout' } }, 1000).rows;
    for (const loc of both) {
      const site = siteRow(par.j, loc) || {};
      const e = pj(sql(`select json_build_object('below', count(*) filter (where p.par_level is not null and i.on_hand < p.par_level), 'min', count(*) filter (where p.min_level is not null and i.on_hand < p.min_level),
          'over', count(*) filter (where p.par_level > 0 and i.on_hand > p.par_level * 1.5)) from inventory_items i join par_levels p on p.inventory_item_id = i.id where i.location_id = '${loc}' and i.archived_at is null`)) || {};
      const neg = num(`select count(*) from inventory_items where location_id = '${loc}' and archived_at is null and on_hand < 0`);
      // the replay: each live item's quantity at the end of every day of the window
      const live = (pj(sql(`select json_agg(json_build_object('id', id, 'q', coalesce(on_hand, 0))) from inventory_items where location_id = '${loc}' and archived_at is null`)) || []);
      let zeroDays = 0; let zeroItems = 0;
      for (const it of live) {
        let n = 0;
        for (let d = F; d <= Tt; d = addDays(d, 1)) {
          const q = it.q - o.mv.filter((m) => m.loc === loc && m.item === it.id && !m.demo && m.day > d).reduce((s, m) => s + Number(m.qty), 0);
          if (q <= 0) n++;
        }
        zeroDays += n; if (n) zeroItems++;
      }
      const ro = outs.filter((r) => r.location_id === loc);
      ok(Number(site.below_par) === e.below && Number(site.below_min) === e.min && Number(site.over_par) === e.over && Number(site.negative) === neg,
        `${VNAME[loc]}: below par ${site.below_par}, below minimum ${site.below_min}, over par ${site.over_par}, negative ${site.negative} (as the rows say)`);
      ok(Number(site.stock_outs) === zeroDays && ro.length === zeroItems && ro.reduce((s, r) => s + Number(r.days_at_zero), 0) === zeroDays,
        `${VNAME[loc]}: stock outs ${site.stock_outs} item days at or below zero = a day by day replay of the ledger (${zeroDays} over ${zeroItems} items)`);
    }
    // key ratios: milk per latte, saved by the owner
    const milkCo = sql(`select company_ref from inventory_items where id = '${I.pMilk}'`);
    const sv = callJ('ownerT', `select public.stock_save_key_ratios('${ORG_T}', ${jlit([{ id: null, name: 'Milk per latte', used_item_id: milkCo, used_unit: 'l', sold_rule: { kind: 'items', menu_item_ids: [M.pLatte, M.lLatte] }, recipe_amount: 0.2, sort_order: 1 }])}, 'reports')`);
    ok(sv.status === 0 && sv.j?.ok === true, `the owner saves a key item (${outcome(sv)})`);
    const kr = rep('ownerT', 'key_ratios', { sites: both, from: F, to: Tt });
    for (const loc of both) {
      const row = (kr.j?.totals || []).find((t) => t.location_id === loc) || {};
      const used = -o.mv.filter((m) => m.loc === loc && !m.demo && m.day >= F && m.day <= Tt && m.type === 'SALE_DEPLETION' && m.src === 'closed_check' && m.co === milkCo).reduce((s, m) => s + Number(m.qty), 0);
      const sold = Number(sql(`select coalesce(sum(qty), 0) from sales_day_sums where location_id = '${loc}' and business_day between '${F}' and '${Tt}' and menu_item_id in ('${M.pLatte}', '${M.lLatte}')`));
      ok(near(row.used_qty, used, 1e-6) && near(row.sold_qty, sold, 1e-6) && (sold === 0 ? row.per_sold == null : near(row.per_sold, Math.round((used / sold) * 10000) / 10000, 1e-4)),
        `${VNAME[loc]}: milk used ${row.used_qty} against ${row.sold_qty} lattes sold = ${row.per_sold} a latte (recipe ${row.recipe_amount}, ${row.diff_pct}%)`);
    }
    const dk = rep('ownerT', 'dashboard', { sites: both, from: F, to: Tt });
    ok((dk.j?.rows?.key_items || []).some((t) => t.name === 'Milk per latte'), 'the dashboard key item tiles carry it');
    // setup health and batches
    const shh = rep('ownerT', 'setup_health', { sites: both, from: F, to: Tt });
    for (const loc of both) {
      const site = siteRow(shh.j, loc) || {};
      const e = pj(sql(`select json_build_object('nr', coalesce(sum(s.net) filter (where not exists (select 1 from menu_item_recipes r where r.location_id = s.location_id and r.menu_item_id = s.menu_item_id)), 0),
          'arch', (select count(*) from inventory_items where location_id = '${loc}' and archived_at is not null and on_hand <> 0)) from sales_day_sums s where s.location_id = '${loc}' and s.business_day between '${F}' and '${Tt}'`)) || {};
      ok(near(site.no_recipe_sales_net, e.nr) && Number(site.archived_holding) === e.arch && site.recipes_over_target === null && site.recipes_missing_cost === null,
        `${VNAME[loc]}: sales with no recipe ${site.no_recipe_sales_net} (${site.no_recipe_pct}%), archived items holding stock ${site.archived_holding}; recipe targets and costs come with the recipes update`);
    }
    const bt = rep('ownerT', 'batches', { sites: both, from: F, to: Tt });
    const bs = siteRow(bt.j, PROVO) || {};
    const be = pj(sql(`select json_build_object('n', count(*), 'p', coalesce(sum(planned_qty), 0), 'a', coalesce(sum(actual_qty), 0)) from production_batches b cross join lateral public.stock_co__venue_day(b.location_id, b.produced_at) d
                         where b.location_id = '${PROVO}' and b.status = 'COMPLETED' and d.business_day between '${F}' and '${Tt}'`)) || {};
    const xo = oracle(o, PROVO, F, Tt);
    ok(Number(bs.batches) === be.n && near(bs.planned_qty, be.p, 1e-6) && near(bs.actual_qty, be.a, 1e-6) && near(bs.made_value, xo.made) && near(bs.used_value, xo.used)
       && (be.p === 0 ? bs.yield_pct == null : near(bs.yield_pct, Math.round((be.a / be.p) * 10000) / 100, 0.011)),
      `Provo batches: ${bs.batches} made, yield ${bs.yield_pct}% (${be.a} of ${be.p}), made ${bs.made_value} and used ${bs.used_value} = the ledger`);
    // labour: Flash GP at Provo, 'No labour data' at Location 2
    const cg3 = rep('ownerT', 'cogs', { sites: both, from: F, to: Tt });
    const lp = siteRow(cg3.j, PROVO) || {}; const ll = siteRow(cg3.j, LOC2) || {};
    const lab = Number(sql(`select coalesce(sum(coalesce(pay_amount, actual_hours * effective_rate)), 0) from wf_timesheets t cross join lateral public.stock_co__venue_day(t.location_id, t.clock_in) d
                             where t.location_id = '${PROVO}' and d.business_day between '${F}' and '${Tt}'`));
    ok(near(lp.labour, lab) && lp.labour_has_data === true && ll.labour == null && ll.labour_has_data === false && ll.flash_gp_pct == null,
      `labour ${lp.labour} at Provo (Flash GP ${lp.flash_gp_pct}%); Location 2 has no timesheet: labour null, 'No labour data'`);
    // the value report on a past day equals the ledger at that day's end, per site and per item
    const vd = dayOf(Math.floor(N / 2));
    const val = rep('ownerT', 'value', { sites: both, from: vd, to: vd });
    const vi = allPages('ownerT', 'value', { sites: both, from: vd, to: vd, opts: { level: 'item' } }, 1000).rows;
    for (const loc of both) {
      const site = siteRow(val.j, loc) || {};
      const perItem = {};
      const allIt = pj(sql(`select json_agg(json_build_object('id', id, 'v', coalesce(on_hand, 0) * coalesce(current_cost, 0))) from inventory_items where location_id = '${loc}'`)) || [];
      for (const it of allIt) perItem[it.id] = Number(it.v) - o.mv.filter((m) => m.loc === loc && m.item === it.id && !m.demo && m.day > vd).reduce((s, m) => s + Number(m.v), 0);
      const pos = Object.values(perItem).filter((v) => v > 0).reduce((s, v) => s + v, 0); const negv = Object.values(perItem).filter((v) => v < 0).reduce((s, v) => s + v, 0);
      const rowsHere = vi.filter((r) => r.location_id === loc);
      ok(near(site.stock_value, pos) && near(site.negative_value, negv) && rowsHere.every((r) => near(r.value, perItem[r.inventory_item_id])),
        `${VNAME[loc]}: stock value at the end of ${vd} ${site.stock_value} (negative ${site.negative_value} shown apart, never taken off) = the ledger, item by item (${rowsHere.length} items)`);
    }
    ok((val.j?.totals || []).some((t) => t.location_id === PROVO && Number(t.archived_holding_value) > 0), 'the archived keg still holding stock is on its own line');
    const legal = rep('ownerT', 'value', { sites: both, from: vd, to: vd, opts: { view: 'legal' } });
    ok((legal.j?.rows || []).length === 1 && legal.j.rows[0].legal_company === 'North Ltd' && Number(legal.j.rows[0].sites) === 2, `by legal company: both sites under their Xero company (${short(legal.j?.rows)})`);
    const area = rep('ownerT', 'value', { sites: both, from: vd, to: vd, opts: { view: 'area' } });
    ok(area.message === 'By area is today only.' && rep('ownerT', 'value', { sites: both, from: today, to: today, opts: { view: 'area', at_day: today } }).status === 0,
      `by area: a past day refused 'By area is today only.'; today allowed`);
    ok(rep('ownerT', 'par', { sites: both, from: addDays(ukToday, -94), to: ukToday, opts: { level: 'stockout' } }).message === 'Stock outs cover up to 93 days.',
      `stock outs over 94 days refused 'Stock outs cover up to 93 days.'`);
    // targets: the colours follow the saved lines and the built in defaults, exactly as targetRules.js says
    const g0 = siteRow(rep('ownerT', 'gap', { sites: both, from: F, to: Tt }).j, PROVO) || {};
    const dflt = ragOf('gap_pct', g0.gap_pct == null ? null : Number(g0.gap_pct), TARGET_DEFAULTS.gap_pct);
    ok(g0.rag?.gap_pct === dflt, `with no target saved Provo's gap ${g0.gap_pct}% is ${g0.rag?.gap_pct} by the built in line (targetRules.js says ${dflt})`);
    const gv = g0.gap_pct == null ? null : Number(g0.gap_pct);
    const SITE_LINE = { green_to: 0.1, amber_to: 0.2 }; const CO_LINE = { green_to: 99, amber_to: 100 };
    const st = callJ('ownerT', `select public.stock_save_targets('${ORG_T}', ${jlit([{ location_id: PROVO, metric: 'gap_pct', ...SITE_LINE },
      { location_id: null, metric: 'gap_pct', ...CO_LINE }])}, 'reports')`);
    ok(st.status === 0 && st.j?.ok === true && st.j.rows.length === 2, `the owner saves a company line and a site line for the gap (${outcome(st)})`);
    const g1 = rep('ownerT', 'gap', { sites: both, from: F, to: Tt }).j;
    const pRag = siteRow(g1, PROVO)?.rag?.gap_pct; const lRow = siteRow(g1, LOC2) || {};
    ok(pRag === ragOf('gap_pct', gv, SITE_LINE) && lRow.rag?.gap_pct === ragOf('gap_pct', lRow.gap_pct == null ? null : Number(lRow.gap_pct), CO_LINE),
      `Provo now follows its own line (${pRag}), Location 2 the company line (${lRow.rag?.gap_pct}), word for word with targetRules.js`);
    const stale = callJ('ownerT', `select public.stock_save_targets('${ORG_T}', ${jlit([{ location_id: PROVO, metric: 'gap_pct', green_to: 1, amber_to: 2, row_version: null }])})`);
    const flip = callJ('ownerT', `select public.stock_save_targets('${ORG_T}', ${jlit([{ location_id: null, metric: 'gp_pct', green_to: 60, amber_to: 65 }])})`);
    const conflict = callJ('ownerT', `select public.stock_save_targets('${ORG_T}', ${jlit([{ location_id: PROVO, metric: 'gap_pct', green_to: 1, amber_to: 2, row_version: 7 }])})`);
    ok(stale.message === 'This screen is out of date. Reload it, then save again.' && flip.message === 'Green must be the better side of amber.' && conflict.status === 0 && conflict.j?.ok === false,
      `targets refuse a missing version, green on the wrong side of amber, and answer a stale version with the conflict (${outcome(stale)}; ${outcome(flip)}; ${short(conflict.j, 80)})`);
    const del = callJ('ownerT', `select public.stock_save_targets('${ORG_T}', ${jlit([{ location_id: PROVO, metric: 'gap_pct', delete: true, row_version: 1 }])})`);
    ok(del.status === 0 && num(`select count(*) from stock_targets where location_id = '${PROVO}'`) === 0 && num(`select count(*) from stock_change_log where entity = 'targets'`) >= 3,
      'a site line removed goes back to the company line; every save is in the change log');
    // the 21st key item
    const many = Array.from({ length: 19 }, (_, k) => ({ id: null, name: `Item ${k + 2}`, used_item_id: milkCo, used_unit: 'l', sold_rule: { kind: 'all' } }));
    const r19 = callJ('ownerT', `select public.stock_save_key_ratios('${ORG_T}', ${jlit(many)})`);
    const r21 = callJ('ownerT', `select public.stock_save_key_ratios('${ORG_T}', ${jlit([{ id: null, name: 'One too many', used_item_id: milkCo, sold_rule: { kind: 'all' } }])})`);
    ok(r19.status === 0 && r21.sqlstate === '55000' && r21.message === 'That is 20 key items. Archive one first.', `20 key items at most (${outcome(r21)})`);
    sql(`delete from stock_key_ratios where name <> 'Milk per latte'`);
    // the dashboard: by type, attention, the cards come from the same rows
    const db = rep('ownerT', 'dashboard', { sites: both, from: F, to: Tt }).j || {};
    const types = db.rows?.by_type || [];
    ok(near(types.reduce((s, t) => s + Number(t.sales_net), 0), coRows(db)[0]?.sales_net) && types.every((t) => t.actual_cost === null),
      `GP by type: food, drink and other add up to the company sales (${types.map((t) => `${t.type} ${t.sales_net}`).join(', ')}); actual by type comes with counts by type`);
    const att = db.rows?.attention || [];
    ok(att.some((a) => a.kind === 'negative_stock' && a.location_id === PROVO) && att.some((a) => a.kind === 'demo_history') && att.some((a) => a.kind === 'below_minimum'),
      `needs attention: ${[...new Set(att.map((a) => a.kind))].join(', ')}`);
    ok((db.rows?.league || []).length === 2 && (db.rows.league || []).every((l) => 'last_full_count_words' in l && 'below_par_count' in l), 'the league is in the dashboard answer, one row a site');
  });

  // == 33b. The venue clock around the clock changes, a UK and a US site, two currencies ===================
  if (want(33)) await guarded('d4a clocks', () => {
    c.createFrom('n_w2', D4);
    c.use('n_w2');
    sql(`update locations set currency = 'USD', timezone = 'America/New_York' where id = '${LOC2}'`);
    sql(`insert into venue_clock (location_id, timezone, day_start, synced_at) values ('${PROVO}', 'Europe/London', '06:00', now()), ('${LOC2}', 'America/New_York', '06:00', now())
         on conflict (location_id) do update set timezone = excluded.timezone, day_start = excluded.day_start`);
    dsDrainAll();
    // instants around 06:00 venue time on the night of each clock change and the days either side
    const inst = [];
    const ukDays = ['2026-10-24', '2026-10-25', '2026-10-26'];
    const usDays = ['2026-10-31', '2026-11-01', '2026-11-02'];
    // 04:59, 05:00, 05:59, 06:00, 06:01 UTC and their US equivalents: venue time either side of 06:00, BST or GMT, EDT or EST
    for (const d of [...ukDays, ...usDays]) for (const hm of ['00:30', '04:59', '05:00', '05:30', '05:59', '06:00', '06:01', '09:59', '10:00', '10:30', '10:59', '11:00', '11:01', '23:59']) inst.push(`${d}T${hm}:00Z`);
    const ev = [];
    let n = 0;
    for (const t of inst) {
      for (const loc of [PROVO, LOC2]) {
        n++;
        const item = loc === PROVO ? I.pCups : I.lCups;
        ev.push(`select public._post_stock_movement('${loc}', '${item}', -1, 'WASTE', null, 'waste', 'clk${n}', 'clk:${n}', '${t}', null, null, null)`);
        ev.push(insertRow({ id: `clk-${n}`, location_id: loc, ref: `CLK${n}`, closed_at: t, items: [{ itemId: 'm-clock', qty: 1, price: 1.2 }], subtotal: 1.2, total: 1.2, tax_amount: 0.2,
          source: 'pos', order_type: 'dine-in', status: 'paid', voided: false, tenders: [{ method: 'cash', amount: 1.2 }] }));
      }
    }
    sql(`${ev.join(';\n')};`);
    drainAll();
    sql(`update sales_day_sums_queue set due_at = now() - interval '1 second'`);
    dsDrainAll();
    const o = oracleData();
    const span = { from: '2026-10-23', to: '2026-11-03' };
    let badDays = []; let diffDay = false;
    for (const loc of [PROVO, LOC2]) {
      const cl = o.clocks[loc];
      const days = [...new Set(inst.map((t) => venueDay(Date.parse(t) / 1000, cl.tz, cl.start)))].sort();
      for (const d of days) {
        const one = rep('ownerT', 'dashboard', { sites: [PROVO, LOC2], from: d, to: d }).j;
        const s = siteRow(one, loc) || {};
        const wantN = inst.filter((t) => venueDay(Date.parse(t) / 1000, cl.tz, cl.start) === d).length;
        if (!near(s.waste_value, wantN * Number(sql(`select current_cost from inventory_items where id = '${loc === PROVO ? I.pCups : I.lCups}'`)), 1e-4) || !near(s.sales_net, wantN * 1.0, 0.001)) {
          badDays.push(`${VNAME[loc]} ${d}: waste ${s.waste_value}, sales ${s.sales_net}, want ${wantN} events`);
        }
      }
    }
    for (const t of inst) if (venueDay(Date.parse(t) / 1000, 'Europe/London', '06:00') !== venueDay(Date.parse(t) / 1000, 'America/New_York', '06:00')) diffDay = true;
    ok(badDays.length === 0, `every one day window at both venues holds exactly the instants its own clock puts in it, the UK night of 25 Oct and the US night of 1 Nov included (${badDays.slice(0, 3).join('; ') || `${inst.length} instants a venue`})`);
    ok(diffDay && venueDay(Date.parse('2026-10-25T05:30:00Z') / 1000, 'Europe/London', '06:00') === '2026-10-24' && venueDay(Date.parse('2026-10-25T06:00:00Z') / 1000, 'Europe/London', '06:00') === '2026-10-25'
       && venueDay(Date.parse('2026-10-25T09:59:00Z') / 1000, 'America/New_York', '06:00') === '2026-10-24',
      'a UK and a US site on the same calendar day land on different business days around 06:00 (25 Oct 05:30 UTC is the 24th in the UK; 09:59 UTC is still the 24th in New York)');
    const whole = rep('ownerT', 'dashboard', { sites: [PROVO, LOC2], ...span }).j;
    ok([PROVO, LOC2].every((loc) => near(siteRow(whole, loc)?.sales_net, inst.length * 1.0, 0.001)), `over the whole span every total is whole: ${inst.length} sales a venue, none lost or doubled by a clock change`);
    // two currencies: two company rows, never one
    const co = coRows(whole);
    ok(whole?.meta?.mixed_currency === true && co.length === 2 && co.map((x) => x.currency).sort().join(',') === 'GBP,USD'
       && near(co.find((x) => x.currency === 'GBP').sales_net, siteRow(whole, PROVO).sales_net) && near(co.find((x) => x.currency === 'USD').sales_net, siteRow(whole, LOC2).sales_net),
      `two currencies in one company: two company rows (GBP, USD), each its own sites, never one row adding both (${co.map((x) => `${x.currency} ${x.sales_net}`).join(', ')})`);
    const every = [];
    for (const nm of D4A_REPORTS.filter((x) => x !== 'attention')) {
      const a = rep('ownerT', nm, { sites: [PROVO, LOC2], ...span }).j;
      const cur = coRows(a).map((x) => x.currency);
      if (a && cur.length && !(cur.includes('GBP') && cur.includes('USD') && cur.length === new Set(cur).size)) every.push(`${nm} ${cur.join('/')}`);
    }
    ok(every.length === 0, `every report with company rows keeps one per currency (${every.join('; ') || 'all'})`);
    const tz = (whole?.meta?.sites || []).map((s) => `${s.name} ${s.timezone} ${s.day_start} ${s.currency}`).join('; ');
    ok(/Provo Europe\/London 06:00:00 GBP/.test(tz) && /Location 2 America\/New_York 06:00:00 USD/.test(tz), `meta names each site's clock and currency (${tz})`);
  });

  // ============================================================================================================
  section(34, '34. Demo history left out, counted or estimated, own cost rule, not yet posted, a locked period');
  if (world && want(34)) await guarded('d4a rules', () => {
    c.use('n_w1');
    const both = [PROVO, LOC2];
    const F = dayOf(3); const Tt = dayOf(N - 1);
    const o = oracleData();
    const demoMv = o.mv.filter((m) => m.demo);
    ok(['demo-v1:w:egg', 'seed:w:rcv'].every((k) => demoMv.some((m) => m.key === k)) && num(`select count(*) from stock_day_sums where demo = true`) >= 2,
      `the world has demo history inside the window (demo-v1:w:egg, seed:w:rcv; ${demoMv.length} demo keyed movements in all) and its day totals are flagged demo`);
    const dash = rep('ownerT', 'dashboard', { sites: both, from: F, to: Tt }).j || {};
    ok(dash.meta?.demo_left_out === true, 'meta.demo_left_out true: the web says "Demo history left out"');
    // the same figures with the demo rows removed altogether
    c.createFrom('n_w1_nodemo', 'n_w1');
    c.use('n_w1_nodemo');
    sql(`delete from stock_movements where idempotency_key like 'demo-v1:%' or idempotency_key like 'seed:%'`);
    dsDrainAll();
    const flows = ['sales_net', 'theo_cost', 'actual_cost', 'gap_value', 'waste_value', 'purchases', 'comps_cost', 'unaccounted', 'surplus',
      'gp_pct_theo', 'gp_pct_actual', 'gap_pct', 'waste_pct', 'comps_pct', 'theo_pct', 'actual_pct', 'sales_with_recipe_pct'];
    const d2 = rep('ownerT', 'dashboard', { sites: both, from: F, to: Tt }).j || {};
    const diff = [];
    for (const loc of both) for (const k of flows) if (!near(siteRow(dash, loc)?.[k], siteRow(d2, loc)?.[k], 1e-4)) diff.push(`${VNAME[loc]} ${k} ${siteRow(dash, loc)?.[k]} / ${siteRow(d2, loc)?.[k]}`);
    ok(diff.length === 0 && d2.meta?.demo_left_out === false, `every flow figure is the same as with no demo history at all (${diff.slice(0, 3).join('; ') || flows.join(', ')})`);
    // A check the demo files wrote (id demo-, as the 12,643 live ones at the two demo sites) on a day of
    // the window. sales_day_sums keeps no demo flag, so its takings cannot be told from the real ones:
    // the site's sales and every GP figure come back not known with the words, never a GP over demo
    // takings beside the demo stock left out. Here on the world with no demo stock at all, so the demo
    // check alone sets "Demo history left out".
    const dday = dayOf(5);
    const baseNet = num(`select coalesce(sum(net), 0) from sales_day_sums where location_id = '${PROVO}' and business_day = '${dday}'`);
    c.createFrom('n_w1_democheck', 'n_w1_nodemo');
    c.use('n_w1_democheck');
    const dpr = Number(PRICE[M.pLatte] || 3);
    sql(insertRow({ id: 'demo-sale-w1', location_id: PROVO, ref: 'DEMOW1', closed_at: `${dday}T12:00:00Z`, items: [{ itemId: M.pLatte, qty: 20, price: dpr }],
      subtotal: 20 * dpr, total: 20 * dpr, tax_amount: Math.round((20 * dpr * 0.2 / 1.2) * 100) / 100, service: 0, tip: 0, source: 'pos', order_type: 'dine-in', status: 'paid',
      voided: false, refunds: [], discounts: [], method: 'cash', payment_method: 'cash', tenders: [{ method: 'cash', amount: 20 * dpr, tip: 0 }] }));
    drainAll();
    sql(`update sales_day_sums_queue set due_at = now() - interval '1 second'`);
    dsDrainAll();
    const inSales = num(`select coalesce(sum(net), 0) from sales_day_sums where location_id = '${PROVO}' and business_day = '${dday}'`) - baseNet;
    ok(num(`select count(*) from stock_outbox where check_id = 'demo-sale-w1'`) === 0 && num(`select count(*) from stock_day_sums where demo = true`) === 0 && inSales > 0,
      `a demo check on ${dday} at Provo: never posted to stock, no demo stock anywhere, and its takings (${inSales.toFixed(2)}) are in the stored sales totals (which keep no demo flag)`);
    const dd = rep('ownerT', 'dashboard', { sites: both, from: F, to: Tt }).j || {};
    const dp = siteRow(dd, PROVO) || {}; const dl = siteRow(dd, LOC2) || {}; const dco = coRows(dd)[0] || {};
    const gpKeys = ['sales_net', 'theo_cost', 'comps_cost', 'gp_pct_theo', 'gp_pct_actual', 'gap_pct', 'waste_pct', 'comps_pct', 'theo_pct', 'actual_pct', 'sales_with_recipe_pct'];
    ok(dd.meta?.demo_left_out === true && gpKeys.every((k) => dp[k] === null) && dp.demo_sales === true
       && (dd.meta?.windows || []).find((w) => w.location_id === PROVO)?.demo_sales === true
       && (dd.meta?.notes || []).includes('Demo sales on these days at Provo: its sales and GP are not shown'),
      `Provo with a demo check in the window: "Demo history left out", its sales and every GP figure not known (${gpKeys.filter((k) => dp[k] !== null).join(', ') || 'all null'}), "Demo sales on these days at Provo: its sales and GP are not shown"`);
    ok(['waste_value', 'actual_cost', 'gap_value', 'purchases', 'stock_value_now'].every((k) => near(dp[k], siteRow(d2, PROVO)?.[k], 1e-4)),
      `its stock figures still stand (waste ${dp.waste_value}, actual cost ${dp.actual_cost}, gap ${dp.gap_value}, purchases ${dp.purchases})`);
    ok(flows.every((k) => (dl[k] == null && siteRow(d2, LOC2)?.[k] == null) || near(dl[k], siteRow(d2, LOC2)?.[k], 1e-4)) && dl.demo_sales === false,
      'Location 2 (no demo check) has every figure as before');
    ok(['sales_net', 'theo_cost', 'gp_pct_theo', 'gp_pct_actual', 'gap_pct', 'comps_cost'].every((k) => dco[k] === null) && dco.demo_sales === true,
      `the company row is not known either (never Location 2's sales beside Provo's costs): ${short(['sales_net', 'gp_pct_theo'].map((k) => `${k} ${dco[k]}`))}`);
    const dpg = rep('ownerT', 'product_gp', { sites: both, from: F, to: Tt }).j || {};
    const dpr2 = allPages('ownerT', 'product_gp', { sites: both, from: F, to: Tt, opts: { level: 'site_product' } }, 1000).rows;
    ok(!dpr2.some((r) => r.location_id === PROVO) && dpr2.some((r) => r.location_id === LOC2) && siteRow(dpg, PROVO)?.gp === null && siteRow(dpg, PROVO)?.demo_sales === true
       && (coRows(dpg)[0] || {}).gp === null,
      `product GP: no Provo products, its site row and the company row not known; Location 2 as before (${short({ provoRows: dpr2.filter((r) => r.location_id === PROVO).length, site: siteRow(dpg, PROVO), co: coRows(dpg)[0] }, 400)})`);
    const dtype = (dd.rows?.by_type || []);
    const dwk = allPages('ownerT', 'cogs', { sites: both, from: F, to: Tt, opts: { level: 'week' } }, 1000).rows.filter((r) => r.location_id === PROVO);
    const dty = allPages('ownerT', 'cogs', { sites: both, from: F, to: Tt, opts: { level: 'type' } }, 1000).rows;
    const dkr = rep('ownerT', 'key_ratios', { sites: both, from: F, to: Tt }).j || {};
    const dsh = siteRow(rep('ownerT', 'setup_health', { sites: both, from: F, to: Tt }).j, PROVO) || {};
    ok(dtype.every((t) => t.sales_net === null && t.gp_pct_theo === null) && dwk.length > 0 && dwk.every((r) => r.sales_net === null && r.gp_pct_theo === null)
       && !dty.some((r) => r.location_id === PROVO) && (dkr.totals || []).filter((t) => t.location_id === PROVO).every((t) => t.sold_qty === null && t.per_sold === null)
       && dsh.sales_net === null && dsh.no_recipe_pct === null,
      'GP by type, the weeks, the types, the key items sold and the sales with no recipe at Provo: not known, never counted');
    const att2 = rep('ownerT', 'attention', { sites: both, from: F, to: Tt }).j?.rows || [];
    ok(att2.some((a) => a.kind === 'demo_history' && a.location_id === PROVO), 'needs attention: Demo history at Provo (from the demo check)');
    // a window without the demo check day: every figure as with no demo at all
    const after5 = rep('ownerT', 'dashboard', { sites: both, from: addDays(dday, 1), to: Tt }).j || {};
    c.use('n_w1_nodemo');
    const clean5 = rep('ownerT', 'dashboard', { sites: both, from: addDays(dday, 1), to: Tt }).j || {};
    const diff5 = [];
    for (const loc of both) for (const k of flows) if (!((siteRow(after5, loc)?.[k] == null && siteRow(clean5, loc)?.[k] == null) || near(siteRow(after5, loc)?.[k], siteRow(clean5, loc)?.[k], 1e-4))) diff5.push(`${VNAME[loc]} ${k}`);
    ok(diff5.length === 0 && siteRow(after5, PROVO)?.demo_sales === false && after5.meta?.demo_left_out === true,
      `from ${addDays(dday, 1)} (no demo check in the days): every figure, sales and GP included, the same as with no demo at all (${diff5.slice(0, 4).join('; ') || flows.length + ' figures a site'})`);
    const mvDemo = (db) => { c.use(db); const it = sql(`select company_ref from inventory_items where id = '${I.pEggs}'`);
      return allPages('ownerT', 'movement', { sites: both, from: dayOf(1), to: dayOf(N), opts: { level: 'movement', site: PROVO, item_id: it } }, 1000).rows; };
    const deep = mvDemo('n_w1');
    const wantIds = o.mv.filter((m) => m.loc === PROVO && m.item === I.pEggs && !m.demo && m.day >= dayOf(1) && m.day <= dayOf(N)).length;
    const keys = deep.map((r) => sql(`select idempotency_key from stock_movements where id = '${r.id}'`));
    ok(deep.length > 0 && deep.length === wantIds && !keys.some(isDemo) && keys.includes('w:3:egg'),
      `the deep dive of the item with a demo movement lists every real movement of it (${deep.length} of ${wantIds}) and never the demo one`);
    c.use('n_w1');
    // counted or estimated on every opening and closing figure
    const mv1 = rep('ownerT', 'movement', { sites: both, from: F, to: Tt }).j || {};
    const mv2 = rep('ownerT', 'movement', { sites: both, from: dayOf(1), to: dayOf(N) }).j || {};
    ok(both.every((l) => siteRow(mv1, l)?.opening_counted === true && siteRow(mv1, l)?.closing_counted === true)
       && both.every((l) => siteRow(mv2, l)?.opening_counted === false && siteRow(mv2, l)?.closing_counted === false),
      'opening and closing say Counted on the count days and Estimated (ledger) on any other day, on every site row');
    ok((mv1.meta?.windows || []).every((w) => 'opening_counted' in w && 'closing_counted' in w && 'takes_from' in w && 'snapshot' in w), 'meta.windows carries the flags per site');
    const lone = rep('ownerT', 'movement', { sites: both, from: dayOf(1), to: dayOf(3), opts: { between_counts: true } }).j || {};
    ok((lone.meta?.windows || []).every((w) => w.window_missing === true && w.from_day == null), 'between counts with fewer than two full counts by the end: window_missing ("Needs two full counts"), no guess');
    // own cost rule
    const sitesMeta = dash.meta?.sites || [];
    ok(sitesMeta.find((s) => s.id === LOC2)?.cost_rule_own === true && sitesMeta.find((s) => s.id === PROVO)?.cost_rule_own === false, 'Location 2 with its own cost rule is marked "Own cost rule"; Provo is not');
    // sales not yet posted: a held event shows in the count and value and moves no GP figure
    const chk = sql(`select id from closed_checks where location_id = '${PROVO}' and left(id, 1) = 'w' and closed_at::date = '${dayOf(5)}' order by id limit 1`);
    const subtotal = Number(sql(`select subtotal from closed_checks where id = '${chk}'`));
    sql(`insert into stock_outbox (location_id, check_id, kind, event_ref, writer, status, due_at, occurred_at, flags) values ('${PROVO}', '${chk}', 'sale', 'held-test', 'pos', 'held', now(), '${dayOf(5)}T12:00:00Z', array['needs_a_person'])`);
    const dh = rep('ownerT', 'dashboard', { sites: both, from: F, to: Tt }).j || {};
    const p0 = siteRow(dash, PROVO) || {}; const p1 = siteRow(dh, PROVO) || {};
    ok(Number(p1.not_posted_count) === Number(p0.not_posted_count) + 1 && near(p1.not_posted_value, Number(p0.not_posted_value) + subtotal) && dh.meta?.not_posted?.count >= 1
       && ['sales_net', 'theo_cost', 'actual_cost', 'gp_pct_theo', 'gp_pct_actual', 'comps_cost'].every((k) => near(p0[k], p1[k], 1e-6)),
      `a held sale: "${p1.not_posted_count} sales not yet posted to stock (${p1.not_posted_value})"; every GP figure unchanged`);
    sql(`delete from stock_outbox where event_ref = 'held-test'`);
    // a locked period: its snapshot is read instead of the day totals; a price edit after it changes nothing
    const pid = id('ab000000', 1);
    const snap = { opening_value: 1000.11, closing_value: 2000.22, purchases: 300.33, transfers_in: 0, transfers_out: 0, made: 0, used_in_batches: 0, sold_cost: 400.44, waste: 50.55,
      revalue: 0, count_adj: -12.34, sales_net: 1234.56, theo_cost: 400.44, actual_cost: 410.1, comps_cost: 9.99, comps_qty: 3, by_category: [{ category_id: null, name: 'Dairy', closing_value: 2000.22 }], locked_at: '2026-10-01T00:00:00Z' };
    sql(`insert into stock_periods (id, org_id, location_id, from_day, to_day, locked_at, locked_by) values ('${pid}', '${ORG_T}', '${PROVO}', '${F}', '${Tt}', now(), '${U.ownerT}');
         insert into stock_period_snapshots (period_id, location_id, metrics) values ('${pid}', '${PROVO}', ${jlit(snap)})`);
    const lk = rep('ownerT', 'cogs', { sites: both, from: F, to: Tt }).j || {};
    const lp = siteRow(lk, PROVO) || {};
    const lw = (lk.meta?.windows || []).find((w) => w.location_id === PROVO) || {};
    ok(lw.snapshot === true && near(lp.sales_net, 1234.56) && near(lp.theo_cost, 400.44) && near(lp.actual_cost, 410.1) && near(lp.comps_cost, 9.99) && !('snap' in lw),
      `a locked period: Provo's figures are the snapshot's (sales ${lp.sales_net}, theo ${lp.theo_cost}, actual ${lp.actual_cost}, comps ${lp.comps_cost}): "Locked period: from the snapshot"`);
    const lmv = siteRow(rep('ownerT', 'movement', { sites: both, from: F, to: Tt }).j, PROVO) || {};
    const lval = siteRow(rep('ownerT', 'value', { sites: both, from: Tt, to: Tt }).j, PROVO) || {};
    ok(near(lmv.opening_value, 1000.11) && near(lmv.closing_value, 2000.22) && near(lmv.received, 300.33) && near(lval.stock_value, 2000.22),
      `the movement and value reports read the same snapshot (opening ${lmv.opening_value}, closing ${lmv.closing_value}, value on the last day ${lval.stock_value})`);
    sql(`insert into stock_movements (location_id, inventory_item_id, qty_base, unit_cost, value_delta, movement_type, source_type, occurred_at, posted_at, idempotency_key)
         select '${PROVO}', id, 0, current_cost * 2, on_hand * current_cost, 'REVALUE', 'harness', '${dayOf(4)}T12:00:00Z', now(), 'lock:reval' from inventory_items where id = '${I.pMilk}';
         update inventory_items set current_cost = current_cost * 2 where id = '${I.pMilk}'`);
    dsDrainAll();
    const lk2 = siteRow(rep('ownerT', 'cogs', { sites: both, from: F, to: Tt }).j, PROVO) || {};
    ok(near(lk2.sales_net, lp.sales_net) && near(lk2.actual_cost, lp.actual_cost) && near(lk2.theo_cost, lp.theo_cost), 'a price edit dated inside the locked month changes none of its figures (a locked month never changes)');
    const part = rep('ownerT', 'cogs', { sites: both, from: F, to: addDays(Tt, 1) }).j || {};
    const pw = (part.meta?.windows || []).find((w) => w.location_id === PROVO) || {};
    ok(pw.snapshot === false && pw.part_locked === true && !near(siteRow(part, PROVO)?.sales_net, 1234.56), 'a range that only overlaps the locked period is read live and marked part_locked ("Part of a locked period: read live")');
    sql(`update stock_periods set unlocked_at = now() where id = '${pid}'`);
    ok(rep('ownerT', 'cogs', { sites: both, from: F, to: Tt }).j?.meta?.windows?.find((w) => w.location_id === PROVO)?.snapshot === false, 'unlocked: read live again');
  });

  // ============================================================================================================
  section(35, '35. Paging: every drill level at a page of 3, ties included; totals on every page; the 1,000 cap; columns');
  if (world && want(35)) await guarded('d4a paging', () => {
    c.use('n_w1');
    const both = [PROVO, LOC2];
    const F = dayOf(1); const Tt = dayOf(N);
    const pitem = sql(`select company_ref from inventory_items where id = '${I.pMilk}'`);
    const LEVELS = [
      ['value', { level: 'item' }], ['value', { level: 'category' }], ['value', { level: 'site' }], ['value', { view: 'legal' }],
      ['movement', { level: 'item', site: PROVO }], ['movement', { level: 'movement', site: PROVO, item_id: pitem }], ['movement', { level: 'site' }],
      ['gap', { level: 'item' }], ['gap', { level: 'site' }], ['cogs', { level: 'week' }], ['cogs', { level: 'type' }], ['cogs', { level: 'site' }],
      ['product_gp', { level: 'product' }], ['product_gp', { level: 'site_product' }],
      ['waste', { level: 'reason' }], ['waste', { level: 'category' }], ['waste', { level: 'item' }], ['waste', { level: 'person' }], ['waste', { level: 'day' }], ['waste', { level: 'site' }],
      ['purchases', { level: 'supplier' }], ['purchases', { level: 'category' }], ['purchases', { level: 'week' }], ['purchases', { level: 'order' }], ['purchases', { level: 'site' }],
      ['prices', { level: 'item' }], ['prices', { level: 'change' }], ['prices', { level: 'coming' }],
      ['days_on_hand', { level: 'category' }], ['days_on_hand', { level: 'slow', idle_days: 14 }], ['days_on_hand', { level: 'site' }],
      ['par', { level: 'below' }], ['par', { level: 'stockout' }], ['par', { level: 'over' }], ['par', { level: 'negative' }], ['par', { level: 'site' }],
      ['key_ratios', { level: 'site' }], ['key_ratios', { level: 'week' }], ['setup_health', { level: 'detail' }], ['setup_health', { level: 'site' }],
      ['batches', { level: 'recipe' }], ['batches', { level: 'batch' }], ['batches', { level: 'site' }], ['league', {}], ['attention', {}],
    ];
    const bad = []; const colBad = []; let paged = 0;
    for (const [name, opts] of LEVELS) {
      const full = rep('ownerT', name, { sites: both, from: F, to: Tt, opts });
      if (full.status !== 0 || !full.j) { bad.push(`${name} ${JSON.stringify(opts)}: ${outcome(full)}`); continue; }
      const p3 = allPages('ownerT', name, { sites: both, from: F, to: Tt, opts }, 3);
      const a = (full.j.rows || []).map((r) => JSON.stringify(r)); const b = p3.rows.map((r) => JSON.stringify(r));
      const tot = new Set(p3.totals);
      if (p3.error || a.join('\n') !== b.join('\n') || new Set(b).size !== b.length || tot.size !== 1 || [...tot][0] !== JSON.stringify(full.j.totals)) {
        bad.push(`${name} ${JSON.stringify(opts)}: ${a.length} rows in one page, ${b.length} over ${p3.pages} pages${p3.error ? ` ${p3.error}` : ''}${tot.size !== 1 ? ', totals differ' : ''}`);
      }
      if (p3.pages > 1) paged++;
      const cols = (full.j.meta?.columns || []).map((x) => x.key);
      if (!cols.length || !(full.j.meta.columns || []).every((x) => x.label && ['money', 'pct', 'qty', 'text', 'day', 'rag'].includes(x.kind))) colBad.push(`${name} ${JSON.stringify(opts)}: columns ${short(full.j.meta?.columns, 80)}`);
      const rowsToCheck = (full.j.rows || []).slice(0, 50);
      for (const r of rowsToCheck) { const miss = cols.filter((k) => !(k in r)); if (miss.length) { colBad.push(`${name} ${JSON.stringify(opts)} row lacks ${miss.join(',')}`); break; } }
    }
    ok(bad.length === 0 && paged >= 15, `every one of ${LEVELS.length} levels pages at 3 a page with ties to exactly the rows of one page, in order, none twice, the totals on every page (${paged} levels took more than one page; ${bad.slice(0, 4).join('; ') || 'all equal'})`);
    ok(colBad.length === 0, `meta.columns names a key, a label and a kind, and every row carries every column key the screen and the export read (${colBad.slice(0, 4).join('; ') || 'all'})`);
    const tie = allPages('ownerT', 'value', { sites: both, from: Tt, to: Tt, opts: { level: 'item' } }, 1);
    const vals = tie.rows.map((r) => Number(r.value));
    ok(vals.length > 5 && vals.some((v, k) => k > 0 && v === vals[k - 1]) && new Set(tie.rows.map((r) => r.inventory_item_id)).size === tie.rows.length,
      `a page of 1 through ${tie.rows.length} value rows with equal values: every item once (the key ends with a unique id)`);
    const big = rep('ownerT', 'value', { sites: both, from: Tt, to: Tt, opts: { level: 'item' }, limit: 100000 });
    const small = rep('ownerT', 'value', { sites: both, from: Tt, to: Tt, opts: { level: 'item' }, limit: 0 });
    ok(big.status === 0 && big.j.rows.length <= 1000 && small.status === 0 && small.j.rows.length === 1, `p_limit is held to 1 to 1,000 (${big.j?.rows?.length}, ${small.j?.rows?.length})`);
  });

  // ============================================================================================================
  section(36, `36. Speed: ${QUICK ? 10 : 50} sites by 500 items by 31 days of day totals, every report under 5 s as the owner under the 8 s limit`);
  const SITES = QUICK ? 10 : 50;
  const scaleLoc = (n) => `e6000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const scaleSites = Array.from({ length: SITES }, (_, k) => scaleLoc(k + 1));
  let scaleReady = false;
  if (want(36) || want(37)) await guarded('d4a scale', () => {
    c.createFrom('n_scale', D4);
    c.use('n_scale');
    const t0 = Date.now();
    sql(`insert into organisations (id, name) values ('${SCALE_ORG}', 'Scale test company');
      insert into locations (id, org_id, name, currency, timezone, status)
        select ('e6000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${SCALE_ORG}', 'Scale site ' || lpad(n::text, 2, '0'), 'GBP', 'Europe/London', 'active' from generate_series(1, ${SITES}) n;
      insert into venue_clock (location_id, timezone, day_start, synced_at) select id, 'Europe/London', '06:00', now() from locations where org_id = '${SCALE_ORG}';
      insert into stock_co_categories (id, org_id, name) select ('e8000000-0000-4000-8000-' || lpad(to_hex(k), 12, '0'))::uuid, '${SCALE_ORG}', 'Category ' || k from generate_series(1, 10) k;
      insert into stock_co_items (id, org_id, name, base_unit, category_id)
        select ('e7000000-0000-4000-8000-' || lpad(to_hex(k), 12, '0'))::uuid, '${SCALE_ORG}', 'Scale item ' || lpad(k::text, 3, '0'), 'each',
               ('e8000000-0000-4000-8000-' || lpad(to_hex(1 + k % 10), 12, '0'))::uuid from generate_series(1, 500) k;
      insert into inventory_items (id, location_id, org_id, name, kind, base_unit, company_ref, on_hand, current_cost)
        select gen_random_uuid(), l.id, l.org_id, 'Scale item ' || lpad(k::text, 3, '0'), 'PURCHASED', 'each', ('e7000000-0000-4000-8000-' || lpad(to_hex(k), 12, '0'))::uuid,
               20 + (k % 7), round(0.5 + (k % 13) * 0.25, 2)
          from locations l cross join generate_series(1, 500) k where l.org_id = '${SCALE_ORG}';
      delete from stock_day_sums_repair where location_id in (select id from locations where org_id = '${SCALE_ORG}');
      delete from sales_day_sums_queue where location_id in (select id from locations where org_id = '${SCALE_ORG}');
      insert into stock_day_sums (location_id, business_day, inventory_item_id, company_item_id, movement_type, source_type, qty_base, value, clock_known, demo)
        select i.location_id, d::date, i.id, i.company_ref, t.mt, t.st, t.q, t.q * i.current_cost, true, false
          from inventory_items i
         cross join generate_series(current_date - 30, current_date, interval '1 day') d
         cross join lateral (values ('SALE_DEPLETION', 'closed_check', -1.0), ('PURCHASE_RECEIPT', 'purchase_order', 1.0), ('WASTE', 'waste', -0.1)) t(mt, st, q)
         where i.location_id in (select id from locations where org_id = '${SCALE_ORG}')
           and (t.mt = 'SALE_DEPLETION' and (hashtext(i.id::text || d::text) % 10) < 3 or t.mt = 'PURCHASE_RECEIPT' and (hashtext(i.id::text || d::text) % 50) = 0
                or t.mt = 'WASTE' and (hashtext(i.id::text || d::text) % 97) = 0);
      insert into sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net, discount_spread, reward_spread, tax, loyalty_qty, staff_qty, comp_qty,
                                  loyalty_cost, staff_cost, comp_cost, theo_cost, clock_known)
        select l.id, d::date, 'm-scale-' || p, ot, 5, 20, 16.67, 0, 0, 3.33, case when p % 9 = 0 then 1 else 0 end, case when p % 11 = 0 then 1 else 0 end, 0,
               case when p % 9 = 0 then 0.8 else 0 end, case when p % 11 = 0 then 0.8 else 0 end, 0, 4.1, true
          from locations l cross join generate_series(current_date - 30, current_date, interval '1 day') d cross join generate_series(1, 60) p cross join (values ('dine-in'), ('takeaway')) o(ot)
         where l.org_id = '${SCALE_ORG}';
      insert into stock_counts (id, location_id, name, count_type, status, approved_at)
        select gen_random_uuid(), l.id, 'Full count ' || k, 'FULL', 'APPROVED', (current_date - (k * 14))::timestamp + interval '21 hours'
          from locations l cross join (values (1), (2)) z(k) where l.org_id = '${SCALE_ORG}';
      insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, expected_qty, variance_qty, unit_cost)
        select c.location_id, c.id, i.id, i.on_hand, i.on_hand, 0, i.current_cost from stock_counts c join inventory_items i on i.location_id = c.location_id
         where c.location_id in (select id from locations where org_id = '${SCALE_ORG}');
      insert into user_profiles (id, org_id, location_id, role, email, full_name) values ('${SCALE_OWNER}', '${SCALE_ORG}', '${scaleLoc(1)}', 'owner', 'scale@example.test', 'Scale Owner');
      analyze;`);
    const counts = pj(sql(`select json_build_object('sites', (select count(*) from locations where org_id = '${SCALE_ORG}'),
        'items', (select count(*) from inventory_items i join locations l on l.id = i.location_id where l.org_id = '${SCALE_ORG}'),
        'stock_days', (select count(*) from stock_day_sums s join locations l on l.id = s.location_id where l.org_id = '${SCALE_ORG}'),
        'sales_days', (select count(*) from sales_day_sums s join locations l on l.id = s.location_id where l.org_id = '${SCALE_ORG}'))`)) || {};
    ok(counts.sites === SITES && counts.items === SITES * 500 && counts.stock_days > SITES * 31 * 100, `the synthetic company: ${short(counts)} (built in ${Date.now() - t0} ms)`);
    scaleReady = true;
    if (!want(36)) return;
    const range = { from: addDays(today, -30), to: today };
    const slow = []; const times = [];
    const someItem = sql(`select company_ref from inventory_items where location_id = '${scaleLoc(1)}' order by name limit 1`);
    const RUNS = [...D4A_REPORTS.map((n) => [n, null]), ['value', { level: 'item' }], ['movement', { level: 'item', site: scaleLoc(1) }], ['movement', { level: 'movement', site: scaleLoc(1), item_id: someItem }],
      ['gap', { level: 'item' }], ['cogs', { level: 'week' }], ['product_gp', { level: 'site_product' }], ['days_on_hand', { level: 'slow' }], ['par', { level: 'stockout' }],
      ['movement', { between_counts: true }], ['dashboard', { between_counts: true }]];
    for (const [n, opts] of RUNS) {
      const r = rep('scaleOwner', n, { org: SCALE_ORG, sites: scaleSites, ...range, opts });
      times.push(`${n}${opts ? `:${opts.level || 'between'}` : ''} ${r.ms}`);
      if (r.status !== 0 || r.ms >= 5000) slow.push(`${n} ${JSON.stringify(opts)}: ${outcome(r)} ${r.ms} ms`);
    }
    console.log(`     ms: ${times.join(', ')}`);
    ok(slow.length === 0, `${RUNS.length} calls over ${SITES} sites by 31 days, each under 5 s as the owner under the 8 s limit (${slow.join('; ') || 'all'})`);
    const long = rep('scaleOwner', 'dashboard', { org: SCALE_ORG, sites: scaleSites, from: addDays(today, -400), to: today });
    ok(long.status === 0 && long.ms < 8000, `a 400 day range: answered in ${long.ms} ms, under the 8 s limit (${outcome(long)})`);
    const lg = rep('scaleOwner', 'league', { org: SCALE_ORG, sites: scaleSites, ...range });
    ok(lg.status === 0 && lg.j.rows.length === SITES && lg.j.totals.length === SITES + 1, `the league: ${lg.j?.rows?.length} site rows and one company row`);
  });

  // ============================================================================================================
  section(37, '37. Exports through the queue to a file; then the rollback and 4a again');
  if (want(37)) await guarded('d4a exports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd4aexp.'));
    try {
      // the edge function's run, here: claim, pages as the job's login, a part file a page, finish
      const runner = () => {
        const claim = callJ('service', 'select public.report_export_claim(3)').j || { jobs: [], expired: [] };
        for (const job of claim.jobs || []) {
          let pages = 0;
          for (;;) {
            const pg = callJ('service', `select public.report_export_page('${job.id}')`).j || {};
            if (pg.status !== 'running') break;
            pages++;
            const n = Number(sql(`select pages from report_export_jobs where id = '${job.id}'`));
            writeFileSync(join(dir, partName(job.file_prefix, n).replace(/\//g, '_')), csvPart(pg.columns || [], pg.rows || [], { header: n === 1 }));
            if (!pg.next) { callJ('service', `select public.report_export_finish('${job.id}', ${jlit({ status: 'done', parts: n })})`); break; }
            if (pages >= 25) { callJ('service', `select public.report_export_finish('${job.id}', ${jlit({ status: 'running', parts: n })})`); break; }
          }
        }
        return claim;
      };
      const fileOf = (job) => { const prefix = sql(`select file_prefix from report_export_jobs where id = '${job}'`);
        const parts = Number(sql(`select parts from report_export_jobs where id = '${job}'`));
        return Array.from({ length: parts }, (_, k) => readFileSync(join(dir, partName(prefix, k + 1).replace(/\//g, '_')), 'utf8')).join(''); };
      if (scaleReady) {
        c.use('n_scale');
        const args = { org: SCALE_ORG, sites: scaleSites, from: addDays(today, -30), to: today, opts: { level: 'item' } };
        const st = callJ('scaleOwner', `select public.stock_report_export_start('value', ${jlit(args)})`);
        ok(st.status === 0 && st.j?.ok === true && st.j.job_id, `the owner starts an export of every item value at ${SITES} sites (${outcome(st)})`);
        const job = st.j?.job_id;
        const dup = callJ('scaleOwner', `select public.stock_report_export_start('value', ${jlit(args)})`);
        ok(dup.sqlstate === '55000' && dup.message === 'An export is already running. Wait for it to finish.', `a second one while it waits: refused (${outcome(dup)})`);
        const jr = pj(callJ('scaleOwner', `select row_to_json(j) from report_export_jobs j where id = '${job}'`).out) || {};
        ok(jr.status === 'waiting' && jr.file_prefix === `${SCALE_ORG}/${SCALE_OWNER}/${job}/` && JSON.stringify(jr.args.sites) === JSON.stringify(scaleSites) && jr.args.opts.level === 'item',
          `the job waits with the exact call and its folder ${short(jr.file_prefix, 120)}; the owner reads it`);
        let runs = 0;
        while (runs < 20 && sql(`select status from report_export_jobs where id = '${job}'`) !== 'done') { runs++; runner(); }
        const dj = pj(sql(`select row_to_json(j) from report_export_jobs j where id = '${job}'`)) || {};
        const direct = allPages('scaleOwner', 'value', { org: SCALE_ORG, sites: scaleSites, from: args.from, to: args.to, opts: args.opts }, 1000, 1000);
        const csv = fileOf(job);
        const lines = csv.split('\r\n').filter((l) => l.length);
        const header = lines[0].replace(/^﻿/, '');
        ok(dj.status === 'done' && dj.rows === direct.rows.length && dj.pages === direct.pages && lines.length === direct.rows.length + 1 && dj.expires_at && runs >= Math.ceil(direct.pages / 25),
          `the queue builds it in ${runs} runs of up to 25 pages: ${dj.pages} pages, ${dj.parts} part files, ${lines.length - 1} rows = every row of the report (${direct.rows.length}); kept 7 days`);
        ok(header.split(',').length === (dj.columns || []).length && (dj.columns || []).every((col) => header.includes(col.label)), `the file's header is the report's columns (${short(header, 120)})`);
        const reach = callJ('service', `select public.report_export_reach_ok('${job}', '${SCALE_OWNER}')`);
        const other = callJ('service', `select public.report_export_reach_ok('${job}', '${U.ownerT}')`);
        ok(reach.out === 't' && other.out === 'f', 'the download check: the job\'s own login yes, another login no');
        sql(`update report_export_jobs set expires_at = now() - interval '1 minute' where id = '${job}'`);
        const cl = runner();
        ok((cl.expired || []).some((e) => e.id === job && e.file_prefix === dj.file_prefix) && sql(`select status from report_export_jobs where id = '${job}'`) === 'expired'
           && callJ('service', `select public.report_export_reach_ok('${job}', '${SCALE_OWNER}')`).out === 'f',
          'past 7 days the runner is handed the folder to remove and the job is expired; the download check then says no');
        // 20 a day
        sql(`insert into report_export_jobs (org_id, user_id, report, args, status, created_at) select '${SCALE_ORG}', '${SCALE_OWNER}', 'value', '{}', 'done', now() - interval '1 hour' from generate_series(1, 19)`);
        const t21 = callJ('scaleOwner', `select public.stock_report_export_start('value', ${jlit(args)})`);
        ok(t21.sqlstate === '55000' && t21.message === 'That is 20 exports today. Try again tomorrow.', `the 21st export in a day: refused (${outcome(t21)})`);
        const bad = callJ('scaleOwner', `select public.stock_report_export_start('stock_take', ${jlit(args)})`);
        ok(bad.message === 'That report cannot be exported.', `an unknown report: refused (${outcome(bad)})`);
      } else ok(false, 'the scale company is there for the export proof');
      // reach lost between start and run; cancel; five tries
      if (world) {
        c.use('n_w1');
        const both = [PROVO, LOC2];
        const args = { org: ORG_T, sites: both, from: dayOf(1), to: dayOf(N), opts: { level: 'item' } };
        const st = callJ('mgrAll', `select public.stock_report_export_start('gap', ${jlit(args)})`);
        ok(st.status === 0 && st.j?.job_id, `a Stock control all manager starts an export over both sites (${outcome(st)})`);
        sql(`update user_profiles set stock_control = null where id = '${U.mgrAll}'`);
        runner();
        const jf = pj(sql(`select row_to_json(j) from report_export_jobs j where id = '${st.j?.job_id}'`)) || {};
        ok(jf.status === 'failed' && jf.error === 'This login no longer reaches Provo.', `the level taken away before the run: the job fails in words at run time (${jf.status}: ${jf.error})`);
        sql(`update user_profiles set stock_control = 'all' where id = '${U.mgrAll}'`);
        const c1 = callJ('ownerT', `select public.stock_report_export_start('gap', ${jlit(args)})`);
        const cx = callJ('mgrProvo', `select public.stock_report_export_cancel('${c1.j?.job_id}')`);
        ok(sql(`select status from report_export_jobs where id = '${c1.j?.job_id}'`) === 'waiting' && cx.status === 0, 'another login cannot cancel it');
        const cc = callJ('ownerT', `select public.stock_report_export_cancel('${c1.j?.job_id}')`);
        ok(cc.status === 0 && sql(`select status from report_export_jobs where id = '${c1.j?.job_id}'`) === 'cancelled' && !(runner().jobs || []).some((j) => j.id === c1.j?.job_id),
          'its own login cancels it; the runner never claims a cancelled job');
        const c2 = callJ('ownerT', `select public.stock_report_export_start('gap', ${jlit(args)})`);
        sql(`update report_export_jobs set attempts = 5, status = 'running', claimed_at = now() - interval '5 minutes' where id = '${c2.j?.job_id}'`);
        runner();
        ok(sql(`select status || ':' || error from report_export_jobs where id = '${c2.j?.job_id}'`) === 'failed:Stopped after 5 tries.', 'a job that died five times stops: \'Stopped after 5 tries.\'');
        const fin = callJ('ownerT', `select public.report_export_finish('${c2.j?.job_id}', '{"status":"done"}'::jsonb)`);
        ok(fin.sqlstate === '42501', 'the runner functions are the service role\'s only');
        // the rollback, then 4a again: every number the same
        const strip = (a) => JSON.stringify(a, (k, v) => (k === 'generated_at' || k === 'rag' ? undefined : v));
        const snapAns = () => ['dashboard', 'movement', 'gap', 'cogs', 'product_gp', 'waste', 'value'].map((n) => strip(rep('ownerT', n, { sites: both, from: dayOf(3), to: dayOf(N - 1) }).j?.totals));
        const before = snapAns();
        const keep = sql(`select count(*) || ':' || coalesce(sum(value), 0) from stock_day_sums`) + '|' + sql(`select count(*) || ':' || coalesce(sum(net), 0) from sales_day_sums`);
        sql(`insert into storage.objects (bucket_id, name) values ('report-exports', '${ORG_T}/${U.ownerT}/x/part-0001.csv');
             insert into sales_day_sums_queue (location_id, business_day, reason, queued_at, attempts, due_at) values ('${PROVO}', '2025-12-01', 'drop4a_backfill', now(), 0, now() + interval '1 hour')`);
        const waiting = num(`select count(*) from report_export_jobs where status in ('waiting', 'running')`);
        const rb = c.paste(FILES.d4Rb);
        const rr = lastRows(rb)[0] || {};
        console.log(`     rollback: ${short(rr, 400)}`);
        ok(rb.status === 0 && rr.functions_left === '0' && rr.tables_left === '0' && rr.bucket_left === 'f' && rr.cron_left === 'f' && rr.vault_key_left === 'f' && rr.indexes_left === '0'
           && Number(rr.jobs_failed) === waiting && Number(rr.backfill_rows_dropped) === 1,
          `the rollback: no function, table, bucket, cron job, vault key or index of 4a left; ${rr.jobs_failed} waiting export failed in words; ${rr.backfill_rows_dropped} queued backfill day taken out`);
        ok(num(`select count(*) from storage.objects where bucket_id = 'report-exports'`) === 0 && num(`select count(*) from pg_policies where policyname = 'report_exports_owner_read'`) === 0,
          'its files and its read policy are gone');
        ok(keep === sql(`select count(*) || ':' || coalesce(sum(value), 0) from stock_day_sums`) + '|' + sql(`select count(*) || ':' || coalesce(sum(net), 0) from sales_day_sums`)
           && tableExists('stock_sale_takes') && fnExists('public.sales_day_sums_rebuild(uuid,date,date)') && D4A_CHECKED.every(([s, m5]) => md5Of(s) === m5),
          'the day totals, the drainer and every body 4a read are as they were (4a replaced nothing)');
        const again = c.paste(FILES.d4);
        ok(again.status === 0, `4a applies again after its rollback (${again.status ? short(again.stderr, 300) : 'ok'})`);
        sql(`update user_profiles set stock_control = 'all' where id = '${U.mgrAll}'`);
        const after = snapAns();
        const off = before.map((b, k) => (b === after[k] ? null : k)).filter((k) => k !== null);
        ok(off.length === 0, `and every report answers exactly the same numbers as before the rollback (${off.length ? `differ: ${off.join(',')}` : 'dashboard, movement, gap, cost of sales, product GP, waste, value'})`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
