// node --test: the Drop 4a multi site stock files (20261026a and its rollback: the head office reports)
// read as text, so CI checks the house rules on every PR. What they DO is proved on a real Postgres 17
// shaped like Ops by supabase/tests/stock_native/run.mjs --drop4a, sections 30 to 37 (Peter's files are
// never run against Supabase by Claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { TARGET_DEFAULTS } from './targetRules.js';

const path = (p) => new URL(`../../../${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const MIGS = 'supabase/migrations/';
const FILES = {
  d4: `${MIGS}20261026a_OPS_stock_native_4a.sql`,
  d4Rb: `${MIGS}20261026a_OPS_stock_native_4a_ROLLBACK.sql`,
};
const missing = Object.values(FILES).filter((f) => !existsSync(path(f)));
const T = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, existsSync(path(f)) ? read(f) : '']));

// Comments out, then dollar quoted bodies out: what is left is what the SQL editor runs at the top level.
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const top = (t) => noComments(t).replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/gi, () => ' $$body$$ ');
const statements = (t) => top(t).split(';').map((s) => s.trim()).filter(Boolean);
// every function a file makes: { name, args, types, ret, opts, body }
const fns = (t) => [...noComments(t).matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\bas\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\4\$/gi)]
  .map((m) => ({ name: m[1].toLowerCase(), args: m[2], types: argTypes(m[2]), head: m[3], body: m[5] }));
// the argument types of a parameter list, in order ('p_x uuid[] default null' -> 'uuid[]')
function argTypes(list) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((a) => a.trim().replace(/\s+default\s+[\s\S]*$/i, '').split(/\s+/).slice(1).join(' ').toLowerCase()).filter(Boolean);
}
const sig = (f) => `${f.name}(${f.types.join(', ')})`;
// the old card processor's name, spelt out letter by letter so this file never carries the word
const OLD_PROCESSOR = new RegExp(['s', 't', 'r', 'i', 'p', 'e'].join(''), 'i');

// contract 1.1: the nine bodies 4a reads and only checks (normalised md5 after the drainer release)
const CHECKED = {
  'public.stock_level(uuid,uuid)': '4287c82be293ef0b2724ee206d71eecc',
  'public.stock_reach_locations()': '6805857cee1a521eebe68a9dc3d8fa3e',
  'public.stock_co__venue_day(uuid,timestamptz)': '8c9513db8ec56ddb68a1a3f247360742',
  'public.stock_co__clock_of(uuid)': '605fce03d4e44064df5cf3b03ecd0350',
  'public.stock_co__day_start_at(date,time,text)': '2cb462264587615075225d05a84cd051',
  'public._stock_day_sums_apply()': 'ccf9db2e33be2e998bcc540186cca0f9',
  'public.stock_day_sums_rebuild(uuid,date,date)': '7f8ccfae7dbe7826623e60dab4f84bcb',
  'public.sales_day_sums_rebuild(uuid,date,date)': '007c100176c9438b35c6531916555a79',
  'public.stock_site_scope(uuid)': 'e0b54f5aaea4f330e2300248b721141d',
};
// contract 1.6: the sixteen reports; 1.5 and 1.8: the other public functions and exactly who may run them
const REPORTS = ['dashboard', 'league', 'attention', 'value', 'movement', 'gap', 'cogs', 'product_gp', 'waste', 'purchases', 'prices',
  'days_on_hand', 'par', 'key_ratios', 'setup_health', 'batches'];
const GRANTS = {
  ...Object.fromEntries(REPORTS.map((n) => [`stock_report_${n}`, n === 'dashboard' || n === 'league' ? ['authenticated', 'service_role'] : ['authenticated']])),
  stock_save_targets: ['authenticated'], stock_save_key_ratios: ['authenticated'], stock_report_export_start: ['authenticated'], stock_report_export_cancel: ['authenticated'],
  report_export_cron_ok: ['service_role'], report_export_claim: ['service_role'], report_export_page: ['service_role'], report_export_finish: ['service_role'],
  report_export_reach_ok: ['service_role'], report_export_run_due: [], stock_report_guard: [],
};
const NEW_TABLES = ['stock_targets', 'stock_key_ratios', 'report_export_jobs'];
const NEW_INDEXES = ['stock_targets_one', 'stock_key_ratios_org', 'report_export_jobs_open', 'report_export_jobs_user', 'stock_day_sums_rp', 'sales_day_sums_rp', 'stock_day_sums_demo', 'closed_checks_demo_rp'];
const CHECK_ROW = ['org_id', 'multi', 'new_tables', 'new_functions', 'internals_open_to_api', 'anon_can_read_reports', 'bucket_ok', 'policy_ok', 'cron_job', 'vault_key',
  'backfill_days_queued', 'backfill_minutes', 'dashboard_ms', 'league_rows', 'demo_left_out', 'site_rows_changed', 'logins_changed'];
const RB_ROW = ['functions_left', 'tables_left', 'bucket_left', 'cron_left', 'jobs_failed', 'backfill_rows_dropped'];
// contract 1.11: the words the web detects, exactly
const WORDS = [
  'Sign in to Back Office to see stock reports.', 'Not allowed: this login does not reach %.', 'Not allowed: % is in another company.', 'Pick 1 to 50 sites.',
  'Pick a start and end day, start first, up to 400 days.', 'By area is today only.', 'Stock outs cover up to 93 days.', 'Green must be the better side of amber.',
  'This screen is out of date. Reload it, then save again.', 'That is 20 key items. Archive one first.', 'An export is already running. Wait for it to finish.',
  'That is 20 exports today. Try again tomorrow.', 'That report cannot be exported.', 'This login no longer reaches ', 'Stopped after 5 tries.',
  'Purchases at delivery value until the purchasing update', 'Choose your key items in Targets', 'Plate cost not known before ',
];

test('both Drop 4a files are in supabase/migrations', () => {
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

test('ASCII only, never an em or en dash, never the old card processor\'s name, no msm_ object touched', () => {
  for (const [k, t] of Object.entries(T)) {
    const bad = [...t].findIndex((ch) => ch.charCodeAt(0) > 127);
    assert.equal(bad, -1, `${FILES[k]}: a non ASCII character at ${bad}: ${JSON.stringify(t.slice(Math.max(0, bad - 30), bad + 10))}`);
    assert.doesNotMatch(t, /[\u2013\u2014]/, FILES[k]);
    assert.doesNotMatch(t, OLD_PROCESSOR, `${FILES[k]} names the old card processor`);
    assert.doesNotMatch(noComments(t), /\bmsm_/i, `${FILES[k]} touches a Multi site menu object`);
  }
});

test('nothing of Drop 2 or Drop 3 is needed or named', () => {
  for (const [k, t] of Object.entries(T)) {
    assert.doesNotMatch(t, /recipe_cost_daily|menu_item_stock_facts/, `${FILES[k]} names a Drop 2 table`);
  }
});

test('bare statements: no begin, commit or rollback of their own (one paste is one transaction)', () => {
  for (const [k, t] of Object.entries(T)) {
    for (const s of statements(t)) assert.doesNotMatch(s, /^(begin|commit|rollback|start\s+transaction)\b/i, `${FILES[k]}: ${s.slice(0, 60)}`);
  }
});

test('guard first (Ops only, Drop 1 and the drainer in, not run twice), a 3 s lock wait and 300 s limit, the check row last', () => {
  for (const [k, t] of Object.entries(T)) {
    const st = statements(t);
    assert.match(st[0] || '', /^do\s+\$\$body\$\$$/i, `${FILES[k]}: the first statement is the guard DO block (${(st[0] || '').slice(0, 60)})`);
    const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$/i.exec(noComments(t))?.[1] || '';
    assert.ok(/raise\s+exception/i.test(guard) && /billing_state/.test(guard) && /user_locations/.test(guard), `${FILES[k]}: the guard raises in plain words, Ops only`);
    assert.match(top(t), /set\s+local\s+lock_timeout\s*=\s*'3s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'300s'/i, `${FILES[k]}: 3 s lock wait, 300 s limit`);
    assert.match(st[st.length - 1] || '', /^(with\b[\s\S]*\bselect\b|select\b)/i, `${FILES[k]}: the last statement is the visible check row`);
  }
  const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$/i.exec(noComments(T.d4))?.[1] || '';
  for (const w of ['Run 20261021a_OPS_stock_native_0a.sql first. Nothing was changed.', 'Run 20261022a_OPS_stock_native_0b.sql first. Nothing was changed.',
    'Run 20261024a_OPS_stock_native_1.sql first. Nothing was changed.', 'Run 20261023a_OPS_stock_drainer_v2.sql first. Nothing was changed.',
    'Drop 4a has run already. Nothing was changed.', 'Storage is not there. Nothing was changed.']) {
    assert.ok(guard.includes(w), `the guard says '${w}'`);
  }
  for (const name of ['stock_movements_day_sums_ins', 'stock_sale_takes', 'stock_order_rules', 'stock_co_lock_upd', 'stock_day_sums', "column_name = 'demo'", 'report_export_cron_ok']) {
    assert.ok(guard.includes(name), `the guard knows the earlier files by ${name}`);
  }
  for (const fn of ['vault.create_secret(text,text,text,uuid)', 'net.http_post(text,jsonb,jsonb,jsonb,integer)', 'cron.schedule(text,text,text)', 'cron.unschedule(bigint)']) {
    assert.ok(guard.includes(fn), `the guard checks ${fn}`);
  }
  const last = statements(T.d4).at(-1) || '';
  for (const col of CHECK_ROW) assert.match(last, new RegExp(`(\\bas\\s+${col}\\b|\\bo\\.${col}\\b)`), `check row column ${col}`);
  const rbLast = statements(T.d4Rb).at(-1) || '';
  for (const col of RB_ROW) assert.match(rbLast, new RegExp(`\\bas\\s+${col}\\b`), `rollback check row column ${col}`);
  const rbGuard = /do\s+\$guard\$([\s\S]*?)\$guard\$/i.exec(noComments(T.d4Rb))?.[1] || '';
  assert.match(rbGuard, /to_regclass\('public\.stock_targets'\) is null/, 'the rollback refuses unless 4a is in');
});

test('the nine bodies 4a reads are checked by md5 and none is replaced or backed up', () => {
  for (const [s, m5] of Object.entries(CHECKED)) {
    assert.ok(T.d4.includes(`('${s}', '${m5}')`), `checks ${s} (${m5})`);
  }
  assert.match(T.d4, /A stock function changed since this file was written\. Ask Claude for a new file\./);
  assert.match(T.d4, /md5\(btrim\(regexp_replace\(p\.prosrc, '\\s\+', ' ', 'g'\)\)\)/, 'the normalised body md5');
  assert.doesNotMatch(noComments(T.d4), /insert\s+into\s+public\.stock_native_backup/i, 'nothing is backed up');
  // no function an earlier migration made is created again here
  const mine = new Set(fns(T.d4).map((f) => f.name));
  const others = readdirSync(path(MIGS)).filter((f) => f.endsWith('.sql') && !f.startsWith('20261026a_'));
  const clash = [];
  for (const f of others) {
    for (const m of noComments(read(`${MIGS}${f}`)).matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi)) {
      if (mine.has(m[1].toLowerCase())) clash.push(`${m[1]} (${f})`);
    }
  }
  assert.deepEqual(clash, [], `4a replaces no earlier body: ${clash.join(', ')}`);
  for (const name of Object.keys(CHECKED).map((s) => s.slice(7, s.indexOf('(')))) {
    assert.ok(!mine.has(name), `${name} is read, never replaced`);
  }
});

test('the three new tables: RLS, revoked from every API role, a select only read rule, the second step fence, no write policy', () => {
  const t = noComments(T.d4);
  for (const name of NEW_TABLES) {
    assert.match(t, new RegExp(`create\\s+table\\s+public\\.${name}\\s*\\(`), `${name} is made`);
    assert.match(t, new RegExp(`alter\\s+table\\s+public\\.${name}\\s+enable\\s+row\\s+level\\s+security`), `${name}: RLS on`);
    assert.match(t, new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${name}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`), `${name}: revoked first`);
    assert.match(t, new RegExp(`create\\s+policy\\s+${name}_read\\s+on\\s+public\\.${name}\\s+as\\s+permissive\\s+for\\s+select\\s+to\\s+authenticated`), `${name}: one read rule, select only`);
    assert.doesNotMatch(t, new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${name}\\s+as\\s+permissive\\s+for\\s+(all|insert|update|delete)`, 'i'), `${name}: no write policy`);
    assert.match(T.d4, new RegExp(`comment on table public\\.${name} is\\s+'[^']*20261026a`), `${name}: its comment names the Drop`);
  }
  assert.match(t, /foreach\s+t\s+in\s+array\s+array\['stock_targets',\s*'stock_key_ratios',\s*'report_export_jobs'\]\s+loop[\s\S]*?second_step_fence[\s\S]*?as restrictive for all to authenticated/, 'the second step fence on all three');
  assert.match(t, /grant\s+select\s+on\s+table\s+public\.stock_targets\s+to\s+authenticated,\s*service_role;/);
  assert.match(t, /grant\s+select\s+on\s+table\s+public\.stock_key_ratios\s+to\s+authenticated;/);
  assert.match(t, /grant\s+select\s+on\s+table\s+public\.report_export_jobs\s+to\s+authenticated,\s*service_role;/);
  assert.match(t, /stock_targets_read[\s\S]{0,120}stock_reach_orgs\(\)/, 'targets are read by the company reach');
  assert.match(t, /report_export_jobs_read[\s\S]{0,120}user_id\s*=\s*auth\.uid\(\)\s+and\s+not\s+public\.is_anon_session\(\)/, 'a login reads its own export jobs only');
  assert.doesNotMatch(t, /grant\s+(insert|update|delete|all)\s+on\s+table\s+public\.(stock_targets|stock_key_ratios|report_export_jobs)/i, 'no write grant');
});

test('every new function: definer, a search path, revoked from public and anon by name, then exactly the grants of contract 1.8', () => {
  const list = fns(T.d4);
  const names = list.map((f) => f.name);
  assert.equal(new Set(names).size, names.length, 'each function is made once');
  for (const n of REPORTS) assert.ok(names.includes(`stock_report_${n}`), `stock_report_${n} is made`);
  assert.ok(!names.includes('stock_report_recipe_cost') && !names.includes('stock_report_allergens'), 'recipe cost and allergens wait for the recipes update');
  const noComm = noComments(T.d4);
  for (const f of list) {
    assert.match(f.head, /security\s+definer/i, `${f.name} is security definer`);
    const want = f.name === 'report_export_cron_ok' || f.name === 'report_export_run_due' ? /set\s+search_path\s*=\s*''/i : /set\s+search_path\s*=\s*public,\s*pg_temp/i;
    assert.match(f.head, want, `${f.name}: search_path ${f.name.startsWith('report_export_cron') || f.name === 'report_export_run_due' ? "''" : 'public, pg_temp'}`);
    const rv = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${f.name}\\s*\\(${f.types.map((x) => x.replace(/[[\]]/g, '\\$&')).join(',\\s*')}\\)\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role;`);
    assert.match(noComm, rv, `${sig(f)} is revoked from public and anon by name`);
    const granted = [...noComm.matchAll(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${f.name}\\s*\\([^)]*\\)\\s+to\\s+([a-z_, ]+);`, 'g'))]
      .flatMap((m) => m[1].split(',').map((x) => x.trim())).sort();
    const exp = f.name.startsWith('stock_rp__') ? [] : (GRANTS[f.name] || null);
    assert.ok(exp !== null, `${f.name} has an expected grant list`);
    assert.deepEqual(granted, [...exp].sort(), `${f.name}: EXECUTE granted to ${exp.join(', ') || 'nobody'}`);
  }
  assert.match(noComm, /p\.proname ~ '\^stock_rp__' or p\.proname ~ '\^report_export_' or p\.proname = 'stock_report_guard'/, 'the catalog loop revokes the internals too (a revoke, never a drop)');
  assert.doesNotMatch(noComm, /grant\s+execute\s+on\s+function[^;]*\bto\s+[^;]*\banon\b/i, 'anon is granted nothing');
  assert.doesNotMatch(noComm, /grant\s+execute\s+on\s+function[^;]*\bto\s+[^;]*\bpublic\b/i, 'public is granted nothing');
});

test('every report: the one signature, the guard, the range check, paged at most 1,000 rows, never OFFSET', () => {
  const list = fns(T.d4);
  for (const n of REPORTS) {
    const f = list.find((x) => x.name === `stock_report_${n}`);
    assert.ok(f, `stock_report_${n}`);
    assert.deepEqual(f.types, ['uuid', 'uuid[]', 'date', 'date', 'jsonb', 'jsonb', 'integer'], `${n}: (p_org, p_sites, p_from, p_to, p_opts, p_after, p_limit)`);
    assert.match(f.args, /p_after\s+jsonb\s+default\s+null,\s*p_limit\s+integer\s+default\s+1000/i, `${n}: p_after and p_limit default 1000`);
    assert.match(f.head, /\bstable\b/i, `${n} is stable`);
    assert.match(f.body, /public\.stock_report_guard\(p_org,\s*p_sites\)/, `${n} asks the report guard first`);
    assert.match(f.body, /public\.stock_rp__range_ok\(p_from,\s*p_to\)/, `${n} checks the range`);
    assert.match(f.body, /public\.stock_rp__page_cap\(p_limit\)/, `${n} caps at 1,000 rows`);
    assert.match(f.body, /'next'/, `${n} answers next`);
  }
  for (const [k, t] of Object.entries(T)) assert.doesNotMatch(noComments(t), /\boffset\b/i, `${FILES[k]}: never OFFSET`);
  const cap = list.find((x) => x.name === 'stock_rp__page_cap');
  assert.match(cap.body, /least\(greatest\(coalesce\(p_limit,\s*1000\),\s*1\),\s*1000\)/, 'the cap is 1 to 1,000');
  const sk = list.find((x) => x.name === 'stock_rp__sk');
  assert.match(sk?.body || '', /round\(coalesce\(p_value,\s*0\),\s*6\)/, 'a keyset number is rounded to 6 places (so next survives a JavaScript round trip)');
});

test('demo history is left out: demo = false on every day total read, stock_rp__is_demo on every movement read', () => {
  const list = fns(T.d4);
  for (const f of list) {
    for (const m of f.body.matchAll(/stock_day_sums\s+(?:as\s+)?([a-z]\w*)\b/g)) {
      const alias = m[1];
      if (['where', 'on', 'join', 'group', 'order'].includes(alias)) continue;
      const after = f.body.slice(m.index, m.index + 700);
      assert.match(after, new RegExp(`\\b${alias}\\.demo\\s*=\\s*(false|true)\\b`), `${f.name}: the stock_day_sums read as ${alias} says demo = false (or looks for demo = true)`);
    }
    for (const m of f.body.matchAll(/stock_movements\s+(?:as\s+)?([a-z]\w*)\b/g)) {
      const after = f.body.slice(m.index, m.index + 700);
      assert.match(after, /stock_rp__is_demo\(/, `${f.name}: the stock_movements read leaves demo keys out`);
    }
  }
  const isDemo = list.find((x) => x.name === 'stock_rp__is_demo');
  assert.match(isDemo.body, /left\(p_key,\s*8\)\s*=\s*'demo-v1:'\s+or\s+left\(p_key,\s*7\)\s*=\s*'demo71:'\s+or\s+left\(p_key,\s*5\)\s*=\s*'seed:'/, 'the demo keys of map 8.5');
});

test('the built in targets of stock_rp__rag are TARGET_DEFAULTS of targetRules.js, number for number', () => {
  const rag = fns(T.d4).find((x) => x.name === 'stock_rp__rag');
  const block = /from\s+\(values([\s\S]*?)\)\s+as\s+d\(metric,\s*green_to,\s*amber_to\)/i.exec(rag.body)?.[1] || '';
  const got = Object.fromEntries([...block.matchAll(/\('([a-z_]+)',\s*([0-9.]+)(?:::numeric)?,\s*([0-9.]+)(?:::numeric)?\)/g)].map((m) => [m[1], { green_to: Number(m[2]), amber_to: Number(m[3]) }]));
  assert.deepEqual(got, Object.fromEntries(Object.entries(TARGET_DEFAULTS).map(([k, v]) => [k, { ...v }])));
  assert.match(T.d4, /check \(metric in \('gp_pct', 'gap_pct', 'waste_pct', 'comps_pct', 'days_on_hand', 'budget_pct', 'no_recipe_pct'\)\)/, 'the seven metrics');
});

test('no UPDATE or DELETE without WHERE, in either file', () => {
  for (const [k, t] of Object.entries(T)) {
    const flat = noComments(t).replace(/\$([a-z_0-9]*)\$/gi, ';');
    for (const chunk of flat.split(';')) {
      for (const m of chunk.matchAll(/(?<!for\s|do\s|no\s+key\s)\bupdate\s+(?:public\.)?([a-z_]+)\s+(?:[a-z]\s+)?set\b/gi)) {
        assert.match(chunk.slice(m.index), /\bwhere\b/i, `${FILES[k]}: update ${m[1]} has a WHERE`);
      }
      for (const m of chunk.matchAll(/\bdelete\s+from\s+([a-z_.]+)/gi)) {
        assert.match(chunk.slice(m.index), /\bwhere\b/i, `${FILES[k]}: delete from ${m[1]} has a WHERE`);
      }
    }
  }
});

test('the words of contract 1.11 are there', () => {
  for (const w of WORDS) assert.ok(T.d4.includes(w), `says '${w}'`);
});

test('the storage policy: the owner folder only, never a device read function; the bucket is private', () => {
  const pol = /create\s+policy\s+report_exports_owner_read\s+on\s+storage\.objects\s+for\s+select\s+to\s+authenticated\s+using\s*\(([\s\S]*?)\);/i.exec(noComments(T.d4))?.[1] || '';
  assert.match(pol, /bucket_id = 'report-exports'/);
  assert.match(pol, /\(storage\.foldername\(name\)\)\[2\] = auth\.uid\(\)::text/);
  assert.match(pol, /not public\.is_anon_session\(\)/);
  assert.doesNotMatch(pol, /accessible_location|ops_writable_location|user_accessible/);
  assert.doesNotMatch(noComments(T.d4), /create\s+policy\s+\w+\s+on\s+storage\.objects\s+for\s+(insert|update|delete|all)/i, 'no write policy on storage');
  assert.match(T.d4, /values \('report-exports', 'report-exports', false, 52428800, array\['text\/csv', 'application\/json'\]\)\s+on conflict \(id\) do nothing/);
});

test('the export sender posts to report-export with x-cron-key, only when there is work; the key is made by the database', () => {
  const due = fns(T.d4).find((x) => x.name === 'report_export_run_due');
  assert.match(due.body, /url := 'https:\/\/tbetcegmszzotrwdtqhi\.supabase\.co\/functions\/v1\/report-export'/);
  assert.match(due.body, /'x-cron-key', k/);
  assert.match(due.body, /body := '\{"action": "run"\}'::jsonb/);
  assert.match(due.body, /if not exists \(select 1 from public\.report_export_jobs j[\s\S]*?return 0;/, 'nothing is posted when nothing waits');
  assert.match(T.d4, /cron\.schedule\('report-export-run', '\* \* \* \* \*', 'select public\.report_export_run_due\(\);'\)/);
  assert.match(T.d4, /vault\.create_secret\(\s*replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\),\s*'report_export_cron_key'/);
  const ok = fns(T.d4).find((x) => x.name === 'report_export_cron_ok');
  assert.match(ok.body, /length\(p_key\) >= 32/);
  assert.doesNotMatch(ok.head, /returns\s+text/i, 'the key check never returns the key');
});

test('the sales history backfill: 15 venue days a minute, newest first, the drainer\'s queue, never twice', () => {
  const t = noComments(T.d4);
  assert.match(t, /insert into public\.sales_day_sums_queue \(location_id, business_day, reason, queued_at, attempts, due_at\)/);
  assert.match(t, /'drop4a_backfill'/);
  assert.match(t, /\(row_number\(\) over \(order by d\.business_day desc, d\.location_id\) - 1\) \/ 15\) \* interval '1 minute'/);
  assert.match(t, /on conflict \(location_id, business_day\) do nothing/);
  assert.match(t, /current_date - interval '13 months'/);
});

test('the rollback names everything 4a made, by exact signature, and never uses LIKE', () => {
  const rb = noComments(T.d4Rb);
  assert.doesNotMatch(rb, /\blike\b/i, 'no LIKE');
  for (const f of fns(T.d4)) {
    const re = new RegExp(`drop\\s+function\\s+if\\s+exists\\s+public\\.${f.name}\\s*\\(${f.types.map((x) => x.replace(/[[\]]/g, '\\$&')).join(',\\s*')}\\);`);
    assert.match(rb, re, `the rollback drops ${sig(f)}`);
  }
  for (const t of NEW_TABLES) assert.match(rb, new RegExp(`drop\\s+table\\s+if\\s+exists\\s+public\\.${t};`), `drops ${t}`);
  for (const ix of ['stock_day_sums_rp', 'sales_day_sums_rp', 'stock_day_sums_demo', 'closed_checks_demo_rp']) assert.match(rb, new RegExp(`drop\\s+index\\s+if\\s+exists\\s+public\\.${ix};`), `drops ${ix}`);
  for (const ix of NEW_INDEXES) assert.ok(T.d4.includes(ix), `4a makes ${ix}`);
  assert.match(rb, /drop policy if exists report_exports_owner_read on storage\.objects;/);
  assert.match(rb, /delete from storage\.objects o where o\.bucket_id = 'report-exports';/);
  assert.match(rb, /delete from storage\.buckets b where b\.id = 'report-exports';/);
  assert.match(rb, /delete from vault\.secrets s where s\.name = 'report_export_cron_key';/);
  assert.match(rb, /c\.jobname = 'report-export-run'[\s\S]*?cron\.unschedule\(j\.jobid\)/);
  assert.match(rb, /set status = 'failed', error = 'Drop 4a was rolled back\.'/);
  assert.match(rb, /delete from public\.sales_day_sums_queue q where q\.reason = 'drop4a_backfill'/);
  assert.match(T.d4Rb, /the backfilled days already totalled stay, they are correct/);
  assert.doesNotMatch(rb, /drop\s+table\s+if\s+exists\s+public\.(sales_day_sums|stock_day_sums|stock_change_log|stock_sale_takes)\b/, 'the day totals and the change log are kept');
});
