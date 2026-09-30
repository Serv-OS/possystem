// src/lib/voidRules.js
//
// The void rules, in one place, for every order the till can hold.
//
// Coffee Boy, 30 Sep 2026 (Peter): "Can't void anything other than table orders. That needs
// fixing." Until now the Void button and store.voidItem / voidCheck only knew table sessions.
// A walk in (takeaway, collection, delivery, drive thru, dine in without a table) had no void at
// all once it was sent, and the order screens (kiosk, online, QR) had only the HubRise Reject.
//
// Everything here is pure so the decisions are testable in Node:
//   · who can be voided (canVoidItem / canVoidOrder)
//   · what the records look like (buildVoidTombstone, voidLogEntry)
//   · how a kitchen ticket learns about it (voidTicketItems / ticketHasLines)
//   · how the reports read a void back (normaliseCheckStatus / voidedValue)
//
// No imports on purpose: the store, the surfaces, db.js and the Back Office reports all pull
// from here, and this file must never pull them back in.

/** The reasons staff pick from. Shared by the till modal and the order screens. */
export const VOID_REASONS = [
  'Customer changed mind',
  'Wrong item ordered',
  'Kitchen error',
  'Allergy / dietary concern',
  'Item unavailable',
  'Duplicate order',
  'Manager discretion',
  'Training / test order',
  'Other',
];

const isObj = (v) => !!v && typeof v === 'object';
const lineValue = (i) => (Number(i?.price) || 0) * (Number(i?.qty) || 0);

/** A line the kitchen already has and nobody has voided yet. */
export function isLiveSentLine(item) {
  if (!isObj(item)) return false;
  if (item.voided === true || item.status === 'voided') return false;
  return item.status === 'sent';
}

/** A line still being built. Unsent lines are removed, never voided (Peter: keep delete). */
export function isUnsentLine(item) {
  if (!isObj(item)) return false;
  if (item.voided === true || item.status === 'voided') return false;
  return item.status !== 'sent';
}

/** True when this line can be voided (it went to the kitchen and is still live). */
export function canVoidItem(item) {
  return isLiveSentLine(item);
}

/**
 * True when the whole order can be voided: at least one live line has been sent.
 * Works for a table session ({ items, sentAt }), a walk in order (same shape) or a bare list.
 * An order that was never sent has nothing to void: staff clear it line by line.
 */
export function canVoidOrder(order) {
  const items = Array.isArray(order) ? order : (Array.isArray(order?.items) ? order.items : []);
  return items.some(isLiveSentLine);
}

/** The lines a whole order void takes: everything not already voided. */
export function voidableLines(items) {
  return (Array.isArray(items) ? items : []).filter(i => isObj(i) && i.voided !== true && i.status !== 'voided');
}

/** The value a void report shows for these lines (price x qty, discounts ignored). */
export function linesValue(items) {
  return (Array.isArray(items) ? items : []).reduce((s, i) => s + lineValue(i), 0);
}

const TYPE_WORDS = {
  'dine-in': 'Dine in', dinein: 'Dine in', takeaway: 'Takeaway', collection: 'Collection',
  delivery: 'Delivery', 'drive-thru': 'Drive thru', drivethru: 'Drive thru',
};

/**
 * What the void log, the toast and the activity feed call a walk in order:
 * "Takeaway · Jane" or "Collection R35". A table keeps its table label.
 */
export function orderVoidLabel({ tableLabel, orderType, customer, ref } = {}) {
  if (tableLabel) return String(tableLabel);
  const type = TYPE_WORDS[String(orderType || '').toLowerCase()] || (orderType ? String(orderType) : 'Order');
  const name = isObj(customer) ? (customer.name || customer.firstName || customer.first_name) : (typeof customer === 'string' ? customer : null);
  if (name) return `${type} · ${String(name).trim()}`;
  if (ref) return `${type} ${String(ref)}`;
  return type;
}

/** Every uid of the lines being voided, as a Set the ticket matchers use. */
export function lineUids(items) {
  return new Set((Array.isArray(items) ? items : []).map(i => i?.uid).filter(Boolean));
}

/** Does this kitchen ticket carry any of these lines? Tickets store the line's uid (createKdsTickets). */
export function ticketHasLines(ticketItems, uids) {
  if (!(uids instanceof Set) || uids.size === 0) return false;
  return (Array.isArray(ticketItems) ? ticketItems : []).some(i => i?.uid && uids.has(i.uid));
}

/**
 * Mark the voided lines on a kitchen ticket. Returns { items, changed, allVoided } so the caller
 * writes the row only when something changed. The lines stay on the ticket flagged voided: the
 * KDS shows them struck through under a VOID banner (kdsTicket.voidState) so the kitchen SEES
 * the void instead of a ticket that quietly shrinks. A ticket whose every line is voided reads
 * "ORDER VOIDED" and the kitchen bumps it.
 */
export function voidTicketItems(ticketItems, uids) {
  const items = Array.isArray(ticketItems) ? ticketItems : [];
  let changed = false;
  const next = items.map(i => {
    if (!isObj(i) || i.voided === true) return i;
    if (!(uids instanceof Set) || !i.uid || !uids.has(i.uid)) return i;
    changed = true;
    return { ...i, voided: true };
  });
  const allVoided = next.length > 0 && next.every(i => !isObj(i) || i.voided === true);
  return { items: changed ? next : items, changed, allVoided };
}

/** The row the till keeps in voidLog for a void (same shape for tables and walk ins). */
export function voidLogEntry({ type, tableId = null, label, items, reason, manager, ref = null, now = Date.now() }) {
  const lines = (Array.isArray(items) ? items : []).map(i => ({ name: i.name, price: i.price, qty: i.qty }));
  return {
    id: `void-${now}`, timestamp: now, type,
    tableId, tableLabel: label || null, ref,
    items: lines,
    totalValue: linesValue(lines),
    reason, manager: manager?.name || null, managerId: manager?.id || null,
  };
}

// closed_checks.source has a CHECK constraint (pos, kiosk, online, mobile, catering, hubrise,
// pax_table_pay, pos_send_to_terminal, adyen_pay_at_table, ezcater, qr). Anything else would
// refuse the whole insert, so an unknown channel books as pos.
const CHECK_SOURCES = new Set(['pos', 'kiosk', 'online', 'mobile', 'catering', 'hubrise', 'pax_table_pay', 'pos_send_to_terminal', 'adyen_pay_at_table', 'ezcater', 'qr']);
export function checkSourceFor(source) {
  const s = String(source || '').toLowerCase();
  return CHECK_SOURCES.has(s) ? s : 'pos';
}

/**
 * The closed_checks TOMBSTONE a whole order void writes for a walk in or an order screen order.
 * Same idea as the table path (store.voidCheck, v5.9.72): flagged voided, status 'voided',
 * method 'void', and NO money on it (subtotal, total, tax, tenders all zero), so no report ever
 * counts it as a sale. The lines ride on `items` flagged voided so the Exceptions report can show
 * what was voided and its value (voidedValue).
 */
export function buildVoidTombstone({ order, orderType, customer = null, staff = null, manager, reason, locationId = null, source = 'pos', now = Date.now(), id = null } = {}) {
  const lines = voidableLines(order?.items).map(i => ({ ...i, status: 'voided', voided: true }));
  return {
    id: id || `void-${now}-${Math.random().toString(36).slice(2, 7)}`,
    ref: order?.ref || null,
    tableId: null,
    tableLabel: null,
    locationId,
    server: staff?.name || manager?.name || 'Staff',
    staffId: staff?.id || null,
    covers: 1,
    orderType: orderType || order?.type || 'takeaway',
    customer: isObj(customer) ? customer : (isObj(order?.customer) ? order.customer : null),
    items: lines,
    discounts: [],
    subtotal: 0, service: 0, tip: 0, total: 0, taxAmount: 0, taxBreakdown: null,
    tenders: [],
    method: 'void',
    seatedAt: null,
    closedAt: now,
    status: 'voided',
    voided: true,
    voidReason: reason || null,
    voidedBy: manager?.name || null,
    refunds: [],
    source: checkSourceFor(source),
  };
}

/**
 * The status a report reads. The v5.9.72 table tombstone was written as status 'void' while
 * every report (Exceptions, Z report, Shifts, Servers, salesStats) looks for 'voided', so those
 * voids never showed anywhere. Read both spellings, and the voided flag, as 'voided'.
 */
export function normaliseCheckStatus(status, voided = false) {
  if (voided === true || status === 'void') return 'voided';
  return status;
}

/** True for any void record, whichever spelling wrote it. */
export function isVoidedCheck(check) {
  return !!check && (check.voided === true || check.status === 'voided' || check.status === 'void');
}

/**
 * The value a void report shows. A tombstone books total 0 on purpose (so sales never count it),
 * so the value comes from its lines when the total is empty.
 */
export function voidedValue(check) {
  if (!isVoidedCheck(check)) return 0;
  const total = Number(check.total) || 0;
  return total > 0 ? total : linesValue(check.items);
}

/** The words the void toast and the activity feed use for a set of lines. */
export function voidLinesText(items) {
  const lines = voidableLines(items).concat((Array.isArray(items) ? items : []).filter(i => isObj(i) && (i.voided === true || i.status === 'voided')));
  const seen = new Set();
  const words = [];
  for (const i of lines) {
    const key = i.uid || `${i.name}|${i.qty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(`${Number(i.qty) || 1}× ${i.name || 'Item'}`);
  }
  return words.join(', ');
}
