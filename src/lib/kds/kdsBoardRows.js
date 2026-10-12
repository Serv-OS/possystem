// src/lib/kds/kdsBoardRows.js
//
// 12 Oct 2026, Barnsley: a list answer older than 15 s was thrown away, and one answered while any
// write started or finished was thrown away too and not asked again for 20 s. On a slow link
// nothing new showed for minutes. An old list could also wipe a ticket the live channel had just
// added. The rule now: EVERY list answer is used, late or not, and what this screen learned AFTER
// that read was sent (a live change, one of its own saves) is laid on top, so a late list can
// never undo something newer.
//
// Pure: rows are the board's shape (KDSSurface mapRow), events are a Map by ticket id.

/** Events older than this can no longer be newer than any read still in flight (reads are cancelled at 45 s). */
export const EVENT_KEEP_MS = 2 * 60 * 1000;

/** Something this screen learned at `at`: the ticket is `row` now ('row'), or it left the board ('gone'). */
export function noteEvent(events, { id, kind, row = null, at }) {
  if (!id) return events;
  const next = new Map(events || []);
  next.set(id, { kind: kind === 'gone' ? 'gone' : 'row', row: kind === 'gone' ? null : row, at });
  return next;
}

export function pruneEvents(events, { now, keepMs = EVENT_KEEP_MS } = {}) {
  const next = new Map();
  for (const [id, e] of events || []) if (now - e.at <= keepMs) next.set(id, e);
  return next;
}

export const upsertRow = (rows, row) => ((rows || []).some((r) => r.id === row.id)
  ? rows.map((r) => (r.id === row.id ? row : r))
  : [...(rows || []), row]);

export const removeRow = (rows, id) => (rows || []).filter((r) => r.id !== id);

/**
 * A list answer → the rows the board holds. Anything learned at or after the moment the read was
 * sent wins over the list (the list was read before it).
 */
export function mergeList({ rows, readStartedAt, events }) {
  let out = [...(rows || [])];
  for (const [id, e] of events || []) {
    if (!(e.at >= readStartedAt)) continue;
    out = e.kind === 'gone' ? removeRow(out, id) : (e.row ? upsertRow(out, e.row) : out);
  }
  return out;
}
