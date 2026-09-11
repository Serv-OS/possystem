// guestChoicePricing.js — the guest booking page's pre-order choice helpers.
//
// 10 Sep 2026 (review). These used to live inside BookingWidget.jsx, where
// node:test could not reach them, so a change to how the page prices a size
// could make the "Extra, paid at the table" line differ from what the till
// charges with no test failing. Pure: no React, no I/O.
//
// Guest page only. The server rules (what is kept, what it costs) live in
// preorderChoices.js, which has a Deno copy; this file does not.
//
// A pick is { name, itemId, mods, variantItemId, variantName, notes } and is
// compared on name. menu is the page's loaded venue menu:
//   { status: 'off'|'loading'|'failed'|'ready', items, instGroupDefs, groupMin }

import { packageLinePrice } from './packagePricing.js';
import { resolveItemPrice, variantChildren, variantFromPrice } from '../menuPricing.js';
import { itemNeedsSheetReturn, choiceConfigured, modsExtra, MAX_CHOICE_NOTE } from './preorderChoices.js';

const round2 = (n) => Math.round(n * 100) / 100;

// A plain chip tap: the dish with nothing chosen on it.
export const plainChoice = (o) => ({
  name: o.name, itemId: o.itemId || null, mods: [], variantItemId: null, variantName: null, notes: '',
});

// A saved pick (preorder_info) back into the page's shape.
export const choiceFromRow = (r) => (r?.name ? {
  name: r.name, itemId: r.itemId || null,
  mods: Array.isArray(r.mods) ? r.mods : [],
  variantItemId: r.variantItemId || null, variantName: r.variantName || null,
  notes: r.notes || '',
} : null);

// One pick as the book and preorder_submit payloads carry it. The course lets
// the server place a dish offered in two courses in the right one.
export const choicePayload = (seat, guestName, course, c) => ({
  seat, guestName, course, name: c.name, itemId: c.itemId || undefined,
  mods: Array.isArray(c.mods) ? c.mods : [],
  variantItemId: c.variantItemId || undefined,
  variantName: c.variantName || undefined,
  notes: c.notes ? String(c.notes).slice(0, MAX_CHOICE_NOTE) : undefined,
});

export const menuRowFor = (menu, itemId) => (itemId && menu?.status === 'ready'
  ? (menu.items || []).find((r) => String(r.id) === String(itemId)) || null
  : null);

// What a size costs RELATIVE to the package line: the till's package rule
// (packageLinePrice) on the storefront's price resolver. A prepay line is
// included whatever the size. A deposit or hold line follows the menu, and a
// dish with sizes is measured from its CHEAPEST live size, because a size
// parent row is never charged itself (its own price is 0). So the smallest size
// is included and a bigger one shows only the difference. Never below 0.
export function choicePriceFor(model, priceOverride, lineRow, rows = []) {
  const override = priceOverride == null || priceOverride === '' ? null : Number(priceOverride);
  const lineOf = (menuPrice) => packageLinePrice(model, override, menuPrice);
  const sized = !!lineRow && variantChildren(lineRow, rows).length > 0;
  const baseMenu = sized
    ? (variantFromPrice(lineRow, rows, 'dineIn') ?? 0)
    : (lineRow ? resolveItemPrice(lineRow, 'dineIn') : 0);
  const base = lineOf(baseMenu);
  return (row) => {
    if (!row) return 0;
    // The parent of a sized dish is shown for a moment before the sheet picks a size.
    if (sized && String(row.id) === String(lineRow.id)) return 0;
    return Math.max(0, round2(lineOf(resolveItemPrice(row, 'dineIn')) - base));
  };
}

// The extra a pick adds on top of the package: its size difference plus its options.
export function choiceExtra(choice, option, menu, model) {
  if (!choice || !option) return 0;
  const lineRow = menuRowFor(menu, option.itemId);
  const sizeRow = choice.variantItemId ? menuRowFor(menu, choice.variantItemId) : null;
  const size = lineRow && sizeRow ? choicePriceFor(model, option.priceOverride, lineRow, menu.items)(sizeRow) : 0;
  return round2(size + modsExtra(choice.mods));
}

// Chosen = a current option and, when the dish needs a size, a required
// instruction (cooking temperature) or a required option, the sheet came back
// with them (or the saved pick already carries them). A menu that is still
// loading or failed to load never blocks the booking: the till's Options badge
// still asks on the night.
export function choiceComplete(choice, options, menu) {
  if (!choice) return false;
  const opt = (options || []).find((o) => o.name === choice.name);
  if (!opt) return false;
  const row = menuRowFor(menu, opt.itemId);
  if (!row) return true;
  if (!itemNeedsSheetReturn(row, menu.items, { groupMin: menu.groupMin, instDefs: menu.instGroupDefs })) return true;
  return choiceConfigured(choice, { item: row, rows: menu.items, instDefs: menu.instGroupDefs });
}
