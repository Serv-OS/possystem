// src/lib/menuItemOrder.js
//
// v5.11.111 (28 Oct 2026, Peter: "why is the order of products different on the kiosk to online
// ordering... the default should be the same"). ONE rule for the order products appear in, on
// every screen that lists a category's items: the till and bar, both kiosk designs, online and QR,
// catering, menu boards, the print menu and Back Office's menu builder.
//
// The rule: the position the venue gave the item in the menu builder (sort_order; a new item has
// 999 until it is dragged into place), then the order the items were made in (the id carries the
// creation time). Before this every screen sorted by position alone, so items never dragged into
// place, all at 999, came out in whatever order the database handed back: online ordered its read
// by id and showed creation order, the kiosk did not and showed a different order every load.
//
// Pure, no React, no Supabase. Reads either row shape (sort_order or sortOrder).

export const UNPLACED = 999;

/** The item's position in its category, UNPLACED when none was ever given. */
export function itemPosition(it) {
  // v5.12.86 (Peter, 23 Nov 2026: "they just go into any order... refreshing the page reflects the new
  // layout accurately"). A Back Office row carries BOTH fields: the mapper (lib/rowMapping.js) spreads
  // the database row, so sort_order stays beside sortOrder. A drag patches sortOrder only, and this
  // read took sort_order first, so the screen kept the OLD order until a reload. The camel field is
  // the one every edit writes, so it is read first; a raw database row (kiosk, online) has only sort_order.
  const v = it?.sortOrder ?? it?.sort_order;
  const n = Number(v);
  return v == null || Number.isNaN(n) ? UNPLACED : n;
}

/** Array.prototype.sort comparator: position, then creation order (id), the same on every screen. */
export function compareMenuItems(a, b) {
  const d = itemPosition(a) - itemPosition(b);
  if (d) return d;
  const x = String(a?.id ?? ''), y = String(b?.id ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A sorted copy. */
export function sortMenuItems(items) {
  return (Array.isArray(items) ? items.filter(Boolean) : []).slice().sort(compareMenuItems);
}
