// src/lib/ukMobile.js
//
// THE CUSTOMER DISPLAY TAKES ONLY A REAL UK MOBILE (27 Sep 2026). PURE: no imports, so node tests
// drive every case (src/lib/ukMobile.test.js), the display keypad uses it before it sends anything
// (surfaces/CustomerDisplaySurface.jsx) and the till uses it again before it creates anything
// (lib/customerLookup.js captureLoyaltyByPhone). One rule, in one place, for both.
//
// WHY. Peter, 27 Sep 2026: a customer typed 0776295512 on the display (ten digits, one short) and
// the till made a loyalty profile for it and texted the sign up link to a number that is nobody's.
// The keypad only asked for seven digits. Now a UK venue's display takes only a UK mobile:
//   07 and 9 more digits (11 digits), or +447 / 447 and 9 more digits; spaces are fine.
// Anything else ("0776295512", a landline "01132 496 000", letters, nothing) is refused on the
// display with "Please check your number", and nothing is sent or created.
//
// A venue that is not in the UK (a USD or EUR till) keeps the old rule: its customers type their
// own country's numbers, which a UK rule would refuse every time. The till's currency is how the
// app tells the two apart (the same fallback lib/customerImport.js uses for the venue's country).

const str = (v) => (v == null ? '' : String(v));

/** The number with its spaces taken out, or '' when anything but digits, spaces and one leading + is in it. */
function compact(raw) {
  const s = str(raw).trim();
  if (!s || !/^\+?[\d\s]+$/.test(s)) return '';
  return s.replace(/\s+/g, '');
}

/** A UK mobile: 07 + 9 digits, +447 + 9 digits, or 447 + 9 digits (spaces allowed, nothing else). */
export function isUkMobile(raw) {
  return /^(?:07\d{9}|\+447\d{9}|447\d{9})$/.test(compact(raw));
}

/** A UK mobile in the stored form ('+447762955142'), or null when it is not one. */
export function normaliseUkMobile(raw) {
  const s = compact(raw);
  if (!isUkMobile(s)) return null;
  if (s.startsWith('07')) return '+44' + s.slice(1);
  if (s.startsWith('447')) return '+' + s;
  return s;
}

/** Does the UK rule apply to this till? A GBP till does, and so does one whose currency is not known yet. */
export function ukRuleApplies(currency) {
  const c = str(currency).trim().toUpperCase();
  return c === '' || c === 'GBP';
}

/**
 * May the customer display send this number? THE ONE CHECK both the display keypad and the till
 * run. A UK venue: a UK mobile only. Any other venue: seven to fifteen digits, as before.
 */
export function displayNumberAccepted(raw, currency = 'GBP') {
  if (ukRuleApplies(currency)) return isUkMobile(raw);
  const d = str(raw).replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15;
}

/** The words the display shows for a number it will not send. */
export const CHECK_NUMBER_TEXT = 'Please check your number';
