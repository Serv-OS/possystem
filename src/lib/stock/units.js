/**
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

/** Normalise a unit code: trim + lowercase. Returns '' for nullish input. */
export const normUnit = (code) => String(code ?? '').trim().toLowerCase();

/** True if `code` is a known global unit. */
export const isKnownUnit = (code) => Object.prototype.hasOwnProperty.call(UNITS, normUnit(code));

/** The dimension of a known unit, or null. */
export const unitDimension = (code) => UNITS[normUnit(code)]?.dimension ?? null;

/**
 * Global same-dimension conversion factor: how many of unit `b` are in one of
 * unit `a` (so qtyB = qtyA * globalFactor(a,b)). Returns null when the units are
 * unknown or live in different dimensions (caller must then use an item bridge).
 */
export function globalFactor(a, b) {
  const ua = UNITS[normUnit(a)];
  const ub = UNITS[normUnit(b)];
  if (!ua || !ub || ua.dimension !== ub.dimension) return null;
  return ua.toCanonical / ub.toCanonical;
}
