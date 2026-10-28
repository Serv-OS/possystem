// v5.11.108 (28 Oct 2026, Peter: "update the allergens so they show up the same on kiosk and on
// online ordering and QR etc so the UI is the same"). The chip row is tested on its own
// (allergenChips.test.js); unit tests do not catch wiring, so these pin that every place a guest
// or a member of staff sees an item USES it, fed from the allergen field (never the description),
// with its surface's theme palette, and that the old per surface markup is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const between = (src, a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `found ${a}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j > i, `found the end of ${a}`);
  return src.slice(i, j);
};
const IMPORT = /import AllergenChips, \{[^}]*\} from '(\.\.\/)+components\/AllergenChips\.js';|import AllergenChips, \{[^}]*\} from '\.\/AllergenChips\.js';/;

const SURFACES = {
  'online and QR menu cards': '../surfaces/online/OnlineSurface.jsx',
  'online and QR product sheet': '../surfaces/online/OnlineItemSheet.jsx',
  'catering menu cards': '../surfaces/catering/CateringSurface.jsx',
  'kiosk (new design) item card': '../surfaces/kiosk/KioskItemCard.jsx',
  'kiosk (new design) item sheet': '../surfaces/kiosk/KioskItemSheet.jsx',
  'kiosk (current design) menu card': '../surfaces/KioskApp.jsx',
  'kiosk (current design) item screen': '../surfaces/KioskProductModal.jsx',
  'till product modal': '../components/ProductModal.jsx',
  'till item info': '../components/ItemInfoModal.jsx',
};

test('every surface imports and renders the one shared chip row', () => {
  for (const [name, file] of Object.entries(SURFACES)) {
    const src = read(file);
    assert.match(src, IMPORT, `${name} imports AllergenChips`);
    assert.match(src, /<AllergenChips\s/, `${name} renders AllergenChips`);
  }
});

test('each surface passes its own theme palette (never a colour of its own)', () => {
  for (const file of ['../surfaces/online/OnlineSurface.jsx', '../surfaces/online/OnlineItemSheet.jsx', '../surfaces/catering/CateringSurface.jsx']) {
    for (const m of read(file).matchAll(/<AllergenChips [^>]*\/>/g)) assert.match(m[0], /palette=\{(allergenPaletteFromTheme\(theme\)|chipPalette)\}/, `${file}: ${m[0]}`);
  }
  for (const file of ['../surfaces/kiosk/KioskItemCard.jsx', '../surfaces/kiosk/KioskItemSheet.jsx', '../surfaces/KioskApp.jsx', '../surfaces/KioskProductModal.jsx']) {
    for (const m of read(file).matchAll(/<AllergenChips [^>]*\/>/g)) assert.match(m[0], /palette=\{KIOSK_ALLERGEN_PALETTE\}/, `${file}: ${m[0]}`);
  }
  for (const file of ['../components/ProductModal.jsx', '../components/ItemInfoModal.jsx']) {
    for (const m of read(file).matchAll(/<AllergenChips [^>]*\/>/g)) assert.match(m[0], /palette=\{TILL_ALLERGEN_PALETTE\}/, `${file}: ${m[0]}`);
  }
  const sheet = read('../surfaces/online/OnlineItemSheet.jsx');
  assert.match(sheet, /const chipPalette = allergenPaletteFromTheme\(theme\);/);
});

test('the online and QR card shows the allergen FIELD under the description, not a count or description words', () => {
  const card = between(read('../surfaces/online/OnlineSurface.jsx'), 'function ItemCard(', '\n}\n');
  assert.match(card, /const chipIds = \[\.\.\.itemAllergenIds\(item\), \.\.\.\(marked \? unsafe : \[\]\)\];/);
  assert.match(card, /<AllergenChips ids=\{chipIds\} size="card" active=\{marked \? unsafe : null\}/);
  const desc = card.indexOf('tItemDescription(item)}');
  const chips = card.indexOf('<AllergenChips');
  assert.ok(desc > 0 && chips > desc, 'the chips sit under the description');
  assert.doesNotMatch(card, /allergens\.length === 1|`\$\{allergens\.length\} allergens`/, 'no "3 allergens" pill');
  assert.doesNotMatch(card, /Contains \{unsafe\.join/, 'no separate Contains line');
  assert.doesNotMatch(card, /#fde6e6|#991b1b|#b91c1c/, 'no literal reds');
  // The chips never read the description.
  assert.doesNotMatch(card.slice(chips, card.indexOf('/>', chips)), /description/i);
});

test('the product sheet shows item + size + picked options, under the description, in theme colours', () => {
  const sheet = read('../surfaces/online/OnlineItemSheet.jsx');
  assert.match(sheet, /const shownIds = shownAllergenIds\(\{/);
  assert.match(sheet, /optionLists: pickedOpts\.map\(o => optionAllergenList\(o, rowById\(resolveOptItemId\(o\)\)\)\)/);
  assert.match(sheet, /<AllergenChips ids=\{shownIds\} size="detail" active=\{avoidAllergens\} palette=\{chipPalette\}\/>/);
  const body = between(sheet, '{tItemDescription(item) && (\n            <div style={{ fontSize: 14', '{/* Variant picker');
  assert.ok(body.indexOf('<AllergenChips') > body.indexOf('{tItemDescription(item)}'), 'under the description');
  assert.doesNotMatch(sheet, /#fde6e6|#fcaeae|#7f1d1d|#fee2e2/, 'the old pink boxes are gone');
  const variantRow = between(sheet, 'function VariantRow(', '\n}\n');
  assert.match(variantRow, /<AllergenChips ids=\{variant\.allergens\} size="card"/);
});

test('both kiosk designs read the same picked option list and show the chips on cards and sheets', () => {
  const v2sheet = read('../surfaces/kiosk/KioskItemSheet.jsx');
  assert.match(v2sheet, /kioskPickedOptionIds\(\{ groups, selections, nestedSelections, subGroupsCache, resolveOpt \}\)/);
  assert.match(v2sheet, /<AllergenChips ids=\{shownIds\} size="detail" active=\{avoidAllergens\}/);
  assert.doesNotMatch(v2sheet, /k2\.sheet\.allergens/, 'the old "Allergens: a, b" line is gone');
  const legacy = read('../surfaces/KioskProductModal.jsx');
  assert.match(legacy, /optionLists: \[kioskPickedOptionIds\(\{ groups, selections, nestedSelections, subGroupsCache, resolveOpt \}\)\]/);
  assert.match(legacy, /<AllergenChips ids=\{shownIds\} size="detail" active=\{avoidAllergens\}/);
  assert.doesNotMatch(legacy, /item\.allergens\.join\(', '\)|effective\.allergens\.join|subEffective\.allergens\.join/, 'no comma lists left');
  const v2card = read('../surfaces/kiosk/KioskItemCard.jsx');
  assert.match(v2card, /<AllergenChips ids=\{item\.allergens\} size="card" active=\{avoid\}/);
  assert.match(read('../surfaces/kiosk/KioskMenuScreen.jsx'), /avoid=\{allergenFilter\}/);
  const legacyCard = between(read('../surfaces/KioskApp.jsx'), 'function MenuItemCard(', '\n}\n');
  assert.match(legacyCard, /<AllergenChips ids=\{item\.allergens\} size="card" active=\{allergenFilter\}/);
});

test('the till modals use the chips; the guest allergen filter still decides the warning', () => {
  const pm = read('../components/ProductModal.jsx');
  const shell = between(pm, 'function ModalShellWrapper(', '\n}\n');
  assert.match(shell, /<AllergenChips ids=\{item\.allergens\} size="detail" active=\{activeAllergens\}/);
  assert.match(shell, /const flagged = \(item\.allergens \|\| \[\]\)\.filter\(a => activeAllergens\.includes\(a\)\);/, 'the add warning is unchanged');
  assert.doesNotMatch(shell, /al\?\.icon/, 'no letter icons');
  const info = read('../components/ItemInfoModal.jsx');
  assert.match(info, /const allergenList = allergenChipIds\(item\.allergens\);/);
  assert.match(info, /<AllergenChips ids=\{allergenList\} size="detail" heading=\{false\}/);
  assert.doesNotMatch(info, /a\.icon/, 'no letter icons');
});
