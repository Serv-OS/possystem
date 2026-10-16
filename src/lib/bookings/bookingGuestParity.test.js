/**
 * bookingGuestParity.test.js: the guest link and guest message rules exist twice because Deno
 * cannot import from src/: supabase/functions/_shared/bookingGuest.js (booking-widget,
 * booking-reminders) and src/lib/bookings/bookingGuest.js (the web app and these tests). If they
 * drift, the guest page could offer a change the server then refuses, or the Inspector could
 * describe a reminder rule the sweep does not run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as src from './bookingGuest.js';
import * as copy from '../../../supabase/functions/_shared/bookingGuest.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

test('PARITY: the two files are byte-identical', () => {
  const a = readFileSync(here('./bookingGuest.js'), 'utf8');
  const b = readFileSync(here('../../../supabase/functions/_shared/bookingGuest.js'), 'utf8');
  assert.equal(a, b, 'copy src/lib/bookings/bookingGuest.js over supabase/functions/_shared/bookingGuest.js (or back)');
});

test('PARITY: same exports and same answers', () => {
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(src).sort());
  const now = Date.parse('2026-10-16T12:00:00Z');
  const booking = { status: 'confirmed', booking_date: '2026-10-17', start_time: '19:00', created_at: '2026-10-01T00:00:00Z' };
  assert.deepEqual(copy.manageState({ booking, tz: 'Europe/London', now }), src.manageState({ booking, tz: 'Europe/London', now }));
  assert.deepEqual(
    copy.reminderDue({ kind: 'reminder_day', booking, tz: 'Europe/London', now }),
    src.reminderDue({ kind: 'reminder_day', booking, tz: 'Europe/London', now }),
  );
});
