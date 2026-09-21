// supabase/functions/_shared/venueWriter.js
//
// ONE ANSWER TO "MAY THIS LOGIN WRITE AT THIS VENUE?"
//
// Nine edge functions carried their own copy of this check, and every copy said
// the same thing: a user_locations row, or super_admin. That was the database's
// rule too, until venues started being created faster than link rows were.
//
// 21 Sep 2026, live: Coffee Boy Barnsley Train Station refused every save, with
// "no access to this location", because its owner held one link row for a
// different venue. Twenty more venues go in this week. Chasing that one banner
// at a time is not a plan, so the rule itself now grants an OWNER every venue in
// their own organisation, the moment it exists.
//
// This mirrors migration 20260921u_OPS_owner_holds_own_company.sql. The database
// is the authority; these functions must not be stricter than it, or a venue is
// writable through the app and refused through an edge function, which is the
// worst kind of half-working.
//
// WHY role AND org_id CAN BE TRUSTED (both were holes once):
//   * role   cannot be changed by its own login  (20260915c user_profiles_role_guard)
//   * org_id can only be set to an org you already reach (20260919a1 fence guard)
// An anonymous session is never a writer, whatever its profile row says: the
// kiosk, online and QR surfaces all hold a real auth.uid() and a profile row
// stamped 'owner' by the insert default, with no org.

/**
 * The decision, with no database in it, so node tests can drive every branch.
 * @param {{user:any, role:string|null, orgId:string|null, linked:boolean, venueOrgId:string|null}} f
 * @returns {{ok:boolean, via:string|null}}
 */
export function decideVenueWriter(f) {
  const no = { ok: false, via: null };
  if (!f || !f.user || f.user.is_anonymous || !f.user.id) return no;
  if (f.role === 'super_admin') return { ok: true, via: 'super_admin' };
  if (f.linked) return { ok: true, via: 'user_locations' };
  // An owner holds their own company. Both sides must be real: a null org on
  // either side is not a match (that is how anonymous profiles stay out).
  if (f.role === 'owner' && f.orgId && f.venueOrgId && String(f.orgId) === String(f.venueOrgId)) {
    return { ok: true, via: 'owner_org' };
  }
  return no;
}

/**
 * The same decision against the real tables, on a service-role Ops client.
 * Never throws: a failed read is "not a writer".
 * @param {any} ops service-role Ops client
 * @param {any} user the authenticated user (never anonymous)
 * @param {string} opsLocationId
 * @returns {Promise<boolean>}
 */
export async function isVenueWriter(ops, user, opsLocationId) {
  if (!ops || !user || user.is_anonymous || !user.id || !opsLocationId) return false;
  try {
    const [ulRes, profRes, locRes] = await Promise.all([
      ops.from('user_locations').select('location_id')
        .eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle(),
      ops.from('user_profiles').select('role, org_id').eq('id', user.id).maybeSingle(),
      ops.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle(),
    ]);
    return decideVenueWriter({
      user,
      role: profRes?.data?.role ?? null,
      orgId: profRes?.data?.org_id ?? null,
      linked: !!ulRes?.data,
      venueOrgId: locRes?.data?.org_id ?? null,
    }).ok;
  } catch (e) {
    console.warn('[venueWriter] access check failed:', e?.message || e);
    return false;
  }
}
