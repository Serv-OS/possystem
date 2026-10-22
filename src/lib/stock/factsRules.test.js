// node --test: the What is in it rules (src/lib/stock/factsRules.js, multi site stock Drop 2,
// contract 3.4 and 4.4). Made up names, suppliers and numbers only (the repo is public).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ALLERGEN_CHIPS, DIET_IDS, DIET_LABELS, DIETS, NUTRITION_FIELDS, OLD_PACK_WORDS,
  allergenIds, allergenLabel, allergenLabels, allergenWords, normaliseDietId, dietIds, dietWords, nutritionOf, nutritionEmpty,
  factsOf, factsDraft, factsPatch, checkedWords, savedFactsWords, factsDiffer, differRule,
  newItemName, supplierItemSiteIds, makeNewItemPlan, madeNewItemWords,
} from './factsRules.js';
import { ALLERGENS } from '../../data/seed.js';
import { UK_ALLERGENS } from '../kioskAllergens.js';

const N1 = '10000000-0000-4000-8000-000000000001';
const N2 = '10000000-0000-4000-8000-000000000002';
const N3 = '10000000-0000-4000-8000-000000000003';
const SI_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const SI_B = 'bbbbbbbb-0000-4000-8000-000000000002';

// A supplier item as stock_item_detail answers it after Drop 2 (the 0a columns plus `facts`).
const siB = () => ({
  id: SI_B, supplier_id: 'sup-b', supplier_name: 'Hill Bakery', supplier_product_name: 'Sesame brioche 4 pack', sku: 'HB-SB4',
  pack_qty: 6, inner_qty: 4, inner_unit: 'each', pack_description: '6 x 4 each', pack_price: 9.6, purchase_vat_rate: 0, price_includes_tax: false,
  currency: 'GBP', row_version: 3, archived_at: null,
  allergens: ['gluten', 'sesame', 'eggs'], may_contain: ['milk'], diets: ['vegetarian'], ingredients_text: 'Wheat flour, water, sesame seeds, egg',
  nutrition: { kcal: 310, fat_g: 8.2, saturates_g: 1.1, carbs_g: 52, sugars_g: 6, protein_g: 9, salt_g: 1.1, fibre_g: null },
  facts_checked_by: 'u-1', facts_checked_by_name: 'Pat Lee', facts_checked_at: '2026-10-18T09:12:00Z',
  facts: { allergens: ['gluten', 'sesame', 'eggs'], may_contain: ['milk'], diets: ['vegetarian'], ingredients_text: 'Wheat flour, water, sesame seeds, egg',
    nutrition: { kcal: 310, fat_g: 8.2, saturates_g: 1.1, carbs_g: 52, sugars_g: 6, protein_g: 9, salt_g: 1.1, fibre_g: null }, checked_by_name: 'Pat Lee', checked_at: '2026-10-18T09:12:00Z' },
  sites: [{ location_id: N1, off_here: false, price_here: null }, { location_id: N2, off_here: true, price_here: null }, { location_id: N3, off_here: false, price_here: 9.9 }],
});
// The same read before Drop 2 (0a columns only, nothing checked): the screen reads it the same way.
const siA = () => ({
  id: SI_A, supplier_id: 'sup-a', supplier_name: 'Sample Bakers', sku: 'SB-BR', pack_qty: 1, inner_qty: 24, inner_unit: 'each', pack_price: 7.2,
  row_version: 1, allergens: ['Gluten', 'egg'], may_contain: [], diets: null, ingredients_text: null, nutrition: null, facts_checked_at: null, sites: [],
});
const detail = () => ({
  item: { id: 'item-1', name: 'Brioche bun', base_unit: 'each', category_id: 'cat-1', type: 'food', purchase_vat_rate: 0, main_supplier_item_id: SI_A, row_version: 4 },
  row_version: 4,
  supplier_items: [siA(), siB()],
  sites: [{ location_id: N1, on_here: true }, { location_id: N2, on_here: true }, { location_id: N3, on_here: false }],
  facts: {
    allergens: ['gluten', 'eggs', 'sesame'], may_contain: ['milk'], diets: [], needs_check: false, source: 'supplier_items', differ: true,
    from: [
      { supplier_item_id: SI_A, supplier_name: 'Sample Bakers', allergens: ['gluten', 'eggs'], sites_on: 2 },
      { supplier_item_id: SI_B, supplier_name: 'Hill Bakery', allergens: ['gluten', 'sesame', 'eggs'], sites_on: 2 },
    ],
  },
});

test('the 14 allergens: seed labels in the kiosk order, other spellings normalised, repeats dropped', () => {
  assert.deepEqual(ALLERGEN_CHIPS.map((c) => c.id), [...UK_ALLERGENS]);
  for (const a of ALLERGENS) assert.equal(allergenLabel(a.id), a.label, a.id);
  assert.equal(allergenLabel('nuts'), 'Tree nuts');
  assert.equal(allergenLabel('Dairy'), 'Milk', 'an alias reads as its id');
  assert.equal(allergenLabel('paprika'), 'Paprika', 'a value that is not one of the 14 stays, with a capital');
  assert.equal(allergenLabel(''), '');
  assert.deepEqual(allergenIds(['Soya', 'milk', 'MILK', 'treenuts', '', null, 'paprika']), ['milk', 'nuts', 'soy', 'paprika']);
  assert.deepEqual(allergenLabels(['sesame', 'gluten']), ['Gluten', 'Sesame']);
  assert.equal(allergenWords(['sesame', 'gluten']), 'Gluten, Sesame');
  assert.equal(allergenWords([]), 'none');
  assert.equal(allergenWords(null), 'none');
});

test('diets: the database ids with their words; Menu Manager spellings read as the same id', () => {
  assert.deepEqual([...DIET_IDS], ['vegan', 'vegetarian', 'pescatarian', 'halal', 'kosher', 'gluten_free', 'dairy_free', 'nut_free']);
  assert.deepEqual(DIETS.map((d) => d.label), ['Vegan', 'Vegetarian', 'Pescatarian', 'Halal', 'Kosher', 'Gluten free', 'Dairy free', 'Nut free']);
  for (const id of DIET_IDS) assert.ok(DIET_LABELS[id]);
  assert.equal(normaliseDietId('Gluten-free'), 'gluten_free');
  assert.equal(normaliseDietId(' dairy free '), 'dairy_free');
  assert.deepEqual(dietIds(['Vegan', 'gluten-free', 'keto', 'vegan']), ['vegan', 'gluten_free'], 'unknown diets are left out, once each, in order');
  assert.equal(dietWords(['nut_free', 'vegan']), 'Vegan, Nut free');
  assert.equal(dietWords([]), 'none');
  assert.ok(Object.isFrozen(DIET_IDS) && Object.isFrozen(DIETS) && Object.isFrozen(NUTRITION_FIELDS));
});

test('nutrition per 100 g: eight numbers in the screen order, empty when the pack does not say', () => {
  assert.deepEqual(NUTRITION_FIELDS.map((f) => f.key), ['kcal', 'fat_g', 'saturates_g', 'carbs_g', 'sugars_g', 'protein_g', 'salt_g', 'fibre_g']);
  assert.deepEqual(NUTRITION_FIELDS.map((f) => f.label), ['kcal', 'Fat', 'of which saturates', 'Carbs', 'of which sugars', 'Protein', 'Salt', 'Fibre']);
  assert.deepEqual(nutritionOf({ kcal: '120', fat_g: 3, other: 9 }), { kcal: 120, fat_g: 3, saturates_g: null, carbs_g: null, sugars_g: null, protein_g: null, salt_g: null, fibre_g: null });
  assert.ok(nutritionEmpty(nutritionOf(null)));
  assert.ok(!nutritionEmpty(nutritionOf({ salt_g: 0 })), 'zero is a number the pack said');
});

test('factsOf: the Drop 2 facts object, or the 0a columns, read into one shape', () => {
  const b = factsOf(siB());
  assert.deepEqual(b.allergens, ['gluten', 'eggs', 'sesame'], 'in the order of the 14');
  assert.deepEqual(b.may_contain, ['milk']);
  assert.deepEqual(b.diets, ['vegetarian']);
  assert.equal(b.ingredients_text, 'Wheat flour, water, sesame seeds, egg');
  assert.equal(b.nutrition.kcal, 310);
  assert.equal(b.nutrition.fibre_g, null);
  assert.equal(b.checked_by_name, 'Pat Lee');
  assert.equal(b.checked_at, '2026-10-18T09:12:00Z');
  const a = factsOf(siA());
  assert.deepEqual(a.allergens, ['gluten', 'eggs'], 'old spellings normalised');
  assert.deepEqual(a.diets, []);
  assert.equal(a.ingredients_text, '');
  assert.ok(nutritionEmpty(a.nutrition));
  assert.equal(a.checked_by_name, null);
  assert.equal(a.checked_at, null);
  assert.deepEqual(factsOf(null).allergens, []);
});

test('factsDraft and factsPatch: the screen draft, and the five keys the save takes', () => {
  const d = factsDraft(siB());
  assert.deepEqual(d.nutrition, { kcal: '310', fat_g: '8.2', saturates_g: '1.1', carbs_g: '52', sugars_g: '6', protein_g: '9', salt_g: '1.1', fibre_g: '' });
  const same = factsPatch(d, siB());
  assert.equal(same.error, null);
  assert.equal(same.changed, false, 'nothing typed: nothing to save');
  assert.deepEqual(Object.keys(same.patch).sort(), ['allergens', 'diets', 'ingredients_text', 'may_contain', 'nutrition'], 'all five keys every time');
  const more = factsPatch({ ...d, allergens: [...d.allergens, 'milk'], nutrition: { ...d.nutrition, fibre_g: ' 2.5 ' } }, siB());
  assert.equal(more.changed, true);
  assert.deepEqual(more.patch.allergens, ['gluten', 'eggs', 'sesame', 'milk'].sort((x, y) => UK_ALLERGENS.indexOf(x) - UK_ALLERGENS.indexOf(y)));
  assert.equal(more.patch.nutrition.fibre_g, 2.5);
  assert.equal(factsPatch({ ...d, ingredients_text: '  ' }, siB()).patch.ingredients_text, null, 'empty text is null');
  assert.equal(factsPatch({ ...d, ingredients_text: 'Wheat flour, water, sesame seeds, egg ' }, siB()).changed, false, 'a trailing space is not a change');
  const bad = factsPatch({ ...d, nutrition: { ...d.nutrition, salt_g: 'lots' } }, siB());
  assert.equal(bad.patch, null);
  assert.equal(bad.error, 'Salt per 100 g must be a number from 0 up.');
  assert.equal(factsPatch({ ...d, nutrition: { ...d.nutrition, kcal: '-4' } }, siB()).error, 'kcal per 100 g must be a number from 0 up.');
  const fresh = factsPatch(factsDraft(siA()), siA());
  assert.equal(fresh.changed, false);
  assert.deepEqual(fresh.patch, { allergens: ['gluten', 'eggs'], may_contain: [], diets: [], ingredients_text: null, nutrition: nutritionOf(null) });
});

test('the words: checked by, the saved toast', () => {
  assert.equal(checkedWords('Pat Lee', '2026-10-18T09:12:00Z', 'Europe/London'), 'Checked by Pat Lee, 18 Oct');
  assert.equal(checkedWords('Pat Lee', '2026-10-18T23:30:00Z', 'America/Los_Angeles'), 'Checked by Pat Lee, 18 Oct', 'the venue\'s day');
  assert.equal(checkedWords('Pat Lee', '2026-10-18T23:30:00Z', 'Australia/Sydney'), 'Checked by Pat Lee, 19 Oct');
  assert.equal(checkedWords('', '2026-10-18T09:12:00Z', null), 'Checked by someone, 18 Oct');
  assert.equal(checkedWords('Pat Lee', null), 'Not checked yet');
  assert.equal(savedFactsWords('Brioche bun'), 'Saved. Every recipe using Brioche bun at every site now shows these allergens.');
  assert.equal(savedFactsWords(''), 'Saved. Every recipe using this item at every site now shows these allergens.');
});

test('the allergen rule: the contract words, who has what, and nothing when every supplier agrees', () => {
  const r = differRule(detail().facts, 'Brioche bun');
  assert.equal(r.words, 'The Brioche bun from Hill Bakery has Sesame and the one from Sample Bakers does not. Make it a new item so each site buys what it says.');
  assert.equal(r.supplierB, 'Hill Bakery');
  assert.equal(r.supplierA, 'Sample Bakers');
  assert.deepEqual(r.allergens, ['sesame']);
  assert.equal(r.supplierItemId, SI_B);
  // the database says differ false: no rule, whatever the lists look like
  assert.equal(differRule({ ...detail().facts, differ: false }, 'Brioche bun'), null);
  // no differ flag (an older read): worked out from the lists
  const noFlag = { ...detail().facts }; delete noFlag.differ;
  assert.equal(differRule(noFlag, 'Brioche bun')?.supplierB, 'Hill Bakery');
  assert.ok(factsDiffer(noFlag.from));
  assert.ok(!factsDiffer([{ allergens: ['Gluten', 'egg'] }, { allergens: ['eggs', 'gluten'] }]), 'spelling and order do not make a difference');
  assert.equal(differRule({ differ: true, from: [{ supplier_name: 'Only One', allergens: ['milk'] }] }, 'Milk'), null, 'one supplier item cannot differ');
  assert.equal(differRule(null, 'Milk'), null);
  // two with the same count but different sets: the first with something the other lacks is B
  const two = differRule({ differ: true, from: [{ supplier_name: 'Alpha Foods', allergens: ['milk'] }, { supplier_name: 'Beta Foods', allergens: ['soy'] }] }, 'Spread');
  assert.equal(two.words, 'The Spread from Alpha Foods has Milk and the one from Beta Foods does not. Make it a new item so each site buys what it says.');
});

test('Make it a new item: the name, the pre ticked sites, the plan and its words', () => {
  assert.equal(newItemName('Brioche bun', 'Hill Bakery'), 'Brioche bun (Hill Bakery)');
  assert.equal(newItemName(' Brioche bun ', ''), 'Brioche bun');
  assert.deepEqual(supplierItemSiteIds(siB()), [N1, N3], 'off here is not pre ticked');
  assert.deepEqual(supplierItemSiteIds({ sites: null }), []);
  const plan = makeNewItemPlan(detail(), siB(), { siteIds: [N1, N3, N1] });
  assert.equal(plan.error, null);
  assert.deepEqual(plan.item, { location_id: N1, name: 'Brioche bun (Hill Bakery)', base_unit: 'each', category_id: 'cat-1', type: 'food', purchase_vat_rate: 0 });
  assert.deepEqual(plan.sites, [{ location_id: N1, on: true }, { location_id: N3, on: true }]);
  assert.deepEqual(plan.si, {
    supplier_id: 'sup-b', supplier_product_name: 'Sesame brioche 4 pack', supplier_sku: 'HB-SB4', pack_qty: 6, inner_qty: 4, inner_unit: 'each',
    pack_description: '6 x 4 each', pack_price: 9.6, purchase_vat_rate: 0, price_includes_tax: false, currency: 'GBP',
    allergens: ['gluten', 'eggs', 'sesame'], may_contain: ['milk'], diets: ['vegetarian'], ingredients_text: 'Wheat flour, water, sesame seeds, egg',
    nutrition: { kcal: 310, fat_g: 8.2, saturates_g: 1.1, carbs_g: 52, sugars_g: 6, protein_g: 9, salt_g: 1.1, fibre_g: null },
  });
  assert.ok(!('id' in plan.si) && !('item_id' in plan.si), 'a copy, never the old row');
  assert.equal(makeNewItemPlan(detail(), siB(), { name: 'Sesame bun', siteIds: [N2] }).item.name, 'Sesame bun');
  assert.equal(makeNewItemPlan(detail(), siB(), { siteIds: [] }).error, 'Tick at least one site.');
  assert.equal(makeNewItemPlan(detail(), siB(), { name: '  ', siteIds: [N1] }).error, 'Give the new item a name.');
  assert.equal(makeNewItemPlan(detail(), { ...siB(), supplier_id: null }, { siteIds: [N1] }).error, 'This supplier pack has no supplier.');
  assert.equal(OLD_PACK_WORDS, 'The old supplier pack is archived, never deleted. Orders and invoices keep it.');
  assert.equal(madeNewItemWords('Brioche bun (Hill Bakery)', 'Hill Bakery'), "Brioche bun (Hill Bakery) saved. Hill Bakery's pack is under it now. The old supplier pack is archived, never deleted. Orders and invoices keep it.");
  assert.equal(madeNewItemWords('Brioche bun (Hill Bakery)', 'Hill Bakery', ['The old supplier pack was not archived: refused.']), "Brioche bun (Hill Bakery) saved. Hill Bakery's pack is under it now. The old supplier pack was not archived: refused.");
});

test('the module is pure and plain: no React, no database, no long dashes, never that word', () => {
  const src = fs.readFileSync(new URL('./factsRules.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['../../data/seed.js', '../kioskAllergens.js', '../venueDate.js']);
  assert.doesNotMatch(src, new RegExp('[\\u2013\\u2014]'));
  assert.doesNotMatch(src, /from 'react'|supabase|stockApi|\.rpc\(|window\./);
  assert.doesNotMatch(src, new RegExp(['s', 'tripe'].join(''), 'i'));
});
