// src/lib/bookings/editRules.js
//
// Editing a booking: the pure rules (16 Oct 2026). Peter, showing the system
// to a customer: "why can't I edit a booking, that is basic, what if someone
// makes a mistake or wants to move a booking". This module decides what an
// edit may do and says why not in plain words. No store, no Supabase, no
// React, so every rule runs under node:test (editRules.test.js).
//
//   editRefusal     may this booking be edited at all (dining, departed,
//                   cancelled, no show and expired are not)
//   validateEdit    date, time inside service hours, covers against the
//                   tables' seats, turn minutes from the rules
//   conflictsFor    the new tables and window against every other live
//                   booking on those tables, naming the other booking
//   paymentAfterEdit  package price times covers against what was captured
//   snapToSlot, shiftTables, slotTimes  helpers the Timeline drag uses
//   stampEdit, editedLine  the audit line ("Edited 17:42 by Jane")
//
// The audit rides the booking's customer jsonb (edited_by, edited_at): the
// bookings table has no audit columns and this release adds no schema.

import { toMin, toHM, turnFor, toOptimiserBooking, DEFAULT_TURN_BANDS } from './optimiser.js';
import { paymentDue, NON_BLOCKING_STATUSES } from './bookingPayment.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isHM = (s) => /^\d{2}:\d{2}$/.test(String(s || '').slice(0, 5));
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Statuses that cannot be edited, each with the words the sheet shows.
export const EDIT_REFUSALS = {
  dining: 'This party is seated. Change the table on the till, where the tab is.',
  departed: 'This party has left. A finished booking cannot be changed.',
  cancelled: 'This booking was cancelled. Make a new booking instead.',
  no_show: 'This booking was marked as a no show. Undo the no show first if that was a mistake.',
  expired: 'This booking expired unpaid and its table was freed. The guest must book again.',
};

export function editRefusal(booking) {
  if (!booking) return 'Booking not found.';
  return EDIT_REFUSALS[booking.status] || null;
}

// Every 15 minute (or rule) slot across the service window, 'HH:MM'.
export function slotTimes({ serviceStart = '17:00', serviceEnd = '23:00', slotMinutes = 15 } = {}) {
  const step = Math.max(5, num(slotMinutes) || 15);
  const out = [];
  for (let m = toMin(serviceStart); m < toMin(serviceEnd); m += step) out.push(toHM(m));
  return out;
}

// Nearest slot boundary, in minutes of day.
export function snapToSlot(min, step = 15) {
  const s = Math.max(1, num(step) || 15);
  return Math.round(num(min) / s) * s;
}

// The Timeline drag moves every member table by the same number of rows, so
// a joined party keeps its shape. rows is the ordered table list the Timeline
// draws. null when any member would fall off the top or bottom.
export function shiftTables(tableIds, rows, rowDelta) {
  const ids = Array.isArray(tableIds) ? tableIds : [];
  const order = (rows || []).map((t) => (t && t.id !== undefined ? t.id : t));
  if (!ids.length || !order.length) return null;
  const out = [];
  for (const id of ids) {
    const i = order.indexOf(id);
    if (i < 0) return null;
    const j = i + Math.round(num(rowDelta));
    if (j < 0 || j >= order.length) return null;
    out.push(order[j]);
  }
  return out;
}

// What an edit would make the booking. patch keys are optional; anything left
// out keeps the booking's value. Returns { ok, errors: [...], next } where next
// is the booking after the edit (turnMinutes recomputed for the new covers).
//   rules   { serviceStart, serviceEnd, turnBands }
//   tables  [{ id, label, covers | maxCovers }] the venue's tables
//   today   'YYYY-MM-DD' on the venue clock
//   pkg     the booking's package (its turnMinutes wins over the band)
export function validateEdit({ booking, patch = {}, rules = {}, tables = [], today = null, pkg = null } = {}) {
  const errors = [];
  if (!booking) return { ok: false, errors: ['Booking not found.'], next: null };
  const refusal = editRefusal(booking);
  if (refusal) return { ok: false, errors: [refusal], next: null };

  const date = patch.date !== undefined ? String(patch.date || '') : String(booking.date || '');
  const startTime = String(patch.startTime !== undefined ? patch.startTime : booking.startTime || '').slice(0, 5);
  const covers = patch.covers !== undefined ? Math.round(num(patch.covers)) : Math.round(num(booking.covers));
  const tableIds = patch.tables !== undefined ? (Array.isArray(patch.tables) ? patch.tables.filter(Boolean) : []) : (booking.tables || []);
  const primary = patch.primaryTableId || (tableIds.includes(booking.primaryTableId) && patch.tables === undefined ? booking.primaryTableId : tableIds[0]) || null;

  if (!isISODate(date)) errors.push('Pick a date.');
  else if (today && date < today) errors.push('That date has gone. A booking can be moved to today or a later day.');

  if (!isHM(startTime)) errors.push('Pick a time.');
  else {
    const s = toMin(startTime);
    const open = toMin(rules.serviceStart || '17:00');
    const close = toMin(rules.serviceEnd || '23:00');
    if (s < open || s >= close) errors.push(`${startTime} is outside service hours (${toHM(open)} to ${toHM(close)}).`);
  }

  if (!(covers >= 1)) errors.push('Covers must be at least 1.');
  else if (covers > 200) errors.push('Covers cannot be more than 200.');
  if (booking.status === 'pending_payment' && covers !== Math.round(num(booking.covers))) {
    errors.push('This booking is still being paid online, so its covers cannot change until the payment lands.');
  }

  if (!tableIds.length) errors.push('Pick at least one table.');
  else {
    const byId = new Map((tables || []).map((t) => [t.id, t]));
    const missing = tableIds.filter((id) => !byId.has(id));
    if (missing.length) errors.push('A chosen table is no longer on the floor plan.');
    else if (covers >= 1) {
      const seats = tableIds.reduce((s, id) => s + num(byId.get(id).covers ?? byId.get(id).maxCovers), 0);
      if (seats < covers) {
        const label = tableIds.map((id) => byId.get(id).label || id).join(' + ');
        errors.push(`${label} seats ${seats}, this party is ${covers}. Add a table or pick a bigger one.`);
      }
    }
  }

  const turnMinutes = (pkg && num(pkg.turnMinutes) > 0) ? num(pkg.turnMinutes) : turnFor(Math.max(1, covers), rules.turnBands || DEFAULT_TURN_BANDS);

  const next = {
    ...booking,
    date,
    startTime,
    covers,
    tables: tableIds,
    primaryTableId: primary,
    turnMinutes,
    note: patch.note !== undefined ? String(patch.note || '') : (booking.note || ''),
    customer: patch.customer !== undefined ? patch.customer : booking.customer,
  };
  return { ok: errors.length === 0, errors, next };
}

// Other bookings in the way of the edited booking's new tables and window.
//   booking  the booking after the edit ({ id, tables, startTime | startMin, turnMinutes })
//   others   the day's bookings (store shape) plus any open tab blocks from
//            sessionsToBlocks, which have ids 'sess-<tableId>'
//   tables   for labels in the words
// Same half open rule as the optimiser and create_booking: a booking ending
// exactly when another starts is not a conflict. Each conflict names the
// other booking so the sheet and the drag ghost can say who.
export function conflictsFor({ booking, others = [], tables = [] } = {}) {
  if (!booking) return [];
  const me = toOptimiserBooking(booking);
  const mine = new Set(me.tables || []);
  if (!mine.size) return [];
  const myStart = me.startMin;
  const myEnd = myStart + (num(me.turnMinutes) || 90);
  const label = (id) => (tables || []).find((t) => t.id === id)?.label || String(id).slice(-4);
  const out = [];
  for (const raw of others || []) {
    if (!raw || raw.id === booking.id) continue;
    if (NON_BLOCKING_STATUSES.includes(raw.status)) continue;
    const o = toOptimiserBooking(raw);
    const shared = (o.tables || []).filter((t) => mine.has(t));
    if (!shared.length) continue;
    const s = o.startMin, e = s + (num(o.turnMinutes) || 90);
    if (!(s < myEnd && e > myStart)) continue;
    const isTab = String(raw.id || '').startsWith('sess-');
    const name = isTab
      ? `an open tab on ${label(shared[0])}`
      : (raw.customer?.name || (raw.source === 'walk_in' ? 'a walk in' : `a party of ${o.covers}`));
    out.push({
      bookingId: raw.id,
      name,
      tableId: shared[0],
      tableLabel: label(shared[0]),
      startMin: s,
      endMin: e,
      text: isTab
        ? `${label(shared[0])} has an open tab until about ${toHM(e)}`
        : `${label(shared[0])} is taken by ${name} ${toHM(s)} to ${toHM(e)}`,
    });
  }
  return out;
}

// What the booking owes after an edit, in minor units.
//   pkg            the booking's package (null = no package, nothing due)
//   covers         the covers after the edit
//   capturedMinor  what the ledger shows captured (null = not visible here)
// state: 'none' (no package money), 'unknown' (ledger not visible),
//        'settled', 'owed' (diffMinor to take), 'overpaid' (diffMinor to give back)
export function paymentAfterEdit({ pkg = null, covers, capturedMinor = null } = {}) {
  const due = paymentDue({ covers, pkg, rules: null });
  if (!due || due.kind === 'hold' || !(due.amountMinor > 0)) {
    return { kind: null, dueMinor: 0, capturedMinor: capturedMinor ?? 0, diffMinor: 0, state: 'none' };
  }
  if (capturedMinor === null || capturedMinor === undefined) {
    return { kind: due.kind, dueMinor: due.amountMinor, capturedMinor: null, diffMinor: 0, state: 'unknown' };
  }
  const cap = Math.max(0, Math.round(num(capturedMinor)));
  const diff = due.amountMinor - cap;
  return {
    kind: due.kind,
    dueMinor: due.amountMinor,
    capturedMinor: cap,
    diffMinor: Math.abs(diff),
    state: diff === 0 ? 'settled' : diff > 0 ? 'owed' : 'overpaid',
  };
}

// The audit stamp on the customer snapshot. Keeps every existing key.
export function stampEdit(customer, by, at = Date.now()) {
  const base = customer && typeof customer === 'object' ? customer : {};
  return { ...base, edited_by: by || null, edited_at: new Date(at).toISOString() };
}

// Does this customer snapshot carry a real guest (name or phone), as opposed
// to only an edit stamp on a walk in?
export const hasGuest = (customer) => !!(customer && (customer.name || customer.phone || customer.email));

// "Edited 17:42 by Jane", or null when never edited. formatTime is injected so
// the module stays clock and locale free (the caller passes the venue clock).
export function editedLine(booking, formatTime = null) {
  const c = booking?.customer;
  if (!c || !c.edited_at) return null;
  const at = new Date(c.edited_at);
  if (Number.isNaN(at.getTime())) return null;
  const hm = typeof formatTime === 'function'
    ? formatTime(at)
    : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `Edited ${hm}${c.edited_by ? ` by ${c.edited_by}` : ''}`;
}

// The fields an edit changed, in words, for the activity feed.
export function describeChanges(before, after, tables = []) {
  if (!before || !after) return '';
  const label = (id) => (tables || []).find((t) => t.id === id)?.label || String(id).slice(-4);
  const bits = [];
  if (before.date !== after.date) bits.push(`date ${before.date} to ${after.date}`);
  if (String(before.startTime || '').slice(0, 5) !== String(after.startTime || '').slice(0, 5)) bits.push(`time ${String(before.startTime).slice(0, 5)} to ${String(after.startTime).slice(0, 5)}`);
  if (num(before.covers) !== num(after.covers)) bits.push(`covers ${before.covers} to ${after.covers}`);
  const bt = (before.tables || []).join(','), at = (after.tables || []).join(',');
  if (bt !== at) bits.push(`table ${(before.tables || []).map(label).join('+') || 'none'} to ${(after.tables || []).map(label).join('+') || 'none'}`);
  if ((before.customer?.name || '') !== (after.customer?.name || '')) bits.push('guest name');
  if ((before.customer?.phone || '') !== (after.customer?.phone || '')) bits.push('phone');
  if ((before.customer?.email || '') !== (after.customer?.email || '')) bits.push('email');
  const ba = (before.customer?.allergens || []).join(','), aa = (after.customer?.allergens || []).join(',');
  if (ba !== aa) bits.push('allergens');
  if ((before.note || '') !== (after.note || '')) bits.push('note');
  return bits.join(', ');
}

// 16 Oct 2026 (bookings audit items 10 and 21): the database's refusal codes (create_booking,
// move_booking, edit_booking) in the words the stand and the till show. tableLabel is the
// table's name when the refusal names one. Unknown codes pass through as they are.
export function bookingRefusalWords({ error = null, tableLabel = null, seats = null, status = null } = {}) {
  const t = tableLabel || 'That table';
  switch (error) {
    case 'table_taken': return `${t} was just taken by another booking. Nothing was changed.`;
    case 'unknown_table': return `${t} is not on this venue's floor plan any more. Reload the floor and pick again.`;
    case 'too_many_covers': return `The tables seat ${Number(seats) || 0}, fewer than the party. Add a table or pick a bigger one.`;
    case 'awaiting_payment': return 'This booking is still being paid online, so its covers cannot change until the payment lands.';
    case 'not_editable': return EDIT_REFUSALS[status] || 'This booking can no longer be changed.';
    case 'unknown booking': return 'This booking is not on the diary any more. Reload and try again.';
    case 'booking is closed': return 'This booking is finished, so it cannot be moved.';
    case 'no tables supplied': return 'Pick at least one table.';
    default: return error ? String(error) : 'The database refused the change.';
  }
}
