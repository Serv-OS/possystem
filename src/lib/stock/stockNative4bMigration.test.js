/**
 * stockNative4bMigration.test.js: the CI text test of Drop 4b (release 5.11.100):
 * supabase/migrations/20261030a_OPS_stock_native_4b.sql, its rollback and the storage fix mirror 20261029b.
 * Run: `npm test`, or `node --test src/lib/stock/stockNative4bMigration.test.js`.
 *
 * The local PostgreSQL proof is supabase/tests/stock_native/run.mjs --drop4b (drop4b.mjs, sections 60 to 68);
 * this file holds the text rules every Drop file keeps, so a careless edit fails in CI before anyone pastes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIG = (f) => path.join(here, '../../../supabase/migrations', f);
const FILES = {
  fwd: MIG('20261030a_OPS_stock_native_4b.sql'),
  rb: MIG('20261030a_OPS_stock_native_4b_ROLLBACK.sql'),
  fix: MIG('20261029b_OPS_storage_inbox_upload_ok.sql'),
  d3: MIG('20261027a_OPS_stock_native_3.sql'),
  d3rb: MIG('20261027a_OPS_stock_native_3_ROLLBACK.sql'),
};
const T = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '']));
const code = (s) => s.replace(/--[^\n]*/g, '');
const SIG7 = '(uuid, uuid[], date, date, jsonb, jsonb, integer)';

// what 4b makes (public functions by signature, as the rollback must drop them)
const NEW_FUNCS = [
  `stock_report_off_contract${SIG7}`, `stock_report_budget${SIG7}`, `stock_report_transfers${SIG7}`, `stock_report_count_compliance${SIG7}`,
  `stock_report_month_end${SIG7}`, 'stock_month_end_journal(uuid, date, date)', 'stock_month_end_journal_record(uuid, date, date, text, jsonb)',
  'stock_rp__legal_of(uuid)', 'stock_rp__in_transit(uuid[], date)', 'stock_rp__kitchen_margin(uuid[], date)', 'stock_rp__budget(uuid, date, date, boolean)',
  'stock_rp__grni(uuid[], date)', 'stock_rp__credits_out(uuid[], date)', 'stock_rp__recharges(uuid[], date, date)',
  'stock_rp__budget_merge(uuid, jsonb, jsonb, date, date)', 'stock_rp__count_merge(uuid, jsonb, date)', 'stock_rp__purchase_extra(uuid[], date, date, boolean)',
  'stock_rp__credit_figures(uuid[], date, date)', 'stock_rp__notes_4b(jsonb)', 'stock_rp__oc_lines(uuid[], date, date)', 'stock_rp__margin_same_legal(uuid, date)',
  'stock_co__weekly_stage()', 'stock_co__notify_email_ok(text)', 'stock_month_end_journal_claim(uuid, date, date, text, uuid, text)',
];
const RENAMES = [
  ['stock_report_league', 'stock_rp__league_4a'], ['stock_report_dashboard', 'stock_rp__dashboard_4a'], ['stock_report_attention', 'stock_rp__attention_4a'],
  ['stock_report_value', 'stock_rp__value_4a'], ['stock_report_purchases', 'stock_rp__purchases_4a'], ['stock_report_prices', 'stock_rp__prices_4a'],
  ['stock_notify_due', 'stock_co__notify_due_d3'], ['stock_notify_targets', 'stock_co__notify_targets_d3'],
];
const REPLACED = ['stock_rp__snapshot', 'stock_report_export_start', 'stock_lock_period'];

test('the 4b files and the storage fix mirror are in supabase/migrations', () => {
  for (const [k, f] of Object.entries(FILES)) assert.ok(fs.existsSync(f), `${k}: ${f}`);
});

test('ASCII only, never an em or en dash, never an exclamation mark (a zsh paste trap), never the old card processor\'s name', () => {
  for (const k of ['fwd', 'rb']) {
    assert.ok([...T[k]].every((ch) => ch.charCodeAt(0) < 128), `${k} is ASCII only`);
    assert.ok(!T[k].includes('!'), `${k} has no exclamation mark`);
    assert.ok(!/stripe/i.test(T[k]), `${k} never names the old processor`);
  }
});

test('bare statements: no begin, commit or rollback of their own (one paste is one transaction)', () => {
  for (const k of ['fwd', 'rb']) {
    const c = code(T[k]).replace(/\$fn\$[\s\S]*?\$fn\$/g, '').replace(/\$[a-z_0-9]*\$[\s\S]*?\$[a-z_0-9]*\$/g, '');
    assert.ok(!/^\s*(begin|commit|rollback)\s*;/im.test(c), `${k}: no transaction statements`);
  }
});

test('guard first: Ops only, Drop 3, 4a, Reports align and the storage fix in, never twice; lock wait 3 s; the check row last', () => {
  const g = T.fwd.indexOf('do $guard$');
  const firstStmt = code(T.fwd).search(/\S/);
  assert.ok(g > 0 && code(T.fwd).slice(firstStmt).startsWith('do $guard$'), 'the guard is the first statement');
  for (const w of ['This is not the Ops database', 'Run 20261027a_OPS_stock_native_3.sql first', 'Run 20261026a_OPS_stock_native_4a.sql first',
    'Run 20261029a_OPS_reports_align.sql first', 'Run 20261029b_OPS_storage_inbox_upload_ok.sql first', 'Drop 4b has run already']) {
    assert.ok(T.fwd.includes(w), `guard words: ${w}`);
  }
  assert.ok(/coalesce\(p\.qual, ''\) \|\| coalesce\(p\.with_check, ''\) ~ 'stock_level'/.test(T.fwd), 'the guard refuses while any storage rule calls stock_level');
  assert.ok(T.fwd.indexOf("set local lock_timeout = '3s';") > g && T.fwd.indexOf("set local statement_timeout = '300s';") > g, 'lock wait 3 s, 300 s limit');
  const last = code(T.fwd).trim().split(/;\s*$/m).filter((s) => s.trim()).pop();
  assert.ok(/^\s*select o\.org_id/m.test(last) && /site_rows_changed/.test(last) && /logins_changed/.test(last), 'the check row is the last statement');
});

test('every body it renames or replaces is checked by md5 before anything changes, and saved as 4b: for the rollback', () => {
  const bodies = T.fwd.indexOf('do $bodies$');
  const firstChange = T.fwd.indexOf('alter function public.');
  assert.ok(bodies > 0 && bodies < firstChange, 'the md5 check comes before the first change');
  for (const [from] of RENAMES) assert.ok(new RegExp(`'public\\.${from}\\([^']*\\)', '[0-9a-f]{32}'`).test(T.fwd), `md5 pinned: ${from}`);
  for (const n of REPLACED) assert.ok(new RegExp(`'public\\.${n}\\([^']*\\)', '[0-9a-f]{32}'`).test(T.fwd), `md5 pinned: ${n}`);
  assert.ok(/insert into public\.stock_native_backup \(name, body, md5\)\nselect '4b:' \|\| p\.proname, pg_get_functiondef\(p\.oid\)/.test(T.fwd), 'the bodies are saved as 4b:<name>');
  assert.ok(T.fwd.includes("'4b:check:stock_notify_sent_kind_check'"), 'the alert kind CHECK is saved');
  for (const [from, to] of RENAMES) assert.ok(T.fwd.includes(`rename to ${to};`) && T.fwd.includes(`function public.${from}(`), `renamed: ${from} to ${to}`);
});

test('every function made or renamed is revoked from public, anon, authenticated and service_role by exact signature, then granted exactly', () => {
  for (const sig of NEW_FUNCS) {
    assert.ok(T.fwd.includes(`revoke all on function public.${sig} from public, anon, authenticated, service_role;`), `revoked: ${sig}`);
  }
  for (const [, to] of RENAMES) assert.ok(new RegExp(`revoke all on function public\\.${to}\\([^)]*\\) from public, anon, authenticated, service_role;`).test(T.fwd), `revoked: ${to}`);
  const grants = [...T.fwd.matchAll(/grant execute on function public\.([a-z_0-9]+)\([^)]*\) to ([a-z_, ]+);/g)].map((m) => [m[1], m[2]]);
  const by = Object.fromEntries(grants.map(([n, r]) => [n, r]));
  for (const n of ['stock_report_off_contract', 'stock_report_budget', 'stock_report_transfers', 'stock_report_count_compliance', 'stock_report_month_end',
    'stock_report_attention', 'stock_report_value', 'stock_report_purchases', 'stock_report_prices', 'stock_report_export_start', 'stock_lock_period']) {
    assert.equal(by[n], 'authenticated', `${n}: signed in logins only`);
  }
  assert.equal(by.stock_report_league, 'authenticated, service_role');
  assert.equal(by.stock_report_dashboard, 'authenticated, service_role');
  assert.equal(by.stock_month_end_journal, 'authenticated, service_role');
  assert.equal(by.stock_month_end_journal_record, 'service_role');
  assert.equal(by.stock_month_end_journal_claim, 'service_role');
  assert.equal(by.stock_notify_targets, 'service_role');
  for (const n of grants.map(([x]) => x)) assert.ok(!/^stock_rp__|^stock_co__/.test(n), `no internal is granted: ${n}`);
  assert.ok(!/grant execute on function public\.[a-z_0-9]+\([^)]*\) to [a-z_, ]*anon/.test(T.fwd), 'nothing to anon');
});

test('every new function is SECURITY DEFINER with search_path public, pg_temp', () => {
  const heads = [...T.fwd.matchAll(/create or replace function public\.([a-z_0-9]+)\(([\s\S]*?)\$fn\$/g)];
  assert.ok(heads.length >= 30, `${heads.length} functions`);
  for (const h of heads) {
    assert.ok(/security definer/.test(h[2]) && /set search_path = public, pg_temp/.test(h[2]), `${h[1]} is definer with the search path`);
  }
});

test('every new report: the 4a signature, the report guard, the range check, at most 1,000 rows, keyset never OFFSET', () => {
  for (const n of ['off_contract', 'budget', 'transfers', 'count_compliance', 'month_end']) {
    const m = new RegExp(`create or replace function public\\.stock_report_${n}\\(p_org uuid, p_sites uuid\\[\\], p_from date, p_to date, p_opts jsonb default null,\\s*p_after jsonb default null, p_limit integer default 1000\\)[\\s\\S]*?\\n\\$fn\\$;`).exec(T.fwd);
    assert.ok(m, `stock_report_${n} has the one signature`);
    const b = m[0];
    assert.ok(b.includes('public.stock_report_guard(p_org, p_sites)'), `${n}: the report guard`);
    assert.ok(b.includes('public.stock_rp__range_ok(p_from, p_to)'), `${n}: the range check`);
    assert.ok(!/\boffset\b/i.test(b.replace(/limit 1 offset/g, '')), `${n}: never OFFSET`);
    assert.ok(/limit 1000|v_limit/.test(b), `${n}: capped`);
  }
});

test('the Reports align rules: sales from the day totals (net after refunds), waste and transfers from the ledger, demo history left out', () => {
  const budget = /function public\.stock_report_budget[\s\S]*?\n\$fn\$;/.exec(T.fwd)[0];
  assert.ok(budget.includes("public.stock_rp__site_figures(v_g, v_win)") && budget.includes("(f ->> 'sales_net')"), 'budget sales are the site figures\' net (the same as every Stock and GP report)');
  assert.ok(budget.includes('sum(d.net)') && budget.includes('sales_day_sums'), 'the weekly sales read sales_day_sums.net');
  const tr = /function public\.stock_report_transfers[\s\S]*?\n\$fn\$;/.exec(T.fwd)[0];
  assert.ok(tr.includes("(f ->> 'transfers_out')") && tr.includes("(f ->> 'transfers_in')"), 'transfers in and out are the ledger\'s (Stock movement\'s)');
  const me = /function public\.stock_report_month_end[\s\S]*?\n\$fn\$;/.exec(T.fwd)[0];
  assert.ok(me.includes("(s.f ->> 'waste_value')") && me.includes("(s.f ->> 'closing_value')"), 'month end waste and closing are the site figures\' (the ledger)');
  for (const m of T.fwd.matchAll(/from stock_day_sums [a-z]+ where[^;]*?(?=\)|;)/g)) assert.ok(/demo = false|not [a-z]+\.demo/.test(m[0]), `demo left out: ${m[0].slice(0, 80)}`);
});

test('the closing stock journal: a DRAFT from the edge function, never posted here; head office only; never twice', () => {
  assert.ok(T.fwd.includes("raise exception 'Only head office sends the closing stock journal.'"), 'head office only');
  assert.ok(T.fwd.includes("raise exception 'This month was already sent to Xero.' using errcode = '55000'"), 'never twice');
  assert.ok(/'Reconnect Xero to allow stock journals\.'/.test(T.fwd) && /accounting\.manualjournals/.test(T.fwd), 'the reconnect state, from the granted scopes');
  assert.ok(!/net\.http_post\([^)]*xero/i.test(T.fwd), 'the database never calls Xero');
});

test('the weekly email: the kind is added, the staging never raises, the Drop 3 sender does the rest', () => {
  assert.ok(/check \(kind in \([^)]*'delivery_overdue', 'weekly'\)\)/.test(T.fwd), 'the CHECK gains weekly');
  const st = /function public\.stock_co__weekly_stage\(\)[\s\S]*?\n\$fn\$;/.exec(T.fwd)[0];
  assert.ok(/exception when others then\s+raise warning/.test(st), 'a problem is a warning, never an error');
  assert.ok(st.includes("interval '1 day'") && st.includes('on conflict do nothing'), 'within a day of the deadline, never twice');
  const due = /create or replace function public\.stock_notify_due\(\)[\s\S]*?\n\$fn\$;/.exec(T.fwd)[0];
  assert.ok(due.includes('public.stock_co__weekly_stage()') && due.includes('return public.stock_co__notify_due_d3();'), 'the Drop 3 body still sends');
});

test('no UPDATE or DELETE without WHERE, in either file', () => {
  for (const k of ['fwd', 'rb']) {
    for (const m of code(T[k]).matchAll(/\b(update|delete from)\s+[a-z_.]+[^;]*;/gi)) {
      if (/^update\s+(set|of)\b/i.test(m[0]) || /do update set/i.test(m[0])) continue;
      assert.ok(/\bwhere\b/i.test(m[0]) || /on conflict/i.test(m[0]), `${k}: ${m[0].slice(0, 90)}`);
    }
  }
});

test('the rollback names everything 4b made by exact signature, never LIKE, puts every renamed body back and checks it by md5', () => {
  for (const sig of NEW_FUNCS) assert.ok(T.rb.includes(`drop function public.${sig};`), `dropped: ${sig}`);
  for (const [from, to] of RENAMES) assert.ok(T.rb.includes(`rename to ${from};`) && T.rb.includes(`function public.${to}(`), `named back: ${to} to ${from}`);
  for (const n of REPLACED) assert.ok(T.rb.includes(`'4b:${n}'`), `replayed: ${n}`);
  assert.ok(T.rb.includes('drop table public.stock_month_end_journals;'), 'the table');
  assert.ok(!/\blike\s+'/i.test(code(T.rb).replace(/not like '%weekly%'/g, '')), 'no LIKE');
  assert.ok(T.rb.includes("A stock function did not come back as it was"), 'every body checked by md5 after');
  assert.ok(!/stock_invoice_inbox_files_add|stock_level\(auth/.test(code(T.rb)), 'the rollback never touches the storage rule');
});

test('the storage lesson: no storage rule anywhere calls stock_level; the Drop 3 file makes the safe rule and its rollback drops the check after the rule', () => {
  for (const f of fs.readdirSync(MIG('')).filter((x) => x.endsWith('.sql'))) {
    const t = code(fs.readFileSync(MIG(f), 'utf8'));
    for (const m of t.matchAll(/create policy [a-z_0-9]+ on storage\.objects[\s\S]*?;/g)) {
      assert.ok(!/stock_level\(/.test(m[0]), `${f}: a storage rule calls stock_level: ${m[0].slice(0, 120)}`);
    }
  }
  assert.ok(/create policy stock_invoice_inbox_files_add on storage\.objects as permissive for insert to authenticated\s+with check \(bucket_id = 'stock-invoice-inbox' and public\.stock_invoice_inbox_upload_ok\(name\)\);/.test(T.d3), 'Drop 3 makes the safe rule');
  assert.ok(T.d3.indexOf('create or replace function public.stock_invoice_inbox_upload_ok') < T.d3.indexOf('create policy stock_invoice_inbox_files_add'), 'the check before the rule');
  assert.ok(T.d3.includes('grant execute on function public.stock_invoice_inbox_upload_ok(text) to authenticated;'), 'signed in logins may run the check');
  const dp = T.d3rb.indexOf('drop policy if exists stock_invoice_inbox_files_add on storage.objects;');
  const df = T.d3rb.indexOf('drop function if exists public.stock_invoice_inbox_upload_ok(text);');
  assert.ok(dp > 0 && df > dp, 'the Drop 3 rollback drops the rule first, then the check');
  assert.ok(/o = v_org::text/.test(T.fwd) && /o = v_org::text/.test(T.d3), '4b and Drop 3 compare the org as text (stock_reach_orgs answers text)');
});

test('the storage fix mirror is the 23 Oct live paste byte for byte below its header', () => {
  const body = T.fix.split('\n').slice(T.fix.split('\n').findIndex((l) => l.startsWith('-- 1_fix_invoice_inbox_upload_policy.sql'))).join('\n');
  assert.ok(body.startsWith('-- 1_fix_invoice_inbox_upload_policy.sql'), 'the live file starts where the header ends');
  assert.ok(body.includes("create policy stock_invoice_inbox_files_add on storage.objects\n  for insert to authenticated\n  with check (bucket_id = 'stock-invoice-inbox' and public.stock_invoice_inbox_upload_ok(name));"), 'the rule as run');
  assert.ok(T.fix.includes('KNOWN SLIP'), 'the header names the text = uuid slip 4b corrects');
});
