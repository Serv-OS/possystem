// src/lib/primaryLocation.test.js: holiday and PTO at a person's primary location (5.12.55).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryRecord, personBalance } from '../../supabase/functions/_shared/primaryLocation.js';

const rp = { id: 'rp', location_id: 'LP', primary_venue_id: 'LP', created_at: '2026-10-01' };
const rd = { id: 'rd', location_id: 'LD', primary_venue_id: 'LP', created_at: '2026-11-01' };

test('the primary location every linked record names', () => {
  assert.equal(primaryRecord([rd, rp]).id, 'rp');
  assert.equal(primaryRecord([{ ...rp, primary_venue_id: 'LD' }, { ...rd, primary_venue_id: 'LD' }]).id, 'rd');
});

test('none set or disagreeing: the record they were first added at', () => {
  assert.equal(primaryRecord([{ ...rd, primary_venue_id: null }, { ...rp, primary_venue_id: null }]).id, 'rp');
  assert.equal(primaryRecord([{ ...rp, primary_venue_id: 'LX' }, { ...rd, primary_venue_id: 'LY' }]).id, 'rp', 'a primary that is not one of their sites is ignored');
});

test('leavers never count, no records means none', () => {
  assert.equal(primaryRecord([{ ...rp, status: 'leaver' }, rd]).id, 'rd');
  assert.equal(primaryRecord([]), null);
});

test('one balance from every site: earned at both, taken at the primary', () => {
  // Provo earned 1.5, Daybreak earned 1, 2 taken at Provo.
  assert.equal(personBalance([{ accrued_hours: 1.5 }, { accrued_hours: 1 }, { accrued_hours: -2 }]), 0.5);
  assert.equal(personBalance([]), 0);
});

import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the decision, the staff app and the Sites panel all use the primary location', () => {
  const fn = read('supabase/functions/workforce-compute/index.ts');
  assert.match(fn, /const prim = primaryRecord\(linkedRecs\) \|\| meRec;/);
  assert.match(fn, /if \(status === 'approved' && prim && prim\.id !== req\.staff_id\) \{/);
  assert.match(fn, /location_id: chargeLoc, org_id: org, staff_id: req\.staff_id, kind: 'taken',/);
  assert.match(fn, /const balance = personBalance\(led \?\? \[\]\);/);
  const sp = read('supabase/functions/staff-portal/index.ts');
  assert.match(sp, /location_id: homeRec\.location_id, org_id: staff\.org_id, staff_id: homeRec\.id,/);
  const data = read('src/staff/wfData.js');
  assert.match(data, /else row\.primary_venue_id = locationId;/, 'set once, at creation');
  assert.doesNotMatch(data, /primary_venue_id: locationId, venue_ids/, 'a save never rewrites it');
  assert.match(data, /peopleDoor\('wf_staff_set_primary'/);
  const sql = read('supabase/migrations/20261118a_OPS_wf_staff_primary_location.sql');
  assert.match(sql, /perform public\.wf_people_assert_access\(st\.org_id, v_locs\);/, 'needs access to every site');
  assert.match(sql, /if not \(p_location = any\(v_locs\)\) then/);
  assert.ok([...sql].every((c) => c.charCodeAt(0) < 128));
});
