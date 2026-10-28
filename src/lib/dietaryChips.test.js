// v5.11.110 (28 Oct 2026, Peter: "I have just made a product on Habitum with Vegetarian and vegan
// dietary but the icons have not shown on either the online ordering or kiosk"). The kiosk had no
// dietary rendering at all. The one chip row, src/components/DietaryChips.js, rendered as the
// browser renders it, and the wiring: both kiosk designs, cards and item screens, use it, fed from
// the dietary FIELD, with the kiosk theme tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DietaryChips, { dietaryChipCodes, dietaryChipLabels, KIOSK_DIET_PALETTE } from '../components/DietaryChips.js';
import { t, englishKeys, setLang } from './i18n.js';

const render = (props) => renderToStaticMarkup(createElement(DietaryChips, props));
const words = (html) => [...html.matchAll(/data-diet="[A-Z]+"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('nothing to show renders nothing', () => {
  for (const item of [undefined, null, {}, { tags: [] }, { tags: ['spicy'] }, { tags: null }]) assert.equal(render({ item }), '', JSON.stringify(item));
});

test('the Habitum case: tags vegetarian and vegan become the words Vegetarian and Vegan', () => {
  const html = render({ item: { tags: ['vegetarian', 'vegan'] } });
  assert.deepEqual(words(html), ['Vegetarian', 'Vegan']);
  assert.match(html, /aria-label="Vegetarian, Vegan"/);
  assert.doesNotMatch(html, /<svg|<img/, 'words, never an icon picture');
});

test('every spelling the menu builder saves maps to a word, no repeats, in badge order', () => {
  assert.deepEqual(dietaryChipCodes({ tags: ['vg', 'vegan', 'Gluten-Free', 'df', 'veg'] }), ['VG', 'GF', 'DF', 'V']);
  assert.deepEqual(dietaryChipLabels({ tags: ['gf', 'df'] }).map((r) => r.label), ['Gluten free', 'Dairy free']);
});

test('a picked size with its own tags wins; a size with none shows the item\'s', () => {
  assert.deepEqual(dietaryChipCodes({ tags: ['vegan'] }, { tags: ['vegetarian'] }), ['VG']);
  assert.deepEqual(dietaryChipCodes({ tags: [] }, { tags: ['vegetarian'] }), ['V']);
  assert.deepEqual(dietaryChipCodes(null, { tags: ['gf'] }), ['GF']);
});

test('chips wrap and are never cut off; card and detail sizes are marked', () => {
  const html = render({ item: { tags: ['gf', 'v', 'vg', 'df'] }, size: 'detail' });
  assert.equal(words(html).length, 4);
  assert.match(html, /flex-wrap:wrap/);
  assert.doesNotMatch(html, /line-clamp|text-overflow|ellipsis|overflow:hidden/);
  assert.match(html, /data-dietary-chips="detail"/);
  assert.match(render({ item: { tags: ['v'] } }), /data-dietary-chips="card"/);
});

test('colours come only from the kiosk theme tokens', () => {
  const html = render({ item: { tags: ['v'] }, palette: KIOSK_DIET_PALETTE });
  assert.match(html, /color:var\(--kDiet-fg\)/);
  assert.match(html, /background:var\(--kDiet-bg\)/);
  assert.match(html, /border:1px solid var\(--kDiet-border\)/);
  assert.doesNotMatch(html, /#[0-9a-f]{3,8}\b/i, 'no colour of its own');
  const css = read('../styles/globals.css');
  for (const theme of ['dark', 'light', 'design']) {
    const block = css.slice(css.indexOf(`[data-kiosk-theme="${theme}"] {`), css.indexOf('}', css.indexOf(`[data-kiosk-theme="${theme}"] {`)));
    for (const tok of ['--kDiet-bg', '--kDiet-border', '--kDiet-fg']) assert.match(block, new RegExp(`${tok}:`), `${theme} defines ${tok}`);
  }
});

test('the words follow the kiosk language, with English when a language has none', () => {
  assert.deepEqual(englishKeys('diet.').sort(), ['diet.DF', 'diet.GF', 'diet.V', 'diet.VG']);
  const es = (key) => t(key, 'es');
  assert.deepEqual(dietaryChipLabels({ tags: ['vegan', 'gf'] }, null, es).map((r) => r.label), ['Vegano', 'Sin gluten']);
  const none = (key) => key;   // a translate that knows nothing
  assert.deepEqual(dietaryChipLabels({ tags: ['vegan'] }, null, none).map((r) => r.label), ['Vegan']);
  assert.equal(typeof setLang, 'function');
});

const SURFACES = {
  'kiosk (new design) item card': '../surfaces/kiosk/KioskItemCard.jsx',
  'kiosk (new design) item sheet': '../surfaces/kiosk/KioskItemSheet.jsx',
  'kiosk (current design) menu card': '../surfaces/KioskApp.jsx',
  'kiosk (current design) item screen': '../surfaces/KioskProductModal.jsx',
};

test('both kiosk designs, cards and item screens, render the one shared dietary row with the kiosk palette', () => {
  for (const [name, file] of Object.entries(SURFACES)) {
    const src = read(file);
    assert.match(src, /import DietaryChips, \{ KIOSK_DIET_PALETTE \} from '(\.\.\/)+components\/DietaryChips\.js';/, `${name} imports DietaryChips`);
    const uses = [...src.matchAll(/<DietaryChips [\s\S]*?\/>/g)].map((m) => m[0]);
    assert.ok(uses.length >= 1, `${name} renders DietaryChips`);
    for (const u of uses) assert.match(u, /palette=\{KIOSK_DIET_PALETTE\}/, `${name}: ${u}`);
  }
  // Item screens: the picked size first, the item as fallback.
  for (const file of ['../surfaces/kiosk/KioskItemSheet.jsx', '../surfaces/KioskProductModal.jsx']) {
    assert.match(read(file), /<DietaryChips item=\{pickedVariantOpt \? [^}]*\} fallback=\{item\} size="detail"/, file);
  }
  // Cards: next to the allergen chips.
  for (const file of ['../surfaces/kiosk/KioskItemCard.jsx', '../surfaces/KioskApp.jsx']) {
    const src = read(file);
    const a = src.indexOf('<AllergenChips ids={item.allergens} size="card"');
    const d = src.indexOf('<DietaryChips item={item} size="card"');
    assert.ok(a > 0 && d > a && d - a < 400, `${file}: the dietary row sits by the allergen row`);
  }
});
