// node --test: the Drop 3 multi site stock files (20261027a and its rollback) read as text, so CI checks the
// house rules on every PR. What they DO is proved on a real Postgres 17 shaped like Ops by
// supabase/tests/stock_native/run.mjs --drop3, sections 40 to 49 (Peter's files are never run against
// Supabase by Claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const path = (p) => new URL(`../../../${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const MIGS = 'supabase/migrations/';
const FILES = {
  d3: `${MIGS}20261027a_OPS_stock_native_3.sql`,
  d3Rb: `${MIGS}20261027a_OPS_stock_native_3_ROLLBACK.sql`,
};
const T = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, existsSync(path(f)) ? read(f) : '']));

// Comments out, then dollar quoted bodies out: what is left is what the SQL editor runs at the top level.
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const top = (t) => noComments(t).replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/gi, () => ' $$body$$ ');
const statements = (t) => top(t).split(';').map((s) => s.trim()).filter(Boolean);
const created = (t) => [...noComments(t).matchAll(/create\s+or\s+replace\s+(?:function|procedure)\s+public\.([a-z0-9_]+)\s*\(/gi)].map((m) => m[1].toLowerCase());
const tablesMade = (t) => [...noComments(t).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
// every function body of a file: [name, args text, body, head]
const bodies = (t) => [...noComments(t).matchAll(/create\s+or\s+replace\s+(?:function|procedure)\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(returns|language)([\s\S]*?)\bas\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\5\$/gi)]
  .map((m) => [m[1].toLowerCase(), m[2], m[6], m[4]]);
const argTypes = (args) => args.split(',').map((a) => a.trim()).filter(Boolean)
  .map((a) => a.replace(/\s+default\s+[\s\S]*$/i, '').split(/\s+/).slice(1).join(' ')).join(', ');
// the old card processor's name, spelt out letter by letter so this file never carries the word
const OLD_PROCESSOR = new RegExp(['s', 't', 'r', 'i', 'p', 'e'].join(''), 'i');

// contract 1.1: the 10 rebuilt bodies and the 23 checked ones (normalised md5)
const REPLACED = {
  stock_post_invoice: '13a87312ccaecb25f0e5184f070565ed', stock_receive: '25cf780578d16f9c42e2e4cb3509911e',
  stock_record_waste: '7adec1618754c96e9f3d9655fcf98070', stock_approve_count_pin: 'ffccd1e09fcfac62cff36e8d463f6519',
  post_stock_transfer_leg: 'd95f253953c5f22d537ee5e4b6925d49', stock_needs_attention: '3c37e882291e5ba76048fa31304046b7',
  stock_save_recipe: '8b625c94827917726945d7d4b1dffd8a', stock_co__recipe_on_at: '00d9e6a85b03889c53dd96d716b33a37',
  stock_recipe_detail: 'd7e0003ba1ae8dbc3b76e08ad13a8da2', stock_recipe_card: '275faa45aff17d97f12de8e7934252bf',
};
const CHECKED = ['bad3f938c1f00e7dd1c08ade70cc3b45', '3bb42e8fac4e6259f537bc6a6159177a', '03e4984a451353649de11b73acdd4e11', 'a7cb781c5c5931f347d05252a6327ff1',
  '8c9513db8ec56ddb68a1a3f247360742', 'ebf8561b02839372d44f0b42def127e2', 'ea27df98f795de86f094926b26478571', 'a519f9295ec00c61f08ac0bcadf62e9f',
  '12bc4e385fdb5562506977d1e05fce7e', 'dfb1ae8795f9105f1d9761d4846c6ded', '591676006ee56b85eb6b88149f48263b', 'f81f934a29ce14571f254df888bb9f90',
  '0c60388fa92f2b14ae4c16c4f1ecf357', 'e6c02dc96759f6d61511efdf36f8bc04', 'e0b54f5aaea4f330e2300248b721141d', 'd4a8cf7151e8558d5c16ac31dbd5a8ec',
  'eddb686e82a5314f6fe10de34cff92ab', '4287c82be293ef0b2724ee206d71eecc', '6805857cee1a521eebe68a9dc3d8fa3e', 'd5585672014220e100b95533e471dd89',
  '681741af80b7152ff692bf3689fd1cc3', '5027ed5a5c5ca0b6f03a1d414998dfeb', 'a5a6840362abc7d648281f0e47a89da5'];
// contract 1.6 and 1.8: the 66 public functions and their grants
const BOTH = ['stock_order_pad_context', 'stock_po_submit', 'stock_edit_standing_run', 'stock_budget_status', 'stock_save_forecast',
  'stock_fresh_closedown_list', 'stock_request_transfer', 'stock_fulfil_request', 'stock_dispute_transfer', 'stock_kitchen_orders_in',
  'stock_kitchen_plan', 'stock_kitchen_tick', 'stock_kitchen_untick', 'stock_kitchen_pick'];
const SERVICE = ['stock_inbox_receive', 'stock_recharge_record', 'po_cutoff_cron_ok', 'stock_notify_cron_ok', 'stock_notify_targets'];
const NONE = ['stock_po_cutoff_run', 'stock_notify_due'];
const ANON = ['stock_waste_reasons'];
const AUTH = ['stock_po_decide', 'stock_create_orders_many', 'stock_save_standing_order', 'stock_save_delivery_exception', 'stock_save_order_list',
  'stock_due_to_order', 'stock_orders_page', 'stock_deliveries_board', 'stock_invoices_page', 'stock_missing_invoices', 'stock_invoice_match',
  'stock_invoices_approve', 'stock_invoice_split', 'stock_invoice_inbox_page', 'stock_inbox_place', 'stock_inbox_ignore', 'stock_inbox_address',
  'stock_inbox_add', 'stock_save_credit_request', 'stock_credit_set_status', 'stock_save_credit_note', 'stock_credits_page', 'stock_price_changes_page',
  'stock_make_company_price', 'stock_budget_board', 'stock_save_budget', 'stock_sales_history', 'stock_forecast_week', 'stock_save_forecast_source',
  'stock_count_due', 'stock_save_count_plan', 'stock_save_count_template', 'stock_template_for_site', 'stock_save_shelf_order',
  'stock_second_approve_count', 'stock_lock_period', 'stock_unlock_period', 'stock_transfer_matches', 'stock_save_transfer_list', 'stock_set_site_kind',
  'stock_kitchen_ingredients', 'stock_set_recipe_restricted', 'stock_save_recipe_secret', 'stock_recharge_statement'];
const NEW_PUBLIC = [...BOTH, ...SERVICE, ...NONE, ...ANON, ...AUTH];
const PAGES = ['stock_due_to_order', 'stock_orders_page', 'stock_deliveries_board', 'stock_invoices_page', 'stock_missing_invoices',
  'stock_invoice_inbox_page', 'stock_credits_page', 'stock_price_changes_page'];
const NEW_TABLES = ['stock_po_approvals', 'stock_po_send_jobs', 'stock_standing_orders', 'stock_standing_order_lines', 'stock_standing_runs',
  'stock_delivery_exceptions', 'stock_order_lists', 'stock_budgets', 'stock_invoice_inbox', 'supplier_invoice_site_splits', 'stock_credit_requests',
  'stock_credit_request_lines', 'stock_credit_notes', 'stock_count_plans', 'stock_count_templates', 'stock_count_template_lines',
  'stock_count_template_sites', 'stock_template_shelf_order', 'stock_transfer_lists', 'stock_forecast_hours', 'stock_co_site_forecast_source',
  'stock_co_recipe_secrets', 'stock_kitchen_plan_ticks', 'stock_recharge_posts', 'stock_notify_sent'];
const READ_RULE = NEW_TABLES.filter((t) => !['stock_po_send_jobs', 'stock_notify_sent'].includes(t));
const CHECK_COLS = ['org_id', 'multi', 'replaced_functions', 'new_functions', 'new_tables', 'new_columns', 'transfer_status_check', 'approval_guard',
  'invoice_lock_guard', 'recipe_policies', 'cron_jobs', 'vault_keys', 'bucket', 'internals_open_to_api', 'anon_can_save', 'site_kinds',
  'internal_suppliers', 'approvals', 'notify_rows', 'send_jobs', 'site_rows_changed', 'orders_changed', 'menu_rows_changed', 'logins_changed'];
const NEW_COLUMNS = 41;

test('both Drop 3 files are in the repo', () => {
  for (const f of Object.values(FILES)) assert.ok(existsSync(path(f)), `${f} is missing`);
});

test('ASCII only, no em or en dash, no old card processor word, bare statements', () => {
  for (const [k, t] of Object.entries(T)) {
    assert.equal([...t].findIndex((ch) => ch.charCodeAt(0) > 127), -1, `${k}: a non ASCII character`);
    assert.ok(!/[\u2013\u2014]/.test(t), `${k}: an em or en dash`);
    assert.ok(!OLD_PROCESSOR.test(t), `${k}: the old card processor's name`);
    const s = statements(t).map((x) => x.toLowerCase());
    assert.ok(!s.some((x) => /^(begin|commit|rollback|start transaction)\b/.test(x)), `${k}: a transaction statement at the top level`);
  }
});

test('the guard is first, refuses without Drop 2 and on a second run, and never names a 20261026a object', () => {
  const first = statements(T.d3)[0];
  assert.match(first, /^do\s+\$\$body\$\$/i, 'the first statement is the guard block');
  const guard = /do \$guard\$([\s\S]*?)\$guard\$/.exec(T.d3)[1];
  assert.match(guard, /This file is for the Ops database only\. Nothing was changed\./);
  assert.match(guard, /menu_item_stock_facts[\s\S]*'d2:'\) <> 15[\s\S]*Run 20261025a_OPS_stock_native_2\.sql first\. Nothing was changed\./);
  assert.match(guard, /stock_po_approvals'\) is not null or to_regclass\('public\.stock_notify_sent'\) is not null[\s\S]*Drop 3 has run already\. Nothing was changed\./);
  assert.match(guard, /vault\.create_secret\(text,text,text,uuid\)[\s\S]*net\.http_post\(text,jsonb,jsonb,jsonb,integer\)[\s\S]*cron\.schedule\(text,text,text\)[\s\S]*cron\.unschedule\(bigint\)/);
  for (const [k, t] of Object.entries(T)) assert.ok(!/stock_targets|stock_report_|report_export|20261026a/.test(noComments(t)), `${k} names a Drop 4a object`);
  assert.match(T.d3, /set local lock_timeout = '3s';/);
  assert.ok(statements(T.d3)[1].startsWith("set local lock_timeout = '3s'"), 'the 3 s lock wait comes right after the guard');
  assert.match(statements(T.d3Rb)[0], /^do\s+\$\$body\$\$/i, 'the rollback starts with its guard');
  assert.match(T.d3Rb, /stock_po_approvals'\) is null[\s\S]*'d3:'\) <> 10/);
  assert.match(T.d3Rb, /Some transfers are REQUESTED or DISPUTED\. Cancel or resolve them first\. Nothing was changed\./);
});

test('the 33 bodies are checked by md5 and the 10 rebuilt ones backed up as d3: before the first replace', () => {
  const block = /do \$bodies\$([\s\S]*?)\$bodies\$/.exec(T.d3)[1];
  for (const m of [...Object.values(REPLACED), ...CHECKED]) assert.ok(block.includes(`'${m}'`), `md5 ${m} is checked`);
  assert.equal((block.match(/'[0-9a-f]{32}'/g) || []).length, 33);
  const backup = T.d3.indexOf("insert into public.stock_native_backup (name, body, md5, saved_at)\nselect 'd3:'");
  assert.ok(backup > 0, 'the d3: backup insert');
  const re = new RegExp(`create or replace function public\\.(${Object.keys(REPLACED).join('|')})\\(`, 'i');
  assert.ok(T.d3.search(re) > backup, 'the backup comes before the first rebuilt body');
});

test('only the 10 named bodies are rebuilt among the functions earlier files made, and their signatures stay', () => {
  const earlier = new Set(readdirSync(path(MIGS)).filter((f) => f.endsWith('.sql') && f < '20261027a' && !/ROLLBACK/i.test(f))
    .flatMap((f) => created(read(`${MIGS}${f}`))));
  const rebuilt = [...new Set(created(T.d3))].filter((n) => earlier.has(n)).sort();
  assert.deepEqual(rebuilt, Object.keys(REPLACED).sort());
  const sig = Object.fromEntries(bodies(T.d3).filter(([n]) => REPLACED[n]).map(([n, a]) => [n, argTypes(a)]));
  assert.equal(sig.stock_record_waste, 'uuid, jsonb, jsonb', 'no new argument on stock_record_waste (decision 1)');
  assert.equal(sig.post_stock_transfer_leg, 'uuid, text, text');
  assert.equal(sig.stock_approve_count_pin, 'uuid, text, text, text, jsonb, boolean');
});

test('no login row, no menu row, no ALTER of ops_alerts, no trigger on purchase_orders but the approval guard and the send rule', () => {
  for (const [k, t] of Object.entries(T)) {
    const s = noComments(t).toLowerCase();
    assert.ok(!/(insert\s+into|update|delete\s+from)\s+(public\.)?(user_profiles|user_locations)\b/.test(s), `${k}: writes a login row`);
    assert.ok(!/(insert\s+into|update|delete\s+from)\s+(public\.)?menu_items\b/.test(s), `${k}: writes a menu_items row`);
    assert.ok(!/alter\s+table\s+(if\s+exists\s+)?(public\.)?ops_alerts\b/.test(s), `${k}: alters ops_alerts`);
  }
  const trig = [...noComments(T.d3).matchAll(/create\s+trigger\s+(\S+)[\s\S]*?\bon\s+public\.(\S+)/gi)].filter((m) => m[2] === 'purchase_orders').map((m) => m[1]);
  assert.deepEqual(trig, ['purchase_orders_approval_guard', 'purchase_orders_send_rule']);
  // the count approval fence is the one trigger on stock_counts it adds, before insert or update
  const counts = [...noComments(T.d3).matchAll(/create\s+trigger\s+(\S+)\s+([^;]*?)\bon\s+public\.(\S+)/gi)].filter((m) => m[3] === 'stock_counts').map((m) => `${m[1]} ${m[2].trim()}`);
  assert.deepEqual(counts, ['stock_counts_approval_fence before insert or update']);
});

test('every new table has row level security, a revoke, the fence, its read rule and no write policy', () => {
  const t = noComments(T.d3);
  assert.deepEqual(tablesMade(T.d3).sort(), [...NEW_TABLES].sort());
  for (const tb of NEW_TABLES) {
    assert.match(t, new RegExp(`alter table public\\.${tb} enable row level security;`));
    assert.match(t, new RegExp(`revoke all on table public\\.${tb} from public, anon, authenticated, service_role;`));
    assert.ok(t.includes(`'${tb}'`) && /create policy second_step_fence on public\.%I as restrictive for all to authenticated/.test(t), `${tb}: the fence`);
  }
  for (const tb of READ_RULE) assert.match(t, new RegExp(`create policy ${tb}_read on public\\.${tb} as permissive for select to authenticated`));
  const policies = [...t.matchAll(/create policy (\S+) on public\.(\S+) as (\S+) for (\S+) to (\S+)/g)];
  for (const [, , tb, kind, cmd, to] of policies) {
    if (kind === 'permissive') assert.equal(cmd, 'select', `${tb}: a permissive policy that is not SELECT`);
    assert.notEqual(to, 'public', `${tb}: a policy to public`);
  }
  const writes = [...t.matchAll(/grant\s+([a-z, ]+)\s+on\s+table\s+public\.(\S+)\s+to\s+([a-z_, ]+);/g)].filter((m) => /insert|update|delete|all/.test(m[1]));
  for (const [, priv, tb, to] of writes) {
    assert.equal(to, 'service_role', `${tb}: ${priv} granted to ${to}`);
    assert.ok(['stock_po_send_jobs', 'stock_invoice_inbox', 'stock_recharge_posts', 'stock_notify_sent'].includes(tb), `${tb}: a write grant contract 1.2 does not list`);
  }
  assert.ok(!/grant[^;]*on table public\.(stock_notify_sent|stock_po_send_jobs)[^;]*authenticated/.test(t), 'the alert ledger or the send list readable by logins');
});

test('the 41 columns, each with a comment, and the transfer CHECK holds exactly the seven values', () => {
  const t = noComments(T.d3);
  assert.equal((t.match(/alter table public\.[a-z_]+ add column if not exists /g) || []).length, NEW_COLUMNS);
  assert.equal((T.d3.match(/^comment on column public\.[a-z_]+\.[a-z_]+ is '[^']*(?:''[^']*)*20261027a/gm) || []).length, NEW_COLUMNS);
  assert.match(t, /alter table public\.stock_transfers drop constraint stock_transfers_status_chk;\s+alter table public\.stock_transfers add constraint stock_transfers_status_chk\s+check \(status in \('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED', 'DONE', 'REQUESTED', 'DISPUTED'\)\);/);
  assert.match(noComments(T.d3Rb), /add constraint stock_transfers_status_chk\s+check \(status in \('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED', 'DONE'\)\);/);
});

test('every new function is revoked by name, then granted exactly as contract 1.8', () => {
  const t = noComments(T.d3);
  const fns = bodies(T.d3).filter(([n]) => !REPLACED[n]);
  const names = fns.map(([n]) => n);
  assert.deepEqual(names.filter((n) => !n.startsWith('stock_co__')).sort(), [...NEW_PUBLIC].sort());
  assert.equal(NEW_PUBLIC.length, 66);
  for (const [n, args] of fns) {
    const sig = `public.${n}(${argTypes(args)})`;
    assert.ok(t.includes(`revoke all on function ${sig} from public, anon, authenticated, service_role;`), `${sig} is not revoked by name`);
    const grants = [...t.matchAll(new RegExp(`grant execute on function ${sig.replace(/[()[\]]/g, '\\$&')} to ([a-z_, ]+);`, 'g'))].map((m) => m[1]);
    if (['stock_co__hidden_recipes', 'stock_co__secret_ok'].includes(n)) assert.deepEqual(grants, ['authenticated, service_role'], n);
    else if (n.startsWith('stock_co__')) assert.deepEqual(grants, [], `${n}: an internal helper is granted`);
    else if (ANON.includes(n)) assert.deepEqual(grants, ['anon, authenticated, service_role'], n);
    else if (BOTH.includes(n)) assert.deepEqual(grants, ['authenticated, service_role'], n);
    else if (SERVICE.includes(n)) assert.deepEqual(grants, ['service_role'], n);
    else if (NONE.includes(n)) assert.deepEqual(grants, [], n);
    else assert.deepEqual(grants, ['authenticated'], n);
  }
  assert.match(t, /left\(p\.proname, 9\) = 'stock_co_' and substr\(p\.proname, 10, 1\) = '_'[\s\S]*?execute format\('revoke all on function %s from public, anon, authenticated, service_role'/);
  for (const f of ['stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock']) {
    assert.match(t, new RegExp(`grant execute on function public\\.${f}\\(\\) to authenticated, service_role;`));
  }
  for (const [n, , , head] of fns) {
    if (['stock_co__po_approval_guard', 'stock_co__invoice_lock_guard', 'stock_co__count_approval_fence'].includes(n)) {
      assert.ok(!/security definer/i.test(head), `${n}: should be INVOKER`);
      continue;
    }
    assert.match(head, /security definer\s+set search_path = (public, pg_temp|'')/, `${n}: definer with the search path`);
  }
});

test('no OFFSET, every page capped at 100 and keyset, no UPDATE or DELETE without WHERE', () => {
  for (const [k, t] of Object.entries(T)) {
    assert.ok(!/\boffset\b/i.test(noComments(t)), `${k}: OFFSET`);
    for (const st of noComments(t).split(';')) {
      const s = st.replace(/\s+/g, ' ').trim().toLowerCase();
      if (/^(with [\s\S]*\) )?update /.test(s) || / update (public\.)?[a-z_]+ [a-z]+ set /.test(` ${s}`)) assert.ok(/\bwhere\b/.test(s), `${k}: an UPDATE without WHERE: ${s.slice(0, 120)}`);
      if (/\bdelete from\b/.test(s)) assert.ok(/\bwhere\b/.test(s), `${k}: a DELETE without WHERE: ${s.slice(0, 120)}`);
    }
  }
  for (const [n, , body] of bodies(T.d3).filter(([x]) => PAGES.includes(x))) {
    assert.match(body, /least\(greatest\(coalesce\(p_limit, 100\), 1\), 100\)/, `${n}: the page cap`);
    assert.match(body, /p_after/, `${n}: keyset on p_after`);
  }
});

test('the two cron jobs are scheduled and unscheduled by name, with their vault keys', () => {
  const t = noComments(T.d3);
  assert.match(t, /cron\.schedule\('stock-notify', '\* \* \* \* \*', 'select public\.stock_notify_due\(\);'\)/);
  assert.match(t, /cron\.schedule\('po-cutoff-run', '\* \* \* \* \*', 'select public\.stock_po_cutoff_run\(\);'\)/);
  assert.match(t, /c\.jobname in \('stock-notify', 'po-cutoff-run'\)/);
  assert.match(t, /vault\.create_secret\([^;]*'stock_notify_cron_key'/);
  assert.match(t, /vault\.create_secret\([^;]*'po_cutoff_cron_key'/);
  const rb = noComments(T.d3Rb);
  assert.match(rb, /c\.jobname in \('stock-notify', 'po-cutoff-run'\)[\s\S]*cron\.unschedule/);
  assert.match(rb, /delete from vault\.secrets s where s\.name in \('stock_notify_cron_key', 'po_cutoff_cron_key'\);/);
});

test('the money words are ASCII (the pound made with chr) and every new refusal word of contract 1.7 is there', () => {
  const t = T.d3;
  assert.match(t, /chr\(163\)/);
  for (const w of ['This order arrives as a transfer from the central kitchen. Receive it in Transfers.', 'This order is waiting for approval.',
    'You raised this order. Another manager approves it.', 'Send anyway is for head office, 30 minutes before the order by time.',
    '% does not deliver to % on %.', 'The order by time has passed. This standing order was sent.', 'Line %: that item is not at %.',
    'The splits add up to %, the invoice is %.', 'This invoice was sent to Xero and is locked.', 'Pick a reason for %.',
    ' needs a manager PIN.', '. Waiting for a second approval.', 'You gave the first approval. Someone else gives the second.',
    'That count is in a locked period (to %). Ask head office to unlock it.', 'Say why you are unlocking it.', 'Say what is wrong.',
    'This order was already picked.', 'This kitchen has open orders. Send or cancel them first.', 'A one site company has no central kitchen.',
    'Only the kitchen makes this recipe. Other sites buy it from the kitchen.', 'Only batch and prep recipes can be kitchen only.',
    'Set Kitchen only on the recipe page.', 'Tick today or yesterday only.', 'That tick is from an earlier day.', 'This month was already sent to Xero.',
    'Sign in to log waste.', 'Over the maximum %']) assert.ok(t.includes(w), w);
});

test('the check row is the last statement with every contract 1.9 column, after the schema reload', () => {
  const s = statements(T.d3);
  const last = s[s.length - 1];
  assert.match(last, /^select o\.org_id,/);
  const cols = [...last.matchAll(/\bas ([a-z_]+)\s*(?:,|\n\s*from)/g)].map((m) => m[1]);
  assert.deepEqual(['org_id', ...cols], CHECK_COLS);
  assert.match(s[s.length - 2], /^notify pgrst, 'reload schema'$/);
});

test('the rollback names all 10 bodies, every function by signature, the 25 tables and 41 columns, and never a LIKE drop', () => {
  const t = noComments(T.d3Rb);
  assert.match(t, /left\(b\.name, 3\) = 'd3:' order by b\.name loop\s+execute r\.body;/);
  for (const [n, m] of Object.entries(REPLACED)) assert.ok(t.includes(`'${m}'`) && t.includes(`public.${n}(`), `checks ${n} is back by md5`);
  assert.ok(!/like\s+'stock_co/i.test(t), 'a LIKE over stock_co');
  for (const [n, args] of bodies(T.d3).filter(([x]) => !REPLACED[x])) {
    assert.ok(t.includes(`drop function if exists public.${n}(${argTypes(args)});`), `drops ${n}`);
  }
  for (const tb of NEW_TABLES) assert.match(t, new RegExp(`drop table if exists public\\.${tb};`));
  assert.equal((t.match(/alter table public\.[a-z_]+ drop column if exists /g) || []).length, NEW_COLUMNS);
  assert.match(t, /alter policy stock_co_recipes_read on public\.stock_co_recipes using \(org_id::text in \(select public\.stock_reach_orgs\(\)\)\);/);
  assert.match(t, /alter policy stock_co_recipe_lines_read on public\.stock_co_recipe_lines using \(org_id::text in \(select public\.stock_reach_orgs\(\)\)\);/);
  assert.ok(!/delete from storage\.|drop[^;]*storage\.buckets/.test(t), 'the bucket and its files are kept');
  const s = statements(T.d3Rb);
  assert.match(s[s.length - 1], /as bodies_restored[\s\S]*as tables_dropped[\s\S]*as cron_jobs[\s\S]*as site_rows_changed[\s\S]*as orders_changed$/);
});

test('the recipe read rules hide kitchen only recipes through stock_co__hidden_recipes', () => {
  const t = noComments(T.d3);
  assert.match(t, /alter policy stock_co_recipes_read on public\.stock_co_recipes\s+using \(org_id::text in \(select public\.stock_reach_orgs\(\)\) and \(not restricted or id <> all \(\(select public\.stock_co__hidden_recipes\(\)\)::uuid\[\]\)\)\);/);
  assert.match(t, /alter policy stock_co_recipe_lines_read on public\.stock_co_recipe_lines\s+using \(org_id::text in \(select public\.stock_reach_orgs\(\)\) and recipe_id <> all \(\(select public\.stock_co__hidden_recipes\(\)\)::uuid\[\]\)\);/);
  assert.match(t, /create policy stock_co_recipe_secrets_read on public\.stock_co_recipe_secrets as permissive for select to authenticated\s+using \(public\.stock_co__secret_ok\(org_id, kitchen_location_id\)\);/);
});

test('the waste PIN and the phone branch: the PIN is never stored, p_actor only for the service role', () => {
  const waste = bodies(T.d3).find(([n]) => n === 'stock_record_waste')[2];
  assert.ok(!/p_event\s*->>?\s*'pin'[^;]*insert/i.test(waste) && !/insert into waste_events[^;]*p_event\b(?!\s*->)/i.test(waste), 'the event is never copied whole into a row');
  assert.match(waste, /stock_co__is_service\(\) and coalesce\(p_event ->> 'approved_by_staff_id', ''\)/);
  const who = bodies(T.d3).find(([n]) => n === 'stock_co__d3_who')[2];
  assert.match(who, /if public\.stock_co__is_service\(\) then[\s\S]*return public\.stock_co__guard\(p_org, p_section, p_need, p_sites\);/);
});

// The harness's JS model of the delivery rule (contract 2.3), which section 42 checks the SQL twin against.
test('the delivery rule model: cut off, no cut off, skipped days, moved days, nothing to order', async () => {
  const { modelNextDelivery: nd } = await import('../../../supabase/tests/stock_native/drop3.mjs');
  const wed = { delivery_dow: 3, order_by_dow: 2, order_by_time: '14:00' };
  const sat = { delivery_dow: 6, order_by_dow: null, order_by_time: null };
  // Tue 3 Nov 2026
  assert.equal(nd({ rules: [], nowVenue: { ymd: '2026-11-03', hm: '10:00' } }), null);
  const a = nd({ rules: [wed, sat], nowVenue: { ymd: '2026-11-03', hm: '13:59' } });
  assert.deepEqual([a.deliveryYmd, a.orderByYmd, a.orderByHm, a.minutesLeft], ['2026-11-04', '2026-11-03', '14:00', 1]);
  const b = nd({ rules: [wed, sat], nowVenue: { ymd: '2026-11-03', hm: '14:00' } });
  assert.deepEqual([b.deliveryYmd, b.orderByYmd, b.orderByHm], ['2026-11-07', '2026-11-07', '00:00'], 'at the cut off it asks for the next delivery; no cut off is midnight the day before');
  const c = nd({ rules: [wed], exceptions: [{ name: 'Bank holiday', from_day: '2026-11-04', to_day: '2026-11-04', kind: 'no_delivery' }], nowVenue: { ymd: '2026-11-03', hm: '09:00' } });
  assert.deepEqual([c.deliveryYmd, c.skipped], ['2026-11-11', [{ ymd: '2026-11-04', name: 'Bank holiday' }]]);
  const d = nd({ rules: [wed], exceptions: [{ name: 'Moved', from_day: '2026-11-04', to_day: '2026-11-04', kind: 'deliver_instead', deliver_on: '2026-11-05' }], nowVenue: { ymd: '2026-11-03', hm: '09:00' } });
  assert.deepEqual([d.deliveryYmd, d.orderByYmd, d.orderByHm], ['2026-11-05', '2026-11-04', '14:00'], 'the order by moves with the day');
  const e = nd({ rules: [wed], exceptions: [{ name: 'Closed', from_day: '2026-11-01', to_day: '2026-11-30', kind: 'no_delivery' }], nowVenue: { ymd: '2026-11-03', hm: '09:00' } });
  assert.equal(e, null, 'nothing inside 21 days');
});

// Integration (v5.11.96): the answer keys the Back Office screens read, and po-send's credit request stamp.
test('the screens get what they read: the budget board own row, the supplier item version, the credit request stamp', () => {
  const board = bodies(T.d3).find(([n]) => n === 'stock_budget_board')[2];
  assert.match(board, /'own', \(select jsonb_build_object\('id', b\.id, 'rule', b\.rule, 'pct', b\.pct, 'amount', b\.amount, 'row_version', b\.row_version\)\s+from stock_budgets b where b\.org_id = p_org and b\.location_id = u\.x\)/);
  const page = bodies(T.d3).find(([n]) => n === 'stock_price_changes_page')[2];
  assert.match(page, /'supplier_item_version', \(select c\.row_version from stock_co_supplier_items c where c\.id = n\.si\)/);
  assert.match(T.d3, /\ngrant update \(emailed_at, updated_at\) on table public\.stock_credit_requests to service_role;\n/);
  assert.doesNotMatch(T.d3, /grant (?:insert|delete|update)(?! \(emailed_at, updated_at\))[^;]*stock_credit_requests/i, 'no other write on credit requests');
});
