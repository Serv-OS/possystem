/**
 * menuRules.js: ONE place for the menu rules every ordering screen must agree on. The till
 * (POSSurface, BarSurface, InlineItemFlow), the kiosk (both designs, lib/kioskMenu.js and
 * lib/kioskOptionGroups.js) and online ordering (OnlineItemSheet) all read these.
 *
 * Pure, NO imports, so node:test can load it. menuRules.test.js holds the rules, and
 * menuRulesUsage.test.js fails if a screen goes back to its own copy.
 *
 * WHY (15 Sep 2026, Provo): the kiosk kept its own copy of these rules from v5.3.1 and got
 * them wrong, so it disagreed with the till. Option only sub items (No Ice) showed as
 * products, sizes showed no options (it read the main product), Milk was optional (it read an
 * old per item "min 0" copy instead of the Milk group, which is required) and Cooking
 * preference was always required (the till only requires it when it is set to required).
 * The main product options came from Back Office: the Flow tab's "Add to flow" box saved to the
 * main product of an item with sizes (fixed in v5.8.70, rule 5 moves what is already there).
 */

// The store shape (camelCase) wins; a raw DB row (snake_case) is read when it is missing.
const field = (row, camel, snake) => (row?.[camel] !== undefined ? row[camel] : row?.[snake]);

/**
 * 1. PRODUCTS. A sub item that is not sold alone is only ever an option (No Ice in Soft
 * Drinks Options). It is never a product on a grid, search, rail or count. Items of any other
 * type are not hidden by this rule. The till's rule exactly: type 'subitem' and not soldAlone.
 */
export function isOptionOnlyItem(item) {
  if (!item || item.type !== 'subitem') return false;
  return !field(item, 'soldAlone', 'sold_alone');
}

/** The group id an assignment points at: a plain id, or { groupId } or { id }. */
export function assignmentGroupId(assignment) {
  if (typeof assignment === 'string') return assignment || null;
  if (!assignment || typeof assignment !== 'object') return null;
  return assignment.groupId || assignment.id || null;
}

/**
 * 2. SIZE OPTIONS. Options belong on SIZES. When a size is picked, its own options are used;
 * only a size with none uses the main product's (older menus). Modifier groups and instruction
 * groups are decided separately. Callers pass the lists they count, for example only groups
 * that still exist, as the till does. Returns one of the two arrays as it was given.
 */
export function sizeOrMainOptions(sizeOptions, mainOptions) {
  const own = Array.isArray(sizeOptions) ? sizeOptions : [];
  if (own.length > 0) return own;
  return Array.isArray(mainOptions) ? mainOptions : [];
}

/**
 * 3. MODIFIER GROUP RULES come from the GROUP (Back Office, Modifier groups), never from a
 * copy saved on an item. Old menus carry per item { min, max } copies (the Latte and Cappucino
 * sizes say min 0 while the Milk group says required). The till and Back Office never read
 * them. Returns the group's own minimum picks (0 when optional).
 */
export function modifierGroupMin(group) {
  const n = Number(group?.min ?? 0);
  return n > 0 ? n : 0;
}

/** True when the group needs at least one pick, read from the group itself. */
export function modifierGroupRequired(group) {
  return modifierGroupMin(group) > 0;
}

/**
 * 4. INSTRUCTION GROUPS (Cooking preference): the item's assignment min when it sets one,
 * else the group's, else 0 (optional). Back Office's Flow tab required toggle writes the
 * assignment min. Returns the minimum picks (0 when optional).
 */
export function instructionGroupMin(assignment, group) {
  const own = assignment && typeof assignment === 'object' ? assignment.min : undefined;
  const n = Number(own ?? group?.min ?? 0);
  return n > 0 ? n : 0;
}

const hasList = (v) => Array.isArray(v) && v.length > 0;

/**
 * 5. OPTIONS LEFT ON A MAIN PRODUCT WITH SIZES. Back Office only saves options to sizes. An
 * item that still has options on its main product (set before it had sizes, or through the
 * old Flow tab box) has them moved: every size with none of that kind gets a copy, and the
 * main product is cleared. What the till, kiosk and online show stays the same, because a
 * size with none already used the main product's (rule 2).
 * main   the main product (store shape: assignedModifierGroups, assignedInstructionGroups)
 * sizes  its live sizes (not archived)
 * Returns { mainPatch, sizePatches: [{ id, patch }] }, or null when there is nothing to move
 * (no sizes, or nothing on the main product).
 */
export function moveMainProductOptions(main, sizes) {
  const live = (Array.isArray(sizes) ? sizes : []).filter(s => s && s.id != null);
  if (!main || live.length === 0) return null;
  const mainMods = field(main, 'assignedModifierGroups', 'assigned_modifier_groups');
  const mainInst = field(main, 'assignedInstructionGroups', 'assigned_instruction_groups');
  if (!hasList(mainMods) && !hasList(mainInst)) return null;
  const sizePatches = [];
  for (const s of live) {
    const patch = {};
    if (hasList(mainMods) && !hasList(field(s, 'assignedModifierGroups', 'assigned_modifier_groups'))) {
      patch.assignedModifierGroups = mainMods.map(a => (a && typeof a === 'object' ? { ...a } : a));
    }
    if (hasList(mainInst) && !hasList(field(s, 'assignedInstructionGroups', 'assigned_instruction_groups'))) {
      patch.assignedInstructionGroups = mainInst.map(a => (a && typeof a === 'object' ? { ...a } : a));
    }
    if (Object.keys(patch).length) sizePatches.push({ id: s.id, patch });
  }
  return { mainPatch: { assignedModifierGroups: [], assignedInstructionGroups: [] }, sizePatches };
}
