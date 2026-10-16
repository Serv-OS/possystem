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
//   changedFields   the sheet's patch: only what the host actually changed
//   dropTarget      where a Timeline drag lands (axis lock, dead zone, seats)
//
// The audit rides the booking's customer jsonb (edited_by, edited_at): the
// bookings table has no audit columns and this release adds no schema.

import { toMin, toHM, turnFor, toOptimiserBooking, DEFAULT_TURN_BANDS } from './optimiser.js';
import { paymentDue, NON_BLOCKING_STATUSES } from './bookingPayment.js';
import { buildScheduleCtx } from '../scheduleCtx.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isHM = (s) => /^\d{2}:\d{2}$/.test(String(s || '').slice(0, 5));
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const hm = (s) => String(s || '').slice(0, 5);

// 16 Oct 2026 review: the statuses move_booking itself ignores. An expired
// booking keeps its booking_tables rows, so the server still counts it; the
// edit and the drag count it too, or the ghost shows green and the save is
// refused. (NON_BLOCKING_STATUSES, which also skips expired, stays for the
// optimiser and the diary.)
export const MOVE_NON_BLOCKING = ['departed', 'cancelled', 'no_show'];

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
// out keeps the booking's value. Returns { ok, errors: [...], next, changed }
// where next is the booking after the edit and changed says which parts moved.
// 16 Oct 2026 review: each check runs only for what the edit changes. A name
// fix on a booking made before the hours or the bands changed, or one sitting
// on a table smaller than its party, must still save. The turn stays the
// booking's own unless the covers change (or it has none).
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

  const dateChanged = date !== String(booking.date || '');
  const timeChanged = startTime !== hm(booking.startTime);
  const coversChanged = covers !== Math.round(num(booking.covers));
  const tablesChanged = tableIds.join(',') !== (booking.tables || []).join(',');
  const primaryChanged = primary !== (booking.primaryTableId || null);

  if (!isISODate(date)) errors.push('Pick a date.');
  else if (dateChanged && today && date < today) errors.push('That date has gone. A booking can be moved to today or a later day.');

  if (!isHM(startTime)) errors.push('Pick a time.');
  else if (timeChanged) {
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

  if (!tableIds.length) { if (tablesChanged) errors.push('Pick at least one table.'); }
  else if (tablesChanged || coversChanged) {
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

  const turnMinutes = (!coversChanged && num(booking.turnMinutes) > 0)
    ? num(booking.turnMinutes)
    : (pkg && num(pkg.turnMinutes) > 0) ? num(pkg.turnMinutes) : turnFor(Math.max(1, covers), rules.turnBands || DEFAULT_TURN_BANDS);
  const turnChanged = turnMinutes !== num(booking.turnMinutes);

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
  const changed = {
    date: dateChanged, time: timeChanged, covers: coversChanged,
    tables: tablesChanged || primaryChanged, turn: turnChanged,
    // where or when the table is held: these need the conflict check and
    // move_booking's check under the venue lock. A covers, guest or note
    // change alone does not.
    slot: dateChanged || timeChanged || tablesChanged || primaryChanged || turnChanged,
  };
  return { ok: errors.length === 0, errors, next, changed };
}

// Other bookings in the way of the edited booking's new tables and window.
//   booking  the booking after the edit ({ id, tables, startTime | startMin, turnMinutes })
//   others   the day's bookings (store shape) plus any open tab blocks from
//            sessionsToBlocks, which have ids 'sess-<tableId>'
//   tables   for labels in the words
// Same half open rule as the optimiser and create_booking: a booking ending
// exactly when another starts is not a conflict. Each conflict names the
// other booking so the sheet and the drag ghost can say who.
//   nonBlocking  statuses that never block (default the optimiser's list;
//                editing passes MOVE_NON_BLOCKING to match move_booking)
export function conflictsFor({ booking, others = [], tables = [], nonBlocking = NON_BLOCKING_STATUSES } = {}) {
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
    if (nonBlocking.includes(raw.status)) continue;
    const o = toOptimiserBooking(raw);
    const shared = (o.tables || []).filter((t) => mine.has(t));
    if (!shared.length) continue;
    const s = o.startMin, e = s + (num(o.turnMinutes) || 90);
    if (!(s < myEnd && e > myStart)) continue;
    const isTab = String(raw.id || '').startsWith('sess-');
    const name = isTab
      ? `an open tab on ${label(shared[0])}`
      : (raw.customer?.name || (raw.source === 'walk_in' ? 'a walk in' : `a party of ${o.covers}`))
        + (raw.status === 'expired' ? ' (expired unpaid, still holding the table)' : '');
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

// Does this customer snapshot carry a real guest (name, phone, email or
// allergens), as opposed to only an edit stamp on a walk in? Allergens alone
// count: a "party of 4" with peanuts must take them to the till seat.
export const hasGuest = (customer) => !!(customer && (customer.name || customer.phone || customer.email
  || (Array.isArray(customer.allergens) && customer.allergens.length)));

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

// The tables a booking holds, primary first (the shape the sheet starts from).
export const tablesOf = (b) => (Array.isArray(b?.tables) && b.tables.length ? b.tables : (b?.primaryTableId ? [b.primaryTableId] : []));

// 16 Oct 2026 review: the sheet sends only what the host changed against the
// booking as it was when the sheet opened (snap). Sending every field put back
// whatever another device had changed meanwhile (a Timeline move, a note from
// Back Office). form: { date, startTime, covers, tables, note, customer:
// { name, phone, email, allergens } }. An empty object means nothing changed.
export function changedFields(snap, form) {
  const patch = {};
  if (!snap || !form) return patch;
  if (form.date !== undefined && form.date !== String(snap.date || '')) patch.date = form.date;
  if (form.startTime !== undefined && hm(form.startTime) !== hm(snap.startTime)) patch.startTime = hm(form.startTime);
  if (form.covers !== undefined && Math.round(num(form.covers)) !== Math.round(num(snap.covers))) patch.covers = Math.round(num(form.covers));
  if (Array.isArray(form.tables) && form.tables.join(',') !== tablesOf(snap).join(',')) {
    patch.tables = form.tables;
    patch.primaryTableId = form.tables[0] || null;
  }
  if (form.note !== undefined && String(form.note || '') !== String(snap.note || '')) patch.note = String(form.note || '');
  const c = form.customer || {};
  const was = snap.customer || {};
  const guest = {};
  for (const k of ['name', 'phone', 'email']) {
    if (c[k] === undefined) continue;
    const a = String(c[k] || '').trim() || null;
    const b = String(was[k] || '').trim() || null;
    if (a !== b) guest[k] = a;
  }
  if (Array.isArray(c.allergens)) {
    const a = [...c.allergens].sort().join(',');
    const b = [...(Array.isArray(was.allergens) ? was.allergens : [])].sort().join(',');
    if (a !== b) guest.allergens = c.allergens;
  }
  if (Object.keys(guest).length) patch.customer = guest;
  return patch;
}

// 16 Oct 2026 review: where a Timeline drag lands, as a pure function so the
// snapping is tested. The drag locks to the axis the finger mostly moved on:
// a mostly vertical drag (a table move) keeps the time unless it also went a
// whole slot sideways, and a mostly sideways drag (a time move) keeps the
// tables unless it also went a whole row down or up. Sideways drift under
// three quarters of a slot never moves the time.
//   booking  { id, startTime, turnMinutes, covers, tables }
//   dx, dy   the pointer offset in px; slotW px per 15 minutes; rowH px per row
//   rows     the Timeline's table rows in order [{ id, label, maxCovers | covers }]
//   startMin, endMin  the drawn service window in minutes
//   others   the day's bookings plus open tab blocks
export function dropTarget({ booking, dx = 0, dy = 0, slotW = 24, rowH = 44, rows = [], startMin = 0, endMin = 24 * 60, others = [], nonBlocking = MOVE_NON_BLOCKING } = {}) {
  const b = booking || {};
  const bs = toMin(b.startTime);
  const ax = Math.abs(num(dx)), ay = Math.abs(num(dy));
  const sw = Math.max(1, num(slotW)), rh = Math.max(1, num(rowH));
  const vertical = ay > ax;
  const cols = (vertical ? ax <= sw : ax < sw * 0.75) ? 0 : Math.round(num(dx) / sw);
  const rowDelta = (!vertical ? ay <= rh : ay < rh * 0.5) ? 0 : Math.round(num(dy) / rh);
  // No sideways move keeps the booking's own time, even an off grid one.
  const ns = cols === 0 ? bs : Math.max(num(startMin), Math.min(num(endMin) - 15, snapToSlot(bs + cols * 15, 15)));
  const timeChanged = ns !== bs;
  const unchanged = !timeChanged && rowDelta === 0;
  const label = (id) => (rows || []).find((t) => t.id === id)?.label || String(id).slice(-4);
  const base = { unchanged, startMin: ns, fromMin: bs, timeChanged, tablesChanged: rowDelta !== 0, conflicts: [] };
  const tables2 = shiftTables(b.tables || [], rows, rowDelta);
  if (!tables2) return { ...base, ok: false, tables: null, reason: 'That would push a joined table off the floor plan.' };
  const seats = tables2.reduce((sum, id) => {
    const t = (rows || []).find((r) => r.id === id);
    return sum + num(t?.maxCovers ?? t?.covers);
  }, 0);
  const conflicts = conflictsFor({
    booking: { id: b.id, tables: tables2, startTime: toHM(ns), turnMinutes: num(b.turnMinutes) || 90 },
    others, tables: rows, nonBlocking,
  });
  let reason = null;
  if (conflicts.length) reason = conflicts[0].text;
  else if (rowDelta !== 0 && seats < num(b.covers || 1)) reason = `${tables2.map(label).join(' + ')} seats ${seats}, this party is ${b.covers}.`;
  return { ...base, ok: !reason, tables: tables2, conflicts, reason };
}

// 16 Oct 2026 review: lowering covers on a pre ordered booking leaves plates
// for guests who are not coming (each pre-order row becomes a kitchen line at
// seating). The words the sheet shows, or null when no seat is past the covers.
export function preorderWarning(preorders, covers) {
  const n = Math.round(num(covers));
  const seats = [...new Set((preorders || []).map((p) => num(p?.seat)).filter((s) => s > n))].sort((a, b) => a - b);
  if (!seats.length) return null;
  const list = seats.length === 1 ? `Seat ${seats[0]} has` : `Seats ${seats.slice(0, -1).join(', ')} and ${seats[seats.length - 1]} have`;
  return `${list} pre-orders. They will still go to the kitchen. Remove them in Pre-orders.`;
}

// 16 Oct 2026 review: business times on the VENUE clock (the venue clock
// rule). A formatter for 'HH:MM' and the venue's today, both from the venue
// timezone, so Peter in California sees Leeds times and the Leeds day.
export const fmtClock = (tz) => (d) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  } catch {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
};
export const venueToday = (tz) => buildScheduleCtx(tz || undefined).ymd;

// 16 Oct 2026: the same tables (and primary) before and after an edit, order kept.
export function sameTables(before = {}, after = {}) {
  return (before?.tables || []).join(',') === (after?.tables || []).join(',')
    && (before?.primaryTableId || null) === (after?.primaryTableId || null);
}

// 16 Oct 2026: does an edit move the booking's window? A new date, a new time, new tables, or
// more covers. A note, phone, guest or smaller party edit does not, so it skips the diary
// conflict check and keeps the booking's turn (the till's Edit reservation on a table with an
// open tab is not refused for a phone number).
export function editChangesWindow(before = {}, next = {}) {
  if (!before || !next) return true;
  if (String(before.date || '') !== String(next.date || '')) return true;
  if (String(before.startTime || '').slice(0, 5) !== String(next.startTime || '').slice(0, 5)) return true;
  if (!sameTables(before, next)) return true;
  return Math.round(num(next.covers)) > Math.round(num(before.covers));
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
    case 'no access': return 'This device is not allowed to change bookings at this venue. Pair it again or sign in, then try again.';
    default: return error ? String(error) : 'The database refused the change.';
  }
}
