// src/lib/discountApprover.js
//
// The manager who approved a discount is recorded as a NAME TAG ({ id, name, role }), never as
// the staff record. v5.10.0 (27 Sep 2026): the till's discount screen put the signed in
// manager's whole staff_members row on the discount, so every discounted check in closed_checks
// (and the open table in active_sessions, and a reader job's check_draft) carried that manager's
// PIN in plain text, plus their permissions and staff card id. Coffee Boy Leeds "Custom 100%" and
// "Staff Discount 50%" checks, 26 and 27 Sep. Those rows are read by every till, report and Back
// Office, so a PIN on them is a PIN handed to anyone who can read a check.
//
// Nothing reads a discount's manager beyond its name (the Exceptions report, the screen's own
// "Authorised by"), so a whitelist loses nothing. Applied where a discount is made (DiscountModal),
// where the store takes one (add*Discount) and where a check leaves the till (closedCheckRow,
// writeClosedCheckRow, terminal job check_draft), so an old open table loaded from active_sessions
// is cleaned when it closes. Pure: no imports, tested under `npm test`.

const APPROVER_KEYS = ['id', 'name', 'role'];

/** { id, name, role } from any staff record (only the keys it has), or null. */
export function approverStamp(staff) {
  if (!staff || typeof staff !== 'object') return null;
  const out = {};
  for (const k of APPROVER_KEYS) {
    const v = staff[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The discount with its manager reduced to a name tag. Same object back when there is nothing to change. */
export function scrubDiscount(discount) {
  if (!discount || typeof discount !== 'object') return discount;
  const m = discount.manager;
  if (!m || typeof m !== 'object') return discount;
  const stamp = approverStamp(m);
  const same = stamp && Object.keys(m).length === Object.keys(stamp).length
    && Object.keys(stamp).every(k => m[k] === stamp[k]);
  return same ? discount : { ...discount, manager: stamp };
}

/** A discounts list with every manager reduced to a name tag. Same array back when nothing changed. */
export function scrubDiscounts(discounts) {
  if (!Array.isArray(discounts)) return discounts;
  let changed = false;
  const out = discounts.map(d => { const s = scrubDiscount(d); if (s !== d) changed = true; return s; });
  return changed ? out : discounts;
}

/** Items whose own discount carries a manager, reduced the same way. Same array back when nothing changed. */
export function scrubItemDiscounts(items) {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const out = items.map(i => {
    if (!i || typeof i !== 'object' || !i.discount) return i;
    const d = scrubDiscount(i.discount);
    if (d === i.discount) return i;
    changed = true;
    return { ...i, discount: d };
  });
  return changed ? out : items;
}

/** A check shaped object (closed check, check_draft) with its discounts and item discounts scrubbed. */
export function scrubCheckApprovers(check) {
  if (!check || typeof check !== 'object') return check;
  const discounts = scrubDiscounts(check.discounts);
  const items = scrubItemDiscounts(check.items);
  if (discounts === check.discounts && items === check.items) return check;
  return { ...check, discounts, items };
}
