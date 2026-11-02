// src/lib/online/deliveryCoverage.js
//
// DELIVERY COVERAGE on the online menu page (5.12.35). Peter: "the deliver to your address would
// need to be fenced by inputting the address of the delivery and knowing if that can actually be
// delivered to, so the flow is very different". The address and the coverage check moved to the
// moment the customer picks Delivery, so nobody builds a basket for an address the venue cannot
// deliver to. PURE apart from quoteDeliveryAddress, which takes its quote call as a dependency;
// tested in deliveryCoverage.test.js.
//
// ONE RULE, ONE HOME: the page's address sheet and OnlineCheckout step 1 both go through
// quoteDeliveryAddress (the same getDeliveryQuote call the checkout always made, through
// lib/delivery/quoteService.js) and read every word from here. The checkout has no quote call
// and no reason wording of its own (pinned in deliveryCoverage.test.js).
//
//   delivery = { address1, postcode, geo: { lat, lng } | null, quote: getDeliveryQuote result | null }
//
// The page owns that object and hands it to OnlineCheckout as a controlled prop, as it does the
// timing choice, so step 1 starts with the address, the coordinates and the quote filled, and an
// edit there updates the header's "Delivery to <address>" row.

import { getDeliveryQuote } from '../delivery/quoteService.js';
import { pickupWord } from './orderTiming.js';

export const EMPTY_DELIVERY = Object.freeze({ address1: '', postcode: '', geo: null, quote: null });

/** A quote that has not answered in this long is reported as a check that could not run. */
export const QUOTE_TIMEOUT_MS = 15000;

/** The reasons that mean the ADDRESS is the problem: the venue does not go there. Every other
 *  reason (transport, timeout, courier sign in, no quote) means the check itself did not run. */
export const NOT_COVERED_REASONS = Object.freeze(['out_of_radius', 'out_of_coverage']);

/** "12 High Street, HD1 2AB": the address as one line, never null. */
export function deliveryAddressLine(address1, postcode) {
  return [address1, postcode].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
}

/** Both parts typed: the check may run. */
export function canCheckAddress(delivery) {
  return !!(String(delivery?.address1 || '').trim() && String(delivery?.postcode || '').trim());
}

/** The dropoff the quote is asked for: trimmed line 1, upper case postcode, and the coordinates
 *  when a Mapbox suggestion was picked (the server geocodes a UK postcode itself otherwise). */
export function deliveryDropoff(delivery) {
  const out = { line1: String(delivery?.address1 || '').trim(), postcode: String(delivery?.postcode || '').trim().toUpperCase() };
  const geo = delivery?.geo;
  if (geo && Number.isFinite(Number(geo.lat)) && Number.isFinite(Number(geo.lng))) { out.lat = Number(geo.lat); out.lng = Number(geo.lng); }
  return out;
}

/** The address text as typed. The coordinates and the quote belonged to the old text, so they go,
 *  unless the text is exactly the line a suggestion just filled in (the autocomplete reports the
 *  pick, then the same text through onChangeText; the pick must keep its coordinates). */
export function typeAddress(delivery, text) {
  const t = String(text ?? '');
  const d = delivery || EMPTY_DELIVERY;
  if (d.address1 === t && d.geo) return d;
  return { ...d, address1: t, geo: null, quote: null };
}

/** The postcode as typed. Coordinates were for the old postcode, so they and the quote go. */
export function typePostcode(delivery, text) {
  const d = delivery || EMPTY_DELIVERY;
  return { ...d, postcode: String(text ?? ''), geo: null, quote: null };
}

/** A Mapbox suggestion picked: line 1, its postcode when it has one, its coordinates. */
export function pickAddress(delivery, a) {
  const d = delivery || EMPTY_DELIVERY;
  const line1 = String(a?.line1 || a?.full || a?.label || '');
  const geo = (a && a.lat != null && a.lng != null && Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng))) ? { lat: Number(a.lat), lng: Number(a.lng) } : null;
  return { ...d, address1: line1, postcode: a?.postcode ? String(a.postcode) : d.postcode, geo, quote: null };
}

/** The quote for this address, kept only if the address is still the one it was asked for. */
export function withQuote(delivery, asked, quote) {
  const d = delivery || EMPTY_DELIVERY;
  if (d.address1 !== asked?.address1 || d.postcode !== asked?.postcode) return d;
  return { ...d, quote: quote || null };
}

/**
 * The state of the check:
 *   'empty'        nothing to check yet (a part is missing)
 *   'unchecked'    an address, no answer yet
 *   'checking'     the quote is running
 *   'covered'      the venue delivers there (the quote is available; the minimum order is a
 *                  separate matter, see minimumOrderShortfall)
 *   'not_covered'  the address is outside the radius or the courier's coverage
 *   'error'        the check itself did not run (transport, timeout, courier sign in, no quote)
 */
export function coverageState(delivery, { checking = false } = {}) {
  if (checking) return 'checking';
  if (!canCheckAddress(delivery)) return 'empty';
  const q = delivery?.quote;
  if (!q) return 'unchecked';
  if (q.available) return 'covered';
  return NOT_COVERED_REASONS.includes(q.reason) ? 'not_covered' : 'error';
}

/** Pence or cents short of the quoted minimum order, 0 when there is none or it is met. */
export function minimumOrderShortfall(quote, subtotalMinor) {
  if (!quote || !quote.available) return 0;
  const min = Number(quote.minOrderMinor);
  if (!Number.isFinite(min) || min <= 0) return 0;
  const sub = Math.max(0, Math.round(Number(subtotalMinor) || 0));
  return Math.max(0, min - sub);
}

/** The basket bar's line while the basket is under the delivery minimum: "Add £4.50 more for
 *  delivery". '' otherwise. fmt formats a MINOR amount. */
export function basketMinimumWords(quote, subtotalMinor, fmt) {
  const short = minimumOrderShortfall(quote, subtotalMinor);
  return short > 0 ? `Add ${fmt(short)} more for delivery` : '';
}

/** The sheet's words for each state. fmt formats a MINOR amount in the venue's currency. */
export function coverageWords(delivery, { checking = false, fmt = (m) => String(m), siblings = 0, location = null } = {}) {
  const state = coverageState(delivery, { checking });
  const line = deliveryAddressLine(delivery?.address1, delivery?.postcode);
  const q = delivery?.quote;
  const collect = pickupWord(location).toLowerCase();
  if (state === 'checking') return { state, title: 'Checking your address', detail: 'One moment.' };
  if (state === 'covered') {
    const parts = [];
    const fee = Number(q.customerFeeMinor) || 0;
    parts.push(fee > 0 && !q.freeDelivery ? `Delivery fee ${fmt(fee)}.` : 'Delivery is free.');
    const min = Number(q.minOrderMinor);
    if (Number.isFinite(min) && min > 0) parts.push(`Minimum order ${fmt(min)}.`);
    return { state, title: `We deliver to ${line}`, detail: parts.join(' ') };
  }
  if (state === 'not_covered') {
    const tail = siblings > 0 ? `Choose ${collect} instead, or try another of our venues.` : `Choose ${collect} instead.`;
    return { state, title: 'We do not deliver there yet', detail: `${line} is outside our delivery area. ${tail}` };
  }
  if (state === 'error') {
    return { state, title: 'We could not check that address', detail: `The delivery check did not run. Try again, or choose ${collect} instead.` };
  }
  return { state, title: '', detail: '' };
}

/**
 * The checkout's block words for a delivery order, or null when nothing blocks. One wording for
 * the details step and the payment gate.
 *   whileChecking: the payment gate blocks while no quote has answered; the details step does
 *   not (a null quote never fails step 1, as before).
 */
export function deliveryBlockWords(quote, { fmt = (m) => String(m), whileChecking = false, location = null } = {}) {
  const collect = pickupWord(location).toLowerCase();
  if (!quote) return whileChecking ? 'Checking delivery for your address. One moment, then try again.' : null;
  if (!quote.available) {
    return NOT_COVERED_REASONS.includes(quote.reason)
      ? `Sorry, your address is outside our delivery area. Please choose ${collect}.`
      : `Delivery is not available for this address right now. Please choose ${collect}.`;
  }
  if (quote.belowMinimum) {
    const min = Number.isFinite(Number(quote.minOrderMinor)) ? fmt(Number(quote.minOrderMinor)) : '';
    return `Minimum order for delivery is ${min}. Add more to your basket or choose ${collect}.`;
  }
  return null;
}

/** The "Try <venue>" button on the not covered sheet: one sibling by name, several as "another
 *  location", none at all without a sibling. Opens the Change location sheet. */
export function tryVenueButton(siblings) {
  const list = Array.isArray(siblings) ? siblings.filter((v) => v && v.id) : [];
  if (!list.length) return null;
  if (list.length === 1) return { label: `Try ${String(list[0].name || 'our other venue').trim()}` };
  return { label: 'Try another location' };
}

/** "Collect instead" for a sterling venue, "Pickup instead" elsewhere (pickupWord, one place). */
export function collectInsteadLabel(location) {
  return `${pickupWord(location)} instead`;
}

/** The postcode field's label and the Mapbox country, from the venue currency (one place). */
export function postcodeLabel(location) {
  return String(location?.currency || 'GBP').toUpperCase() === 'USD' ? 'ZIP code' : 'Postcode';
}
export function addressCountry(location) {
  return String(location?.currency || 'GBP').toUpperCase() === 'USD' ? 'us' : 'gb';
}

/**
 * THE quote call: the one getDeliveryQuote the checkout always made, with the dropoff built here,
 * the current basket for the minimum and free delivery rules, and a timeout. Never throws: a
 * thrown transport error or a timeout comes back as { available: false, reason }, which
 * coverageState reads as 'error' (the check could not run), never as not covered.
 */
export async function quoteDeliveryAddress({ opsLocationId, delivery, orderSubtotalMinor = 0 }, deps = {}) {
  const quote = deps.getDeliveryQuote || getDeliveryQuote;
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs)) ? Number(deps.timeoutMs) : QUOTE_TIMEOUT_MS;
  const dropoff = deliveryDropoff(delivery);
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ available: false, reason: 'timeout' }), timeoutMs); });
  try {
    const call = Promise.resolve()
      .then(() => quote({ opsLocationId, dropoff, orderSubtotalMinor: Math.max(0, Math.round(Number(orderSubtotalMinor) || 0)) }))
      .catch((e) => ({ available: false, reason: 'transport_error', error: String(e?.message || e) }));
    const q = await Promise.race([call, timeout]);
    return (q && typeof q === 'object') ? q : { available: false, reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
