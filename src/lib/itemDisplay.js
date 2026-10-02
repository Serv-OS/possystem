// ============================================================
// src/lib/itemDisplay.js — customer-facing item field resolvers
// ============================================================
// Two name fields exist on a menu_items row:
//   - `name`     — internal/admin string. Stable identity, used by BO list
//                  views, POS button text default, modifier-option name
//                  match.
//   - `menuName` (DB column `menu_name`) — customer-facing display name. The
//                  field operators edit when they "rename" something for
//                  the kiosk / online surfaces.
//
// Different load paths give different shapes:
//   - Zustand store (POS): rows normalized to camelCase via SyncBridge → use
//                          `menuName`.
//   - Kiosk's useKioskMenu: raw Supabase rows → use `menu_name`.
//
// displayName() reads either shape, falling back to `name` so legacy data or
// fresh inserts that haven't set menuName yet still render something.
// ============================================================

export function displayName(item) {
  if (!item) return '';
  return item.menuName ?? item.menu_name ?? item.name ?? '';
}

// ── Kitchen / receipt name overrides ─────────────────────────────────────────
// Two more name fields exist on a menu_items row:
//   - `kitchenName` (DB `kitchen_name`) — what the KDS + kitchen tickets print.
//   - `receiptName` (DB `receipt_name`) — what customer receipts print.
//
// Both save paths default the DB column to the item's display name when the
// operator never typed one, so a populated column does NOT mean "explicitly
// set". These resolvers return the override ONLY when it genuinely differs
// from the item's base `name` — callers snapshot the result onto the order
// line at add time (null when no override) and render `kitchenName || name` /
// `receiptName || name`. That keeps synthesized line names (e.g. variant
// "Lager — Pint") intact for the common no-override case: zero visual change
// unless the operator actually set a kitchen/receipt name.
export function kitchenOverride(item) {
  if (!item) return null;
  const k = item.kitchenName ?? item.kitchen_name ?? null;
  return (k && k !== item.name) ? k : null;
}

export function receiptOverride(item) {
  if (!item) return null;
  const r = item.receiptName ?? item.receipt_name ?? null;
  return (r && r !== item.name) ? r : null;
}

// ── The name staff read for an order line (2 Oct 2026) ───────────────────────
// Peter, Coffee Boy Leeds, live: "it's not showing the product, just the size; this is back,
// the variant issue." QR order QR-FAUOB reached the Orders screen and the kitchen screen as
// "Big Boy". The line was stored as name "Mont Blanc — Big Boy", kitchenName "Big Boy".
//
// A size row is called "Big Boy" and its kitchen_name column defaults to that same word. The
// online and QR page copied the raw column onto the line, so every staff screen (they all read
// kitchenName first) dropped the product. The page now uses kitchenOverride like the till and
// the kiosk, and this resolver covers the lines already stored and any phone still holding the
// old page: a kitchen name that is only the size at the end of "<product> — <size>" is not an
// override, so the full line name is shown. A real override (the venue typed a different
// kitchen name) still wins, and a line whose name is already full is never doubled.
const SIZE_JOIN = ' — ';   // the long dash every channel writes between product and size

/** True when kitchenName is just the size the line name already ends with. */
export function isSizeOnlyKitchenName(line) {
  if (!line) return false;
  const k = String(line.kitchenName ?? line.kitchen_name ?? '').trim().toLowerCase();
  const name = String(line.name ?? '').trim().toLowerCase();
  if (!k || !name || k === name) return false;
  return name.endsWith(SIZE_JOIN + k);
}

/** What the kitchen and the Orders screen show for a line: its kitchen name, else its name. */
export function kitchenLineName(line) {
  if (!line) return '';
  const k = line.kitchenName ?? line.kitchen_name ?? null;
  return (k && !isSizeOnlyKitchenName(line)) ? k : (line.name ?? '');
}
