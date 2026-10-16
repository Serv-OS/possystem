import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBookingsCatchUp } from './bookingsCatchUp.js';

// Hand driven timers: run(ms) advances the clock and fires what is due.
function fakeTimers() {
  let t = 0, seq = 0;
  const jobs = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, { fn, at: t + ms, every: 0 }); return id; },
    clearTimeout: (id) => jobs.delete(id),
    setInterval: (fn, ms) => { const id = ++seq; jobs.set(id, { fn, at: t + ms, every: ms }); return id; },
    clearInterval: (id) => jobs.delete(id),
    run(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, j] of jobs) if (j.at <= end && (!next || j.at < next[1].at)) next = [id, j];
        if (!next) break;
        const [id, j] = next;
        t = j.at;
        if (j.every) j.at += j.every; else jobs.delete(id);
        j.fn();
      }
      t = end;
    },
  };
}

function fakeStore(state) {
  const calls = { refresh: [], setDate: [] };
  const s = {
    bookingsDate: '2026-10-16',
    locationConfig: { timezone: 'Europe/London' },
    refreshBookingsDay: (r) => calls.refresh.push(r),
    setBookingsDate: (d) => { calls.setDate.push(d); s.bookingsDate = d; },
    ...state,
  };
  return { store: { getState: () => s }, calls, s };
}

test('wake, network back and the safety timer each reload the viewed day', () => {
  const timers = fakeTimers();
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const { store, calls } = fakeStore();
  const stop = startBookingsCatchUp({ store, win, doc, timers, everyMs: 60000, dayCheckMs: 0 });

  doc.dispatchEvent(new Event('visibilitychange'));
  timers.run(500);
  assert.deepEqual(calls.refresh, ['visible']);

  win.dispatchEvent(new Event('online'));
  timers.run(500);
  assert.deepEqual(calls.refresh, ['visible', 'online']);

  timers.run(60000);
  assert.equal(calls.refresh.at(-1), 'timer');
  stop();
  const before = calls.refresh.length;
  timers.run(180000);
  win.dispatchEvent(new Event('online'));
  timers.run(1000);
  assert.equal(calls.refresh.length, before);
});

test('a wake that fires visible and online together costs one read', () => {
  const timers = fakeTimers();
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const { store, calls } = fakeStore();
  startBookingsCatchUp({ store, win, doc, timers, everyMs: 0, dayCheckMs: 0 });
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('online'));
  timers.run(1000);
  assert.deepEqual(calls.refresh, ['online']);
});

test('a hidden tab skips the timer read', () => {
  const timers = fakeTimers();
  const doc = new EventTarget();
  doc.visibilityState = 'hidden';
  const { store, calls } = fakeStore();
  startBookingsCatchUp({ store, win: null, doc, timers, everyMs: 60000, dayCheckMs: 0 });
  timers.run(130000);
  assert.deepEqual(calls.refresh, []);
});

test('midnight on the venue clock moves a diary on today to the new day', () => {
  const timers = fakeTimers();
  let now = new Date('2026-10-16T22:59:00Z'); // 23:59 in London
  const { store, calls } = fakeStore({ bookingsDate: '2026-10-16' });
  startBookingsCatchUp({ store, win: null, doc: null, timers, everyMs: 0, dayCheckMs: 30000, at: () => now });
  timers.run(30000);
  assert.deepEqual(calls.setDate, []);
  now = new Date('2026-10-16T23:01:00Z'); // 00:01 on 17 Oct in London
  timers.run(30000);
  assert.deepEqual(calls.setDate, ['2026-10-17']);
});

test('a diary deliberately on another date stays there at midnight', () => {
  const timers = fakeTimers();
  let now = new Date('2026-10-16T22:59:00Z');
  const { store, calls } = fakeStore({ bookingsDate: '2026-10-24' });
  startBookingsCatchUp({ store, win: null, doc: null, timers, everyMs: 0, dayCheckMs: 30000, at: () => now });
  now = new Date('2026-10-16T23:01:00Z');
  timers.run(60000);
  assert.deepEqual(calls.setDate, []);
});

test('the venue clock decides midnight, not the device: California 16:01 is London midnight', () => {
  const timers = fakeTimers();
  let now = new Date('2026-10-16T22:59:00Z'); // 15:59 Pacific
  const { store, calls } = fakeStore({ bookingsDate: '2026-10-16', locationConfig: { timezone: 'Europe/London' } });
  startBookingsCatchUp({ store, win: null, doc: null, timers, everyMs: 0, dayCheckMs: 30000, at: () => now });
  now = new Date('2026-10-16T23:01:00Z'); // 16:01 Pacific
  timers.run(30000);
  assert.deepEqual(calls.setDate, ['2026-10-17']);
});
