// wasteReasons.test.js: the waste reasons a screen offers and the manager PIN answers (v5.11.96,
// multi site stock Drop 3, contract 3.3). Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WASTE_REASONS, END_OF_DAY_REASON, reasonsFromAnswer, startReason, pinAsk, reasonsToSave, moveReason } from './wasteReasons.js';

const TODAY = ['Spoilage', 'Out of date', 'Prep / trim', 'Over-production', 'Breakage / spill', 'Staff meal', 'Customer return', 'Training', 'Other'];

test('WASTE_REASONS is today\'s list word for word, and waste.js re exports this very list', () => {
  assert.deepEqual(WASTE_REASONS, TODAY);
  const waste = fs.readFileSync(new URL('./waste.js', import.meta.url), 'utf8');
  assert.match(waste, /^import \{ WASTE_REASONS \} from '\.\/wasteReasons\.js';$/m);
  assert.match(waste, /^export \{ WASTE_REASONS \};$/m);
  assert.doesNotMatch(waste, /export const WASTE_REASONS/);
  assert.equal(END_OF_DAY_REASON, 'End of day');
});

test('reasonsFromAnswer: the company list when set; today\'s list for anything else', () => {
  assert.deepEqual(reasonsFromAnswer({ data: { reasons: [' Spoilage ', 'Dropped', 'dropped', '', null], pin_over: 25, currency: 'GBP' }, error: null }),
    { reasons: ['Spoilage', 'Dropped'], pinOver: 25, currency: 'GBP', fromCompany: true });
  const fallback = { reasons: WASTE_REASONS, pinOver: null, currency: null, fromCompany: false };
  assert.deepEqual(reasonsFromAnswer(null), fallback);
  assert.deepEqual(reasonsFromAnswer({ data: { reasons: null, pin_over: null, currency: 'GBP' } }), { ...fallback, currency: 'GBP' });
  assert.deepEqual(reasonsFromAnswer({ data: { reasons: [] } }), fallback);
  assert.deepEqual(reasonsFromAnswer({ data: null, error: new Error('x'), needsUpdate: true }), fallback, 'no Drop 3: today');
  assert.deepEqual(reasonsFromAnswer({ data: { reasons: ['A'] }, error: new Error('Sign in to log waste.') }), fallback);
  assert.equal(reasonsFromAnswer({ data: { reasons: ['A'], pin_over: 'x' } }).pinOver, null);
  assert.equal(reasonsFromAnswer({ data: { reasons: ['A'], pin_over: '0' } }).pinOver, 0);
  assert.equal(reasonsFromAnswer({ data: { reasons: ['A'], pin_over: -1 } }).pinOver, null);
});

test('startReason: the wish when it is on the list, else the first', () => {
  assert.equal(startReason(WASTE_REASONS, 'Breakage / spill'), 'Breakage / spill');
  assert.equal(startReason(['Dropped', 'Burnt'], 'Breakage / spill'), 'Dropped');
  assert.equal(startReason([], null), 'Spoilage');
  assert.equal(startReason(null), 'Spoilage');
});

test('pinAsk: the three PIN answers of stock_record_waste; anything else is null', () => {
  assert.deepEqual(pinAsk({ ok: false, pin: 'needed', error: 'Over £25 needs a manager PIN.', limit: 25 }), { state: 'needed', words: 'Over £25 needs a manager PIN.', limit: 25 });
  assert.deepEqual(pinAsk({ ok: false, pin: 'wrong', error: 'That PIN is not a manager at this venue.' }), { state: 'wrong', words: 'That PIN is not a manager at this venue.', limit: null });
  assert.deepEqual(pinAsk({ ok: false, pin: 'locked' }), { state: 'locked', words: 'Too many wrong PINs. Wait 15 minutes, then try again.', limit: null });
  assert.equal(pinAsk({ ok: false, pin: 'odd' }).state, 'needed');
  assert.equal(pinAsk({ ok: true, id: 'w1' }), null);
  assert.equal(pinAsk({ ok: false, error: 'Something else' }), null);
  assert.equal(pinAsk(null), null);
});

test('reasonsToSave and moveReason: the company list editor', () => {
  assert.deepEqual(reasonsToSave([' Spoilage', 'spoilage', '', 'Burnt ']), ['Spoilage', 'Burnt']);
  assert.deepEqual(reasonsToSave(null), []);
  const list = ['A', 'B', 'C'];
  assert.deepEqual(moveReason(list, 1, -1), ['B', 'A', 'C']);
  assert.deepEqual(moveReason(list, 1, 1), ['A', 'C', 'B']);
  assert.equal(moveReason(list, 0, -1), list);
  assert.equal(moveReason(list, 2, 1), list);
  assert.deepEqual(list, ['A', 'B', 'C'], 'never changed in place');
});

test('wasteReasons.js stays pure: no browser client, no dash', () => {
  const src = fs.readFileSync(new URL('./wasteReasons.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/supabase'|from '\.\/stockApi/);
  assert.doesNotMatch(src, /[\u2013\u2014]/);
});
