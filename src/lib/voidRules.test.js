// Void rules (30 Sep 2026, Peter at Coffee Boy: "Can't void anything other than table orders").
// Pure decisions behind the Void button on the till, the Orders screen void, the kitchen
// notice and the way the reports read a void back.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VOID_REASONS, isLiveSentLine, isUnsentLine, canVoidItem, canVoidOrder, voidableLines, linesValue,
  orderVoidLabel, lineUids, ticketHasLines, voidTicketItems, voidLogEntry, buildVoidTombstone,
  checkSourceFor, normaliseCheckStatus, isVoidedCheck, voidedValue, voidLinesText,
} from './voidRules.js';

const sent    = { uid: 'a', name: 'Burger', price: 10, qty: 2, status: 'sent' };
const pending = { uid: 'b', name: 'Chips', price: 3, qty: 1, status: 'pending' };
const voided  = { uid: 'c', name: 'Cola', price: 2, qty: 1, status: 'voided', voided: true };

test('the reason list is the one the modal always had, Other last', () => {
  assert.equal(VOID_REASONS.length, 9);
  assert.equal(VOID_REASONS[0], 'Customer changed mind');
  assert.equal(VOID_REASONS[VOID_REASONS.length - 1], 'Other');
});

test('only a sent, live line can be voided; an unsent line is removed instead', () => {
  assert.equal(canVoidItem(sent), true);
  assert.equal(canVoidItem(pending), false);
  assert.equal(canVoidItem(voided), false);
  assert.equal(canVoidItem(null), false);
  assert.equal(isLiveSentLine({ ...sent, voided: true }), false);
  assert.equal(isUnsentLine(pending), true);
  assert.equal(isUnsentLine(sent), false);
  assert.equal(isUnsentLine(voided), false);
});

test('canVoidOrder: any order (table, walk in, bare list) with one live sent line', () => {
  assert.equal(canVoidOrder({ items: [pending] }), false, 'nothing sent yet');
  assert.equal(canVoidOrder({ items: [sent, pending] }), true, 'walk in shape');
  assert.equal(canVoidOrder([sent]), true, 'bare list (the till passes getPOSItems())');
  assert.equal(canVoidOrder({ items: [voided] }), false, 'already voided');
  assert.equal(canVoidOrder(null), false);
  assert.equal(canVoidOrder({}), false);
});

test('voidableLines leaves already voided lines out; linesValue is price x qty', () => {
  assert.deepEqual(voidableLines([sent, pending, voided]).map(i => i.uid), ['a', 'b']);
  assert.equal(linesValue([sent, pending]), 23);
  assert.equal(linesValue(null), 0);
});

test('orderVoidLabel names a walk in the way staff say it', () => {
  assert.equal(orderVoidLabel({ tableLabel: 'T4' }), 'T4');
  assert.equal(orderVoidLabel({ orderType: 'takeaway', customer: { name: 'Jane' } }), 'Takeaway · Jane');
  assert.equal(orderVoidLabel({ orderType: 'collection', ref: 'R35' }), 'Collection R35');
  assert.equal(orderVoidLabel({ orderType: 'drive-thru' }), 'Drive thru');
  assert.equal(orderVoidLabel({ orderType: 'dine-in', customer: 'Sam' }), 'Dine in · Sam');
  assert.equal(orderVoidLabel({}), 'Order');
});

test('kitchen tickets are matched by the line uid and flagged, never shrunk', () => {
  const uids = lineUids([sent, voided]);
  assert.deepEqual([...uids], ['a', 'c']);
  const ticket = [{ uid: 'a', name: 'Burger', qty: 2 }, { uid: 'z', name: 'Soup', qty: 1 }];
  assert.equal(ticketHasLines(ticket, uids), true);
  assert.equal(ticketHasLines([{ uid: 'z' }], uids), false);
  assert.equal(ticketHasLines(ticket, new Set()), false);
  const r = voidTicketItems(ticket, uids);
  assert.equal(r.changed, true);
  assert.equal(r.allVoided, false);
  assert.equal(r.items.length, 2, 'the line stays on the ticket');
  assert.equal(r.items[0].voided, true);
  assert.equal(r.items[1].voided, undefined);
  // Nothing to change: the same array back, so the caller writes no row.
  const again = voidTicketItems(r.items, uids);
  assert.equal(again.changed, false);
  assert.equal(again.items, r.items);
  // Every line voided: the whole order was voided.
  assert.equal(voidTicketItems(ticket, new Set(['a', 'z'])).allVoided, true);
});

test('the void log row has the same shape for a table and a walk in', () => {
  const m = { id: 's1', name: 'Kim', pin: '1234' };
  const t = voidLogEntry({ type: 'item', tableId: 't1', label: 'T4', items: [sent], reason: 'Kitchen error', manager: m, now: 5 });
  const w = voidLogEntry({ type: 'check', label: 'Takeaway · Jane', items: [sent, pending], reason: 'Duplicate order', manager: m, ref: 'R35', now: 6 });
  assert.equal(t.id, 'void-5');
  assert.equal(t.totalValue, 20);
  assert.equal(t.manager, 'Kim');
  assert.equal(t.managerId, 's1');
  assert.equal(Object.prototype.hasOwnProperty.call(t, 'pin'), false, 'never the staff record');
  assert.equal(w.tableId, null);
  assert.equal(w.ref, 'R35');
  assert.equal(w.totalValue, 23);
  assert.deepEqual(Object.keys(t).sort(), Object.keys(w).sort());
});

test('a whole order void books a tombstone with no money on it and every line flagged', () => {
  const order = { ref: 'R35', items: [sent, pending, voided], customer: { name: 'Jane', phone: '07700' } };
  const tomb = buildVoidTombstone({ order, orderType: 'takeaway', staff: { id: 'st', name: 'Ali' }, manager: { id: 'm', name: 'Kim' }, reason: 'Duplicate order', locationId: 'L1', source: 'pos', now: 1000, id: 'void-x' });
  assert.equal(tomb.id, 'void-x');
  assert.equal(tomb.ref, 'R35');
  assert.equal(tomb.status, 'voided');
  assert.equal(tomb.voided, true);
  assert.equal(tomb.method, 'void');
  assert.equal(tomb.total, 0);
  assert.equal(tomb.subtotal, 0);
  assert.equal(tomb.taxAmount, 0);
  assert.deepEqual(tomb.tenders, []);
  assert.equal(tomb.items.length, 2, 'the already voided line is not voided twice');
  assert.ok(tomb.items.every(i => i.voided === true && i.status === 'voided'));
  assert.equal(tomb.voidReason, 'Duplicate order');
  assert.equal(tomb.voidedBy, 'Kim');
  assert.equal(tomb.server, 'Ali');
  assert.equal(tomb.orderType, 'takeaway');
  assert.equal(tomb.customer.name, 'Jane');
  assert.equal(tomb.closedAt, 1000);
  assert.equal(tomb.tableId, null);
  assert.equal(tomb.seatedAt, null, 'a walk in never closes a table occupation');
  // A queue order carries its own type and customer.
  const q = buildVoidTombstone({ order: { ref: 'OL-1', type: 'collection', items: [sent], customer: { name: 'Bo' } }, manager: { name: 'Kim' }, reason: 'Other', source: 'online' });
  assert.equal(q.orderType, 'collection');
  assert.equal(q.customer.name, 'Bo');
  assert.equal(q.source, 'online');
  assert.match(q.id, /^void-\d+-/);
});

test('closed_checks.source CHECK constraint: an unknown channel books as pos', () => {
  assert.equal(checkSourceFor('kiosk'), 'kiosk');
  assert.equal(checkSourceFor('QR'), 'qr');
  assert.equal(checkSourceFor('deliveroo'), 'pos');
  assert.equal(checkSourceFor(null), 'pos');
});

test('reports read both spellings of a void as voided', () => {
  assert.equal(normaliseCheckStatus('void', true), 'voided');
  assert.equal(normaliseCheckStatus('void', false), 'voided');
  assert.equal(normaliseCheckStatus('paid', true), 'voided', 'the flag wins');
  assert.equal(normaliseCheckStatus('paid', false), 'paid');
  assert.equal(normaliseCheckStatus('refunded'), 'refunded');
  assert.equal(isVoidedCheck({ status: 'void' }), true);
  assert.equal(isVoidedCheck({ status: 'voided' }), true);
  assert.equal(isVoidedCheck({ status: 'paid', voided: true }), true);
  assert.equal(isVoidedCheck({ status: 'paid' }), false);
});

test('voidedValue: the total when there is one, else the lines (a tombstone books 0)', () => {
  assert.equal(voidedValue({ status: 'voided', total: 12.5, items: [sent] }), 12.5, 'a legacy void kept its total');
  assert.equal(voidedValue({ status: 'void', voided: true, total: 0, items: [sent, pending] }), 23);
  assert.equal(voidedValue({ status: 'paid', total: 40 }), 0, 'never for a sale');
});

test('voidLinesText reads like the toast', () => {
  assert.equal(voidLinesText([sent, pending]), '2× Burger, 1× Chips');
  assert.equal(voidLinesText([voided]), '1× Cola');
  assert.equal(voidLinesText([]), '');
});

// The wiring. Read the source so a refactor that quietly drops a branch fails here.
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the store voids a walk in (tableId null) and tells the kitchen on every path', () => {
  const src = read('../store/index.js');
  const voidItem = src.slice(src.indexOf('  voidItem: (tableId, itemUid,'), src.indexOf('  voidCheck: (tableId,'));
  const voidCheck = src.slice(src.indexOf('  voidCheck: (tableId,'), src.indexOf('  voidQueueOrder: (ref,'));
  const voidQueue = src.slice(src.indexOf('  voidQueueOrder: (ref,'), src.indexOf('  // ── Discounts ──'));
  assert.ok(voidItem.includes('if (!tableId) {'), 'voidItem has a walk in branch');
  assert.ok(voidCheck.includes('if (!tableId) {'), 'voidCheck has a walk in branch');
  assert.equal(voidItem.split('voidKitchenLines(').length - 1, 2, 'voidItem: table and walk in both notify the kitchen');
  assert.equal(voidCheck.split('voidKitchenLines(').length - 1, 2, 'voidCheck: table and walk in both notify the kitchen');
  assert.ok(voidCheck.includes('buildVoidTombstone('), 'a walk in void books a tombstone');
  assert.ok(voidCheck.includes("status: 'voided', method: 'void'"), "the table tombstone is 'voided' (the reports' spelling)");
  assert.ok(!voidCheck.includes("status: 'void',"), "no tombstone is written as 'void' any more");
  assert.ok(voidCheck.includes('removeFromQueue(order.ref)'), 'the queue row goes with the walk in');
  assert.ok(voidCheck.includes('clearWalkIn()'), 'the till is clear for the next order');
  assert.ok(voidQueue.includes('removeFromQueue(o.ref)'), 'an Orders screen void removes the row like a reject');
  assert.ok(voidQueue.includes("refund it in Back Office"), 'a prepaid order says where the money is given back');
  // The kitchen notice matches by line uid (a walk in label is shared by every unnamed takeaway).
  const kitchen = src.slice(src.indexOf('  voidKitchenLines: ('), src.indexOf('  _logVoidActivity: ('));
  assert.ok(kitchen.includes("from('kds_tickets')") && kitchen.includes('ticketHasLines('));
  assert.ok(kitchen.includes("in('status', ['pending', 'held'])"));
  assert.ok(kitchen.includes("itemLabel: `** VOID **"), 'a void docket prints to each centre');
  // Review, 30 Sep 2026: a sticker centre (splitPerItem) printed the void as plain "ITEM 1 OF 2" stickers.
  assert.ok(src.includes("centre?.splitPerItem && !job.itemLabel)"), 'a labelled notice never splits into stickers');
  // Every void path restores the daily counts through one helper.
  const voidBlock = src.slice(src.indexOf('  voidItem: ('), src.indexOf('  // ── Discounts'));
  assert.equal((voidBlock.match(/get\(\)\._restoreDailyCounts\(/g) || []).length, 5, 'both voidItem paths, both voidCheck paths, voidQueueOrder');
  assert.ok(!voidBlock.includes(' — '), 'staff toasts carry no em dash');
  const queue = src.slice(src.indexOf('  voidQueueOrder: ('), src.indexOf('  // ── Discounts'));
  assert.ok(queue.includes("o.status === 'received' ? 'reject' : 'cancel'"), 'an accepted HubRise order is cancelled, not rejected');
  assert.ok(queue.includes("payload: { status: 'cancelled' }"), 'the customer tracker sees the cancel before the row goes');
  assert.ok(queue.includes("if (get().walkInOrder?.ref === o.ref) get().clearWalkIn();"), 'the same order open on the till is cleared');
  const itemWalkIn = src.slice(src.indexOf('  voidItem: ('), src.indexOf('  // A void of the whole order.'));
  assert.ok(itemWalkIn.includes("if (order?._channelRef) { showToast('This is a channel order."), 'a HubRise pay copy refuses a line void too');
  assert.ok(kitchen.includes('if (isTrainingMode() || !supabase) return;'), 'training mode writes no ticket and prints nothing');
});

test('the till, MPOS and the Orders screen all reach the void', () => {
  const pos = read('../surfaces/POSSurface.jsx');
  assert.ok(pos.includes('const orderCanVoid = canVoidOrder(items) || (!!activeTableId && hasSent);'), 'a sent table keeps the check void after every line was voided');
  assert.ok(pos.includes('{orderCanVoid&&<button'), 'the Void button follows the order, not only the table');
  assert.ok(!pos.includes('{activeTableId&&hasSent&&<button'), 'the table only gate is gone');
  assert.ok(pos.includes('voidCheck(activeTableId||null, opts)'));
  const mpos = read('../surfaces/mpos/MItemActions.jsx');
  assert.ok(mpos.includes('voidItem?.(activeTableId || null, item.uid, {'), 'MPOS voids a walk in line for real');
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.ok(hub.includes("import VoidModal from '../components/VoidModal';"));
  assert.ok(hub.includes('voidQueueOrder(voidOrder.ref, opts)'));
  assert.ok(hub.includes('const canVoid = order._kind === \'queue\''));
  const modal = read('../components/VoidModal.jsx');
  assert.ok(modal.includes("import { VOID_REASONS } from '../lib/voidRules';"), 'one reason list everywhere');
});

test('closed checks load with the normalised status; the reports value a void from its lines', () => {
  const db = read('./db.js');
  assert.equal(db.split('status: normaliseCheckStatus(c.status, c.voided)').length - 1, 2, 'both closed check loaders');
  for (const f of ['../backoffice/sections/reports/Exceptions.jsx', '../backoffice/sections/reports/Servers.jsx', '../backoffice/sections/reports/Shifts.jsx']) {
    assert.ok(read(f).includes('voidedValue(c)'), f);
  }
  const card = read('../surfaces/kds/KdsTicketCard.jsx');
  assert.equal(card.split('<VoidBlock voids={view.voids}').length - 1, 2, 'card and pop out both show the void');
});
