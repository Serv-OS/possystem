// node --test: the stock facts every channel lays over its menu rows (v5.11.91, multi site stock
// Drop 2, contract 3.6): the shared alias table and id order, the merge rule (never fewer
// allergens than typed), Show calories, the kcal words through i18n, the paged facts read and
// withFacts (never throws), and the four new i18n keys in every language block.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  mergeStockFacts, withItemFacts, factsByItemId, showCalories, kcalWords, mayContainWords,
  fetchMenuStockFacts, withFacts, allergenIds, normaliseAllergenId, UK_ALLERGENS, factsPanelWords, factsCheckedWords,
  KCAL_KEY, KCAL_NOTE_KEY, MAY_CONTAIN_KEY, ALLERGEN_CHECK_KEY, KCAL_NOTE_EN, FACTS_TABLE, FACTS_IDS_CHUNK,
} from './menuStockFacts.js';
import * as shared from '../../supabase/functions/_shared/menuStockFacts.js';
import * as sharedIds from '../../supabase/functions/_shared/allergenIds.js';
import * as kiosk from './kioskAllergens.js';
import { t, tf, englishKeys, languageKeys, LANGUAGES, RETIRED_LANGUAGES } from './i18n.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── a stand in for the Supabase client: one table, paged like the Data API ──────────────────
function fakeClient(rows, { cap = 1000, fail = false, throwOn = false, missing = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const st = { table, filters: [], order: null, from: 0, to: cap - 1 };
      const run = async () => {
        if (throwOn) throw new Error('network gone');
        if (missing) return { data: null, error: { code: '42P01', message: `relation "public.${table}" does not exist` } };
        if (fail) return { data: null, error: { message: 'refused' } };
        let out = rows.filter((r) => st.filters.every((f) => f(r)));
        if (st.order) out = [...out].sort((a, b) => String(a[st.order]).localeCompare(String(b[st.order])));
        calls.push({ table, from: st.from, to: st.to, filters: st.filters.length });
        return { data: out.slice(st.from, Math.min(st.to + 1, st.from + cap)), error: null };
      };
      const b = {
        select() { return b; },
        eq(c, v) { st.filters.push((r) => String(r[c]) === String(v)); return b; },
        in(c, vs) { st.filters.push((r) => vs.includes(String(r[c]))); return b; },
        order(c) { st.order = c; return b; },
        range(a, z) { st.from = a; st.to = z; return b; },
        then(res, rej) { return run().then(res, rej); },
      };
      return b;
    },
  };
}

const row = (menu_item_id, extra = {}) => ({ location_id: 'L1', menu_item_id, allergens: [], recipe_allergens: [], typed_allergens: [], may_contain: [], diets: [], ingredients_text: null, kcal: null, needs_check: false, checked_at: null, ...extra });

test('one alias table: the kiosk re exports the shared one and the ids come out in the sheet order, then the rest alphabetically', () => {
  assert.equal(kiosk.normaliseAllergenId, sharedIds.normaliseAllergenId, 'the same function, not a copy');
  assert.equal(kiosk.UK_ALLERGENS, sharedIds.UK_ALLERGENS);
  assert.equal(kiosk.isUkAllergen, sharedIds.isUkAllergen);
  assert.equal(normaliseAllergenId('Tree_Nuts'), 'nuts');
  assert.equal(normaliseAllergenId('Sulfur-Dioxide'), 'sulphites');
  assert.deepEqual(allergenIds(['zebra fruit', 'Soya', 'milk', 'MILK', 'dairy', 'apple', 'gluten', '', null, '  ']), ['gluten', 'milk', 'soy', 'apple', 'zebra fruit']);
  assert.deepEqual(allergenIds(null), []);
  assert.deepEqual(allergenIds(UK_ALLERGENS.slice().reverse()), [...UK_ALLERGENS], 'the 14 in the design order whatever order they came in');
  assert.ok(!read('./kioskAllergens.js').includes("const ALIASES = new Map"), 'the alias table lives in the shared file only');
  assert.ok(read('../../supabase/functions/_shared/allergenIds.js').includes("'tree nuts': 'nuts'"));
});

test('mergeStockFacts: the typed spelling stays, the recipe adds by normalised id, never fewer, items with no row untouched', () => {
  const items = [
    { id: 'a', name: 'Latte', allergens: ['Dairy'] },
    { id: 'b', name: 'Tea', allergens: ['soy'] },
    { id: 7, name: 'Toast' },
  ];
  const facts = [
    row('a', { allergens: ['milk', 'nuts', 'Gluten'], kcal: '146.4', may_contain: ['Peanut', 'soya'], diets: ['vegetarian'], ingredients_text: 'Milk, *Coffee*', needs_check: true, checked_at: '2026-10-20T10:00:00Z' }),
    row('7', { allergens: [], kcal: null }),
    row('zzz', { allergens: ['fish'] }),
  ];
  const out = mergeStockFacts(items, facts);
  assert.notEqual(out, items, 'a new array when something changed');
  assert.deepEqual(out[0].allergens, ['Dairy', 'gluten', 'nuts'], 'Dairy kept as typed (it is milk), gluten and nuts added in the sheet order');
  assert.equal(out[0].kcal, 146.4);
  assert.deepEqual(out[0].stockFacts, { needsCheck: true, mayContain: ['peanuts', 'soy'], diets: ['vegetarian'], ingredientsText: 'Milk, *Coffee*', checkedAt: '2026-10-20T10:00:00Z' });
  assert.equal(out[1], items[1], 'no row: the very same object');
  assert.deepEqual(out[2].allergens, [], 'a row with nothing adds nothing');
  assert.equal(out[2].kcal, null);
  assert.equal(out[2].stockFacts.needsCheck, false);
  assert.deepEqual(items[0].allergens, ['Dairy'], 'the input row is never changed');
  // never fewer than typed: a recipe that says nothing leaves every typed allergen
  const kept = mergeStockFacts([{ id: 'x', allergens: ['milk', 'eggs'] }], [row('x', { allergens: [] })]);
  assert.deepEqual(kept[0].allergens, ['milk', 'eggs']);
});

test('mergeStockFacts: the same array when there are no facts, or none for these items; a Map is taken as it is', () => {
  const items = [{ id: 'a', allergens: ['milk'] }];
  assert.equal(mergeStockFacts(items, []), items);
  assert.equal(mergeStockFacts(items, null), items);
  assert.equal(mergeStockFacts(items, [row('other')]), items);
  assert.equal(mergeStockFacts(null, [row('a')]), null);
  assert.equal(mergeStockFacts([], [row('a')]).length, 0);
  const map = factsByItemId([row('a', { kcal: 10 }), null, { menu_item_id: null }]);
  assert.equal(map.size, 1);
  assert.equal(mergeStockFacts(items, map)[0].kcal, 10);
  assert.equal(withItemFacts(items[0], null), items[0]);
});

test('mergeStockFacts works on raw rows and on mapped rows alike (only id and allergens are read)', () => {
  const raw = [{ id: 'm1', menu_name: 'Soup', pricing: { base: 4 }, allergens: ['celery'] }];
  const mapped = [{ id: 'm1', menuName: 'Soup', price: 4, allergens: ['celery'], srvAt: 'x' }];
  const facts = [row('m1', { allergens: ['Celery', 'mustard'], kcal: 90 })];
  assert.deepEqual(mergeStockFacts(raw, facts)[0].allergens, ['celery', 'mustard']);
  assert.deepEqual(mergeStockFacts(mapped, facts)[0].allergens, ['celery', 'mustard']);
  assert.equal(mergeStockFacts(mapped, facts)[0].srvAt, 'x', 'every other field rides unchanged');
});

test('showCalories is the one venue key, and only a real true', () => {
  assert.equal(showCalories({ show_calories: true }), true);
  assert.equal(showCalories({ show_calories: 'true' }), false);
  assert.equal(showCalories({ show_calories: 1 }), false);
  assert.equal(showCalories({}), false);
  assert.equal(showCalories(null), false);
  assert.equal(showCalories('{"show_calories":true}'), false, 'a string is not settings');
});

test('kcalWords: whole numbers through the i18n key, English without it, nothing for no figure', () => {
  assert.equal(kcalWords(146.4, t), '146 kcal');
  assert.equal(kcalWords('146', t), '146 kcal');
  assert.equal(kcalWords(146, (k) => t(k, 'zh')), '146 千卡');
  assert.equal(kcalWords(0), '0 kcal');
  assert.equal(kcalWords(null), '');
  assert.equal(kcalWords(undefined, t), '');
  assert.equal(kcalWords('abc', t), '');
  assert.equal(kcalWords(-5, t), '');
  assert.equal(kcalWords(12, (k) => k), '12 kcal', 'a t that does not know the key still gives words');
  assert.equal(mayContainWords(['Milk', 'Nuts'], t), 'May contain: Milk, Nuts');
  assert.equal(mayContainWords(['Leche'], (k) => t(k, 'es')), 'Puede contener: Leche');
  assert.equal(mayContainWords([], t), '');
  assert.equal(mayContainWords(['Milk']), 'May contain: Milk');
});

test('the four i18n keys exist in English and in every other language block, with the same markers and no dashes', () => {
  assert.equal(KCAL_KEY, 'product.kcal');
  assert.equal(KCAL_NOTE_KEY, 'product.kcalNote');
  assert.equal(MAY_CONTAIN_KEY, 'product.mayContain');
  assert.equal(ALLERGEN_CHECK_KEY, 'product.allergenCheck');
  assert.equal(t(KCAL_NOTE_KEY, 'en'), KCAL_NOTE_EN);
  assert.equal(tf(KCAL_KEY, { n: 146 }, 'en'), '146 kcal');
  assert.equal(t(ALLERGEN_CHECK_KEY, 'en'), 'Allergens being checked, ask staff');
  const keys = [KCAL_KEY, KCAL_NOTE_KEY, MAY_CONTAIN_KEY, ALLERGEN_CHECK_KEY];
  const markers = (s) => (String(s).match(/\{[A-Za-z0-9]+\}/g) || []).sort().join();
  const langs = [...LANGUAGES.map((L) => L.code).filter((c) => c !== 'en'), ...RETIRED_LANGUAGES];
  for (const lang of langs) {
    for (const k of keys) {
      assert.ok(languageKeys(lang).includes(k), `${lang} ${k}`);
      assert.equal(markers(t(k, lang)), markers(t(k, 'en')), `${lang} ${k} markers`);
      assert.doesNotMatch(t(k, lang), /[\u2013\u2014]/, `${lang} ${k} dash`);
    }
  }
  assert.ok(englishKeys('product.').includes(KCAL_KEY));
  assert.equal(shared.KCAL_NOTE_KEY, KCAL_NOTE_KEY, 'the web file re exports the shared constants');
});

test('fetchMenuStockFacts pages past the row cap, filters by venue, and lists ids 200 at a time', async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => row(`m${String(i).padStart(4, '0')}`));
  rows.push({ ...row('x1'), location_id: 'OTHER' });
  const client = fakeClient(rows);
  const all = await fetchMenuStockFacts(client, 'L1');
  assert.equal(all.error, null);
  assert.equal(all.rows.length, 1205);
  assert.equal(client.calls.length, 2, 'two pages of 1,000');
  assert.ok(all.rows.every((r) => r.location_id === 'L1'));
  const ids = Array.from({ length: 450 }, (_, i) => `m${String(i).padStart(4, '0')}`);
  const some = await fetchMenuStockFacts(fakeClient(rows), 'L1', { ids });
  assert.equal(some.rows.length, 450);
  assert.equal(FACTS_IDS_CHUNK, 200);
  const c2 = fakeClient(rows);
  await fetchMenuStockFacts(c2, 'L1', { ids: ids.concat(ids) });
  assert.equal(c2.calls.length, 3, '450 distinct ids: three lists');
  assert.deepEqual(await fetchMenuStockFacts(fakeClient(rows), 'L1', { ids: [] }), { rows: [], error: null }, 'no ids: nothing to read');
  assert.equal(FACTS_TABLE, 'menu_item_stock_facts');
});

test('fetchMenuStockFacts: no client, the demo venue, a failed page, a missing table or a throw answer no rows and never throw', async () => {
  assert.deepEqual(await fetchMenuStockFacts(null, 'L1'), { rows: [], error: null });
  assert.deepEqual(await fetchMenuStockFacts(fakeClient([row('a')]), 'loc-demo'), { rows: [], error: null });
  assert.deepEqual(await fetchMenuStockFacts(fakeClient([row('a')]), null), { rows: [], error: null });
  const failed = await fetchMenuStockFacts(fakeClient([row('a')], { fail: true }), 'L1');
  assert.deepEqual(failed.rows, []);
  assert.ok(failed.error);
  const missing = await fetchMenuStockFacts(fakeClient([row('a')], { missing: true }), 'L1');
  assert.deepEqual(missing.rows, []);
  assert.match(String(missing.error.message), /does not exist/);
  const thrown = await fetchMenuStockFacts(fakeClient([row('a')], { throwOn: true }), 'L1');
  assert.deepEqual(thrown.rows, []);
  assert.equal(thrown.error.message, 'network gone');
});

test('withFacts: read then merge; a failed read or an empty venue gives the very same items back', async () => {
  const items = [{ id: 'a', allergens: ['Dairy'] }, { id: 'b', allergens: [] }];
  const merged = await withFacts(fakeClient([row('a', { allergens: ['nuts'], kcal: 200 })]), 'L1', items);
  assert.deepEqual(merged[0].allergens, ['Dairy', 'nuts']);
  assert.equal(merged[0].kcal, 200);
  assert.equal(merged[1], items[1]);
  assert.equal(await withFacts(fakeClient([]), 'L1', items), items);
  assert.equal(await withFacts(fakeClient([row('a')], { fail: true }), 'L1', items), items);
  assert.equal(await withFacts(fakeClient([row('a')], { throwOn: true }), 'L1', items), items);
  assert.equal(await withFacts(null, 'L1', items), items);
  const none = [];
  assert.equal(await withFacts(fakeClient([row('a')]), 'L1', none), none);
  assert.equal(await withFacts(fakeClient([row('a')]), 'L1', null), null);
});

test('the From the recipe panel words: allergens in the sheet order, kcal, Checked by or Not checked yet, Check again', () => {
  const checked = row('a', { allergens: ['nuts', 'Milk'], may_contain: ['soya'], kcal: 146.4, checked_at: '2026-10-17T10:00:00Z', checked_by_name: 'Jo', needs_check: false });
  const w = factsPanelWords(checked, { timeZone: 'UTC' });
  assert.deepEqual(w.allergens, ['milk', 'nuts']);
  assert.deepEqual(w.mayContain, ['soy']);
  assert.equal(w.kcal, '146 kcal');
  assert.equal(w.checked, 'Checked by Jo, 17 Oct');
  assert.equal(w.check, '');
  const waiting = factsPanelWords(row('b', { needs_check: true, check_words: 'Check again: Cheddar from Freshways changed 17 Oct' }));
  assert.equal(waiting.checked, 'Not checked yet');
  assert.equal(waiting.check, 'Check again: Cheddar from Freshways changed 17 Oct');
  assert.equal(factsPanelWords(row('c', { needs_check: true, check_words: 'the recipe no longer has milk' })).check, 'Check again: the recipe no longer has milk', 'the prefix is added once');
  assert.equal(factsPanelWords(row('d', { needs_check: true })).check, 'Check again: the recipe changed');
  assert.equal(factsPanelWords(row('e', { kcal: null })).kcal, '');
  assert.equal(factsPanelWords(null), null);
  assert.equal(factsCheckedWords({ checked_at: '2026-10-17T10:00:00Z', checked_by_name: '' }, { timeZone: 'UTC' }), 'Checked by someone, 17 Oct');
  assert.equal(factsCheckedWords({ checked_at: 'not a date', checked_by_name: 'Jo' }), 'Checked by Jo');
  assert.equal(factsCheckedWords({}), 'Not checked yet');
});

test('the shared merge file imports only the alias table, and the words carry no dashes', () => {
  const src = read('../../supabase/functions/_shared/menuStockFacts.js');
  const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./allergenIds.js']);
  assert.doesNotMatch(src, /[\u2013\u2014]/);
  assert.doesNotMatch(read('./menuStockFacts.js'), /[\u2013\u2014]/);
  assert.doesNotMatch(read('../../supabase/functions/_shared/allergenIds.js'), /[\u2013\u2014]/);
  assert.equal(read('../../supabase/functions/_shared/allergenIds.js').match(/^import /gm), null, 'the alias table has no imports');
});
