// supabase/functions/_shared/orderNotifyScope.js
//
// WHICH ORDER AN order-notify CALL IS ABOUT, AND WHICH LEDGER ROW CLAIMS ITS TEXT.
//
// Pure decisions only. No I/O, no Deno, no Supabase: imported by
// supabase/functions/order-notify/index.ts and unit-tested from
// src/lib/orderNotifyScope.test.js under plain node. Keep it that way.
//
// THE DEFECT (finding F13, fixed 14 Sep 2026). Order refs are per VENUE
// (next_order_number counts per location; order_queue's key is
// (location_id, ref) since 20260806k). The notify trigger sent only { ref, event },
// so the function loaded `.eq('ref', ref).maybeSingle()`. When a second venue held
// the same ref, PostgREST answered PGRST116 (2 rows), data came back null and the
// function returned "order gone": the text was silently dropped. The replay ledger
// order_notifications is keyed (ref, event), so a text already sent for venue A's
// R12 also blocked venue B's R12 for ever.
//
// THE FIX, in two halves that can land in either order:
//   * 20260915_OPS_order_notify_by_location.sql makes the trigger send location_id
//     and creates order_notify_ledger keyed (location_id, ref, event).
//   * the function scopes by location ONLY when the payload carries one. A payload
//     without location_id (the trigger before that migration runs) takes exactly
//     today's path: `.eq('ref', ref)` and the (ref, event) ledger.
// The old ledger is never altered, so an OLD deploy of the function keeps working
// after the migration too (it ignores the extra key and uses the old table).

export const LEGACY_LEDGER_TABLE = 'order_notifications';
export const LEDGER_TABLE = 'order_notify_ledger';

// The legacy ledger stops receiving rows once the function scopes by location.
// Allowance around a legacy row's sent_at when matching it to an order. Live (14 Sep 2026):
// the claim stamp lands 15 to 54 ms after sent_at, and created_at is at most 0.34 s before it,
// so 5 minutes is far wider than any gap seen while staying too short to swallow a second
// venue's order placed a few minutes later.
export const LEGACY_LEDGER_SKEW_MS = 5 * 60 * 1000;
// An order goes ready within hours of being placed. A legacy 'ready' row can only belong to
// another venue's unstamped order that was placed inside this window before the text.
export const LEGACY_READY_WINDOW_MS = 12 * 60 * 60 * 1000;

const EVENTS = new Set(['confirmed', 'ready']);

// Request body -> { ref, event, locationId } or { error }. locationId is null when
// the caller did not send one (the pre-migration trigger).
export function parseNotifyPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const ref = String(b.ref || '').trim();
  const event = String(b.event || '').trim();
  if (!ref || !EVENTS.has(event)) return { error: 'ref + event required' };
  const rawLoc = b.location_id;
  const locationId = rawLoc == null ? '' : String(rawLoc).trim();
  return { ref, event, locationId: locationId || null };
}

// Applies the order filters to a PostgREST builder. Without a location this is
// byte for byte the query the function has always sent: `.eq('ref', ref)`.
export function scopeToOrder(query, target) {
  const q = target.locationId ? query.eq('location_id', target.locationId) : query;
  return q.eq('ref', target.ref);
}

// The ledger claim for this call: which table, which row, which conflict target.
export function ledgerClaimFor(target) {
  if (target.locationId) {
    return {
      table: LEDGER_TABLE,
      row: { location_id: target.locationId, ref: target.ref, event: target.event },
      onConflict: 'location_id,ref,event',
    };
  }
  return {
    table: LEGACY_LEDGER_TABLE,
    row: { ref: target.ref, event: target.event },
    onConflict: 'ref,event',
  };
}

// "The table is not there": Postgres undefined_table, or PostgREST's schema cache
// not knowing it. Used when a location arrives before the migration has made the
// new ledger (a hand-made call), so the function falls back to today's ledger.
export function isMissingTableError(error) {
  const code = String(error?.code || '');
  return code === '42P01' || code === 'PGRST205';
}

// The order_queue claim stamp column for an event.
export function stampColumnFor(event) {
  return event === 'confirmed' ? 'notify_confirmed_at' : 'notify_ready_at';
}

// Location-scoped path only: the OTHER venues' orders with this ref, read to work out whose
// order a legacy (ref, event) row was for. Callers select location_id, created_at and both
// stamp columns.
export function scopeToOtherVenues(query, target) {
  return query.eq('ref', target.ref).neq('location_id', target.locationId);
}

const ms = (v) => (v == null || v === '' ? NaN : Date.parse(String(v)));

// Does another venue's order account for a legacy (ref, event) row sent at sentAt?
// The old function could only claim the ledger when exactly one order held the ref, and it
// stamped that order a few ms after the claim. So the legacy row is another venue's when:
//   * that venue's order carries this event's stamp within the allowance of sent_at
//     (it was texted then), or
//   * its order is unstamped (no contact details, so no text went out) and it was the order
//     in play at sent_at: placed at sent_at for 'confirmed', placed within
//     LEGACY_READY_WINDOW_MS before sent_at for 'ready'.
export function legacyRowOwnedElsewhere(sentAt, event, otherVenueRows, skewMs = LEGACY_LEDGER_SKEW_MS) {
  const sentMs = ms(sentAt);
  if (!Number.isFinite(sentMs) || !Array.isArray(otherVenueRows)) return false;
  const col = stampColumnFor(event);
  return otherVenueRows.some((row) => {
    if (!row) return false;
    const stampMs = ms(row[col]);
    if (Number.isFinite(stampMs)) return Math.abs(stampMs - sentMs) <= skewMs;
    if (row[col] != null && row[col] !== '') return false; // unreadable stamp: not proof
    const createdMs = ms(row.created_at);
    if (!Number.isFinite(createdMs)) return false;
    if (event === 'confirmed') return Math.abs(createdMs - sentMs) <= skewMs;
    return createdMs >= sentMs - LEGACY_READY_WINDOW_MS && createdMs <= sentMs + skewMs;
  });
}

// Location-scoped path only: does the OLD (ref, event) ledger say this order was
// already texted? `result` is the { data, error } of reading
// order_notifications.sent_at for (ref, event). The legacy row does not name a venue, and
// refs repeat across venues, so it is matched to an order before it may block.
//   * no legacy row, or no legacy table -> not blocked
//   * any other read error -> blocked (never risk a double text; today a failed
//     ledger claim also skips)
//   * another venue's order accounts for the row (legacyRowOwnedElsewhere) -> not blocked
//   * a legacy row sent BEFORE this order existed (beyond the allowance) was an earlier
//     use of the ref -> not blocked
//   * otherwise (same order, a replay of it, or no created_at to compare) -> blocked
// `otherVenueRows` is the scopeToOtherVenues read; pass [] when that read failed, which
// falls back to the time rule alone.
export function legacyLedgerBlocks(result, orderCreatedAt, { event, otherVenueRows = [], skewMs = LEGACY_LEDGER_SKEW_MS } = {}) {
  if (result?.error) return !isMissingTableError(result.error);
  const sentAt = result?.data?.sent_at;
  if (!sentAt) return false;
  if (event && legacyRowOwnedElsewhere(sentAt, event, otherVenueRows, skewMs)) return false;
  const sentMs = ms(sentAt);
  const createdMs = ms(orderCreatedAt);
  if (!Number.isFinite(sentMs) || !Number.isFinite(createdMs)) return true;
  return createdMs <= sentMs + skewMs;
}
