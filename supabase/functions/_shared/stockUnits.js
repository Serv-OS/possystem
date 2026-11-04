/**
 * _shared: the ONE copy of this engine. src/lib/stock/units.js re-exports it for the browser; manager-approve
 * imports it under Deno so a receive from the Manager app converts packs to base units exactly as
 * Back Office receiving does (v5.11.64).
 *
 * units.js — canonical units of measure for the stock/costing engine.
 *
 * Every quantity in the stock system is ultimately reduced to a per-dimension
 * CANONICAL unit so that pack sizes, recipe quantities, counts and waste are all
 * comparable and value-able in one currency of measure:
 *
 *   COUNT  → canonical "each"
 *   WEIGHT → canonical "g"   (gram)
 *   VOLUME → canonical "ml"  (millilitre)
 *
 * `toCanonical` is how many canonical units ONE of this unit equals
 * (e.g. 1 kg = 1000 g, so kg.toCanonical = 1000).
 *
 * Locale: en-GB — imperial volume here is UK (fl oz = 28.4130625 ml, pint =
 * 568.26125 ml), NOT US. Cross-dimension conversions (e.g. volume↔weight for a
 * specific ingredient's density) are NOT global — they live per-item in
 * `inventory_item_conversions` and are resolved by conversion.js.
 *
 * This table is the source-of-truth mirror of the `stock_units` DB seed; keep the
 * two in step (see supabase/migrations/*_stock_foundation.sql).
 *
 * 5.12.57 (US basics batch 7): US_UNITS adds the US volume units (fl oz 29.5735 ml, cup 236.588 ml,
 * pint 473.176 ml, quart 946.353 ml, gallon 3785.41 ml), seeded in stock_units by
 * 20261120c_OPS_stock_us_units.sql. UNITS stays the UK set of 13, exactly as before, so every
 * picker that lists UNITS reads as it did; the helpers below (isKnownUnit, unitDimension,
 * globalFactor) know ALL_UNITS, so a US gallon converts as a US gallon wherever it is used. The
 * screens offer the US set at a US site (src/lib/stock/stockRegion.js unitPickList).
 */

export const DIMENSIONS = Object.freeze({ COUNT: 'COUNT', WEIGHT: 'WEIGHT', VOLUME: 'VOLUME' });

/** code → { dimension, toCanonical, label } */
export const UNITS = Object.freeze({
  // COUNT (canonical: each)
  each:  { dimension: 'COUNT',  toCanonical: 1,            label: 'each' },
  dozen: { dimension: 'COUNT',  toCanonical: 12,           label: 'dozen' },

  // WEIGHT (canonical: g)
  mg:    { dimension: 'WEIGHT', toCanonical: 0.001,        label: 'milligram' },
  g:     { dimension: 'WEIGHT', toCanonical: 1,            label: 'gram' },
  kg:    { dimension: 'WEIGHT', toCanonical: 1000,         label: 'kilogram' },
  oz:    { dimension: 'WEIGHT', toCanonical: 28.349523125, label: 'ounce' },
  lb:    { dimension: 'WEIGHT', toCanonical: 453.59237,    label: 'pound' },

  // VOLUME (canonical: ml) — UK imperial
  ml:    { dimension: 'VOLUME', toCanonical: 1,            label: 'millilitre' },
  cl:    { dimension: 'VOLUME', toCanonical: 10,           label: 'centilitre' },
  l:     { dimension: 'VOLUME', toCanonical: 1000,         label: 'litre' },
  floz:  { dimension: 'VOLUME', toCanonical: 28.4130625,   label: 'fl oz (UK)' },
  pt:    { dimension: 'VOLUME', toCanonical: 568.26125,    label: 'pint (UK)' },
  gal:   { dimension: 'VOLUME', toCanonical: 4546.09,      label: 'gallon (UK)' },
});

/** 5.12.57: the US volume units (US customary), code -> { dimension, toCanonical, label, region }. */
export const US_UNITS = Object.freeze({
  floz_us: { dimension: 'VOLUME', toCanonical: 29.5735295625, label: 'fl oz (US)',  region: 'US' },
  cup_us:  { dimension: 'VOLUME', toCanonical: 236.5882365,   label: 'cup (US)',    region: 'US' },
  pt_us:   { dimension: 'VOLUME', toCanonical: 473.176473,    label: 'pint (US)',   region: 'US' },
  qt_us:   { dimension: 'VOLUME', toCanonical: 946.352946,    label: 'quart (US)',  region: 'US' },
  gal_us:  { dimension: 'VOLUME', toCanonical: 3785.411784,   label: 'gallon (US)', region: 'US' },
});

/** Every unit the engine knows: the UK set and the US volume units. */
export const ALL_UNITS = Object.freeze({ ...UNITS, ...US_UNITS });

/** Normalise a unit code: trim + lowercase. Returns '' for nullish input. */
export const normUnit = (code) => String(code ?? '').trim().toLowerCase();

/** True if `code` is a known global unit. */
export const isKnownUnit = (code) => Object.prototype.hasOwnProperty.call(ALL_UNITS, normUnit(code));

/** The dimension of a known unit, or null. */
export const unitDimension = (code) => ALL_UNITS[normUnit(code)]?.dimension ?? null;

/**
 * Global same-dimension conversion factor: how many of unit `b` are in one of
 * unit `a` (so qtyB = qtyA * globalFactor(a,b)). Returns null when the units are
 * unknown or live in different dimensions (caller must then use an item bridge).
 */
export function globalFactor(a, b) {
  const ua = ALL_UNITS[normUnit(a)];
  const ub = ALL_UNITS[normUnit(b)];
  if (!ua || !ub || ua.dimension !== ub.dimension) return null;
  return ua.toCanonical / ub.toCanonical;
}
