// Multi site menu, round 2: what the Option groups screen shows and what its Save stages
// (msmGroupView.js), driven through builder 1's msmGroupEdit rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as edit from './msmGroupEdit.js';
import {
  optionsOf, legacyGroupIds, optionCell, groupDiffers, groupList, keptRuleLines, formFromGroup, ruleFromForm, formSentence,
  productPickTree, groupForm, newGroupForm, newOptionForm, groupSaveChanges, addGroupWithSites, optionPriceWords,
} from './msmGroupView.js';
import { indexCentral, categoryTree } from './msmGrid.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';

const A = 'site-a', B = 'site-b', C = 'site-c';
const central = () => ({
  menu: { id: 'm' },
  sites: [{ location_id: A }, { location_id: B }, { location_id: C }],
  categories: [{ id: 'hot', label: 'Hot drinks', sort_order: 1 }, { id: 'food', label: 'Food', sort_order: 2 }],
  products: [
    { id: 'latte', name: 'Latte', category_id: 'hot', default_price: 3.4, modifier_groups: [{ groupId: 'milk' }] },
    { id: 'large', name: 'Large latte', category_id: 'hot', parent_product_id: 'latte', default_price: 3.9, modifier_groups: [] },
    { id: 'tea', name: 'Tea', category_id: 'hot', default_price: 2.4, modifier_groups: [] },
    { id: 'toast', name: 'Toast', category_id: 'food', default_price: 3, modifier_groups: [] },
    { id: 'oatp', name: 'Oat milk', type: 'subitem', sold_alone: false, default_price: 0.5, category_id: null, modifier_groups: [] },
  ],
  productSites: [
    { product_id: 'latte', location_id: A, venue_item_id: 'v1', active: true }, { product_id: 'latte', location_id: B, venue_item_id: 'v2', active: true },
    { product_id: 'tea', location_id: C, venue_item_id: 'v3', active: true }, { product_id: 'toast', location_id: A, venue_item_id: 'v4', active: true },
  ],
  groups: [
    { id: 'milk', name: 'Milk options', min: 0, max: 1, selection_type: 'single', sort_order: 1 },
    { id: 'old', name: 'Old sauces', min: 0, max: 1, selection_type: 'single', sort_order: 2, options: [{ id: 'x1', name: 'Ketchup', price: 0 }] },
  ],
  groupSites: [{ group_id: 'milk', location_id: A, venue_group_id: 'g-a', kept: {} }, { group_id: 'milk', location_id: B, venue_group_id: 'g-b', kept: { max: 2 } }],
  options: [
    { id: 'oat', group_id: 'milk', name: 'Oat milk', price: 0.5, product_id: 'oatp', sort_order: 0 },
    { id: 'soy', group_id: 'milk', name: 'Soya milk', price: 0.5, product_id: null, sort_order: 1 },
  ],
  optionSites: [
    { option_id: 'oat', location_id: A, venue_option_id: 'o1', active: true, price: null },
    { option_id: 'oat', location_id: B, venue_option_id: 'o1', active: true, price: 0.6 },
    { option_id: 'soy', location_id: A, venue_option_id: 'o2', active: true, price: null },
    { option_id: 'soy', location_id: B, venue_option_id: 'o2', active: false, price: null },
  ],
});
const ctxOf = (c) => ({ live: c, eff: c });

test('an option at a site: on, its own price or the default, off, no row is off, a site without the group', () => {
  const c = central();
  const oat = c.options[0], soy = c.options[1];
  assert.deepEqual(optionCell(c, oat, A).follows, true);
  assert.equal(optionCell(c, oat, B).price, 0.6);
  assert.equal(optionCell(c, soy, B).active, false);
  assert.equal(optionCell(c, oat, C).here, false, 'Milk options is not at site C');
  c.optionSites = c.optionSites.filter((r) => !(r.option_id === 'soy' && r.location_id === A));
  assert.equal(optionCell(c, soy, A).active, false, 'no row means off');
  assert.equal(optionPriceWords(-0.5), 'takes 0.50 off');
});

test('the list: used by, differs between sites, old style groups need the refresh, filters and search', () => {
  const c = central();
  assert.deepEqual(legacyGroupIds(c), ['old']);
  assert.equal(optionsOf(c, 'old').legacy, true);
  const list = groupList(c);
  assert.deepEqual(list.map((g) => g.group.name), ['Milk options', 'Old sauces']);
  assert.equal(list[0].words, 'Used by 1 product in 1 category');
  assert.equal(list[1].words, 'Not on any product yet');
  assert.equal(list[0].differs, true, 'site B keeps its own rule and has its own price');
  assert.deepEqual(groupList(c, { filter: 'unused' }).map((g) => g.group.id), ['old']);
  assert.deepEqual(groupList(c, { search: 'soya' }).map((g) => g.group.id), ['milk'], 'search finds a group by an option name');
  assert.equal(groupDiffers({ ...c, groupSites: [c.groupSites[0]], optionSites: c.optionSites.filter((r) => r.location_id === A) }, 'milk'), false);
  const kept = keptRuleLines(c, 'milk', (l) => (l === B ? 'Barnsley' : l));
  assert.equal(kept[0].words, 'Barnsley keeps its own rule: choose up to 2.');
});

test('the rule form is always a valid rule (Menu Manager\'s rules)', () => {
  assert.deepEqual(ruleFromForm({ choice: 'single', mustChoose: true }), { min: 1, max: 1, selection_type: 'single' });
  assert.deepEqual(ruleFromForm({ choice: 'multiple', mustChoose: false, min: 2, max: 3 }), { min: 0, max: 3, selection_type: 'multiple' });
  assert.deepEqual(ruleFromForm({ choice: 'multiple', mustChoose: true, min: 5, max: 3 }), { min: 3, max: 3, selection_type: 'multiple' }, 'at least never above up to');
  assert.deepEqual(ruleFromForm({ choice: 'quantity', max: 3 }), { min: 3, max: 3, selection_type: 'quantity' }, 'a box of 3 is exactly 3');
  assert.deepEqual(ruleFromForm({ choice: 'multiple', max: 500 }), { min: 0, max: 99, selection_type: 'multiple' });
  assert.equal(formSentence({ choice: 'single', mustChoose: true }), 'Choose exactly 1. Customers must choose before the till moves on.');
  assert.deepEqual(formFromGroup({ min: 1, max: 1, selection_type: 'single' }), { mustChoose: true, choice: 'single', min: 1, max: 1 });
});

test('Add to products: categories in order, sizes under their product, ticked when it already has the group, no option only sub items', () => {
  const c = central();
  const ix = indexCentral(c);
  const t = productPickTree(ix, categoryTree(ix), 'milk');
  assert.deepEqual(t.map((x) => x.category.label), ['Hot drinks', 'Food']);
  const latte = t[0].products.find((x) => x.product.id === 'latte');
  assert.equal(latte.has, true);
  assert.deepEqual(latte.sizes.map((s) => [s.product.id, s.has]), [['large', false]]);
  assert.ok(!t.flatMap((x) => x.products).some((x) => x.product.id === 'oatp'));
  assert.deepEqual(productPickTree(ix, categoryTree(ix), 'milk', 'toa').map((x) => x.category.label), ['Food']);
});

test('Save: a price edit stages only that option; a site price equal to the new default follows it again', () => {
  const c = central();
  const f = groupForm(c, 'milk');
  f.options[0].price = '0.60';
  const r = groupSaveChanges(ctxOf(c), f, edit);
  assert.equal(r.words, '');
  assert.deepEqual(r.changes.map((x) => [x.target, x.entity_id, x.location_id || null, x.after]), [
    ['modifier_option', 'oat', null, { price: 0.6 }],
    ['modifier_option_site', 'oat', B, { price: null }],
  ]);
});

test('Save: off at one site, own price at another, a rename, a new order', () => {
  const c = central();
  const f = groupForm(c, 'milk');
  f.options[1].sites[A] = { active: false, own: '' };
  f.options[0].sites[A] = { active: true, own: '0.70' };
  f.name = 'Milks';
  f.options.reverse();
  const r = groupSaveChanges(ctxOf(c), f, edit);
  const k = r.changes.map((x) => `${x.target}:${x.entity_id}:${x.location_id || ''}:${JSON.stringify(x.after)}`);
  assert.ok(k.includes('modifier_group:milk::{"name":"Milks"}'));
  assert.ok(k.includes(`modifier_option_site:soy:${A}:{"active":false}`));
  assert.ok(k.includes(`modifier_option_site:oat:${A}:{"price":0.7}`));
  assert.ok(k.includes('modifier_option:soy::{"sort_order":0}') && k.includes('modifier_option:oat::{"sort_order":1}'));
  assert.ok(!k.some((x) => x.includes(`:${C}:`)), 'a site the group is not at is left alone');
});

test('Save: a new group with a new option and a new sub item: a row at EVERY site, the sub item first', () => {
  const c = central();
  const f = newGroupForm('box');
  f.name = 'Choose 3 donuts';
  f.form = { choice: 'quantity', max: 3, mustChoose: true };
  f.options.push(newOptionForm(c, { id: 'glaze', name: 'Glazed', price: '0.00' }));
  f.options.push(newOptionForm(c, { id: 'jam', name: 'Jam', price: '0.00', newSub: { productId: 'jamp', soldAlone: true, productPrice: 1.5, categoryId: 'food' } }));
  f.options[0].sites[B] = { active: false, own: '' };
  const r = groupSaveChanges(ctxOf(c), f, edit);
  assert.equal(r.words, '');
  const t = r.changes.map((x) => `${x.target}:${x.entity_id}:${x.location_id || ''}`);
  assert.equal(t[0], 'modifier_group:box:');
  assert.ok(t.indexOf('product:jamp:') < t.indexOf('modifier_option:jam:'), 'the sub item before the option that points at it');
  for (const loc of [A, B, C]) { assert.ok(t.includes(`modifier_option_site:glaze:${loc}`)); assert.ok(t.includes(`modifier_option_site:jam:${loc}`)); }
  assert.equal(r.changes.find((x) => x.target === 'modifier_option_site' && x.entity_id === 'glaze' && x.location_id === B).after.active, false);
  assert.deepEqual(r.changes[0].after, { name: 'Choose 3 donuts', min: 3, max: 3, selection_type: 'quantity', sort_order: 2 });
  assert.equal(r.changes.find((x) => x.target === 'modifier_option' && x.entity_id === 'jam').after.sort_order, 1);
  // It all applies cleanly to central state.
  const after = applyChanges(c, r.changes).central;
  assert.equal(optionsOf(after, 'box').rows.length, 2);
  assert.equal(after.products.find((p) => p.id === 'jamp').sold_alone, true);
});

test('Save refuses in words: no name, an option with no name or a bad price, must choose with nothing to pick', () => {
  const c = central();
  const f = newGroupForm('g');
  assert.match(groupSaveChanges(ctxOf(c), f, edit).words, /Give the option group a name/);
  f.name = 'Sauces';
  f.form = { choice: 'single', mustChoose: true };
  assert.match(groupSaveChanges(ctxOf(c), f, edit).words, /needs at least one option/);
  f.options.push(newOptionForm(c, { id: 'o', name: '', price: '0.00' }));
  assert.match(groupSaveChanges(ctxOf(c), f, edit).words, /Every option needs a name/);
  f.options[0].name = 'Mayo'; f.options[0].price = '-1';
  assert.match(groupSaveChanges(ctxOf(c), f, edit).words, /0\.00 or more/);
});

test('Add to products: the group goes on the product and its sizes, and its options switch on where they have no row yet', () => {
  const c = central();
  const r = addGroupWithSites(ctxOf(c), 'milk', ['tea', 'toast'], edit);
  const t = r.map((x) => `${x.target}:${x.entity_id}:${x.location_id || ''}`);
  assert.ok(t.includes('product:tea:') && t.includes('product:toast:'));
  assert.ok(t.includes(`modifier_option_site:oat:${C}`) && t.includes(`modifier_option_site:soy:${C}`), 'site C sells Tea: the options go on there');
  assert.ok(!t.includes(`modifier_option_site:oat:${A}`), 'site A already has rows (kept as they are)');
  assert.ok(r.filter((x) => x.target === 'modifier_option_site').every((x) => x.after.active === true));
  const sized = addGroupWithSites(ctxOf(c), 'milk', ['latte'], edit).map((x) => x.entity_id);
  assert.deepEqual(sized.filter((x) => x === 'large'), ['large'], 'ticking a product with sizes means its sizes');
});

test('Copy this group: the copy\'s options carry the same site rows (on, off, own price), so it is not off everywhere', async () => {
  const { copyGroupWithSites } = await import('./msmGroupView.js');
  const c = central();
  let n = 0;
  const r = copyGroupWithSites(ctxOf(c), 'milk', () => `new-${++n}`, edit);
  assert.equal(r.groupId, 'new-1');
  const after = applyChanges(c, r.changes).central;
  const copy = after.groups.find((g) => g.id === 'new-1');
  assert.equal(copy.name, 'Milk options (copy)');
  const opts = optionsOf(after, 'new-1').rows;
  assert.deepEqual(opts.map((o) => o.name), ['Oat milk', 'Soya milk']);
  const soyB = after.optionSites.find((x) => x.option_id === opts[1].id && x.location_id === B);
  assert.equal(soyB.active, false);
  assert.equal(after.optionSites.find((x) => x.option_id === opts[0].id && x.location_id === B).price, 0.6);
});

// ── Round 2 review (17 Oct 2026) ────────────────────────────────────────────

test('review: ticking a group on a product in the product sheet switches its options on where the product is sold', async () => {
  const { groupTickSiteRows } = await import('./msmGroupView.js');
  const c = central();
  const rows = groupTickSiteRows(ctxOf(c), [], [{ groupId: 'milk' }], [C], edit);
  const t = rows.map((x) => `${x.entity_id}:${x.location_id}:${x.after.active}`);
  assert.deepEqual(t.sort(), [`oat:${C}:true`, `soy:${C}:true`]);
  assert.deepEqual(groupTickSiteRows(ctxOf(c), [{ groupId: 'milk' }], [{ groupId: 'milk' }], [C], edit), [], 'a group already on the product adds nothing');
  assert.deepEqual(groupTickSiteRows(ctxOf(c), [], ['milk'], [A], edit), [], 'site A already has rows (kept as they are)');
});

test('review: copyGroupChanges alone makes the site rows, and a new group\'s new option can be on at every site', () => {
  const c = central();
  let n = 0;
  const ids = new Map();
  const ch = edit.copyGroupChanges(ctxOf(c), 'milk', { groupId: 'copy', optionId: (old) => { if (!ids.has(old)) ids.set(old, `n${++n}`); return ids.get(old); } });
  assert.equal(ch.filter((x) => x.target === 'modifier_option_site').length, 4, 'a row per site the original has');
  const blank = edit.newOptionChanges(ctxOf(c), { id: 'z', groupId: 'brand-new', name: 'Z', price: 0 });
  assert.equal(blank.filter((x) => x.target === 'modifier_option_site').length, 0, 'the old rule without allSites');
  const every = edit.newOptionChanges(ctxOf(c), { id: 'z', groupId: 'brand-new', name: 'Z', price: 0, allSites: true });
  assert.equal(every.filter((x) => x.target === 'modifier_option_site').length, 3);
});

test('review: a group holding a minus option (brought in from a site) can still be saved; a typed minus price cannot', () => {
  const c = central();
  c.options[1].price = -0.2;
  const f = groupForm(c, 'milk');
  f.name = 'Milk';
  const r = groupSaveChanges(ctxOf(c), f, edit);
  assert.equal(r.words, '', 'renaming works');
  assert.ok(r.changes.some((x) => x.target === 'modifier_group' && x.after.name === 'Milk'));
  f.options[0].price = '-0.10';
  assert.match(groupSaveChanges(ctxOf(c), f, edit).words, /0\.00 or more/);
});
