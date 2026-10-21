// src/lib/stock/orderRules.test.js: the Order rules tab rules (multi site stock Drop 1, contract 1.3,
// 1.6 and 3.4). Synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_CODES, WEEK_COLUMNS, dayLabel, dayName, timeText, orderByWords, deriveDays, defaultOrderBy,
  validRules, ruleFor, withDay, cellModel, copyTargets, rulesWords, sameRules,
} from './orderRules.js';

test('day codes and labels follow Postgres extract(dow): 0 Sunday ... 6 Saturday', () => {
  assert.deepEqual([...DAY_CODES], ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.deepEqual([...WEEK_COLUMNS], [1, 2, 3, 4, 5, 6, 0], 'the grid starts on Monday, as the mockup');
  assert.equal(dayLabel(1), 'Mon');
  assert.equal(dayLabel(0), 'Sun');
  assert.equal(dayLabel('6'), 'Sat', 'a day number read back as text');
  assert.equal(dayName(3), 'Wednesday');
  for (const bad of [7, -1, 1.5, null, undefined, '', 'mon']) {
    assert.equal(dayLabel(bad), '', String(bad));
    assert.equal(dayName(bad), '', String(bad));
  }
});

test('timeText reads HH:MM, H:MM and the HH:MM:SS a time column answers', () => {
  assert.equal(timeText('14:00'), '14:00');
  assert.equal(timeText('9:30'), '09:30');
  assert.equal(timeText('14:00:00'), '14:00');
  assert.equal(timeText(' 07:05:00.000 '), '07:05');
  assert.equal(timeText('00:00'), '00:00');
  assert.equal(timeText('23:59'), '23:59');
  for (const bad of ['24:00', '12:60', '1400', 'noon', '', null, undefined, '12:5']) assert.equal(timeText(bad), null, String(bad));
});

test('orderByWords says "order by Sun 14:00", nothing when there is no order by', () => {
  assert.equal(orderByWords({ delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00:00' }), 'order by Sun 14:00');
  assert.equal(orderByWords({ delivery_dow: 2, order_by_dow: 1, order_by_time: '12:00' }), 'order by Mon 12:00');
  assert.equal(orderByWords({ delivery_dow: 2, order_by_dow: null, order_by_time: null }), '');
  assert.equal(orderByWords(null), '');
});

test('deriveDays: day codes Monday first, cut off the time most rules use (ties: the earliest)', () => {
  // the mockup's Provo row: Mon, Wed, Fri, each ordered by 14:00 the day before
  assert.deepEqual(deriveDays([
    { delivery_dow: 5, order_by_dow: 4, order_by_time: '14:00:00' },
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00:00' },
    { delivery_dow: 3, order_by_dow: 2, order_by_time: '14:00:00' },
  ]), { delivery_days: ['mon', 'wed', 'fri'], cutoff_time: '14:00' });
  // Sunday goes last, as suppliers.delivery_days is written mon..sun
  assert.deepEqual(deriveDays([{ delivery_dow: 0, order_by_dow: 6, order_by_time: '10:00' }, { delivery_dow: 6, order_by_dow: 5, order_by_time: '10:00' }]).delivery_days, ['sat', 'sun']);
  // the most used time wins
  assert.equal(deriveDays([
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '16:00' },
    { delivery_dow: 2, order_by_dow: 1, order_by_time: '12:00' },
    { delivery_dow: 4, order_by_dow: 3, order_by_time: '16:00' },
  ]).cutoff_time, '16:00');
  // a tie goes to the earliest time
  assert.equal(deriveDays([
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '16:00' },
    { delivery_dow: 2, order_by_dow: 1, order_by_time: '09:00' },
  ]).cutoff_time, '09:00');
  // rules with no order by count for the days but not for the cut off
  assert.deepEqual(deriveDays([{ delivery_dow: 2, order_by_dow: null, order_by_time: null }, { delivery_dow: 4, order_by_dow: null, order_by_time: null }]),
    { delivery_days: ['tue', 'thu'], cutoff_time: null });
  assert.deepEqual(deriveDays([]), { delivery_days: [], cutoff_time: null });
  assert.deepEqual(deriveDays(null), { delivery_days: [], cutoff_time: null });
});

test('the seed rule round trips: rules made from delivery_days and a cut off derive the same values back', () => {
  // contract 1.3: one rule per day code, order by the day before at the cut off (none without one)
  const seed = (days, cutoff) => days.map((code) => {
    const dow = DAY_CODES.indexOf(code);
    return { delivery_dow: dow, ...defaultOrderBy(dow, cutoff) };
  });
  // a small seeded random walk over every day set and a few cut offs
  let seedN = 42;
  const rand = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
  const cutoffs = ['14:00', '09:30', '16:00', null, '23:59', '00:00'];
  for (let run = 0; run < 300; run++) {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].filter(() => rand() < 0.5);
    const cutoff = cutoffs[Math.floor(rand() * cutoffs.length)];
    const back = deriveDays(seed(days, cutoff));
    assert.deepEqual(back.delivery_days, days, `days ${days.join(',')}`);
    assert.equal(back.cutoff_time, days.length ? cutoff : null, `cut off ${cutoff} with ${days.length} days`);
  }
});

test('defaultOrderBy: the day before at the cut off, or none', () => {
  assert.deepEqual(defaultOrderBy(1, '14:00'), { order_by_dow: 0, order_by_time: '14:00' }, 'Monday is ordered by Sunday');
  assert.deepEqual(defaultOrderBy(0, '16:00:00'), { order_by_dow: 6, order_by_time: '16:00' }, 'Sunday is ordered by Saturday');
  assert.deepEqual(defaultOrderBy(3, null), { order_by_dow: null, order_by_time: null });
  assert.deepEqual(defaultOrderBy(3, 'noon'), { order_by_dow: null, order_by_time: null }, 'a cut off that is not a time gives none (as the seed)');
  assert.deepEqual(defaultOrderBy(9, '14:00'), { order_by_dow: null, order_by_time: null });
});

test('validRules: one per day, the order by pair together, times as HH:MM, Monday first', () => {
  const ok = validRules([
    { delivery_dow: 0, order_by_dow: 6, order_by_time: '14:00:00' },
    { delivery_dow: 1, order_by_dow: '0', order_by_time: '9:15' },
    { delivery_dow: 3, order_by_dow: null, order_by_time: null },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rules, [
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '09:15' },
    { delivery_dow: 3, order_by_dow: null, order_by_time: null },
    { delivery_dow: 0, order_by_dow: 6, order_by_time: '14:00' },
  ]);
  assert.deepEqual(validRules([]), { ok: true, rules: [] }, 'no deliveries is allowed');
  assert.equal(validRules([{ delivery_dow: 1 }, { delivery_dow: 1 }]).error, 'Each day can have one delivery only.');
  assert.equal(validRules([{ delivery_dow: 7 }]).error, 'A delivery day must be Monday to Sunday.');
  assert.equal(validRules([{ delivery_dow: 2, order_by_dow: 1, order_by_time: null }]).error, 'Pick an order by day and a time for Tuesday, or tick No order by time.');
  assert.equal(validRules([{ delivery_dow: 2, order_by_dow: null, order_by_time: '10:00' }]).error, 'Pick an order by day and a time for Tuesday, or tick No order by time.');
  assert.equal(validRules([{ delivery_dow: 2, order_by_dow: 8, order_by_time: '10:00' }]).error, 'Pick an order by day for Tuesday.');
  assert.equal(validRules([{ delivery_dow: 2, order_by_dow: 1, order_by_time: '25:00' }]).error, 'The order by time must be a time such as 14:00.');
  assert.equal(validRules(null).ok, false);
});

test('withDay changes one day and keeps the others; ruleFor and cellModel read a day', () => {
  const rules = [
    { id: 'r1', delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00:00', row_version: 3 },
    { id: 'r2', delivery_dow: 5, order_by_dow: 4, order_by_time: '14:00:00', row_version: 1 },
  ];
  assert.equal(ruleFor(rules, 5).id, 'r2');
  assert.equal(ruleFor(rules, 2), null);
  assert.deepEqual(cellModel(rules, 1), { delivery: true, orderBy: 'order by Sun 14:00' });
  assert.deepEqual(cellModel(rules, 2), { delivery: false, orderBy: '' });
  // add Wednesday with no order by
  assert.deepEqual(withDay(rules, 3, { order_by_dow: null, order_by_time: null }), [
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00' },
    { delivery_dow: 3, order_by_dow: null, order_by_time: null },
    { delivery_dow: 5, order_by_dow: 4, order_by_time: '14:00' },
  ]);
  // change Friday's order by
  assert.deepEqual(withDay(rules, 5, { order_by_dow: 3, order_by_time: '16:30' })[1], { delivery_dow: 5, order_by_dow: 3, order_by_time: '16:30' });
  // take Monday off
  assert.deepEqual(withDay(rules, 1, null), [{ delivery_dow: 5, order_by_dow: 4, order_by_time: '14:00' }]);
  // a bad time is kept as typed so validRules refuses it with words
  assert.equal(validRules(withDay(rules, 2, { order_by_dow: 1, order_by_time: '99:00' })).error, 'The order by time must be a time such as 14:00.');
  assert.equal(rules.length, 2, 'the rules passed in are never changed');
});

test('copyTargets: every other site that can order; rulesWords for the change log', () => {
  const sites = [
    { location_id: 'a', can_order: true }, { location_id: 'b', can_order: false }, { location_id: 'c', can_order: true }, null,
  ];
  assert.deepEqual(copyTargets(sites, 'a'), ['c']);
  assert.deepEqual(copyTargets(sites, 'c'), ['a']);
  assert.deepEqual(copyTargets(null, 'a'), []);
  assert.equal(rulesWords([
    { delivery_dow: 4, order_by_dow: null, order_by_time: null },
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00:00' },
  ]), 'Mon (order by Sun 14:00), Thu');
  assert.equal(rulesWords([]), '');
  assert.equal(rulesWords(null), '');
});

test('sameRules: the same days and order by times, whatever the order or the seconds', () => {
  const a = [
    { delivery_dow: 5, order_by_dow: 4, order_by_time: '14:00:00' },
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00' },
  ];
  const b = [
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00' },
    { delivery_dow: 5, order_by_dow: 4, order_by_time: '14:00' },
  ];
  assert.equal(sameRules(a, b), true, 'order and seconds do not matter');
  assert.equal(sameRules(a, withDay(a, 2, null)), true, 'no delivery on a day that had none: nothing changed');
  assert.equal(sameRules(a, withDay(a, 1, null)), false, 'a day taken off');
  assert.equal(sameRules(a, withDay(a, 1, { order_by_dow: 0, order_by_time: '15:00' })), false, 'a new order by time');
  assert.equal(sameRules(a, withDay(a, 1, { order_by_dow: 6, order_by_time: '14:00' })), false, 'a new order by day');
  assert.equal(sameRules(a, withDay(a, 1, { order_by_dow: null, order_by_time: null })), false, 'no order by any more');
  assert.equal(sameRules([], null), true);
  assert.equal(sameRules([{ delivery_dow: 3, order_by_dow: null, order_by_time: null }], []), false);
});
