// src/lib/kds/kdsTicketReplay.js
//
// 12 Oct 2026, Barnsley hunt (reproduced on the real code, not the cause that day): a till's
// kitchen ticket whose insert looked failed was queued as an UPSERT carrying status 'pending' and
// the items as sent. Replayed after the kitchen had bumped the ticket, it put the ticket back to
// pending and wiped the ticks. Nobody had touched it.
//
// The rule (K7): a kitchen ticket is inserted ONCE. A replay may create a ticket that is missing;
// it can never change one that exists (INSERT ... ON CONFLICT DO NOTHING).
//
// Pure: no Supabase, no storage.

export const KDS_TICKETS = 'kds_tickets';

/** The queue item for a kitchen ticket whose first insert did not confirm. */
export function kitchenTicketQueueItem(row) {
  return { type: 'upsert', table: KDS_TICKETS, payload: row, onConflict: 'id', ignoreDuplicates: true };
}

/**
 * The options a queued upsert is replayed with. A kitchen ticket is ALWAYS insert if missing,
 * whatever the queued item says (a till may still hold items queued by an older build, which
 * carry no flag). Every other table gets exactly what it got before: { onConflict }.
 */
export function replayUpsertOptions(item) {
  const onConflict = (item && item.onConflict) || 'id';
  if ((item && item.table) === KDS_TICKETS || (item && item.ignoreDuplicates === true)) return { onConflict, ignoreDuplicates: true };
  return { onConflict };
}

/**
 * The key that groups queued upserts into one batched statement. A "merge" upsert and an "insert
 * if missing" upsert never share a statement (one statement has one conflict rule). For every
 * table but kitchen tickets this is the key the queue always used.
 */
export const upsertRunKey = (item) => `u|${item.table}|${item.onConflict || 'id'}${replayUpsertOptions(item).ignoreDuplicates ? '|keep' : ''}`;

/**
 * The database says the row is already there: the ticket WAS inserted, only the answer was lost
 * (or the request was sent twice). kds_tickets has one unique rule, its id (checked on the live
 * database, 12 Oct 2026), so a duplicate key answer can only mean this ticket.
 */
export function isDuplicateTicketError(error) {
  if (!error) return false;
  if (String(error.code || '') === '23505') return true;
  return /duplicate key value/i.test(String(error.message || ''));
}
