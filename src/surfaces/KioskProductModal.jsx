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
import { supabase } from '../lib/supabase';
import { useStore } from '../store';
import { t, useKioskLang } from '../lib/i18n';
import { displayName } from '../lib/itemDisplay';
import { money } from '../lib/currency';

// ============================================================
// VALIDATION HELPERS (pure)
// ============================================================

function normalizeGroup(group) {
  // v5.5.33: read both selection_type (DB column) and selectionType (camelCase
  // legacy/store-normalized) to defensively cover any data shape. POS data is
  // normalized to camelCase via SyncBridge; the kiosk reads raw Supabase rows
  // so it sees snake_case. Either should resolve correctly here.
  const selType = group.selection_type ?? group.selectionType ?? 'single';
  const isSingle = selType === 'single';
  const isQuantity = selType === 'quantity';
  // min/max are plain field names in both shapes — read defensively from
  // both possible aliases just in case.
  const rawMinExplicit = group.min ?? group.min_select ?? group.minSelect;
  const rawMin = Math.max(rawMinExplicit ?? 0, 0);
  const rawMax = group.max ?? group.max_select ?? group.maxSelect ?? null;
  const max = rawMax != null ? rawMax : (isSingle ? 1 : (group.options?.length || 99));
  // v5.5.34: For quantity-mode groups (e.g. "Box of 3" / "Box of 6") where the
  // customer must pick a fixed number of items, default min to max when the
  // operator hasn't explicitly set min. Quantity mode semantically means
  // "container of N" — leaving with fewer than N defeats the purpose. This
  // protects against legacy BO data where min was left at 0 by accident.
  // Operators who genuinely want "between 1 and max" can still set min
  // explicitly to a non-null value below max. Going forward, the BO
  // selection-mode picker auto-sets min=max on quantity-mode click so this
  // defensive default rarely fires for new data.
  let min = rawMin;
  if (isQuantity && (rawMinExplicit == null || rawMinExplicit === 0) && max > 1) {
    min = max;
  }
  // Clamp min to never exceed max (defensive against bad BO writes).
  const safeMin = Math.min(min, max);
  return { ...group, _min: safeMin, _max: max, _isSingle: isSingle, _selectionType: selType };
}

// Walks all selected occurrences of options-with-subGroupId and returns
// the parent option occurrences that need a nested pick.
function collectNestedOccurrences(groups, selections) {
  const out = [];
  for (const g of groups) {
    if (g.__isVariantGroup) continue;
    const picked = selections[g.id] || [];
    const occCounts = {};
    picked.forEach(optId => {
      const opt = (g.options || []).find(o => o.id === optId);
      if (!opt || !opt.subGroupId) return;
      const idx = occCounts[optId] || 0;
      occCounts[optId] = idx + 1;
      out.push({ groupId: g.id, optionId: optId, occurrenceIdx: idx, option: opt, parentGroup: g });
    });
  }
  return out;
}

function validateSelections(groups, selections, nestedSelections, subGroupsCache) {
  // Top-level group min/max
  for (const g of groups) {
    const picked = selections[g.id] || [];
    if (picked.length < g._min) {
      return g._min === 1 ? 'Pick a ' + g.name : 'Pick at least ' + g._min + ' from ' + g.name;
    }
    if (picked.length > g._max) {
      return 'Too many in ' + g.name + ' (max ' + g._max + ')';
    }
  }
  // Nested sub-group min/max for each occurrence of an option with subGroupId
  const nested = collectNestedOccurrences(groups, selections);
  for (const n of nested) {
    const sub = subGroupsCache[n.option.subGroupId];
    if (!sub) continue; // sub-group not loaded — soft skip
    const key = n.groupId + ':' + n.optionId + ':' + n.occurrenceIdx;
    const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
    if (subSel.length < sub._min) {
      return sub._min === 1 ? 'Pick a ' + sub.name + ' for ' + n.option.name : 'Pick ' + sub._min + ' from ' + sub.name;
    }
    if (subSel.length > sub._max) {
      return 'Too many in ' + sub.name + ' (max ' + sub._max + ')';
    }
  }
  return null;
}

function priceDelta(groups, selections, nestedSelections, subGroupsCache) {
  let delta = 0;
  for (const g of groups) {
    if (g.__isVariantGroup) continue;
    const picked = selections[g.id] || [];
    for (const optId of picked) {
      const opt = (g.options || []).find(o => o.id === optId);
      if (opt && typeof opt.price === 'number') delta += opt.price;
    }
  }
  // Nested option prices
  const nested = collectNestedOccurrences(groups, selections);
  for (const n of nested) {
    const sub = subGroupsCache[n.option.subGroupId];
    if (!sub) continue;
    const key = n.groupId + ':' + n.optionId + ':' + n.occurrenceIdx;
    const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
    for (const subOptId of subSel) {
      const subOpt = (sub.options || []).find(o => o.id === subOptId);
      if (subOpt && typeof subOpt.price === 'number') delta += subOpt.price;
    }
  }
  return delta;
}

function buildModsArray(groups, selections, nestedSelections, subGroupsCache) {
  const mods = [];
  for (const g of groups) {
    if (g.__isVariantGroup) continue;
    const isInstrGroup = g.__isInstructionGroup;
    const picked = selections[g.id] || [];
    const occCounts = {};
    for (const optId of picked) {
      const opt = (g.options || []).find(o => o.id === optId);
      if (!opt) continue;
      mods.push({
        label: opt.name,
        price: typeof opt.price === 'number' ? opt.price : 0,
        groupLabel: g.name,
        ...(opt.itemId ? { itemId: opt.itemId } : {}),
        ...(isInstrGroup ? { _instruction: true } : {}),
      });
      // If this option has nested config, emit the nested picks tagged with parent
      if (opt.subGroupId) {
        const idx = occCounts[optId] || 0;
        occCounts[optId] = idx + 1;
        const sub = subGroupsCache[opt.subGroupId];
        if (sub) {
          const key = g.id + ':' + optId + ':' + idx;
          const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
          for (const subOptId of subSel) {
            const subOpt = (sub.options || []).find(o => o.id === subOptId);
            if (!subOpt) continue;
            mods.push({
              label: subOpt.name,
              price: typeof subOpt.price === 'number' ? subOpt.price : 0,
              groupLabel: opt.name + ' → ' + sub.name,
            });
          }
        }
      }
    }
  }
  return mods;
}

function summarizeForDisplay(groups, selections, nestedSelections, subGroupsCache) {
  const parts = [];
  for (const g of groups) {
    const picked = selections[g.id] || [];
    if (picked.length === 0) continue;
    const counts = {};
    for (const id of picked) counts[id] = (counts[id] || 0) + 1;
    const labels = Object.entries(counts).map(([id, n]) => {
      const name = (g.options || []).find(o => o.id === id)?.name;
      if (!name) return null;
      return n > 1 ? (name + ' ×' + n) : name;
    }).filter(Boolean);
    if (labels.length > 0) parts.push(labels.join(', '));
  }
  // Append nested labels
  const nested = collectNestedOccurrences(groups, selections);
  for (const n of nested) {
    const sub = subGroupsCache[n.option.subGroupId];
    if (!sub) continue;
    const key = n.groupId + ':' + n.optionId + ':' + n.occurrenceIdx;
    const subSel = (nestedSelections[key] && nestedSelections[key][sub.id]) || [];
    const subNames = subSel.map(id => (sub.options || []).find(o => o.id === id)?.name).filter(Boolean);
    if (subNames.length > 0) parts.push(n.option.name + ': ' + subNames.join(', '));
  }
  return parts.join(' · ');
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function KioskProductModal({ item, allItems = [], brandColor, brandAccent, basePrice, addLabel, onAdd, onCancel, dailyCounts = {}, cartItemUsage = {} }) {
  // Subscribe to language changes so t() strings re-render if the customer
  // switches language while the modal is open.
  useKioskLang();
  const allInstructionDefs = useStore(s => s.instructionGroupDefs) || [];

  // v5.5.285: Stock enforcement — cap qty selector and modifier selections
  // to the remaining stock minus what's already in the customer's cart.
  // cartItemUsage is { [itemId]: totalQtyInCart } computed by KioskApp.
  const eightySixIds = useStore(s => s.eightySixIds || []);

  // (v5.5.27/28 sub-item lookup + diagnostic moved below state declarations to avoid TDZ.)


  const [groups, setGroups] = useState([]);
  const [subGroupsCache, setSubGroupsCache] = useState({}); // { [subGroupId]: normalizedGroup }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selections, setSelections] = useState({}); // { groupId: [optionId, ...] }
  const [nestedSelections, setNestedSelections] = useState({}); // { 'gid:oid:idx': { subGroupId: [...] } }
  const [qty, setQty] = useState(1);
  const [showError, setShowError] = useState(false);
  const [instructions, setInstructions] = useState('');

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
    // Also count current selections in THIS modal that use this itemId
    let inModal = 0;
    for (const g of groups) {
      const picked = selections[g.id] || [];
      for (const pid of picked) {
        const opt = (g.options || []).find(o => o.id === pid);
        if (opt && (opt.itemId || opt.item_id) === optItemId) inModal++;
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
  const subitemByName = useMemo(() => {
    const map = new Map();
    for (const it of (allItems || [])) {
      if (!it || it.archived) continue;
      if (it.type !== 'subitem') continue;
      // Read both camelCase (store) and snake_case (raw Supabase) shapes.
      const soldAlone = it.soldAlone ?? it.sold_alone;
      if (!soldAlone) continue;
      // Index under every name field this row carries — short option names
      // ("Bueno Filled") need to match longer sub-item display names
      // ("Bueno Filled Donut") via menuName/kitchenName/receiptName aliases.
      const candidates = [
        it.name,
        it.menuName, it.menu_name,
        it.receiptName, it.receipt_name,
        it.kitchenName, it.kitchen_name,
      ];
      for (const raw of candidates) {
        if (!raw) continue;
        const key = String(raw).trim().toLowerCase();
        if (key && !map.has(key)) map.set(key, it);
      }
    }
    return map;
  }, [allItems]);

  const resolveOpt = (opt) => {
    const key = String(opt?.name || '').trim().toLowerCase();
    const match = key ? subitemByName.get(key) : null;
    return {
      image: opt?.image || match?.image || null,
      description: opt?.description || match?.description || null,
      allergens: (Array.isArray(opt?.allergens) && opt.allergens.length > 0)
        ? opt.allergens
        : (Array.isArray(match?.allergens) ? match.allergens : []),
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
    const match = key ? subitemByName.get(key) : null;
    return match?.id || null;
  };

  // Load top-level groups + variants, then pre-fetch any sub-groups referenced by option.subGroupId
  useEffect(() => {
    let alive = true;
    (async () => {
      const result = [];

      // ── Synthesize 'Size' group for variants-type items ──
      if (item?.type === 'variants') {
        const children = (allItems || [])
          .filter(i => i.parent_id === item.id && i.archived !== true)
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        if (children.length > 0) {
          const cheapestPrice = Math.min(...children.map(c => c.pricing?.base ?? c.price ?? 0));
          result.push(normalizeGroup({
            id: '__variants__',
            name: 'Size',
            selection_type: 'single',
            min: 1, max: 1, min_select: 1, max_select: 1,
            __isVariantGroup: true,
            __cheapestPrice: cheapestPrice,
            options: children.map(c => ({
              id: c.id,
              name: c.name,
              price: ((c.pricing?.base ?? c.price ?? 0) - cheapestPrice),
              __absolutePrice: c.pricing?.base ?? c.price ?? 0,
            })),
          }));
        }
      }

      // ── Load assigned_modifier_groups ──
      const assignments = item?.assigned_modifier_groups;
      if (Array.isArray(assignments) && assignments.length > 0) {
        const idsAndOverrides = assignments.map(a => {
          if (typeof a === 'string') return { id: a, min: null, max: null };
          return { id: a.groupId || a.id, min: a.min ?? null, max: a.max ?? null };
        }).filter(x => x.id);
        const ids = idsAndOverrides.map(x => x.id);
        try {
          const { data, error } = await supabase
            .from('modifier_groups')
            .select('*')
            .in('id', ids);
          if (error) throw error;
          if (!alive) return;
          const ordered = idsAndOverrides
            .map(({ id, min, max }) => {
              const g = (data || []).find(x => x.id === id);
              if (!g) {
                console.warn('[kiosk] modifier group not found:', id, '(referenced by item ' + (item?.name || item?.id) + ')');
                return null;
              }
              const merged = { ...g };
              if (min !== null && min !== undefined) merged.min = min;
              if (max !== null && max !== undefined) merged.max = max;
              return normalizeGroup(merged);
            })
            .filter(Boolean);
          result.push(...ordered);
        } catch (e) {
          if (alive) setError(e?.message || 'Failed to load options');
        }
      }

      // ── Instruction groups ──
      // v5.5.947: cooking preferences render FIRST, same rule as the POS (v5.5.915/947).
      // They were pushed after every modifier group, so on a long kiosk item the
      // kitchen-critical choice was the last card a customer scrolled to.
      const instrAssignments = item?.assigned_instruction_groups;
      if (Array.isArray(instrAssignments) && instrAssignments.length > 0) {
        const instrGroups = [];
        for (const a of instrAssignments) {
          const igId = typeof a === 'string' ? a : (a.groupId || a.id);
          const minOverride = (typeof a === 'object' && a.min !== undefined) ? a.min : null;
          const def = allInstructionDefs.find(g => g.id === igId);
          if (!def) { console.warn('[kiosk] instruction group not found:', igId); continue; }
          instrGroups.push(normalizeGroup({
            id: '__instr__' + def.id,
            name: def.name,
            selection_type: 'single',
            min: minOverride !== null ? minOverride : 1,
            max: 1,
            __isInstructionGroup: true,
            options: (def.options || []).map((label, idx) => ({
              id: 'instr-' + def.id + '-' + idx,
              name: label,
              price: 0,
            })),
          }));
        }
        result.unshift(...instrGroups);
      }

      // ── Pre-fetch all sub-groups referenced by option.subGroupId ──
      const subGroupIds = new Set();
      for (const g of result) {
        for (const opt of (g.options || [])) {
          if (opt && opt.subGroupId) subGroupIds.add(opt.subGroupId);
        }
      }
      let subCache = {};
      if (subGroupIds.size > 0) {
        try {
          const { data, error } = await supabase
            .from('modifier_groups')
            .select('*')
            .in('id', Array.from(subGroupIds));
          if (error) throw error;
          if (!alive) return;
          for (const sg of (data || [])) {
            subCache[sg.id] = normalizeGroup(sg);
          }
        } catch (e) {
          console.warn('[kiosk] failed to pre-fetch sub-groups:', e?.message);
        }
      }

      if (alive) {
        setGroups(result);
        setSubGroupsCache(subCache);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [item, allItems]);

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
  let effectiveBase = basePrice || 0;
  if (variantGroup) {
    const pickedVariantId = (selections[variantGroup.id] || [])[0];
    const pickedOpt = pickedVariantId ? variantGroup.options.find(o => o.id === pickedVariantId) : null;
    effectiveBase = pickedOpt ? pickedOpt.__absolutePrice : variantGroup.__cheapestPrice;
  }
  const totalPriceEach = effectiveBase + priceDelta(groups, selections, nestedSelections, subGroupsCache);
  const totalPrice = totalPriceEach * qty;

  // ── Selection mutation ──
  const incOption = (group, optId) => {
    setShowError(false);
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
          if (inModal >= stock.remaining - inCart) return prev; // at stock limit
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
    const summary = summarizeForDisplay(groups, selections, nestedSelections, subGroupsCache);
    onAdd({
      qty,
      selections,
      mods,
      summary,
      priceEach: totalPriceEach,
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
        background: item?.image ? '#000' : ('linear-gradient(135deg, ' + brandColor + ', ' + (brandAccent || brandColor) + ')'),
        flexShrink: 0,
        overflow: 'hidden',
      }}>
        {item?.image && (
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

        {/* Base price — brand color, large */}
        <div style={{
          fontSize: 'clamp(26px, 3.4vw, 38px)',
          fontWeight: 800,
          color: brandColor,
          letterSpacing: '-0.01em',
          marginBottom: 'clamp(20px, 2.6vw, 28px)',
          fontVariantNumeric: 'tabular-nums',
        }}>{money(Number(basePrice ?? 0))}</div>

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
                  const priceLabel = (opt.price && opt.price > 0)
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
            onClick={() => setQty(q => Math.min(q + 1, maxQty))}
            disabled={qty >= maxQty}
            style={{
              ...qtyBtn(brandColor),
              ...(qty >= maxQty ? { opacity: 0.3, cursor: 'not-allowed' } : {}),
            }}
          >+</button>
        </div>
        {/* v5.5.285: Stock limit indicator */}
        {maxQty < Infinity && maxQty <= 5 && (
          <div style={{ fontSize: 'clamp(11px, 1.3vw, 13px)', color: maxQty === 0 ? 'var(--kError-fg, #e53e3e)' : '#e67e22', fontWeight: 700, flexShrink: 0 }}>
            {maxQty === 0 ? 'Sold out' : `Only ${maxQty} left`}
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
