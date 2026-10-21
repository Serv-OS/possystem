// node --test: the Drop 1 multi site stock files (20261024a and its rollback) read as text, so CI checks the
// house rules on every PR. What they DO is proved on a real Postgres 17 shaped like Ops by
// supabase/tests/stock_native/run.mjs, sections 19 to 25 (Peter's files are never run against Supabase
// by Claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const path = (p) => new URL(`../../../${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const MIGS = 'supabase/migrations/';
const FILES = {
  d1: `${MIGS}20261024a_OPS_stock_native_1.sql`,
  d1Rb: `${MIGS}20261024a_OPS_stock_native_1_ROLLBACK.sql`,
};
const missing = Object.values(FILES).filter((f) => !existsSync(path(f)));
const T = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, existsSync(path(f)) ? read(f) : '']));

// Comments out, then dollar quoted bodies out: what is left is what the SQL editor runs at the top level.
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const top = (t) => noComments(t).replace(/\$([a-z_0-9]*)\$[\s\S]*?\$\1\$/gi, () => ' $$body$$ ');
const statements = (t) => top(t).split(';').map((s) => s.trim()).filter(Boolean);
const created = (t, kind = 'function|procedure') => [...noComments(t).matchAll(new RegExp(`create\\s+or\\s+replace\\s+(?:${kind})\\s+public\\.([a-z0-9_]+)\\s*\\(`, 'gi'))].map((m) => m[1].toLowerCase());
const tablesMade = (t) => [...noComments(t).matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase());
// every function body of a file: [name, args text, body]
const bodies = (t) => [...noComments(t).matchAll(/create\s+or\s+replace\s+(?:function|procedure)\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*(?:returns[\s\S]*?)?\bas\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\3\$/gi)]
  .map((m) => [m[1].toLowerCase(), m[2], m[4]]);
// the old card processor's name, spelt out letter by letter so this file never carries the word
const OLD_PROCESSOR = new RegExp(['s', 't', 'r', 'i', 'p', 'e'].join(''), 'i');

// contract section 1.1: the 24 rebuilt bodies and the 11 checked ones, with their live md5
const REPLACED = {
  stock_co__allowed: '1a61b7cf3384939cf5c602e547dd906e', stock_co__clean: '0d6b3b3acb2648f2c554641327e7b897',
  stock_co__guard: 'c224e1e46da49d27130c67751be35763', stock_save_item: 'b97ba7787ce200ca960386fa9ea08a21',
  stock_archive_item: '45f6b86f9cfe07fa956cd48673edb8a0', stock_save_item_site: '15a6251d811a4dc7b6d6ca6044003841',
  stock_save_pack: '39a2b6167347e083b98ef9893f37230e', stock_archive_pack: '76e8ad8a870d692fd1de7864830a095a',
  stock_set_pack_default: '247dfba7b4a240c89f9709f3c57006af', stock_save_bridge: 'e4d3e7233e00797b4d1e2b7871e75f88',
  stock_archive_bridge: 'd447b7f0985b5ba7ce13ab5aa92f6862', stock_save_supplier: '807f4a60bb08ff6f989eab8a2c344f50',
  stock_archive_supplier: 'b73aaff7b2dcc8d96774757ec6b8a227', stock_save_supplier_site: '30aeea13c057aac577f8917d2a3cd8df',
  stock_save_supplier_item: '9489d7b6c52c7c01c330f0d5a124b9b2', stock_save_supplier_item_site: '6208c21ed8d450631238c8cfafedf9ea',
  stock_archive_supplier_item: 'de5581c5e3fd99a1c155f836531bc3f0', stock_save_recipe: '49574e0d8e9768cfb643296dabd71804',
  stock_archive_recipe: 'f9e6e10b9363442894fdb897ebce5a41', stock_link_menu_item: 'c346686e8608256779bbf21e9dc9cdf4',
  stock_co__run_job: '79b49ec0f5087d6ff36460f2147d0c2f', stock_save_queue_run: 'c51af18907f35ff136334ff7461f9ae5',
  stock_nightly_upkeep: '6f74ec2cf9499fb6412090b143149e8d', stock_item_detail: '237948f39a88613c62e381d1d843e28a',
};
const CHECKED = ['e0b54f5aaea4f330e2300248b721141d', '68980e8bc9d49446950d5389d924d6e8', '77d43d74e1791813cffdf82254f650ad', '329060038c9d43bad9c2aa9302b4f271',
  '913b98491c7234340131c604108e789b', 'a7518aaa97ce5809aafa0854d9056c4d', 'bee1118bc131abf7c9c83b88a3c85897', '7eeb435c8c677730049190e85456fd4a',
  '8c9513db8ec56ddb68a1a3f247360742', 'eae7ebd02ee5c5681f3a248942fb28e4', '000c0e067df8ab8197dee16872fa79b4'];
// contract section 1.6: the public functions and who may run them
const NEW_PUBLIC = {
  stock_items_page: ['authenticated'], stock_item_used_in: ['authenticated'], stock_suppliers_page: ['authenticated'],
  stock_supplier_detail: ['authenticated'], stock_prices_page: ['authenticated'], stock_needs_attention: ['authenticated'],
  stock_paused_items: ['authenticated', 'service_role'], stock_golive_plan: ['authenticated'], stock_import_check: ['authenticated'],
  stock_set_item_sites: ['authenticated'], stock_pause_items: ['authenticated'], stock_change_prices: ['authenticated'],
  stock_cancel_dated_price: ['authenticated'], stock_import_stage: ['authenticated'], stock_import_commit: ['authenticated'],
  stock_import_cancel: ['authenticated'], stock_copy_site: ['authenticated'], stock_save_order_rules: ['authenticated'],
  stock_copy_order_rules: ['authenticated'], stock_save_category: ['authenticated'], stock_archive_category: ['authenticated'],
  stock_save_settings: ['authenticated'], stock_make_company_record: ['authenticated'], stock_save_golive_step: ['authenticated'],
  stock_save_site_group: ['authenticated'], stock_delete_site_group: ['authenticated'], stock_suggest_change: ['authenticated'],
  stock_resync_site: ['authenticated'], stock_nightly_health: ['service_role'],
};
const NEW_TABLES = ['stock_order_rules', 'stock_co_dated_prices', 'stock_co_import_jobs', 'stock_co_import_rows', 'stock_co_categories',
  'stock_co_golive_steps', 'stock_co_site_health'];
const FIXED_HELPERS = ['stock_co__need_of', 'stock_co__need_version', 'stock_co__paused_now', 'stock_co__derive_days', 'stock_co__seed_order_rules',
  'stock_co__si_unit_cost', 'stock_co__set_sites_at', 'stock_co__pause_at', 'stock_co__apply_dated_prices', 'stock_co__price_plan',
  'stock_co__import_check_row', 'stock_co__import_apply', 'stock_co__copy_site_step', 'stock_co__category_rename_step', 'stock_co__d1_org_guard'];

test('both Drop 1 files are in supabase/migrations', () => {
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

test('ASCII only, never an em or en dash, never the old card processor\'s name', () => {
  for (const [k, t] of Object.entries(T)) {
    const bad = [...t].findIndex((ch) => ch.charCodeAt(0) > 127);
    assert.equal(bad, -1, `${FILES[k]}: a non ASCII character at ${bad}: ${JSON.stringify(t.slice(Math.max(0, bad - 30), bad + 10))}`);
    assert.doesNotMatch(t, /[\u2013\u2014]/, FILES[k]);
    assert.doesNotMatch(t, OLD_PROCESSOR, `${FILES[k]} names the old card processor`);
  }
});

test('bare statements: no begin, commit or rollback of their own (one paste is one transaction)', () => {
  for (const [k, t] of Object.entries(T)) {
    for (const s of statements(t)) assert.doesNotMatch(s, /^(begin|commit|rollback|start\s+transaction)\b/i, `${FILES[k]}: ${s.slice(0, 60)}`);
  }
});

test('guard first, a 3 s lock wait, a visible check row last', () => {
  for (const [k, t] of Object.entries(T)) {
    const st = statements(t);
    assert.match(st[0] || '', /^do\s+\$\$body\$\$$/i, `${FILES[k]}: the first statement is the guard DO block (${(st[0] || '').slice(0, 60)})`);
    const guard = /do\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\1\$/i.exec(noComments(t));
    assert.ok(guard && /raise\s+exception/i.test(guard[2]) && /billing_state/.test(guard[2]), `${FILES[k]}: the guard raises in plain words, Ops only`);
    assert.match(top(t), /set\s+local\s+lock_timeout\s*=\s*'3s'\s*;\s*set\s+local\s+statement_timeout\s*=\s*'300s'/i, `${FILES[k]}: 3 s lock wait, 300 s limit`);
    assert.match(st[st.length - 1] || '', /^(with\b[\s\S]*\bselect\b|select\b)/i, `${FILES[k]}: the last statement is the visible check row`);
  }
  const guard = /do\s+\$guard\$([\s\S]*?)\$guard\$/i.exec(noComments(T.d1))?.[1] || '';
  assert.match(guard, /'Run 20261022a_OPS_stock_native_0b\.sql first\. Nothing was changed\.'/, 'refuses without 0b');
  assert.match(guard, /stock_co_lock_upd/, '0b is known by its trigger');
  assert.match(guard, /'Drop 1 has run already\. Nothing was changed\.'/, 'refuses a second run');
  for (const col of ['org_id', 'multi', 'categories_seeded', 'items_with_category', 'items_without_category', 'order_rules_seeded', 'order_rules_without_order_by',
    'suppliers_without_cutoff', 'bad_delivery_day_values', 'order_rules_round_trip_bad', 'replaced_functions', 'new_functions', 'internals_open_to_api',
    'anon_can_save', 'levels_on', 'site_rows_changed', 'logins_changed']) {
    assert.match(statements(T.d1).at(-1) || '', new RegExp(`(\\bas\\s+${col}\\b|\\bo\\.${col}\\b)`), `Drop 1 check row column ${col}`);
  }
  for (const col of ['bodies_restored', 'dated_prices_dropped', 'import_jobs_dropped', 'queue_rows_failed', 'site_rows_changed']) {
    assert.match(statements(T.d1Rb).at(-1) || '', new RegExp(`\\bas\\s+${col}\\b`), `rollback check row column ${col}`);
  }
});

test('the 35 live bodies are checked by md5, the 24 rebuilt ones backed up as d1: before the first replace', () => {
  for (const [n, md5] of Object.entries(REPLACED)) {
    assert.ok(T.d1.includes(md5), `checks ${n} (${md5})`);
    assert.ok(T.d1Rb.includes(md5), `the rollback check row proves ${n} is back (${md5})`);
  }
  for (const md5 of CHECKED) assert.ok(T.d1.includes(md5), `checks ${md5}`);
  assert.match(T.d1, /A stock function changed since this file was written\. Ask Claude for a new file\./);
  assert.match(T.d1, /md5\(btrim\(regexp_replace\(p\.prosrc, '\\s\+', ' ', 'g'\)\)\)/, 'the normalised body md5');
  const backup = noComments(T.d1).search(/insert\s+into\s+public\.stock_native_backup/i);
  const firstReplace = noComments(T.d1).search(/create\s+or\s+replace\s+(?:function|procedure)\s+public\.(stock_co__allowed|stock_co__clean|stock_co__guard|stock_save_item)\s*\(/i);
  assert.ok(backup > 0 && backup < firstReplace, 'the backup of the 24 comes before the first rebuilt body');
  assert.match(T.d1, /'d1:'\s*\|\|\s*p\.proname/, 'named d1:<name>');
  assert.match(noComments(T.d1), /for\s+no\s+key\s+update/i, 'the item row locks before the snapshot');
});

test('only the 24 named bodies are rebuilt among the functions earlier files made; menu machinery untouched', () => {
  const older = new Set();
  for (const f of readdirSync(path(MIGS)).filter((x) => x.endsWith('.sql') && !x.includes('ROLLBACK') && x < '20261024a')) {
    for (const n of created(read(`${MIGS}${f}`))) older.add(n);
  }
  const mine = [...new Set(created(T.d1))];
  assert.deepEqual(mine.filter((n) => older.has(n)).sort(), Object.keys(REPLACED).sort(), 'exactly the 24 of contract 1.1');
  for (const n of Object.keys(NEW_PUBLIC)) assert.ok(mine.includes(n), `${n} is made`);
  for (const n of FIXED_HELPERS) assert.ok(mine.includes(n), `the fixed helper ${n} is made`);
  assert.deepEqual(mine.filter((n) => /^msm_/.test(n)), [], 'no Multi site menu function is created or replaced');
  assert.doesNotMatch(noComments(T.d1), /alter\s+table\s+(?:if\s+exists\s+)?public\.msm_/i, 'no menu table is altered');
  assert.doesNotMatch(noComments(T.d1), /create\s+(?:or\s+replace\s+)?trigger\s+\w+[\s\S]{0,120}?\son\s+public\.msm_/i, 'no trigger on a menu table');
  for (const f of ['_post_stock_movement', 'post_stock_movement', 'stock_explode', 'stock_outbox_drain', 'stock_record_waste', 'stock_receive', 'stock_post_invoice',
    'user_accessible_locations', 'accessible_location_uuids', 'stock_reach_locations', 'stock_level', 'set_stock_control', 'stock_co__sync_site', 'stock_co__sync_recipes']) {
    assert.ok(!mine.includes(f), `${f} is not replaced`);
  }
});

test('no login is written: no user_profiles or user_locations change anywhere', () => {
  const body = noComments(T.d1);
  assert.doesNotMatch(body, /(update|insert\s+into|delete\s+from)\s+(public\.)?user_(profiles|locations)\b/i);
  assert.doesNotMatch(body, /set_stock_control\s*\(/i, 'no Stock control level is set');
  assert.match(body, /md5:user_profiles/);
  assert.match(body, /md5:user_locations/);
});

test('every new table: row level security, revoked from every API role, its second step fence, no write policy', () => {
  const body = noComments(T.d1);
  const blocks = [...body.matchAll(/do\s+\$([a-z_0-9]*)\$([\s\S]*?)\$\1\$/gi)].map((m) => m[2]);
  assert.deepEqual(tablesMade(T.d1).sort(), [...NEW_TABLES].sort(), 'the seven tables of contract 1.2');
  for (const t of NEW_TABLES) {
    assert.match(body, new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, 'i'), `${t}: row level security on`);
    assert.match(body, new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${t}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`, 'i'), `${t}: revoked first`);
    assert.ok(blocks.some((b) => /second_step_fence/.test(b) && /as restrictive/.test(b) && b.includes(`'${t}'`)), `${t}: its own restrictive second step fence`);
    assert.doesNotMatch(body, new RegExp(`create\\s+policy\\s+\\w+\\s+on\\s+public\\.${t}\\s+(?:as\\s+permissive\\s+)?for\\s+(insert|update|delete|all)\\b`, 'i'), `${t}: no write policy`);
    assert.doesNotMatch(body, new RegExp(`grant\\s+[a-z, ]*\\b(insert|update|delete)\\b[a-z, ]*\\s+on\\s+table\\s+public\\.${t}\\b`, 'i'), `${t}: select only`);
    assert.doesNotMatch(body, new RegExp(`grant\\s+[a-z, ]+\\s+on\\s+table\\s+public\\.${t}\\s+to\\s+[^;]*\\banon\\b`, 'i'), `${t}: nothing for the anon key`);
  }
  for (const t of ['stock_co_import_jobs', 'stock_co_import_rows']) {
    assert.match(body, new RegExp(`grant\\s+select\\s+on\\s+table\\s+public\\.${t}\\s+to\\s+service_role;`, 'i'), `${t}: read through stock_import_check only`);
  }
});

test('every new function revoked from public and anon by name, then exactly the grants of contract 1.10', () => {
  const body = noComments(T.d1);
  const mine = [...new Set(created(T.d1))].filter((n) => !(n in REPLACED));
  for (const n of mine) {
    assert.match(body, new RegExp(`revoke\\s+all\\s+on\\s+(?:function|procedure)\\s+public\\.${n}\\s*\\([^)]*\\)\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`, 'i'), `${n} revoked by name`);
  }
  assert.match(body, /'\^stock_co__'/, 'the stock_co__ catalog loop (a revoke, never a drop)');
  const grants = [...body.matchAll(/grant\s+execute\s+on\s+function\s+public\.([a-z0-9_]+)\s*\([^)]*\)\s+to\s+([^;]+);/gi)].map((m) => [m[1], m[2].split(',').map((x) => x.trim()).sort()]);
  for (const [n, roles] of Object.entries(NEW_PUBLIC)) {
    const g = grants.filter(([x]) => x === n);
    assert.equal(g.length, 1, `${n}: one grant`);
    assert.deepEqual(g[0][1], roles, `${n}: EXECUTE to ${roles.join(' and ')}`);
  }
  assert.deepEqual(grants.filter(([, r]) => r.includes('anon')).map(([n]) => n), [], 'nothing new for the anon key');
  assert.deepEqual(grants.filter(([n]) => /^stock_co__/.test(n)).map(([n]) => n).sort(),
    ['stock_co__ledger_lock', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__writer_ok'], 'internals: only what 0a and 0b gave back');
  assert.match(body, /has_function_privilege\('anon'/, 'the file asserts the anon key saves nothing');
  assert.match(body, /notify\s+pgrst,\s*'reload schema'/i);
  for (const n of Object.keys(NEW_PUBLIC)) {
    const def = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${n}\\s*\\([\\s\\S]*?\\$fn\\$`, 'i').exec(body)?.[0] || '';
    assert.match(def, /security\s+definer/i, `${n}: SECURITY DEFINER`);
    assert.match(def, /set\s+search_path\s*=\s*public,\s*pg_temp/i, `${n}: search_path public, pg_temp`);
  }
});

test('pages: keyset only (never OFFSET), every p_limit capped, never more than 1,000 rows a read', () => {
  const body = noComments(T.d1);
  assert.doesNotMatch(body, /\boffset\s+\w/i, 'no OFFSET anywhere');
  // a page function takes p_after (the previous answer's next) and p_limit
  const withLimit = bodies(T.d1).filter(([, args]) => /\bp_limit\b/.test(args) && /\bp_after\b/.test(args));
  assert.ok(withLimit.length >= 5, `the page functions (${withLimit.map(([n]) => n).join(', ')})`);
  for (const [n, , b] of withLimit) {
    if (n === 'stock_co__price_plan') continue; // internal: its callers pass 200 or 300, or null for a count
    const cap = /least\(greatest\(coalesce\(p_limit,\s*(\d+)\),\s*1\),\s*(\d+)\)/i.exec(b);
    assert.ok(cap && Number(cap[2]) <= 200 && cap[1] === cap[2], `${n}: p_limit capped (${cap ? cap[0] : 'no cap'})`);
    assert.match(b, /\bp_after\b/, `${n}: keyset on p_after`);
  }
  for (const n of ['stock_items_page', 'stock_suppliers_page', 'stock_prices_page', 'stock_item_used_in']) {
    const b = bodies(T.d1).find(([x]) => x === n)?.[2] || '';
    assert.match(b, /least\(greatest\(coalesce\(p_limit,\s*100\),\s*1\),\s*100\)/i, `${n}: pages of 100`);
  }
  const paused = bodies(T.d1).find(([x]) => x === 'stock_paused_items')?.[2] || '';
  assert.match(paused, /limit\s+1001/i, 'stock_paused_items reads at most 1,000 rows (plus one to say there are more)');
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

test('the words the web detects are exactly the contract\'s (section 1.9)', () => {
  for (const w of ['Not allowed: this is set by head office.', 'Not allowed: prices and the supplier here are set by head office.',
    'This screen is out of date. Reload it, then save again.', 'Tick sites on the Sites tab.', 'Pick a category from the list.',
    'Delivery days are set on the Order rules tab.', 'Choose Stop ordering, run out, or write it off first.', 'This is a local item. Archive it instead.',
    'There is already a category called %.', 'Move the % items in % to another category first.', 'There is already a group called %.',
    'Pick 50 sites or fewer.', "% cannot deliver to % yet. Tick % on the supplier''s Sites tab first.", 'Each day can have one delivery only.',
    'Write what should change, up to 500 letters.', 'That is 30 suggestions today. Try again tomorrow.', 'Recipes come in with the recipe update.',
    'The field "%" must be a date such as 2026-11-03.', 'The field "%" must be a time such as 14:00.', 'The field "%" must be a percent from 0 to 100.']) {
    assert.ok(T.d1.includes(w), `"${w}"`);
  }
});

// stock_co__allowed of one file: { target: { key: type } }
const allowedOf = (t) => {
  const b = bodies(t).find(([n]) => n === 'stock_co__allowed')?.[2] || '';
  return Object.fromEntries([...b.matchAll(/when\s+'([a-z_]+)'\s+then\s+'(\{[^']*\})'::jsonb/g)].map((m) => [m[1], JSON.parse(m[2])]));
};

test('Drop 1 only ADDS keys to stock_co__allowed: every key 0a allows is still allowed, with the same type', () => {
  const a0 = allowedOf(read(`${MIGS}20261021a_OPS_stock_native_0a.sql`));
  const a1 = allowedOf(T.d1);
  assert.ok(Object.keys(a0).length >= 13, `0a targets read: ${Object.keys(a0).join(', ')}`);
  for (const [target, keys] of Object.entries(a0)) {
    for (const [k, type] of Object.entries(keys)) assert.equal(a1[target]?.[k], type, `${target}.${k} (0a ${type}) is gone or changed in Drop 1`);
  }
  assert.equal(a1.supplier_item.purchase_tax_rate_id, 'uuid', "the one site Suppliers tab's VAT rate row");
});

test("every key today's one site screens send (saveRules builders) is a key Drop 1 allows", async () => {
  const sr = await import('./saveRules.js');
  const a1 = allowedOf(T.d1);
  const check = (target, obj, where) => {
    assert.ok(a1[target], `${where}: Drop 1 knows the target ${target}`);
    for (const [k, v] of Object.entries(obj || {})) {
      assert.ok(k in a1[target], `${where}: the key ${k} of ${target} is refused by Drop 1 ('cannot be changed here')`);
      if (String(a1[target][k]).startsWith('object:') && v && typeof v === 'object') check(String(a1[target][k]).slice(7), v, `${where}.${k}`);
    }
  };
  const ID = 'a1000000-0000-4000-8000-000000000001';
  for (const tax of [null, ID]) {
    for (const id of [null, ID]) {
      check('supplier_item', sr.supplierItemSaveArgs({ id, inventoryItemId: ID, supplierId: ID, packPrice: 9.6, purchaseTaxRateId: tax, isPreferred: true, rowVersion: 2 }, ID).p_si, `supplierItemSaveArgs(id ${!!id}, VAT row ${!!tax})`);
      check('item', sr.itemSaveArgs({ id, name: 'Milk', purchaseTaxRateId: tax, kind: 'MADE', rowVersion: 2 }, ID).p_item, `itemSaveArgs(id ${!!id})`);
    }
  }
  check('supplier', sr.supplierSaveArgs({ id: ID, name: 'Dairy', deliveryDays: ['mon'], cutoffTime: '14:00', rowVersion: 1 }, ID).p_supplier, 'supplierSaveArgs');
  check('pack', sr.packSaveArgs({ id: ID, inventoryItemId: ID, name: 'Case', qtyInBase: 6, parentFormatId: ID, rowVersion: 1 }, ID).p_pack, 'packSaveArgs');
  check('bridge', sr.bridgeSaveArgs({ id: ID, inventoryItemId: ID, fromQty: 1, fromUnit: 'each', toQty: 50, toUnit: 'g', rowVersion: 1 }, ID).p_bridge, 'bridgeSaveArgs');
  const rec = sr.recipeSaveArgs({ id: ID, name: 'Latte', recipeType: 'MENU', menuItemId: 'm-latte', lines: [{ componentItemId: ID, qty: 1, unit: 'ml' }] }, ID);
  check('recipe', rec.p_recipe, 'recipeSaveArgs');
  for (const l of rec.p_lines) check('recipe_line', l, 'recipeSaveArgs line');
  check('item_site_patch', sr.parPatch({ parLevel: 1, reorderPoint: 2, minLevel: 0 }), 'parPatch');
  check('item_site_patch', sr.areaPatch(ID, { byName: 'Sam' }), 'areaPatch');
});

test('the levels: the guard step 4 and its dry run as a real manager login', () => {
  const guard = bodies(T.d1).find(([n]) => n === 'stock_co__guard')?.[2] || '';
  assert.match(guard, /v_multi\s+and\s+p_need\s*=\s*'company'\s+and\s+v_level\s+is\s+distinct\s+from\s+'all'/i, 'company needs Stock control all in a multi site company');
  assert.match(guard, /v_multi\s+and\s+p_need\s*=\s*'site_price'\s+and\s+coalesce\(v_level,\s*'sites'\)\s+not\s+in\s+\('sites_full',\s*'all'\)/i, 'site price needs sites_full or all');
  assert.match(noComments(T.d1), /set_config\(\s*'request\.jwt\.claims'/i, 'the dry run sets real request claims');
  assert.match(noComments(T.d1), /'refused, par ok'/);
  assert.match(noComments(T.d1), /The levels did NOT refuse a company change/, 'the file raises when the levels do not refuse');
});

test('the rollback: explicit names only, the 24 d1: bodies named, every Drop 1 function, trigger, column and table dropped', () => {
  const rb = noComments(T.d1Rb);
  assert.doesNotMatch(rb, /like\s+'[%_]*stock_co/i, 'a LIKE would also match stock_count*, stock_cost_rule, stock_convert_qty');
  assert.doesNotMatch(rb, /\blike\b/i, 'no LIKE at all');
  for (const n of Object.keys(REPLACED)) assert.ok(rb.split(`'d1:${n}'`).length - 1 >= 2, `the rollback names d1:${n} (guard and replay)`);
  for (const n of [...new Set(created(T.d1))].filter((x) => !(x in REPLACED))) {
    assert.match(rb, new RegExp(`drop\\s+function\\s+if\\s+exists\\s+public\\.${n}\\s*\\(`, 'i'), `drops ${n} by name`);
  }
  for (const t of NEW_TABLES) assert.match(rb, new RegExp(`drop\\s+table\\s+if\\s+exists\\s+public\\.${t};`, 'i'), `drops ${t} by name`);
  for (const [t, c] of [['stock_co_items', 'category_id'], ['stock_co_item_sites', 'paused_from'], ['stock_co_item_sites', 'paused_until'], ['stock_co_site_groups', 'row_version']]) {
    assert.match(rb, new RegExp(`alter\\s+table\\s+public\\.${t}\\s+drop\\s+column\\s+if\\s+exists\\s+${c};`, 'i'), `drops ${t}.${c}`);
  }
  assert.match(rb, /drop\s+trigger\s+if\s+exists\s+stock_co_items_category_guard\s+on\s+public\.stock_co_items/i);
  assert.equal((rb.match(/drop\s+trigger\s+if\s+exists\s+stock_co_d1_org_guard\s+on\s+public\./gi) || []).length, 6, 'the company guard trigger off its six tables');
  assert.match(rb, /'Drop 1 was rolled back\.'/, 'waiting Drop 1 jobs fail in words');
  assert.match(rb, /delete\s+from\s+public\.stock_native_backup\s+b\s+where\s+b\.name\s+in\s*\(/i, 'the d1: rows deleted by name');
  assert.doesNotMatch(rb, /(update|insert\s+into|delete\s+from)\s+(public\.)?user_(profiles|locations)\b/i, 'no login written');
});
