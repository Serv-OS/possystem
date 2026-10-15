// src/lib/qrTabStranded.test.js
//
// "I also have a table that says removed table, then when I try to close it with cash it
// wont, I have no idea where that came from" (Peter, 21 Sep 2026, live).
//
// Table t1 at Provo: three lines, GBP 46.00, and no way out.
//   * the floor plan showed "Removed table" (no floor_tables row: deleted while the
//     session was open, which is the tombstone that keeps the money visible),
//   * clearTable refused it, because active_sessions said source 'qr' and a QR tab holds
//     a card pre-authorisation that only Orders Hub can capture,
//   * and Orders Hub had nothing to show: the order_queue row that WAS the tab was gone.
//
// The guard is right while the tab is live. It is a dead end once the tab is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { qrCloseDecision, isQrTabForTable, qrSessionShownInQrSection, qrSessionPaidOff } from './qrTabStranded.js';

const STORE = readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
const qrSession = { source: 'qr', items: [{ name: 'Beer' }] };

test('a LIVE QR tab still belongs to Orders Hub', () => {
  const queue = [{ ref: 'QR-1', source: 'qr', customer: { tableId: 't1', tableLabel: 'T1' } }];
  const d = qrCloseDecision({ session: qrSession, tableId: 't1', orderQueue: queue });
  assert.deepEqual(d, { block: true, reason: 'live_tab' }, 'closing it on the floor would double charge');
});

test('Peter s table: a QR session whose tab has gone can be closed at the till', () => {
  const d = qrCloseDecision({ session: qrSession, tableId: 't1', orderQueue: [] });
  assert.deepEqual(d, { block: false, reason: 'stranded' });
  // and the same with a queue that simply holds other people's orders
  const others = [{ ref: 'OL-9', source: 'online' }, { ref: 'QR-2', source: 'qr', customer: { tableId: 't9' } }];
  assert.equal(qrCloseDecision({ session: qrSession, tableId: 't1', orderQueue: others }).block, false);
});

test('an ordinary table is never touched by this rule', () => {
  assert.deepEqual(qrCloseDecision({ session: { source: 'pos' }, tableId: 't4', orderQueue: [] }), { block: false, reason: 'not_qr' });
  assert.deepEqual(qrCloseDecision({ session: null, tableId: 't4' }), { block: false, reason: 'not_qr' });
  assert.deepEqual(qrCloseDecision({}), { block: false, reason: 'not_qr' });
});

test('a tab is matched by id, by the label the customer saw, or by its ref', () => {
  assert.equal(isQrTabForTable({ source: 'qr', customer: { tableId: 't1' } }, 't1'), true);
  assert.equal(isQrTabForTable({ source: 'qr', customer: { tableLabel: 'T1' } }, 'x', { label: 't1' }), true, 'case does not matter');
  assert.equal(isQrTabForTable({ source: 'qr', ref: 'QR-77' }, 'x', { ref: 'QR-77' }), true);
  // never match another table, and never match a non QR row
  assert.equal(isQrTabForTable({ source: 'qr', customer: { tableId: 't2' } }, 't1'), false);
  assert.equal(isQrTabForTable({ source: 'online', customer: { tableId: 't1' } }, 't1'), false);
  assert.equal(isQrTabForTable(null, 't1'), false);
});

test('both till paths ask the same question', () => {
  // clearTable (taking the money) and openTableInPOS (opening the order)
  assert.equal((STORE.match(/qrCloseDecision\(/g) || []).length, 2);
  assert.match(STORE, /const qrClose = qrCloseDecision\(\{ session: qrTable\?\.session, tableId, orderQueue: get\(\)\.orderQueue \}\);/);
  assert.match(STORE, /if \(qrClose\.block\) \{/);
  // the old unconditional refusal is gone from both
  assert.doesNotMatch(STORE, /if \(qrTable\?\.session\?\.source === 'qr'\) \{/);
  assert.doesNotMatch(STORE, /if \(t\?\.session\?\.source === 'qr'\) \{/);
  // and a stranded close says so in the log, because it is a close somebody may ask about
  assert.match(STORE, /QR session with no open tab in the queue/);
});

// ── 2 Oct 2026: one QR order, one card on the Orders screen ─────────────────────
// Peter, Coffee Boy Leeds, live: "online ordering, when you order to table you get 2 orders ...
// it's opening 2 tables for some reason, one on the actual table 6 and 6.1, that needs to not
// happen." The real rows: floor table id t-1790408276961, label T6; QR-FAUOB with
// customer.tableId "T6" (the label the QR link carries) and tableLabel "T6.1".

const LEEDS_T6 = {
  id: 't-1790408276961', label: 'T6', status: 'occupied',
  session: { source: 'qr', server: 'QR', covers: 1, items: [{ name: 'Mont Blanc — Big Boy', kitchenName: 'Big Boy', qty: 1, price: 5.6, tab_pi: 'HZRBXVNKS23PB4H6' }] },
};
const QR_FAUOB = { ref: 'QR-FAUOB', source: 'qr', status: 'prep', paid: true, customer: { tableId: 'T6', tableLabel: 'T6.1', name: 'Petwr' } };

test('the QR link carries the table LABEL: the row still belongs to the floor table', () => {
  assert.equal(isQrTabForTable(QR_FAUOB, LEEDS_T6.id, LEEDS_T6.session), false, 'the id alone never matched (why the till guards miss it)');
  assert.equal(isQrTabForTable(QR_FAUOB, LEEDS_T6.id, LEEDS_T6.session, 'T6'), true, 'matched on the label');
  assert.equal(isQrTabForTable(QR_FAUOB, LEEDS_T6.id, LEEDS_T6.session, 't6'), true, 'case does not matter');
  assert.equal(isQrTabForTable({ ...QR_FAUOB, customer: { tableId: 'T7', tableLabel: 'T7' } }, LEEDS_T6.id, LEEDS_T6.session, 'T6'), false, 'never another table');
  assert.equal(isQrTabForTable({ ...QR_FAUOB, customer: { tableId: 'T60', tableLabel: 'T60.1' } }, LEEDS_T6.id, LEEDS_T6.session, 'T6'), false, 'T60 is not T6');
  assert.equal(isQrTabForTable({ ...QR_FAUOB, customer: { tableId: 'T6', tableLabel: 'T6' } }, LEEDS_T6.id, null, 'T6'), true, 'the plain label a first order now carries');
});

test('Peter s order: the QR copy on Table T6 is not a second card', () => {
  assert.equal(qrSessionShownInQrSection(LEEDS_T6, [QR_FAUOB]), true, 'the QR card is the order');
});

test('a table staff must still see stays on the Orders screen', () => {
  // an ordinary table
  assert.equal(qrSessionShownInQrSection({ id: 't1', label: 'T1', session: { items: [{ name: 'Beer' }] } }, [QR_FAUOB]), false);
  assert.equal(qrSessionShownInQrSection({ id: 't1', label: 'T1', session: null }, [QR_FAUOB]), false);
  assert.equal(qrSessionShownInQrSection(null, [QR_FAUOB]), false);
  // the stranded tab of 21 Sep: no QR row left in the queue, so the table card is the only way in
  assert.equal(qrSessionShownInQrSection(LEEDS_T6, []), false);
  assert.equal(qrSessionShownInQrSection(LEEDS_T6, [{ ref: 'OL-1', source: 'online' }, { ...QR_FAUOB, customer: { tableId: 'T9' } }]), false);
  // Preston, 2 Oct: staff rang a tea onto the QR session. That line is on no QR card.
  const withTillLine = { ...LEEDS_T6, session: { ...LEEDS_T6.session, items: [...LEEDS_T6.session.items, { uid: 'i60', name: 'Tea — Small Boy', qty: 1, price: 2.85 }] } };
  assert.equal(qrSessionShownInQrSection(withTillLine, [QR_FAUOB]), false);
});

test('the Orders screen leaves the QR copy out of its Tables section', () => {
  const HUB = readFileSync(new URL('../surfaces/OrdersHub.jsx', import.meta.url), 'utf8');
  assert.match(HUB, /tables\.filter\(t => t\.status !== 'available' && t\.session && !qrSessionShownInQrSection\(t, orderQueue\)\)/);
});

// ── 2 Oct 2026, review: the floor copy of a paid QR order is let go by every till ─
// The live rows. active_sessions for Leeds T6 (written by the phone at 10:35, written again by a
// till at 11:16), and the sale the server booked for QR-FAUOB the second it was paid.

const LEEDS_T6_ROW = {
  items: [{ cat: 'cat-1789995407717_5c26956b', qty: 1, cats: [], mods: [], name: 'Mont Blanc — Big Boy', fired: true, price: 5.6, course: 1,
    itemId: 'm-1789995489544_5c26956b', status: 'sent', tab_pi: 'HZRBXVNKS23PB4H6', parentId: 'm-1789995447762_5c26956b', kitchenName: 'Big Boy', receiptName: null }],
  total: 5.6, covers: 1, sentAt: 1790937347637, server: 'QR', source: 'qr', openedAt: 1790937346153, subtotal: 5.6, qr_tab_count: 1,
};
// database shape (a till that booted after the sale) and store shape (a till that saw it live)
const CHECK_DB = { id: 'chk-1790937346153-4st', ref: 'QR-FAUOB', status: 'paid', source: 'qr', table_id: 'T6', seated_at: null,
  customer: { tableId: 'T6', tableLabel: 'T6.1', payment_intent_id: 'HZRBXVNKS23PB4H6' },
  stripe_payment_intent_id: 'HZRBXVNKS23PB4H6', payment_intents: [{ id: 'HZRBXVNKS23PB4H6', amountMinor: 560 }],
  tenders: [{ method: 'card', amount: 5.6, psp_ref: 'HZRBXVNKS23PB4H6', processor: 'adyen' }] };
const CHECK_STORE = { id: 'chk-1790937346153-4st', ref: 'QR-FAUOB', status: 'paid', tableId: 'T6', seatedAt: null,
  customer: { payment_intent_id: 'HZRBXVNKS23PB4H6' }, stripePaymentIntentId: 'HZRBXVNKS23PB4H6', paymentIntents: [{ id: 'HZRBXVNKS23PB4H6' }] };
const TILL_SALE = { id: 'chk-9', ref: 'R6404', tableId: 't-1', seatedAt: 1000, method: 'card', tenders: [{ method: 'card', psp_ref: 'OTHERREF' }] };

test('Leeds T6: the copy of a paid, booked QR order is finished', () => {
  assert.equal(qrSessionPaidOff(LEEDS_T6_ROW, [TILL_SALE, CHECK_DB]), true, 'database shape');
  assert.equal(qrSessionPaidOff(LEEDS_T6_ROW, [CHECK_STORE]), true, 'store shape');
  assert.equal(qrSessionPaidOff(LEEDS_T6_ROW, [{ tenders: [{ psp_ref: 'HZRBXVNKS23PB4H6' }] }]), true, 'the card tender alone is enough');
  assert.equal(qrSessionPaidOff(LEEDS_T6_ROW, [{ customer: { payment_intent_id: 'HZRBXVNKS23PB4H6' }, status: 'refunded' }]), true, 'a refunded order is finished too');
});

test('nothing is dropped without proof that its money is booked', () => {
  assert.equal(qrSessionPaidOff(LEEDS_T6_ROW, []), false, 'no sale on this till yet');
  assert.equal(qrSessionPaidOff(LEEDS_T6_ROW, null), false);
  assert.equal(qrSessionPaidOff(LEEDS_T6_ROW, [TILL_SALE]), false, 'another payment proves nothing');
  // an open tab: its sale is only written when the tab closes
  const tab = { source: 'qr', openedAt: 5, items: [{ name: 'Beer', tab_pi: 'pi_tab' }, { name: 'Beer', tab_pi: 'pi_tab' }] };
  assert.equal(qrSessionPaidOff(tab, [CHECK_DB]), false);
  // a paid order and an open tab on the same table: the tab keeps the table
  const mixed = { ...LEEDS_T6_ROW, items: [...LEEDS_T6_ROW.items, { name: 'Beer', tab_pi: 'pi_tab' }] };
  assert.equal(qrSessionPaidOff(mixed, [CHECK_DB]), false);
  assert.equal(qrSessionPaidOff(mixed, [CHECK_DB, { customer: { payment_intent_id: 'pi_tab' } }]), true, 'until the tab is closed and booked as well');
});

test('a line staff rang in at the till is never dropped (Preston, 2 Oct)', () => {
  const preston = { source: 'qr', server: 'Staff', openedAt: 5, items: [
    { name: 'Blueberry Iced Matcha — Big Boy', status: 'voided', voided: true, tab_pi: 'GTJFLFQPHN998GG6' },
    { uid: 'i60', name: 'Tea — Small Boy', qty: 1, price: 2.85, status: 'sent' },
  ] };
  assert.equal(qrSessionPaidOff(preston, [{ customer: { payment_intent_id: 'GTJFLFQPHN998GG6' } }]), false);
  assert.equal(qrSessionPaidOff({ ...LEEDS_T6_ROW, items: [{ name: 'Free refill', tab_pi: null }] }, [CHECK_DB]), false, 'a QR line with no payment on it');
  assert.equal(qrSessionPaidOff({ ...LEEDS_T6_ROW, items: [] }, [CHECK_DB]), false, 'an empty session proves nothing');
});

test('only a QR floor copy: a till s own table is never judged by this rule', () => {
  const till = { id: 'ORD-7', seatedAt: 1000, server: 'Jane', items: [{ name: 'Latte', tab_pi: 'HZRBXVNKS23PB4H6' }] };
  assert.equal(qrSessionPaidOff(till, [CHECK_DB]), false, 'no source qr');
  assert.equal(qrSessionPaidOff({ ...LEEDS_T6_ROW, seatedAt: 1000 }, [CHECK_DB]), false, 'a session with its own seatedAt uses the seatedAt rule');
  assert.equal(qrSessionPaidOff(null, [CHECK_DB]), false);
});

test('the one closed test every sync path asks uses it', () => {
  const CLOSURE = readFileSync(new URL('../sync/sessionClosure.js', import.meta.url), 'utf8');
  assert.match(CLOSURE, /import \{ qrSessionPaidOff \} from '\.\.\/lib\/qrTabStranded';/);
  assert.match(CLOSURE, /return qrSessionPaidOff\(session, checks\);/);
  // a QR copy has openedAt and no seatedAt: it must get past the "no key at all" early return
  assert.match(CLOSURE, /if \(!session\.seatedAt && !session\.openedAt\) return false;/);
  assert.ok(LEEDS_T6_ROW.openedAt && !LEEDS_T6_ROW.seatedAt);
});
