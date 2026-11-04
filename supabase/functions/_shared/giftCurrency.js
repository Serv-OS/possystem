// supabase/functions/_shared/giftCurrency.js
//
// 5.12.57: gift cards are sold in the selling venue's own currency. gift_brand_config.currency is a
// column with a 'gbp' default and nothing ever set it from the venue, so a US company that turned
// gift cards on without opening Settings would have sold pound gift cards online. The venue's
// currency (Platform locations.currency) now decides the charge; the config is only a fallback for
// a venue row with no currency. Codes are lower case, as Adyen and the gift tables store them.

const CODE = /^[a-z]{3}$/;

/** A currency code as the gift tables keep it ('usd'), or null when it is not one. */
export function giftCode(c) {
  const s = String(c ?? '').trim().toLowerCase();
  return CODE.test(s) ? s : null;
}

/** The currency a gift card is charged in: the selling venue's, else the config's, else 'gbp'. */
export function giftChargeCurrency({ venueCurrency, configCurrency } = {}) {
  return giftCode(venueCurrency) || giftCode(configCurrency) || 'gbp';
}

/**
 * The currency a company's gift cards start in when they are first turned on: the one currency its
 * venues use, or null when they use several or none (the column default then stands, and each sale
 * is still charged in its own venue's currency by giftChargeCurrency).
 */
export function companyGiftCurrency(venueCurrencies) {
  const set = new Set((venueCurrencies || []).map(giftCode).filter(Boolean));
  return set.size === 1 ? [...set][0] : null;
}
