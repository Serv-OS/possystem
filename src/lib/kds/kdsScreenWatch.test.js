// 12 Oct 2026, Coffee Boy Barnsley (K6): the till says when a kitchen screen stops showing orders.
// The figures are that afternoon's: the drinks screen last beat at 14:43:40 UTC, the food screen
// and the till kept beating, and orders sat on the drinks screen from 14:30:58.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenNow, emptyOpeningHours } from '../openingHours.js';
import {
  WATCH_TICK_MS, SILENT_MS, MIN_WAIT_MS, MAX_WAIT_MS, STUCK_EXTRA_MIN, STUCK_RULE, DEFAULT_LATE_MIN, REPEAT_MS, BACK_LINE_MS,
  TRADING_MARGIN_MS, CONFIRM_MAX_IDS, GONE_KEEP, NO_SCREEN_RECHECK_MS, MAX_CHIMES, STALE_SCREEN_MS,
  watchRunsOn, waitingTickets, leftWaiting, isTrading, screensFrom, serverNowFrom, watchProblems, soundDue,
  confirmWaiting, rememberGone, newWatch, watchLook, isBack, nextAlerts, hideAlert, alertWords, backWords,
  waitingSummary, waitingWords, screenStatus, heardWords, testTicketWords,
} from './kdsScreenWatch.js';

const T = (s) => Date.UTC(2026, 9, 12, ...s.split(':').map(Number));
const iso = (s) => new Date(T(s)).toISOString();
const MIN = 60000;

// 14:47 UTC: drinks last beat 14:43:40, food and the till beat at 14:46:50 and 14:46:45.
const devices = () => [
  { id: 'd1', name: 'drinks kds', type: 'kds', status: 'active', centre_id: 'pc-d', last_seen: iso('14:43:40'), kds_settings: { late: 15 } },
  { id: 'd2', name: 'food KDS', type: 'kds', status: 'active', centre_id: 'pc-f', last_seen: iso('14:46:50'), kds_settings: null },
  { id: 'p1', name: 'POS 1', type: 'pos', status: 'active', centre_id: null, last_seen: iso('14:46:45') },
];
const store = () => [
  { id: 'k1', centre_id: 'pc-d', sent_at: iso('14:30:58'), status: 'pending' },     // a database row
  { id: 'k2', centreId: 'pc-d', sentAt: T('14:42:13') },                           // the till's own sent ticket
  { id: 'k3', centre_id: 'pc-d', sent_at: iso('14:46:30'), status: 'pending' },     // under 2 minutes
  { id: 'k4', centre_id: 'pc-f', sent_at: iso('14:44:21'), status: 'pending' },
  { id: 'k5', centre_id: 'pc-d', sent_at: iso('09:00:00'), status: 'pending' },     // over 3 hours: a leftover
  { id: 'k6', centre_id: 'pc-d', sent_at: iso('14:40:00'), status: 'held' },        // held: not waiting
];
const now = T('14:47:00');
const dayStartMs = T('05:00:00');   // 06:00 in Barnsley in October

test('the limits are the ones the owner was told', () => {
  assert.equal(WATCH_TICK_MS, 60000);
  assert.equal(SILENT_MS, 120000);
  assert.equal(MIN_WAIT_MS, 120000);
  assert.equal(MAX_WAIT_MS, 10800000);
  assert.equal(STUCK_EXTRA_MIN, 5);
  // Review 12 Oct 2026: on 39 normal venue days the "stuck" rule chimed on 25. It is built and
  // tested (the tests below pass stuckRule: true) and switched off until the owner says otherwise.
  assert.equal(STUCK_RULE, false, 'the "stuck" rule is off: only a SILENT screen raises the bar');
  assert.equal(MAX_CHIMES, 3);
  assert.equal(STALE_SCREEN_MS, 7 * 24 * 60 * MIN);
  assert.equal(DEFAULT_LATE_MIN, 15);
  assert.equal(REPEAT_MS, 300000);
  assert.equal(BACK_LINE_MS, 20000);
  assert.equal(TRADING_MARGIN_MS, 1800000);
  assert.equal(CONFIRM_MAX_IDS, 20);
  assert.equal(GONE_KEEP, 500);
  assert.equal(NO_SCREEN_RECHECK_MS, 600000);
});

test('only a counter till watches', () => {
  assert.equal(watchRunsOn({ type: 'pos', defaultSurface: 'pos' }), true);
  assert.equal(watchRunsOn({ type: 'pos', defaultSurface: 'tables' }), true);
  assert.equal(watchRunsOn({ type: 'pos' }), true);
  assert.equal(watchRunsOn({ type: 'pos', defaultSurface: 'kds' }), false, 'a till profile that is a kitchen screen');
  assert.equal(watchRunsOn({ type: 'pos', defaultSurface: 'kiosk' }), false, 'a till profile that faces customers');
  for (const type of ['kds', 'kiosk', 'handheld', 'clock', 'admin', undefined, null]) assert.equal(watchRunsOn({ type }), false, String(type));
  assert.equal(watchRunsOn(), false);
});

test('orders waiting: both ticket shapes are read, oldest first', () => {
  const waiting = waitingTickets(store(), { now, dayStartMs });
  assert.deepEqual(waiting, [
    { id: 'k1', centreId: 'pc-d', sentAt: T('14:30:58') },
    { id: 'k2', centreId: 'pc-d', sentAt: T('14:42:13') },
    { id: 'k4', centreId: 'pc-f', sentAt: T('14:44:21') },
  ]);
});

test('orders waiting: under 2 minutes, over 3 hours, before the business day, held and skipped ids do not count', () => {
  const ids = (list, opts) => waitingTickets(list, { now, dayStartMs, ...opts }).map((w) => w.id);
  assert.deepEqual(ids(store()), ['k1', 'k2', 'k4']);
  assert.deepEqual(ids(store(), { skip: new Set(['k1']) }), ['k2', 'k4'], 'the database said k1 is no longer waiting');
  assert.deepEqual(ids([{ id: 'a', sent_at: iso('14:45:00') }]), ['a'], 'exactly 2 minutes counts');
  assert.deepEqual(ids([{ id: 'a', sent_at: iso('14:45:01') }]), [], 'a second under does not');
  assert.deepEqual(ids([{ id: 'a', sent_at: iso('11:47:00') }]), ['a'], 'exactly 3 hours still counts');
  assert.deepEqual(ids([{ id: 'a', sent_at: iso('11:46:59') }]), [], 'older is a leftover');
  assert.deepEqual(ids([{ id: 'a', sent_at: iso('14:40:00') }], { dayStartMs: T('14:41:00') }), [], 'before the business day');
  assert.deepEqual(ids([{ id: 'a', sent_at: iso('14:40:00'), status: 'bumped' }]), []);
  assert.deepEqual(ids([{ id: 'a', sent_at: iso('15:30:00') }]), [], 'a ticket timed for later is not waiting yet');
  assert.deepEqual(ids([null, {}, { id: 'a' }, { id: 'b', sent_at: 'not a date' }]), [], 'unreadable rows are ignored');
  assert.deepEqual(waitingTickets(null, { now }), []);
});

test('the till notes a ticket leaving its list (bumped) or leaving pending (held), by station', () => {
  const before = [
    { id: 'a', centre_id: 'pc-d', status: 'pending' }, { id: 'b', centreId: 'pc-f' }, { id: 'c', centre_id: null, status: 'pending' },
    { id: 'h', centre_id: 'pc-x', status: 'held' },
  ];
  assert.deepEqual(leftWaiting(before, before), [], 'nothing left');
  assert.deepEqual(leftWaiting(before, before.filter((t) => t.id !== 'a')), ['pc-d'], 'bumped on the drinks screen');
  assert.deepEqual(leftWaiting(before, before.filter((t) => t.id !== 'c')), [''], 'a ticket with no station');
  assert.deepEqual(leftWaiting(before, before.map((t) => (t.id === 'b' ? { ...t, status: 'held' } : t))), ['pc-f'], 'held is somebody working that screen');
  assert.deepEqual(leftWaiting(before, [...before, { id: 'new', centre_id: 'pc-d' }]), [], 'a new ticket is not a bump');
  assert.deepEqual(leftWaiting(before, before.map((t) => (t.id === 'h' ? { ...t, status: 'pending' } : t))), [], 'a resumed ticket is not a bump');
  assert.deepEqual(leftWaiting(before, []).sort(), ['', 'pc-d', 'pc-f', 'pc-x']);
  assert.deepEqual(leftWaiting(null, null), []);
});

test('the kitchen screens come from the devices rows; the clock is the newest heartbeat at the venue', () => {
  const list = [
    ...devices(),
    { id: 'd3', name: 'old kds', type: 'kds', status: 'removed', centre_id: 'pc-d', last_seen: iso('09:00:00') },
    { id: 'd4', name: '', type: 'kds', status: 'online', centre_id: null, last_seen: null, kds_settings: '{"late":30}' },
    { id: 'd5', name: 'unpaired kds', type: 'kds', status: 'unpaired', centre_id: 'pc-d', last_seen: null },
    { id: 'k1', name: 'Kiosk', type: 'kiosk', status: 'online', last_seen: iso('14:46:10') },
  ];
  const screens = screensFrom(list);
  assert.deepEqual(screens.map((s) => s.id), ['d1', 'd2', 'd4'], 'only kitchen screens that are in use');
  assert.deepEqual(screens[0], { id: 'd1', name: 'drinks kds', centreId: 'pc-d', lastSeenMs: T('14:43:40'), lateMin: 15 });
  assert.equal(screens[1].lateMin, DEFAULT_LATE_MIN, 'no settings saved: the default late time');
  assert.equal(screens[2].name, 'Kitchen screen');
  assert.equal(screens[2].lateMin, 30, 'settings stored as text are read');
  assert.ok(Number.isNaN(screens[2].lastSeenMs));
  assert.equal(screensFrom([{ id: 'x', type: 'kds', status: 'active', kds_settings: { late: 0 } }])[0].lateMin, DEFAULT_LATE_MIN);
  assert.equal(serverNowFrom(list), T('14:46:50'));
  assert.equal(serverNowFrom([{ last_seen: null }, { last_seen: 'rubbish' }]), null);
  assert.equal(serverNowFrom([]), null);
  assert.deepEqual(screensFrom(null), []);
});

test('12 Oct, 14:47: the drinks screen is silent (2 minutes behind the newest heartbeat) with 2 orders waiting', () => {
  const waiting = waitingTickets(store(), { now, dayStartMs });
  const serverNow = serverNowFrom(devices());
  const problems = watchProblems({ screens: screensFrom(devices()), waiting, serverNow, bumpSeenAt: new Map(), watchingSince: T('11:46:18'), now });
  assert.equal(problems.length, 1, 'the food screen is beating: no alarm for it');
  const p = problems[0];
  assert.equal(p.screenId, 'd1');
  assert.equal(p.reason, 'silent');
  assert.equal(p.count, 2);
  assert.deepEqual(p.ids, ['k1', 'k2']);
  assert.equal(p.silentMs, T('14:46:50') - T('14:43:40'));
  assert.equal(p.oldestWaitMs, now - T('14:30:58'));
  assert.deepEqual(alertWords(nextAlerts({}, problems, { now }).alerts.d1), {
    title: 'drinks kds is not showing orders',
    body: 'This till has not heard from it for 3 min. 2 orders waiting, the oldest 16 min. Check that screen and its WiFi. Tell the kitchen the orders by hand.',
  });
  // One second short of two minutes behind: not silent yet.
  const nearly = devices().map((d) => (d.id === 'd1' ? { ...d, last_seen: iso('14:44:51') } : d));
  assert.equal(watchProblems({ screens: screensFrom(nearly), waiting, serverNow: serverNowFrom(nearly), bumpSeenAt: new Map(), watchingSince: T('11:46:18'), now }).length, 0);
  const just = devices().map((d) => (d.id === 'd1' ? { ...d, last_seen: iso('14:44:50') } : d));
  assert.equal(watchProblems({ screens: screensFrom(just), waiting, serverNow: serverNowFrom(just), bumpSeenAt: new Map(), watchingSince: T('11:46:18'), now })[0].reason, 'silent');
});

test('a silent screen with nothing waiting on it is not an alarm, and neither is a station with no screen', () => {
  const serverNow = serverNowFrom(devices());
  const screens = screensFrom(devices());
  const base = { screens, serverNow, bumpSeenAt: new Map(), watchingSince: 0, now };
  assert.deepEqual(watchProblems({ ...base, waiting: [] }), []);
  assert.deepEqual(watchProblems({ ...base, waiting: waitingTickets([{ id: 'f', centre_id: 'pc-f', sent_at: iso('14:40:00') }], { now }) }), [], 'only the healthy food screen has an order');
  assert.deepEqual(watchProblems({ ...base, waiting: waitingTickets([{ id: 'x', centre_id: 'pc-printer-only', sent_at: iso('14:00:00') }], { now }) }), [], 'no screen is bound to that station');
  assert.deepEqual(watchProblems({ ...base, waiting: waitingTickets([{ id: 'x', centre_id: null, sent_at: iso('14:00:00') }], { now }) }), [], 'a ticket with no station is on no station screen');
  assert.deepEqual(watchProblems(), []);
});

test('a screen not heard from since yesterday is silent; one never heard from, or not for a week, is a leftover; with no heartbeat to compare with the till cannot tell', () => {
  const waiting = waitingTickets(store(), { now, dayStartMs });
  const rows = (lastSeen) => [{ id: 'd1', name: 'drinks kds', type: 'kds', status: 'active', centre_id: 'pc-d', last_seen: lastSeen }, { id: 'p1', type: 'pos', status: 'active', last_seen: iso('14:46:45') }];
  const judge = (lastSeen) => watchProblems({ screens: screensFrom(rows(lastSeen)), waiting, serverNow: serverNowFrom(rows(lastSeen)), bumpSeenAt: new Map(), watchingSince: 0, now });
  // The tablet worked yesterday evening and did not start this morning: that IS an alarm.
  const p = judge(new Date(T('14:46:45') - 20 * 60 * MIN).toISOString())[0];
  assert.equal(p.reason, 'silent');
  assert.match(alertWords(p).body, /^This till has not heard from it for 20 h\. 2 orders waiting, the oldest 16 min\. Check that screen and its WiFi\. Tell the kitchen the orders by hand\.$/);
  assert.match(alertWords(judge(new Date(T('14:46:45') - 3 * 24 * 60 * MIN).toISOString())[0]).body, /^This till has not heard from it today\. /, 'days: "today" reads better than a count of hours');
  // Review 12 Oct 2026: 3 of the 16 live kitchen screen rows were leftovers (a replaced tablet, a
  // test screen), silent for over a week. Each would have chimed whenever an order waited 2 minutes.
  assert.deepEqual(judge(new Date(T('14:46:45') - STALE_SCREEN_MS).toISOString()), [], 'a week: a leftover, not a screen staff rely on');
  assert.equal(judge(new Date(T('14:46:45') - STALE_SCREEN_MS + MIN).toISOString()).length, 1, 'a minute under a week still counts');
  assert.deepEqual(judge(null), [], 'never heard from at all: a leftover');
  // Heard from once, but no clock at all (cannot happen while this till beats): not called silent.
  const fresh = [{ id: 'k9', centre_id: 'pc-d', sent_at: iso('14:44:00') }];
  assert.deepEqual(watchProblems({ screens: screensFrom(devices()), waiting: waitingTickets(fresh, { now }), serverNow: null, bumpSeenAt: new Map(), watchingSince: now, now }), []);
});

test('stuck: only past the late time plus 5 minutes with no bump seen in that time', () => {
  const beating = devices().map((d) => ({ ...d, last_seen: iso(d.id === 'd1' ? '14:50:40' : '14:50:50') }));
  const now2 = T('14:51:00');
  const waiting = waitingTickets(store(), { now: now2, dayStartMs });
  const look = (bumpSeenAt, watchingSince = T('11:46:18'), list = beating) =>
    watchProblems({ screens: screensFrom(list), waiting, serverNow: serverNowFrom(list), bumpSeenAt, watchingSince, now: now2, stuckRule: true });
  // The oldest drinks order has waited 20 min 2 s; late is 15, so the limit is 20.
  const stuck = look(new Map([['pc-d', T('14:29:42')]]));
  assert.deepEqual(stuck.map((p) => `${p.name}:${p.reason}`), ['drinks kds:stuck']);
  assert.equal(stuck[0].count, 3, 'k1, k2 and k3 (now over 2 minutes)');
  assert.equal(stuck[0].noBumpMs, now2 - T('14:30:58'), 'never longer than the oldest order has waited');
  assert.deepEqual(alertWords(nextAlerts({}, stuck, { now: now2 }).alerts.d1), {
    title: 'drinks kds has not bumped anything for 20 min',
    body: '3 orders waiting, the oldest 20 min. Check that screen is showing them.',
  });
  // As shipped (STUCK_RULE off) the very same look raises nothing: the screen is beating.
  assert.deepEqual(watchProblems({ screens: screensFrom(beating), waiting, serverNow: serverNowFrom(beating), bumpSeenAt: new Map([['pc-d', T('14:29:42')]]), watchingSince: T('11:46:18'), now: now2 }), []);
  assert.deepEqual(look(new Map([['pc-d', T('14:46:00')]])), [], 'a bump seen 5 minutes ago is a slow kitchen, not a stuck screen');
  assert.deepEqual(look(new Map([['pc-d', T('14:31:01')]])), [], 'a bump 19 min 59 s ago: not yet');
  assert.equal(look(new Map([['pc-d', T('14:31:00')]])).length, 1, 'exactly 20 minutes');
  assert.deepEqual(look(new Map(), T('14:40:00')), [], 'a till that started 11 minutes ago has seen no bump yet: it waits');
  assert.equal(look(new Map([['pc-f', T('14:50:00')]])).length, 1, 'a bump on the food screen says nothing about drinks');
  // A longer late time on that screen moves the limit with it.
  const late30 = beating.map((d) => (d.id === 'd1' ? { ...d, kds_settings: { late: 30 } } : d));
  assert.deepEqual(look(new Map(), T('11:46:18'), late30), []);
  // The hold back switch: with the rule left out a beating screen is never "stuck", and "silent" still works.
  assert.deepEqual(watchProblems({ screens: screensFrom(beating), waiting, serverNow: serverNowFrom(beating), bumpSeenAt: new Map(), watchingSince: T('11:46:18'), now: now2, stuckRule: false }), []);
  assert.deepEqual(watchProblems({ screens: screensFrom(devices()), waiting, serverNow: serverNowFrom(devices()), bumpSeenAt: new Map(), watchingSince: T('11:46:18'), now: now2, stuckRule: false }).map((p) => p.reason), ['silent']);
  // The oldest order one second under the limit: not yet.
  const young = waitingTickets(store().filter((t) => t.id !== 'k1'), { now: now2, dayStartMs });
  assert.deepEqual(watchProblems({ screens: screensFrom(beating), waiting: young, serverNow: serverNowFrom(beating), bumpSeenAt: new Map(), watchingSince: 0, now: now2, stuckRule: true }), []);
});

test('a screen with no station shows every ticket: any order counts, and a bump at any station counts', () => {
  const now2 = T('14:51:00');
  const list = [
    { id: 'all', name: 'Pass', type: 'kds', status: 'active', centre_id: null, last_seen: iso('14:50:40'), kds_settings: { late: 15 } },
    { id: 'p1', type: 'pos', status: 'active', last_seen: iso('14:50:50') },
  ];
  const waiting = waitingTickets(store(), { now: now2, dayStartMs });
  const look = (bumpSeenAt) => watchProblems({ screens: screensFrom(list), waiting, serverNow: serverNowFrom(list), bumpSeenAt, watchingSince: 0, now: now2, stuckRule: true });
  assert.equal(look(new Map())[0].count, 4, 'drinks and food orders are all on it');
  assert.equal(look(new Map())[0].reason, 'stuck');
  assert.deepEqual(look(new Map([['pc-f', T('14:49:00')]])), [], 'a food ticket left 2 minutes ago: somebody is bumping on it');
  assert.deepEqual(look(new Map([['', T('14:49:00')]])), []);
});

test('a till whose clock is 10 minutes fast calls nobody silent: heartbeats are compared with each other', () => {
  const beating = devices().map((d) => ({ ...d, last_seen: iso(d.id === 'd1' ? '14:50:40' : '14:50:50') }));
  const fast = T('14:51:00') + 10 * MIN;
  const waiting = waitingTickets(store(), { now: fast, dayStartMs: 0 });
  const problems = watchProblems({ screens: screensFrom(beating), waiting, serverNow: serverNowFrom(beating), bumpSeenAt: new Map([['pc-d', fast - MIN]]), watchingSince: 0, now: fast, stuckRule: true });
  assert.equal(problems.filter((p) => p.reason === 'silent').length, 0);
  assert.deepEqual(problems, [], 'and a bump it saw a minute ago keeps "stuck" away too');
});

test('the chime: at the start, again at 5 minutes, not in between, three times at most for the same orders', () => {
  const waiting = waitingTickets(store(), { now, dayStartMs });
  const problems = watchProblems({ screens: screensFrom(devices()), waiting, serverNow: serverNowFrom(devices()), bumpSeenAt: new Map(), watchingSince: 0, now });
  assert.equal(problems[0].newestSentAt, T('14:42:13'), 'the newest order waiting on that screen');
  assert.equal(soundDue({}, problems[0], now), true);
  const a = nextAlerts({}, problems, { now });
  assert.equal(a.sound, true);
  assert.equal(a.alerts.d1.since, now);
  assert.equal(a.alerts.d1.lastSoundAt, now);
  assert.equal(a.alerts.d1.sounds, 1);
  assert.equal(a.alerts.d1.acked, false);
  assert.deepEqual(a.back, []);
  // One minute on: the same trouble, no second sound.
  assert.equal(soundDue(a.alerts, problems[0], now + MIN), false);
  const b = nextAlerts(a.alerts, problems, { now: now + MIN });
  assert.equal(b.sound, false);
  assert.equal(b.alerts.d1.lastSoundAt, now);
  assert.equal(b.alerts.d1.since, now);
  // Five and ten minutes on: the second and the third chime.
  const c = nextAlerts(b.alerts, problems, { now: now + 5 * MIN });
  assert.equal(c.sound, true);
  assert.equal(c.alerts.d1.since, now, 'the same trouble since the start');
  const d = nextAlerts(c.alerts, problems, { now: now + 10 * MIN });
  assert.equal(d.sound, true);
  assert.equal(d.alerts.d1.sounds, MAX_CHIMES);
  // Review 12 Oct 2026: a tablet switched off at closing with one card not bumped chimed every 5
  // minutes for 3 hours, 36 times. After the third chime for the same orders the till is quiet.
  let last = d.alerts;
  for (let n = 3; n <= 36; n += 1) {
    assert.equal(soundDue(last, problems[0], now + n * 5 * MIN), false, `no chime ${n + 1}`);
    const next = nextAlerts(last, problems, { now: now + n * 5 * MIN });
    assert.equal(next.sound, false);
    assert.equal(next.alerts.d1.acked, false, 'the bar stays up: the words are still true');
    last = next.alerts;
  }
  // A NEW order sent to that screen starts it again (it shows up here once it has waited 2 minutes).
  const more = [...problems.map((p) => ({ ...p, count: 3, newestSentAt: now + 180 * MIN, ids: [...p.ids, 'k9'] }))];
  const e = nextAlerts(last, more, { now: now + 183 * MIN });
  assert.equal(e.sound, true);
  assert.equal(e.alerts.d1.sounds, 1);
  assert.equal(e.alerts.d1.newestSentAt, now + 180 * MIN);
});

test('OK means something: no bar and no chime for that screen until a new order is sent to it, or it comes back and goes again', () => {
  const waiting = waitingTickets(store(), { now, dayStartMs });
  const problems = watchProblems({ screens: screensFrom(devices()), waiting, serverNow: serverNowFrom(devices()), bumpSeenAt: new Map(), watchingSince: 0, now });
  const up = nextAlerts({}, problems, { now }).alerts;
  const ok = hideAlert(up, 'd1');
  assert.equal(ok.d1.acked, true);
  assert.equal(hideAlert(up, 'nobody'), up, 'OK on a bar that is gone changes nothing');
  // Review 12 Oct 2026: OK used to hide the bar for five minutes and the chime came anyway.
  let last = ok;
  for (let n = 1; n <= 36; n += 1) {
    assert.equal(soundDue(last, problems[0], now + n * 5 * MIN), false);
    const next = nextAlerts(last, problems, { now: now + n * 5 * MIN });
    assert.equal(next.sound, false, `quiet ${n * 5} minutes after OK`);
    assert.equal(next.alerts.d1.acked, true, 'and the bar stays away');
    last = next.alerts;
  }
  // An order leaving the list (bumped on another screen) is not a new order.
  const fewer = problems.map((p) => ({ ...p, count: 1, newestSentAt: T('14:30:58'), ids: ['k1'] }));
  assert.equal(nextAlerts(last, fewer, { now: now + 200 * MIN }).alerts.d1.acked, true);
  // A new order for the silent screen 2 minutes after OK: the bar is back at once, the chime waits for the 5 minutes.
  const more = problems.map((p) => ({ ...p, count: 3, newestSentAt: now + MIN, ids: [...p.ids, 'k9'] }));
  const soon = nextAlerts(ok, more, { now: now + 3 * MIN });
  assert.equal(soon.alerts.d1.acked, false, 'the bar shows again: staff must know this order is not on the screen either');
  assert.equal(soon.sound, false);
  const later = nextAlerts(soon.alerts, more, { now: now + 5 * MIN });
  assert.equal(later.sound, true);
  // The screen comes back (the alert goes) and falls silent again later: new trouble, bar and chime.
  const gone = nextAlerts(ok, [], { now: now + 6 * MIN });
  assert.deepEqual(gone.alerts, {});
  const again = nextAlerts(gone.alerts, problems, { now: now + 30 * MIN });
  assert.equal(again.sound, true);
  assert.equal(again.alerts.d1.acked, false);
});

test('an order another live screen also shows is not stranded: a second tablet that is off raises nothing while the first is working', () => {
  // Review 12 Oct 2026: two kitchen screen rows on one station (a tablet used only at peak, or the
  // old row left behind when a tablet was replaced) raised "is not showing orders. Tell the kitchen
  // the orders by hand" with a chime, while the working screen had every one of those orders.
  const two = [
    { id: 'd1', name: 'Drinks 1', type: 'kds', status: 'active', centre_id: 'pc-d', last_seen: iso('14:46:40') },
    { id: 'd3', name: 'Drinks 2', type: 'kds', status: 'active', centre_id: 'pc-d', last_seen: iso('11:00:00') },
    { id: 'p1', name: 'POS 1', type: 'pos', status: 'active', centre_id: null, last_seen: iso('14:46:45') },
  ];
  const waiting = waitingTickets(store(), { now, dayStartMs });
  const judge = (list) => watchProblems({ screens: screensFrom(list), waiting, serverNow: serverNowFrom(list), bumpSeenAt: new Map(), watchingSince: 0, now });
  assert.deepEqual(judge(two), []);
  // Both drinks screens silent: each is in trouble (nobody shows those orders).
  const both = two.map((d) => (d.id === 'd1' ? { ...d, last_seen: iso('14:40:00') } : d));
  assert.deepEqual(judge(both).map((p) => p.name), ['Drinks 1', 'Drinks 2']);
  // A live screen with NO station shows every ticket, so it covers the silent drinks screen too.
  const pass = [{ ...two[1] }, { id: 'all', name: 'Pass', type: 'kds', status: 'active', centre_id: null, last_seen: iso('14:46:40') }, two[2]];
  assert.deepEqual(judge(pass), []);
  // A silent screen with no station is covered order by order: the food screen is live, the
  // drinks screen is not, so only the drinks orders are stranded.
  const mixed = [
    { id: 'all', name: 'Pass', type: 'kds', status: 'active', centre_id: null, last_seen: iso('14:40:00') },
    { id: 'd2', name: 'food KDS', type: 'kds', status: 'active', centre_id: 'pc-f', last_seen: iso('14:46:50') },
    two[2],
  ];
  const p = judge(mixed);
  assert.deepEqual(p.map((x) => `${x.name}:${x.count}:${x.ids}`), ['Pass:2:k1,k2'], 'the food order k4 is on the live food screen');
  // A live screen of ANOTHER station covers nothing of this one.
  assert.equal(judge(devices()).length, 1);
});

test('"could not tell" changes nothing: a carried alert stays as it was, and none is raised', () => {
  const waiting = waitingTickets(store(), { now, dayStartMs });
  const problems = watchProblems({ screens: screensFrom(devices()), waiting, serverNow: serverNowFrom(devices()), bumpSeenAt: new Map(), watchingSince: 0, now });
  const up = nextAlerts({}, problems, { now }).alerts;
  // The check before the 5 minute chime could not be made: no sound, the alert unchanged, no "back".
  const kept = nextAlerts(up, [], { now: now + 5 * MIN, carry: ['d1'] });
  assert.equal(kept.alerts.d1, up.d1);
  assert.equal(kept.sound, false);
  assert.deepEqual(kept.back, []);
  // Never up, check failed: not raised.
  const none = nextAlerts({}, [], { now, carry: ['d1'] });
  assert.deepEqual(none.alerts, {});
  assert.equal(none.sound, false);
  // A carried screen is not judged again in the same look even if a problem for it is passed in.
  assert.equal(nextAlerts(up, problems, { now: now + 5 * MIN, carry: ['d1'] }).sound, false);
});

test('the database check before a chime: gone orders are dropped; a list shown to be behind only speaks for confirmed orders', () => {
  const waiting = [
    { id: 'a', centreId: 'pc-d', sentAt: 1 }, { id: 'b', centreId: 'pc-d', sentAt: 2 }, { id: 'c', centreId: 'pc-d', sentAt: 3 },
    { id: 'f', centreId: 'pc-f', sentAt: 2 },
  ];
  const ids = ['a', 'b', 'c'];
  // Every checked order is still pending: the till's list is good, nothing changes.
  const good = confirmWaiting(waiting, { ids, checked: ['a', 'b'], pending: new Set(['a', 'b']) });
  assert.equal(good.waiting, waiting);
  assert.deepEqual(good.gone, []);
  assert.deepEqual(good.stations, []);
  // One was bumped without this till seeing it: it goes, and so does the order nobody asked about.
  const behind = confirmWaiting(waiting, { ids, checked: ['a', 'b'], pending: new Set(['b']) });
  assert.deepEqual(behind.waiting.map((w) => w.id), ['b', 'f'], 'b is confirmed; c was not asked about; food is another screen');
  assert.deepEqual(behind.gone, ['a']);
  assert.deepEqual(behind.stations, ['pc-d'], 'proof that drinks tickets are being bumped');
  // All gone: nothing of this screen is left to alarm about.
  const all = confirmWaiting(waiting, { ids, checked: ['a', 'b'], pending: new Set() });
  assert.deepEqual(all.waiting.map((w) => w.id), ['f']);
  assert.deepEqual(all.gone, ['a', 'b']);
  assert.deepEqual(confirmWaiting([{ id: 'n', centreId: null, sentAt: 1 }], { ids: ['n'], checked: ['n'], pending: new Set() }).stations, ['']);
  assert.deepEqual(confirmWaiting(null, {}), { waiting: [], gone: [], stations: [] });
  // A ticket the database does not hold at all (this till's own send that never arrived) is not
  // waiting on the screen, but it is no proof that anything was bumped there.
  const never = confirmWaiting(waiting, { ids, checked: ['a', 'b'], pending: new Set(['b']), found: new Set(['b']) });
  assert.deepEqual(never.waiting.map((w) => w.id), ['b', 'f']);
  assert.deepEqual(never.gone, ['a']);
  assert.deepEqual(never.stations, [], 'a missing row proves nothing about the drinks screen');
  const bumped = confirmWaiting(waiting, { ids, checked: ['a', 'b'], pending: new Set(), found: new Set(['a']) });
  assert.deepEqual(bumped.gone, ['a', 'b']);
  assert.deepEqual(bumped.stations, ['pc-d'], 'a was found and is no longer pending: that is a bump');
});

test('the ids the database said are gone are remembered, and the memory stays small', () => {
  const gone = new Set(['a', 'b']);
  assert.equal(rememberGone(gone, ['c', 'a']), gone, 'the same Set comes back');
  assert.deepEqual([...gone], ['b', 'c', 'a'], 'an id named again counts as newest');
  assert.deepEqual([...rememberGone(new Set(['a', 'b', 'c']), ['d'], 3)], ['b', 'c', 'd'], 'past the limit the oldest is forgotten');
  assert.deepEqual([...rememberGone(new Set(['a']), null)], ['a']);
  const big = new Set();
  for (let i = 0; i < GONE_KEEP + 40; i += 1) rememberGone(big, [`t${i}`]);
  assert.equal(big.size, GONE_KEEP);
  assert.equal(big.has('t39'), false);
  assert.equal(big.has('t40'), true);
  assert.equal(big.has(`t${GONE_KEEP + 39}`), true);
});

// A till as components/KdsScreenAlert.jsx runs it: its own list, the two reads, one look a minute.
function till({ tickets, devicesAt, database, since = T('09:00:00'), trading = true, stuckRule }) {
  const t = { tickets, alerts: {}, watch: newWatch(since), reads: [], chimes: [], backs: [], devicesAt, database, trading, read1: 'ok', read2: 'ok' };
  t.look = async (at) => {
    const now = typeof at === 'string' ? T(at) : at;
    const out = await watchLook({
      tickets: t.tickets, trading: t.trading, dayStartMs, getAlerts: () => t.alerts, watch: t.watch, now, stuckRule,
      readDevices: async () => { t.reads.push('devices'); return t.read1 === 'ok' ? t.devicesAt(now) : null; },
      readStatuses: async (ids) => {
        t.reads.push(`tickets:${ids.length}`);
        if (t.read2 !== 'ok') return null;
        return ids.filter((id) => id in t.database).map((id) => ({ id, status: t.database[id] }));
      },
    });
    if (!out) return null;
    t.alerts = out.alerts;
    if (out.sound) t.chimes.push(now);
    out.back.forEach((b) => t.backs.push(backWords(b)));
    return out;
  };
  return t;
}
const beatingAt = (drinks) => (at) => [
  { id: 'd1', name: 'drinks kds', type: 'kds', status: 'active', centre_id: 'pc-d', last_seen: new Date(typeof drinks === 'function' ? drinks(at) : at - 20000).toISOString(), kds_settings: { late: 15 } },
  { id: 'd2', name: 'food KDS', type: 'kds', status: 'active', centre_id: 'pc-f', last_seen: new Date(at - 10000).toISOString(), kds_settings: null },
  { id: 'p1', name: 'POS 1', type: 'pos', status: 'active', centre_id: null, last_seen: new Date(at - 15000).toISOString() },
];

test('12 Oct at the till: nothing read while nothing waits, the bar at 14:46, a chime every 5 minutes, one line when it is back', async () => {
  // The drinks screen last beat at 14:43:40 and comes back at 14:57.
  const drinksBeat = (at) => (at >= T('14:57:00') ? at - 20000 : Math.min(at - 20000, T('14:43:40')));
  const t = till({
    tickets: [],
    devicesAt: beatingAt(drinksBeat),
    database: { k1: 'pending', k2: 'pending' },
    since: T('11:46:18'),
  });
  assert.equal(await t.look('14:20:00'), null);
  assert.deepEqual(t.reads, [], 'no order has waited 2 minutes: no read at all');
  t.tickets = [{ id: 'k1', centre_id: 'pc-d', sent_at: iso('14:30:58'), status: 'pending' }];
  assert.equal(await t.look('14:32:00'), null);
  assert.deepEqual(t.reads, [], 'one minute old: still no read');
  await t.look('14:33:00');
  assert.deepEqual(t.reads, ['devices'], 'READ 1 once an order has waited 2 minutes; the screen is beating, so no READ 2');
  assert.deepEqual(t.alerts, {});
  t.tickets = [...t.tickets, { id: 'k2', centreId: 'pc-d', sentAt: T('14:42:13') }];
  await t.look('14:45:00');
  assert.deepEqual(t.alerts, {}, '14:45: 70 seconds behind the newest heartbeat, not silent yet');
  t.reads = [];
  const up = await t.look('14:46:00');
  assert.deepEqual(t.reads, ['devices', 'tickets:2'], 'a chime is due: the two orders are checked against the database first');
  assert.equal(up.sound, true);
  assert.deepEqual(alertWords(t.alerts.d1), {
    title: 'drinks kds is not showing orders',
    body: 'This till has not heard from it for 2 min. 2 orders waiting, the oldest 15 min. Check that screen and its WiFi. Tell the kitchen the orders by hand.',
  });
  // The next four looks: one small read each, no chime.
  t.reads = [];
  for (const at of ['14:47:00', '14:48:00', '14:49:00', '14:50:00']) await t.look(at);
  assert.deepEqual(t.reads, ['devices', 'devices', 'devices', 'devices']);
  assert.equal(t.chimes.length, 1);
  // 14:51: five minutes on. Checked again, chimes again.
  t.reads = [];
  await t.look('14:51:00');
  assert.deepEqual(t.reads, ['devices', 'tickets:2']);
  assert.deepEqual(t.chimes, [T('14:46:00'), T('14:51:00')]);
  assert.match(alertWords(t.alerts.d1).body, /^This till has not heard from it for 7 min\. 2 orders waiting, the oldest 20 min\. /);
  // Staff tap OK: quiet from here on, and no more checks against the database either.
  t.alerts = hideAlert(t.alerts, 'd1');
  t.reads = [];
  await t.look('14:56:00');
  assert.deepEqual(t.reads, ['devices']);
  assert.equal(t.chimes.length, 2);
  assert.equal(t.alerts.d1.acked, true);
  // 14:58: the screen is back and both orders were bumped. One read to prove it, one line, no bar.
  t.tickets = [];
  t.reads = [];
  await t.look('14:58:00');
  assert.deepEqual(t.reads, ['devices']);
  assert.deepEqual(t.alerts, {});
  assert.deepEqual(t.backs, ['drinks kds is back online.']);
  // And then nothing: no read at all.
  t.reads = [];
  assert.equal(await t.look('14:59:00'), null);
  assert.deepEqual(t.reads, []);
  assert.equal(t.chimes.length, 2);
});

test('a look, as shipped: a screen that is beating never raises the bar, however long an order has waited', async () => {
  // Review 12 Oct 2026: "has not bumped anything for 20 min" came up on 25 of 39 normal venue days
  // (a toastie nobody bumped at a quiet station). The rule is off; only a silent screen is an alarm.
  const tickets = [{ id: 'k1', centre_id: 'pc-d', sent_at: iso('14:20:00'), status: 'pending' }];
  const t = till({ tickets, devicesAt: beatingAt(), database: { k1: 'pending' }, since: T('09:00:00') });
  for (let n = 0; n < 30; n += 1) await t.look(T('14:45:00') + n * MIN);
  assert.deepEqual(t.alerts, {});
  assert.equal(t.chimes.length, 0);
  assert.deepEqual(t.reads.filter((r) => r !== 'devices'), [], 'and no check against the database is made for it');
  // Switched on (the owner's call), the same looks do raise it.
  const on = till({ tickets, devicesAt: beatingAt(), database: { k1: 'pending' }, since: T('09:00:00'), stuckRule: true });
  await on.look('14:45:00');
  assert.equal(on.alerts.d1.reason, 'stuck');
});

test('a look at closing time: the tablet is switched off with the last card not bumped and the till stays on', async () => {
  // Review 12 Oct 2026 (Headingley, 9 Oct: card sent 17:26, screen off 17:27, bumped next morning):
  // the till chimed every 5 minutes for 3 hours, 36 times, and OK only hid the bar for 5 minutes.
  const tickets = [{ id: 'k1', centre_id: 'pc-d', sent_at: iso('17:26:29'), status: 'pending' }];
  const off = beatingAt(() => T('17:27:00'));
  const t = till({ tickets, devicesAt: off, database: { k1: 'pending' } });
  for (let at = T('17:28:00'); at <= T('20:30:00'); at += MIN) await t.look(at);
  assert.deepEqual(t.chimes.map((c) => new Date(c).toISOString().slice(11, 16)), ['17:30', '17:35', '17:40'], 'three chimes, then quiet');
  assert.equal(t.reads.filter((r) => r.startsWith('tickets')).length, 3, 'and the database is only asked before a chime');
  // With OK tapped at the first bar: one chime in all.
  const u = till({ tickets, devicesAt: off, database: { k1: 'pending' } });
  for (let at = T('17:28:00'); at <= T('20:30:00'); at += MIN) {
    await u.look(at);
    if (u.alerts.d1 && !u.alerts.d1.acked) u.alerts = hideAlert(u.alerts, 'd1');
  }
  assert.equal(u.chimes.length, 1);
});

test('a look: outside trading hours nothing is read and a bar that is up comes down without a "back" line', async () => {
  const t = till({ tickets: store(), devicesAt: () => devices(), database: { k1: 'pending', k2: 'pending', k4: 'pending' }, trading: false });
  assert.equal(await t.look('14:47:00'), null);
  assert.deepEqual(t.reads, [], 'shut: no read');
  t.trading = true;
  await t.look('14:47:00');
  assert.deepEqual(Object.keys(t.alerts), ['d1']);
  t.trading = false;                                  // closing time
  t.reads = [];
  await t.look('14:48:00');
  assert.deepEqual(t.reads, ['devices'], 'one read as the bar comes down');
  assert.deepEqual(t.alerts, {});
  assert.deepEqual(t.backs, [], 'the screen is still silent: nothing says it is back');
});

test('a look: a read that fails changes nothing', async () => {
  const t = till({ tickets: store(), devicesAt: () => devices(), database: { k1: 'pending', k2: 'pending', k4: 'pending' } });
  t.read1 = 'down';
  assert.equal(await t.look('14:47:00'), null, 'READ 1 could not tell: no alert is raised');
  assert.deepEqual(t.alerts, {});
  t.read1 = 'ok';
  t.read2 = 'down';
  await t.look('14:47:00');
  assert.deepEqual(t.alerts, {}, 'READ 2 could not tell: a new alert is not raised');
  assert.equal(t.chimes.length, 0);
  t.read2 = 'ok';
  await t.look('14:47:00');
  assert.equal(t.chimes.length, 1);
  const was = t.alerts.d1;
  // Five minutes on the check cannot be made: the bar stays exactly as it was, no second chime.
  t.read2 = 'down';
  await t.look(T('14:47:00') + 5 * MIN);
  assert.equal(t.alerts.d1, was);
  assert.equal(t.chimes.length, 1);
  // READ 1 fails while the bar is up and orders wait: nothing changes.
  t.read1 = 'down';
  assert.equal(await t.look(T('14:47:00') + 6 * MIN), null);
  assert.equal(t.alerts.d1, was);
  // The checks work again: the chime that was due sounds now.
  t.read1 = 'ok'; t.read2 = 'ok';
  await t.look(T('14:47:00') + 7 * MIN);
  assert.equal(t.chimes.length, 2);
  // Nothing waits any more and READ 1 fails: the bar still comes down (its words are no longer true), with no line.
  t.tickets = [];
  t.read1 = 'down';
  await t.look(T('14:47:00') + 8 * MIN);
  assert.deepEqual(t.alerts, {});
  assert.deepEqual(t.backs, []);
});

test('a look: OK tapped while the reads are out is not lost', async () => {
  const t = till({ tickets: store(), devicesAt: () => devices(), database: { k1: 'pending', k2: 'pending', k4: 'pending' } });
  await t.look('14:47:00');
  const slow = t.devicesAt;
  t.devicesAt = (at) => { t.alerts = hideAlert(t.alerts, 'd1'); return slow(at); };   // the tap lands during READ 1
  await t.look('14:48:00');
  assert.equal(t.alerts.d1.acked, true);
});

test('a till with a stale list of 60 old orders never calls a healthy screen stuck', async () => {
  // The till's live updates died at 12:00. The kitchen bumped all of these; the till never saw it.
  const stale = [];
  const database = {};
  for (let i = 0; i < 60; i += 1) { stale.push({ id: `s${i}`, centre_id: 'pc-d', sent_at: new Date(T('12:00:00') + i * MIN).toISOString(), status: 'pending' }); database[`s${i}`] = 'bumped'; }
  const t = till({ tickets: stale, devicesAt: beatingAt(), database, stuckRule: true });
  // Ten looks, a minute apart.
  for (let n = 0; n < 10; n += 1) await t.look(T('14:51:00') + n * MIN);
  assert.equal(t.chimes.length, 0);
  assert.deepEqual(t.alerts, {});
  assert.deepEqual(t.reads.filter((r) => r !== 'devices'), ['tickets:20'], 'one check of 20 was enough to know the till is behind');
  assert.equal(t.watch.gone.size, CONFIRM_MAX_IDS);
});

test('a till with a stale list and a screen that really is silent: the bar comes up late but only ever counts confirmed orders', async () => {
  // 45 old orders the kitchen bumped (the till never saw it) and 2 that really are waiting.
  const tickets = [];
  const database = {};
  for (let i = 0; i < 45; i += 1) { tickets.push({ id: `s${i}`, centre_id: 'pc-d', sent_at: new Date(T('12:30:00') + i * MIN).toISOString(), status: 'pending' }); database[`s${i}`] = 'bumped'; }
  tickets.push({ id: 'k1', centre_id: 'pc-d', sent_at: iso('14:30:58'), status: 'pending' }, { id: 'k2', centreId: 'pc-d', sentAt: T('14:42:13') });
  database.k1 = 'pending'; database.k2 = 'pending';
  const t = till({ tickets, devicesAt: beatingAt(() => T('14:43:40')), database });
  await t.look('14:47:00');
  assert.deepEqual(t.alerts, {}, 'the 20 oldest were all bumped: this till is behind, so it says nothing yet');
  await t.look('14:48:00');
  assert.deepEqual(t.alerts, {});
  await t.look('14:49:00');
  assert.equal(t.chimes.length, 1, 'the third check reaches the two real orders');
  assert.equal(t.alerts.d1.count, 2);
  assert.match(alertWords(t.alerts.d1).body, /2 orders waiting, the oldest 18 min\./);
  assert.deepEqual(t.reads.filter((r) => r !== 'devices'), ['tickets:20', 'tickets:20', 'tickets:7']);
  // The list is now known good again: no more checks until the next chime.
  t.reads = [];
  await t.look('14:50:00');
  await t.look('14:51:00');
  assert.deepEqual(t.reads, ['devices', 'tickets:2', 'devices'], 'one check that finds nothing gone ends the extra checks');
  assert.equal(t.alerts.d1.count, 2);
  assert.equal(t.chimes.length, 1);
});

test('a look: a station that only prints does not make the till read every minute', async () => {
  // Tickets for a station with no kitchen screen are never bumped, so they always "wait".
  const printerOnly = [];
  for (let i = 0; i < 30; i += 1) printerOnly.push({ id: `p${i}`, centre_id: 'pc-printer-only', sent_at: new Date(T('13:00:00') + i * MIN).toISOString(), status: 'pending' });
  const t = till({ tickets: printerOnly, devicesAt: beatingAt(), database: {} });
  for (let n = 0; n < 10; n += 1) await t.look(T('14:00:00') + n * MIN);
  assert.deepEqual(t.reads, ['devices'], 'one read told it that station has no kitchen screen');
  assert.deepEqual(t.alerts, {});
  await t.look(T('14:00:00') + 10 * MIN);
  assert.deepEqual(t.reads, ['devices', 'devices'], 'asked again after 10 minutes (a screen may have been paired)');
  // An order for the drinks screen has waited 2 minutes: READ 1 at once, the quiet spell does not cover it.
  t.tickets = [...printerOnly, { id: 'k1', centre_id: 'pc-d', sent_at: new Date(T('14:11:00')).toISOString(), status: 'pending' }];
  await t.look(T('14:00:00') + 12 * MIN);
  assert.equal(t.reads.length, 2, '14:12: the drinks order is one minute old');
  await t.look(T('14:00:00') + 13 * MIN);
  await t.look(T('14:00:00') + 14 * MIN);
  assert.equal(t.reads.length, 4, 'once a minute while an order waits on a kitchen screen');
  // The drinks order is bumped: only the printer tickets wait again, and the till goes quiet again.
  t.tickets = printerOnly;
  await t.look(T('14:00:00') + 15 * MIN);
  await t.look(T('14:00:00') + 16 * MIN);
  assert.equal(t.reads.length, 4);
  // A silent drinks screen is still caught on time beside the printer tickets.
  const mixed = till({ tickets: [...printerOnly, ...store()], devicesAt: () => devices(), database: { k1: 'pending', k2: 'pending', k4: 'pending' } });
  await mixed.look('14:47:00');
  assert.deepEqual(Object.keys(mixed.alerts), ['d1']);
  assert.equal(mixed.alerts.d1.count, 2, 'the printer tickets are not counted against any screen');
  // A venue with no kitchen screen at all: one read, then quiet.
  const none = till({ tickets: store(), devicesAt: () => [{ id: 'p1', type: 'pos', status: 'active', last_seen: iso('14:46:45') }], database: {} });
  for (let n = 0; n < 5; n += 1) await none.look(T('14:47:00') + n * MIN);
  assert.deepEqual(none.reads, ['devices']);
  assert.deepEqual(none.alerts, {});
  // A screen with no station shows every ticket: nothing is "print only" then.
  const pass = till({ tickets: printerOnly, devicesAt: (at) => [{ id: 'all', name: 'Pass', type: 'kds', status: 'active', centre_id: null, last_seen: new Date(at - 5000).toISOString() }, { id: 'p1', type: 'pos', status: 'active', last_seen: new Date(at - 9000).toISOString() }], database: {}, since: T('13:59:00') });
  await pass.look('14:00:00');
  await pass.look('14:01:00');
  assert.deepEqual(pass.reads, ['devices', 'devices']);
});

test('a look: a ticket this till sent that never reached the database is not counted against the screen', async () => {
  const t = till({ tickets: store(), devicesAt: () => devices(), database: {} });   // none of the till's tickets is in the database
  await t.look('14:47:00');
  assert.deepEqual(t.alerts, {});
  assert.equal(t.chimes.length, 0);
  assert.deepEqual([...t.watch.gone].sort(), ['k1', 'k2']);
  assert.equal(t.watch.bumpSeenAt.size, 0, 'and it is no proof of a bump');
});

test('"back" is only said when the screen is proven back', () => {
  const waiting = waitingTickets(store(), { now, dayStartMs });
  const screens = screensFrom(devices());
  const serverNow = serverNowFrom(devices());
  const silent = nextAlerts({}, watchProblems({ screens, waiting, serverNow, bumpSeenAt: new Map(), watchingSince: 0, now }), { now }).alerts;
  // Without proof (the plain rule): every alert that goes says it is back.
  assert.deepEqual(nextAlerts(silent, [], { now: now + MIN }).back.map(backWords), ['drinks kds is back online.']);
  // Heard from again: back.
  const again = devices().map((d) => ({ ...d, last_seen: iso('14:47:50') }));
  const proofBack = { screens: screensFrom(again), serverNow: serverNowFrom(again), bumpSeenAt: new Map() };
  assert.equal(isBack(silent.d1, proofBack), true);
  assert.deepEqual(nextAlerts(silent, [], { now: now + MIN, proof: proofBack }).back, [{ screenId: 'd1', name: 'drinks kds', reason: 'silent' }]);
  // The orders are gone (bumped elsewhere, too old, or the venue shut) but the screen is still silent: the bar goes, no line.
  const proofStill = { screens, serverNow, bumpSeenAt: new Map([['pc-d', now + 30000]]) };
  assert.equal(isBack(silent.d1, proofStill), false);
  const quiet = nextAlerts(silent, [], { now: now + MIN, proof: proofStill });
  assert.deepEqual(quiet.alerts, {});
  assert.deepEqual(quiet.back, []);
  assert.equal(isBack(silent.d1, { screens: [], serverNow, bumpSeenAt: new Map() }), false, 'the screen was removed from the venue');
  assert.equal(isBack(silent.d1, {}), false);
  assert.equal(isBack(null, proofBack), false);
  // Stuck: back when the till saw a ticket of that station leave since the alert came up.
  const stuck = { d1: { screenId: 'd1', name: 'drinks kds', centreId: 'pc-d', reason: 'stuck', since: now, lastSoundAt: now, hiddenUntil: 0 } };
  assert.equal(isBack(stuck.d1, { screens, serverNow, bumpSeenAt: new Map([['pc-d', now + 1]]) }), true);
  assert.equal(isBack(stuck.d1, { screens, serverNow, bumpSeenAt: new Map([['pc-d', now - 1]]) }), false, 'a bump before the alert is not news');
  assert.equal(isBack(stuck.d1, { screens, serverNow, bumpSeenAt: new Map([['pc-f', now + 1]]) }), false, 'another station');
  assert.deepEqual(nextAlerts(stuck, [], { now: now + MIN, proof: { screens, serverNow, bumpSeenAt: new Map([['pc-d', now + 1]]) } }).back.map(backWords), ['drinks kds is bumping orders again.']);
  assert.deepEqual(nextAlerts(stuck, [], { now: now + MIN, proof: { screens, serverNow, bumpSeenAt: new Map() } }).back, []);
  // A screen with no station: a bump at any station.
  assert.equal(isBack({ ...stuck.d1, centreId: null }, { bumpSeenAt: new Map([['pc-f', now + 1]]) }), true);
  // A silent screen that is heard from again but still has old orders nobody bumps becomes "stuck": the bar stays, no line.
  const turned = nextAlerts(silent, [{ ...silent.d1, reason: 'stuck' }], { now: now + MIN, proof: proofBack });
  assert.equal(turned.alerts.d1.reason, 'stuck');
  assert.deepEqual(turned.back, []);
  assert.equal(turned.sound, false, 'the same alert: no new chime');
});

test('trading: no hours set, open, shut, and the 30 minute margin', () => {
  const hours = { weekly: { sun: [], mon: [{ open: '07:00', close: '17:30' }], tue: [], wed: [], thu: [], fri: [], sat: [] }, closedDates: [] };
  const tz = 'Europe/London';
  const at = (hhmm) => Date.parse(`2026-10-12T${hhmm}:00+01:00`);   // Monday 12 Oct 2026, British Summer Time
  assert.equal(isTrading({ openingHours: null, timeZone: tz, now: at('03:00'), isOpenNow }), true, 'no hours set counts as trading');
  assert.equal(isTrading({ openingHours: {}, timeZone: tz, now: at('03:00'), isOpenNow }), true);
  assert.equal(isTrading({ openingHours: hours, timeZone: tz, now: at('03:00') }), true, 'no way to tell counts as trading');
  assert.equal(isTrading({ openingHours: hours, timeZone: tz, now: at('12:00'), isOpenNow }), true);
  assert.equal(isTrading({ openingHours: hours, timeZone: tz, now: at('17:45'), isOpenNow }), true, '15 minutes after close');
  assert.equal(isTrading({ openingHours: hours, timeZone: tz, now: at('18:00'), isOpenNow }), false, 'half an hour after close');
  assert.equal(isTrading({ openingHours: hours, timeZone: tz, now: at('06:45'), isOpenNow }), true, '15 minutes before opening');
  assert.equal(isTrading({ openingHours: hours, timeZone: tz, now: at('06:20'), isOpenNow }), false);
  assert.equal(isTrading({ openingHours: hours, timeZone: tz, now: Date.parse('2026-10-13T12:00:00+01:00'), isOpenNow }), false, 'a closed day');
  assert.equal(isTrading({ openingHours: hours, timeZone: 'Not/AZone', now: at('03:00'), isOpenNow }), true, 'a broken time zone never silences the watch');
  assert.equal(isTrading(), true);
  // Review 12 Oct 2026: Back Office stores a week with NO opening time on any day the first time
  // the Location page is saved for any reason (lib/openingHours.js emptyOpeningHours). It read as
  // shut at every hour, so the till would never have raised an alarm at such a venue.
  const never = { weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] }, closedDates: [] };
  assert.deepEqual(never, emptyOpeningHours());
  assert.equal(isOpenNow(never, tz, new Date(at('12:00'))).open, false, 'the kiosk helper really does call it shut');
  for (const hhmm of ['03:00', '08:00', '12:00', '14:47', '23:30']) assert.equal(isTrading({ openingHours: never, timeZone: tz, now: at(hhmm), isOpenNow }), true, `hours never filled in count as trading (${hhmm})`);
  assert.equal(isTrading({ openingHours: { weekly: {} }, timeZone: tz, now: at('03:00'), isOpenNow }), true);
  assert.equal(isTrading({ openingHours: { weekly: 'nonsense' }, timeZone: tz, now: at('03:00'), isOpenNow }), true);
});

test('the words on the till bar, singular and plural, minutes and hours', () => {
  const silent = { name: 'drinks kds', reason: 'silent', count: 1, oldestWaitMs: 3 * MIN, silentMs: 2 * MIN };
  assert.deepEqual(alertWords(silent), {
    title: 'drinks kds is not showing orders',
    body: 'This till has not heard from it for 2 min. 1 order waiting, the oldest 3 min. Check that screen and its WiFi. Tell the kitchen the orders by hand.',
  });
  assert.match(alertWords({ ...silent, count: 12, oldestWaitMs: 96 * MIN, silentMs: 125 * MIN }).body, /^This till has not heard from it for 2 h 5 min\. 12 orders waiting, the oldest 1 h 36 min\. /);
  assert.match(alertWords({ ...silent, silentMs: 120 * MIN }).body, /^This till has not heard from it for 2 h\. /);
  assert.match(alertWords({ ...silent, silentMs: 26 * 60 * MIN }).body, /^This till has not heard from it today\. /, 'a day or more reads "today"');
  assert.match(alertWords({ ...silent, silentMs: Infinity }).body, /^This till has not heard from it today\. /);
  const stuck = { name: 'food KDS', reason: 'stuck', count: 3, oldestWaitMs: 31 * MIN, noBumpMs: 22 * MIN };
  assert.deepEqual(alertWords(stuck), { title: 'food KDS has not bumped anything for 22 min', body: '3 orders waiting, the oldest 31 min. Check that screen is showing them.' });
  assert.equal(alertWords({ ...stuck, noBumpMs: undefined }).title, 'food KDS has not bumped anything for 31 min');
  assert.equal(backWords({ name: 'drinks kds', reason: 'silent' }), 'drinks kds is back online.');
  assert.equal(backWords({ name: 'drinks kds', reason: 'stuck' }), 'drinks kds is bumping orders again.');
  for (const w of [alertWords(silent), alertWords(stuck)]) assert.doesNotMatch(`${w.title} ${w.body}`, /[\u2013\u2014]|N\/A/);
});

test('status drawer: heard from, orders waiting on it, and the test ticket said honestly', () => {
  const st = (seen, server = '14:46:50') => screenStatus({ lastSeenMs: T(seen), serverNow: T(server) });
  assert.deepEqual(st('14:46:40'), { state: 'online', silentMs: 10000 });
  assert.equal(heardWords(st('14:46:40')), 'Heard from just now');
  assert.equal(heardWords(st('14:45:21')), 'Heard from just now', '89 seconds');
  assert.equal(heardWords(st('14:45:00')), 'Heard from 2 min ago', '110 seconds: still online');
  assert.deepEqual(st('14:44:50'), { state: 'offline', silentMs: 120000 }, 'two minutes behind the newest heartbeat');
  assert.equal(heardWords(st('14:43:40')), 'Not heard from for 3 min', '12 Oct, the drinks screen');
  assert.equal(heardWords(st('14:40:50')), 'Not heard from for 6 min');
  assert.equal(heardWords(st('12:10:50')), 'Not heard from for 2 h 36 min');
  assert.equal(heardWords(screenStatus({ lastSeenMs: T('14:46:50') - 22 * 24 * 60 * MIN, serverNow: T('14:46:50') })), 'Not heard from for 22 days');
  assert.deepEqual(screenStatus({ lastSeenMs: NaN, serverNow: T('14:46:50') }), { state: 'unknown', silentMs: null });
  assert.deepEqual(screenStatus({ lastSeenMs: T('14:46:40'), serverNow: null }), { state: 'unknown', silentMs: null });
  assert.equal(heardWords(screenStatus()), 'Not heard from yet');
  assert.equal(heardWords(), 'Not heard from yet');
  assert.equal(st('14:47:30').silentMs, 0, 'a screen that beat after the newest other device is not negative');

  // Orders waiting on a screen: every pending ticket of today, however new (the watch itself waits 2 minutes).
  const sum = waitingSummary(store(), { centreId: 'pc-d', now, dayStartMs });
  assert.deepEqual(sum, { count: 3, oldestWaitMs: now - T('14:30:58') });
  assert.equal(waitingWords(sum), '3 orders waiting on it, the oldest 16 min');
  assert.equal(waitingWords(waitingSummary(store(), { centreId: 'pc-f', now, dayStartMs })), '1 order waiting on it, the oldest 3 min');
  assert.equal(waitingSummary(store(), { centreId: null, now, dayStartMs }).count, 4, 'a screen with no station shows them all');
  assert.equal(waitingWords(waitingSummary(store(), { centreId: 'pc-none', now, dayStartMs })), null);
  assert.equal(waitingWords(waitingSummary([], { now })), null);
  assert.equal(waitingWords(), null);
  assert.equal(waitingSummary(store(), { centreId: 'pc-d', now, dayStartMs: T('14:35:00') }).count, 2, 'before the business day does not count');

  const name = 'drinks kds';
  assert.equal(testTicketWords({ state: 'sent', name }), 'Test ticket sent. Bump it on drinks kds to prove the screen is working.');
  assert.equal(testTicketWords({ name }), 'Test ticket sent. Bump it on drinks kds to prove the screen is working.');
  assert.equal(testTicketWords({ state: 'silent', name, silentMs: 4 * MIN }), 'Sent, but this till has not heard from drinks kds for 4 min. It may not show.');
  assert.equal(testTicketWords({ state: 'bumped', name }), 'drinks kds bumped the test ticket. It is working.');
  assert.equal(testTicketWords({ state: 'waiting', name }), 'Not bumped yet. If the test ticket is not on drinks kds, that screen is not getting orders: check its WiFi and restart it.');
});
