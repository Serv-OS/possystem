// src/lib/cashDenominations.test.js: US and EU venues count their own notes and coins (5.12.46).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { denominationsFor, denominationLabel, countTotal, countedValues } from './cashDenominations.js';

test('a US venue counts bills, quarters, dimes, nickels and pennies', () => {
  const us = denominationsFor('USD');
  assert.deepEqual(us.map((d) => d.value), [100, 50, 20, 10, 5, 2, 1, 0.25, 0.1, 0.05, 0.01]);
  assert.ok(us.every((d) => !/£|p coins/.test(d.label)));
  assert.equal(denominationLabel(0.25, 'USD'), '25¢');
  assert.equal(denominationLabel(20, 'usd'), '$20');
});

test('a UK venue keeps exactly the old list', () => {
  assert.deepEqual(denominationsFor('GBP').map((d) => [d.value, d.label]), [
    [50, '£50 notes'], [20, '£20 notes'], [10, '£10 notes'], [5, '£5 notes'], [2, '£2 coins'], [1, '£1 coins'],
    [0.5, '50p coins'], [0.2, '20p coins'], [0.1, '10p coins'], [0.05, '5p coins'], [0.02, '2p coins'], [0.01, '1p coins'],
  ]);
  assert.equal(denominationLabel(0.5, 'GBP'), '50p');
  assert.equal(denominationsFor('XYZ'), denominationsFor('GBP'));
  assert.equal(denominationsFor(null), denominationsFor('GBP'));
});

test('euro venues count euro notes and cent coins', () => {
  assert.equal(denominationsFor('EUR')[0].label, '€100 notes');
  assert.equal(denominationLabel(0.2, 'EUR'), '20c');
});

test('totals add up in pennies', () => {
  assert.equal(countTotal({ 0.1: 3 }), 0.3);
  assert.equal(countTotal({ 0.25: 7, 0.05: 3, 0.01: 4 }), 1.94);
  assert.equal(countTotal({ 20: 5, 1: 12, 0.25: 40 }), 122);
  assert.equal(countTotal({ 50: '2', 0.5: -3, 0.2: 'x' }), 100);
  assert.equal(countTotal(null), 0);
});

test('a saved count lists its values biggest first, whatever the currency', () => {
  assert.deepEqual(countedValues({ '0.25': 4, '20': 1, '1': 0, bad: 2 }), [20, 1, 0.25]);
  assert.equal(denominationLabel(0.3, 'GBP'), '£0.30');
});

test('the count screen and End of day read the venue set, not a UK list', () => {
  const modal = readFileSync(new URL('../components/DrawerCashModal.jsx', import.meta.url), 'utf8');
  const eod = readFileSync(new URL('../backoffice/sections/EODClose.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(modal, /'£50 notes'/);
  assert.doesNotMatch(eod, /'50p'/);
  assert.match(modal, /denominationsFor\(/);
  assert.match(eod, /denominationLabel\(/);
});
