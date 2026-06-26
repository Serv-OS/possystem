// supabase/functions/_shared/delivery-dispatch.ts
//
// ONE server-side, IDEMPOTENT courier-dispatch path, shared by uber-direct (create_delivery,
// client-triggered) and catering-release (the device-independent fire-time cron). Building the
// Uber manifest / HubRise order server-side means there's a single source of truth and the
// cron can dispatch even if no POS device is online. Idempotent on order_ref → a row in
// courier_deliveries means "already dispatched", so client + cron + retries never double-send.
//
// Mirrors src/lib/delivery/manifest.js + hubriseOrder.js (kept as the unit-tested spec).

import { getAccessToken, createDelivery, parseDeliveryResp, mapUberStatus } from './uber.ts';
import { createOrder as createHubriseOrder } from './hubrise.ts';

const ENV = (Deno.env.get('UBER_DIRECT_ENV') ?? 'sandbox') as 'sandbox' | 'prod';
const CLIENT_ID = Deno.env.get('UBER_DIRECT_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('UBER_DIRECT_CLIENT_SECRET') ?? '';
const ENV_CUSTOMER_ID = Deno.env.get('UBER_DIRECT_CUSTOMER_ID') ?? '';

function e164(raw: string): string {
  const s = String(raw || '').replace(/[\s()-]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('0')) return '+44' + s.slice(1);
  if (s.startsWith('44')) return '+' + s;
  return s;
}
const addrObj = (a: any) => (typeof a === 'string' ? { line1: a } : (a || {}));
const addrStr = (a: any) => { const o = addrObj(a); return [o.line1, o.line2, o.city, o.postcode, o.country || 'GB'].filter(Boolean).join(', '); };
const hrMoney = (major: number, ccy: string) => `${(Number(major) || 0).toFixed(2)} ${ccy}`;

/** Build the HubRise create-order body from a ServOS order + quote (mirror of hubriseOrder.js). */
export function buildHubriseOrderServer(order: any, quote: any, currency = 'GBP') {
  const items = (order?.items || []).filter((i: any) => !i.voided);
  const cust = order?.customer || {};
  const a = addrObj(quote?.dropoff || cust.address);
  const full = String(cust.name || '').trim().split(/\s+/);
  const feeMajor = (quote?.customerFeeMinor || 0) / 100;
  const body: any = {
    status: 'new', service_type: 'delivery', private_ref: order?.ref || null,
    customer: {
      first_name: full[0] || 'Customer', last_name: full.slice(1).join(' '),
      phone: e164(cust.phone), address_1: a.line1 || '', address_2: a.line2 || '',
      city: a.city || '', postal_code: a.postcode || '', country: a.country || 'GB',
    },
    items: items.map((i: any) => ({ product_name: i.name || 'Item', sku_name: i.name || 'Item', sku_ref: i.itemId || null, price: hrMoney(i.price, currency), quantity: Number(i.qty) || 1 })),
    total: hrMoney(order?.total, currency),
    customer_notes: cust.notes || cust.deliveryNotes || '',
  };
  if (feeMajor > 0) body.charges = [{ name: 'Delivery', price: hrMoney(feeMajor, currency) }];
  return body;
}

/** Build the Uber create-delivery manifest from a ServOS order + quote + venue pickup config. */
export function buildManifestServer(order: any, quote: any, cfg: any) {
  const items = (order?.items || []).filter((i: any) => !i.voided);
  const cust = order?.customer || {};
  return {
    quote_id: quote?.quoteId || null,
    manifest_reference: order?.ref || null,
    manifest_total_value: items.reduce((s: number, i: any) => s + Math.round((Number(i.price) || 0) * (Number(i.qty) || 1) * 100), 0),
    currency: quote?.currency || 'GBP',
    pickup: { name: cfg?.pickup_contact?.name || 'Restaurant', phone: e164(cfg?.pickup_contact?.phone || ''), address: cfg?.pickup_address || null, instructions: cfg?.pickup_contact?.instructions || '' },
    dropoff: { name: cust.name || 'Customer', phone: e164(cust.phone), address: addrObj(quote?.dropoff || cust.address), instructions: cust.notes || '' },
    items: items.map((i: any) => ({ name: i.name || 'Item', quantity: Number(i.qty) || 1 })),
  };
}

/**
 * Dispatch a courier for one order, IDEMPOTENTLY (skips if courier_deliveries already has a row
 * for this order_ref). Routes by cfg.dispatch_backend. Returns a result the caller can act on
 * (e.g. send a tracking SMS). Throws nothing fatal — returns {ok:false,reason} on problems.
 */
export async function dispatchCourier(sb: any, { loc, cfg, order, quote }: { loc: string; cfg: any; order: any; quote: any }) {
  const orderRef = order?.ref || null;
  // Idempotency: a row for this order means it's already been dispatched.
  if (orderRef) {
    const { data: existing } = await sb.from('courier_deliveries').select('id, tracking_url').eq('location_id', loc).eq('order_ref', orderRef).maybeSingle();
    if (existing) return { ok: true, skipped: true, deliveryRowId: existing.id, trackingUrl: existing.tracking_url || null };
  }

  try {
    if (cfg.dispatch_backend === 'hubrise_bridge') {
      const { data: conn } = await sb.from('hubrise_connections').select('access_token, hubrise_location_id').eq('location_id', loc).maybeSingle();
      if (!conn?.access_token || !conn?.hubrise_location_id) return { ok: false, reason: 'hubrise_not_connected' };
      const created = await createHubriseOrder(conn.access_token, conn.hubrise_location_id, buildHubriseOrderServer(order, quote, quote?.currency || 'GBP'));
      const hubriseRef = created?.id || created?.order_id || null;
      const { data: row } = await sb.from('courier_deliveries').insert({ location_id: loc, order_ref: orderRef, dispatch_backend: 'hubrise_bridge', status: 'pending', hubrise_ref: hubriseRef }).select('id').maybeSingle();
      return { ok: true, backend: 'hubrise_bridge', deliveryRowId: row?.id || null, hubriseRef };
    }

    // uber_api
    const customerId = cfg.uber_customer_id || ENV_CUSTOMER_ID;
    const env = (cfg.env || ENV) as 'sandbox' | 'prod';
    if (!CLIENT_ID || !CLIENT_SECRET || !customerId) return { ok: false, reason: 'not_configured' };
    const token = await getAccessToken(env, CLIENT_ID, CLIENT_SECRET);
    const resp = await createDelivery({ env, token, customerId, manifest: buildManifestServer(order, quote, cfg) });
    const p = parseDeliveryResp(resp);
    const status = mapUberStatus(p.rawStatus);
    const { data: row } = await sb.from('courier_deliveries').insert({
      location_id: loc, order_ref: orderRef, dispatch_backend: 'uber_api',
      uber_delivery_id: p.id, status, tracking_url: p.trackingUrl,
      courier_name: p.courierName, courier_phone: p.courierPhone, last_lat: p.lat, last_lng: p.lng,
    }).select('id').maybeSingle();
    return { ok: true, deliveryRowId: row?.id || null, deliveryId: p.id, trackingUrl: p.trackingUrl, status };
  } catch (e) {
    return { ok: false, reason: 'dispatch_failed', error: String((e as Error)?.message || e) };
  }
}
