// reportText.js: turn any stored check field into text a report can print (28 Sep 2026).
// Leeds, Peter: "I keep getting this error on exceptions report" (React error #31). Collection orders
// store closed_checks.customer as an object ({ name, phone, email, notes, isASAP, collectionISO,
// collectionTime }) and the Exceptions report printed it straight into the page when the check had no
// table label. React refuses to render a plain object, so the whole report crashed.

/** Plain text for any value: strings and numbers as they are, an object's name or label, else ''. */
export function plainText(v) {
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (Array.isArray(v)) return v.map(plainText).filter(Boolean).join(', ');
  if (typeof v === 'object') return plainText(v.name ?? v.label ?? v.displayName ?? '');
  return '';
}

/** What to show for a check's customer: a name, else the phone number, else ''. */
export function checkCustomerText(customer) {
  if (customer && typeof customer === 'object' && !Array.isArray(customer)) {
    return plainText(customer.name).trim() || plainText(customer.phone).trim();
  }
  return plainText(customer).trim();
}

/** A line's modifiers as one line of text. Lines store mods as { label, price, ... } objects, and
 *  joining those printed "[object Object], [object Object]" under every modified item. */
export function modsText(mods) {
  if (typeof mods === 'string') return mods;
  if (!Array.isArray(mods)) return '';
  return mods.map((m) => (m && typeof m === 'object' ? plainText(m.label ?? m.name) : plainText(m)))
    .filter(Boolean).join(', ');
}
