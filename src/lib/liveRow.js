// src/lib/liveRow.js
//
// 12 Oct 2026, WHY. The realtime library hands a postgres_changes handler `new = {}` (an empty
// object, which is truthy) when the server sent a change with an error and no record, and the
// server sends such a change to EVERY subscriber on the table, whatever their filter. A handler
// that only checks `if (!payload.new)` then treats nothing as a row. That is how every menu
// board lost its pairing on the night of 11 to 12 Oct. Use this in any handler that is about
// to use the row: it gives the row back only when it is a real one.
// NO imports, so node:test can load it.

/** The new row of a live change, or null when the change has errors, no record or no id. */
export function liveRow(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const errs = payload.errors;
  if (errs != null && !(Array.isArray(errs) && errs.length === 0)) return null;
  const row = payload.new;
  if (!row || typeof row !== 'object' || row.id == null || row.id === '') return null;
  return row;
}
