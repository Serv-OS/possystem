// src/lib/aiClock.test.js
//
// 5.12.60 (US basics batch 8, the tail): the AI tools' "today" and hour buckets and the Back Office
// greeting run on the VENUE's clock. Pure: lib/aiClock.js only, plus a source guard on the two files
// that now call it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { venueDayStart, venueHour, hourLabel, dayPart } from './aiClock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('venue midnight: Denver and London on one instant', () => {
  const at = new Date('2026-11-04T18:00:00Z');   // 11:00 MST in Denver, 18:00 GMT in London
  assert.equal(venueDayStart('America/Denver', at).toISOString(), '2026-11-04T07:00:00.000Z');
  assert.equal(venueDayStart('Europe/London', at).toISOString(), '2026-11-04T00:00:00.000Z');
  // a day that still has summer time: Denver MDT (UTC-6), London BST (UTC+1)
  const summer = new Date('2026-07-10T12:00:00Z');
  assert.equal(venueDayStart('America/Denver', summer).toISOString(), '2026-07-10T06:00:00.000Z');
  assert.equal(venueDayStart('Europe/London', summer).toISOString(), '2026-07-09T23:00:00.000Z');
  // the clock change day itself: London goes back on 25 Oct 2026; midnight is still 23:00Z the night before
  assert.equal(venueDayStart('Europe/London', new Date('2026-10-25T12:00:00Z')).toISOString(), '2026-10-24T23:00:00.000Z');
  // the input is not touched
  const keep = new Date('2026-11-04T18:00:00Z');
  venueDayStart('America/Denver', keep);
  assert.equal(keep.toISOString(), '2026-11-04T18:00:00.000Z');
});

test('venue hour across the day roll over', () => {
  const late = '2026-11-04T06:30:00Z';   // 23:30 the night before in Denver, 06:30 in London
  assert.equal(venueHour(late, 'America/Denver'), 23);
  assert.equal(venueHour(late, 'Europe/London'), 6);
  assert.equal(venueDayStart('America/Denver', late).toISOString(), '2026-11-03T07:00:00.000Z');
  assert.equal(venueDayStart('Europe/London', late).toISOString(), '2026-11-04T00:00:00.000Z');
  // 07:00Z is Denver's first hour of 4 Nov
  assert.equal(venueHour('2026-11-04T07:00:00Z', 'America/Denver'), 0);
  assert.equal(venueHour(new Date('2026-11-04T06:59:00Z'), 'America/Denver'), 23);
});

test('no zone: the laptop clock, exactly as before', () => {
  const now = new Date('2026-11-04T18:00:00Z');
  const before = new Date(now); before.setHours(0, 0, 0, 0);
  assert.equal(venueDayStart(null, now).getTime(), before.getTime());
  assert.equal(venueDayStart(undefined, now).getTime(), before.getTime());
  assert.equal(venueDayStart('', now).getTime(), before.getTime());
  for (const ts of ['2026-11-04T06:30:00Z', new Date('2026-07-10T12:00:00Z'), Date.parse('2026-01-01T23:59:00Z')]) {
    assert.equal(venueHour(ts, null), new Date(ts).getHours());
  }
});

test('hour labels: 12 hour at a US venue, 24 hour at a UK one', () => {
  assert.equal(hourLabel(14, 'USD'), '2:00 PM');
  assert.equal(hourLabel(0, 'USD'), '12:00 AM');
  assert.equal(hourLabel(12, 'USD'), '12:00 PM');
  assert.equal(hourLabel(9, 'USD'), '9:00 AM');
  assert.equal(hourLabel(14, 'GBP'), '14:00');
  assert.equal(hourLabel(0, 'GBP'), '00:00');
  assert.equal(hourLabel(9, 'GBP'), '09:00');
  assert.equal(hourLabel(9), '09:00');                 // the default is the UK word, as before
  assert.equal(hourLabel(14, 'EUR'), '14:00');          // Ireland reads as the UK did
  // every UK label is the exact string the tools built before: padStart(2, '0') + ':00'
  for (let h = 0; h < 24; h++) assert.equal(hourLabel(h, 'GBP'), `${String(h).padStart(2, '0')}:00`);
});

test('day part: the greeting rule as before', () => {
  assert.equal(dayPart(0), 'morning');
  assert.equal(dayPart(11), 'morning');
  assert.equal(dayPart(12), 'afternoon');
  assert.equal(dayPart(16), 'afternoon');
  assert.equal(dayPart(17), 'evening');
  assert.equal(dayPart(23), 'evening');
});

test('guard: aiTools and the Back Office greeting no longer read the laptop clock', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'src/lib/aiTools.js'), 'utf8');
  assert.doesNotMatch(tools, /setHours\(0, 0, 0, 0\)/, 'aiTools.js still has a laptop start of day');
  assert.doesNotMatch(tools, /\.getHours\(\)/, 'aiTools.js still reads a laptop hour');
  assert.match(tools, /from '\.\/aiClock\.js'/);
  assert.match(tools, /venueDayStart\(zoneOr\(\)\)/);
  assert.match(tools, /venueHour\(ts, zoneOr\(\)\)/);
  const bo = fs.readFileSync(path.join(ROOT, 'src/backoffice/BackOfficeApp.jsx'), 'utf8');
  assert.doesNotMatch(bo, /new Date\(\)\.getHours\(\)/, 'BackOfficeApp.jsx greeting still reads the laptop hour');
  assert.match(bo, /dayPart\(venueHour\(new Date\(\), zoneOr\(\)\)\)/);
});

// en and em dash by code point, so this file carries neither
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('guard: no long dashes on the lines this change wrote', () => {
  const MINE = /aiClock|venueDayStart|venueHour|hourLabel|hourText|hourOf|dayStart\(\)|dayPart|batch 8 tail|5\.12\.60/;
  for (const rel of ['src/lib/aiTools.js', 'src/backoffice/BackOfficeApp.jsx', 'src/lib/aiClock.js', 'src/lib/aiClock.test.js']) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    const own = rel.endsWith('aiClock.js') || rel.endsWith('aiClock.test.js') ? lines : lines.filter((l) => MINE.test(l));
    assert.ok(own.length > 0, `${rel}: no lines from this change found`);
    for (const l of own) assert.doesNotMatch(l, LONG_DASH, `${rel}: ${l.trim()}`);
  }
});
