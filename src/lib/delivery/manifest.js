/**
 * manifest.js — build the Uber Direct "create delivery" manifest from a ServOS order.
 * Pure + unit-tested. The edge fn passes this through to Uber (exact field shape locked
 * in sandbox); keeping it here means the data/maths (declared value, item lines, E.164
 * phone) are tested in one place.
 */

import { toE164 as regionE164 } from '../../../supabase/functions/_shared/regionPack.js';

/**
 * E.164 with the venue's country (07… → +44… at a UK venue; keep already-+ numbers; pass through
 * what cannot be read). 5.12.57: read through the region pack with the venue's currency (USD is
 * the US), so a US (801) 555-1234 is +18015551234; it used to go to the courier as 8015551234.
 * No currency reads as the UK, as before.
 * @param {string} raw
 * @param {string|object} [venue='GBP']  the venue's currency, or a row with currency/country
 */
export function toE164(raw, venue = 'GBP') {
  const s = String(raw || '').replace(/[\s()-]/g, '');
  if (!s) return '';
  return regionE164(s, venue || 'GBP') || s;
}

const addrObj = (a) => {
  if (!a) return null;
  if (typeof a === 'string') return { line1: a };
  return { line1: a.line1 || '', line2: a.line2 || '', city: a.city || '', postcode: a.postcode || '', country: a.country || 'GB', lat: a.lat ?? null, lng: a.lng ?? null };
};

/**
 * @param {object} args
 * @param {object} args.order   closed-check-like record: { ref, items[], customer:{name,phone,address} }
 * @param {object} args.quote   accepted DeliveryQuoteService result (quoteId, dropoff, currency)
 * @param {object} args.pickup  venue pickup config: { address, contact:{name,phone,instructions} }
 * @returns manifest object for the uber-direct create_delivery action
 */
export function buildManifest({ order, quote, pickup }) {
  const items = (order?.items || []).filter((i) => !i.voided);
  const declaredValueMinor = items.reduce((s, i) => s + Math.round((Number(i.price) || 0) * (Number(i.qty) || 1) * 100), 0);
  const cust = order?.customer || {};
  const currency = quote?.currency || 'GBP';

  return {
    quote_id: quote?.quoteId || null,
    manifest_reference: order?.ref || null,
    manifest_total_value: declaredValueMinor,          // declared value for goods-liability cover
    currency,
    pickup: {
      name: pickup?.contact?.name || pickup?.name || 'Restaurant',
      phone: toE164(pickup?.contact?.phone || pickup?.phone, currency),
      address: addrObj(pickup?.address),
      instructions: pickup?.contact?.instructions || '',
    },
    dropoff: {
      name: cust.name || 'Customer',
      phone: toE164(cust.phone, currency),
      address: addrObj(quote?.dropoff || cust.address),
      instructions: cust.notes || cust.deliveryNotes || '',
    },
    items: items.map((i) => ({ name: i.name || 'Item', quantity: Number(i.qty) || 1 })),
  };
}
