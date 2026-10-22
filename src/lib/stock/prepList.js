/**
 * stock/prepList.js: the Prep list and the Batch and prep grid rules (multi site stock Drop 2,
 * v5.11.91, design 2.7, map 4.6, mockup scrBatch).
 *
 * PURE: no React, no Supabase, so node --test drives every line (prepList.test.js).
 *
 *   prepRows({ items, schedules, usageByItem, batches, ticks, dow })
 *       the Batches.jsx "needed today" rule (v5.5.931, kept word for word) in the shape the
 *       database's stock_prep_list answers, for the fallback when that function is not there yet
 *   prepFromServer(data)        stock_prep_list's answer as numbers the screen can add up
 *   makeWords(row)              '6 L' to make, or 'covered'
 *   tickWords(tick, unit, tz)   'Done 6 L by Jane Tester 14:05'
 *   HOW_OPTIONS, howLabel       Bought in, Made here, Made to order (stock_batch_set_how's values)
 *   isHoldingRefusal(error)     the 55000 "still holds" refusal that opens the Not yet modal
 *   applyHow(rows, ...)         a saved choice written into the grid's rows
 *
 * Nothing here moves a stock number: a tick is a record of who made what, never an on hand.
 */

import { fmtVenueTime } from '../venueDate.js';

export const PREP_SUB = "Today's suggested amounts, through recipes, less what is on the shelf. Tick each one done.";
export const PREP_COLUMNS = Object.freeze(['Item', 'On hand', 'Scheduled', 'Expect to use', 'Make', 'Done']);
export const BATCH_TITLE = 'Batch and prep';
export const BATCH_SUB = 'Same editor as dishes, plus yield, shelf life and the made item. Each site chooses how it gets each batch.';
export const BATCH_STRIP = Object.freeze([
  ['Bought in', 'from the central kitchen or a supplier.'],
  ['Made here', 'the kitchen logs each batch.'],
  ['Made to order', 'no logging, the sale takes the raw ingredients off.'],
]);
export const NOT_YET_TITLE = 'Not yet';
export const NOT_YET_NOTE = 'That stock would never come off if sales took the raw ingredients instead.';
export const NOT_USED = 'Not used';

/** The three ways a site gets a batch (stock_batch_set_how p_how), in the grid's order. */
export const HOW_OPTIONS = Object.freeze([
  { value: 'bought', label: 'Bought in' },
  { value: 'batches', label: 'Made here' },
  { value: 'to_order', label: 'Made to order' },
]);
const HOW_LABELS = new Map(HOW_OPTIONS.map((o) => [o.value, o.label]));

/** 'batches' gives 'Made here'; a value ServOS does not know is shown as it is. */
export function howLabel(how) {
  if (how == null || how === '') return '';
  return HOW_LABELS.get(String(how)) || String(how);
}

/** 'Prep list for Northgate'. */
export function prepTitle(siteName) {
  const n = String(siteName || '').trim();
  return n ? `Prep list for ${n}` : 'Prep list';
}

/** One decimal, the way Batches.jsx rounds ('6.5', never '6.499999'). */
export const r1 = (v) => Math.round(Number(v) * 10) / 10;

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The Batches.jsx needed today rule (v5.5.931), kept word for word, in the stock_prep_list shape.
 *
 *   items        the site's stock items (kind, archivedAt, onHand, baseUnit, name, id); only MADE
 *                items that are not archived are listed
 *   schedules    prep_schedule rows active at the site ({ output_item_id, qty, unit, days_of_week })
 *   usageByItem  { [itemId]: [sun .. sat] } weekday usage in the base unit
 *   batches      production_batches rows; a PLANNED one for today that was planned BY HAND (no
 *                schedule_id) counts as planned (a scheduled plan is already in `scheduled`)
 *   ticks        stock_prep_ticks rows ({ output_item_id | recipe_id, qty, done_by_name, done_at })
 *   dow          the venue's weekday today (0 = Sunday)
 *   todayYmd     the venue's day, to pick today's planned batches (optional)
 *
 * horizon: today up to (exclusive) the NEXT scheduled cook day; no schedule = today only.
 * make = max(0, expected - on hand - scheduled - planned). A row is listed when expected > 0 or
 * scheduled > 0 (the Batches rule). Sorted by make, biggest first, then by name.
 */
export function prepRows({ items, schedules, usageByItem, batches, ticks, dow, todayYmd = null } = {}) {
  const profByItem = usageByItem || {};
  const scheds = Array.isArray(schedules) ? schedules : [];
  const made = (Array.isArray(items) ? items : []).filter((i) => i && i.kind === 'MADE' && !i.archivedAt);
  const day = ((num(dow) % 7) + 7) % 7;
  const planned = Array.isArray(batches) ? batches : [];
  const tickList = Array.isArray(ticks) ? ticks : [];
  const out = [];
  for (const item of made) {
    const p = profByItem[item.id];
    const myScheds = scheds.filter((x) => x.output_item_id === item.id);
    const cookDays = new Set(myScheds.flatMap((x) => (Array.isArray(x.days_of_week) && x.days_of_week.length) ? x.days_of_week : [0, 1, 2, 3, 4, 5, 6]));
    // horizon: today up to (exclusive) the NEXT scheduled cook day; no schedule = today only
    let span = 1;
    if (cookDays.size) { for (let d = 1; d <= 7; d++) { if (cookDays.has((day + d) % 7)) { span = d; break; } } }
    let expected = 0;
    if (p) for (let d = 0; d < span; d++) expected += num(p[(day + d) % 7]);
    const scheduled = myScheds.filter((x) => !Array.isArray(x.days_of_week) || !x.days_of_week.length || x.days_of_week.includes(day))
      .reduce((sum, x) => sum + (Number(x.qty) || 0), 0);
    const onHand = Number(item.onHand) || 0;
    const plannedQty = planned
      .filter((b) => b && b.status === 'PLANNED' && (b.outputItemId ?? b.output_item_id) === item.id && !(b.scheduleId ?? b.schedule_id)
        && (!todayYmd || !(b.plannedFor ?? b.planned_for) || (b.plannedFor ?? b.planned_for) === todayYmd))
      .reduce((sum, b) => sum + num(b.plannedQty ?? b.planned_qty), 0);
    const make = Math.max(0, expected - onHand - scheduled - plannedQty);
    const myTicks = tickList.filter((t) => t && (t.output_item_id === item.id || (item.recipeId && t.recipe_id === item.recipeId)));
    const doneQty = myTicks.reduce((sum, t) => sum + num(t.qty), 0);
    if (expected > 0 || scheduled > 0) out.push({
      recipe_id: item.recipeId || null, site_recipe_id: item.siteRecipeId || null, output_item_id: item.id,
      name: item.name, unit: item.baseUnit || '', on_hand: onHand, scheduled, expected, planned: plannedQty, make,
      done_qty: doneQty,
      ticks: myTicks.map((t) => ({ id: t.id ?? null, qty: num(t.qty), by_name: t.by_name ?? t.done_by_name ?? '', at: t.at ?? t.done_at ?? null })),
      horizon: span === 1 ? 'end of today' : DAYS[(day + span) % 7],
    });
  }
  out.sort((a, b) => (b.make - a.make) || String(a.name || '').localeCompare(String(b.name || ''), 'en-GB', { numeric: true, sensitivity: 'base' }));
  return out;
}

/** stock_prep_list's answer, every figure a number, ticks a list: { business_day, rows }. */
export function prepFromServer(data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return {
    business_day: data?.business_day || null,
    rows: rows.map((r) => ({
      recipe_id: r?.recipe_id ?? null, site_recipe_id: r?.site_recipe_id ?? null, output_item_id: r?.output_item_id ?? null,
      name: r?.name || '', unit: r?.unit || '',
      on_hand: num(r?.on_hand), expected: num(r?.expected), scheduled: num(r?.scheduled), planned: num(r?.planned),
      make: num(r?.make, Math.max(0, num(r?.expected) - num(r?.on_hand) - num(r?.scheduled) - num(r?.planned))),
      done_qty: num(r?.done_qty),
      ticks: (Array.isArray(r?.ticks) ? r.ticks : []).map((t) => ({ id: t?.id ?? null, qty: num(t?.qty), by_name: t?.by_name || '', at: t?.at || null })),
      horizon: r?.horizon || null,
    })),
  };
}

/** What is still to make after the ticks: never below 0. */
export function remaining(row) {
  return Math.max(0, num(row?.make) - num(row?.done_qty));
}

/** 'covered' when nothing is to make, else the amount: '6 L', '12 each'. */
export function makeWords(row) {
  const make = num(row?.make);
  if (make <= 0) return 'covered';
  return `${r1(make)}${row?.unit ? ` ${row.unit}` : ''}`;
}

/** 'Done 6 L by Jane Tester 14:05' (the venue's clock); the name or time left off when unknown. */
export function tickWords(tick, unit = '', tz = null) {
  const qty = r1(num(tick?.qty));
  const who = String(tick?.by_name || '').trim();
  const at = tick?.at ? fmtVenueTime(tick.at, tz) : '';
  return `Done ${qty}${unit ? ` ${unit}` : ''}${who ? ` by ${who}` : ''}${at ? ` ${at}` : ''}`;
}

/** The state a Make cell is in: 'covered' (nothing to make), 'done' (ticked up to it), 'open'. */
export function rowState(row) {
  if (num(row?.make) <= 0) return 'covered';
  return remaining(row) <= 0 ? 'done' : 'open';
}

/** The qty the Done box starts with: what is still to make, one decimal, as text; '' when none. */
export function defaultTickQty(row) {
  const left = remaining(row);
  return left > 0 ? String(r1(left)) : '';
}

// ── the Batch and prep grid ──────────────────────────────────────────────────────────────────────

/**
 * The 55000 refusal of stock_batch_set_how while the site still holds the made item ('<site> still
 * holds <qty> <unit> of <item>. Use it up ...'): it opens the Not yet modal, every other refusal is
 * a red line.
 */
export function isHoldingRefusal(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const words = String(error.message || error);
  return (code === '55000' && /still holds/i.test(words)) || /still holds .* Use it up or count it to zero first/i.test(words);
}

/** 'Northgate now gets Test sauce: Made here.' (the mockup's toast after a saved choice). */
export function howSavedWords(siteName, recipeName, how) {
  return `${siteName || 'The site'} now gets ${recipeName || 'the batch'}: ${howLabel(how) || how}.`;
}

/** The grid's site cell for one row: { on, how, holds, unit } or null when the recipe is off there. */
export function siteCell(row, siteId) {
  const s = (Array.isArray(row?.sites) ? row.sites : []).find((x) => String(x?.location_id) === String(siteId));
  if (!s || s.on === false) return null;
  return { on: true, how: s.how || 'batches', holds: s.holds == null ? null : num(s.holds), unit: s.unit || '' };
}

/** 'holds 4 L' under a Made here cell when the site holds some; '' otherwise. */
export function holdsWords(cell) {
  if (!cell || cell.holds == null || !(cell.holds > 0)) return '';
  return `holds ${r1(cell.holds)}${cell.unit ? ` ${cell.unit}` : ''}`;
}

/**
 * A saved choice written into the grid's rows: that site's how and the recipe's new row_version
 * (the database answers { ok, location_id, how, row_version }). Rows that did not change are the
 * same objects, so the table does not re-render them.
 */
export function applyHow(rows, recipeId, siteId, answer) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (String(r?.recipe_id) !== String(recipeId)) return r;
    const sites = (Array.isArray(r.sites) ? r.sites : []).map((s) => (String(s.location_id) === String(siteId) ? { ...s, on: true, how: answer?.how || s.how } : s));
    return { ...r, sites, row_version: answer?.row_version != null ? answer.row_version : r.row_version };
  });
}

/** A new page of rows under the ones shown (Show more), never the same recipe twice. */
export function appendRows(rows, more) {
  const seen = new Set((rows || []).map((r) => String(r.recipe_id)));
  const out = [...(rows || [])];
  for (const r of Array.isArray(more) ? more : []) {
    if (seen.has(String(r.recipe_id))) continue;
    seen.add(String(r.recipe_id));
    out.push(r);
  }
  return out;
}

/** The grid's column width: the recipe and yield columns plus one per site. */
export function gridMinWidth(siteCount) {
  return 260 + 110 + Math.max(0, num(siteCount)) * 150;
}
