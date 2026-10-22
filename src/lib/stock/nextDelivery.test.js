// src/lib/stock/nextDelivery.test.js
//
// Multi site stock Drop 3 (v5.11.96, contract 2.3): the one delivery rule for every company.
// nextDelivery, coverFromRules, rulesFromDeliveryDays, orderByWords, basketRules, the suggestPacks
// byte for byte case, and both clock changes (25 Oct 2026 UK, 1 Nov 2026 US).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextDelivery, coverFromRules, rulesFromDeliveryDays, orderByWords, basketRules, suggestPacks,
  dayWords, timeLeftWords, moneyWords, venueTimeToMs, tzOffsetMinutes, coverDaysFromSchedule,
} from './purchasingRules.js';

// Thu 22 Oct 2026 is a Thursday (dow 4).
const TUE_THU_14 = [
  { delivery_dow: 2, order_by_dow: 1, order_by_time: '14:00' },
  { delivery_dow: 4, order_by_dow: 3, order_by_time: '14:00' },
];

test('rulesFromDeliveryDays is the Drop 1 seed: the day before at the cut off, none without one', () => {
  assert.deepEqual(rulesFromDeliveryDays(['thu', 'tue'], '14:00'), TUE_THU_14);
  assert.deepEqual(rulesFromDeliveryDays([2, 4], '14:00'), TUE_THU_14, 'ISO numbers read as names');
  assert.deepEqual(rulesFromDeliveryDays(['sun', 'mon'], '09:30'), [
    { delivery_dow: 0, order_by_dow: 6, order_by_time: '09:30' },
    { delivery_dow: 1, order_by_dow: 0, order_by_time: '09:30' },
  ], 'Sunday ordered by Saturday');
  assert.deepEqual(rulesFromDeliveryDays(['tue'], null), [{ delivery_dow: 2, order_by_dow: null, order_by_time: null }]);
  // the seed's regex is strict HH:MM: anything else is no cut off
  for (const bad of ['9:00', '14:00:00', '25:00', 'noon', '', undefined]) {
    assert.deepEqual(rulesFromDeliveryDays(['tue'], bad), [{ delivery_dow: 2, order_by_dow: null, order_by_time: null }], String(bad));
  }
  assert.deepEqual(rulesFromDeliveryDays([], '14:00'), []);
  assert.deepEqual(rulesFromDeliveryDays(null, '14:00'), []);
  assert.deepEqual(rulesFromDeliveryDays(['tue', 'Tuesday', 2], '14:00'), [TUE_THU_14[0]], 'duplicates dropped');
});

test('nextDelivery: before the cut off the next delivery, one minute after it the following one', () => {
  const wed = (hm) => nextDelivery({ rules: TUE_THU_14, nowVenue: { ymd: '2026-10-21', hm } });
  const before = wed('13:59');
  assert.equal(before.deliveryYmd, '2026-10-22');
  assert.equal(before.deliveryDow, 4);
  assert.equal(before.orderByYmd, '2026-10-21');
  assert.equal(before.orderByHm, '14:00');
  assert.equal(before.orderByAt, '2026-10-21T14:00');
  assert.equal(before.minutesLeft, 1);
  assert.deepEqual(before.skipped, []);
  assert.equal(wed('14:00').deliveryYmd, '2026-10-27', 'at the order by time it has passed');
  assert.equal(wed('14:01').deliveryYmd, '2026-10-27', 'an order after the cut off asks for the next delivery');
  assert.equal(wed('14:01').orderByAt, '2026-10-26T14:00');
  // buildScheduleCtx's shape works the same
  assert.deepEqual(nextDelivery({ rules: TUE_THU_14, nowVenue: { ymd: '2026-10-21', nowMinutes: 13 * 60 + 59, isoDay: 3 } }), before);
});

test('nextDelivery: a supplier with no cut off is ordered by midnight the day before', () => {
  const rules = rulesFromDeliveryDays(['fri'], null);
  const thu = nextDelivery({ rules, nowVenue: { ymd: '2026-10-22', hm: '23:59' } });
  assert.equal(thu.deliveryYmd, '2026-10-23');
  assert.equal(thu.orderByYmd, '2026-10-22');
  assert.equal(thu.orderByHm, '24:00');
  assert.equal(thu.orderByAt, '2026-10-23T00:00');
  assert.equal(thu.minutesLeft, 1);
  const fri = nextDelivery({ rules, nowVenue: { ymd: '2026-10-23', hm: '00:00' } });
  assert.equal(fri.deliveryYmd, '2026-10-30', 'from midnight it is next week');
  assert.equal(orderByWords(thu), 'Next delivery Fri 23 Oct · order by the end of Thu (in 1 m)');
});

test('nextDelivery: a same day order by and an order by days before', () => {
  const early = [{ delivery_dow: 4, order_by_dow: 4, order_by_time: '06:00' }];
  assert.equal(nextDelivery({ rules: early, nowVenue: { ymd: '2026-10-22', hm: '05:00' } }).deliveryYmd, '2026-10-22');
  assert.equal(nextDelivery({ rules: early, nowVenue: { ymd: '2026-10-22', hm: '06:00' } }).deliveryYmd, '2026-10-29');
  const twoBefore = [{ delivery_dow: 1, order_by_dow: 5, order_by_time: '12:00' }]; // Monday, by Friday noon
  const sat = nextDelivery({ rules: twoBefore, nowVenue: { ymd: '2026-10-24', hm: '09:00' } });
  assert.equal(sat.deliveryYmd, '2026-11-02');
  assert.equal(sat.orderByYmd, '2026-10-30');
});

test('nextDelivery: exceptions skip a day or move it with its order by', () => {
  const now = { ymd: '2026-12-21', hm: '10:00' }; // Monday
  const rules = rulesFromDeliveryDays(['fri'], '14:00');
  const xmas = [{ from_day: '2026-12-24', to_day: '2026-12-26', kind: 'no_delivery', name: 'Christmas' }];
  const plain = nextDelivery({ rules, nowVenue: now });
  assert.equal(plain.deliveryYmd, '2026-12-25');
  const skipped = nextDelivery({ rules, exceptions: xmas, nowVenue: now });
  assert.equal(skipped.deliveryYmd, '2027-01-01');
  assert.deepEqual(skipped.skipped, [{ ymd: '2026-12-25', name: 'Christmas' }]);
  const moved = nextDelivery({ rules, exceptions: [{ from_day: '2026-12-25', to_day: '2026-12-25', kind: 'deliver_instead', deliver_on: '2026-12-23', name: 'Early' }], nowVenue: now });
  assert.equal(moved.deliveryYmd, '2026-12-23');
  assert.equal(moved.orderByYmd, '2026-12-22', 'the order by moves the same two days');
  assert.equal(moved.orderByHm, '14:00');
  // no_delivery wins over deliver_instead on the same day
  const both = nextDelivery({ rules, exceptions: [...xmas, { from_day: '2026-12-25', to_day: '2026-12-25', kind: 'deliver_instead', deliver_on: '2026-12-23', name: 'Early' }], nowVenue: now });
  assert.equal(both.deliveryYmd, '2027-01-01');
  // a moved day later than another delivery: the earliest delivery wins
  const r2 = rulesFromDeliveryDays(['mon', 'wed'], '14:00');
  const late = nextDelivery({ rules: r2, exceptions: [{ from_day: '2026-12-28', to_day: '2026-12-28', kind: 'deliver_instead', deliver_on: '2026-12-31', name: 'Late' }], nowVenue: { ymd: '2026-12-26', hm: '10:00' } });
  assert.equal(late.deliveryYmd, '2026-12-30');
});

test('nextDelivery: null without rules, at most 21 days, bad input is safe', () => {
  assert.equal(nextDelivery({ rules: [], nowVenue: { ymd: '2026-10-22', hm: '10:00' } }), null);
  assert.equal(nextDelivery({ rules: null, nowVenue: { ymd: '2026-10-22', hm: '10:00' } }), null);
  assert.equal(nextDelivery({ rules: TUE_THU_14, nowVenue: { ymd: 'nope' } }), null);
  assert.equal(nextDelivery(), null);
  const all = rulesFromDeliveryDays(['tue'], '14:00');
  const shut = [{ from_day: '2026-10-22', to_day: '2026-11-30', kind: 'no_delivery', name: 'Refit' }];
  assert.equal(nextDelivery({ rules: all, exceptions: shut, nowVenue: { ymd: '2026-10-22', hm: '10:00' } }), null, 'nothing in 21 days');
});

test('both clock changes: real minutes left across 25 Oct (UK) and 1 Nov (US)', () => {
  // UK: clocks go back at 02:00 on Sun 25 Oct 2026, so Sat 12:00 to Mon 12:00 is 49 real hours
  const uk = nextDelivery({ rules: rulesFromDeliveryDays(['tue'], '12:00'), nowVenue: { ymd: '2026-10-24', hm: '12:00' }, tz: 'Europe/London' });
  assert.equal(uk.orderByAt, '2026-10-26T12:00');
  assert.equal(uk.minutesLeft, 49 * 60);
  assert.equal(uk.orderByMs, Date.UTC(2026, 9, 26, 12, 0));
  const ukWall = nextDelivery({ rules: rulesFromDeliveryDays(['tue'], '12:00'), nowVenue: { ymd: '2026-10-24', hm: '12:00' } });
  assert.equal(ukWall.minutesLeft, 48 * 60, 'without a zone it counts the wall clock');
  // US: clocks go back at 02:00 on Sun 1 Nov 2026 in Denver
  const us = nextDelivery({ rules: rulesFromDeliveryDays(['tue'], '12:00'), nowVenue: { ymd: '2026-10-31', hm: '12:00' }, tz: 'America/Denver' });
  assert.equal(us.orderByAt, '2026-11-02T12:00');
  assert.equal(us.minutesLeft, 49 * 60);
  // the order by day itself is on the change: Sun 25 Oct 09:00 London is 09:00 GMT
  const onDay = nextDelivery({ rules: rulesFromDeliveryDays(['mon'], '09:00'), nowVenue: { ymd: '2026-10-25', hm: '00:30' }, tz: 'Europe/London' });
  assert.equal(onDay.orderByMs, Date.UTC(2026, 9, 25, 9, 0));
  assert.equal(onDay.minutesLeft, 9 * 60 + 30, '00:30 BST to 09:00 GMT is 9 h 30 m');
  assert.equal(tzOffsetMinutes('Europe/London', Date.UTC(2026, 9, 24, 12)), 60);
  assert.equal(tzOffsetMinutes('Europe/London', Date.UTC(2026, 9, 26, 12)), 0);
  assert.equal(venueTimeToMs('2026-10-25', '01:30', 'Europe/London'), Date.UTC(2026, 9, 25, 0, 30), 'the twice happening 01:30 is the first one');
  assert.equal(venueTimeToMs('2026-03-29', '01:30', 'Europe/London'), Date.UTC(2026, 2, 29, 1, 30), 'a skipped time lands an hour on');
});

test('nextDelivery agrees with a day by day reference over 2,000 random rule sets', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const add = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
  const dow = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
  for (let i = 0; i < 2000; i++) {
    const rules = [];
    for (let d = 0; d < 7; d++) {
      if (rnd() < 0.4) {
        const none = rnd() < 0.2;
        rules.push({ delivery_dow: d, order_by_dow: none ? null : Math.floor(rnd() * 7), order_by_time: none ? null : `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${rnd() < 0.5 ? '00' : '30'}` });
      }
    }
    const today = add('2026-10-01', Math.floor(rnd() * 60));
    const hm = `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;
    // reference: every delivery day in the next 21, its order by found by stepping back day by day
    let want = null;
    for (let k = 0; k < 21 && !want; k++) {
      const day = add(today, k);
      const r = rules.find((x) => x.delivery_dow === dow(day));
      if (!r) continue;
      let ob;
      if (r.order_by_dow === null) ob = `${day}T00:00`;
      else { let o = day; while (dow(o) !== r.order_by_dow) o = add(o, -1); ob = `${o}T${r.order_by_time}`; }
      if (ob > `${today}T${hm}`) want = { day, ob };
    }
    const got = nextDelivery({ rules, nowVenue: { ymd: today, hm } });
    if (!want) { assert.equal(got, null, JSON.stringify({ rules, today, hm })); continue; }
    assert.equal(got.deliveryYmd, want.day, JSON.stringify({ rules, today, hm }));
    assert.equal(got.orderByAt, want.ob);
  }
});

test('coverFromRules: today to the delivery after next; null without rules', () => {
  assert.equal(coverFromRules({ rules: TUE_THU_14, nowVenue: { ymd: '2026-10-21', hm: '10:00' } }), 6, 'Thu next, Tue after');
  assert.equal(coverFromRules({ rules: TUE_THU_14, nowVenue: { ymd: '2026-10-21', hm: '15:00' } }), 8, 'after the cut off: Tue next, Thu after');
  assert.equal(coverFromRules({ rules: [], nowVenue: { ymd: '2026-10-21', hm: '10:00' } }), null);
  // before any cut off it is today's coverDaysFromSchedule
  const days = ['tue', 'thu'];
  assert.equal(coverFromRules({ rules: rulesFromDeliveryDays(days, null), nowVenue: { ymd: '2026-10-22', hm: '09:00' } }), coverDaysFromSchedule(days, 4));
  assert.equal(coverFromRules({ rules: rulesFromDeliveryDays(['mon'], null), nowVenue: { ymd: '2026-10-22', hm: '09:00' } }), 11, 'one delivery a week: to the second Monday');
});

test('orderByWords, dayWords, timeLeftWords: the mockup line, never a dash', () => {
  const n = nextDelivery({ rules: TUE_THU_14, nowVenue: { ymd: '2026-10-21', hm: '10:40' } });
  assert.equal(orderByWords(n), 'Next delivery Thu 22 Oct · order by Wed 14:00 (in 3 h 20 m)');
  assert.equal(orderByWords({ ...n, minutesLeft: 45 }), 'Next delivery Thu 22 Oct · order by Wed 14:00 (in 45 m)');
  assert.equal(orderByWords({ ...n, minutesLeft: 0 }), 'Next delivery Thu 22 Oct · order by Wed 14:00 (passed)');
  const live = nextDelivery({ rules: TUE_THU_14, nowVenue: { ymd: '2026-10-21', hm: '10:40' }, tz: 'Europe/London' });
  assert.equal(orderByWords(live, live.orderByMs - 30 * 60000), 'Next delivery Thu 22 Oct · order by Wed 14:00 (in 30 m)', 'counts down from nowMs');
  assert.equal(orderByWords(live, live.orderByMs + 60000), 'Next delivery Thu 22 Oct · order by Wed 14:00 (passed)');
  assert.equal(orderByWords(null), '');
  assert.equal(dayWords('2026-10-22'), 'Thu 22 Oct');
  assert.equal(dayWords('x'), '');
  assert.equal(timeLeftWords(60), '1 h');
  assert.equal(timeLeftWords(1500), '1 d 1 h');
  assert.equal(timeLeftWords(-3), null);
  for (const s of [orderByWords(n), orderByWords(live)]) assert.doesNotMatch(s, /[\u2013\u2014]/);
});

test('basketRules: minimum, maximum, the fee and its waiver, the approval limit', () => {
  const a = basketRules({ goods: 128, minOrder: 150, maxOrder: 800, fee: 12.5, feeWaivedOverMin: true, approvalLimit: null });
  assert.equal(a.minShort, 22);
  assert.equal(a.overMax, false);
  assert.equal(a.feeCharged, 12.5);
  assert.equal(a.needsApproval, false);
  assert.deepEqual(a.words, [
    { tone: 'amber', text: 'Minimum order £150: add £22 more' },
    { tone: 'plain', text: 'Delivery fee £12.50' },
  ]);
  assert.deepEqual(a.approval, { tone: 'plain', text: 'No approval limit at this site' });
  const b = basketRules({ goods: 150, minOrder: 150, fee: 12.5, feeWaivedOverMin: true });
  assert.equal(b.feeCharged, 0, 'waived at the minimum');
  assert.deepEqual(b.words, [{ tone: 'plain', text: 'No delivery fee over the minimum' }]);
  const c = basketRules({ goods: 820, maxOrder: 800, approvalLimit: 800 });
  assert.equal(c.overMax, true);
  assert.equal(c.needsApproval, true);
  assert.deepEqual(c.words, [{ tone: 'red', text: 'Over the maximum £800' }]);
  assert.deepEqual(c.approval, { tone: 'amber', text: 'Needs approval: over £800' });
  const d = basketRules({ goods: 790, fee: 12.5, approvalLimit: 800 });
  assert.equal(d.needsApproval, true, 'goods plus the fee count against the limit');
  const e = basketRules({ goods: 700, approvalLimit: 800 });
  assert.deepEqual(e.approval, { tone: 'plain', text: 'Approval needed over £800' });
  assert.equal(basketRules({ goods: 10, approvalLimit: 0 }).needsApproval, true, 'a limit of 0 means every order');
  assert.deepEqual(basketRules({}).words, []);
  assert.equal(moneyWords(2140), '£2,140');
  assert.equal(moneyWords(12.5), '£12.50');
  assert.equal(moneyWords(3, '$'), '$3');
});

test('suggestPacks: with none of the new inputs the answer is today\'s byte for byte', () => {
  const cases = [
    { onHand: 3, onOrder: 1, avgDaily: 2, coverDays: 5, safetyDays: 1, perPack: 4 },
    { onHand: 0, profile: [1, 2, 3, 4, 5, 6, 7], todayDow: 3, coverDays: 4, perPack: 6 },
    { onHand: 2, par: 10, perPack: 3 },
    { onHand: 20, avgDaily: 1, perPack: 5 },
  ];
  for (const c of cases) {
    const today = suggestPacks(c);
    assert.deepEqual(suggestPacks({ ...c, forecastScale: 1 }), today, 'scale 1 is today');
    assert.deepEqual(suggestPacks({ ...c, forecastScale: undefined, parByWeekday: undefined, coverDaysPar: undefined }), today);
    assert.deepEqual(Object.keys(today), ['expectedBase', 'needBase', 'suggestedPacks', 'covered', 'effCover', 'hasShape']);
  }
});

test('suggestPacks: forecastScale, the par for the delivery day and a days of cover par', () => {
  const base = { onHand: 2, onOrder: 0, avgDaily: 2, coverDays: 3, safetyDays: 0, perPack: 4 };
  const busy = suggestPacks({ ...base, forecastScale: 1.5 });
  assert.equal(busy.expectedBase, 9);
  assert.equal(busy.needBase, 7);
  assert.equal(busy.suggestedPacks, 2);
  assert.equal(busy.forecastUse, 3);
  const wed = suggestPacks({ ...base, parByWeekday: { 3: 20, 5: 4 }, deliveryDow: 3 });
  assert.equal(wed.parUsed, 20);
  assert.equal(wed.needBase, 18, 'topped up to the Wednesday par');
  assert.equal(wed.suggestedPacks, 5);
  const fri = suggestPacks({ ...base, par: 30, parByWeekday: { 3: 20 }, deliveryDow: 5 });
  assert.equal(fri.parUsed, 30, 'no par for Friday: the usual par');
  assert.equal(fri.needBase, 4, 'the usual par does not top up when there is history (today\'s rule)');
  const cover = suggestPacks({ ...base, coverDaysPar: 5 });
  assert.equal(cover.parUsed, 10, '2 a day for 5 days');
  assert.equal(cover.needBase, 8);
  const none = suggestPacks({ onHand: 1, coverDaysPar: 5, par: 6, perPack: 1 });
  assert.equal(none.parUsed, 6, 'no usage: a cover par cannot be worked out, the par stands');
  assert.equal(none.needBase, 5);
});
