/**
 * kioskPhone.js: the mobile number rules for the new kiosk design (README 6).
 *
 * One number, typed once on the keypad, used for points (no code needed to earn,
 * decision 5) and for the ready text (decision 9). The kiosk only ever shows it MASKED
 * (README privacy rule): "•••• •••" and the last 3 digits.
 *
 * Region comes from the venue currency: USD venues use US numbers, every other venue
 * (GBP, and EUR for now) uses UK mobile numbers.
 *
 * Pure: no imports, so node:test can load it (kioskPhone.test.js).
 */

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

/** 'us' for a USD venue, otherwise 'uk'. */
export function kioskPhoneRegion(currencyCode) {
  return String(currencyCode || '').toUpperCase() === 'USD' ? 'us' : 'uk';
}

/** The most digits the keypad takes for a region (README: capped at 11). */
export function kioskPhoneMaxLength(region) {
  return region === 'us' ? 10 : 11;
}

/**
 * The number in E.164, or null when it is not a number we can text.
 *   UK: 07 and 9 more digits (11), or the same without the leading 0 (7 and 9 more, 10),
 *       becomes +447 and 9 digits. Anything else (landlines, a missing 7) is null.
 *   US: exactly 10 digits becomes +1 and the digits.
 */
export function kioskE164(digits, region) {
  const d = onlyDigits(digits);
  if (region === 'us') {
    return /^[2-9]\d{9}$/.test(d) ? `+1${d}` : null;
  }
  if (/^07\d{9}$/.test(d)) return `+44${d.slice(1)}`;
  if (/^7\d{9}$/.test(d)) return `+44${d}`;
  return null;
}

/** True when Confirm number can be tapped: the number converts to E.164. */
export function kioskPhoneValid(digits, region) {
  return kioskE164(digits, region) !== null;
}

/**
 * Keypad display grouping.
 *   UK: a space after the 5th digit ("07700 900123", README 6).
 *   US: 3, 3, 4 ("415 555 0123").
 */
export function kioskPhoneDisplay(digits, region) {
  const d = onlyDigits(digits);
  if (region === 'us') {
    return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 10)].filter(Boolean).join(' ');
  }
  return d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5)}` : d;
}

/** The masked echo, never the full number: "•••• •••" and the last 3 digits. */
export function kioskMaskPhone(digits) {
  const d = onlyDigits(digits);
  return `•••• •••${d.slice(-3)}`;
}
