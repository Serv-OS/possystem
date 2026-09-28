/**
 * clockSheet.test.js: which open timesheet a workforce-clock punch acts on
 * (supabase/functions/_shared/clockSheet.js, v5.10.3). Run: `npm test`.
 *
 * 28 Sep 2026: the Manager app's Clock out is a tap on ONE timesheet. manager-approve checked that
 * sheet was open, then asked workforce-clock to clock the PERSON out, and workforce-clock closes
 * the person's newest open sheet. Back Office can save a sheet with no clock out, so a person can
 * have two open: the manager tapped A, B was closed, and the audit row named A. manager-approve
 * now names the sheet; workforce-clock honours the name only from the service role, only for
 * 'out', and only for an open sheet of this person at this venue. The Time Clock, the till and
 * the staff app send no name and keep the newest open sheet, read for read as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { namedSheetId, openSheetFor } from '../../supabase/functions/_shared/clockSheet.js';
import { fakeWfDb } from './fixtures/fakeWfDb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (fn) => fs.readFileSync(path.join(here, `../../supabase/functions/${fn}/index.ts`), 'utf8');

const LEEDS = 'loc-leeds';
const HUDD = 'loc-hudd';
const SAM = 'staff-sam';
const JO = 'staff-jo';
const sheet = (id, over) => ({ id, location_id: LEEDS, org_id: 'org-cb', staff_id: SAM, clock_out: null, break_taken: 0, effective_rate: 12.21, ...over });
// Sam has TWO open sheets at Leeds: A from Back Office (saved with no clock out), B from the Time Clock.
const rows = () => ({
  wf_timesheets: [
    sheet('ts-a', { clock_in: '2026-09-26T08:00:00.000Z' }),
    sheet('ts-b', { clock_in: '2026-09-27T09:00:00.000Z' }),
    sheet('ts-closed', { clock_in: '2026-09-25T08:00:00.000Z', clock_out: '2026-09-25T16:00:00.000Z' }),
    sheet('ts-jo', { staff_id: JO, clock_in: '2026-09-27T07:00:00.000Z' }),
    sheet('ts-hudd', { location_id: HUDD, clock_in: '2026-09-27T10:00:00.000Z' }),
  ],
});

test('no name (Time Clock, till, staff app): the newest open sheet, with the same request as before', async () => {
  const db = fakeWfDb(rows());
  const r = await openSheetFor(db, { locationId: LEEDS, staffId: SAM, sheetId: null, action: 'out' });
  assert.equal(r.open.id, 'ts-b');
  assert.equal(r.refusal, undefined);
  // The read workforce-clock made before v5.10.3, call for call.
  assert.deepEqual(db.log, [[
    ['from', 'wf_timesheets'], ['select', '*'], ['eq', 'location_id', LEEDS], ['eq', 'staff_id', SAM],
    ['is', 'clock_out', null], ['order', 'clock_in', { ascending: false }], ['limit', 1],
  ]]);
  // Nothing open: null, and 'out' answers "not clocked in" as it always has.
  const none = await openSheetFor(fakeWfDb({ wf_timesheets: [] }), { locationId: LEEDS, staffId: SAM, action: 'out' });
  assert.deepEqual(none, { open: null });
  // A failed read is still "nothing open" on this path, as before (unchanged on purpose).
  const failed = fakeWfDb(rows()); failed.fail.wf_timesheets = 'timeout';
  assert.deepEqual(await openSheetFor(failed, { locationId: LEEDS, staffId: SAM, action: 'status' }), { open: null });
});

test('the manager taps A: A is the sheet, not the newer B', async () => {
  const db = fakeWfDb(rows());
  const r = await openSheetFor(db, { locationId: LEEDS, staffId: SAM, sheetId: 'ts-a', action: 'out' });
  assert.equal(r.open.id, 'ts-a');
  assert.equal(r.open.clock_in, '2026-09-26T08:00:00.000Z');
  // And B when B is tapped.
  assert.equal((await openSheetFor(db, { locationId: LEEDS, staffId: SAM, sheetId: 'ts-b', action: 'out' })).open.id, 'ts-b');
});

test('a named sheet is refused, never swapped for the newest, when it is not an open sheet of this person here', async () => {
  const db = fakeWfDb(rows());
  const ask = (sheetId, over = {}) => openSheetFor(db, { locationId: LEEDS, staffId: SAM, sheetId, action: 'out', ...over });
  assert.deepEqual(await ask('ts-closed'), { refusal: { status: 409, error: 'already clocked out' } });
  assert.deepEqual(await ask('ts-jo'), { refusal: { status: 404, error: 'timesheet not found for this person at this location' } });
  assert.deepEqual(await ask('ts-hudd'), { refusal: { status: 404, error: 'timesheet not found for this person at this location' } });
  assert.deepEqual(await ask('ts-missing'), { refusal: { status: 404, error: 'timesheet not found for this person at this location' } });
  // Only a clock out names a sheet.
  for (const action of ['in', 'status', 'break_start', 'break_end']) {
    assert.deepEqual(await ask('ts-a', { action }), { refusal: { status: 400, error: 'timesheet_id is only for out' } }, action);
  }
  // A read that fails is a refusal, not "nothing open".
  db.fail.wf_timesheets = 'timeout';
  assert.deepEqual(await ask('ts-a'), { refusal: { status: 500, error: 'could not read the timesheet: timeout' } });
});

test('only a service role caller may name a sheet', () => {
  assert.equal(namedSheetId({ timesheet_id: 'ts-a' }, true), 'ts-a');
  assert.equal(namedSheetId({ timesheet_id: 'ts-a' }, false), null, 'a device or a signed in user');
  assert.equal(namedSheetId({}, true), null);
  assert.equal(namedSheetId({ timesheet_id: '' }, true), null);
  assert.equal(namedSheetId(null, true), null);
});

test('workforce-clock uses the rule; manager-approve names the tapped sheet and reads it back', () => {
  const wc = read('workforce-clock');
  assert.match(wc, /import \{ namedSheetId, openSheetFor \} from '\.\.\/_shared\/clockSheet\.js';/);
  assert.match(wc, /const sheetIdIn = namedSheetId\(body, isService\);/);
  assert.match(wc, /openSheetFor\(admin, \{ locationId: location_id, staffId: staff\.id, sheetId: sheetIdIn, action \}\)/);
  assert.equal((wc.match(/from\('wf_timesheets'\)\s*\n?\s*\.select\('\*'\)/g) || []).length, 0, 'workforce-clock keeps its own open sheet read');
  // Every write in 'out' is to the sheet it chose (open.id).
  const out = wc.slice(wc.indexOf("if (action === 'out')"));
  assert.match(out, /\.update\(update\)\.eq\('id', open\.id\)/);

  const ma = read('manager-approve');
  const clockOut = ma.slice(ma.indexOf("if (action === 'timesheet.clock_out')"), ma.indexOf("if (action === 'timesheet.approve')"));
  assert.match(clockOut, /body: JSON\.stringify\(\{ location_id: loc, staff_id: ts\.staff_id, timesheet_id: ts\.id, action: 'out' \}\)/);
  assert.match(clockOut, /\.select\('clock_out, break_taken, actual_hours'\)\.eq\('id', ts\.id\)\.eq\('location_id', loc\)/);
  assert.match(clockOut, /if \(!backErr && !closed\?\.clock_out\) return json\(/);
  assert.match(clockOut, /audit\(loc, ts\.org_id, op, 'timesheet\.manager_clock_out', 'wf_timesheets', ts\.id,/);
});
