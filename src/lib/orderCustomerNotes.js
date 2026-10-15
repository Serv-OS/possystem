// src/lib/orderCustomerNotes.js
//
// The customer on an ORDER carries only the notes typed for THAT order. A customer RECORD's
// notes (customers.notes) never ride onto an order.
//
// 30 Sep 2026 (Coffee Boy Barnsley, KDS ticket #58, dine in, POS 1): the ticket's note box said
// "6 expired". That is not an order note: it is the customer record's notes, written by the
// customer importer ("6 expired", "Phone in 5Loyalty: ...", "Shares this phone with N other
// account(s)"; 1,098 Coffee Boy customers have such notes, some with a full phone number). The
// kitchen reads the order customer's notes (store: joinNotes(orderNote, customer.notes) into the
// ticket meta, then the KDS, the till's collection queue), so a record's notes that reached the
// order customer went to the kitchen. They reached it two ways:
//   1. The customer form (components/CustomerModal.jsx): when the typed phone matched a profile
//      and staff typed no order note, the order took the profile's notes instead.
//   2. A table reservation: the whole search row (notes included) was saved as the reservation's
//      customer, and seatTable copied it onto the table's order.
// Both now stop the record's notes here. Managers still read them in Back Office (Customers).
//
// Pure: no imports, so node:test can load it.

/**
 * A copy of the customer without the record's `notes`, for putting on an order. Everything
 * else (name, phone, email, allergens, ids, marketing flags) is kept. A customer with no
 * `notes` field is returned as it is; null, undefined and non objects come back as null.
 */
export function withoutRecordNotes(customer) {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) return null;
  if (!Object.prototype.hasOwnProperty.call(customer, 'notes')) return customer;
  const { notes: _recordNotes, ...rest } = customer;
  void _recordNotes;
  return rest;
}

/**
 * The notes an order customer carries after the form matched a profile by phone: only what
 * staff typed for this order, trimmed. The matched profile's own notes are never used.
 */
export function orderNotesFromForm(typed) {
  return typeof typed === 'string' ? typed.trim() : '';
}
