/**
 * adyenWallets.js: the pure part of turning an order into Adyen's
 * /paymentMethods call and turning its answer into what Drop-in needs to
 * render Apple Pay and Google Pay beside the card form. No network, no React,
 * no @adyen/adyen-web import: everything here is a plain function over plain
 * objects, so adyenWallets.test.js is the whole contract.
 *
 * WHY (8 Sep 2026): AdyenPaymentForm handed Drop-in a HARDCODED card only
 * paymentMethodsResponse, so no wallet could ever appear no matter how the
 * merchant account was set up. That is why Apple Pay did not load in checkout.
 * The advanced flow wants a real /paymentMethods response, which is per amount
 * and per country, so it cannot be a constant and it cannot be cached.
 *
 * ENDPOINTS AND FIELDS VERIFIED ON THE DOCS (8 Sep 2026):
 *   POST {checkoutBase}/paymentMethods
 *     required: merchantAccount, amount { currency, value }
 *     optional: countryCode, channel ('Web'), shopperLocale, store (1 to 16
 *               chars), shopperReference, allowedPaymentMethods,
 *               blockedPaymentMethods, shopperEmail, shopperIP
 *     response: { paymentMethods: [{ type, name, brand, brands, configuration,
 *               group, inputDetails }], storedPaymentMethods? }
 *     https://docs.adyen.com/api-explorer/Checkout/72/post/paymentMethods
 *     https://docs.adyen.com/online-payments/build-your-integration/advanced-flow
 *
 * THE UNMOUNTABLE WALLET TRAP (the reason usableWalletMethods exists):
 * Drop-in constructs every entry in the response synchronously, in a .map()
 * with no try/catch, and GooglePay's constructor THROWS when
 * configuration.merchantId is missing. One such entry therefore takes the
 * card form down with it. Adyen makes that field optional on test, so the
 * response is filtered here before Drop-in ever sees it.
 *
 * THE MERGE TRAP (the reason walletConfiguration exists):
 * adyen-web v6 builds a component's props as
 *   { ...corePropsForComponent, ...thePaymentMethodEntryFromTheResponse, ...yourPaymentMethodsConfiguration }
 * (UIElement.buildElementProps), so a `configuration` key you pass REPLACES
 * the one Adyen sent rather than merging into it. Adyen's own docs say
 * configuration.merchantName only works when merchantId is set too (Apple Pay,
 * for merchantIdentifier during merchant validation) and when merchantId plus
 * gatewayMerchantId are set too (Google Pay). So the venue's display name is
 * merged ONTO the response's configuration, never sent on its own, and never
 * at all when the identifiers it depends on are missing.
 *   https://docs.adyen.com/payment-methods/apple-pay/web-drop-in
 *   https://docs.adyen.com/payment-methods/google-pay/web-drop-in
 */

// The wallet types this checkout knows how to render. 'paywithgoogle' is the
// legacy type name Adyen still returns on some accounts; the GooglePay class
// registers both, and Drop-in keys paymentMethodsConfiguration by the type
// string the response actually used, so it is kept verbatim throughout.
export const WALLET_TYPES = Object.freeze(['applepay', 'googlepay', 'paywithgoogle']);

// What this checkout can actually mount: the Card, ApplePay and GooglePay
// classes. Anything else in a /paymentMethods response would be dropped by
// Drop-in with a console warning ("you support X but this component has not
// been configured"), so the request asks Adyen for these three and no more.
// Sent as allowedPaymentMethods, a documented /paymentMethods request field.
// 'paywithgoogle' rides along because it is the type an older account still
// ANSWERS with, and allowedPaymentMethods is the one field that decides
// whether Adyen may return it. Naming a type the account does not have is
// harmless; leaving it out filtered Google Pay out server side, silently.
export const CHECKOUT_PAYMENT_TYPES = Object.freeze(['scheme', 'applepay', 'googlepay', 'paywithgoogle']);

// The fallback. This WAS the only thing AdyenPaymentForm ever gave Drop-in;
// now it is what the form falls back to when the /paymentMethods call cannot
// be made, so a broken lookup costs the wallets and never the card form.
export const CARD_ONLY_PAYMENT_METHODS = Object.freeze({
  paymentMethods: [{ type: 'scheme', name: 'Credit or debit card', brands: ['visa', 'mc', 'amex'] }],
});

const WALLET_LABELS = { applepay: 'Apple Pay', googlepay: 'Google Pay', paywithgoogle: 'Google Pay' };

/** 'Apple Pay' / 'Google Pay' for a payment method type, else null. */
export function walletLabel(type) {
  return WALLET_LABELS[String(type || '').toLowerCase()] || null;
}

/** Is this payment method type one of the wallets we render? */
export function isWalletType(type) {
  return WALLET_TYPES.includes(String(type || '').toLowerCase());
}

const upper = (v, fallback = '') => String(v ?? fallback).trim().toUpperCase();

/**
 * Build the adyen-checkout `payment_methods` request from an order.
 *
 * The amount is REQUIRED and real: Adyen decides which methods to offer from
 * the amount and the country, so a placeholder here would offer the shopper
 * methods that then refuse the real total.
 *
 * Throws on anything the edge function would only refuse anyway (no venue, no
 * amount), so the caller fails once, on the spot, with a message it can show.
 */
export function buildPaymentMethodsRequest({
  locationId,
  amountMinor,
  currency = 'GBP',
  countryCode,
  shopperLocale,
  allowedTypes = CHECKOUT_PAYMENT_TYPES,
} = {}) {
  const location = String(locationId ?? '').trim();
  if (!location) throw new Error('locationId required to look up the payment methods');
  const value = Math.round(Number(amountMinor));
  if (!Number.isFinite(value) || value < 1) throw new Error('amountMinor must be a positive integer (minor units)');
  const cur = upper(currency);
  if (cur.length !== 3) throw new Error('currency must be a 3 letter code');

  const country = upper(countryCode);
  const locale = String(shopperLocale ?? '').trim();
  const types = (Array.isArray(allowedTypes) ? allowedTypes : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  return {
    action: 'payment_methods',
    location_id: location,
    amount: { value, currency: cur },
    channel: 'Web',
    ...(country.length === 2 ? { countryCode: country } : {}),
    ...(locale ? { shopperLocale: locale } : {}),
    ...(types.length ? { allowed_types: types } : {}),
  };
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Why Drop-in could not construct this entry, or null when it can.
 *
 * A WALLET ENTRY DROP-IN CANNOT CONSTRUCT KILLS THE WHOLE DROP-IN, CARD FORM
 * INCLUDED. components/Dropin/elements/createElements.js is a plain .map() of
 * `new PaymentMethodElement(core, elementProps)` with NO try/catch, and it
 * runs synchronously inside dropin.mount(). GooglePay's constructor throws
 *   AdyenCheckoutError('IMPLEMENTATION_ERROR', 'GooglePay - Missing merchantId')
 * (verified in node_modules/@adyen/adyen-web/dist/es/components/GooglePay,
 * v6.42.0), its defaultProps set configuration.merchantId to '', and
 * buildElementProps merges SHALLOWLY, so a response entry
 * { type:'googlepay', configuration:{ gatewayMerchantId:'X' } } lands as
 * falsy and throws. Preact finds no boundary, rethrows past dropin.mount(),
 * and the shopper sees "Could not load the payment form" with no card form.
 *
 * Adyen's docs make the Google merchant ID required in LIVE and optional in
 * TEST, so that entry is the EXPECTED shape on a test venue with Google Pay
 * switched on. Hence: filter before Drop-in, never after.
 *
 * Apple Pay does not throw in its constructor, but with no merchantId its
 * merchant validation runs with an empty merchantIdentifier and the sheet
 * dies after the shopper has opened it, so it is dropped for the same reason:
 * a button that cannot pay is worse than no button, and the operator is told
 * on the venue's Adyen screen instead.
 *   https://docs.adyen.com/payment-methods/google-pay/web-drop-in
 *   https://docs.adyen.com/payment-methods/apple-pay/web-drop-in
 */
function walletBlocker(type, configuration) {
  const conf = configuration && typeof configuration === 'object' ? configuration : {};
  if (type === 'googlepay' || type === 'paywithgoogle') {
    if (!nonEmpty(conf.merchantId)) return 'no configuration.merchantId (the Google merchant ID; Adyen makes it optional on test)';
    if (!nonEmpty(conf.gatewayMerchantId)) return 'no configuration.gatewayMerchantId';
    return null;
  }
  if (type === 'applepay' && !nonEmpty(conf.merchantId)) {
    return 'no configuration.merchantId (the Apple merchant identifier)';
  }
  return null;
}

/**
 * Split a /paymentMethods response into what Drop-in can mount and what it
 * would throw on. Non wallet entries (the card) always survive: only a wallet
 * has an identifier it cannot be constructed without.
 *
 * Returns { paymentMethods, dropped: [{ type, reason }] }.
 */
export function usableWalletMethods(response) {
  const paymentMethods = [];
  const dropped = [];
  for (const pm of response?.paymentMethods || []) {
    if (!pm || !pm.type) continue;
    const type = String(pm.type).toLowerCase();
    const reason = walletBlocker(type, pm.configuration);
    if (reason) dropped.push({ type, reason });
    else paymentMethods.push(pm);
  }
  return { paymentMethods, dropped };
}

/** 'googlepay: no configuration.merchantId (…)' lines, for one console.warn. */
export function droppedWalletNote(dropped) {
  const list = (Array.isArray(dropped) ? dropped : []).filter(Boolean);
  if (!list.length) return null;
  return list.map((d) => `${d.type}: ${d.reason}`).join('; ');
}

/**
 * Turn the supabase.functions.invoke result into what the form mounts with.
 *
 * Never throws and never leaves the caller without a paymentMethodsResponse:
 * every unhappy path lands on CARD_ONLY_PAYMENT_METHODS with a `reason` the
 * caller logs as a console warning. `config` carries the publishable facts
 * (client key, environment, Drop-in environment, region) the fn answers on
 * BOTH its success and its cardOnly refusal, so the happy path needs no
 * separate `status` round trip; it is null only when even those are missing.
 *
 * `dropped` names every entry filtered out by usableWalletMethods, so the
 * caller warns with the REASON rather than leaving Drop-in to throw. The
 * filtered list is what both paymentMethodsResponse and offeredWalletTypes
 * are built from, so missingWalletNote can never blame the browser for a
 * wallet we removed ourselves.
 *
 * storedPaymentMethods is deliberately NOT forwarded: no caller sends a
 * shopperReference on this lookup, so Adyen returns none, and passing shopper
 * data straight through to Drop-in would become a live path the day one does.
 */
export function resolvePaymentMethods({ data, error } = {}) {
  const config = paymentConfigFrom(data);
  const raw = Array.isArray(data?.paymentMethods) ? data.paymentMethods : null;
  const { paymentMethods: list, dropped } = usableWalletMethods(raw ? { paymentMethods: raw } : null);

  if (data?.ok && raw && list.length) {
    return { response: { paymentMethods: list }, fallback: false, reason: null, dropped, config };
  }

  const emptied = data?.ok && raw && !list.length;
  const reason = String(
    data?.error
    || error?.message
    || (emptied && dropped.length ? `every method Adyen offered was unmountable (${droppedWalletNote(dropped)})` : '')
    || (emptied ? 'Adyen returned no payment methods for this amount and country' : '')
    || 'the payment methods lookup returned nothing',
  );
  return { response: CARD_ONLY_PAYMENT_METHODS, fallback: true, reason, dropped, config };
}

/** The publishable config the fn echoes back, or null when it is not usable. */
export function paymentConfigFrom(data) {
  const clientKey = String(data?.clientKey ?? '').trim();
  if (!clientKey) return null;
  const environment = String(data?.environment ?? '').trim() || null;
  const region = String(data?.region ?? '').trim() || null;
  const dropinEnvironment = String(data?.dropinEnvironment ?? '').trim()
    || (environment === 'live' ? 'live' : 'test');
  return { clientKey, environment, region, dropinEnvironment };
}

/** The wallet types this response offers, in the order Adyen listed them. */
export function offeredWalletTypes(response) {
  const seen = new Set();
  const out = [];
  for (const pm of response?.paymentMethods || []) {
    const type = String(pm?.type || '').toLowerCase();
    if (isWalletType(type) && !seen.has(type)) { seen.add(type); out.push(type); }
  }
  return out;
}

/**
 * The paymentMethodsConfiguration block for Drop-in: one entry per wallet the
 * response actually offers, each carrying the real amount, the country and
 * (only when it is safe) the venue's name.
 *
 * Callbacks are NOT built here (they close over React state); the caller
 * merges onAuthorized / onClick / onError onto these.
 */
export function walletConfiguration({ response, amountMinor, currency = 'GBP', countryCode, merchantName } = {}) {
  const value = Math.round(Number(amountMinor));
  const amount = Number.isFinite(value) && value >= 1 ? { value, currency: upper(currency) } : null;
  const country = upper(countryCode);
  const name = String(merchantName ?? '').trim();

  const out = {};
  for (const pm of response?.paymentMethods || []) {
    const type = String(pm?.type || '').toLowerCase();
    if (!isWalletType(type) || out[type]) continue;

    const entry = {};
    if (amount) entry.amount = amount;
    if (country.length === 2) entry.countryCode = country;

    // Merge, never replace: see THE MERGE TRAP at the top of this file.
    const fromAdyen = pm.configuration && typeof pm.configuration === 'object' ? { ...pm.configuration } : null;
    if (fromAdyen) {
      if (name && canNameMerchant(type, fromAdyen)) fromAdyen.merchantName = name;
      entry.configuration = fromAdyen;
    }
    out[type] = entry;
  }
  return out;
}

// Apple Pay validates the merchant with { displayName: merchantName,
// merchantIdentifier: merchantId }, so a merchantName without a merchantId
// would validate against nothing. Google Pay's docs say merchantName needs
// merchantId and gatewayMerchantId set alongside it. When they are missing,
// Adyen's own configured name stands.
function canNameMerchant(type, configuration) {
  if (type === 'applepay') return Boolean(configuration.merchantId);
  return Boolean(configuration.gatewayMerchantId && configuration.merchantId);
}

/**
 * The one short line under the card form when the venue offers a wallet this
 * browser did not render. Absence is normal and quiet (Apple Pay wants Safari
 * or an Apple device, Google Pay wants Chrome, and Drop-in simply drops a
 * component whose isAvailable() rejects), so this explains rather than errors,
 * and returns null whenever there is nothing to explain.
 */
export function missingWalletNote(offered, rendered) {
  const shown = new Set((Array.isArray(rendered) ? rendered : []).map((t) => String(t || '').toLowerCase()));
  const missing = new Set();
  for (const type of Array.isArray(offered) ? offered : []) {
    const t = String(type || '').toLowerCase();
    if (!isWalletType(t) || shown.has(t)) continue;
    // paywithgoogle and googlepay are the same wallet under two names: if
    // either rendered, Google Pay is on screen.
    if (t === 'paywithgoogle' && shown.has('googlepay')) continue;
    if (t === 'googlepay' && shown.has('paywithgoogle')) continue;
    missing.add(walletLabel(t));
  }
  if (!missing.size) return null;
  if (missing.has('Apple Pay') && missing.has('Google Pay')) {
    return 'Apple Pay and Google Pay are set up here but this browser cannot show them, so pay by card below.';
  }
  if (missing.has('Apple Pay')) {
    return 'Apple Pay is set up here but this browser cannot show it. Pay by card below, or reopen this page in Safari on an Apple device.';
  }
  return 'Google Pay is set up here but this browser cannot show it. Pay by card below, or reopen this page in Chrome.';
}

/**
 * The ONLY payment method types that must NOT carry
 * authenticationData.threeDSRequestData.
 *
 * MIRROR: supabase/functions/adyen-checkout/index.ts declares this list
 * verbatim (Deno cannot import from src/). KEEP IN SYNC: change both or
 * neither. This test file is the contract for both copies.
 *
 * APPLE PAY ONLY (8 Sep 2026). The old rule was "every wallet", on the
 * premise that a wallet is device authenticated and its token carries the
 * scheme cryptogram. That is true of Apple Pay and of a Google Pay
 * CRYPTOGRAM_3DS (DPAN) token, and NOT of a Google Pay PAN_ONLY (FPAN) token:
 * adyen-web's GooglePay defaultProps allow BOTH auth methods
 * (allowedAuthMethods: ['PAN_ONLY','CRYPTOGRAM_3DS'], verified in v6.42.0)
 * and nothing here narrows them, so an FPAN token arrives with no cryptogram,
 * is processed as raw card data and is expected to go through 3D Secure.
 * Without the flag Adyen answers RedirectShopper, which this checkout cannot
 * complete, and the shopper hits a dead end. GooglePay.formatData() does send
 * browserInfo, so the flag is the only missing half of native 3DS2.
 */
export const NO_NATIVE_3DS_TYPES = Object.freeze(['applepay']);

/**
 * Should this payment carry authenticationData.threeDSRequestData? Everything
 * except Apple Pay: see NO_NATIVE_3DS_TYPES above.
 */
export function wantsNativeThreeDS(paymentMethod) {
  return !NO_NATIVE_3DS_TYPES.includes(String(paymentMethod?.type ?? '').toLowerCase());
}
