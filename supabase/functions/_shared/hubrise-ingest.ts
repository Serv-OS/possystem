// supabase/functions/_shared/hubrise-ingest.ts
//
// DB-touching HubRise helpers shared by more than one edge function (webhook,
// reconcile, inventory-push, order-status). Each takes the service-role supabase
// client as a parameter so it works in any function. Keeping these here avoids
// cross-function imports (each edge function is a separate deploy/bundle).

import { getOrder, patchOrder, putInventory } from './hubrise.ts';
import { orderToQueueRow, hrToQueueStatus } from './hubrise-map.ts';

const TERMINAL = new Set(['rejected', 'cancelled', 'delivery_failed']);

// Only columns guaranteed on every venue's order_queue (QueueSync's safe set). Payment
// status + HubRise ids ride in the customer jsonb so an insert never trips a missing column.
function queuePayload(row: any, isNew: boolean) {
  const p: any = {
    ref: row.ref, location_id: row.location_id, type: row.type, customer: row.customer,
    items: row.items, total: row.total, status: row.status, source: 'hubrise',
    is_asap: row.is_asap, collection_time: row.collection_time,
  };
  if (isNew) { p.created_at = row.created_at; p.sent_at = new Date().toISOString(); }
  return p;
}

/** Ingest one HubRise order into order_queue. Idempotent + monotonic. */
export async function ingestOrder(sb: any, opsLocationId: string, order: any, eventCreatedAt: string | null) {
  if (!order?.id) return;
  const { row, link } = orderToQueueRow(order, { locationId: opsLocationId });

  const { data: existingLink } = await sb.from('hubrise_order_links')
    .select('last_event_created_at, pushed_status').eq('hubrise_order_id', order.id).maybeSingle();
  if (existingLink?.last_event_created_at && eventCreatedAt &&
      new Date(eventCreatedAt) < new Date(existingLink.last_event_created_at)) return;

  const { data: existingRow } = await sb.from('order_queue').select('ref, status').eq('ref', row.ref).maybeSingle();
  const { data: conn } = await sb.from('hubrise_connections')
    .select('access_token, auto_accept, default_prep_minutes').eq('location_id', opsLocationId).maybeSingle();

  const incomingNew = (order.status || 'new') === 'new';
  const autoAccept = incomingNew && !!conn?.auto_accept;
  const terminal = TERMINAL.has(order.status);

  // Initial local status: a brand-new order is 'received' — or 'prep' when the venue
  // auto-accepts (which signals the realtime client to auto-print). Existing orders keep
  // their prep progress unless HubRise now reports a terminal (cancelled) state.
  const status = existingRow
    ? (terminal ? 'cancelled' : existingRow.status)
    : (terminal ? 'cancelled' : (autoAccept ? 'prep' : hrToQueueStatus(order.status || 'new')));

  await sb.from('order_queue').upsert(queuePayload({ ...row, status }, !existingRow), { onConflict: 'ref' });

  await sb.from('hubrise_order_links').upsert({
    ...link, hr_status: order.status || 'new',
    last_event_created_at: eventCreatedAt || new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'ref' });

  // COMPLIANCE — acknowledge a new order back to HubRise. HubRise requires the EPOS to move
  // new -> 'received' on ingest (suppresses the channel's "order not picked up" alerts). If the
  // venue auto-accepts, jump straight to 'accepted'.
  //
  // Per HubRise's sign-off review (22 Jul 2026):
  //   - NO private_ref: not needed — our ref already lives on hubrise_order_links, and
  //     HubRise dedups on its own order id.
  //   - NO confirmed_time on a plain accept: confirmed_time is ONLY for telling the channel
  //     the restaurant is DELAYING beyond the requested/ASAP time. Accepting on time is
  //     implicit confirmation of the requested time. (When one IS sent — the explicit-delay
  //     path in hubrise-order-status — it goes in STORE-LOCAL time, not UTC.)
  // Best-effort: failures are retried by the reconcile cron.
  if (incomingNew && conn?.access_token && !(existingLink && existingLink.pushed_status)) {
    try {
      await patchOrderStatus(sb, row.ref, autoAccept ? 'accepted' : 'received', null, null);
    } catch { /* reconcile retries via link.push_error */ }
  }
}

/**
 * Format a Date as an ISO-8601 string in the STORE'S local offset, borrowed from one of
 * HubRise's own timestamps on the order (they arrive store-local with offset, e.g.
 * "2026-07-22T19:30:00+01:00"). HubRise accepts UTC too, but their integration review
 * asked for local time for readability. No offset to borrow -> fall back to UTC.
 */
export function toStoreLocalIso(d: Date, refIso?: string | null): string {
  const m = typeof refIso === 'string' ? refIso.match(/([+-]\d{2}):?(\d{2})$/) : null;
  if (!m) return d.toISOString();
  const sign = m[1].startsWith('-') ? -1 : 1;
  const offMin = sign * (Math.abs(parseInt(m[1], 10)) * 60 + parseInt(m[2], 10));
  const t = new Date(d.getTime() + offMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
    + `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}${m[1]}:${m[2]}`;
}

/** Fetch the full order then ingest (used by the passive-event reconcile path). */
export async function fetchAndIngest(sb: any, loc: string, token: string, hubLocId: string, orderId: string, eventCreatedAt: string | null) {
  const order = await getOrder(token, hubLocId, orderId);
  if (order?.id) await ingestOrder(sb, loc, order, eventCreatedAt);
}

/** Full inventory resync: PUT the complete out-of-stock set (86'd + stock<=0). */
export async function resyncInventory(sb: any, loc: string): Promise<{ outOfStock: number } | { skipped: string }> {
  const { data: conn } = await sb.from('hubrise_connections').select('access_token, hubrise_catalog_id').eq('location_id', loc).maybeSingle();
  if (!conn?.access_token) return { skipped: 'not connected' };
  if (!conn.hubrise_catalog_id) return { skipped: 'no catalog' };

  const [{ data: eightySix }, { data: stock }] = await Promise.all([
    sb.from('eighty_six').select('item_id').eq('location_id', loc),
    sb.from('stock_levels').select('item_id, remaining').eq('location_id', loc).lte('remaining', 0),
  ]);
  const ids = new Set<string>();
  (eightySix || []).forEach((r: any) => r.item_id && ids.add(String(r.item_id)));
  (stock || []).forEach((r: any) => r.item_id && ids.add(String(r.item_id)));
  // Our catalog uses the item id as BOTH the sku ref (standalone) and (when name-matched)
  // the option ref — so push each 86'd id as sku_ref AND option_ref to cover items sold both
  // ways. If HubRise rejects unknown option refs, fall back to sku-only so 86 still applies.
  const skuEntries = [...ids].map((id) => ({ sku_ref: id, stock: '0' }));
  const allEntries = [...skuEntries, ...[...ids].map((id) => ({ option_ref: id, stock: '0' }))];

  try {
    try { await putInventory(conn.access_token, conn.hubrise_catalog_id, allEntries); }
    catch { await putInventory(conn.access_token, conn.hubrise_catalog_id, skuEntries); }
    await sb.from('hubrise_connections').update({ inventory_synced_at: new Date().toISOString(), inventory_sync_error: null }).eq('location_id', loc);
  } catch (e) {
    await sb.from('hubrise_connections').update({ inventory_sync_error: e instanceof Error ? e.message : String(e) }).eq('location_id', loc);
    throw e;
  }
  return { outOfStock: ids.size };
}

/** PATCH a HubRise order's status + record the result on the link row. */
export async function patchOrderStatus(sb: any, ref: string, hrStatus: string, confirmedTime?: string | null, reason?: string | null, extra?: Record<string, unknown> | null) {
  const { data: link } = await sb.from('hubrise_order_links').select('*').eq('ref', ref).maybeSingle();
  if (!link) throw new Error('not a HubRise order');
  const { data: conn } = await sb.from('hubrise_connections').select('access_token').eq('location_id', link.location_id).maybeSingle();
  if (!conn?.access_token) throw new Error('not connected');

  const body: Record<string, unknown> = { status: hrStatus };
  if (confirmedTime) body.confirmed_time = confirmedTime;
  if (reason) body.seller_notes = reason;
  if (extra) Object.assign(body, extra);   // extra top-level PATCH fields (rarely needed)
  const now = new Date().toISOString();
  try {
    await patchOrder(conn.access_token, link.hubrise_location_id, link.hubrise_order_id, body);
    await sb.from('hubrise_order_links').update({ pushed_status: hrStatus, pushed_at: now, push_error: null, updated_at: now }).eq('ref', ref);
  } catch (e) {
    await sb.from('hubrise_order_links').update({ pushed_status: hrStatus, push_error: e instanceof Error ? e.message : String(e), updated_at: now }).eq('ref', ref);
    throw e;
  }
}
