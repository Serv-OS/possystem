// src/lib/kds/kdsOrderNote.js
//
// The kitchen's own note on a ticket (Peter, Coffee Boy, 30 Sep 2026: "add the ability to add a
// note to the KDS order. It doesn't need to sync anywhere, just on the order, and it saves").
//
// WHERE IT LIVES: kds_tickets.meta.kdsNote. meta is stamped by the writer on insert and never
// written again by a till (fireCourse writes fired_courses and items, a bump writes status), so
// the KDS is the only thing that touches it after insert and a note cannot be wiped by a stale
// till. It never reaches the till, receipts or reports: nothing else reads the key.
//
// WHICH ROWS: the same order is one kds_tickets row per production centre (food and drinks
// screens = 2 rows). The note goes on EVERY row of the order at the location, so every kitchen
// screen showing the order sees it. Rows are matched by the order's ref (meta.ref, stamped since
// this change for till, kiosk, online, QR, delivery app and catering orders), or, for a table or
// bar tab send that has no ref, by the same table label sent within a few seconds of each other.
//
// SIZE: realtime rows over 1 MB drop columns, so the note is capped at 200 characters.
// No React, no Supabase.

export const KDS_NOTE_MAX = 200;

/** How far apart two rows of one table send can be stamped (Date.now() runs once per row). */
export const SAME_SEND_WINDOW_MS = 3000;

/** Typed text → the note to save: lines tidied, blank lines dropped, capped. null when empty. */
export function cleanKdsNote(text) {
  if (text == null) return null;
  const s = String(text).split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  if (!s) return null;
  return s.length > KDS_NOTE_MAX ? s.slice(0, KDS_NOTE_MAX).trimEnd() : s;
}

/** The kitchen note on a row's raw meta, or null. Read straight from the column, never from the normalised meta. */
export function kdsNoteOf(rawMeta) {
  const n = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) ? rawMeta.kdsNote : null;
  return typeof n === 'string' && n.trim() ? n : null;
}

/** The meta to write back: the row's current meta with the note set, or the key removed when the note is cleared. */
export function metaWithKdsNote(rawMeta, note) {
  const base = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) ? { ...rawMeta } : {};
  const n = cleanKdsNote(note);
  if (n) base.kdsNote = n;
  else delete base.kdsNote;
  return base;
}

/**
 * What identifies the order a mapped ticket belongs to:
 *   { kind: 'ref', ref }                    an order with a ref (till, kiosk, online, QR, apps, catering)
 *   { kind: 'send', tableLabel, sentAt }    a table or bar tab send (no ref)
 *   null                                    nothing to match on
 */
export function orderKeyOf(ticket) {
  const ref = ticket?.meta?.ref;
  if (typeof ref === 'string' && ref.trim()) return { kind: 'ref', ref: ref.trim() };
  const label = ticket?.table == null ? '' : String(ticket.table).trim();
  const sentAt = Number(ticket?.sentAt);
  if (label && Number.isFinite(sentAt)) return { kind: 'send', tableLabel: label, sentAt };
  return null;
}

/** True when two mapped tickets are rows of the same order. A row is always the same order as itself. */
export function isSameOrder(a, b) {
  if (!a || !b) return false;
  if (a.id != null && a.id === b.id) return true;
  const ka = orderKeyOf(a);
  const kb = orderKeyOf(b);
  if (!ka || !kb || ka.kind !== kb.kind) return false;
  if (ka.kind === 'ref') return ka.ref === kb.ref;
  return ka.tableLabel === kb.tableLabel && Math.abs(ka.sentAt - kb.sentAt) <= SAME_SEND_WINDOW_MS;
}

/** The rows of `ticket`'s order among `candidates` (mapped rows), the ticket itself included. */
export function rowsOfSameOrder(ticket, candidates) {
  const out = (candidates || []).filter(c => isSameOrder(ticket, c));
  if (ticket && !out.some(c => c.id === ticket.id)) out.push(ticket);
  return out;
}
