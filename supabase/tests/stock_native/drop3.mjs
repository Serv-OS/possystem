// drop3.mjs: proves Drop 3 of multi site stock (supabase/migrations/20261027a_OPS_stock_native_3.sql and its
// rollback) on the throwaway Ops shaped database run.mjs built (section 1), after 0a, its revalue file, 0b,
// Drop 1 (20261024a), the drainer release (20261023a) and Drop 2 (20261025a), in Peter's order. It never
// needs 20261026a (Drop 4a). run.mjs --drop3 calls drop3Sections(). It never connects to Supabase.
//
//   40  the paste: refused without Drop 2, on a second run, with a changed body, off Ops; runs without
//       20261026a; the check row; no site row, login, menu or order row changes
//   41  what it made: every new table (RLS, exact grants, read rule, fence, no write policy), the 41 columns,
//       the transfer CHECK swap, the three triggers, the cron jobs and vault keys, the inbox bucket policies,
//       every new function (definer, search path, exact grants; the anon key refused but the waste reasons'
//       device branch)
//   42  stock_co__next_delivery equals nextDelivery (contract 2.3) on 2,000 random rule sets, exceptions and
//       venue clocks across both clock changes; one minute after the cut off asks for the next delivery; no cut
//       off means midnight the day before
//   43  orders and approvals with real roles; the runner passes up at 60 and 30 minutes and sends at the order
//       by time as sent unapproved (or missed with the setting off); the maximum; the fee and its waiver;
//       orders for many sites; a one site company sees send; every Stock control level
//   44  standing orders: the runner makes the order with the site's edits, skips a bank holiday and a paused
//       order, records a held supplier with no send job, makes nothing twice
//   45  invoices, credits, prices: the price rule moves THAT site's price only (cost step, REVALUE, alert over
//       5%), agreed prices raise a credit request, the 3 way match, missing invoices, splits, the lock, make
//       company price, a one site company's invoice is byte for byte today's answer
//   46  counts and waste: second approval, if not counted zero, locked periods (refused, snapshot frozen, back
//       dated waste booked now), waste over the PIN limit on the till and the phone, 5 wrong PINs lock, the
//       waste reasons device branch
//   47  transfers and the kitchen: request, fulfil, send, receive by company item; refuse; dispute and resolve
//       move no stock; a kitchen order picked, sent and received puts stock in ONCE; the production plan;
//       kitchen only recipes hidden from other site managers; the recharge statement; a kitchen standing order
//   48  alerts staged once, multi site only; reads at 50 sites by 20 suppliers in pages of 100 under 1 s; the
//       runner with 1,000 standing orders due under 8 s a call with no item lock held over 1 s
//   49  every order channel basket identical before and after Drop 3, nothing moved a number by itself; the
//       rollback (10 bodies back by md5, the tables gone, numbers unchanged); then Drop 3 again
//
// Ids and neutral words only (the repo is public).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { here, lit, jlit, rng } from './base.mjs';
import { ORG_T, PROVO, LOC2, ORG_S, SOLO, U, I, SUP, SP, M, CALLERS, id } from './fixtures.mjs';
import { BASKET_SETUP, basketEvents, basketTimeArrives, basketBookedSql } from './channels.mjs';
import { PRICE } from './drainer_fixtures.mjs';
import { D2_SHAPE } from './drop2.mjs';
import * as PR from '../../functions/_shared/purchasingRules.js';

// The 10 bodies Drop 3 rebuilds and the 23 it only checks (contract 1.1).
export const D3_BODIES = readFileSync(join(here, '..', '..', 'migrations', '20261027a_OPS_stock_native_3.sql'), 'utf8')
  .split('\n').map((l) => /^\s+\('(public\.[a-z0-9_]+\([^)]*\))', '([0-9a-f]{32})'\)/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]);
export const D3_REPLACED = ['stock_post_invoice', 'stock_receive', 'stock_record_waste', 'stock_approve_count_pin', 'post_stock_transfer_leg',
  'stock_needs_attention', 'stock_save_recipe', 'stock_co__recipe_on_at', 'stock_recipe_detail', 'stock_recipe_card'];
const LIVE_SECOND_STEP_MD5 = '5027ed5a5c5ca0b6f03a1d414998dfeb';

// contract 1.2: grants and read rules of the 25 tables
const AS = ['authenticated', 'service_role'];
export const D3_TABLES = {
  stock_po_approvals: { g: { authenticated: 'SELECT', service_role: 'SELECT' }, read: true },
  stock_po_send_jobs: { g: { service_role: 'SELECT,UPDATE' }, read: false },
  stock_standing_orders: { read: true }, stock_standing_order_lines: { read: true }, stock_standing_runs: { read: true },
  stock_delivery_exceptions: { read: true }, stock_order_lists: { read: true }, stock_budgets: { read: true },
  stock_invoice_inbox: { g: { authenticated: 'SELECT', service_role: 'INSERT,SELECT' }, read: true },
  supplier_invoice_site_splits: { read: true }, stock_credit_requests: { read: true }, stock_credit_request_lines: { read: true },
  stock_credit_notes: { read: true }, stock_count_plans: { read: true }, stock_count_templates: { read: true },
  stock_count_template_lines: { read: true }, stock_count_template_sites: { read: true }, stock_template_shelf_order: { read: true },
  stock_transfer_lists: { read: true }, stock_forecast_hours: { read: true }, stock_co_site_forecast_source: { read: true },
  stock_co_recipe_secrets: { read: true }, stock_kitchen_plan_ticks: { read: true },
  stock_recharge_posts: { g: { authenticated: 'SELECT', service_role: 'INSERT,SELECT,UPDATE' }, read: true },
  stock_notify_sent: { g: { service_role: 'INSERT,SELECT,UPDATE' }, read: false },
};
const BOTH = ['stock_order_pad_context', 'stock_po_submit', 'stock_edit_standing_run', 'stock_budget_status', 'stock_save_forecast',
  'stock_fresh_closedown_list', 'stock_request_transfer', 'stock_fulfil_request', 'stock_dispute_transfer', 'stock_kitchen_orders_in',
  'stock_kitchen_plan', 'stock_kitchen_tick', 'stock_kitchen_untick', 'stock_kitchen_pick'];
const SERVICE = ['stock_inbox_receive', 'stock_recharge_record', 'po_cutoff_cron_ok', 'stock_notify_cron_ok', 'stock_notify_targets'];
const NONE = ['stock_po_cutoff_run', 'stock_notify_due'];
const ANON = ['stock_waste_reasons'];

// The live shapes Drop 3 reads that the harness base lacks (read from the live database 22 Oct 2026;
// synthetic rows only): the rota's forecast, the staff contact table, Xero connections, ezCater links and
// the storage schema stand in (buckets, objects, foldername).
export const D3_SHAPE = `
create table if not exists public.wf_sales_forecast (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, forecast_date date not null,
  currency char(3) not null default 'GBP', amount numeric not null default 0 check (amount >= 0), actual_amount numeric,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (location_id, forecast_date));
create table if not exists public.wf_staff (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, location_id uuid not null, name text not null, mobile text, email text,
  status text not null default 'active', pos_user_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.xero_connections (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, tenant_id text not null, tenant_name text,
  access_token text not null default 'x', refresh_token text not null default 'x', expires_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.ezcater_order_links (
  ref text primary key, location_id text not null, ez_order_id text not null, event_at timestamptz, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint,
  allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  created_at timestamptz default now(), metadata jsonb);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to authenticated, anon, service_role;
grant select, insert on storage.objects to authenticated;
grant all on storage.objects, storage.buckets to service_role;
`;

// -- the JS model of nextDelivery (contract 2.3), used to check the SQL twin -----------------------------
const DAY = 86400000;
const ymdToMs = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
const msToYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
const hmToMin = (hm) => (hm == null ? null : +hm.slice(0, 2) * 60 + +hm.slice(3, 5));
const pad = (n) => String(n).padStart(2, '0');
export function modelNextDelivery({ rules, exceptions = [], nowVenue }) {
  if (!rules || rules.length === 0) return null;
  const now = ymdToMs(nowVenue.ymd) / 60000 + hmToMin(nowVenue.hm);
  const exs = exceptions.map((x, k) => ({ ...x, k })).sort((a, b) => (a.from_day < b.from_day ? -1 : a.from_day > b.from_day ? 1
    : a.name < b.name ? -1 : a.name > b.name ? 1 : a.k - b.k));
  const cands = [];
  for (let k = 0; k <= 20; k++) {
    const dMs = ymdToMs(nowVenue.ymd) + k * DAY;
    const d = msToYmd(dMs);
    const dow = new Date(dMs).getUTCDay();
    for (const r of rules.filter((x) => x.delivery_dow === dow)) {
      const skip = exs.find((x) => x.kind === 'no_delivery' && x.from_day <= d && d <= x.to_day);
      const ins = exs.find((x) => x.kind === 'deliver_instead' && x.from_day <= d && d <= x.to_day);
      const shift = ins ? Math.round((ymdToMs(ins.deliver_on) - dMs) / DAY) : 0;
      const day = dMs + shift * DAY;
      const obDay = r.order_by_time == null ? day : dMs - (((dow - (r.order_by_dow ?? (dow + 6) % 7)) + 7) % 7) * DAY + shift * DAY;
      const ob = obDay / 60000 + (r.order_by_time == null ? 0 : hmToMin(r.order_by_time));
      if (ob > now || skip) cands.push({ orig: d, day: msToYmd(day), ob, skip: skip ? skip.name : null });
    }
  }
  cands.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.ob - b.ob || (a.orig < b.orig ? -1 : a.orig > b.orig ? 1 : 0)));
  const best = cands.find((c) => !c.skip && c.ob > now);
  if (!best) return null;
  const obMs = best.ob * 60000;
  const obIso = new Date(obMs).toISOString();
  const seen = new Set();
  const skipped = cands.filter((c) => c.skip && c.orig < best.day).filter((c) => { const key = `${c.orig}|${c.skip}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (a.orig < b.orig ? -1 : 1)).map((c) => ({ ymd: c.orig, name: c.skip }));
  return { deliveryYmd: best.day, deliveryDow: new Date(ymdToMs(best.day)).getUTCDay(), orderByYmd: obIso.slice(0, 10), orderByHm: obIso.slice(11, 16),
    orderByAt: `${obIso.slice(0, 10)}T${obIso.slice(11, 16)}`, minutesLeft: Math.round(best.ob - now), skipped };
}
const wall = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};

export async function drop3Sections(ctx) {
  const { c, ok, section, guarded, FILES, QUICK } = ctx;
  const SCALE = ctx.SCALE_SITES || (QUICK ? 10 : 50);
  const sql = (q, o) => c.sql(q, o);
  const num = (q, o) => c.num(q, o);
  const short = (x, n = 160) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);
  const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const tf = (v) => v === 't' || v === 'true' || v === true;
  const D3 = process.env.STOCKN_D3 || FILES.d3;
  const D3RB = process.env.STOCKN_D3_ROLLBACK || FILES.d3Rb;

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
    const cl = typeof key === 'string' ? CALLERS[key] : key;
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
  const callJ = (key, body) => { const r = asCaller(key, body); return { ...r, j: lastJson(r) }; };
  const outcome = (r) => (r.sqlstate ? r.sqlstate : r.status !== 0 ? `fail:${short(r.message, 80)}` : 'ok');
  const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  const canExec = (role, sig) => sql(`select has_function_privilege('${role}', to_regprocedure('${sig}'), 'execute')`) === 't';
  const FNS = () => Object.fromEntries(sql(`select p.oid::regprocedure::text || '=' || md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)
    .split('\n').filter(Boolean).map((l) => { const k = l.lastIndexOf('='); return [l.slice(0, k), l.slice(k + 1)]; }));
  const numbers = (loc) => sql(`select json_build_object(
      'items', (select json_agg(json_build_object('id', id, 'on_hand', on_hand, 'cost', current_cost) order by id) from inventory_items where location_id = '${loc}'),
      'ledger', (select json_build_object('n', count(*), 'q', sum(qty_base), 'v', sum(value_delta)) from stock_movements where location_id = '${loc}'),
      'counts', (select count(*) from stock_counts where location_id = '${loc}'),
      'orders', (select json_build_object('po', count(*), 'st', string_agg(status, ',' order by id)) from purchase_orders where location_id = '${loc}'),
      'transfers', (select count(*) from stock_transfers where location_id = '${loc}'), 'waste', (select count(*) from waste_events where location_id = '${loc}'))`);
  const allNumbers = () => [PROVO, LOC2, SOLO].map(numbers).join('|');
  const loginsMd5 = () => sql(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from user_profiles t`)
    + sql(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from user_locations t`);
  const menuMd5 = () => sql(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from menu_items t`);
  const onHandEqLedger = (loc) => num(`select count(*) from inventory_items i where i.location_id = '${loc}'
     and i.on_hand <> coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`) === 0;
  const ledgerGap = (loc) => num(`select coalesce(max(abs(coalesce((select sum(m.value_delta) from stock_movements m where m.inventory_item_id = i.id), 0)
     - i.on_hand * coalesce(i.current_cost, 0))), 0) from inventory_items i where i.location_id = '${loc}'`);
  const coOf = (item) => sql(`select company_ref from inventory_items where id = '${item}'`);
  const supCo = (sup) => sql(`select company_ref from suppliers where id = '${sup}'`);
  const today = (loc) => sql(`select public.stock_co__today('${loc}')`);
  const POUND = '\u00a3';
  // a DRAFT order as createOrdersFromBasket writes it (the SQL editor stands in for the browser insert)
  const mkPO = (loc, sup, lines, extra = '') => {
    const po = sql(`insert into purchase_orders (location_id, supplier_id, reference, status, subtotal ${extra ? ', ' + extra.split('=')[0] : ''})
      values ('${loc}', '${sup}', 'PO-T${Math.floor(Math.random() * 1e6)}', 'DRAFT', ${lines.reduce((s, l) => s + l.qty * l.price, 0)} ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`);
    lines.forEach((l, k) => sql(`insert into po_lines (location_id, po_id, inventory_item_id, supplier_product_id, description, qty_packs, pack_qty, inner_qty, inner_unit, unit_price, qty_received, sort_order)
      select '${loc}', '${po}', '${l.item}', ${l.sp ? `'${l.sp}'` : 'null'}, 'line', ${l.qty}, coalesce(sp.pack_qty, 1), coalesce(sp.inner_qty, 1), sp.inner_unit, ${l.price}, ${l.received ?? 0}, ${k}
        from (select 1) z left join supplier_products sp on sp.id = ${l.sp ? `'${l.sp}'` : 'null'}`));
    return po;
  };

  // ==========================================================================================================
  section(40, '40. Drop 3 as the SQL editor runs it, after 0a, revalue, 0b, Drop 1, the drainer and Drop 2');
  let applied = false;
  const PRE = 'n_d3_pre';
  const T0 = 'n_d3_after';
  let d3Text = '';
  let before = {};
  await guarded('drop 3 paste', () => {
    c.createFrom('n_d3_a', 'n_base');
    c.use('n_d3_a');
    for (const [f, name] of [[FILES.a, '0a'], [FILES.rv, 'its revalue file']]) {
      const r = c.paste(f);
      ok(r.status === 0, `${name} applies (${r.status ? short(r.stderr, 300) : `${r.ms} ms`})`);
    }
    c.sqlFile(join(here, 'live_discounts.sql'));
    c.psql({ input: BASKET_SETUP });
    for (const [f, name] of [[FILES.b, '0b'], [FILES.d1, 'Drop 1 (20261024a)']]) {
      const r = c.paste(f);
      ok(r.status === 0, `${name} applies (${r.status ? short(r.stderr, 300) : `${r.ms} ms`})`);
    }
    c.psql({ input: D2_SHAPE });
    const rd = c.paste(FILES.d);
    ok(rd.status === 0, `the drainer (20261023a) applies (${rd.status ? short(rd.stderr, 300) : `${rd.ms} ms`})`);
    c.psql({ input: D3_SHAPE });
    c.createFrom('n_d3_nod2', 'n_d3_a');
    const r2 = c.paste(FILES.d2);
    const last2 = (r2.sets[r2.sets.length - 1] || { rows: [] }).rows;
    ok(r2.status === 0 && last2.length > 0 && last2.every((w) => Number(w.replaced_functions) === 15), `Drop 2 (20261025a) applies; its check row says 15 bodies (${r2.status ? short(r2.stderr, 300) : `${r2.ms} ms`})`);
    c.createFrom(PRE, 'n_d3_a');
    c.use(PRE);
    // the Stock control levels the later sections use (as Drop 1 and 2 set them after 0a)
    sql(`update user_profiles set stock_control = 'sites_full' where id = '${U.mgrFull}'; update user_profiles set stock_control = 'all' where id in ('${U.mgrAll}', '${U.mgrAllPurch}');`);
    // the harness stand in of second_step_ok() is not the live text: the paste here pins the stand in's md5
    // in place of the live one (said so); every other pinned body is the live text exactly
    const standIn = md5Of('public.second_step_ok()');
    const raw = readFileSync(D3, 'utf8');
    ok(raw.includes(LIVE_SECOND_STEP_MD5), `the file pins second_step_ok() at its live md5 (${LIVE_SECOND_STEP_MD5}); the harness pastes it with the stand in's md5 (${standIn})`);
    d3Text = raw.replace(LIVE_SECOND_STEP_MD5, standIn);
    const bad = D3_BODIES.filter(([s, m]) => s !== 'public.second_step_ok()' && md5Of(s) !== m);
    ok(D3_BODIES.length === 33 && bad.length === 0, `the 33 pinned bodies equal the harness bodies built from the repo files (${bad.map(([s]) => s).join(', ') || 'all'})`);
  });

  await guarded('refusals', () => {
    for (const [db, prep, want, label] of [
      ['n_d3_r1', 'n_d3_nod2', /Run 20261025a_OPS_stock_native_2\.sql first\. Nothing was changed\./, 'without Drop 2'],
      ['n_d3_r2', PRE, /A stock function changed since this file was written/, 'with a changed body'],
      ['n_d3_r3', PRE, /This file is for the Ops database only\. Nothing was changed\./, 'off Ops'],
    ]) {
      c.createFrom(db, prep);
      c.use(db);
      if (label === 'with a changed body') sql(`create or replace function public.stock_level(p_uid uuid, p_org uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$ select 'all'::text $$`);
      if (label === 'off Ops') sql(`create table public.billing_state (id int)`);
      const fnB = FNS();
      const r = c.paste(null, { input: d3Text });
      ok(r.status !== 0 && want.test(r.stderr) && JSON.stringify(FNS()) === JSON.stringify(fnB) && sql(`select to_regclass('public.stock_po_approvals') is null`) === 't',
        `${label}: refused in words and nothing changed (${short(r.error, 120)})`);
    }
  });

  let checkRow = [];
  await guarded('the paste', () => {
    c.use(PRE);
    before = { numbers: allNumbers(), menu: menuMd5(), fns: FNS(), logins: loginsMd5() };
    ok(sql(`select to_regclass('public.stock_targets') is null and to_regprocedure('public.stock_report_value(uuid,uuid[],date,date)') is null`) === 't'
       && !/stock_targets|stock_report_|report_export/.test(d3Text), 'Drop 4a (20261026a) is not here and the file never names it');
    c.createFrom('n_d3_paste', PRE);
    c.use('n_d3_paste');
    const r = c.paste(null, { input: d3Text });
    ok(r.status === 0, `Drop 3 applies as one paste (${r.status ? short(r.stderr, 900) : `${r.ms} ms`})`);
    if (r.status !== 0) return;
    applied = true;
    const last = r.sets[r.sets.length - 1] || { cols: [], rows: [] };
    checkRow = last.rows;
    const want = ['org_id', 'multi', 'replaced_functions', 'new_functions', 'new_tables', 'new_columns', 'transfer_status_check', 'approval_guard',
      'invoice_lock_guard', 'recipe_policies', 'cron_jobs', 'vault_keys', 'bucket', 'internals_open_to_api', 'anon_can_save', 'site_kinds',
      'internal_suppliers', 'approvals', 'notify_rows', 'send_jobs', 'site_rows_changed', 'orders_changed', 'menu_rows_changed', 'logins_changed'];
    ok(JSON.stringify(last.cols) === JSON.stringify(want), `the check row has contract 1.9's columns in order (${last.cols.join(',')})`);
    for (const row of last.rows) console.log(`     ${short(row, 900)}`);
    ok(last.rows.some((w) => w.org_id === ORG_T && tf(w.multi)) && last.rows.some((w) => w.org_id === ORG_S && !tf(w.multi)),
      'one row per company that holds stock: the two site company multi, the one site company not');
    ok(last.rows.every((w) => Number(w.replaced_functions) === 10 && Number(w.new_functions) === 66 && Number(w.new_tables) === 25 && Number(w.new_columns) === 41
      && tf(w.transfer_status_check) && tf(w.approval_guard) && tf(w.invoice_lock_guard) && tf(w.recipe_policies) && Number(w.cron_jobs) === 2
      && Number(w.vault_keys) === 2 && tf(w.bucket) && !tf(w.internals_open_to_api) && !tf(w.anon_can_save) && Number(w.site_kinds) === 0
      && Number(w.internal_suppliers) === 0 && Number(w.approvals) === 0 && Number(w.notify_rows) === 0 && Number(w.send_jobs) === 0
      && Number(w.site_rows_changed) === 0 && !tf(w.orders_changed) && !tf(w.menu_rows_changed) && !tf(w.logins_changed)),
      'every row: 10 replaced, 66 new, 25 tables, 41 columns, the CHECK, both guards, the recipe rules, 2 cron jobs, 2 keys, the bucket, internals closed, anon cannot save, nothing made, nothing changed');
    ok(allNumbers() === before.numbers, 'no on hand, cost, ledger, count, order, transfer or waste number moved');
    ok(menuMd5() === before.menu && loginsMd5() === before.logins, 'no menu row and no login row was written');
    const fnA = FNS();
    const changed = Object.keys(before.fns).filter((k) => fnA[k] !== before.fns[k]).map((k) => k.slice(0, k.indexOf('(')));
    ok(changed.every((k) => D3_REPLACED.includes(k)) && D3_REPLACED.every((k) => changed.includes(k)),
      `only the 10 named bodies changed among functions earlier files made (${changed.filter((k) => !D3_REPLACED.includes(k)).join(', ') || 'none other'})`);
    ok(num(`select count(*) from stock_native_backup where left(name, 3) = 'd3:'`) === 10, 'the 10 bodies are backed up as d3: rows');
    const again = c.paste(null, { input: d3Text });
    ok(again.status !== 0 && /Drop 3 has run already\. Nothing was changed\./.test(again.stderr), `a second paste refuses (${short(again.error, 80)})`);
    c.createFrom(T0, 'n_d3_paste');
  });
  if (!applied) return;
  const fresh = (name) => { c.createFrom(name, T0); c.use(name); };

  // ==========================================================================================================
  section(41, '41. What Drop 3 made: tables, read rules, fences, columns, the CHECK swap, triggers, cron, vault, bucket, functions and grants');
  await guarded('what it made', () => {
    c.use(T0);
    for (const [t, w] of Object.entries(D3_TABLES)) {
      const want = w.g || { authenticated: 'SELECT', service_role: 'SELECT' };
      const got = Object.fromEntries(sql(`select grantee || '=' || string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = '${t}' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') group by grantee order by grantee`)
        .split('\n').filter(Boolean).map((l) => l.split('=')));
      const pol = sql(`select coalesce(string_agg(policyname || ':' || permissive || ':' || cmd, ',' order by policyname), '') from pg_policies where schemaname = 'public' and tablename = '${t}'`);
      const rls = sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`) === 't';
      ok(rls && JSON.stringify(got) === JSON.stringify(want), `${t}: row level security on, grants exactly ${short(want, 100)} (${short(got, 100)})`);
      ok(/second_step_fence:RESTRICTIVE:ALL/.test(pol) && (w.read ? pol.includes(`${t}_read:PERMISSIVE:SELECT`) : !/PERMISSIVE/.test(pol))
         && !/PERMISSIVE:(INSERT|UPDATE|DELETE|ALL)/.test(pol), `${t}: the read rule, the second step fence and no write policy (${pol})`);
    }
    ok(num(`select count(*) from information_schema.columns c where c.table_schema = 'public' and c.column_name in ('reason', 'reason_note', 'edited_by',
         'edited_by_name', 'edited_at') and c.table_name = 'wf_sales_forecast'`) === 5
       && num(`select count(*) from pg_description d join pg_attribute a on a.attrelid = d.objoid and a.attnum = d.objsubid
                where d.description like '%20261027a%' and d.objsubid > 0`) === 41, 'the 41 new columns, each with a comment naming 20261027a');
    ok(/'REQUESTED'.*'DISPUTED'/.test(sql(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_transfers_status_chk'`)),
      'the transfer status CHECK holds the seven values');
    ok(num(`select count(*) from pg_trigger where not tgisinternal and tgname in ('purchase_orders_approval_guard', 'supplier_invoices_lock_guard')`) === 3
       && num(`select count(*) from pg_trigger where not tgisinternal and tgname = 'stock_co_d3_org_guard'`) === 13
       && sql(`select string_agg(g.tgname, ',' order by g.tgname) from pg_trigger g where g.tgrelid = 'public.purchase_orders'::regclass and not g.tgisinternal`) === 'purchase_orders_approval_guard,purchase_orders_send_rule'
       && num(`select count(*) from pg_trigger g where g.tgrelid = 'public.stock_counts'::regclass and g.tgname = 'stock_counts_approval_fence' and not g.tgisinternal`) === 1,
      'the approval guard and the send rule (the only triggers on purchase_orders), the count approval fence, the lock guard on invoices and their lines, the company guard on 13 tables');
    ok(sql(`select string_agg(jobname || '=' || command, ',' order by jobname) from cron.job where jobname in ('stock-notify', 'po-cutoff-run')`)
       === 'po-cutoff-run=select public.stock_po_cutoff_run();,stock-notify=select public.stock_notify_due();'
       && num(`select count(*) from vault.secrets where name in ('stock_notify_cron_key', 'po_cutoff_cron_key') and length(secret) >= 32`) === 2,
      'the two cron jobs every minute and their two vault keys');
    const objPol = sql(`select string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') || coalesce(with_check, ''), ' | ' order by policyname) from pg_policies where schemaname = 'storage' and tablename = 'objects'`);
    ok(/stock_invoice_inbox_files_add:INSERT:.*foldername\(name\)/.test(objPol) && /stock_invoice_inbox_files_read:SELECT:.*foldername\(name\)/.test(objPol)
       && !/stock_invoice_inbox_files.*:(UPDATE|DELETE)/.test(objPol) && sql(`select public from storage.buckets where id = 'stock-invoice-inbox'`) === 'f',
      'the private inbox bucket: read and add policies on objects.name, no update or delete policy');
    const fns = sql(`select string_agg(p.oid::regprocedure::text, '|' order by 1) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in (select unnest(regexp_split_to_array(${lit(d3Text.match(/p\.proname in \(\n([\s\S]*?)\n\s*\)\)::integer as new_functions/)[1].replace(/[\s']/g, ''))}, ',')))`).split('|');
    ok(fns.length === 66, `66 new public functions (${fns.length})`);
    const bad = [];
    for (const sig of fns) {
      const name = sig.slice(0, sig.indexOf('('));
      const def = pj(sql(`select json_build_object('definer', prosecdef, 'path', array_to_string(proconfig, ',')) from pg_proc where oid = to_regprocedure('public.${sig}')`));
      const want = ANON.includes(name) ? ['anon', 'authenticated', 'service_role'] : BOTH.includes(name) ? AS : SERVICE.includes(name) ? ['service_role'] : NONE.includes(name) ? [] : ['authenticated'];
      const got = ['anon', 'authenticated', 'service_role'].filter((r) => canExec(r, `public.${sig}`));
      const path = /cron_ok$/.test(name) ? /search_path=""/.test(def.path) : /search_path=public, pg_temp/.test(def.path);
      if (!(def.definer && path && JSON.stringify(got) === JSON.stringify(want) && !canExec('public', `public.${sig}`))) bad.push(`${name}: ${got.join('/')} ${def.path}`);
    }
    ok(bad.length === 0, `every new function: definer, its search path, EXECUTE exactly as contract 1.6 (${bad.join('; ') || 'all 66'})`);
    const open = sql(`select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p where p.pronamespace = 'public'::regnamespace
        and left(p.proname, 10) = 'stock_co__' and p.proname not in ('stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock',
        'stock_co__hidden_recipes', 'stock_co__secret_ok')
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))`);
    ok(open === '', `every stock_co__ helper is closed to the API (${open || 'none open'})`);
    for (const [label, body] of [
      ['order pad', `select public.stock_order_pad_context('${PROVO}')`], ['submit', `select public.stock_po_submit('${id('99000000', 1)}')`],
      ['due to order', `select public.stock_due_to_order('${ORG_T}', null)`], ['save budget', `select public.stock_save_budget('{}'::jsonb)`],
      ['request a transfer', `select public.stock_request_transfer('${PROVO}', '${LOC2}', '[]'::jsonb)`], ['kitchen pick', `select public.stock_kitchen_pick('${id('99000000', 1)}', '[]'::jsonb)`]]) {
      const r = asCaller('anonKey', body, { commit: false });
      ok(r.sqlstate === '42501', `the bare anon key is refused: ${label} (${outcome(r)})`);
    }
    const wr = asCaller('anonKey', `select public.stock_waste_reasons('${PROVO}')`, { commit: false });
    const wt = callJ('tillProvo', `select public.stock_waste_reasons('${PROVO}')`);
    ok(wr.sqlstate === '42501' && /Sign in to log waste\./.test(wr.message) && wt.j && wt.j.reasons === null && 'pin_over' in wt.j,
      `the waste reasons: the bare anon key is refused in words, a till bound to the venue reads them (${short(wt.j, 100)})`);
  });

  // ==========================================================================================================
  section(42, '42. stock_co__next_delivery equals nextDelivery on 2,000 random rule sets, exceptions and venue clocks');
  await guarded('next delivery twin', () => {
    fresh('n_d3_nd');
    const r = rng(ctx.SEED || 7);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const ORG_P = id('0e000000', 'e1');
    const TZ = ['Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
    const LOCS = TZ.map((_, k) => id('e1000000', `e1${k}`));
    sql(`insert into organisations (id, name) values ('${ORG_P}', 'Clock test company') on conflict do nothing;
         ${TZ.map((tz, k) => `insert into locations (id, org_id, name, timezone, currency, status) values ('${LOCS[k]}', '${ORG_P}', 'Clock ${k}', '${tz}', 'GBP', 'active');`).join('\n')}`);
    const N = 2000;
    const cases = [];
    const T0ms = Date.UTC(2026, 9, 20);
    const changes = [Date.UTC(2026, 9, 25, 1, 0), Date.UTC(2026, 10, 1, 6, 0), Date.UTC(2026, 10, 1, 9, 0)];
    const stmts = [];
    for (let k = 0; k < N; k++) {
      const loc = k % 4;
      const nowMs = r() < 0.5 ? pick(changes) + Math.round((r() - 0.5) * 6 * 3600000 / 60000) * 60000 : T0ms + Math.floor(r() * 20 * DAY / 60000) * 60000;
      const dows = [...new Set(Array.from({ length: 1 + Math.floor(r() * 4) }, () => Math.floor(r() * 7)))];
      const noCut = r() < 0.25;
      const rules = dows.map((d) => (noCut ? { delivery_dow: d, order_by_dow: null, order_by_time: null }
        : { delivery_dow: d, order_by_dow: (d + 7 - (r() < 0.15 ? 0 : 1 + Math.floor(r() * 3) % 3)) % 7, order_by_time: `${pad(Math.floor(r() * 24))}:${pad(5 * Math.floor(r() * 12))}` }));
      const nowV = wall(nowMs, TZ[loc]);
      const exceptions = [];
      const nEx = r() < 0.5 ? 0 : 1 + Math.floor(r() * 2);
      for (let e = 0; e < nEx; e++) {
        const from = msToYmd(ymdToMs(nowV.ymd) + Math.floor(r() * 20) * DAY);
        const to = msToYmd(ymdToMs(from) + Math.floor(r() * 3) * DAY);
        const kind = r() < 0.6 ? 'no_delivery' : 'deliver_instead';
        exceptions.push({ name: `Ex ${k}.${e}`, from_day: from, to_day: to, kind, deliver_on: kind === 'deliver_instead' ? msToYmd(ymdToMs(to) + (1 + Math.floor(r() * 3)) * DAY) : null });
      }
      cases.push({ k, loc, nowMs, rules, exceptions, nowV, tz: TZ[loc] });
      const cs = id('e2000000', k + 1); const s = id('e3000000', k + 1);
      stmts.push(`insert into stock_co_suppliers (id, org_id, name) values ('${cs}', '${ORG_P}', 'Clock co ${k}');
        insert into suppliers (id, location_id, org_id, name, company_ref) values ('${s}', '${LOCS[loc]}', '${ORG_P}', 'Clock ${k}', '${cs}');
        ${rules.map((x) => `insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time) values ('${ORG_P}', '${LOCS[loc]}', '${s}', '${cs}', ${x.delivery_dow}, ${x.order_by_dow ?? 'null'}, ${x.order_by_time ? `'${x.order_by_time}'` : 'null'});`).join('\n')}
        ${exceptions.map((x, e) => `insert into stock_delivery_exceptions (org_id, scope, company_supplier_id, name, from_day, to_day, kind, deliver_on, created_at) values ('${ORG_P}', 'supplier', '${cs}', ${lit(x.name)}, '${x.from_day}', '${x.to_day}', '${x.kind}', ${x.deliver_on ? `'${x.deliver_on}'` : 'null'}, now() + interval '${e} second');`).join('\n')}`);
    }
    for (let k = 0; k < stmts.length; k += 200) sql(stmts.slice(k, k + 200).join('\n'));
    const out = sql(`select string_agg(coalesce(public.stock_co__next_delivery(s.id, to_timestamp(v.ms / 1000.0))::text, 'null'), E'\\n' order by v.k)
                       from (values ${cases.map((x) => `(${x.k}, '${id('e3000000', x.k + 1)}'::uuid, ${x.nowMs})`).join(',')}) v(k, sid, ms) join suppliers s on s.id = v.sid`).split('\n');
    let bad = 0; let badPR = 0; let checkedPR = 0;
    const hasPR = typeof PR.nextDelivery === 'function';
    cases.forEach((x, k) => {
      const want = modelNextDelivery({ rules: x.rules, exceptions: x.exceptions, nowVenue: x.nowV });
      const got = pj(out[k]);
      const same = (want === null && got === null) || (want && got && got.delivery_day === want.deliveryYmd && got.order_by_ymd === want.orderByYmd
        && got.order_by_hm === want.orderByHm && Number(got.minutes_left) === want.minutesLeft
        && JSON.stringify((got.skipped || []).map((s) => ({ ymd: s.day, name: s.name }))) === JSON.stringify(want.skipped)
        && wall(Date.parse(got.order_by_at), x.tz).hm === want.orderByHm);
      if (!same) { bad++; if (bad <= 3) console.log(`     case ${k} (${x.tz} now ${x.nowV.ymd} ${x.nowV.hm}) rules ${short(x.rules, 200)} ex ${short(x.exceptions, 200)}\n       sql ${short(got, 300)}\n       js  ${short(want, 300)}`); }
      if (hasPR) {
        checkedPR++;
        const pr = PR.nextDelivery({ rules: x.rules, exceptions: x.exceptions, nowVenue: x.nowV });
        // the same moment: purchasingRules.js says a no cut off order by as 24:00 on the day before, the SQL as 00:00 on the delivery
        // day (orderByAt is the same in both; the integrator is told)
        const samePR = (pr == null && want == null) || (pr && want && pr.deliveryYmd === want.deliveryYmd && pr.orderByAt === want.orderByAt
          && pr.minutesLeft === want.minutesLeft && JSON.stringify((pr.skipped || []).map((s) => ({ ymd: s.ymd, name: s.name }))) === JSON.stringify(want.skipped));
        if (!samePR) { badPR++; if (badPR <= 2) console.log(`     purchasingRules case ${k}: ${short(pr, 200)} vs ${short(want, 200)}`); }
      }
    });
    ok(bad === 0, `stock_co__next_delivery equals the contract 2.3 rule on ${N} random rule sets, exceptions and venue clocks around 25 Oct (UK) and 1 Nov (US) (${bad} differ, seed ${ctx.SEED})`);
    if (hasPR) ok(badPR === 0, `purchasingRules.js nextDelivery gives the same answer on all ${checkedPR} (${badPR} differ)`);
    else console.log('     note: purchasingRules.js has no nextDelivery yet (web-purchasing builds it); the integrator re-runs this section after the merge');
    // one minute after the cut off asks for the following delivery; no cut off means midnight the day before
    const s1 = id('e3000000', 99001); const cs1 = id('e2000000', 99001);
    sql(`insert into stock_co_suppliers (id, org_id, name) values ('${cs1}', '${ORG_P}', 'Cut off test');
         insert into suppliers (id, location_id, org_id, name, company_ref) values ('${s1}', '${LOCS[0]}', '${ORG_P}', 'Cut off test', '${cs1}');
         insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
         values ('${ORG_P}', '${LOCS[0]}', '${s1}', '${cs1}', 3, 2, '14:00'), ('${ORG_P}', '${LOCS[0]}', '${s1}', '${cs1}', 6, null, null);`);
    const at = (iso) => pj(sql(`select public.stock_co__next_delivery('${s1}', '${iso}'::timestamptz)`));
    const a1 = at('2026-11-03T13:59:00Z'); const a2 = at('2026-11-03T14:01:00Z'); const a3 = at('2026-11-06T23:59:00Z'); const a4 = at('2026-11-07T00:00:00Z');
    ok(a1.delivery_day === '2026-11-04' && a1.minutes_left === 1 && a2.delivery_day === '2026-11-07' && a2.order_by_ymd === '2026-11-07' && a2.order_by_hm === '00:00',
      `one minute before the Tue 14:00 cut off it is Wed; one minute after it asks for the next delivery (Sat, no cut off: by midnight Fri) (${a1.delivery_day}, ${a2.delivery_day} by ${a2.order_by_ymd} ${a2.order_by_hm})`);
    ok(a3.delivery_day === '2026-11-07' && a3.minutes_left === 1 && a4.delivery_day === '2026-11-11', `a supplier with no cut off is ordered by midnight the day before (${a3.delivery_day} with ${a3.minutes_left} min, then ${a4.delivery_day})`);
  });

  // ==========================================================================================================
  section(43, '43. Orders and approvals with real roles; the runner; the maximum; the fee; many sites; one site; Stock control levels');
  await guarded('orders and approvals', () => {
    fresh('n_d3_po');
    const dairyCo = supCo(SUP.pDairy);
    sql(`update suppliers set approval_limit = 50, delivery_fee = 12.50, min_order_value = 100 where id = '${SUP.pDairy}';
         update stock_co_suppliers set max_order_value = 800, fee_waived_over_min = true where id = '${dairyCo}';`);
    const butter = (qty) => [{ item: I.pButter, sp: SP.pButter, qty, price: 30 }];
    // under the limit: send, the fee charged under the minimum, the price when ordered, the next delivery day
    const p1 = mkPO(PROVO, SUP.pDairy, butter(1));
    const s1 = callJ('mgrProvo', `select public.stock_po_submit('${p1}', 'purchasing')`);
    const nd = pj(sql(`select public.stock_co__next_delivery('${SUP.pDairy}')`));
    ok(s1.j && s1.j.send === true && !s1.j.needs_approval, `under the limit (30 + 12.50 fee): send (${short(s1.j || s1.message, 120)})`);
    ok(sql(`select delivery_fee || ':' || expected_date from purchase_orders where id = '${p1}'`) === `12.50:${nd.delivery_day}`
       && Number(sql(`select ordered_unit_price from po_lines where po_id = '${p1}'`)) === 30, `the fee is on the order (not in subtotal), the price when ordered is kept, delivery ${nd.delivery_day}`);
    // over the limit: an approval waits; the fee waived over the minimum
    const p2 = mkPO(PROVO, SUP.pDairy, butter(4));
    const s2 = callJ('mgrProvo', `select public.stock_po_submit('${p2}', 'purchasing')`);
    ok(s2.j && s2.j.needs_approval === true && Number(s2.j.amount) === 120 && Number(s2.j.limit) === 50 && Array.isArray(s2.j.approvers) && s2.j.approvers.length > 0,
      `over the limit: needs approval, 120 against 50, approvers named (${short(s2.j || s2.message, 160)})`);
    ok(sql(`select coalesce(delivery_fee::text, 'none') from purchase_orders where id = '${p2}'`) === 'none'
       && sql(`select status || ':' || step || ':' || raised_by from stock_po_approvals where po_id = '${p2}'`) === `waiting:0:${U.mgrProvo}`
       && num(`select count(*) from stock_notify_sent where kind = 'approval_wait' and ref = '${p2}'`) === 1, 'no delivery fee over the minimum (waived); the approval waits at step 0 with the raiser; one approval_wait alert');
    const g1 = asCaller('mgrProvo', `update purchase_orders set status = 'SENT' where id = '${p2}'`);
    const g2 = asCaller('service', `update purchase_orders set status = 'SENT' where id = '${p2}'`);
    ok(g1.sqlstate === '55000' && /This order is waiting for approval\./.test(g1.message) && g2.sqlstate === '55000',
      `the guard refuses a direct update to SENT from the site and from po-send (${outcome(g1)}, ${outcome(g2)})`);
    const d1 = asCaller('mgrProvo', `select public.stock_po_decide('${p2}', 'approve')`);
    ok(d1.sqlstate === '42501' && /You raised this order\. Another manager approves it\./.test(d1.message), `the raiser cannot approve (${outcome(d1)})`);
    const d2 = callJ('mgrLoc2', `select public.stock_po_decide('${p2}', 'approve')`);
    ok(d2.sqlstate === '42501', `a manager of another site cannot approve (${outcome(d2)})`);
    const d3 = callJ('areaMgr', `select public.stock_po_decide('${p2}', 'approve')`);
    ok(d3.j && d3.j.send === true && sql(`select status || ':' || decided_by_name from stock_po_approvals where po_id = '${p2}'`).startsWith('approved:'),
      `another manager of that site approves: send (${short(d3.j || d3.message, 100)})`);
    // the server sends it too: a send job waits two minutes for the screen's own email, and if that email
    // failed (the order is still DRAFT) po-cutoff-run sends it; an approval never costs the delivery
    ok(sql(`select j.why || ':' || j.status || ':' || (j.not_before > now() + interval '90 seconds') || ':' || po.status
              from stock_po_send_jobs j join purchase_orders po on po.id = j.po_id where j.po_id = '${p2}'`) === 'approved:waiting:true:DRAFT',
      'approve writes a send job (approved, waiting, not before two minutes) in the same transaction; the order is still DRAFT');
    sql(`update stock_po_send_jobs set not_before = now() - interval '1 second' where po_id = '${p2}'`);
    ok(sql(`select (public.stock_po_cutoff_run() is not null)::text`) === 'true', 'the email failed and the tab closed: at its time the runner calls po-cutoff-run to send it');
    // the send rule: an approved order that now costs more than was approved cannot be marked sent
    sql(`update po_lines set qty_packs = 5 where po_id = '${p2}'`);
    const up = asCaller('service', `update purchase_orders set status = 'SENT', ordered_at = now() where id = '${p2}'`);
    ok(up.sqlstate === '55000' && /This order needs approval\. Submit it again\./.test(up.message), `more than was approved: refused (${outcome(up)})`);
    sql(`update po_lines set qty_packs = 4 where po_id = '${p2}'`);
    ok(asCaller('service', `update purchase_orders set status = 'SENT', ordered_at = now() where id = '${p2}'`).status === 0, 'po-send can mark it sent after the approval');
    // the limit holds for every caller, not only stock_po_submit: an order over the limit never submitted
    // cannot be marked sent from the site or by po-send; po-send's rule raises the approval instead
    const p5 = mkPO(PROVO, SUP.pDairy, butter(4));
    const h1 = asCaller('mgrProvo', `update purchase_orders set status = 'SENT' where id = '${p5}'`);
    const h2 = asCaller('service', `update purchase_orders set status = 'SENT' where id = '${p5}'`);
    ok(h1.sqlstate === '55000' && /over the approval limit/.test(h1.message) && h2.sqlstate === '55000' && sql(`select status from purchase_orders where id = '${p5}'`) === 'DRAFT',
      `a direct update to SENT over the limit is refused for the site and for po-send (${outcome(h1)}, ${outcome(h2)})`);
    const ps5 = callJ('service', `select public.stock_po_submit('${p5}', 'purchasing', ${jlit({ location_id: PROVO, uid: U.mgrProvo, name: 'Back Office' })})`);
    ok(ps5.j && ps5.j.needs_approval === true && sql(`select status || ':' || raised_by from stock_po_approvals where po_id = '${p5}'`) === `waiting:${U.mgrProvo}`,
      `po-send's rule (stock_po_submit as the service role) raises the approval with the asker and sends nothing (${short(ps5.j || ps5.message, 100)})`);
    const p6 = mkPO(PROVO, SUP.pDairy, butter(1));
    ok(asCaller('mgrProvo', `update purchase_orders set status = 'SENT' where id = '${p6}'`).status === 0, 'under the limit a site still marks an order sent as today');
    // an order raised on the phone with a PIN: the PIN holder's login cannot approve it in Back Office
    const staffP = sql(`select id from staff_members where location_id = '${PROVO}' order by id limit 1`);
    sql(`update staff_members set auth_user_id = '${U.mgrProvo}' where id = '${staffP}'`);
    const p7 = mkPO(PROVO, SUP.pDairy, butter(4));
    const ph = callJ('service', `select public.stock_po_submit('${p7}', 'purchasing', ${jlit({ location_id: PROVO, uid: null, name: 'Duty Manager', staff_id: staffP })})`);
    ok(ph.j && ph.j.needs_approval && sql(`select coalesce(raised_by::text, 'none') || ':' || raised_by_staff_id from stock_po_approvals where po_id = '${p7}'`) === `none:${staffP}`,
      'a PIN on a shared phone: the approval keeps the PIN holder\'s staff row');
    const self = asCaller('mgrProvo', `select public.stock_po_decide('${p7}', 'approve')`);
    const pageSelf = callJ('mgrProvo', `select public.stock_orders_page('${ORG_T}', null, 'DRAFT')`).j;
    const rowSelf = pageSelf && pageSelf.rows.find((x) => x.id === p7);
    ok(self.sqlstate === '42501' && /You raised this order\. Another manager approves it\./.test(self.message) && rowSelf && rowSelf.approval.can_decide === false,
      `the raiser by PIN cannot approve it from their Back Office login, nor is offered Approve (${outcome(self)})`);
    const other = callJ('areaMgr', `select public.stock_po_decide('${p7}', 'approve')`);
    ok(other.j && other.j.send === true, 'another manager of that site approves it');
    const p3 = mkPO(PROVO, SUP.pDairy, butter(3));
    callJ('mgrProvo', `select public.stock_po_submit('${p3}')`);
    const d4 = callJ('mgrAll', `select public.stock_po_decide('${p3}', 'send_back', 'Too much butter')`);
    ok(d4.j && d4.j.status === 'sent_back' && sql(`select status from purchase_orders where id = '${p3}'`) === 'DRAFT'
       && asCaller('mgrProvo', `update purchase_orders set status = 'SENT' where id = '${p3}'`).sqlstate === '55000',
      'a company editor (Stock control all) sends it back: the order stays DRAFT for the raiser and cannot be sent');
    const re = callJ('mgrProvo', `select public.stock_po_submit('${p3}')`);
    ok(re.j && re.j.needs_approval && sql(`select status || ':' || step from stock_po_approvals where po_id = '${p3}'`) === 'waiting:0', 'the raiser changes it and submits again: waiting at step 0');
    const sa1 = asCaller('mgrAll', `select public.stock_po_decide('${p3}', 'send_anyway')`);
    sql(`update stock_po_approvals set step = 2 where po_id = '${p3}'`);
    const sa2 = asCaller('areaMgr', `select public.stock_po_decide('${p3}', 'send_anyway')`);
    const sa3 = callJ('mgrAll', `select public.stock_po_decide('${p3}', 'send_anyway')`);
    ok(sa1.sqlstate === '42501' && /Send anyway is for head office, 30 minutes before the order by time\./.test(sa1.message) && sa2.sqlstate === '42501'
       && sa3.j && sa3.j.send === true, `send anyway: refused before step 2 and for a site manager, allowed for head office at step 2 (${outcome(sa1)}, ${outcome(sa2)}, ${short(sa3.j, 60)})`);
    const p4 = mkPO(PROVO, SUP.pDairy, butter(2));
    callJ('mgrProvo', `select public.stock_po_submit('${p4}')`);
    const cx = callJ('mgrProvo', `select public.stock_po_decide('${p4}', 'cancel')`);
    ok(cx.j && cx.j.status === 'cancelled' && sql(`select status from purchase_orders where id = '${p4}'`) === 'CANCELLED', 'the raiser cancels: the order is CANCELLED');
    ok(num(`select count(*) from stock_change_log where entity = 'po_approval'`) >= 4, 'every decision is in the change log');
    // the runner: 60 and 30 minutes, then sent unapproved at the order by time (or missed with the setting off)
    const mk = (mins) => { const p = mkPO(PROVO, SUP.pDairy, butter(3)); callJ('mgrProvo', `select public.stock_po_submit('${p}')`);
      sql(`update stock_po_approvals set order_by_at = now() + interval '${mins} minutes' where po_id = '${p}'`); return p; };
    const r60 = mk(50); const r30 = mk(20); const r0 = mk(-1);
    sql(`update stock_po_approvals set step = 1 where po_id = '${r30}'`);
    const calls0 = num(`select count(*) from net.calls where url like '%po-cutoff-run'`);
    sql(`select public.stock_po_cutoff_run()`);
    ok(sql(`select step from stock_po_approvals where po_id = '${r60}'`) === '1' && num(`select count(*) from stock_notify_sent where kind = 'approval_60' and ref = '${r60}'`) === 1,
      'at 60 minutes the approval is passed up (step 1, alert approval_60)');
    ok(sql(`select step from stock_po_approvals where po_id = '${r30}'`) === '2' && num(`select count(*) from stock_notify_sent where kind = 'approval_30' and ref = '${r30}'`) === 1,
      'at 30 minutes head office is alerted (step 2, alert approval_30)');
    ok(sql(`select a.status || ':' || (po.sent_unapproved_at is not null) || ':' || j.why from stock_po_approvals a join purchase_orders po on po.id = a.po_id
             join stock_po_send_jobs j on j.po_id = a.po_id where a.po_id = '${r0}'`) === 'sent_unapproved:true:sent_unapproved'
       && num(`select count(*) from stock_notify_sent where kind = 'sent_unapproved' and ref = '${r0}'`) === 1
       && num(`select count(*) from net.calls where url like '%po-cutoff-run'`) === calls0 + 1,
      'at the order by time it goes as sent unapproved: stamped, a send job, an alert, and po-cutoff-run is called');
    sql(`update stock_co_settings set send_unapproved_at_cutoff = false where org_id = '${ORG_T}'`);
    const rm = mk(-1);
    sql(`select public.stock_po_cutoff_run()`);
    ok(sql(`select status from stock_po_approvals where po_id = '${rm}'`) === 'missed' && num(`select count(*) from stock_po_send_jobs where po_id = '${rm}'`) === 0,
      'with the company setting off it is marked missed and never sent');
    sql(`select public.stock_po_cutoff_run()`);
    ok(num(`select count(*) from stock_notify_sent where ref in ('${r60}', '${r30}', '${r0}')`) === 6, 'a second runner call stages nothing twice (3 waits, the 60, the 30 and the sent unapproved)');
    // the maximum
    const pm = mkPO(PROVO, SUP.pDairy, butter(30));
    const mx = asCaller('mgrProvo', `select public.stock_po_submit('${pm}')`);
    ok(mx.sqlstate === '22023' && mx.message.includes(`Over the maximum ${POUND}800 for `) && /Split the order or ask head office\./.test(mx.message), `over the maximum is refused (${short(mx.message, 120)})`);
    // orders for many sites
    const many = (orders, who = 'ownerT') => callJ(who, `select public.stock_create_orders_many('${ORG_T}', ${jlit(orders)})`);
    const bad = many([{ location_id: PROVO, supplier_id: SUP.pDairy, lines: [{ inventory_item_id: I.pButter, supplier_product_id: SP.pButter, qty_packs: 1 }] },
      { location_id: LOC2, supplier_id: SUP.lDairy, lines: [{ inventory_item_id: I.pButter, qty_packs: 1 }] }]);
    ok(bad.sqlstate === '22023' && /Line 1: that item is not at Location 2\./.test(bad.message), `an item of another site is refused in words (${short(bad.message, 100)})`);
    const good = many([{ location_id: PROVO, supplier_id: SUP.pDairy, lines: [{ inventory_item_id: I.pButter, supplier_product_id: SP.pButter, qty_packs: 1 }] },
      { location_id: LOC2, supplier_id: SUP.lDairy, lines: [{ inventory_item_id: I.lButter, supplier_product_id: SP.lButter, qty_packs: 1 }] }]);
    ok(good.j && good.j.orders.length === 2 && good.j.orders.every((o) => o.po_id && !o.error) && good.j.orders.some((o) => o.send),
      `head office orders for two sites in one call (${short(good.j && good.j.orders.map((o) => [o.send, o.needs_approval, o.error]), 120)})`);
    ok(many([{ location_id: PROVO, supplier_id: SUP.pDairy, lines: [{ inventory_item_id: I.pButter, qty_packs: 1 }] }], 'mgrProvo').sqlstate === '42501', 'a site manager cannot order for many sites');
    // a one site company: send for every order
    const ps = mkPO(SOLO, SUP.sDrinks, [{ item: I.sWater, sp: SP.sWater, qty: 50, price: 9.6 }]);
    const ss = callJ('soloMgr', `select public.stock_po_submit('${ps}')`);
    ok(ss.j && ss.j.send === true && num(`select count(*) from stock_po_approvals where po_id = '${ps}'`) === 0, `a one site company's order: send, no approval (${short(ss.j, 80)})`);
    const pad1 = callJ('mgrProvo', `select public.stock_order_pad_context('${PROVO}')`).j;
    const pad2 = callJ('soloMgr', `select public.stock_order_pad_context('${SOLO}')`).j;
    const dairy = pad1 && pad1.suppliers.find((s) => s.supplier_id === SUP.pDairy);
    ok(pad1 && pad1.multi === true && dairy && dairy.next && dairy.next.delivery_day === nd.delivery_day && Number(dairy.approval_limit) === 50
       && Number(dairy.max_order_value) === 800 && dairy.fee_waived_over_min === true && pad1.budget === null && pad2 && pad2.multi === false,
      `the Order pad context: next delivery, the limits and the fee rule; no budget bar without a budget; a one site company is not multi (${short(dairy && dairy.next, 120)})`);
    const due = callJ('ownerT', `select public.stock_due_to_order('${ORG_T}', null)`).j;
    ok(due && due.rows.length > 0 && due.rows.every((x) => ['ordered', 'not_yet', 'waiting_approval', 'missed', 'standing', 'held'].includes(x.status)),
      `Due to order answers every site supplier with rules (${due && due.rows.map((x) => x.supplier_name + ':' + x.status).join(', ')})`);
    // every Stock control level on the company and site saves
    const L = (who, label, body, want) => { const r0 = asCaller(who, body); ok(outcome(r0) === want, `${CALLERS[who].what}: ${label} -> ${want} (${outcome(r0)}${r0.sqlstate ? ' ' + short(r0.message, 80) : ''})`); };
    const ex = (scope, loc = null) => jlit({ scope, location_id: loc, name: 'Refit', from_day: '2026-12-24', to_day: '2026-12-26', kind: 'no_delivery' });
    L('mgrProvo', 'a company day with no delivery', `select public.stock_save_delivery_exception(${ex('company')}::jsonb || '{"org_id":"${ORG_T}"}')`, '42501');
    L('mgrFull', 'a company day with no delivery', `select public.stock_save_delivery_exception(${ex('company')}::jsonb || '{"org_id":"${ORG_T}"}')`, '42501');
    L('mgrAll', 'a company day with no delivery', `select public.stock_save_delivery_exception(${ex('company')}::jsonb || '{"org_id":"${ORG_T}"}')`, 'ok');
    L('mgrProvo', 'its own site day with no delivery', `select public.stock_save_delivery_exception(${ex('site', PROVO)})`, 'ok');
    L('mgrProvo', 'another site day with no delivery', `select public.stock_save_delivery_exception(${ex('site', LOC2)})`, '42501');
    L('mgrFull', 'a budget', `select public.stock_save_budget('{"location_id":"${LOC2}","rule":"fixed","amount":500}')`, '42501');
    L('ownerT', 'a budget', `select public.stock_save_budget('{"location_id":"${PROVO}","rule":"fixed","amount":500}')`, 'ok');
    L('mgrAllPurch', 'a company budget', `select public.stock_save_budget('{"org_id":"${ORG_T}","rule":"pct_of_forecast","pct":30}')`, 'ok');
    L('noStep', 'its own site standing order (no second step)', `select public.stock_save_standing_order('{"location_id":"${PROVO}","supplier_id":"${SUP.pDairy}","delivery_dows":[1],"lines":[]}')`, '42501');
    L('soloMgr', 'a company day in a one site company', `select public.stock_save_delivery_exception(${ex('company')}::jsonb || '{"org_id":"${ORG_S}"}')`, 'ok');
    const bs = callJ('mgrProvo', `select public.stock_budget_status('${PROVO}')`).j;
    ok(bs && Number(bs.budget) === 500 && bs.rule === 'fixed' && bs.week_start, `the budget status reads the site row (${short(bs, 160)})`);
  });

  // ==========================================================================================================
  section(44, '44. Standing orders: the runner makes the order at the order by time with the edits; bank holiday, paused, held; nothing twice');
  await guarded('standing orders', () => {
    fresh('n_d3_so');
    // rules whose order by passed 5 minutes ago for a delivery tomorrow (venue clock), for three suppliers
    const passed = (sup, loc) => sql(`delete from stock_order_rules where supplier_id = '${sup}';
      insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
      select l.org_id, l.id, s.id, s.company_ref, extract(dow from (z.n - interval '5 minutes')::date + 1), extract(dow from z.n - interval '5 minutes'),
             (z.n - interval '5 minutes')::time(0)
        from suppliers s join locations l on l.id = s.location_id cross join lateral (select now() at time zone public.stock_co__tz(l.id) as n) z where s.id = '${sup}';
      select extract(dow from (now() at time zone public.stock_co__tz('${loc}') - interval '5 minutes')::date + 1)::int;`).split('\n').pop();
    const dowDry = Number(passed(SUP.pDry, PROVO));
    passed(SUP.pBean, PROVO);
    passed(SUP.lDry, LOC2);
    const tomorrow = sql(`select ((now() at time zone public.stock_co__tz('${PROVO}') - interval '5 minutes')::date + 1)::text`);
    const so = (body, who = 'mgrProvo') => callJ(who, `select public.stock_save_standing_order(${jlit(body)})`);
    const a = so({ location_id: PROVO, supplier_id: SUP.pDry, name: 'Cups weekly', delivery_dows: [dowDry], lines: [{ inventory_item_id: I.pCups, supplier_product_id: SP.pCups, qty_packs: 2 }] });
    ok(a.j && a.j.ok, `a site sets its own standing order (${short(a.j || a.message, 100)})`);
    const wrongDay = so({ location_id: PROVO, supplier_id: SUP.pDairy, delivery_dows: [3], lines: [] });
    ok(wrongDay.sqlstate === '22023' && /Dairy Co does not deliver to Provo on Wednesday\./.test(wrongDay.message), `a day the supplier does not deliver is refused in words (${short(wrongDay.message, 80)})`);
    // the site's edits before the order by time (stored on the run), then the runner
    sql(`insert into stock_standing_runs (standing_order_id, location_id, delivery_day, status, lines, edited_by_name)
         values ('${a.j.id}', '${PROVO}', '${tomorrow}', 'waiting', '[{"inventory_item_id":"${I.pCups}","supplier_product_id":"${SP.pCups}","qty_packs":5}]', 'Site edit')`);
    const late = asCaller('mgrProvo', `select public.stock_edit_standing_run('${a.j.id}', '${tomorrow}', null, true)`);
    ok(late.sqlstate === '55000' && /The order by time has passed\. This standing order was sent\./.test(late.message), `after the order by time the run cannot be changed (${outcome(late)})`);
    const b = so({ location_id: PROVO, supplier_id: SUP.pDry, name: 'Paused one', delivery_dows: [dowDry], paused_until: tomorrow, lines: [{ inventory_item_id: I.pSyrup, supplier_product_id: SP.pSyrup, qty_packs: 1 }] });
    const beanCo = supCo(SUP.pBean);
    sql(`insert into stock_delivery_exceptions (org_id, scope, company_supplier_id, name, from_day, to_day, kind) values ('${ORG_T}', 'supplier', '${beanCo}', 'Bank holiday', '${tomorrow}', '${tomorrow}', 'no_delivery');`);
    const cbean = so({ location_id: PROVO, supplier_id: SUP.pBean, delivery_dows: [dowDry], lines: [{ inventory_item_id: I.pBeans, qty_packs: 1 }] });
    sql(`update stock_co_suppliers set order_method = 'held' where id = '${supCo(SUP.lDry)}'`);
    const lCupsItem = I.lCups;
    const dLoc = so({ location_id: LOC2, supplier_id: SUP.lDry, delivery_dows: [dowDry], lines: [{ inventory_item_id: lCupsItem, qty_packs: 1 }] }, 'mgrLoc2');
    ok(b.j && cbean.j && dLoc.j, `the paused, bank holiday and held standing orders are saved (${short([b.message, cbean.message, dLoc.message].filter(Boolean), 200)})`);
    const pos0 = num(`select count(*) from purchase_orders`);
    sql(`select public.stock_po_cutoff_run()`);
    const runA = sql(`select r.status || ':' || coalesce(r.po_id::text, '') from stock_standing_runs r where r.standing_order_id = '${a.j.id}' and r.delivery_day = '${tomorrow}'`);
    const poA = runA.split(':')[1];
    ok(runA.startsWith('sent:') && sql(`select status || ':' || standing_order_id || ':' || expected_date from purchase_orders where id = '${poA}'`) === `DRAFT:${a.j.id}:${tomorrow}`
       && Number(sql(`select string_agg(qty_packs::text, ',') from po_lines where po_id = '${poA}'`)) === 5 && sql(`select why from stock_po_send_jobs where po_id = '${poA}'`) === 'standing',
      `at the order by time the runner makes the order from the site's edit (5 packs, not 2) for tomorrow with a send job (${runA})`);
    ok(sql(`select status || ':' || skip_reason from stock_standing_runs where standing_order_id = '${b.j.id}'`) === 'skipped:Standing order paused', 'a paused standing order is skipped with its reason');
    ok(sql(`select status || ':' || skip_reason from stock_standing_runs where standing_order_id = '${cbean.j.id}' and delivery_day = '${tomorrow}'`) === 'skipped:Bank holiday',
      'a day with no delivery (Bank holiday) is skipped with its name');
    const runD = sql(`select r.status || ':' || coalesce(r.po_id::text, '') from stock_standing_runs r where r.standing_order_id = '${dLoc.j.id}'`);
    ok(runD.startsWith('held:') && sql(`select status from purchase_orders where id = '${runD.split(':')[1]}'`) === 'SENT'
       && num(`select count(*) from stock_po_send_jobs where po_id = '${runD.split(':')[1]}'`) === 0, `a held supplier: the order is recorded SENT with no email job (${runD})`);
    const pos1 = num(`select count(*) from purchase_orders`);
    sql(`select public.stock_po_cutoff_run()`);
    ok(num(`select count(*) from purchase_orders`) === pos1 && pos1 === pos0 + 2, `a second runner call makes nothing twice (${pos1 - pos0} orders, then ${num(`select count(*) from purchase_orders`) - pos1} more)`);
    // before the order by time: the site changes or skips the coming standing order
    const nd = pj(sql(`select public.stock_co__next_delivery('${SUP.pDairy}')`));
    const e = so({ location_id: PROVO, supplier_id: SUP.pDairy, delivery_dows: [Number(sql(`select extract(dow from date '${nd.delivery_day}')::int`))], lines: [{ inventory_item_id: I.pMilk, supplier_product_id: SP.pMilk, qty_packs: 1 }] });
    const ed = callJ('mgrProvo', `select public.stock_edit_standing_run('${e.j.id}', '${nd.delivery_day}', '[{"inventory_item_id":"${I.pMilk}","qty_packs":3}]')`);
    const sk = callJ('service', `select public.stock_edit_standing_run('${e.j.id}', '${nd.delivery_day}', null, true, '{"uid":"${U.mgrProvo}","name":"Phone user","location_id":"${PROVO}"}')`);
    ok(ed.j && ed.j.status === 'waiting' && sk.j && sk.j.status === 'skipped' && sql(`select skip_reason from stock_standing_runs where standing_order_id = '${e.j.id}'`) === 'Skipped by Phone user',
      'before the order by time the site changes the coming order, and the phone (service role with the person named) skips it');
    const spoof = asCaller('mgrProvo', `select public.stock_edit_standing_run('${dLoc.j.id}', '${tomorrow}', null, true, '{"uid":"${U.mgrLoc2}","name":"Someone","location_id":"${LOC2}"}')`);
    ok(spoof.sqlstate === '42501', `a login passing p_actor is ignored (only the service role may name a person): refused at a site it does not reach (${outcome(spoof)})`);
    const pad = callJ('mgrProvo', `select public.stock_order_pad_context('${PROVO}')`).j;
    const dairy = pad.suppliers.find((s) => s.supplier_id === SUP.pDairy);
    ok(dairy.standing.length === 1 && dairy.standing[0].status === 'skipped', 'the Order pad shows the coming standing order and its state');
    // the approval limit when a standing order is set up: over the site's limit for that supplier only a
    // company editor sets it, and a site's change to one run stays within it (the runner sends with no approval)
    const ndS = pj(sql(`select public.stock_co__next_delivery('${SUP.pDairy}')`));
    const ndDow = Number(sql(`select extract(dow from '${ndS.delivery_day}'::date)::int`));
    sql(`update suppliers set approval_limit = 50 where id = '${SUP.pDairy}'`);
    const butterLine = (n) => [{ inventory_item_id: I.pButter, supplier_product_id: SP.pButter, qty_packs: n }];
    const overN = Math.floor(50 / Number(sql(`select pack_price from supplier_products where id = '${SP.pButter}'`))) + 1;
    const big = { location_id: PROVO, supplier_id: SUP.pDairy, name: 'Butter big', delivery_dows: [ndDow], lines: butterLine(overN) };
    const o1 = so(big);
    const o2 = so(big, 'mgrAll');
    const o3 = so({ ...big, name: 'Butter small', lines: butterLine(1) });
    ok(o1.sqlstate === '22023' && /over the approval limit/.test(o1.message) && o2.j && o2.j.ok && o3.j && o3.j.ok,
      `a site cannot set a standing order over its approval limit; a company editor can; within the limit the site can (${outcome(o1)} ${short(o1.message, 120)})`);
    const e1 = asCaller('mgrProvo', `select public.stock_edit_standing_run('${o3.j.id}', '${ndS.delivery_day}', ${jlit(butterLine(overN))})`);
    const e2 = callJ('mgrProvo', `select public.stock_edit_standing_run('${o3.j.id}', '${ndS.delivery_day}', ${jlit(butterLine(1))})`);
    ok(e1.sqlstate === '22023' && /over the approval limit/.test(e1.message) && e2.j && e2.j.ok,
      `a site's change to one run over the limit is refused; within it, saved (${outcome(e1)})`);
  });

  // shared kitchen set up (sections 45, 47): Location 2 becomes a central kitchen; Provo gets the site row of
  // that internal supplier and a butter pack from it
  const kitchenSetup = () => {
    const k = callJ('ownerT', `select public.stock_set_site_kind('${LOC2}', 'central_kitchen')`).j;
    const ks = id('6a000000', 'a01'); const ksp = id('6b000000', 'a01');
    sql(`insert into suppliers (id, location_id, org_id, name, company_ref) values ('${ks}', '${PROVO}', '${ORG_T}', 'Central kitchen, Location 2', '${k.supplier_id}');
         insert into supplier_products (id, location_id, inventory_item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price) values ('${ksp}', '${PROVO}', '${I.pButter}', '${ks}', 1, 40, 'each', 28);`);
    return { kitchenSup: k.supplier_id, ks, ksp, k };
  };

  // ==========================================================================================================
  section(45, '45. Invoices, credits and prices: the price rule, agreed prices, the 3 way match, missing invoices, splits, the lock, make company price');
  await guarded('invoices', () => {
    fresh('n_d3_inv');
    const siButter = sql(`select supplier_item_id from stock_co_supplier_item_sites where site_supplier_product_id = '${SP.pButter}'`);
    const coPrice0 = sql(`select pack_price from stock_co_supplier_items where id = '${siButter}'`);
    const l2Price0 = sql(`select pack_price from supplier_products where id = '${SP.lButter}'`);
    const post = (who, loc, inv, lines, receipts = []) => callJ(who, `select public.stock_post_invoice('${loc}', ${jlit(inv)}, ${jlit(lines)}, ${jlit(receipts)})`);
    const r1 = post('mgrProvo', PROVO, { supplier_id: SUP.pDairy, invoice_number: 'INV-1', invoice_date: today(PROVO), total: 33 },
      [{ description: 'Butter', qty: 1, unit_price: 33, line_total: 33, matched_item_id: I.pButter, supplier_product_id: SP.pButter }],
      [{ item_id: I.pButter, qty_base: 40, unit_cost: 0.825, line_index: 0 }]);
    const rule = r1.j && r1.j.price_rule && r1.j.price_rule[0];
    ok(rule && rule.rule === 'price_here' && Number(rule.new) === 33 && Number(rule.old) === 30, `the supplier accepts price changes: the price here moves at Provo (${short(r1.j || r1.message, 200)})`);
    ok(sql(`select price_here from stock_co_supplier_item_sites where supplier_item_id = '${siButter}' and location_id = '${PROVO}'`) === '33.0000'
       && sql(`select pack_price from supplier_products where id = '${SP.pButter}'`) === '33.0000'
       && sql(`select pack_price from supplier_products where id = '${SP.lButter}'`) === l2Price0
       && sql(`select pack_price from stock_co_supplier_items where id = '${siButter}'`) === coPrice0,
      'THAT site only: Provo 33; Location 2 and the company price unchanged');
    ok(num(`select count(*) from stock_change_log where entity = 'supplier_item_site' and source = 'invoice' and location_id = '${PROVO}'`) >= 1
       && num(`select count(*) from stock_notify_sent where kind = 'price_rise' and location_id = '${PROVO}'`) === 1 && onHandEqLedger(PROVO) && ledgerGap(PROVO) < 0.01,
      'logged with source invoice, one price_rise alert (10% over 5%), on hand equals the ledger and its value equals the books (cost step and REVALUE)');
    // the price compared is the NET price of one pack as posted: a line in the item's own unit (20 of the
    // 40 in a pack, 16.50) and a line entered with VAT (39.60 a pack, 33 net) leave the price at 33
    const perUnit = post('mgrProvo', PROVO, { supplier_id: SUP.pDairy, invoice_number: 'INV-1U', invoice_date: today(PROVO), total: 16.5 },
      [{ description: 'Butter', qty: 20, unit: 'each', unit_price: 0.825, line_total: 16.5, matched_item_id: I.pButter, supplier_product_id: SP.pButter }],
      [{ item_id: I.pButter, qty_base: 20, unit_cost: 0.825, line_index: 0 }]);
    const incVat = post('mgrProvo', PROVO, { supplier_id: SUP.pDairy, invoice_number: 'INV-1V', invoice_date: today(PROVO), total: 39.6 },
      [{ description: 'Butter', qty: 1, unit_price: 39.6, line_total: 33, line_tax: 6.6, matched_item_id: I.pButter, supplier_product_id: SP.pButter }],
      [{ item_id: I.pButter, qty_base: 40, unit_cost: 0.825, line_index: 0 }]);
    const noRec = post('mgrProvo', PROVO, { supplier_id: SUP.pDairy, invoice_number: 'INV-1N', invoice_date: today(PROVO), total: 5 },
      [{ description: 'Butter, a box we cannot count', qty: 1, unit: 'box', unit_price: 5, line_total: 5, matched_item_id: I.pButter, supplier_product_id: SP.pButter }]);
    ok(perUnit.j && perUnit.j.price_rule[0] && perUnit.j.price_rule[0].rule === 'none' && Number(perUnit.j.price_rule[0].new) === 33
       && incVat.j && incVat.j.price_rule[0] && incVat.j.price_rule[0].rule === 'none' && Number(incVat.j.price_rule[0].new) === 33
       && noRec.j && noRec.j.ok && noRec.j.price_rule.length === 0
       && sql(`select price_here from stock_co_supplier_item_sites where supplier_item_id = '${siButter}' and location_id = '${PROVO}'`) === '33.0000'
       && sql(`select pack_price from supplier_products where id = '${SP.pButter}'`) === '33.0000'
       && num(`select count(*) from stock_notify_sent where kind = 'price_rise' and location_id = '${PROVO}'`) === 1,
      `a per unit line and a line with VAT are compared as a net pack price (33 both): the price here stays 33, no alert; a line with no receipt leaves it alone (${short([perUnit.j && perUnit.j.price_rule, incVat.j && incVat.j.price_rule, noRec.j && noRec.j.price_rule], 200)})`);
    // agreed prices: a credit request, the price stays
    const beanCo = supCo(SUP.pBean);
    const siBeans = sql(`select supplier_item_id from stock_co_supplier_item_sites where site_supplier_product_id = '${SP.pBeans}'`);
    sql(`update stock_co_suppliers set accepts_price_changes = false where id = '${beanCo}'; update stock_co_supplier_items set allowed_diff_pct = 2, agreed_until = null where id = '${siBeans}';`);
    const beansPack = Number(sql(`select public.stock_qty_to_base(pack_qty * inner_qty, inner_unit, inventory_item_id) from supplier_products where id = '${SP.pBeans}'`));
    const r2 = post('mgrProvo', PROVO, { supplier_id: SUP.pBean, invoice_number: 'INV-2', total: 60 },
      [{ description: 'Beans', qty: 3, unit_price: 20, line_total: 60, matched_item_id: I.pBeans, supplier_product_id: SP.pBeans }],
      [{ item_id: I.pBeans, qty_base: 3 * beansPack, unit_cost: 20 / beansPack, line_index: 0 }]);
    ok(r2.j && r2.j.credit_request_id && r2.j.price_rule[0].rule === 'credit_request'
       && sql(`select reason || ':' || status || ':' || amount from stock_credit_requests where id = '${r2.j.credit_request_id}'`) === 'overcharge:asked:6.00'
       && sql(`select pack_price from supplier_products where id = '${SP.pBeans}'`) === '18.0000', `agreed prices: one credit request for 3 x (20 - 18) = 6.00 and the price stays 18 (${short(r2.j, 160)})`);
    // the 3 way match on received orders
    const recvPO = (qty, price, recv) => mkPO(PROVO, SUP.pDairy, [{ item: I.pEggs, sp: SP.pEggs, qty, price, received: recv }]);
    const m = (qty, price, recv, iq, ip) => {
      const p = recvPO(qty, price, recv);
      sql(`update po_lines set ordered_unit_price = unit_price where po_id = '${p}'; update purchase_orders set status = 'RECEIVED', received_at = now() where id = '${p}'`);
      const r = post('mgrProvo', PROVO, { supplier_id: SUP.pDairy, po_id: p, invoice_number: `M-${p.slice(0, 6)}`, total: iq * ip },
        [{ description: 'Eggs', qty: iq, unit_price: ip, matched_item_id: I.pEggs, supplier_product_id: SP.pEggs }]);
      return r.j && r.j.match_status;
    };
    const ms = [m(2, 9, 2, 2, 9), m(2, 9, 2, 2, 9.5), m(2, 9, 1, 2, 9), m(2, 9, 1, 2, 9.5)];
    ok(JSON.stringify(ms) === JSON.stringify(['matched', 'price_issue', 'qty_issue', 'both']), `the 3 way match: matched, price issue, quantity issue, both (${ms.join(', ')})`);
    // missing invoices leave out kitchen orders
    const { ks, ksp } = kitchenSetup();
    const old = mkPO(PROVO, SUP.pDry, [{ item: I.pCups, sp: SP.pCups, qty: 1, price: 4 }]);
    const kpo = mkPO(PROVO, ks, [{ item: I.pButter, sp: ksp, qty: 1, price: 28 }]);
    sql(`update purchase_orders set status = 'RECEIVED', received_at = now() - interval '12 days' where id in ('${old}', '${kpo}')`);
    const miss = callJ('ownerT', `select public.stock_missing_invoices('${ORG_T}', null)`).j;
    ok(miss && miss.rows.some((x) => x.po_id === old) && !miss.rows.some((x) => x.po_id === kpo), 'Missing invoices lists a received order with no invoice after 7 days and never a kitchen order');
    const kin = asCaller('mgrProvo', `select public.stock_post_invoice('${PROVO}', '{"supplier_id":"${ks}","po_id":"${kpo}"}', '[]')`);
    ok(kin.sqlstate === '55000' && /This order arrives as a transfer from the central kitchen\. Receive it in Transfers\./.test(kin.message), `a kitchen order is never invoiced as a delivery (${outcome(kin)})`);
    // the kitchen's delivery note posted as an invoice with no order (and no shop buy) is refused too: the
    // goods come in only through the transfer, never counted twice
    const before = numbers(PROVO);
    const kin2 = asCaller('mgrProvo', `select public.stock_post_invoice('${PROVO}', ${jlit({ supplier_id: ks, invoice_number: 'KDN-1', total: 28 })},
      ${jlit([{ description: 'Butter', qty: 1, unit_price: 28, line_total: 28, matched_item_id: I.pButter, supplier_product_id: ksp }])},
      ${jlit([{ item_id: I.pButter, qty_base: 40, unit_cost: 0.7, line_index: 0 }])})`);
    ok(kin2.sqlstate === '55000' && /Receive it in Transfers\./.test(kin2.message) && numbers(PROVO) === before
       && num(`select count(*) from supplier_invoices where invoice_number = 'KDN-1'`) === 0,
      `an invoice from the kitchen supplier with no order is refused and posts nothing (${outcome(kin2)})`);
    // splits add up; the lock
    const inv1 = r1.j.invoice_id;
    const sp1 = asCaller('ownerT', `select public.stock_invoice_split('${inv1}', '[{"location_id":"${PROVO}","amount":20},{"location_id":"${LOC2}","amount":10}]')`);
    const sp2 = callJ('ownerT', `select public.stock_invoice_split('${inv1}', '[{"location_id":"${PROVO}","amount":20},{"location_id":"${LOC2}","amount":13}]')`);
    ok(sp1.sqlstate === '22023' && sp1.message.includes(`The splits add up to ${POUND}30, the invoice is ${POUND}33.`) && sp2.j && sp2.j.ok
       && num(`select count(*) from supplier_invoice_site_splits where invoice_id = '${inv1}'`) === 2, `splits must add up to the invoice (${short(sp1.message, 90)}); paperwork only`);
    ok(asCaller('mgrProvo', `select public.stock_invoice_split('${inv1}', '[{"location_id":"${PROVO}","amount":33}]')`).sqlstate === '42501', 'a site manager cannot split an invoice across sites');
    asCaller('service', `update supplier_invoices set locked_at = now() where id = '${inv1}'`);
    const lk = asCaller('mgrProvo', `update supplier_invoices set invoice_number = 'X' where id = '${inv1}'`);
    const lk2 = asCaller('ownerT', `select public.stock_invoice_split('${inv1}', '[{"location_id":"${PROVO}","amount":33}]')`);
    const ap = callJ('mgrProvo', `select public.stock_invoices_approve(array['${inv1}']::uuid[])`);
    ok(lk.sqlstate === '55000' && /This invoice was sent to Xero and is locked\./.test(lk.message) && lk2.sqlstate === '55000' && ap.j && ap.j.approved === 0 && ap.j.skipped.length === 1,
      'a locked invoice refuses an edit, a split and an approval (skipped with its words)');
    // make company price: every following site moves
    const ver = num(`select row_version from stock_co_supplier_items where id = '${siButter}'`);
    const mcp = callJ('ownerT', `select public.stock_make_company_price('${siButter}', '${PROVO}', ${ver})`);
    ok(mcp.j && mcp.j.ok && sql(`select pack_price from stock_co_supplier_items where id = '${siButter}'`) === '33.0000'
       && sql(`select coalesce(price_here::text, 'null') from stock_co_supplier_item_sites where supplier_item_id = '${siButter}' and location_id = '${PROVO}'`) === 'null'
       && sql(`select pack_price from supplier_products where id = '${SP.lButter}'`) === '33.0000' && onHandEqLedger(LOC2) && ledgerGap(LOC2) < 0.01,
      `make this the company price: the company price is 33, Provo follows it, Location 2 moves with it (cost step and REVALUE there) (${short(mcp.j || mcp.message, 120)})`);
    ok(asCaller('mgrProvo', `select public.stock_make_company_price('${siButter}', '${PROVO}', ${ver + 1})`).sqlstate === '42501', 'a site manager cannot make a company price');
    const pc = callJ('ownerT', `select public.stock_price_changes_page('${ORG_T}', null)`).j;
    ok(pc && pc.rows.some((x) => x.source === 'invoice' && Number(x.new) === 33), `Supplier prices lists the invoice change (${pc && pc.rows.length} rows)`);
    // a one site company: byte for byte today's answer
    const solo = (db) => { c.use(db); return asCaller('soloMgr', `select public.stock_post_invoice('${SOLO}', '{"client_id":"${id('7a000000', 'b1')}","supplier_id":"${SUP.sDrinks}","invoice_number":"S-1","total":12}',
      '[{"description":"Water","qty":1,"unit_price":12,"matched_item_id":"${I.sWater}","supplier_product_id":"${SP.sWater}"}]', '[{"item_id":"${I.sWater}","qty_base":24,"unit_cost":0.5,"line_index":0}]')`, { commit: false }).out; };
    c.createFrom('n_d3_inv_pre', PRE);
    const outPre = solo('n_d3_inv_pre');
    const outPost = solo('n_d3_inv');
    ok(outPre && outPre === outPost && !/price_rule/.test(outPost), `a one site company's invoice post answers byte for byte as before Drop 3 (${short(outPost, 120)})`);
    asCaller('soloMgr', `select public.stock_post_invoice('${SOLO}', '{"supplier_id":"${SUP.sDrinks}","invoice_number":"S-2","total":12}', '[{"description":"Water","qty":1,"unit_price":12,"supplier_product_id":"${SP.sWater}"}]')`);
    ok(sql(`select pack_price from supplier_products where id = '${SP.sWater}'`) === '9.6000' && num(`select count(*) from stock_credit_requests c join locations l on l.id = c.location_id where l.org_id = '${ORG_S}'`) === 0
       && num(`select count(*) from stock_notify_sent where org_id = '${ORG_S}'`) === 0, 'and writes no price, credit or alert');
    // credits: a request by hand, a credit note covering it
    const cr = callJ('mgrProvo', `select public.stock_save_credit_request('{"location_id":"${PROVO}","supplier_id":"${SUP.pDairy}","reason":"short","lines":[{"description":"Eggs","qty":1,"amount":9}]}')`);
    const cn = callJ('mgrProvo', `select public.stock_save_credit_note('{"location_id":"${PROVO}","supplier_id":"${SUP.pDairy}","request_id":"${cr.j && cr.j.id}","amount":9,"note_date":"${today(PROVO)}"}')`);
    const wo = asCaller('mgrProvo', `select public.stock_credit_set_status('${r2.j.credit_request_id}', 'written_off', null)`);
    ok(cr.j && Number(cr.j.amount) === 9 && cn.j && cn.j.request_status === 'received' && wo.sqlstate === '42501',
      'a credit request by hand, a credit note that covers it marks it received; writing one off is head office only');
  });

  // ==========================================================================================================
  section(46, '46. Counts and waste: second approval, if not counted zero, locked periods, waste over the PIN limit, 5 wrong PINs lock');
  await guarded('counts and waste', () => {
    fresh('n_d3_cw');
    const mkCount = (lines, extra = {}) => {
      const cid = sql(`insert into stock_counts (location_id, name, count_type, status, started_at ${extra.plan ? ', plan_id' : ''}) values ('${PROVO}', 'Test count', 'FULL', 'SUBMITTED', now() ${extra.plan ? `, '${extra.plan}'` : ''}) returning id`);
      lines.forEach((l, k) => sql(`insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, counted_at, sort_order) values ('${PROVO}', '${cid}', '${l.item}', ${l.qty ?? 'null'}, ${l.at ? `'${l.at}'` : l.qty == null ? 'null' : 'now()'}, ${k})`));
      return cid;
    };
    // an opening count first (its variance is 0 by rule), then a count over the limit
    const open = mkCount([{ item: I.pButter, qty: 10 }]);
    callJ('mgrProvo', `select public.stock_approve_count_pin('${open}', '4321', null, null, null, false)`);
    sql(`update stock_co_settings set count_second_approval_over = 5 where org_id = '${ORG_T}'`);
    const mv0 = num(`select count(*) from stock_movements where location_id = '${PROVO}'`);
    const big = mkCount([{ item: I.pButter, qty: num(`select on_hand from inventory_items where id = '${I.pButter}'`) + 50 }]);
    const a1 = callJ('mgrProvo', `select public.stock_approve_count_pin('${big}', '4321', null, null, null, false)`);
    ok(a1.j && a1.j.ok === false && a1.j.waiting === 'second_approval' && a1.j.error === `Over ${POUND}5. Waiting for a second approval.`
       && num(`select count(*) from stock_movements where location_id = '${PROVO}'`) === mv0
       && sql(`select (second_approval_needed_at is not null) || ':' || first_approved_by || ':' || first_approved_by_name from stock_counts where id = '${big}'`) === `true:${U.mgrProvo}:Duty Manager`
       && num(`select count(*) from stock_notify_sent where kind = 'count_second_approval' and ref = '${big}'`) === 1,
      `over the limit: nothing posts, the count waits for a second approval with the first approver and an alert (${short(a1.j, 160)})`);
    const s1 = asCaller('mgrProvo', `select public.stock_second_approve_count('${big}')`);
    ok(s1.sqlstate === '42501' && /You gave the first approval\. Someone else gives the second\./.test(s1.message), `the first approver cannot give the second (${outcome(s1)})`);
    ok(asCaller('mgrLoc2', `select public.stock_second_approve_count('${big}')`).sqlstate === '42501', 'a manager of another site cannot give it');
    const s2 = callJ('areaMgr', `select public.stock_second_approve_count('${big}')`);
    ok(s2.j && s2.j.ok && sql(`select status || ':' || (second_approved_by_name is not null) || ':' || approved_by_staff_name from stock_counts where id = '${big}'`) === 'APPROVED:true:Duty Manager'
       && num(`select count(*) from stock_movements where location_id = '${PROVO}' and movement_type = 'STOCK_COUNT_ADJ'`) > 0 && onHandEqLedger(PROVO),
      `another login of that site posts it (${short(s2.j, 100)})`);
    // the approval columns are the count approval's alone: a login cannot set or clear them through the API
    const big2 = mkCount([{ item: I.pButter, qty: num(`select on_hand from inventory_items where id = '${I.pButter}'`) + 50 }]);
    const f1 = asCaller('mgrProvo', `update stock_counts set second_approved_at = now() where id = '${big2}'`);
    const f2 = asCaller('mgrProvo', `update stock_counts set first_approved_by_name = 'Me' where id = '${big2}'`);
    const f3 = asCaller('mgrProvo', `insert into stock_counts (location_id, name, count_type, status, started_at, second_approved_at) values ('${PROVO}', 'Sneaky', 'FULL', 'SUBMITTED', now(), now())`);
    const f4 = asCaller('mgrProvo', `update stock_counts set name = 'Renamed' where id = '${big2}'`);
    const f5 = asCaller('service', `update stock_counts set second_approval_needed_at = now(), first_approved_by_name = 'Duty Manager' where id = '${big2}'`);
    ok(f1.sqlstate === '42501' && f2.sqlstate === '42501' && f3.sqlstate === '42501' && f4.status === 0 && f5.status === 0
       && /Only the count approval records who approved a count\./.test(f1.message),
      `a direct update or insert of the second approval is refused for a login (${outcome(f1)}, ${outcome(f2)}, ${outcome(f3)}); other edits and the phone (service role) go through`);
    sql(`update stock_counts set second_approval_needed_at = null, first_approved_by_name = null where id = '${big2}'`);
    const a3 = callJ('mgrProvo', `select public.stock_approve_count_pin('${big2}', '4321', null, null, null, false)`);
    ok(a3.j && a3.j.ok === false && a3.j.waiting === 'second_approval', 'so the count over the limit still waits for a second approval');
    sql(`update stock_co_settings set count_second_approval_over = null where org_id = '${ORG_T}'`);
    // if not counted: zero
    const plan = callJ('ownerT', `select public.stock_save_count_plan('{"org_id":"${ORG_T}","name":"Daily fresh","count_type":"PARTIAL","every":"day","if_not_counted":"zero"}')`).j;
    const zc = mkCount([{ item: I.pMilk, qty: 1 }, { item: I.pEggs, qty: null }], { plan: plan && plan.id });
    const za = callJ('mgrProvo', `select public.stock_approve_count_pin('${zc}', '4321', null, null, null, false)`);
    ok(za.j && za.j.ok && Number(sql(`select counted_qty from stock_count_lines where count_id = '${zc}' and inventory_item_id = '${I.pEggs}'`)) === 0
       && num(`select on_hand from inventory_items where id = '${I.pEggs}'`) === 0, `a plan that says zero: the uncounted line becomes 0 when a manager approves (${short(za.j || za.message, 100)})`);
    const due = callJ('ownerT', `select public.stock_count_due('${ORG_T}', null)`).j;
    ok(due && due.rows.some((x) => x.plan_id === plan.id && x.location_id === PROVO), `the count plan is due at every open site (${due && due.rows.map((x) => x.status).join(',')})`);
    // locked periods
    const t = today(PROVO);
    const lp0 = asCaller('mgrProvo', `select public.stock_lock_period('${PROVO}', date '${t}' - 10, date '${t}' - 3)`);
    const lp = callJ('ownerT', `select public.stock_lock_period('${PROVO}', date '${t}' - 10, date '${t}' - 3)`);
    ok(lp0.sqlstate === '42501' && lp.j && lp.j.ok && lp.j.metrics && num(`select count(*) from stock_period_snapshots where period_id = '${lp.j.period_id}'`) === 1,
      `head office locks a period with one snapshot row; a site manager cannot (${short(lp.j && lp.j.metrics, 160)})`);
    const old = mkCount([{ item: I.pCups, qty: 3, at: `${sql(`select (date '${t}' - 5)::text`)} 12:00:00+00` }]);
    const lc = asCaller('mgrProvo', `select public.stock_approve_count_pin('${old}', '4321', null, null, null, false)`);
    const pv = callJ('mgrProvo', `select public.stock_approve_count_pin('${old}', null, null, null, null, true)`);
    ok(lc.sqlstate === '55000' && /That count is in a locked period \(to \d+ [A-Z][a-z]{2}\)\. Ask head office to unlock it\./.test(lc.message) && pv.j && pv.j.preview,
      `a count inside it is refused in words; the preview still works (${short(lc.message, 100)})`);
    const snap0 = sql(`select metrics::text from stock_period_snapshots where period_id = '${lp.j.period_id}'`);
    const siButter = sql(`select supplier_item_id from stock_co_supplier_item_sites where site_supplier_product_id = '${SP.pButter}'`);
    sql(`select public.stock_co__set_price_here('${siButter}', '${PROVO}', 31, 'edit', null)`);
    callJ('mgrProvo', `select public.stock_post_invoice('${PROVO}', '{"supplier_id":"${SUP.pDairy}","invoice_number":"LATE-1","invoice_date":"${sql(`select (date '${t}' - 6)::text`)}"}',
      '[{"description":"Butter","qty":1,"unit_price":31,"matched_item_id":"${I.pButter}"}]', '[{"item_id":"${I.pButter}","qty_base":40,"unit_cost":0.775}]')`);
    const bw = callJ('mgrProvo', `select public.stock_record_waste('${PROVO}', '{"kind":"item","inventory_item_id":"${I.pCups}","qty_base":1,"reason":"Breakage / spill","occurred_at":"${sql(`select (date '${t}' - 5)::text`)}T12:00:00Z"}')`);
    ok(sql(`select metrics::text from stock_period_snapshots where period_id = '${lp.j.period_id}'`) === snap0
       && sql(`select note from waste_events where id = '${bw.j && bw.j.id}'`).includes(', period locked)')
       && num(`select count(*) from stock_movements where location_id = '${PROVO}' and occurred_at < now() - interval '1 day' and source_id = '${bw.j && bw.j.id}'`) === 0,
      'the snapshot stays identical after a price edit and a late invoice; a back dated waste lands now with its real day in the note');
    const ul0 = asCaller('ownerT', `select public.stock_unlock_period('${lp.j.period_id}', '  ')`);
    const ul = callJ('ownerT', `select public.stock_unlock_period('${lp.j.period_id}', 'Wrong count')`);
    ok(ul0.sqlstate === '22023' && /Say why you are unlocking it\./.test(ul0.message) && ul.j && ul.j.ok
       && num(`select count(*) from stock_period_snapshots where period_id = '${lp.j.period_id}'`) === 1, 'unlocking needs a reason; the snapshot stays');
    // waste over the PIN limit: the till (a device session) and the phone (service role with the staff stamped)
    sql(`insert into stock_co_site_settings (location_id, org_id, waste_pin_over_value) values ('${PROVO}', '${ORG_T}', 1)
           on conflict (location_id) do update set waste_pin_over_value = 1`);
    const w = (who, extra = '') => callJ(who, `select public.stock_record_waste('${PROVO}', '{"kind":"item","inventory_item_id":"${I.pBeans}","qty_base":2,"reason":"Spoilage","source":"pos"${extra}}')`);
    const n0 = num(`select count(*) from waste_events where location_id = '${PROVO}'`);
    const w1 = w('tillProvo');
    ok(w1.j && w1.j.ok === false && w1.j.pin === 'needed' && w1.j.error === `Over ${POUND}1 needs a manager PIN.` && Number(w1.j.limit) === 1
       && num(`select count(*) from waste_events where location_id = '${PROVO}'`) === n0, `the till: over the limit asks for a manager PIN and writes nothing (${short(w1.j, 120)})`);
    const w2 = w('tillProvo', ',"pin":"1111"');
    ok(w2.j && w2.j.pin === 'wrong' && w2.j.error === 'That PIN is not a manager at this venue.', 'a server PIN is wrong');
    const w3 = w('tillProvo', ',"pin":"2468"');
    ok(w3.j && w3.j.ok && sql(`select approved_by_staff_name || ':' || coalesce(note, '') from waste_events where id = '${w3.j.id}'`) === 'Approver One:'
       && num(`select count(*) from waste_events where location_id = '${PROVO}' and note like '%2468%'`) === 0, 'a PIN with manager approvals passes; the holder is stamped and the PIN is never stored');
    const w4 = w('service', `,"approved_by_staff_id":"${sql(`select id from staff_members where location_id = '${PROVO}' and name = 'Duty Manager'`)}"`);
    ok(w4.j && w4.j.ok && sql(`select approved_by_staff_name from waste_events where id = '${w4.j.id}'`) === 'Duty Manager', 'the phone (service role) passes the staff member it proved');
    for (let k = 0; k < 4; k++) w('tillProvo', ',"pin":"9999"');
    const w5 = w('tillProvo', ',"pin":"4321"');
    ok(w5.j && w5.j.pin === 'locked' && w5.j.error === 'Too many wrong PINs. Wait 15 minutes, then try again.', `5 wrong PINs lock the till for 15 minutes, even with the right one (${short(w5.j, 80)})`);
    const w6 = callJ('mgrLoc2', `select public.stock_record_waste('${LOC2}', '{"kind":"item","inventory_item_id":"${I.lButter}","qty_base":1,"reason":"Spoilage"}')`);
    ok(w6.j && w6.j.ok && !('pin' in w6.j), 'no limit set (every live company): waste is logged as today');
    ok(onHandEqLedger(PROVO) && onHandEqLedger(LOC2), 'on hand equals the ledger at both sites');
    const fc = callJ('mgrProvo', `select public.stock_fresh_closedown_list('${PROVO}')`).j;
    ok(fc && Array.isArray(fc.rows), `the fresh close down list answers (${fc && fc.rows.length} items)`);
  });

  // ==========================================================================================================
  section(47, '47. Transfers and the central kitchen: requests, disputes, a kitchen order received once, the plan, kitchen only recipes, recharges');
  await guarded('transfers and kitchen', () => {
    fresh('n_d3_tk');
    const butterCo = coOf(I.pButter);
    const mv = (loc) => sql(`select json_build_object('n', count(*), 'q', sum(qty_base), 'v', sum(value_delta)) from stock_movements where location_id = '${loc}'`);
    const rq = callJ('mgrLoc2', `select public.stock_request_transfer('${PROVO}', '${LOC2}', '[{"company_item_id":"${butterCo}","qty_base":40},{"company_item_id":"${coOf(I.pSyrup)}","qty_base":5}]', 'Running low', 'For the weekend')`);
    ok(rq.j && rq.j.ok && rq.j.refused.length === 1 && /is not at /.test(rq.j.refused[0])
       && sql(`select status || ':' || kind || ':' || requested_by_name from stock_transfers where id = '${rq.j.transfer_id}'`).startsWith('REQUESTED:request:')
       && num(`select count(*) from stock_notify_sent where kind = 'transfer_waiting' and location_id = '${PROVO}'`) === 1,
      `the receiving site asks: REQUESTED with the one line both sites hold; the other is refused in words (${short(rq.j, 160)})`);
    const before = { p: mv(PROVO), l: mv(LOC2) };
    const tid = rq.j.transfer_id;
    const line = sql(`select id from stock_transfer_lines where transfer_id = '${tid}'`);
    ok(asCaller('mgrLoc2', `select public.stock_fulfil_request('${tid}')`).sqlstate === '42501', 'the asking site cannot accept its own request');
    const ff = callJ('mgrProvo', `select public.stock_fulfil_request('${tid}', '[{"line_id":"${line}","qty_base":20}]')`);
    const out = callJ('mgrProvo', `select public.post_stock_transfer_leg('${tid}', 'out', 'Provo manager')`);
    const mt = callJ('mgrLoc2', `select public.stock_transfer_matches('${tid}')`);
    const inn = callJ('mgrLoc2', `select public.post_stock_transfer_leg('${tid}', 'in', 'Loc2 manager')`);
    ok(ff.j && ff.j.status === 'DRAFT' && out.j && out.j.status === 'SENT' && mt.j && mt.j[0].how === 'company' && inn.j && inn.j.status === 'RECEIVED',
      `fulfil (20 of 40), send with today's out leg, the receive matches by company item, received (${short(mt.j, 100)})`);
    const vOut = num(`select coalesce(sum(value_delta), 0) from stock_movements where source_id = '${tid}' and location_id = '${PROVO}'`);
    const vIn = num(`select coalesce(sum(value_delta), 0) from stock_movements where source_id = '${tid}' and location_id = '${LOC2}' and movement_type = 'TRANSFER_IN'`);
    const qOut = num(`select coalesce(sum(qty_base), 0) from stock_movements where source_id = '${tid}' and location_id = '${PROVO}'`);
    const qIn = num(`select coalesce(sum(qty_base), 0) from stock_movements where source_id = '${tid}' and location_id = '${LOC2}' and movement_type = 'TRANSFER_IN'`);
    ok(qOut === -20 && qIn === 20 && Math.abs(vOut + vIn) < 0.01 && onHandEqLedger(PROVO) && onHandEqLedger(LOC2), `the transfer conserves stock (${qOut} / +${qIn}) and value (${vOut} / ${vIn})`);
    const rq2 = callJ('mgrLoc2', `select public.stock_request_transfer('${PROVO}', '${LOC2}', '[{"company_item_id":"${butterCo}","qty_base":5}]')`).j;
    const mvA = { p: mv(PROVO), l: mv(LOC2) };
    const rf = callJ('mgrProvo', `select public.post_stock_transfer_leg('${rq2.transfer_id}', 'refuse', 'Provo manager')`);
    const dp0 = asCaller('mgrLoc2', `select public.stock_dispute_transfer('${tid}', '  ')`);
    const dp = callJ('mgrLoc2', `select public.stock_dispute_transfer('${tid}', 'Two packs were open')`);
    const rs = callJ('mgrProvo', `select public.post_stock_transfer_leg('${tid}', 'resolve', 'Provo manager')`);
    ok(rf.j && rf.j.status === 'CANCELLED' && dp0.sqlstate === '22023' && /Say what is wrong\./.test(dp0.message) && dp.j && dp.j.status === 'DISPUTED'
       && sql(`select dispute_note from stock_transfers where id = '${tid}'`) === 'Two packs were open' && rs.j && rs.j.status === 'RECEIVED'
       && mv(PROVO) === mvA.p && mv(LOC2) === mvA.l, 'refuse a request; a dispute needs words; dispute and resolve move no stock');
    // the central kitchen
    ok(asCaller('mgrProvo', `select public.stock_set_site_kind('${LOC2}', 'central_kitchen')`).sqlstate === '42501'
       && /A one site company has no central kitchen\./.test(asCaller('soloOwner', `select public.stock_set_site_kind('${SOLO}', 'central_kitchen')`).message),
      'only head office sets a central kitchen; a one site company has none');
    const { ks, ksp, kitchenSup } = kitchenSetup();
    ok(sql(`select name || ':' || accepts_price_changes || ':' || internal_location_id from stock_co_suppliers where id = '${kitchenSup}'`) === `Central kitchen, Location 2:false:${LOC2}`,
      'the kitchen becomes an internal company supplier');
    const kpo = mkPO(PROVO, ks, [{ item: I.pButter, sp: ksp, qty: 2, price: 28 }]);
    sql(`update purchase_orders set expected_date = current_date + 1 where id = '${kpo}'`);
    const sub = callJ('mgrProvo', `select public.stock_po_submit('${kpo}')`);
    ok(sub.j && sub.j.internal === true && sql(`select status from purchase_orders where id = '${kpo}'`) === 'SENT' && num(`select count(*) from stock_po_send_jobs where po_id = '${kpo}'`) === 0,
      'a kitchen order goes SENT to the kitchen (never emailed)');
    const day = sql(`select expected_date from purchase_orders where id = '${kpo}'`);
    const r1 = asCaller('mgrProvo', `select public.stock_receive('${PROVO}', 'purchase_order', '${kpo}', '[{"key":"x","item_id":"${I.pButter}","qty_base":80}]')`);
    ok(r1.sqlstate === '55000' && /This order arrives as a transfer from the central kitchen\. Receive it in Transfers\./.test(r1.message), `receiving it as a delivery is refused (${outcome(r1)})`);
    const oi = callJ('mgrLoc2', `select public.stock_kitchen_orders_in('${LOC2}', '${day}')`);
    ok(oi.j && oi.j.some((o) => o.po_id === kpo && o.lines.length === 1) && num(`select count(*) from purchase_orders where id = '${kpo}'`) === 1
       && asCaller('mgrLoc2', `select count(*) from purchase_orders where id = '${kpo}'`).out === '0', 'the kitchen sees it in Orders in (it cannot read other sites\' orders directly)');
    const kItem = sql(`select site_item_id from stock_co_item_sites where item_id = '${butterCo}' and location_id = '${LOC2}'`);
    sql(`insert into production_batches (location_id, output_item_id, output_name, planned_qty, actual_qty, output_unit, status, lot_code, expiry_at, produced_at)
         values ('${LOC2}', '${kItem}', 'Butter', 40, 40, 'each', 'COMPLETED', 'LOT-7', now() + interval '3 days', now())`);
    const pl = sql(`select id from po_lines where po_id = '${kpo}'`);
    const pick = callJ('mgrLoc2', `select public.stock_kitchen_pick('${kpo}', '[{"po_line_id":"${pl}","qty_packs_sent":1}]')`);
    const kt = pick.j && pick.j.transfer_id;
    ok(pick.j && pick.j.ok && pick.j.short_lines.length === 1 && sql(`select status || ':' || kind || ':' || purchase_order_id from stock_transfers where id = '${kt}'`) === `SENT:central_kitchen:${kpo}`
       && sql(`select lot_code || ':' || to_unit_cost from stock_transfer_lines where transfer_id = '${kt}'`) === 'LOT-7:0.70000000' && pick.j.note && pick.j.note.lines[0].short === 1,
      `pick and send: one linked transfer in transit, the lot travels, the price the site paid is kept, the delivery note shows the short (${short(pick.j && pick.j.note, 140)})`);
    const p2 = asCaller('mgrLoc2', `select public.stock_kitchen_pick('${kpo}', '[{"po_line_id":"${pl}","qty_packs_sent":1}]')`);
    ok(p2.sqlstate === '55000' && /This order was already picked\./.test(p2.message), 'a second pick is refused');
    const ki = callJ('mgrProvo', `select public.post_stock_transfer_leg('${kt}', 'in', 'Provo manager')`);
    ok(ki.j && ki.j.status === 'RECEIVED' && ki.j.received_lines[0].lot_code === 'LOT-7' && sql(`select status || ':' || (select qty_received::numeric(12,3) from po_lines where po_id = '${kpo}') from purchase_orders where id = '${kpo}'`) === 'RECEIVED:1.000',
      `receiving the transfer closes the order: RECEIVED with 1 pack received (${short(ki.j, 140)})`);
    ok(num(`select count(*) from stock_movements where location_id = '${PROVO}' and source_id = '${kt}' and movement_type = 'TRANSFER_IN'`) === 1
       && num(`select count(*) from stock_movements where location_id = '${PROVO}' and source_id = '${kpo}' and movement_type = 'PURCHASE_RECEIPT'`) === 0
       && Math.abs(num(`select sum(value_delta) from stock_movements where source_id = '${kt}' and movement_type in ('TRANSFER_IN', 'TRANSFER_OUT')`)) < 0.01,
      'stock went in ONCE (one TRANSFER_IN, no PURCHASE_RECEIPT) and the value left the kitchen and arrived at Provo');
    const again = [asCaller('mgrProvo', `select public.stock_receive('${PROVO}', 'purchase_order', '${kpo}', '[{"key":"y","item_id":"${I.pButter}","qty_base":40}]')`),
      asCaller('mgrProvo', `select public.stock_post_invoice('${PROVO}', '{"supplier_id":"${ks}","po_id":"${kpo}"}', '[]')`),
      asCaller('service', `select public.stock_receive('${PROVO}', 'purchase_order', '${kpo}', '[{"key":"z","item_id":"${I.pButter}","qty_base":40}]')`)];
    ok(again.every((x) => x.sqlstate === '55000'), `a second receive through Deliveries, an invoice or the phone is refused (${again.map(outcome).join(', ')})`);
    // the production plan: orders, standing orders, less holds
    const milkCo = coOf(I.lMilk);
    const rec = callJ('ownerT', `select public.stock_save_recipe(${jlit({ location_id: LOC2, name: 'Butter batch', recipe_type: 'BATCH', output_item_id: butterCo, yield_qty: 40, yield_unit: 'each', sites: [{ location_id: LOC2, on: true }] })},
      ${jlit([{ component_item_id: milkCo, qty: 2, unit: 'l' }])})`);
    const rid = rec.j && rec.j.id;
    const kpo2 = mkPO(PROVO, ks, [{ item: I.pButter, sp: ksp, qty: 3, price: 28 }]);
    sql(`update purchase_orders set expected_date = '${day}' where id = '${kpo2}'`);
    callJ('mgrProvo', `select public.stock_po_submit('${kpo2}')`);
    const plan = callJ('mgrLoc2', `select public.stock_kitchen_plan('${LOC2}', '${day}')`).j;
    const row = plan && plan.find((x) => x.recipe_id === rid);
    const holds = num(`select on_hand from inventory_items where id = '${kItem}'`);
    ok(row && Number(row.ordered) === 200 && Number(row.holds) === holds && Number(row.make) === Math.max(0, 200 + Number(row.catering) + Number(row.standing) - holds)
       && row.by_site.length === 1, `the plan sums the orders for that day (2 + 3 packs of 40 = 200) less what the kitchen holds (${short(row, 200)})`);
    const ing = callJ('mgrLoc2', `select public.stock_kitchen_ingredients('${LOC2}', '${day}')`).j;
    ok(Array.isArray(ing) && (Number(row.make) === 0 || ing.some((x) => x.name && Number(x.need_base) > 0)), `ingredients for the Make (${short(ing, 160)})`);
    const tk = callJ('mgrLoc2', `select public.stock_kitchen_tick('${LOC2}', '${rid}', 40)`);
    const tk2 = asCaller('mgrLoc2', `select public.stock_kitchen_tick('${LOC2}', '${rid}', 40, current_date - 5)`);
    const ut = callJ('mgrLoc2', `select public.stock_kitchen_untick('${tk.j && tk.j.id}')`);
    ok(tk.j && Number(tk.j.done) === 40 && tk2.sqlstate === '22023' && /Tick today or yesterday only\./.test(tk2.message) && ut.j && ut.j.ok, 'Done ticks with who: today, never an earlier day; untick today');
    // kitchen only recipes
    const rv = num(`select row_version from stock_co_recipes where id = '${rid}'`);
    const dish = sql(`select id from stock_co_recipes where kind = 'dish' and org_id = '${ORG_T}' limit 1`);
    ok(/Only batch and prep recipes can be kitchen only\./.test(asCaller('ownerT', `select public.stock_set_recipe_restricted('${dish}', true, '${LOC2}', ${num(`select row_version from stock_co_recipes where id = '${dish}'`)})`).message),
      'a dish cannot be kitchen only');
    // on at Provo first: its site copy carries the lines a Provo manager can read today
    const onP = callJ('ownerT', `select public.stock_set_recipe_sites('${rid}', '[{"location_id":"${PROVO}","on":true}]', ${num(`select row_version from stock_co_recipes where id = '${rid}'`)})`);
    const sridP = sql(`select coalesce(site_recipe_id::text, '') from stock_co_recipe_sites where recipe_id = '${rid}' and location_id = '${PROVO}'`);
    const linesP = () => (sridP ? Number(asCaller('mgrProvo', `select count(*) from recipe_lines where recipe_id = '${sridP}'`, { commit: false }).out) : -1);
    const linesBefore = linesP();
    ok(onP.j && sridP && linesBefore > 0, `the recipe is on at Provo with its lines there (${linesBefore} lines; ${short(onP.j || onP.message, 120)})`);
    sql(`update stock_co_recipes set method = 'Churn slowly' where id = '${rid}'`);
    const rr = callJ('ownerT', `select public.stock_set_recipe_restricted('${rid}', true, '${LOC2}', ${num(`select row_version from stock_co_recipes where id = '${rid}'`)})`);
    ok(rr.j && rr.j.ok && sql(`select coalesce(method, 'null') || ':' || restricted from stock_co_recipes where id = '${rid}'`) === 'null:true'
       && sql(`select method from stock_co_recipe_secrets where recipe_id = '${rid}'`) === 'Churn slowly', 'Kitchen only: the method moves to the secrets table');
    const seen = (who) => [`select count(*) from stock_co_recipes where id = '${rid}'`, `select count(*) from stock_co_recipe_lines where recipe_id = '${rid}'`,
      `select count(*) from stock_co_recipe_secrets where recipe_id = '${rid}'`].map((q) => asCaller(who, q, { commit: false }).out).join(',');
    ok(seen('mgrProvo') === '0,0,0' && seen('mgrLoc2') === '1,1,1' && seen('ownerT') === '1,1,1',
      `a site manager of another site reads no row of the recipe, its lines or secrets; the kitchen login and the owner do (${seen('mgrProvo')} / ${seen('mgrLoc2')} / ${seen('ownerT')})`);
    const kitchenLines = Number(sql(`select count(*) from recipe_lines where recipe_id = (select site_recipe_id from stock_co_recipe_sites where recipe_id = '${rid}' and location_id = '${LOC2}')`));
    ok(linesP() === 0 && Number(sql(`select count(*) from recipe_lines where recipe_id = '${sridP}'`)) === 0 && kitchenLines > 0,
      `made Kitchen only, Provo's copy of the ingredients is gone: a Provo manager reads 0 recipe_lines rows; the kitchen keeps its ${kitchenLines}`);
    const det = callJ('mgrProvo', `select public.stock_recipe_detail('${rid}')`).j;
    const detK = callJ('mgrLoc2', `select public.stock_recipe_detail('${rid}')`).j;
    ok(det && det.restricted === true && det.method === null && det.cost === null && (det.sites || []).every((s) => s.cost === null) && detK && detK.method === 'Churn slowly'
       && det.kitchen_name === 'Location 2', 'the detail read gives another site no method and no cost; the kitchen gets the method');
    const on = callJ('ownerT', `select public.stock_set_recipe_sites('${rid}', '[{"location_id":"${PROVO}","on":true}]', ${num(`select row_version from stock_co_recipes where id = '${rid}'`)})`);
    ok(/Only the kitchen makes this recipe\. Other sites buy it from the kitchen\./.test(JSON.stringify(on.j || on.message)), `switching it on at another site is refused in words (${short(on.j || on.message, 160)})`);
    ok(/Set Kitchen only on the recipe page\./.test(asCaller('ownerT', `select public.stock_save_recipe('{"id":"${rid}","restricted":false}', null, 1)`).message), 'the recipe save refuses the restricted key');
    // recharges by legal company
    sql(`insert into xero_connections (location_id, tenant_id, tenant_name) values ('${LOC2}', 'tenant-a', 'Kitchen Ltd'), ('${PROVO}', 'tenant-b', 'Provo Ltd')`);
    const st = callJ('ownerT', `select public.stock_recharge_statement('${ORG_T}', current_date)`).j;
    const kr = st && st.find((x) => x.from_location_id === LOC2 && x.to_location_id === PROVO);
    ok(kr && Math.abs(Number(kr.amount) - 28) < 0.01 && kr.from_tenant === 'Kitchen Ltd' && asCaller('mgrProvo', `select public.stock_recharge_statement('${ORG_T}', current_date)`).sqlstate === '42501',
      `the recharge statement: kitchen to Provo at the price paid (40 x 0.70 = 28) between two Xero companies; head office only (${short(kr, 160)})`);
    const rec1 = callJ('service', `select public.stock_recharge_record('${ORG_T}', current_date, '${LOC2}', '${PROVO}', 28, 'INV-X', 'BILL-X', null, 'xero')`);
    const rec2 = asCaller('service', `select public.stock_recharge_record('${ORG_T}', current_date, '${LOC2}', '${PROVO}', 28, 'INV-Y', null, null, 'xero')`);
    ok(rec1.j && rec1.j.ok && rec2.sqlstate === '55000' && /This month was already sent to Xero\./.test(rec2.message), 'a month posted with both ids is never sent again');
    // a kitchen standing order lands in Orders in
    sql(`delete from stock_order_rules where supplier_id = '${ks}';
         insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
         select '${ORG_T}', '${PROVO}', '${ks}', '${kitchenSup}', extract(dow from (z.n - interval '5 minutes')::date + 1), extract(dow from z.n - interval '5 minutes'), (z.n - interval '5 minutes')::time(0)
           from (select now() at time zone public.stock_co__tz('${PROVO}') as n) z;`);
    const sok = callJ('mgrProvo', `select public.stock_save_standing_order('{"location_id":"${PROVO}","supplier_id":"${ks}","delivery_dows":[${sql(`select extract(dow from (now() at time zone public.stock_co__tz('${PROVO}') - interval '5 minutes')::date + 1)::int`)}],"lines":[{"inventory_item_id":"${I.pButter}","supplier_product_id":"${ksp}","qty_packs":1}]}')`).j;
    sql(`select public.stock_po_cutoff_run()`);
    const spo = sql(`select po_id from stock_standing_runs where standing_order_id = '${sok && sok.id}'`);
    const sday = sql(`select expected_date from purchase_orders where id = '${spo}'`);
    ok(spo && sql(`select status from purchase_orders where id = '${spo}'`) === 'SENT' && num(`select count(*) from stock_po_send_jobs where po_id = '${spo}'`) === 0
       && (callJ('mgrLoc2', `select public.stock_kitchen_orders_in('${LOC2}', '${sday}')`).j || []).some((o) => o.po_id === spo),
      'a kitchen standing order is made SENT by the runner and lands in the kitchen\'s Orders in (no email)');
  });

  // ==========================================================================================================
  section(48, `48. Alerts staged once (multi site only); reads at ${SCALE} sites by 20 suppliers under 1 s a page; the runner with 1,000 standing orders`);
  await guarded('alerts and scale', async () => {
    fresh('n_d3_sc');
    const op = mkPO(PROVO, SUP.pDairy, [{ item: I.pButter, sp: SP.pButter, qty: 1, price: 30 }]);
    const os = mkPO(SOLO, SUP.sDrinks, [{ item: I.sWater, sp: SP.sWater, qty: 1, price: 9.6 }]);
    sql(`update purchase_orders set status = 'SENT', expected_date = current_date - 3 where id in ('${op}', '${os}')`);
    const tr = sql(`insert into stock_transfers (location_id, to_location_id, status, reference, sent_at) values ('${PROVO}', '${LOC2}', 'SENT', 'TR-OLD', now() - interval '3 hours') returning id`);
    const calls0 = num(`select count(*) from net.calls where url like '%stock-notify'`);
    sql(`select public.stock_notify_due()`);
    const n1 = num(`select count(*) from stock_notify_sent`);
    ok(num(`select count(*) from stock_notify_sent where kind = 'delivery_overdue' and ref = '${op}'`) === 1 && num(`select count(*) from stock_notify_sent where ref = '${os}'`) === 0
       && num(`select count(*) from stock_notify_sent where kind = 'transfer_waiting' and ref = '${tr}'`) === 1
       && num(`select count(*) from net.calls where url like '%stock-notify'`) === calls0 + 1, 'stock_notify_due stages the overdue delivery and the waiting transfer of the multi site company only, then calls stock-notify');
    sql(`select public.stock_notify_due()`);
    ok(num(`select count(*) from stock_notify_sent`) === n1, 'a second minute stages nothing new');
    // order_by (a cut off within the hour, nothing ordered), count_missed (a plan missed yesterday), count_due (an hour into the day)
    sql(`delete from stock_order_rules where supplier_id = '${SUP.pDry}';
         insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
         select '${ORG_T}', '${PROVO}', '${SUP.pDry}', '${supCo(SUP.pDry)}', extract(dow from (z.n + interval '30 minutes')::date + 1), extract(dow from z.n + interval '30 minutes'), (z.n + interval '30 minutes')::time(0)
           from (select now() at time zone public.stock_co__tz('${PROVO}') as n) z;`);
    const plan = callJ('ownerT', `select public.stock_save_count_plan('{"org_id":"${ORG_T}","name":"Daily","count_type":"SPOT","every":"day","sites":["${PROVO}"],"due_by":"00:00"}')`).j;
    sql(`update stock_count_plans set created_at = now() - interval '3 days' where id = '${plan.id}'`);
    sql(`select public.stock_notify_due()`);
    const crossesDay = sql(`select ((now() at time zone public.stock_co__tz('${PROVO}'))::date <> ((now() + interval '30 minutes') at time zone public.stock_co__tz('${PROVO}'))::date)`) === 't';
    ok(crossesDay || num(`select count(*) from stock_notify_sent where kind = 'order_by' and location_id = '${PROVO}' and ref like '${SUP.pDry}:%'`) === 1, 'order_by: a cut off within the hour with nothing ordered is staged once');
    ok(num(`select count(*) from stock_notify_sent where kind = 'count_missed' and ref like '${plan.id}:${PROVO}:%'`) === 1, 'count_missed: yesterday\'s plan with no count is staged once');
    const hourIn = sql(`select now() >= (select public.stock_co__day_start_at(public.stock_co__today('${PROVO}'), k.day_start, k.timezone) from public.stock_co__clock_of('${PROVO}') k) + interval '1 hour'`) === 't';
    ok(!hourIn || num(`select count(*) from stock_notify_sent where kind = 'count_due' and ref like '${plan.id}:${PROVO}:%'`) === 1, `count_due: staged an hour into the venue day${hourIn ? '' : ' (not yet an hour in: nothing staged, as the rule says)'}`);
    const n2 = num(`select count(*) from stock_notify_sent`);
    sql(`select public.stock_notify_due()`);
    ok(num(`select count(*) from stock_notify_sent`) === n2, 'and again nothing twice');
    const tg = callJ('service', `select public.stock_notify_targets(${num(`select id from stock_notify_sent where ref = '${op}'`)})`).j;
    ok(tg && tg.bell.length === 1 && tg.people.some((p) => p.user_id === U.mgrProvo), `who gets it: the bell at Provo and its site managers (${short(tg, 160)})`);
    ok(asCaller('mgrProvo', `select public.stock_notify_targets(1)`).sqlstate === '42501' && asCaller('mgrProvo', `select count(*) from stock_notify_sent`).sqlstate === '42501',
      'the ledger and its targets are the service role\'s only');
    // scale: a company with SCALE sites by 20 suppliers, each with two delivery days, orders, invoices and price history
    const ORG_SC = id('0f000000', 'f9');
    const scLoc = (n) => `e9000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const t0 = Date.now();
    sql(`insert into organisations (id, name) values ('${ORG_SC}', 'Scale company');
      insert into locations (id, org_id, name, timezone, currency, status) select ('e9000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, '${ORG_SC}', 'Scale ' || g, 'Europe/London', 'GBP', 'active' from generate_series(1, ${SCALE}) g;
      insert into stock_co_items (org_id, name, base_unit) select '${ORG_SC}', 'Scale item ' || g, 'each' from generate_series(1, 20) g;
      insert into stock_co_suppliers (org_id, name) select '${ORG_SC}', 'Scale supplier ' || g from generate_series(1, 20) g;
      insert into suppliers (location_id, org_id, name, company_ref) select l.id, l.org_id, c.name, c.id from locations l cross join stock_co_suppliers c where l.org_id = '${ORG_SC}' and c.org_id = '${ORG_SC}';
      insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
        select s.org_id, s.location_id, s.id, s.company_ref, d, (d + 6) % 7, '14:00' from suppliers s cross join (values (1), (4)) v(d) where s.org_id = '${ORG_SC}';
      insert into inventory_items (location_id, org_id, name, base_unit, current_cost, on_hand, company_ref)
        select l.id, l.org_id, i.name, 'each', 1, 0, i.id from locations l cross join stock_co_items i where l.org_id = '${ORG_SC}' and i.org_id = '${ORG_SC}';
      insert into purchase_orders (location_id, supplier_id, reference, status, expected_date, ordered_at, subtotal)
        select s.location_id, s.id, 'SC-' || g, case when g % 3 = 0 then 'RECEIVED' else 'SENT' end, current_date + (g % 5) - 2, now() - g * interval '1 hour', 100
          from suppliers s cross join generate_series(1, 3) g where s.org_id = '${ORG_SC}';
      insert into supplier_invoices (location_id, supplier_id, invoice_number, invoice_date, status, total)
        select s.location_id, s.id, 'SCI-' || s.id, current_date - 1, 'POSTED', 100 from suppliers s where s.org_id = '${ORG_SC}';`);
    console.log(`     scale company built: ${SCALE} sites, ${SCALE * 20} site suppliers (${Date.now() - t0} ms)`);
    const page = (label, fn, rowsKey = 'rows') => {
      let after = null; let n = 0; let worst = 0; let pages = 0;
      do {
        const r = callJ('superAdmin', `select public.${fn}('${ORG_SC}', null${after ? `, ${lit(JSON.stringify(after))}::jsonb` : ''})`);
        if (!r.j) { ok(false, `${label}: ${short(r.message, 200)}`); return; }
        worst = Math.max(worst, r.ms); pages++;
        const rows = rowsKey === 'board' ? [...r.j.today, ...r.j.coming, ...r.j.overdue, ...r.j.kitchen] : r.j[rowsKey];
        n += rows.length; after = r.j.next;
        if (rows.length > 100) { ok(false, `${label}: a page had ${rows.length} rows`); return; }
      } while (after && pages < 30);
      ok(worst < 1000, `${label}: ${n} rows in ${pages} pages of at most 100, the slowest page ${worst} ms (under 1 s, psql round trip included)`);
    };
    page('stock_due_to_order', 'stock_due_to_order');
    const op1 = callJ('superAdmin', `select public.stock_orders_page('${ORG_SC}', null)`);
    ok(op1.j && op1.j.rows.length === 100 && op1.ms < 1000, `stock_orders_page: the first page of 100 in ${op1.ms} ms`);
    page('stock_deliveries_board', 'stock_deliveries_board', 'board');
    const ip = callJ('superAdmin', `select public.stock_invoices_page('${ORG_SC}', null)`);
    const pp = callJ('superAdmin', `select public.stock_price_changes_page('${ORG_SC}', null)`);
    ok(ip.j && ip.j.rows.length === Math.min(100, SCALE * 20) && ip.ms < 1000 && pp.j && pp.ms < 1000, `stock_invoices_page ${ip.ms} ms, stock_price_changes_page ${pp.ms} ms`);
    // the runner with 1,000 standing orders due in one minute, while a sale holds an item row
    sql(`update stock_order_rules r set delivery_dow = extract(dow from (now() at time zone 'Europe/London' - interval '5 minutes')::date + 1),
           order_by_dow = extract(dow from now() at time zone 'Europe/London' - interval '5 minutes'), order_by_time = (now() at time zone 'Europe/London' - interval '5 minutes')::time(0)
          where r.org_id = '${ORG_SC}' and r.delivery_dow = 1;
         delete from stock_order_rules r where r.org_id = '${ORG_SC}' and r.delivery_dow <> extract(dow from (now() at time zone 'Europe/London' - interval '5 minutes')::date + 1);
         insert into supplier_products (location_id, inventory_item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price)
           select s.location_id, i.id, s.id, 1, 1, 'each', 2 from suppliers s join inventory_items i on i.location_id = s.location_id and i.name = replace(s.name, 'supplier', 'item') where s.org_id = '${ORG_SC}';
         insert into stock_standing_orders (org_id, location_id, supplier_id, company_supplier_id, delivery_dows)
           select s.org_id, s.location_id, s.id, s.company_ref, array[extract(dow from (now() at time zone 'Europe/London' - interval '5 minutes')::date + 1)::smallint]
             from suppliers s where s.org_id = '${ORG_SC}' limit 1000;
         insert into stock_standing_order_lines (standing_order_id, location_id, inventory_item_id, qty_packs)
           select o.id, o.location_id, i.id, 2 from stock_standing_orders o join suppliers s on s.id = o.supplier_id
             join inventory_items i on i.location_id = o.location_id and i.name = replace(s.name, 'supplier', 'item') where o.org_id = '${ORG_SC}';`);
    const total = num(`select count(*) from stock_standing_orders where org_id = '${ORG_SC}'`);
    let worst = 0; let calls = 0; let waitWorst = 0;
    const item = sql(`select id from inventory_items where location_id = '${scLoc(1)}' limit 1`);
    for (let k = 0; k < 8; k++) {
      const runner = c.psqlAsync({ input: `set statement_timeout = '8s'; select public.stock_po_cutoff_run();` });
      const sale = c.psqlAsync({ input: `begin; set lock_timeout = '1s'; select 1 from inventory_items where id = '${item}' for no key update; commit;` });
      const [a, b] = await Promise.all([runner, sale]);
      worst = Math.max(worst, a.ms); waitWorst = Math.max(waitWorst, b.ms); calls++;
      if (a.code !== 0 || b.code !== 0) { ok(false, `runner call ${k + 1}: ${short(a.err || b.err, 200)}`); break; }
      if (num(`select count(*) from stock_standing_runs r join stock_standing_orders o on o.id = r.standing_order_id where o.org_id = '${ORG_SC}'`) >= total) break;
    }
    const made = num(`select count(*) from stock_standing_runs r join stock_standing_orders o on o.id = r.standing_order_id where o.org_id = '${ORG_SC}' and r.status = 'sent'`);
    ok(made === total && worst < 8000, `the runner made all ${total} standing orders in ${calls} calls of at most 200, the slowest ${worst} ms (under 8 s)`);
    ok(waitWorst < 1000, `a sale locking an item row while the runner ran waited at most ${waitWorst} ms (no item lock held over 1 s)`);
  });

  // ==========================================================================================================
  section(49, '49. Every order channel basket identical; nothing moved a number by itself; the rollback; then Drop 3 again');
  await guarded('basket and rollback', () => {
    const BASKET = [
      { p: 'cp', loc: PROVO, menu: { a: M.pLatte, b: M.pFlat, c: M.pBoard }, dev: { till: 'tillProvo', kiosk: 'kioskProvo', mpos: 'mposProvo' }, presets: {},
        only: ['cash', 'card', 'split', 'kiosk', 'online', 'qrnow', 'qrtab', 'cater', 'cater-net', 'pat', 'mpos', 'hubrise', 'hr-cancel', 'ezcater', 'ref-uid', 'ref-full', 'void-made', 'booking', 'demo'] },
      { p: 'cl', loc: LOC2, menu: { a: M.lLatte, b: M.lSoup, c: M.lBread }, dev: { till: 'tillLoc2', kiosk: 'tillLoc2', mpos: 'tillLoc2' }, presets: {},
        only: ['cash', 'kiosk', 'online', 'qrtab', 'cater-net', 'pat', 'mpos', 'hubrise', 'ezcater', 'ref-uid', 'ref-full', 'void-made', 'booking', 'demo'] },
      { p: 'cs', loc: SOLO, menu: { a: M.sWater, b: M.sWater, c: M.sWater }, dev: { till: 'tillSolo', kiosk: 'tillSolo', mpos: 'tillSolo' }, presets: {},
        only: ['cash', 'kiosk', 'ref-uid', 'void-made', 'booking', 'demo'] },
    ];
    const t0 = Date.now() - 3600000;
    const drain = () => sql('call public.stock_outbox_drain(10, 50, 0.05, true);');
    const runBasket = () => {
      const problems = [];
      const evs = BASKET.map((v) => ({ v, e: basketEvents({ ...v, t0, price: PRICE }) }));
      for (const phase of ['A', 'B', 'C']) {
        for (const { v, e } of evs) for (const ev of e.filter((z) => z.phase === phase)) {
          const r = asCaller(ev.caller, phase === 'A' ? ev.sql : `${ev.sql} returning id`);
          if (r.status !== 0) problems.push(`${v.p} ${phase} ${ev.name}: ${outcome(r)}`);
        }
        drain();
      }
      for (let k = 0; k < 3; k++) { for (const v of BASKET) sql(basketTimeArrives(v.p)); drain(); }
      return { out: BASKET.map((v) => sql(basketBookedSql(v.p, t0))).join('|'), problems };
    };
    c.createFrom('n_d3_bk_pre', PRE);
    c.use('n_d3_bk_pre');
    const a = runBasket();
    fresh('n_d3_bk_post');
    const b = runBasket();
    ok(a.problems.length === 0 && b.problems.length === 0, `the basket books on both copies (${[...a.problems, ...b.problems].slice(0, 3).join('; ') || 'no problems'})`);
    ok(a.out === b.out && a.out.length > 100, `every channel books identical movements, waste and outbox events before and after Drop 3 (till, card, split, kiosk, online, QR, catering, pay at table, MPOS, HubRise, ezCater, refunds, voids) (${a.out.length} chars)`);
    // the new basket rows on the same copy: a standing order sent by the runner, waste over the limit from the till
    sql(`delete from stock_order_rules where supplier_id = '${SUP.pDry}';
         insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow, order_by_dow, order_by_time)
         select '${ORG_T}', '${PROVO}', '${SUP.pDry}', '${supCo(SUP.pDry)}', extract(dow from (z.n - interval '5 minutes')::date + 1), extract(dow from z.n - interval '5 minutes'), (z.n - interval '5 minutes')::time(0)
           from (select now() at time zone public.stock_co__tz('${PROVO}') as n) z;`);
    const nb = allNumbers();
    const so = callJ('mgrProvo', `select public.stock_save_standing_order('{"location_id":"${PROVO}","supplier_id":"${SUP.pDry}","delivery_dows":[${sql(`select extract(dow from (now() at time zone public.stock_co__tz('${PROVO}') - interval '5 minutes')::date + 1)::int`)}],"lines":[{"inventory_item_id":"${I.pCups}","qty_packs":1}]}')`).j;
    sql(`select public.stock_po_cutoff_run(); select public.stock_notify_due();`);
    const after = allNumbers().split('|').map(pj); const bef = nb.split('|').map(pj);
    ok(so && after.every((x, k) => JSON.stringify(x.items) === JSON.stringify(bef[k].items) && JSON.stringify(x.ledger) === JSON.stringify(bef[k].ledger) && x.counts === bef[k].counts),
      'the runner and the alerts move no on hand, cost, ledger or count number by themselves (a standing order is an order, not stock)');
    sql(`insert into stock_co_site_settings (location_id, org_id, waste_pin_over_value) values ('${PROVO}', '${ORG_T}', 1) on conflict (location_id) do update set waste_pin_over_value = 1`);
    const wt = callJ('tillProvo', `select public.stock_record_waste('${PROVO}', '{"kind":"item","inventory_item_id":"${I.pBeans}","qty_base":2,"reason":"Spoilage","source":"pos","pin":"4321"}')`);
    ok(wt.j && wt.j.ok && num(`select count(*) from stock_movements where source_id = '${wt.j.id}' and movement_type = 'WASTE'`) === 1 && onHandEqLedger(PROVO),
      'waste over the PIN limit from the till with a manager PIN takes stock off once');
    // the rollback
    c.use(T0);
    c.createFrom('n_d3_rb', T0);
    c.use('n_d3_rb');
    const r = c.paste(D3RB);
    ok(r.status === 0, `the rollback applies (${r.status ? short(r.stderr, 600) : `${r.ms} ms`})`);
    if (r.status !== 0) return;
    const last = (r.sets[r.sets.length - 1] || { rows: [] }).rows[0] || {};
    ok(Number(last.bodies_restored) === 10 && Number(last.tables_dropped) === 25 && Number(last.cron_jobs) === 0 && Number(last.site_rows_changed) === 0 && !tf(last.orders_changed),
      `its check row: ${short(last, 300)}`);
    ok(D3_BODIES.filter(([s]) => D3_REPLACED.includes(s.slice(7, s.indexOf('(')))).every(([sig, m]) => md5Of(sig) === m), 'the 10 bodies are back by md5');
    ok(JSON.stringify(FNS()) === JSON.stringify(before.fns), 'every function is exactly as before Drop 3');
    const cols = (db) => { c.use(db); return sql(`select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, column_name)) from information_schema.columns where table_schema = 'public'`)
      + sql(`select md5(string_agg(tablename || ':' || policyname || ':' || coalesce(qual, ''), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public'`)
      + sql(`select md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname)) from pg_constraint where connamespace = 'public'::regnamespace`); };
    const colsRb = cols('n_d3_rb'); const colsPre = cols(PRE);
    c.use('n_d3_rb');
    ok(colsRb === colsPre, 'every column, read rule and constraint of public is exactly as before Drop 3 (the CHECK back to five values)');
    ok(allNumbers() === before.numbers && menuMd5() === before.menu && loginsMd5() === before.logins, 'numbers, menu rows and logins unchanged');
    ok(num(`select count(*) from stock_native_backup where left(name, 3) = 'd3:'`) === 0 && num(`select count(*) from cron.job where jobname in ('stock-notify', 'po-cutoff-run')`) === 0
       && num(`select count(*) from vault.secrets where name in ('stock_notify_cron_key', 'po_cutoff_cron_key')`) === 0
       && sql(`select count(*) from storage.buckets where id = 'stock-invoice-inbox'`) === '1', 'the d3: rows, the cron jobs and the keys are gone; the inbox bucket and its files are kept');
    const again = c.paste(null, { input: d3Text });
    ok(again.status === 0, `Drop 3 applies again after its rollback (${again.status ? short(again.stderr, 400) : `${again.ms} ms`})`);
    // the rollback refuses while a transfer is REQUESTED
    c.createFrom('n_d3_rb2', T0);
    c.use('n_d3_rb2');
    callJ('mgrLoc2', `select public.stock_request_transfer('${PROVO}', '${LOC2}', '[{"company_item_id":"${coOf(I.pButter)}","qty_base":1}]')`);
    const rr = c.paste(D3RB);
    ok(rr.status !== 0 && /Some transfers are REQUESTED or DISPUTED\. Cancel or resolve them first\. Nothing was changed\./.test(rr.stderr), `the rollback refuses while a transfer is REQUESTED (${short(rr.error, 100)})`);
  });
}
