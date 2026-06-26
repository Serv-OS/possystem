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
 * Dispatch a courier for one order, IDEMPOTENTLY, using RESERVE-THEN-ACT: claim the order_ref by
 * inserting the courier_deliveries row FIRST (the unique index courier_deliveries_order_ref_uidx
 * makes the claim atomic), THEN call Uber/HubRise, THEN fill in the result. A duplicate claim →
 * skip. This closes the "external dispatch succeeded but the row insert failed → retry double-
 * sends" window. Returns a result the caller can act on (e.g. a tracking SMS). Never throws.
 */
export async function dispatchCourier(sb: any, { loc, cfg, order, quote }: { loc: string; cfg: any; order: any; quote: any }) {
  const orderRef = order?.ref || null;

  // 1) Reserve the order_ref (atomic via the unique index). A conflict means someone already
  //    claimed/dispatched it → skip (return the existing row).
  let rowId: string | null = null;
  if (orderRef) {
    const ins = await sb.from('courier_deliveries')
      .insert({ location_id: loc, order_ref: orderRef, dispatch_backend: cfg.dispatch_backend || 'uber_api', status: 'dispatching' })
      .select('id').maybeSingle();
    if (ins.error) {
      const { data: ex } = await sb.from('courier_deliveries').select('id, tracking_url').eq('location_id', loc).eq('order_ref', orderRef).maybeSingle();
      return { ok: true, skipped: true, deliveryRowId: ex?.id || null, trackingUrl: ex?.tracking_url || null };
    }
    rowId = ins.data?.id || null;
  }

  // Release the reservation on a CONFIG problem (so a corrected retry can run); mark 'failed' on
  // a transient dispatch error (visible on the board; retryable).
  const fail = async (reason: string, extra: Record<string, unknown> = {}) => {
    if (rowId && (reason === 'not_configured' || reason === 'hubrise_not_connected')) await sb.from('courier_deliveries').delete().eq('id', rowId);
    else if (rowId) await sb.from('courier_deliveries').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', rowId);
    return { ok: false, reason, ...extra };
  };

  try {
    // 2) Dispatch + 3) fill in the result on the reserved row.
    if (cfg.dispatch_backend === 'hubrise_bridge') {
      const { data: conn } = await sb.from('hubrise_connections').select('access_token, hubrise_location_id').eq('location_id', loc).maybeSingle();
      if (!conn?.access_token || !conn?.hubrise_location_id) return await fail('hubrise_not_connected');
      const created = await createHubriseOrder(conn.access_token, conn.hubrise_location_id, buildHubriseOrderServer(order, quote, quote?.currency || 'GBP'));
      const hubriseRef = created?.id || created?.order_id || null;
      if (rowId) await sb.from('courier_deliveries').update({ hubrise_ref: hubriseRef, status: 'pending', updated_at: new Date().toISOString() }).eq('id', rowId);
      return { ok: true, backend: 'hubrise_bridge', deliveryRowId: rowId, hubriseRef };
    }

    // uber_api
    const customerId = cfg.uber_customer_id || ENV_CUSTOMER_ID;
    const env = (cfg.env || ENV) as 'sandbox' | 'prod';
    if (!CLIENT_ID || !CLIENT_SECRET || !customerId) return await fail('not_configured');
    const token = await getAccessToken(env, CLIENT_ID, CLIENT_SECRET);
    const resp = await createDelivery({ env, token, customerId, manifest: buildManifestServer(order, quote, cfg) });
    const p = parseDeliveryResp(resp);
    const status = mapUberStatus(p.rawStatus);
    if (rowId) await sb.from('courier_deliveries').update({
      uber_delivery_id: p.id, status, tracking_url: p.trackingUrl,
      courier_name: p.courierName, courier_phone: p.courierPhone, last_lat: p.lat, last_lng: p.lng, updated_at: new Date().toISOString(),
    }).eq('id', rowId);
    return { ok: true, deliveryRowId: rowId, deliveryId: p.id, trackingUrl: p.trackingUrl, status };
  } catch (e) {
    return await fail('dispatch_failed', { error: String((e as Error)?.message || e) });
  }
}
