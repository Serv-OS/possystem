// menuBoardUptime.test.js: a TV reloads itself once a night, never by day, never two at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nightlyReloadDue, reloadMinuteOffset, localHourMinute, MIN_UP_MS, WINDOW_START_HOUR, WINDOW_HOURS, CHECK_MS } from './menuBoardUptime.js';

const DAY = 24 * 60 * 60 * 1000;

test('never by day, never when the page is young', () => {
  assert.equal(nightlyReloadDue({ upMs: 3 * DAY, hour: 12, minute: 0, seed: 'a' }), false);
  assert.equal(nightlyReloadDue({ upMs: 3 * DAY, hour: 23, minute: 59, seed: 'a' }), false);
  assert.equal(nightlyReloadDue({ upMs: MIN_UP_MS - 1, hour: 4, minute: 30, seed: 'a' }), false);
  assert.equal(nightlyReloadDue({ upMs: 3 * DAY, hour: 6, minute: 0, seed: 'a' }), false, 'window closed at 06:00');
  assert.equal(nightlyReloadDue({}), false);
  assert.equal(nightlyReloadDue({ upMs: 3 * DAY, hour: 'x', minute: 0 }), false);
});

test('inside the window a long running page reloads from its own minute on, so the first check after it fires', () => {
  const seed = 'f0a8b2c1-1111-2222-3333-444455556666';
  const off = reloadMinuteOffset(seed);
  assert.ok(off >= 0 && off < WINDOW_HOURS * 60);
  const slot = WINDOW_START_HOUR * 60 + off;
  const at = (mins) => nightlyReloadDue({ upMs: 3 * DAY, hour: Math.floor(mins / 60), minute: mins % 60, seed });
  assert.equal(at(slot - 1), false, 'the minute before');
  assert.equal(at(slot), true, 'its minute');
  assert.equal(at(WINDOW_START_HOUR * 60 + WINDOW_HOURS * 60 - 1), true, 'still due at the end of the window if it missed its minute');
  assert.equal(at(WINDOW_START_HOUR * 60 + WINDOW_HOURS * 60), false);
});

test('twenty five screens spread over the window; the same id always gets the same minute', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `screen-${i}-${(i * 7919) % 1000}`);
  const minutes = new Set(ids.map(reloadMinuteOffset));
  assert.ok(minutes.size >= 20, `spread: ${minutes.size} distinct minutes for 25 screens`);
  assert.equal(reloadMinuteOffset(ids[3]), reloadMinuteOffset(ids[3]));
  assert.equal(reloadMinuteOffset(undefined), 0);
});

test('the venue clock decides, not the stick clock: 03:30 in Leeds is 19:30 in California', () => {
  const t = new Date('2026-11-08T03:30:00Z');   // GMT in November
  assert.deepEqual(localHourMinute(t, 'Europe/London'), { hour: 3, minute: 30 });
  assert.deepEqual(localHourMinute(t, 'America/Los_Angeles'), { hour: 19, minute: 30 });
  const bad = localHourMinute(t, 'Not/AZone');
  assert.ok(Number.isInteger(bad.hour) && Number.isInteger(bad.minute), 'a bad zone falls back to the device clock');
  assert.equal(CHECK_MS, 60_000);
});

test('the TV page asks every minute, reloads on the venue clock, and keeps the pairing (no storage cleared)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../surfaces/MenuBoardSurface.jsx', import.meta.url)), 'utf8');
  assert.match(src, /nightlyReloadDue\(\{ upMs: Date\.now\(\) - PAGE_UP_SINCE, \.\.\.localHourMinute\(new Date\(\), dataRef\.current\?\.tz\), seed: screen\?\.id \}\)/);
  assert.match(src, /setInterval\(checkNightly, CHECK_MS\)/);
  assert.match(src, /reloadPage\(\);/, 'the reload goes through the one helper, so the pairing pin (no window.location.reload in the surface) holds');
  assert.equal((src.match(/window\.location\.reload/g) || []).length, 0);
  const nightly = src.slice(src.indexOf('const checkNightly'), src.indexOf('const checkNightly') + 600);
  assert.doesNotMatch(nightly, /localStorage\.(clear|removeItem)/);
});
