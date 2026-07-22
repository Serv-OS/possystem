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

  // Ref surfacing for the HubRise sign-off: log per-channel payment name/ref codes so they are
  // visible in the edge-fn logs (webhook + reconcile both funnel through here).
  if (row.customer?.payments?.length) {
    console.log('[hubrise] payments', row.customer.channel, JSON.stringify(row.customer.payments));
  }

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

  // Paid channel orders book into closed_checks at ACCEPT (v5.5.854) — so a channel-side
  // cancellation/rejection arriving after that must VOID the booked check or reports and
  // EOD overstate revenue. Voiding (not deleting) keeps the audit trail; SalesSummary /
  // Exceptions already treat status='voided' as a void. Idempotent + best-effort.
  if (terminal) {
    try {
      await sb.from('closed_checks').update({ status: 'voided' })
        .eq('id', `chk-hr-${row.ref}`).eq('source', 'hubrise').eq('status', 'paid');
    } catch { /* never fail ingest on this */ }
  }

  // CRM — flow the channel customer into the venue customer DB (Back Office → Customers),
  // mirroring the online-checkout attribution path. Runs ONLY on FIRST sight of the order
  // (existingRow null) so webhook retries and reconcile replays can never double-count a
  // visit. An order that arrives already-cancelled still records the contact, but not a
  // visit/spend. Best-effort by doctrine: a CRM blip must never fail order ingest.
  if (!existingRow) {
    try {
      await upsertChannelCustomer(sb, opsLocationId, row, {
        countOrder: !terminal,
        firstName: order?.customer?.first_name || null,
        lastName: order?.customer?.last_name || null,
      });
    } catch (e) {
      console.warn('[hubrise] customer upsert failed:', e instanceof Error ? e.message : String(e));
    }
  }

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

// ── Channel-order CRM upsert ─────────────────────────────────────────────────
// Server-side mirror of the online-checkout attribution path (attributeOnlineOrder in
// src/lib/customerLookup.js) and the wifi-capture edge fn: the venue customer DB is the
// ops `customers` table keyed by (org_id, phone) — email as fallback key — with
// fill-blanks-only patches, then customer_locations visit stats + a denormalised
// customer_orders history row. Same lookup-then-insert/update pattern as every existing
// writer (no reliance on a unique constraint).
//
// Channel specifics:
//   - phone is already E.164-normalised by orderToQueueRow's toE164 (same key space as
//     the POS/online normalisers); channel PROXY numbers are stored as-is — no extra
//     validity rules invented here.
//   - the 'HubRise customer' placeholder name is never written, so it can never mask or
//     block a real name (insert stores null; patch only fills a blank with a real name).
//   - marketing consent is one-way: a channel pref can GRANT opt-in, never withdraw one.
//   - customers has NO address columns (see 20260615_wifi_capture.sql header) — delivery
//     addresses stay on order_queue.customer.address, like the online path.
const HR_PLACEHOLDER_NAME = 'HubRise customer';

export async function upsertChannelCustomer(
  sb: any, opsLocationId: string, row: any,
  opts?: { countOrder?: boolean; firstName?: string | null; lastName?: string | null },
) {
  const c = row?.customer || {};
  const phone = String(c.phone || '').trim();
  const email = String(c.email || '').trim().toLowerCase().slice(0, 200);
  if (!phone && !email) return;                      // nothing to key on → skip (task rule)

  // org_id (ops locations) is the customers tenant key — same resolution as wifi-capture.
  const { data: loc } = await sb.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  const orgId = loc?.org_id;
  if (!orgId) { console.warn('[hubrise] customer upsert skipped — no org_id for location', opsLocationId); return; }

  const rawName = String(c.name || '').trim();
  const name = rawName && rawName !== HR_PLACEHOLDER_NAME ? rawName.slice(0, 120) : null;
  const firstName = opts?.firstName ? String(opts.firstName).trim().slice(0, 80) : null;
  const lastName = opts?.lastName ? String(opts.lastName).trim().slice(0, 80) : null;
  const phoneRaw = phone ? String(c.phoneRaw || phone).slice(0, 40) : null;
  const source = `hubrise:${c.channel || 'HubRise'}`;  // e.g. hubrise:Deliveroo
  const optIn = c.marketingPrefs?.sms === true || c.marketingPrefs?.email === true;
  const nowIso = new Date().toISOString();

  // Match by phone first, else by (org_id, lower(email)) — same order as wifi-capture.
  const COLS = 'id, name, first_name, last_name, email, phone, marketing_opt_in, source, sources';
  let existing: any = null;
  if (phone) {
    const { data } = await sb.from('customers').select(COLS)
      .eq('org_id', orgId).eq('phone', phone).is('deleted_at', null).maybeSingle();
    existing = data || null;
  }
  if (!existing && email) {
    const { data } = await sb.from('customers').select(COLS)
      .eq('org_id', orgId).ilike('email', email).is('deleted_at', null).maybeSingle();
    existing = data || null;
  }

  let customerId: string | null = null;
  if (existing) {
    // Fill blanks only — never clobber operator-curated data.
    const patch: Record<string, unknown> = { updated_at: nowIso };
    if (name && !existing.name) patch.name = name;
    if (firstName && !existing.first_name) patch.first_name = firstName;
    if (lastName && !existing.last_name) patch.last_name = lastName;
    if (email && !existing.email) patch.email = email;
    if (phone && !existing.phone) { patch.phone = phone; patch.phone_raw = phoneRaw; }
    const sources: string[] = Array.isArray(existing.sources) ? existing.sources : [];
    if (!sources.includes(source)) patch.sources = [...sources, source];
    if (!existing.source) patch.source = source;
    if (optIn && !existing.marketing_opt_in) { patch.marketing_opt_in = true; patch.marketing_opt_in_at = nowIso; }
    const { error } = await sb.from('customers').update(patch).eq('id', existing.id);
    if (error) { console.warn('[hubrise] customer update failed:', error.message); return; }
    customerId = existing.id;
  } else {
    const { data: ins, error } = await sb.from('customers').insert({
      org_id: orgId,
      phone: phone || null, phone_raw: phoneRaw,
      email: email || null,
      name, first_name: firstName, last_name: lastName,
      source, sources: [source],
      marketing_opt_in: optIn, marketing_opt_in_at: optIn ? nowIso : null,
    }).select('id').single();
    if (error) { console.warn('[hubrise] customer insert failed:', error.message); return; }
    customerId = ins?.id || null;
  }
  if (!customerId || opts?.countOrder === false) return;

  // Visit stats + order history — read-then-write like both existing paths. The caller
  // only invokes this on first sight of the order, which is the idempotency guarantee.
  try {
    const total = Number(row.total) || 0;
    const { data: cl } = await sb.from('customer_locations')
      .select('visit_count, lifetime_revenue')
      .eq('customer_id', customerId).eq('location_id', opsLocationId).maybeSingle();
    if (cl) {
      await sb.from('customer_locations').update({
        visit_count: (Number(cl.visit_count) || 0) + 1,
        lifetime_revenue: (Number(cl.lifetime_revenue) || 0) + total,
        last_visit_at: nowIso,
      }).eq('customer_id', customerId).eq('location_id', opsLocationId);
    } else {
      await sb.from('customer_locations').insert({
        customer_id: customerId, location_id: opsLocationId,
        visit_count: 1, lifetime_revenue: total,
        first_visit_at: nowIso, last_visit_at: nowIso,
      });
    }
    await sb.from('customer_orders').insert({
      customer_id: customerId, location_id: opsLocationId,
      closed_check_id: row.ref || null,                // HR-<order id> — audit link back to the queue row
      ordered_at: row.created_at || nowIso,
      total, channel: source,
      item_summary: (row.items || []).map((i: any) => ({ name: i.name, qty: i.qty, price: i.price })),
    });
  } catch (e) {
    console.warn('[hubrise] visit/order attribution failed:', e instanceof Error ? e.message : String(e));
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
