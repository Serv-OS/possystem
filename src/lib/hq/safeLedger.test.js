/**
 * safeLedger.test.js: the safe as a ledger fed by till events.
 * Run: `node --test src/lib/hq/safeLedger.test.js`.
 *
 * Pinned:
 *   1. The balance is the signed sum, to the penny.
 *   2. Waiting = till events the ledger has not posted: a closed drawer's declared cash in, its
 *      opening float out, a till drop in. Posted ones vanish. A drop and a cash up never double count.
 *   3. A count only moves the ledger through an accepted adjustment.
 *   4. Unbanked days count from the last deposit, else the first cash in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeBalance, balanceAt, waitingItems, waitingTotal, movementsFromItems, countOutcome, denominationsTotal,
  suggestedDeposit, inTransit, unbankedDays, cashSummary, depositNextStatus, kindLabel,
} from './safeLedger.js';

const mv = (kind, amount, business_date, ref_kind = null, ref_id = null) => ({ kind, amount, business_date, ref_kind, ref_id });

test('safeBalance and balanceAt: signed sum, pennies, date cut', () => {
  const rows = [mv('drawer_in', 812.4, '2026-11-16'), mv('drop_in', 200, '2026-11-16'), mv('float_out', -150, '2026-11-17'), mv('adjustment', -2.4, '2026-11-17'), mv('bank_out', -700, '2026-11-18')];
  assert.equal(safeBalance(rows), 160);
  assert.equal(balanceAt(rows, '2026-11-16'), 1012.4);
  assert.equal(balanceAt(rows, '2026-11-17'), 860);
  assert.equal(safeBalance([]), 0);
  assert.equal(safeBalance([{ amount: 0.1 }, { amount: 0.2 }]), 0.3);
});

test('waitingItems: closed drawers, floats and drops the ledger has not seen', () => {
  const sessions = [
    { id: 'ds-1', drawer_id: 'd1', status: 'closed', cash_in_at: '2026-11-16T10:00:00Z', cash_out_at: '2026-11-16T23:10:00Z', opening_float: 150, declared_cash: 812.4, expected_cash: 814.8, variance: -2.4 },
    { id: 'ds-2', drawer_id: 'd1', status: 'open', cash_in_at: '2026-11-17T10:00:00Z', opening_float: 150, declared_cash: null },
    { id: 'ds-3', drawer_id: 'd2', status: 'closed', cash_in_at: '2026-11-16T10:00:00Z', cash_out_at: '2026-11-16T22:00:00Z', opening_float: 0, declared_cash: 0 },
  ];
  const drops = [
    { id: 'cm-1', type: 'cash_drop', amount: 200, timestamp: '2026-11-16T15:00:00Z', drawer_id: 'd1', staff_name: 'Jane' },
    { id: 'cm-2', type: 'cash_sale', amount: 20, timestamp: '2026-11-16T15:01:00Z' },
    { id: 'cm-3', type: 'drop', amount: 50, timestamp: '2026-11-16T18:00:00Z' },
  ];
  const w = waitingItems({ sessions, tillDrops: drops, movements: [] });
  assert.deepEqual(w.map((i) => [i.kind, i.amount, i.ref_kind, i.ref_id]), [
    ['float_out', -150, 'drawer_float', 'ds-1'],
    ['drop_in', 200, 'cash_movement', 'cm-1'],
    ['drop_in', 50, 'cash_movement', 'cm-3'],
    ['drawer_in', 812.4, 'drawer_session', 'ds-1'],
    ['float_out', -150, 'drawer_float', 'ds-2'],
  ]);
  assert.equal(w[3].detail, 'Counted, drawer short 2.40');
  assert.equal(w[1].detail, 'By Jane');
  assert.equal(waitingTotal(w), 762.4);

  const posted = [mv('float_out', -150, '2026-11-16', 'drawer_float', 'ds-1'), mv('drop_in', 200, '2026-11-16', 'cash_movement', 'cm-1'), mv('drawer_in', 812.4, '2026-11-16', 'drawer_session', 'ds-1')];
  const left = waitingItems({ sessions, tillDrops: drops, movements: posted });
  assert.deepEqual(left.map((i) => i.ref_id), ['cm-3', 'ds-2']);
  assert.deepEqual(waitingItems({}), []);
});

test('movementsFromItems: rows for the ledger, each on its own business day', () => {
  const items = waitingItems({ sessions: [{ id: 'ds-1', status: 'closed', cash_in_at: '2026-11-16T10:00:00Z', cash_out_at: '2026-11-17T01:30:00Z', opening_float: 100, declared_cash: 500 }] });
  const rows = movementsFromItems(items, { orgId: 'org', locationId: 'loc', byName: 'Pete', businessDateOf: (i) => i.at.slice(0, 10) });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { org_id: 'org', location_id: 'loc', business_date: '2026-11-16', kind: 'float_out', amount: -100, ref_kind: 'drawer_float', ref_id: 'ds-1', drawer_id: null, note: 'Opening float', created_by_name: 'Pete' });
  assert.equal(rows[1].business_date, '2026-11-17');
  assert.equal(rows[1].amount, 500);
});

test('countOutcome, denominationsTotal, suggestedDeposit', () => {
  assert.deepEqual(countOutcome(860, 860), { variance: 0, adjustment: null, words: 'Matches the ledger.' });
  const short = countOutcome(855, 860);
  assert.equal(short.variance, -5);
  assert.deepEqual(short.adjustment, { kind: 'adjustment', amount: -5, note: 'Safe count short 5.00' });
  assert.equal(short.words, 'Short by 5.00.');
  assert.equal(countOutcome('', 860).adjustment, null);
  assert.equal(denominationsTotal({ 20: 3, 5: 1, '0.05': 10 }), 65.5);
  assert.equal(suggestedDeposit(860, 300), 560);
  assert.equal(suggestedDeposit(200, 300), 0);
  assert.equal(suggestedDeposit(860), 860);
});

test('inTransit, unbankedDays, cashSummary, deposit steps', () => {
  const deposits = [
    { status: 'confirmed', amount: 500, business_date: '2026-11-10' },
    { status: 'banked', amount: 700, business_date: '2026-11-14' },
    { status: 'prepared', amount: 300, business_date: '2026-11-16' },
    { status: 'cancelled', amount: 999, business_date: '2026-11-17' },
  ];
  assert.equal(inTransit(deposits), 1000);
  assert.equal(unbankedDays({ deposits, today: '2026-11-18' }), 2);
  assert.equal(unbankedDays({ deposits: [], movements: [mv('drawer_in', 50, '2026-11-12')], today: '2026-11-18' }), 6);
  assert.equal(unbankedDays({ deposits: [], movements: [], today: '2026-11-18' }), null);
  const s = cashSummary({ movements: [mv('drawer_in', 900, '2026-11-15')], counts: [{ variance: -5, business_date: '2026-11-17', created_at: '2026-11-17T09:00:00Z' }, { variance: 0, business_date: '2026-11-16', created_at: '2026-11-16T09:00:00Z' }], deposits, today: '2026-11-18' });
  assert.equal(s.used, true);
  assert.equal(s.balance, 900);
  assert.equal(s.inTransit, 1000);
  assert.equal(s.unbankedDays, 2);
  assert.equal(s.lastVariance, -5);
  assert.equal(s.lastCountDate, '2026-11-17');
  assert.equal(s.lastDeposit.business_date, '2026-11-16');
  const empty = cashSummary({ today: '2026-11-18' });
  assert.equal(empty.used, false);
  assert.equal(empty.balance, null);
  assert.equal(depositNextStatus('prepared'), 'banked');
  assert.equal(depositNextStatus('banked'), 'confirmed');
  assert.equal(depositNextStatus('confirmed'), null);
  assert.equal(kindLabel('bank_out'), 'To the bank');
});
