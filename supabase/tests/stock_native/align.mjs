// align.mjs: proves release 5.11.99 Reports align (supabase/migrations/20261029a_OPS_reports_align.sql and
// its rollback) on the throwaway Ops shaped database run.mjs built, after 0a, its revalue file, 0b, Drop 1,
// the drainer release, Drop 2, Drop 3 and Drop 4a: the live order on the night it runs. It never connects to
// Supabase. run.mjs --align calls alignSections() after its section 1.
//
//   50  the paste: 4a first (as live), a seeded world of sales through the real drainer, then the guard's
//       refusals (no 4a, a changed body, a second run, not Ops), the check row (every column), nothing at the
//       sites or logins moved, the rebuild queued (refund days and demo days, 15 a minute, newest first)
//   51  the refund rule in SQL (_sales_refund_parts, _sales_check_tenders, _sales_allocate) against the JS
//       rule (accountingDay.js, tradingSales.js) on every refund of the world and on random refunds
//   52  every Stock and GP figure against the P&L's own JS (tradingDays, timesheetDays, ledgerDays, the
//       Wastage log's wasteFromLedger) per venue day: net after refunds on the refund day, theoretical cost
//       with the unsale off, waste from the ledger, labour approved and paid on the day most of the shift
//       falls in, GP after never above GP before; sales_day_sums_check ok every day; demo history left out
//       (and, until a demo day is rebuilt, not shown, with the words); the waste entry with a cost and no
//       ledger named and not counted; the direct waste_events insert refused
//   53  the rollback: the twelve bodies back by md5, the two policies back, the helpers and columns gone,
//       the days queued and, once drained, every report exactly as before the paste; then the paste again
//       and every number as the first time
//
// Ids and neutral words only (the repo is public).

import { lit, jlit, arr, rng } from './base.mjs';
import { ORG_T, PROVO, LOC2, U, I, M, CALLERS, id } from './fixtures.mjs';
import { BASKET_SETUP, basketEvents, insertRow } from './channels.mjs';
import { DISC, PRICE, BM, basketSql, presetKindsSql } from './drainer_fixtures.mjs';
import { venueDay } from './drop4a.mjs';
// the reports' own JS rules: the P&L (trading-report), the Wastage log, the demo rule
import { tradingDays, timesheetDays, ledgerDays, refundSalesParts } from '../../functions/_shared/tradingSales.js';
import { allocate, checkTenders } from '../../functions/_shared/accountingDay.js';
import { leaveOutDemo } from '../../functions/_shared/demoHistory.js';
import { wasteFromLedger } from '../../../src/lib/stock/wasteLedger.js';

const PENNY = 0.0101;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const ALIGN_REPLACED = [
  ['public.sales_day_sums_rebuild(uuid,date,date)', '007c100176c9438b35c6531916555a79'],
  ['public.sales_day_sums_check(uuid,date)', '309f47ed5dc335eaea8b39fca077df25'],
  ['public._sales_day_sums_enqueue()', '35a05a622b0c4034f3a42f4fe18a6c5e'],
  ['public._sales_check_parts(public.closed_checks)', 'e8bf29d73eb072ae3ea7320e6db8d6ed'],
  ['public.report_day_sums(text[],date,date,jsonb)', '25a8daf22bd412c1a2579807d21b223c'],
  ['public.stock_rp__labour(uuid,date,date)', 'c517bbdaa5d045ee61da531288fa39df'],
  ['public.stock_rp__site_sales(jsonb)', '56b344ed1a153802e2b239a52b12b5b8'],
  ['public.stock_rp__site_figures(jsonb,jsonb)', '2682edc3b68ad1c9e1900c1ae174fe5b'],
  ['public.stock_rp__derive(uuid,jsonb)', '0e3d2aa719c32b9378a49a80567f832c'],
  ['public.stock_rp__demo_sales(uuid,date,date)', '38dc304d476f2d7892f2922cfbefdb9d'],
  ['public.stock_rp__meta(jsonb,text,date,date,boolean,text,jsonb,jsonb,jsonb)', '7dc410b654129a53de9ca72065a62bdf'],
  ['public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)', '012537d5fb83c45c65f75ae3906cefba'],
];
const HELPERS = ['public._sales_is_demo(text)', 'public._sales_allocate(bigint,bigint[])', 'public._sales_kind(text)',
  'public._sales_check_tenders(public.closed_checks)', 'public._sales_refund_at(jsonb,timestamptz)', 'public._sales_refund_parts(public.closed_checks,jsonb)'];
const NEW_COLS = ['sale_net', 'sale_theo', 'refund_net', 'refund_tax', 'refund_gross', 'refund_qty', 'refund_cost'];

export async function alignSections(ctx) {
  const { c, ok, section, guarded, FILES, QUICK, SEED = 1 } = ctx;
  const sql = (q, o) => c.sql(q, o);
  const num = (q, o) => c.num(q, o);
  const short = (x, n = 160) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);
  const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const near = (a, b, eps = PENNY) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
  const PRE = c.DB;
  const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  const drain = () => sql('call public.stock_outbox_drain(10, 200, 0.05, true);');
  const dsDrainAll = (force = false) => {
    if (force) sql(`update sales_day_sums_queue set due_at = now() - interval '1 second'`);
    for (let k = 0; k < 400; k++) {
      sql('call public.stock_day_sums_drain(40, 50);');
      if (num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) === 0) return k + 1;
    }
    return -1;
  };
  const drainAll = () => { for (let k = 0; k < 40 && num(`select count(*) from stock_outbox where status = 'pending' and due_at <= now()`) > 0; k++) drain(); dsDrainAll(); };
  // a report as the Owner app asks it (the service role) or as a login
  function callerLines(cl) {
    const lines = ['\\set VERBOSITY verbose', 'begin;'];
    if (cl.claims) lines.push(`select set_config('request.jwt.claims', ${lit(JSON.stringify(cl.claims))}, true) \\g /dev/null`);
    if (cl.role) { lines.push(`set local role ${cl.role};`); lines.push(`set local statement_timeout = '8s';`); lines.push(`set local lock_timeout = '8s';`); }
    return lines;
  }
  const rep = (who, name, { sites = [PROVO, LOC2], from, to, opts = null, limit = 1000 }) => {
    const lines = callerLines(CALLERS[who]);
    lines.push(`select public.stock_report_${name}('${ORG_T}', ${arr(sites)}, '${from}', '${to}', ${opts ? jlit(opts) : 'null'}, null, ${limit});`, 'commit;');
    const t0 = Date.now();
    const r = c.psql({ login: CALLERS[who].login, input: lines.join('\n') + '\n', allowFail: true });
    const out = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
    return { status: r.status, j: pj(out), err: (r.stderr || '').trim(), ms: Date.now() - t0 };
  };
  const siteRow = (j, loc) => (j?.totals || []).find((t) => t.location_id === loc) || null;
  const strip = (j) => JSON.stringify(j, (k, v) => (k === 'generated_at' ? undefined : v));
  const paste = (f, o) => c.paste(f, o);
  const lastRows = (r) => (r.sets[r.sets.length - 1] || { rows: [] }).rows;

  // ============================================================================================================
  section(50, '50. Reports align as the SQL editor runs it: 4a first, a seeded world, the guard, the check row, the rebuild queued');
  let world = null;
  let pasted = false;
  let before = null;
  await guarded('align paste', () => {
    c.use(PRE);
    const d0 = dsDrainAll();
    ok(d0 > 0, `the drainer's queue drained first (${d0} runs)`);
    c.createFrom('n_al_no4a', PRE);
    const a4 = paste(FILES.d4);
    ok(a4.status === 0, `4a applies first, as live (${a4.status ? short(a4.stderr, 400) : `${a4.ms} ms`})`);
    if (a4.status) return;
    sql(`update sales_day_sums_queue set due_at = now() - interval '1 second' where reason = 'drop4a_backfill'`);
    dsDrainAll();
    world = buildWorld();
    ok(!!world, `a seeded world of ${world?.days.length} days at Provo and Location 2: every channel through the real drainer, refunds on the day and days later, demo checks, timesheets, waste`);
    // the reports as 4a answers them, for the rollback proof
    before = snapshotReports(world);
    c.createFrom('n_al_pre', c.DB);   // 4a and the world in, align not yet
    // the guard's refusals, each on a copy, each changing nothing
    const refuse = (label, db, setup, want) => {
      c.createFrom('n_al_ref', db);
      c.use('n_al_ref');
      if (setup) sql(setup);
      const r = paste(FILES.al);
      ok(r.status !== 0 && (r.error || '').includes(want) && sql(`select to_regprocedure('public._sales_refund_parts(public.closed_checks,jsonb)') is null`) === 't',
        `refuses ${label}: "${short(r.error, 120)}" and nothing changed`);
    };
    refuse('without 4a', 'n_al_no4a', null, 'Run 20261026a_OPS_stock_native_4a.sql first');
    refuse('a changed body', 'n_al_pre', `create or replace function public.stock_rp__pct(p_num numeric, p_den numeric) returns numeric language sql immutable security definer set search_path = public, pg_temp as $f$ select null::numeric $f$;
      create or replace function public.stock_rp__labour(p_site uuid, p_from date, p_to date) returns table(pay numeric, has_data boolean) language sql stable security definer set search_path = public, pg_temp as $f$ select 0::numeric, false $f$;`, 'A report function changed since this file was written');
    refuse('on a database that is not Ops', 'n_al_pre', 'create table public.billing_state (id integer);', 'This is not the Ops database');
    c.use('n_al_pre');
    c.createFrom('n_al', 'n_al_pre');
    c.use('n_al');
    const r = paste(FILES.al);
    ok(r.status === 0, `Reports align applies as one paste (${r.status ? short(r.stderr, 900) : `${r.ms} ms`})`);
    if (r.status) return;
    const x = lastRows(r)[0] || {};
    console.log(`     check row: ${short(x, 1200)}`);
    ok(x.bodies_replaced === '12' && x.new_helpers === '6' && x.new_columns === '7' && x.waste_write_policies === '0' && x.backup_rows === '14'
       && x.internals_open_to_api === 'f' && x.site_rows_changed === '0' && x.logins_changed === 'f',
      'the check row: 12 bodies replaced, 6 helpers, 7 columns, the 2 waste write policies gone, 14 backup rows, internals closed, no site row or login changed');
    const want = num(`select count(*) from (select distinct location_id, business_day from sales_day_sums_queue where reason = 'reports_align') z`);
    ok(Number(x.refund_days_queued) + Number(x.demo_days_queued) === want && want > 0 && Number(x.backfill_minutes) === Math.ceil(want / 15),
      `the rebuild queued: ${x.refund_days_queued} refund days and ${x.demo_days_queued} demo days, ${x.backfill_minutes} minutes at 15 a minute`);
    const dues = pj(sql(`select json_agg(json_build_object('d', business_day, 'm', extract(epoch from due_at - queued_at)::integer / 60) order by due_at, business_day desc, location_id) from sales_day_sums_queue where reason = 'reports_align'`)) || [];
    ok(dues.every((q, k) => q.m === Math.floor(k / 15)) && dues.every((q, k) => k === 0 || dues[k - 1].d >= q.d),
      `15 venue days a minute, newest first (${dues.length} days over ${dues.length ? dues[dues.length - 1].m + 1 : 0} minutes)`);
    ok(x.leeds_18_oct_net === '' && x.provo_14_oct_labour !== undefined, `the live proof columns are there (empty here: no Coffee Boy Leeds in this database; Provo 14 Oct labour ${x.provo_14_oct_labour})`);
    for (const [sig, was] of ALIGN_REPLACED) ok(md5Of(sig) !== was, `${sig} replaced`);
    const again = paste(FILES.al);
    ok(again.status !== 0 && (again.error || '').includes('has run already'), `a second paste refuses: "${short(again.error, 100)}"`);
    pasted = true;
  });
  if (!pasted) return;

  // ============================================================================================================
  section(51, '51. The refund rule in SQL against the JS rule: every refund of the world, then random ones');
  await guarded('refund rule', () => {
    c.use('n_al');
    // every refund entry of the world's checks (demo included: the rule itself is the same)
    const pairs = pj(sql(`select coalesce(json_agg(json_build_object('row', to_jsonb(c), 'n', e.n, 'p', to_jsonb(p))), '[]')
                            from closed_checks c
                           cross join lateral jsonb_array_elements(c.refunds) with ordinality as e(r, n)
                           cross join lateral public._sales_refund_parts(c, e.r) p
                           where c.refunds is not null and c.refunds <> '[]'::jsonb and jsonb_typeof(e.r) = 'object'`)) || [];
    let bad = 0; const eg = [];
    for (const q of pairs) {
      const entry = q.row.refunds[q.n - 1];
      const js = refundSalesParts(entry, q.row);
      const sMin = Math.round(js.gross * 100), tMin = Math.round(js.vat * 100);
      const atOk = js.atMs == null ? q.p.at_ts == null : Math.abs(Date.parse(q.p.at_ts) - js.atMs) < 1;
      if (q.p.skipped !== js.skipped || (!js.skipped && (Number(q.p.sales_minor) !== sMin || Number(q.p.tax_minor) !== tMin)) || !atOk) { bad++; if (eg.length < 3) eg.push({ id: q.row.id, sql: q.p, js }); }
    }
    ok(pairs.length > 10 && bad === 0, `${pairs.length} refunds of the world: the SQL refund rule equals the JS rule on every one (skipped, goods, VAT, the instant)${bad ? ` (${bad} differ: ${short(eg, 500)})` : ''}`);
    // random checks and refunds: tenders (card, cash, gift card, loyalty, promo, booking, odd ones), legs,
    // statuses, splits, full refunds, legacy rows; the same answer from both sides
    const rand = rng(SEED + 51);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const money = () => Math.round(rand() * 4000) / 100;
    const N = QUICK ? 300 : 1200;
    const cases = [];
    for (let k = 0; k < N; k++) {
      const sub = money() + 1;
      const legacy = rand() < 0.2;
      const tip = rand() < 0.3 ? Math.round(rand() * 300) / 100 : 0;
      const service = rand() < 0.2 ? Math.round(rand() * 200) / 100 : 0;
      const total = Math.round((sub + service + tip) * 100) / 100;
      const tenders = legacy ? null : Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({
        method: pick(['card', 'cash', 'gift_card', 'loyalty', 'promo', 'booking_deposit', 'Card ', 'apple-pay', 'other', 'deliveroo', 'split']),
        amount: Math.round(rand() * total * 100) / 100, tip: rand() < 0.3 ? Math.round(rand() * 200) / 100 : 0 }));
      const row = { id: `rnd-${k}`, location_id: PROVO, closed_at: new Date(Date.UTC(2026, 9, 1 + (k % 20), 12)).toISOString(), subtotal: sub, total,
        tax_amount: rand() < 0.15 ? null : Math.round(sub / 6 * 100) / 100, service, tip, status: 'paid', voided: false, discounts: rand() < 0.1 ? [{ amount: sub }] : [],
        tenders, method: pick(['card', 'cash', 'gift_card+card', 'split', 'card:5.00,loyalty:1.00', 'booking+cash']), payment_method: null, source: pick(['pos', 'kiosk', 'online']),
        processor: null, gift_card: rand() < 0.2 ? { applied: 300 } : null, loyalty: rand() < 0.2 ? { discount_value: 150 } : null, promo: rand() < 0.1 ? { discount_value: 1 } : null,
        payment_intents: rand() < 0.1 ? [{ method: 'booking', amountMinor: 500 }] : null, items: [] };
      const legs = rand() < 0.5 ? [{ status: pick(['accepted', 'succeeded', 'failed', 'pending']), amountMinor: Math.round(rand() * total * 100) }] : [];
      const entry = { id: `e${k}`, timestamp: rand() < 0.9 ? Date.parse(row.closed_at) + Math.floor(rand() * 5) * 86400000 : null, amount: Math.round(rand() * total * 100) / 100,
        tenderMethod: pick(['card', 'cash', null, 'gift_card']), cardStatus: pick(['accepted', 'failed', 'partial', 'pending', null]), legs,
        isFullRefund: rand() < 0.3, ...(rand() < 0.7 ? { taxAmount: Math.round(rand() * 300) / 100, tipAmount: rand() < 0.5 ? 0 : Math.round(rand() * 100) / 100, serviceAmount: 0 } : {}),
        ...(rand() < 0.5 ? { items: [{ itemId: 'x', qty: 1, price: 2 }] } : {}), ...(rand() < 0.03 ? { failed: true } : {}) };
      cases.push({ row, entry });
    }
    const out = pj(sql(`select json_agg(json_build_object('k', z.k, 'p', to_jsonb(p), 't', (select json_agg(to_jsonb(t) order by t.i) from public._sales_check_tenders(jsonb_populate_record(null::public.closed_checks, z.row)) t)) order by z.k)
                          from jsonb_to_recordset(${lit(JSON.stringify(cases.map((x, k) => ({ k, row: x.row, entry: x.entry }))))}::jsonb) as z(k integer, row jsonb, entry jsonb)
                         cross join lateral public._sales_refund_parts(jsonb_populate_record(null::public.closed_checks, z.row), z.entry) p`)) || [];
    let rbad = 0, tbad = 0; const reg = [];
    for (const o of out) {
      const { row, entry } = cases[o.k];
      const js = refundSalesParts(entry, row);
      const sMin = Math.round(js.gross * 100), tMin = Math.round(js.vat * 100);
      if (o.p.skipped !== js.skipped || (!js.skipped && (Number(o.p.sales_minor) !== sMin || Number(o.p.tax_minor) !== tMin))) { rbad++; if (reg.length < 3) reg.push({ row, entry, sql: o.p, js }); }
      const jt = checkTenders(row).tenders.map((t) => [t.kind, t.amount, t.tip]);
      const st = (o.t || []).map((t) => [t.kind, Number(t.amount), Number(t.tip)]);
      if (JSON.stringify(jt) !== JSON.stringify(st)) tbad++;
    }
    ok(out.length === N && rbad === 0, `${N} random refunds (seed ${SEED + 51}): SQL equals JS on every one${rbad ? ` (${rbad} differ: ${short(reg, 900)})` : ''}`);
    ok(out.length === N && tbad === 0, `${N} random checks: _sales_check_tenders equals checkTenders (kind, amount, tip) on every one${tbad ? ` (${tbad} differ)` : ''}`);
    let abad = 0;
    for (let k = 0; k < 200; k++) {
      const w = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => (rand() < 0.2 ? 0 : Math.floor(rand() * 1000)));
      const t = Math.floor(rand() * 5000) - (rand() < 0.1 ? 2000 : 0);
      const s = (sql(`select array_to_string(public._sales_allocate(${t}, array[${w.join(',')}]::bigint[]), ',')`) || '').split(',').map(Number);
      if (JSON.stringify(s) !== JSON.stringify(allocate(t, w))) abad++;
    }
    ok(abad === 0, `200 random splits: _sales_allocate equals allocate (largest remainder, ties to the earlier, all zero to the first)${abad ? ` (${abad} differ)` : ''}`);
  });

  // ============================================================================================================
  section(52, '52. Every Stock and GP figure against the P&L and the Wastage log, per venue day');
  await guarded('figures', () => {
    c.use('n_al');
    // until a demo day is rebuilt, a window holding it shows no sales, with the new words
    const dd = world.demoDay;
    const pre = rep('ownerT', 'cogs', { from: dd, to: dd });
    const pr = siteRow(pre.j, PROVO);
    ok(pre.status === 0 && pr && pr.sales_net == null && pr.demo_sales === true && (pre.j.meta.notes || []).some((n) => n.startsWith('Demo history at Provo is still being taken out')),
      `before the drain: ${dd} at Provo (a demo day not yet rebuilt) shows no sales, with the words ("${short((pre.j?.meta?.notes || []).find((n) => n.startsWith('Demo')), 110)}")`);
    const runs = dsDrainAll(true);
    ok(runs > 0 && num(`select count(*) from sales_day_sums_queue`) === 0 && num(`select count(*) from sales_day_sums where refund_net is null and business_day in (select distinct business_day from sales_day_sums where refund_net is not null)`) >= 0,
      `the drain rebuilds every queued day (${runs} runs)`);
    const o = oracle();
    for (const loc of [PROVO, LOC2]) {
      const name = loc === PROVO ? 'Provo' : 'Location 2';
      let nb = 0, tb = 0, wb = 0, lb = 0, gb = 0, cb = 0, pb = 0, wl = 0; const eg = [];
      for (const d of world.days) {
        const r = rep('ownerT', 'cogs', { sites: [PROVO, LOC2], from: d, to: d });
        const s = siteRow(r.j, loc) || {};
        const want = o[loc];
        // theoretical cost is the P&L's COGS less the stock rows of a voided check (a channel cancel whose stock
        // the ledger kept: Stock and GP never counts a voided check's sale, as 4a never did; named below)
        const net = want.sales[d]?.net ?? 0, theo = want.ledgerNoVoid.cogs[d] ?? 0, waste = want.ledger.waste[d] ?? 0, lab = want.labour[d] ?? 0;
        if (!near(s.sales_net, net)) { nb++; if (eg.length < 4) eg.push({ d, what: 'net', got: s.sales_net, want: net }); }
        if (!near(s.theo_cost, theo)) { tb++; if (eg.length < 4) eg.push({ d, what: 'theo', got: s.theo_cost, want: theo }); }
        if (!near((want.ledger.cogs[d] ?? 0) - theo, want.voidKept[d] ?? 0)) { tb++; if (eg.length < 4) eg.push({ d, what: 'void kept', got: (want.ledger.cogs[d] ?? 0) - theo, want: want.voidKept[d] }); }
        if (!near(s.labour ?? 0, lab)) { lb++; if (eg.length < 4) eg.push({ d, what: 'labour', got: s.labour, want: lab }); }
        if (!(near(s.gp_after, Number(s.sales_net) - Number(s.theo_cost)) && s.gp_before != null && Number(s.gp_before) >= Number(s.gp_after) - 1e-9
              && near(Number(s.gp_before) - Number(s.gp_after), s.comps_cost))) { gb++; if (eg.length < 4) eg.push({ d, what: 'gp', got: [s.gp_before, s.gp_after, s.comps_cost] }); }
        const ck = pj(sql(`select public.sales_day_sums_check('${loc}', '${d}')`));
        if (!ck?.ok) { cb++; if (eg.length < 4) eg.push({ d, what: 'check', got: ck }); }
        // the Wastage log's JS over the same day's rows equals the report
        const evs = (want.events || []).filter((e) => e.day === d);
        const mvs = (want.mv || []).filter((m) => m.day === d && m.movement_type === 'WASTE');
        const wjs = wasteFromLedger({ events: evs, movements: mvs }).total;
        const wr = siteRow(rep('ownerT', 'waste', { from: d, to: d }).j, loc) || {};
        const dsh = siteRow(rep('ownerT', 'dashboard', { from: d, to: d }).j, loc) || {};
        if (!near(wr.waste_value, waste) || !near(wr.ledger_waste, waste)) { wb++; if (eg.length < 4) eg.push({ d, what: 'waste report', got: [wr.waste_value, wr.ledger_waste], want: waste }); }
        if (!near(wjs, waste) || (dsh.waste_value !== undefined && !near(dsh.waste_value, waste))) { wl++; if (eg.length < 4) eg.push({ d, what: 'wastage log / dashboard', got: [wjs, dsh.waste_value], want: waste }); }
        // Product GP adds up to the site, but for a sealed item put back on the shelf (P&L keeps its cost)
        if (loc === LOC2) {
          const pg = siteRow(rep('ownerT', 'product_gp', { sites: [LOC2], from: d, to: d }).j, LOC2) || {};
          // the products' cost after their refunds' own takes equals the site's cost with the ledger's unsale off
          if (!near(pg.known_net, s.sales_net) || !near(pg.theo_cost, s.theo_cost)) { pb++; if (eg.length < 4) eg.push({ d, what: 'product gp', got: [pg.known_net, pg.theo_cost], want: [s.sales_net, s.theo_cost] }); }
        }
      }
      ok(nb + tb + wb + lb + gb + cb + pb + wl === 0,
        `${name}, ${world.days.length} days: net after refunds, theoretical cost (unsale off), waste, labour equal the P&L's own JS; GP after = net less cost, GP before = after plus comps; the day check ok; the Wastage log equals the report${loc === LOC2 ? '; Product GP adds up to the site' : ''}${eg.length ? ` (${short(eg, 700)})` : ''}`);
    }
    // the whole window at once, both sites: demo left out, refunds made after a sale's day on their own day
    const from = world.days[0], to = world.days[world.days.length - 1];
    const all = rep('ownerT', 'cogs', { from, to });
    for (const loc of [PROVO, LOC2]) {
      const s = siteRow(all.j, loc) || {};
      const net = world.days.reduce((t, d) => t + (o[loc].sales[d]?.net ?? 0), 0);
      ok(near(s.sales_net, net, 0.02) && s.demo_sales === false, `${loc === PROVO ? 'Provo' : 'Location 2'} ${from} to ${to}: net ${s.sales_net} = the P&L's ${net.toFixed(2)}, demo history left out (shown, not hidden)`);
    }
    ok(all.j?.meta?.demo_left_out === true, 'meta.demo_left_out true: the screen says "Demo history left out"');
    // a refund made days after its sale sits on the refund's day, in Stock and GP and in the P&L
    const late = world.lateRefund;
    const lr = siteRow(rep('ownerT', 'cogs', { from: late.day, to: late.day }).j, PROVO);
    ok(near(lr.sales_net, o[PROVO].sales[late.day]?.net ?? 0) && Number(o[PROVO].sales[late.day]?.refunds || 0) > 0,
      `a refund made on ${late.day} for a sale of ${late.saleDay} comes off ${late.day} (net ${lr.sales_net}, refunds that day ${o[PROVO].sales[late.day]?.refunds})`);
    // labour: a pending shift is not labour; an opener who clocks in before the day starts stays on that day
    const lab = rep('ownerT', 'cogs', { from: world.labourDay, to: world.labourDay });
    ok(near(siteRow(lab.j, PROVO)?.labour, o[PROVO].labour[world.labourDay] ?? 0) && Number(world.pendingPay) > 0,
      `labour on ${world.labourDay}: ${siteRow(lab.j, PROVO)?.labour} (approved and paid, an early opener on the day, an overnight closer on the night; ${world.pendingPay} pending left out)`);
    // the waste entry with a cost and nothing off stock: named, never counted
    const wd = rep('ownerT', 'waste', { from: world.ghostDay, to: world.ghostDay });
    const ghostNotes = (wd.j?.meta?.notes || []).filter((n) => n.includes('carry a cost but took nothing off stock: not counted'));
    ok(ghostNotes.length === 1 && ghostNotes[0].startsWith('1 waste entry at Provo') && near(siteRow(wd.j, PROVO)?.waste_value, o[PROVO].ledger.waste[world.ghostDay] ?? 0)
       && num(`select count(*) from waste_events w where w.source in ('refund', 'void') and not exists (select 1 from stock_movements m where m.location_id = w.location_id and m.movement_type = 'WASTE' and md5(m.idempotency_key)::uuid = w.id)`) === 0,
      `the waste entry with a cost and no ledger on ${world.ghostDay}: named ("${short((wd.j?.meta?.notes || []).find((n) => n.includes('nothing off stock')), 100)}") and not counted`);
    // nobody can write a waste row past its ledger any more; stock_record_waste still writes both
    const direct = c.psql({ login: 'authenticator', input: callerLines(CALLERS.mgrProvo).concat([`insert into waste_events (location_id, item_name, qty, unit, reason, cost_value, source) values ('${PROVO}', 'x', 1, 'each', 'x', 9.99, 'pos');`, 'commit;']).join('\n') + '\n', allowFail: true });
    ok(direct.status !== 0 && /row-level security|permission denied/.test(direct.stderr || ''), `a signed in manager can no longer insert a waste row directly (${short((direct.stderr || '').split('\n').find((l) => l.includes('ERROR')) || '', 120)})`);
    // the Owner app reads the league as the service role: its Stock line carries the same net
    const lg = rep('service', 'league', { from, to });
    const lgRow = (lg.j?.rows || []).find((r) => r.location_id === PROVO);
    ok(lg.status === 0 && near(lgRow?.sales_net, siteRow(all.j, PROVO)?.sales_net), `the league (the Owner app's Stock line) answers the same net (${lgRow?.sales_net})`);
    const own = rep('ownerT', 'dashboard', { from, to });
    ok(own.status === 0 && own.ms < 5000, `the dashboard as the owner under the live limits: ${own.ms} ms`);
  });

  // ============================================================================================================
  section(53, '53. The rollback: every body back by md5, the policies back, nothing of align left, every report as before; then align again');
  await guarded('rollback', () => {
    c.use('n_al');
    const after1 = snapshotReports(world);
    const rb = paste(FILES.alRb);
    const x = lastRows(rb)[0] || {};
    console.log(`     rollback: ${short(x, 400)}`);
    ok(rb.status === 0 && x.bodies_restored === '12' && x.policies_back === '2' && x.helpers_left === '0' && x.columns_left === '0' && x.backup_rows_left === '0' && x.site_rows_changed === '0',
      `the rollback: 12 bodies back, 2 policies back, no helper, column or backup row left, no site row changed${rb.status ? `: ${short(rb.stderr, 400)}` : ''}`);
    let same = 0;
    for (const [sig, was] of ALIGN_REPLACED) if (md5Of(sig) === was) same++;
    ok(same === ALIGN_REPLACED.length, `every replaced body has its live md5 again (${same} of ${ALIGN_REPLACED.length})`);
    ok(HELPERS.every((h) => sql(`select to_regprocedure('${h}') is null`) === 't') && num(`select count(*) from information_schema.columns where table_name = 'sales_day_sums' and column_name in (${NEW_COLS.map((k) => `'${k}'`).join(', ')})`) === 0,
      'the six helpers and the seven columns are gone');
    dsDrainAll(true);
    const back = snapshotReports(world);
    const diff = Object.keys(before).filter((k) => before[k] !== back[k]);
    ok(diff.length === 0, `once drained, every report answers exactly what 4a answered before the paste (${Object.keys(before).length} answers${diff.length ? `; differ: ${diff.slice(0, 4).join(', ')}` : ''})`);
    const again = paste(FILES.al);
    ok(again.status === 0, `Reports align applies again after its rollback (${again.status ? short(again.stderr, 400) : 'ok'})`);
    dsDrainAll(true);
    const after2 = snapshotReports(world);
    const d2 = Object.keys(after1).filter((k) => after1[k] !== after2[k]);
    ok(d2.length === 0, `and every report answers exactly what it answered the first time (${Object.keys(after1).length} answers${d2.length ? `; differ: ${d2.slice(0, 4).join(', ')}` : ''})`);
  });

  // -- the world ----------------------------------------------------------------------------------------------
  function buildWorld() {
    const N = QUICK ? 6 : 12;
    const rand = rng(SEED + 50);
    const today = sql(`select (public.stock_co__venue_day('${PROVO}', now())).business_day::text`);
    const days = Array.from({ length: N }, (_, k) => addDays(today, -(N - k)));
    c.psql({ input: BASKET_SETUP });
    c.psql({ input: basketSql() });
    sql(presetKindsSql);
    sql(`insert into venue_clock (location_id, timezone, day_start, synced_at) values ('${PROVO}', 'Europe/London', '06:00', now()), ('${LOC2}', 'Europe/London', '06:30', now())
         on conflict (location_id) do update set timezone = excluded.timezone, day_start = excluded.day_start`);
    sql(`update stock_depletion_mode set central_since = now() - interval '60 days' where location_id in ('${PROVO}', '${LOC2}')`);
    sql(`update stock_movements set occurred_at = occurred_at - interval '45 days' where left(source_id, 5) = 'seed-' and movement_type = 'SALE_DEPLETION'`);
    drainAll();
    const items = (loc) => pj(sql(`select json_agg(json_build_object('id', id, 'name', name, 'unit', base_unit) order by name, id) from inventory_items where location_id = '${loc}' and archived_at is null`)) || [];
    const its = { [PROVO]: items(PROVO), [LOC2]: items(LOC2) };
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const post = (loc, it, q, type, src, key, at, sid = key) => `select public._post_stock_movement('${loc}', '${it}', ${q}, '${type}', null, '${src}', '${sid}', '${key}', '${at}', null, null, null)`;
    const ONLY_P = ['cash', 'card', 'split', 'terminal', 'bartab', 'kiosk', 'pat', 'mpos', 'hubrise', 'hr-cancel', 'ref-uid', 'ref-nouid', 'ref-full', 'ref-refused', 'sealed',
      'void-made', 'staff-check', 'staff-item', 'staff-label', 'comp', 'loy-tender', 'loy-kind', 'loy-legacy', 'promo', 'mods', 'gift', 'deposit', 'drive'];
    const ONLY_L = ['cash', 'kiosk', 'pat', 'mpos', 'hubrise', 'ref-uid', 'ref-full', 'void-made', 'staff-label', 'loy-tender'];
    const venues = [
      { p: 'p', loc: PROVO, menu: { a: M.pLatte, b: M.pFlat, c: M.pBoard, juice: BM.juice, shot: BM.shot, drive: BM.drive }, dev: { till: 'tillProvo', kiosk: 'kioskProvo', mpos: 'mposProvo' },
        presets: { staff: DISC.pStaff, comp: DISC.pComp, loyalty: DISC.pLoyalty }, only: ONLY_P },
      { p: 'l', loc: LOC2, menu: { a: M.lLatte, b: M.lSoup, c: M.lBread }, dev: { till: 'tillLoc2', kiosk: 'tillLoc2', mpos: 'tillLoc2' }, presets: { staff: DISC.lStaff }, only: ONLY_L },
    ];
    let pendingPay = 0;
    let lateRefund = null;
    for (let k = 0; k < N; k++) {
      const d = days[k];
      const at = (h, m = 0) => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
      // the sales of the day through every channel and the real drainer, at midday
      for (const v of venues) {
        const t0 = Date.parse(`${d}T11:00:00Z`) + (v.p === 'p' ? 0 : 1800000);
        const evs = basketEvents({ p: `a${k}${v.p}`, loc: v.loc, t0, menu: v.menu, price: PRICE, dev: v.dev, presets: v.presets, only: v.only }).filter((e) => e.caller !== 'customer');
        for (const ph of ['A', 'B', 'C']) {
          const body = evs.filter((e) => e.phase === ph).map((e) => e.sql);
          if (body.length) sql(`${body.join(';\n')};`);
          drain();
        }
      }
      const out = [];
      // a refund made today on a sale of the day before (a part refund of one line, as the till writes it)
      if (k >= 1) {
        const saleDay = days[k - 1];
        const ts = Date.parse(`${d}T13:00:00Z`);
        const entry = { id: `late-${k}`, timestamp: ts, items: [{ uid: 'c1', itemId: M.pLatte, qty: 2, refundQty: 1, price: PRICE[M.pLatte] }], isFullRefund: false,
          amount: PRICE[M.pLatte], taxAmount: Math.round(PRICE[M.pLatte] / 6 * 100) / 100, tipAmount: 0, serviceAmount: 0, tenderMethod: 'cash', cardStatus: 'accepted', legs: [] };
        out.push(`update closed_checks set refunds = coalesce(refunds, '[]'::jsonb) || ${lit(JSON.stringify([entry]))}::jsonb, status = 'partial_refund' where id = 'a${k - 1}p-cash'`);
        if (!lateRefund && k === Math.floor(N / 2)) lateRefund = { day: d, saleDay };
      }
      // demo history (as the demo files wrote it: a check with no outbox, its stock under demo keys, a refund on it)
      const dm = `demo-al-${k}`;
      out.push(`set session_replication_role = replica`);
      out.push(insertRow({ id: dm, location_id: PROVO, ref: `DEMOAL${k}`, closed_at: at(12), items: [{ uid: 'd1', itemId: M.pLatte, qty: 3, price: PRICE[M.pLatte] }],
        subtotal: 3 * PRICE[M.pLatte], total: 3 * PRICE[M.pLatte], tax_amount: Math.round(3 * PRICE[M.pLatte] / 6 * 100) / 100, service: 0, tip: 0, source: 'pos', order_type: 'dine-in',
        status: 'paid', voided: false, discounts: [], method: 'card', payment_method: 'card', tenders: [{ method: 'card', amount: 3 * PRICE[M.pLatte], tip: 0 }],
        refunds: [{ id: `dr-${k}`, timestamp: Date.parse(at(14)), amount: PRICE[M.pLatte], taxAmount: 0.5, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', items: [], isFullRefund: false }] }));
      out.push(`set session_replication_role = origin`);
      out.push(post(PROVO, I.pMilk, -1, 'SALE_DEPLETION', 'closed_check', `demo-v1:sale:${dm}`, at(12), dm));
      out.push(post(PROVO, I.pEggs, -1, 'WASTE', 'waste', `demo-v1:w:${k}`, at(16)));
      // waste, entered with a reason (its ledger row and its waste row, as stock_record_waste writes them)
      for (const v of venues) {
        const x = pick(its[v.loc]); const wid = id('a8800000', `${k}${v.p === 'p' ? 1 : 2}`);
        out.push(post(v.loc, x.id, -1, 'WASTE', 'waste', `waste:${wid}`, at(15), wid));
        out.push(`insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, cost_value, source, occurred_at)
                  select '${wid}', '${v.loc}', '${x.id}', ${lit(x.name)}, 1, ${lit(x.unit)}, 1, 'Dropped', coalesce(current_cost, 0), 'backoffice', '${at(15)}' from inventory_items where id = '${x.id}'`);
      }
      // labour at Provo: an approved shift, a paid opener who clocks in before the 06:00 day start, an overnight
      // closer (the night belongs to the day it started), and a pending one that is not labour yet
      const pay = (80 + rand() * 30).toFixed(2);
      const pend = (40 + rand() * 20).toFixed(2);
      pendingPay += Number(pend);
      out.push(`insert into wf_timesheets (location_id, org_id, clock_in, clock_out, actual_hours, effective_rate, pay_amount, status) values
                  ('${PROVO}', '${ORG_T}', '${at(7)}', '${at(15)}', 8, 11.5, ${pay}, 'approved'),
                  ('${PROVO}', '${ORG_T}', '${d}T04:40:00Z', '${at(12, 40)}', 8, 11.5, 70.00, 'paid'),
                  ('${PROVO}', '${ORG_T}', '${at(21)}', '${addDays(d, 1)}T03:30:00Z', 6.5, 12, 78.00, 'approved'),
                  ('${PROVO}', '${ORG_T}', '${at(9)}', '${at(13)}', 4, 11, ${pend}, 'pending')`);
      sql(`${out.join(';\n')};`);
      drainAll();
    }
    // a waste entry with a cost and nothing off stock (the root cause the release closes): written as the
    // demo file wrote its three dish rows, straight into waste_events
    const ghostDay = days[1];
    sql(`insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, cost_value, sale_value, source, occurred_at)
         values ('${id('a8900000', 1)}', '${PROVO}', null, 'Dish with no recipe', 1, 'each', 1, 'Over-production', 3.42, 14, 'pos', '${ghostDay}T12:10:00Z')`);
    drainAll();
    return { days, demoDay: days[N - 1], lateRefund: lateRefund || { day: days[1], saleDay: days[0] }, labourDay: days[2], pendingPay: pendingPay.toFixed(2), ghostDay };
  }

  // the P&L's own JS over the raw rows, per venue day (independent of every SQL function this release made)
  function oracle() {
    const out = {};
    for (const loc of [PROVO, LOC2]) {
      const clock = pj(sql(`select json_build_object('tz', coalesce(c.timezone, 'Europe/London'), 'start', to_char(coalesce(c.day_start, '06:00'), 'HH24:MI')) from venue_clock c where c.location_id = '${loc}'`)) || { tz: 'Europe/London', start: '06:00' };
      const dayOf = (ms) => venueDay(ms / 1000, clock.tz, clock.start);
      const rows = pj(sql(`select coalesce(json_agg(to_jsonb(c)), '[]') from closed_checks c where c.location_id = '${loc}'`)) || [];
      const nod = leaveOutDemo(rows).rows;
      const sales = tradingDays({ saleRows: nod, refundRows: nod, dayOf });
      const mv = (pj(sql(`select coalesce(json_agg(json_build_object('value_delta', m.value_delta, 'occurred_at', m.occurred_at, 'movement_type', m.movement_type, 'idempotency_key', m.idempotency_key,
                    'source_type', m.source_type, 'source_id', m.source_id, 'inventory_item_id', m.inventory_item_id)), '[]') from stock_movements m where m.location_id = '${loc}' and m.movement_type in ('SALE_DEPLETION', 'WASTE')`)) || [])
        .map((m) => ({ ...m, day: dayOf(Date.parse(m.occurred_at)) }));
      const ledger = ledgerDays({ movements: mv, dayOf });
      const voided = new Set(rows.filter((r) => r.voided === true || ['void', 'voided'].includes(String(r.status || ''))).map((r) => r.id));
      const ofVoid = (m) => voided.has(m.source_id) && ['closed_check', 'closed_check_refund'].includes(m.source_type);
      const ledgerNoVoid = ledgerDays({ movements: mv.filter((m) => !ofVoid(m)), dayOf });
      const voidKept = ledgerDays({ movements: mv.filter(ofVoid), dayOf }).cogs;
      const ts = pj(sql(`select coalesce(json_agg(json_build_object('id', t.id, 'clock_in', t.clock_in, 'clock_out', t.clock_out, 'pay_amount', t.pay_amount, 'status', t.status)), '[]') from wf_timesheets t where t.location_id = '${loc}'`)) || [];
      const labour = timesheetDays({ timesheets: ts, dayOf });
      const events = (pj(sql(`select coalesce(json_agg(json_build_object('id', w.id, 'inventoryItemId', w.inventory_item_id, 'occurredAt', w.occurred_at, 'source', w.source, 'costValue', w.cost_value)), '[]') from waste_events w where w.location_id = '${loc}'`)) || [])
        .map((e) => ({ ...e, day: dayOf(Date.parse(e.occurredAt)) }));
      out[loc] = { sales, ledger, ledgerNoVoid, voidKept, labour, mv, events };
    }
    return out;
  }

  // every report of the world's window, as JSON without the generated time (for the rollback proof)
  function snapshotReports(w) {
    const out = {};
    const from = w.days[0], to = w.days[w.days.length - 1];
    for (const name of ['dashboard', 'league', 'cogs', 'product_gp', 'waste', 'value', 'movement', 'gap']) {
      const r = rep('ownerT', name, { from, to });
      out[name] = r.status === 0 ? strip(r.j) : `error ${short(r.err, 200)}`;
    }
    for (const d of w.days) out[`cogs ${d}`] = strip(rep('ownerT', 'cogs', { from: d, to: d }).j);
    return out;
  }
}
