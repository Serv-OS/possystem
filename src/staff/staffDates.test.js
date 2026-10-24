// src/staff/staffDates.test.js: the staff app's dates and times the venue's way (v5.11.101).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayText, timeText } from './staffDates.js';

test('UK venue: 24 hour times as before; US venue: 12 hour', () => {
  assert.equal(timeText('17:00'), '17:00');
  assert.equal(timeText('17:00', 'en-GB'), '17:00');
  assert.equal(timeText('17:00', 'en-US'), '5:00 PM');
  assert.equal(timeText('00:30', 'en-US'), '12:30 AM');
  assert.equal(timeText('12:00', 'en-US'), '12:00 PM');
  assert.equal(timeText('', 'en-US'), '');
  assert.equal(dayText(''), '');
  assert.match(dayText('2026-10-28', 'en-GB'), /28 Oct/);
  assert.match(dayText('2026-10-28', 'en-US'), /Oct 28/);
});
