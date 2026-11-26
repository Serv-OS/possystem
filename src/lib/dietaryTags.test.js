import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIET, DIET_TAGS, toggleDietTag, dietaryBadges } from './dietary.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('every tag the Back Office can tick has a badge, and the badge is the one shown beside it', () => {
  assert.deepEqual(DIET_TAGS.map(d => d.id), ['vegetarian', 'vegan', 'gluten-free', 'dairy-free']);
  for (const d of DIET_TAGS) assert.equal(DIET[d.id], d.badge, d.id);
  assert.deepEqual(dietaryBadges({ tags: DIET_TAGS.map(d => d.id) }), ['V', 'VG', 'GF', 'DF']);
});

test('ticking and unticking keeps any other tag the product holds', () => {
  assert.deepEqual(toggleDietTag([], 'vegan'), ['vegan']);
  assert.deepEqual(toggleDietTag(['vegan', 'spicy'], 'vegan'), ['spicy']);
  assert.deepEqual(toggleDietTag(['spicy'], 'gluten-free'), ['spicy', 'gluten-free']);
  assert.deepEqual(toggleDietTag(null, 'vegan'), ['vegan']);
  const before = ['vegan'];
  toggleDietTag(before, 'vegan');
  assert.deepEqual(before, ['vegan'], 'the list handed in is not changed');
});

// Peter, 25 Nov 2026: "in the multi site menu manager you cant add dietary info". The site's
// Dietary boxes are locked to head office (lockOn('tags')), and head office's sheet had none.
test('head office can tick dietary tags: the product sheet has the boxes and carries them', () => {
  const sheet = read('../backoffice/sections/msm/MsmProductSheet.jsx');
  assert.ok(sheet.includes('<Field label="Dietary"'));
  assert.ok(sheet.includes("set('tags', toggleDietTag(form.tags, d.id))"));
  assert.ok(sheet.includes('allergens: [], tags: [],'), 'a new product starts with none');
  assert.ok(sheet.includes('allergens: x.allergens || [], tags: x.tags || [],'), 'an existing product opens with its own');
  // The site editor ticks the same list, and its boxes stay locked while head office owns them.
  const site = read('../backoffice/sections/MenuManager.jsx');
  assert.ok(site.includes("import { DIET_TAGS } from '../../lib/dietary';"));
  assert.ok(!site.includes('const DIET_TAGS = ['));
  assert.ok(site.includes("lockOn('allergens') || lockOn('tags')"));
  // Publish writes them: the staged fields include tags.
  assert.ok(read('../../supabase/functions/_shared/msmModel.js').includes("'allergens', 'tags', 'image'"));
});
