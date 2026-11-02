// src/lib/online/promoEntry.js
//
// 5.12.37 (found proving Forms live on Provo, 2 Nov 2026): online checkout stripped the hyphen out
// of whatever was typed in "Gift card or promo code" before checking it as a promo code, and
// promo-redeem matches the code exactly (lockdown step 1d), so every code with a prefix
// (5OFF-7GRRTK5P, WELC-..., BDAY-...) said "Code not recognised" online. The kiosk already sent the
// code as typed. A gift card is still looked up without separators; a promo code keeps its hyphens.

/** The code as the customer typed it, for promo-redeem: spaces dropped, hyphens kept, upper case. */
export function typedPromoCode(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase();
}

/** The code with every separator gone, for the gift card length check and gift-lookup. */
export function giftCodeDigits(raw) {
  return String(raw == null ? '' : raw).replace(/[\s-]/g, '');
}

/**
 * Plain words for a promo-redeem refusal (validate's { valid:false, reason, min_spend }), so the
 * customer learns why instead of "Code not recognised". '' = no better words (say not recognised).
 * money(major) formats an amount in the venue currency.
 */
export function promoRefusalWords(reply, money = (n) => String(n)) {
  const r = reply && typeof reply === 'object' ? String(reply.reason || '') : '';
  switch (r) {
    case 'usage_limit': return 'You have already used this offer.';
    case 'already_used': return 'This code has already been used.';
    case 'expired': return 'This code has expired.';
    case 'voided': return 'This code is no longer valid.';
    case 'not_yet_active': return 'This code is not active yet.';
    case 'inactive': return 'This offer has ended.';
    case 'wrong_venue': return 'This code cannot be used at this venue.';
    case 'customer_mismatch': return 'This code belongs to another customer.';
    case 'free_item_not_in_basket': return 'Add the free item to your basket first, then use the code.';
    case 'min_spend': return Number.isFinite(Number(reply.min_spend)) ? `Spend ${money(Number(reply.min_spend))} or more to use this code.` : 'Your basket is under the minimum spend for this code.';
    default: return '';
  }
}
