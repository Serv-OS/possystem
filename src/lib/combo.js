// src/lib/combo.js
//
// COMBO PRODUCTS: ONE PRODUCT AT A SET PRICE, BUILT FROM REAL PRODUCTS (5.12.123, stage 1).
//
// Peter, 27 Nov 2026 (Mozz, the Toast catering "Build Your Own Package", 149.00: pick 5 pizzas,
// 2 breads, 1 to 4 sides): "composite product - Step 1 - name = Pic a product add the products for
// this step set rules around it like you can anyway with modifers same logic etc. But we would need
// to say - keeps price or is part of set price", and "we need this to go to the KDS and kitchen
// correctly not as sub items but as normal order where the products just show without the master
// product", and "this all needs to link correctly to the GP stock etc throguh the enitre system".
//
// THE MODEL (the one booking packages already use, lib/bookings/packagePricing.js):
//   * A product of type 'combo' holds ordered STEPS in menu_items.combo (jsonb):
//       { v: 1, steps: [{ id, name, selectionType, min, max, pricing, products: [{ itemId, bump }] }] }
//     selectionType is one of the three kinds of choice an option group has (lib/choiceKinds.js):
//     'single', 'multiple' (with 'multiple_once' for "each only once") and 'quantity'.
//     pricing is 'set' (part of the set price) or 'own' (the pick keeps its own price).
//   * The Combo's own price is the set price. A Combo with NO steps is exactly the product it
//     always was (a chip on a product with option groups): nothing here touches it.
//   * On an order a finished Combo is ONE line that carries the set price and never reaches the
//     kitchen (noKitchen), plus ONE REAL line per pick: the picked product's own id, options,
//     course, kitchen routing and stock. Every line of one Combo shares a comboId.
//   * A pick is 0.00, or its price bump, or its own price where the step keeps prices. A pick's own
//     options are the product's real ones and charge on top. The Combo cannot switch them off.
//   * The Combo moves as one: void, remove, discount, seat, split and refund act on every line of
//     it. A pick is never voided, discounted, moved or paid on its own.
//
// PURE: NO IMPORTS. The Back Office, the POS, the store, the receipt builders and the tests all
// read these rules; the screens that have not learned Combos yet ask comboPosOnly().

// ── 1. THE SHAPE ─────────────────────────────────────────────────────────────

export const COMBO_TYPE = 'combo';
export const COMBO_VERSION = 1;
/** "As many as they like", the same number an option group uses. */
export const UNLIMITED = 99;
export const PRICING_SET = 'set';
export const PRICING_OWN = 'own';
/** The same word lib/choiceKinds.js uses (comboChoiceKinds.test.js pins it). */
export const ONCE_EACH = 'multiple_once';
const KINDS = ['single', 'multiple', ONCE_EACH, 'quantity'];

/** Plain words, the ones the Multi site menu already uses for an option group. */
export const STEP_KIND_WORDS = Object.freeze({
  single: 'One choice', multiple: 'Several choices', [ONCE_EACH]: 'Several choices', quantity: 'Same choice more than once',
});
export const PRICING_WORDS = Object.freeze({ [PRICING_SET]: 'Part of the set price', [PRICING_OWN]: 'Keeps its price' });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const listOf = (v) => (Array.isArray(v) ? v : []);
const whole = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
/** Money to the cent, never minus zero. */
export const cents = (v) => { const n = Math.round((Number(v) || 0) * 100) / 100; return n === 0 ? 0 : n; };
const text = (v) => (v == null ? '' : String(v).trim());
const nameOf = (row) => text(row?.menuName ?? row?.menu_name ?? row?.name) || 'Item';
const parentIdOf = (row) => row?.parentId ?? row?.parent_id ?? null;
/** lib/menuRules.js rule 1, inline so this file stays import free (combo.test.js pins the two agree). */
const optionOnly = (row) => !!row && row.type === 'subitem' && !(row.soldAlone !== undefined ? row.soldAlone : row.sold_alone);

/** One product of a step: { itemId, bump }. A plain id is accepted. Nothing usable gives null. */
function normaliseEntry(raw, keepsPrice) {
  const itemId = text(typeof raw === 'string' || typeof raw === 'number' ? raw : (raw?.itemId ?? raw?.item_id ?? raw?.id));
  if (!itemId) return null;
  const bump = keepsPrice ? 0 : Math.max(0, cents(isObj(raw) ? raw.bump : 0));
  return { itemId, bump };
}

/**
 * One step, always in a shape every screen can trust.
 *   single     up to 1 (exactly 1 when it must be chosen)
 *   quantity   exactly N, the same product can be picked again ("a box of 5")
 *   multiple   between min and max (99 = as many as they like), the same product can be picked again
 *   multiple_once  the same, but each product only once
 */
export function normaliseStep(raw, index = 0) {
  const r = isObj(raw) ? raw : {};
  const kind = KINDS.includes(r.selectionType ?? r.selection_type) ? (r.selectionType ?? r.selection_type) : 'single';
  let min = Math.max(0, whole(r.min));
  let max = Math.max(0, whole(r.max));
  if (kind === 'single') { max = 1; min = min > 0 ? 1 : 0; }
  else if (kind === 'quantity') { max = clamp(max || min || 1, 1, UNLIMITED - 1); min = max; }
  else { max = max >= UNLIMITED ? UNLIMITED : clamp(max || 1, 1, UNLIMITED - 1); min = clamp(min, 0, max >= UNLIMITED ? UNLIMITED - 1 : max); }
  const pricing = r.pricing === PRICING_OWN ? PRICING_OWN : PRICING_SET;
  const seen = new Set();
  const products = [];
  for (const p of listOf(r.products)) {
    const e = normaliseEntry(p, pricing === PRICING_OWN);
    if (!e || seen.has(e.itemId)) continue;
    seen.add(e.itemId);
    products.push(e);
  }
  return { id: text(r.id) || `step-${index + 1}`, name: text(r.name) || `Step ${index + 1}`, selectionType: kind, min, max, pricing, products };
}

/** The steps held in a menu_items.combo value (the jsonb object, or a bare list of steps). */
export function comboStepsOf(value) {
  const raw = Array.isArray(value) ? value : (isObj(value) ? listOf(value.steps) : []);
  const ids = new Set();
  return raw.filter(isObj).map((s, i) => {
    const step = normaliseStep(s, i);
    let id = step.id;
    for (let n = 2; ids.has(id); n++) id = `${step.id}-${n}`;   // two steps never share an id
    ids.add(id);
    return id === step.id ? step : { ...step, id };
  });
}

/** The steps of a product: only a product of type 'combo' has any. */
export function comboSteps(item) {
  if (!item || item.type !== COMBO_TYPE) return [];
  return comboStepsOf(item.combo);
}

/** True for a Combo that is built from steps. False for every other product, a step less Combo included. */
export function comboHasSteps(item) {
  return comboSteps(item).length > 0;
}

/** What is saved in menu_items.combo: the steps, or null when there are none (the column goes back to empty). */
export function comboColumnValue(steps) {
  const clean = comboStepsOf(listOf(steps));
  return clean.length ? { v: COMBO_VERSION, steps: clean } : null;
}

// ── 2. THE RULE OF A STEP, AND ITS WORDS ─────────────────────────────────────

/** { min, max, repeat }: repeat = the same product can be picked more than once. */
export function stepRule(step) {
  const s = normaliseStep(step);
  return { min: s.min, max: s.max, repeat: s.selectionType === 'multiple' || s.selectionType === 'quantity' };
}

/** "Choose exactly 5", "Choose up to 4", "Choose between 1 and 4" (the Multi site menu's words). */
export function ruleWords(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(0, Number(max) || 0);
  if (b >= UNLIMITED && a === 0) return 'Choose as many as they like';
  if (b >= UNLIMITED) return `Choose at least ${a}`;
  if (a === b) return `Choose exactly ${a}`;
  if (a === 0) return `Choose up to ${b}`;
  return `Choose between ${a} and ${b}`;
}

/** The sentence under a step in the Back Office: the rule, whether it can be skipped, and repeats. */
export function stepSentence(step) {
  const s = normaliseStep(step);
  const r = stepRule(s);
  const skip = r.min > 0 ? 'Customers must choose.' : 'Customers can skip it.';
  const again = s.selectionType === 'single' ? '' : r.repeat ? ' The same product can be picked again.' : ' Each product only once.';
  return `${ruleWords(r.min, r.max)}. ${skip}${again}`;
}

/** The form the Steps tab edits (the same form the Multi site menu uses for an option group). */
export function stepForm(step) {
  const s = normaliseStep(step);
  const choice = s.selectionType === ONCE_EACH ? 'multiple' : s.selectionType;
  return { choice, mustChoose: s.min > 0, onceEach: s.selectionType === ONCE_EACH, min: s.min, max: s.max };
}

/** A step with the form's rule on it (always a valid rule, whatever was typed). */
export function stepWithForm(step, form) {
  const f = isObj(form) ? form : {};
  const choice = ['single', 'multiple', 'quantity'].includes(f.choice) ? f.choice : 'single';
  let rule;
  if (choice === 'single') rule = { selectionType: 'single', min: f.mustChoose ? 1 : 0, max: 1 };
  else {
    const max = whole(f.max) >= UNLIMITED ? UNLIMITED : clamp(whole(f.max) || 1, 1, UNLIMITED - 1);
    if (choice === 'quantity') rule = { selectionType: 'quantity', min: Math.min(max, UNLIMITED - 1), max: Math.min(max, UNLIMITED - 1) };
    else rule = { selectionType: f.onceEach ? ONCE_EACH : 'multiple', min: f.mustChoose ? clamp(whole(f.min) || 1, 1, max >= UNLIMITED ? UNLIMITED - 1 : max) : 0, max };
  }
  return normaliseStep({ ...(isObj(step) ? step : {}), ...rule });
}

/** A new empty step: one choice, must be chosen, part of the set price. */
export function newStep(steps, id) {
  const n = listOf(steps).length + 1;
  return normaliseStep({ id: text(id) || `step-${n}`, name: `Step ${n}`, selectionType: 'single', min: 1, max: 1, pricing: PRICING_SET, products: [] }, n - 1);
}

// ── 3. WHICH PRODUCTS A STEP MAY HOLD ────────────────────────────────────────

/**
 * Why this menu row cannot be a product of a step, in words, or null when it can.
 * A step holds products that are sold: a plain product, a product with sizes (the size is then
 * asked at the POS), or one size of a product. Never another Combo, never a sub item that is only
 * an option, never the Combo itself.
 */
export function stepProductBlock(row, { comboId = null } = {}) {
  if (!row) return 'That product is not on the menu any more.';
  if (comboId != null && String(row.id) === String(comboId)) return 'A Combo cannot hold itself.';
  if (row.type === COMBO_TYPE) return 'A Combo cannot go inside another Combo.';
  if (row.type === 'spacer') return 'That is a gap on the POS grid, not a product.';
  if (optionOnly(row)) return 'That is an option only, not a product. Turn on Sold alone to use it in a Combo.';
  if (row.type === 'pizza') return 'A pizza builder product cannot go in a Combo yet.';
  return null;
}

/**
 * Why steps cannot be set up on this product, in words, or null when they can (the Steps tab shows
 * the words instead of the editor). Stage 1: a Combo with steps is one site's own product.
 *   managed   true when the Multi site menu manages the product (head office owns it)
 *   sizes     how many live sizes the product has
 */
export function stepsEditBlock(item, { managed = false, sizes = 0 } = {}) {
  if (!item || item.type !== COMBO_TYPE) return 'Set the type to Combo to give this product steps.';
  if (managed) return 'Head office manages this product in the Multi site menu. A Combo with steps is set up as a site\'s own product for now.';
  const scope = item.scope || 'local';
  if (scope !== 'local' || item.masterId || item.master_id) return 'This product is shared with other sites. A Combo with steps works at one site for now: set Sharing to This site only first.';
  if (parentIdOf(item)) return 'A size cannot be a Combo.';
  if (Number(sizes) > 0) return 'This product has sizes. A Combo with steps has one set price: remove its sizes first.';
  return null;
}

/**
 * What is wrong with a Combo's steps, in words, for the Steps tab.
 *   ctx.rowsById     Map of the venue's menu rows by id
 *   ctx.hiddenHere   (row) => true when head office hides the product on the POS
 *   ctx.eightySix    Set (or list) of 86'd ids
 *   ctx.noPrice      true when the Combo has no price set
 * Returns [{ stepId | null, level: 'stop' | 'note', words }]. 'stop' = the Combo cannot be sold
 * as it is (a step that can never be finished); 'note' = worth knowing.
 */
export function comboWarnings(item, ctx = {}) {
  const steps = comboSteps(item);
  if (!steps.length) return [];
  const rows = ctx.rowsById instanceof Map ? ctx.rowsById : new Map();
  const out = [];
  const off = setOf(ctx.eightySix);
  if (ctx.noPrice) out.push({ stepId: null, level: 'stop', words: 'This Combo has no price. Set its price on Details: that is the set price.' });
  for (const step of steps) {
    const rule = stepRule(step);
    if (!step.products.length) {
      out.push({ stepId: step.id, level: rule.min > 0 ? 'stop' : 'note', words: `"${step.name}" has no products yet.` });
      continue;
    }
    let usable = 0;
    for (const e of step.products) {
      const row = rows.get(e.itemId);
      if (!row) { out.push({ stepId: step.id, level: 'note', words: `A product in "${step.name}" is not on the menu any more. Take it out of the step.` }); continue; }
      const block = stepProductBlock(row, { comboId: item.id });
      if (block) { out.push({ stepId: step.id, level: 'note', words: `${nameOf(row)}: ${block}` }); continue; }
      if (row.archived) { out.push({ stepId: step.id, level: 'note', words: `${nameOf(row)} is archived, so it is not offered.` }); continue; }
      if (typeof ctx.hiddenHere === 'function' && ctx.hiddenHere(row)) { out.push({ stepId: step.id, level: 'note', words: `Head office hides ${nameOf(row)} on the POS, so it is not offered.` }); continue; }
      usable += 1;
      if (off.has(row.id)) out.push({ stepId: step.id, level: 'note', words: `${nameOf(row)} is 86'd right now.` });
    }
    if (rule.min > 0 && usable === 0) out.push({ stepId: step.id, level: 'stop', words: `"${step.name}" must be chosen, but none of its products can be picked.` });
    else if (!rule.repeat && rule.min > usable) out.push({ stepId: step.id, level: 'stop', words: `"${step.name}" asks for ${rule.min}, but only ${usable} product${usable === 1 ? '' : 's'} can be picked, each once.` });
  }
  return out;
}

const setOf = (v) => (v instanceof Set ? v : new Set(listOf(v)));

// ── 4. WHAT CAN BE PICKED RIGHT NOW (the POS, and later every ordering screen) ──

/**
 * The context the ordering rules read. Every part is optional (nothing set = nothing blocks):
 *   rowsById      Map of the venue's menu rows by id
 *   sizesOf       (id) => the live sizes of a product (rows), [] when it has none
 *   eightySix     Set or list of 86'd ids
 *   remainingOf   (id) => how many are left on a daily count, null when not counted
 *   soldAs        (row) => false when the product is not sold on this order type (lib/soldAs.js)
 *   notSoldWords  (row) => the words for that
 *   hiddenHere    (row) => true when head office hides the product on this screen
 *   requiresAnswers (row) => true when the product has a size to pick or an option that must be answered
 */
const rowsOf = (ctx) => (ctx && ctx.rowsById instanceof Map ? ctx.rowsById : new Map());
const sizesFor = (ctx, id) => (ctx && typeof ctx.sizesOf === 'function' ? listOf(ctx.sizesOf(id)) : []);
const remaining = (ctx, id) => {
  if (!ctx || typeof ctx.remainingOf !== 'function') return null;
  const n = ctx.remainingOf(id);
  return n == null || !Number.isFinite(Number(n)) ? null : Number(n);
};

/**
 * How many units of each menu row a set of picks takes off the daily counts: the picked row and its
 * product (a size also counts against its product, as store.decrementDailyCount does), and every
 * option that is linked to a product. A pick whose size is not chosen yet counts against its product.
 * Returns Map(id -> units).
 */
export function unitsUsed(picks, ctx = {}) {
  const rows = rowsOf(ctx);
  const used = new Map();
  const add = (id, n = 1) => {
    if (id == null || !(n > 0)) return;
    used.set(id, (used.get(id) || 0) + n);
    const p = parentIdOf(rows.get(id));
    if (p != null) used.set(p, (used.get(p) || 0) + n);
  };
  for (const p of listOf(picks)) {
    if (!p) continue;
    add(p.itemId ?? p.entryId);
    for (const m of listOf(p.mods)) if (m && m.itemId) add(m.itemId, Number(m.qty) > 0 ? Number(m.qty) : 1);
  }
  return used;
}

/** Units of one row still free once `used` is taken off its own count and its product's. Infinity = not counted. */
function unitsLeft(id, ctx, used) {
  const rows = rowsOf(ctx);
  let left = Infinity;
  for (const k of [id, parentIdOf(rows.get(id))]) {
    if (k == null) continue;
    const r = remaining(ctx, k);
    if (r != null) left = Math.min(left, r - (used.get(k) || 0));
  }
  return left;
}

/**
 * One product of a step as the ordering screen shows it.
 *   state  'gone'    not on the menu, archived, or not a product a step may hold: never shown
 *          'hidden'  head office hides it on this screen: never shown
 *          'out'     86'd or none left: greyed, with the words
 *          'type'    not sold on this order type: greyed, with the words
 *          'ok'      can be picked
 *   left   how many more can be picked (Infinity when nothing counts it)
 *   sizes  the sizes that can still be picked (a product with sizes), else []
 */
export function entryState(entry, ctx = {}, picks = []) {
  const rows = rowsOf(ctx);
  const row = rows.get(entry?.itemId) || null;
  if (!row || row.archived || stepProductBlock(row, { comboId: ctx.comboId ?? null })) return { row, state: 'gone', words: '', left: 0, sizes: [] };
  if (typeof ctx.hiddenHere === 'function' && ctx.hiddenHere(row)) return { row, state: 'hidden', words: '', left: 0, sizes: [] };
  const off = setOf(ctx.eightySix);
  const used = unitsUsed(picks, ctx);
  const parent = rows.get(parentIdOf(row)) || null;
  const sold = (r) => (typeof ctx.soldAs === 'function' ? ctx.soldAs(r) !== false : true);
  const wordsNotSold = (r) => (typeof ctx.notSoldWords === 'function' ? ctx.notSoldWords(r) : 'Not available for this order type');
  if (!sold(row)) return { row, state: 'type', words: wordsNotSold(row), left: 0, sizes: [] };
  if (off.has(row.id) || (parent && off.has(parent.id))) return { row, state: 'out', words: "86'd", left: 0, sizes: [] };
  const allSizes = sizesFor(ctx, row.id).filter((s) => s && !s.archived);
  if (allSizes.length) {
    const own = unitsLeft(row.id, ctx, used);          // the product's own count, sizes or not
    const open = allSizes.filter((s) => !off.has(s.id) && sold(s) && Math.min(own, unitsLeft(s.id, ctx, used)) >= 1);
    if (!open.length) {
      const anySold = allSizes.some((s) => sold(s));
      return { row, state: anySold ? 'out' : 'type', words: anySold ? 'Sold out' : wordsNotSold(row), left: 0, sizes: [] };
    }
    const left = Math.min(own, open.reduce((m, s) => Math.max(m, unitsLeft(s.id, ctx, used)), 0));
    return { row, state: 'ok', words: Number.isFinite(left) && left <= 3 ? `${left} left` : '', left, sizes: open };
  }
  const left = unitsLeft(row.id, ctx, used);
  if (left < 1) return { row, state: 'out', words: 'Sold out', left: 0, sizes: [] };
  return { row, state: 'ok', words: Number.isFinite(left) && left <= 3 ? `${left} left` : '', left, sizes: [] };
}

/** The products of a step that are shown on the ordering screen (never the 'gone' or 'hidden' ones). */
export function stepEntries(step, ctx = {}, picks = []) {
  return normaliseStep(step).products
    .map((entry) => ({ entry, ...entryState(entry, ctx, picks) }))
    .filter((e) => e.state !== 'gone' && e.state !== 'hidden');
}

// ── 5. PICKS ─────────────────────────────────────────────────────────────────
//
// A pick is ONE unit of one product in one step (Margherita twice is two picks, each changed on
// its own):
//   { key, stepId, entryId, itemId, mods, notes, answers, configured }
//     entryId     the product the step lists
//     itemId      the row that is sold: entryId, or the size picked (null until a size is picked)
//     mods        the product's own options, as the POS option flow builds them
//     answers     the option flow's own record of the answers, so Change opens with them (lib/optionAnswers.js)
//     configured  the option flow has been confirmed for this pick

export const picksOfStep = (picks, stepId) => listOf(picks).filter((p) => p && p.stepId === stepId);

/** Where a step stands: { count, min, max, need, room, done, full }. */
export function stepStatus(step, picks) {
  const r = stepRule(step);
  const count = picksOfStep(picks, normaliseStep(step).id).length;
  return { count, min: r.min, max: r.max, need: Math.max(0, r.min - count), room: r.max >= UNLIMITED ? Infinity : Math.max(0, r.max - count), done: count >= r.min && (r.max >= UNLIMITED || count <= r.max), full: r.max < UNLIMITED && count >= r.max };
}

/** What a step still needs, in words: "Pick 2 more", "Pick 1", "Optional", "Done". */
export function stepNeedWords(step, picks) {
  const s = stepStatus(step, picks);
  if (s.need > 0) {
    if (s.count > 0) return `Pick ${s.need} more`;
    return s.min === s.max ? `Pick ${s.min}` : `Pick at least ${s.min}`;
  }
  if (s.full) return 'Done';
  if (s.count === 0) return s.max >= UNLIMITED ? 'Optional' : `Optional, up to ${s.max}`;
  return s.max >= UNLIMITED ? 'Add more if you like' : `Up to ${s.max - s.count} more`;
}

/** "3 of 5", "2 picked", "0 of 1": the count against the rule. */
export function stepCountWords(step, picks) {
  const s = stepStatus(step, picks);
  if (s.max >= UNLIMITED) return `${s.count} picked`;
  return `${s.count} of ${s.max}`;
}

/** Can one more of this product be picked in this step? (room in the rule, and "each only once"). */
export function canPick(step, picks, entryId) {
  const s = normaliseStep(step);
  const st = stepStatus(s, picks);
  const r = stepRule(s);
  if (s.selectionType === 'single') return true;                       // a tap swaps the choice
  if (st.room < 1) return false;
  if (!r.repeat && picksOfStep(picks, s.id).some((p) => p.entryId === entryId)) return false;
  return true;
}

/**
 * The picks after one tap on a product of a step.
 *   single         the tapped product replaces the choice; tapping the chosen one takes it off (when it can be skipped)
 *   each only once a second tap takes it off
 *   otherwise      a tap adds one more (the screen has its own minus)
 * newPick(entryId) makes the pick (the screen stamps the key). Returns the same list when nothing can change.
 */
export function tapEntry(step, picks, entryId, newPick) {
  const s = normaliseStep(step);
  const list = listOf(picks);
  const mine = picksOfStep(list, s.id);
  const has = mine.filter((p) => p.entryId === entryId);
  const r = stepRule(s);
  if (s.selectionType === 'single') {
    if (has.length) return r.min > 0 ? list : list.filter((p) => !mine.includes(p));
    return [...list.filter((p) => !mine.includes(p)), newPick(entryId)];
  }
  if (!r.repeat && has.length) return list.filter((p) => p !== has[0]);
  if (!canPick(s, list, entryId)) return list;
  return [...list, newPick(entryId)];
}

/** The picks with the LAST pick of this product in this step taken off (the minus on a tile). */
export function untapEntry(step, picks, entryId) {
  const s = normaliseStep(step);
  const list = listOf(picks);
  const has = picksOfStep(list, s.id).filter((p) => p.entryId === entryId);
  if (!has.length) return list;
  const last = has[has.length - 1];
  return list.filter((p) => p !== last);
}

/**
 * The picks a step makes by itself, or null when there is a choice to make. A step fills itself
 * when its answer is fixed: it asks for an exact number and
 *   * only one product can be picked (and it may repeat, or the number is 1), or
 *   * each product is picked once and the number is exactly how many there are.
 * Returns the entry ids to pick, in order. It is how the step is SET UP that makes it fixed, never
 * what happens to be sold out: a step of two products does not turn into "no choice" because one
 * ran out (comboUnsellable and comboMissing say when a fixed pick cannot be made).
 */
export function fixedAnswer(step, ctx = {}) {
  const s = normaliseStep(step);
  const r = stepRule(s);
  if (r.min !== r.max || r.max >= UNLIMITED || r.max < 1) return null;
  const shown = stepEntries(s, ctx, []);
  if (shown.length === 1 && (r.repeat || r.max === 1)) return Array.from({ length: r.max }, () => shown[0].entry.itemId);
  if (!r.repeat && s.selectionType !== 'single' && shown.length === r.max) return shown.map((e) => e.entry.itemId);
  return null;
}

/** True when every step fills itself: nothing to choose, so the Combo adds in one tap. */
export function comboIsFixed(steps, ctx = {}) {
  const list = comboStepsOf(listOf(steps));
  return list.length > 0 && list.every((s) => fixedAnswer(s, ctx) !== null);
}

/** The picks a Combo starts with: every step that fills itself, filled. newPick(stepId, entryId) makes each. */
export function startingPicks(steps, ctx, newPick) {
  const out = [];
  for (const s of comboStepsOf(listOf(steps))) {
    const fixed = fixedAnswer(s, ctx);
    if (fixed) for (const entryId of fixed) out.push(newPick(s.id, entryId));
  }
  return out;
}

/**
 * What a pick still needs before the Combo can be added: 'size' (its product has sizes and none is
 * picked), 'options' (its product has an option that must be answered and the option flow has not
 * been confirmed), or null. ctx.requiresAnswers(row) says whether the row has such an option.
 */
export function pickNeeds(pick, ctx = {}) {
  if (!pick) return null;
  const sizes = sizesFor(ctx, pick.entryId);
  const sized = sizes.length > 0;
  if (sized && !sizes.some((s) => s && s.id === pick.itemId)) return 'size';
  if (pick.configured) return null;
  const row = rowsOf(ctx).get(pick.itemId ?? pick.entryId);
  return row && typeof ctx.requiresAnswers === 'function' && ctx.requiresAnswers(row) ? 'options' : null;
}

// ── 6. MONEY ─────────────────────────────────────────────────────────────────

const modsTotal = (mods) => listOf(mods).reduce((s, m) => s + (Number(m?.price) || 0), 0);

/**
 * What one pick costs: { base, bump, extras, total }.
 *   base    0.00 where the step is part of the set price; the product's own price where it keeps it
 *   bump    the step's price bump for this product (never on a step that keeps prices)
 *   extras  the pick's own options, priced as the product prices them
 * ownPrice is the product's own price for this order type and menu (the caller resolves it: the
 * size's price when a size is picked).
 */
export function pickPrice({ step, entryId, mods = [], ownPrice = 0 } = {}) {
  const s = normaliseStep(step);
  const entry = s.products.find((p) => p.itemId === entryId) || { bump: 0 };
  const keeps = s.pricing === PRICING_OWN;
  const base = keeps ? cents(ownPrice) : 0;
  const bump = keeps ? 0 : cents(entry.bump);
  const extras = cents(modsTotal(mods));
  return { base, bump, extras, total: cents(base + bump + extras) };
}

/**
 * Everything a Combo's picks add on top of the set price, and the whole Combo.
 *   priceOf(row) the product's own price for this order type and menu
 * Returns { setPrice, extras, total }.
 */
export function comboTotal({ setPrice = 0, steps = [], picks = [], rowsById = new Map(), priceOf = () => 0 } = {}) {
  const byId = new Map(comboStepsOf(listOf(steps)).map((s) => [s.id, s]));
  let extras = 0;
  for (const p of listOf(picks)) {
    const step = p && byId.get(p.stepId);
    if (!step) continue;
    const row = rowsById.get(p.itemId ?? p.entryId);
    extras += pickPrice({ step, entryId: p.entryId, mods: p.mods, ownPrice: row ? priceOf(row) : 0 }).total;
  }
  return { setPrice: cents(setPrice), extras: cents(extras), total: cents(Number(setPrice || 0) + extras) };
}

// ── 7. CAN IT BE ADDED? ──────────────────────────────────────────────────────

/**
 * What stops a set of picks being added, in words (the first thing only), or null when it is ready.
 * Checks every step's rule, every pick's size and required options, and the daily counts across all
 * the picks together (two of the last pizza, or an option that is linked to a product with 1 left).
 */
export function comboMissing(steps, picks, ctx = {}) {
  const list = comboStepsOf(listOf(steps));
  if (!list.length) return null;
  const rows = rowsOf(ctx);
  for (const s of list) {
    const st = stepStatus(s, picks);
    if (st.need > 0) return `${s.name}: ${stepNeedWords(s, picks).toLowerCase()}`;
    if (!st.done) return `${s.name}: too many picked`;
  }
  const stepById = new Map(list.map((s) => [s.id, s]));
  for (const p of listOf(picks)) {
    const step = p && stepById.get(p.stepId);
    if (!step) continue;                                                    // not a pick of this Combo: it makes no line
    const entry = step.products.find((e) => e.itemId === p.entryId);
    const entryRow = rows.get(p.entryId);
    // The menu moved under the screen: the product left the step, was archived or is hidden here.
    if (!entry || !entryRow) return `${nameOf(entryRow)} cannot be picked in "${step.name}" any more`;
    const st = entryState(entry, ctx, []);
    if (st.state === 'gone' || st.state === 'hidden') return `${nameOf(entryRow)} cannot be picked any more`;
    if (st.state === 'type') return st.words;
    const needs = pickNeeds(p, ctx);
    const row = rows.get(p.itemId ?? p.entryId) || entryRow;
    if (needs === 'size') return `${nameOf(row)}: choose a size`;
    if (needs === 'options') return `${nameOf(row)}: choose its options`;
    if (row !== entryRow) {
      if (row.archived) return `${pickLineName(row, rows)} cannot be picked any more`;
      if (typeof ctx.soldAs === 'function' && ctx.soldAs(row) === false) return typeof ctx.notSoldWords === 'function' ? ctx.notSoldWords(row) : `${pickLineName(row, rows)} is not available for this order type`;
    }
  }
  const off = setOf(ctx.eightySix);
  for (const [id, units] of unitsUsed(picks, ctx)) {
    const row = rows.get(id);
    if (off.has(id)) return `${nameOf(row)} is 86'd`;
    const r = remaining(ctx, id);
    if (r != null && units > r) return r <= 0 ? `${nameOf(row)} is sold out` : `Only ${r} × ${nameOf(row)} left`;
  }
  return null;
}

/**
 * Why a Combo cannot be sold at all right now, in words, or null when it can be opened: a step that
 * must be chosen has nothing left to pick, or not enough.
 */
export function comboUnsellable(item, ctx = {}) {
  for (const s of comboSteps(item)) {
    const r = stepRule(s);
    if (r.min < 1) continue;
    const open = stepEntries(s, { ...ctx, comboId: item.id }, []).filter((e) => e.state === 'ok');
    if (!open.length) return `${nameOf(item)} cannot be made right now: nothing can be picked for "${s.name}".`;
    const room = r.repeat ? open.reduce((n, e) => n + e.left, 0) : open.length;
    if (room < r.min) return `${nameOf(item)} cannot be made right now: "${s.name}" needs ${r.min} and only ${room} can be picked.`;
  }
  return null;
}

// ── 8. THE LINES A FINISHED COMBO BECOMES ────────────────────────────────────

/** "Margherita", or "Margherita — Large" for a size (the POS's own way of naming a size line). */
export function pickLineName(row, rowsById = new Map()) {
  const parent = rowsById.get(parentIdOf(row));
  return parent ? `${nameOf(parent)} — ${nameOf(row)}` : nameOf(row);
}

/**
 * The lines of one finished Combo, as plain data (the store adds the fields every POS line has:
 * tax, category, course, kitchen names).
 *   item       the Combo product          comboId   this Combo's own id on the order
 *   setPrice   the Combo's price for this order type and menu
 *   priceOf    (row) => the product's own price for this order type and menu
 * Returns { parent, picks }:
 *   parent  { comboRole: 'parent', comboId, itemId, name, price, noKitchen: true }
 *   picks   [{ comboRole: 'pick', comboId, comboName, comboStepId, comboStepName, comboEntryId,
 *              comboKeepsPrice, comboBump, itemId, name, price, mods, notes, optionAnswers }]
 * in step order, then in the order they were picked. A pick with no row or no step is left out.
 */
export function comboLinePlan({ item, comboId, setPrice = 0, steps = null, picks = [], rowsById = new Map(), priceOf = () => 0 } = {}) {
  const list = steps ? comboStepsOf(listOf(steps)) : comboSteps(item);
  const name = nameOf(item);
  const parent = { comboRole: 'parent', comboId, itemId: item?.id ?? null, name, price: cents(setPrice), noKitchen: true };
  const out = [];
  for (const step of list) {
    for (const p of picksOfStep(picks, step.id)) {
      const row = rowsById.get(p.itemId ?? p.entryId);
      if (!row) continue;
      const mods = listOf(p.mods);
      const price = pickPrice({ step, entryId: p.entryId, mods, ownPrice: priceOf(row) });
      out.push({
        comboRole: 'pick', comboId, comboName: name,
        comboStepId: step.id, comboStepName: step.name, comboEntryId: p.entryId,
        comboKeepsPrice: step.pricing === PRICING_OWN, comboBump: price.bump,
        itemId: row.id, name: pickLineName(row, rowsById), price: price.total,
        mods, notes: text(p.notes), ...(p.answers ? { optionAnswers: p.answers } : {}),
      });
    }
  }
  return { parent, picks: out };
}

/** The picks of a Combo already on an order, read back from its lines (to change it, or to add it again). */
export function picksFromLines(lines, keyOf = (l, i) => l.uid || `pick-${i}`) {
  return listOf(lines).filter(isComboPick).filter((l) => !l.voided).map((l, i) => ({
    key: keyOf(l, i), stepId: l.comboStepId, entryId: l.comboEntryId ?? l.itemId, itemId: l.itemId,
    mods: listOf(l.mods), notes: l.notes || '', answers: l.optionAnswers || null, configured: true,
  }));
}

// ── 9. A COMBO ON AN ORDER: ONE GROUP OF LINES ───────────────────────────────

export const comboIdOf = (line) => (line && line.comboId) || null;
export const isComboLine = (line) => !!comboIdOf(line);
export function isComboParent(line) { return !!line && !!line.comboId && line.comboRole === 'parent'; }
export function isComboPick(line) { return !!line && !!line.comboId && line.comboRole === 'pick'; }

/** Every line of the Combo a line belongs to (the line alone when it is not in one). */
export function comboLinesOf(items, line) {
  const id = comboIdOf(line);
  if (!id) return line ? [line] : [];
  return listOf(items).filter((i) => i && i.comboId === id);
}

/** The uids that move together with this uid: the whole Combo, or just the line. */
export function comboUids(items, uid) {
  const line = listOf(items).find((i) => i && i.uid === uid);
  if (!line) return [];
  return comboLinesOf(items, line).map((i) => i.uid);
}

/** Has any live line of this Combo gone to the kitchen? Then the Combo is voided, never removed. */
export function comboIsSent(items, comboId) {
  return listOf(items).some((i) => i && i.comboId === comboId && !i.voided && i.status === 'sent');
}

/** What the whole Combo comes to: its set price plus everything its picks add (voided lines left out). */
export function comboLinesTotal(lines) {
  return cents(listOf(lines).filter((l) => l && !l.voided).reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 1), 0));
}

/**
 * An order's lines as the screen and the receipt show them: a Combo is ONE block (its line, then
 * its picks under it), every other line is itself. In the order the lines were added.
 * Returns [{ kind: 'line', line } | { kind: 'combo', comboId, parent, picks, total, sent, voided }].
 * Picks whose Combo line is missing (it never should be) show as ordinary lines.
 */
export function orderBlocks(items) {
  const list = listOf(items).filter(Boolean);
  const parents = new Map(list.filter(isComboParent).map((l) => [l.comboId, l]));
  const out = [];
  const at = new Map();
  for (const line of list) {
    const id = comboIdOf(line);
    if (!id || !parents.has(id)) { out.push({ kind: 'line', line }); continue; }
    if (!at.has(id)) {
      at.set(id, out.length);
      out.push({ kind: 'combo', comboId: id, parent: parents.get(id), picks: [], total: 0, sent: false, voided: false });
    }
    if (isComboPick(line)) out[at.get(id)].picks.push(line);
  }
  for (const b of out) {
    if (b.kind !== 'combo') continue;
    const all = [b.parent, ...b.picks];
    b.total = comboLinesTotal(all);
    b.sent = all.some((l) => !l.voided && l.status === 'sent');
    b.voided = all.every((l) => l.voided || l.status === 'voided');
  }
  return out;
}

/**
 * A list of line selections (uids) made whole: any Combo that is partly in it is taken in full, or
 * left out in full. Used by the screens that let staff pick lines (split by item, refund, discount).
 *   mode 'add'    a Combo with any line picked is picked whole
 *   mode 'drop'   a Combo with any line NOT picked is dropped whole
 */
export function wholeCombos(items, uids, mode = 'add') {
  const list = listOf(items).filter(Boolean);
  const picked = new Set(listOf(uids));
  const groups = new Map();
  for (const l of list) if (l.comboId) { if (!groups.has(l.comboId)) groups.set(l.comboId, []); groups.get(l.comboId).push(l.uid); }
  for (const group of groups.values()) {
    const some = group.some((u) => picked.has(u));
    const every = group.every((u) => picked.has(u));
    if (some && !every) group.forEach((u) => (mode === 'drop' ? picked.delete(u) : picked.add(u)));
  }
  return list.map((l) => l.uid).filter((u) => picked.has(u));
}

/** True when these uids hold only whole Combos (no Combo is cut). The store refuses anything else. */
export function keepsCombosWhole(items, uids) {
  const picked = new Set(listOf(uids));
  const seen = new Map();
  for (const l of listOf(items)) {
    if (!l || !l.comboId) continue;
    const s = seen.get(l.comboId) || { in: 0, out: 0 };
    if (picked.has(l.uid)) s.in += 1; else s.out += 1;
    seen.set(l.comboId, s);
  }
  for (const s of seen.values()) if (s.in > 0 && s.out > 0) return false;
  return true;
}

/**
 * What one line void takes: the line, or the whole Combo it belongs to (its own line and every pick
 * that is still live). Returns { lines, gone, name }: the lines to void, their uids as a Set, and
 * what the toast and the void log call it (the Combo's name, never one pick's).
 */
export function voidGroup(items, item) {
  if (!item) return { lines: [], gone: new Set(), name: '' };
  if (!isComboLine(item)) return { lines: [item], gone: new Set([item.uid]), name: item.name };
  const lines = comboLinesOf(items, item).filter((i) => !i.voided);
  return { lines, gone: new Set(lines.map((i) => i.uid)), name: lines.find(isComboParent)?.name || item.comboName || item.name };
}

/**
 * A discount put on any line of a Combo is a discount on the Combo: a percent comes off EVERY line
 * of it (the set price and everything its picks add); an amount comes off the Combo's own line,
 * once (the same amount on every line would take it off many times over). A pick is never
 * discounted on its own. Returns the order's lines with the discount on. discount null takes it off.
 */
export function comboDiscount(items, target, discount) {
  const group = new Set(comboLinesOf(items, target).map((i) => i.uid));
  const every = !!discount && discount.type === 'percent';
  return listOf(items).map((i) => {
    if (!i || !group.has(i.uid)) return i;
    return { ...i, discount: discount && (every || isComboParent(i)) ? discount : null };
  });
}

/**
 * The lines a "Clear" of the unsent draft takes: every pending line that is not voided, EXCEPT the
 * unsent lines of a Combo that already has a line at the kitchen (a Combo is voided as one, never
 * half cleared). Returns a predicate over a line.
 */
export function draftLineTest(items) {
  const list = listOf(items);
  return (i) => !!i && i.status === 'pending' && !i.voided && !(i.comboId && comboIsSent(list, i.comboId));
}

// ── 10. WORDS ────────────────────────────────────────────────────────────────

export const COMBO_WORDS = Object.freeze({
  posOnly: 'A Combo with steps is sold on the POS only for now.',
  qty: 'A Combo is rung up one at a time. Add it again for another one.',
  asOne: 'A Combo is voided, discounted, moved and paid as one.',
  refundWhole: 'A Combo is refunded whole: its price and everything picked in it.',
  sentChange: 'This Combo has gone to the kitchen. Void it and ring it up again to change it.',
  noOwnOptions: 'A Combo with steps asks no options of its own: its line never reaches the kitchen. Each product in a step asks its own.',
  share: 'A Combo with steps stays at this site for now, so it was not shared. Combos come to the Multi site menu in a later update.',
  needsUpdate: 'Steps need one database update that has not been run yet (SQL 20261215a). Nothing can be saved until then. Ask ServOS to run it.',
});

/** "Build Your Own Package is a Combo with choices. Ring it up on the POS." */
export function comboNotHereWords(item) {
  return `${nameOf(item)} is a Combo with choices. Ring it up on the POS.`;
}

// ── 11. SCREENS THAT HAVE NOT LEARNED COMBOS YET ─────────────────────────────

/**
 * True for a product only the POS can sell for now: a Combo with steps. The kiosk, online, QR, the
 * catering page, the phone POS, the bar screen, the delivery catalogue and the assistant all leave
 * it out or refuse it (comboSurfaces.test.js). A Combo with no steps is never held back.
 */
export function comboPosOnly(item) {
  return comboHasSteps(item);
}
