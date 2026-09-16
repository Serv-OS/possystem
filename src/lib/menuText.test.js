// The venue's menu text in the customer's language on the new kiosk design (lib/menuText.js):
// lookups with English fallback, and the basket line rebuilt with translated choices.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setMenuTranslations, clearMenuTranslations, menuTranslationsActive, menuTranslationLang,
  itemName, itemDescription, categoryLabel, groupName, optionName, translateEnglish, lineChoices,
} from './menuText.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const PIZZA = { id: 'm-1', name: 'Pepperoni', menu_name: null, description: 'Tomato, mozzarella' };
const LARGE = { id: 'm-1-L', name: 'Large', parent_id: 'm-1' };
const CAT = { id: 'cat-1', label: 'Sourdough Pizza' };
const MILK = { id: 'mg-1', name: 'Milk', options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.4 }, { id: 'opt-soy', name: 'Soy milk' }] };
const SIZE = { id: '__variants__', name: 'Size', __isVariantGroup: true, options: [{ id: 'm-1-L', name: 'Large', itemId: 'm-1-L' }] };
// The sheet gives instruction groups the kiosk's '__instr__' prefix (kioskOptionGroups.js).
const COOK = { id: '__instr__igd-cook', name: 'Cooking preference', __isInstructionGroup: true, options: [{ id: 'instr-igd-cook-0', name: 'Medium rare' }] };

const ROWS = [
  { entity_type: 'item', entity_id: 'm-1', text: { name: 'Pepperoni', description: 'Tomate, mozzarella', en: 'Pepperoni' } },
  { entity_type: 'item', entity_id: 'm-1-L', text: { name: 'Grande', en: 'Large' } },
  { entity_type: 'category', entity_id: 'cat-1', text: { name: 'Pizza de masa madre', en: 'Sourdough Pizza' } },
  { entity_type: 'modifier_group', entity_id: 'mg-1', text: { name: 'Leche', en: 'Milk' } },
  { entity_type: 'modifier_option', entity_id: 'opt-oat', text: { name: 'Leche de avena', en: 'Oat milk', group: 'Milk' } },
  // Two options called Hot in two groups, and a group called Size next to a size called Size
  { entity_type: 'modifier_option', entity_id: 'opt-hot-sauce', text: { name: 'Picante', en: 'Hot', group: 'Sauce' } },
  { entity_type: 'modifier_option', entity_id: 'opt-hot-temp', text: { name: 'Caliente', en: 'Hot', group: 'Serving temperature' } },
  { entity_type: 'modifier_group', entity_id: 'mg-size', text: { name: 'Tamaño (grupo)', en: 'Size' } },
  { entity_type: 'modifier_option', entity_id: 'opt-size', text: { name: 'Tamaño', en: 'Size', group: 'Extras' } },
  { entity_type: 'instruction_group', entity_id: 'igd-cook', text: { name: 'Punto de cocción', en: 'Cooking preference' } },
  { entity_type: 'instruction_option', entity_id: 'igd-cook|Medium rare', text: { name: 'Poco hecha', en: 'Medium rare', group: 'Cooking preference' } },
  { entity_type: 'item', entity_id: 'm-blank', text: { name: '   ' } },
];

test('with no rows every lookup gives the English', () => {
  clearMenuTranslations();
  assert.equal(menuTranslationsActive(), false);
  assert.equal(menuTranslationLang(), 'en');
  assert.equal(itemName(PIZZA), 'Pepperoni');
  assert.equal(itemDescription(PIZZA), 'Tomato, mozzarella');
  assert.equal(categoryLabel(CAT), 'Sourdough Pizza');
  assert.equal(groupName(MILK), 'Milk');
  assert.equal(optionName(MILK, MILK.options[0]), 'Oat milk');
  assert.equal(optionName(SIZE, SIZE.options[0]), 'Large');
  assert.equal(optionName(COOK, COOK.options[0]), 'Medium rare');
  assert.equal(translateEnglish('Oat milk'), 'Oat milk');
  assert.equal(itemName(null), '');
  assert.equal(itemDescription({ id: 'x' }), '');
});

test('with rows loaded the customer sees their language, and the English where a row is missing', () => {
  setMenuTranslations('es', ROWS);
  assert.equal(menuTranslationsActive(), true);
  assert.equal(menuTranslationLang(), 'es');
  assert.equal(itemName(PIZZA), 'Pepperoni');
  assert.equal(itemDescription(PIZZA), 'Tomate, mozzarella');
  assert.equal(itemName(LARGE), 'Grande');
  assert.equal(categoryLabel(CAT), 'Pizza de masa madre');
  assert.equal(groupName(MILK), 'Leche');
  assert.equal(groupName(COOK), 'Punto de cocción');
  assert.equal(optionName(MILK, MILK.options[0]), 'Leche de avena');
  assert.equal(optionName(MILK, MILK.options[1]), 'Soy milk', 'no row: English');
  assert.equal(optionName(SIZE, SIZE.options[0]), 'Grande', 'a size is the item it points at');
  assert.equal(optionName(COOK, COOK.options[0]), 'Poco hecha');
  // The menu name wins in English too, so the fallback matches the card
  assert.equal(itemName({ id: 'm-9', name: 'Cola', menu_name: 'Pepsi Max' }), 'Pepsi Max');
  // A blank translation is ignored
  assert.equal(itemName({ id: 'm-blank', name: 'Blank' }), 'Blank');
  // English text the kiosk only has as text (basket labels) goes through the English index
  assert.equal(translateEnglish('Oat milk'), 'Leche de avena');
  assert.equal(translateEnglish('oat MILK '), 'Leche de avena');
  assert.equal(translateEnglish('Medium rare'), 'Poco hecha');
  assert.equal(translateEnglish('Nothing known'), 'Nothing known');
  assert.equal(translateEnglish(''), '');
  // The group tells two options called Hot apart; without it the first option wins
  assert.equal(translateEnglish('Hot', 'Sauce'), 'Picante');
  assert.equal(translateEnglish('Hot', 'Serving temperature'), 'Caliente');
  assert.equal(translateEnglish('Hot', 'No such group'), 'Picante');
  // An option beats a group of the same English name in the plain index
  assert.equal(translateEnglish('Size'), 'Tamaño');
});

test('the basket line: English unchanged without rows, choices translated with them', () => {
  const line = {
    item: PIZZA, variant: { id: 'm-1-L', lineName: 'Pepperoni — Large' }, name: 'Pepperoni', qty: 1,
    mods: 'Large · Oat milk ×2, Soy milk · Medium rare · Hot · Note: no basil', instructions: 'no basil',
    modsArray: [
      { label: 'Oat milk', price: 0.4, groupLabel: 'Milk' },
      { label: 'Soy milk', price: 0.4, groupLabel: 'Milk' },
      { label: 'Oat milk', price: 0.4, groupLabel: 'Milk' },   // picked again later: still ×2
      { label: 'Medium rare', price: 0, groupLabel: 'Cooking preference', _instruction: true },
      { label: 'Hot', price: 0, groupLabel: 'Serving temperature' },
      { label: 'Rainbow', price: 0.1, groupLabel: 'Chocolate dust → Sprinkle' },
      { label: 'no basil', price: 0, groupLabel: 'Note', _instruction: true },
    ],
  };
  clearMenuTranslations();
  assert.equal(lineChoices(line), 'Large · Oat milk ×2, Soy milk · Medium rare · Hot');
  setMenuTranslations('es', ROWS);
  assert.equal(lineChoices(line), 'Grande · Leche de avena ×2 · Soy milk · Poco hecha · Caliente · Chocolate dust: Rainbow');
  // A venue's own group called Note keeps its picks; only the typed note is left to k2.line.note
  const noteGroup = { item: PIZZA, mods: 'No ice · Note: hot', instructions: 'hot', modsArray: [
    { label: 'No ice', price: 0, groupLabel: 'Note', _instruction: true },
    { label: 'hot', price: 0, groupLabel: 'Note', _instruction: true },
  ] };
  assert.equal(lineChoices(noteGroup), 'No ice');
  // A line with no size and no choices
  assert.equal(lineChoices({ item: PIZZA, mods: '', modsArray: [] }), '');
  assert.equal(lineChoices({ item: PIZZA, mods: 'Note: hot', instructions: 'hot', modsArray: [{ label: 'hot', groupLabel: 'Note', _instruction: true }] }), '');
  clearMenuTranslations();
});

test('what is saved never goes through these lookups', () => {
  // kioskOrderItem (the order line) reads line.name and line.modsArray, both English.
  const src = fs.readFileSync(path.join(here, 'kioskLine.js'), 'utf8');
  assert.ok(!src.includes('menuText'));
  const app = fs.readFileSync(path.join(here, '../surfaces/KioskApp.jsx'), 'utf8');
  assert.ok(!app.includes('menuText'), 'the engine (cart, order) never imports the translations');
});
