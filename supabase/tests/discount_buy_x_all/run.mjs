#!/usr/bin/env node
// run.mjs: proves 20261105b (Buy X, discount the lot on the server) on a local, throwaway
// PostgreSQL, before Peter runs it on the Ops database. It never connects to Supabase.
//
//   node supabase/tests/discount_buy_x_all/run.mjs
//
// It builds only what public._public_order_auto reads (locations, discount_rules and the _fence_
// helpers, taken word for word from 20260919a1), loads the live function (20261020a), then:
//   1. before 20261105b the server skips a buy_x_all rule (the gap this release closes);
//   2. 20261105b applies, its check row reads as documented, and a second run is fine;
//   3. for every basket below the server takes off exactly what lib/discountEngine.js takes off,
//      line by line (the parity the online, kiosk and QR orders need), Buy X get Y and bundles too;
//   4. the ROLLBACK puts the 20261020a function back word for word.
// Exit code 0 only when every check holds.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAutoDiscounts } from '../../../src/lib/discountEngine.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const mig = (f) => readFileSync(join(repo, 'supabase/migrations', f), 'utf8');
const MIGRATION = join(repo, 'supabase/migrations/20261105b_OPS_discount_buy_x_all.sql');
const ROLLBACK = join(repo, 'supabase/migrations/20261105b_OPS_discount_buy_x_all_ROLLBACK.sql');

const bin = (name) => (existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name);
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', PGOPTIONS: '-c client_min_messages=warning' };
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log(`  ok   ${msg}`); } else { failures++; console.log(`  FAIL ${msg}`); } };

const port = String(55700 + Math.floor(Math.random() * 80));
const dir = mkdtempSync(join(tmpdir(), 'pgd.'));
const data = join(dir, 'data');
{
  let r = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
  r = spawnSync(bin('pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-p ${port} -c listen_addresses='' -k ${dir} -c timezone=UTC`, 'start'], { env, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
}
function stop() { spawnSync(bin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env, encoding: 'utf8' }); rmSync(dir, { recursive: true, force: true }); }
function psql({ input, args = [], allowFail = false }) {
  const r = spawnSync(bin('psql'), ['-h', dir, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...args], { env, input, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) { console.error('psql failed:\n', (input || '').slice(0, 300), '\n', r.stderr || r.stdout); stop(); process.exit(2); }
  return r;
}
const sql = (q) => psql({ input: q }).stdout.trim();
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error(`missing ${a}`); return s.slice(i, s.indexOf(b, i) + b.length); };

try {
  // ── the shape public._public_order_auto reads ──
  const fence = mig('20260919a1_OPS_fence_identity_devices.sql');
  const helpers = ['_fence_num', '_fence_js_truthy', '_fence_hhmm', '_fence_cat_match', '_fence_rule_live']
    .map((n) => between(fence, `create or replace function public.${n}(`, '$fn$;')).join('\n\n');
  const live = between(mig('20261020a_OPS_channel_parity_2.sql'), 'CREATE OR REPLACE FUNCTION public._public_order_auto(', '$function$;');
  psql({ input: `
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.user_locations (user_id uuid, location_id uuid);
    create table public.locations (id uuid primary key, timezone text);
    create table public.discount_rules (id uuid primary key default gen_random_uuid(), location_id text, name text, active boolean default true,
      trigger_type text, trigger_category_ids text[], trigger_qty integer, reward_type text, reward_value numeric, reward_qty integer,
      reward_category_ids text[], channels jsonb, schedule jsonb, priority integer, sort_order integer, created_at timestamptz default now(),
      updated_at timestamptz default now(), trigger_groups jsonb);
    ${helpers}
    ${live}
    revoke all on function public._public_order_auto(text, text, jsonb) from public, anon, authenticated;
    grant execute on function public._public_order_auto(text, text, jsonb) to service_role;
  ` });
  const LOC = '0a000000-0000-4000-8000-000000000001';
  sql(`insert into public.locations values (${lit(LOC)}, 'Europe/London')`);

  // Rules, highest priority first (the engine is handed them in that order; the server orders by priority).
  const RULES = [
    { id: '00000000-0000-4000-8000-000000000001', name: '6 donuts 15% off', trigger_type: 'buy_x_all', trigger_category_ids: ['donuts'], trigger_qty: 6, reward_type: 'percent', reward_value: 15, reward_qty: 1, priority: 30 },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Muffins 3 for 50p off each', trigger_type: 'buy_x_all', trigger_category_ids: ['muffins', 'cakes'], trigger_qty: 3, reward_type: 'amount', reward_value: 0.5, reward_qty: 1, priority: 20 },
    { id: '00000000-0000-4000-8000-000000000003', name: 'Buy 2 donuts get 1 free', trigger_type: 'buy_x', trigger_category_ids: ['donuts'], trigger_qty: 2, reward_type: 'free', reward_value: 0, reward_qty: 1, priority: 10 },
    { id: '00000000-0000-4000-8000-000000000004', name: 'Coffee and cake 4.00', trigger_type: 'bundle', trigger_groups: [{ categoryIds: ['coffee'], qty: 1 }, { categoryIds: ['cakes'], qty: 1 }], reward_type: 'fixed_price', reward_value: 4, priority: 5 },
  ];
  for (const r of RULES) {
    sql(`insert into public.discount_rules (id, location_id, name, trigger_type, trigger_category_ids, trigger_qty, reward_type, reward_value, reward_qty, priority, trigger_groups)
         values (${lit(r.id)}, ${lit(LOC)}, ${lit(r.name)}, ${lit(r.trigger_type)}, ${r.trigger_category_ids ? `array[${r.trigger_category_ids.map(lit).join(',')}]` : 'null'},
                 ${r.trigger_qty ?? 'null'}, ${lit(r.reward_type)}, ${r.reward_value}, ${r.reward_qty ?? 'null'}, ${r.priority}, ${r.trigger_groups ? lit(JSON.stringify(r.trigger_groups)) : 'null'})`);
  }
  const engineRules = RULES.map((r) => ({ ...r, active: true }));

  const line = (n, cat, unit, qty, cats = null) => ({ n, cat, unit, qty, ...(cats ? { cats } : {}) });
  const BASKETS = {
    'six donuts': [line(1, 'donuts', 200, 6)],
    'seven donuts, mixed prices': [line(1, 'donuts', 300, 1), line(2, 'donuts', 200, 5), line(3, 'donuts', 150, 1)],
    'twelve donuts': [line(1, 'donuts', 200, 12)],
    'nine donuts (6 + one buy 2 get 1)': [line(1, 'donuts', 220, 9)],
    'five donuts (buy 2 get 1 only)': [line(1, 'donuts', 180, 5)],
    'muffins and cakes, coffee': [line(1, 'muffins', 275, 2), line(2, 'cakes', 320, 2), line(3, 'coffee', 300, 1)],
    'a cake counted through its cats': [line(1, 'gifts', 400, 1, ['gifts', 'cakes']), line(2, 'muffins', 250, 2), line(3, 'coffee', 280, 1)],
    'a muffin cheaper than 50p off': [line(1, 'muffins', 40, 3)],
    'nothing qualifies': [line(1, 'coffee', 300, 2)],
  };
  // Review fix (5.11.109): an exact half penny. The half price rule is its own, so only it runs here.
  const HALF = { id: '00000000-0000-4000-8000-000000000009', name: 'Half price donuts', trigger_type: 'buy_x_all', trigger_category_ids: ['halfdonut'],
    trigger_qty: 6, reward_type: 'percent', reward_value: 50, reward_qty: 1, priority: 40 };
  RULES.push(HALF);
  sql(`insert into public.discount_rules (id, location_id, name, trigger_type, trigger_category_ids, trigger_qty, reward_type, reward_value, reward_qty, priority)
       values (${lit(HALF.id)}, ${lit(LOC)}, ${lit(HALF.name)}, 'buy_x_all', array['halfdonut'], 6, 'percent', 50, 1, 40)`);
  engineRules.unshift({ ...HALF, active: true });
  BASKETS['six at 1.15, half price (an exact half penny each)'] = [line(1, 'halfdonut', 115, 6)];
  const server = (lines) => JSON.parse(sql(`select public._public_order_auto(${lit(LOC)}, 'online', ${lit(JSON.stringify(lines))})`));
  const app = (lines) => {
    const items = lines.map((l) => ({ uid: `u${l.n}`, name: l.cat, cat: l.cat, cats: l.cats || null, price: l.unit / 100, qty: l.qty }));
    const res = evaluateAutoDiscounts(items, engineRules, 'online');
    const byLine = {};
    for (const r of res) for (const a of r.appliedItems) byLine[a.uid] = Math.round(((byLine[a.uid] || 0) + (a.saving ?? 0)) * 100) / 100;
    return { total: Math.round(res.reduce((s, r) => s + r.totalSaving, 0) * 100), rules: res.map((r) => r.ruleId), byLine };
  };

  console.log('1. before 20261105b');
  const before = server(BASKETS['six donuts']);
  ok(!before.rules.some((r) => r.rule_id === RULES[0].id), 'the server skips Buy X, discount the lot (the gap)');
  ok(app(BASKETS['six donuts']).total === 180, 'while the apps take 1.80 off six donuts');

  console.log('2. the migration');
  const m = psql({ args: ['-1', '-f', MIGRATION] });
  ok(m.stdout.trim().split('\n').pop() === '1|1|f|f', `check row as documented (${m.stdout.trim().split('\n').pop()})`);
  ok(psql({ args: ['-1', '-f', MIGRATION] }).status === 0, 'a second run is fine');
  const raw = readFileSync(MIGRATION, 'utf8') + readFileSync(ROLLBACK, 'utf8');
  ok([...raw].every((c) => c.charCodeAt(0) < 128) && !raw.includes('!'), 'both files are ASCII and carry no exclamation mark');

  console.log('3. the server takes off what the apps take off');
  for (const [name, lines] of Object.entries(BASKETS)) {
    const s = server(lines), a = app(lines);
    const sLines = Object.fromEntries((s.line_minor || []).map((x) => [`u${x.n}`, x.saving_minor / 100]));
    const sameLines = JSON.stringify(Object.keys({ ...sLines, ...a.byLine }).sort().map((k) => [k, Math.round((sLines[k] || 0) * 100), Math.round((a.byLine[k] || 0) * 100)]).filter(([, x, y]) => x !== y)) === '[]';
    ok(s.total_minor === a.total && JSON.stringify(s.rules.map((r) => r.rule_id)) === JSON.stringify(a.rules) && sameLines,
      `${name}: server ${s.total_minor}p, apps ${a.total}p, rules ${a.rules.length}, line by line the same`);
  }
  ok(server(BASKETS['twelve donuts']).total_minor === 360, 'twelve donuts: 15% off all twelve (twice six), 3.60');
  ok(server(BASKETS['seven donuts, mixed prices']).total_minor === Math.round((200 * 5 + 150) * 0.15), 'seven donuts: the cheapest six');
  ok(server(BASKETS['six at 1.15, half price (an exact half penny each)']).total_minor === 348 && app(BASKETS['six at 1.15, half price (an exact half penny each)']).total === 348,
    'six at 1.15 half price: 3.48 on the server and in the apps (58p each)');

  console.log('4. the rollback');
  const rb = psql({ args: ['-1', '-f', ROLLBACK] });
  ok(rb.stdout.trim().split('\n').pop() === '0|1|3', `rollback check row, the three test rules still on (${rb.stdout.trim().split('\n').pop()})`);
  const after = sql(`select pg_get_functiondef('public._public_order_auto(text,text,jsonb)'::regprocedure)`);
  ok(!after.includes('buy_x_all') && after.includes('line_minor'), 'the 20261020a function is back');
  ok(sql(`select has_function_privilege('anon', 'public._public_order_auto(text,text,jsonb)'::regprocedure, 'execute')`) === 'f', 'and still only the service role runs it');
} finally {
  stop();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
