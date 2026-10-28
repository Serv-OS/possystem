// discountWords.test.js: the Buy X rule sentence in Back Office, Discounts (v5.11.109).
// Run: node --test src/lib/discountWords.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleSentence, categoryNames, rewardWords } from './discountWords.js';

const CATS = [{ id: 'd', label: 'Donuts' }, { id: 'm', label: 'Muffins' }, { id: 'k', label: 'Drinks' }];

test('Buy X get Y reads as one plain sentence, Peter\'s example word for word', () => {
  const rule = { triggerType: 'buy_x', triggerQty: 3, rewardQty: 1, rewardType: 'percent', rewardValue: 10, triggerCategoryIds: ['d'] };
  assert.equal(ruleSentence(rule, CATS), 'Customer buys 3 from Donuts at full price, then the next 1 from Donuts is 10% off. Needs 4 donuts in the basket.');
});

test('Buy X get Y: plurals, free, amounts, other reward categories, half typed values', () => {
  const base = { triggerType: 'buy_x', triggerQty: 2, rewardQty: 2, triggerCategoryIds: ['d', 'm'] };
  assert.equal(ruleSentence({ ...base, rewardType: 'free' }, CATS), 'Customer buys 2 from Donuts or Muffins at full price, then the next 2 from Donuts or Muffins are free. Needs 4 items from Donuts or Muffins in the basket.');
  assert.match(ruleSentence({ ...base, rewardType: 'amount', rewardValue: '1.5' }, CATS, { sym: '$' }), /are \$1\.50 off each\./);
  assert.match(ruleSentence({ ...base, rewardQty: 1, rewardType: 'free', rewardCategoryIds: ['k'] }, CATS, { sameRewardCats: false }), /then the next 1 from Drinks is free\. Needs 3 items in the basket\./);
  assert.equal(ruleSentence({ triggerType: 'buy_x', triggerQty: '', rewardQty: 1, rewardType: 'percent', rewardValue: '' }, CATS), 'Customer buys ? from any category at full price, then the next 1 from any category is ?% off. Needs ? items in the basket.');
});

test('Buy X, discount the lot reads as one plain sentence', () => {
  const rule = { triggerType: 'buy_x_all', triggerQty: 6, rewardType: 'percent', rewardValue: 15, triggerCategoryIds: ['d'] };
  assert.equal(ruleSentence(rule, CATS), 'Customer buys 6 from Donuts and all 6 are 15% off. Needs 6 donuts in the basket. 12 get it twice; with 7, the cheapest 6 get it.');
  assert.match(ruleSentence({ ...rule, rewardType: 'amount', rewardValue: 0.5 }, CATS), /all 6 are £0\.50 off each\./);
});

test('the little helpers', () => {
  assert.equal(categoryNames(['d', 'm', 'k'], CATS), 'Donuts, Muffins or Drinks');
  assert.equal(categoryNames([], CATS), 'any category');
  assert.equal(rewardWords({ rewardType: 'percent', rewardValue: 12.5 }), '12.5% off');
});

test('the sentences carry no dashes and no exclamation marks', () => {
  const rules = [
    { triggerType: 'buy_x', triggerQty: 3, rewardQty: 1, rewardType: 'percent', rewardValue: 10, triggerCategoryIds: ['d'] },
    { triggerType: 'buy_x', triggerQty: 2, rewardQty: 2, rewardType: 'amount', rewardValue: 1, triggerCategoryIds: ['d', 'm'] },
    { triggerType: 'buy_x_all', triggerQty: 6, rewardType: 'percent', rewardValue: 15, triggerCategoryIds: ['d'] },
    { triggerType: 'buy_x_all', triggerQty: 1, rewardType: 'free', triggerCategoryIds: [] },
  ];
  for (const r of rules) assert.doesNotMatch(ruleSentence(r, CATS), /[\u2013\u2014!]| - /);
});
