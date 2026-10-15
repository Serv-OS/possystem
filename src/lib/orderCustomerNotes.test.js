// src/lib/orderCustomerNotes.test.js
//
// A customer RECORD's notes never reach the kitchen (30 Sep 2026, Coffee Boy Barnsley KDS
// ticket #58, "6 expired"). The pure helper, then source pins on the places that put a customer
// on an order. Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutRecordNotes, orderNotesFromForm } from './orderCustomerNotes.js';
import { buildTicketMeta, joinNotes } from './kds/kdsTicket.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const read = (rel) => fs.readFileSync(path.resolve(SRC, rel), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// A customers row as the till's search returned it before the fix (importer notes included).
const RECORD = {
  id: 'c-1', name: 'Sam', phone: '+447700900123', phone_raw: '07700 900123', email: 'sam@example.com',
  marketing_opt_in: true, allergens: ['milk'], notes: '6 expired',
};

test('withoutRecordNotes: the record notes go, everything else stays', () => {
  const out = withoutRecordNotes(RECORD);
  assert.equal('notes' in out, false);
  assert.deepEqual(out, {
    id: 'c-1', name: 'Sam', phone: '+447700900123', phone_raw: '07700 900123', email: 'sam@example.com',
    marketing_opt_in: true, allergens: ['milk'],
  });
  // The record itself is never changed (Back Office still shows its notes).
  assert.equal(RECORD.notes, '6 expired');
});

test('withoutRecordNotes: a customer with no notes field is handed back as it is', () => {
  const c = { name: 'Guest', phone: null, allergens: [] };
  assert.equal(withoutRecordNotes(c), c);
});

test('withoutRecordNotes: nothing, or not a customer, is null', () => {
  assert.equal(withoutRecordNotes(null), null);
  assert.equal(withoutRecordNotes(undefined), null);
  assert.equal(withoutRecordNotes('Sam'), null);
  assert.equal(withoutRecordNotes(['x']), null);
});

test('orderNotesFromForm: only what staff typed for this order', () => {
  assert.equal(orderNotesFromForm('  no onions  '), 'no onions');
  assert.equal(orderNotesFromForm(''), '');
  assert.equal(orderNotesFromForm(undefined), '');
  assert.equal(orderNotesFromForm(null), '');
});

test('Barnsley #58: the kitchen note is the order note only, once the customer is cleaned', () => {
  // Before: joinNotes(orderNote '3', customer.notes '6 expired') gave "3\n6 expired".
  assert.equal(joinNotes('3', RECORD.notes), '3\n6 expired');
  // After: the order customer never carries the record's notes.
  const seated = withoutRecordNotes(RECORD);
  const meta = buildTicketMeta({ channel: 'table', isTable: true, customerName: seated.name, note: joinNotes('3', seated.notes) });
  assert.equal(meta.note, '3');
  // No order note and no typed customer note: no note box at all.
  assert.equal(buildTicketMeta({ channel: 'till', note: joinNotes('', withoutRecordNotes(RECORD).notes) }).note, null);
  // A note staff typed on the customer form for THIS order still reaches the kitchen.
  const typed = { ...withoutRecordNotes(RECORD), notes: orderNotesFromForm(' ring on arrival ') };
  assert.equal(joinNotes('', typed.notes), 'ring on arrival');
});

test('wiring: the customer form never takes a matched profile\'s notes', () => {
  const modal = code(read('components/CustomerModal.jsx'));
  assert.doesNotMatch(modal, /match\.notes/, 'CustomerModal must never read the matched profile\'s notes');
  assert.match(modal, /const finalNotes = orderNotesFromForm\(notes\);/);
  assert.match(modal, /name: finalName, phone: phone\.trim\(\), email: finalEmail, notes: finalNotes,/);
  // Allergens still come from the matched profile (the kitchen must see an allergy).
  assert.match(modal, /if \(Array\.isArray\(match\.allergens\) && match\.allergens\.length\) finalAllergens = match\.allergens;/);
});

test('wiring: seating a table strips the record notes from the guest', () => {
  const store = code(read('store/index.js'));
  assert.match(store, /import \{ withoutRecordNotes \} from '\.\.\/lib\/orderCustomerNotes';/);
  assert.match(store, /const seatCustomer = withoutRecordNotes\(customer \|\| tbl\?\.reservation\?\.customer \|\| null\);/);
  // The kitchen join stays: customer.notes is now only what was typed for this order.
  assert.match(store, /note: joinNotes\(session\?\.orderNote, session\?\.customer\?\.notes\),/);
  assert.match(store, /note: joinNotes\(order\.orderNote, customer\?\.notes\),/);
});

test('wiring: a table reservation saves the guest without the record notes', () => {
  const tables = code(read('surfaces/TablesSurface.jsx'));
  assert.match(tables, /customer: withoutRecordNotes\(customerObj\)/);
  assert.doesNotMatch(tables, /cols: '[^']*\bnotes\b[^']*'/, 'the reservation read back never asks for notes');
});

test('wiring: the till customer search never carries record notes', () => {
  const store = code(read('store/index.js'));
  const start = store.indexOf('\n  searchCustomersLive: async');
  assert.ok(start > 0);
  const rest = store.slice(start + 1);
  const search = rest.slice(0, rest.search(/\n {2}[A-Za-z_$][\w$]*: /));
  assert.doesNotMatch(search, /\.select\('[^']*\bnotes\b[^']*'\)/, 'no customers select in the till search asks for notes');
  assert.equal(search.split('.select(\'id, name, phone, phone_raw, email, marketing_opt_in, allergens\')').length - 1, 2);
  // customer-search still returns notes: dropped before the link search stops and before the cache.
  const strip = search.indexOf('enriched = (enriched || []).map(withoutRecordNotes).filter(Boolean);');
  assert.ok(strip > 0 && strip < search.indexOf('if (phoneless) return phonelessResults(enriched);'));
  assert.ok(strip < search.indexOf('set({ customerHistory'));
  assert.match(search, /if \(fallback\?\.length\) enriched = fallback\.map\(withoutRecordNotes\)\.filter\(Boolean\);/);
});
