// Multi site menu: when a scheduled set runs (supabase/functions/_shared/msmSchedule.js). London and
// a US zone, both clock change weekends, the lead, the order and the overlap words. The database
// gives the same answers (supabase/tests/multi_site_menu/run.mjs compares them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, dueAt, startsWords, scheduleButtonWords, siteDueTimes, overlaps, isPast, clockText, scheduleNote } from '../../../supabase/functions/_shared/msmSchedule.js';

const iso = (ms) => new Date(ms).toISOString().slice(0, 16);

test('a wall clock time on the site\'s own clock: London in summer and in winter', () => {
  assert.equal(iso(localToUtc('2026-07-20T06:00', 'Europe/London')), '2026-07-20T05:00');
  assert.equal(iso(localToUtc('2026-12-01T06:00', 'Europe/London')), '2026-12-01T06:00');
  assert.equal(iso(localToUtc('2026-12-01T06:00', 'America/New_York')), '2026-12-01T11:00');
  assert.equal(localToUtc('not a time', 'Europe/London'), null);
});

test('the clock change weekends: 06:00 the morning after is right in both zones', () => {
  assert.equal(iso(localToUtc('2026-10-25T06:00', 'Europe/London')), '2026-10-25T06:00', 'clocks went back at 02:00');
  assert.equal(iso(localToUtc('2026-03-29T06:00', 'Europe/London')), '2026-03-29T05:00', 'clocks went forward at 01:00');
  assert.equal(iso(localToUtc('2026-11-01T06:00', 'America/Los_Angeles')), '2026-11-01T14:00');
  assert.equal(iso(localToUtc('2026-03-08T06:00', 'America/Los_Angeles')), '2026-03-08T13:00');
});

test('a time in the gap or twice over is read as Postgres reads it', () => {
  assert.equal(iso(localToUtc('2026-03-29T01:30', 'Europe/London')), '2026-03-29T01:30', 'in the gap: the offset from before it');
  assert.equal(iso(localToUtc('2026-10-25T01:30', 'Europe/London')), '2026-10-25T01:30', 'twice over: the second (winter time)');
  assert.equal(iso(localToUtc('2026-11-01T01:30', 'America/Los_Angeles')), '2026-11-01T09:30');
});

test('on the POS by X: the run starts the lead before it', () => {
  assert.equal(iso(dueAt('2026-10-20T06:00', 'Europe/London', 5)), '2026-10-20T04:55');
  assert.equal(iso(dueAt('2026-10-20T06:00', 'Europe/London', 0)), '2026-10-20T05:00');
  assert.equal(startsWords('2026-10-20T06:00', 'Europe/London', 5), 'Starts 05:55 so it is on every till by 06:00');
  assert.equal(startsWords('2026-10-20T06:00', 'Europe/London', 0), 'Starts at 06:00');
  assert.equal(scheduleButtonWords('2026-10-20T06:00', 'Europe/London', 5), 'Schedule for Tue 20 Oct 06:00 (starts 05:55)');
  assert.equal(clockText(Date.UTC(2026, 9, 20, 4, 55), 'Europe/London'), '05:55');
});

test('a mixed company gets one due time per site', () => {
  const d = siteDueTimes('2026-12-01T06:00', [{ location_id: 'uk', timezone: 'Europe/London' }, { location_id: 'us', timezone: 'America/Denver' }], 5);
  assert.equal(iso(d[0].due_at), '2026-12-01T05:55');
  assert.equal(iso(d[1].due_at), '2026-12-01T12:55');
});

test('a time already passed cannot be scheduled', () => {
  assert.equal(isPast('2020-01-01T06:00', 'Europe/London'), true);
  assert.equal(isPast('2099-01-01T06:00', 'Europe/London'), false);
});

test('scheduled sets run in time order, and an overlap says which one wins', () => {
  const sets = [
    { id: 'xmas', title: 'Christmas', due_at: Date.UTC(2026, 11, 1, 5, 55), changes: [{ target: 'product_site', entity_id: 'latte', location_id: 'siteb', after: { price: 3.5 } }] },
    { id: 'rise', title: 'Price rise', due_at: Date.UTC(2026, 9, 19, 4, 55), changes: [{ target: 'product_site', entity_id: 'latte', location_id: 'siteb', after: { price: 3.1 } }, { target: 'product', entity_id: 'tea', after: { name: 'Tea' } }] },
    { id: 'quiet', title: 'Quiet', due_at: Date.UTC(2026, 9, 25, 5, 55), changes: [{ target: 'product', entity_id: 'cola', after: { name: 'Cola' } }] },
  ];
  const o = overlaps(sets, { latte: 'Latte', siteb: 'Site B' });
  assert.deepEqual(o.order, ['rise', 'quiet', 'xmas']);
  assert.equal(o.overlaps.length, 1);
  assert.equal(o.overlaps[0].words, 'Price rise (Mon 19 Oct 05:55) also changes Latte at Site B. Christmas (Tue 1 Dec 05:55) runs later and wins.');
});

test('the words under the time box: empty, past, lead already past, normal', () => {
  const tz = 'Europe/London';
  const at = localToUtc('2026-10-20T11:00', tz);
  assert.deepEqual(scheduleNote('', tz, 5, at - 3600000), { ok: false, past: false, words: 'Pick a date and time.' });
  assert.equal(scheduleNote('2026-10-20T11:00', tz, 5, at + 1).past, true);
  const close = scheduleNote('2026-10-20T11:00', tz, 5, at - 2 * 60000);
  assert.equal(close.ok, true);
  assert.equal(close.words, 'Starts straight away so it is on every till by 11:00', 'never a start time already gone');
  assert.equal(scheduleNote('2026-10-20T11:00', tz, 5, at - 3600000).words, 'Starts 10:55 so it is on every till by 11:00');
});
