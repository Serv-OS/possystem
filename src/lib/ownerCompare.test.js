// ownerCompare.test.js: the words on the Owner app's comparison line.
//
// 5 Oct 2026, Peter: "same day last week, then for the week the week before and the month view
// the month before." The line is always drawn and always says what it compares to. The blocks
// here are built with the function's own compareOf and groupCompare, so the words are tested
// against what the function really sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareOf, groupCompare } from '../../supabase/functions/_shared/ownerPeriod.js';
import {
  hasFeature, compareBlock, groupCompareBlock, weekdayOf, clockLabel, thenWords, compareLine, groupNote, groupLine, sharedCompareRange,
} from './ownerCompare.js';
import { groupCards, venueView, rollupView } from './ownerPeriod.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// Monday 5 Oct 2026 at 14:00: Today is set against Monday 28 Sep up to 14:00.
const todayRange = { from: '2026-10-05', to: '2026-10-05', cmp_from: '2026-09-28', cmp_to: '2026-09-28', days: 1, cmp_days: 1, cmp_time: '14:00' };
const weekRange = { from: '2026-10-05', to: '2026-10-07', cmp_from: '2026-09-28', cmp_to: '2026-09-30', days: 3, cmp_days: 3, cmp_time: '14:00' };
const monthRange = { from: '2026-10-01', to: '2026-10-05', cmp_from: '2026-09-01', cmp_to: '2026-09-05', days: 5, cmp_days: 5, cmp_time: '14:00' };
const block = (period, a) => ({ period, ...compareOf(a) });
const open = { firstSaleDay: '2026-08-01', cmpFrom: '2026-09-28' };

test('the day and the clock in words', () => {
  assert.equal(weekdayOf('2026-09-28'), 'Monday');
  assert.equal(weekdayOf('2026-10-04'), 'Sunday');
  assert.equal(weekdayOf(null), '');
  assert.equal(weekdayOf('28/09/2026'), '');
  assert.equal(clockLabel('14:00'), '2pm');
  assert.equal(clockLabel('14:30'), '2:30pm');
  assert.equal(clockLabel('00:00'), '12am');
  assert.equal(clockLabel('12:05'), '12:05pm');
  assert.equal(clockLabel('09:00'), '9am');
  assert.equal(clockLabel(null), '');
  assert.equal(clockLabel('25:00'), '');
});

test('what each period is compared with', () => {
  assert.equal(thenWords('today', todayRange), 'last Monday by 2pm');
  assert.equal(thenWords('today', todayRange, { withTime: false }), 'last Monday');
  // No cut sent: the day alone. No dates at all: still words, never "last undefined".
  assert.equal(thenWords('today', { ...todayRange, cmp_time: null }), 'last Monday');
  assert.equal(thenWords('today', null), 'the same day last week');
  assert.equal(thenWords('week', weekRange), 'same days last week');
  assert.equal(thenWords('month', monthRange), 'same days last month');
});

test('a venue line: the percent says what it is against', () => {
  const up = compareLine(block('today', { net: 102, cmpNet: 100, ...open }), todayRange, 'today');
  assert.deepEqual(up, { text: '+2% vs last Monday by 2pm', tone: 'up', reason: 'ok' });
  const wk = compareLine(block('week', { net: 102, cmpNet: 100, ...open }), weekRange, 'week');
  assert.equal(wk.text, '+2% vs same days last week');
  const down = compareLine(block('month', { net: 90, cmpNet: 100, firstSaleDay: '2026-08-01', cmpFrom: '2026-09-01' }), monthRange, 'month');
  assert.deepEqual(down, { text: '-10% vs same days last month', tone: 'down', reason: 'ok' });
  const flat = compareLine(block('week', { net: 100, cmpNet: 100, ...open }), weekRange, 'week');
  assert.equal(flat.text, '+0% vs same days last week');
});

test('a new venue says New in grey, never a percent', () => {
  // Opened on the 29th: it was not trading when last Monday began.
  const c = block('today', { net: 640, cmpNet: 7, firstSaleDay: '2026-09-29', cmpFrom: '2026-09-28' });
  assert.equal(c.reason, 'new');
  assert.deepEqual(compareLine(c, todayRange, 'today'), { text: 'New this week', tone: 'grey', reason: 'new' });
  assert.equal(compareLine({ ...c, period: 'week' }, weekRange, 'week').text, 'New this week');
  assert.equal(compareLine({ ...c, period: 'month' }, monthRange, 'month').text, 'New this month');
});

test('no sales yet is grey words, never a red minus 100%', () => {
  const c = block('today', { net: 0, cmpNet: 300, ...open });
  assert.equal(c.reason, 'no_sales_now');
  const line = compareLine(c, todayRange, 'today');
  assert.deepEqual(line, { text: 'No sales yet today', tone: 'grey', reason: 'no_sales_now' });
  assert.doesNotMatch(line.text, /%/);
  assert.equal(compareLine(c, weekRange, 'week').text, 'No sales yet this week');
  assert.equal(compareLine(c, monthRange, 'month').text, 'No sales yet this month');
});

test('nothing sold in the comparison span says so', () => {
  const c = block('today', { net: 50, cmpNet: 0, ...open });
  assert.equal(c.reason, 'no_sales_then');
  assert.deepEqual(compareLine(c, todayRange, 'today'), { text: 'No sales last Monday', tone: 'grey', reason: 'no_sales_then' });
  assert.equal(compareLine(c, weekRange, 'week').text, 'No sales in the same days last week');
  assert.equal(compareLine(c, monthRange, 'month').text, 'No sales in the same days last month');
  // A block that says ok but carries no percent is not drawn as "+null%".
  assert.equal(compareLine({ reason: 'ok', pct: null }, todayRange, 'today').tone, 'grey');
});

test('the block is only used for the period it was worked out for', () => {
  const l = { compare: block('week', { net: 102, cmpNet: 100, ...open }) };
  assert.ok(compareBlock(l, 'week'));
  assert.equal(compareBlock(l, 'today'), null, 'a week percent is never drawn on Today\'s numbers');
  assert.equal(compareBlock({}, 'week'), null, 'a function from before the reason word');
  assert.equal(compareBlock({ compare: { period: 'week', reason: 'something_new' } }, 'week'), null);
  assert.equal(compareBlock(null, 'week'), null);
});

test('the group block: the function stamps no period on it, the answer\'s period is its period', () => {
  const g = groupCompare([compareOf({ net: 102, cmpNet: 100, ...open })]);
  assert.equal('period' in g, false, 'what the function really sends');
  assert.equal(groupCompareBlock({ compare: g }, 'week'), g);
  assert.equal(groupCompareBlock({ compare: { period: 'week', ...g } }, 'week').pct, 2);
  assert.equal(groupCompareBlock({ compare: { period: 'week', ...g } }, 'today'), null, 'stamped for another period');
  assert.equal(groupCompareBlock({ wtd_vs_last_week_pct: 5 }, 'today'), null, 'a function from before the reason word');
  assert.equal(groupCompareBlock({ compare: { reason: 'ok', pct: 5 } }, 'today'), null, 'no venue counts: not a group block');
});

test('the group line: comparison pounds, like for like percent, and how many venues', () => {
  // Two venues with a full comparison, four that opened this week (Coffee Boy, 5 Oct 2026).
  const list = [
    compareOf({ net: 1500, cmpNet: 500, ...open }),
    compareOf({ net: 940.57, cmpNet: 381, ...open }),
    ...[1, 2, 3, 4].map(() => compareOf({ net: 700, cmpNet: 3, firstSaleDay: '2026-09-29', cmpFrom: '2026-09-28' })),
  ];
  const g = { period: 'week', ...groupCompare(list) };
  assert.equal(groupNote(g), ' (2 of 6 venues, 4 new)');
  const line = groupLine(g, weekRange, 'week');
  assert.equal(line.label, 'Same days last week');
  assert.equal(line.amount, 881, 'the pounds are the comparison\'s, at the venues that are compared');
  assert.equal(line.pct, '+177%');
  assert.equal(line.tone, 'up');
  assert.equal(line.note, ' (2 of 6 venues, 4 new)');
  assert.equal(line.grey, null);
  // Today reads the same sum with Today's words.
  assert.equal(groupLine(g, todayRange, 'today').label, 'Last Monday by 2pm');
  assert.equal(groupLine(g, null, 'today').label, 'The same day last week');
});

test('the group note counts every kind of venue that is left out', () => {
  assert.equal(groupNote({ venues: 3, venues_compared: 3, venues_new: 0 }), '', 'every venue compared: no note');
  assert.equal(groupNote({ venues: 5, venues_compared: 1, venues_new: 0 }), ' (1 of 5 venues, 4 with no sales then)');
  assert.equal(groupNote({ venues: 6, venues_compared: 3, venues_new: 2 }), ' (3 of 6 venues, 2 new, 1 with no sales then)');
  assert.equal(groupNote({ venues: 4, venues_compared: 0, venues_new: 4 }), '');
  assert.equal(groupNote(null), '');
});

test('a group with no fair percent says why in grey', () => {
  const allNew = groupCompare([1, 2].map(() => compareOf({ net: 50, cmpNet: 0, firstSaleDay: '2026-10-01', cmpFrom: '2026-09-28' })));
  assert.equal(groupLine(allNew, weekRange, 'week').grey, 'New this week');
  const quiet = groupCompare([compareOf({ net: 0, cmpNet: 300, ...open })]);
  const line = groupLine(quiet, todayRange, 'today');
  assert.equal(line.grey, 'No sales yet today');
  assert.equal(line.pct, '');
  assert.equal(line.amount, null);
});

test('the group words name a day and a time only when every venue shares them', () => {
  const uk = { range: todayRange };
  assert.deepEqual(sharedCompareRange([uk, { range: { ...todayRange } }]), { cmp_to: '2026-09-28', cmp_time: '14:00' });
  // Same day, different clocks (a UK and a US venue): the day, no time.
  assert.deepEqual(sharedCompareRange([uk, { range: { ...todayRange, cmp_time: '06:00' } }]), { cmp_to: '2026-09-28', cmp_time: null });
  // Different days: neither.
  assert.equal(sharedCompareRange([uk, { range: { ...todayRange, cmp_to: '2026-09-27' } }]), null);
  assert.equal(sharedCompareRange([uk, {}]), null);
  assert.equal(sharedCompareRange([]), null);
});

test('features: an older function sends no list', () => {
  assert.equal(hasFeature({ features: ['period', 'detail'] }, 'detail'), true);
  assert.equal(hasFeature({ features: ['period'] }, 'detail'), false);
  // 8 Oct 2026: the sales mix is its own feature word.
  assert.equal(hasFeature({ features: ['period', 'detail', 'mix'] }, 'mix'), true);
  assert.equal(hasFeature({ features: ['period', 'detail'] }, 'mix'), false);
  assert.equal(hasFeature({}, 'detail'), false);
  assert.equal(hasFeature(null, 'detail'), false);
});

test('one group card, or one per currency', () => {
  const gbp = { ops_location_id: 'a', currency: 'GBP' }, usd = { ops_location_id: 'b', currency: 'USD' };
  // One currency: the whole rollup, as always.
  const one = groupCards({ rollup: { locations: 1, currency: 'GBP', by_currency: [{ currency: 'GBP', locations: 1 }] }, locations: [gbp] });
  assert.equal(one.length, 1);
  assert.equal(one[0].currency, 'GBP');
  assert.equal(one[0].locations.length, 1);
  // Pounds and dollars: never one added total.
  const by = [{ currency: 'GBP', locations: 1, net_sales: 10 }, { currency: 'USD', locations: 1, net_sales: 20 }];
  const two = groupCards({ rollup: { locations: 2, currency: null, net_sales: 30, by_currency: by }, locations: [gbp, usd] });
  assert.deepEqual(two.map((g) => [g.currency, g.rollup.net_sales, g.locations.map((l) => l.ops_location_id)]), [['GBP', 10, ['a']], ['USD', 20, ['b']]]);
  // A function from before by_currency: one card in the first venue's currency, as before.
  const old = groupCards({ rollup: { locations: 2, net_sales: 30 }, locations: [gbp, usd] });
  assert.equal(old.length, 1);
  assert.equal(old[0].currency, 'GBP');
  assert.deepEqual(groupCards({ rollup: { locations: 0 }, locations: [] }), []);
  assert.deepEqual(groupCards(null), []);
});

test('an old function: the cards read exactly the fields they always read', () => {
  // No compare block, no period echo: today's fields and the week to date chip.
  const l = { today: { net_sales: 80, orders: 4 }, wtd: { vs_last_week_pct: 5 }, top_items: [] };
  assert.equal(compareBlock(l, 'today'), null);
  assert.equal(venueView(l, 'today').vs_pct, 5);
  assert.equal(rollupView({ net_sales: 80, wtd_net: 300, wtd_vs_last_week_pct: 5 }, 'today').vs_pct, 5);
});

test('the Owner screen draws the line always, and keeps the old line for an old function', () => {
  const src = read('../surfaces/OwnerSurface.jsx');
  // Venue card: the function's block for the period of the numbers, then the words.
  assert.ok(src.includes('const cmp = compareBlock(l, t.period);'));
  assert.ok(src.includes('const line = cmp ? compareLine(cmp, l.range, t.period) : null;'));
  assert.ok(src.includes('{line && <div style={{ fontSize: 12.5, fontWeight: 700, color: toneColor(line.tone), marginTop: 10 }}>{line.text}</div>}'),
    'the line is drawn whenever there is a block, whatever its reason');
  assert.ok(src.includes('{!line && t.vs_pct != null && <Chip'), 'the old chip only when the function sent no block');
  // Group card: the same, and the pounds are the comparison's.
  assert.ok(src.includes('const cmp = groupCompareBlock(r, rv.period);'));
  assert.ok(src.includes('const line = cmp ? groupLine(cmp, sharedCompareRange(g.locations), rv.period) : null;'));
  assert.ok(src.includes('{line.label} {money(line.amount, cur)}'));
  assert.ok(src.includes('{!line && rv.vs_pct != null && ('));
  // One group card per currency.
  assert.ok(src.includes('const groups = groupCards(data);') && src.includes('{groups.map((g) => ('));
  // 8 Oct 2026: the sales mix bars draw only from a function that sends the mix, the venue cards
  // of a currency with nothing set up stay quiet, and the group card carries the one hint.
  assert.ok(src.includes('const mixOn = canMix(data);'));
  assert.ok(src.includes('const quietBy = allOtherByCurrency(groups);'));
  assert.ok(src.includes('bar={mixOn ? cardBar(g.rollup.mix, { hint: true }) : null}'));
  assert.ok(src.includes('bar={mixOn ? cardBar(l.mix, { quiet: !!quietBy[l.currency] }) : null}'));
  assert.ok(src.includes('<MixBar bar={bar} size="group"/>') && src.includes('<MixBar bar={bar}/>'));
  // No percent is worked out on the screen.
  assert.doesNotMatch(src, /vsPct\(|\/ *100\)/);
});
