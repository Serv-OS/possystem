// src/lib/ezcaterTillWrite.js
//
// WHAT A TILL MAY WRITE ON AN ezCater ORDER (review round 4, 18 Sep 2026).
//
// QueueSync used to upsert every queue row from till memory, whole: customer, status, sent_at,
// items, times. On an ezCater order most of that belongs to the SERVER: the ezCater lifecycle,
// the fire time (sent_at), the venue date and time, and the customer jsonb (where the lifecycle,
// the answer stamp and every staff warning live) are written only by _shared/ezcaterIngest.ts,
// under its guards. A till writing its older copy back would undo a cancel, move a fire time
// back, or wipe a warning, with no guard at all.
//
// So for an ezCater row the till writes ONLY what staff change on the till (the status as staff
// move it through the kitchen, and the staff member), always as an UPDATE of the row the server
// already has (never an insert of a partial row), and never onto a cancelled row (a cancel is
// ezCater's, a till cannot bring the order back). Every other source is written as before.

/** The order_queue columns a till may write on an ezCater row. */
export const EZCATER_TILL_FIELDS = Object.freeze(['status', 'staff']);

/**
 * How the flush writes one queue row.
 *   { mode: 'as_before' }                                 not ezCater: unchanged behaviour
 *   { mode: 'update', payload, notMatch }                 ezCater: only the till owned fields
 *   { mode: 'skip' }                                      ezCater with nothing the till owns
 */
export function tillQueueWrite(row) {
  if (String(row?.source || '').trim().toLowerCase() !== 'ezcater') return { mode: 'as_before' };
  const payload = {};
  for (const k of EZCATER_TILL_FIELDS) if (row[k] !== undefined) payload[k] = row[k];
  if (!Object.keys(payload).length) return { mode: 'skip' };
  // ref rides along unchanged (it is the row's own key, matched on anyway): the offline queue's
  // replay guard identifies a buffered order write by payload.ref.
  return { mode: 'update', payload: { ref: row.ref, ...payload }, notMatch: { status: 'cancelled' } };
}

/**
 * The till's row with a pre fire answer merged over it (review round 4). The answer carries NO
 * customer contact details (the server strips them, prefireRowForTill), so its customer is merged
 * OVER the till's own, never in place of it: the kitchen ticket keeps the name the till had.
 */
export function mergePrefireRow(row, pfRow) {
  if (!pfRow) return row;
  const customer = pfRow.customer ? { ...(row?.customer || {}), ...pfRow.customer } : row?.customer;
  return { ...row, items: pfRow.items || row?.items, customer, type: pfRow.type || row?.type };
}
