/**
 * kioskGroupRules.js: modifier group rules shared by the kiosk item screen
 * (KioskProductModal) and the new kiosk design's one tap add rule (kioskMenu.js).
 *
 * Pure: only imports lib/menuRules.js (itself import free), so node:test can load it.
 *
 * normalizeGroup was moved here WORD FOR WORD from KioskProductModal.jsx (new kiosk
 * design build, stage B), so both places read a group's min, max and selection type
 * exactly the same way. Do not change it without checking the kiosk item screen.
 */
import { instructionGroupMin } from './menuRules.js';

export function normalizeGroup(group) {
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

/**
 * A group's assignments on an item (menu_items.assigned_modifier_groups) as
 * [{ id, min, max }], read the same way KioskProductModal reads them: a plain id string
 * has no overrides; an object gives groupId (or id) plus optional min and max overrides.
 */
export function modifierAssignments(assignments) {
  if (!Array.isArray(assignments)) return [];
  return assignments.map(a => {
    if (typeof a === 'string') return { id: a, min: null, max: null };
    if (!a || typeof a !== 'object') return { id: null, min: null, max: null };
    return { id: a.groupId || a.id, min: a.min ?? null, max: a.max ?? null };
  }).filter(x => x.id);
}

/**
 * True when a modifier group row needs at least one pick before the item can be added (the
 * kiosk item screen blocks Add until it has one). Read from the GROUP only, like the till and
 * Back Office (lib/menuRules.js rule 3): a { min, max } copy saved on an item is ignored. Before
 * v5.8.70 the kiosk applied those copies, so Milk (required) was optional on the Latte sizes.
 */
export function groupRequired(row) {
  if (!row || typeof row !== 'object') return false;
  return normalizeGroup(row)._min >= 1;
}

/**
 * True when an instruction group assignment (menu_items.assigned_instruction_groups) needs a
 * pick: the assignment's min when it sets one, else the group definition's, else optional
 * (lib/menuRules.js rule 4, the till's and Back Office's rule). Before v5.8.70 the kiosk made
 * every instruction group required unless the item said otherwise.
 */
export function instructionAssignmentRequired(assignment, definition = null) {
  return instructionGroupMin(assignment, definition) >= 1;
}

/**
 * The new design item sheet's guidance line for the first top level group that is not
 * satisfied, as an i18n key and values ({ key, vars }), or null. It checks the loaded
 * groups (normalizeGroup'd, with _min and _max) in the same order and with the same tests as
 * KioskProductModal's validateSelections, so it names the same group. null when every top
 * level group is fine: a nested choice is then the reason and the sheet keeps that text.
 * Today's modal is not changed (its "Pick a Base" button text stays as it is).
 */
export function kioskSheetGroupHint(groups, selections) {
  for (const g of (Array.isArray(groups) ? groups : [])) {
    if (!g) continue;
    const picked = (selections && selections[g.id]) || [];
    const group = String(g.name ?? '').trim();
    // The size group is the one group the kiosk makes up, and its name is English ('Size') so
    // today's modal and the checks read as before. groupKey tells the caller to put the
    // customer's own word for Size in {group}. A venue's own group names are never translated.
    const sizeKey = g.__isVariantGroup ? { groupKey: 'k2.sheet.size' } : null;
    if (picked.length < g._min) {
      if (g._min === 1 && g._max === 1) return { key: 'k2.sheet.pickOne', vars: { group }, ...sizeKey };
      if (g._min === g._max) return { key: 'k2.sheet.pickExactly', vars: { group, n: g._min }, ...sizeKey };
      return { key: 'k2.sheet.pickAtLeast', vars: { group, n: g._min }, ...sizeKey };
    }
    if (picked.length > g._max) return { key: 'k2.sheet.pickTooMany', vars: { group, n: g._max }, ...sizeKey };
  }
  return null;
}

/** The instruction group id an assignment points at (a plain id or { groupId | id }). */
export function instructionAssignmentId(assignment) {
  if (typeof assignment === 'string') return assignment;
  return (assignment && (assignment.groupId || assignment.id)) || null;
}
