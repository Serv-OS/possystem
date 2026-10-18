// src/lib/msm/msmLock.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75, design 3.2 and the design review): the Menu
// Manager lock. Pure, tested (msmLock.test.js).
//
// A product or an option group that the group menu manages at a site has fields head office owns:
// a change made to them at the site is replaced by the next publish, so the site's screens show
// them read only and the store refuses to save them (every screen goes through the store: Menu
// Manager, the menu visualiser, the canvas menu, the AI tools and the bulk VAT tool). A field the
// site KEEPS as its own (msm_product_sites.kept, msm_modifier_group_sites.kept) stays editable.
//
// Still the site's own, always: button colour, order, print centre, timed menu prices
// (pricing.menus), 86, cooking preferences (instruction groups), recipes, the sharing scope.
//
// It stays a SCREEN lock, not a database lock (design 8): publish is the guard. When the managed
// lists cannot be read, nothing is locked and the site works as it does today.

const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Store patch keys (camel and snake spellings) -> the venue column the group menu owns.
export const OWNED_ITEM_KEYS = Object.freeze({
  name: 'name', menuName: 'menu_name', menu_name: 'menu_name',
  receiptName: 'receipt_name', receipt_name: 'receipt_name',
  kitchenName: 'kitchen_name', kitchen_name: 'kitchen_name',
  description: 'description', cat: 'cat', cats: 'cats',
  taxRateId: 'tax_rate_id', tax_rate_id: 'tax_rate_id',
  taxProfileId: 'tax_rate_id', tax_profile_id: 'tax_rate_id',
  taxOverrides: 'tax_overrides', tax_overrides: 'tax_overrides',
  allergens: 'allergens', tags: 'tags', image: 'image',
  assignedModifierGroups: 'assigned_modifier_groups', assigned_modifier_groups: 'assigned_modifier_groups', modifierGroups: 'assigned_modifier_groups',
  visibility: 'visibility', soldAlone: 'sold_alone', sold_alone: 'sold_alone', type: 'type',
  itemCode: 'item_code', item_code: 'item_code', parentId: 'parent_id', parent_id: 'parent_id',
  price: 'pricing',
});

// The prices head office owns inside pricing (the Standard price and the order type prices).
// pricing.menus (timed menu prices) and anything else stay the site's.
export const OWNED_PRICE_KEYS = Object.freeze(['base', 'dineIn', 'takeaway', 'collection', 'delivery', 'driveThru']);

// An option group's fields head office owns (store spelling -> column for the kept check).
export const OWNED_GROUP_KEYS = Object.freeze({
  name: 'name', min: 'min', max: 'max', minSelect: 'min', maxSelect: 'max', min_select: 'min', max_select: 'max',
  selectionType: 'selection_type', selection_type: 'selection_type',
});
// The keys of one option head office owns. Any other key on an option (an 86 flag, a colour) stays
// the site's.
export const OWNED_OPTION_KEYS = Object.freeze(['name', 'price', 'itemId', 'item_id', 'subGroupId', 'sub_group_id']);

// Plain words for each owned column (shown in the lock note).
const WORDS = {
  name: 'name', menu_name: 'name', receipt_name: 'receipt name', kitchen_name: 'kitchen name', description: 'description',
  cat: 'category', cats: 'extra categories', tax_rate_id: 'VAT', tax_overrides: 'VAT by order type', allergens: 'allergens',
  tags: 'dietary tags', image: 'photo', assigned_modifier_groups: 'option groups', visibility: 'where it shows',
  sold_alone: 'sold on its own', type: 'type', item_code: 'item code', parent_id: 'size of', pricing: 'prices',
  min: 'rule', max: 'rule', selection_type: 'kind of choice', options: 'options',
};
export const lockWord = (col) => WORDS[col] || 'this setting';

/** The words every lock note uses. */
export const LOCK_WORDS = Object.freeze({
  product: 'Head office sets this in the Multi site menu. Ask the people who run your group menu to change it there.',
  group: 'This option group is managed by head office in the Multi site menu. Its name, rules, options and prices are set there.',
  stillYours: 'Still yours here: button colour, order, print centre, timed menu prices, 86, cooking preferences and recipes.',
});

const keptSet = (kept) => new Set(Array.isArray(kept) ? kept : kept instanceof Set ? [...kept] : []);

/**
 * The part of a store patch a site may save on a product the group menu manages.
 *   patch   the store patch (camel or snake keys)
 *   cur     the product as the store holds it now (for the prices)
 *   kept    the columns this site keeps as its own (msm_managed_items kept)
 * Returns { patch, dropped: [columns] }. A patch with nothing owned comes back as it was.
 */
export function lockedItemPatch(patch, cur, kept = []) {
  const k = keptSet(kept);
  const out = {};
  const dropped = new Set();
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'pricing') {
      const was = cur?.pricing && typeof cur.pricing === 'object' ? cur.pricing : {};
      const next = value && typeof value === 'object' ? { ...value } : {};
      let changed = false;
      for (const pk of OWNED_PRICE_KEYS) {
        if (!same(next[pk], was[pk])) { changed = true; if (has(was, pk)) next[pk] = was[pk]; else delete next[pk]; }
      }
      if (changed) dropped.add('pricing');
      if (!same(next, was)) out.pricing = next;
      continue;
    }
    const col = OWNED_ITEM_KEYS[key];
    if (!col || k.has(col)) { out[key] = value; continue; }
    // The same value as now is harmless (a screen that sends the whole row): let it through.
    const now = cur ? (has(cur, key) ? cur[key] : undefined) : undefined;
    if (cur && same(now, value)) { out[key] = value; continue; }
    dropped.add(col);
  }
  return { patch: out, dropped: [...dropped] };
}

/**
 * The part of a store patch a site may save on an option group the group menu manages.
 *   patch      { name, min, max, selectionType, options, ... }
 *   cur        the group as the store holds it now
 *   kept       the group columns this site keeps (msm_managed_groups kept)
 *   ownedIds   the venue option ids the group menu owns in this group (Set or array)
 * Options: head office's options keep their name, price, sub item and Then ask, and are never taken
 * out; options the site added itself, and any other key, stay the site's.
 * Returns { patch, dropped: [columns] }.
 */
export function lockedGroupPatch(patch, cur, kept = [], ownedIds = []) {
  const k = keptSet(kept);
  const owned = new Set(ownedIds instanceof Set ? [...ownedIds] : Array.isArray(ownedIds) ? ownedIds : []);
  const out = {};
  const dropped = new Set();
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'options') {
      const was = Array.isArray(cur?.options) ? cur.options : [];
      const next = Array.isArray(value) ? value.map((o) => (o && typeof o === 'object' ? { ...o } : o)) : [];
      const wasById = new Map(was.filter((o) => o && owned.has(o.id)).map((o) => [o.id, o]));
      for (const o of next) {
        const w = o && wasById.get(o.id);
        if (!w) continue;
        for (const ok of OWNED_OPTION_KEYS) {
          if (!same(o[ok], w[ok])) { dropped.add('options'); if (has(w, ok)) o[ok] = w[ok]; else delete o[ok]; }
        }
      }
      // An option head office owns that the patch took out goes back where it was.
      for (const [id, w] of wasById) {
        if (next.some((o) => o && o.id === id)) continue;
        dropped.add('options');
        const at = was.indexOf(w);
        next.splice(Math.min(at, next.length), 0, { ...w });
      }
      if (!same(next, was)) out.options = next;
      continue;
    }
    const col = OWNED_GROUP_KEYS[key];
    if (!col || k.has(col)) { out[key] = value; continue; }
    if (cur && same(cur[key], value)) { out[key] = value; continue; }
    dropped.add(col);
  }
  return { patch: out, dropped: [...dropped] };
}

/** One option's patch (store updateModifierGroupOption) on a managed group. */
export function lockedOptionPatch(patch, ownedOption) {
  if (!ownedOption) return { patch: { ...(patch || {}) }, dropped: [] };
  const out = {};
  let dropped = false;
  for (const [key, value] of Object.entries(patch || {})) {
    if (OWNED_OPTION_KEYS.includes(key) && !same(ownedOption[key], value)) { dropped = true; continue; }
    out[key] = value;
  }
  return { patch: out, dropped: dropped ? ['options'] : [] };
}

/** The toast after a refused edit: "Latte: the price and the name are set by head office ...". */
export function droppedWords(name, dropped) {
  const words = [...new Set((dropped || []).map(lockWord))];
  if (!words.length) return '';
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `${name || 'This product'}: the ${list} ${words.length === 1 ? 'is' : 'are'} set by head office in the Multi site menu, so ${words.length === 1 ? 'it was' : 'they were'} not changed here.`;
}

/**
 * What the lock means for one product at this site, for the screens.
 *   state   msmManaged.msmManagedState()
 * Returns null when the product is not managed, else { kept: Set(columns), locked(col) }.
 */
export function itemLock(state, id) {
  if (!state || !id || !state.ids || !state.ids.has(id)) return null;
  const kept = keptSet(state.kept && state.kept.get ? state.kept.get(id) : []);
  return { kept, locked: (col) => !kept.has(col) };
}
/** The same for an option group: { kept, ownedOptions: Set, locked(col) } or null. */
export function groupLock(state, id) {
  if (!state || !id || !state.groups || !state.groups.has(id)) return null;
  const kept = keptSet(state.groupKept && state.groupKept.get ? state.groupKept.get(id) : []);
  const ownedOptions = (state.groupOptions && state.groupOptions.get && state.groupOptions.get(id)) || new Set();
  return { kept, ownedOptions, locked: (col) => !kept.has(col) };
}
