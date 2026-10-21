// drop1.mjs: proves Drop 1 of multi site stock (supabase/migrations/20261024a_OPS_stock_native_1.sql and its
// rollback) on the throwaway Ops shaped database run.mjs built, after 0a, its revalue file and 0b (sections 19
// to 25 of run.mjs). It never connects to Supabase.
//
//   19  the paste: the guard (no 0b, a second run, a changed body, not Ops), the check row, no site row,
//       login or link changes, categories and order rules seeded, the round trip
//   20  every new table (RLS, grants, read rule, second step fence, no write policy), column and trigger;
//       every new function (definer, search path, grants, the anon key refused)
//   21  the Stock control levels with real roles and JWT claims and the live limits
//   22  the pages: keyset paging with name ties, every filter, scope by group, a manager's own sites,
//       100 rows a page under 1 s at 5,000 items by 50 sites (10 with --quick)
//   23  set sites, pause, Change prices (preview, live, dated), import, Copy a site, category rename, order
//       rules, make company record, site groups, suggestions, nightly health and Fix; every bulk over 200
//       rows queued and finished by the runner with sales running, no runner step over 1 s, no dead
//       outbox event, nothing moving an on hand, cost or ledger number by itself
//   24  every order channel books exactly the same before and after Drop 1
//   25  the rollback (the 24 Drop 0 bodies back by md5, numbers unchanged), then Drop 1 again
//
// Ids and neutral words only (the repo is public).

import { readFileSync } from 'node:fs';
import { venueFigures, figureDiff, lit, jlit } from './base.mjs';
import { ORG_T, PROVO, LOC2, SOLO, U, I, SUP, SP, TAX, CALLERS, id } from './fixtures.mjs';
import { channelEvents, refundEvent, drainSql, bookedSql } from './channels.mjs';
import { normDeliveryDays, nextDeliveryYmd } from '../../functions/_shared/purchasingRules.js';
// the web's own builders, so a check sends exactly what a screen sends
import { supplierItemSaveArgs } from '../../../src/lib/stock/saveRules.js';
import { toStageRows } from '../../../src/lib/stock/importMappers.js';

// The 24 bodies Drop 1 rebuilds and their live normalised md5 (contract section 1.1).
export const D1_REPLACED = [
  ['public.stock_co__allowed(text)', '1a61b7cf3384939cf5c602e547dd906e'],
  ['public.stock_co__clean(text,jsonb)', '0d6b3b3acb2648f2c554641327e7b897'],
  ['public.stock_co__guard(uuid,text,text,uuid[])', 'c224e1e46da49d27130c67751be35763'],
  ['public.stock_save_item(jsonb,jsonb,integer,text)', 'b97ba7787ce200ca960386fa9ea08a21'],
  ['public.stock_archive_item(uuid,integer,boolean,text)', '45f6b86f9cfe07fa956cd48673edb8a0'],
  ['public.stock_save_item_site(uuid,uuid,jsonb,integer,text)', '15a6251d811a4dc7b6d6ca6044003841'],
  ['public.stock_save_pack(jsonb,integer,text)', '39a2b6167347e083b98ef9893f37230e'],
  ['public.stock_archive_pack(uuid,integer,boolean,text)', '76e8ad8a870d692fd1de7864830a095a'],
  ['public.stock_set_pack_default(uuid,text,integer,text)', '247dfba7b4a240c89f9709f3c57006af'],
  ['public.stock_save_bridge(jsonb,integer,text)', 'e4d3e7233e00797b4d1e2b7871e75f88'],
  ['public.stock_archive_bridge(uuid,integer,boolean,text)', 'd447b7f0985b5ba7ce13ab5aa92f6862'],
  ['public.stock_save_supplier(jsonb,jsonb,integer,text)', '807f4a60bb08ff6f989eab8a2c344f50'],
  ['public.stock_archive_supplier(uuid,integer,boolean,text)', 'b73aaff7b2dcc8d96774757ec6b8a227'],
  ['public.stock_save_supplier_site(uuid,uuid,jsonb,integer,text)', '30aeea13c057aac577f8917d2a3cd8df'],
  ['public.stock_save_supplier_item(jsonb,integer,text)', '9489d7b6c52c7c01c330f0d5a124b9b2'],
  ['public.stock_save_supplier_item_site(uuid,uuid,jsonb,integer,text)', '6208c21ed8d450631238c8cfafedf9ea'],
  ['public.stock_archive_supplier_item(uuid,integer,boolean,text)', 'de5581c5e3fd99a1c155f836531bc3f0'],
  ['public.stock_save_recipe(jsonb,jsonb,integer,text)', '49574e0d8e9768cfb643296dabd71804'],
  ['public.stock_archive_recipe(uuid,integer,boolean,text)', 'f9e6e10b9363442894fdb897ebce5a41'],
  ['public.stock_link_menu_item(uuid,text,uuid,numeric,text)', 'c346686e8608256779bbf21e9dc9cdf4'],
  ['public.stock_co__run_job(bigint)', '79b49ec0f5087d6ff36460f2147d0c2f'],
  ['public.stock_save_queue_run(integer)', 'c51af18907f35ff136334ff7461f9ae5'],
  ['public.stock_nightly_upkeep()', '6f74ec2cf9499fb6412090b143149e8d'],
  ['public.stock_item_detail(uuid)', '237948f39a88613c62e381d1d843e28a'],
];
// The 11 bodies Drop 1 only checks.
export const D1_CHECKED = [
  ['public.stock_site_scope(uuid)', 'e0b54f5aaea4f330e2300248b721141d'],
  ['public.stock_co__sync_site(uuid,uuid[],uuid[],boolean,boolean)', '68980e8bc9d49446950d5389d924d6e8'],
  ['public.stock_co__sync_recipes(uuid,uuid[],boolean,boolean)', '77d43d74e1791813cffdf82254f650ad'],
  ['public.stock_co__new_site_item(uuid,uuid,text,boolean)', '329060038c9d43bad9c2aa9302b4f271'],
  ['public.stock_co__new_site_supplier(uuid,uuid)', '913b98491c7234340131c604108e789b'],
  ['public.stock_co__set_preferred(uuid,uuid,uuid,boolean)', 'a7518aaa97ce5809aafa0854d9056c4d'],
  ['public.stock_co__currency_check(uuid)', 'bee1118bc131abf7c9c83b88a3c85897'],
  ['public.stock_co__run_sites(uuid,uuid,uuid[],uuid[],uuid[],uuid[],bigint,timestamptz)', '7eeb435c8c677730049190e85456fd4a'],
  ['public.stock_co__venue_day(uuid,timestamptz)', '8c9513db8ec56ddb68a1a3f247360742'],
  ['public.stock_changes_page(text,uuid,jsonb,integer)', 'eae7ebd02ee5c5681f3a248942fb28e4'],
  ['public.stock_co__org_guard()', '000c0e067df8ab8197dee16872fa79b4'],
];
// The functions of contract 1.6 and who may run them.
export const D1_NEW = [
  ['public.stock_items_page(uuid,uuid[],text,jsonb,jsonb,integer)', ['authenticated']],
  ['public.stock_item_used_in(uuid,jsonb,integer)', ['authenticated']],
  ['public.stock_suppliers_page(uuid,uuid[],text,jsonb,jsonb,integer)', ['authenticated']],
  ['public.stock_supplier_detail(uuid)', ['authenticated']],
  ['public.stock_prices_page(uuid,uuid,text,jsonb,integer)', ['authenticated']],
  ['public.stock_needs_attention(uuid,uuid[])', ['authenticated']],
  ['public.stock_paused_items(uuid)', ['authenticated', 'service_role']],
  ['public.stock_golive_plan(uuid)', ['authenticated']],
  ['public.stock_import_check(uuid,jsonb,integer)', ['authenticated']],
  ['public.stock_set_item_sites(uuid[],uuid[],jsonb,text)', ['authenticated']],
  ['public.stock_pause_items(uuid[],uuid[],date,date,boolean,text)', ['authenticated']],
  ['public.stock_change_prices(jsonb,boolean,text)', ['authenticated']],
  ['public.stock_cancel_dated_price(uuid,text)', ['authenticated']],
  ['public.stock_import_stage(uuid,jsonb,jsonb)', ['authenticated']],
  ['public.stock_import_commit(uuid,uuid[])', ['authenticated']],
  ['public.stock_import_cancel(uuid)', ['authenticated']],
  ['public.stock_copy_site(uuid,uuid,text)', ['authenticated']],
  ['public.stock_save_order_rules(uuid,uuid,jsonb,integer,text)', ['authenticated']],
  ['public.stock_copy_order_rules(uuid,uuid,uuid[],text)', ['authenticated']],
  ['public.stock_save_category(jsonb,integer,text)', ['authenticated']],
  ['public.stock_archive_category(uuid,integer,boolean,text)', ['authenticated']],
  ['public.stock_save_settings(uuid,jsonb,integer)', ['authenticated']],
  ['public.stock_make_company_record(text,uuid,integer,text)', ['authenticated']],
  ['public.stock_save_golive_step(uuid,jsonb,integer)', ['authenticated']],
  ['public.stock_save_site_group(jsonb)', ['authenticated']],
  ['public.stock_delete_site_group(uuid)', ['authenticated']],
  ['public.stock_suggest_change(text,uuid,text)', ['authenticated']],
  ['public.stock_resync_site(uuid)', ['authenticated']],
  ['public.stock_nightly_health(uuid)', ['service_role']],
];
export const D1_TABLES = {
  stock_order_rules: { grants: ['authenticated', 'service_role'], read: 'stock_reach_locations' },
  stock_co_dated_prices: { grants: ['authenticated', 'service_role'], read: 'both' },
  stock_co_import_jobs: { grants: ['service_role'], read: null },
  stock_co_import_rows: { grants: ['service_role'], read: null },
  stock_co_categories: { grants: ['authenticated', 'service_role'], read: 'stock_reach_orgs' },
  stock_co_golive_steps: { grants: ['authenticated', 'service_role'], read: 'stock_reach_locations' },
  stock_co_site_health: { grants: ['authenticated', 'service_role'], read: 'stock_reach_locations' },
};
const D1_KINDS = ['set_sites', 'pause', 'change_prices', 'import_commit', 'copy_site', 'category_rename', 'resync_site'];

export async function drop1Sections(ctx) {
  const { c, ok, section, guarded, FILES, QUICK, SCALE_SITES = QUICK ? 10 : 50, SCALE_ITEMS = 5000 } = ctx;
  const sql = (q, o) => c.sql(q, o);
  const num = (q, o) => c.num(q, o);
  const short = (x, n = 160) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);
  const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const tf = (v) => v === 't' || v === 'true';
  const MAIN = c.DB;

  // -- callers, as run.mjs makes them (authenticator, SET ROLE, claims, the live limits) ---------------------
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
    const cl = CALLERS[key];
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
  const outcome = (r) => (r.j?.ok === false ? `ok false: ${short(r.j.error, 80)}` : r.sqlstate ? `${r.sqlstate} ${short(r.message, 90)}` : r.status !== 0 ? `fail:${short(r.message, 80)}` : 'ok');
  const want = (r, w) => (w === 'ok' ? r.status === 0 && (r.j == null || r.j.ok !== false) : w.startsWith('words:') ? r.message === w.slice(6) : r.sqlstate === w);
  const T = (who, what, r, w) => ok(want(r, w), `${CALLERS[who].what}: ${what} ${w === 'ok' ? 'allowed' : `refused ${w.startsWith('words:') ? `'${w.slice(6)}'` : w}`} (${outcome(r)})`);
  const coRef = (table, rid) => sql(`select coalesce(company_ref::text, '') from public.${table} where id = '${rid}'`);
  const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  const tableExists = (t) => sql(`select to_regclass('public.${t}') is not null`) === 't';
  const runQueue = (secs = 30) => sql(`call public.stock_save_queue_run(${secs});`);
  const drain = () => sql(drainSql);
  const onHandEqLedger = (loc) => num(`select count(*) from inventory_items i where i.location_id = '${loc}'
     and i.on_hand <> coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)`) === 0;
  const ledgerGap = (loc) => num(`select coalesce(max(abs(coalesce((select sum(m.value_delta) from stock_movements m where m.inventory_item_id = i.id), 0)
     - i.on_hand * coalesce(i.current_cost, 0))), 0) from inventory_items i where i.location_id = '${loc}'`);
  const VENUES = [PROVO, LOC2, SOLO];
  const VNAME = { [PROVO]: 'Provo', [LOC2]: 'Location 2', [SOLO]: 'Solo venue' };
  const profileSnap = () => sql(`select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from user_profiles t`);
  const linkSnap = () => sql(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from user_locations t`);
  const fns = () => Object.fromEntries(sql(`select p.oid::regprocedure::text || '=' || md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)
    .split('\n').filter(Boolean).map((l) => { const k = l.lastIndexOf('='); return [l.slice(0, k), l.slice(k + 1)]; }));
  const lastRows = (r) => (r.sets[r.sets.length - 1] || { rows: [] }).rows;
  // drive the queue: every waiting job one step at a time (each its own transaction, as the runner does),
  // each step timed; returns { steps, slowest, failed }
  function runJobs(maxSteps = 4000) {
    let steps = 0; let slowest = 0; const ran = new Set();
    for (;;) {
      const next = sql(`select coalesce(min(id)::text, '') from stock_save_queue where status = 'waiting' and due_at <= now()`);
      if (!next || steps >= maxSteps) break;
      const t0 = Date.now();
      sql(`select public.stock_co__run_job(${next});`);
      slowest = Math.max(slowest, Date.now() - t0);
      steps++; ran.add(next);
    }
    const failed = ran.size ? num(`select count(*) from stock_save_queue where status = 'failed' and id in (${[...ran].join(',')})`) : 0;
    const errors = ran.size ? sql(`select coalesce(string_agg(distinct left(last_error, 120), ' / '), '') from stock_save_queue where status = 'failed' and id in (${[...ran].join(',')})`) : '';
    return { steps, slowest, failed, errors };
  }
  // every order channel through the real drainer (as run.mjs section 5)
  const chanVenues = [
    { prefix: 'dp', loc: PROVO, menu: { a: 'm-latte', b: 'm-flat', c: 'm-board' }, dev: { till: 'tillProvo', kiosk: 'kioskProvo', mpos: 'mposProvo' } },
    { prefix: 'dl', loc: LOC2, menu: { a: 'm-latte_949f370e', b: 'm-soup_949f370e', c: 'm-bread_949f370e' }, dev: { till: 'tillLoc2', kiosk: 'tillLoc2', mpos: 'tillLoc2' } },
    { prefix: 'ds', loc: SOLO, menu: { a: 'm-water', b: 'm-water', c: 'm-water' }, dev: { till: 'tillSolo', kiosk: 'tillSolo', mpos: 'tillSolo' } },
  ];
  function runChannels() {
    const out = {}; const problems = [];
    for (const v of chanVenues) {
      for (const e of channelEvents(v.prefix, v.loc, v.menu, v.dev)) {
        const r = asCaller(e.caller, e.sql);
        if (r.status !== 0) problems.push(`${v.prefix} ${e.name}: ${outcome(r)}`);
      }
      drain();
      const rf = refundEvent(v.prefix, v.menu, v.dev);
      const r = asCaller(rf.caller, rf.sql);
      if (r.status !== 0) problems.push(`${v.prefix} refund: ${outcome(r)}`);
      drain();
      out[v.loc] = pj(sql(bookedSql(v.prefix, v.loc)));
    }
    return { out, problems };
  }

  // == 19. The paste ======================================================================================================================
  section(19, '19. Drop 1 as the SQL editor runs it: the guard, the check row, nothing at the sites or logins moves, the seeds');
  let chanBefore = null;
  let preCount = 0;
  await guarded('d1 guard', () => {
    c.use(MAIN);
    sql(`analyze;`);
    c.createFrom('n_pre_d1', MAIN);
    // every channel before Drop 1, on a copy (section 24 compares)
    c.createFrom('n_d1_chan_pre', MAIN);
    c.use('n_d1_chan_pre');
    const ch = runChannels();
    chanBefore = ch.out;
    ok(ch.problems.length === 0, `before Drop 1: every channel writes its check (${ch.problems.join('; ') || 'all written'})`);
    // refuses without 0b
    c.createFrom('n_d1_no0b', MAIN);
    c.use('n_d1_no0b');
    let r = c.paste(FILES.bRb);
    ok(r.status === 0, `a copy with 0b rolled back (${r.status ? short(r.stderr, 200) : 'ok'})`);
    r = c.paste(FILES.d1);
    ok(r.status !== 0 && /Run 20261022a_OPS_stock_native_0b\.sql first\. Nothing was changed\./.test(r.stderr) && !tableExists('stock_order_rules'),
      `without 0b Drop 1 refuses in plain words and changes nothing (${short(r.error, 120)})`);
    // a changed body
    c.createFrom('n_d1_body', MAIN);
    c.use('n_d1_body');
    const def = sql(`select pg_get_functiondef('public.stock_site_scope(uuid)'::regprocedure)`);
    sql(def.replace(/AS \$function\$/, 'AS $function$\n-- a later change'));
    r = c.paste(FILES.d1);
    ok(r.status !== 0 && /A stock function changed since this file was written\. Ask Claude for a new file\./.test(r.stderr) && /stock_site_scope/.test(r.stderr)
       && !tableExists('stock_order_rules'), `a changed body: refused, naming it, nothing changed (${short(r.error, 160)})`);
    // not Ops
    c.createFrom('n_d1_notops', MAIN);
    c.use('n_d1_notops');
    sql(`create table public.billing_state (id integer)`);
    r = c.paste(FILES.d1);
    ok(r.status !== 0 && /This is not the Ops database/.test(r.stderr) && !tableExists('stock_order_rules'), `on another database: refused, nothing changed (${short(r.error, 100)})`);
    // the paste itself
    c.use(MAIN);
    const figBefore = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
    const profBefore = profileSnap();
    const linkBefore = linkSnap();
    const fnBefore = fns();
    preCount = Object.keys(fnBefore).length;
    const expect = pj(sql(`select json_object_agg(o.org_id, json_build_object(
        'cats', (select count(distinct lower(btrim(i.category))) from stock_co_items i where i.org_id = o.org_id and nullif(btrim(coalesce(i.category, '')), '') is not null),
        'with', (select count(*) from stock_co_items i where i.org_id = o.org_id and nullif(btrim(coalesce(i.category, '')), '') is not null),
        'without', (select count(*) from stock_co_items i where i.org_id = o.org_id and nullif(btrim(coalesce(i.category, '')), '') is null),
        'rules', (select coalesce(sum((select count(distinct lower(left(btrim(e #>> '{}'), 3))) from jsonb_array_elements(case when jsonb_typeof(s.delivery_days) = 'array' then s.delivery_days else '[]' end) e
                                       where lower(left(btrim(e #>> '{}'), 3)) in ('mon','tue','wed','thu','fri','sat','sun'))), 0)
                    from suppliers s join locations l on l.id = s.location_id where l.org_id = o.org_id and s.company_ref is not null),
        'no_cut', (select count(*) from suppliers s join locations l on l.id = s.location_id
                    where l.org_id = o.org_id and s.company_ref is not null and coalesce(s.cutoff_time, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')))
      from (select distinct l.org_id from locations l where l.org_id is not null
              and (exists (select 1 from inventory_items i where i.location_id = l.id) or exists (select 1 from suppliers s where s.location_id = l.id))) o`));
    r = c.paste(FILES.d1);
    ok(r.status === 0, `Drop 1 applies as one paste (${r.status ? short(r.stderr, 500) : `${r.ms} ms`})`);
    const rows = lastRows(r);
    console.log(`     check row: ${short(rows, 900)}`);
    ok(rows.length === Object.keys(expect || {}).length && rows.length > 0, `one check row per company that holds stock (${rows.length})`);
    for (const row of rows) {
      const e = expect[row.org_id] || {};
      const multi = row.org_id === ORG_T;
      ok(tf(row.multi) === multi && Number(row.categories_seeded) === e.cats && Number(row.items_with_category) === e.with && Number(row.items_without_category) === e.without,
        `${row.org_id.slice(0, 8)}: multi ${row.multi}, categories ${row.categories_seeded} (${e.cats} expected), items with ${row.items_with_category} / without ${row.items_without_category}`);
      ok(Number(row.order_rules_seeded) === e.rules && Number(row.suppliers_without_cutoff) === e.no_cut && Number(row.bad_delivery_day_values) === 0
         && Number(row.order_rules_round_trip_bad) === 0,
        `${row.org_id.slice(0, 8)}: ${row.order_rules_seeded} order rules (${e.rules} expected), ${row.order_rules_without_order_by} with no order by, ${row.suppliers_without_cutoff} suppliers with no cut off, 0 bad day values, 0 round trip misses`);
      ok(Number(row.replaced_functions) === 24 && Number(row.new_functions) === D1_NEW.length && row.internals_open_to_api === 'f' && row.anon_can_save === 'f',
        `${row.org_id.slice(0, 8)}: 24 bodies replaced, ${row.new_functions} new functions, no internal helper open to the API, the anon key saves nothing`);
      ok(row.levels_on === 'refused, par ok' && row.site_rows_changed === '0' && row.logins_changed === 'f',
        `${row.org_id.slice(0, 8)}: the levels dry run '${row.levels_on}', site rows changed ${row.site_rows_changed}, logins changed ${row.logins_changed}`);
    }
    const figAfter = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
    for (const v of VENUES) {
      const d = figureDiff(figBefore[v], figAfter[v]);
      ok(d.length === 0, `${VNAME[v]}: every site row, on hand, cost, ledger, area holding, par and recipe line exactly as before (${d.join(', ') || 'no difference'})`);
    }
    ok(profileSnap() === profBefore && linkSnap() === linkBefore, 'no user_profiles or user_locations row changed (nobody\'s login, role or link)');
    const fnAfter = fns();
    const changed = Object.keys(fnBefore).filter((k) => fnAfter[k] !== fnBefore[k]).sort();
    ok(changed.length === 24 && changed.every((k) => D1_REPLACED.some(([s]) => k.startsWith(s.slice(7, s.indexOf('(')) + '('))),
      `only the 24 named bodies changed among the functions there before (${changed.length}: ${changed.filter((k) => !D1_REPLACED.some(([s]) => k.startsWith(s.slice(7, s.indexOf('(')) + '('))).join(', ') || 'all named'})`);
    ok(num(`select count(*) from stock_native_backup where name like 'd1:%'`) === 24, 'the 24 replaced bodies are in stock_native_backup (d1:...)');
    // the second run
    r = c.paste(FILES.d1);
    ok(r.status !== 0 && /Drop 1 has run already\. Nothing was changed\./.test(r.stderr), `a second paste refuses: 'Drop 1 has run already. Nothing was changed.' (${short(r.error, 80)})`);
    // the seeds
    const catBad = num(`select count(*) from stock_co_items i where nullif(btrim(coalesce(i.category, '')), '') is not null
                          and (i.category_id is null or (select lower(c.name) from stock_co_categories c where c.id = i.category_id) <> lower(btrim(i.category)))`);
    ok(catBad === 0, 'every item with a free text category points at the category of that name (lower case, trimmed)');
    ok(num(`select count(*) from stock_change_log where entity = 'item' and field = 'category_id'`) === 0
       && num(`select count(*) from stock_co_items where row_version > 1 and updated_at > now() - interval '1 minute'`) === 0,
      'the category seed is not an edit: no version bump, no change log row');
    const trip = num(`select count(*) from suppliers s cross join lateral public.stock_co__derive_days(s.id) d
                        where s.company_ref is not null
                          and ((select coalesce(array_agg(distinct lower(left(btrim(x), 3)) order by lower(left(btrim(x), 3))), '{}') from jsonb_array_elements_text(s.delivery_days) x)
                               is distinct from (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(d.delivery_days) x)
                               or nullif(s.cutoff_time, '') is distinct from d.cutoff_time)
                          and coalesce(s.cutoff_time, '') ~ '^(([01][0-9]|2[0-3]):[0-5][0-9])?$'`);
    ok(trip === 0, `round trip: every seeded site supplier row's days (as a set, read the way the Order pad reads them) and cut off come back the same from its order rules (${trip} differ)`);
    ok(num(`select count(*) from stock_order_rules where order_by_dow is not null and order_by_dow <> (delivery_dow + 6) % 7`) === 0,
      'each seeded rule orders by the day before its delivery');
  });

  // == 20. Tables, columns, triggers, functions ====================================================================================
  section(20, '20. What Drop 1 made: tables (RLS, grants, read rule, second step fence, no write policy), columns, triggers, functions and their grants');
  await guarded('d1 inventory', () => {
    c.use(MAIN);
    for (const [t, spec] of Object.entries(D1_TABLES)) {
      ok(sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`) === 't', `${t}: row level security on`);
      const g = sql(`select coalesce(string_agg(distinct grantee || ':' || privilege_type, ',' order by grantee || ':' || privilege_type), '')
                       from information_schema.role_table_grants where table_schema = 'public' and table_name = '${t}' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`);
      ok(g === spec.grants.map((r) => `${r}:SELECT`).join(','), `${t}: grants exactly select to ${spec.grants.join(' and ')} (${g || 'none'})`);
      const pol = sql(`select coalesce(string_agg(policyname || ':' || permissive || ':' || cmd, ',' order by policyname), '') from pg_policies where schemaname = 'public' and tablename = '${t}'`);
      const wantPol = [spec.read ? `${t}_read:PERMISSIVE:SELECT` : null, 'second_step_fence:RESTRICTIVE:ALL'].filter(Boolean).sort().join(',');
      ok(pol === wantPol, `${t}: policies ${pol} (no write policy)`);
      if (spec.read) {
        const q = sql(`select qual from pg_policies where schemaname = 'public' and tablename = '${t}' and policyname = '${t}_read'`);
        ok(spec.read === 'both' ? /stock_reach_locations/.test(q) && /stock_reach_orgs/.test(q) : q.includes(spec.read) && !/user_accessible_locations/.test(q),
          `${t}: the read rule reads ${spec.read === 'both' ? 'the site by stock_reach_locations and the company by stock_reach_orgs' : spec.read}`);
      }
    }
    const cols = sql(`select string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, column_name) from information_schema.columns
                       where table_schema = 'public' and ((table_name = 'stock_co_items' and column_name = 'category_id')
                          or (table_name = 'stock_co_item_sites' and column_name in ('paused_from', 'paused_until'))
                          or (table_name = 'stock_co_site_groups' and column_name = 'row_version'))`);
    ok(cols === 'stock_co_item_sites.paused_from:date,stock_co_item_sites.paused_until:date,stock_co_items.category_id:uuid,stock_co_site_groups.row_version:integer', `the four new columns (${cols})`);
    ok(sql(`select count(*) from pg_constraint where conname in ('stock_co_item_sites_pause_days', 'stock_order_rules_order_by_pair', 'stock_order_rules_one_per_day')`) === '3'
       && sql(`select count(*) from pg_indexes where indexname in ('stock_co_items_category', 'stock_co_dated_prices_one_waiting', 'stock_co_dated_prices_due', 'stock_co_dated_prices_si', 'stock_order_rules_loc', 'stock_co_categories_name_uniq', 'stock_co_import_rows_new_name')`) === '7',
      'the CHECKs (pause days, order by pair, one rule a day) and the seven indexes (the import rows one finds a name made earlier in the same file)');
    const trg = sql(`select string_agg(tgrelid::regclass::text || '.' || tgname, ',' order by tgrelid::regclass::text, tgname) from pg_trigger where not tgisinternal and tgname in ('stock_co_d1_org_guard', 'stock_co_items_category_guard')`);
    ok(trg.split(',').length === 7 && /stock_co_items\.stock_co_items_category_guard/.test(trg), `the company guard trigger on the six new company tables and the category guard on stock_co_items (${trg})`);
    for (const [sig, roles] of D1_NEW) {
      const facts = sql(`select p.prosecdef || '|' || coalesce((select substr(x, 13) from unnest(p.proconfig) x where x like 'search_path=%'), '')
                              || '|' || coalesce((select string_agg(r, ',' order by r) from unnest(array['anon','authenticated','service_role','public']) r
                                                  where case when r = 'public' then exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
                                                             else has_function_privilege(r, p.oid, 'execute') end), '')
                         from pg_proc p where p.oid = to_regprocedure('${sig}')`);
      ok(facts === `true|public, pg_temp|${roles.join(',')}`, `${sig.slice(7, sig.indexOf('('))}: definer, search path public, pg_temp, EXECUTE to ${roles.join(' and ')} only (${facts})`);
    }
    const open = sql(`select coalesce(string_agg(p.proname, ', '), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ '^stock_co__'
                        and p.proname not in ('stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock')
                        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))`);
    ok(open === '', `every internal helper (stock_co__) is owner only, except writer_ok and the three 0b lock functions as 0a and 0b left them (${open || 'none open'})`);
    for (const [sig] of D1_REPLACED) {
      const f = sql(`select has_function_privilege('anon', to_regprocedure('${sig}'), 'execute')`);
      ok(f === 'f', `${sig.slice(7, sig.indexOf('('))}: closed to the anon key`);
    }
    const anonR = asCaller('anonKey', `select public.stock_items_page('${ORG_T}', null)`);
    ok(anonR.sqlstate === '42501', `the anon key cannot run stock_items_page (${outcome(anonR)})`);
    const anonW = asCaller('anonKey', `select public.stock_set_item_sites(array['${coRef('inventory_items', I.pMilk)}']::uuid[], array['${LOC2}']::uuid[], null)`);
    ok(anonW.sqlstate === '42501', `the anon key cannot run stock_set_item_sites (${outcome(anonW)})`);
    const nh = callJ('ownerT', `select public.stock_nightly_health('${PROVO}')`);
    ok(nh.sqlstate === '42501', `a signed in owner cannot run stock_nightly_health (service role only) (${outcome(nh)})`);
    const nhs = callJ('service', `select public.stock_nightly_health('${PROVO}')`);
    ok(nhs.status === 0 && nhs.j?.location_id === PROVO, `the service role runs stock_nightly_health (${outcome(nhs)})`);
    const ps = callJ('service', `select public.stock_paused_items('${PROVO}')`);
    ok(ps.status === 0 && Array.isArray(ps.j?.rows), `the service role reads stock_paused_items (manager-approve) (${outcome(ps)})`);
  });

  // == 21. The levels ==================================================================================================================
  section(21, '21. The Stock control levels, switched on (real roles and JWT claims, the live 8 s limit)');
  await guarded('d1 levels', () => {
    c.use(MAIN);
    sql(`update user_profiles set stock_control = 'sites_full' where id = '${U.mgrFull}'; update user_profiles set stock_control = 'all' where id in ('${U.mgrAll}', '${U.mgrAllPurch}');`);
    const verItem = (siteItem) => num(`select row_version from inventory_items where id = '${siteItem}'`);
    const link = (siteItem) => num(`select row_version from stock_co_item_sites where site_item_id = '${siteItem}'`);
    const rename = (who, siteItem, loc, name, v = verItem(siteItem)) => callJ(who, `select public.stock_save_item(${jlit({ site_item_id: siteItem, location_id: loc, name })}, null, ${v == null ? 'null' : v}, 'inventory')`);
    const par = (who, siteItem, loc, p, v = null) => callJ(who, `select public.stock_save_item_site('${siteItem}', '${loc}', ${jlit({ par_level: p })}, ${v == null ? 'null' : v}, 'inventory')`);
    const HO = 'words:Not allowed: this is set by head office.';
    const HP = 'words:Not allowed: prices and the supplier here are set by head office.';
    T('ownerT', 'company item rename at Provo', rename('ownerT', I.pEggs, PROVO, 'Free Range Eggs'), 'ok');
    T('superAdmin', 'company item rename at Provo', rename('superAdmin', I.pEggs, PROVO, 'Free Range Eggs'), 'ok');
    T('ownerX', 'company item rename at Provo (owner of ANOTHER company: Their sites here)', rename('ownerX', I.pEggs, PROVO, 'X'), HO);
    T('ownerX', 'par at Provo', par('ownerX', I.pMilk, PROVO, 25), 'ok');
    T('ownerNoOrg', 'company item rename at Provo (role owner with no company: Their sites)', rename('ownerNoOrg', I.pEggs, PROVO, 'X'), HO);
    T('ownerNoOrg', 'par at Provo', par('ownerNoOrg', I.pMilk, PROVO, 26), 'ok');
    const supV = num(`select row_version from suppliers where id = '${SUP.pDry}'`);
    T('mgrAllPurch', 'supplier save (Stock control all, Purchasing)', callJ('mgrAllPurch', `select public.stock_save_supplier(${jlit({ site_supplier_id: SUP.pDry, location_id: PROVO, contact_name: 'Orders desk' })}, null, ${supV}, 'purchasing')`), 'ok');
    T('mgrAllPurch', 'item save (no Inventory section)', callJ('mgrAllPurch', `select public.stock_save_item(${jlit({ site_item_id: I.lCups, location_id: LOC2, name: 'Cups 12oz' })}, null, ${verItem(I.lCups)}, 'inventory')`), '42501');
    T('mgrAll', 'company item rename at Location 2 (Stock control all)', rename('mgrAll', I.lCups, LOC2, 'Cups 12oz'), 'ok');
    // a plain site manager (Their sites)
    T('mgrProvo', 'company item rename at Provo', rename('mgrProvo', I.pEggs, PROVO, 'X'), HO);
    T('mgrProvo', 'par at Provo (null version: no check, as Drop 0)', par('mgrProvo', I.pMilk, PROVO, 27), 'ok');
    ok(num(`select par_level from par_levels where location_id = '${PROVO}' and inventory_item_id = '${I.pMilk}'`) === 27, 'and the par is written');
    const loc = callJ('mgrProvo', `select public.stock_save_item(${jlit({ location_id: PROVO, name: 'House Sauce', base_unit: 'l' })}, null, null, 'inventory')`);
    T('mgrProvo', 'a new local item at its own site', loc, 'ok');
    const localId = loc.j?.id;
    ok(localId && sql(`select local_location_id from stock_co_items where id = '${localId}'`) === PROVO, 'it is a local record of Provo (local_location_id)');
    T('mgrProvo', 'editing its own local item', callJ('mgrProvo', `select public.stock_save_item(${jlit({ id: localId, location_id: PROVO, name: 'House Sauce 2' })}, null, 1, 'inventory')`), 'ok');
    T('mgrProvo', 'a pack on its own local item', callJ('mgrProvo', `select public.stock_save_pack(${jlit({ item_id: localId, location_id: PROVO, name: 'Bottle', qty_in_base: 0.5 })}, null, 'inventory')`), 'ok');
    T('mgrProvo', 'price here at Provo', callJ('mgrProvo', `select public.stock_save_item_site('${I.pButter}', '${PROVO}', ${jlit({ price_here: 31 })}, ${link(I.pButter)}, 'inventory')`), HP);
    const siButter = coRef('supplier_products', SP.pButter);
    T('mgrProvo', 'supplier here at Provo', callJ('mgrProvo', `select public.stock_save_item_site('${I.pButter}', '${PROVO}', ${jlit({ supplier_here: siButter })}, ${link(I.pButter)}, 'inventory')`), HP);
    T('mgrProvo', 'price here through stock_save_supplier_item_site', callJ('mgrProvo', `select public.stock_save_supplier_item_site('${siButter}', '${PROVO}', ${jlit({ price_here: 30.0 })}, 1)`), HP);
    T('mgrProvo', 'a direct update of a company column (0b lock)', asCaller('mgrProvo', `update inventory_items set name = name || ' x' where id = '${I.pBeans}'`), '42501');
    T('mgrProvo', 'tick items on at its site (stock_set_item_sites)', callJ('mgrProvo', `select public.stock_set_item_sites(array['${coRef('inventory_items', I.pMilk)}']::uuid[], array['${PROVO}']::uuid[], null, 'inventory')`), HP);
    T('mgrProvo', 'a company category', callJ('mgrProvo', `select public.stock_save_category(${jlit({ org_id: ORG_T, name: 'Sneaky' })}, null, 'inventory')`), HO);
    T('mgrProvo', 'order rules', callJ('mgrProvo', `select public.stock_save_order_rules('${SUP.pDairy}', '${PROVO}', '[]', 1, 'purchasing')`), HO);
    T('mgrProvo', 'a suggestion on a company item it can see', callJ('mgrProvo', `select public.stock_suggest_change('item', '${I.pEggs}', 'Two trays please')`), 'ok');
    // sites_full
    const siLButter = coRef('supplier_products', SP.lButter);
    T('mgrFull', 'price here at its own site (Their sites, full control)', callJ('mgrFull', `select public.stock_save_item_site('${I.lButter}', '${LOC2}', ${jlit({ price_here: 29 })}, ${link(I.lButter)}, 'inventory')`), 'ok');
    T('mgrFull', 'supplier here at its own site', callJ('mgrFull', `select public.stock_save_item_site('${I.lButter}', '${LOC2}', ${jlit({ supplier_here: siLButter })}, ${link(I.lButter)}, 'inventory')`), 'ok');
    T('mgrFull', 'price here at Provo (another site)', callJ('mgrFull', `select public.stock_save_item_site('${I.pButter}', '${PROVO}', ${jlit({ price_here: 29 })}, ${link(I.pButter)}, 'inventory')`), '42501');
    T('mgrFull', 'company item rename', rename('mgrFull', I.lCups, LOC2, 'X'), HO);
    T('mgrFull', 'Change prices of the company price (it moves Provo too)', callJ('mgrFull', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siLButter], how: 'percent', value: 5 })}, true, 'inventory')`), '42501');
    T('mgrAll', 'Change prices of the company price (Stock control all)', callJ('mgrAll', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siLButter], how: 'percent', value: 5 })}, true, 'inventory')`), 'ok');
    T('mgrFull', 'Change prices here at its own site (preview)', callJ('mgrFull', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siLButter], sites: [LOC2], how: 'percent', value: 5 })}, true, 'inventory')`), 'ok');
    // area manager over two sites
    T('areaMgr', 'company item rename (Their sites over two sites)', rename('areaMgr', I.pEggs, PROVO, 'X'), HO);
    T('areaMgr', 'par at Provo', par('areaMgr', I.pMilk, PROVO, 28), 'ok');
    T('areaMgr', 'par at Location 2', par('areaMgr', I.lMilk, LOC2, 14), 'ok');
    // the one site company: exactly Drop 0's rights
    T('soloMgr', 'company item rename (one site company)', rename('soloMgr', I.sWater, SOLO, 'Bottled Water'), 'ok');
    T('soloMgr', 'free text category (one site company keeps it)', callJ('soloMgr', `select public.stock_save_item(${jlit({ site_item_id: I.sWater, location_id: SOLO, category: 'Soft drinks' })}, null, ${verItem(I.sWater)}, 'inventory')`), 'ok');
    ok(sql(`select c.name from stock_co_items i join stock_co_categories c on c.id = i.category_id where i.id = '${coRef('inventory_items', I.sWater)}'`) === 'Soft drinks', 'and its company category is kept in step');
    T('soloMgr', 'price here (one site company)', callJ('soloMgr', `select public.stock_save_item_site('${I.sWater}', '${SOLO}', ${jlit({ price_here: 6.5 })}, ${link(I.sWater)}, 'inventory')`), 'ok');
    const sv = num(`select row_version from suppliers where id = '${SUP.sDrinks}'`);
    T('soloMgr', 'supplier delivery days and cut off on today\'s form', callJ('soloMgr', `select public.stock_save_supplier(${jlit({ site_supplier_id: SUP.sDrinks, location_id: SOLO, site: { delivery_days: ['mon', 'thu'], cutoff_time: '10:00' } })}, null, ${sv}, 'purchasing')`), 'ok');
    ok(sql(`select string_agg(delivery_dow || '/' || order_by_dow || '/' || to_char(order_by_time, 'HH24:MI'), ',' order by delivery_dow) from stock_order_rules where supplier_id = '${SUP.sDrinks}'`) === '1/0/10:00,4/3/10:00',
      'its order rules follow in the same call (Monday and Thursday, ordered the day before at 10:00)');
    T('soloMgr', 'par (one site company)', par('soloMgr', I.sWater, SOLO, 12), 'ok');
    T('soloOwner', 'company item rename (owner of the one site company)', rename('soloOwner', I.sWater, SOLO, 'Bottled Water'), 'ok');
    // multi site: free text category refused, delivery days on the form refused
    T('ownerT', 'free text category in a multi site company', callJ('ownerT', `select public.stock_save_item(${jlit({ site_item_id: I.pEggs, location_id: PROVO, category: 'Eggs' })}, null, ${verItem(I.pEggs)}, 'inventory')`), 'words:Pick a category from the list.');
    T('ownerT', 'delivery days on the supplier form in a multi site company', callJ('ownerT', `select public.stock_save_supplier(${jlit({ site_supplier_id: SUP.pDairy, location_id: PROVO, site: { delivery_days: ['mon'] } })}, null, ${num(`select row_version from suppliers where id = '${SUP.pDairy}'`)}, 'purchasing')`), 'words:Delivery days are set on the Order rules tab.');
    T('ownerT', 'p_sites on an existing item', callJ('ownerT', `select public.stock_save_item(${jlit({ site_item_id: I.pEggs, location_id: PROVO, name: 'Free Range Eggs' })}, ${jlit([{ location_id: LOC2, on: true }])}, ${verItem(I.pEggs)}, 'inventory')`), 'words:Tick sites on the Sites tab.');
    // the version rule
    T('ownerT', 'a company edit with no version', rename('ownerT', I.pEggs, PROVO, 'Free Range Eggs', null), 'words:This screen is out of date. Reload it, then save again.');
    T('ownerT', 'a par edit with no version (site facts keep Drop 0\'s rule)', par('ownerT', I.pMilk, PROVO, 29), 'ok');
    const old = rename('ownerT', I.pEggs, PROVO, 'Free Range Eggs', 1);
    ok(old.j?.ok === false && old.j.conflict && / saved this first at \d\d:\d\d\. Reload to see the change, then save again\.$/.test(old.j.error),
      `a company edit with an old version: nothing written, "saved this first" (${short(old.j?.error, 90)})`);
    // -- one site company: today's Stock items > Suppliers tab (StockItemsSplit, data.js upsertSupplierProduct) sends
    //    saveRules.supplierItemSaveArgs: purchase_tax_rate_id (null or a rate row) and site.is_preferred, always
    const spV = (id_) => num(`select row_version from supplier_products where id = '${id_}'`);
    const soloSave = (sp) => {
      const a = supplierItemSaveArgs(sp, SOLO, { section: 'inventory' });
      return callJ('soloMgr', `select public.stock_save_supplier_item(${jlit(a.p_si)}, ${a.p_version == null ? 'null' : a.p_version}, '${a.p_section}')`);
    };
    const soloSp = (over = {}) => ({ id: SP.sWater, inventoryItemId: I.sWater, supplierId: SUP.sDrinks, supplierSku: 'DR-W24', packDescription: 'Case of 24',
      packQty: 1, innerQty: 24, innerUnit: 'each', packPrice: 9.6, purchaseTaxRateId: null, priceIncludesTax: false, isPreferred: true, rowVersion: spV(SP.sWater), ...over });
    T('soloMgr', 'a supplier pack saved as today\'s one site Suppliers tab sends it (purchase_tax_rate_id null)', soloSave(soloSp()), 'ok');
    T('soloMgr', 'the same with a VAT rate row picked', soloSave(soloSp({ purchaseTaxRateId: TAX.sStd })), 'ok');
    ok(sql(`select purchase_tax_rate_id from supplier_products where id = '${SP.sWater}'`) === TAX.sStd, 'and the VAT rate row picked is kept on the pack');
    const soloCost0 = num(`select current_cost from inventory_items where id = '${I.sWater}'`);
    const soloNew = soloSave({ inventoryItemId: I.sWater, supplierId: SUP.sDrinks, packDescription: 'Case of 12', packQty: 1, innerQty: 12, innerUnit: 'each',
      packPrice: 6, purchaseTaxRateId: TAX.sStd, priceIncludesTax: false, isPreferred: true });
    T('soloMgr', 'a second supplier pack, saved as the preferred one (Set preferred)', soloNew, 'ok');
    const soloNewSp = soloNew.j?.site_supplier_product_id;
    ok(soloNewSp && sql(`select is_preferred from supplier_products where id = '${soloNewSp}'`) === 't' && sql(`select is_preferred from supplier_products where id = '${SP.sWater}'`) === 'f'
       && Math.abs(num(`select current_cost from inventory_items where id = '${I.sWater}'`) - 0.5) < 0.0001,
      `the preferred flag and the cost follow the new pack (cost ${soloCost0} to ${num(`select current_cost from inventory_items where id = '${I.sWater}'`)}, 6.00 for 12)`);
    T('soloMgr', 'Set preferred back to the first pack', soloSave(soloSp({ purchaseTaxRateId: TAX.sStd })), 'ok');
    ok(sql(`select is_preferred from supplier_products where id = '${SP.sWater}'`) === 't' && Math.abs(num(`select current_cost from inventory_items where id = '${I.sWater}'`) - soloCost0) < 0.0001,
      `and back: preferred again, the cost back at ${soloCost0}`);
    T('soloMgr', 'archive the second pack', callJ('soloMgr', `select public.stock_archive_supplier_item('${soloNewSp}', ${spV(soloNewSp)}, true, 'inventory')`), 'ok');

    // -- a plain site manager (Their sites) and a local supplier: a pack can never be moved to a company supplier, nor
    //    become the supplier here of a company item (that is Their sites, full control, as supplier_here is)
    const corner = callJ('mgrProvo', `select public.stock_save_supplier(${jlit({ name: 'Corner Shop', location_id: PROVO })}, null, null, 'purchasing')`);
    T('mgrProvo', 'a local supplier at its own site', corner, 'ok');
    const milkCoL = coRef('inventory_items', I.pMilk);
    const dairyCoL = coRef('suppliers', SUP.pDairy);
    // the preferred live packs, the default supplier and the cost of one site item
    const prefSnap = (item) => sql(`select coalesce(string_agg(sp.id::text, ',' order by sp.id) filter (where sp.is_preferred and sp.archived_at is null), '')
                                     || '|' || coalesce(t.default_supplier_id::text, '') || '|' || coalesce(t.current_cost::text, '')
                                      from inventory_items t left join supplier_products sp on sp.inventory_item_id = t.id
                                     where t.id = '${item}' group by t.id`);
    const provoMilk0 = prefSnap(I.pMilk);
    const cheap = callJ('mgrProvo', `select public.stock_save_supplier_item(${jlit({ item_id: milkCoL, supplier_id: corner.j?.id, location_id: PROVO, pack_price: 0.2, inner_qty: 2, inner_unit: 'l', supplier_product_name: 'Cheap milk' })}, null, 'inventory')`);
    T('mgrProvo', 'a pack of a company item from its local supplier (not preferred)', cheap, 'ok');
    const cheapV = () => num(`select row_version from stock_co_supplier_items where id = '${cheap.j?.id}'`);
    T('mgrProvo', 'moving that pack to a company supplier (it would show at Location 2)',
      callJ('mgrProvo', `select public.stock_save_supplier_item(${jlit({ id: cheap.j?.id, supplier_id: dairyCoL, location_id: PROVO, pack_qty: 3 })}, ${cheapV()}, 'inventory')`), HO);
    ok(sql(`select supplier_id from stock_co_supplier_items where id = '${cheap.j?.id}'`) === corner.j?.id
       && num(`select count(*) from stock_co_supplier_item_sites where supplier_item_id = '${cheap.j?.id}'`) === 1
       && num(`select count(*) from supplier_products where location_id = '${LOC2}' and pack_price = 0.2`) === 0,
      'nothing moved: still its local supplier, at Provo only, nothing new at Location 2');
    T('mgrProvo', 'making that pack the supplier here of a company item (site.is_preferred)',
      callJ('mgrProvo', `select public.stock_save_supplier_item(${jlit({ id: cheap.j?.id, location_id: PROVO, site: { is_preferred: true } })}, ${cheapV()}, 'inventory')`), HP);
    T('mgrProvo', 'a new local pack saved straight in as the supplier here of a company item',
      callJ('mgrProvo', `select public.stock_save_supplier_item(${jlit({ item_id: milkCoL, supplier_id: corner.j?.id, location_id: PROVO, pack_price: 0.15, inner_qty: 2, inner_unit: 'l', site: { is_preferred: true } })}, null, 'inventory')`), HP);
    ok(prefSnap(I.pMilk) === provoMilk0, 'the supplier here and the cost of milk at Provo did not move');
    T('mgrProvo', 'its local pack saved again, still not preferred (site facts)',
      callJ('mgrProvo', `select public.stock_save_supplier_item(${jlit({ id: cheap.j?.id, location_id: PROVO, pack_price: 0.25, site: { is_preferred: false } })}, ${cheapV()}, 'inventory')`), 'ok');
    T('mgrProvo', 'archive its local pack', callJ('mgrProvo', `select public.stock_archive_supplier_item('${cheap.j?.id}', ${cheapV()}, true, 'inventory')`), 'ok');
    // Their sites, full control: the supplier here at its own site, never at another
    const corner2 = callJ('mgrFull', `select public.stock_save_supplier(${jlit({ name: 'Corner Shop Two', location_id: LOC2 })}, null, null, 'purchasing')`);
    T('mgrFull', 'a local supplier at its own site', corner2, 'ok');
    const l2Milk0 = prefSnap(I.lMilk);
    const own = callJ('mgrFull', `select public.stock_save_supplier_item(${jlit({ item_id: coRef('inventory_items', I.lMilk), supplier_id: corner2.j?.id, location_id: LOC2, pack_price: 0.2, inner_qty: 2, inner_unit: 'l', site: { is_preferred: true } })}, null, 'inventory')`);
    T('mgrFull', 'its local pack as the supplier here of a company item at its own site', own, 'ok');
    ok(sql(`select is_preferred from supplier_products where id = '${own.j?.site_supplier_product_id}'`) === 't', 'and it is the supplier here at Location 2 now');
    T('mgrFull', 'the supplier here at Provo (another site)',
      callJ('mgrFull', `select public.stock_save_supplier_item(${jlit({ item_id: milkCoL, supplier_id: corner2.j?.id, location_id: PROVO, pack_price: 0.2, inner_qty: 2, inner_unit: 'l', site: { is_preferred: true } })}, null, 'inventory')`), '42501');
    T('mgrFull', 'the supplier here back to the first pack (supplier_here)',
      callJ('mgrFull', `select public.stock_save_item_site('${I.lMilk}', '${LOC2}', ${jlit({ supplier_here: coRef('supplier_products', SP.lMilk) })}, ${link(I.lMilk)}, 'inventory')`), 'ok');
    T('mgrFull', 'archive its local pack', callJ('mgrFull', `select public.stock_archive_supplier_item('${own.j?.id}', ${num(`select row_version from stock_co_supplier_items where id = '${own.j?.id}'`)}, true, 'inventory')`), 'ok');
    ok(prefSnap(I.lMilk) === l2Milk0, `the supplier here, the default supplier and the cost of milk at Location 2 are back as they were (${prefSnap(I.lMilk)})`);

    // -- Purchased or made, per site (map 4.2: it moved from Details to the Sites tab): company, with the item's version
    const eggsCo = coRef('inventory_items', I.pEggs);
    const coV = (cid) => num(`select row_version from stock_co_items where id = '${cid}'`);
    const lEggsShared = coRef('inventory_items', I.lEggs) === eggsCo;
    T('ownerT', 'Purchased or made at Provo: made here', callJ('ownerT', `select public.stock_save_item(${jlit({ id: eggsCo, location_id: PROVO, site: { kind: 'MADE' } })}, null, ${coV(eggsCo)}, 'inventory')`), 'ok');
    ok(sql(`select supply_mode from stock_co_item_sites where item_id = '${eggsCo}' and location_id = '${PROVO}'`) === 'batches' && sql(`select kind from inventory_items where id = '${I.pEggs}'`) === 'MADE'
       && (!lEggsShared || sql(`select kind from inventory_items where id = '${I.lEggs}'`) === 'PURCHASED'),
      `made at Provo only (the site row says MADE${lEggsShared ? ', Location 2 still buys it' : ''})`);
    T('mgrProvo', 'Purchased or made (a plain site manager)', callJ('mgrProvo', `select public.stock_save_item(${jlit({ id: eggsCo, location_id: PROVO, site: { kind: 'PURCHASED' } })}, null, ${coV(eggsCo)}, 'inventory')`), HO);
    T('ownerT', 'Sold directly at Provo', callJ('ownerT', `select public.stock_save_item(${jlit({ id: eggsCo, location_id: PROVO, site: { is_sellable: true } })}, null, ${coV(eggsCo)}, 'inventory')`), 'ok');
    ok(sql(`select is_sellable from inventory_items where id = '${I.pEggs}'`) === 't' && callJ('ownerT', `select public.stock_item_detail('${eggsCo}')`).j?.sites?.find((x) => x.location_id === PROVO)?.is_sellable === true,
      'Sold directly is kept and the item page reads it (is_sellable)');
    T('ownerT', 'back to purchased, not sold directly', callJ('ownerT', `select public.stock_save_item(${jlit({ id: eggsCo, location_id: PROVO, site: { kind: 'PURCHASED', is_sellable: false } })}, null, ${coV(eggsCo)}, 'inventory')`), 'ok');
    ok(sql(`select supply_mode from stock_co_item_sites where item_id = '${eggsCo}' and location_id = '${PROVO}'`) === 'bought' && sql(`select kind || '/' || is_sellable from inventory_items where id = '${I.pEggs}'`) === 'PURCHASED/false',
      'and back as it was');
    const madeNew = callJ('ownerT', `select public.stock_save_item(${jlit({ location_id: PROVO, name: 'House Batch Harness', base_unit: 'l', site: { kind: 'MADE' } })}, ${jlit([{ location_id: PROVO, on: true }, { location_id: LOC2, on: true }])}, null, 'inventory')`);
    T('ownerT', 'a new made item (Add item, Purchased or made: Made here) at two sites', madeNew, 'ok');
    ok(sql(`select string_agg(s.supply_mode || '/' || t.kind, ',' order by s.location_id) from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id where s.item_id = '${madeNew.j?.id}'`) === 'batches/MADE,batches/MADE',
      'made here at every site it starts at');
    // devices, customers, the anon key, no second step
    for (const dev of ['tillProvo', 'kioskProvo', 'mposProvo', 'customer']) {
      T(dev, 'the company item list', callJ(dev, `select public.stock_items_page('${ORG_T}', null)`), '42501');
      T(dev, 'tick items on', callJ(dev, `select public.stock_set_item_sites(array['${coRef('inventory_items', I.pMilk)}']::uuid[], array['${PROVO}']::uuid[], null)`), '42501');
    }
    T('anonKey', 'Change prices', callJ('anonKey', `select public.stock_change_prices('{}'::jsonb, true)`), '42501');
    T('noStep', 'the company item list without the second step', callJ('noStep', `select public.stock_items_page('${ORG_T}', null)`), 'words:Sign in to Back Office to change stock.');
    T('groupMgr', 'the item list of another company', callJ('groupMgr', `select public.stock_items_page('${ORG_T}', null)`), '42501');
    // owner only: site overrides in settings
    const setV = num(`select row_version from stock_co_settings where org_id = '${ORG_T}'`);
    T('mgrAll', 'company settings (Stock control all)', callJ('mgrAll', `select public.stock_save_settings('${ORG_T}', ${jlit({ week_start: 1 })}, ${setV})`), 'ok');
    T('mgrAll', 'a site override in settings (owner only)', callJ('mgrAll', `select public.stock_save_settings('${ORG_T}', ${jlit({ sites: [{ location_id: LOC2, waste_pin_over_value: 20 }] })}, ${num(`select row_version from stock_co_settings where org_id = '${ORG_T}'`)})`), '42501');
    T('ownerT', 'a site override in settings', callJ('ownerT', `select public.stock_save_settings('${ORG_T}', ${jlit({ sites: [{ location_id: LOC2, waste_pin_over_value: 20 }] })}, ${num(`select row_version from stock_co_settings where org_id = '${ORG_T}'`)})`), 'ok');
    ok(num(`select waste_pin_over_value from stock_co_site_settings where location_id = '${LOC2}'`) === 20, 'and the override is stored for Location 2');
    T('mgrAll', 'Copy a site (company)', callJ('mgrAll', `select public.stock_copy_site('${PROVO}', '${LOC2}', 'inventory')`), 'ok');
    sql(`delete from stock_save_queue where kind = 'copy_site' and status = 'waiting'`);
    ok(sql(`select string_agg(distinct coalesce(stock_control, 'null'), ',') from user_profiles where id in ('${U.mgrProvo}', '${U.mgrLoc2}', '${U.ownerX}', '${U.ownerNoOrg}', '${U.areaMgr}')`) === 'null',
      'no Stock control level was changed by Drop 1 (the harness set only the three test levels itself)');
  });

  // == 22. The pages ===================================================================================================================
  section(22, `22. The pages: keyset paging, filters, scope; 100 rows under 1 s at ${SCALE_ITEMS} items by ${SCALE_SITES} sites`);
  await guarded('d1 pages', async () => {
    c.use(MAIN);
    const page = (who, args) => callJ(who, `select public.stock_items_page(${args})`);
    const walk = (who, org, sites, filters, limit) => {
      const seen = []; let after = null; let pages = 0; let worst = 0;
      do {
        const r = page(who, `'${org}', ${sites ? `array[${sites.map((s) => `'${s}'`).join(',')}]::uuid[]` : 'null'}, null, ${filters ? jlit(filters) : 'null'}, ${after ? jlit(after) : 'null'}, ${limit}`);
        if (r.status !== 0) return { error: outcome(r) };
        seen.push(...r.j.rows.map((x) => x.id)); after = r.j.next; pages++; worst = Math.max(worst, r.ms);
        if (pages > 400) break;
      } while (after);
      return { seen, pages, worst };
    };
    const full = page('ownerT', `'${ORG_T}', null, null, null, null, 100`).j;
    const w = walk('ownerT', ORG_T, null, null, 2);
    ok(!w.error && w.seen.length === full.rows.length && new Set(w.seen).size === w.seen.length && JSON.stringify(w.seen) === JSON.stringify(full.rows.map((x) => x.id)),
      `pages of 2 (name ties included: three Brioche Bun) give every row once, in order (${w.seen?.length} rows in ${w.pages} pages, ${full.rows.length} in one page)`);
    ok(full.total === full.rows.length && full.rows.some((x) => x.name_suffix === '(2)'), `the first page says the total (${full.total}) and twins carry "(2)" for display only`);
    ok(page('ownerT', `'${ORG_T}', null, null, null, null, 500`).j?.rows.length <= 100, 'p_limit is capped at 100');
    const cat = sql(`select category_id from stock_co_items where org_id = '${ORG_T}' and category_id is not null group by category_id order by count(*) desc limit 1`);
    const fc = page('ownerT', `'${ORG_T}', null, null, ${jlit({ category_id: cat })}`).j;
    ok(fc.rows.length > 0 && fc.rows.every((x) => x.category_id === cat), `filter category (${fc.rows.length} rows)`);
    const fl2 = page('ownerT', `'${ORG_T}', null, null, ${jlit({ on_at: LOC2 })}`).j;
    ok(fl2.rows.length > 0 && fl2.rows.every((x) => x.sites.some((s) => s.location_id === LOC2 && s.on)), `filter on at Location 2 (${fl2.rows.length} rows)`);
    const fna = page('ownerT', `'${ORG_T}', null, null, ${jlit({ not_at: LOC2 })}`).j;
    ok(fna.rows.length > 0 && fna.rows.every((x) => !x.sites.some((s) => s.location_id === LOC2 && s.on)) && fna.rows.length + fl2.rows.length === full.total,
      `filter not at Location 2 (${fna.rows.length}; with "on at" they make the whole list)`);
    const dairy = coRef('suppliers', SUP.pDairy);
    const fs = page('ownerT', `'${ORG_T}', null, null, ${jlit({ supplier_id: dairy })}`).j;
    ok(fs.rows.length > 0 && fs.rows.length === num(`select count(distinct item_id) from stock_co_supplier_items where supplier_id = '${dairy}' and archived_at is null`), `filter supplier (${fs.rows.length})`);
    const fs2 = page('ownerT', `'${ORG_T}', null, 'brio'`).j;
    ok(fs2.rows.length === 3 && fs2.rows.every((x) => /brioche/i.test(x.name)), `search by name, case blind (${fs2.rows.length})`);
    const fLocal = page('ownerT', `'${ORG_T}', null, null, ${jlit({ local: true })}`).j;
    ok(fLocal.rows.length >= 1 && fLocal.rows.every((x) => x.local_location_id), `filter local (${fLocal.rows.length})`);
    const milkCo = coRef('inventory_items', I.pMilk);
    callJ('ownerT', `select public.stock_pause_items(array['${milkCo}']::uuid[], array['${PROVO}']::uuid[], null, null, true, 'inventory')`);
    const fp = page('ownerT', `'${ORG_T}', null, null, ${jlit({ paused: true })}`).j;
    ok(fp.rows.length === 1 && fp.rows[0].id === milkCo && fp.rows[0].sites.find((s) => s.location_id === PROVO)?.paused === true, `filter paused (${fp.rows.length})`);
    callJ('ownerT', `select public.stock_pause_items(array['${milkCo}']::uuid[], array['${PROVO}']::uuid[], null, null, false, 'inventory')`);
    sql(`update par_levels set reorder_point = (select on_hand + 5 from inventory_items where id = '${I.pButter}') where location_id = '${PROVO}' and inventory_item_id = '${I.pButter}';
         insert into par_levels (location_id, inventory_item_id, reorder_point) select '${PROVO}', '${I.pButter}', on_hand + 5 from inventory_items where id = '${I.pButter}' on conflict do nothing;`);
    const flow = page('ownerT', `'${ORG_T}', null, null, ${jlit({ on_at: PROVO, low: true })}`).j;
    ok(flow.rows.some((x) => x.id === coRef('inventory_items', I.pButter)), `filter low at a site (${flow.rows.length})`);
    const fu = page('ownerT', `'${ORG_T}', null, null, ${jlit({ colour: 'red' })}`);
    ok(fu.sqlstate === '22023', `an unknown filter is refused 22023 (${outcome(fu)})`);
    // filter ids: a screen that saved one cell reads only that row again (CompanyItemList refreshRows)
    const fullNow = page('ownerT', `'${ORG_T}', null, null, null, null, 100`).j;
    const ids3 = [fullNow.rows[0].id, fullNow.rows[Math.floor(fullNow.rows.length / 2)].id, fullNow.rows[fullNow.rows.length - 1].id];
    const fi = page('ownerT', `'${ORG_T}', null, null, ${jlit({ ids: ids3 })}`).j;
    ok(fi && fi.rows.length === 3 && JSON.stringify(fi.rows) === JSON.stringify(fullNow.rows.filter((x) => ids3.includes(x.id))),
      'filter ids: only those rows, each exactly as the full page has it, in list order');
    const fl2Now = page('ownerT', `'${ORG_T}', null, null, ${jlit({ on_at: LOC2 })}`).j;
    const fiOn = page('ownerT', `'${ORG_T}', null, null, ${jlit({ ids: ids3, on_at: LOC2 })}`).j;
    ok(fiOn && JSON.stringify(fiOn.rows.map((x) => x.id)) === JSON.stringify(fl2Now.rows.filter((x) => ids3.includes(x.id)).map((x) => x.id)),
      `filter ids keeps every other filter (with on at Location 2: ${fiOn?.rows.length} of 3), so a row that no longer fits drops out`);
    const fiMgr = page('mgrProvo', `'${ORG_T}', null, null, ${jlit({ ids: fullNow.rows.map((x) => x.id).slice(0, 100) })}`).j;
    const mgrAll = page('mgrProvo', `'${ORG_T}', null`).j;
    ok(fiMgr && fiMgr.rows.every((x) => mgrAll.rows.some((y) => y.id === x.id)) && fiMgr.rows.every((x) => x.sites.every((z) => z.location_id === PROVO)),
      `filter ids never widens what a login sees (a Provo manager asking for every id gets ${fiMgr?.rows.length}, Provo only)`);
    const fi101 = page('ownerT', `'${ORG_T}', null, null, ${jlit({ ids: Array.from({ length: 101 }, (_, k) => id('f9b00000', k.toString(16))) })}`);
    ok(fi101.message === 'The filter "ids" must be a list of up to 100 items.', `101 ids: refused (${outcome(fi101)})`);
    const fiBad = page('ownerT', `'${ORG_T}', null, null, ${jlit({ ids: ['not an id'] })}`);
    ok(fiBad.sqlstate === '22023', `an id that is not an id: refused 22023 (${outcome(fiBad)})`);
    // a manager sees only its own sites; scope by group
    const mp = page('mgrProvo', `'${ORG_T}', null`).j;
    ok(mp && JSON.stringify(mp.sites) === JSON.stringify([PROVO]) && mp.rows.every((x) => x.sites.every((s) => s.location_id === PROVO) && (x.sites.length > 0 || x.local_location_id === PROVO)),
      `a Provo manager: scope is Provo only, every row is linked at Provo or local to it, no Location 2 figure shown (${mp?.rows.length} rows)`);
    const grp = callJ('ownerT', `select public.stock_save_site_group(${jlit({ org_id: ORG_T, name: 'Group L2', location_ids: [LOC2] })})`);
    T('ownerT', 'a site group', grp, 'ok');
    const g2 = page('ownerT', `'${ORG_T}', array['${LOC2}']::uuid[]`).j;
    ok(g2.sites.length === 1 && g2.rows.every((x) => x.sites.every((s) => s.location_id === LOC2)), `scope by a group's sites (${g2.rows.length} rows at Location 2)`);
    const mx = page('mgrProvo', `'${ORG_T}', array['${LOC2}']::uuid[]`);
    ok(mx.sqlstate === '42501', `a Provo manager naming Location 2 only: refused (${outcome(mx)})`);
    // suppliers and prices pages
    const sAll = callJ('ownerT', `select public.stock_suppliers_page('${ORG_T}', null, null, null, null, 100)`).j;
    let after = null; const sSeen = [];
    do { const r = callJ('ownerT', `select public.stock_suppliers_page('${ORG_T}', null, null, null, ${after ? jlit(after) : 'null'}, 2)`).j; sSeen.push(...r.rows.map((x) => x.id)); after = r.next; } while (after && sSeen.length < 500);
    ok(sAll.rows.length > 0 && JSON.stringify(sSeen) === JSON.stringify(sAll.rows.map((x) => x.id)), `stock_suppliers_page: pages of 2 give every supplier once, in order (${sSeen.length})`);
    const pAll = callJ('ownerT', `select public.stock_prices_page('${dairy}', null, null, null, 100)`).j;
    after = null; const pSeen = [];
    do { const r = callJ('ownerT', `select public.stock_prices_page('${dairy}', null, null, ${after ? jlit(after) : 'null'}, 1)`).j; pSeen.push(...r.rows.map((x) => x.supplier_item_id)); after = r.next; } while (after && pSeen.length < 500);
    ok(pAll.rows.length > 0 && JSON.stringify(pSeen) === JSON.stringify(pAll.rows.map((x) => x.supplier_item_id)), `stock_prices_page: pages of 1 give every supplier pack once, in order (${pSeen.length})`);
    const sd = callJ('ownerT', `select public.stock_supplier_detail('${dairy}')`).j;
    ok(sd && sd.sites.length >= 1 && sd.sites.every((s) => Array.isArray(s.rules)), `stock_supplier_detail: its sites with their order rules (${sd?.sites.length})`);
    // A company supplier no site can order from (its last site unticked): head office still opens it and
    // its packs page, so a site can be ticked on again; a sites manager is still refused (integrator, Drop 1).
    const LONE = 'f9a00000-0000-4000-8000-000000000001';
    sql(`insert into stock_co_suppliers (id, org_id, name) values ('${LONE}', '${ORG_T}', 'Unlinked Harness Supplier')`);
    const ld = callJ('ownerT', `select public.stock_supplier_detail('${LONE}')`);
    ok(ld.status === 0 && ld.j?.local === false && Array.isArray(ld.j?.sites) && ld.j.sites.length === 0, `stock_supplier_detail: head office opens a company supplier with no site (${ld.status === 0 ? `${ld.j?.sites?.length} sites` : outcome(ld)})`);
    const lp = callJ('ownerT', `select public.stock_prices_page('${LONE}', null, null, null, 100)`);
    ok(lp.status === 0 && Array.isArray(lp.j?.rows) && lp.j.rows.length === 0, `stock_prices_page: head office reads a company supplier with no site (${lp.status === 0 ? `${lp.j?.rows?.length} rows` : outcome(lp)})`);
    const lm = callJ('mgrProvo', `select public.stock_supplier_detail('${LONE}')`);
    ok(lm.sqlstate === '42501', `stock_supplier_detail: a Provo manager is refused a supplier with no site in reach (${outcome(lm)})`);
    const lmp = callJ('mgrProvo', `select public.stock_prices_page('${LONE}', null, null, null, 100)`);
    ok(lmp.sqlstate === '42501', `stock_prices_page: a Provo manager is refused a supplier with no site in reach (${outcome(lmp)})`);
    // ...and the Sites tab's tick (p_sites only, no other key) puts it back at Provo.
    const lt = callJ('ownerT', `select public.stock_save_supplier(${jlit({ id: LONE })}, ${jlit([{ location_id: PROVO, on: true }])}, ${ld.j?.row_version ?? 1}, 'purchasing')`);
    const ld2 = callJ('ownerT', `select public.stock_supplier_detail('${LONE}')`);
    ok(want(lt, 'ok') && ld2.j?.sites?.length === 1 && ld2.j.sites[0].location_id === PROVO && ld2.j.sites[0].can_order === true,
      `a company supplier with no site: ticking Provo on links it there again (${outcome(lt)}; ${ld2.j?.sites?.length} sites)`);
    const loneSite = sql(`select coalesce(string_agg(site_supplier_id::text, ','), '') from stock_co_supplier_sites where supplier_id = '${LONE}'`);
    sql(`delete from stock_save_queue where '${LONE}' = any(entity_ids);
         delete from stock_order_rules where company_ref = '${LONE}';
         delete from stock_co_supplier_sites where supplier_id = '${LONE}';
         ${loneSite ? `delete from suppliers where id in (${loneSite.split(',').map((x) => `'${x}'`).join(', ')});` : ''}
         delete from stock_co_suppliers where id = '${LONE}';`);
    ok(num(`select count(*) from stock_co_suppliers where id = '${LONE}'`) === 0, 'the unlinked supplier check leaves nothing behind');
    const na = callJ('ownerT', `select public.stock_needs_attention('${ORG_T}', null)`).j;
    ok(na && na.rows.length === 2 && na.rows.every((x) => 'below_zero' in x && 'health' in x), 'stock_needs_attention: one row per site in scope');
    const na51 = callJ('ownerT', `select public.stock_needs_attention('${ORG_T}', array(select gen_random_uuid() from generate_series(1, 51)))`);
    ok(na51.message === 'Pick 50 sites or fewer.', `more than 50 sites: 'Pick 50 sites or fewer.' (${outcome(na51)})`);
    const ui = callJ('ownerT', `select public.stock_item_used_in('${milkCo}', null, 100)`).j;
    ok(ui && ui.rows.length > 0 && ui.rows.every((x) => ['dish', 'batch', 'prep'].includes(x.kind)), `stock_item_used_in: the recipes using milk (${ui?.rows.length})`);
    const det = callJ('ownerT', `select public.stock_item_detail('${milkCo}')`).j;
    ok(det && 'count_pack' in det && 'catching_up' in det && det.sites.every((s) => 'price_here' in s && 'why_on' in s && 'last_paid' in s && 'can_order_suppliers' in s) && 'category_name' in det.item,
      'stock_item_detail keeps every Drop 0 key and adds the Drop 1 ones');

    // -- scale: a big company built on a copy ------------------------------------------------------------------------------
    c.createFrom('n_d1_scale', MAIN);
    c.use('n_d1_scale');
    const BIG = id('0e000000', 'f1');
    const OWNER = id('10000000', 'f1');
    const MGR = id('10000000', 'f2');
    CALLERS.ownerD1 = { login: 'authenticator', role: 'authenticated', claims: { sub: OWNER, role: 'authenticated', is_anonymous: false, aud: 'authenticated', aal: 'aal2' }, what: 'owner of the big company' };
    CALLERS.mgrD1 = { login: 'authenticator', role: 'authenticated', claims: { sub: MGR, role: 'authenticated', is_anonymous: false, aud: 'authenticated', aal: 'aal2' }, what: 'manager at big site 01' };
    const S = (n) => `f2000000-0000-4000-8000-${String(n.toString(16)).padStart(12, '0')}`;
    const t0 = Date.now();
    sql(`insert into organisations (id, name) values ('${BIG}', 'Big group D1');
         insert into locations (id, org_id, name, timezone, currency) select ('f2000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}', 'Big ' || lpad(n::text, 2, '0'), 'Europe/London', 'GBP' from generate_series(1, ${SCALE_SITES}) n;
         insert into user_profiles (id, org_id, role, full_name) values ('${OWNER}', '${BIG}', 'owner', 'Big Owner'), ('${MGR}', '${BIG}', 'manager', 'Big Manager');
         insert into user_locations (user_id, location_id) values ('${MGR}', '${S(1)}');
         insert into tax_rates (location_id, name, rate, is_default) select id, 'VAT', 0.2, true from locations where org_id = '${BIG}';
         insert into stock_co_items (id, org_id, name, base_unit, category) select ('f3000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}',
           'Item ' || lpad((n - n % 7)::text, 4, '0'), case when n % 3 = 0 then 'kg' else 'each' end, null from generate_series(1, ${SCALE_ITEMS}) n;
         insert into inventory_items (id, location_id, org_id, name, base_unit, current_cost, on_hand, company_ref)
           select gen_random_uuid(), l.id, '${BIG}', c.name, c.base_unit, 1, 0, c.id from locations l cross join stock_co_items c where l.org_id = '${BIG}' and c.org_id = '${BIG}';
         insert into stock_co_item_sites (item_id, org_id, location_id, site_item_id) select i.company_ref, '${BIG}', i.location_id, i.id from inventory_items i join locations l on l.id = i.location_id where l.org_id = '${BIG}';
         insert into stock_co_suppliers (id, org_id, name) values ('f4000000-0000-4000-8000-000000000001', '${BIG}', 'Big Supplier');
         insert into suppliers (id, location_id, org_id, name, delivery_days, company_ref)
           select ('f5000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, ('f2000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}', 'Big Supplier', '["mon","thu"]', 'f4000000-0000-4000-8000-000000000001' from generate_series(1, ${SCALE_SITES}) n;
         insert into stock_co_supplier_sites (supplier_id, org_id, location_id, site_supplier_id) select 'f4000000-0000-4000-8000-000000000001', '${BIG}', s.location_id, s.id from suppliers s where s.company_ref = 'f4000000-0000-4000-8000-000000000001';
         insert into stock_co_supplier_items (id, org_id, item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price, currency)
           select ('f6000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}', ('f3000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                  'f4000000-0000-4000-8000-000000000001', 1, 6, case when n % 3 = 0 then 'kg' else 'each' end, 12, 'GBP' from generate_series(1, 300) n;
         insert into supplier_products (id, location_id, inventory_item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price, is_preferred, company_ref)
           select gen_random_uuid(), s.location_id, s.site_item_id, ss.site_supplier_id, 1, 6, si.inner_unit, 12, true, si.id
             from stock_co_supplier_items si join stock_co_item_sites s on s.item_id = si.item_id join stock_co_supplier_sites ss on ss.supplier_id = si.supplier_id and ss.location_id = s.location_id
            where si.org_id = '${BIG}';
         insert into stock_co_supplier_item_sites (supplier_item_id, org_id, location_id, site_supplier_product_id) select sp.company_ref, '${BIG}', sp.location_id, sp.id from supplier_products sp join locations l on l.id = sp.location_id where l.org_id = '${BIG}';
         insert into stock_order_rules (org_id, location_id, supplier_id, company_ref, delivery_dow) select '${BIG}', s.location_id, s.id, s.company_ref, d from suppliers s cross join (values (1), (4)) v(d) where s.company_ref = 'f4000000-0000-4000-8000-000000000001';
         analyze;`);
    ok(num(`select count(*) from inventory_items i join locations l on l.id = i.location_id where l.org_id = '${BIG}'`) === SCALE_SITES * SCALE_ITEMS,
      `${SCALE_SITES * SCALE_ITEMS} site rows of ${SCALE_ITEMS} company items at ${SCALE_SITES} sites, 300 supplier packs (built in ${Math.round((Date.now() - t0) / 1000)} s)`);
    const first = page('ownerD1', `'${BIG}', null, null, null, null, 100`);
    ok(first.status === 0 && first.j.rows.length === 100 && first.j.total === SCALE_ITEMS && first.ms < 1000 && first.j.rows[0].sites.length === SCALE_SITES,
      `the first page: 100 rows, each with ${SCALE_SITES} sites packed in, total ${first.j?.total}, in ${first.ms} ms (under 1 s) (${outcome(first)})`);
    const wb = walk('ownerD1', BIG, null, null, 100);
    ok(!wb.error && wb.seen.length === SCALE_ITEMS && new Set(wb.seen).size === SCALE_ITEMS && wb.worst < 1000,
      `walking every page by keyset (names tie in sevens): ${wb.seen?.length} rows, ${wb.pages} pages, none repeated or skipped, slowest page ${wb.worst} ms (under 1 s)`);
    const oneRow = page('ownerD1', `'${BIG}', null, null, ${jlit({ ids: [first.j.rows[0].id] })}, null, 100`);
    ok(oneRow.status === 0 && oneRow.j.rows.length === 1 && oneRow.j.rows[0].sites.length === SCALE_SITES && oneRow.ms < 1000
       && JSON.stringify(oneRow.j.rows[0]) === JSON.stringify(first.j.rows[0]),
      `one row read again by id at ${SCALE_SITES} sites: ${oneRow.ms} ms, ${JSON.stringify(oneRow.j?.rows || []).length} bytes against ${JSON.stringify(first.j?.rows || []).length} for the page of 100`);
    const later = page('ownerD1', `'${BIG}', null, 'item 4', null, null, 100`);
    ok(later.status === 0 && later.ms < 1000 && later.j.rows.every((x) => /item 4/i.test(x.name)), `a search page in ${later.ms} ms`);
    const mg = page('mgrD1', `'${BIG}', null, null, null, null, 100`);
    ok(mg.status === 0 && mg.ms < 1000 && mg.j.sites.length === 1 && mg.j.rows[0].sites.length === 1, `a manager of one site: its site only, ${mg.ms} ms`);
    const sup = callJ('ownerD1', `select public.stock_suppliers_page('${BIG}', null, null, null, null, 100)`);
    ok(sup.status === 0 && sup.ms < 1000 && sup.j.rows[0].sites.length === SCALE_SITES, `stock_suppliers_page at ${SCALE_SITES} sites: ${sup.ms} ms`);
    let pa = null; let pn = 0; let pworst = 0;
    do {
      const r = callJ('ownerD1', `select public.stock_prices_page('f4000000-0000-4000-8000-000000000001', null, null, ${pa ? jlit(pa) : 'null'}, 100)`);
      if (r.status !== 0) { ok(false, `stock_prices_page: ${outcome(r)}`); break; }
      pn += r.j.rows.length; pa = r.j.next; pworst = Math.max(pworst, r.ms);
    } while (pa);
    ok(pn === 300 && pworst < 1000, `stock_prices_page: 300 supplier packs in pages of 100, slowest ${pworst} ms`);
    const att = callJ('ownerD1', `select public.stock_needs_attention('${BIG}', null)`);
    ok(att.status === 0 && att.j.rows.length === SCALE_SITES && att.ms < 8000, `stock_needs_attention at ${SCALE_SITES} sites: ${att.ms} ms (under the 8 s limit)`);
    const it = 'f3000000-0000-4000-8000-000000000011';
    const sv = callJ('ownerD1', `select public.stock_save_item(${jlit({ id: it, location_id: S(1), name: 'Item 0017 renamed' })}, null, 1, 'inventory')`);
    ok(sv.j?.ok === true && sv.ms < 3000, `one item saved at ${SCALE_SITES} sites answers in ${sv.ms} ms (under 3 s) (${sv.j ? `${sv.j.sites_written} written, ${sv.j.queued?.length} queued` : outcome(sv)})`);
    const rj = runJobs();
    ok(num(`select count(*) from inventory_items where company_ref = '${it}' and name = 'Item 0017 renamed'`) === SCALE_SITES && rj.failed === 0,
      `the runner finishes the rest: every site carries the name (${rj.steps} steps, slowest ${rj.slowest} ms${rj.errors ? `, ${rj.errors}` : ''})`);
    const nh = callJ('service', `select public.stock_nightly_health('${S(2)}')`);
    ok(nh.status === 0 && nh.ms < 8000 && nh.j.planned_writes === 0, `stock_nightly_health at ${SCALE_ITEMS} items: ${nh.ms} ms, ${nh.j?.planned_writes} planned writes`);
    c.use(MAIN);
  });

  // == 23. Bulk saves and the save queue ==========================================================================================
  section(23, '23. Set sites, pause, Change prices, import, Copy a site, categories, order rules, groups, suggestions, health and Fix; big ones through the queue');
  await guarded('d1 bulk', async () => {
    c.use(MAIN);
    const L = (s) => `array[${s.map((x) => `'${x}'`).join(',')}]::uuid[]`;
    const milkCo = coRef('inventory_items', I.pMilk);
    const breadCo = coRef('inventory_items', I.lBread);
    const figs0 = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
    // set sites: add, run out, remove refused with words, remove allowed
    let r = callJ('ownerT', `select public.stock_set_item_sites(${L([breadCo])}, ${L([PROVO])}, null, 'inventory')`);
    ok(r.j?.ok && r.j.added === 1 && r.j.queued.length === 0, `Add Bread to Provo: added now (${short(r.j)})`);
    const breadP = sql(`select site_item_id from stock_co_item_sites where item_id = '${breadCo}' and location_id = '${PROVO}'`);
    ok(breadP && num(`select on_hand from inventory_items where id = '${breadP}'`) === 0 && /^Added by /.test(sql(`select why_on from stock_co_item_sites where site_item_id = '${breadP}'`)),
      'its new site row starts at on hand 0, "Added by <name>"');
    ok(num(`select count(*) from supplier_products where inventory_item_id = '${breadP}' and archived_at is null`)
       === num(`select count(*) from stock_co_supplier_items si join stock_co_supplier_sites ss on ss.supplier_id = si.supplier_id and ss.location_id = '${PROVO}'
                 where si.item_id = '${breadCo}' and si.archived_at is null`), 'the writer adds its supplier packs at Provo where the supplier can order there');
    r = callJ('ownerT', `select public.stock_set_item_sites(${L([breadCo])}, null, ${jlit([{ location_id: LOC2, mode: 'remove' }])}, 'inventory')`);
    ok(r.j?.ok && r.j.removed === 0 && /^Location 2 holds .* Choose Stop ordering, run out, or write it off first\.$/.test(r.j.refused[0]?.error || ''),
      `Remove now where it holds stock: refused in words (${short(r.j?.refused?.[0]?.error, 140)})`);
    r = callJ('ownerT', `select public.stock_set_item_sites(${L([breadCo])}, null, ${jlit([{ location_id: LOC2, mode: 'runout' }])}, 'inventory')`);
    ok(r.j?.ok && r.j.run_out === 1 && sql(`select stop_ordering_at is not null from stock_co_item_sites where item_id = '${breadCo}' and location_id = '${LOC2}'`) === 't',
      'Stop ordering, run out: stop_ordering_at set');
    ok(num(`select count(*) from supplier_products sp join stock_co_item_sites s on s.site_item_id = sp.inventory_item_id where s.item_id = '${breadCo}' and s.location_id = '${LOC2}' and sp.archived_at is null`) === 0,
      'its supplier packs at Location 2 are archived (it cannot be ordered there)');
    r = callJ('ownerT', `select public.stock_set_item_sites(${L([breadCo])}, null, ${jlit([{ location_id: PROVO, mode: 'remove' }])}, 'inventory')`);
    ok(r.j?.ok && r.j.removed === 1 && sql(`select archived_at is not null from inventory_items where id = '${breadP}'`) === 't', 'Remove now where it holds none and no recipe uses it: off, the site row archived');
    const lsauce = sql(`select id from stock_co_items where org_id = '${ORG_T}' and local_location_id = '${PROVO}' limit 1`);
    if (lsauce) {
      r = callJ('ownerT', `select public.stock_set_item_sites(${L([lsauce])}, null, ${jlit([{ location_id: PROVO, mode: 'remove' }])}, 'inventory')`);
      ok(r.j?.refused?.[0]?.error === 'This is a local item. Archive it instead.', `a local item off its own site: 'This is a local item. Archive it instead.' (${short(r.j?.refused)})`);
      r = callJ('ownerT', `select public.stock_set_item_sites(${L([lsauce])}, ${L([LOC2])}, null, 'inventory')`);
      ok(r.j?.ok && sql(`select local_location_id is null from stock_co_items where id = '${lsauce}'`) === 't', 'a local item ticked at another site becomes a company item');
    }
    // pause
    r = callJ('ownerT', `select public.stock_pause_items(${L([milkCo])}, null, null, null, true, 'inventory')`);
    ok(r.j?.ok && num(`select jsonb_array_length(public.stock_paused_items('${PROVO}') -> 'rows')`) === 1
       && pj(sql(`select public.stock_paused_items('${LOC2}')`)).rows[0]?.everywhere === true, 'pause everywhere: paused at both sites today ("everywhere")');
    asCaller('tillProvo', `insert into closed_checks (id, location_id, items, order_type, source, ref) values ('d1-paused', '${PROVO}', '[{"itemId":"m-latte","qty":1}]', 'dine-in', 'pos', 'D1P')`);
    drain();
    ok(num(`select count(*) from stock_movements where source_id = 'd1-paused'`) > 0 && onHandEqLedger(PROVO), 'a sale of a paused item still takes it off stock (pause never touches sales)');
    r = callJ('ownerT', `select public.stock_pause_items(${L([milkCo])}, null, null, null, false, 'inventory')`);
    ok(r.j?.ok && num(`select jsonb_array_length(public.stock_paused_items('${PROVO}') -> 'rows')`) === 0, 'unpause: nothing paused');
    r = callJ('ownerT', `select public.stock_pause_items(${L([milkCo])}, ${L([LOC2])}, '2020-01-01', '2020-01-02', true, 'inventory')`);
    ok(r.j?.ok && num(`select jsonb_array_length(public.stock_paused_items('${LOC2}') -> 'rows')`) === 0, 'a pause whose days are over is not paused today');
    r = callJ('ownerT', `select public.stock_pause_items(${L([milkCo])}, ${L([LOC2])}, '2026-11-05', '2026-11-01', true, 'inventory')`);
    ok(r.message === 'The pause must end on or after the day it starts.', `a pause ending before it starts: refused in words (${outcome(r)})`);
    // change prices
    const siMilk = coRef('supplier_products', SP.pMilk);
    const before = num(`select pack_price from stock_co_supplier_items where id = '${siMilk}'`);
    r = callJ('ownerT', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siMilk], how: 'percent', value: 10 })}, true, 'inventory')`);
    ok(r.j?.preview && r.j.total === 1 && near(r.j.rows[0].after, before * 1.1) && /^1 price changes from today at \d sites?$/.test(r.j.words) && 'used_in' in r.j.rows[0],
      `preview: before ${before}, after ${r.j?.rows?.[0]?.after}, "${r.j?.words}", used in ${r.j?.rows?.[0]?.used_in} recipes`);
    ok(num(`select pack_price from stock_co_supplier_items where id = '${siMilk}'`) === before, 'a preview changes nothing');
    r = callJ('ownerT', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siMilk], how: 'percent', value: 10 })}, false, 'inventory')`);
    ok(r.j?.ok && r.j.changed === 1 && near(num(`select pack_price from stock_co_supplier_items where id = '${siMilk}'`), before * 1.1)
       && near(num(`select pack_price from supplier_products where id = '${SP.lMilk}'`), before * 1.1) === (sql(`select price_here is null from stock_co_supplier_item_sites where site_supplier_product_id = '${SP.lMilk}'`) === 't'),
      'live: the company price moves now, and every site following it (the writer)');
    r = callJ('ownerT', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siMilk], how: 'set', value: -1 })}, true, 'inventory')`);
    ok(r.message === 'A price cannot be below 0.', `a price below 0: refused (${outcome(r)})`);
    // dated: a site row applies on that site's own day; a company row waits for the latest clock
    sql(`update locations set timezone = 'Pacific/Kiritimati' where id = '${LOC2}'; update locations set timezone = 'Pacific/Pago_Pago' where id = '${PROVO}';`);
    const dL = sql(`select public.stock_co__today('${LOC2}')`); const dP = sql(`select public.stock_co__today('${PROVO}')`);
    ok(dL > dP, `the two sites now have different business days (Location 2 ${dL}, Provo ${dP})`);
    r = callJ('ownerT', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siMilk], how: 'set', value: 2.5, from_day: dL })}, false, 'inventory')`);
    ok(r.j?.ok && r.j.dated === 1 && r.j.from_day === dL, `a company price from ${dL}: one waiting dated price (${short(r.j)})`);
    const siteSi = coRef('supplier_products', SP.lMilk);
    r = callJ('ownerT', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siteSi], sites: [LOC2], how: 'set', value: 2.75, from_day: dL })}, false, 'inventory')`);
    ok(r.j?.ok && (r.j.dated === 1 || r.j.changed === 1), `a price here at Location 2 from its own today (${short(r.j)})`);
    sql(`select public.stock_co__apply_dated_prices(200)`);
    ok(sql(`select price_here from stock_co_supplier_item_sites where supplier_item_id = '${siteSi}' and location_id = '${LOC2}'`) === '2.7500',
      'the site row applies on that site\'s day');
    ok(sql(`select status from stock_co_dated_prices where location_id is null and supplier_item_id = '${siMilk}' and status in ('waiting','applied') order by created_at desc limit 1`) === 'waiting',
      'the company row waits: its day has not begun at Provo (the latest clock wins)');
    sql(`update locations set timezone = 'Pacific/Kiritimati' where id = '${PROVO}'`);
    sql(`select public.stock_co__apply_dated_prices(200)`);
    ok(num(`select pack_price from stock_co_supplier_items where id = '${siMilk}'`) === 2.5 && sql(`select count(*) from stock_save_queue where kind = 'site_sync' and payload ->> 'reason' = 'dated_price' and status = 'waiting'`) !== '0',
      'once its day has begun at every following site the company price applies, and site_sync jobs carry it');
    runJobs();
    sql(`update locations set timezone = 'Europe/London' where id in ('${PROVO}', '${LOC2}')`);
    r = callJ('ownerT', `select public.stock_change_prices(${jlit({ supplier_item_ids: [siMilk], how: 'set', value: 3, from_day: '2031-01-01' })}, false, 'inventory')`);
    const dpid = sql(`select id from stock_co_dated_prices where from_day = '2031-01-01' and status = 'waiting' limit 1`);
    T('mgrProvo', 'cancel a company dated price', callJ('mgrProvo', `select public.stock_cancel_dated_price('${dpid}', 'inventory')`), '42501');
    T('ownerT', 'cancel a company dated price', callJ('ownerT', `select public.stock_cancel_dated_price('${dpid}', 'inventory')`), 'ok');
    // categories
    const catId = sql(`select id from stock_co_categories where org_id = '${ORG_T}' order by name limit 1`);
    const catName = sql(`select name from stock_co_categories where id = '${catId}'`);
    r = callJ('ownerT', `select public.stock_save_category(${jlit({ org_id: ORG_T, name: catName.toUpperCase() })}, null, 'inventory')`);
    ok(r.message === `There is already a category called ${catName.toUpperCase()}.`, `a duplicate category name: refused (${outcome(r)})`);
    r = callJ('ownerT', `select public.stock_save_category(${jlit({ id: catId, name: `${catName} renamed` })}, ${num(`select row_version from stock_co_categories where id = '${catId}'`)}, 'inventory')`);
    ok(r.j?.ok && num(`select count(*) from stock_co_items where category_id = '${catId}' and category <> '${catName} renamed'`) === 0, 'rename a category: every item\'s free text follows');
    runJobs();
    ok(num(`select count(*) from inventory_items t join stock_co_item_sites s on s.site_item_id = t.id join stock_co_items i on i.id = s.item_id where i.category_id = '${catId}' and t.category is distinct from i.category`) === 0,
      'and every site row through the writer');
    r = callJ('ownerT', `select public.stock_archive_category('${catId}', ${num(`select row_version from stock_co_categories where id = '${catId}'`)}, true, 'inventory')`);
    ok(/^Move the \d+ items in .* to another category first\.$/.test(r.message), `archiving a category in use: refused in words (${outcome(r)})`);
    // order rules: save, copy; the derived columns the Order pad reads
    const dairy = coRef('suppliers', SUP.pDairy);
    r = callJ('ownerT', `select public.stock_save_order_rules('${dairy}', '${PROVO}', ${jlit([{ delivery_dow: 2, order_by_dow: 1, order_by_time: '14:00' }, { delivery_dow: 5, order_by_dow: 4, order_by_time: '11:30' }, { delivery_dow: 4, order_by_dow: 3, order_by_time: '14:00' }])}, ${num(`select row_version from stock_co_supplier_sites where supplier_id = '${dairy}' and location_id = '${PROVO}'`)}, 'purchasing')`);
    ok(r.j?.ok && JSON.stringify(r.j.delivery_days) === '["tue","thu","fri"]' && r.j.cutoff_time === '14:00', `order rules: the site row's delivery days ${JSON.stringify(r.j?.delivery_days)} and cut off ${r.j?.cutoff_time} (the most used order by time)`);
    ok(sql(`select delivery_days::text || ' ' || cutoff_time from suppliers where id = '${SUP.pDairy}'`) === '["tue", "thu", "fri"] 14:00', 'today\'s Order pad readers see day codes and an HH:MM cut off, as before');
    const dd = pj(sql(`select delivery_days from suppliers where id = '${SUP.pDairy}'`));
    ok(JSON.stringify(normDeliveryDays(dd)) === '["tue","thu","fri"]' && nextDeliveryYmd(dd, '2026-11-02') === '2026-11-03' && nextDeliveryYmd(dd, '2026-11-03') === '2026-11-05',
      'the Order pad and manager-approve rules (purchasingRules) read the derived days: after Monday 2 Nov the next delivery is Tuesday 3 Nov, after that Thursday 5 Nov');
    r = callJ('ownerT', `select public.stock_save_order_rules('${dairy}', '${PROVO}', ${jlit([{ delivery_dow: 2 }, { delivery_dow: 2 }])}, ${num(`select row_version from stock_co_supplier_sites where supplier_id = '${dairy}' and location_id = '${PROVO}'`)}, 'purchasing')`);
    ok(r.message === 'Each day can have one delivery only.', `two rules for one day: refused (${outcome(r)})`);
    r = callJ('ownerT', `select public.stock_save_order_rules('${dairy}', '${PROVO}', '[]', 1, 'purchasing')`);
    ok(r.j?.ok === false && r.j.conflict, `an old version: "saved this first" (${short(r.j?.error, 90)})`);
    r = callJ('ownerT', `select public.stock_copy_order_rules('${dairy}', '${PROVO}', ${L([LOC2])}, 'purchasing')`);
    const dairyL2 = sql(`select site_supplier_id from stock_co_supplier_sites where supplier_id = '${dairy}' and location_id = '${LOC2}'`);
    ok(r.j?.ok && (r.j.copied === 1 ? sql(`select delivery_days::text from suppliers where id = '${dairyL2}'`) === '["tue", "thu", "fri"]' : r.j.skipped.length === 1),
      `copy order rules to Location 2 (${short(r.j)})`);
    // a supplier unticked at a site, then ticked again: the site row is archived (never deleted) and comes
    // back with its own account number; the writer never fights it
    T('mgrLoc2', 'its own account number with a supplier (site facts)', callJ('mgrLoc2', `select public.stock_save_supplier_site('${dairy}', '${LOC2}', ${jlit({ account_number: 'L2-77' })}, null, 'purchasing')`), 'ok');
    const pw0 = pj(sql(`select public.stock_nightly_health('${LOC2}')`))?.planned_writes;
    r = callJ('ownerT', `select public.stock_save_supplier(${jlit({ id: dairy })}, ${jlit([{ location_id: LOC2, on: false }])}, ${num(`select row_version from stock_co_suppliers where id = '${dairy}'`)}, 'purchasing')`);
    ok(r.j?.ok && sql(`select archived_at is not null from suppliers where id = '${SUP.lDairy}'`) === 't'
       && num(`select count(*) from stock_co_supplier_sites where supplier_id = '${dairy}' and location_id = '${LOC2}'`) === 0
       && num(`select count(*) from supplier_products where supplier_id = '${SUP.lDairy}' and archived_at is null`) === 0,
      `untick Dairy at Location 2: its site row archived (not deleted), its packs there archived, the link gone (${outcome(r)})`);
    ok(pj(sql(`select public.stock_nightly_health('${LOC2}')`))?.planned_writes === pw0, 'and the writer plans nothing new there (it never brings the row back by itself)');
    T('mgrLoc2', 'ticking a supplier on at its site (Their sites)', callJ('mgrLoc2', `select public.stock_save_supplier(${jlit({ id: dairy })}, ${jlit([{ location_id: LOC2, on: true }])}, ${num(`select row_version from stock_co_suppliers where id = '${dairy}'`)}, 'purchasing')`), 'words:Not allowed: prices and the supplier here are set by head office.');
    r = callJ('mgrFull', `select public.stock_save_supplier(${jlit({ id: dairy })}, ${jlit([{ location_id: LOC2, on: true }])}, ${num(`select row_version from stock_co_suppliers where id = '${dairy}'`)}, 'purchasing')`);
    ok(r.j?.ok && sql(`select coalesce(account_number, '') || '|' || (archived_at is null) from suppliers where id = '${SUP.lDairy}'`) === 'L2-77|true'
       && num(`select count(*) from stock_co_supplier_sites where supplier_id = '${dairy}' and location_id = '${LOC2}' and site_supplier_id = '${SUP.lDairy}'`) === 1
       && num(`select count(*) from supplier_products where supplier_id = '${SUP.lDairy}' and archived_at is null`) > 0,
      `tick it on again (Their sites, full control): the same site row back with its own account number, its packs back (${outcome(r)})`);
    // make company record, groups, suggestions, health and Fix, go live
    const loc2 = callJ('mgrLoc2', `select public.stock_save_item(${jlit({ location_id: LOC2, name: 'Loc2 Pickles', base_unit: 'kg' })}, null, null, 'inventory')`).j?.id;
    r = callJ('ownerT', `select public.stock_make_company_record('item', '${loc2}', 1, 'inventory')`);
    ok(r.j?.ok && sql(`select local_location_id is null from stock_co_items where id = '${loc2}'`) === 't' && num(`select count(*) from stock_co_item_sites where item_id = '${loc2}'`) === 1,
      'make company record: no longer local, its site tick stays');
    r = callJ('ownerT', `select public.stock_save_site_group(${jlit({ org_id: ORG_T, name: 'Group L2' })})`);
    ok(r.message === 'Pick at least one site.' || /already a group/.test(r.message || ''), `a group with no sites or a used name: refused (${outcome(r)})`);
    const gid = sql(`select id from stock_co_site_groups where org_id = '${ORG_T}' limit 1`);
    if (gid) {
      r = callJ('ownerT', `select public.stock_save_site_group(${jlit({ id: gid, name: 'Group L2b', location_ids: [LOC2, PROVO] })})`);
      ok(r.message === 'This screen is out of date. Reload it, then save again.', `a group edit with no row_version: refused (${outcome(r)})`);
      r = callJ('ownerT', `select public.stock_save_site_group(${jlit({ id: gid, name: 'Group L2b', location_ids: [LOC2, PROVO], row_version: num(`select row_version from stock_co_site_groups where id = '${gid}'`) })})`);
      ok(r.j?.ok, 'a group edit with its version');
      T('ownerT', 'delete a group', callJ('ownerT', `select public.stock_delete_site_group('${gid}')`), 'ok');
    }
    const ev0 = num(`select count(*) from activity_events where kind = 'stock_suggestion' and location_id = '${LOC2}'`);
    r = callJ('mgrLoc2', `select public.stock_suggest_change('item', '${I.lButter}', 'Cheaper butter from the cash and carry')`);
    ok(r.j?.ok && num(`select count(*) from activity_events where kind = 'stock_suggestion' and location_id = '${LOC2}'`) === ev0 + 1, 'a suggestion: one activity row at the caller\'s site, one change log row');
    r = callJ('mgrLoc2', `select public.stock_suggest_change('item', '${I.lButter}', '')`);
    ok(r.message === 'Write what should change, up to 500 letters.', `an empty suggestion: refused (${outcome(r)})`);
    sql(`insert into stock_change_log (org_id, location_id, entity, entity_id, field, who, source) select '${ORG_T}', '${LOC2}', 'item', gen_random_uuid(), 'suggestion', '${U.mgrLoc2}', 'suggest' from generate_series(1, 30)`);
    r = callJ('mgrLoc2', `select public.stock_suggest_change('item', '${I.lButter}', 'One more')`);
    ok(r.message === 'That is 30 suggestions today. Try again tomorrow.', `the 31st suggestion in a day: refused (${outcome(r)})`);
    sql(`update stock_co_items set name = name || ' drift' where id = '${milkCo}'`);
    const h = callJ('service', `select public.stock_nightly_health('${PROVO}')`);
    ok(h.j?.planned_writes > 0 && sql(`select lines::text from stock_co_site_health where location_id = '${PROVO}'`).includes('differ'), `nightly health finds the drift (${h.j?.planned_writes} planned writes)`);
    r = callJ('ownerT', `select public.stock_resync_site('${PROVO}')`);
    const r2 = callJ('ownerT', `select public.stock_resync_site('${PROVO}')`);
    ok(r.j?.ok && r2.j?.queue_id === r.j.queue_id, 'Fix queues one resync job (asking again answers the same job)');
    runQueue(45);
    ok(sql(`select status from stock_save_queue where id = ${r.j?.queue_id}`) === 'done', 'the real runner procedure (stock_save_queue_run, dated prices first) finishes it');
    ok(pj(sql(`select public.stock_nightly_health('${PROVO}')`))?.planned_writes === 0, 'after the Fix the site matches the company list');
    sql(`update stock_co_items set name = replace(name, ' drift', '') where id = '${milkCo}'`);
    runJobs();
    r = callJ('ownerT', `select public.stock_save_golive_step('${LOC2}', ${jlit({ step: 'side_by_side', due_day: '2026-11-03', done: true })}, null)`);
    const plan = callJ('ownerT', `select public.stock_golive_plan('${LOC2}')`).j;
    ok(r.j?.ok && r.j.step.done_at && plan?.steps?.find((x) => x.step === 'side_by_side')?.done_by_name, 'a go live step saved (done stamps who and when) and the plan reads it');
    // import: stage, check, commit through the queue
    const rows = Array.from({ length: 2000 }, (_, k) => ({ row_no: k + 1, kind: 'item', data: { name: `Imported ${String(k).padStart(4, '0')}`, base_unit: k % 2 ? 'kg' : 'each', category: 'Imported' } }));
    rows.push({ row_no: 2001, kind: 'recipe', data: { name: 'Imported dish' } });
    r = callJ('ownerT', `select public.stock_import_stage(null, ${jlit(rows.slice(0, 2000))}, ${jlit({ org_id: ORG_T, source: 'csv', file_name: 'items.csv', sites: [LOC2] })})`);
    ok(r.j?.ok && r.j.staged === 2000 && r.j.counts.new === 2000 && r.ms < 8000, `stage 2,000 rows in one call: ${r.j?.counts?.new} new (${r.ms} ms)`);
    const job = r.j?.job_id;
    r = callJ('ownerT', `select public.stock_import_stage('${job}', ${jlit(rows.slice(2000))})`);
    ok(r.j?.counts?.skip === 1, 'a recipe row is skipped ("Recipes come in with the recipe update.")');
    r = callJ('ownerT', `select public.stock_import_stage('${job}', ${jlit(Array.from({ length: 2001 }, (_, k) => ({ row_no: k + 1, kind: 'item', data: { name: 'x', base_unit: 'kg' } })))})`);
    ok(r.message === 'Send 2,000 rows or fewer at a time.', `2,001 rows in one call: refused (${outcome(r)})`);
    const chk = callJ('ownerT', `select public.stock_import_check('${job}', null, 500)`).j;
    ok(chk && chk.rows.length === 200 && chk.next?.row_no === 200, 'the check screen reads 200 rows a page by row number');
    r = callJ('ownerT', `select public.stock_import_commit('${job}')`);
    ok(r.j?.ok && r.j.queue_id, `commit: always queued (job ${r.j?.queue_id})`);
    const ij = runJobs();
    ok(sql(`select status from stock_co_import_jobs where id = '${job}'`) === 'done' && num(`select count(*) from stock_co_items where org_id = '${ORG_T}' and name like 'Imported %'`) === 2000
       && num(`select count(*) from stock_co_item_sites s join stock_co_items i on i.id = s.item_id where i.name like 'Imported %' and s.location_id = '${LOC2}'`) === 2000 && ij.failed === 0 && ij.slowest < 1000,
      `the runner commits it: 2,000 company items on at Location 2 (${ij.steps} steps, slowest ${ij.slowest} ms)`);
    ok(num(`select count(*) from inventory_items i join stock_co_item_sites s on s.site_item_id = i.id join stock_co_items c on c.id = s.item_id where c.name like 'Imported %' and i.on_hand <> 0`) === 0,
      'every imported item starts at on hand 0 (an import never writes on hand, cost or the ledger)');
    // a file with only Name and Base unit (no Category, Type, SKU...): importMappers sends those keys empty, and an
    // empty cell keeps what is there. Nothing changes, at the company or at a site.
    const lemCo = coRef('inventory_items', I.pLemons);
    const lem0 = sql(`select concat_ws('|', c.category, c.category_id, c.type, c.sku, c.barcode, c.shelf_life_days, c.purchase_vat_rate, c.row_version,
                        (select string_agg(coalesce(t.category, '') || '/' || coalesce(t.sku, ''), ',' order by t.location_id) from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id where s.item_id = c.id))
                        from stock_co_items c where c.id = '${lemCo}'`);
    const lemRows = toStageRows('items', [{ _row: 2, name: sql(`select name from stock_co_items where id = '${lemCo}'`), base_unit: sql(`select base_unit from stock_co_items where id = '${lemCo}'`) }]);
    ok(lemRows.length === 1 && 'category' in lemRows[0].data && lemRows[0].data.category === null, 'the mapper sends the empty Category cell as null (the staged shape of contract 3.5)');
    const lj = callJ('ownerT', `select public.stock_import_stage(null, ${jlit(lemRows)}, ${jlit({ org_id: ORG_T, source: 'csv', file_name: 'names.csv', sites: [PROVO, LOC2] })})`);
    ok(lj.j?.ok && lj.j.counts.same === 1 && lj.j.counts.change === 0, `the check screen says Same, not Change (${short(lj.j?.counts)})`);
    r = callJ('ownerT', `select public.stock_import_commit('${lj.j?.job_id}')`);
    const lr = runJobs();
    ok(r.j?.ok && lr.failed === 0 && sql(`select status from stock_co_import_jobs where id = '${lj.j?.job_id}'`) === 'done', 'the name only file commits');
    const lem1 = sql(`select concat_ws('|', c.category, c.category_id, c.type, c.sku, c.barcode, c.shelf_life_days, c.purchase_vat_rate, c.row_version,
                        (select string_agg(coalesce(t.category, '') || '/' || coalesce(t.sku, ''), ',' order by t.location_id) from stock_co_item_sites s join inventory_items t on t.id = s.site_item_id where s.item_id = c.id))
                        from stock_co_items c where c.id = '${lemCo}'`);
    ok(lem1 === lem0 && lem0.startsWith('Fruit|'), `a name only re-import changes nothing: Lemons keeps Fruit at the company and at both sites (${lem1})`);
    // an empty supplier cell keeps the supplier's email too (Same, not Change)
    const supName = sql(`select name from stock_co_suppliers where id = '${coRef('suppliers', SUP.pDairy)}'`);
    const sj = callJ('ownerT', `select public.stock_import_stage(null, ${jlit(toStageRows('suppliers', [{ _row: 2, name: supName }]))}, ${jlit({ org_id: ORG_T, source: 'csv', file_name: 'suppliers.csv', sites: [PROVO] })})`);
    ok(sj.j?.ok && sj.j.counts.same === 1 && sj.j.counts.change === 0, `a supplier row with only its name: Same (${short(sj.j?.counts)})`);
    callJ('ownerT', `select public.stock_import_cancel('${sj.j?.job_id}')`);
    // nothing at the fixture sites moved by itself
    for (const v of [SOLO]) {
      const d = figureDiff(figs0[v], venueFigures(c, v));
      ok(d.filter((k) => !/^n:|^s:mv|^v:items|^s:on_hand|^s:books|^v:pars/.test(k)).length === 0 && d.filter((k) => /^s:on_hand|^s:books/.test(k)).length === 0,
        `${VNAME[v]} (one site company, untouched by these saves): no on hand, cost or ledger number moved (${d.join(', ') || 'none'})`);
    }
    ok(VENUES.every(onHandEqLedger) && VENUES.every((v) => ledgerGap(v) < 0.01), 'on hand equals the ledger and ledger value equals the books at every venue');

    // -- big bulk saves through the queue on the scale copy, with sales running -----------------------------------------
    c.use('n_d1_scale');
    const BIG = id('0e000000', 'f1');
    const S = (n) => `f2000000-0000-4000-8000-${String(n.toString(16)).padStart(12, '0')}`;
    sql(`insert into stock_co_items (id, org_id, name, base_unit) select ('f7000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}', 'New ' || lpad(n::text, 3, '0'), 'each' from generate_series(1, 300) n;`);
    const newIds = sql(`select string_agg(id::text, ',' order by id) from stock_co_items where name like 'New %' and org_id = '${BIG}'`).split(',');
    const hot = sql(`select string_agg(id::text, ',' order by id) from (select id from inventory_items where location_id = '${S(1)}' order by id limit 4) z`).split(',');
    let stop = false; const errs = []; let sales = 0;
    const tills = Array.from({ length: 4 }, (_, t) => (async () => {
      let k = 0;
      while (!stop) {
        const body = `set lock_timeout = '8s'; set statement_timeout = '8s'; begin; ${hot.map((x, j) => `select public._post_stock_movement('${S(1)}', '${x}', -1, 'SALE_DEPLETION', 1, 'closed_check', 'd1s${t}-${k}', 'sale:d1s${t}-${k}:${j}:${x}');`).join(' ')} commit;`;
        const res = await c.psqlAsync({ input: body });
        sales++; if (res.code) errs.push(res.sqlstate || short(res.err, 60));
        k++;
      }
    })());
    await new Promise((res) => setTimeout(res, 300));
    r = callJ('ownerD1', `select public.stock_set_item_sites(array[${newIds.map((x) => `'${x}'`).join(',')}]::uuid[], array['${S(1)}']::uuid[], null, 'inventory')`);
    ok(r.j?.ok && r.j.queued.length === 1 && r.j.added === 0, `tick 300 new items on at one site: over 200 rows, so queued (${r.ms} ms)`);
    r = callJ('ownerD1', `select public.stock_change_prices(${jlit({ supplier_id: 'f4000000-0000-4000-8000-000000000001', how: 'percent', value: 5 })}, false, 'purchasing')`);
    ok(r.j?.ok && r.j.queued.length === 1 && r.j.queued[0].location_id === null, `Change prices of 300 supplier packs (company): queued as one company job (${r.ms} ms)`);
    r = callJ('ownerD1', `select public.stock_pause_items(array[${newIds.slice(0, 150).map((x) => `'${x}'`).join(',')}]::uuid[], array['${S(1)}', '${S(2)}']::uuid[], null, null, true, 'inventory')`);
    ok(r.j?.ok && r.j.queued.length === 2, `pause 150 items at 2 sites: 300 rows, one job a site (${r.ms} ms)`);
    sql(`insert into stock_co_categories (id, org_id, name) values ('f8000000-0000-4000-8000-000000000001', '${BIG}', 'Dry');
         update stock_co_items set category_id = 'f8000000-0000-4000-8000-000000000001', category = 'Dry' where org_id = '${BIG}' and name like 'Item 0%';`);
    r = callJ('ownerD1', `select public.stock_save_category(${jlit({ id: 'f8000000-0000-4000-8000-000000000001', name: 'Dry goods' })}, 1, 'inventory')`);
    ok(r.j?.ok && r.j.queued.length === 1, `rename a category of more than 200 items: queued (${r.ms} ms)`);
    // a supplier with a pack for every item (5,000), linked at big site 01 only: Copy a site, an import that links it
    // at another site and Fix must all write its packs a few hundred at a time, never in one long step
    const HUGE = 'f4000000-0000-4000-8000-0000000000aa';
    sql(`insert into stock_co_suppliers (id, org_id, name) values ('${HUGE}', '${BIG}', 'Huge Supplier');
         insert into suppliers (id, location_id, org_id, name, delivery_days, company_ref) values ('f5000000-0000-4000-8000-0000000000aa', '${S(1)}', '${BIG}', 'Huge Supplier', '[]', '${HUGE}');
         insert into stock_co_supplier_sites (supplier_id, org_id, location_id, site_supplier_id) values ('${HUGE}', '${BIG}', '${S(1)}', 'f5000000-0000-4000-8000-0000000000aa');
         insert into stock_co_supplier_items (id, org_id, item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price, currency)
           select ('fa000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${BIG}', ('f3000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
                  '${HUGE}', 1, 12, case when n % 3 = 0 then 'kg' else 'each' end, 12.6, 'GBP' from generate_series(1, ${SCALE_ITEMS}) n;
         insert into supplier_products (id, location_id, inventory_item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price, is_preferred, company_ref)
           select gen_random_uuid(), '${S(1)}', s.site_item_id, 'f5000000-0000-4000-8000-0000000000aa', 1, 12, si.inner_unit, 12.6, false, si.id
             from stock_co_supplier_items si join stock_co_item_sites s on s.item_id = si.item_id and s.location_id = '${S(1)}' where si.supplier_id = '${HUGE}';
         insert into stock_co_supplier_item_sites (supplier_item_id, org_id, location_id, site_supplier_product_id)
           select sp.company_ref, '${BIG}', '${S(1)}', sp.id from supplier_products sp where sp.supplier_id = 'f5000000-0000-4000-8000-0000000000aa';
         analyze;`);
    const hugeAt = (loc) => num(`select count(*) from supplier_products sp join stock_co_supplier_item_sites x on x.site_supplier_product_id = sp.id
                                  join stock_co_supplier_items si on si.id = x.supplier_item_id where si.supplier_id = '${HUGE}' and sp.location_id = '${loc}' and sp.archived_at is null`);
    ok(hugeAt(S(1)) === SCALE_ITEMS, `a supplier with ${SCALE_ITEMS} packs at big site 01`);
    // an import that links that supplier at big site 02 (one supplier row): its packs go through the queue in steps
    const hj = callJ('ownerD1', `select public.stock_import_stage(null, ${jlit([{ row_no: 1, kind: 'supplier', data: { name: 'Huge Supplier' } }])}, ${jlit({ org_id: BIG, source: 'csv', file_name: 'link.csv', sites: [S(2)] })})`);
    r = callJ('ownerD1', `select public.stock_import_commit('${hj.j?.job_id}')`);
    ok(hj.j?.ok && hj.j.counts.same === 1 && r.j?.ok, 'an import of one supplier row, linking it at big site 02: queued');
    sql(`insert into locations (id, org_id, name, timezone, currency) values ('${S(99)}', '${BIG}', 'Big new', 'Europe/London', 'GBP');
         insert into storage_areas (location_id, name, kind, sort_order) values ('${S(1)}', 'Walk in', 'walk_in', 1);
         insert into par_levels (location_id, inventory_item_id, par_level, reorder_point, min_level) select '${S(1)}', id, 10, 4, 2 from inventory_items where location_id = '${S(1)}' order by id limit 50;`);
    r = callJ('ownerD1', `select public.stock_copy_site('${S(1)}', '${S(99)}', 'inventory')`);
    ok(r.j?.ok && r.j.queue_id, 'Copy a site to a new site: queued');
    const big = runJobs(20000);
    stop = true;
    await Promise.all(tills);
    ok(big.failed === 0 && big.slowest < 1000, `the runner finishes every job: ${big.steps} steps, slowest ${big.slowest} ms (no runner step holds a stock item lock over 1 s), ${big.failed} failed${big.errors ? ` (${big.errors})` : ''}`);
    ok(errs.length === 0, `${sales} multi line sales ran during the bulk saves: 0 lock timeouts, 0 deadlocks (${errs.slice(0, 3).join(', ') || 'none'})`);
    ok(num(`select count(*) from stock_co_item_sites where location_id = '${S(1)}' and item_id in (select id from stock_co_items where name like 'New %')`) === 300, 'the 300 new items are on at that site');
    ok(num(`select count(*) from supplier_products sp join locations l on l.id = sp.location_id where l.org_id = '${BIG}' and sp.archived_at is null and sp.pack_price <> 12.6`) === 0, 'every site follows the new company price (12 + 5% = 12.60)');
    ok(num(`select count(*) from stock_co_item_sites where location_id in ('${S(1)}', '${S(2)}') and paused`) === 300 - (num(`select count(*) from stock_co_item_sites where location_id = '${S(2)}' and item_id in (select id from stock_co_items where name like 'New %')`) === 0 ? 150 : 0),
      'the pause landed where those items are on');
    ok(num(`select count(*) from inventory_items t join stock_co_item_sites s on s.site_item_id = t.id where s.item_id in (select id from stock_co_items where category_id = 'f8000000-0000-4000-8000-000000000001') and t.category is distinct from 'Dry goods'`) === 0,
      'the category rename reached every site row');
    const onFrom = num(`select count(*) from stock_co_item_sites s join stock_co_items i on i.id = s.item_id where s.location_id = '${S(1)}' and s.on_here and s.stop_ordering_at is null and i.local_location_id is null and i.archived_at is null`);
    ok(num(`select count(*) from stock_co_item_sites where location_id = '${S(99)}' and on_here`) === onFrom && num(`select count(*) from inventory_items where location_id = '${S(99)}' and on_hand <> 0`) === 0,
      `Copy a site: all ${onFrom} items on at the new site at on hand 0`);
    ok(hugeAt(S(2)) === SCALE_ITEMS && hugeAt(S(99)) === SCALE_ITEMS,
      `the ${SCALE_ITEMS} pack supplier: every pack written at big site 02 (import) and at the new site (Copy a site), each runner step under 1 s (above)`);
    ok(num(`select count(*) from stock_co_supplier_sites where location_id = '${S(99)}'`) === 2 && sql(`select string_agg(distinct coalesce(email, '') || '|' || coalesce(account_number, ''), ',') from suppliers where location_id = '${S(99)}'`) === '|'
       && num(`select count(*) from stock_order_rules where location_id = '${S(99)}'`) === 2 && num(`select count(*) from par_levels where location_id = '${S(99)}'`) === 50
       && num(`select count(*) from storage_areas where location_id = '${S(99)}' and kind = 'walk_in'`) === 1 && sql(`select done_at is not null from stock_co_golive_steps where location_id = '${S(99)}' and step = 'copy_site'`) === 't',
      'and its two suppliers (order email and account number left empty), order rules, pars, the missing area kind, and the go live step done');
    // Fix (resync) at the new site: every item, then the suppliers a few at a time, each step under 1 s
    r = callJ('ownerD1', `select public.stock_resync_site('${S(99)}')`);
    const fx = runJobs(20000);
    ok(r.j?.ok && fx.failed === 0 && fx.slowest < 1000 && sql(`select status from stock_save_queue where id = ${r.j?.queue_id}`) === 'done',
      `Fix at a site with the ${SCALE_ITEMS} pack supplier: ${fx.steps} steps, slowest ${fx.slowest} ms, ${fx.failed} failed${fx.errors ? ` (${fx.errors})` : ''}`);
    ok(pj(sql(`select public.stock_nightly_health('${S(99)}')`))?.planned_writes === 0, 'and the site matches the company list after it');
    // staging a 5,000 line file: 5,000 new items, a new supplier and 5,000 supplier pack rows naming them, 2,000 rows a
    // call as ImportModal sends it, every call well inside the live 8 s limit
    const nItems = Array.from({ length: SCALE_ITEMS }, (_, k) => ({ row_no: 1000000 + k + 1, kind: 'item', data: { name: `Staged ${String(k).padStart(5, '0')}`, base_unit: 'each' } }));
    const nSup = [{ row_no: 2000001, kind: 'supplier', data: { name: 'Staged Supplier' } }];
    const nPacks = Array.from({ length: SCALE_ITEMS }, (_, k) => ({ row_no: 3000000 + k + 1, kind: 'supplier_item',
      data: { supplier: 'Staged Supplier', item: `Staged ${String(k).padStart(5, '0')}`, pack_qty: 1, inner_qty: 6, inner_unit: 'each', pack_price: 4.2 } }));
    const all = [...nItems, ...nSup, ...nPacks];
    let sjob = null; let sworst = 0; let scalls = 0; let sbad = null;
    for (let k = 0; k < all.length; k += 2000) {
      const st = callJ('ownerD1', `select public.stock_import_stage(${sjob ? `'${sjob}'` : 'null'}, ${jlit(all.slice(k, k + 2000))}${sjob ? '' : `, ${jlit({ org_id: BIG, source: 'nory', file_name: 'nory.csv', sites: [S(3)] })}`})`);
      scalls++; sworst = Math.max(sworst, st.ms);
      if (!st.j?.ok) { sbad = outcome(st); break; }
      sjob = st.j.job_id;
    }
    const scount = sjob ? pj(sql(`select counts::text from stock_co_import_jobs where id = '${sjob}'`)) : null;
    ok(!sbad && scount?.new === all.length && scount?.problem === 0 && sworst < 4000,
      `staging ${all.length} rows (${SCALE_ITEMS} items, 1 supplier, ${SCALE_ITEMS} packs naming them) in ${scalls} calls: slowest ${sworst} ms (under 4 s; the live limit is 8 s)${sbad ? `, ${sbad}` : ''}, ${scount?.new} new, ${scount?.problem} problems`);
    if (sjob) callJ('ownerD1', `select public.stock_import_cancel('${sjob}')`);
    ok(num(`select count(*) from stock_outbox where status = 'dead'`) === 0, 'zero dead outbox events');
    ok(onHandEqLedger(S(1)), 'on hand equals the ledger at the busy site');
    c.use(MAIN);
  });

  // == 24. Every order channel ==========================================================================================
  section(24, '24. Every order channel books exactly the same before and after Drop 1');
  await guarded('d1 channels', () => {
    c.createFrom('n_d1_chan_post', 'n_pre_d1');
    c.use('n_d1_chan_post');
    const r = c.paste(FILES.d1);
    ok(r.status === 0, 'Drop 1 applies on the copy taken before it');
    const { out, problems } = runChannels();
    ok(problems.length === 0, `every channel writes its check after Drop 1 (${problems.join('; ') || 'all written'})`);
    for (const v of chanVenues) {
      const a = JSON.stringify(out[v.loc]); const b = JSON.stringify(chanBefore?.[v.loc]);
      ok(a === b, `${VNAME[v.loc]}: till, kiosk, online, QR, catering, pay at table, MPOS, HubRise, ezCater, the refund and the void book the same movements, waste and outbox events (${out[v.loc]?.movements?.length} movements)`);
    }
    c.use(MAIN);
  });

  // == 25. The rollback, then Drop 1 again ===========================================================================================
  section(25, '25. The Drop 1 rollback: the 24 Drop 0 bodies back, no number moving; then Drop 1 again');
  await guarded('d1 rollback', () => {
    c.use(MAIN);
    const rb = readFileSync(FILES.d1Rb, 'utf8');
    ok(!/like\s+'[%_]*stock_co/i.test(rb.replace(/--[^\n]*/g, '')), 'the rollback drops by exact name (no LIKE)');
    const pre = Object.fromEntries(VENUES.map((v) => [v, venueFigures(c, v)]));
    const items = (f) => JSON.stringify(f['v:items'].map((x) => [x.id, x.on_hand, x.cost]));
    sql(`insert into stock_save_queue (org_id, location_id, kind, payload) values ('${ORG_T}', '${PROVO}', 'set_sites', '{"item_ids": [], "mode": "add"}')`);
    const r = c.paste(FILES.d1Rb);
    ok(r.status === 0, `the rollback applies (${r.status ? short(r.stderr, 400) : `${r.ms} ms`})`);
    const row = lastRows(r)[0] || {};
    console.log(`     rollback check: ${short(row, 400)}`);
    ok(row.bodies_restored === '24' && row.drop1_left === '0' && row.site_rows_changed === '0' && Number(row.queue_rows_failed) >= 1,
      `check row: 24 bodies restored, nothing of Drop 1 left, site rows changed 0, ${row.queue_rows_failed} Drop 1 jobs failed in words`);
    for (const [sig, md5] of D1_REPLACED) ok(md5Of(sig) === md5, `${sig.slice(7, sig.indexOf('('))} is the Drop 0 body again (md5 ${md5})`);
    for (const t of Object.keys(D1_TABLES)) ok(!tableExists(t), `${t} is gone`);
    ok(sql(`select count(*) from information_schema.columns where table_schema = 'public' and ((table_name = 'stock_co_items' and column_name = 'category_id') or (table_name = 'stock_co_item_sites' and column_name in ('paused_from', 'paused_until')) or (table_name = 'stock_co_site_groups' and column_name = 'row_version'))`) === '0',
      'the four Drop 1 columns are gone');
    ok(num(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace`) === preCount, `the function count is the one before Drop 1 (${preCount})`);
    ok(num(`select count(*) from stock_native_backup where name like 'd1:%'`) === 0, 'the d1: backup rows are gone');
    ok(sql(`select last_error from stock_save_queue where kind = 'set_sites' order by id desc limit 1`) === 'Drop 1 was rolled back.', 'a waiting Drop 1 job is failed with "Drop 1 was rolled back."');
    for (const v of VENUES) ok(items(venueFigures(c, v)) === items(pre[v]), `${VNAME[v]}: every item's on hand and cost unchanged by the rollback`);
    const own = callJ('mgrProvo', `select public.stock_save_item(${jlit({ site_item_id: I.pEggs, location_id: PROVO, name: 'Free Range Eggs' })}, null, null, 'inventory')`);
    ok(own.status === 0, `levels off again: a Provo manager's company save is Drop 0's (${outcome(own)})`);
    const a = c.paste(FILES.d1);
    ok(a.status === 0 && lastRows(a).every((x) => x.levels_on === 'refused, par ok' && x.site_rows_changed === '0'), `Drop 1 applies again after its rollback (${a.status ? short(a.stderr, 300) : 'ok'})`);
    ok(VENUES.every(onHandEqLedger) && VENUES.every((v) => ledgerGap(v) < 0.01), 'on hand equals the ledger and ledger value equals the books at every venue at the end');
  });
}

const near = (a, b, eps = 1e-3) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
