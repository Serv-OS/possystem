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
