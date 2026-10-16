// cronKey.test.js: who may start the booking-reminders sweep (17 Oct 2026, v5.11.72).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepAccess, isMissingCheck, bearerOf, isServiceRoleBearer, CRON_KEY_HEADER, CRON_KEY_CHECK } from '../../../supabase/functions/_shared/cronKey.js';

test('the service role always passes, and is matched exactly', () => {
  assert.deepEqual(sweepAccess({ service: true }), { ok: true, by: 'service_role', reason: null });
  assert.equal(isServiceRoleBearer('Bearer svc', 'svc'), true);
  assert.equal(isServiceRoleBearer('bearer   svc ', 'svc'), true);
  assert.equal(isServiceRoleBearer('Bearer svc2', 'svc'), false);
  assert.equal(isServiceRoleBearer('Bearer ', ''), false, 'an unset key never matches an empty bearer');
  assert.equal(isServiceRoleBearer(null, 'svc'), false);
  assert.equal(bearerOf('Basic abc'), '');
});

test('before the migration (no check function) the sweep stays open', () => {
  for (const error of [{ code: 'PGRST202', message: 'x' }, { code: '42883', message: 'x' }, { message: 'Could not find the function public.booking_reminders_cron_ok(p_key) in the schema cache' }]) {
    assert.equal(isMissingCheck(error), true);
    assert.deepEqual(sweepAccess({ key: '', check: { data: null, error } }), { ok: true, by: 'before_migration', reason: null });
  }
});

test('after it: the right key passes; none, wrong, or a failed check refuses', () => {
  assert.deepEqual(sweepAccess({ key: 'k', check: { data: true, error: null } }), { ok: true, by: 'cron_key', reason: null });
  assert.equal(sweepAccess({ key: '', check: { data: false, error: null } }).reason, 'no_cron_key');
  assert.equal(sweepAccess({ key: 'nope', check: { data: false, error: null } }).reason, 'wrong_cron_key');
  assert.equal(sweepAccess({ key: 'nope', check: { data: null, error: null } }).reason, 'wrong_cron_key');
  assert.equal(sweepAccess({ key: 'k', check: { data: null, error: { code: '57014', message: 'statement timeout' } } }).reason, 'cron_key_check_failed');
  assert.equal(sweepAccess({ key: 'k', check: null }).ok, false, 'never asked: refused');
  assert.equal(sweepAccess().ok, false);
});

test('the names the migration and the function share', () => {
  assert.equal(CRON_KEY_HEADER, 'x-cron-key');
  assert.equal(CRON_KEY_CHECK, 'booking_reminders_cron_ok');
});

test('20261017a: the key is made inside the database, checked by the service role only, and sent by the job', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../../supabase/migrations/20261017a_OPS_booking_reminders_cron_key.sql', import.meta.url), 'utf8');
  // Live signatures (read 17 Oct 2026), or the guard would refuse on the real database.
  assert.match(sql, /to_regprocedure\('vault\.create_secret\(text,text,text,uuid\)'\)/);
  assert.match(sql, /to_regprocedure\('net\.http_post\(text,jsonb,jsonb,jsonb,integer\)'\)/);
  assert.match(sql, /to_regprocedure\('cron\.schedule\(text,text,text\)'\)/);
  // Made from random uuids, once; nobody types a key.
  assert.match(sql, /if not exists \(select 1 from vault\.secrets where name = 'booking_reminders_cron_key'\)/);
  assert.match(sql, /replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\)/);
  // The names the function uses.
  assert.match(sql, new RegExp(`create or replace function public\\.${CRON_KEY_CHECK}\\(p_key text\\)`));
  assert.match(sql, new RegExp(`'${CRON_KEY_HEADER}', k`));
  assert.match(sql, /revoke all on function public\.booking_reminders_cron_ok\(text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.booking_reminders_cron_ok\(text\) to service_role;/);
  assert.match(sql, /revoke all on function public\.booking_reminders_send_due\(\) from public, anon, authenticated, service_role;/);
  assert.match(sql, /cron\.schedule\('booking-reminders-nudge', '\*\/5 \* \* \* \*', 'select public\.booking_reminders_send_due\(\);'\)/);
  assert.match(sql, /timeout_milliseconds := 25000/);
  assert.doesNotMatch(sql, /[\u2013\u2014]/, 'no long dashes');
});
