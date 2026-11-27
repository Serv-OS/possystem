// Multi site menu, 5.12.110. Peter, 26 Nov 2026, after the product names: "the other thing is
// also in categories" and "in the normal menu we have this feature where you can add products to
// multiple categories".
//
// Two things the Multi site menu could not do, both locked in Menu Manager for a group product:
//   1. RENAME A CATEGORY. The rule refused any name on a category the group menu already has
//      (20261018). The name is allowed now (20261211a); its place and colour still are not.
//   2. "ALSO IN": put a product in extra categories. The model, the import and the publish plan
//      all carried extra_category_ids, but the product sheet had no boxes for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { categoryRenameChange, categoryGuardWords, productUpdate } from './msmEdit.js';
import { changeWords } from './msmWords.js';
import { applyChanges, mergeStaged } from '../../../supabase/functions/_shared/msmDiff.js';
import { CATEGORY_UPDATE_FIELDS, CATEGORY_RULE_OLD_WORDS, categoryUpdateWords, checkChange } from '../../../supabase/functions/_shared/msmModel.js';
import { planSite, touchedFromChanges, lineWords } from '../../../supabase/functions/_shared/msmPlan.js';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { A, B, ORG, importSites, idGen, venues } from './msmFixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

function setup() {
  const v = venues();
  const sites = importSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false };
  return { v, central, ctx: { live: central, eff: applyChanges(central, []).central } };
}
const topCats = (central) => central.categories.filter((c) => !c.archived && !c.parent_id);

// ── 1. Rename a category ────────────────────────────────────────────────────

test('a rename stages only the name, with the old name as its before', () => {
  const { ctx, central } = setup();
  const cat = topCats(central)[0];
  const r = categoryRenameChange(ctx, cat.id, '  Coffee and tea ');
  assert.deepEqual(r.change, { target: 'category', entity_id: cat.id, location_id: null, op: 'update', after: { label: 'Coffee and tea' }, before: { label: cat.label } });
  assert.equal(checkChange(r.change).ok, true);
  assert.equal(mergeStaged(null, r.change).action, 'insert', 'the draft takes it');
  assert.equal(applyChanges(central, [r.change]).central.categories.find((c) => c.id === cat.id).label, 'Coffee and tea');
});

test('the same name stages nothing; a blank, a long or a taken name is refused in words', () => {
  const { ctx, central } = setup();
  const [one, two] = topCats(central);
  assert.ok(one && two, 'the fixture has two top level categories');
  assert.deepEqual(categoryRenameChange(ctx, one.id, one.label), { change: null });
  assert.match(categoryRenameChange(ctx, one.id, '   ').words, /Give the category a name/);
  assert.match(categoryRenameChange(ctx, one.id, 'x'.repeat(81)).words, /too long/);
  assert.match(categoryRenameChange(ctx, one.id, two.label.toUpperCase()).words, /already a category called/);
  assert.match(categoryRenameChange(ctx, 'no-such-id', 'Soups').words, /not in the group menu/);
});

test('the rule: the name is allowed, the place and the colour still are not', () => {
  // 5.12.116: and which of the group's menus it is on (menu_keys, 20261214a).
  assert.deepEqual([...CATEGORY_UPDATE_FIELDS], ['archived', 'route_like_id', 'label', 'menu_keys']);
  const ch = (after) => ({ target: 'category', entity_id: 'aaaaaaaa-0000-4000-8000-00000000c001', location_id: null, op: 'update', after });
  assert.equal(categoryUpdateWords(ch({ label: 'Soups' })), '');
  assert.match(categoryUpdateWords(ch({ color: '#000000' })), /place and colour stay as each site has them/);
  assert.match(categoryUpdateWords(ch({ label: 'Soups', parent_id: null })), /Only its name can be changed here/);
  assert.equal(mergeStaged(null, ch({ parent_id: null })).action, 'none');
});

test('publishing a rename writes the new name to that category at each site, and nothing else', () => {
  const { v, central, ctx } = setup();
  const cat = topCats(central).find((c) => central.catSites.some((s) => s.category_id === c.id && s.location_id === A) && central.catSites.some((s) => s.category_id === c.id && s.location_id === B));
  assert.ok(cat, 'a category both sites have');
  const { change } = categoryRenameChange(ctx, cat.id, 'Renamed here');
  const after = applyChanges(central, [change]).central;
  for (const loc of [A, B]) {
    const vid = central.catSites.find((s) => s.category_id === cat.id && s.location_id === loc).venue_category_id;
    const p = planSite({ central: after, touched: touchedFromChanges([change]), locationId: loc, orgId: ORG, venue: v[loc] });
    assert.deepEqual(p.problems.filter((x) => x.level === 'block'), []);
    assert.deepEqual(p.writes.categories.update, [{ id: vid, set: { label: 'Renamed here' } }]);
    assert.equal(p.writes.categories.insert.length, 0);
    assert.equal(p.writes.items.update.length + p.writes.items.insert.length, 0, 'no product is touched');
    const line = p.lines.find((l) => l.table === 'categories' && l.column === 'label');
    assert.match(lineWords(line, {}), /renamed to "?Renamed here"?/);
  }
  // A publish that does not hold a rename never writes a category name (a site's own name is safe).
  const other = { target: 'product', entity_id: central.products.find((x) => !x.archived).id, op: 'update', after: { description: 'New words' } };
  const q = planSite({ central: applyChanges(central, [other]).central, touched: touchedFromChanges([other]), locationId: A, orgId: ORG, venue: v[A] });
  assert.equal(q.writes.categories.update.length, 0);
});

test('the draft says the new name', () => {
  const names = { categories: new Map([['c1', 'Hot drinks']]) };
  assert.deepEqual(changeWords({ target: 'category', entity_id: 'c1', op: 'update', after: { label: 'Coffee' } }, names), { subject: 'Hot drinks', words: 'renamed to Coffee at every site' });
});

test('20261211a holds the rule as it is now: the same list and the same words as the Back Office', () => {
  const sql = read('../../../supabase/migrations/20261211a_OPS_multi_site_menu_category_rename.sql');
  const rb = read('../../../supabase/migrations/20261211a_OPS_multi_site_menu_category_rename_ROLLBACK.sql');
  const m = /if new\.target = 'category' and new\.op <> 'create' and jsonb_typeof\(new\.after\) = 'object'\s+and exists \(select 1 from jsonb_object_keys\(new\.after\) k where k <> all \(array\[([^\]]+)\]\)\) then/.exec(sql);
  assert.ok(m, 'refuses other fields on a category that is not new');
  // 20261211a is the file as Ops ran it: 20261214a adds menu_keys (src/lib/msm/msmSeveralMenus.test.js).
  assert.deepEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), CATEGORY_UPDATE_FIELDS.filter((k) => k !== 'menu_keys'));
  const words = categoryUpdateWords({ target: 'category', op: 'update', after: { color: 'x' } });
  assert.ok(sql.includes(`raise exception '${words.replace(/'/g, "''")}' using errcode = '22023'`), 'the database says what the screen says');
  // One function replaced, nothing else: no table, no venue row, no grant.
  assert.deepEqual([...sql.matchAll(/create or replace function (public\.\w+)\(/g)].map((x) => x[1]), ['public.msm_changes_category_fields']);
  assert.doesNotMatch(sql, /\b(alter|drop) table\b|\b(insert into|update|delete from) public\./i);
  assert.doesNotMatch(sql, /grant execute/);
  assert.doesNotMatch(sql, /^\s*(begin|commit);/im, 'bare statements: the SQL editor runs the paste as one transaction');
  assert.match(sql, /Run 20261018_OPS_multi_site_menu_category_fields\.sql first/);
  assert.match(sql, /\) as category_rename_ok,[\s\S]*\) as guards_in_order,[\s\S]*as staged_category_fields;\s*$/);
  // The roll back puts the October rule back, word for word.
  assert.ok(rb.includes("k <> all (array['archived', 'route_like_id']))"));
  assert.ok(rb.includes(`raise exception '${CATEGORY_RULE_OLD_WORDS.replace(/'/g, "''")}' using errcode = '22023'`));
  for (const [f, s] of [['20261211a', sql], ['20261211a roll back', rb]]) assert.doesNotMatch(s, /[^\t\n\r -~]/, `${f} is pure ASCII`);
});

test('before 20261211a has run, the database refusal is turned into what to do about it', () => {
  assert.match(categoryGuardWords(`ERROR: ${CATEGORY_RULE_OLD_WORDS}`), /needs one database update that has not been run yet \(SQL 20261211a\)/);
  assert.equal(categoryGuardWords('Something else went wrong.'), 'Something else went wrong.');
  assert.match(read('../../backoffice/sections/msm/MultiSiteMenu.jsx'), /categoryGuardWords\(r\.failed\[0\]\.words\)/);
});

test('the grid has Rename on every category row', () => {
  const grid = read('../../backoffice/sections/msm/MsmGrid.jsx');
  assert.match(grid, /data-testid="msm-category-rename"/);
  assert.match(grid, /categoryRenameChange\(ctx, renaming\.id, renaming\.value\)/);
});

// ── 2. "Also in": a product in extra categories ─────────────────────────────

test('the product sheet has the Also in boxes and sends them', () => {
  const sheet = read('../../backoffice/sections/msm/MsmProductSheet.jsx');
  assert.match(sheet, /label="Also in"/);
  assert.match(sheet, /data-testid="msm-also-in"/);
  assert.match(sheet, /extra_category_ids: \[\.\.\.\(x\.extra_category_ids \|\| \[\]\)\]/, 'it opens with what the product has');
  assert.match(sheet, /f\.extra_category_ids = .*filter\(\(c\) => c && c !== f\.category_id\)/, 'never its own category twice');
});

test('an extra category stages one change, publishes to the site, and none is no change', () => {
  const { v, central, ctx } = setup();
  const p = central.products.find((x) => !x.archived && !x.parent_product_id && x.category_id && central.productSites.some((s) => s.product_id === x.id && s.location_id === A && s.active !== false));
  const extra = central.categories.find((c) => !c.archived && c.id !== p.category_id && central.catSites.some((s) => s.category_id === c.id && s.location_id === A));
  assert.ok(p && extra);
  // No list and an empty list are the same thing: opening and saving stages nothing.
  assert.equal(productUpdate(ctx, p.id, { extra_category_ids: [] }).change, null);
  const r = productUpdate(ctx, p.id, { extra_category_ids: [extra.id] });
  assert.deepEqual(r.change.after, { extra_category_ids: [extra.id] });
  assert.equal(checkChange(r.change).ok, true);
  const plan = planSite({ central: applyChanges(central, [r.change]).central, touched: touchedFromChanges([r.change]), locationId: A, orgId: ORG, venue: v[A] });
  const vItem = central.productSites.find((s) => s.product_id === p.id && s.location_id === A).venue_item_id;
  const vCat = central.catSites.find((s) => s.category_id === extra.id && s.location_id === A).venue_category_id;
  assert.deepEqual(plan.writes.items.update.find((u) => u.id === vItem)?.set, { cats: [vCat] });
});
