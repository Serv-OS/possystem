/**
 * hubriseOrder.js — build a HubRise "create order" body from a ServOS delivery order,
 * so the HubRise Uber Direct Bridge can dispatch it. Pure + unit-tested.
 *
 * HubRise money is "<amount> <CCY>" strings; catalog refs (sku_ref) = our internal item
 * ids (matches the existing HubRise catalog push). NOTE: lock the exact HubRise order
 * field names against a connected account — this is the documented shape, best-effort.
 */
import { toE164 } from './manifest.js';

const hrMoney = (amountMajor, ccy = 'GBP') => `${(Number(amountMajor) || 0).toFixed(2)} ${ccy}`;

const splitName = (full) => {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || 'Customer', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
};

const addr = (a) => (typeof a === 'string' ? { line1: a } : (a || {}));

/**
 * @param {object} args
 * @param {object} args.order   closed-check-like record: { ref, items[], total, customer:{name,phone,address,notes} }
 * @param {object} args.quote   accepted DeliveryQuoteService result (customerFeeMinor, dropoff, etaMinutes)
 * @param {string} [args.currency]
 * @returns HubRise create-order body
 */
export function buildHubriseOrder({ order, quote, currency = 'GBP' }) {
  const items = (order?.items || []).filter((i) => !i.voided);
  const cust = order?.customer || {};
  const a = addr(quote?.dropoff || cust.address);
  const { first, last } = splitName(cust.name);
  const feeMajor = (quote?.customerFeeMinor || 0) / 100;

  const body = {
    status: 'new',
    service_type: 'delivery',
    private_ref: order?.ref || null,
    customer: {
      first_name: first,
      last_name: last,
      phone: toE164(cust.phone),
      address_1: a.line1 || '',
      address_2: a.line2 || '',
      city: a.city || '',
      postal_code: a.postcode || '',
      country: a.country || 'GB',
    },
    items: items.map((i) => ({
      product_name: i.name || 'Item',
      sku_name: i.name || 'Item',
      sku_ref: i.itemId || null,        // = our internal item id (matches the pushed catalog)
      price: hrMoney(i.price, currency),
      quantity: Number(i.qty) || 1,
    })),
    total: hrMoney(order?.total, currency),
    customer_notes: cust.notes || cust.deliveryNotes || '',
  };

  if (feeMajor > 0) body.charges = [{ name: 'Delivery', price: hrMoney(feeMajor, currency) }];
  if (quote?.etaMinutes != null) body.expected_time_minutes = quote.etaMinutes;

  return body;
}
