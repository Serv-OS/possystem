// venueDiscounts.js: the discount buttons a till shows (29 Sep 2026).
// Peter: "each location should have their own discounts". The POS and MPOS used to show six
// hard-coded starter discounts (Staff meal, Staff drinks, Loyalty 10%, NHS / Blue Light,
// Happy hour 20%, Comp) whenever a venue had none of its own, so Huddersfield showed a
// "Happy hour" nobody had set up anywhere. A till now shows ONLY the venue's own discounts
// from Back Office (store.discountPresets, loaded per venue by SyncBridge), and nothing else.

export const NO_DISCOUNTS_TEXT = 'No discounts set up for this venue. Add them in Back Office, under Discounts.';

/** The venue's own active discounts, in Back Office order, as { id, label, type, value, requiresManager, scope, categoryIds }. */
export function venueDiscountList(discountPresets) {
  return (Array.isArray(discountPresets) ? discountPresets : [])
    .filter((d) => d && d.active !== false && Number(d.value) > 0)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => ((a.d.sortOrder ?? 0) - (b.d.sortOrder ?? 0)) || (a.i - b.i))
    .map(({ d }) => ({
      id: d.id,
      label: d.label || d.name || 'Discount',
      type: d.type === 'amount' ? 'amount' : 'percent',
      value: Number(d.value),
      requiresManager: !!(d.requiresManager ?? d.requires_manager),
      scope: d.scope || 'global',
      categoryIds: d.categoryIds || d.category_ids || [],
    }));
}
