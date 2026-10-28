// v5.11.108 (28 Oct 2026, Peter: "update the allergens so they show up the same on kiosk and on
// online ordering and QR etc so the UI is the same"). The one chip row, src/components/AllergenChips.js,
// rendered as the browser renders it, and the pure list it is fed (lib/kioskAllergens.js): the item,
// its picked size and every picked option, without repeats, in the kiosk's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AllergenChips, {
  allergenChipIds, allergenChipLabels, allergenPaletteFromTheme, withAlpha,
  KIOSK_ALLERGEN_PALETTE, TILL_ALLERGEN_PALETTE, ALLERGEN_MARK,
} from '../components/AllergenChips.js';
import { shownAllergenIds, optionAllergenList, kioskPickedOptionIds } from './kioskAllergens.js';

const render = (props) => renderToStaticMarkup(createElement(AllergenChips, props));
const words = (html) => [...html.matchAll(/<span>([^<]*)<\/span><\/span>/g)].map((m) => m[1]);

test('nothing to show renders nothing', () => {
  for (const ids of [undefined, null, [], [''], [null]]) assert.equal(render({ ids }), '', String(ids));
});

test('words in the kiosk wording and the kiosk order, older spellings read as the 14, no repeats', () => {
  const html = render({ ids: ['Soya', 'dairy', 'gluten', 'tree nuts', 'Milk', 'oats'] });
  assert.deepEqual(words(html), ['Gluten', 'Milk', 'Tree nuts', 'Soy', 'Oats']);
  assert.deepEqual(allergenChipIds(['Soya', 'dairy', 'gluten']), ['gluten', 'milk', 'soy']);
  assert.deepEqual(allergenChipLabels(['nuts']).map((r) => r.label), ['Tree nuts']);
  assert.match(html, /aria-label="Allergens: Gluten, Milk, Tree nuts, Soy, Oats"/);
});

test('each chip is a small warning mark and the word, never an icon picture', () => {
  const html = render({ ids: ['milk'] });
  assert.ok(html.includes(`>${ALLERGEN_MARK}</span>`), 'the mark is text');
  assert.doesNotMatch(html, /<svg|<img/);
  assert.match(html, /data-allergen="milk"/);
});

test('chips wrap and are never cut off', () => {
  const html = render({ ids: ['gluten', 'milk', 'eggs', 'fish', 'crustaceans', 'nuts', 'peanuts', 'soy', 'sesame', 'celery', 'mustard', 'sulphites', 'molluscs', 'lupin'] });
  assert.equal(words(html).length, 14);
  assert.match(html, /flex-wrap:wrap/);
  assert.doesNotMatch(html, /line-clamp|text-overflow|ellipsis|overflow:hidden/);
});

test('card has no heading; detail has the word Allergens above the chips (or none when asked)', () => {
  assert.doesNotMatch(render({ ids: ['milk'], size: 'card' }), />Allergens</);
  assert.match(render({ ids: ['milk'], size: 'detail' }), /aria-hidden="true"[^>]*>Allergens<\/span>/);
  assert.doesNotMatch(render({ ids: ['milk'], size: 'detail', heading: false }), />Allergens<\/span>/);
  assert.match(render({ ids: ['milk'], size: 'card' }), /data-allergen-chips="card"/);
  assert.match(render({ ids: ['milk'], size: 'detail' }), /data-allergen-chips="detail"/);
});

test('active allergens stand out, from a Set or an array, any spelling; they never add a chip', () => {
  const html = render({ ids: ['milk', 'gluten'], active: new Set(['Dairy', 'fish']), palette: TILL_ALLERGEN_PALETTE });
  assert.match(html, /data-allergen="milk" data-hot="true"/);
  assert.doesNotMatch(html, /data-allergen="gluten" data-hot/);
  assert.doesNotMatch(html, /data-allergen="fish"/);
  assert.match(html, /background:var\(--red-d\)/);
  assert.match(render({ ids: ['milk'], active: ['milk'] }), /data-hot="true"/);
});

test('colours come only from the palette the surface passes (venue theme tokens)', () => {
  const kiosk = render({ ids: ['milk'], palette: KIOSK_ALLERGEN_PALETTE });
  assert.match(kiosk, /color:var\(--kAllergen-fg\)/);
  assert.match(kiosk, /background:var\(--kAllergen-bg\)/);
  const till = render({ ids: ['milk'], palette: TILL_ALLERGEN_PALETTE });
  assert.match(till, /color:var\(--t2\)/);
  // Online and QR: the venue Appearance theme. Light and dark both read: text is the venue's own
  // foreground, a highlighted chip is the venue's background on its foreground.
  for (const theme of [{ fg: '#1a1a1a', bg: '#ffffff', accent: '#e8a020' }, { fg: '#f4f4f4', bg: '#101010', accent: '#15C26A' }]) {
    const pal = allergenPaletteFromTheme(theme);
    assert.equal(pal.fg, theme.fg);
    assert.equal(pal.hotFg, theme.bg);
    assert.equal(pal.hotBg, theme.fg);
    assert.equal(pal.mark, theme.accent);
    const html = render({ ids: ['milk', 'eggs'], active: ['eggs'], palette: pal });
    const colours = [...html.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase());
    for (const c of colours) assert.ok([theme.fg, theme.bg, theme.accent].map((x) => x.toLowerCase()).includes(c), `${c} comes from the theme`);
  }
  assert.equal(withAlpha('#fff', 0.5), 'rgba(255,255,255,0.5)');
  assert.equal(withAlpha('#1a1a1a', 0.06), 'rgba(26,26,26,0.06)');
  assert.equal(withAlpha('rebeccapurple', 0.2), 'color-mix(in srgb, rebeccapurple 20%, transparent)');
});

test('the surface sets the scale', () => {
  assert.match(render({ ids: ['milk'], fontSize: 19 }), /font-size:19px/);
  assert.match(render({ ids: ['milk'], fontSize: 'clamp(11px, 1.3vw, 14px)' }), /font-size:clamp\(11px, 1.3vw, 14px\)/);
  assert.match(render({ ids: ['milk'] }), /font-size:11px/);
  assert.match(render({ ids: ['milk'], size: 'detail' }), /font-size:13px/);
});

test('a translate function gives the words in the guest language', () => {
  const tr = (k) => ({ 'k2.allergen.milk': 'Leche', 'product.allergens': 'Alérgenos' }[k] || k);
  const html = render({ ids: ['milk'], size: 'detail', translate: tr });
  assert.deepEqual(words(html), ['Leche']);
  assert.match(html, /aria-label="Alérgenos: Leche"/);
});

// ── The list a product screen shows: item + size + every picked option ─────────────────────

test('shownAllergenIds: the union of the item, its picked size and the picked options, in order', () => {
  const item = { allergens: ['gluten'] };
  const size = { allergens: ['Milk'] };
  assert.deepEqual(shownAllergenIds({ item }), ['gluten']);
  assert.deepEqual(shownAllergenIds({ item, size }), ['gluten', 'milk']);
  // Oat milk (own list) and a nut topping (its linked item) add theirs; repeats fold.
  const oat = optionAllergenList({ name: 'Oat milk', allergens: ['oats', 'gluten'] });
  const nuts = optionAllergenList({ name: 'Hazelnut', allergens: [] }, { allergens: ['tree nuts'] });
  assert.deepEqual(shownAllergenIds({ item, size, optionLists: [oat, nuts] }), ['gluten', 'milk', 'nuts', 'oats']);
  assert.deepEqual(shownAllergenIds({ item: { allergens: [] }, optionLists: [['dairy'], ['milk']] }), ['milk']);
  assert.deepEqual(shownAllergenIds(), []);
  assert.deepEqual(shownAllergenIds({ item: null, size: null, optionLists: null }), []);
});

test('optionAllergenList: the option\'s own list wins, else the linked item, else nothing', () => {
  assert.deepEqual(optionAllergenList({ allergens: ['milk'] }, { allergens: ['eggs'] }), ['milk']);
  assert.deepEqual(optionAllergenList({ allergens: [] }, { allergens: ['eggs'] }), ['eggs']);
  assert.deepEqual(optionAllergenList({}, null), []);
  assert.deepEqual(optionAllergenList(null, undefined), []);
});

test('kioskPickedOptionIds: picked options and nested picks, the size group left out', () => {
  const groups = [
    { id: 'size', __isVariantGroup: true, options: [{ id: 's1', allergens: ['fish'] }] },
    { id: 'g1', options: [{ id: 'o1', allergens: ['milk'] }, { id: 'o2', allergens: ['eggs'], subGroupId: 'sub' }, { id: 'o3', allergens: ['celery'] }] },
  ];
  const subGroupsCache = { sub: { id: 'sub', options: [{ id: 'n1', allergens: ['Sesame'] }] } };
  const selections = { size: ['s1'], g1: ['o1', 'o2'] };
  const nestedSelections = { 'g1:o2:0': { sub: ['n1'] } };
  const resolveOpt = (o) => ({ allergens: o.allergens });
  assert.deepEqual(kioskPickedOptionIds({ groups, selections, nestedSelections, subGroupsCache, resolveOpt }), ['milk', 'eggs', 'sesame']);
  assert.deepEqual(kioskPickedOptionIds({ groups, selections: {}, resolveOpt }), []);
  assert.deepEqual(kioskPickedOptionIds(), []);
});
