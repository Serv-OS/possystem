/**
 * rateCard.test.js: the rate card editor's pure helpers (RateCardRows).
 * Run: `node --test src/lib/payments/rateCard.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_CARD_TIERS, emptyCard, cardToState, stateToCard, cardsEqual, fmtRate, cardHasOverride } from './rateCard.js';

test('RATE_CARD_TIERS: the four payment types in order, plain words, no dashes', () => {
  assert.deepEqual(RATE_CARD_TIERS.map((t) => t.id), ['card_present', 'card_not_present', 'amex', 'keyed']);
  assert.deepEqual(RATE_CARD_TIERS.map((t) => t.label), ['In person', 'Online', 'Amex and business cards', 'Keyed in']);
  for (const t of RATE_CARD_TIERS) {
    assert.doesNotMatch(t.label, /[-–—]/, t.label);
    if (t.note) assert.doesNotMatch(t.note, /[-–—]/, t.note);
  }
  assert.ok(Object.isFrozen(RATE_CARD_TIERS));
});

test('emptyCard and cardToState: strings for every field, either spelling of the pence', () => {
  assert.deepEqual(emptyCard(), {
    card_present: { percent: '', fixed_pence: '' }, card_not_present: { percent: '', fixed_pence: '' },
    amex: { percent: '', fixed_pence: '' }, keyed: { percent: '', fixed_pence: '' },
  });
  const st = cardToState({ card_present: { percent: 1.4, fixed_pence: 5 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: null, fixed_pence: null } });
  assert.deepEqual(st.card_present, { percent: '1.4', fixed_pence: '5' });
  assert.deepEqual(st.amex, { percent: '2.5', fixed_pence: '10' });
  assert.deepEqual(st.keyed, { percent: '', fixed_pence: '' });
  assert.deepEqual(st.card_not_present, { percent: '', fixed_pence: '' });
  // 0 is a price, kept as '0'
  assert.deepEqual(cardToState({ amex: { percent: 0, fixed_pence: 0 } }).amex, { percent: '0', fixed_pence: '0' });
  // junk never throws
  assert.deepEqual(cardToState(null), emptyCard());
  assert.deepEqual(cardToState({ amex: 'x', other: { percent: 1 } }), emptyCard());
});

test('stateToCard: numbers, whole pence, null for empty, and the round trip', () => {
  const card = stateToCard({ card_present: { percent: '1.4', fixed_pence: '5' }, amex: { percent: '0', fixed_pence: '4.6' }, keyed: { percent: '', fixed_pence: '' } });
  assert.deepEqual(card, {
    card_present: { percent: 1.4, fixed_pence: 5 },
    card_not_present: { percent: null, fixed_pence: null },
    amex: { percent: 0, fixed_pence: 5 },
    keyed: { percent: null, fixed_pence: null },
  });
  assert.deepEqual(cardToState(card).card_present, { percent: '1.4', fixed_pence: '5' });
  // a typo is null, never NaN in the jsonb
  assert.deepEqual(stateToCard({ amex: { percent: 'x', fixed_pence: 'y' } }).amex, { percent: null, fixed_pence: null });
  assert.deepEqual(stateToCard(null).keyed, { percent: null, fixed_pence: null });
});

test('cardsEqual and cardHasOverride: the same card two ways, and whether anything is typed', () => {
  assert.equal(cardsEqual({ amex: { percent: '1', fixed_pence: '' } }, { amex: { percent: '1.0', fixed_pence: '' } }), true);
  assert.equal(cardsEqual({ amex: { percent: '1', fixed_pence: '' } }, { amex: { percent: '1', fixed_pence: '5' } }), false);
  assert.equal(cardsEqual(emptyCard(), null), true);
  assert.equal(cardHasOverride(emptyCard()), false);
  assert.equal(cardHasOverride({ keyed: { percent: '', fixed_pence: '15' } }), true);
  assert.equal(cardHasOverride({ keyed: { percent: '0', fixed_pence: '' } }), true);
  assert.equal(cardHasOverride(null), false);
});

test('fmtRate: two decimals, pence or cents, Not set for nothing', () => {
  assert.equal(fmtRate(1.4, 5), '1.40% + 5p');
  assert.equal(fmtRate(1.4, 5, 'USD'), '1.40% + 5c');
  assert.equal(fmtRate(null, 5), '0.00% + 5p');
  assert.equal(fmtRate(1, null), '1.00% + 0p');
  assert.equal(fmtRate(0, 0), '0.00% + 0p');
  assert.equal(fmtRate(null, null), 'Not set');
  assert.equal(fmtRate('', ''), 'Not set');
});
