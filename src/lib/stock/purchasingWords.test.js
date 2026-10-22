// src/lib/stock/purchasingWords.test.js: the words and pills of the multi site Purchasing screens
// (multi site stock Drop 3, v5.11.96, contract 4.1 and 4.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as W from './purchasingWords.js';

test('the pills of 4.1 with their tones', () => {
  assert.deepEqual(['ordered', 'not_yet', 'waiting_approval', 'missed', 'standing', 'held'].map((s) => [W.duePill(s).text, W.duePill(s).tone]), [
    ['Ordered', 'good'], ['Not yet', 'neutral'], ['Waiting approval', 'warn'], ['Missed cut off', 'bad'], ['Standing order', 'blue'], ['Held by supplier', 'blue'],
  ]);
  assert.equal(W.duePill('nonsense').text, 'Not yet');
  assert.deepEqual(['matched', 'price_issue', 'qty_issue', 'both', 'by_hand'].map((s) => [W.matchPill(s).text, W.matchPill(s).tone]), [
    ['Matched', 'good'], ['Price issue', 'warn'], ['Quantity issue', 'warn'], ['Both', 'bad'], ['Approved by hand', 'neutral'],
  ]);
  assert.equal(W.matchPill(null), null);
  assert.deepEqual(['asked', 'received', 'written_off'].map((s) => W.creditPill(s).text), ['Asked', 'Received', 'Written off']);
  assert.equal(W.approvalPill('sent_unapproved').text, 'Sent unapproved');
  assert.equal(W.approvalPill('x'), null);
  assert.deepEqual(W.orderStatusPill('PARTIAL'), { text: 'Part received', tone: 'warn' });
  assert.deepEqual(W.needsApprovalPill(800), { text: 'Needs approval: over £800', tone: 'warn' });
  assert.equal(W.LOCKED_PILL.text, 'Locked');
  assert.equal(W.PILLS.ourKitchen.text, 'Our kitchen');
});

test('forecast reasons are stored as the database CHECK allows', () => {
  assert.deepEqual(W.FORECAST_REASONS.map(([id]) => id), ['weather', 'local_event', 'booking', 'promotion', 'closure', 'other']);
  assert.equal(W.forecastReasonWords('booking'), 'Pre order or booking');
  assert.equal(W.forecastReasonWords(null), '');
  assert.deepEqual(W.CREDIT_REASONS.map(([id]) => id), ['overcharge', 'short', 'not_coming', 'damaged', 'other']);
  assert.equal(W.creditReasonWords('not_coming'), 'Not coming');
});

test('standing order words', () => {
  assert.equal(W.standingPillWords(6, true), 'Standing order 6 a day');
  assert.equal(W.standingPillWords(2.5), 'Standing order 2.5');
  assert.equal(W.dowsWords([0, 1, 2, 3, 4, 5, 6]), 'every day');
  assert.equal(W.dowsWords([4, 1]), 'every Monday and Thursday');
  assert.equal(W.dowsWords([5, 1, 3]), 'every Mon, Wed and Fri');
  assert.equal(W.dowsWords([0]), 'every Sunday');
  assert.equal(W.standingRowWords({ siteName: 'Site A', lines: [{ qty_packs: 6, label: '2 L whole milk' }], dows: [0, 1, 2, 3, 4, 5, 6] }),
    'Site A: 6 x 2 L whole milk every day. Sent by us at the order by time, changeable until then.');
  assert.equal(W.standingRowWords({ siteName: 'Site B', lines: [{ qty_packs: 2, name: 'Bread' }], dows: [2], held: true }),
    'Site B: 2 x Bread every Tuesday. Held by the supplier, no email.');
});

test('budgetWords: nothing without a budget, spent plus basket of the budget, over', () => {
  assert.equal(W.budgetWords(null), null);
  assert.equal(W.budgetWords({ budget: null, spent: 10 }), null);
  assert.deepEqual(W.budgetWords({ budget: 2600, spent: 2140, rule: 'pct_of_forecast' }, 320), {
    title: 'Budget this week', rule: '(a % of forecast sales)', right: '£2,140 spent + £320 basket of £2,600', over: false,
  });
  const over = W.budgetWords({ budget: 2600, spent: 2400, rule: 'fixed' }, 320);
  assert.equal(over.rule, '(fixed)');
  assert.equal(over.over, true);
  assert.equal(W.budgetRuleWords({ rule: 'pct_of_forecast', pct: 28 }), '28% of forecast');
  assert.equal(W.budgetRuleWords({ rule: 'fixed', amount: 100 }), 'Fixed');
  assert.equal(W.budgetRuleWords(null), 'No budget');
});

test('atWords, comingWords, pctWords, priceRose', () => {
  assert.equal(W.atWords('2026-10-20T13:00:00Z', 'Europe/London'), 'Tue 14:00');
  assert.equal(W.atWords('2026-10-27T14:00:00Z', 'Europe/London', { withDate: true }), 'Tue 27 Oct 14:00', 'after the clock change');
  assert.equal(W.atWords(null), '');
  assert.equal(W.atWords('bad'), '');
  assert.equal(W.comingWords('2026-11-01'), 'Coming 1 Nov');
  assert.equal(W.pctWords(6.24), '+6.2%');
  assert.equal(W.pctWords(-3), '-3%');
  assert.equal(W.pctWords(null), '');
  assert.equal(W.priceRose(5), false);
  assert.equal(W.priceRose(5.1), true);
});

test('splitCheck: the splits add up to the invoice within a penny', () => {
  assert.deepEqual(W.splitCheck([{ amount: 60 }, { amount: 40.005 }], 100), { ok: true, sum: 100.01, words: '' });
  assert.deepEqual(W.splitCheck([{ amount: 60 }, { amount: 30 }], 100), { ok: false, sum: 90, words: 'The splits add up to £90, the invoice is £100.' });
});

test('tempCheck: over 8 C is turned away, dry goods need no reading', () => {
  assert.deepEqual(W.tempCheck('5'), { known: true, tooWarm: false });
  assert.deepEqual(W.tempCheck(8), { known: true, tooWarm: false });
  assert.deepEqual(W.tempCheck('8.1'), { known: true, tooWarm: true });
  assert.deepEqual(W.tempCheck(''), { known: false, tooWarm: false });
  assert.deepEqual(W.tempCheck('', true), { known: true, tooWarm: false });
});

test('pad words, headers and toasts', () => {
  assert.deepEqual(W.HEADERS_MULTI_OF(3), ['Item', 'On hand', 'Forecast use', 'Par (Wed)', 'Suggested', 'Order', 'Supplier', 'Line £ (ex VAT)']);
  assert.equal(W.HEADERS_MULTI_OF(null)[3], 'Par (next)');
  assert.equal(W.noRulesWords('Fresh Co'), 'No delivery days set for Fresh Co.');
  assert.equal(W.sendBackToast('Sam'), 'Sent back to Sam to change.');
  assert.equal(W.manyOrdersWords(3, 1), '3 orders to 1 supplier');
  assert.equal(W.submitToast({ sent: 2, approvals: 1 }), '2 orders sent, 1 sent for approval.');
  assert.equal(W.submitToast({}), 'Nothing was sent.');
});

test('no long dash anywhere in the words file', () => {
  const src = fs.readFileSync(new URL('./purchasingWords.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[\u2013\u2014]/);
});
