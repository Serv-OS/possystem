// supabase/functions/_shared/clockSheet.js: which open timesheet a workforce-clock punch acts on
// (v5.10.3). Plain JS so node tests drive the real rule (clockSheet.test.js).
//
// The Time Clock, the till and the staff app act on the person's NEWEST open sheet, as they always
// have: that read is unchanged, request for request. A person can have two open sheets (Back
// Office can save one with no clock out), so the Manager app's Clock out, which is a tap on ONE
// sheet, closed the newest instead of the tapped one and audited the wrong id. manager-approve now
// names the sheet (timesheet_id). Only a service role caller may name one, only for 'out', and the
// sheet must be this person's, at this venue, and still open; anything else is refused, never
// swapped for the newest.

/** The sheet id a punch names: a service role caller only (never honoured from a device). */
export function namedSheetId(body, isService) {
  if (!isService) return null;
  const id = body?.timesheet_id;
  return id == null || id === '' ? null : String(id);
}

/**
 * The open sheet for this punch. Returns { open } (null when there is none), or { refusal:
 * { status, error } } when a named sheet cannot be used.
 */
export async function openSheetFor(client, { locationId, staffId, sheetId = null, action }) {
  if (!sheetId) {
    // Current open timesheet (no clock_out), latest first.
    const { data: openRows } = await client.from('wf_timesheets')
      .select('*').eq('location_id', locationId).eq('staff_id', staffId).is('clock_out', null)
      .order('clock_in', { ascending: false }).limit(1);
    return { open: openRows?.[0] ?? null };
  }
  if (action !== 'out') return { refusal: { status: 400, error: 'timesheet_id is only for out' } };
  const { data: sheet, error } = await client.from('wf_timesheets')
    .select('*').eq('id', sheetId).eq('location_id', locationId).eq('staff_id', staffId).maybeSingle();
  if (error) return { refusal: { status: 500, error: `could not read the timesheet: ${error.message || error}` } };
  if (!sheet) return { refusal: { status: 404, error: 'timesheet not found for this person at this location' } };
  if (sheet.clock_out) return { refusal: { status: 409, error: 'already clocked out' } };
  return { open: sheet };
}
