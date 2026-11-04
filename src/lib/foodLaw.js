// src/lib/foodLaw.js
//
// 5.12.57: the food safety and food law words that differ by country, in one place. A UK (and
// Irish) venue reads every line exactly as before: the UK block below holds the old words, moved
// here word for word. A US venue reads the FDA Food Code words: the 9 major food allergens, °F
// temperatures, the FDA calorie line, US ID types and the legal age of 21.
//
// Every function takes the venue's country ('UK' | 'US' | 'IE'); with none it uses the venue the
// screen is on (lib/regionPack.js activeCountry, which follows the venue's currency; a customer
// screen sets that from its own venue in CustomerBoot).
//
// Pure apart from that default: node:test loads it (foodSafetyBatch5.test.js).

import { ALLERGENS } from '../data/seed.js';
import { getActiveCurrencyCode } from './currency.js';
import { regionOf } from '../../supabase/functions/_shared/regionPack.js';

// lib/regionPack.js activeCountry, read here from its two parts so node:test can load this file.
const activeCountry = () => regionOf(getActiveCurrencyCode());
const countryOr = (country) => (country === 'UK' || country === 'US' || country === 'IE' ? country : activeCountry());
export const isUsVenue = (country) => countryOr(country) === 'US';

// ── the words ───────────────────────────────────────────────────────────────
// UK: the words the screens carried before 5.12.57, unchanged (Ireland reads these too).
const UK = {
  tempDefaultsNote: 'Defaults follow FSA / Safer Food Better Business: chilled ≤8°C (target 1–4); frozen ≤−18°C; hot holding ≥63°C. Editable per unit.',
  tempFloorNote: '✓ FSA: chilled ≤8°C (target 1–4); frozen ≤−18°C; hot holding ≥63°C.',
  allergenEditorHeading: 'Declared allergens — EU 14 mandatory',
  allergenEditorExtraHeading: '',
  kioskAllergenConfirmDesc: "Customer must confirm allergen warning when adding flagged items (UK Natasha's Law)",
  allergenCheckoutLegal: 'EU/UK Food Information for Consumers Regulation requires all 14 allergens to be declared. This confirmation is recorded on the order audit trail.',
  boardFooterDefault: 'Please ask staff about the 14 allergens.',
  boardFooterPlaceholder: 'e.g. Please ask staff about the 14 allergens.',
  foodLabelName: 'PPDS label',
  foodLabelTab: 'PPDS',
  foodLabelOneProduct: 'A PPDS label belongs to one product. Open the recipe, go to Allergens and nutrition, and press Print PPDS label for this site.',
  recipeAllergenNote: 'for PPDS labels.',
  printFoodLabel: 'Print PPDS label',
  caloriesCardNote: 'Each shows the kcal of a portion and the line "Adults need around 2,000 kcal a day". The figures come from the stock recipe linked at this site. A product with no recipe shows none.',
  idCheckIntro: 'UK licensing compliance.',
  idCheckFrequencyHint: ' UK best practice is every 5–20 sales.',
  idCheckBadge: 'UK Licensing · Challenge ID',
};

// US: the FDA Food Code and US licensing words.
const US = {
  tempDefaultsNote: 'Defaults follow the FDA Food Code: cold holding 41°F or below; frozen 0°F or below; hot holding 135°F or above; cool from 135°F to 70°F within 2 hours, then to 41°F within 4 more hours. Editable per unit.',
  tempFloorNote: '✓ FDA Food Code: cold holding 41°F or below; frozen 0°F or below; hot holding 135°F or above.',
  allergenEditorHeading: 'Major food allergens: the 9 the FDA names',
  allergenEditorExtraHeading: 'Other allergens',
  kioskAllergenConfirmDesc: 'Customer must confirm allergen warning when adding flagged items',
  allergenCheckoutLegal: 'Tell the guest about the 9 major food allergens in their order. This confirmation is recorded on the order audit trail.',
  boardFooterDefault: 'Please ask staff about allergens.',
  boardFooterPlaceholder: 'e.g. Please ask staff about allergens.',
  foodLabelName: 'Food label',
  foodLabelTab: 'Food label',
  foodLabelOneProduct: 'A food label belongs to one product. Open the recipe, go to Allergens and nutrition, and press Print food label for this site.',
  recipeAllergenNote: 'for food labels.',
  printFoodLabel: 'Print food label',
  caloriesCardNote: 'Each shows the calories (Cal) of a portion and the line "2,000 calories a day is used for general nutrition advice, but calorie needs vary." The figures come from the stock recipe linked at this site. A product with no recipe shows none.',
  idCheckIntro: 'The legal age to buy alcohol in the US is 21.',
  idCheckFrequencyHint: ' The legal age for alcohol is 21: check ID for anyone who may be under 21.',
  idCheckBadge: 'ID check · Legal age 21',
};

/** The food law words for the venue's country (a fresh copy). */
export function foodLawWords(country) {
  return { ...(isUsVenue(country) ? US : UK) };
}

// For the guard test: both blocks, so it can prove the US words carry no UK law terms.
export const FOOD_LAW_WORDS = Object.freeze({ UK: Object.freeze({ ...UK }), US: Object.freeze({ ...US }) });

// ── allergens ───────────────────────────────────────────────────────────────
// The stored ids never change (src/data/seed.js ALLERGENS). Wheat: the one alias table
// (supabase/functions/_shared/allergenIds.js) and its SQL twin (stock_co__allergen_ids) already
// read 'wheat' as 'gluten', and the till looks labels up in the 14, so a separate 'wheat' id would
// be folded into gluten or dropped from the allergen check. A US venue therefore declares wheat on
// the 'gluten' id, named Wheat/Gluten; splitting the two needs a migration first.
export const US_MAJOR_ALLERGEN_IDS = Object.freeze(['milk', 'eggs', 'fish', 'crustaceans', 'nuts', 'peanuts', 'gluten', 'soy', 'sesame']);
// The rest of the 14 stay on offer at a US venue, so no stored id is ever left without its tick box.
export const US_EXTRA_ALLERGEN_IDS = Object.freeze(['molluscs', 'sulphites', 'mustard', 'celery', 'lupin']);

/** US spelling and the FDA names, by stored id. Ids not listed read as the seed label. */
export const US_ALLERGEN_LABELS = Object.freeze({
  gluten: 'Wheat/Gluten',
  crustaceans: 'Crustacean shellfish',
  soy: 'Soybeans',
  molluscs: 'Mollusks',
  sulphites: 'Sulfites',
});

const SEED = new Map((ALLERGENS || []).map((a) => [a.id, a]));

/** One allergen id in the venue's words: 'Sulphites' in the UK, 'Sulfites' in the US. */
export function allergenLabelFor(id, country) {
  const key = String(id ?? '');
  if (isUsVenue(country) && US_ALLERGEN_LABELS[key]) return US_ALLERGEN_LABELS[key];
  if (SEED.has(key)) return SEED.get(key).label;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : '';
}

/**
 * The allergen tick boxes for the venue: { major: [{ id, label, icon }], extra: [...] }. The UK
 * gets the 14 exactly as src/data/seed.js lists them and no extras; the US gets the 9 major food
 * allergens then the other five.
 */
export function allergenOptionsFor(country) {
  if (!isUsVenue(country)) return { major: ALLERGENS.map((a) => ({ ...a })), extra: [] };
  const opt = (id) => ({ id, label: allergenLabelFor(id, 'US'), icon: id === 'gluten' ? 'W' : (SEED.get(id)?.icon || '') });
  return { major: US_MAJOR_ALLERGEN_IDS.map(opt), extra: US_EXTRA_ALLERGEN_IDS.map(opt) };
}

// ── ID check (Challenge 21 / Challenge ID) ──────────────────────────────────
const UK_ID_TYPES = [
  { id: 'passport',         label: 'Passport' },
  { id: 'driving_license',  label: 'Driving License' },
  { id: 'pass_card',        label: 'PASS Card' },
  { id: 'national_id',      label: 'National ID' },
  { id: 'military_id',      label: 'Military ID' },
  { id: 'other',            label: 'Other' },
];
// The US: the four IDs a US venue takes. driving_license keeps its stored id.
const US_ID_TYPES = [
  { id: 'driving_license',  label: "Driver's license" },
  { id: 'state_id',         label: 'State ID' },
  { id: 'passport',         label: 'Passport' },
  { id: 'military_id',      label: 'Military ID' },
];

/** The ID types the till offers at the venue. */
export function idTypesFor(country) {
  return (isUsVenue(country) ? US_ID_TYPES : UK_ID_TYPES).map((t) => ({ ...t }));
}

/**
 * 5.12.57 (every venue; the owner's call): only the last 4 characters of an ID number are kept.
 * Spaces and hyphens are dropped first, so 'AB 12-34 56' keeps '3456'. '' for nothing.
 */
export function idLast4(raw) {
  const s = String(raw ?? '').replace(/[\s-]+/g, '').toUpperCase();
  return s.slice(-4);
}

/** An ID number as shown and exported: 'ending 3456', never more (old rows held the full number). */
export function maskIdNumber(stored) {
  const last4 = idLast4(stored);
  return last4 ? `ending ${last4}` : '';
}
