// node --test: 20261019c (multi site stock Phase 1, v5.11.80) read as text, so CI checks the house
// rules on every PR. The behaviour is proved on a real Postgres by supabase/tests/stock_company/run.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../../../${p}`, import.meta.url), 'utf8');
const SQL = read('supabase/migrations/20261019c_OPS_stock_company.sql');
const RB = read('supabase/migrations/20261019c_OPS_stock_company_ROLLBACK.sql');
const top = (t) => t.replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/g, '');

test('ASCII only, bare statements, a guard first and a check row last', () => {
  const ascii = (t) => [...t].every((ch) => ch.charCodeAt(0) < 128);
  assert.ok(ascii(SQL) && ascii(RB));
  assert.doesNotMatch(top(SQL), /^\s*(begin|commit|rollback)\s*;/im);
  assert.doesNotMatch(top(RB), /^\s*(begin|commit|rollback)\s*;/im);
  assert.ok(SQL.indexOf('do $guard$') < SQL.indexOf('create table'));
  assert.match(SQL, /Run 20261019b_OPS_stock_phase0\.sql \(v5\.11\.79\) first/);
  assert.match(SQL.trim(), /as stock_sums;$/);
  assert.match(RB.trim(), /as venues_central;$/);
});

test('the menu machinery is untouched: no msm menu function replaced, no menu table altered', () => {
  const menu = new Set();
  for (const f of ['20261017_OPS_multi_site_menu.sql', '20261017c_OPS_multi_site_menu_groups.sql', '20261018_OPS_multi_site_menu_category_fields.sql']) {
    for (const m of read(`supabase/migrations/${f}`).matchAll(/create or replace function public\.([a-z0-9_]+)\(/g)) menu.add(m[1]);
  }
  const mine = [...SQL.matchAll(/create or replace (?:function|procedure) public\.([a-z0-9_]+)\(/g)].map((m) => m[1]);
  assert.ok(mine.length > 40);
  assert.deepEqual(mine.filter((n) => menu.has(n)), []);
  assert.doesNotMatch(SQL, /alter table public\.msm_(menus|products|product_sites|change_sets|changes|versions|version_sites|company|members)\b/);
  // and no Phase 0 or central stock function body is replaced either
  for (const f of ['_post_stock_movement', 'post_stock_movement', 'approve_stock_count', 'stock_record_waste', 'stock_central_switch', 'post_stock_transfer_leg']) {
    assert.doesNotMatch(SQL, new RegExp(`create or replace function public\\.${f}\\(`), f);
  }
});

test('the lock on company rows: WHEN on company columns only, never on hand or cost; delete and forge refused', () => {
  const upd = [...SQL.matchAll(/create trigger msm_stock_lock_upd before update on public\.(\w+) for each row\s+when \(([\s\S]*?)\)\s+execute function/g)];
  assert.equal(upd.length, 5);
  for (const [, tbl, when] of upd) {
    assert.doesNotMatch(when, /on_hand|current_cost|is_preferred|default_supplier_id|account_number|par_level/, tbl);
    assert.match(when, /old\.company_ref is not null or new\.company_ref is not null/, tbl);
  }
  assert.equal((SQL.match(/create trigger msm_stock_lock_del before delete/g) || []).length, 5);
  assert.equal((SQL.match(/create trigger msm_stock_lock_ins before insert/g) || []).length, 5);
  // the bypass is the owner role in this transaction, never a setting alone
  assert.match(SQL, /current_setting\('servos\.stock_publish', true\), ''\) = txid_current\(\)::text and current_user = 'postgres'/);
});

test('publish never writes a fact: no on hand, ledger, par, count, order or invoice write in the writer; cost only by the site\'s own rule', () => {
  const w = SQL.slice(SQL.indexOf('create or replace function public.msm_stock__sync_site'), SQL.indexOf('-- 11. HEALTH CHECK'));
  assert.doesNotMatch(w, /update inventory_items t\s+set[^;]*on_hand\s*=/);
  // current_cost: the ONE write is the site's own cost rule's answer (msm_stock__cost_plan, plan 4.5)
  const costWrites = [...w.matchAll(/update inventory_items t\s+set[^;]*current_cost\s*=[^;]*;/g)].map((m) => m[0]);
  assert.equal(costWrites.length, 1);
  assert.match(costWrites[0], /set current_cost = c\.cost\s+from _w_newcost c/);
  assert.match(SQL, /create or replace function public\.msm_stock__cost_plan\(p_loc uuid, p_rule text\)/);
  assert.match(SQL, /p_rule = 'price_list' or coalesce\(c\.prev, 0\) = 0/, 'deliveries sites: only an item with no cost or never received');
  assert.doesNotMatch(w, /insert into (stock_movements|par_levels|stock_counts|purchase_orders|supplier_invoices|waste_events)/);
  assert.match(w, /on_hand, current_cost\)\s+select[\s\S]*?w\.cid, 0, null/, 'a new item starts at 0 on hand and no cost');
  assert.match(w, /-- the busy table last/);
  assert.doesNotMatch(w, /\bdelete from\b/, 'publish never deletes at a site');
});

test('who may call: internals owner only, the runner never through the API, count approval behind the PIN', () => {
  assert.match(SQL, /revoke all on procedure public\.msm_stock_run_due\(integer\) from public, anon, authenticated, service_role/);
  assert.match(SQL, /revoke all on function public\.approve_stock_count\(uuid, text, text, jsonb, boolean\) from public, anon, authenticated;/);
  assert.match(SQL, /grant execute on function public\.approve_stock_count\(uuid, text, text, jsonb, boolean\) to service_role;/);
  assert.match(RB, /grant execute on function public\.approve_stock_count\(uuid, text, text, jsonb, boolean\) to authenticated, service_role;/);
  assert.match(SQL, /cron\.schedule\('msm-stock-run-due', '\* \* \* \* \*', 'call public\.msm_stock_run_due\(45\);'\)/);
  assert.match(SQL, /perform set_config\('lock_timeout', '2s', true\);/, 'publish gives way to sales within 2 s');
});

test('Peter 19 Oct: Shared stock on puts central stock on at every site, and at a site that joins later', () => {
  assert.match(SQL, /v_switched := public\.msm_stock__central_all\(p_org, 'shared stock on'\);/);
  assert.match(SQL, /create trigger locations_stock_company_join after insert or update of org_id on public\.locations/);
  assert.match(SQL, /Switch the Multi site menu on for this company first/);
  assert.match(RB, /Nothing here touches\s+--\s+stock_depletion_mode/);
});

test('every new table has row level security and the second step', () => {
  const tables = [...SQL.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 20);
  for (const t of tables) assert.ok(SQL.includes(`'${t}'`), `${t} is in the RLS list`);
  assert.match(SQL, /create policy second_step_fence on public\.%I as restrictive/);
  for (const t of tables) assert.match(RB, new RegExp(`drop table if exists public\\.${t} cascade;`), t);
});

test('round 1: no UPDATE or DELETE without a WHERE (Ops preloads safeupdate for the API login)', () => {
  const body = SQL.replace(/--[^\n]*/g, '');
  for (const st of body.split(';')) {
    const m = /(?:^|[\s(])(update\s+(?!of\b)[a-z_.]+\s+(?:[a-z]+\s+)?set\b|delete\s+from\b)/i.exec(st);
    if (!m) continue;
    const rest = st.slice(m.index);
    if (/do update set/i.test(rest) && !/^\s*update\s+[a-z_.]+\s+(?:[a-z]+\s+)?set/i.test(rest.trim())) continue;
    assert.match(rest, /\bwhere\b/i, rest.slice(0, 120));
  }
});

test('round 1: the base unit lock covers counts, pars, orders and own packs; a draft is capped; FK indexes for Undo', () => {
  assert.match(SQL, /create or replace function public\.msm_stock__site_item_in_use\(p_loc uuid, p_item uuid\)/);
  for (const t of ['stock_movements', 'stock_count_lines', 'par_levels', 'po_lines', 'stock_transfer_lines', 'item_packaging_formats']) {
    assert.ok(SQL.slice(SQL.indexOf('msm_stock__site_item_in_use(p_loc uuid'), SQL.indexOf('create or replace function public.msm_stock__unit_in_use')).includes(t), t);
  }
  assert.match(SQL, /if new\.base_unit is distinct from old\.base_unit and public\.msm_stock__unit_in_use\(old\.id, new\.base_unit\)/);
  assert.match(SQL, /if n > 40000 then/);
  for (const i of ['stock_movements_item_fk_idx', 'item_pack_fmt_parent_idx', 'recipe_lines_loc_unit_idx']) {
    assert.ok(SQL.includes(`'${i}'`), i);
    assert.match(RB, new RegExp(`drop index if exists public\\.${i};`), i);
  }
});
