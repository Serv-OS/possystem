// customerImportMoney.test.js — points and gift card balances coming IN.
//
// Peter, 21 Sep 2026: "We need to be able to import Gift cards points balances
// not just stamp cards."
//
// Two different risks, tested as two different things:
//   * POINTS are a number in our own system. Doubling them is embarrassing and
//     fixable.
//   * A GIFT CARD is money a customer is holding a plastic card for. Doubling
//     one invents money, and topping up a card that has been spent since gives
//     it back. So an existing code is never touched.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readMoney, readCsv, validateRows, summarise, canonicalHeader,
  MAX_POINTS, MAX_GIFT_BALANCE,
} from './customerImport.js';
import {
  confirmLines, moneyLine, chunkSizeFor, CHUNK_SIZE, GIFT_CHUNK_SIZE, mergeResult,
  balanceDestinationLines, needsStampCard, importBlockReason,
} from './customerImportScreen.js';
import {
  pointsKey, pointsOwed, pointsSkipped, alreadyPointedLine,
  giftKey, giftRowsOf, giftSplit, alreadyCardedLine,
} from '../../supabase/functions/_shared/customerImportPlan.ts';

const OPTS = { country: 'GB', today: '2026-09-21' };

// ── reading money ───────────────────────────────────────────────────────────

test('money is read out of whatever the other system wrote', () => {
  assert.equal(readMoney('12.50').minor, 1250);
  assert.equal(readMoney('£12.50').minor, 1250);
  assert.equal(readMoney('$5').minor, 500);
  assert.equal(readMoney('12,50').minor, 1250, 'a European decimal comma');
  assert.equal(readMoney('1,250.00').minor, 125000, 'a thousands separator');
  assert.equal(readMoney('12.5').minor, 1250);
  assert.equal(readMoney('0').minor, 0);
  assert.equal(readMoney('GBP 3.20').minor, 320);
});

test('the pence are exact, never a float that lost one', () => {
  // 12.45 * 100 is 1244.9999999999998 in binary floating point.
  assert.equal(readMoney('12.45').minor, 1245);
  assert.equal(readMoney('0.07').minor, 7);
  assert.equal(readMoney('8.29').minor, 829);
  assert.equal(readMoney('19.99').minor, 1999);
});

test('what money is NOT', () => {
  assert.equal(readMoney('-3.00').ok, false, 'a card cannot hold less than nothing');
  assert.equal(readMoney('(3.00)').ok, false, 'accountants write a negative like this');
  assert.equal(readMoney('12.500').ok, false, 'three decimals is a separator we misread, not half a penny');
  assert.equal(readMoney('twelve pounds').ok, false);
  assert.equal(readMoney(String(MAX_GIFT_BALANCE + 1), MAX_GIFT_BALANCE).ok, false, 'above the cap is a column in the wrong place');
  assert.equal(readMoney('20250412', MAX_GIFT_BALANCE).ok, false, 'a date landing in the money column');
});

test('blank money is blank, not zero pounds of nothing', () => {
  for (const blank of ['', '   ', 'n/a', 'none', '-', null, undefined]) {
    const r = readMoney(blank);
    assert.equal(r.ok, true, String(blank));
    assert.equal(r.empty, true, String(blank));
    assert.equal(r.minor, 0);
  }
});

// ── the columns ─────────────────────────────────────────────────────────────

test('points and gift card columns are recognised by the names other systems use', () => {
  assert.equal(canonicalHeader('Points'), 'points');
  assert.equal(canonicalHeader('Loyalty Points'), 'points');
  assert.equal(canonicalHeader('Gift Card Balance'), 'gift_card_balance');
  assert.equal(canonicalHeader('Stored Value'), 'gift_card_balance');
  assert.equal(canonicalHeader('Gift Card Number'), 'gift_card_code');
  assert.equal(canonicalHeader('Voucher Code'), 'gift_card_code');
});

test('a points balance is never read as stamps', () => {
  const csv = [
    'name,phone,points,stamps',
    'Jane,07700 900123,3200,4',
  ].join('\r\n');
  const out = validateRows(readCsv(csv).rows, OPTS);
  assert.deepEqual(out.errors, []);
  assert.equal(out.ready[0].points, 3200);
  assert.equal(out.ready[0].stamps, 4, 'the stamps column is untouched');
});

test('points above the cap stop the row rather than going in', () => {
  const csv = ['name,phone,points', 'Jane,07700 900123,' + (MAX_POINTS + 1)].join('\r\n');
  const out = validateRows(readCsv(csv).rows, OPTS);
  assert.equal(out.ready.length, 0);
  assert.match(out.errors[0].message, /too high/i);
});

// ── a card needs both halves ────────────────────────────────────────────────

test('a balance with no code, and a code with no balance, are both refused', () => {
  const csv = [
    'name,phone,gift_card_code,gift_card_balance',
    'No Code,07700 900123,,12.50',
    'No Money,07700 900124,GC-1234-5678,',
  ].join('\r\n');
  const out = validateRows(readCsv(csv).rows, OPTS);
  assert.equal(out.ready.length, 0, 'neither row is a card we can make');
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0].message, /no card code/i);
  assert.match(out.errors[1].message, /no balance/i);
});

test('one card code cannot belong to two people', () => {
  const csv = [
    'name,phone,gift_card_code,gift_card_balance',
    'First Owner,07700 900123,GC-1234-5678,10.00',
    'Second Owner,07700 900124,gc-1234-5678,25.00',
  ].join('\r\n');
  const out = validateRows(readCsv(csv).rows, OPTS);
  // BOTH people go in. Only the card comes off the second one, and it is said.
  assert.equal(out.ready.length, 2);
  assert.equal(out.ready[0].giftCardMinor, 1000);
  assert.equal(out.ready[1].giftCardCode, null, 'the second row keeps the person, loses the card');
  assert.equal(out.ready[1].giftCardMinor, 0);
  const said = out.warnings.find((w) => w.field === 'gift_card_code');
  assert.ok(said, 'and we say so, rather than dropping money quietly');
  assert.match(said.message, /already on row 2/);
});

// ── the totals the operator reads before pressing the button ────────────────

test('the summary counts points and the money on the cards', () => {
  const csv = [
    'name,phone,points,gift_card_code,gift_card_balance',
    'Jane,07700 900123,320,GC-0001,12.50',
    'Bob,07700 900124,80,GC-0002,7.25',
    'Ann,07700 900125,0,,',
  ].join('\r\n');
  const checked = validateRows(readCsv(csv).rows, OPTS);
  const sum = summarise(checked, checked.ready.map((r) => ({ row_number: r.rowNumber, verdict: 'new' })));
  assert.equal(sum.withPoints, 2);
  assert.equal(sum.pointsTotal, 400);
  assert.equal(sum.withGiftCards, 2);
  assert.equal(sum.giftMinorTotal, 1975);
});

test('the confirm says the money out loud, in the venue currency', () => {
  const lines = confirmLines({ newCustomers: 2, withPoints: 2, pointsTotal: 400, withGiftCards: 2, giftMinorTotal: 1975, currency: 'GBP' });
  const joined = lines.join(' ');
  assert.match(joined, /£19\.75/);
  assert.match(joined, /spendable at the till/);
  assert.match(joined, /400 points/);
  assert.equal(moneyLine(1975, 'USD'), '$19.75');
  assert.equal(moneyLine(0, 'GBP'), '£0.00');
});

test('a file with cards goes to the server in smaller slices', () => {
  // argon2id per card, tens of milliseconds each: 200 in one request is a
  // minute of work and a request that may never come back.
  assert.equal(chunkSizeFor({ withGiftCards: 0 }), CHUNK_SIZE);
  assert.equal(chunkSizeFor({ withGiftCards: 12 }), GIFT_CHUNK_SIZE);
  assert.equal(chunkSizeFor(null), CHUNK_SIZE);
  assert.ok(GIFT_CHUNK_SIZE < CHUNK_SIZE);
});

// ── the server side guards ──────────────────────────────────────────────────

const row = (over) => ({ rowNumber: 2, verdict: 'new', reason: '', customerId: 'c1', matchedOn: '', row: { points: 0, giftCardCode: null, giftCardMinor: 0, ...over } });

test('points are credited once, whatever batch the second file came under', () => {
  const decisions = [row({ points: 300 }), { ...row({ points: 50 }), rowNumber: 3, customerId: 'c2' }];
  assert.equal(pointsOwed(decisions, new Set()).length, 2);
  // c1 was credited by an earlier import, under a DIFFERENT batch id
  const owed = pointsOwed(decisions, new Set(['c1']));
  assert.deepEqual(owed.map((d) => d.customerId), ['c2']);
  const skipped = pointsSkipped(decisions, new Set(['c1']));
  assert.deepEqual(skipped.map((d) => d.customerId), ['c1']);
  assert.match(alreadyPointedLine(skipped.length), /already imported points for 1 of these people/);
});

test('a row with no points is not a points row at all', () => {
  assert.equal(pointsOwed([row({ points: 0 })], new Set()).length, 0);
  assert.equal(pointsOwed([{ ...row({ points: 10 }), verdict: 'blocked' }], new Set()).length, 0);
  assert.equal(pointsOwed([{ ...row({ points: 10 }), customerId: null }], new Set()).length, 0);
  assert.equal(alreadyPointedLine(0), '');
});

test('the keys are stable and say what they claim', () => {
  assert.equal(pointsKey('b1', 'c1'), 'import:b1:c1:points');
  assert.equal(giftKey('b1', 'c1'), 'import:b1:c1:gift');
  assert.notEqual(pointsKey('b1', 'c1'), giftKey('b1', 'c1'));
});

test('a gift card we already hold is left exactly as it is', () => {
  const rows = [
    row({ giftCardCode: 'GC-0001', giftCardMinor: 1250 }),
    { ...row({ giftCardCode: 'GC-0002', giftCardMinor: 500 }), rowNumber: 3, customerId: 'c2' },
  ];
  assert.equal(giftRowsOf(rows).length, 2);
  const lookupOf = (d) => 'hash-of-' + d.row.giftCardCode;
  const split = giftSplit(rows, new Set(['hash-of-GC-0001']), lookupOf);
  assert.deepEqual(split.create.map((d) => d.row.giftCardCode), ['GC-0002']);
  assert.deepEqual(split.already.map((d) => d.row.giftCardCode), ['GC-0001']);
  assert.match(alreadyCardedLine(1), /left the balance exactly as it is/);
});

test('a card with no money, or on a blocked row, is not a card to make', () => {
  assert.equal(giftRowsOf([row({ giftCardCode: 'GC-1', giftCardMinor: 0 })]).length, 0);
  assert.equal(giftRowsOf([row({ giftCardCode: null, giftCardMinor: 900 })]).length, 0);
  assert.equal(giftRowsOf([{ ...row({ giftCardCode: 'GC-1', giftCardMinor: 900 }), verdict: 'blocked' }]).length, 0);
  assert.equal(alreadyCardedLine(0), '');
});

test('the running totals add up across slices, in either spelling', () => {
  let acc = mergeResult(null, { chunk: { pointed: 3, already_pointed: 1, cards_made: 2, cards_minor: 1975, already_carded: 1 } });
  acc = mergeResult(acc, { chunk: { pointed: 2, cards_made: 1, cards_minor: 500 } });
  assert.equal(acc.pointed, 5);
  assert.equal(acc.alreadyPointed, 1);
  assert.equal(acc.cardsMade, 3);
  assert.equal(acc.cardsMinor, 2475);
  assert.equal(acc.alreadyCarded, 1);
});

// ── the screen does not ask a question that does not apply ──────────────────

test('a file with no stamps is never asked which stamp card', () => {
  // Peter, 21 Sep 2026: "we have where do stamps go still but that makes no
  // sense for points and also for gift cards so that will block the upload."
  assert.equal(needsStampCard({ withStamps: 0, withPoints: 40, withGiftCards: 3 }), false);
  assert.equal(needsStampCard({ withStamps: 2 }), true);
  assert.equal(needsStampCard(null), false);

  const lines = balanceDestinationLines({ withStamps: 0, withPoints: 40, withGiftCards: 3 }).join(' ');
  assert.match(lines, /Points go straight onto/);
  assert.match(lines, /Gift cards keep the code/);
  assert.match(lines, /No stamps in this file/);
});

test('and a points only file is not blocked by a missing stamp card', () => {
  const blocked = importBlockReason({
    company: true, fileRead: true, previewed: true, ready: 12,
    withStamps: 0, programmes: [], programId: '', consentGiven: true, busy: false,
  });
  assert.equal(blocked, null, 'nothing about stamps can stop a file with no stamps in it');
});

test('a file carrying nothing but people says so', () => {
  const lines = balanceDestinationLines({ withStamps: 0, withPoints: 0, withGiftCards: 0 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Nothing in this file carries a balance/);
});
