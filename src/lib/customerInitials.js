// customerInitials.js: what a customer chip shows, for any customer, even one with no name yet
// (v5.9.88). Leeds, 27 Sep 2026, Peter: "we are still having that crash when customers put their
// phone number in on the customer display and their number isn't in the system". Since v5.9.85 a new
// number on the display is saved and attached to the order with NO name, and the till's order chip
// ran customer.name.split(...), which crashed the whole till.

/** Up to two initials from a name; '#' plus the last two digits of the phone when there is no name. */
export function customerInitials(name, phone) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length) return parts.map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits ? `#${digits.slice(-2)}` : '?';
}

/** The line to show for a customer: their name, else "New customer". */
export function customerLabel(name) {
  const n = String(name ?? '').trim();
  return n || 'New customer';
}

/** The first name for a greeting, or '' when there is none. */
export function firstNameOf(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || '';
}
