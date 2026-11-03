// src/lib/timezones.test.js: one venue time zone list, and the Ops venue row follows the Platform (5.12.48).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMMON_TIMEZONES, TIMEZONES } from './timezones.js';

const root = new URL('../../', import.meta.url).pathname;

test('every US zone a venue can be in is offered, Mountain first among them', () => {
  const common = COMMON_TIMEZONES.map(([v]) => v);
  for (const z of ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']) {
    assert.ok(common.includes(z), `${z} is in the Common group`);
    assert.ok(TIMEZONES.some((t) => t.value === z), `${z} is offered`);
  }
  assert.ok(TIMEZONES.length > COMMON_TIMEZONES.length, 'the full list is there too');
});

test('no screen writes its own time zone list: every picker uses the shared one', () => {
  const files = [];
  const walk = (p) => {
    const abs = join(root, p);
    if (statSync(abs).isDirectory()) { for (const f of readdirSync(abs)) walk(join(p, f)); return; }
    if (/\.jsx$/.test(p)) files.push(p);
  };
  walk('src');
  const own = files.filter((f) => /<option value="(Europe|America|Asia|Australia|Pacific)\//.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(own, [], 'hand written time zone options');
  for (const f of ['src/admin/CompanyAdminApp.jsx', 'src/backoffice/sections/CompanyAdmin.jsx', 'src/backoffice/sections/MultiLocation.jsx']) {
    assert.match(readFileSync(join(root, f), 'utf8'), /<TimezoneOptions value=/, `${f} uses TimezoneOptions`);
  }
  assert.match(readFileSync(join(root, 'src/backoffice/sections/LocationSettings.jsx'), 'utf8'), /from '\.\.\/\.\.\/lib\/timezones'/);
});

test('the venue clock sync puts the Ops venue row right (20261116a)', () => {
  const sql = readFileSync(join(root, 'supabase/migrations/20261116a_OPS_venue_timezone_one_source.sql'), 'utf8');
  assert.match(sql, /if coalesce\(btrim\(v_ops_tz\), ''\) <> v_tz then\s+update locations set timezone = v_tz where id = v_loc;/);
  assert.match(sql, /update public\.locations l\s+set timezone = c\.timezone\s+from public\.venue_clock c/);
  assert.ok([...sql].every((ch) => ch.charCodeAt(0) < 128), 'ASCII only, safe to paste');
  // location-admin sends every saved time zone through the sync.
  const fn = readFileSync(join(root, 'supabase/functions/location-admin/index.ts'), 'utf8');
  assert.match(fn, /if \('timezone' in row \|\| 'business_day_start' in row\) await syncVenueClock\(loc, ops\);/);
});
