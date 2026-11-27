// src/lib/ai86.js
//
// THE ASSISTANT'S 86 (5.12.119). Peter, 27 Nov 2026: "I also cant find a way to 86 a sub item!
// and the Ai said its done it but doesnt".
//
// What was wrong: the tool asked the model for an item id it never had (its lookup gave names
// only), so for a sub item it made one up; the app flipped the 86 switch on that id without
// looking, and always answered "has been 86'd".
//
// The rules here:
//   * the APP finds the row (a product, a size or an option), by a real id or by name;
//   * two rows with the name are never guessed between: both come back, with their ids;
//   * a row that is already 86'd is left alone (the store's toggle86 is a switch: it would have
//     been turned back ON);
//   * "has been 86'd" is only said when the 86 list holds the row afterwards.
//
// PURE: no imports, so node --test can load it.

/**
 * 5.12.119: the menu row an 86 is for, found by the app (never trusted from the model).
 *   input  { item_id?, item_name? }
 * A row is a product, a size or a sub item (an option). By id when the id is a real row; else by
 * name: the exact name first, then a name that holds the words. More than one match is never
 * guessed: the choices come back (with their ids) so the person can say which.
 * Returns { item, kind } or { item: null, words, choices? }.
 */
export function find86Target(menuItems, input = {}, { menuCategories = [], modifierGroupDefs = [] } = {}) {
  const rows = (Array.isArray(menuItems) ? menuItems : []).filter(i => i && !i.archived && i.type !== 'spacer');
  const kindOf = (i) => (i.type === 'subitem' ? 'option' : (i.parentId || i.parent_id) ? 'size' : 'product');
  const where = (i) => {
    if (i.type === 'subitem') {
      const g = modifierGroupDefs.filter(d => (d.options || []).some(o => o && (o.itemId || o.item_id) === i.id)).map(d => d.name).filter(Boolean);
      return g.length ? `an option in ${g.slice(0, 2).join(' and ')}` : 'an option';
    }
    const parent = (i.parentId || i.parent_id) ? rows.find(r => r.id === (i.parentId || i.parent_id)) : null;
    if (parent) return `a size of ${parent.menuName || parent.name}`;
    const cat = menuCategories.find(c => c.id === (i.cat || i.categoryId));
    return cat ? `a product in ${cat.label || cat.name}` : 'a product';
  };
  const byId = input.item_id ? rows.find(i => i.id === input.item_id) : null;
  if (byId) return { item: byId, kind: kindOf(byId) };
  const q = String(input.item_name || '').trim().toLowerCase();
  if (!q) return { item: null, words: 'No product name was given. Nothing was changed.' };
  const names = (i) => [i.name, i.menuName].filter(Boolean).map(n => String(n).trim().toLowerCase());
  let hits = rows.filter(i => names(i).includes(q));
  if (!hits.length) hits = rows.filter(i => names(i).some(n => n.includes(q)));
  if (!hits.length) return { item: null, words: `Nothing on the menu is called "${input.item_name}": no product, size or option. Nothing was changed.` };
  if (hits.length === 1) return { item: hits[0], kind: kindOf(hits[0]) };
  return {
    item: null,
    words: `${hits.length} things on the menu match "${input.item_name}". Nothing was changed. Ask which one, then call again with its item_id.`,
    choices: hits.slice(0, 8).map(i => ({ item_id: i.id, name: i.menuName || i.name, what: where(i) })),
  };
}

/** What the assistant gets back when it asks to 86 something: a proposal to confirm, or plain words why not. */
export function propose86(toolInput = {}, storeState = {}) {
  const { menuItems = [], menuCategories = [], modifierGroupDefs = [], eightySixIds = [] } = storeState;
  const found = find86Target(menuItems, toolInput, { menuCategories, modifierGroupDefs });
  if (!found.item) {
    return { result: { preview: false, ok: false, nothing_changed: true, message: found.words, ...(found.choices ? { choices: found.choices } : {}) } };
  }
  const name = found.item.menuName || found.item.name;
  if (eightySixIds.includes(found.item.id)) {
    return { result: { preview: false, ok: true, nothing_changed: true, message: `"${name}" is already 86'd. Nothing was changed.` } };
  }
  return {
    result: { preview: true, message: `Proposed 86, awaiting your confirmation. It is NOT 86'd yet.`, item: name, kind: found.kind },
    pendingAction: {
      type:    'eighty_six_item',
      label:   `86 "${name}"${found.kind === 'option' ? ' (an option)' : ''}: mark as sold out`,
      payload: { item_id: found.item.id, item_name: name },
    },
  };
}

/**
 * The confirmed 86.
 *   storeActions  { toggle86, getMenuItems?, getEightySixIds? }  (the two getters read the LIVE store)
 * Returns { ok, message } or { ok: false, error }.
 */
export function confirm86(payload, storeActions = {}) {
  const { toggle86, getMenuItems, getEightySixIds } = storeActions;
  if (!toggle86) return { ok: false, error: 'Not available' };
  const id = payload?.item_id;
  if (!id) return { ok: false, error: 'No product was picked. Nothing was changed.' };
  const name = payload.item_name || 'That product';
  if (getMenuItems && !(getMenuItems() || []).some(i => i && i.id === id && !i.archived)) {
    return { ok: false, error: `Could not find "${name}" on the menu. Nothing was changed.` };
  }
  if (getEightySixIds && (getEightySixIds() || []).includes(id)) return { ok: true, message: `"${name}" was already 86'd` };
  toggle86(id);
  if (getEightySixIds && !(getEightySixIds() || []).includes(id)) return { ok: false, error: `The 86 on "${name}" did not take. Nothing was changed.` };
  return { ok: true, message: `"${name}" has been 86'd` };
}
