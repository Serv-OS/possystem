// src/lib/kds/kdsItemTicks.js: ticking and unticking one item on a kitchen ticket (v5.9.96).
//
// Peter, 27 Sep 2026: "you can't untick an item if you click by accident". A tap on a ticked item
// now unticks it. Every tap saves the whole items list, so the screen keeps the ticks it changed on
// top of anything the database sends back until the database shows those same ticks (or a short
// while after its last save): an older save arriving late must never flip an item back, and a
// later tap must never be built from that older copy. Lines this screen did not touch always come
// from the database, so a tick made on another kitchen screen still shows straight away.
//
// Pure helpers, no React, no database.

/** Flip the tick on one item. Returns { items, ticked } or null for a line that is not there. */
export function toggleTick(items, index) {
  const list = Array.isArray(items) ? items : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length || !list[index]) return null;
  const ticked = !list[index]._bumped;
  return { items: list.map((it, i) => (i === index ? { ...it, _bumped: ticked } : it)), ticked };
}

/** The tick on every line, in order (what one save sent). */
export function tickFlags(items) {
  return (Array.isArray(items) ? items : []).map((it) => !!it?._bumped);
}

/** How long a screen keeps its own ticks after its last save finished, if the database never shows them. */
export const LOCAL_TICKS_GRACE_MS = 30 * 1000;

/** True while this screen's ticks still win over the database copy. */
export function ticksActive(pending, now) {
  return !!pending && (pending.settledBy == null || now < pending.settledBy);
}

/**
 * The lines this screen has changed and not yet seen back: the line just tapped plus the lines of
 * a still active earlier tap, each with its tick as it stands in `items` (what is about to be saved).
 */
export function touchedTicks(prevPending, index, items, now) {
  const keys = new Set(ticksActive(prevPending, now) ? prevPending.touched.keys() : []);
  keys.add(index);
  const out = new Map();
  for (const k of keys) out.set(k, !!items?.[k]?._bumped);
  return out;
}

/** True when these items carry every tick in `touched`. */
export function ticksMatch(items, touched) {
  if (!(touched instanceof Map)) return true;
  const list = Array.isArray(items) ? items : [];
  for (const [i, v] of touched) if (!!list[i]?._bumped !== v) return false;
  return true;
}

/**
 * The database's items with this screen's changed ticks laid on top. Everything else (a void from
 * the till, a note, another screen's tick on another line) comes from the database.
 */
export function overlayTicks(items, touched) {
  const list = Array.isArray(items) ? items : [];
  if (!(touched instanceof Map)) return list;
  return list.map((it, i) => (it && touched.has(i) && !!it._bumped !== touched.get(i) ? { ...it, _bumped: touched.get(i) } : it));
}

/** True when `items` carry, on every touched line, the ticks of one of this screen's own saves. */
function isOwnOlderSave(items, touched, sent) {
  if (!Array.isArray(sent) || !sent.length) return false;
  const list = Array.isArray(items) ? items : [];
  return sent.some((flags) => {
    for (const i of touched.keys()) if (!!list[i]?._bumped !== !!flags?.[i]) return false;
    return true;
  });
}

/**
 * A row that just arrived (live update or refetch) → the row to show. `pending` is this screen's
 * unsettled ticks for the ticket: { touched, sent, settledBy }. settledBy is null while a save is
 * still waiting or running (this screen's save lands after anything arriving now), else the time
 * after which the database copy wins; `sent` holds the ticks of each save this screen sent.
 * Returns { row, settled }: settled is true when the pending entry can be dropped.
 *
 * Review round (v5.9.96): once this screen's last save has finished, a row that disagrees is kept
 * under our ticks only when it is a late copy of one of our own saves. Anything else was written
 * by another screen after us, so it shows straight away and the entry is dropped.
 */
export function mergeIncomingTicks(row, pending, now) {
  if (!pending || !row) return { row, settled: true };
  if (!ticksActive(pending, now)) return { row, settled: true };
  if (ticksMatch(row.items, pending.touched)) return { row, settled: pending.settledBy != null };
  if (pending.settledBy != null && !isOwnOlderSave(row.items, pending.touched, pending.sent)) return { row, settled: true };
  return { row: { ...row, items: overlayTicks(row.items, pending.touched) }, settled: false };
}
