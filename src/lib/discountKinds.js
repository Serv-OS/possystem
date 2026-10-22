// discountKinds.js: what a Back Office discount preset is for (v5.11.92, the drainer release, 20261023a).
//
// Pure, no I/O. A preset can be marked Staff, Comp or Loyalty (column discounts.kind; null is an
// ordinary discount). The till copies the preset's id and kind onto the check discount (presetId,
// kind), and the database's sales day totals count staff food, comps and loyalty rewards on their
// own line with what they cost in stock. The kind never changes a price: the amount, label, type,
// value and scope of the discount are exactly what they were.

export const DISCOUNT_KINDS = ['staff', 'comp', 'loyalty'];

export const DISCOUNT_KIND_LABELS = {
  '': 'Ordinary discount',
  staff: 'Staff food and drink',
  comp: 'Comp (on the house)',
  loyalty: 'Loyalty reward',
};

/** Help line under the Kind select in Back Office > Discounts. */
export const DISCOUNT_KIND_HELP = 'Stock reports show staff food, comps and loyalty rewards on their own line. The price does not change.';

/** Toast when the database has no discounts.kind column yet (20261023a not run): the rest saved. */
export const DISCOUNT_KIND_NOT_SAVED = 'Saved. The kind needs a database update first, so it was not kept.';

/** One of 'staff', 'comp', 'loyalty', or null for anything else (an ordinary discount). */
export function cleanDiscountKind(v) {
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase();
  return DISCOUNT_KINDS.includes(k) ? k : null;
}

/** The plain words for a kind ('Ordinary discount' for none). */
export function discountKindLabel(v) {
  return DISCOUNT_KIND_LABELS[cleanDiscountKind(v) || ''];
}

/**
 * Did this database error refuse the write only because the kind column is not there yet?
 * PostgREST says PGRST204 ("Could not find the 'kind' column of 'discounts' in the schema cache");
 * Postgres says 42703 (column "kind" of relation "discounts" does not exist).
 */
export function isMissingKindColumn(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code !== 'PGRST204' && code !== '42703') return false;
  const words = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /\bkind\b/i.test(words);
}
