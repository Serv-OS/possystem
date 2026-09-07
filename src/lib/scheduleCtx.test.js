import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleCtx } from './scheduleCtx.js';

// Every surface's menu decision now routes through buildScheduleCtx, so both
// branches (Intl in the venue timezone, and the device-clock fallback when Intl
// rejects the timezone string) are pinned here.

test('buildScheduleCtx: evaluates the given instant in the venue timezone', () => {
  const at = new Date('2026-09-07T17:00:00Z');   // Monday, 18:00 BST in London, 10:00 in Los Angeles
  const london = buildScheduleCtx('Europe/London', at);
  assert.equal(london.nowMinutes, 18 * 60);
  assert.equal(london.isoDay, 1);
  assert.equal(london.ymd, '2026-09-07');
  const la = buildScheduleCtx('America/Los_Angeles', at);
  assert.equal(la.nowMinutes, 10 * 60);
  assert.equal(la.isoDay, 1);
  // a venue whose day has already rolled over
  const tokyo = buildScheduleCtx('Asia/Tokyo', at);
  assert.equal(tokyo.nowMinutes, 2 * 60);
  assert.equal(tokyo.isoDay, 2);
  assert.equal(tokyo.ymd, '2026-09-08');
});

test('buildScheduleCtx: empty timezone defaults to Europe/London', () => {
  const at = new Date('2026-09-07T17:00:00Z');
  assert.deepEqual(buildScheduleCtx('', at), buildScheduleCtx('Europe/London', at));
  assert.deepEqual(buildScheduleCtx(undefined, at), buildScheduleCtx('Europe/London', at));
  assert.deepEqual(buildScheduleCtx(null, at), buildScheduleCtx('Europe/London', at));
});

test('buildScheduleCtx: bad timezone falls back to the device clock at the given instant', () => {
  const at = new Date('2026-09-07T12:34:00Z');
  const ctx = buildScheduleCtx('Not/AZone', at);
  assert.equal(ctx.nowMinutes, at.getHours() * 60 + at.getMinutes());
  assert.equal(ctx.isoDay, ((at.getDay() + 6) % 7) + 1);
  assert.equal(ctx.ymd, at.toISOString().slice(0, 10));
});

test('buildScheduleCtx: no instant, or an invalid one, reads the real clock without throwing', () => {
  for (const now of [undefined, null, 'yesterday', 12, new Date('not a date')]) {
    const ctx = buildScheduleCtx('Europe/London', now);
    assert.ok(ctx.nowMinutes >= 0 && ctx.nowMinutes < 1440, String(now));
    assert.ok(ctx.isoDay >= 1 && ctx.isoDay <= 7, String(now));
    assert.match(ctx.ymd, /^\d{4}-\d{2}-\d{2}$/);
  }
});
