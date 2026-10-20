// channels.mjs: one sale (and its refund or void) through every order channel, written the way each
// writer writes it, then drained by the REAL central drainer (20261018c, stock_outbox_drain). run.mjs
// books the same events on a copy of the database before 0a and on a copy after 0a and asks for
// identical movements: every channel takes stock off exactly as before (map 9.1), refunded food is
// waste, a void of fired food is waste.
//
// Writers (as live): the till, the kiosk and the MPOS phone are bound devices (anonymous sessions)
// that insert closed_checks themselves; pay at table is the till's own check (source
// adyen_pay_at_table); online, QR and catering checks are written by a server function in one
// transaction with their payment proof (the paid order token, or a payment_proofs row bound to
// venue:ref), called by the customer's session; HubRise and ezCater checks are written by their edge
// functions with the service role. Refunds and voids are the till's updates of its own check.

import { lit } from './base.mjs';

// Two server functions shaped like place_public_order and settle_qr_tab (the check and its proof in
// one transaction). Harness only: names outside every stock prefix.
export const CHANNEL_SETUP = `
create or replace function public.harness_public_order(p_loc text, p_ref text, p_id text, p_source text, p_type text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into closed_checks (id, location_id, items, order_type, source, ref) values (p_id, p_loc, p_items, p_type, p_source, p_ref);
  insert into public_order_tokens (location_id, ref, paid) values (p_loc, p_ref, true);
end $$;
create or replace function public.harness_settle_qr(p_loc text, p_ref text, p_id text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into closed_checks (id, location_id, items, order_type, source, ref) values (p_id, p_loc, p_items, 'dine-in', 'qr', p_ref);
  insert into payment_proofs (location_id, used_by_ref) values (p_loc, p_loc || ':' || p_ref);
end $$;
revoke all on function public.harness_public_order(text,text,text,text,text,jsonb) from public, anon;
revoke all on function public.harness_settle_qr(text,text,text,jsonb) from public, anon;
grant execute on function public.harness_public_order(text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.harness_settle_qr(text,text,text,jsonb) to authenticated;
`;

const insertCheck = (row) => `insert into closed_checks (id, location_id, items, order_type, source, ref, status, voided, refunds)
  select x.id, x.location_id, coalesce(x.items, '[]'), x.order_type, x.source, x.ref, coalesce(x.status, 'paid'), coalesce(x.voided, false), coalesce(x.refunds, '[]')
    from jsonb_populate_record(null::closed_checks, ${lit(JSON.stringify(row))}::jsonb) x`;

// The events at one venue. menu: { a, b, c } three of the venue's till products (c may be a pack
// line dish); dev: { till, kiosk, mpos } caller keys (a venue with one till uses it for all three).
export function channelEvents(prefix, loc, menu, dev) {
  const line = (itemId, qty, extra = {}) => ({ itemId, qty, ...extra });
  const e = [];
  e.push({ name: 'till', caller: dev.till, sql: insertCheck({ id: `${prefix}-till`, location_id: loc, ref: `${prefix}T1`, source: 'pos', order_type: 'dine-in',
    items: [line(menu.a, 2, { uid: 'u1' }), line(menu.b, 1, { uid: 'u2' }), line(menu.c, 1, { uid: 'u3' })] }) });
  e.push({ name: 'kiosk', caller: dev.kiosk, sql: insertCheck({ id: `${prefix}-kiosk`, location_id: loc, ref: `${prefix}K1`, source: 'kiosk', order_type: 'takeaway',
    items: [line(menu.a, 1), line(menu.b, 2)] }) });
  e.push({ name: 'online', caller: 'customer', sql: `select public.harness_public_order('${loc}', '${prefix}OL1', '${prefix}-online', 'online', 'collection', ${lit(JSON.stringify([line(menu.a, 1), line(menu.c, 1)]))}::jsonb)` });
  e.push({ name: 'qr', caller: 'customer', sql: `select public.harness_settle_qr('${loc}', '${prefix}QR1', '${prefix}-qr', ${lit(JSON.stringify([line(menu.b, 1)]))}::jsonb)` });
  e.push({ name: 'catering', caller: 'customer', sql: `select public.harness_public_order('${loc}', '${prefix}CT1', '${prefix}-catering', 'catering', 'catering', ${lit(JSON.stringify([line(menu.a, 6)]))}::jsonb)` });
  e.push({ name: 'pay at table', caller: dev.till, sql: insertCheck({ id: `${prefix}-pat`, location_id: loc, ref: `${prefix}PT1`, source: 'adyen_pay_at_table', order_type: 'dine-in',
    items: [line(menu.b, 1), line(menu.c, 2)] }) });
  e.push({ name: 'MPOS', caller: dev.mpos, sql: insertCheck({ id: `${prefix}-mpos`, location_id: loc, ref: `${prefix}MP1`, source: 'mpos_adyen_local', order_type: 'dine-in',
    items: [line(menu.a, 1)] }) });
  e.push({ name: 'HubRise', caller: 'service', sql: insertCheck({ id: `${prefix}-hubrise`, location_id: loc, ref: `${prefix}HR1`, source: 'hubrise', order_type: 'delivery',
    items: [line(menu.a, 1), line(menu.b, 1)] }) });
  e.push({ name: 'ezCater', caller: 'service', sql: insertCheck({ id: `${prefix}-ezcater`, location_id: loc, ref: `${prefix}EZ1`, source: 'ezcater', order_type: 'catering',
    items: [line(menu.c, 3)] }) });
  e.push({ name: 'void', caller: dev.till, sql: insertCheck({ id: `${prefix}-void`, location_id: loc, ref: `${prefix}V1`, source: 'pos', order_type: 'dine-in', status: 'voided', voided: true,
    items: [line(menu.a, 1, { fired: true, status: 'voided', voided: true }), line(menu.b, 1, { voided: true })] }) });
  return e;
}

// The refund of part of the till check (applied after its sale is drained): refunded food is waste.
export function refundEvent(prefix, menu, dev) {
  const entry = { id: `${prefix}-ref1`, timestamp: Date.now(), items: [{ uid: 'u1', itemId: menu.a, qty: 2, refundQty: 1 }], isFullRefund: false, amount: 3 };
  return { name: 'refund', caller: dev.till, sql: `update closed_checks set refunds = coalesce(refunds, '[]'::jsonb) || ${lit(JSON.stringify([entry]))}::jsonb, status = 'partial_refund' where id = '${prefix}-till'` };
}

export const drainSql = 'call public.stock_outbox_drain(10, 50, 0.05, true);';

// What the events booked: every movement and waste row whose source is one of the checks, with the
// ids and times taken out (so a copy before 0a and a copy after 0a compare directly).
// (the fixture has no waste of its own, so every waste row at the venue is one these events made)
export function bookedSql(prefix, loc) {
  return `select json_build_object(
    'movements', (select coalesce(json_agg(json_build_object('check', m.source_id, 'item', m.inventory_item_id, 'type', m.movement_type,
                    'qty', m.qty_base, 'value', m.value_delta, 'key', m.idempotency_key, 'source', m.source_type) order by m.idempotency_key), '[]')
                  from stock_movements m where m.source_id like '${prefix}-%'),
    'waste', (select coalesce(json_agg(json_build_object('item', w.inventory_item_id, 'qty', w.qty_base, 'reason', w.reason, 'source', w.source, 'value', w.cost_value)
                    order by w.inventory_item_id, w.reason, w.qty_base), '[]')
               from waste_events w where w.location_id = '${loc}'),
    'outbox', (select coalesce(json_agg(json_build_object('check', o.check_id, 'kind', o.kind, 'writer', o.writer, 'status', o.status, 'flags', o.flags)
                    order by o.check_id, o.kind, o.event_ref), '[]')
                from stock_outbox o where o.check_id like '${prefix}-%'))`;
}
