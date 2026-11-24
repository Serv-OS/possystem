// More than one check on a table (lib/tableChecks.js). Peter, Provo, 24 Nov 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveItems, hasLiveItems, openChecksOf, nextCheckNumber, checkIdFor, checkLabelFor, afterCheckDropped, floorStatus, checksToPick, newCheckTarget } from './tableChecks.js';

const line = (uid, extra = {}) => ({ uid, name: uid, qty: 1, price: 5, ...extra });
const sess = (id, items) => ({ id, items, seatedAt: 1, covers: 2, server: 'Jane' });
const table = (id, label, extra = {}) => ({ id, label, status: 'available', session: null, ...extra });
const child = (parentId, n, parentLabel, items) => ({ id: checkIdFor(parentId, n), label: checkLabelFor(parentLabel, n), parentId, status: 'open', session: sess(`s-${parentId}-${n}`, items) });

test('a voided line is not on the check', () => {
  assert.equal(liveItems(sess('a', [line('x'), line('y', { voided: true })])).length, 1);
  assert.equal(liveItems(null).length, 0);
  assert.equal(hasLiveItems(table('t1', 'T1', { session: sess('a', [line('x', { voided: true })]) })), false);
});

test('the next check number is the lowest one free, never one in use', () => {
  const t6 = table('t6', 'T6', { status: 'occupied', session: sess('s1', [line('a')]) });
  assert.equal(nextCheckNumber([t6], 't6'), 2);
  assert.equal(nextCheckNumber([t6, child('t6', 2, 'T6', [line('b')])], 't6'), 3);
  // T6.2 was paid and T6.3 is still open: the old rule (children + 2) gave 3 again.
  const after = [t6, child('t6', 3, 'T6', [line('c')])];
  assert.equal(after.filter(t => t.parentId === 't6').length + 2, 3, 'the old rule lands on the live T6.3');
  assert.equal(nextCheckNumber(after, 't6'), 2);
  assert.equal(nextCheckNumber([t6, child('t6', 2, 'T6', []), child('t6', 3, 'T6', [])], 't6'), 4);
});

test('paying the first check keeps every other check that still holds lines', () => {
  const t6 = table('t6', 'T6', { status: 'occupied', session: sess('s1', [line('a')]), childIds: ['t6-2', 't6-3', 't6-9'] });
  const c2 = child('t6', 2, 'T6', [line('b')]);
  const c3 = child('t6', 3, 'T6', [line('c', { voided: true })]);
  const t7 = table('t7', 'T7', { status: 'occupied', session: sess('s7', [line('z')]) });
  const out = afterCheckDropped([t6, c2, c3, t7], 't6');
  const p = out.find(t => t.id === 't6');
  assert.equal(p.session, null);
  assert.equal(p.status, 'available');
  assert.deepEqual(p.childIds, ['t6-2']);
  assert.ok(out.find(t => t.id === 't6-2'), 'the unpaid check stays');
  assert.equal(out.find(t => t.id === 't6-2').session.items.length, 1);
  assert.equal(out.find(t => t.id === 't6-3'), undefined, 'a check with nothing on it goes');
  assert.equal(out.find(t => t.id === 't7'), t7, 'other tables are not touched');
  assert.equal(floorStatus(p, out), 'occupied', 'the table is not free');
});

test('paying the first check of a table with no other check frees it', () => {
  const t6 = table('t6', 'T6', { status: 'occupied', session: sess('s1', [line('a')]) });
  const out = afterCheckDropped([t6], 't6');
  assert.deepEqual(out, [{ ...t6, status: 'available', session: null, childIds: [] }]);
  assert.equal(floorStatus(out[0], out), 'available');
});

test('paying another check removes it; the table is freed with the last one', () => {
  const t6 = table('t6', 'T6', { status: 'occupied', session: sess('s1', [line('a')]), childIds: ['t6-2'] });
  const c2 = child('t6', 2, 'T6', [line('b')]);
  const one = afterCheckDropped([t6, c2], 't6-2');
  assert.equal(one.length, 1);
  assert.equal(one[0].session.id, 's1', 'the first check is still there');
  assert.deepEqual(one[0].childIds, []);
  // First check paid first, then the second: the table ends free.
  const firstPaid = afterCheckDropped([t6, c2], 't6');
  const done = afterCheckDropped(firstPaid, 't6-2');
  assert.equal(done.length, 1);
  assert.equal(done[0].status, 'available');
  assert.equal(done[0].session, null);
  assert.deepEqual(done[0].childIds, []);
  // Two other checks: paying one keeps the table held by the other.
  const c3 = child('t6', 3, 'T6', [line('c')]);
  const two = afterCheckDropped(afterCheckDropped([{ ...t6, childIds: ['t6-2', 't6-3'] }, c2, c3], 't6'), 't6-2');
  assert.deepEqual(two.map(t => t.id), ['t6', 't6-3']);
  assert.equal(floorStatus(two[0], two), 'occupied');
});

test('a table that is not there changes nothing', () => {
  const list = [table('t1', 'T1')];
  assert.equal(afterCheckDropped(list, 'nope'), list);
  assert.deepEqual(afterCheckDropped(null, 't1'), []);
});

test('the checks to pick: the first when it is open, then the others in number order', () => {
  const t6 = table('t6', 'T6', { status: 'occupied', session: sess('s1', [line('a')]) });
  const c2 = child('t6', 2, 'T6', [line('b')]);
  const c10 = child('t6', 10, 'T6', [line('c')]);
  assert.deepEqual(checksToPick([t6, c10, c2], t6).map(t => t.id), ['t6', 't6-2', 't6-10']);
  const paid = { ...t6, session: null, status: 'available' };
  assert.deepEqual(checksToPick([paid, c10, c2], paid).map(t => t.id), ['t6-2', 't6-10']);
  assert.deepEqual(checksToPick([t6], t6).map(t => t.id), ['t6']);
  assert.deepEqual(openChecksOf([t6, c2], 't6').map(t => t.id), ['t6-2']);
  assert.equal(floorStatus(t6, [t6, c2]), 'occupied');
  assert.equal(floorStatus(c2, [t6, c2]), 'open');
});

test('where a new check goes is decided when staff press Send or Pay', () => {
  const t6 = table('t6', 'T6', { status: 'occupied', session: sess('s1', [line('a')]) });
  const c2 = child('t6', 2, 'T6', [line('b')]);
  assert.deepEqual(newCheckTarget([t6], 't6'), { action: 'split', tableId: 't6' });
  // The first check was paid while the order was being taken: still a separate check.
  assert.deepEqual(newCheckTarget([{ ...t6, session: null }, c2], 't6'), { action: 'split', tableId: 't6' });
  // Every check was paid: the order seats the table as its first check.
  assert.deepEqual(newCheckTarget([{ ...t6, session: null, status: 'available' }], 't6'), { action: 'seat', tableId: 't6' });
  assert.equal(newCheckTarget([t6, c2], 't6-2'), null, 'never a check on a check');
  assert.equal(newCheckTarget([t6], 'gone'), null);
  assert.equal(newCheckTarget([t6], undefined), null);
});

// The wiring: the store, the floor plan and the till all go through the rules above.
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const has = (src, needle, why) => assert.ok(src.includes(needle), why);

test('store: numbering, the kept checks and New check go through lib/tableChecks.js', () => {
  const src = read('../store/index.js');
  has(src, 'const checkNum = nextCheckNumber(get().tables, parentTableId);', 'the new check takes the lowest free number');
  assert.ok(!src.includes('existingChildren.length + 2'), 'the count based number is gone');
  has(src, 'set(s => ({ tables: afterCheckDropped(s.tables, tableId) }));', 'closing a check keeps the other checks');
  has(src, "if (!t.session || parentItems.length === (t.session.items || []).length) return { ...t, childIds };", 'a paid first check is never handed an empty session');
  has(src, "set({ newCheckFor: { tableId, label: t.label || tableId }, activeTableId: null, surface: 'pos', orderType: 'dine-in' });", 'New check opens the till with no table written yet');
  has(src, 'deliveryQuote:null, newCheckFor:null })),', 'clearing the order forgets the new check');
});

test('floor plan: New check sits under Add to order, and a held table is not offered a seat', () => {
  const src = read('../surfaces/TablesSurface.jsx');
  const add = src.indexOf("onClick={()=>handleAction('open_pos')} style={{ height:44, fontSize:14 }}>Add to order →</button>");
  const btn = src.indexOf('onClick={()=>newCheck(selectedTable)}', add);
  const pay = src.indexOf('Take payment</button>', add);
  assert.ok(add > 0 && btn > add && btn < pay, 'the button is between Add to order and Take payment');
  has(src, "{heldChecks.length === 0 && !selectedTable.session && !selectedBk && (selectedTable.status==='available' || selectedTable.status==='reserved') && (", 'no Seat guests while another check is open');
  has(src, 'if (startNewCheck(table.id)) setSelected(null);', 'the button starts the new check');
});

test('till: Send and Pay make the check, and the pop up is not asked', () => {
  const src = read('../surfaces/POSSurface.jsx');
  has(src, 'const forNewCheck = !activeTableId && newCheckFor ? newCheckFor : null;', 'a new check only while no table is open');
  has(src, 'if (forNewCheck) { if (placeNewCheck()) setShowCheckout(true); } else if (detailsNeeded)', 'the review screen pays a new check without the pop up');
  has(src, "if (target.action === 'split') st.splitTableCheck(target.tableId, items, st.staff?.name);", 'a separate check on the table');
  has(src, 'if (forNewCheck) { if (!items.length || !placeNewCheck()) return; proceedToCheckout(); return; }', 'Pay makes the check first');
  const send = src.indexOf('if (useStore.getState().newCheckFor) {');
  const popup = src.indexOf("if (!afterDetails && detailsNeeded) { setDetailsFor('send'); return; }");
  assert.ok(send > 0 && send < popup, 'Send looks at the new check before anything else');
  has(src, 'if (activeTableId || newCheckFor || walkInOrder?.items?.length) return;', 'the start order type never replaces dine in on a new check');
});
