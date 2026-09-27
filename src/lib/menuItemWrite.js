// src/lib/menuItemWrite.js: which database columns a Back Office menu edit may write.
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board".
// Every menu save used to build the WHOLE row from the tab's memory and upsert it. A
// Back Office tab loaded at 13:52 changed a price (or pressed Push to POS) at 13:59 and
// put back everything it remembered: its old tax rate on 430 products, and archived=false
// on the Choc Babyccino another tab had archived at 13:56. Nothing had asked it to.
//
// So a save now writes ONLY the columns the person changed (columnsForPatch), and the
// writer (lib/menuRowWrite.js) sends them with `where updated_at = <the time this tab
// read the row>`. A derived column follows only when its inputs change:
//   name, menu_name          the display name (menuName, else name)
//   receipt_name / kitchen   their own field, else the display name
//   type                     the v5.5.797 auto modifiable flip (a top level product with
//                            modifier groups is never saved as plain 'simple')
//   sold_alone               lib/menuRules.js rule 6, with the type we write
//   archived                 ONLY when the edit itself sets it, never defaulted
//
// Pure: no database, no store. Imported by db.js (create), the store (edits) and the tests.
// Static imports with extensions so node:test can load it (ADR-008).

import { resolveSoldAlone } from './menuRules.js';
import { itemCodeForSave } from './itemCode.js';
import { categoryImageField } from './categoryPhoto.js';
import { normaliseMenuRow } from './rowMapping.js';

const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// The camel spelling when the row carries it (even as null: that is a clear), else the snake
// one. `a || b` read the stale snake value back whenever a field was cleared to null.
const own = (o, camel, snake) => (o && o[camel] !== undefined ? o[camel] : o?.[snake]);

// v5.5.797 AUTO MODIFIABLE safety net, the rule upsertMenuItem always applied: a top level
// product with modifier groups attached is never written as plain 'simple' (the till skips
// the options screen for type 'simple').
export function itemTypeOf(item) {
  const _parentId = own(item, 'parentId', 'parent_id') ?? null;
  const _assignedMods = item?.assignedModifierGroups || item?.assigned_modifier_groups || [];
  let _type = item?.type || 'simple';
  if (_type === 'simple' && !_parentId && Array.isArray(_assignedMods) && _assignedMods.length > 0) _type = 'modifiable';
  return _type;
}

/**
 * The FULL column map of a menu item (store shape or raw row), without id, location_id and
 * updated_at. This is the mapping upsertMenuItem has always used, kept in one place: a
 * create sends all of it, an edit sends only the columns columnsForPatch picks from it.
 */
export function menuItemRow(item) {
  // RENAME CASCADE: name, menu_name, receipt_name and kitchen_name share one fallback chain.
  const _displayName = item.menuName || item.menu_name || item.name || 'Item';
  const _type = itemTypeOf(item);
  return {
    name:         _displayName,
    menu_name:    _displayName,
    receipt_name: item.receiptName || item.receipt_name || _displayName,
    kitchen_name: item.kitchenName || item.kitchen_name || _displayName,
    description:  item.description || '',
    type:         _type,
    cat:          item.cat         || null,
    cats:         item.cats        || [],
    parent_id:    own(item, 'parentId', 'parent_id') ?? null,
    sort_order:   item.sortOrder   ?? item.sort_order   ?? 0,
    pricing:      item.pricing || { base: item.price || 0 },
    allergens:    item.allergens   || [],
    tags:         item.tags        || [],
    assigned_modifier_groups:    item.assignedModifierGroups    || item.assigned_modifier_groups    || [],
    assigned_instruction_groups: item.assignedInstructionGroups || item.assigned_instruction_groups || [],
    // v5.5.948: combined flow order, only when the row carries it (a path that never loaded it
    // must not null a saved drag order).
    ...(item.optionGroupOrder !== undefined || item.option_group_order !== undefined
      ? { option_group_order: item.optionGroupOrder ?? item.option_group_order ?? null } : {}),
    visibility:   item.visibility  || { pos: true, kiosk: true, online: true },
    // A real choice is kept; with none, a sub item is not sold alone and every other type is
    // (lib/menuRules.js rule 6), judged on the type we write.
    sold_alone:   resolveSoldAlone({ ...item, type: _type }),
    archived:     item.archived    ?? false,
    centre_id:    own(item, 'centreId', 'centre_id') || null,
    tax_rate_id:  own(item, 'taxRateId', 'tax_rate_id') || null,
    tax_overrides: own(item, 'taxOverrides', 'tax_overrides') || {},
    // v5.7.33 / v5.8.100: CONDITIONAL, only when the row carries the field, so a row loaded
    // before the column existed leaves the saved value alone.
    ...(item.taxProfileId !== undefined || item.tax_profile_id !== undefined
      ? { tax_profile_id: item.taxProfileId ?? item.tax_profile_id ?? null } : {}),
    ...(item.itemCode !== undefined || item.item_code !== undefined
      ? { item_code: itemCodeForSave(item.itemCode ?? item.item_code) } : {}),
    image:        item.image || null,
    scope:           item.scope          || item.ownership_scope || 'local',
    org_id:          item.orgId          ?? item.org_id          ?? null,
    master_id:       item.masterId       ?? item.master_id       ?? null,
    lock_pricing:    item.lockPricing    ?? item.lock_pricing    ?? false,
    locked_fields:   item.lockedFields   ?? item.locked_fields   ?? [],
  };
}

const NAME_KEYS = ['menuName', 'menu_name', 'name'];
const TYPE_INPUTS = ['assignedModifierGroups', 'assigned_modifier_groups', 'modifierGroups', 'parentId', 'parent_id'];

// column → the store keys that set it (`keys`), and for a derived column the keys it follows
// (`from`). A patch key that is in no list is not a column (variantLabel, course, pizza
// fields): nothing was ever saved for it and nothing is now.
export const ITEM_COLUMNS = {
  name:                        { keys: NAME_KEYS },
  menu_name:                   { keys: NAME_KEYS },
  receipt_name:                { keys: ['receiptName', 'receipt_name'], from: NAME_KEYS },
  kitchen_name:                { keys: ['kitchenName', 'kitchen_name'], from: NAME_KEYS },
  description:                 { keys: ['description'] },
  type:                        { keys: ['type'], from: TYPE_INPUTS },
  cat:                         { keys: ['cat'] },
  cats:                        { keys: ['cats'] },
  parent_id:                   { keys: ['parentId', 'parent_id'] },
  sort_order:                  { keys: ['sortOrder', 'sort_order'] },
  pricing:                     { keys: ['pricing'], from: ['price'] },
  allergens:                   { keys: ['allergens'] },
  tags:                        { keys: ['tags'] },
  assigned_modifier_groups:    { keys: ['assignedModifierGroups', 'assigned_modifier_groups'] },
  assigned_instruction_groups: { keys: ['assignedInstructionGroups', 'assigned_instruction_groups'] },
  option_group_order:          { keys: ['optionGroupOrder', 'option_group_order'] },
  visibility:                  { keys: ['visibility'] },
  sold_alone:                  { keys: ['soldAlone', 'sold_alone'], from: ['type', ...TYPE_INPUTS] },
  archived:                    { keys: ['archived'] },
  centre_id:                   { keys: ['centreId', 'centre_id'] },
  tax_rate_id:                 { keys: ['taxRateId', 'tax_rate_id'] },
  tax_overrides:               { keys: ['taxOverrides', 'tax_overrides'] },
  tax_profile_id:              { keys: ['taxProfileId', 'tax_profile_id'] },
  item_code:                   { keys: ['itemCode', 'item_code'] },
  image:                       { keys: ['image'] },
  scope:                       { keys: ['scope', 'ownership_scope'] },
  org_id:                      { keys: ['orgId', 'org_id'] },
  master_id:                   { keys: ['masterId', 'master_id'] },
  lock_pricing:                { keys: ['lockPricing', 'lock_pricing'] },
  locked_fields:               { keys: ['lockedFields', 'locked_fields'] },
};

const isFlag = (v) => v === true || v === false;

/**
 * The columns an edit writes, with their values taken from the item AFTER the edit.
 *   patch     the edit ({ taxRateId }, { archived: true, parentId: null }, ...)
 *   fullItem  the item with the edit applied (the store row after set)
 *   prevItem  the item before the edit (optional). With it, a derived column is written
 *             only when its value really changes; without it, when its inputs are touched.
 * Returns { cols, soft }. `soft` names the columns written only as a safety net (a legacy
 * 'simple' product with groups gets its type put right, a missing Sold alone gets the rule's
 * default, as every save always did): if somebody else changed one of those, the writer
 * leaves their value alone instead of refusing the person's edit over a field they never
 * touched. archived is written only when the patch contains it.
 */
export function columnsForEdit(patch, fullItem, prevItem = null) {
  const cols = {};
  const soft = new Set();
  if (!patch || typeof patch !== 'object' || !fullItem) return { cols, soft };
  const full = menuItemRow(fullItem);
  const prev = prevItem ? menuItemRow(prevItem) : null;
  const touched = (keys) => (keys || []).some((k) => has(patch, k));
  for (const [col, spec] of Object.entries(ITEM_COLUMNS)) {
    if (!(col in full)) continue;   // a conditional column the row does not carry
    if (touched(spec.keys)) { cols[col] = full[col]; continue; }
    if (col === 'type' || col === 'sold_alone') continue;   // below, after the plain columns
    if (spec.from && touched(spec.from) && (!prev || !sameValue(full[col], prev[col]))) cols[col] = full[col];
  }
  // type: its inputs changed (hard), or the row holds a type we would never write (soft).
  if (!('type' in cols)) {
    if (touched(ITEM_COLUMNS.type.from) && (!prevItem || full.type !== (prevItem.type || 'simple'))) cols.type = full.type;
    else if (prevItem && full.type !== (prevItem.type || 'simple')) { cols.type = full.type; soft.add('type'); }
  }
  // sold_alone follows a type we write (rule 6 is judged on it), else fills a missing flag.
  if (!('sold_alone' in cols)) {
    const raw = prevItem ? (isFlag(prevItem.soldAlone) ? prevItem.soldAlone : prevItem.sold_alone) : undefined;
    const differs = !prevItem || !isFlag(raw) || raw !== full.sold_alone;
    if ('type' in cols && !soft.has('type') && differs) cols.sold_alone = full.sold_alone;
    else if (prevItem && differs) { cols.sold_alone = full.sold_alone; soft.add('sold_alone'); }
  }
  return { cols, soft };
}

/** Just the column map of columnsForEdit (the columns an edit writes, and their values). */
export function columnsForPatch(patch, fullItem, prevItem = null) {
  return columnsForEdit(patch, fullItem, prevItem).cols;
}

// ── Categories ───────────────────────────────────────────────────────────────
// The row every category writer builds (the store's editor path and the push's insert
// only path). The photo goes ONLY through categoryImageField: a real https URL or nothing,
// so no save can wipe a photo (removal is saveCategoryImage in db.js only). The LIVE store
// row is passed when there is one, so a write queued before a photo change reads the new one.
export function categoryRow(cat, liveCat = null) {
  return {
    menu_id:          own(cat, 'menuId', 'menu_id') || null,
    parent_id:        own(cat, 'parentId', 'parent_id') || null,
    label:            cat.label ?? cat.name ?? 'Category',
    icon:             cat.icon || '🍽',
    color:            cat.color || '#3b82f6',
    accounting_group: own(cat, 'accountingGroup', 'accounting_group') || '',
    sort_order:       own(cat, 'sortOrder', 'sort_order') || 0,
    default_course:   own(cat, 'defaultCourse', 'default_course') ?? 1,
    spacer_slots:     own(cat, 'spacerSlots', 'spacer_slots') ?? [],
    is_special:       cat.isSpecial ?? cat.is_special ?? false,
    ...(cat.taxProfileId !== undefined || cat.tax_profile_id !== undefined
      ? { tax_profile_id: cat.taxProfileId ?? cat.tax_profile_id ?? null } : {}),
    ...categoryImageField(liveCat ?? cat),
  };
}

export const CATEGORY_COLUMNS = {
  menu_id:          { keys: ['menuId', 'menu_id'] },
  parent_id:        { keys: ['parentId', 'parent_id'] },
  label:            { keys: ['label', 'name'] },
  icon:             { keys: ['icon'] },
  color:            { keys: ['color'] },
  accounting_group: { keys: ['accountingGroup', 'accounting_group'] },
  sort_order:       { keys: ['sortOrder', 'sort_order'] },
  default_course:   { keys: ['defaultCourse', 'default_course'] },
  spacer_slots:     { keys: ['spacerSlots', 'spacer_slots'] },
  is_special:       { keys: ['isSpecial', 'is_special'] },
  tax_profile_id:   { keys: ['taxProfileId', 'tax_profile_id'] },
  image:            { keys: ['image'] },
};

/** The category columns an edit writes (same rule as columnsForPatch; no derived columns). */
export function columnsForCategoryPatch(patch, fullCat, liveCat = null) {
  if (!patch || typeof patch !== 'object' || !fullCat) return {};
  const full = categoryRow(fullCat, liveCat);
  const out = {};
  for (const [col, spec] of Object.entries(CATEGORY_COLUMNS)) {
    if (col in full && spec.keys.some((k) => has(patch, k))) out[col] = full[col];
  }
  return out;
}

// ── Menus ────────────────────────────────────────────────────────────────────
// Both spellings through the shared normaliser (v5.7.15: a stale snake only row un-starred
// the default menu on any save).
export function menuRow(menu) {
  const m = normaliseMenuRow(menu) || {};
  return {
    name:        m.name || 'Menu',
    description: m.description || '',
    is_default:  m.isDefault || false,
    is_active:   m.isActive !== false,
    sort_order:  m.sortOrder || 0,
    schedule:    m.schedule ?? null,
    priority:    m.priority ?? 0,
    scope:       m.scope || 'local',
    org_id:      m.orgId ?? m.org_id ?? null,
  };
}

export const MENU_COLUMNS = {
  name:        { keys: ['name'] },
  description: { keys: ['description'] },
  is_default:  { keys: ['isDefault', 'is_default'] },
  is_active:   { keys: ['isActive', 'is_active'] },
  sort_order:  { keys: ['sortOrder', 'sort_order'] },
  schedule:    { keys: ['schedule'] },
  priority:    { keys: ['priority'] },
  scope:       { keys: ['scope'] },
  org_id:      { keys: ['orgId', 'org_id'] },
};

/** The menus columns an edit writes. */
export function columnsForMenuPatch(patch, fullMenu) {
  if (!patch || typeof patch !== 'object' || !fullMenu) return {};
  const full = menuRow(fullMenu);
  const out = {};
  for (const [col, spec] of Object.entries(MENU_COLUMNS)) {
    if (spec.keys.some((k) => has(patch, k))) out[col] = full[col];
  }
  return out;
}

// ── Comparing column values ─────────────────────────────────────────────────
// jsonb comes back with its keys in the database's order, and a missing value is null, so
// the comparison is on a stable form: keys sorted, undefined read as null (and dropped
// inside objects, as JSON drops it on the way to the database).
export function stableJson(v) {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const sameValue = (a, b) => stableJson(a) === stableJson(b);

/** Just these keys of a column map. */
export const pickColumns = (row, cols) => {
  const out = {};
  for (const c of cols || []) if (row && c in row) out[c] = row[c];
  return out;
};

/**
 * What a re-read row says about an edit that matched no row.
 *   cols   what this tab wants to write
 *   base   the same columns as this tab last saw them (before the edit)
 *   fresh  the same columns as the database holds them now (mapped the same way as base)
 * changed  columns somebody else changed (neither what we saw nor what we want): refuse
 * pending  columns still ours to write (the database still holds what we saw)
 * A column that already holds what we want is neither.
 */
export function columnConflicts({ cols, base, fresh }) {
  const changed = [];
  const pending = [];
  for (const c of Object.keys(cols || {})) {
    const now = fresh ? fresh[c] : undefined;
    if (sameValue(now, cols[c])) continue;
    if (!sameValue(now, base ? base[c] : undefined)) changed.push(c);
    else pending.push(c);
  }
  return { changed, pending };
}

/** The store keys that read a set of columns (so a merge can leave pending edits alone). */
export function keysForColumns(spec, cols) {
  const out = new Set();
  for (const c of cols || []) for (const k of (spec[c]?.keys || [])) out.add(k);
  return out;
}
