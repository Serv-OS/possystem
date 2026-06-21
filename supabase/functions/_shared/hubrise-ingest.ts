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
    .select('last_event_created_at').eq('hubrise_order_id', order.id).maybeSingle();
  if (existingLink?.last_event_created_at && eventCreatedAt &&
      new Date(eventCreatedAt) < new Date(existingLink.last_event_created_at)) return;

  const { data: existingRow } = await sb.from('order_queue').select('ref, status').eq('ref', row.ref).maybeSingle();
  const terminal = TERMINAL.has(order.status);
  const status = !existingRow ? hrToQueueStatus(order.status || 'new') : (terminal ? 'cancelled' : existingRow.status);

  await sb.from('order_queue').upsert(queuePayload({ ...row, status }, !existingRow), { onConflict: 'ref' });

  await sb.from('hubrise_order_links').upsert({
    ...link, hr_status: order.status || 'new',
    last_event_created_at: eventCreatedAt || new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'ref' });
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
  const entries = [...ids].map((id) => ({ sku_ref: id, stock: '0' }));

  try {
    await putInventory(conn.access_token, conn.hubrise_catalog_id, entries);
    await sb.from('hubrise_connections').update({ inventory_synced_at: new Date().toISOString(), inventory_sync_error: null }).eq('location_id', loc);
  } catch (e) {
    await sb.from('hubrise_connections').update({ inventory_sync_error: e instanceof Error ? e.message : String(e) }).eq('location_id', loc);
    throw e;
  }
  return { outOfStock: entries.length };
}

/** PATCH a HubRise order's status + record the result on the link row. */
export async function patchOrderStatus(sb: any, ref: string, hrStatus: string, confirmedTime?: string | null, reason?: string | null) {
  const { data: link } = await sb.from('hubrise_order_links').select('*').eq('ref', ref).maybeSingle();
  if (!link) throw new Error('not a HubRise order');
  const { data: conn } = await sb.from('hubrise_connections').select('access_token').eq('location_id', link.location_id).maybeSingle();
  if (!conn?.access_token) throw new Error('not connected');

  const body: Record<string, unknown> = { status: hrStatus };
  if (confirmedTime) body.confirmed_time = confirmedTime;
  if (reason) body.seller_notes = reason;
  const now = new Date().toISOString();
  try {
    await patchOrder(conn.access_token, link.hubrise_location_id, link.hubrise_order_id, body);
    await sb.from('hubrise_order_links').update({ pushed_status: hrStatus, pushed_at: now, push_error: null, updated_at: now }).eq('ref', ref);
  } catch (e) {
    await sb.from('hubrise_order_links').update({ pushed_status: hrStatus, push_error: e instanceof Error ? e.message : String(e), updated_at: now }).eq('ref', ref);
    throw e;
  }
}
