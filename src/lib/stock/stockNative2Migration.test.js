// node --test: the Drop 2 multi site stock files (20261025a and its rollback) read as text, so CI checks the
// house rules on every PR. What they DO is proved on a real Postgres 17 shaped like Ops by
// supabase/tests/stock_native/run.mjs --drop2, sections 30 to 38 (Peter's files are never run against
// Supabase by Claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const path = (p) => new URL(`../../../${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const MIGS = 'supabase/migrations/';
const FILES = {
  d2: `${MIGS}20261025a_OPS_stock_native_2.sql`,
  d2Rb: `${MIGS}20261025a_OPS_stock_native_2_ROLLBACK.sql`,
};
const T = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, existsSync(path(f)) ? read(f) : '']));

// Comments out, then dollar quoted bodies out: what is left is what the SQL editor runs at the top level.
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const top = (t) => noComments(t).replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/gi, () => ' $$body$$ ');
const statements = (t) => top(t).split(';').map((s) => s.trim()).filter(Boolean);
const created = (t) => [...noComments(t).matchAll(/create\s+or\s+replace\s+(?:function|procedure)\s+public\.([a-z0-9_]+)\s*\(/gi)].map((m) => m[1].toLowerCase());
const tablesMade = (t) => [...noComments(t).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
// every function body of a file: [name, args text, body]
const bodies = (t) => [...noComments(t).matchAll(/create\s+or\s+replace\s+(?:function|procedure)\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:returns|language)[\s\S]*?\bas\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\3\$/gi)]
  .map((m) => [m[1].toLowerCase(), m[2], m[4]]);
// argument types of a signature text, the way the grant block names them
const argTypes = (args) => args.split(',').map((a) => a.trim()).filter(Boolean)
  .map((a) => a.replace(/\s+default\s+[\s\S]*$/i, '').split(/\s+/).slice(1).join(' ')).join(', ');
// the old card processor's name, spelt out letter by letter so this file never carries the word
const OLD_PROCESSOR = new RegExp(['s', 't', 'r', 'i', 'p', 'e'].join(''), 'i');

// contract section 1.1: the 15 rebuilt bodies and the 25 checked ones (normalised md5; the contract said 41 in all, its table holds 40)
const REPLACED = {
  stock_co__allowed: '551ef9810f8f5d40112eb6995db3757d', stock_co__clean: '503a049bb411a9f8be3c8c057bb51a3b',
  stock_save_recipe: '6edac3d07dbef3bca9efbf9f9d1996bc', stock_archive_recipe: 'aaa6f1df489ec3ba9f89d3bf47f1d7b6',
  stock_link_menu_item: '82912cf90532d46b9c777f9ab0b9679f', stock_save_supplier_item: '4216382a95e15945cd00ea12548c0131',
  stock_save_item: '92f7cb59e261422d8540441b261f7756', stock_item_detail: '3c651bd7668b19e1f21fc2dcf343cbb8',
  stock_make_company_record: '54a721d04be5b45edb5de0194b3e16b0', stock_co__run_job: 'c05acf44319f338f23ac992700053383',
  stock_save_queue_run: '69963d8c329feb65136f4f010a1e09c8', stock_co__copy_site_step: 'e4fea542cb89a94868b5efc65843a917',
  stock_co__import_check_row: '5dafb0125a57e802aa3caf96a825784a', stock_co__import_apply: 'ef093dc6b21c7a1a9d8116638ca5804b',
  hubrise_menu_fingerprint: '8d6218c9a3bcd982d022857911325d08',
};
const CHECKED = ['03e4984a451353649de11b73acdd4e11', 'a7cb781c5c5931f347d05252a6327ff1', 'f199e0018f911cb3941139bf30959762', '77d43d74e1791813cffdf82254f650ad',
  '68980e8bc9d49446950d5389d924d6e8', 'c5d4dabdbc022eba3bc29f6fac2c3f35', '35a4eb7806b0214cedd4364822676f3c', 'fcc7d12e0c4e8fe1057e54417c619390',
  '4e2b32920c54bc904a87342413034afb', 'd162532c34b8b1c1d701c9dbef2f4af2', 'ceca5292974b81336d88ed5fa32efd6d', '7eeb435c8c677730049190e85456fd4a',
  '913a3c42943b8fcbfad1106003fcfa5f', '8c9513db8ec56ddb68a1a3f247360742', 'ebf8561b02839372d44f0b42def127e2', '000c0e067df8ab8197dee16872fa79b4',
  'f259202b0e85a4a1f13f210949ffbca3', 'a5a6840362abc7d648281f0e47a89da5', 'fa7a53906c9ad73500eb369d0edf601f', '0c60388fa92f2b14ae4c16c4f1ecf357',
  'a3f0d94ee7595d774e07d70c466ae242', 'dcd6342c924d7213b5e53ea84c1aa09f', '66d98dd337b94dd1d163e2ddcf61ebfc', '2d730b51be380bf6ed82a0d86a612643',
  '46b35552fbc89c416898279545bf4633'];
// contract section 1.6 (24 public functions; the contract's count of 23 left out the menu product picker)
const SERVICE = ['stock_facts_rebuild', 'stock_msm_recipe_scan', 'stock_msm_recipe_run', 'stock_nightly_recipes'];
const NEW_PUBLIC = ['stock_recipes_page', 'stock_recipe_detail', 'stock_recipe_cost', 'stock_plate_costs', 'stock_recipe_missing', 'stock_recipe_facts',
  'stock_recipe_card', 'stock_prep_list', 'stock_batch_how', 'stock_recipe_menu_products', 'stock_set_recipe_sites', 'stock_recipe_link_products',
  'stock_batch_set_how', 'stock_save_option_rule', 'stock_archive_option_rule', 'stock_swap_ingredient', 'stock_make_sizes', 'stock_prep_tick',
  'stock_prep_untick', 'stock_facts_signoff', ...SERVICE];
const PAGES = ['stock_recipes_page', 'stock_recipe_missing', 'stock_batch_how', 'stock_recipe_menu_products', 'stock_plate_costs'];
const NEW_TABLES = ['menu_item_stock_facts', 'stock_msm_recipe_jobs', 'stock_msm_recipe_cursor', 'recipe_cost_daily', 'stock_prep_ticks'];
const CHECK_COLS = ['org_id', 'multi', 'items_allergens_moved', 'supplier_items_with_allergens', 'items_keeping_own_allergens', 'rollup_unchanged', 'facts_rows',
  'facts_needs_check', 'facts_checked', 'recipe_cost_rows', 'msm_cursor_set', 'msm_jobs', 'replaced_functions', 'new_functions', 'new_tables', 'msm_index',
  'internals_open_to_api', 'anon_can_save', 'anon_reads_facts', 'anon_reads_cost', 'site_rows_changed', 'menu_rows_changed', 'logins_changed'];
const MSM_INDEX = "create index if not exists msm_version_sites_finished on public.msm_version_sites (finished_at) where status in ('done', 'nothing')";

test('both Drop 2 files are in the repo', () => {
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

test('the guard is first and refuses without Drop 1, without the drainer, and on a second run', () => {
  const first = statements(T.d2)[0];
  assert.match(first, /^do\s+\$\$body\$\$/i, 'the first statement is the guard block');
  const guard = /do \$guard\$([\s\S]*?)\$guard\$/.exec(T.d2)[1];
  assert.match(guard, /This is not the Ops database/);
  assert.match(guard, /Run 20261024a_OPS_stock_native_1\.sql first\. Nothing was changed\./);
  assert.match(guard, /stock_co_option_rules[\s\S]*Run 20261023a_OPS_stock_drainer_v2\.sql first\. Nothing was changed\./);
  assert.match(guard, /'drainer_v2:'\) <> 7/);
  assert.match(guard, /Drop 2 has run already\. Nothing was changed\./);
  assert.match(T.d2, /set local lock_timeout = '3s';/);
  const rbFirst = statements(T.d2Rb)[0];
  assert.match(rbFirst, /^do\s+\$\$body\$\$/i, 'the rollback starts with its guard');
  assert.match(T.d2Rb, /menu_item_stock_facts'\) is null[\s\S]*'d2:'\) <> 15/);
});

test('the 40 bodies are checked by md5 and the 15 rebuilt ones backed up as d2: before the first replace', () => {
  const block = /do \$bodies\$([\s\S]*?)\$bodies\$/.exec(T.d2)[1];
  for (const m of [...Object.values(REPLACED), ...CHECKED]) assert.ok(block.includes(`'${m}'`), `md5 ${m} is checked`);
  assert.equal((block.match(/'[0-9a-f]{32}'/g) || []).length, 40);
  const backup = T.d2.indexOf("insert into public.stock_native_backup (name, body, md5, saved_at)\nselect 'd2:'");
  assert.ok(backup > 0, 'the d2: backup insert');
  const firstReplace = T.d2.search(/create or replace function public\.(stock_co__allowed|stock_co__clean|stock_save_recipe|stock_archive_recipe|stock_link_menu_item|stock_save_supplier_item|stock_save_item|stock_item_detail|stock_make_company_record|stock_co__run_job|stock_co__copy_site_step|stock_co__import_check_row|stock_co__import_apply|hubrise_menu_fingerprint)\(|create or replace procedure public\.stock_save_queue_run\(/);
  assert.ok(firstReplace > backup, 'the backup comes before the first rebuilt body');
});

test('only the 15 named bodies are rebuilt among the functions earlier files made', () => {
  const earlier = new Set(readdirSync(path(MIGS)).filter((f) => f.endsWith('.sql') && f < '20261025a' && !/ROLLBACK/i.test(f))
    .flatMap((f) => created(read(`${MIGS}${f}`))));
  const rebuilt = [...new Set(created(T.d2))].filter((n) => earlier.has(n)).sort();
  assert.deepEqual(rebuilt, Object.keys(REPLACED).sort());
});

test('no msm function, no msm ALTER, no trigger on an msm table, and exactly the one msm index', () => {
  const t = noComments(T.d2).toLowerCase();
  assert.ok(!created(T.d2).some((n) => n.startsWith('msm')), 'an msm function is made or replaced');
  assert.ok(!/alter\s+table\s+(if\s+exists\s+)?public\.msm_/.test(t), 'an ALTER of an msm table');
  assert.ok(!/create\s+trigger[\s\S]{0,200}?\bon\s+public\.msm_/.test(t), 'a trigger on an msm table');
  const idx = t.match(/create\s+(unique\s+)?index[^;]*public\.msm_[^;]*;/g) || [];
  assert.equal(idx.length, 1);
  assert.equal(idx[0].replace(/\s+/g, ' ').replace(/;$/, ''), MSM_INDEX);
});

test('no login row and no menu row is written by either file', () => {
  for (const [k, t] of Object.entries(T)) {
    const s = noComments(t).toLowerCase();
    assert.ok(!/(insert\s+into|update|delete\s+from)\s+(public\.)?(user_profiles|user_locations)\b/.test(s), `${k}: writes a login row`);
    assert.ok(!/(insert\s+into|update|delete\s+from)\s+(public\.)?menu_items\b/.test(s), `${k}: writes a menu_items row`);
  }
});

test('every new table has row level security, a revoke, the fence and no write policy', () => {
  const t = noComments(T.d2);
  assert.deepEqual(tablesMade(T.d2).sort(), [...NEW_TABLES].sort());
  for (const tb of NEW_TABLES) {
    assert.match(t, new RegExp(`alter table public\\.${tb} enable row level security;`));
    assert.match(t, new RegExp(`revoke all on table public\\.${tb} from public, anon, authenticated, service_role;`));
    assert.match(t, new RegExp(`create policy second_step_fence on public\\.${tb} as restrictive for all to authenticated`));
  }
  const policies = [...t.matchAll(/create policy (\S+) on public\.(\S+) as (\S+) for (\S+) to (\S+)/g)];
  for (const [, , tb, kind, cmd, to] of policies) {
    if (kind === 'permissive') assert.equal(cmd, 'select', `${tb}: a permissive policy that is not SELECT`);
    if (to === 'public') assert.equal(tb, 'menu_item_stock_facts', `${tb}: a policy to public`);
  }
  assert.match(t, /create policy menu_item_stock_facts_anon_read on public\.menu_item_stock_facts as permissive for select to public\s+using \(true\);/);
  assert.match(t, /grant select on table public\.menu_item_stock_facts to anon, authenticated, service_role;/);
  assert.ok(!/grant[^;]*on table public\.recipe_cost_daily[^;]*anon/.test(t), 'recipe_cost_daily granted to anon');
  assert.ok(!/grant\s+(insert|update|delete|all)/i.test(t), 'a write grant on a table');
});

test('every new function is revoked by name, then granted exactly as contract 1.10', () => {
  const t = noComments(T.d2);
  const fns = bodies(T.d2).filter(([n]) => !Object.keys(REPLACED).includes(n));
  const names = fns.map(([n]) => n);
  assert.deepEqual(names.filter((n) => !n.startsWith('stock_co__')).sort(), [...NEW_PUBLIC].sort());
  for (const [n, args] of fns) {
    const sig = `public.${n}(${argTypes(args)})`;
    assert.ok(t.includes(`revoke all on function ${sig} from public, anon, authenticated, service_role;`), `${sig} is not revoked by name`);
    const grants = [...t.matchAll(new RegExp(`grant execute on function ${sig.replace(/[()[\]]/g, '\\$&')} to ([a-z_, ]+);`, 'g'))].map((m) => m[1]);
    if (n.startsWith('stock_co__')) assert.deepEqual(grants, [], `${n}: an internal helper is granted`);
    else if (n === 'stock_recipe_card') assert.deepEqual(grants, ['anon, authenticated, service_role']);
    else if (SERVICE.includes(n)) assert.deepEqual(grants, ['service_role'], n);
    else assert.deepEqual(grants, ['authenticated'], n);
  }
  assert.match(t, /left\(p\.proname, 9\) = 'stock_co_' and substr\(p\.proname, 10, 1\) = '_'[\s\S]*?execute format\('revoke all on function %s from public, anon, authenticated, service_role'/);
  for (const f of ['stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock']) {
    assert.match(t, new RegExp(`grant execute on function public\\.${f}\\(\\) to authenticated, service_role;`));
  }
  for (const [n, , body] of fns) assert.ok(!/\bsecurity\s+invoker\b/i.test(body), `${n}: invoker`);
  for (const m of t.matchAll(/create or replace function public\.([a-z0-9_]+)\([\s\S]*?\bas \$fn\$/g)) {
    if (Object.keys(REPLACED).includes(m[1])) continue;
    assert.match(m[0], /security definer\s+set search_path = public, pg_temp/, `${m[1]}: definer with the search path`);
  }
});

test('no OFFSET, every page capped at 100 (plate costs at 1,000), no UPDATE or DELETE without WHERE', () => {
  for (const [k, t] of Object.entries(T)) {
    assert.ok(!/\boffset\b/i.test(noComments(t)), `${k}: OFFSET`);
    for (const st of noComments(t).split(';')) {
      const s = st.replace(/\s+/g, ' ').trim().toLowerCase();
      if (/^(with [\s\S]*\) )?update /.test(s) || / update public\.[a-z_]+ [a-z]+ set /.test(` ${s}`)) assert.ok(/\bwhere\b/.test(s), `${k}: an UPDATE without WHERE: ${s.slice(0, 120)}`);
      if (/\bdelete from\b/.test(s)) assert.ok(/\bwhere\b/.test(s), `${k}: a DELETE without WHERE: ${s.slice(0, 120)}`);
    }
  }
  for (const [n, , body] of bodies(T.d2).filter(([x]) => PAGES.includes(x))) {
    const cap = n === 'stock_plate_costs' ? 1000 : 100;
    assert.match(body, new RegExp(`least\\(greatest\\(coalesce\\(p_limit, ${cap}\\), 1\\), ${cap}\\)`), `${n}: the page cap`);
  }
});

test('the data step only ever widens the supplier item allergens (a union), never a shorter array', () => {
  const step = /do \$d2_allergens\$([\s\S]*?)\$d2_allergens\$/.exec(T.d2)[1];
  const sets = [...step.matchAll(/set allergens = ([^;]*?) where/g)].map((m) => m[1].trim());
  assert.ok(sets.length > 0, 'the step writes allergens');
  for (const s of sets) assert.equal(s, 'v_new');
  assert.match(step, /v_new := public\.stock_co__allergen_ids\(array_cat\(coalesce\(s\.allergens, '\{\}'::text\[\]\), v_vals\)\);/);
  assert.ok(!/update public\.stock_co_items i set allergens/.test(step), 'the item allergens are rewritten');
});

test('the check row is the last statement with every contract 1.11 column', () => {
  const s = statements(T.d2);
  const last = s[s.length - 1];
  assert.match(last, /^select o\.org_id,/);
  for (const col of CHECK_COLS) assert.ok(new RegExp(`\\bas ${col}\\b|^select o\\.${col},`).test(last) || (col === 'org_id'), `column ${col}`);
  assert.match(s[s.length - 2], /^notify pgrst, 'reload schema'$/);
});

test('the rollback names all 15 bodies, every function by signature, and never a LIKE drop', () => {
  const t = noComments(T.d2Rb);
  for (const [n, m] of Object.entries(REPLACED)) {
    assert.ok(t.includes(`'d2:${n}'`), `replays d2:${n}`);
    assert.ok(t.includes(`'${m}'`), `checks ${n} is back by md5`);
  }
  assert.ok(!/like\s+'stock_co/i.test(t), 'a LIKE over stock_co');
  for (const [n, args] of bodies(T.d2).filter(([x]) => !Object.keys(REPLACED).includes(x))) {
    assert.ok(t.includes(`drop function if exists public.${n}(${argTypes(args)});`), `drops ${n}`);
  }
  for (const tb of NEW_TABLES) assert.match(t, new RegExp(`drop table if exists public\\.${tb};`));
  assert.match(t, /drop index if exists public\.msm_version_sites_finished;/);
  for (const c of ['stock_co_recipes drop column if exists updated_by', 'stock_co_recipe_sites drop column if exists why_on', 'stock_co_recipe_sites drop column if exists linked_at',
    'stock_co_supplier_items drop column if exists facts_checked_by_name', 'stock_co_items drop column if exists facts_source']) assert.ok(t.includes(c), c);
  assert.match(t, /'Drop 2 was rolled back\.'/);
  const s = statements(T.d2Rb);
  assert.match(s[s.length - 1], /as bodies_restored[\s\S]*as facts_rows_dropped[\s\S]*as msm_jobs_dropped[\s\S]*as queue_rows_failed[\s\S]*as site_rows_changed[\s\S]*as menu_rows_changed$/);
});

test('the save queue runner calls the msm scan and run each in its own block and never touches a menu table', () => {
  const runner = bodies(T.d2).find(([n]) => n === 'stock_save_queue_run')[2];
  assert.match(runner, /begin\s+perform public\.stock_msm_recipe_scan\(\);\s+exception when others then/);
  assert.match(runner, /begin\s+perform public\.stock_msm_recipe_run\(20\);\s+exception when others then/);
  for (const n of ['stock_msm_recipe_scan', 'stock_msm_recipe_run']) {
    const b = bodies(T.d2).find(([x]) => x === n)[2];
    assert.ok(!/(insert\s+into|update|delete\s+from)\s+(public\.)?(msm_[a-z_]+|menu_items)\b/i.test(b), `${n} writes a menu table`);
  }
});
