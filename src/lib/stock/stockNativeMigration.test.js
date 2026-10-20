// node --test: the Drop 0 multi site stock files (20261021a 0a, its revalue file, 20261022a 0b and the
// three rollbacks) read as text, so CI checks the house rules on every PR. What they DO is proved on a
// real Postgres 17 shaped like Ops by supabase/tests/stock_native/run.mjs (Peter's files are never run
// against Supabase by Claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const path = (p) => new URL(`../../../${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const MIGS = 'supabase/migrations/';
const FILES = {
  a: `${MIGS}20261021a_OPS_stock_native_0a.sql`,
  aRb: `${MIGS}20261021a_OPS_stock_native_0a_ROLLBACK.sql`,
  rv: `${MIGS}20261021a_OPS_stock_native_0a_revalue.sql`,
  rvRb: `${MIGS}20261021a_OPS_stock_native_0a_revalue_ROLLBACK.sql`,
  b: `${MIGS}20261022a_OPS_stock_native_0b.sql`,
  bRb: `${MIGS}20261022a_OPS_stock_native_0b_ROLLBACK.sql`,
};
const missing = Object.values(FILES).filter((f) => !existsSync(path(f)));
const T = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, existsSync(path(f)) ? read(f) : '']));

// Comments out (line comments and block comments), then dollar quoted bodies out: what is left is the
// statements the SQL editor runs at the top level.
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const top = (t) => noComments(t).replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/gi, () => ' $$body$$ ');
const statements = (t) => top(t).split(';').map((s) => s.trim()).filter(Boolean);
const created = (t, kind = 'function|procedure') => [...noComments(t).matchAll(new RegExp(`create\\s+or\\s+replace\\s+(?:${kind})\\s+public\\.([a-z0-9_]+)\\s*\\(`, 'gi'))].map((m) => m[1].toLowerCase());
const tablesMade = (t) => [...noComments(t).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
// the old card processor's name, spelt out letter by letter so this file never carries the word
const OLD_PROCESSOR = new RegExp(['s', 't', 'r', 'i', 'p', 'e'].join(''), 'i');
const REPLACED = ['_stock_receive_lines', 'approve_stock_count', 'post_stock_transfer_leg', 'stock_office_reaches', 'stock_caller_reaches', 'stock_cost_rule', 'user_profiles_fence_guard'];

test('all six Drop 0 files are in supabase/migrations', () => {
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')} (the extras SQL builder writes them; 0a is header + the five part files)`);
});

test('ASCII only, never an em or en dash, never the old card processor\'s name', () => {
  for (const [k, t] of Object.entries(T)) {
    const bad = [...t].findIndex((ch) => ch.charCodeAt(0) > 127);
    assert.equal(bad, -1, `${FILES[k]}: a non ASCII character at ${bad}: ${JSON.stringify(t.slice(Math.max(0, bad - 30), bad + 10))}`);
    assert.doesNotMatch(t, /[\u2013\u2014]/, FILES[k]);
    assert.doesNotMatch(t, OLD_PROCESSOR, `${FILES[k]} names the old card processor`);
  }
});

test('bare statements: no begin, commit or rollback of their own (the SQL editor runs one paste as one transaction)', () => {
  for (const [k, t] of Object.entries(T)) {
    for (const s of statements(t)) assert.doesNotMatch(s, /^(begin|commit|rollback|start\s+transaction)\b/i, `${FILES[k]}: ${s.slice(0, 60)}`);
  }
});

test('guard first and a short lock wait, a visible check row last', () => {
  for (const [k, t] of Object.entries(T)) {
    const st = statements(t);
    assert.match(st[0] || '', /^do\s+\$\$body\$\$$/i, `${FILES[k]}: the first statement is the guard DO block (${(st[0] || '').slice(0, 60)})`);
    const guard = /do\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\1\$/i.exec(noComments(t));
    assert.ok(guard && /raise\s+exception/i.test(guard[2]), `${FILES[k]}: the guard raises with plain words`);
    assert.match(top(t), /set\s+local\s+lock_timeout\s*=\s*'[0-9]+s'/i, `${FILES[k]}: a short lock wait`);
    const last = st[st.length - 1] || '';
    assert.match(last, /^(with\b[\s\S]*\bselect\b|select\b)/i, `${FILES[k]}: the last statement is the visible check row (${last.slice(0, 60)})`);
  }
  assert.match(top(T.a), /set\s+local\s+lock_timeout\s*=\s*'3s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'300s'/i, '0a: 3 s lock wait, 300 s limit');
  for (const col of ['venue', 'delta', 'site_rows_without_company_ref', 'sync_planned_writes', 'recipe_pairs', 'policies_swapped', 'policies_swapped_devices',
    'internals_open_to_api', 'approve_open_to_logins', 'profile_guard_closed', 'cron_jobs', 'nightly_key_present']) {
    assert.match(statements(T.a).at(-1) || '', new RegExp(`\\bas\\s+${col}\\b`), `0a check row column ${col}`);
  }
  for (const col of ['items_off_before', 'revalue_rows', 'revalue_value', 'items_off_after']) assert.match(statements(T.rv).at(-1) || '', new RegExp(`\\bas\\s+${col}\\b`), `revalue check row ${col}`);
  for (const col of ['lock_triggers', 'approve_open_to_logins', 'dry_run_name_refused', 'dry_run_on_hand_refused', 'save_rows_since_0a']) assert.match(statements(T.b).at(-1) || '', new RegExp(`\\bas\\s+${col}\\b`), `0b check row ${col}`);
});

test('0a is the five part files in order, with the seven live body checks and the optional profile guard block marked', () => {
  const marks = [...T.a.matchAll(/^-- == 0a part ([1-5]):/gm)].map((m) => Number(m[1]));
  assert.deepEqual(marks, [1, 2, 3, 4, 5], 'one header line per part, 1 to 5, in order');
  for (const md5 of ['188d811b62552b501a42c7948ad46a22', 'd920cc8d432e65a1373fd1548e7cfc7e', 'f321c21b48115a8de8fbfcb021ab4577', 'f822b368352f2cc5d307c6aba9917429',
    '6f7553102dbaf750eb13e82fdd5d5149', '8fdd834c5814089d6baaa46c2660e5c7', '79ed2f68e3504dc1f38e98aee31a7baa', '2974176b3ea49b90065dc0c20572e343']) {
    assert.ok(T.a.includes(md5), `0a checks the live body md5 ${md5}`);
  }
  assert.match(T.a, /A stock function changed since this file was written\. Ask Claude for a new file\./);
  assert.match(T.a, /md5\(btrim\(regexp_replace\(p\.prosrc, '\\s\+', ' ', 'g'\)\)\)/, 'the normalised body md5 (contract section 4)');
  assert.match(T.a, /OPTIONAL[\s\S]{0,600}user_profiles_fence_guard|user_profiles_fence_guard[\s\S]{0,600}OPTIONAL/, 'the profile guard org fix is its own clearly marked block');
  assert.match(T.a, /for no key update/i, 'the item row locks before the snapshot');
});

test('menu machinery and every other live function untouched: only the seven named bodies are replaced', () => {
  const menu = new Set();
  for (const f of ['20261017_OPS_multi_site_menu.sql', '20261017c_OPS_multi_site_menu_groups.sql', '20261018_OPS_multi_site_menu_category_fields.sql']) {
    for (const n of created(read(`${MIGS}${f}`))) menu.add(n);
  }
  const mine = [...created(T.a), ...created(T.b), ...created(T.rv)];
  assert.ok(mine.length > 40, `0a makes the Drop 0 functions (${mine.length})`);
  assert.deepEqual(mine.filter((n) => menu.has(n)), [], 'no Multi site menu function is created or replaced');
  for (const t of [T.a, T.b, T.rv]) {
    assert.doesNotMatch(noComments(t), /alter\s+table\s+(?:if\s+exists\s+)?public\.msm_/i, 'no menu table is altered');
    assert.doesNotMatch(noComments(t), /create\s+(?:or\s+replace\s+)?trigger\s+\w+[\s\S]{0,120}?\son\s+public\.msm_/i, 'no trigger is put on a menu table');
  }
  // every function an earlier migration made: only the seven named ones may be replaced here
  const older = new Set();
  for (const f of readdirSync(path(MIGS)).filter((x) => x.endsWith('.sql') && !x.includes('stock_native') && !x.includes('ROLLBACK') && x < '20261021')) {
    for (const n of created(read(`${MIGS}${f}`))) older.add(n);
  }
  const replaced = [...new Set([...created(T.a), ...created(T.b), ...created(T.rv)])].filter((n) => older.has(n));
  assert.deepEqual(replaced.filter((n) => !REPLACED.includes(n)), [], `only ${REPLACED.join(', ')} are rebuilt (found ${replaced.join(', ')})`);
  for (const f of ['_post_stock_movement', 'post_stock_movement', 'stock_explode', 'stock_outbox_drain', 'stock_record_waste', 'stock_receive', 'stock_post_invoice',
    'user_accessible_locations', 'accessible_location_uuids', 'accessible_location_ids', 'set_bo_sections']) {
    assert.ok(!created(T.a).includes(f) && !created(T.b).includes(f), `${f} is not replaced`);
  }
});

test('0b: the company column lock never fires on on hand, cost, preferred pack, preferred supplier or account number', () => {
  const body = noComments(T.b);
  const upd = [...body.matchAll(/create\s+(?:or\s+replace\s+)?trigger\s+stock_co_lock_upd\s+before\s+update\s+on\s+public\.(\w+)\s+for\s+each\s+row\s+when\s*\(([\s\S]*?)\)\s*execute\s+function/gi)];
  const tables = upd.map((m) => m[1]).sort();
  assert.deepEqual(tables, ['inventory_item_conversions', 'inventory_items', 'item_packaging_formats', 'menu_item_recipes', 'recipe_lines', 'recipes', 'supplier_products', 'suppliers'],
    'one stock_co_lock_upd trigger on each of the eight tables');
  for (const [, tbl, when] of upd) {
    assert.doesNotMatch(when, /\b(on_hand|current_cost|is_preferred|default_supplier_id|account_number|par_level|updated_at)\b/, `${tbl}: ${when.slice(0, 120)}`);
  }
  assert.equal((body.match(/trigger\s+stock_co_lock_ins\s+before\s+insert/gi) || []).length, 8, 'forging a company_ref refused on the eight tables');
  assert.equal((body.match(/trigger\s+stock_co_lock_del\s+before\s+delete/gi) || []).length, 8, 'deleting a company row refused on the eight tables');
  assert.match(body, /trigger\s+stock_co_lock_ledger\s+before\s+update\s+of\s+on_hand,\s*current_cost\s+on\s+public\.inventory_items/i, 'the ledger lock');
  assert.match(body, /revoke\s+(?:all|execute)\s+on\s+function\s+public\.approve_stock_count\(uuid,\s*text,\s*text,\s*jsonb,\s*boolean\)\s+from\s+[^;]*\bauthenticated\b/i, 'count approval closed to logins');
  assert.match(body, /grant\s+execute\s+on\s+function\s+public\.approve_stock_count\(uuid,\s*text,\s*text,\s*jsonb,\s*boolean\)\s+to\s+service_role/i, 'the service role keeps it');
  assert.match(noComments(T.bRb), /grant\s+execute\s+on\s+function\s+public\.approve_stock_count\(uuid,\s*text,\s*text,\s*jsonb,\s*boolean\)\s+to\s+[^;]*\bauthenticated\b/i, 'and opened again by its rollback');
  assert.match(body, /set\s+local\s+request\.jwt\.claims|set_config\(\s*'request\.jwt\.claims'/i, 'the dry run sets real request claims');
});

test('no UPDATE or DELETE without a WHERE (Ops preloads pg-safeupdate for the API login, inside functions too)', () => {
  for (const [k, t] of Object.entries(T)) {
    const body = noComments(t);
    for (const st of body.split(';')) {
      const m = /(?:^|[\s(])(update\s+(?!of\b)(?:only\s+)?[a-z_.]+\s+(?:as\s+)?(?:[a-z_]+\s+)?set\b|delete\s+from\b)/i.exec(st);
      if (!m) continue;
      const rest = st.slice(m.index);
      if (/do\s+update\s+set/i.test(rest) && !/^\s*\(?\s*update\s+/i.test(rest.trim())) continue;
      assert.match(rest, /\bwhere\b/i, `${FILES[k]}: ${rest.trim().slice(0, 140)}`);
    }
  }
});

test('every new table has row level security, its own second step fence, and no write policy', () => {
  const body = noComments(T.a);
  const blocks = [...body.matchAll(/do\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\1\$/gi)].map((m) => m[2]);
  const tables = tablesMade(T.a);
  assert.ok(tables.length >= 27, `0a makes the Drop 0 tables (${tables.length})`);
  for (const t of tables) {
    const rls = new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, 'i').test(body)
      || blocks.some((b) => /enable\s+row\s+level\s+security/i.test(b) && b.includes(`'${t}'`));
    assert.ok(rls, `${t}: row level security on`);
    const fence = new RegExp(`create\\s+policy\\s+second_step_fence\\s+on\\s+public\\.${t}\\b`, 'i').test(body)
      || blocks.some((b) => /second_step_fence/.test(b) && b.includes(`'${t}'`));
    assert.ok(fence, `${t}: its own second step fence`);
    assert.match(body, new RegExp(`revoke\\s+all\\s+on\\s+(?:table\\s+)?public\\.${t}\\s+from\\s+public,\\s*anon,\\s*authenticated|'${t}'`, 'i'), `${t}: revoked from the API roles first`);
    assert.doesNotMatch(body, new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${t}\\s+(?:as\\s+permissive\\s+)?for\\s+(insert|update|delete|all)\\b`, 'i'), `${t}: no write policy (only definer functions write)`);
  }
});

test('grants: internals closed, every new function revoked from public and anon by name, anon keeps stock_reach_locations only', () => {
  const body = noComments(T.a);
  assert.match(body, /'\^stock_co__'/, 'the stock_co__ catalog loop');
  assert.match(body, /from\s+public,\s*anon,\s*authenticated,\s*service_role/i);
  assert.match(body, /revoke\s+all\s+on\s+procedure\s+public\.stock_save_queue_run\(integer\)\s+from\s+public,\s*anon,\s*authenticated,\s*service_role/i, 'the queue runner open to no API role');
  const fns = [...new Set(created(T.a))].filter((n) => !REPLACED.includes(n) && !/^stock_co__/.test(n));
  for (const n of fns) {
    assert.match(body, new RegExp(`revoke\\s+all\\s+on\\s+(?:function|procedure)\\s+public\\.${n}\\s*\\([^)]*\\)\\s+from\\s+public,\\s*anon`, 'i'), `${n} revoked from public and anon by name`);
  }
  const anonGrants = [...body.matchAll(/grant\s+execute\s+on\s+function\s+public\.([a-z0-9_]+)\s*\([^)]*\)\s+to\s+([^;]+);/gi)].filter((m) => /\banon\b/.test(m[2])).map((m) => m[1]);
  assert.deepEqual([...new Set(anonGrants)], ['stock_reach_locations'], 'exception 1 only');
  const writerOk = [...body.matchAll(/grant\s+execute\s+on\s+function\s+public\.(stock_co__[a-z0-9_]+)\s*\(/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(writerOk)], ['stock_co__writer_ok'], 'exception 2 only');
  for (const f of ['stock_native_backup', 'stock_pin_tries']) {
    assert.doesNotMatch(body, new RegExp(`grant\\s+[a-z, ]+\\s+on\\s+(?:table\\s+)?public\\.${f}\\s+to`, 'i'), `${f}: owner only`);
  }
  assert.match(body, /notify\s+pgrst,\s*'reload schema'/i);
});

test('the triggers: orphan is AFTER INSERT (PostgREST upserts), the mirror is three statement triggers', () => {
  const body = noComments(T.a);
  assert.doesNotMatch(body, /trigger\s+stock_co_orphan\s+before/i, 'never a BEFORE INSERT orphan trigger');
  assert.match(body, /stock_co_orphan[\s\S]{0,200}after\s+insert[\s\S]{0,200}when\s*\(\s*new\.company_ref\s+is\s+null\s*\)|after\s+insert[\s\S]{0,200}stock_co_orphan/i);
  for (const n of ['stock_co_mirror_ins', 'stock_co_mirror_upd', 'stock_co_mirror_del']) assert.match(body, new RegExp(`${n}[\\s\\S]{0,300}for\\s+each\\s+statement`, 'i'), n);
  assert.match(body, /referencing\s+old\s+table\s+as\s+old_rows\s+new\s+table\s+as\s+new_rows/i);
});

test('rollbacks: explicit names only, never a LIKE on stock_co, and what they keep is kept', () => {
  for (const k of ['a', 'aRb', 'rvRb', 'bRb']) {
    assert.doesNotMatch(noComments(T[k]), /like\s+'[%_]*stock_co/i, `${FILES[k]}: a LIKE would also match stock_count*, stock_cost_rule, stock_convert_qty`);
  }
  const rb = noComments(T.aRb);
  for (const t of tablesMade(T.a)) assert.match(rb, new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${t}\\b`, 'i'), `the 0a rollback drops ${t} by name`);
  for (const n of [...new Set(created(T.a))].filter((x) => !REPLACED.includes(x))) {
    assert.match(rb, new RegExp(`drop\\s+(?:function|procedure)\\s+(?:if\\s+exists\\s+)?public\\.${n}\\s*\\(`, 'i'), `the 0a rollback drops ${n} by name`);
  }
  assert.match(rb, /stock_native_backup/, 'it replays the seven bodies 0a backed up');
  assert.match(rb, /cron\.unschedule/i);
  assert.match(rb, /'stock-save-queue'/);
  assert.match(rb, /'stock-nightly'/);
  assert.match(rb, /delete\s+from\s+vault\.secrets\s+(?:\w+\s+)?where\s+(?:\w+\.)?name\s*=\s*'stock_nightly_cron_key'/i, 'the vault key by name');
  assert.doesNotMatch(rb, /drop\s+column\s+(?:if\s+exists\s+)?approved_by_staff_(id|name)/i, 'the PIN holder columns are kept');
  assert.match(rb, /user_accessible_locations\(\)/, 'the 51 policies are put back');
  assert.match(rb, /accessible_location_uuids\(\)/, 'and the 14');
  assert.match(noComments(T.rvRb), /delete\s+from\s+(?:public\.)?stock_movements\b[^;]*\bwhere\b/i, 'the revalue rollback deletes ledger rows (with a WHERE)');
  assert.match(noComments(T.rvRb), /source_type\s*=\s*'opening_revalue'/i, 'chosen by their source_type');
});

test('the revalue file: one REVALUE per item off, keyed so a second run writes nothing', () => {
  const body = noComments(T.rv);
  assert.match(body, /'opening_revalue'/);
  assert.match(body, /'revalue:opening:'/);
  assert.match(body, /'REVALUE'/);
  assert.match(body, /opening_revalue[\s\S]{0,400}raise\s+exception|raise\s+exception[\s\S]{0,200}opening/i, 'it refuses a second run');
});
