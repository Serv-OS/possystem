// src/lib/comboLines.js
//
// A FINISHED COMBO AS REAL POS ORDER LINES (5.12.123, stage 1). The rules are lib/combo.js (import
// free); this file dresses its plan in the fields EVERY POS line carries, with the POS's own
// helpers, so a pick is the line the counter would ring for that product:
//   kitchen and receipt names   lib/itemDisplay.js kitchenOverride / receiptOverride
//   category and "Also in"      lib/tillLine.js tillLineCat / tillLineCats (a size reports under its product)
//   tax                         lib/tillLine.js tillLineTaxRefs / tillLineTaxFields (the size rule, this venue's rates)
//   course                      the category's default course (store.addItem's chain: cat, cats[0], the product's cat)
// store.addItem builds its line from the same helpers. This file is the ONLY place a Combo's lines
// are built (comboStore wiring test), so the POS, a changed Combo and "add another" cannot drift.
//
// It also answers, for one product: does it have options at all, and must any be answered? The
// same rules the POS option flow applies (lib/menuRules.js rules 2 to 4).
//
// PURE: no store, no database. Runs under node --test.

import { kitchenOverride, receiptOverride } from './itemDisplay.js';
import { tillLineCat, tillLineCats, tillLineTaxRefs, tillLineTaxFields } from './tillLine.js';
import { sizeOrMainOptions, modifierGroupRequired, instructionGroupMin, assignmentGroupId } from './menuRules.js';
import { isSoldAs, notSoldAsWords, optionHiddenOn, groupsShownOn } from './soldAs.js';
import { compareMenuItems } from './menuItemOrder.js';
import { comboLinePlan, comboSteps, pickPrice, pickLineName, isComboPick, cents } from './combo.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const parentIdOf = (row) => row?.parentId ?? row?.parent_id ?? null;

/** The course a line starts on: its category's default (store.addItem's own chain). */
export function lineCourse(item, menuItems, menuCategories) {
  const cats = listOf(menuCategories);
  const parent = parentIdOf(item) ? listOf(menuItems).find((m) => m && m.id === parentIdOf(item)) : null;
  const cat = cats.find((c) => c.id === item?.cat)
    || cats.find((c) => c.id === item?.cats?.[0])
    || (parent ? cats.find((c) => c.id === parent.cat) : null);
  return cat?.defaultCourse ?? cat?.default_course ?? 1;
}

/**
 * The fields every POS line takes from its menu row. `dropped` lists tax rate ids the product
 * names that this venue does not hold (the line is then charged at the venue default, and says so).
 */
export function tillLineBase(item, { menuItems = [], menuCategories = [], taxRates = [] } = {}) {
  const refs = tillLineTaxRefs(item, menuItems, taxRates);
  const course = lineCourse(item, menuItems, menuCategories);
  return {
    fields: {
      kitchenName: kitchenOverride(item),
      receiptName: receiptOverride(item),
      allergens: item?.allergens || [],
      centreId: item?.centreId,
      cat: tillLineCat(item, menuItems),
      ...tillLineCats(item, menuItems),
      parentId: parentIdOf(item) || null,
      ...tillLineTaxFields(refs),
      course,
      fired: course === 0,
    },
    dropped: refs.dropped || [],
  };
}

/**
 * The order lines of one finished Combo: its own line first, then one line per pick.
 *   item        the Combo product            comboId   this Combo's id on the order
 *   picks       lib/combo.js picks           setPrice  the Combo's price for this order type and menu
 *   priceOf     (row) => the product's own price for this order type and menu
 *   uid         () => a new line uid
 * Returns { lines, dropped }. The Combo line carries the set price and never reaches the kitchen
 * (noKitchen, course 0); each pick is a normal kitchen line.
 */
export function comboOrderLines({ item, comboId, picks = [], setPrice = 0, priceOf = () => 0, uid, menuItems = [], menuCategories = [], taxRates = [], steps = null } = {}) {
  const rowsById = new Map(listOf(menuItems).filter(Boolean).map((r) => [r.id, r]));
  const plan = comboLinePlan({ item, comboId, setPrice, steps, picks, rowsById, priceOf });
  const ctx = { menuItems, menuCategories, taxRates };
  const dropped = [];
  const own = tillLineBase(item, ctx);
  dropped.push(...own.dropped.map((id) => ({ itemId: item.id, rateId: id })));
  const parent = {
    uid: uid(), itemId: plan.parent.itemId, name: plan.parent.name,
    ...own.fields,
    price: plan.parent.price, qty: 1, mods: [], notes: '', pizzaConfig: null,
    seat: 'shared', course: 0, fired: true, status: 'pending',
    noKitchen: true, comboId, comboRole: 'parent',
  };
  const lines = [parent];
  for (const p of plan.picks) {
    const row = rowsById.get(p.itemId);
    const base = tillLineBase(row, ctx);
    dropped.push(...base.dropped.map((id) => ({ itemId: row.id, rateId: id })));
    lines.push({
      uid: uid(), itemId: p.itemId, name: p.name,
      ...base.fields,
      price: p.price, qty: 1, mods: p.mods, notes: p.notes, pizzaConfig: null,
      seat: 'shared', status: 'pending',
      comboId, comboRole: 'pick', comboName: p.comboName,
      comboStepId: p.comboStepId, comboStepName: p.comboStepName, comboEntryId: p.comboEntryId,
      comboKeepsPrice: p.comboKeepsPrice, comboBump: p.comboBump,
      ...(p.optionAnswers ? { optionAnswers: p.optionAnswers } : {}),
    });
  }
  return { lines, dropped };
}

/**
 * A pick line after its own options (or its size) were changed on the order panel.
 *   line     the pick line as it is       target   the row now sold (the product, or the size picked)
 *   mods     the new options              notes    the new note (it replaces the old one)
 *   answers  the option flow's own record of the answers
 *   priceOf  (row) => the product's own price for this order type and menu
 * The price is worked out again from the line's own rule: 0.00 or its own price, its bump, its options.
 * Its course, seat and status stay as they are. Returns null when the line is not a pick.
 */
export function changedPickLine({ line, target, mods = [], notes = '', answers = null, priceOf = () => 0, menuItems = [], menuCategories = [], taxRates = [] } = {}) {
  if (!isComboPick(line) || !target) return null;
  const rowsById = new Map(listOf(menuItems).filter(Boolean).map((r) => [r.id, r]));
  const extras = cents(listOf(mods).reduce((s, m) => s + (Number(m?.price) || 0), 0));
  const price = cents((line.comboKeepsPrice ? cents(priceOf(target)) : 0) + (Number(line.comboBump) || 0) + extras);
  const moved = target.id !== line.itemId;
  const base = moved ? tillLineBase(target, { menuItems, menuCategories, taxRates }).fields : {};
  // A new size keeps the course and fired state the line already has (staff may have moved it).
  const { course: _c, fired: _f, ...fresh } = base;
  const next = { ...line, ...fresh, itemId: target.id, name: pickLineName(target, rowsById), mods: listOf(mods), notes: String(notes || '').trim(), price };
  if (answers) next.optionAnswers = answers; else delete next.optionAnswers;
  return next;
}

/**
 * A pick line repriced for a new order type (store.setOrderType). A pick that is part of the set
 * price stays 0.00 plus its bump and options, whatever the order type; a pick that keeps its price
 * takes the product's price for the new order type, as any line does.
 */
export function repricedPickLine(line, row, priceOf) {
  if (!isComboPick(line)) return line;
  const extras = listOf(line.mods).reduce((s, m) => s + (Number(m?.price) || 0), 0);
  const own = line.comboKeepsPrice ? (row ? Number(priceOf(row)) : null) : 0;
  if (own == null || !Number.isFinite(own)) return line;                    // its row is gone: leave the line as it is
  const price = cents(own + (Number(line.comboBump) || 0) + extras);
  return price === line.price ? line : { ...line, price };
}

// ── A product's own options ──────────────────────────────────────────────────

const modGroupsOf = (row, defs) => {
  const out = [];
  for (const a of listOf(row?.assignedModifierGroups ?? row?.assigned_modifier_groups)) {
    const def = listOf(defs).find((d) => d && d.id === assignmentGroupId(a));
    if (def) out.push({ required: modifierGroupRequired(def) });
  }
  for (const g of listOf(row?.modifierGroups)) if (listOf(g?.options).length) out.push({ required: !!g.required || (Number(g.min) || 0) > 0 });
  return out;
};
const instGroupsOf = (row, defs) => {
  const out = [];
  for (const raw of listOf(row?.assignedInstructionGroups ?? row?.assigned_instruction_groups)) {
    const a = typeof raw === 'string' ? { groupId: raw } : raw;
    const def = listOf(defs).find((d) => d && d.id === a?.groupId);
    if (def) out.push({ required: !!def.required || instructionGroupMin(a, def) > 0 });
  }
  return out;
};

/**
 * What the POS option flow would ask for this row: { hasOptions, requiresAnswers }.
 *   hasOptions       it has sizes, or any option or instruction group (so "Change" has something to open)
 *   requiresAnswers  a size must be picked, or a group must be answered, before it can be sold
 * A size uses its own groups, and its product's only when it has none of that kind (rule 2).
 * modifierGroupDefs are the groups as the POS shows them (options hidden on the POS already taken out).
 */
export function optionFacts(row, { menuItems = [], modifierGroupDefs = [], instructionGroupDefs = [] } = {}) {
  if (!row) return { hasOptions: false, requiresAnswers: false };
  const rows = listOf(menuItems);
  const sizes = rows.filter((r) => r && !r.archived && parentIdOf(r) === row.id);
  const parent = parentIdOf(row) ? rows.find((r) => r && r.id === parentIdOf(row)) : null;
  const mods = sizeOrMainOptions(modGroupsOf(row, modifierGroupDefs), parent ? modGroupsOf(parent, modifierGroupDefs) : []);
  const inst = sizeOrMainOptions(instGroupsOf(row, instructionGroupDefs), parent ? instGroupsOf(parent, instructionGroupDefs) : []);
  // A product with sizes: the size is asked first (each size then brings its own groups).
  return {
    hasOptions: sizes.length > 0 || mods.length > 0 || inst.length > 0,
    requiresAnswers: sizes.length > 0 || mods.some((g) => g.required) || inst.some((g) => g.required),
  };
}

/** The step a pick line came from, or null when the Combo no longer has it. */
export function stepOfLine(line, item) {
  return comboSteps(item).find((s) => s.id === line?.comboStepId) || null;
}

/** What a pick line's rule adds before its options, for the screen: 'Included', '+2.50' or its own price. */
export function pickBaseOf(line, item, ownPrice = 0) {
  const step = stepOfLine(line, item);
  if (!step) return { base: line?.comboKeepsPrice ? cents(ownPrice) : 0, bump: cents(line?.comboBump) };
  const p = pickPrice({ step, entryId: line.comboEntryId, mods: [], ownPrice });
  return { base: p.base, bump: p.bump };
}

// ── What the POS knows right now ─────────────────────────────────────────────

/**
 * The context lib/combo.js reads on the POS (what can be picked right now), built from the store's
 * own state so the Combo screen and the store's final check can never disagree.
 *   orderType   the order type the Combo is sold on ('dine-in' on a table, whatever the POS says)
 *   giveBack    Map(id -> units) to count as still free: the units a Combo already on the order
 *               holds, when that Combo is being changed
 * 86, daily counts and Sold as are the POS's own rules; a product head office hides on the POS
 * (its Shows on list) is left out, as an option linked to it would be.
 */
export function comboPosContext({ item = null, menuItems = [], eightySixIds = [], dailyCounts = {}, orderType = null, modifierGroupDefs = [], instructionGroupDefs = [], giveBack = null } = {}) {
  const rows = listOf(menuItems).filter(Boolean);
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map();
  for (const r of rows) {
    const pid = parentIdOf(r);
    if (pid == null || r.archived) continue;
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(r);
  }
  for (const list of kids.values()) list.sort(compareMenuItems);
  const defs = groupsShownOn(listOf(modifierGroupDefs), rowsById, 'pos');
  const facts = new Map();
  const factsOf = (row) => {
    if (!row) return { hasOptions: false, requiresAnswers: false };
    if (!facts.has(row.id)) facts.set(row.id, optionFacts(row, { menuItems: rows, modifierGroupDefs: defs, instructionGroupDefs }));
    return facts.get(row.id);
  };
  const back = giveBack instanceof Map ? giveBack : new Map();
  return {
    comboId: item?.id ?? null,
    rowsById,
    sizesOf: (id) => kids.get(id) || [],
    eightySix: new Set(listOf(eightySixIds)),
    remainingOf: (id) => {
      const c = dailyCounts ? dailyCounts[id] : null;
      if (!c || typeof c.remaining !== 'number') return null;
      return c.remaining + (back.get(id) || 0);
    },
    soldAs: (row) => isSoldAs(row, orderType, rowsById),
    notSoldWords: (row) => notSoldAsWords(row, orderType),
    hiddenHere: (row) => optionHiddenOn(row, 'pos'),
    requiresAnswers: (row) => factsOf(row).requiresAnswers,
    hasOptions: (row) => factsOf(row).hasOptions,
  };
}
