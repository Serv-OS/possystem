// drop4b.mjs: proves Drop 4b of multi site stock (supabase/migrations/20261030a_OPS_stock_native_4b.sql and its
// rollback, release 5.11.100) on the throwaway Ops shaped database run.mjs built, after 0a, its revalue file, 0b,
// Drop 1, the drainer, Drop 2 and Drop 3; this file then pastes 4a, Reports align (20261029a) and the storage fix
// (20261029b) as live has them, and then 4b. It never connects to Supabase. run.mjs --drop4b calls drop4bSections().
//
//   60  the paste: the bodies 4b checks have exactly the live md5 here (the files replay live); the guard's
//       refusals (no Reports align, a storage rule still calling stock_level, a changed body, a second run, not
//       Ops); the check row (every column); nothing at the sites or logins moved
//   61  the storage lesson: the old inbox rule breaks an upload into ANOTHER bucket (permission denied for
//       stock_level), the fixed rule does not; the table rule guard finds no rule calling a function its logins
//       cannot run, and finds one when it is planted
//   62  what 4b made: the table (RLS, fence, read rule, no write policy), the renamed bodies (md5 as saved,
//       internal now), every function (definer, search path, exact grants), anon and devices refused
//   63  real roles on the five new reports and the journal: owner, Stock control all, a sites manager (own site
//       ok, another refused by name), another company, a till, the anon key, no second step, the service role;
//       the journal's own words; the record function (service role only, never twice)
//   64  every new figure against the seeded world (worked out here from the rows written), and the cross report
//       parity: budget sales = Cost of sales sales, transfers in and out = Stock movement, month end waste =
//       Waste, month end closing = Stock movement closing, league budget = Purchase budget
//   65  the weekly email staging (each venue's clock, the deadline, the counted path, the company row last, never
//       twice, never an old week) and who it goes to
//   66  a locked period: the snapshot holds every figure, the month end and the dashboard read it after a back
//       dated movement changes the ledger, stock value at the period end reads it, an old Drop 3 snapshot is read
//       by its old names; the closing stock journal ready only when every site is locked
//   67  speed: 50 sites (10 with --quick) by 500 items by 31 days with invoices, transfers, orders and a count plan:
//       every 4b report and every changed one under 5 s as the owner under the 8 s limit
//   68  the rollback: every body back by md5, every 4b object gone, every changed report answering exactly what
//       it answered before 4b; then 4b again and every answer as the first time
//
// Ids and neutral words only (the repo is public).

import { lit, jlit, arr } from './base.mjs';
import { ORG_T, PROVO, LOC2, ORG_X, U, I, SUP, CALLERS, id } from './fixtures.mjs';

const SIG7 = '(uuid,uuid[],date,date,jsonb,jsonb,integer)';
// what live answered on 23 Oct 2026 (read only): the eleven bodies 4b renames or replaces and four it reads
export const D4B_LIVE_MD5 = [
  ['public.stock_rp__snapshot(uuid,date,date)', '337b3eced4a784a310ab6a9a19698196'],
  [`public.stock_report_league${SIG7}`, '187e57cdd30206a996f57577fcc1b786'],
  [`public.stock_report_dashboard${SIG7}`, 'd0323ceee050a123f7a310de73b77eb4'],
  [`public.stock_report_attention${SIG7}`, 'a72f1d26901dc4ef4170ffb3561d18c2'],
  [`public.stock_report_value${SIG7}`, '9ce59583f9e9f0f59083ceeb1baa0b99'],
  [`public.stock_report_purchases${SIG7}`, 'e383750b568d9b5deb87ac8afd0bb1cb'],
  [`public.stock_report_prices${SIG7}`, 'b5a575d346e06b1302da576e85928651'],
  ['public.stock_report_export_start(text,jsonb)', '9cbe7bd979cb18856f055113f1705039'],
  ['public.stock_lock_period(uuid,date,date)', '8a77de5d4fc115b4922a8b332e3db5da'],
  ['public.stock_notify_due()', '8958a67ff641ea9270a8ac5632dd19ae'],
  ['public.stock_notify_targets(bigint)', '276132acb90aff16aa031fcecada9aff'],
  ['public.stock_rp__site_figures(jsonb,jsonb)', '61302c621256eb638c977eb452bc4724'],
  ['public.stock_rp__windows(jsonb,date,date,boolean)', '7d695565d0da046538dfb3f0a39c5805'],
  ['public.stock_co__count_due_rows(uuid,uuid[],date)', '578c33287f913776dbba88e17b881269'],
  ['public.stock_co__forecast_amount(uuid,date)', 'da368fbe7c89eaf9bdc2685d0f43fa96'],
];
export const D4B_REPORTS = ['off_contract', 'budget', 'transfers', 'count_compliance', 'month_end'];
const CHANGED = ['league', 'dashboard', 'attention', 'value', 'purchases', 'prices'];
const RENAMED = [
  ['stock_report_league', `public.stock_rp__league_4a${SIG7}`], ['stock_report_dashboard', `public.stock_rp__dashboard_4a${SIG7}`],
  ['stock_report_attention', `public.stock_rp__attention_4a${SIG7}`], ['stock_report_value', `public.stock_rp__value_4a${SIG7}`],
  ['stock_report_purchases', `public.stock_rp__purchases_4a${SIG7}`], ['stock_report_prices', `public.stock_rp__prices_4a${SIG7}`],
  ['stock_notify_due', 'public.stock_co__notify_due_d3()'], ['stock_notify_targets', 'public.stock_co__notify_targets_d3(bigint)'],
];
const HELPERS = ['public.stock_rp__legal_of(uuid)', 'public.stock_rp__in_transit(uuid[],date)', 'public.stock_rp__kitchen_margin(uuid[],date)',
  'public.stock_rp__budget(uuid,date,date,boolean)', 'public.stock_rp__grni(uuid[],date)', 'public.stock_rp__credits_out(uuid[],date)',
  'public.stock_rp__recharges(uuid[],date,date)', 'public.stock_rp__budget_merge(uuid,jsonb,jsonb,date,date)', 'public.stock_rp__count_merge(uuid,jsonb,date)',
  'public.stock_rp__purchase_extra(uuid[],date,date,boolean)', 'public.stock_rp__credit_figures(uuid[],date,date)', 'public.stock_rp__notes_4b(jsonb)',
  'public.stock_rp__oc_lines(uuid[],date,date)', 'public.stock_rp__margin_same_legal(uuid,date)', 'public.stock_co__weekly_stage()',
  'public.stock_co__notify_email_ok(text)'];
// the table rule guard (the same query the 4b asserts run and the release folder reads live)
export const POLICY_GUARD_SQL = `
with pol as (
  select n.nspname, c.relname, c.oid as rel, p.polname, p.polcmd, p.polroles,
         coalesce(p.polqual::text, '') || ' ' || coalesce(p.polwithcheck::text, '') as tree
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'storage')
),
calls as (select pol.*, (m[1])::oid as fn from pol cross join lateral regexp_matches(pol.tree, ':funcid (\\d+)', 'g') as m),
roles as (
  select calls.*, r.rolname
    from calls
   cross join lateral (select x.rolname from pg_roles x where x.oid = any(calls.polroles) and x.rolname in ('anon', 'authenticated')
                       union select 'anon' where 0::oid = any(calls.polroles)
                       union select 'authenticated' where 0::oid = any(calls.polroles)) r
)
select coalesce(json_agg(distinct jsonb_build_object('table', roles.nspname || '.' || roles.relname, 'policy', roles.polname, 'role', roles.rolname,
                                                     'fn', roles.fn::regprocedure::text)), '[]')
  from roles
 where not has_function_privilege(roles.rolname, roles.fn, 'execute')
   and ((roles.polcmd in ('r', '*') and has_table_privilege(roles.rolname, roles.rel, 'select'))
        or (roles.polcmd in ('a', '*') and has_table_privilege(roles.rolname, roles.rel, 'insert'))
        or (roles.polcmd in ('w', '*') and has_table_privilege(roles.rolname, roles.rel, 'update'))
        or (roles.polcmd in ('d', '*') and has_table_privilege(roles.rolname, roles.rel, 'delete')))`;

const PENNY = 0.0101;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const W = (n) => id('4b000000', n);

export async function drop4bSections(ctx) {
  const { c, ok, section, guarded, FILES, QUICK } = ctx;
  const sql = (q, o) => c.sql(q, o);
  const num = (q, o) => c.num(q, o);
  const short = (x, n = 160) => String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, n);
  const pj = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const near = (a, b, eps = PENNY) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
  const PRE = c.DB;
  const md5Of = (sig) => sql(`select md5(btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('${sig}')`);
  const aclOf = (sig) => sql(`select coalesce(string_agg(r, ',' order by r), '') from (
      select case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end r
        from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = to_regprocedure('${sig}') and a.privilege_type = 'EXECUTE') z`);
  const fnExists = (sig) => sql(`select to_regprocedure('${sig}') is not null`) === 't';
  const lastRows = (r) => (r.sets[r.sets.length - 1] || { rows: [] }).rows;
  const paste = (f, o) => c.paste(f, o);
  const dsDrainAll = (force = false) => {
    if (force) sql(`update sales_day_sums_queue set due_at = now() - interval '1 second'`);
    for (let k = 0; k < 400; k++) {
      sql('call public.stock_day_sums_drain(40, 50);');
      if (num(`select (select count(*) from stock_day_sums_repair where due_at <= now()) + (select count(*) from sales_day_sums_queue where due_at <= now())`) === 0) return k + 1;
    }
    return -1;
  };
  const SCALE_ORG = id('0e000000', 'f4');
  const SCALE_OWNER = id('10000000', 'f4');
  const loginOf = (sub, aal = 'aal2') => ({ sub, role: 'authenticated', is_anonymous: false, aud: 'authenticated', aal });
  const CALL = { ...CALLERS, scaleOwner: { login: 'authenticator', role: 'authenticated', claims: loginOf(SCALE_OWNER), what: 'owner of the 4b scale company' } };
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
  const rep = (who, name, { org = ORG_T, sites = [PROVO, LOC2], from, to, opts = null, after = null, limit = 1000 }) =>
    callJ(who, `select public.stock_report_${name}('${org}', ${arr(sites)}, '${from}', '${to}', ${opts ? jlit(opts) : 'null'}, ${after ? jlit(after) : 'null'}, ${limit})`);
  const siteRow = (j, loc) => (j?.totals || []).find((t) => t.location_id === loc) || null;
  const coRow = (j) => (j?.totals || []).find((t) => t.location_id == null) || null;
  const strip = (j) => JSON.stringify(j, (k, v) => (k === 'generated_at' ? undefined : v));
  const T = sql(`select (public.stock_co__venue_day('${PROVO}', now())).business_day::text`);
  const D = (n) => addDays(T, -n);
  const WIN = { from: D(6), to: D(1) };
  const VNAME = { [PROVO]: 'Provo', [LOC2]: 'Location 2' };

  // ============================================================================================================
  section(60, '60. Drop 4b as the SQL editor runs it: 4a, Reports align and the storage fix first (as live), the guard, the check row');
  let pasted = false;
  let before = null;
  let first = null;
  await guarded('4b paste', () => {
    c.use(PRE);
    dsDrainAll();
    const a4 = paste(FILES.d4);
    ok(a4.status === 0, `4a applies first, as live (${a4.status ? short(a4.stderr, 400) : `${a4.ms} ms`})`);
    if (a4.status) return;
    sql(`update sales_day_sums_queue set due_at = now() - interval '1 second' where reason = 'drop4a_backfill'`);
    dsDrainAll();
    c.createFrom('n_4b_noal', c.DB);
    const al = paste(FILES.al);
    ok(al.status === 0, `Reports align (20261029a) applies, as live (${al.status ? short(al.stderr, 400) : `${al.ms} ms`})`);
    if (al.status) return;
    dsDrainAll(true);
    const hf = paste(FILES.hf);
    ok(hf.status === 0 && (lastRows(hf)[0] || {}).policy_fixed === 't' && (lastRows(hf)[0] || {}).old_call_gone === 't',
      `the storage fix (20261029b, the 23 Oct live paste) applies again and changes nothing: ${short(lastRows(hf)[0], 200)}`);
    // the files replay live: every body 4b checks has the md5 live answered on 23 Oct
    const diff = D4B_LIVE_MD5.filter(([sig, want]) => md5Of(sig) !== want).map(([sig]) => sig);
    ok(diff.length === 0, `the ${D4B_LIVE_MD5.length} bodies 4b checks have exactly the live md5 here (${diff.join(', ') || 'all equal'})`);
    buildWorld();
    ok(num(`select count(*) from stock_transfers where id::text like '4b000000-%'`) === 5 && num(`select count(*) from purchase_orders where id::text like '4b000000-%'`) === 5,
      'the seeded world: 5 transfers (a central kitchen delivery with a markup, one in transit, one disputed, a request, one overdue), 5 orders, an invoice, credits, budgets, a count plan, Xero companies');
    // the 23 Oct live text of the upload check has a slip: an inbox path raises instead of answering (4b corrects it)
    const slip = asCaller('ownerT', `select public.stock_invoice_inbox_upload_ok('org/${ORG_T}/inv.pdf')`);
    ok(slip.status !== 0 && /operator does not exist: text = uuid/.test(slip.message),
      `the 23 Oct upload check raises on an inbox upload ("${short(slip.message, 80)}"): 4b corrects it`);
    c.createFrom('n_4b_pre', c.DB);
    // the old Drop 3 lock (before 4b), on a copy, for the old snapshot names proof of section 66
    c.createFrom('n_4b_oldsnap', c.DB);
    c.use('n_4b_oldsnap');
    const oldLock = callJ('ownerT', `select public.stock_lock_period('${LOC2}', '${D(13)}', '${D(8)}')`);
    ok(oldLock.status === 0 && oldLock.j?.metrics?.stock_value !== undefined && oldLock.j?.metrics?.closing_value === undefined,
      `the Drop 3 lock writes its own names (stock_value, count_variance, cogs): ${short(Object.keys(oldLock.j?.metrics || {}), 200)}`);
    c.use('n_4b_pre');
    before = snapshotReports();
    // the guard's refusals, each on a copy, each changing nothing
    const refuse = (label, db, setup, want) => {
      c.createFrom('n_4b_ref', db);
      c.use('n_4b_ref');
      if (setup) sql(setup);
      const r = paste(FILES.d4b);
      ok(r.status !== 0 && (r.error || '').includes(want) && !fnExists(`public.stock_report_month_end${SIG7}`) && !fnExists(`public.stock_rp__value_4a${SIG7}`),
        `refuses ${label}: "${short(r.error, 130)}" and nothing changed`);
    };
    refuse('without Reports align', 'n_4b_noal', null, 'Run 20261029a_OPS_reports_align.sql first');
    refuse('while a storage rule still calls stock_level (the 23 Oct break)', 'n_4b_pre', `drop policy stock_invoice_inbox_files_add on storage.objects;
      create policy stock_invoice_inbox_files_add on storage.objects as permissive for insert to authenticated
        with check (bucket_id = 'stock-invoice-inbox' and (storage.foldername(name))[1] = 'org'
                    and (storage.foldername(name))[2] in (select public.stock_reach_orgs())
                    and public.stock_level(auth.uid(), ((storage.foldername(name))[2])::uuid) = 'all');`, 'Run 20261029b_OPS_storage_inbox_upload_ok.sql first');
    refuse('a changed body', 'n_4b_pre', `create or replace function public.stock_report_value(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
        p_after jsonb default null, p_limit integer default 1000) returns jsonb language sql stable security definer set search_path = public, pg_temp as $f$ select '{}'::jsonb $f$;`,
      'A stock function changed since this file was written');
    refuse('a changed alert kind list', 'n_4b_pre', `alter table stock_notify_sent drop constraint stock_notify_sent_kind_check;
      alter table stock_notify_sent add constraint stock_notify_sent_kind_check check (kind in ('order_by', 'price_rise'));`, 'The alert kinds of stock_notify_sent are not as written for');
    refuse('on a database that is not Ops', 'n_4b_pre', 'create table public.billing_state (id integer);', 'This is not the Ops database');
    c.createFrom('n_4b', 'n_4b_pre');
    c.use('n_4b');
    const r = paste(FILES.d4b);
    ok(r.status === 0, `Drop 4b applies as one paste (${r.status ? short(r.stderr, 1200) : `${r.ms} ms`})`);
    if (r.status) return;
    const rows = lastRows(r);
    for (const x of rows) console.log(`     check row: ${short(x, 900)}`);
    const t = rows.find((x) => x.org_id === ORG_T) || {};
    ok(t.multi === 't' && t.bodies_moved === '11' && t.renamed_kept === '8' && t.new_functions === '24' && t.new_tables === '1' && t.weekly_kind === 't'
       && t.internals_open_to_api === 'f' && t.anon_can_read_reports === 'f' && t.table_rules_ok === 't' && t.storage_upload_ok === 't'
       && t.backup_rows === '12' && t.budget_ok === 't' && Number(t.legal_rows) >= 1 && Number(t.dashboard_ms) < 5000 && Number(t.month_end_ms) < 5000
       && t.site_rows_changed === '0' && t.logins_changed === 'f',
      'the check row (test company): 11 bodies moved, 8 renamed and kept, 24 new functions, 1 table, the weekly kind, internals closed, table rules ok, uploads ok, 12 backup rows, budget on every card, the timed calls under 5 s, no site row or login changed');
    ok(rows.every((x) => x.site_rows_changed === '0' && x.logins_changed === 'f') && rows.some((x) => x.multi === 'f' && x.dashboard_ms === 'skipped'),
      `every company row: no site row or login changed; a one site company is skipped (${rows.length} rows)`);
    for (const [sig, was] of D4B_LIVE_MD5.slice(0, 11)) ok(md5Of(sig) !== was, `${sig.slice(7, 60)} is the 4b body now`);
    const again = paste(FILES.d4b);
    ok(again.status !== 0 && (again.error || '').includes('Drop 4b has run already'), `a second paste refuses: "${short(again.error, 100)}"`);
    c.createFrom('n_4b_fresh', 'n_4b');   // 4b just pasted, the world untouched: for the rollback proof
    first = snapshotReports();
    pasted = true;
  });
  if (!pasted) return;

  // ============================================================================================================
  section(61, '61. The storage lesson (23 Oct): a rule that calls a function its logins cannot run breaks every upload; the guard finds it');
  await guarded('storage', () => {
    c.createFrom('n_4b_st', 'n_4b');
    c.use('n_4b_st');
    sql(`insert into storage.buckets (id, name, public) values ('test-logos', 'test-logos', false) on conflict do nothing;
         create policy test_logos_add on storage.objects for insert to authenticated with check (bucket_id = 'test-logos');`);
    const up = (who) => asCaller(who, `insert into storage.objects (bucket_id, name) values ('test-logos', 'brand/logo-${Math.random().toString(36).slice(2)}.png')`);
    const good = up('mgrProvo');
    ok(good.status === 0, `with the fixed inbox rule a manager uploads a logo into another bucket (${outcome(good)})`);
    const guard0 = pj(sql(POLICY_GUARD_SQL)) || [];
    ok(guard0.length === 0, `the table rule guard finds no rule calling a function its logins cannot run (${short(guard0, 300) || 'none'})`);
    sql(`drop policy stock_invoice_inbox_files_add on storage.objects;
         create policy stock_invoice_inbox_files_add on storage.objects as permissive for insert to authenticated
           with check (bucket_id = 'stock-invoice-inbox' and (storage.foldername(name))[1] = 'org'
                       and (storage.foldername(name))[2] in (select public.stock_reach_orgs())
                       and public.stock_level(auth.uid(), ((storage.foldername(name))[2])::uuid) = 'all');`);
    const bad = up('mgrProvo');
    ok(bad.status !== 0 && /permission denied for function stock_level/.test(bad.message), `with the 22 Oct rule the same upload fails: "${short(bad.message, 120)}" (the live incident, here)`);
    const guard1 = pj(sql(POLICY_GUARD_SQL)) || [];
    ok(guard1.some((g) => g.policy === 'stock_invoice_inbox_files_add' && g.role === 'authenticated' && /stock_level/.test(g.fn)),
      `the guard names it: ${short(guard1, 240)}`);
    // the 4b paste itself refuses on such a database (section 60) and the Drop 3 file in the repo now makes the fixed rule
    sql(`drop policy stock_invoice_inbox_files_add on storage.objects;
         create policy stock_invoice_inbox_files_add on storage.objects for insert to authenticated with check (bucket_id = 'stock-invoice-inbox' and public.stock_invoice_inbox_upload_ok(name));`);
    ok(up('mgrProvo').status === 0, 'the fixed rule back: the upload works again');
    // the upload check itself: the org folder, a company the login reaches, Stock control all
    const ck = (who, name) => sql(`begin; select set_config('request.jwt.claims', ${lit(JSON.stringify(CALL[who].claims))}, true); set local role authenticated;
                                   select public.stock_invoice_inbox_upload_ok(${lit(name)}); commit;`).split('\n').filter(Boolean).pop();
    ok(ck('ownerT', `org/${ORG_T}/a.pdf`) === 't' && ck('mgrProvo', `org/${ORG_T}/a.pdf`) === 'f' && ck('ownerT', `org/${ORG_X}/a.pdf`) === 'f' && ck('ownerT', 'brand/a.pdf') === 'f',
      'stock_invoice_inbox_upload_ok: the owner yes; a sites manager, another company and a name outside org/ no');
  });

  // ============================================================================================================
  section(62, '62. What 4b made: the table, the renamed bodies, every function and its grants');
  await guarded('objects', () => {
    c.use('n_4b');
    ok(sql(`select relrowsecurity from pg_class where oid = 'public.stock_month_end_journals'::regclass`) === 't'
       && num(`select count(*) from pg_policies where tablename = 'stock_month_end_journals' and cmd <> 'SELECT' and policyname <> 'second_step_fence'`) === 0
       && num(`select count(*) from pg_policies where tablename = 'stock_month_end_journals' and policyname = 'second_step_fence' and permissive = 'RESTRICTIVE'`) === 1
       && sql(`select has_table_privilege('authenticated', 'public.stock_month_end_journals', 'insert')`) === 'f'
       && sql(`select has_table_privilege('anon', 'public.stock_month_end_journals', 'select')`) === 'f',
      'stock_month_end_journals: RLS on, read by company reach, the second step fence, no write policy, no insert grant, nothing for anon');
    const kept = RENAMED.filter(([name, sig]) => md5Of(sig) === sql(`select md5 from stock_native_backup where name = '4b:${name}'`) && aclOf(sig) === 'postgres');
    ok(kept.length === RENAMED.length, `the ${RENAMED.length} renamed bodies keep their text (md5 as saved) and are internal now (${RENAMED.length - kept.length} differ)`);
    const want = {
      ...Object.fromEntries(D4B_REPORTS.map((n) => [`public.stock_report_${n}${SIG7}`, 'authenticated,postgres'])),
      [`public.stock_report_league${SIG7}`]: 'authenticated,postgres,service_role', [`public.stock_report_dashboard${SIG7}`]: 'authenticated,postgres,service_role',
      [`public.stock_report_attention${SIG7}`]: 'authenticated,postgres', [`public.stock_report_value${SIG7}`]: 'authenticated,postgres',
      [`public.stock_report_purchases${SIG7}`]: 'authenticated,postgres', [`public.stock_report_prices${SIG7}`]: 'authenticated,postgres',
      'public.stock_report_export_start(text,jsonb)': 'authenticated,postgres', 'public.stock_lock_period(uuid,date,date)': 'authenticated,postgres',
      'public.stock_month_end_journal(uuid,date,date)': 'authenticated,postgres,service_role',
      'public.stock_month_end_journal_record(uuid,date,date,text,jsonb)': 'postgres,service_role',
      'public.stock_month_end_journal_claim(uuid,date,date,text,uuid,text)': 'postgres,service_role',
      'public.stock_notify_due()': 'postgres', 'public.stock_notify_targets(bigint)': 'postgres,service_role',
      ...Object.fromEntries(HELPERS.map((h) => [h, 'postgres'])), 'public.stock_rp__snapshot(uuid,date,date)': 'postgres',
    };
    const wrong = Object.entries(want).filter(([sig, acl]) => aclOf(sig) !== acl).map(([sig]) => `${sig}=${aclOf(sig)}`);
    ok(wrong.length === 0, `${Object.keys(want).length} functions with exactly their grants (${wrong.join('; ') || 'all'})`);
    const defs = Object.keys(want).filter((sig) => sql(`select prosecdef and coalesce(array_to_string(proconfig, ','), '') like '%search_path=public, pg_temp%' from pg_proc where oid = to_regprocedure('${sig}')`) !== 't');
    ok(defs.length === 0, `every one is SECURITY DEFINER with search_path public, pg_temp (${defs.join(', ') || 'all'})`);
    for (const who of ['anonKey', 'tillProvo', 'customer']) {
      const r = rep(who, 'month_end', { ...WIN });
      ok(r.status !== 0 && r.sqlstate === '42501', `${CALL[who].what}: month end refused (${outcome(r)})`);
    }
  });

  // ============================================================================================================
  section(63, '63. Real roles on the five new reports and the closing stock journal');
  await guarded('roles', () => {
    c.use('n_4b');
    for (const n of D4B_REPORTS) {
      const o = rep('ownerT', n, { ...WIN });
      const a = rep('mgrAll', n, { ...WIN });
      const m1 = rep('mgrProvo', n, { sites: [PROVO], ...WIN });
      const m2 = rep('mgrProvo', n, { ...WIN });
      const x = rep('ownerX', n, { ...WIN });
      const s = rep('service', n, { ...WIN });   // the five new reports are for signed in logins only (the Owner app reads the league)
      const ns = rep('noStep', n, { sites: [PROVO], ...WIN });
      ok(o.status === 0 && a.status === 0 && m1.status === 0 && o.j?.totals?.length === 3 && m1.j?.totals?.length === 2
         && m2.sqlstate === '42501' && /does not reach Location 2/.test(m2.message) && x.sqlstate === '42501' && ns.sqlstate === '42501'
         && s.sqlstate === '42501' && /permission denied/.test(s.message),
        `${n}: owner, Stock control all and a sites manager at their own site read it; the manager at both sites is refused by name; another company, no second step and the service role are refused (${[o, a, m1, m2, x, s, ns].map(outcome).join(' | ').slice(0, 300)})`);
    }
    // the journal: head office only, the service role, the record function
    const j1 = callJ('ownerT', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`);
    const legal = j1.j?.legal?.[0] || {};
    ok(j1.status === 0 && j1.j.legal.length === 1 && legal.tenant_id === 'tenant-a' && legal.status === 'not_locked' && legal.locked_all === false
       && legal.connection_location_id && legal.scopes_ok === true && /^Closing stock .*, ServOS \(2 sites\)$/.test(legal.narration),
      `the owner reads the journal: one legal company, not locked yet, connected, scopes ok ("${legal.narration}", ${legal.words})`);
    const j2 = callJ('mgrProvo', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`);
    ok(j2.sqlstate === '42501' && /Only head office sends the closing stock journal/.test(j2.message), `a sites manager: "${short(j2.message, 80)}"`);
    const j3 = callJ('service', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`);
    ok(j3.status === 0 && j3.j?.legal?.length === 1, `the service role reads it (${outcome(j3)})`);
    const rec = (who, patch) => callJ(who, `select public.stock_month_end_journal_record('${ORG_T}', '${WIN.from}', '${WIN.to}', 'tenant-a', ${jlit(patch)})`);
    const r0 = rec('ownerT', { status: 'sent' });
    ok(r0.status !== 0 && r0.sqlstate === '42501', `a signed in login cannot record a journal (${outcome(r0)})`);
    c.createFrom('n_4b_jr', 'n_4b');
    c.use('n_4b_jr');
    // one send at a time: the month is claimed before Xero is called
    const claim = (who) => callJ(who, `select public.stock_month_end_journal_claim('${ORG_T}', '${WIN.from}', '${WIN.to}', 'tenant-a', '${U.ownerT}', 'Owner T')`);
    const c0 = claim('ownerT');
    const c1 = claim('service');
    const c2 = claim('service');
    ok(c0.sqlstate === '42501' && c1.status === 0 && c2.sqlstate === '55000' && /already being sent/.test(c2.message)
       && rep('ownerT', 'month_end', { ...WIN, opts: { level: 'legal' } }).j?.rows?.[0]?.journal?.status === 'sending',
      `the claim: a login cannot; the service role claims once; a second claim while sending is refused ("${short(c2.message, 60)}"); the month end says it is being sent`);
    const r1 = rec('service', { status: 'failed', error: 'Xero said no', stock_account: '630', movement_account: '310' });
    const c3 = claim('service');
    ok(r1.status === 0 && c3.status === 0, 'a failed send frees the month: it can be claimed again');
    const r2 = rec('service', { status: 'sent', xero_journal_id: 'mj-1', amount: 12.34, sent_by_name: 'Owner T' });
    const r3 = rec('service', { status: 'sent', xero_journal_id: 'mj-2' });
    const row = pj(sql(`select row_to_json(j) from stock_month_end_journals j where org_id = '${ORG_T}'`)) || {};
    ok(r1.status === 0 && r2.status === 0 && r3.sqlstate === '55000' && /already sent to Xero/.test(r3.message) && row.status === 'sent' && row.xero_journal_id === 'mj-1'
       && row.stock_account === '630' && row.last_error === null && num(`select count(*) from stock_month_end_journals`) === 1,
      `the service role records a failed send, then the sent one (accounts kept), and never a second (${outcome(r3)})`);
    const c4 = claim('service');
    ok(c4.sqlstate === '55000' && /already sent to Xero/.test(c4.message), `a sent month cannot be claimed again (${outcome(c4)})`);
    // every site of the legal company counts, a site closed since that still holds stock too; one site says site
    c.createFrom('n_4b_cl', 'n_4b');
    c.use('n_4b_cl');
    sql(`update locations set status = 'closed' where id = '${LOC2}'`);
    const jc = callJ('ownerT', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`).j?.legal?.[0] || {};
    ok((jc.location_ids || []).length === 2 && /\(2 sites\)$/.test(jc.narration || ''), `a site closed since, still holding stock, is in the journal (${(jc.location_ids || []).length} sites, "${jc.narration}")`);
    sql(`delete from xero_connections where location_id = '${LOC2}'`);
    const j1s = (callJ('ownerT', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`).j?.legal || []).find((x) => x.tenant_id === 'tenant-a') || {};
    ok(/\(1 site\)$/.test(j1s.narration || '') && Array.isArray(j1s.sites) && j1s.sites.length === 1 && 'grni' in j1s,
      `one site: "${j1s.narration}"; the journal rows carry the month end figures the screen shows`);
    c.use('n_4b_jr');
    const me = rep('ownerT', 'month_end', { ...WIN, opts: { level: 'legal' } });
    ok(me.j?.rows?.[0]?.journal?.status === 'sent' && me.j.rows[0].journal.xero_journal_id === 'mj-1' && /^Sent to Xero as a draft on /.test(me.j.rows[0].journal.words),
      `the month end shows it sent: "${me.j?.rows?.[0]?.journal?.words}"`);
    c.use('n_4b');
  });

  // ============================================================================================================
  section(64, '64. Every new figure against the seeded world, and the cross report parity');
  await guarded('figures', () => {
    c.use('n_4b');
    const pMilkCost = Number(sql(`select current_cost from inventory_items where id = '${I.pMilk}'`));
    const eggsCompany = sql(`select company_ref is not null from inventory_items where id = '${I.pEggs}'`) === 't';
    // Off contract (5.12)
    const oc = rep('ownerT', 'off_contract', { ...WIN });
    const op = siteRow(oc.j, PROVO) || {};
    ok(oc.status === 0 && near(op.spend, 16.5) && near(op.off_contract, 5.5) && near(op.local, eggsCompany ? 2.5 : 5.5) && near(op.not_contract, eggsCompany ? 3 : 0)
       && near(op.over_agreed, 1) && op.over_agreed_lines === 1 && op.lines === 3 && op.invoices === 1 && near(op.off_pct, 33.33),
      `Off contract at Provo: spend 16.50, off contract 5.50 (shop milk local, eggs not a contract supplier), 1.00 above the agreed price on 1 line, 33.33% (${short(op, 300)})`);
    const ol = siteRow(oc.j, LOC2) || {};
    ok(near(ol.spend, 20) && near(Number(ol.off_contract) + (20 - Number(ol.off_contract)), 20) && near(coRow(oc.j)?.spend, 36.5), `Location 2 spend 20.00; the company 36.50`);
    const ocl = rep('ownerT', 'off_contract', { ...WIN, opts: { level: 'line' } });
    ok(ocl.j?.rows?.length === 3 && ocl.j.rows.some((x) => x.why === 'local' && near(x.line_total, 2.5))
       && ocl.j.rows.some((x) => near(x.over_by, 1) && near(x.agreed_price, 5)), `the lines: ${ocl.j?.rows?.map((x) => `${x.name}:${x.why}`).join(', ')}`);
    // Purchase budget (5.13)
    const fc = Number(sql(`select sum(public.stock_co__forecast_amount('${PROVO}', d::date)) from generate_series('${WIN.from}'::date, '${WIN.to}'::date, interval '1 day') d`));
    const bg = rep('ownerT', 'budget', { ...WIN });
    const bp = siteRow(bg.j, PROVO) || {};
    const bl = siteRow(bg.j, LOC2) || {};
    const cg = rep('ownerT', 'cogs', { ...WIN });
    ok(bg.status === 0 && bp.rule === 'pct_of_forecast' && near(bp.budget, Math.round(fc * 0.3 * 100) / 100) && near(bp.spent, 57) && near(bp.forecast, fc)
       && bl.rule === 'fixed' && near(bl.budget, 600) && near(bl.spent, 20) && bl.over === false && near(bl.pct_used, 3.33),
      `Purchase budget: Provo 30% of the forecast ${fc.toFixed(2)} = ${bp.budget}, spent 57.00 (orders by the day ordered, fees in); Location 2 fixed 700 a week = 600.00 for 6 days, spent 20.00`);
    ok(near(bp.sales_net, siteRow(cg.j, PROVO)?.sales_net) && near(bl.sales_net, siteRow(cg.j, LOC2)?.sales_net) && Number(bp.sales_net) > 0,
      `parity: Purchase budget's actual sales equal Cost of sales (Provo ${bp.sales_net}, Location 2 ${bl.sales_net}: net after refunds, the Daily trading rule)`);
    const bw = rep('ownerT', 'budget', { ...WIN, opts: { level: 'week' } });
    const sumW = (loc, k) => (bw.j?.rows || []).filter((x) => x.location_id === loc).reduce((t, x) => t + Number(x[k] || 0), 0);
    ok(near(sumW(LOC2, 'budget'), 600, 0.03) && near(sumW(PROVO, 'spent'), 57) && near(sumW(PROVO, 'budget'), bp.budget, 0.03)
       && (bw.j?.rows || []).filter((x) => x.location_id === PROVO).reduce((t, x) => t + x.days, 0) === 6,
      'the weeks add up to the period (a part week is pro rata by days)');
    const lg = rep('ownerT', 'league', { ...WIN });
    const lp = (lg.j?.rows || []).find((x) => x.location_id === PROVO) || {};
    const ll = (lg.j?.rows || []).find((x) => x.location_id === LOC2) || {};
    ok(near(lp.budget, bp.budget) && near(lp.budget_spent, 57) && near(lp.budget_pct, bp.pct_used) && typeof lp.rag?.budget_pct === 'string'
       && near(coRow(lg.j)?.budget, Number(bp.budget) + 600) && /^Missed /.test(ll.last_full_count_words) && /^Missed |, on time$|, late$/.test(lp.last_full_count_words),
      `parity: the league's budget = Purchase budget (Provo ${lp.budget_spent} of ${lp.budget}, ${lp.rag?.budget_pct}); count words "${lp.last_full_count_words}" and "${ll.last_full_count_words}"`);
    const db = rep('ownerT', 'dashboard', { ...WIN });
    ok(near(siteRow(db.j, PROVO)?.budget, bp.budget) && near(coRow(db.j)?.budget_spent, 77) && (db.j?.rows?.league || []).every((x) => 'budget_pct' in x)
       && !(db.j?.meta?.notes || []).includes('Purchases at delivery value until the purchasing update'),
      'the dashboard cards and league carry the budget; the old purchasing update words are gone');
    // Transfers and central kitchen (5.14)
    const tr = rep('ownerT', 'transfers', { ...WIN });
    const mv = rep('ownerT', 'movement', { ...WIN });
    const tp = siteRow(tr.j, PROVO) || {};
    const tl = siteRow(tr.j, LOC2) || {};
    ok(tr.status === 0 && near(tp.received_in, siteRow(mv.j, PROVO)?.transfers_in) && near(tp.sent_out, siteRow(mv.j, PROVO)?.transfers_out)
       && near(tl.received_in, siteRow(mv.j, LOC2)?.transfers_in) && near(tl.sent_out, siteRow(mv.j, LOC2)?.transfers_out),
      `parity: transfers in and out equal Stock movement (Provo in ${tp.received_in}, out ${tp.sent_out}; Location 2 in ${tl.received_in}, out ${tl.sent_out})`);
    ok(near(tp.in_transit, 2) && tp.in_transit_count === 1 && near(tl.in_transit, 1000 * pMilkCost) && near(tp.short, 1.5) && tp.short_lines === 1
       && tp.disputed === 1 && tl.disputed === 1 && tp.requests_open === 1 && tl.requests_open === 1,
      `in transit Provo 2.00 (the overdue one), Location 2 ${(1000 * pMilkCost).toFixed(2)} (sent yesterday); short 1.50 on 1 line; 1 disputed and 1 request at each end`);
    const tk = rep('ownerT', 'transfers', { ...WIN, opts: { level: 'kitchen' } });
    const ks = (tk.j?.rows || []).find((x) => x.kind === 'site' && x.location_id === PROVO) || {};
    ok(ks.orders === 1 && Number(ks.ordered_qty) === 10 && near(ks.sent_qty, 8) && near(ks.fill_rate, 80) && ks.short_lines === 1 && near(ks.on_time_pct, 100)
       && near(ks.internal_sales, 4) && near(ks.kitchen_cost, 2.4) && near(ks.margin, 1.6) && (tk.j?.rows || []).some((x) => x.kind === 'kitchen' && x.location_id === LOC2),
      `the central kitchen to Provo: 1 order, 8 of 10 sent (fill rate 80%), 1 short line, on time, internal sales 4.00 at cost 2.40, margin 1.60 (${short(ks, 260)})`);
    const tg = rep('ownerT', 'transfers', { ...WIN, opts: { level: 'grid' } });
    const pair = (tg.j?.rows || []).find((x) => x.from_location_id === LOC2 && x.to_location_id === PROVO) || {};
    ok(near(pair.value, 5.5) && pair.transfers === 2, `the grid: Location 2 to Provo received 5.50 in 2 transfers`);
    const tlist = rep('ownerT', 'transfers', { ...WIN, opts: { level: 'list' } });
    const words = Object.fromEntries((tlist.j?.rows || []).map((x) => [x.reference, x.words]));
    ok(words['TR-K1'] === 'Received' && words['TR-2'] === 'In transit' && words['TR-3'] === 'Disputed' && words['TR-4'] === 'Requested' && words['TR-5'] === 'In transit',
      `the list in words: ${short(words, 200)}`);
    const tlistShort = rep('ownerT', 'transfers', { ...WIN, opts: { level: 'list', status: 'DISPUTED' } });
    ok((tlistShort.j?.rows || []).length === 1, 'the list filters by status');
    const trc = rep('ownerT', 'transfers', { ...WIN, opts: { level: 'recharges' } });
    ok((trc.j?.rows || []).length === 1 && near(trc.j.rows[0].amount, 4) && trc.j.rows[0].from_legal === 'Legal A',
      'recharges: the kitchen delivery 4.00 (the statement\'s rule); a transfer between sites of one legal company is not a recharge');
    // Stock value: in transit and the kitchen markup out of the company value
    const v = rep('ownerT', 'value', { ...WIN, opts: { at_day: D(1) } });
    const vp = siteRow(v.j, PROVO) || {};
    const vc = coRow(v.j) || {};
    const lemon = Number(sql(`select value from public.stock_rp__value_at(array['${PROVO}']::uuid[], '${D(1)}') where inventory_item_id = '${I.pLemons}'`));
    const margin = lemon > 0 ? Math.round(lemon * (1 - 2.4 / 4) * 100) / 100 : 0;
    ok(v.status === 0 && near(vp.in_transit, 2) && near(vp.total_value, Number(vp.stock_value) + 2) && vp.internal_margin === 0
       && near(vc.internal_margin, margin) && near(vc.company_value, Number(vc.stock_value) + Number(vc.in_transit) - margin)
       && near(vc.in_transit, 2 + 1000 * pMilkCost),
      `Stock value at ${D(1)}: in transit on the receiving site, Provo's total ${vp.total_value}; the company value takes the kitchen markup out (${margin.toFixed(2)} on lemons worth ${lemon.toFixed(2)} at Provo's cost), site rows keep their cost`);
    const vlegal = rep('ownerT', 'value', { ...WIN, opts: { at_day: D(1), view: 'legal' } });
    ok(near(vlegal.j?.rows?.[0]?.internal_margin, margin) && near(vlegal.j.rows[0].in_transit, vc.in_transit), 'by legal company: one company, the same markup out (the kitchen is in it)');
    // Purchases and price paid
    const pu = rep('ownerT', 'purchases', { ...WIN });
    const pp = siteRow(pu.j, PROVO) || {};
    ok(pu.status === 0 && pp.sent_unapproved === 1 && near(pp.sent_unapproved_value, 10) && pp.substitutions === 1 && near(pp.credit_notes, 0.4)
       && near(pp.invoice_missing, 13) && near(pp.invoiced_after_credits, Number(pp.invoiced) - 0.4)
       && !(pu.j?.meta?.notes || []).some((x) => /come with the purchasing update/.test(x)),
      `Purchases at Provo: 1 order sent unapproved (10.00), 1 line added at delivery, credit notes 0.40, invoiced after credits ${pp.invoiced_after_credits}, no invoice yet 13.00 (the kitchen order left out)`);
    const po = rep('ownerT', 'purchases', { ...WIN, opts: { level: 'order' } });
    const poa = (po.j?.rows || []).find((x) => x.reference === 'PO-A') || {};
    ok(poa.sent_unapproved === true && poa.substitutions === 1, 'the order PO-A: sent unapproved, 1 substitution');
    const pr = rep('ownerT', 'prices', { ...WIN });
    const prp = siteRow(pr.j, PROVO) || {};
    ok(near(prp.overcharge_asked, 1) && near(prp.credits_received, 0.4) && near(prp.written_off, 2) && prp.credit_requests === 2
       && !(pr.j?.meta?.notes || []).some((x) => /purchasing update/.test(x)),
      'Price paid at Provo: overcharge asked 1.00, credit notes 0.40, written off 2.00, 2 requests');
    const prc = rep('ownerT', 'prices', { ...WIN, opts: { level: 'credits' } });
    const prs = rep('ownerT', 'prices', { ...WIN, opts: { level: 'credit_suppliers' } });
    ok((prc.j?.rows || []).length === 2 && prc.j.rows.some((x) => x.reason === 'overcharge' && near(x.received, 0.4)) && prc.j.meta.level === 'credits'
       && (prs.j?.rows || []).some((x) => x.supplier_name === 'Agreed Dairy' && near(x.asked, 1) && near(x.received, 0.4)),
      'the credits, each and by supplier');
    // Count compliance (5.15)
    const cc = rep('ownerT', 'count_compliance', { ...WIN });
    const cp = siteRow(cc.j, PROVO) || {};
    const cl = siteRow(cc.j, LOC2) || {};
    ok(cc.status === 0 && cp.due === 6 && cp.on_time === 1 && cp.missed === 5 && cl.due === 6 && cl.missed === 6 && cp.last_full === D(2) && cp.counts === 1
       && cp.lines_counted === 2 && cp.lines_estimated === 1 && near(cp.counted_pct, 66.67) && near(cp.minutes_avg, 30) && near(cp.variance_value, 1.25),
      `Count compliance: Provo 6 due, 1 on time, 5 missed, last full ${cp.last_full}, 2 lines counted and 1 estimated, 30 minutes, variance 1.25; Location 2 6 missed`);
    const ccal = rep('ownerT', 'count_compliance', { ...WIN, opts: { level: 'calendar' } });
    ok((ccal.j?.rows || []).length === 12 && ccal.j.rows.filter((x) => x.status === 'done').length === 1, 'the calendar: 12 plan days, 1 done');
    // Month end pack (5.23), live (not locked yet)
    const me = rep('ownerT', 'month_end', { ...WIN });
    const mp = siteRow(me.j, PROVO) || {};
    const ml = siteRow(me.j, LOC2) || {};
    const wr = rep('ownerT', 'waste', { ...WIN });
    ok(me.status === 0 && mp.locked === false && near(mp.grni, 20) && near(mp.credits_outstanding, 0.6) && near(mp.recharges_in, 4) && near(ml.recharges_out, 4)
       && near(mp.in_transit, 2) && near(mp.closing_value, siteRow(mv.j, PROVO)?.closing_value) && near(mp.opening_value, siteRow(mv.j, PROVO)?.opening_value)
       && near(mp.waste_value, siteRow(wr.j, PROVO)?.waste_value) && near(mp.purchases, siteRow(mv.j, PROVO)?.received) && mp.legal_company === 'Legal A',
      `Month end at Provo (live): received not invoiced 20.00, credits still owed 0.60, recharges in 4.00, in transit 2.00; closing, opening, purchases equal Stock movement and waste equals Waste (parity)`);
    const mel = rep('ownerT', 'month_end', { ...WIN, opts: { level: 'legal' } });
    ok(mel.j?.rows?.length === 1 && mel.j.rows[0].journal.status === 'not_locked' && mel.j.rows[0].journal.missing_lock.length === 2
       && near(mel.j.rows[0].internal_margin, margin), `by legal company: the journal waits for the locks ("${mel.j?.rows?.[0]?.journal?.words}")`);
    // Needs attention: the Drop 3 rows
    const at = rep('ownerT', 'attention', { ...WIN });
    const kinds = (loc) => Object.fromEntries((at.j?.rows || []).filter((x) => x.location_id === loc).map((x) => [x.kind, x.count]));
    const ka = kinds(PROVO);
    ok(at.status === 0 && ka.approval_waiting === 1 && ka.sent_unapproved === 1 && ka.invoice_missing === 1 && ka.transfer_overdue === 1 && ka.price_rise === 1
       && ka.count_second_approval === 1 && Number(ka.count_missed) >= 1 && kinds(null).invoice_unplaced === 1 && Number(kinds(LOC2).count_missed) >= 1
       && (at.j.rows || []).every((x) => typeof x.words === 'string' && x.words.endsWith('.') && x.ref?.kind === x.kind),
      `needs attention: ${short(ka, 260)} and the company's invoice with no site`);
    ok((db.j?.rows?.attention || []).some((x) => x.kind === 'transfer_overdue'), 'the dashboard shows the same attention rows');
  });

  // ============================================================================================================
  section(65, '65. The weekly email: staged on each venue\'s clock after the count deadline, the company row last, never twice, never an old week');
  await guarded('weekly', () => {
    c.createFrom('n_4b_wk', 'n_4b');
    c.use('n_4b_wk');
    // people with real looking addresses; the HubRise integration login (an owner, as live has it) and a test
    // address that must never be emailed; a site with no stock and a demo venue with stock, never staged
    const HUB = id('10000000', 'b4b1');
    const NOSTOCK = id('e9900000', 1);
    const DEMOV = id('e9900000', 2);
    sql(`update user_profiles set email = 'owner-t@harness-mail.co.uk' where id = '${U.ownerT}';
         update user_profiles set email = 'head-office@harness-mail.co.uk' where id = '${U.mgrAll}';
         update user_profiles set email = 'provo-manager@harness-mail.co.uk' where id = '${U.mgrProvo}';
         update wf_staff set email = null where pos_user_id in ('${U.ownerT}', '${U.mgrAll}', '${U.mgrProvo}');
         insert into user_profiles (id, org_id, location_id, role, email, full_name) values
           ('${HUB}', '${ORG_T}', '${PROVO}', 'owner', 'integration@hubrise.com', 'HubRise integration');
         insert into user_locations (user_id, location_id, role) values ('${HUB}', '${PROVO}', 'owner'), ('${U.ownerT}', '${PROVO}', 'owner') on conflict do nothing;
         insert into locations (id, org_id, name, currency, timezone, status, is_demo) values
           ('${NOSTOCK}', '${ORG_T}', 'Site with no stock', 'GBP', 'Europe/London', 'active', false),
           ('${DEMOV}', '${ORG_T}', 'Demo venue', 'GBP', 'Europe/London', 'active', true);
         insert into venue_clock (location_id, timezone, day_start, synced_at) values ('${NOSTOCK}', 'Europe/London', '06:00', now()), ('${DEMOV}', 'Europe/London', '06:00', now())
           on conflict (location_id) do nothing;
         insert into inventory_items (location_id, org_id, name, kind, base_unit, on_hand, current_cost) values ('${DEMOV}', '${ORG_T}', 'Demo item', 'PURCHASED', 'each', 3, 1);`);
    const dow = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
    const setWeek = (ws, due) => sql(`select set_config('servos.stock_co_write', txid_current()::text, true);
                                      update stock_co_settings set week_start = ${ws} where org_id = '${ORG_T}';
                                      update stock_count_plans set due_by = ${due === 'now' ? `case when (now() at time zone 'Europe/London')::date = '${T}'::date
                                                                                          then ((now() at time zone 'Europe/London') - interval '1 minute')::time else time '23:59' end` : `'${due}'`}
                                       where id = '${W(70)}';`);
    const stage = () => num(`select public.stock_co__weekly_stage()`);
    // a week whose deadline is today, a count approved since the week ended: both sites, then the company row
    setWeek(dow(T), '23:59');
    sql(`insert into stock_counts (id, location_id, name, count_type, status, started_at, submitted_at, approved_at, plan_id)
         values ('${W(91)}', '${LOC2}', 'Week end count', 'FULL', 'APPROVED', now() - interval '2 minutes', now() - interval '1 minute', now(), '${W(70)}')`);
    const n1 = stage();
    const rows1 = pj(sql(`select coalesce(json_agg(json_build_object('loc', location_id, 'ref', ref, 'p', payload) order by location_id nulls first), '[]') from stock_notify_sent where kind = 'weekly'`)) || [];
    const wk = addDays(T, -7);
    ok(rows1.some((x) => x.loc === LOC2 && x.ref === `${LOC2}:${wk}` && x.p.count_in[LOC2] === true && x.p.week_end === addDays(wk, 6)),
      `Location 2 counted since the week ended: its row is staged (week of ${wk}, count in)`);
    const provoStaged = rows1.some((x) => x.loc === PROVO);
    const deadlinePast = sql(`select now() >= ((('${T}'::date)::timestamp + time '23:59') at time zone 'Europe/London')`) === 't';
    ok(provoStaged === deadlinePast, `Provo (no count) is staged only once its deadline has passed (${provoStaged ? 'past' : 'not yet'})`);
    if (!provoStaged) setWeek(dow(T), 'now');
    const n2 = stage();
    const rows2 = pj(sql(`select coalesce(json_agg(json_build_object('loc', location_id, 'ref', ref, 'p', payload) order by location_id nulls first), '[]') from stock_notify_sent where kind = 'weekly'`)) || [];
    const co = rows2.find((x) => x.loc == null) || null;
    ok(rows2.filter((x) => x.loc).length === 2 && co && co.ref === `${ORG_T}:${wk}` && co.p.site_ids.length === 2 && co.p.count_in[LOC2] === true
       && co.p.count_in[PROVO] === false && /^Weekly stock: week of /.test(co.p.title) && co.p.currency_symbol === '£',
      `the company row once both sites have theirs: ${short(co?.p, 260)} (staged ${n1} then ${n2})`);
    ok(stage() === 0 && num(`select count(*) from stock_notify_sent where kind = 'weekly'`) === 3, 'a second run stages nothing (the ledger key)');
    // an old week (deadline over a day ago) is never staged, even with a count
    sql(`delete from stock_notify_sent where kind = 'weekly'`);
    setWeek(dow(addDays(T, -3)), '10:00');
    ok(stage() === 0, 'a week whose deadline passed over a day ago is never staged');
    // who it goes to: by email only; the company row to owners and Stock control all, a site row to its logins
    setWeek(dow(T), 'now');
    stage();
    const idOf = (loc) => sql(`select id from stock_notify_sent where kind = 'weekly' and location_id ${loc ? `= '${loc}'` : 'is null'} limit 1`);
    const tg = (nid) => callJ('service', `select public.stock_notify_targets(${nid})`).j || {};
    const tc = tg(idOf(null));
    const ts = tg(idOf(PROVO));
    ok(Array.isArray(tc.bell) && tc.bell.length === 0 && tc.people.some((p) => p.user_id === U.ownerT) && tc.people.some((p) => p.user_id === U.mgrAll)
       && !tc.people.some((p) => p.user_id === U.mgrProvo) && tc.people.every((p) => p.sms === false),
      `the company email: owners and Stock control all, no bell, no text (${tc.people?.length} people)`);
    ok(ts.bell.length === 0 && ts.people.some((p) => p.user_id === U.mgrProvo), `the Provo email: the logins linked to Provo (${ts.people?.length} people)`);
    const allPeople = [tc, ...[PROVO, LOC2].map((l) => tg(idOf(l)))].flatMap((t) => t.people || []);
    ok(!allPeople.some((p) => p.user_id === HUB || /hubrise|example\.test/i.test(p.email || '')),
      `the HubRise integration login and test addresses are never a recipient (${allPeople.length} emails, none of them)`);
    ok(allPeople.filter((p) => p.user_id === U.ownerT).length === 1 && !ts.people.some((p) => p.user_id === U.ownerT || p.user_id === U.mgrAll),
      'an owner linked to a site gets one email (the company one), never also the site one');
    ok(num(`select count(*) from stock_notify_sent where kind = 'weekly' and location_id in ('${NOSTOCK}', '${DEMOV}')`) === 0
       && !(pj(sql(`select payload -> 'site_ids' from stock_notify_sent where kind = 'weekly' and location_id is null`)) || []).some((x) => x === NOSTOCK || x === DEMOV),
      'a site with no stock and a demo venue are never staged, nor in the company email');
    // the same person rule on every other kind (the Drop 3 body, then the filter): a price rise to company editors
    sql(`insert into stock_notify_sent (org_id, location_id, kind, ref, payload) values ('${ORG_T}', '${PROVO}', 'price_rise', 'pr-hub-${HUB}', '{}')`);
    const pr = tg(sql(`select id from stock_notify_sent where ref = 'pr-hub-${HUB}'`));
    ok(Array.isArray(pr.people) && pr.people.length > 0 && !pr.people.some((p) => p.user_id === HUB && p.email_on !== false) && pr.people.some((p) => p.user_id === U.ownerT),
      `a Drop 3 alert (price rise to company editors): the owner yes, the HubRise login never emailed (${pr.people?.length} people)`);
    const okWords = (e) => sql(`select public.stock_co__notify_email_ok(${lit(e)})`) === 't';
    const ADDR = [['a.person@coffee-shop.co.uk', true], ['integration@hubrise.com', false], ['x@eu.hubrise.com', false], ['bob@example.com', false], ['a@b.test', false],
      ['a@b.invalid', false], ['a@host.local', false], ['noreply@coffee.co.uk', false], ['no-reply@coffee.co.uk', false], ['not an address', false], ['', false]];
    const wrong = ADDR.filter(([e, want]) => okWords(e) !== want).map(([e]) => e);
    ok(wrong.length === 0, `stock_co__notify_email_ok answers as its JS twin on ${ADDR.length} addresses (${wrong.join(', ') || 'all'})`);
    const other = callJ('service', `select public.stock_notify_targets(${sql(`select id from stock_notify_sent where kind <> 'weekly' order by id limit 1`) || 0})`);
    ok(other.status === 0, 'every other kind still answers through the Drop 3 body');
    const due = asCaller('sqlEditor', 'select public.stock_notify_due()');
    ok(due.status === 0, `stock_notify_due runs as pg_cron does (${outcome(due)})`);
    const denied = asCaller('ownerT', `select public.stock_co__weekly_stage()`);
    ok(denied.status !== 0, `a login cannot run the staging (${outcome(denied)})`);
  });

  // ============================================================================================================
  section(66, '66. A locked period: the snapshot holds every figure and every report reads it; an old snapshot by its old names');
  await guarded('locked', () => {
    c.createFrom('n_4b_lk', 'n_4b');
    c.use('n_4b_lk');
    const live = rep('ownerT', 'month_end', { ...WIN });
    const liveDash = rep('ownerT', 'dashboard', { ...WIN });
    const l1 = callJ('ownerT', `select public.stock_lock_period('${PROVO}', '${WIN.from}', '${WIN.to}')`);
    const keys = Object.keys(l1.j?.metrics || {});
    const need = ['stock_value', 'cogs', 'count_variance', 'opening_value', 'closing_value', 'purchases', 'transfers_in', 'transfers_out', 'made', 'used_in_batches',
      'sold_cost', 'waste', 'revalue', 'count_adj', 'sales_net', 'theo_cost', 'actual_cost', 'comps_cost', 'comps_qty', 'by_category', 'in_transit', 'grni',
      'credits_outstanding', 'recharges_in', 'recharges_out', 'internal_margin', 'internal_margin_same_legal'];
    ok(l1.status === 0 && need.every((k) => keys.includes(k)), `the 4b lock writes every figure the reports read (${need.filter((k) => !keys.includes(k)).join(', ') || 'all ' + need.length})`);
    // a back dated delivery inside the period moves the ledger, never the locked figures
    sql(`select public._post_stock_movement('${PROVO}', '${I.pMilk}', 500, 'PURCHASE_RECEIPT', 0.01, 'purchase_order', 'late-${W(99)}', 'late:${W(99)}', '${D(3)}T12:00:00Z', null, null, null)`);
    dsDrainAll();
    const mv2 = rep('ownerT', 'movement', { ...WIN, sites: [LOC2, PROVO] });
    const me2 = rep('ownerT', 'month_end', { ...WIN });
    const d2 = rep('ownerT', 'dashboard', { ...WIN });
    const lp = siteRow(live.j, PROVO), p2 = siteRow(me2.j, PROVO);
    ok(p2.locked === true && near(p2.closing_value, lp.closing_value) && near(p2.purchases, lp.purchases) && near(p2.grni, lp.grni) && near(p2.opening_value, lp.opening_value)
       && near(siteRow(d2.j, PROVO)?.purchases, siteRow(liveDash.j, PROVO)?.purchases) && (d2.j.meta.windows || []).find((w) => w.location_id === PROVO)?.snapshot === true,
      `after a back dated delivery the month end and the dashboard still read the locked figures (purchases ${p2.purchases})`);
    const ledger = Number(sql(`select coalesce(sum(value), 0) from stock_day_sums where location_id = '${PROVO}' and movement_type = 'PURCHASE_RECEIPT' and demo = false and business_day between '${WIN.from}' and '${WIN.to}'`));
    ok(near(ledger, Number(lp.purchases) + 5) && near(siteRow(mv2.j, PROVO)?.received, lp.purchases),
      `the ledger now holds ${ledger.toFixed(2)} of deliveries in the period, Stock movement over the locked period still reads the snapshot's ${lp.purchases}`);
    const v = rep('ownerT', 'value', { ...WIN, opts: { at_day: WIN.to } });
    const vs = siteRow(v.j, PROVO) || {};
    ok(near(vs.stock_value, l1.j.metrics.value_positive) && near(vs.negative_value, l1.j.metrics.value_negative) && near(coRow(v.j)?.stock_value, Number(vs.stock_value) + Number(siteRow(v.j, LOC2)?.stock_value)),
      `Stock value at the period end reads the snapshot as Stock value shows it (${vs.stock_value}, negative ${vs.negative_value} apart), the company row adds it`);
    // the journal: ready only when every site of the legal company is locked
    const j1 = callJ('ownerT', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`).j?.legal?.[0] || {};
    ok(j1.status === 'not_locked' && j1.missing_lock.length === 1, `one site locked: the journal still waits (${j1.missing_lock})`);
    callJ('ownerT', `select public.stock_lock_period('${LOC2}', '${WIN.from}', '${WIN.to}')`);
    const j2 = callJ('ownerT', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`).j?.legal?.[0] || {};
    const mel = rep('ownerT', 'month_end', { ...WIN, opts: { level: 'legal' } }).j?.rows?.[0] || {};
    ok(j2.status === 'ready' && near(j2.amount, mel.movement) && near(mel.closing_value - mel.opening_value, mel.movement) && mel.locked_all === true,
      `both locked: the journal is ready, ${j2.amount} (closing less opening, kitchen markup out: ${mel.internal_margin})`);
    const reconnect = sql(`update xero_connections set scopes = 'openid offline_access accounting.invoices' where location_id in ('${PROVO}', '${LOC2}')`);
    const j3 = callJ('ownerT', `select public.stock_month_end_journal('${ORG_T}', '${WIN.from}', '${WIN.to}')`).j?.legal?.[0] || {};
    ok(reconnect !== null && j3.status === 'needs_reconnect' && j3.words === 'Reconnect Xero to allow stock journals.',
      `a Xero sign in without the journal scope: "${j3.words}" (never a failure)`);
    const me3 = rep('ownerT', 'month_end', { ...WIN, opts: { level: 'category' } });
    ok((me3.j?.rows || []).length > 0 && me3.j.rows.every((x) => x.closing_value != null), 'the month end by category reads the snapshot\'s categories');
    // an old snapshot (written by the Drop 3 lock before 4b) is read by its old names
    c.createFrom('n_4b_old2', 'n_4b_oldsnap');
    c.use('n_4b_old2');
    const p = paste(FILES.d4b);
    ok(p.status === 0, `4b applies over a Drop 3 snapshot (${p.status ? short(p.stderr, 300) : 'ok'})`);
    const snapStock = Number(sql(`select (s.metrics ->> 'stock_value')::numeric from stock_period_snapshots s join stock_periods p on p.id = s.period_id where p.location_id = '${LOC2}'`));
    const mo = rep('ownerT', 'movement', { sites: [LOC2], from: D(13), to: D(8) });
    ok(near(siteRow(mo.j, LOC2)?.closing_value, snapStock) && (mo.j.meta.windows || [])[0]?.snapshot === true,
      `a Drop 3 snapshot's stock_value is read as the closing value (${snapStock})`);
  });

  // ============================================================================================================
  const SITES = QUICK ? 10 : 50;
  section(67, `67. Speed: ${SITES} sites by 500 items by 31 days, every 4b report and every changed one under 5 s as the owner under the 8 s limit`);
  await guarded('speed', () => {
    c.createFrom('n_4b_scale', 'n_4b');
    c.use('n_4b_scale');
    const loc = (n) => `e9000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const sites = Array.from({ length: SITES }, (_, k) => loc(k + 1));
    const t0 = Date.now();
    sql(`select set_config('servos.stock_co_write', txid_current()::text, true);
      insert into organisations (id, name) values ('${SCALE_ORG}', 'Scale 4b company');
      insert into locations (id, org_id, name, currency, timezone, status)
        select ('e9000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, '${SCALE_ORG}', 'Scale site ' || lpad(n::text, 2, '0'), 'GBP', 'Europe/London', 'active' from generate_series(1, ${SITES}) n;
      insert into venue_clock (location_id, timezone, day_start, synced_at) select id, 'Europe/London', '06:00', now() from locations where org_id = '${SCALE_ORG}';
      insert into stock_co_settings (org_id, multi_since, week_start) values ('${SCALE_ORG}', now(), 1) on conflict (org_id) do update set multi_since = now();
      insert into stock_co_site_settings (location_id, org_id, site_kind) values ('${loc(1)}', '${SCALE_ORG}', 'central_kitchen') on conflict (location_id) do update set site_kind = 'central_kitchen';
      insert into stock_co_items (id, org_id, name, base_unit)
        select ('e7100000-0000-4000-8000-' || lpad(to_hex(k), 12, '0'))::uuid, '${SCALE_ORG}', 'Scale item ' || lpad(k::text, 3, '0'), 'each' from generate_series(1, 500) k;
      insert into inventory_items (id, location_id, org_id, name, kind, base_unit, company_ref, on_hand, current_cost)
        select gen_random_uuid(), l.id, l.org_id, 'Scale item ' || lpad(k::text, 3, '0'), 'PURCHASED', 'each', ('e7100000-0000-4000-8000-' || lpad(to_hex(k), 12, '0'))::uuid,
               20 + (k % 7), round(0.5 + (k % 13) * 0.25, 2)
          from locations l cross join generate_series(1, 500) k where l.org_id = '${SCALE_ORG}';
      delete from stock_day_sums_repair where location_id in (select id from locations where org_id = '${SCALE_ORG}');
      delete from sales_day_sums_queue where location_id in (select id from locations where org_id = '${SCALE_ORG}');
      insert into stock_day_sums (location_id, business_day, inventory_item_id, company_item_id, movement_type, source_type, qty_base, value, clock_known, demo)
        select i.location_id, d::date, i.id, i.company_ref, t.mt, t.st, t.q, t.q * i.current_cost, true, false
          from inventory_items i
         cross join generate_series(current_date - 30, current_date, interval '1 day') d
         cross join lateral (values ('SALE_DEPLETION', 'closed_check', -1.0), ('PURCHASE_RECEIPT', 'purchase_order', 1.0), ('TRANSFER_IN', 'transfer', 0.5)) t(mt, st, q)
         where i.location_id in (select id from locations where org_id = '${SCALE_ORG}')
           and (t.mt = 'SALE_DEPLETION' and (hashtext(i.id::text || d::text) % 10) < 3 or t.mt = 'PURCHASE_RECEIPT' and (hashtext(i.id::text || d::text) % 50) = 0
                or t.mt = 'TRANSFER_IN' and (hashtext(i.id::text || d::text) % 97) = 0);
      insert into sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net, discount_spread, reward_spread, tax, loyalty_qty, staff_qty, comp_qty,
                                  loyalty_cost, staff_cost, comp_cost, theo_cost, clock_known, sale_net, sale_theo, refund_net, refund_tax, refund_gross, refund_qty, refund_cost)
        select l.id, d::date, 'm-scale-' || p, 'dine-in', 5, 20, 16.67, 0, 0, 3.33, 0, 0, 0, 0, 0, 0, 4.1, true, 16.67, 4.1, 0, 0, 0, 0, 0
          from locations l cross join generate_series(current_date - 30, current_date, interval '1 day') d cross join generate_series(1, 60) p
         where l.org_id = '${SCALE_ORG}';
      insert into suppliers (id, location_id, org_id, name)
        select gen_random_uuid(), l.id, l.org_id, 'Scale supplier' from locations l where l.org_id = '${SCALE_ORG}';
      insert into purchase_orders (id, location_id, supplier_id, reference, status, ordered_at, received_at, expected_date, subtotal, tax, sent_unapproved_at)
        select gen_random_uuid(), s.location_id, s.id, 'SPO-' || k, case when k % 3 = 0 then 'SENT' else 'RECEIVED' end, now() - (k || ' days')::interval,
               case when k % 3 = 0 then null else now() - ((k - 1) || ' days')::interval end, current_date - k + 1, 100, 20,
               case when k % 5 = 0 then now() - (k || ' days')::interval end
          from suppliers s cross join generate_series(1, 30) k where s.location_id in (select id from locations where org_id = '${SCALE_ORG}');
      insert into po_lines (location_id, po_id, inventory_item_id, qty_packs, unit_price, qty_received)
        select po.location_id, po.id, (select i.id from inventory_items i where i.location_id = po.location_id order by i.id limit 1 offset (hashtext(po.id::text || g::text) & 255)), 2, 10,
               case when po.status = 'RECEIVED' then 2 else 0 end
          from purchase_orders po cross join generate_series(1, 5) g where po.location_id in (select id from locations where org_id = '${SCALE_ORG}');
      insert into supplier_invoices (id, location_id, supplier_id, po_id, invoice_number, invoice_date, status, subtotal, tax, total)
        select gen_random_uuid(), po.location_id, po.supplier_id, po.id, 'SINV-' || po.reference, (po.received_at)::date, 'POSTED', po.subtotal, po.tax, po.subtotal + po.tax
          from purchase_orders po where po.status = 'RECEIVED' and po.location_id in (select id from locations where org_id = '${SCALE_ORG}') and hashtext(po.id::text) % 2 = 0;
      insert into supplier_invoice_lines (location_id, invoice_id, matched_item_id, description, qty, unit_price, line_total)
        select v.location_id, v.id, l.inventory_item_id, 'line', l.qty_packs, l.unit_price, l.qty_packs * l.unit_price
          from supplier_invoices v join po_lines l on l.po_id = v.po_id where v.location_id in (select id from locations where org_id = '${SCALE_ORG}');
      insert into stock_transfers (id, location_id, to_location_id, status, kind, reference, sent_at, received_at)
        select gen_random_uuid(), '${loc(1)}', l.id, case when k % 4 = 0 then 'SENT' else 'RECEIVED' end, 'central_kitchen', 'ST-' || k, now() - (k || ' days')::interval,
               case when k % 4 = 0 then null else now() - ((k - 1) || ' days')::interval end
          from locations l cross join generate_series(1, 10) k where l.org_id = '${SCALE_ORG}' and l.id <> '${loc(1)}';
      insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, to_inventory_item_id, qty_base, unit_cost, to_unit_cost, qty_received_base)
        select t.id, t.location_id, t.to_location_id, (select i.id from inventory_items i where i.location_id = t.location_id order by i.id limit 1),
               (select i.id from inventory_items i where i.location_id = t.to_location_id order by i.id limit 1), 5, 1.0, 1.2, case when t.status = 'RECEIVED' then 5 end
          from stock_transfers t where t.location_id = '${loc(1)}';
      insert into stock_count_plans (id, org_id, name, count_type, every, due_by, active, created_at)
        values ('e9200000-0000-4000-8000-000000000001', '${SCALE_ORG}', 'Daily count', 'FULL', 'day', '10:00', true, now() - interval '60 days');
      insert into stock_budgets (org_id, location_id, rule, amount) values ('${SCALE_ORG}', null, 'fixed', 1000);
      insert into stock_counts (id, location_id, name, count_type, status, started_at, submitted_at, approved_at, plan_id)
        select gen_random_uuid(), l.id, 'Full count ' || k, 'FULL', 'APPROVED', (current_date - k)::timestamp + interval '8 hours',
               (current_date - k)::timestamp + interval '8 hours 30 minutes', (current_date - k)::timestamp + interval '9 hours', 'e9200000-0000-4000-8000-000000000001'
          from locations l cross join generate_series(1, 30, 7) k where l.org_id = '${SCALE_ORG}';
      insert into user_profiles (id, org_id, location_id, role, email, full_name) values ('${SCALE_OWNER}', '${SCALE_ORG}', '${loc(1)}', 'owner', 'scale4b@example.test', 'Scale Owner');
      analyze;`);
    const n = pj(sql(`select json_build_object('sites', (select count(*) from locations where org_id = '${SCALE_ORG}'),
        'items', (select count(*) from inventory_items i join locations l on l.id = i.location_id where l.org_id = '${SCALE_ORG}'),
        'orders', (select count(*) from purchase_orders po join locations l on l.id = po.location_id where l.org_id = '${SCALE_ORG}'),
        'invoice_lines', (select count(*) from supplier_invoice_lines x join locations l on l.id = x.location_id where l.org_id = '${SCALE_ORG}'),
        'transfers', (select count(*) from stock_transfers t join locations l on l.id = t.location_id where l.org_id = '${SCALE_ORG}'))`)) || {};
    ok(n.sites === SITES && n.items === SITES * 500, `the synthetic company: ${short(n)} (built in ${Date.now() - t0} ms)`);
    const range = { from: addDays(T, -30), to: T };
    const RUNS = [...D4B_REPORTS.map((x) => [x, null]), ...CHANGED.map((x) => [x, null]),
      ['off_contract', { level: 'line' }], ['off_contract', { level: 'item' }], ['budget', { level: 'week' }], ['transfers', { level: 'list' }], ['transfers', { level: 'kitchen' }],
      ['transfers', { level: 'grid' }], ['count_compliance', { level: 'calendar' }], ['count_compliance', { level: 'count' }], ['month_end', { level: 'legal' }],
      ['month_end', { level: 'category' }], ['value', { view: 'legal' }], ['purchases', { level: 'order' }], ['prices', { level: 'credits' }]];
    const slow = []; const times = [];
    for (const [name, opts] of RUNS) {
      const r = rep('scaleOwner', name, { org: SCALE_ORG, sites, ...range, opts });
      times.push(`${name}${opts ? `:${opts.level || opts.view}` : ''} ${r.ms}`);
      if (r.status !== 0 || r.ms >= 5000) slow.push(`${name} ${JSON.stringify(opts)}: ${outcome(r)} ${r.ms} ms`);
    }
    console.log(`     ms: ${times.join(', ')}`);
    ok(slow.length === 0, `${RUNS.length} calls over ${SITES} sites by 31 days, each under 5 s as the owner under the 8 s limit (${slow.join('; ') || 'all'})`);
    const pages = [];
    let after = null;
    for (let k = 0; k < 20; k++) {
      const r = rep('scaleOwner', 'count_compliance', { org: SCALE_ORG, sites, ...range, opts: { level: 'calendar' }, after, limit: 1000 });
      if (r.status !== 0) { pages.push(outcome(r)); break; }
      pages.push(r.j.rows.length);
      if (!r.j.next) break;
      after = r.j.next;
    }
    const total = pages.filter((x) => typeof x === 'number').reduce((t, x) => t + x, 0);
    ok(pages.every((x) => typeof x === 'number' && x <= 1000) && total === SITES * 31, `the calendar pages by 1,000 at most, keyset, never a row twice (${pages.join(', ')} = ${total})`);
    const jt = Date.now();
    const jr = callJ('scaleOwner', `select public.stock_month_end_journal('${SCALE_ORG}', '${addDays(T, -30)}', '${addDays(T, -1)}')`);
    ok(jr.status === 0 && Date.now() - jt < 8000, `the closing stock journal over ${SITES} sites: ${Date.now() - jt} ms (${outcome(jr)})`);
  });

  // ============================================================================================================
  section(68, '68. The rollback: every body back by md5, nothing of 4b left, every changed report as before; then 4b again');
  await guarded('rollback', () => {
    c.use('n_4b_fresh');
    const rb = paste(FILES.d4bRb);
    const x = lastRows(rb)[0] || {};
    console.log(`     rollback: ${short(x, 400)}`);
    ok(rb.status === 0 && x.bodies_restored === '11' && x.functions_left === '0' && x.tables_left === '0' && x.kind_check_back === 't' && x.backup_rows_deleted === '12'
       && x.site_rows_changed === '0', `the rollback: 11 bodies back, nothing left, the kind check back, 12 backup rows gone, no site row changed${rb.status ? `: ${short(rb.stderr, 500)}` : ''}`);
    const diff = D4B_LIVE_MD5.filter(([sig, want]) => md5Of(sig) !== want).map(([sig]) => sig);
    ok(diff.length === 0, `every body has its live md5 again (${diff.join(', ') || `all ${D4B_LIVE_MD5.length}`})`);
    const acl = [[`public.stock_report_league${SIG7}`, 'authenticated,postgres,service_role'], [`public.stock_report_value${SIG7}`, 'authenticated,postgres'],
      ['public.stock_notify_targets(bigint)', 'postgres,service_role'], ['public.stock_notify_due()', 'postgres']].filter(([s, a]) => aclOf(s) !== a);
    ok(acl.length === 0, `their grants as before (${acl.map(([s]) => s).join(', ') || 'all'})`);
    const back = snapshotReports();
    const d1 = Object.keys(before).filter((k) => before[k] !== back[k]);
    ok(d1.length === 0, `every changed report answers exactly what it answered before 4b (${Object.keys(before).length} answers${d1.length ? `; differ: ${d1.slice(0, 4).join(', ')}` : ''})`);
    const again = paste(FILES.d4b);
    ok(again.status === 0, `4b applies again after its rollback (${again.status ? short(again.stderr, 400) : 'ok'})`);
    const after2 = snapshotReports();
    const d2 = Object.keys(first).filter((k) => first[k] !== after2[k]);
    ok(d2.length === 0, `and every report answers exactly what it answered the first time (${Object.keys(first).length} answers${d2.length ? `; differ: ${d2.slice(0, 4).join(', ')}` : ''})`);
  });

  // -- the world (written before 4b, so the rollback proof compares like with like) ---------------------------------
  function buildWorld() {
    const at = (d, h) => `(public.stock_co__day_start_at('${d}'::date, time '06:00', 'Europe/London') + interval '${h} hours')`;
    const lemonsUnit = sql(`select base_unit from inventory_items where id = '${I.pLemons}'`) || 'each';
    sql(`select set_config('servos.stock_co_write', txid_current()::text, true);
      select set_config('servos.stock_control_write', txid_current()::text, true);
      insert into venue_clock (location_id, timezone, day_start, synced_at) values ('${PROVO}', 'Europe/London', '06:00', now()), ('${LOC2}', 'Europe/London', '06:00', now())
        on conflict (location_id) do update set timezone = excluded.timezone, day_start = excluded.day_start;
      update user_profiles set stock_control = 'all' where id = '${U.mgrAll}';
      insert into stock_co_settings (org_id, multi_since, week_start) values ('${ORG_T}', now(), 1) on conflict (org_id) do nothing;
      -- the central kitchen (Location 2) and its supplier at Provo; Provo buys lemons only from it
      insert into stock_co_site_settings (location_id, org_id, site_kind) values ('${LOC2}', '${ORG_T}', 'central_kitchen')
        on conflict (location_id) do update set site_kind = 'central_kitchen';
      insert into stock_co_suppliers (id, org_id, name, internal_location_id, accepts_price_changes, order_method) values ('${W(1)}', '${ORG_T}', 'Central kitchen, Location 2', '${LOC2}', false, 'email');
      insert into suppliers (id, location_id, org_id, name, company_ref) values ('${W(2)}', '${PROVO}', '${ORG_T}', 'Central kitchen, Location 2', '${W(1)}');
      update supplier_products set archived_at = now() where inventory_item_id = '${I.pLemons}' and location_id = '${PROVO}';
      insert into supplier_products (id, location_id, inventory_item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price) values ('${W(3)}', '${PROVO}', '${I.pLemons}', '${W(2)}', 1, 1, ${lit(lemonsUnit)}, 0.50);
      -- a supplier with agreed prices (milk at 5.00 a pack, no allowed difference)
      insert into stock_co_suppliers (id, org_id, name, accepts_price_changes) values ('${W(4)}', '${ORG_T}', 'Agreed Dairy', false);
      insert into suppliers (id, location_id, org_id, name, company_ref) values ('${W(5)}', '${PROVO}', '${ORG_T}', 'Agreed Dairy', '${W(4)}');
      insert into stock_co_supplier_items (id, org_id, item_id, supplier_id, pack_qty, inner_qty, inner_unit, pack_price, allowed_diff_pct, currency)
        select '${W(6)}', '${ORG_T}', i.company_ref, '${W(4)}', 1, 1, i.base_unit, 5.00, 0, 'GBP' from inventory_items i where i.id = '${I.pMilk}';
      insert into supplier_products (id, location_id, inventory_item_id, supplier_id, company_ref, pack_qty, inner_qty, inner_unit, pack_price)
        select '${W(7)}', '${PROVO}', '${I.pMilk}', '${W(5)}', '${W(6)}', 1, 1, i.base_unit, 5.00 from inventory_items i where i.id = '${I.pMilk}';
      -- Xero: both sites in one legal company, signed in with the journal scope
      insert into xero_connections (location_id, tenant_id, tenant_name, scopes, created_at, updated_at) values
        ('${PROVO}', 'tenant-a', 'Legal A', 'openid profile email accounting.invoices accounting.manualjournals accounting.settings offline_access', now() - interval '30 days', now()),
        ('${LOC2}', 'tenant-a', 'Legal A', 'openid profile email accounting.invoices accounting.manualjournals accounting.settings offline_access', now() - interval '30 days', now());
      -- orders
      insert into purchase_orders (id, location_id, supplier_id, reference, status, expected_date, ordered_at, received_at, subtotal, tax, delivery_fee, sent_unapproved_at) values
        ('${W(10)}', '${PROVO}', '${SUP.pDairy}', 'PO-A', 'RECEIVED', '${D(3)}', ${at(D(5), 3)}, ${at(D(3), 2)}, 10, 0, 2, ${at(D(5), 3)}),
        ('${W(11)}', '${LOC2}', '${SUP.lDairy}', 'PO-B', 'RECEIVED', '${D(3)}', ${at(D(4), 2)}, ${at(D(3), 2)}, 20, 4, null, null),
        ('${W(12)}', '${PROVO}', '${SUP.pBean}', 'PO-C', 'SENT', '${T}', ${at(D(1), 3)}, null, 40, 8, null, null),
        ('${W(13)}', '${PROVO}', '${SUP.pDry}', 'PO-D', 'RECEIVED', '${D(10)}', now() - interval '12 days', now() - interval '9 days', 7, 0, null, null),
        ('${W(14)}', '${PROVO}', '${W(2)}', 'PO-K', 'RECEIVED', '${D(2)}', ${at(D(4), 2)}, ${at(D(2), 3)}, 5, 0, null, null);
      insert into po_lines (location_id, po_id, inventory_item_id, description, qty_packs, unit_price, qty_received) values
        ('${PROVO}', '${W(10)}', '${I.pMilk}', 'Milk', 2, 5, 2), ('${PROVO}', '${W(10)}', '${I.pButter}', 'Butter (added at the door)', 0, 3, 1),
        ('${LOC2}', '${W(11)}', '${I.lMilk}', 'Milk', 4, 5, 4), ('${PROVO}', '${W(12)}', '${I.pBeans}', 'Beans', 4, 10, 0),
        ('${PROVO}', '${W(13)}', '${I.pCups}', 'Cups', 1, 7, 1), ('${PROVO}', '${W(14)}', '${I.pLemons}', 'Lemons', 10, 0.50, 8);
      insert into stock_po_approvals (org_id, location_id, po_id, amount, limit_amount, status) values ('${ORG_T}', '${PROVO}', '${W(12)}', 40, 30, 'waiting');
      -- invoices: Location 2's order, and a Provo invoice with an agreed price line over, eggs from a supplier that has no deal for them, a shop buy
      insert into supplier_invoices (id, location_id, supplier_id, po_id, invoice_number, invoice_date, status, subtotal, tax, total, posted_at) values
        ('${W(20)}', '${LOC2}', '${SUP.lDairy}', '${W(11)}', 'INV-B', '${D(3)}', 'POSTED', 20, 4, 24, now()),
        ('${W(21)}', '${PROVO}', '${W(5)}', null, 'INV-1', '${D(2)}', 'POSTED', 16.50, 0, 16.50, now());
      insert into supplier_invoice_lines (location_id, invoice_id, matched_item_id, description, qty, unit_price, line_total, supplier_product_id) values
        ('${LOC2}', '${W(20)}', '${I.lMilk}', 'Milk', 4, 5, 20, null),
        ('${PROVO}', '${W(21)}', '${I.pMilk}', 'Milk', 2, 5.50, 11.00, '${W(7)}'),
        ('${PROVO}', '${W(21)}', '${I.pEggs}', 'Eggs', 1, 3.00, 3.00, null),
        ('${PROVO}', '${W(21)}', null, 'Shop milk', 1, 2.50, 2.50, null);
      -- credits
      insert into stock_credit_requests (id, org_id, location_id, supplier_id, invoice_id, reason, status, amount, created_at) values
        ('${W(30)}', '${ORG_T}', '${PROVO}', '${W(5)}', '${W(21)}', 'overcharge', 'asked', 1.00, ${at(D(2), 5)}),
        ('${W(31)}', '${ORG_T}', '${PROVO}', '${SUP.pDairy}', null, 'short', 'written_off', 2.00, ${at(D(3), 6)});
      insert into stock_credit_notes (org_id, location_id, supplier_id, request_id, number, note_date, amount) values ('${ORG_T}', '${PROVO}', '${W(5)}', '${W(30)}', 'CN-1', '${D(1)}', 0.40);
      -- budgets: the company 700 a week, Provo 30% of its forecast
      insert into stock_budgets (org_id, location_id, rule, amount) values ('${ORG_T}', null, 'fixed', 700);
      insert into stock_budgets (org_id, location_id, rule, pct) values ('${ORG_T}', '${PROVO}', 'pct_of_forecast', 30);
      -- a daily count plan; Provo counted on time two days ago (2 lines counted, 1 estimated); a count waiting a second approval
      insert into stock_count_plans (id, org_id, name, count_type, every, due_by, active, created_at) values ('${W(70)}', '${ORG_T}', 'Daily count', 'FULL', 'day', '10:00', true, now() - interval '20 days');
      insert into stock_counts (id, location_id, name, count_type, status, started_at, submitted_at, approved_at, approved_by_name, variance_value, plan_id) values
        ('${W(71)}', '${PROVO}', 'Morning count', 'FULL', 'APPROVED', ${at(D(2), 3)}, ${at(D(2), 3.5)}, ${at(D(2), 3.7)}, 'Manager One', -1.25, '${W(70)}');
      insert into stock_count_lines (location_id, count_id, inventory_item_id, counted_qty, expected_qty, variance_qty, unit_cost) values
        ('${PROVO}', '${W(71)}', '${I.pMilk}', 10, 11, -1, 1), ('${PROVO}', '${W(71)}', '${I.pEggs}', 5, 5, 0, 0.25), ('${PROVO}', '${W(71)}', '${I.pButter}', null, 2, null, 1.5);
      insert into stock_counts (id, location_id, name, count_type, status, started_at, submitted_at, second_approval_needed_at) values
        ('${W(72)}', '${PROVO}', 'Big variance count', 'FULL', 'SUBMITTED', now() - interval '3 hours', now() - interval '2 hours', now() - interval '1 hour');
      -- the company inbox: an invoice nobody could place; a price rise alert this week
      insert into stock_invoice_inbox (org_id, source, file_path, file_name, status) values ('${ORG_T}', 'upload', 'org/${ORG_T}/inv.pdf', 'inv.pdf', 'waiting');
      insert into stock_notify_sent (org_id, location_id, kind, ref, payload, status, created_at) values ('${ORG_T}', '${PROVO}', 'price_rise', 'pr-${W(80)}', '{}', 'sent', now() - interval '1 day');
      -- transfers: the kitchen delivery (8 of 10 sent, cost 0.30, the site pays 0.50), one in transit, one disputed and short, a request, one overdue
      insert into stock_transfers (id, location_id, to_location_id, status, kind, reference, sent_at, received_at, requested_at, purchase_order_id, disputed_at, dispute_note) values
        ('${W(40)}', '${LOC2}', '${PROVO}', 'RECEIVED', 'central_kitchen', 'TR-K1', ${at(D(3), 4)}, ${at(D(2), 3)}, null, '${W(14)}', null, null),
        ('${W(41)}', '${PROVO}', '${LOC2}', 'SENT', 'transfer', 'TR-2', ${at(D(1), 9)}, null, null, null, null, null),
        ('${W(42)}', '${LOC2}', '${PROVO}', 'DISPUTED', 'transfer', 'TR-3', ${at(D(3), 5)}, ${at(D(2), 4)}, null, null, now(), 'One short'),
        ('${W(43)}', '${LOC2}', '${PROVO}', 'REQUESTED', 'request', 'TR-4', null, null, ${at(D(1), 2)}, null, null, null),
        ('${W(44)}', '${LOC2}', '${PROVO}', 'SENT', 'transfer', 'TR-5', now() - interval '3 days', null, null, null, null, null);
      insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, to_inventory_item_id, qty_base, unit_cost, to_unit_cost, qty_received_base, short_qty_base, requested_qty_base) values
        ('${W(40)}', '${LOC2}', '${PROVO}', '${I.lLemons}', '${I.pLemons}', 8, 0.30, 0.50, 8, 0, null),
        ('${W(41)}', '${PROVO}', '${LOC2}', '${I.pMilk}', '${I.lMilk}', 1000, (select current_cost from inventory_items where id = '${I.pMilk}'), null, null, null, null),
        ('${W(42)}', '${LOC2}', '${PROVO}', '${I.lButter}', '${I.pButter}', 2, 1.50, null, 1, 1, null),
        ('${W(43)}', '${LOC2}', '${PROVO}', '${I.lEggs}', '${I.pEggs}', 6, null, null, null, null, 6),
        ('${W(44)}', '${LOC2}', '${PROVO}', '${I.lBeans}', '${I.pBeans}', 100, 0.02, null, null, null, null);
      select public._post_stock_movement('${LOC2}', '${I.lLemons}', -8, 'TRANSFER_OUT', 0.30, 'transfer', '${W(40)}', 'transfer:${W(40)}:out', ${at(D(3), 4)}, null, null, null);
      select public._post_stock_movement('${PROVO}', '${I.pLemons}', 8, 'TRANSFER_IN', 0.50, 'transfer', '${W(40)}', 'transfer:${W(40)}:in', ${at(D(2), 3)}, null, null, null);
      select public._post_stock_movement('${PROVO}', '${I.pMilk}', -1000, 'TRANSFER_OUT', null, 'transfer', '${W(41)}', 'transfer:${W(41)}:out', ${at(D(1), 9)}, null, null, null);
      select public._post_stock_movement('${LOC2}', '${I.lButter}', -2, 'TRANSFER_OUT', 1.50, 'transfer', '${W(42)}', 'transfer:${W(42)}:out', ${at(D(3), 5)}, null, null, null);
      select public._post_stock_movement('${PROVO}', '${I.pButter}', 1, 'TRANSFER_IN', 1.50, 'transfer', '${W(42)}', 'transfer:${W(42)}:in', ${at(D(2), 4)}, null, null, null);
      select public._post_stock_movement('${LOC2}', '${I.lBeans}', -100, 'TRANSFER_OUT', 0.02, 'transfer', '${W(44)}', 'transfer:${W(44)}:out', now() - interval '3 days', null, null, null);
      -- sales: a week at both sites, as the v3 day totals hold them (net after refunds)
      insert into sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net, discount_spread, reward_spread, tax, loyalty_qty, staff_qty, comp_qty,
                                  loyalty_cost, staff_cost, comp_cost, theo_cost, clock_known, sale_net, sale_theo, refund_net, refund_tax, refund_gross, refund_qty, refund_cost)
        select l.loc, d::date, 'm-4b-' || l.n, 'dine-in', 10, 36, 30 + l.n, 0, 0, 6, 0, 0, 0, 0, 0, 0, 9, true, 30 + l.n, 9, 0, 0, 0, 0, 0
          from (values ('${PROVO}'::uuid, 1), ('${LOC2}'::uuid, 2)) l(loc, n)
         cross join generate_series('${D(7)}'::date, '${D(1)}'::date, interval '1 day') d
        on conflict do nothing;
      insert into wf_sales_forecast (location_id, org_id, forecast_date, amount)
        select '${PROVO}', '${ORG_T}', d::date, 100 from generate_series('${D(6)}'::date, '${D(1)}'::date, interval '1 day') d
        on conflict (location_id, forecast_date) do update set amount = 100;`);
    dsDrainAll();
  }

  // every changed report and every new one over the world's window, as JSON without the generated time
  function snapshotReports() {
    const out = {};
    for (const name of [...CHANGED, 'movement', 'cogs']) {
      const r = rep('ownerT', name, { ...WIN });
      out[name] = r.status === 0 ? strip(r.j) : `error ${outcome(r)}`;
    }
    for (const [name, opts] of [['value', { at_day: D(1), view: 'legal' }], ['purchases', { level: 'order' }], ['prices', { level: 'change' }]]) {
      const r = rep('ownerT', name, { ...WIN, opts });
      out[`${name}:${JSON.stringify(opts)}`] = r.status === 0 ? strip(r.j) : `error ${outcome(r)}`;
    }
    if (fnExists(`public.stock_report_month_end${SIG7}`)) {
      for (const n of D4B_REPORTS) {
        const r = rep('ownerT', n, { ...WIN });
        out[`new:${n}`] = r.status === 0 ? strip(r.j) : `error ${outcome(r)}`;
      }
    }
    return out;
  }
}
