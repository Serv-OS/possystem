/**
 * discountEngine.js — Auto-discount evaluation engine
 *
 * Pure functions that evaluate auto-discount rules against a cart.
 * Called by POS, Kiosk, Online, and QR surfaces to determine which
 * automatic discounts should be applied.
 *
 * Follows the pattern of tax.js and serviceCharge.js — no side effects,
 * no store dependencies, just inputs → outputs.
 */

/**
 * Check if an item belongs to any of the given category IDs.
 * Items have `cat` (primary) and `cats[]` (multi-category).
 */
const itemMatchesCategories = (item, categoryIds) => {
  if (!categoryIds?.length) return false;
  if (categoryIds.includes(item.cat)) return true;
  if (Array.isArray(item.cats)) {
    return item.cats.some(c => categoryIds.includes(c));
  }
  return false;
};

/**
 * Evaluate all active auto-discount rules against the current cart.
 *
 * @param {Array} items — Cart items, each with { uid, cat, cats[], price, qty, name, voided }
 * @param {Array} rules — Active discount_rules from the store
 * @param {string} channel — 'pos' | 'online' | 'qr' | 'kiosk'
 * @returns {Array} — Array of auto-discount objects ready to apply:
 *   { ruleId, ruleName, rewardType, rewardValue, appliedItems: [{uid, saving}], totalSaving }
 */
export const evaluateAutoDiscounts = (items, rules, channel = 'pos') => {
  if (!rules?.length || !items?.length) return [];

  // Only non-voided items
  const activeItems = items.filter(i => !i.voided);
  if (!activeItems.length) return [];

  const results = [];

  for (const rule of rules) {
    // Check channel targeting
    if (rule.channels && !rule.channels[channel]) continue;
    if (!rule.active) continue;

    const triggerCats = rule.triggerCategoryIds || rule.trigger_category_ids || [];
    const rewardCats = (rule.rewardCategoryIds || rule.reward_category_ids || []);
    const effectiveRewardCats = rewardCats.length > 0 ? rewardCats : triggerCats;
    const triggerQty = rule.triggerQty ?? rule.trigger_qty ?? 2;
    const rewardQty = rule.rewardQty ?? rule.reward_qty ?? 1;
    const rewardType = rule.rewardType || rule.reward_type || 'percent';
    const rewardValue = parseFloat(rule.rewardValue ?? rule.reward_value ?? 0);

    if (rule.triggerType === 'buy_x' || rule.trigger_type === 'buy_x') {
      // Expand items by qty so each unit is individually addressable
      const expandedQualifying = [];
      for (const item of activeItems) {
        if (itemMatchesCategories(item, triggerCats)) {
          for (let q = 0; q < item.qty; q++) {
            expandedQualifying.push({ ...item, _unitPrice: item.price, _originalUid: item.uid });
          }
        }
      }

      // Need at least triggerQty + rewardQty items to fire
      const totalNeeded = triggerQty + rewardQty;
      if (expandedQualifying.length < totalNeeded) continue;

      // Sort by price ascending — cheapest items get the discount (standard retail practice)
      expandedQualifying.sort((a, b) => a._unitPrice - b._unitPrice);

      // Calculate how many times the rule fires
      const fireCount = Math.floor(expandedQualifying.length / totalNeeded);
      if (fireCount < 1) continue;

      // The reward items are the cheapest `rewardQty * fireCount` items
      const rewardItemCount = rewardQty * fireCount;
      const rewardItems = expandedQualifying.slice(0, rewardItemCount);

      // If reward categories differ from trigger categories, filter further
      let finalRewardItems = rewardItems;
      if (rewardCats.length > 0) {
        finalRewardItems = rewardItems.filter(i => itemMatchesCategories(i, effectiveRewardCats));
      }

      if (!finalRewardItems.length) continue;

      // Calculate savings per reward item
      const appliedItems = [];
      let totalSaving = 0;
      for (const ri of finalRewardItems) {
        let saving = 0;
        if (rewardType === 'percent') {
          saving = ri._unitPrice * rewardValue / 100;
        } else if (rewardType === 'amount') {
          saving = Math.min(rewardValue, ri._unitPrice);
        } else if (rewardType === 'free') {
          saving = ri._unitPrice;
        }
        saving = Math.round(saving * 100) / 100; // Round to 2dp
        appliedItems.push({ uid: ri._originalUid, name: ri.name, saving });
        totalSaving += saving;
      }

      totalSaving = Math.round(totalSaving * 100) / 100;

      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        rewardType,
        rewardValue,
        appliedItems,
        totalSaving,
      });
    }
  }

  return results;
};

/**
 * Filter manual discount presets by scope for a specific item.
 * Returns presets that are either global or match the item's categories.
 *
 * @param {Array} presets — Discount presets from the store
 * @param {Object} item — Menu item with cat/cats[]
 * @returns {Array} — Filtered presets applicable to this item
 */
export const filterDiscountsByScope = (presets, item) => {
  if (!presets?.length) return [];
  return presets.filter(d => {
    if (d.scope === 'global') return true;
    if (d.scope === 'category' && d.categoryIds?.length) {
      return itemMatchesCategories(item, d.categoryIds);
    }
    return true; // Default: show all
  });
};
