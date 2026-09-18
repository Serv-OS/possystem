// src/lib/loyaltyItemPicker.js
//
// Back Office "Eligible free items" picker (points rewards and stamp card rewards): items from
// EVERY site of the company, grouped by name, like the stamp card category picker.
//
// Loyalty is per COMPANY (Peter, 18 Sep 2026) but menu_items are per SITE, so the Latte at
// Leeds and the Latte at Barnsley have different ids. The picker shows one "Latte" (with how
// many sites have it), and ticking it saves every site's id with the same name, so the saved
// id matches at every site today and the name (lib/loyaltyMenuMatch.js) covers sites and
// menus added later. The saved shape is unchanged: [{ id, name }].
//
// A size is grouped as "<parent> - <size>" (itemLabel), the label the matcher compares.

import { itemLabel, itemLabelKey } from './loyaltyMenuMatch.js';

function priceOf(i) {
  const p = Number(i?.price ?? i?.pricing?.base);
  return Number.isFinite(p) ? p : 0;
}

/**
 * @param {Array<{id:string,name:string,parent_id?:string|null,location_id?:string,price?:number}>} items
 * @returns {Array<{key,name,ids,siteCount,price,variants:Array<{key,name,label,ids,siteCount,price}>}>}
 *   products sorted by name. ids are the plain (no size) items with that name; variants are the
 *   sizes, grouped by "<parent> - <size>" across every site.
 */
export function groupItemsForPicker(items) {
  const list = Array.isArray(items) ? items.filter(i => i && i.id && typeof i.name === 'string') : [];
  const byId = new Map(list.map(i => [i.id, i]));
  const hasChildren = new Set();
  for (const i of list) if (i.parent_id && byId.has(i.parent_id)) hasChildren.add(i.parent_id);

  const products = new Map();
  const productFor = (row) => {
    const key = itemLabelKey(row.name);
    if (!key) return null;
    let p = products.get(key);
    if (!p) {
      p = { key, name: row.name.trim().replace(/\s+/g, ' '), ids: [], siteCount: 0, price: priceOf(row), variants: [], _sites: new Set(), _variants: new Map() };
      products.set(key, p);
    }
    p._sites.add(row.location_id || row.id);
    return p;
  };

  for (const i of list) {
    if (i.parent_id) continue;
    const p = productFor(i);
    if (p && !hasChildren.has(i.id)) p.ids.push(i.id);
  }
  for (const v of list) {
    if (!v.parent_id) continue;
    const parent = byId.get(v.parent_id);
    if (!parent || parent.parent_id) continue;   // a size of a size is not a product
    const p = productFor(parent);
    if (!p) continue;
    const label = itemLabel(v.name, parent.name);
    const key = itemLabelKey(label);
    if (!key) continue;
    let g = p._variants.get(key);
    if (!g) {
      g = { key, name: v.name.trim().replace(/\s+/g, ' '), label, ids: [], siteCount: 0, price: priceOf(v), _sites: new Set() };
      p._variants.set(key, g);
    }
    g.ids.push(v.id);
    g._sites.add(v.location_id || v.id);
  }

  const out = [];
  for (const p of products.values()) {
    const variants = [...p._variants.values()]
      .map(({ _sites, ...g }) => ({ ...g, siteCount: _sites.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
    out.push({ key: p.key, name: p.name, ids: p.ids, siteCount: p._sites.size, price: p.price, variants });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A group (product or size) is selected when a saved entry has one of its ids or its name. */
export function pickGroupSelected(group, selected) {
  const ids = new Set(group?.ids || []);
  for (const s of Array.isArray(selected) ? selected : []) {
    if (!s) continue;
    if (s.id && ids.has(s.id)) return true;
    if (group?.key && itemLabelKey(s.name) === group.key) return true;
  }
  return false;
}

/**
 * Toggle a group. On: save every site's id under the group's label. Off: remove every saved
 * entry with one of its ids or its name, so no site keeps matching it.
 * @param group  { key, ids, label? | name }
 */
export function togglePickGroup(group, selected) {
  const current = Array.isArray(selected) ? selected.filter(Boolean) : [];
  if (pickGroupSelected(group, current)) {
    const ids = new Set(group.ids || []);
    return current.filter(s => !(s.id && ids.has(s.id)) && itemLabelKey(s.name) !== group.key);
  }
  const label = group.label || group.name;
  const have = new Set(current.map(s => s.id));
  const next = [...current];
  for (const id of group.ids || []) if (!have.has(id)) next.push({ id, name: label });
  return next;
}

/** Saved entries as one chip per name: [{ key, name, count }]. */
export function selectedChips(selected) {
  const chips = new Map();
  for (const s of Array.isArray(selected) ? selected : []) {
    if (!s) continue;
    const key = itemLabelKey(s.name) || `id:${s.id}`;
    const c = chips.get(key);
    if (c) c.count += 1;
    else chips.set(key, { key, name: s.name || 'Item', count: 1 });
  }
  return [...chips.values()];
}

/** Remove a chip: every saved entry with that name. */
export function removeChip(key, selected) {
  return (Array.isArray(selected) ? selected : []).filter(s => s && (itemLabelKey(s.name) || `id:${s.id}`) !== key);
}
