// createBookingNoAnon.test.js: create_booking is no longer open to the bare public key
// (17 Oct 2026, v5.11.73, migration 20261017b, PR 295 follow up).
//
// Before the grant goes, every caller must be one that keeps it: the two edge functions on the
// service role, and the web app through ONE door (createBookingAtomic) with a session made sure of.
// If someone adds a new caller, this fails and says where.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(js|jsx|ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(rel);
  }
  return out;
}

test('every caller of create_booking keeps its grant: service role functions and the one web app door', () => {
  const callers = [...walk('src'), ...walk('supabase/functions'), ...walk('api')]
    .filter((f) => /rpc\(\s*['"]create_booking['"]/.test(read(f)))
    .sort();
  assert.deepEqual(callers, [
    'src/lib/bookings/bookingsData.js',
    'supabase/functions/booking-host/index.ts',
    'supabase/functions/booking-widget/index.ts',
  ]);
  // The two functions call it on a service role client.
  assert.match(read('supabase/functions/booking-widget/index.ts'), /const db = createClient\(.*SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(read('supabase/functions/booking-widget/index.ts'), /await db\.rpc\('create_booking'/);
  assert.match(read('supabase/functions/booking-host/index.ts'), /const admin = createClient\(SUPABASE_URL, SERVICE_ROLE/);
  assert.match(read('supabase/functions/booking-host/index.ts'), /await admin\.rpc\('create_booking'/);
  // The public booking page never calls the database itself.
  assert.doesNotMatch(read('src/surfaces/online/BookingWidget.jsx'), /\.rpc\(/);
});

test('the web app door makes sure of a session first, and says a refusal in words', () => {
  const src = read('src/lib/bookings/bookingsData.js');
  const door = src.slice(src.indexOf('export async function createBookingAtomic'));
  assert.ok(door.indexOf('await ensureAuthToken()') > 0);
  assert.ok(door.indexOf('await ensureAuthToken()') < door.indexOf("rpc('create_booking'"), 'session before the call');
  assert.match(door, /42501/);
  assert.match(src, /NO_SESSION_WORDS = 'This device is not signed in, so the booking was NOT made\./);
});

test('20261017b takes it from anon (and public) only, by the function id, and its undo gives it back', () => {
  const sql = read('supabase/migrations/20261017b_OPS_create_booking_no_anon.sql');
  assert.match(sql, /p\.proname = 'create_booking'/);
  assert.match(sql, /revoke execute on function %s from public, anon'/);
  assert.match(sql, /grant execute on function %s to authenticated, service_role'/);
  assert.doesNotMatch(sql, /from[^;\n]*authenticated/i, 'never taken from signed in sessions');
  assert.doesNotMatch(sql, /create or replace function/i, 'the function itself is untouched');
  assert.doesNotMatch(sql, /edit_booking\(/, 'edit_booking is not touched');
  assert.match(sql, /anon_can_call 0, public_can_call 0, signed_in_can_call 1, service_role_can_call 1/);
  const undo = read('supabase/migrations/20261017b_OPS_create_booking_no_anon_ROLLBACK.sql');
  assert.match(undo, /grant execute on function %s to anon, authenticated, service_role'/);
});
