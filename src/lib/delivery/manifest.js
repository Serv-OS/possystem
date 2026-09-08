/**
 * manifest.js — build the Uber Direct "create delivery" manifest from a ServOS order.
 * Pure + unit-tested. The edge fn passes this through to Uber (exact field shape locked
 * in sandbox); keeping it here means the data/maths (declared value, item lines, E.164
 * phone) are tested in one place.
 */

/** UK-default E.164 normaliser (07… → +44…; keep already-+ numbers; pass through unknown). */
export function toE164(raw) {
  const s = String(raw || '').replace(/[\s()-]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('07')) return '+44' + s.slice(1);
  if (s.startsWith('44')) return '+' + s;
  if (s.startsWith('0')) return '+44' + s.slice(1);
  return s;
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

  return {
    quote_id: quote?.quoteId || null,
    manifest_reference: order?.ref || null,
    manifest_total_value: declaredValueMinor,          // declared value for goods-liability cover
    currency: quote?.currency || 'GBP',
    pickup: {
      name: pickup?.contact?.name || pickup?.name || 'Restaurant',
      phone: toE164(pickup?.contact?.phone || pickup?.phone),
      address: addrObj(pickup?.address),
      instructions: pickup?.contact?.instructions || '',
    },
    dropoff: {
      name: cust.name || 'Customer',
      phone: toE164(cust.phone),
      address: addrObj(quote?.dropoff || cust.address),
      instructions: cust.notes || cust.deliveryNotes || '',
    },
    items: items.map((i) => ({ name: i.name || 'Item', quantity: Number(i.qty) || 1 })),
  };
}
