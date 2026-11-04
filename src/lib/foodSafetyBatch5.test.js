// 5.12.57 (US basics, batch 5: food safety and food law). A US venue reads the FDA Food Code
// (°F, 41/135/165, cooling in 2 + 4 hours), the 9 major food allergens, the FDA calorie line and
// US ID types; a UK venue reads and behaves exactly as before. ID numbers: last 4 only, everywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TYPE_DEFAULTS, US_TYPE_DEFAULTS, typeDefaultsFor, typeDefault, defaultTempUnit,
  cToF, fToC, displayTemp, toStoredC, breach, inRange,
} from './ops/temp.js';
import {
  foodLawWords, FOOD_LAW_WORDS, allergenOptionsFor, allergenLabelFor, US_MAJOR_ALLERGEN_IDS, US_EXTRA_ALLERGEN_IDS,
  idTypesFor, idLast4, maskIdNumber,
} from './foodLaw.js';
import { ALLERGENS } from '../data/seed.js';
import { UK_ALLERGENS, normaliseAllergenId, sheetAllergenIds, kioskAllergenLabels, allergenNameFor } from './kioskAllergens.js';
import { allergenChipLabels } from '../components/AllergenChips.js';
import { allergenWords as labelAllergenWords } from './stock/batchLabel.js';
import { allergenChipsFor, ALLERGEN_CHIPS, nutritionFieldsFor, NUTRITION_FIELDS } from './stock/factsRules.js';
import { kcalWords as kcalWordsShared, kcalNoteFor, KCAL_NOTE_EN, KCAL_NOTE_US, KCAL_NOTE_KEY } from '../../supabase/functions/_shared/menuStockFacts.js';
import { kcalWords, kcalNote } from './menuStockFacts.js';
import { t } from './i18n.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const F = (c) => displayTemp(c, 'F').value;
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── temperatures ───────────────────────────────────────────────────────────
test('US defaults are the FDA Food Code numbers, shown in °F', () => {
  const us = typeDefaultsFor('US');
  assert.equal(us, US_TYPE_DEFAULTS);
  assert.equal(F(us.fridge.max), 41);
  assert.equal(F(us.cold_hold.max), 41);
  assert.equal(F(us.hot_hold.min), 135);
  assert.equal(F(us.cooking.min), 165);
  assert.equal(F(us.freezer.max), 0);
  assert.equal(F(us.chill_down.max), 41);
  assert.equal(F(us.delivery.max), 41);
  assert.match(us.chill_down.guidance, /135°F to 70°F within 2 hours, then to 41°F or below within the next 4 hours/);
  assert.match(us.delivery.guidance, /41°F, reject above 45°F/);
  assert.match(us.cooking.guidance, /165°F/);
  assert.equal(defaultTempUnit('US'), 'F');
  assert.equal(defaultTempUnit('UK'), 'C');
  assert.equal(defaultTempUnit('IE'), 'C');
  // same types and labels as the UK, so the type picker and the floor read the same list
  assert.deepEqual(Object.keys(us), Object.keys(TYPE_DEFAULTS));
  for (const k of Object.keys(us)) assert.equal(us[k].label, TYPE_DEFAULTS[k].label);
});

test('°C and °F convert both ways (41°F = 5°C, 135°F = 57.2°C)', () => {
  near(fToC(41), 5);
  near(cToF(5), 41);
  assert.equal(displayTemp(fToC(135), 'C').value, 57.2);
  near(cToF(fToC(135)), 135);
  near(toStoredC('41', 'F'), 5);
  assert.equal(displayTemp(toStoredC('135', 'F'), 'F').label, '135°F');
  assert.equal(displayTemp(5, 'F').label, '41°F');
});

test('US limits survive the 2 decimal column: a reading exactly at the limit is in range', () => {
  const us = US_TYPE_DEFAULTS;
  for (const v of Object.values(us)) {
    assert.equal(Math.round(v.min * 100) / 100, v.min);
    assert.equal(Math.round(v.max * 100) / 100, v.max);
  }
  assert.equal(inRange(toStoredC('0', 'F'), us.freezer.min, us.freezer.max), true);
  assert.equal(inRange(toStoredC('41', 'F'), us.fridge.min, us.fridge.max), true);
  assert.equal(inRange(toStoredC('135', 'F'), us.hot_hold.min, us.hot_hold.max), true);
  assert.equal(inRange(toStoredC('165', 'F'), us.cooking.min, us.cooking.max), true);
  assert.equal(inRange(toStoredC('134', 'F'), us.hot_hold.min, us.hot_hold.max), false);
});

test('a UK venue keeps the FSA defaults, word for word', () => {
  assert.equal(typeDefaultsFor('UK'), TYPE_DEFAULTS);
  assert.equal(typeDefaultsFor('IE'), TYPE_DEFAULTS);
  assert.equal(typeDefaultsFor(undefined), TYPE_DEFAULTS);
  assert.deepEqual([TYPE_DEFAULTS.fridge.min, TYPE_DEFAULTS.fridge.max], [1, 5]);
  assert.deepEqual([TYPE_DEFAULTS.cold_hold.min, TYPE_DEFAULTS.cold_hold.max], [0, 8]);
  assert.deepEqual([TYPE_DEFAULTS.hot_hold.min, TYPE_DEFAULTS.hot_hold.max], [63, 90]);
  assert.deepEqual([TYPE_DEFAULTS.delivery.min, TYPE_DEFAULTS.delivery.max], [0, 8]);
  assert.equal(TYPE_DEFAULTS.chill_down.guidance, 'Chill from 63°C to below 8°C within 90 minutes.');
  assert.equal(typeDefault('fridge'), TYPE_DEFAULTS.fridge);
  assert.equal(typeDefault('fridge', 'UK'), TYPE_DEFAULTS.fridge);
  assert.equal(typeDefault('nope', 'US').label, 'nope');
  assert.equal(foodLawWords('UK').tempFloorNote, '✓ FSA: chilled ≤8°C (target 1–4); frozen ≤−18°C; hot holding ≥63°C.');
  assert.equal(foodLawWords('UK').tempDefaultsNote, 'Defaults follow FSA / Safer Food Better Business: chilled ≤8°C (target 1–4); frozen ≤−18°C; hot holding ≥63°C. Editable per unit.');
  assert.match(foodLawWords('US').tempDefaultsNote, /FDA Food Code/);
});

test('a 45°F fridge reading at a US venue is a breach', () => {
  const us = US_TYPE_DEFAULTS;
  const r = toStoredC('45', 'F');
  const b = breach(r, us.fridge.min, us.fridge.max);
  assert.equal(b.inRange, false);
  assert.equal(b.direction, 'over');
  assert.equal(breach(r, us.cold_hold.min, us.cold_hold.max).inRange, false);
  // the same 7.2°C was inside the UK cold hold band (up to 8°C): the US limit is the stricter one
  assert.equal(breach(r, TYPE_DEFAULTS.cold_hold.min, TYPE_DEFAULTS.cold_hold.max).inRange, true);
});

test('the screens read temperatures through the venue unit, never a hard °C at a US venue', () => {
  const ops = read('../surfaces/OperationsSurface.jsx');
  assert.match(ops, /const dUnit = unit\._displayUnit \|\| defaultTempUnit\(country\);/);
  assert.match(ops, /const tempC = toStoredC\(raw, dUnit\);/);
  assert.match(ops, /foodLawWords\(country\)\.tempFloorNote/);
  const cfg = read('../backoffice/sections/operations/OpsTemperature.jsx');
  assert.match(cfg, /useState\(\(\) => defaultTempUnit\(country\)\)/);
  assert.match(cfg, /typeDefault\(t, country\)/);
  const comp = read('../backoffice/sections/operations/OpsCompliance.jsx');
  assert.match(comp, /`Reading°\$\{tUnit\}`/);
});

// ── allergens ──────────────────────────────────────────────────────────────
test('the US list is the 9 major food allergens with Wheat, and no stored id is removed', () => {
  const us = allergenOptionsFor('US');
  assert.equal(us.major.length, 9);
  assert.deepEqual(us.major.map((a) => a.id), [...US_MAJOR_ALLERGEN_IDS]);
  assert.deepEqual(us.major.map((a) => a.label), ['Milk', 'Eggs', 'Fish', 'Crustacean shellfish', 'Tree nuts', 'Peanuts', 'Wheat/Gluten', 'Soybeans', 'Sesame']);
  assert.ok(us.major.some((a) => /Wheat/.test(a.label)));
  // every one of the 14 stored ids still has its tick box at a US venue, and no new id is invented
  const all = [...us.major, ...us.extra].map((a) => a.id).sort();
  assert.deepEqual(all, [...UK_ALLERGENS].sort());
  assert.deepEqual([...US_EXTRA_ALLERGEN_IDS].sort(), ['celery', 'lupin', 'molluscs', 'mustard', 'sulphites']);
  assert.equal(allergenLabelFor('sulphites', 'US'), 'Sulfites');
  assert.equal(allergenLabelFor('molluscs', 'US'), 'Mollusks');
  // wheat is read as gluten by the one alias table (and its SQL twin): the US declares it there
  assert.equal(normaliseAllergenId('wheat'), 'gluten');
  assert.equal(normaliseAllergenId('Wheat'), 'gluten');
});

test('the UK allergen lists are unchanged', () => {
  const uk = allergenOptionsFor('UK');
  assert.deepEqual(uk.major, ALLERGENS);
  assert.deepEqual(uk.extra, []);
  assert.equal(ALLERGENS.length, 14);
  assert.equal(sheetAllergenIds('UK'), UK_ALLERGENS);
  assert.equal(sheetAllergenIds(), UK_ALLERGENS);
  assert.deepEqual(kioskAllergenLabels(['gluten', 'sulphites', 'molluscs'], t), ['Gluten', 'Sulphites', 'Molluscs']);
  assert.deepEqual(allergenChipLabels(['sulphites'], t).map((r) => r.label), ['Sulphites']);
  assert.equal(labelAllergenWords(['sulphites', 'gluten']), 'Allergens: Gluten, Sulphites');
  assert.equal(allergenChipsFor('UK'), ALLERGEN_CHIPS);
  assert.equal(nutritionFieldsFor('UK'), NUTRITION_FIELDS);
  assert.equal(foodLawWords('UK').allergenEditorHeading, 'Declared allergens — EU 14 mandatory');
  assert.equal(foodLawWords('UK').boardFooterDefault, 'Please ask staff about the 14 allergens.');
});

test('US allergen words on the kiosk, the chips, labels and stock (translations kept)', () => {
  assert.deepEqual([...sheetAllergenIds('US')], [...US_MAJOR_ALLERGEN_IDS]);
  assert.deepEqual(kioskAllergenLabels(['gluten', 'sulphites', 'crustaceans', 'soy'], t, 'US'), ['Wheat/Gluten', 'Sulfites', 'Crustacean shellfish', 'Soybeans']);
  assert.deepEqual(allergenChipLabels(['molluscs'], t, 'US').map((r) => r.label), ['Mollusks']);
  // a Spanish kiosk at a US venue keeps its own words; gluten has its own key in every language
  assert.equal(allergenNameFor('sulphites', (k) => t(k, 'es'), 'US'), 'Sulfitos');
  assert.equal(allergenNameFor('gluten', (k) => t(k, 'es'), 'US'), 'Trigo/Gluten');
  // a translate function with no US key falls back to the normal key
  assert.equal(allergenNameFor('gluten', (k) => k, 'US'), 'k2.allergen.gluten');
  assert.equal(labelAllergenWords(['sulphites', 'gluten'], 'US'), 'Allergens: Wheat/Gluten, Sulfites');
  assert.deepEqual(allergenChipsFor('US').map((c) => c.id), ALLERGEN_CHIPS.map((c) => c.id));
  assert.equal(allergenChipsFor('US').find((c) => c.id === 'sulphites').label, 'Sulfites');
  const usNut = nutritionFieldsFor('US');
  assert.deepEqual(usNut.map((f) => f.key), NUTRITION_FIELDS.map((f) => f.key));
  assert.equal(usNut.find((f) => f.key === 'kcal').label, 'Calories');
  assert.equal(usNut.find((f) => f.key === 'fibre_g').label, 'Fiber');
  assert.equal(usNut.find((f) => f.key === 'salt_g').label, 'Salt');   // left: sodium is a different figure
  const w = foodLawWords('US');
  assert.match(w.allergenEditorHeading, /9/);
  assert.equal(w.boardFooterDefault, 'Please ask staff about allergens.');
  assert.equal(w.foodLabelName, 'Food label');
  assert.match(w.allergenCheckoutLegal, /9 major food allergens/);
});

// ── calories ───────────────────────────────────────────────────────────────
test('the calorie words per country', () => {
  assert.equal(KCAL_NOTE_US, '2,000 calories a day is used for general nutrition advice, but calorie needs vary.');
  assert.equal(kcalNoteFor('USD'), KCAL_NOTE_US);
  assert.equal(kcalNoteFor('US'), KCAL_NOTE_US);
  assert.equal(kcalNoteFor({ currency: 'USD' }), KCAL_NOTE_US);
  assert.equal(kcalNoteFor('GBP'), KCAL_NOTE_EN);
  assert.equal(kcalNoteFor('EUR'), KCAL_NOTE_EN);
  assert.equal(kcalNoteFor(null), KCAL_NOTE_EN);
  assert.equal(kcalNoteFor('GBP', t), t(KCAL_NOTE_KEY));
  assert.equal(kcalNoteFor('GBP', (k) => t(k, 'es')), t(KCAL_NOTE_KEY, 'es'));
  assert.equal(kcalWordsShared(146, null, 'USD'), '146 Cal');
  assert.equal(kcalWordsShared(146, t, 'usd'), '146 Cal');
  assert.equal(kcalWordsShared(146), '146 kcal');
  assert.equal(kcalWordsShared(146, t, 'GBP'), '146 kcal');
  // the browser wrapper: the active venue (GBP with no storage), or the venue given
  assert.equal(kcalWords(146), '146 kcal');
  assert.equal(kcalWords(146, null, 'USD'), '146 Cal');
  assert.equal(kcalNote(), KCAL_NOTE_EN);
  assert.equal(kcalNote(t), t(KCAL_NOTE_KEY));
  assert.equal(kcalNote(null, 'USD'), KCAL_NOTE_US);
  assert.match(foodLawWords('US').caloriesCardNote, /2,000 calories a day is used for general nutrition advice/);
  assert.doesNotMatch(foodLawWords('US').caloriesCardNote, /kcal/);
});

// ── ID check ───────────────────────────────────────────────────────────────
test('ID numbers are stored and shown as the last 4 only', () => {
  assert.equal(idLast4('AB 12-34 56'), '3456');
  assert.equal(idLast4('d1234567'), '4567');
  assert.equal(idLast4('12'), '12');
  assert.equal(idLast4(''), '');
  assert.equal(idLast4(null), '');
  assert.equal(maskIdNumber('SMITH901015JN9AA'), 'ending N9AA');
  assert.equal(maskIdNumber('1234'), 'ending 1234');
  assert.equal(maskIdNumber(null), '');
  // the till stores idLast4, never the typed number
  const modal = read('../components/Challenge21Modal.jsx');
  assert.match(modal, /id_document_number: idLast4\(idNumber\),/);
  assert.doesNotMatch(modal, /id_document_number: idNumber/);
  // the report shows and exports only the masked number
  const report = read('../backoffice/sections/Challenge21Report.jsx');
  const reads = report.match(/[^\n]*r\.id_document_number[^\n]*/g) || [];
  assert.ok(reads.length >= 2);
  for (const line of reads) assert.match(line, /maskIdNumber\(r\.id_document_number\)/, line);
});

test('ID types per country', () => {
  assert.deepEqual(idTypesFor('US').map((x) => x.label), ["Driver's license", 'State ID', 'Passport', 'Military ID']);
  assert.ok(idTypesFor('US').some((x) => x.id === 'driving_license'));   // the stored id is kept
  assert.deepEqual(idTypesFor('UK').map((x) => x.label), ['Passport', 'Driving License', 'PASS Card', 'National ID', 'Military ID', 'Other']);
  assert.equal(foodLawWords('UK').idCheckBadge, 'UK Licensing · Challenge ID');
  assert.equal(foodLawWords('UK').idCheckFrequencyHint, ' UK best practice is every 5–20 sales.');
  assert.match(foodLawWords('US').idCheckIntro, /21/);
  assert.match(foodLawWords('US').idCheckFrequencyHint, /21/);
});

// ── guard: no UK law words outside a UK gate ───────────────────────────────
const BANNED = [/14 allergens/, /Natasha/, /FSA/, /EHO/, /PASS Card/, /kcal a day/];

test('the US words carry no UK law term and no em or en dash', () => {
  for (const [k, v] of Object.entries(FOOD_LAW_WORDS.US)) {
    for (const re of BANNED) assert.doesNotMatch(v, re, `US ${k}`);
    assert.doesNotMatch(v, /[—–]/, `US ${k}`);
  }
  for (const v of Object.values(US_TYPE_DEFAULTS)) assert.doesNotMatch(v.guidance, /[—–]|°C/);
  assert.deepEqual(Object.keys(FOOD_LAW_WORDS.US).sort(), Object.keys(FOOD_LAW_WORDS.UK).sort());
});

// The files batch 5 changed. Comments are left out; a UK term may stay only behind a UK gate:
// the UK block of lib/foodLaw.js, the UK calorie constant (KCAL_NOTE_EN, only read when the venue
// is not in the US) and the UK product.kcalNote translations (the same).
const FILES = [
  './foodLaw.js', './ops/temp.js', './menuStockFacts.js', './printMenu.js', './printMenuPdf.js', './kioskAllergens.js',
  './i18n.js', './stock/batchLabel.js', './stock/factsRules.js', '../../supabase/functions/_shared/menuStockFacts.js',
  '../components/AllergenChips.js', '../components/AllergenCheckoutModal.jsx', '../components/Challenge21Modal.jsx',
  '../backoffice/sections/Challenge21.jsx', '../backoffice/sections/Challenge21Report.jsx',
  '../backoffice/sections/operations/OpsTemperature.jsx', '../backoffice/sections/operations/OpsCompliance.jsx',
  '../surfaces/OperationsSurface.jsx', '../backoffice/sections/MenuManager.jsx', '../backoffice/sections/KioskSettings.jsx',
  '../backoffice/sections/MenuBoards.jsx', '../surfaces/menuboard/BoardParts.jsx',
  '../backoffice/sections/produce/BatchLabels.jsx', '../backoffice/sections/produce/RecipeAllergensTab.jsx',
  '../backoffice/sections/stock/CaloriesCard.jsx', '../backoffice/sections/stock/items/WhatIsInIt.jsx',
  '../surfaces/online/OnlineItemSheet.jsx', '../surfaces/online/OnlineSurface.jsx', '../surfaces/catering/CateringSurface.jsx',
  '../surfaces/KioskProductModal.jsx', '../surfaces/kiosk/KioskItemSheet.jsx', '../surfaces/kiosk/KioskMenuScreen.jsx',
  '../surfaces/kiosk/KioskAllergenSheet.jsx',
];
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

test('guard: no "14 allergens", Natasha, FSA, EHO, PASS Card or "kcal a day" without a UK gate', () => {
  const problems = [];
  for (const rel of FILES) {
    let code = stripComments(read(rel));
    if (rel === './foodLaw.js') {
      // the UK words and the UK ID types are the gate; cut them out, the rest must be clean
      code = code.replace(/const UK = \{[\s\S]*?\n\};/, '').replace(/const UK_ID_TYPES = \[[\s\S]*?\n\];/, '');
    }
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      if (rel.endsWith('_shared/menuStockFacts.js') && /^export const KCAL_NOTE_EN = /.test(line)) return;
      if (rel === './i18n.js' && /^\s*'product\.kcalNote': /.test(line)) return;
      for (const re of BANNED) if (re.test(line)) problems.push(`${rel}:${i + 1} ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(problems, []);
});
