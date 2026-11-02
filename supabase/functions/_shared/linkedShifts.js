// linkedShifts.js: a person's shifts at their OTHER linked sites (wf_staff.person_id, 20261111a), for
// the staff app (5.12.38). Runs in Deno (staff-portal) and under node --test with a fake client.
//
// The staff app at one site shows the person's shifts at every site they work at, and its open shift
// list says when one would overlap or take them over the most hours a week counting every site, the
// same rule the database applies when they claim (_wf_claim_problem, 20261112a).

/**
 * db: a supabase client (service role). staff: the wf_staff row ({ id, org_id, person_id }).
 * Returns [{ id, staffId (THIS record), otherStaffId, locationId, site, date, start, finish,
 *   breakMins, status, roleKey, section, otherSite: true }]: draft and published only (opts.published
 *   true: published only, for the staff app's own list). Never throws: an error reads as none.
 */
export async function linkedShiftsFor(db, staff, fromIso, toIso, { published = false } = {}) {
  try {
    if (!db || !staff?.person_id || !staff?.org_id) return [];
    const { data: recs } = await db.from('wf_staff').select('id, location_id')
      .eq('org_id', staff.org_id).eq('person_id', staff.person_id).neq('id', staff.id).neq('status', 'leaver');
    if (!recs?.length) return [];
    const siteOfRec = Object.fromEntries(recs.map((r) => [r.id, r.location_id]));
    let q = db.from('wf_shifts').select('id, location_id, staff_id, role_key, shift_date, start_time, finish_time, break_mins, status, section')
      .in('staff_id', recs.map((r) => r.id)).in('status', published ? ['published'] : ['draft', 'published']);
    if (fromIso) q = q.gte('shift_date', fromIso);
    if (toIso) q = q.lte('shift_date', toIso);
    const [{ data: rows }, { data: locs }] = await Promise.all([
      q.order('shift_date').limit(500),
      db.from('locations').select('id, name').in('id', [...new Set(recs.map((r) => r.location_id))]),
    ]);
    const nameOf = Object.fromEntries((locs || []).map((l) => [l.id, l.name]));
    const hm = (t) => String(t || '').slice(0, 5);
    return (rows || []).map((s) => ({
      id: s.id, staffId: staff.id, otherStaffId: s.staff_id, locationId: s.location_id || siteOfRec[s.staff_id],
      site: nameOf[s.location_id || siteOfRec[s.staff_id]] || 'another site',
      date: s.shift_date, start: hm(s.start_time), finish: hm(s.finish_time), breakMins: s.break_mins || 0,
      status: s.status, roleKey: s.role_key || null, section: s.section || null, otherSite: true,
    }));
  } catch {
    return [];
  }
}
