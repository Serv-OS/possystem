/**
 * discountEngine.js — Auto-discount evaluation engine
 *
 * Pure functions that evaluate auto-discount rules against a cart.
 * Called by POS, Kiosk, Online, and QR surfaces to determine which
 * automatic discounts should be applied.
 *
 * Follows the pattern of tax.js and serviceCharge.js — no side effects,
 * no store dependencies, just inputs → outputs. (No imports — the schedule
 * gate takes a pre-resolved location-local `ctx` from the caller so this
 * file never needs locationTime/Date wiring.)
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
 * Is a rule live RIGHT NOW given its schedule (day-of-week + time window + start/expiry)?
 *
 * Pure: takes the rule plus a pre-resolved LOCATION-LOCAL context so the engine
 * stays dependency-free (callers build ctx via locationTime.buildScheduleCtx).
 *
 * rule.schedule (jsonb, all fields optional — absent = "always on", back-compatible
 * with every rule created before scheduling existed):
 *   { days: [1..7],                 // ISO weekday, 1=Mon … 7=Sun; empty/absent = every day
 *     windows: [{start:'11:00', end:'15:00'}],  // location-local HH:mm; empty = all day;
 *                                                 //   end <= start ⇒ window crosses midnight
 *     startsAt: 'YYYY-MM-DD',        // inclusive go-live date (location-local), absent = live now
 *     expiresAt: 'YYYY-MM-DD' }      // inclusive LAST active date (location-local), absent = never expires
 *
 * ctx = { nowMinutes: 0..1439, isoDay: 1..7, ymd: 'YYYY-MM-DD' } — all location-local.
 */
export const isRuleActiveNow = (rule, ctx) => {
  const s = rule?.schedule || null;
  if (!s) return true;          // no schedule → always on
  if (!ctx) return true;        // caller didn't supply time context → don't gate
  const { nowMinutes, isoDay, ymd } = ctx;

  // Date window (expiry is the headline feature — the offer stops working after this date)
  if (s.startsAt && ymd && ymd < s.startsAt) return false;
  if (s.expiresAt && ymd && ymd > s.expiresAt) return false;

  // Day-of-week
  if (Array.isArray(s.days) && s.days.length && isoDay && !s.days.includes(isoDay)) return false;

  // Time-of-day windows (any match = active); supports windows that cross midnight
  if (Array.isArray(s.windows) && s.windows.length && Number.isFinite(nowMinutes)) {
    const inAny = s.windows.some(w => {
      if (!w?.start || !w?.end) return false;
      const [sh, sm] = String(w.start).split(':').map(Number);
      const [eh, em] = String(w.end).split(':').map(Number);
      const st = sh * 60 + sm, en = eh * 60 + em;
      if (Number.isNaN(st) || Number.isNaN(en)) return false;
      return en > st
        ? (nowMinutes >= st && nowMinutes < en)        // same-day window [start, end)
        : (nowMinutes >= st || nowMinutes < en);       // crosses midnight (e.g. 22:00–02:00)
    });
    if (!inAny) return false;
  }

  return true;
};

/**
 * Evaluate all active auto-discount rules against the current cart.
 *
 * @param {Array}  items   — Cart items, each with { uid, cat, cats[], price, qty, name, voided, discount? }
 * @param {Array}  rules   — Active discount_rules from the store (already priority-ordered DESC)
 * @param {string} channel — 'pos' | 'online' | 'qr' | 'kiosk'
 * @param {Object} [ctx]   — optional location-local time context for schedule/expiry gating
 *                           ({ nowMinutes, isoDay, ymd }). Omit to skip scheduling (legacy/tests).
 * @returns {Array} — Array of auto-discount objects ready to apply:
 *   { ruleId, ruleName, rewardType, rewardValue, appliedItems: [{uid, saving}], totalSaving }
 *
 * Stacking: rules are processed in array (priority) order. A physical UNIT can take part
 * in at most ONE auto-rule (no double-dipping), tracked via a `consumed` set of per-unit ids.
 * A line carrying a MANUAL item discount (item.discount) is skipped entirely — manual wins.
 */
export const evaluateAutoDiscounts = (items, rules, channel = 'pos', ctx = null) => {
  if (!rules?.length || !items?.length) return [];

  const activeItems = items.filter(i => !i.voided);
  if (!activeItems.length) return [];

  // A physical unit participates in at most one auto-rule. Units of the same line
  // (qty > 1) get distinct ids so partial-line consumption works.
  const consumed = new Set();
  const unitKey = (item, q) => `${item.uid ?? item.itemId ?? item.name}#${q}`;

  // Expand the matching lines into individual, still-available units.
  //  - skips lines with a manual item discount (manual wins — never double-dip)
  //  - skips units already consumed by a higher-priority rule
  const expandAvailable = (matchingItems) => {
    const out = [];
    for (const item of matchingItems) {
      if (item.discount) continue; // manual item discount on this line — leave it to the operator
      for (let q = 0; q < item.qty; q++) {
        const key = unitKey(item, q);
        if (consumed.has(key)) continue;
        out.push({ ...item, _unitPrice: item.price, _originalUid: item.uid, _key: key });
      }
    }
    return out;
  };

  const results = [];

  for (const rule of rules) {
    // Channel targeting + active + schedule/expiry gate
    if (rule.channels && !rule.channels[channel]) continue;
    if (!rule.active) continue;
    if (ctx && !isRuleActiveNow(rule, ctx)) continue;

    const triggerCats = rule.triggerCategoryIds || rule.trigger_category_ids || [];
    const rewardCats = (rule.rewardCategoryIds || rule.reward_category_ids || []);
    const effectiveRewardCats = rewardCats.length > 0 ? rewardCats : triggerCats;
    const triggerQty = rule.triggerQty ?? rule.trigger_qty ?? 2;
    const rewardQty = rule.rewardQty ?? rule.reward_qty ?? 1;
    const rewardType = rule.rewardType || rule.reward_type || 'percent';
    const rewardValue = parseFloat(rule.rewardValue ?? rule.reward_value ?? 0);

    const triggerType = rule.triggerType || rule.trigger_type || 'buy_x';

    // ── Bundle / meal-deal rules ──────────────────────────────────────────
    // trigger_type='bundle': each group in triggerGroups must be satisfied
    // reward_type='fixed_price': total for the bundle = rewardValue
    if (triggerType === 'bundle') {
      const groups = rule.triggerGroups || rule.trigger_groups || [];
      if (!groups.length) continue;

      // For each group, find matching AVAILABLE units (expanded by qty)
      const groupMatches = groups.map(g => {
        const catIds = g.categoryIds || g.category_ids || [];
        const needed = g.qty ?? 1;
        const expanded = expandAvailable(activeItems.filter(it => itemMatchesCategories(it, catIds)));
        return { catIds, needed, expanded };
      });

      // Check all groups are satisfied
      if (groupMatches.some(g => g.expanded.length < g.needed)) continue;

      // How many full bundles can we make? Limited by the group with the
      // fewest multiples of its needed count.
      const fireCount = Math.min(...groupMatches.map(g => Math.floor(g.expanded.length / g.needed)));
      if (fireCount < 1) continue;

      // Collect the items that form each bundle (cheapest first per group)
      const appliedItems = [];
      const claimedKeys = [];
      let totalOriginalPrice = 0;
      for (const g of groupMatches) {
        g.expanded.sort((a, b) => a._unitPrice - b._unitPrice);
        const picked = g.expanded.slice(0, g.needed * fireCount);
        for (const p of picked) {
          totalOriginalPrice += p._unitPrice;
          appliedItems.push({ uid: p._originalUid, name: p.name, originalPrice: p._unitPrice });
          claimedKeys.push(p._key);
        }
      }

      const bundlePrice = rewardValue * fireCount;
      const totalSaving = Math.round(Math.max(0, totalOriginalPrice - bundlePrice) * 100) / 100;

      if (totalSaving <= 0) continue;

      // Distribute the saving proportionally across bundle items
      for (const ai of appliedItems) {
        ai.saving = Math.round((ai.originalPrice / totalOriginalPrice) * totalSaving * 100) / 100;
      }

      // Consume every unit that formed the bundle so a later rule can't reuse it
      claimedKeys.forEach(k => consumed.add(k));

      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        rewardType: 'fixed_price',
        rewardValue,
        bundlePrice: bundlePrice,
        appliedItems,
        totalSaving,
      });
      continue;
    }

    // ── Buy-X-get-Y rules ─────────────────────────────────────────────────
    if (triggerType === 'buy_x') {
      // Expand qualifying lines into individual AVAILABLE units
      const expandedQualifying = expandAvailable(activeItems.filter(it => itemMatchesCategories(it, triggerCats)));

      // Need at least triggerQty + rewardQty items to fire
      const totalNeeded = triggerQty + rewardQty;
      if (expandedQualifying.length < totalNeeded) continue;

      // Sort by price ascending — cheapest items get the discount (standard retail practice)
      expandedQualifying.sort((a, b) => a._unitPrice - b._unitPrice);

      // Calculate how many times the rule fires
      const fireCount = Math.floor(expandedQualifying.length / totalNeeded);
      if (fireCount < 1) continue;

      // The cheapest totalNeeded*fireCount units form the deals (trigger + reward).
      const dealUnits = expandedQualifying.slice(0, totalNeeded * fireCount);

      // The reward items are the cheapest `rewardQty * fireCount` of those.
      const rewardItemCount = rewardQty * fireCount;
      let rewardItems = dealUnits.slice(0, rewardItemCount);

      // If reward categories differ from trigger categories, filter further
      if (rewardCats.length > 0) {
        rewardItems = rewardItems.filter(i => itemMatchesCategories(i, effectiveRewardCats));
      }

      if (!rewardItems.length) continue;

      // Calculate savings per reward item
      const appliedItems = [];
      let totalSaving = 0;
      for (const ri of rewardItems) {
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
      if (totalSaving <= 0) continue;

      // Consume the deal units (trigger + reward) so a later rule can't reuse them
      dealUnits.forEach(u => consumed.add(u._key));

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
 * Convert an engine result into the canonical check-level discount shape used by
 * session.discounts[] / closed_checks.discounts (the SAME shape manual discounts use),
 * so totals, receipts and reports need no changes.
 *
 * IMPORTANT: every auto-saving is emitted as a FIXED amount (type:'amount', value=£ saved),
 * NOT a percent. The engine already resolved percent/free/bundle rewards to a concrete £
 * totalSaving; emitting type:'percent' would wrongly re-derive it against the whole subtotal.
 */
export const toAppliedDiscount = (ad) => ({
  id: ad.ruleId,
  label: ad.ruleName,
  type: 'amount',
  value: ad.totalSaving,
  amount: ad.totalSaving,
  scope: 'check',
  isAuto: true,
  appliedItems: ad.appliedItems,
  ruleKind: ad.rewardType,
});

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
