// node --test: the text of 20261208a_OPS_stock_import_unit_bridges.sql and its rollback (5.12.99).
// The behaviour is proved on a local PostgreSQL by supabase/tests/stock_native/unit_bridges_proof.sh
// (36 checks); this pins what CI can see without a database: the two files exist, are plain ASCII,
// guard themselves, and carry the same three functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const UP = read('20261208a_OPS_stock_import_unit_bridges.sql');
const DOWN = read('20261208a_OPS_stock_import_unit_bridges_ROLLBACK.sql');
const FNS = ['stock_import_stage', 'stock_co__import_check_row', 'stock_co__import_apply'];

test('both files are plain ASCII, one transaction, Ops only', () => {
  for (const [name, sql] of [['migration', UP], ['rollback', DOWN]]) {
    const odd = [...sql].find((ch) => { const c = ch.charCodeAt(0); return c !== 9 && c !== 10 && (c < 32 || c > 126); });
    assert.equal(odd, undefined, `${name}: ASCII only (the SQL editor garbles anything else)`);
    assert.match(sql, /^begin;$/m, `${name} opens a transaction`);
    assert.match(sql, /^commit;$/m, `${name} commits`);
    assert.match(sql, /This is the OPS migration\. Run it on the Ops database only\. Nothing was changed\./, `${name} refuses on Platform`);
    assert.match(sql, /notify pgrst, 'reload schema';/, `${name} reloads the API schema`);
    for (const fn of FNS) assert.equal(sql.split(`CREATE OR REPLACE FUNCTION public.${fn}(`).length - 1, 1, `${name} carries ${fn} once`);
  }
});

test('the migration refuses a body it was not built from, and checks what it installed', () => {
  assert.match(UP, /is not the body this file was built from\. Nothing was changed\./);
  assert.match(UP, /did not install/);
  const rows = [...UP.matchAll(/\('(stock_[a-z_]+)', '([0-9a-f]{32})', '([0-9a-f]{32})'\)/g)];
  assert.deepEqual([...new Set(rows.map((r) => r[1]))].sort(), [...FNS].sort(), 'an md5 before and after for each of the three');
  for (const r of rows) assert.notEqual(r[2], r[3], `${r[1]}: the body changes`);
  // the rollback goes back to exactly the "before" bodies the migration names
  for (const r of rows) assert.ok(DOWN.includes(`('${r[1]}', '${r[2]}', '${r[3]}')`), `the rollback checks ${r[1]} against the same md5`);
});

test('the three changes: the kind is let through, checked in words, and written as an ordinary unit bridge', () => {
  assert.match(UP, /array\['item'::text, 'supplier'::text, 'supplier_item'::text, 'par'::text, 'recipe'::text, 'bridge'::text\]/, 'the kind check');
  assert.match(UP, /not in \('item', 'supplier', 'supplier_item', 'par', 'recipe', 'bridge'\)/, 'stage lets a bridge row in');
  assert.match(UP, /'new_bridges', count\(\*\) filter \(where r\.action = 'new' and r\.kind = 'bridge'\)/, 'stage counts new bridges');
  for (const words of ['Add the stock item.', 'Both amounts of a unit bridge must be numbers above 0.', 'measure the same thing, so they need no unit bridge.',
    'No stock item called %s. Add it to the file or the list first.']) assert.ok(UP.includes(words), `the check says: ${words}`);
  assert.match(UP, /insert into stock_co_bridges \(org_id, item_id, from_qty, from_unit, to_qty, to_unit\)/, 'apply writes the company bridge');
  assert.match(UP, /perform public\.stock_co__log\(v_j\.org_id, null, 'bridge', v_id, 'created'/, 'and the change log');
  assert.equal(/insert into (public\.)?inventory_item_conversions/.test(UP), false, 'never a site row by hand: the site pass writes it');
  assert.equal(/stock_movements|on_hand\s*=/.test(UP.split('CREATE OR REPLACE FUNCTION public.stock_co__import_apply(')[1].split("elsif r.kind = 'par' then")[0].split("elsif r.kind = 'bridge' then")[1]), false,
    'the bridge branch writes no on hand and no ledger row');
});

test('the rollback keeps bridges the import made and only narrows the kind check when no bridge row is staged', () => {
  assert.match(DOWN, /if not exists \(select 1 from public\.stock_co_import_rows where kind = 'bridge'\) then/);
  assert.equal(/delete from/i.test(DOWN), false, 'the rollback deletes nothing');
  assert.equal(DOWN.includes("'bridge'::text"), false, 'its kind check is the one from before');
  assert.equal(/elsif (p_kind|r\.kind) = 'bridge'/.test(DOWN), false, 'its functions have no bridge branch');
});
