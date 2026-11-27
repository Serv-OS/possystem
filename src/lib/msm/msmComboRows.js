// src/lib/msm/msmComboRows.js
//
// THE GROUP MENU'S PRODUCTS AS THE STEPS EDITOR READS A MENU (5.12.124, Combo products stage 2).
// Pure, tested (msmComboRows.test.js).
//
// The parent session's brief, 27 Nov 2026: "the Steps editor component and the pure rules must work
// with central product ids as well as a site's item ids (a small adapter, not two editors)". The
// Steps tab (backoffice/sections/ComboStepsTab.jsx) reads the store's menu rows (camel case, a size
// under its product by parentId, its price in pricing.base). A group menu product is a row of
// msm_products (snake case, parent_product_id, default_price). These shape one into the other, so
// the group menu's product sheet opens the very same editor, with the very same words and rules,
// and every step lists products of the group menu by their own ids.

import { COMBO_TYPE } from '../combo.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** One group menu product as a menu row of the Steps editor. */
export function comboStepRow(p) {
  if (!p || typeof p !== 'object') return null;
  const price = p.default_price == null || p.default_price === '' ? null : Number(p.default_price);
  return {
    id: p.id,
    name: p.name || p.menu_name || 'Product',
    menuName: p.menu_name || p.name || 'Product',
    receiptName: p.receipt_name || null,
    kitchenName: p.kitchen_name || null,
    parentId: p.parent_product_id || null,
    type: p.type || 'simple',
    cat: p.category_id || null,
    cats: listOf(p.extra_category_ids),
    // A product with no price set is "no price" to the editor too (it warns where that matters).
    pricing: { base: Number.isFinite(price) ? price : null },
    price: Number.isFinite(price) ? price : 0,
    archived: !!p.archived,
    soldAlone: p.type === 'subitem' ? p.sold_alone === true : p.sold_alone !== false,
    scope: 'local',
    allergens: listOf(p.allergens),
    visibility: p.visibility || null,
    sortOrder: p.sort_order ?? 0,
    ...(has(p, 'combo') ? { combo: p.combo ?? null } : {}),
  };
}

/** Every product of the group menu (the draft applied) as the editor's menu rows. */
export function comboStepRows(products) {
  return listOf(products).map(comboStepRow).filter(Boolean);
}

/**
 * The Combo being edited, as the editor's item: its id (a new product has the id the sheet will
 * stage it with), its names, its set price and its steps as the form holds them.
 */
export function comboStepItem({ id, form = {}, price = null } = {}) {
  return {
    id,
    type: COMBO_TYPE,
    name: form.name || form.menu_name || 'This Combo',
    menuName: form.menu_name || form.name || 'This Combo',
    combo: form.combo ?? null,
    scope: 'local',
    parentId: form.parent_product_id || null,
    pricing: { base: price == null || price === '' ? null : Number(price) },
    assignedModifierGroups: listOf(form.modifier_groups),
  };
}

/**
 * True once the group menu can hold a Combo's steps (SQL 20261216a): the products it read carry the
 * combo column (msmRead selects every column). Before that the sheet says the update is needed and
 * offers no editor, as the site's Steps tab does before SQL 20261215a.
 */
export function comboColumnReady(products) {
  return listOf(products).some((p) => has(p, 'combo'));
}
