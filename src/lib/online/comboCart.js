// src/lib/online/comboCart.js
//
// A COMBO ON THE ONLINE PAGE AND THE CATERING LINK (5.12.125, stage 3). Peter, 27 Nov 2026: YES to
// customers building a Combo there, "this is just a combo product so yes is the answer thats what
// we are building these features for".
//
// The rules are the POS's own (lib/combo.js): the same steps, counts, words and checks. This file
// turns a finished Combo into basket lines the way a customer page builds every line
// (OnlineSurface and CateringSurface addToCart: names, categories, tax, the menu it was priced on):
//   * the Combo's own line: the set price, qty 1, never sent to the kitchen (noKitchen)
//   * one line per pick: the picked product's own id, names, categories and tax, its options in mods
// ONE DIFFERENCE FROM THE POS: a customer page keeps options apart from the price (each option
// carries its own price, and every total adds them, the server's included), so a pick's price here
// is its base (0.00, or its own price where the step keeps prices) plus its bump, WITHOUT its
// options. SQL 20261217a values the lines the same way on the server: supabase/tests/combo_online/
// run.mjs proves a basket built here comes to the server's own figure.
//
// A pick is part of its Combo: it is never in the lines the automatic deals, a promo code's
// category rules or a free item reward read (the POS's rule, and the server's since 20261217a),
// and the basket counts a Combo as one item.
//
// PURE: no React, no database. Runs under node --test.

import { kitchenOverride, receiptOverride } from '../itemDisplay.js';
import { lineCategories } from '../lineCategories.js';
import { lineTaxRefsFor } from '../taxRefs.js';
import { isSoldAs, notSoldAsWords, optionHiddenOn, soldAsKey, SOLD_AS_WORDS } from '../soldAs.js';
import { compareMenuItems } from '../menuItemOrder.js';
import { optionFacts } from '../comboLines.js';
import {
  comboLinePlan, comboSteps, isComboPick, isComboParent, comboIdOf, picksFromLines, orderBlocks, cents,
} from '../combo.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const parentIdOf = (row) => row?.parent_id ?? row?.parentId ?? null;
const assignedIds = (row) => listOf(row?.assigned_modifier_groups ?? row?.assignedModifierGroups)
  .map((a) => (typeof a === 'string' ? a : a?.groupId || a?.id || null)).filter(Boolean);
const instIds = (row) => listOf(row?.assigned_instruction_groups ?? row?.assignedInstructionGroups)
  .map((a) => (typeof a === 'string' ? a : a?.groupId || null)).filter(Boolean);

/**
 * The context lib/combo.js reads on a customer page (what can be picked right now), the same parts
 * the POS builds (lib/comboLines.js comboPosContext) from the page's own data:
 *   rows                the menu rows the page read (snake case, as the database has them)
 *   eightySixIds        what is 86'd today
 *   stockLevels         { id: { remaining } } daily counts, less what the basket already holds
 *   basket              the lines already in the basket (a Combo being changed is left out by the caller)
 *   orderType           the order type the page prices for (Sold as)
 *   fulfilment          'delivery' and so on (a product head office hides on Delivery is left out)
 *   modifierGroupDefs   the option groups of the step products (null while they load: then any
 *                       product with an option group is asked, so nothing that must be answered is skipped)
 *   instructionGroupDefs the venue's instruction groups
 *   noPrice             (row) => true when the row has no price set for this sale (the page's own
 *                       refusesNoPriceLine): a step that keeps prices never sells it for 0.00
 * A product head office hides on Online (its Shows on list) is left out, as an option linked to it
 * is (lib/soldAs.js optionHiddenOn). Its "Visible on" switch is a menu card's: a product kept off the
 * menu can still be offered inside a Combo, as on the POS.
 */
export function customerComboContext({ item = null, rows = [], eightySixIds = [], stockLevels = {}, basket = [], orderType = null, fulfilment = null, modifierGroupDefs = null, instructionGroupDefs = [], noPrice = null, screen = 'online' } = {}) {
  const list = listOf(rows).filter(Boolean);
  const rowsById = new Map(list.map((r) => [r.id, r]));
  const kids = new Map();
  for (const r of list) {
    const pid = parentIdOf(r);
    if (pid == null || r.archived) continue;
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(r);
  }
  for (const k of kids.values()) k.sort(compareMenuItems);
  // What the basket already holds, as the daily count would count it: the row, and its product for a
  // size, and every option linked to a product. A Combo's own line counts against the Combo's own
  // count (a venue may sell only so many packages a day), as the POS counts it (review of 27 Nov).
  const held = new Map();
  const hold = (id, n) => {
    if (id == null || !(n > 0)) return;
    held.set(id, (held.get(id) || 0) + n);
    const p = parentIdOf(rowsById.get(id));
    if (p != null) held.set(p, (held.get(p) || 0) + n);
  };
  for (const l of listOf(basket)) {
    if (!l) continue;
    const q = Math.max(1, Number(l.qty) || 1);
    hold(l.itemId, q);
    for (const m of listOf(l.mods)) if (m && m.itemId) hold(m.itemId, q);
  }
  const defs = Array.isArray(modifierGroupDefs) ? modifierGroupDefs : null;
  const facts = new Map();
  const factsOf = (row) => {
    if (!row) return { hasOptions: false, requiresAnswers: false };
    if (!facts.has(row.id)) {
      if (defs) facts.set(row.id, optionFacts(row, { menuItems: list, modifierGroupDefs: defs, instructionGroupDefs: listOf(instructionGroupDefs) }));
      else {
        // The groups are still loading: a product with sizes or any option group is asked.
        const any = (kids.get(row.id) || []).length > 0 || assignedIds(row).length > 0 || instIds(row).length > 0
          || assignedIds(rowsById.get(parentIdOf(row))).length > 0;
        facts.set(row.id, { hasOptions: any, requiresAnswers: any });
      }
    }
    return facts.get(row.id);
  };
  const off = new Set(listOf(eightySixIds));
  return {
    comboId: item?.id ?? null,
    rowsById,
    sizesOf: (id) => kids.get(id) || [],
    eightySix: off,
    remainingOf: (id) => {
      const s = stockLevels ? stockLevels[id] : null;
      if (!s || typeof s.remaining !== 'number') return null;
      return s.remaining - (held.get(id) || 0);
    },
    soldAs: (row) => isSoldAs(row, orderType, rowsById),
    notSoldWords: (row) => notSoldAsWords(row, orderType),
    notSoldShort: () => { const k = soldAsKey(orderType); return k ? `Not for ${SOLD_AS_WORDS[k]}` : 'Not available'; },
    hiddenHere: (row) => optionHiddenOn(row, screen, fulfilment),   // 5.12.129: the kiosk reads its own Shows on
    requiresAnswers: (row) => factsOf(row).requiresAnswers,
    hasOptions: (row) => factsOf(row).hasOptions,
    // A pick that keeps its own price, of a product with no price set, is never sold for 0.00: its paid
    // options may price it (the POS's rule, lib/combo.js comboMissing). Review of 27 Nov 2026.
    ...(typeof noPrice === 'function' ? { noPriceLine: (row, extras) => !!noPrice(row) && !((Number(extras) || 0) > 0) } : {}),
  };
}

/**
 * Can the Combo itself be sold right now (its own 86 and its own daily count, less what the basket
 * already holds)? The words for a guest, or null. The POS checks the same (store addCombo).
 */
export function comboOwnStock(item, ctx) {
  if (!item || !ctx) return null;
  const name = item.menu_name || item.menuName || item.name || 'This';
  if (ctx.eightySix && ctx.eightySix.has(item.id)) return `${name} is sold out.`;
  const left = typeof ctx.remainingOf === 'function' ? ctx.remainingOf(item.id) : null;
  if (left != null && left < 1) return `${name} is sold out.`;
  return null;
}

/** The POS's words for a missing price are for staff; a guest is told the product is not available. */
export function guestWords(words) {
  const w = String(words || '');
  const m = w.match(/^(.*) has no price set\. Set one in Back Office before selling it\.$/);
  return m ? `${m[1]} is not available right now. Pick another.` : w;
}

/** The option group ids a Combo's step products (and their sizes) use: what the page loads to ask them. */
export function stepGroupIds(item, rows) {
  const list = listOf(rows).filter(Boolean);
  const ids = new Set();
  for (const s of comboSteps(item)) {
    for (const e of s.products) {
      const row = list.find((r) => r.id === e.itemId);
      if (!row) continue;
      for (const id of assignedIds(row)) ids.add(id);
      for (const size of list.filter((r) => parentIdOf(r) === row.id)) for (const id of assignedIds(size)) ids.add(id);
      for (const id of assignedIds(list.find((r) => r.id === parentIdOf(row)))) ids.add(id);
    }
  }
  return [...ids];
}
let seq = 0;
const defaultUid = (id) => `${id}-${Date.now()}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** A new id for one Combo on a basket: every line of it carries it. */
export const newComboId = () => `cb-${Date.now().toString(36)}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The fields a customer page puts on every basket line for a menu row (OnlineSurface addToCart).
 * menuId is left off when it is undefined (the catering link sends the order's menu instead).
 */
export function customerLineFields(row, rows, { menuId } = {}) {
  return {
    kitchenName: kitchenOverride(row),
    receiptName: receiptOverride(row),
    ...lineCategories(row, listOf(rows)),
    parentId: row?.parent_id || row?.parentId || null,
    ...lineTaxRefsFor(row, listOf(rows)),
    ...(menuId !== undefined ? { menuId: menuId || null } : {}),
  };
}

/**
 * The basket lines of one finished Combo: its own line first, then one line per pick.
 *   item      the Combo (a menu row of type combo, as the page read it)
 *   picks     lib/combo.js picks ({ stepId, entryId, itemId, mods, notes })
 *   rows      every menu row the page holds (for sizes, categories and tax)
 *   priceFor  (row) => the row's price for this order type and menu (the page's own priceFor)
 *   comboId   this Combo's id on the basket (newComboId(), or the one it had when it is changed)
 *   menuId    the menu it is priced on (online), undefined on the catering link
 * Returns the lines, never empty when the Combo has picks.
 */
export function comboCartLines({ item, picks = [], rows = [], priceFor = () => 0, comboId = newComboId(), menuId, uid = defaultUid } = {}) {
  const rowsById = new Map(listOf(rows).filter(Boolean).map((r) => [r.id, r]));
  const plan = comboLinePlan({ item, comboId, setPrice: priceFor(item), picks, rowsById, priceOf: priceFor });
  const lines = [{
    uid: uid(item.id), itemId: item.id, name: plan.parent.name,
    ...customerLineFields(item, rows, { menuId }),
    price: plan.parent.price, qty: 1, mods: [], notes: '',
    comboId, comboRole: 'parent', noKitchen: true,
  }];
  for (const p of plan.picks) {
    const row = rowsById.get(p.itemId);
    // Options ride in mods with their own prices: the line's price is its rule alone.
    const price = cents((p.comboKeepsPrice ? cents(priceFor(row)) : 0) + (Number(p.comboBump) || 0));
    lines.push({
      uid: uid(row.id), itemId: row.id, name: p.name,
      ...customerLineFields(row, rows, { menuId }),
      price, qty: 1, mods: listOf(p.mods), notes: p.notes || '',
      comboId, comboRole: 'pick', comboName: p.comboName,
      comboStepId: p.comboStepId, comboStepName: p.comboStepName, comboEntryId: p.comboEntryId,
      comboKeepsPrice: p.comboKeepsPrice, comboBump: p.comboBump,
    });
  }
  return lines;
}

const COMBO_FIELDS = ['comboId', 'comboRole', 'comboName', 'comboStepId', 'comboStepName', 'comboEntryId', 'comboKeepsPrice', 'comboBump'];
/**
 * What a basket line sends with the order so its Combo stays one Combo (the till, the kitchen, the
 * receipt and the reports read these, lib/combo.js), and so the server can check it against the
 * Combo's own steps (SQL 20261217a). {} for every other line. The Combo's own line never reaches
 * the kitchen (noKitchen).
 */
export function comboFieldsOf(line) {
  if (!line || !line.comboId) return {};
  const out = {};
  for (const k of COMBO_FIELDS) if (line[k] !== undefined) out[k] = line[k];
  if (line.noKitchen) out.noKitchen = true;
  return out;
}

/** The picks of a Combo already in the basket, to open it again for a change. */
export function comboPicksInBasket(cart, comboId) {
  return picksFromLines(listOf(cart).filter((l) => l && l.comboId === comboId));
}

/** The basket with one Combo's lines swapped for new ones, in the place the Combo had. */
export function replaceComboLines(cart, comboId, lines) {
  const list = listOf(cart);
  const at = list.findIndex((l) => l && l.comboId === comboId);
  const rest = list.filter((l) => !l || l.comboId !== comboId);
  if (at < 0) return [...rest, ...lines];
  const before = list.slice(0, at).filter((l) => !l || l.comboId !== comboId).length;
  return [...rest.slice(0, before), ...lines, ...rest.slice(before)];
}

/** The basket without one Combo (every line of it), or without one line when it is not in a Combo. */
export function removeBasketLine(cart, uid) {
  const list = listOf(cart);
  const line = list.find((l) => l && l.uid === uid);
  if (!line) return list;
  const id = comboIdOf(line);
  return list.filter((l) => l && (id ? l.comboId !== id : l.uid !== uid));
}

/** How many things are in the basket: a Combo counts once, never once per pick. */
export function basketCount(cart) {
  return listOf(cart).filter((l) => l && !isComboPick(l)).reduce((s, l) => s + (Number(l.qty) || 1), 0);
}

/** The lines deals, promo codes and free item rewards read: every line but a Combo's picks. */
export function linesWithoutPicks(cart) {
  return listOf(cart).filter((l) => l && !isComboPick(l));
}

/**
 * The basket after an order type change takes off what the new order type does not sell: a line,
 * or a WHOLE Combo when any line of it is not sold (a Combo is never left without a pick it was
 * built with, nor a pick without its Combo). Returns { kept, gone }: gone are the names to say.
 */
export function dropHidden(cart, hidden) {
  const list = listOf(cart);
  const out = new Set(list.filter((l) => l && hidden(l)).map((l) => comboIdOf(l) || `uid:${l.uid}`));
  const kept = list.filter((l) => l && !out.has(comboIdOf(l) || `uid:${l.uid}`));
  const gone = [];
  for (const l of list) {
    if (!l || kept.includes(l)) continue;
    const name = isComboPick(l) ? null : (l.name || l.itemId);
    if (name && !gone.includes(name)) gone.push(name);
  }
  return { kept, gone };
}

/**
 * The basket as a customer reads it: a Combo is ONE block (its line, then its picks under it),
 * every other line is itself (lib/combo.js orderBlocks). A block's total is what the whole Combo
 * comes to on a customer page: every line's price plus its options, times its quantity.
 */
export function basketBlocks(cart) {
  const lineTotal = (l) => (Number(l.price) || 0) + listOf(l.mods).reduce((s, m) => s + (Number(m?.price) || 0), 0);
  return orderBlocks(listOf(cart).filter(Boolean)).map((b) => (b.kind !== 'combo' ? b : {
    ...b,
    total: cents([b.parent, ...b.picks].reduce((s, l) => s + lineTotal(l) * (Number(l.qty) || 1), 0)),
    extras: cents(b.picks.reduce((s, l) => s + lineTotal(l) * (Number(l.qty) || 1), 0)),
  }));
}

/** The steps of a Combo line's product, read from the page's rows (empty when it has none now). */
export function stepsOfBasketCombo(cart, comboId, rows) {
  const parent = listOf(cart).find((l) => l && l.comboId === comboId && isComboParent(l));
  const row = parent ? listOf(rows).find((r) => r && r.id === parent.itemId) : null;
  return row ? comboSteps(row) : [];
}
