// The new kiosk design migration: one Ops file the owner runs by hand. It must be safe to
// run twice, refuse the wrong database, and never drop or replace anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const URL_SQL = new URL('../../supabase/migrations/20260915_OPS_kiosk_redesign.sql', import.meta.url);

const withoutComments = (sql) => sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');

test('the migration exists and guards against the wrong database', () => {
  assert.ok(fs.existsSync(URL_SQL));
  const sql = fs.readFileSync(URL_SQL, 'utf8');
  assert.match(sql, /OPS project \(tbetcegmszzotrwdtqhi\) ONLY/);
  assert.match(sql, /to_regclass\('public\.device_profiles'\) is null or to_regclass\('public\.order_queue'\) is null/);
  assert.match(sql, /raise exception/);
});

test('it adds the switch, off by default, idempotently', () => {
  const sql = withoutComments(fs.readFileSync(URL_SQL, 'utf8'));
  assert.match(sql, /add column if not exists kiosk_new_design boolean not null default false/);
  assert.match(sql, /add column if not exists kiosk_sms_enabled boolean default false/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
});

test('it drops and replaces nothing', () => {
  const sql = withoutComments(fs.readFileSync(URL_SQL, 'utf8')).toLowerCase();
  assert.ok(!/drop\s+table/.test(sql));
  assert.ok(!/drop\s+column/.test(sql));
  assert.ok(!/create\s+or\s+replace\s+function/.test(sql));
  assert.ok(!/alter\s+column/.test(sql));
});
