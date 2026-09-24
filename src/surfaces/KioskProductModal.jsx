/**
 * KioskProductModal — v5.5.1
 *
 * Touch-friendly product configurator. Single-screen flow — variants, modifier
 * groups, instruction groups, and NESTED modifiers all render inline within
 * one scrollable surface. The Add-to-order CTA stays sticky at the bottom so
 * the customer always sees price + total + qty.
 *
 * What changed in v5.5.1:
 *   - Nested modifiers (option.subGroupId) now expand INLINE under the parent
 *     option instead of pushing the customer to a new screen. Sub-groups are
 *     pre-fetched on mount so there's no loading flicker on tap.
 *   - Typography sized for kiosk distance (name 38, options 18, etc).
 *   - All colors via [data-kiosk-theme] CSS vars from globals.css.
 *   - Single-flow even for items without modifiers — same shell, just no
 *     groups render, qty + add CTA sit immediately under the description.
 *
 * Modifier group shape (from Supabase):
 *   { id, name, min, max, selection_type ('single'|'multiple'),
 *     options: [{id, name, price, subGroupId?}] }
 *
 * Selection state shape:
 *   selections:        { [groupId]: [optionId, ...] }   // always array
 *   nestedSelections:  { 'groupId:optionId:occurrenceIdx':
 *                          { [subGroupId]: [optionId, ...] } }
 *
 * Validation:
 *   - Each top-level group: min <= count <= max
 *   - Single groups have implicit max=1
 *   - For each selected occurrence of a parent option with subGroupId,
 *     the resolved sub-group must also satisfy its own min/max
 */

import { useState, useEffect, useMemo } from 'react';
import { productImage } from '../lib/productImage';
import { supabase } from '../lib/supabase';
import { useStore } from '../store';
import { t, tf, useKioskLang } from '../lib/i18n';
import { translateEnglish, useMenuText } from '../lib/menuText';
import { displayName } from '../lib/itemDisplay';
import { kioskLineNeed } from '../lib/kioskLine';
import { money } from '../lib/currency';
import { orderOptionFlow } from '../lib/optionFlow';
import { resolveItemPrice, variantChildren, variantFromPrice } from '../lib/menuPricing';
import { normalizeGroup, kioskSheetGroupHint } from '../lib/kioskGroupRules';
import {
  kioskOptionGroupPlan, kioskSheetGroupIds, kioskSheetInstructionIds, kioskSheetGroups,
  kioskPruneSelections, kioskPruneNestedSelections,
  validateSelections, priceDelta, buildModsArray, summarizeForDisplay, kioskSheetNestedHint,
} from '../lib/kioskOptionGroups';
import KioskItemSheet from './kiosk/KioskItemSheet';
import { subitemNameIndex } from '../lib/menuRules';

// ============================================================
// VALIDATION HELPERS (pure)
// ============================================================
// collectNestedOccurrences, validateSelections, priceDelta, buildModsArray and
// summarizeForDisplay moved word for word to lib/kioskOptionGroups.js, with the rule for
// which groups a sized item shows (parent groups plus the picked size's groups, like the till).

// Stable empties, so the group memo below does not rebuild on every render.
const NO_GROUPS = [];
const NO_SIZES = [];
const NO_DEFS = [];

// ============================================================
// MAIN COMPONENT
// ============================================================

// orderType + activeMenuId: the channel and live menu KioskApp prices with, so the
// synthesised Size group prices its variants through the same resolver as the
// card and the cart line (src/lib/menuPricing.js). Without them a variant child
// with a menu tier showed and charged base here while the board and online
// showed the tier.
// New kiosk design (stage B): look="sheet" draws the same item, groups, rules, stock gates
// and add path as the README bottom sheet (./kiosk/KioskItemSheet.jsx). Every hook, state
// value and handler below is shared; only the drawing differs. With look unset (today's
// kiosk) nothing changes.
//   avoidAllergens  : the allergens the customer asked to avoid (the kiosk's allergenFilter)
//   ackRequired     : the venue makes the customer tick that they understand before Add works
//                     (the sheet asks only when the item, its size or a pick has one of them)
//   onPickAllergens : (ids) called just before Add with the allergens of the picked options,
//                     so the new design's allergen check can count them on the basket line
//   fetchGroups : optional (ids) => Promise<{ data, error }> for the modifier_groups read;
//                 unset reads Supabase exactly as before (the DEV preview passes sample data)
export default function KioskProductModal({ item, allItems = [], brandColor, brandAccent, basePrice, addLabel, onAdd, onCancel, dailyCounts = {}, cartItemUsage = {}, orderType = 'dineIn', activeMenuId = null, look, avoidAllergens = null, ackRequired = false, onPickAllergens, fetchGroups, defaultImage = null }) {
  const heroImage = productImage(item, defaultImage);
  // Subscribe to language changes so t() strings re-render if the customer
  // switches language while the modal is open.
  useKioskLang();
  useMenuText();   // the sheet's venue text follows the picked language (no effect on today's modal)
  const allInstructionDefs = useStore(s => s.instructionGroupDefs) || NO_DEFS;

  // v5.5.285: Stock enforcement — cap qty selector and modifier selections
  // to the remaining stock minus what's already in the customer's cart.
  // cartItemUsage is { [itemId]: totalQtyInCart } computed by KioskApp.
  const eightySixIds = useStore(s => s.eightySixIds || []);

  // (v5.5.27/28 sub-item lookup + diagnostic moved below state declarations to avoid TDZ.)


  // Loaded once when the item opens (the effect below): the synthesised Size group (null when
  // the item has no sizes) and every modifier_groups row the item AND its offered sizes use
  // ({ [id]: row }, null until loaded).
  const [sizeGroup, setSizeGroup] = useState(null);
  const [groupRows, setGroupRows] = useState(null);
  const [subGroupsCache, setSubGroupsCache] = useState({}); // { [subGroupId]: normalizedGroup }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selections, setSelections] = useState({}); // { groupId: [optionId, ...] }
  const [nestedSelections, setNestedSelections] = useState({}); // { 'gid:oid:idx': { subGroupId: [...] } }
  const [qty, setQty] = useState(1);
  const [showError, setShowError] = useState(false);
  const [stockErr, setStockErr] = useState(null);   // v5.6.69 — "Only N × X left" commit refusal
  const [instructions, setInstructions] = useState('');

  // ── The groups on screen (lib/kioskOptionGroups.js, the till's rule) ──
  // A sized item shows the PICKED SIZE's own groups, and the parent's only when that size has
  // none (the till's InlineItemFlow rule), for modifier and instruction groups each on their
  // own, in the parent's option_group_order, with the Size group first. Before a size is
  // picked: only the groups every offered size would show, so they do not jump in when a size
  // is tapped. Every row was read when the item opened, so this is worked out on the spot: no
  // read, no loading flash, no reset of the picks. A plain item shows its own groups as before.
  const pickedSizeId = sizeGroup ? ((selections[sizeGroup.id] || [])[0] ?? null) : null;
  const offeredSizes = useMemo(() => {
    if (!sizeGroup) return NO_SIZES;
    const byId = new Map((allItems || []).filter(Boolean).map(i => [i.id, i]));
    return (sizeGroup.options || []).map(o => byId.get(o.id)).filter(Boolean);
  }, [sizeGroup, allItems]);
  const groupPlan = useMemo(
    () => kioskOptionGroupPlan({ parent: item, sizes: offeredSizes, pickedSizeId, groupRows, instructionDefs: allInstructionDefs }),
    [item, offeredSizes, pickedSizeId, groupRows, allInstructionDefs],
  );
  // Two sizes that show the same groups keep the same group objects (Regular to Large).
  const groupPlanKey = JSON.stringify([groupPlan.modifiers, groupPlan.instructions, groupPlan.order]);
  const groups = useMemo(() => {
    if (!groupRows) return NO_GROUPS;
    return kioskSheetGroups({
      plan: groupPlan, sizeGroup, groupRows, instructionDefs: allInstructionDefs, normalizeGroup, orderOptionFlow,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupPlanKey, sizeGroup, groupRows, allInstructionDefs]);

  // v5.5.285: Calculate max qty for the main item based on stock
  const itemStock = dailyCounts[item?.id] || null;
  const itemInCart = cartItemUsage[item?.id] || 0;
  // If stock is tracked, cap at remaining minus what's already in cart
  const maxQty = itemStock ? Math.max(0, itemStock.remaining - itemInCart) : Infinity;
  // Helper: get remaining stock for a modifier option by its itemId
  const getOptionStock = (optItemId) => {
    if (!optItemId) return Infinity;
    const stock = dailyCounts[optItemId];
    if (!stock) return Infinity;
    const inCart = cartItemUsage[optItemId] || 0;
    // Also count current selections in THIS modal that use this itemId.
    // v5.6.69: resolve via resolveOptItemId (not raw opt.itemId) so picks of
    // name-matched options lower the badge like explicitly-linked ones do.
    let inModal = 0;
    for (const g of groups) {
      const picked = selections[g.id] || [];
      for (const pid of picked) {
        const opt = (g.options || []).find(o => o.id === pid);
        if (opt && resolveOptItemId(opt) === optItemId) inModal++;
      }
    }
    return Math.max(0, stock.remaining - inCart - (inModal * qty));
  };

  // ============================================================
  // v5.5.30: Resolve effective image/description/allergens for a modifier
  // option by matching against a sold-alone sub-item.
  //
  // CRITICAL field-name handling: items reach this modal via two different
  // paths in the codebase. POS surfaces read normalized camelCase from the
  // Zustand store (soldAlone, menuName, kitchenName, receiptName) — that
  // normalization happens in SyncBridge. The kiosk's useKioskMenu, however,
  // reads raw Supabase rows where the same fields live as snake_case
  // (sold_alone, menu_name, kitchen_name, receipt_name). v5.5.27/28 only
  // looked at camelCase, so on the kiosk every lookup returned undefined and
  // no sub-item was ever matched even when the data was perfect. The fix
  // reads both shapes for every relevant field.
  //
  // The match is gated to soldAlone===true so pure-modifier sub-items not
  // curated for customer display don't leak description/image — Peter's
  // "only when item can be sold alone also" constraint.
  //
  // Precedence: explicit fields on the modifier option win over inherited
  // sub-item fields, matching POS behavior in InlineItemFlow.
  // ============================================================
  // Pictures and descriptions come only from sold alone sub items. Allergens, 86 and stock
  // come from EVERY sub item: since v5.8.95 a new option only sub item is saved as not sold
  // alone, and its allergens must still reach the customer (lib/menuRules subitemNameIndex).
  const subitemByName = useMemo(() => subitemNameIndex(allItems, { soldAloneOnly: true }), [allItems]);
  const anySubitemByName = useMemo(() => subitemNameIndex(allItems), [allItems]);

  const resolveOpt = (opt) => {
    const key = String(opt?.name || '').trim().toLowerCase();
    const match = key ? subitemByName.get(key) : null;
    const anyMatch = key ? (match || anySubitemByName.get(key)) : null;
    return {
      image: opt?.image || match?.image || null,
      description: opt?.description || match?.description || null,
      allergens: (Array.isArray(opt?.allergens) && opt.allergens.length > 0)
        ? opt.allergens
        : (Array.isArray(anyMatch?.allergens) ? anyMatch.allergens : []),
    };
  };

  // v5.5.289: Resolve the effective itemId for a modifier option.
  // Options that were linked via the back-office UI have opt.itemId.
  // Options without it can still be matched to a menu item by name
  // (via subitemByName) — this is critical for 86/stock enforcement:
  // without it, an 86'd item is still orderable through its modifier group.
  const resolveOptItemId = (opt) => {
    if (opt?.itemId || opt?.item_id) return opt.itemId || opt.item_id;
    const key = String(opt?.name || '').trim().toLowerCase();
    const match = key ? (subitemByName.get(key) || anySubitemByName.get(key)) : null;
    return match?.id || null;
  };

  // v5.6.69 — the line qty multiplies every picked option too ("Box of 3" ×3 =
  // 3 donuts). The stepper cap must honour the TIGHTEST picked option's stock,
  // not just the main item's (the old hole: pick 1 donut with 1 left, then
  // qty→3 walked straight past the per-tap cap). Lives BELOW resolveOptItemId /
  // subitemByName — both are consts this memo closes over at render time.
  const modMaxQty = useMemo(() => {
    const picksById = {};
    for (const g of groups) {
      for (const pid of (selections[g.id] || [])) {
        const o = (g.options || []).find(x => x.id === pid);
        const rid = o ? resolveOptItemId(o) : null;
        if (rid) picksById[rid] = (picksById[rid] || 0) + 1;
      }
    }
    let cap = Infinity;
    for (const [rid, picks] of Object.entries(picksById)) {
      const stock = dailyCounts[rid];
      if (!stock || !Number.isFinite(Number(stock.remaining))) continue;
      const avail = Number(stock.remaining) - (cartItemUsage[rid] || 0);
      cap = Math.min(cap, Math.floor(Math.max(0, avail) / picks));
    }
    return cap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, selections, dailyCounts, cartItemUsage, subitemByName]);
  const lineMaxQty = Math.min(maxQty, modMaxQty);

  // Load the Size group and every modifier group row the item and its offered sizes use (ONE
  // read), then pre-fetch any sub-groups referenced by option.subGroupId. Which rows show is
  // worked out above from the picked size.
  useEffect(() => {
    let alive = true;
    (async () => {
      let sg = null;
      let offered = [];

      // ── Synthesize 'Size' group for a variant parent ──
      // A parent is any item with live child rows (parent_id), typed
      // 'variants' or not, the same test the till (POSSurface) and online use.
      // Sizes that are 86'd or sold out are not offered at all, the till's own
      // filter (POSSurface builds variantChildren with !eightySixIds), so a
      // size the venue has run out of cannot be added and sent to the kitchen.
      // Each size carries itemId: the child row's id, so the per-tap gate
      // (resolveOptItemId, getOptionStock, modMaxQty) covers a size that is
      // 86'd or runs out while the sheet is open, exactly like any linked
      // modifier option.
      {
        const soldOut = (c) => eightySixIds.includes(c.id)
          || (dailyCounts[c.id] && Number(dailyCounts[c.id].remaining) <= 0);
        const sizes = variantChildren(item, allItems).filter(c => !soldOut(c));
        offered = sizes;
        if (sizes.length > 0) {
          // Each size priced by the shared resolver (menu tier, channel, base),
          // the same number the kiosk card and the cart line use for that child.
          // Sizes are ABSOLUTE prices, never deltas from the cheapest: price
          // stays 0 (the delta walk skips this group anyway) and the button
          // label and the charge both read __absolutePrice. Cheapest ignores
          // unpriced sizes, as the card and online do.
          const childPrice = (c) => resolveItemPrice(c, orderType, activeMenuId);
          const cheapestPrice = variantFromPrice(item, sizes, orderType, activeMenuId) || 0;
          sg = normalizeGroup({
            id: '__variants__',
            // English, like every other group name the checks and today's modal read (translating
            // it here would give today's modal "Pick a Tamaño"). The new sheet heads this group
            // with k2.sheet.size and kioskSheetGroupHint hands back the same key for its guidance.
            name: 'Size',
            selection_type: 'single',
            min: 1, max: 1, min_select: 1, max_select: 1,
            __isVariantGroup: true,
            __cheapestPrice: cheapestPrice,
            options: sizes.map(c => ({
              id: c.id,
              name: c.name,
              itemId: c.id,
              price: 0,
              __absolutePrice: childPrice(c),
            })),
          });
        }
      }

      // ── Load assigned_modifier_groups: the parent's and every offered size's ──
      const ids = kioskSheetGroupIds(item, offered);
      const rows = {};
      if (ids.length > 0) {
        try {
          const { data, error } = await (fetchGroups ? fetchGroups(ids) : supabase
            .from('modifier_groups')
            .select('*')
            .in('id', ids));
          if (error) throw error;
          if (!alive) return;
          for (const g of (data || [])) {
            if (g && g.id != null && ids.includes(g.id)) rows[g.id] = g;
          }
          // A group row that is not found is skipped when the groups are built.
          for (const id of ids) {
            if (!rows[id]) console.warn('[kiosk] modifier group not found:', id, '(referenced by item ' + (item?.name || item?.id) + ')');
          }
        } catch (e) {
          if (alive) setError(e?.message || 'Failed to load options');
        }
      }

      // ── Instruction groups ──
      // Built with the modifier groups above from the store's definitions. v5.5.948: ONE
      // ordered flow (lib/optionFlow.js): the Back Office Flow tab's drag order interleaves
      // instruction + modifier groups; with no saved order, instructions come first (the
      // v5.5.947 rule). A missing definition is skipped.
      for (const igId of kioskSheetInstructionIds(item, offered)) {
        if (!allInstructionDefs.some(g => g && g.id === igId)) console.warn('[kiosk] instruction group not found:', igId);
      }

      // ── Pre-fetch all sub-groups referenced by option.subGroupId ──
      const subGroupIds = new Set();
      for (const g of Object.values(rows)) {
        for (const opt of (g.options || [])) {
          if (opt && opt.subGroupId) subGroupIds.add(opt.subGroupId);
        }
      }
      let subCache = {};
      if (subGroupIds.size > 0) {
        try {
          const { data, error } = await (fetchGroups ? fetchGroups(Array.from(subGroupIds)) : supabase
            .from('modifier_groups')
            .select('*')
            .in('id', Array.from(subGroupIds)));
          if (error) throw error;
          if (!alive) return;
          for (const row of (data || [])) {
            subCache[row.id] = normalizeGroup(row);
          }
        } catch (e) {
          console.warn('[kiosk] failed to pre-fetch sub-groups:', e?.message);
        }
      }

      if (alive) {
        setSizeGroup(sg);
        setGroupRows(rows);
        setSubGroupsCache(subCache);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [item, allItems, orderType, activeMenuId, fetchGroups]);

  // A size change can hide a group that only the old size carried: its picks and nested picks
  // are dropped, so nothing hidden reaches the basket line or its merge key. Picks in groups
  // still shown are kept. Validation below runs on the new groups, so a required group on the
  // new size blocks Add until it is answered. Both prune helpers return the same object when
  // nothing changes, so this never loops.
  useEffect(() => {
    if (loading) return;
    setSelections(prev => kioskPruneSelections(groups, prev));
    setNestedSelections(prev => kioskPruneNestedSelections(groups, prev));
  }, [groups, loading]);

  // ── Derived state ──
  const validation = useMemo(
    () => validateSelections(groups, selections, nestedSelections, subGroupsCache),
    [groups, selections, nestedSelections, subGroupsCache]
  );
  const isValid = validation === null;

  // v5.5.33: one-shot diagnostic — prints the rule values for each loaded
  // group. Helps confirm whether the kiosk is reading the same min/max/
  // selectionType the BO saved. Only logs once per group set.
  useEffect(() => {
    if (loading) return;
    if (!groups || groups.length === 0) return;
    // eslint-disable-next-line no-console
    console.log('[kiosk modal v5.5.33] modifier group rules', groups.map(g => ({
      id: g.id,
      name: g.name,
      raw_min: g.min,
      raw_max: g.max,
      raw_selection_type: g.selection_type,
      raw_selectionType: g.selectionType,
      normalized_min: g._min,
      normalized_max: g._max,
      normalized_isSingle: g._isSingle,
      optionCount: (g.options || []).length,
      __isInstructionGroup: !!g.__isInstructionGroup,
      __isVariantGroup: !!g.__isVariantGroup,
    })));
  }, [loading, groups]);
  const variantGroup = groups.find(g => g.__isVariantGroup);
  const pickedVariantId = variantGroup ? (selections[variantGroup.id] || [])[0] : null;
  const pickedVariantOpt = (variantGroup && pickedVariantId) ? variantGroup.options.find(o => o.id === pickedVariantId) : null;
  // A variant parent is never charged its own basePrice (0). Before a size is
  // picked the header shows "from <cheapest>"; once picked, that size's absolute
  // resolved price is the base the modifier deltas stack on, and it is the
  // priceEach handed to addToCart, so the cart line, the kiosk total and the
  // order line all carry the tier price (Half on the Bar menu = 1.23).
  let effectiveBase = basePrice || 0;
  if (variantGroup) effectiveBase = pickedVariantOpt ? pickedVariantOpt.__absolutePrice : variantGroup.__cheapestPrice;
  const totalPriceEach = effectiveBase + priceDelta(groups, selections, nestedSelections, subGroupsCache);
  const totalPrice = totalPriceEach * qty;

  // ── Selection mutation ──
  const incOption = (group, optId) => {
    setShowError(false);
    setStockErr(null);
    setSelections(prev => {
      const current = prev[group.id] || [];
      // v5.5.289: Check stock for this option's linked item.
      // resolveOptItemId falls back to name-matching so options without
      // an explicit itemId are still blocked when their item is 86'd.
      const opt = (group.options || []).find(o => o.id === optId);
      const optItemId = resolveOptItemId(opt);
      if (optItemId) {
        // Check 86'd (explicit + stock-based)
        if (eightySixIds.includes(optItemId)) return prev;
        if (dailyCounts[optItemId] && dailyCounts[optItemId].remaining <= 0) return prev;
        const stock = dailyCounts[optItemId];
        if (stock) {
          const inCart = cartItemUsage[optItemId] || 0;
          // Count how many times this option is already selected (across all groups)
          let inModal = 0;
          for (const g of groups) {
            const gpicked = (g.id === group.id ? current : (selections[g.id] || []));
            for (const pid of gpicked) {
              const o = (g.options || []).find(x => x.id === pid);
              if (o && resolveOptItemId(o) === optItemId) inModal++;
            }
          }
          // v5.6.69: one more pick consumes (inModal+1) × line qty units — the
          // old raw-pick comparison ignored the qty multiplier entirely.
          if ((inModal + 1) * qty > stock.remaining - inCart) return prev; // at stock limit
        }
      }
      let next;
      if (group._isSingle) {
        // Toggle off if same option already picked, otherwise replace
        next = current.length === 1 && current[0] === optId ? [] : [optId];
      } else {
        if (current.length >= group._max) return prev;
        next = [...current, optId];
      }
      return { ...prev, [group.id]: next };
    });
  };

  const decOption = (group, optId) => {
    setShowError(false);
    setStockErr(null);
    setSelections(prev => {
      const current = prev[group.id] || [];
      const idx = current.lastIndexOf(optId);
      if (idx < 0) return prev;
      const next = [...current.slice(0, idx), ...current.slice(idx + 1)];
      return { ...prev, [group.id]: next };
    });
    // Drop the LAST occurrence's nested selection for this option
    setNestedSelections(prev => {
      const currentList = (selections[group.id] || []).filter(id => id === optId);
      const lastIdx = currentList.length - 1;
      if (lastIdx < 0) return prev;
      const key = group.id + ':' + optId + ':' + lastIdx;
      if (!prev[key]) return prev;
      const out = { ...prev };
      delete out[key];
      return out;
    });
  };

  // ── Nested selection mutation ──
  const setNestedPick = (parentKey, sub, subOptId) => {
    setShowError(false);
    setStockErr(null);
    // v5.6.69: nested picks had NO 86/stock gate at all — an 86'd or sold-out
    // item stayed pickable through a sub-group. Same checks as incOption.
    const subOpt = (sub.options || []).find(o => o.id === subOptId);
    const subItemId = resolveOptItemId(subOpt);
    if (subItemId) {
      if (eightySixIds.includes(subItemId)) return;
      const stock = dailyCounts[subItemId];
      if (stock) {
        const avail = Number(stock.remaining) - (cartItemUsage[subItemId] || 0);
        const cur0 = (nestedSelections[parentKey] && nestedSelections[parentKey][sub.id]) || [];
        const picks = cur0.filter(id => {
          const o = (sub.options || []).find(x => x.id === id);
          return o && resolveOptItemId(o) === subItemId;
        }).length;
        if ((picks + 1) * qty > avail) return;
      }
    }
    setNestedSelections(prev => {
      const cur = (prev[parentKey] && prev[parentKey][sub.id]) || [];
      let next;
      if (sub._isSingle) {
        next = cur.length === 1 && cur[0] === subOptId ? [] : [subOptId];
      } else {
        if (cur.length >= sub._max) return prev;
        next = [...cur, subOptId];
      }
      return { ...prev, [parentKey]: { ...(prev[parentKey] || {}), [sub.id]: next } };
    });
  };

  const tryAdd = () => {
    if (!isValid) {
      setShowError(true);
      const firstBad = groups.find(g => {
        const picked = (selections[g.id] || []).length;
        return picked < g._min || picked > g._max;
      });
      if (firstBad) {
        const el = document.querySelector('[data-mod-group="' + firstBad.id + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const mods = buildModsArray(groups, selections, nestedSelections, subGroupsCache);
    // v5.5.289: Enrich mods that lack itemId via name-matching.
    // Without this, stock decrement in KioskApp/OnlineCheckout skips
    // modifier options whose item link is only implicit (name match).
    for (const m of mods) {
      if (!m.itemId && m.label) {
        const key = String(m.label).trim().toLowerCase();
        const match = subitemByName.get(key);
        if (match?.id) m.itemId = match.id;
      }
    }
    // v5.6.69 — FINAL stock gate at commit. The per-tap caps cover the common
    // paths, but this is the single choke point that catches every corner
    // (nested picks, qty bumped after picking, races with another kiosk):
    // aggregate this line's need per linked item (picks × qty, main item × qty)
    // and refuse with a named message rather than silently overselling.
    // The chosen size row (null when the item has no sizes). The Size group is
    // not in mods (buildModsArray skips it), so the size is handed to onAdd on
    // its own and the gate counts the size and its parent, like the till.
    const variantItem = pickedVariantOpt ? ((allItems || []).find(i => i.id === pickedVariantOpt.id) || null) : null;
    {
      const need = kioskLineNeed({ item, variantItem, mods, qty });
      for (const [rid, want] of Object.entries(need)) {
        const banned = eightySixIds.includes(rid);
        const stock = dailyCounts[rid];
        const avail = banned ? 0
          : (stock && Number.isFinite(Number(stock.remaining)))
            ? Number(stock.remaining) - (cartItemUsage[rid] || 0)
            : Infinity;
        if (want > avail) {
          const mi = (allItems || []).find(i => i.id === rid);
          const nm = mi?.menuName || mi?.menu_name || mi?.name || t('k2.sheet.thatItem');
          setStockErr(avail <= 0
            ? tf('k2.sheet.stockSoldOut', { name: translateEnglish(nm) })
            : tf('k2.sheet.stockOnlyLeft', { n: Math.max(0, avail), name: translateEnglish(nm) }));
          return;
        }
      }
    }
    setStockErr(null);
    const summary = summarizeForDisplay(groups, selections, nestedSelections, subGroupsCache);
    onAdd({
      qty,
      selections,
      mods,
      summary,
      priceEach: totalPriceEach,
      variantItem,
      instructions: instructions.trim(),
    });
  };

  // ============================================================
  // RENDER  (v5.5.26 redesign)
  // ============================================================
  // Helper for hint text used by groups + sub-groups.
  function buildHint(min, max) {
    // v5.5.33: clearer "pick exactly N" wording when min === max > 1.
    if (min === 0 && max === 1) return t('product.optional') + ' · ' + t('product.pickOne');
    if (min === max && min === 1) return t('product.required') + ' · ' + t('product.pickOne');
    if (min === max && min > 1) return t('product.required') + ' · ' + t('product.pick') + ' ' + min;
    if (min > 0) return t('product.required') + ' · ' + t('product.pick') + ' ' + min + (max > min ? '–' + max : '');
    return t('product.optional') + ' · ' + t('product.upTo') + ' ' + max;
  }

  // v5.5.33: one-shot diagnostic — prints loaded group rules so we can verify
  // the kiosk is reading the same min/max/selectionType the BO has saved. Logs
  // per-group: id, name, raw stored values, normalized _min/_max, selection
  // type. Fires once after groups load and again if they change. Remove once
  // the group-rules-not-respected issue is confirmed resolved.

  // The new design's sheet says a range in words ("pick 1 to 3", k2.sheet.range): no dash in
  // customer text. Today's modal below keeps buildHint exactly as it was.
  const buildSheetHint = (min, max) => (min > 0 && max > min
    ? t('product.required') + ' · ' + t('product.pick') + ' ' + tf('k2.sheet.range', { min, max })
    : buildHint(min, max));

  if (look === 'sheet') {
    // The sheet's guidance line in the customer's language ("Choose at least 1 from Extras",
    // "Choose 1 from Milk for Latte"), never today's English "Pick a " + group name.
    const sheetHint = isValid ? null
      : (kioskSheetGroupHint(groups, selections) || kioskSheetNestedHint(groups, selections, nestedSelections, subGroupsCache));
    // groupKey: the made up Size group, said in the customer's language. A venue's group and
    // option names go through the venue's translations (lib/menuText.js), English when none.
    const sheetVars = !sheetHint ? null : {
      ...sheetHint.vars,
      group: sheetHint.groupKey ? t(sheetHint.groupKey) : translateEnglish(sheetHint.vars.group),
      ...(sheetHint.vars.option != null ? { option: translateEnglish(sheetHint.vars.option) } : {}),
    };
    return (
      <KioskItemSheet
        item={item}
        loading={loading}
        error={error}
        groups={groups}
        subGroupsCache={subGroupsCache}
        selections={selections}
        nestedSelections={nestedSelections}
        showError={showError}
        stockErr={stockErr}
        qty={qty}
        setQty={setQty}
        lineMaxQty={lineMaxQty}
        instructions={instructions}
        setInstructions={setInstructions}
        validation={sheetHint ? tf(sheetHint.key, sheetVars) : validation}
        isValid={isValid}
        variantGroup={variantGroup}
        pickedVariantOpt={pickedVariantOpt}
        totalPriceEach={totalPriceEach}
        totalPrice={totalPrice}
        basePrice={basePrice}
        brandColor={brandColor}
        incOption={incOption}
        decOption={decOption}
        setNestedPick={setNestedPick}
        tryAdd={tryAdd}
        resolveOpt={resolveOpt}
        resolveOptItemId={resolveOptItemId}
        getOptionStock={getOptionStock}
        eightySixIds={eightySixIds}
        dailyCounts={dailyCounts}
        buildHint={buildSheetHint}
        onCancel={onCancel}
        allItems={allItems}
        avoidAllergens={avoidAllergens}
        ackRequired={ackRequired}
        onPickAllergens={onPickAllergens}
      />
    );
  }

  if (loading) {
    return (
      <div style={overlayStyle()}>
        <div style={{ color: 'var(--kFg)', fontSize: 22, padding: 60 }}>{t('product.loading')}</div>
      </div>
    );
  }

  return (
    <div style={overlayStyle()}>
      {/* Hero image with X close button (top-right) */}
      <div style={{
        position: 'relative',
        width: '100%',
        height: 'clamp(240px, 36vh, 460px)',
        background: heroImage ? '#000' : ('linear-gradient(135deg, ' + brandColor + ', ' + (brandAccent || brandColor) + ')'),
        flexShrink: 0,
        overflow: 'hidden',
      }}>
        {heroImage && (
          <img src={item.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
        <button
          onClick={onCancel}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 'clamp(14px, 2vw, 22px)',
            right: 'clamp(14px, 2vw, 22px)',
            width: 'clamp(48px, 5.4vw, 60px)',
            height: 'clamp(48px, 5.4vw, 60px)',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(10px)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 'clamp(20px, 2.4vw, 26px)',
            color: '#111',
            fontWeight: 600,
            border: 0,
            cursor: 'pointer',
            fontFamily: 'inherit',
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
          }}
        >×</button>
      </div>

      {/* Scrollable body */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: 'clamp(22px, 3vw, 36px) clamp(22px, 3vw, 36px) clamp(14px, 2vw, 20px)',
      }}>
        {/* Title — brand color */}
        <div style={{
          fontSize: 'clamp(30px, 4.4vw, 48px)',
          fontWeight: 800,
          letterSpacing: '-0.02em',
          marginBottom: 'clamp(10px, 1.4vw, 14px)',
          lineHeight: 1.1,
          color: brandColor,
        }}>{displayName(item)}</div>

        {/* Description — muted */}
        {item?.description && (
          <div style={{
            fontSize: 'clamp(16px, 1.9vw, 20px)',
            color: 'var(--kFgMuted)',
            lineHeight: 1.5,
            marginBottom: 'clamp(16px, 2.2vw, 24px)',
          }}>{item.description}</div>
        )}

        {/* Base price, brand color, large. Variant parent: "from <cheapest size>"
            until a size is picked, then that size's absolute resolved price.
            Never 0.00 for a parent. Same figures as the kiosk card and online. */}
        <div style={{
          fontSize: 'clamp(26px, 3.4vw, 38px)',
          fontWeight: 800,
          color: brandColor,
          letterSpacing: '-0.01em',
          marginBottom: 'clamp(20px, 2.6vw, 28px)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {variantGroup
            ? (pickedVariantOpt
                ? money(Number(pickedVariantOpt.__absolutePrice ?? 0))
                : <><span style={{ fontSize: '0.55em', fontWeight: 700, opacity: 0.7, marginRight: 8 }}>{t('menu.from')}</span>{money(Number(variantGroup.__cheapestPrice ?? 0))}</>)
            : money(Number(basePrice ?? 0))}
        </div>

        {/* Allergens — icon + label, then comma list. Brand-color text matches reference. */}
        {Array.isArray(item?.allergens) && item.allergens.length > 0 && (
          <div style={{ marginBottom: 'clamp(24px, 3.2vw, 36px)' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 6,
              color: brandColor,
            }}>
              {/* Inline allergen-warning icon (test-tube + drop). currentColor inherits brand. */}
              <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 3 H15" />
                <path d="M10 3 V11 L6 18 Q6 21 9 21 H15 Q18 21 18 18 L14 11 V3" />
                <circle cx="20" cy="6" r="2.5" />
              </svg>
              <span style={{
                fontSize: 'clamp(18px, 2.2vw, 22px)',
                fontWeight: 800,
                letterSpacing: '-0.01em',
              }}>{t('product.allergens')}</span>
            </div>
            <div style={{
              fontSize: 'clamp(16px, 1.9vw, 20px)',
              color: brandColor,
              fontWeight: 600,
              textTransform: 'capitalize',
            }}>{item.allergens.join(', ')}</div>
          </div>
        )}

        {error && (
          <div style={{
            background: 'var(--kError-bg)',
            border: '1px solid var(--kError-border)',
            color: 'var(--kError-fg)',
            padding: '12px 16px',
            borderRadius: 12,
            fontSize: 14,
            marginBottom: 16,
          }}>{error}</div>
        )}

        {/* Modifier groups */}
        {groups.map(g => {
          const picked = selections[g.id] || [];
          const remaining = g._max - picked.length;
          const isInvalid = showError && (picked.length < g._min || picked.length > g._max);
          const hint = buildHint(g._min, g._max);
          // Decide grid columns: 2-col compact when no rich content, 1-col when any
          // option has an image OR description so that media gets full layout space.
          // v5.5.31: layout reverted to fixed 2-col grid per Peter's feedback.
          // Rich content (image / description / allergens) now renders inside
          // the option card via a small thumbnail + compact text — no need to
          // expand the card to full width. Single-column fallback is kept for
          // the case where the entire group genuinely is single-pick variants
          // (handled by the natural responsive sizing of clamp() — not a
          // content-driven override).
          const optGridCols = 'repeat(2, minmax(0, 1fr))';

          return (
            <div key={g.id} data-mod-group={g.id} style={{ marginBottom: 'clamp(28px, 3.6vw, 40px)' }}>
              {/* Group name — brand color, larger */}
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 4,
                gap: 12,
              }}>
                <div style={{
                  fontSize: 'clamp(22px, 2.8vw, 30px)',
                  fontWeight: 800,
                  color: brandColor,
                  letterSpacing: '-0.01em',
                }}>{g.name}</div>
                {picked.length > 0 && remaining > 0 && !g._isSingle && (
                  <div style={{ fontSize: 'clamp(13px, 1.4vw, 15px)', color: 'var(--kFgFaint)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{picked.length} / {g._max}</div>
                )}
              </div>
              {/* Subtitle hint — also brand color, lighter weight */}
              <div style={{
                fontSize: 'clamp(14px, 1.6vw, 17px)',
                color: isInvalid ? 'var(--kError-fg)' : brandColor,
                marginBottom: 'clamp(14px, 1.8vw, 20px)',
                fontWeight: isInvalid ? 700 : 600,
                opacity: isInvalid ? 1 : 0.85,
              }}>
                {hint}
              </div>

              {/* Option grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: optGridCols,
                gap: 'clamp(10px, 1.4vw, 14px)',
              }}>
                {(g.options || []).map(opt => {
                  const optCount = picked.filter(id => id === opt.id).length;
                  const isSelected = optCount > 0;
                  // Size buttons show each size's ABSOLUTE resolved price (online
                  // and the till do the same). Modifier options keep their +£x delta.
                  const priceLabel = g.__isVariantGroup
                    ? money(Number(opt.__absolutePrice ?? 0))
                    : (opt.price && opt.price > 0)
                      ? '+£' + Number(opt.price).toFixed(2)
                      : (opt.price && opt.price < 0)
                        ? '-£' + Math.abs(opt.price).toFixed(2)
                        : '';
                  const atCap = picked.length >= g._max && !g._isSingle;
                  const showStepper = !g._isSingle && optCount > 0;
                  const sub = opt.subGroupId ? subGroupsCache[opt.subGroupId] : null;
                  // v5.5.27: pull effective display fields (own option > matched sold-alone subitem).
                  const effective = resolveOpt(opt);

                  // v5.5.289: Stock enforcement for modifier options.
                  // resolveOptItemId falls back to name-matching against
                  // sold-alone sub-items when opt.itemId isn't explicitly set.
                  const optItemId = resolveOptItemId(opt);
                  const optStockRemaining = getOptionStock(optItemId);
                  const optIs86 = optItemId && (eightySixIds.includes(optItemId)
                    || (dailyCounts[optItemId] && dailyCounts[optItemId].remaining <= 0));
                  const optSoldOut = optIs86 || optStockRemaining <= 0;
                  const optAtStockCap = !optSoldOut && optStockRemaining < Infinity && optStockRemaining <= 0;
                  const blocked = optSoldOut || (atCap && !isSelected);

                  return (
                    <div key={opt.id} style={{ display: 'flex', flexDirection: 'column' }}>
                      <div
                        onClick={blocked ? undefined : () => incOption(g, opt.id)}
                        style={{
                          background: 'var(--kSurfaceRaised)',
                          border: '1.5px solid ' + (isSelected ? brandColor : (isInvalid ? 'var(--kError-border)' : 'var(--kBorder1)')),
                          borderRadius: sub && isSelected ? '16px 16px 0 0' : 16,
                          color: 'var(--kFg)',
                          transition: 'background 0.12s, border-color 0.12s',
                          overflow: 'hidden',
                          display: 'flex',
                          flexDirection: 'column',
                          cursor: blocked ? 'not-allowed' : 'pointer',
                          opacity: blocked ? 0.4 : 1,
                          position: 'relative',
                        }}
                      >
                        {/* v5.5.32: image-on-top, matching the menu landing-page product card style.
                            4:3 aspect, full card width. Selected state shown as a brand-color radio
                            badge in the top-right corner of the image so the customer can scan
                            multiple selections at a glance. Cards without images fall back to a
                            radio bullet inside the body row. */}
                        {effective.image ? (
                          <div style={{
                            width: '100%',
                            aspectRatio: '4/3',
                            background: 'var(--kImageBg)',
                            overflow: 'hidden',
                            flexShrink: 0,
                            position: 'relative',
                          }}>
                            <img src={effective.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                            {/* Selected badge — top-right corner overlay */}
                            <span style={{
                              position: 'absolute',
                              top: 10, right: 10,
                              width: 'clamp(28px, 3.2vw, 36px)',
                              height: 'clamp(28px, 3.2vw, 36px)',
                              borderRadius: g._isSingle ? '50%' : 10,
                              border: '2px solid ' + (isSelected ? brandColor : 'rgba(255,255,255,0.85)'),
                              display: 'grid',
                              placeItems: 'center',
                              background: isSelected ? brandColor : 'rgba(0,0,0,0.35)',
                              backdropFilter: 'blur(6px)',
                              color: '#fff',
                              fontSize: 'clamp(13px, 1.5vw, 16px)',
                              fontWeight: 800,
                              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                              pointerEvents: 'none',
                            }}>{isSelected ? (g._isSingle ? '✓' : optCount) : ''}</span>
                          </div>
                        ) : null}

                        {/* Body — name, description, price, allergens */}
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 'clamp(10px, 1.4vw, 14px)',
                          padding: 'clamp(12px, 1.6vw, 16px)',
                        }}>
                          {/* Radio fallback when there's no image — still shows a tappable bullet */}
                          {!effective.image && (
                            <span style={{
                              flexShrink: 0,
                              width: 'clamp(22px, 2.4vw, 28px)',
                              height: 'clamp(22px, 2.4vw, 28px)',
                              borderRadius: g._isSingle ? '50%' : 8,
                              border: '2px solid ' + (isSelected ? brandColor : 'var(--kBorder3)'),
                              display: 'grid',
                              placeItems: 'center',
                              background: isSelected ? brandColor : 'transparent',
                              color: '#fff',
                              fontSize: 'clamp(12px, 1.4vw, 15px)',
                              fontWeight: 800,
                            }}>{isSelected ? (g._isSingle ? '✓' : optCount) : ''}</span>
                          )}

                          {/* Text stack — name + (description) + (price) + (allergens) */}
                          <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                            <span style={{
                              fontSize: 'clamp(15px, 1.8vw, 19px)',
                              fontWeight: 700,
                              color: brandColor,
                              lineHeight: 1.25,
                              letterSpacing: '-0.01em',
                            }}>{opt.name}</span>
                            {effective.description && (
                              <span style={{
                                fontSize: 'clamp(11px, 1.3vw, 14px)',
                                color: 'var(--kFgMuted)',
                                fontWeight: 500,
                                lineHeight: 1.35,
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              }}>{effective.description}</span>
                            )}
                            {priceLabel && (
                              <span style={{
                                fontSize: 'clamp(12px, 1.4vw, 15px)',
                                color: 'var(--kFgMuted)',
                                fontVariantNumeric: 'tabular-nums',
                                fontWeight: 600,
                              }}>{priceLabel}</span>
                            )}
                            {effective.allergens && effective.allergens.length > 0 && (
                              <span style={{
                                fontSize: 'clamp(10px, 1.2vw, 13px)',
                                color: 'var(--kAllergen-fg)',
                                fontWeight: 600,
                                lineHeight: 1.3,
                                textTransform: 'capitalize',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              }}>{effective.allergens.join(', ')}</span>
                            )}
                            {/* v5.5.285: Stock badge for modifier options */}
                            {optSoldOut && (
                              <span style={{ fontSize: 'clamp(10px, 1.2vw, 13px)', color: 'var(--kError-fg, #e53e3e)', fontWeight: 700 }}>Sold out</span>
                            )}
                            {!optSoldOut && optItemId && optStockRemaining < Infinity && optStockRemaining <= 3 && (
                              <span style={{ fontSize: 'clamp(10px, 1.2vw, 13px)', color: '#e67e22', fontWeight: 700 }}>Only {optStockRemaining} left</span>
                            )}
                            {sub && !isSelected && (
                              <span style={{ fontSize: 'clamp(11px, 1.2vw, 13px)', color: brandColor, fontWeight: 700 }}>{sub.name} ›</span>
                            )}
                          </span>

                          {/* Stepper for multi-pick selected options */}
                          {showStepper && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); decOption(g, opt.id); }}
                                style={{
                                  width: 'clamp(36px, 4vw, 44px)',
                                  height: 'clamp(36px, 4vw, 44px)',
                                  borderRadius: '50%',
                                  background: 'var(--kSurface2)',
                                  border: 0,
                                  color: 'var(--kFg)',
                                  fontSize: 'clamp(18px, 2vw, 22px)',
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  fontFamily: 'inherit',
                                }}
                              >−</button>
                              <button
                                onClick={(e) => { e.stopPropagation(); incOption(g, opt.id); }}
                                disabled={atCap}
                                style={{
                                  width: 'clamp(36px, 4vw, 44px)',
                                  height: 'clamp(36px, 4vw, 44px)',
                                  borderRadius: '50%',
                                  background: atCap ? 'var(--kSurface1)' : brandColor,
                                  border: 0,
                                  color: '#fff',
                                  fontSize: 'clamp(18px, 2vw, 22px)',
                                  fontWeight: 700,
                                  cursor: atCap ? 'not-allowed' : 'pointer',
                                  fontFamily: 'inherit',
                                  opacity: atCap ? 0.4 : 1,
                                }}
                              >+</button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Inline nested sub-group expansion — one block per occurrence */}
                      {sub && isSelected && Array.from({ length: optCount }).map((_, occIdx) => {
                        const parentKey = g.id + ':' + opt.id + ':' + occIdx;
                        const subSel = (nestedSelections[parentKey] && nestedSelections[parentKey][sub.id]) || [];
                        const isLastOcc = occIdx === optCount - 1;
                        const subInvalid = showError && (subSel.length < sub._min || subSel.length > sub._max);
                        return (
                          <div key={parentKey} style={{
                            background: 'var(--kSurface1)',
                            borderLeft: '3px solid ' + brandColor,
                            borderRight: '1.5px solid ' + brandColor,
                            borderBottom: '1.5px solid ' + brandColor,
                            borderRadius: isLastOcc ? '0 0 16px 16px' : 0,
                            padding: 'clamp(12px, 1.6vw, 18px) clamp(14px, 1.8vw, 20px) clamp(14px, 1.8vw, 20px) clamp(18px, 2.2vw, 26px)',
                            marginBottom: isLastOcc ? 0 : 2,
                          }}>
                            <div style={{
                              fontSize: 'clamp(12px, 1.3vw, 14px)',
                              fontWeight: 700,
                              color: 'var(--kFgMuted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.06em',
                              marginBottom: 4,
                            }}>
                              {opt.name}{optCount > 1 ? ' #' + (occIdx + 1) : ''} · {sub.name}
                            </div>
                            <div style={{
                              fontSize: 'clamp(13px, 1.4vw, 15px)',
                              color: subInvalid ? 'var(--kError-fg)' : 'var(--kFgFaint)',
                              marginBottom: 10,
                              fontWeight: subInvalid ? 700 : 500,
                            }}>
                              {buildHint(sub._min, sub._max)}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {(sub.options || []).map(subOpt => {
                                const isSubSel = subSel.includes(subOpt.id);
                                const subPriceLabel = (subOpt.price && subOpt.price > 0) ? '+£' + Number(subOpt.price).toFixed(2) : '';
                                // v5.5.27: sub-options also inherit from sold-alone subitems by name match.
                                const subEffective = resolveOpt(subOpt);
                                return (
                                  <button
                                    key={subOpt.id}
                                    onClick={() => setNestedPick(parentKey, sub, subOpt.id)}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'flex-start',
                                      gap: 12,
                                      padding: 'clamp(10px, 1.4vw, 14px) clamp(12px, 1.6vw, 16px)',
                                      background: isSubSel ? 'var(--kSurface3)' : 'var(--kSurface2)',
                                      border: '2px solid ' + (isSubSel ? brandColor : 'transparent'),
                                      borderRadius: 12,
                                      color: 'var(--kFg)',
                                      cursor: 'pointer',
                                      fontFamily: 'inherit',
                                      textAlign: 'left',
                                    }}
                                  >
                                    <span style={{
                                      flexShrink: 0,
                                      width: 24, height: 24,
                                      borderRadius: sub._isSingle ? '50%' : 6,
                                      border: '2px solid ' + (isSubSel ? brandColor : 'var(--kBorder3)'),
                                      display: 'grid',
                                      placeItems: 'center',
                                      background: isSubSel ? brandColor : 'transparent',
                                      color: '#fff',
                                      fontSize: 12,
                                      fontWeight: 800,
                                      marginTop: 1,
                                    }}>{isSubSel ? '✓' : ''}</span>
                                    {subEffective.image && (
                                      <span style={{ flexShrink: 0, width: 48, height: 48, borderRadius: 8, overflow: 'hidden', background: 'var(--kImageBg)' }}>
                                        <img src={subEffective.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                                      </span>
                                    )}
                                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                      <span style={{ fontSize: 'clamp(15px, 1.7vw, 18px)', fontWeight: 600 }}>{subOpt.name}</span>
                                      {subEffective.description && (
                                        <span style={{ fontSize: 'clamp(12px, 1.3vw, 14px)', color: 'var(--kFgMuted)', lineHeight: 1.35 }}>{subEffective.description}</span>
                                      )}
                                      {subEffective.allergens && subEffective.allergens.length > 0 && (
                                        <span style={{
                                          fontSize: 'clamp(11px, 1.2vw, 13px)',
                                          color: 'var(--kAllergen-fg)',
                                          fontWeight: 600,
                                          textTransform: 'capitalize',
                                          marginTop: 2,
                                        }}>{subEffective.allergens.join(', ')}</span>
                                      )}
                                    </span>
                                    {subPriceLabel && (
                                      <span style={{
                                        fontSize: 'clamp(13px, 1.4vw, 15px)',
                                        color: 'var(--kFgMuted)',
                                        fontVariantNumeric: 'tabular-nums',
                                        fontWeight: 600,
                                        flexShrink: 0,
                                      }}>{subPriceLabel}</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Special instructions */}
      <div style={{ padding: '0 clamp(22px, 3vw, 36px) clamp(14px, 2vw, 20px)' }}>
        <label style={{
          display: 'block',
          fontSize: 'clamp(12px, 1.3vw, 14px)',
          fontWeight: 700,
          color: 'var(--kFgMuted)',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          marginBottom: 8,
        }}>{t('product.anythingElse')}</label>
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          placeholder={t('product.anythingElse.placeholder')}
          maxLength={140}
          rows={2}
          style={{
            width: '100%',
            borderRadius: 14,
            padding: 'clamp(12px, 1.6vw, 16px)',
            fontFamily: 'inherit',
            fontSize: 'clamp(14px, 1.6vw, 17px)',
            outline: 'none',
            resize: 'none',
            borderWidth: 1,
            borderStyle: 'solid',
          }}
        />
      </div>

      {/* Bottom CTA bar */}
      <div style={{
        padding: 'clamp(14px, 2vw, 20px) clamp(20px, 2.6vw, 28px) clamp(20px, 2.6vw, 28px)',
        borderTop: '1px solid var(--kBorder1)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 'clamp(10px, 1.6vw, 16px)',
      }}>
        {/* Qty stepper — pill */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'clamp(8px, 1.2vw, 14px)',
          background: 'var(--kSurface2)',
          borderRadius: 100,
          padding: 'clamp(4px, 0.6vw, 6px)',
          flexShrink: 0,
        }}>
          <button onClick={() => setQty(q => Math.max(1, q - 1))} style={qtyBtn(brandColor)}>−</button>
          <div style={{
            fontSize: 'clamp(20px, 2.4vw, 26px)',
            fontWeight: 800,
            minWidth: 'clamp(22px, 2.4vw, 28px)',
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
          }}>{qty}</div>
          <button
            onClick={() => setQty(q => Math.min(q + 1, lineMaxQty))}
            disabled={qty >= lineMaxQty}
            style={{
              ...qtyBtn(brandColor),
              ...(qty >= lineMaxQty ? { opacity: 0.3, cursor: 'not-allowed' } : {}),
            }}
          >+</button>
        </div>
        {/* v5.5.285: Stock limit indicator (v5.6.69: honours picked-option stock too) */}
        {lineMaxQty < Infinity && lineMaxQty <= 5 && (
          <div style={{ fontSize: 'clamp(11px, 1.3vw, 13px)', color: lineMaxQty === 0 ? 'var(--kError-fg, #e53e3e)' : '#e67e22', fontWeight: 700, flexShrink: 0 }}>
            {lineMaxQty === 0 ? 'Sold out' : `Only ${lineMaxQty} left`}
          </div>
        )}
        {/* v5.6.69: commit-time stock refusal ("Only 1 × Dubai Chocolate Filled Donut left") */}
        {stockErr && (
          <div style={{ fontSize: 'clamp(11px, 1.3vw, 13px)', color: 'var(--kError-fg, #e53e3e)', fontWeight: 700, flexShrink: 0 }}>
            {stockErr}
          </div>
        )}

        {/* Add CTA — primary brand fill */}
        <button onClick={tryAdd} style={{
          flex: 1,
          background: isValid ? brandColor : 'var(--kSurface2)',
          color: isValid ? '#fff' : 'var(--kFgFaint)',
          padding: 'clamp(16px, 2.2vw, 24px)',
          borderRadius: 18,
          fontSize: 'clamp(18px, 2.2vw, 24px)',
          fontWeight: 800,
          letterSpacing: '-0.01em',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          border: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          boxShadow: isValid ? '0 10px 28px rgba(0,0,0,0.28)' : 'none',
        }}>
          <span style={{ flex: 1, textAlign: 'center' }}>
            {isValid ? (addLabel || t('product.addToOrder')) : (validation || (addLabel || t('product.addToOrder')))}
          </span>
          {isValid && <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{money(totalPrice)}</span>}
        </button>
      </div>
    </div>
  );
}

// ─── Style helpers ───
function overlayStyle() {
  return {
    position: 'absolute', inset: 0,
    background: 'var(--kSurfaceShell)',
    color: 'var(--kFg)',
    display: 'flex', flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  };
}
function qtyBtn(brandColor) {
  return {
    width: 'clamp(40px, 4.6vw, 52px)',
    height: 'clamp(40px, 4.6vw, 52px)',
    borderRadius: '50%',
    background: brandColor,
    color: '#fff',
    border: 0,
    fontSize: 'clamp(20px, 2.4vw, 26px)',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}
