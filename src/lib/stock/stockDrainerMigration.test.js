// node --test: the multi site stock drainer release (20261023a) and its rollback, read as text, so CI
// checks the house rules on every PR (drainer contract 5.7). What the files DO is proved on a real
// Postgres 17 shaped like Ops by `node supabase/tests/stock_native/run.mjs --drainer` (sections 19 to
// 29); Peter's files are never run against Supabase by Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const path = (p) => new URL(`../../../${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const MIGS = 'supabase/migrations/';
const FILES = {
  d: `${MIGS}20261023a_OPS_stock_drainer_v2.sql`,
  dRb: `${MIGS}20261023a_OPS_stock_drainer_v2_ROLLBACK.sql`,
  aRb: `${MIGS}20261021a_OPS_stock_native_0a_ROLLBACK.sql`,
};
const T = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, existsSync(path(f)) ? read(f) : '']));
const OURS = ['d', 'dRb'];

// Comments out, then dollar quoted bodies out: what is left is what the SQL editor runs at the top level.
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const top = (t) => noComments(t).replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/gi, () => ' $$body$$ ');
const statements = (t) => top(t).split(';').map((s) => s.trim()).filter(Boolean);
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
// string literals emptied (after the comments are out), so a ';' inside a message never splits a statement
const noStrings = (t) => t.replace(/'(?:[^']|'')*'/g, "''");
// the old card processor's name, spelt out letter by letter so this file never carries the word
const OLD_PROCESSOR = new RegExp(['s', 't', 'r', 'i', 'p', 'e'].join(''), 'i');

// Every function or procedure the file creates or replaces, with its argument TYPES (names and
// defaults dropped), as `revoke ... on function public.name(types)` names it.
function createdSigs(t) {
  const out = [];
  const re = /create\s+or\s+replace\s+(function|procedure)\s+public\.([a-z0-9_]+)\s*\(/gi;
  const body = noComments(t);
  let m;
  while ((m = re.exec(body))) {
    let depth = 1; let k = re.lastIndex;
    while (k < body.length && depth > 0) { if (body[k] === '(') depth++; else if (body[k] === ')') depth--; k++; }
    const args = body.slice(re.lastIndex, k - 1);
    const parts = [];
    let cur = ''; let d2 = 0;
    for (const ch of args) { if (ch === '(') d2++; if (ch === ')') d2--; if (ch === ',' && d2 === 0) { parts.push(cur); cur = ''; } else cur += ch; }
    if (cur.trim()) parts.push(cur);
    const types = parts.map((a) => a.trim().replace(/\s+default\s+[\s\S]*$/i, '').replace(/^(in|out|inout)\s+/i, '').trim().split(/\s+/).slice(1).join(' ').toLowerCase());
    out.push({ kind: m[1].toLowerCase(), name: m[2].toLowerCase(), types: types.join(',').replace(/\s*,\s*/g, ',') });
  }
  return out;
}

// contract 2.1 to 2.5
const REPLACED = ['stock_qty_to_base', 'stock_explode', 'stock_explode_skipped', '_stock_outbox_apply', 'stock_day_sums_rebuild', 'sales_day_sums_rebuild', 'sales_day_sums_check'];
const NEW_FNS = ['stock_co__option_org_guard', 'stock_explode_lines', '_stock_takes_share', '_stock_day_sums_apply', '_venue_clock_requeue', 'stock_drainer_health',
  '_sales_js_round', '_sales_js_num', '_sales_check_parts', '_sales_day_sums_enqueue', 'stock_day_sums_drain'];
const OPTIONAL = ['_stock_explode_made'];
const NEVER = ['post_stock_movement', '_post_stock_movement', 'stock_outbox_drain', 'stock_record_waste', 'place_public_order', 'settle_qr_tab', '_stock_outbox_on_insert',
  '_stock_outbox_on_update', '_stock_post', '_stock_taken', '_stock_given_back', '_stock_refund_lines', '_stock_refund_at', 'report_day_sums', 'stock_co__venue_day'];
const SERVICE_ONLY = ['stock_day_sums_rebuild(uuid,date,date)', 'sales_day_sums_rebuild(uuid,date,date)', 'sales_day_sums_check(uuid,date)', 'stock_drainer_health(uuid)'];
const MD5 = {
  replaced: ['c052fead38aa366e8145a85790dda91c', '5e27ac77aa8022d035f226f9bc8d2db9', '1cfd825ca6f678d745552418008f6f46', 'e71a501b8571b4627558b0b1541d3417',
    '9a7d26c203d7ce2ae2c2e18879c9f29d', '76d10f6c92e685bc5ef20e04e29de0d9', '5fb95ca9d5987700a490f98b0565eb22'],
  checked: ['2974176b3ea49b90065dc0c20572e343', '858c0e57136998f6613cde7bba42010d', '3180631cc277fb3003c05a772b5400d5', 'a7fc1b530093d9d51504396184eaf7d4',
    '3878bfefa4e0e09ffee13e157da752de', 'de946a006072960781b6a8cc9e0e2df3', '7adec1618754c96e9f3d9655fcf98070', '1528946997db29d2f6c8685ca8425ec5',
    'e8acd544e17a4c176ae5015118f5fb80', 'df31713b61a21394dd8225bb3079538f', '3c65ef2a35812850480485860145722d', '2350548e9309c22a340dc216b765c43d',
    '72cf646903b672f80119819049810d14', 'cdf4f77b33245549db9a5e2787e5e731', '5b84b40043adb5d649b1e13799aef19c', '1bb362aea591604ca01108e2ad74a096',
    '8c9513db8ec56ddb68a1a3f247360742', '605fce03d4e44064df5cf3b03ecd0350', '2cb462264587615075225d05a84cd051', '25a8daf22bd412c1a2579807d21b223c',
    '28a3269e1d37a550643da3b08ae6daff'],
};
// contract 1.3: name, table, the definition up to EXECUTE FUNCTION (spaces normalised), the function
const TRIGGERS = [
  ['stock_movements_day_sums_ins', 'stock_movements', 'after insert on public.stock_movements referencing new table as new_rows for each statement', '_stock_day_sums_apply'],
  ['stock_movements_day_sums_upd', 'stock_movements', 'after update on public.stock_movements referencing old table as old_rows new table as new_rows for each statement', '_stock_day_sums_apply'],
  ['stock_movements_day_sums_del', 'stock_movements', 'after delete on public.stock_movements referencing old table as old_rows for each statement', '_stock_day_sums_apply'],
  ['closed_checks_sales_day_ins', 'closed_checks', 'after insert on public.closed_checks referencing new table as new_rows for each statement', '_sales_day_sums_enqueue'],
  ['closed_checks_sales_day_upd', 'closed_checks', 'after update on public.closed_checks referencing old table as old_rows new table as new_rows for each statement', '_sales_day_sums_enqueue'],
  ['venue_clock_requeue_ins', 'venue_clock', 'after insert on public.venue_clock for each row', '_venue_clock_requeue'],
  ['venue_clock_requeue_upd', 'venue_clock', 'after update of timezone, day_start on public.venue_clock for each row when (old.timezone is distinct from new.timezone or old.day_start is distinct from new.day_start)', '_venue_clock_requeue'],
  ['stock_co_option_org_guard', 'stock_co_option_rules', 'before insert or update on public.stock_co_option_rules for each row', 'stock_co__option_org_guard'],
  ['stock_co_option_org_guard', 'stock_co_option_rule_sites', 'before insert or update on public.stock_co_option_rule_sites for each row', 'stock_co__option_org_guard'],
];
const NEW_TABLES = ['stock_co_option_rules', 'stock_co_option_rule_sites', 'stock_sale_takes'];
const CHECK_ROW = ['venue', 'location_id', 'checks_compared', 'explode_rows_compared', 'explode_differences', 'skipped_flag_differences', 'refunds_compared',
  'refund_differences', 'recipe_lines_compared', 'base_qty_differences', 'bodies_replaced', 'bodies_backed_up', 'new_tables', 'discounts_kind', 'day_sums_triggers',
  'sales_enqueue_triggers', 'clock_triggers', 'option_guard_triggers', 'drain_job', 'internals_open_to_api', 'takes_rows', 'repair_days_queued', 'sales_days_queued'];
const RB_CHECK_ROW = ['bodies_restored', 'triggers_left', 'functions_left', 'tables_left', 'drain_job', 'discounts_kind_kept'];
// the output names of a SELECT list, in order (only "as <name>" items: every check row column is named)
const asNames = (st) => [...st.matchAll(/\bas\s+([a-z_][a-z0-9_]*)\s*(?=,|\bfrom\b|$)/gi)].map((m) => m[1].toLowerCase());
const partOf = (t, n) => { const a = t.indexOf(`-- == drainer part ${n}:`); const b = t.indexOf(`-- == drainer part ${n + 1}:`); return a < 0 ? '' : t.slice(a, b < 0 ? t.length : b); };

test('the release and its rollback are in supabase/migrations', () => {
  assert.ok(T.d, `${FILES.d} is missing (the extras SQL builder assembles it: header + the five part files)`);
  assert.ok(T.dRb, `${FILES.dRb} is missing (the extras SQL builder writes it, contract 5.6)`);
  assert.ok(T.aRb, `${FILES.aRb} is missing`);
});

test('ASCII only, never an em or en dash, never the old card processor\'s name', () => {
  for (const k of ['d', 'dRb', 'aRb']) {
    if (!T[k]) continue;
    const bad = [...T[k]].findIndex((ch) => ch.charCodeAt(0) > 127);
    assert.equal(bad, -1, `${FILES[k]}: a non ASCII character at ${bad}: ${JSON.stringify(T[k].slice(Math.max(0, bad - 30), bad + 10))}`);
    assert.doesNotMatch(T[k], /[\u2013\u2014]/, FILES[k]);
    assert.doesNotMatch(T[k], OLD_PROCESSOR, `${FILES[k]} names the old card processor (or reads the closed_checks column named after it)`);
  }
});

test('bare statements: no begin, commit or rollback of their own (one paste is one transaction)', () => {
  for (const k of OURS) {
    for (const s of statements(T[k])) assert.doesNotMatch(s, /^(begin|commit|rollback|start\s+transaction|end)\b/i, `${FILES[k]}: ${s.slice(0, 60)}`);
  }
});

test('guard first, a short lock wait before the first change, the visible check row last', () => {
  for (const k of OURS) {
    if (!T[k]) continue;
    const st = statements(T[k]);
    assert.match(st[0] || '', /^do\s+\$\$body\$\$$/i, `${FILES[k]}: the first statement is the guard DO block (${(st[0] || '').slice(0, 60)})`);
    const guard = /do\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\1\$/i.exec(noComments(T[k]));
    assert.ok(guard && /raise\s+exception\s+'[^']*Nothing was changed\.?[^']*'/i.test(guard[2]), `${FILES[k]}: the guard refuses in plain words ("Nothing was changed")`);
    assert.match(guard[2], /user_locations/, `${FILES[k]}: the guard asks for Ops`);
    const lockAt = st.findIndex((s) => /^set\s+local\s+lock_timeout\s*=\s*'3s'$/i.test(s));
    const changeAt = st.findIndex((s) => /^(create|alter|drop|insert|update|delete|grant|revoke|comment|select\s+cron\.)/i.test(s) && !/^create\s+temp(orary)?\s+table/i.test(s));
    assert.ok(lockAt > 0, `${FILES[k]}: set local lock_timeout = '3s'`);
    assert.ok(changeAt < 0 || lockAt < changeAt, `${FILES[k]}: the lock wait comes before the first change (lock at ${lockAt}, first change at ${changeAt}: ${(st[changeAt] || '').slice(0, 60)})`);
    const last = st[st.length - 1] || '';
    assert.match(last, /^(with\b[\s\S]*\bselect\b|select\b)/i, `${FILES[k]}: the last statement is the visible check row (${last.slice(0, 60)})`);
  }
  assert.match(top(T.d), /set\s+local\s+lock_timeout\s*=\s*'3s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'120s'/i, 'the release: 3 s lock wait, 120 s limit');
  assert.deepEqual(asNames(statements(T.d).at(-1) || ''), CHECK_ROW, 'the check row has the columns of contract 5.4, in order');
  if (T.dRb) {
    const names = asNames(statements(T.dRb).at(-1) || '');
    for (const col of RB_CHECK_ROW) assert.ok(names.includes(col), `the rollback check row has ${col} (${names.join(', ')})`);
  }
});

test('the guard: every refusal of contract 5.5 and the 28 live bodies by normalised md5, before any change', () => {
  const body = noComments(T.d);
  for (const words of ['This is not the Ops database \\(tbetcegmszzotrwdtqhi\\)\\. Nothing was changed\\.', 'Run 20261021a_OPS_stock_native_0a\\.sql first\\. Nothing was changed\\.',
    'The drainer release has run already\\. Nothing was changed\\.', 'A stock function changed since this file was written\\. Ask Claude for a new file\\.']) {
    assert.match(body, new RegExp(words), words);
  }
  assert.match(body, /to_regprocedure\('cron\.schedule\(text,\s*text,\s*text\)'\)/i, 'pg_cron is asked for');
  for (const n of ['stock_sale_takes', 'stock_co_option_rules', 'stock_movements_day_sums_ins']) assert.ok(body.includes(n), `not run already: ${n}`);
  assert.match(body, /left\(\s*\w*\.?name,\s*11\)\s*=\s*'drainer_v2:'/, 'not run already: no drainer_v2: backup row (left(), never LIKE)');
  for (const m of [...MD5.replaced, ...MD5.checked]) assert.ok(T.d.includes(m), `the guard checks live md5 ${m}`);
  assert.match(T.d, /md5\(btrim\(regexp_replace\(p\.prosrc, '\\s\+', ' ', 'g'\)\)\)/, 'the normalised body md5 (contract 2.1)');
  const st = statements(T.d);
  const md5At = st.findIndex((s, i) => i > 0 && /^do\s+\$\$body\$\$$/i.test(s));
  const firstChange = st.findIndex((s) => /^(create|alter|drop|insert|update|delete|grant|revoke)\b/i.test(s) && !/^create\s+temp(orary)?\s+table/i.test(s));
  assert.ok(md5At > 0 && md5At < firstChange, `the md5 check is its own DO block right after the guard, before any change (${md5At} < ${firstChange})`);
});

test('the five parts in order, with the backup of the seven replaced bodies as drainer_v2:<name>', () => {
  const marks = [...T.d.matchAll(/^-- == drainer part ([1-5]): [^\n]* ==$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(marks, [1, 2, 3, 4, 5], 'one header line per part, 1 to 5, in order');
  const p1 = noComments(partOf(T.d, 1));
  assert.match(p1, /insert\s+into\s+public\.stock_native_backup\s*\(\s*name,\s*body,\s*md5\s*\)/i, 'the backup rows');
  assert.match(p1, /'drainer_v2:'\s*\|\|/, 'named drainer_v2:<name>');
  assert.match(p1, /pg_get_functiondef/i, 'the body is pg_get_functiondef');
  assert.match(p1, /left\(\s*\w*\.?name,\s*11\)\s*=\s*'drainer_v2:'[\s\S]{0,200}<>\s*7|<>\s*7[\s\S]{0,200}left\(\s*\w*\.?name,\s*11\)\s*=\s*'drainer_v2:'/i, 'and refuses unless exactly 7 are saved');
  for (const t of ['_drainer_v1_explode', '_drainer_v1_refund', '_drainer_v1_skipped', '_drainer_v1_base']) {
    assert.match(p1, new RegExp(`create\\s+temp\\s+table\\s+${t}\\b[\\s\\S]*?on\\s+commit\\s+drop`, 'i'), `${t}: the v1 snapshot, dropped at commit`);
  }
  const p2 = partOf(T.d, 2);
  assert.ok(p1.length && p2.length && T.d.indexOf('_drainer_v1_explode') < T.d.indexOf(p2), 'the v1 answers are taken before part 2 replaces anything');
});

test('exactly the functions of the contract are created or replaced, nothing else', () => {
  const sigs = createdSigs(T.d);
  const names = sigs.map((s) => s.name);
  const allowed = new Set([...REPLACED, ...NEW_FNS, ...OPTIONAL]);
  assert.deepEqual(names.filter((n) => !allowed.has(n)), [], 'nothing outside contract 2.2 to 2.5');
  assert.deepEqual([...REPLACED, ...NEW_FNS].filter((n) => !names.includes(n)), [], 'every function of the contract is there');
  assert.equal(new Set(names).size, names.length, 'each made once');
  for (const n of NEVER) assert.ok(!names.includes(n), `${n} is never replaced`);
  assert.deepEqual(names.filter((n) => /^msm_/.test(n)), [], 'no Multi site menu function');
  assert.doesNotMatch(noComments(T.d), /create\s+(or\s+replace\s+)?function\s+(?!public\.)/i, 'every function is made schema qualified in public');
  assert.equal(sigs.find((s) => s.name === 'stock_day_sums_drain')?.kind, 'procedure', 'the drain is a procedure (it commits)');
  const sig = (n) => sigs.find((s) => s.name === n)?.types;
  assert.equal(sig('stock_qty_to_base'), 'numeric,text,uuid');
  assert.equal(sig('stock_explode'), 'uuid,jsonb,text,text');
  assert.equal(sig('stock_explode_skipped'), 'uuid,jsonb,text');
  assert.equal(sig('_stock_outbox_apply'), 'bigint');
  assert.equal(sig('stock_explode_lines'), 'uuid,jsonb,text,text');
  assert.equal(sig('_stock_takes_share'), 'jsonb,jsonb');
  assert.equal(sig('stock_drainer_health'), 'uuid');
  assert.equal(sig('_sales_check_parts'), 'public.closed_checks');
  assert.equal(sig('stock_day_sums_drain'), 'integer,integer');
  // the drain is invoker (COMMIT is refused in a definer procedure); every other new function sets its search_path
  const drain = /create\s+or\s+replace\s+procedure\s+public\.stock_day_sums_drain[\s\S]*?\$([a-z_0-9]*)\$/i.exec(noComments(T.d));
  assert.ok(drain && !/security\s+definer/i.test(drain[0]), 'stock_day_sums_drain is not a definer procedure');
  for (const m of noComments(T.d).matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)[\s\S]*?\$([a-z_0-9]*)\$/gi)) {
    if (/security\s+definer/i.test(m[0])) assert.match(m[0], /set\s+search_path\s*(=|to)/i, `${m[1]}: a definer function sets its search_path`);
  }
});

test('part 5 revokes every function and the procedure by exact signature; only four are granted, to service_role', () => {
  const p5 = noComments(partOf(T.d, 5));
  for (const s of createdSigs(T.d)) {
    const re = new RegExp(`revoke\\s+all\\s+on\\s+${s.kind}\\s+public\\.${s.name}\\s*\\(([^)]*)\\)\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role\\s*;`, 'gi');
    const hits = [...p5.matchAll(re)].map((m) => m[1].replace(/\s+/g, '').toLowerCase());
    assert.ok(hits.includes(s.types.replace(/\s+/g, '')), `${s.name}(${s.types}): revoked from public, anon, authenticated, service_role by exact signature in part 5 (${hits.join(' | ') || 'none'})`);
  }
  const grants = [...noComments(T.d).matchAll(/grant\s+execute\s+on\s+(?:function|procedure)\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s+to\s+([^;]+);/gi)]
    .map((m) => `${m[1]}(${m[2].replace(/\s+/g, '')}) to ${norm(m[3])}`);
  assert.deepEqual(grants.sort(), SERVICE_ONLY.map((s) => `${s} to service_role`).sort(), 'exactly contract 2.6');
  for (const k of [1, 2, 3, 4]) {
    assert.doesNotMatch(noComments(partOf(T.d, k)), /(grant|revoke)\s+[a-z ,]*\s+on\s+(function|procedure)\b/i, `part ${k} has no function grant or revoke (part 5 owns them)`);
  }
  assert.doesNotMatch(noComments(T.d), /grant\s+[^;]*\bto\s+[^;]*\b(anon|public)\b/i, 'nothing is granted to anon or public');
  assert.match(noComments(T.d), /notify\s+pgrst,\s*'reload schema'/i);
});

test('the new tables: row level security, revoked from the API roles, read rules and the second step fence, no write policy', () => {
  const body = noComments(T.d);
  for (const t of NEW_TABLES) {
    assert.match(body, new RegExp(`create\\s+table\\s+public\\.${t}\\s*\\(`, 'i'), `${t} is made`);
    assert.match(body, new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, 'i'), `${t}: row level security on`);
    assert.match(body, new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${t}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`, 'i'), `${t}: revoked from every API role first`);
    assert.doesNotMatch(body, new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${t}\\s+(?:as\\s+permissive\\s+)?for\\s+(insert|update|delete|all)\\b`, 'i'), `${t}: no write policy`);
    assert.doesNotMatch(body, new RegExp(`grant\\s+[^;]*(insert|update|delete)[^;]*on\\s+table\\s+public\\.${t}\\b`, 'i'), `${t}: no write grant`);
  }
  assert.match(body, /grant\s+select\s+on\s+table\s+public\.stock_sale_takes\s+to\s+service_role\s*;/i, 'stock_sale_takes: the service role reads it, nobody else');
  assert.match(body, /stock_co_option_rules_read[\s\S]{0,300}stock_reach_orgs\(\)/i, 'the rules are read through stock_reach_orgs()');
  assert.match(body, /stock_co_option_rule_sites_read[\s\S]{0,300}stock_reach_locations\(\)/i, 'their site rows through stock_reach_locations()');
  assert.match(body, /second_step_fence[\s\S]{0,400}as\s+restrictive/i, 'the restrictive second step fence');
  assert.match(body, /alter\s+table\s+public\.discounts\s+add\s+column\s+(?:if\s+not\s+exists\s+)?kind\s+text\b/i, 'discounts.kind text');
  assert.match(body, /constraint\s+discounts_kind_known\s+check\s*\(\s*kind\s+is\s+null\s+or\s+kind\s+in\s*\(\s*'staff',\s*'comp',\s*'loyalty'\s*\)\s*\)/i, 'with its CHECK discounts_kind_known');
  assert.match(body, /stock_day_sums_pkey\s+primary\s+key\s*\(\s*location_id,\s*business_day,\s*inventory_item_id,\s*movement_type,\s*source_type,\s*demo\s*\)/i, 'the day totals key takes demo');
  assert.match(body, /constraint\s+stock_co_option_rules_shape\s+check/i, 'the option rule shape CHECK');
});

test('the nine triggers exactly as contract 1.3 (transition tables, no column list on the statement update triggers)', () => {
  const body = noComments(T.d);
  const made = [...body.matchAll(/create\s+trigger\s+([a-z0-9_]+)\s+([\s\S]*?)\s+execute\s+function\s+public\.([a-z0-9_]+)\s*\(\s*\)\s*;/gi)]
    .map((m) => ({ name: m[1].toLowerCase(), def: norm(m[2]), fn: m[3].toLowerCase() }));
  assert.equal(made.length, 9, `nine triggers (${made.map((m) => m.name).join(', ')})`);
  for (const [name, table, def, fn] of TRIGGERS) {
    const hit = made.find((m) => m.name === name && m.def.includes(`on public.${table}`));
    assert.ok(hit, `${name} on ${table}`);
    assert.equal(hit.def, def, `${name} on ${table}: ${hit.def}`);
    assert.equal(hit.fn, fn, `${name} runs ${fn}`);
  }
  for (const n of ['stock_movements_day_sums_upd', 'closed_checks_sales_day_upd']) {
    assert.doesNotMatch(made.find((m) => m.name === n).def, /after\s+update\s+of\b/, `${n}: no column list (transition tables refuse one)`);
  }
  const p4 = noComments(partOf(T.d, 4));
  const lastDdl = [...p4.matchAll(/\b(create\s+(?:or\s+replace\s+)?(?:function|procedure|trigger|table|index)|alter\s+table)\s+(?:public\.)?([a-z0-9_]+)/gi)].map((m) => m[2].toLowerCase());
  assert.deepEqual(lastDdl.slice(-2), ['closed_checks_sales_day_ins', 'closed_checks_sales_day_upd'], `the closed_checks triggers are the last DDL of part 4 (${lastDdl.slice(-3).join(', ')})`);
  assert.match(body, /cron\.unschedule[\s\S]{0,300}'stock-day-sums-drain'|'stock-day-sums-drain'[\s\S]{0,300}cron\.unschedule/i, 'the drain job is unscheduled by name first');
  assert.match(body, /cron\.schedule\(\s*'stock-day-sums-drain',\s*'\* \* \* \* \*',\s*'call public\.stock_day_sums_drain\(\);'\s*\)/i, 'then scheduled every minute');
});

test('the drainer never raises on a sale: the trigger bodies catch every error into a repair queue', () => {
  const body = noComments(T.d);
  const fn = (n) => (new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${n}\\s*\\([\\s\\S]*?\\$([a-z_0-9]*)\\$([\\s\\S]*?)\\$\\1\\$`, 'i').exec(body) || [])[2] || '';
  const apply = fn('_stock_day_sums_apply');
  assert.match(apply, /exception\s+when\s+others/i, '_stock_day_sums_apply catches everything');
  assert.match(apply, /stock_day_sums_repair/i, 'and queues the day for repair');
  assert.match(apply, /raise\s+warning/i, 'with a warning, never an exception');
  assert.match(apply, /pg_advisory_xact_lock_shared/i, 'writers take the venue lock shared');
  assert.match(apply, /'500ms'/, 'and wait at most 500 ms');
  const enq = fn('_sales_day_sums_enqueue');
  assert.match(enq, /exception\s+when\s+others/i, '_sales_day_sums_enqueue catches everything');
  assert.match(enq, /raise\s+warning/i);
  assert.match(enq, /'500ms'/, 'and waits at most 500 ms');
  for (const [n, b] of [['_stock_day_sums_apply', apply], ['_sales_day_sums_enqueue', enq]]) {
    const outside = b.replace(/begin[\s\S]*exception\s+when\s+others[\s\S]*$/i, '');
    assert.doesNotMatch(outside, /raise\s+exception/i, `${n}: no raise outside the catch`);
  }
  const apply2 = fn('_stock_outbox_apply');
  assert.match(apply2, /takes_not_saved/, 'a takes row that cannot be written never undoes the sale (flag takes_not_saved)');
  for (const f of ['to_order_fallback', 'refund_by_recipe', 'refund_line_unmatched']) assert.ok(T.d.includes(`'${f}'`), `the new flag ${f}`);
});

test('no stock day is ever a part total: the paste queues the whole ledger, a late figure queues its day (review 21 Oct)', () => {
  const body = noComments(T.d);
  const m = /create\s+or\s+replace\s+function\s+public\._stock_day_sums_apply\s*\([\s\S]*?\$([a-z_0-9]*)\$([\s\S]*?)\$\1\$/i.exec(body);
  const apply = m ? m[2] : '';
  // the late queue: after the upsert, in its own nested block, only before the venue's yesterday, only moved figures
  const upsertAt = apply.search(/insert\s+into\s+stock_day_sums\s+as\s+t/i);
  const lateAt = apply.search(/'late'/);
  assert.ok(upsertAt > 0 && lateAt > upsertAt, 'the late queue comes after the delta upsert');
  assert.match(apply, /stock_co__day_start_at\(\s*td\.business_day\s*-\s*1\b/i, 'the cut is the start of the venue\'s yesterday');
  assert.match(apply, /having\s+coalesce\(sum\(y\.q\),\s*0\)\s*<>\s*0\s+or\s+sum\(coalesce\(y\.v,\s*0\)\)\s*<>\s*0/i, 'only groups whose quantity or value moved');
  assert.match(apply.slice(lateAt), /^[\s\S]*?on\s+conflict\s*\(location_id,\s*business_day\)\s*do\s+nothing[\s\S]*?exception\s+when\s+others\s+then[\s\S]*?raise\s+warning\s+'stock day totals: a late venue day/i,
    'its own nested block: a problem there only warns, the delta stays');
  assert.match(apply.slice(upsertAt, lateAt), /'500ms'/, 'and it waits at most 500 ms');
  assert.match(apply.slice(upsertAt, lateAt), /if\s+exists\s*\(select\s+1\s+from\s+jsonb_array_elements\(v_rows\)\s+e\s+where\s+coalesce\(\(e\s*->>\s*'at'\)::timestamptz,\s*now\(\)\)\s*<\s*now\(\)\s*-\s*interval\s+'22 hours'\)\s+then/i,
    'a statement of rows newer than 22 hours (every sale made now) skips the clock lookups');
  // the paste: every venue day that holds a movement, found on the venue clock in force
  const q = top(T.d).split(';').map((s) => s.trim()).find((s) => /^insert\s+into\s+public\.stock_day_sums_repair\b/i.test(s)) || '';
  assert.ok(q, 'the paste queues stock days');
  assert.match(q, /stock_co__clock_of\(l\.id\)/i, 'on each venue\'s clock');
  assert.match(q, /values\s*\(-1\),\s*\(0\),\s*\(1\)/i, 'the wall clock day less the day start, one either side');
  assert.match(q, /public\.stock_co__day_start_at\(v\.business_day,[\s\S]*public\.stock_co__day_start_at\(v\.business_day\s*\+\s*1,[\s\S]*cross\s+join\s+lateral\s*\(select\s+1\s+from\s+public\.stock_movements\s+m\s+where\s+m\.location_id\s*=\s*h\.location_id\s+and\s+m\.occurred_at\s*>=\s*h\.lo\s+and\s+m\.occurred_at\s*<\s*h\.hi\s+limit\s+1\)/i,
    'kept only when a movement falls inside that day (one index probe per day, never a join of every day with every movement)');
  assert.doesNotMatch(q.slice(q.search(/union\s+select\s+h\.location_id/i)), /now\(\)\s*-\s*interval/i, 'with no date limit: the whole ledger');
});

test('no UPDATE or DELETE without a WHERE (pg-safeupdate, inside functions too); no LIKE in a drop or a rollback delete', () => {
  for (const k of OURS) {
    const body = noStrings(noComments(T[k]));
    for (const st of body.split(';')) {
      const m = /(?:^|[\s(])(update\s+(?!of\b)(?:only\s+)?[a-z_.]+\s+(?:as\s+)?(?:[a-z_]+\s+)?set\b|delete\s+from\b)/i.exec(st);
      if (!m) continue;
      const rest = st.slice(m.index);
      if (/do\s+update\s+set/i.test(rest) && !/^\s*\(?\s*update\s+/i.test(rest.trim())) continue;
      assert.match(rest, /\bwhere\b/i, `${FILES[k]}: ${rest.trim().slice(0, 140)}`);
    }
    for (const st of top(T[k]).split(';')) {
      if (/^\s*drop\b/i.test(st)) assert.doesNotMatch(st, /\blike\b/i, `${FILES[k]}: a drop by LIKE: ${st.trim().slice(0, 100)}`);
    }
  }
  const rb = noComments(T.dRb);
  for (const st of rb.split(';')) if (/delete\s+from/i.test(st)) assert.doesNotMatch(st, /\blike\b/i, `rollback delete by LIKE: ${st.trim().slice(0, 100)}`);
});

test('the rollback: guard, drops by exact name, replays the seven bodies, keeps discounts.kind', () => {
  assert.ok(T.dRb, `${FILES.dRb} is missing`);
  const rb = noComments(T.dRb);
  assert.match(rb, /The function bodies this release saved are missing\. Nothing was changed\. Ask Claude\./, 'the guard refuses when the backup is not whole');
  assert.match(rb, /cron\.unschedule[\s\S]{0,200}'stock-day-sums-drain'|'stock-day-sums-drain'[\s\S]{0,200}cron\.unschedule/i, 'unschedules the drain job by name');
  for (const [name, table] of TRIGGERS) {
    assert.match(rb, new RegExp(`drop\\s+trigger\\s+(?:if\\s+exists\\s+)?${name}\\s+on\\s+public\\.${table}\\b`, 'i'), `drops trigger ${name} on ${table}`);
  }
  for (const s of createdSigs(T.d).filter((x) => !REPLACED.includes(x.name))) {
    const re = new RegExp(`drop\\s+${s.kind}\\s+(?:if\\s+exists\\s+)?public\\.${s.name}\\s*\\(([^)]*)\\)`, 'gi');
    const hits = [...rb.matchAll(re)].map((m) => m[1].replace(/\s+/g, '').toLowerCase());
    assert.ok(hits.includes(s.types.replace(/\s+/g, '')), `drops ${s.kind} ${s.name}(${s.types}) by exact signature (${hits.join(' | ') || 'none'})`);
  }
  for (const n of REPLACED) assert.doesNotMatch(rb, new RegExp(`drop\\s+function\\s+(?:if\\s+exists\\s+)?public\\.${n}\\s*\\(`, 'i'), `${n} is restored, never dropped`);
  for (const t of NEW_TABLES) assert.match(rb, new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${t}\\b`, 'i'), `drops table ${t}`);
  assert.match(rb, /stock_native_backup/, 'replays the bodies the release saved');
  assert.match(rb, /left\(\s*\w*\.?name,\s*11\)\s*=\s*'drainer_v2:'/, 'chooses them with left(name, 11) = \'drainer_v2:\'');
  assert.match(rb, /delete\s+from\s+(?:public\.)?stock_native_backup\b[^;]*where[^;]*left\(\s*\w*\.?name,\s*11\)\s*=\s*'drainer_v2:'/i, 'and deletes only its own backup rows');
  assert.match(rb, /md5\(btrim\(regexp_replace\(/i, 'checks each restored body against the saved md5');
  assert.match(rb, /delete\s+from\s+(?:public\.)?stock_day_sums\s+where\s+true/i, 'empties the derived day totals before the key changes back');
  assert.match(rb, /stock_day_sums_pkey\s+primary\s+key\s*\(\s*location_id,\s*business_day,\s*inventory_item_id,\s*movement_type,\s*source_type\s*\)/i, 'puts the old key back');
  assert.match(rb, /drop\s+column\s+(?:if\s+exists\s+)?demo\b/i, 'drops stock_day_sums.demo');
  for (const ix of ['stock_day_sums_repair_due', 'sales_day_sums_queue_due']) assert.match(rb, new RegExp(`drop\\s+index\\s+(?:if\\s+exists\\s+)?public\\.${ix}\\b`, 'i'), `drops index ${ix}`);
  assert.doesNotMatch(rb, /alter\s+table\s+(?:if\s+exists\s+)?public\.discounts\s+drop\s+(column|constraint)/i, 'keeps discounts.kind and its CHECK (Peter\'s settings)');
  assert.match(T.dRb, /discounts\.kind/i, 'and says so');
  assert.match(rb, /notify\s+pgrst,\s*'reload schema'/i);
  assert.match(top(T.dRb), /set\s+local\s+lock_timeout\s*=\s*'3s'/i);
});

test('the 0a rollback refuses while the drainer release is in (one DO block right after its first guard)', () => {
  const st = statements(T.aRb);
  const blocks = [...noComments(T.aRb).matchAll(/do\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\1\$/gi)].map((m) => m[2]);
  assert.match(st[1] || '', /^do\s+\$\$body\$\$$/i, 'its second statement is a DO block');
  const b = blocks[1] || '';
  assert.match(b, /The drainer release \(20261023a\) is still in\. Run 20261023a_OPS_stock_drainer_v2_ROLLBACK\.sql first\. Nothing was changed\./, 'with the refusal words of contract 5.6');
  assert.match(b, /to_regclass\('public\.stock_sale_takes'\)\s+is\s+not\s+null/i, 'when stock_sale_takes is there');
  assert.match(b, /left\(\s*\w*\.?name,\s*11\)\s*=\s*'drainer_v2:'/, 'or a drainer_v2: backup row (left(), never LIKE)');
  assert.doesNotMatch(b, /\blike\b/i);
});
