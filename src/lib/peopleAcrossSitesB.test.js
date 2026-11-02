// src/lib/peopleAcrossSitesB.test.js
//
// 5.12.38: one person, many sites, part two. The staff app and open shifts see every linked site
// (_shared/linkedShifts.js), and every labour report adds the US overtime premium the database keeps
// on each timesheet (20261112a). The database itself is proven by supabase/tests/wf_people_across_sites_2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { linkedShiftsFor } from '../../supabase/functions/_shared/linkedShifts.js';
import { claimProblem } from '../../supabase/functions/_shared/openShiftRules.js';
import { timesheetCost, timesheetDays } from '../../supabase/functions/_shared/tradingSales.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// A fake supabase client: from(table) answers with the rows given, filtered by eq / neq / in.
function fakeDb(tables) {
  return {
    from(table) {
      let rows = [...(tables[table] || [])];
      const q = {
        select() { return q; },
        eq(c, v) { rows = rows.filter((r) => r[c] === v); return q; },
        neq(c, v) { rows = rows.filter((r) => r[c] !== v); return q; },
        in(c, vs) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
        gte(c, v) { rows = rows.filter((r) => r[c] >= v); return q; },
        lte(c, v) { rows = rows.filter((r) => r[c] <= v); return q; },
        order() { return q; },
        limit() { return q; },
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

const db = fakeDb({
  wf_staff: [
    { id: 'j-provo', org_id: 'o', person_id: 'p', location_id: 'provo', status: 'active' },
    { id: 'j-day', org_id: 'o', person_id: 'p', location_id: 'daybreak', status: 'active' },
    { id: 'j-old', org_id: 'o', person_id: 'p', location_id: 'milk', status: 'leaver' },
  ],
  wf_shifts: [
    { id: 's1', location_id: 'daybreak', staff_id: 'j-day', shift_date: '2026-11-03', start_time: '12:00:00', finish_time: '18:00:00', break_mins: 30, status: 'published', role_key: 'floor', section: null },
    { id: 's2', location_id: 'daybreak', staff_id: 'j-day', shift_date: '2026-11-04', start_time: '09:00:00', finish_time: '13:00:00', break_mins: 0, status: 'draft', role_key: 'floor', section: null },
    { id: 's3', location_id: 'milk', staff_id: 'j-old', shift_date: '2026-11-03', start_time: '09:00:00', finish_time: '13:00:00', break_mins: 0, status: 'published', role_key: 'floor', section: null },
  ],
  locations: [{ id: 'daybreak', name: 'Daybreak' }, { id: 'milk', name: 'Milk Block' }],
});
const me = { id: 'j-provo', org_id: 'o', person_id: 'p', location_id: 'provo' };

test('linkedShiftsFor: their shifts at their other live sites, as their own record here', async () => {
  const all = await linkedShiftsFor(db, me, '2026-11-01', '2026-11-30');
  assert.deepEqual(all.map((s) => [s.id, s.staffId, s.site, s.start, s.finish]), [['s1', 'j-provo', 'Daybreak', '12:00', '18:00'], ['s2', 'j-provo', 'Daybreak', '09:00', '13:00']]);
  const published = await linkedShiftsFor(db, me, '2026-11-01', '2026-11-30', { published: true });
  assert.deepEqual(published.map((s) => s.id), ['s1']);
  assert.deepEqual(await linkedShiftsFor(db, { ...me, person_id: null }, '2026-11-01', '2026-11-30'), []);
  assert.deepEqual(await linkedShiftsFor(null, me), []);
  // A broken read is no shifts, never a crash in the staff app.
  assert.deepEqual(await linkedShiftsFor({ from() { throw new Error('down'); } }, me), []);
});

test('the open shift list says where the overlap is', async () => {
  const theirShifts = await linkedShiftsFor(db, me, '2026-11-01', '2026-11-30');
  const shift = { id: 'open', status: 'published', date: '2026-11-03', start: '14:00', finish: '20:00', staffId: null, locationId: 'provo', roleKey: 'floor' };
  const p = claimProblem({ shift, claimer: { id: 'j-provo', status: 'active', locationId: 'provo', roleKey: 'floor' }, theirShifts, todayIso: '2026-11-02', nowMin: 600, country: 'US' });
  assert.equal(p.code, 'overlap');
  assert.match(p.text, / at Daybreak\.$/);
});

test('timesheetCost: pay plus the US overtime premium, to the cent; 0 premium reads as before', () => {
  assert.equal(timesheetCost({ pay_amount: 153, overtime_premium: 40.28 }), 193.28);
  assert.equal(timesheetCost({ pay_amount: '0.1', overtime_premium: '0.2' }), 0.3);
  assert.equal(timesheetCost({ pay_amount: 120 }), 120);
  const days = timesheetDays({ dayOf: () => '2026-10-31', timesheets: [
    { id: 'a', status: 'approved', clock_in: '2026-10-31T15:00:00Z', pay_amount: 153, overtime_premium: 40.28 },
    { id: 'b', status: 'pending', clock_in: '2026-10-31T15:00:00Z', pay_amount: 99, overtime_premium: 9 },
  ] });
  assert.deepEqual(days, { '2026-10-31': 193.28 });
});

test('every labour report reads the premium', () => {
  const owner = read('../../supabase/functions/_shared/ownerSnapshot.js');
  assert.equal((owner.match(/pay_amount, overtime_premium/g) || []).length, 2);
  assert.match(owner, /pay = timesheetCost\(t\);/);
  assert.match(owner, /lab\.cost \+= timesheetCost\(t\);/);
  assert.doesNotMatch(owner, /Number\(t\.pay_amount\)/);
  assert.match(read('../../supabase/functions/trading-report/index.ts'), /select\('id, clock_in, clock_out, pay_amount, overtime_premium, status'\)/);
  const mgr = read('../../supabase/functions/manager-snapshot/index.ts');
  assert.match(mgr, /pay_amount, overtime_premium, status, effective_rate/);
  assert.match(mgr, /labour \+= timesheetCost\(t\);/);
  assert.match(read('./stock/alignTwin.js'), /toMinor\(t\.pay_amount\) \+ toMinor\(t\.overtime_premium\)/);
  assert.match(read('../backoffice/sections/workforce/WfRota.jsx'), /m\[iso\] \+= pay \+ \(Number\(t\.overtimePremium\) \|\| 0\);/);
  const sql = read('../../supabase/migrations/20261112a_OPS_wf_people_across_sites_2.sql');
  assert.match(sql, /sum\(coalesce\(t\.pay_amount, 0\) \+ coalesce\(t\.overtime_premium, 0\)\)/);   // Stock and GP
});

test('the staff app lists every site and the open shift checks count them', () => {
  const portal = read('../../supabase/functions/staff-portal/index.ts');
  assert.match(portal, /linkedShiftsFor\(admin, staff, today, horizon, \{ published: true \}\)/);
  const app = read('../surfaces/StaffSurface.jsx');
  assert.match(app, /\{s\.otherSite && <div[^>]*>At \{s\.site\}<\/div>\}/);
  assert.match(app, /\{s\.id && !s\.otherSite && snap\?\.swaps/);   // no swap button on another site's shift
  const open = read('../../supabase/functions/staff-portal/openShifts.ts');
  assert.match(open, /const theirShifts = \[\.\.\.\(myShifts \?\? \[\]\)\.map\(mapShift\), \.\.\.\(await linkedShiftsFor\(admin, staff,/);
  assert.match(open, /const away = await linkedShiftsFor\(admin, rawOf\[p\.id\], mon, sun\);/);
  const sql = read('../../supabase/migrations/20261112a_OPS_wf_people_across_sites_2.sql');
  assert.equal((sql.match(/o\.staff_id = any \(v_mine\)/g) || []).length, 2);   // overlap and most hours a week
});
