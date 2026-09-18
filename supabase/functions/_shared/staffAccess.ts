// supabase/functions/_shared/staffAccess.ts
//
// Is this signed in user staff for a location (or a company)? The SAME rule the database uses.
//
// 18 Sep 2026, lockdown step 1: the database rule is user_locations, plus every venue for a
// verified super admin. Migration 20260918d_OPS_profile_venue_lock.sql redefines
// public.user_accessible_locations() as
//
//     select location_id::text from user_locations where user_id = auth.uid()
//     union
//     select id::text from locations where is_super_admin()
//
// Round three had mirrored the OLD rule (user_locations UNION user_profiles.location_id), and
// user_profiles.location_id was writable by the user (and, through a policy that was not row
// scoped, by any login for any row). That made every gift card admin gate spoofable: set a
// profile venue to someone else's venue and you were their staff. The profile venue is now only
// the venue Back Office opens on, never access. The one legacy owner who had a profile venue and
// no user_locations row gets that row from the same migration.
//
// On top of the database rule, the two arms the edge functions have always honoured: super_admin,
// and company level access through the Platform DB's user_company_roles for a location of that
// company.
//
// An anonymous session is NEVER staff, whatever rows it has. signInAnonymously() is free to
// anybody holding the public anon key.
//
// PURE. No imports, so node tests load it directly.

export type StaffFacts = {
  user: { id?: string; is_anonymous?: boolean } | null;
  /** user_profiles.role for the user, or null. */
  role: string | null;
  /** user_locations.location_id rows for the user (Ops location ids). */
  userLocationIds: string[];
  /** Platform user_company_roles.company_id rows for the user. */
  companyRoleCompanyIds: string[];
  /**
   * The location asked about, as its ONE resolved Ops id (staffLocationKeys below). Empty when
   * the question is about a company.
   */
  locationKeys: string[];
  /** The company of that location, or the company asked about. */
  companyId: string | null;
  /** Every Ops location id of the company, for a company level question (no location). */
  companyOpsLocationIds?: string[];
};

export type StaffDecision = {
  ok: boolean;
  via: 'super_admin' | 'user_locations' | 'company_role' | null;
};

/** The set public.user_accessible_locations() returns for this user, as strings. */
export function accessibleLocations(f: Pick<StaffFacts, 'userLocationIds'>): Set<string> {
  const s = new Set<string>();
  for (const id of f.userLocationIds || []) if (id) s.add(String(id));
  return s;
}

export function decideStaffAccess(f: StaffFacts): StaffDecision {
  const no: StaffDecision = { ok: false, via: null };
  if (!f.user || f.user.is_anonymous || !f.user.id) return no;
  if (f.role === 'super_admin') return { ok: true, via: 'super_admin' };

  const ul = accessibleLocations(f);
  const hasCompanyRole = !!f.companyId && (f.companyRoleCompanyIds || []).map(String).includes(String(f.companyId));

  const keys = (f.locationKeys || []).filter(Boolean).map(String);
  if (keys.length) {
    if (keys.some((k) => ul.has(k))) return { ok: true, via: 'user_locations' };
    if (hasCompanyRole) return { ok: true, via: 'company_role' };
    return no;
  }

  if (f.companyId) {
    const companyLocs = (f.companyOpsLocationIds || []).filter(Boolean).map(String);
    if (companyLocs.some((k) => ul.has(k))) return { ok: true, via: 'user_locations' };
    if (hasCompanyRole) return { ok: true, via: 'company_role' };
  }
  return no;
}

export type PlatformLocRow = { id?: string | null; ops_location_id?: string | null; company_id?: string | null };

/**
 * The Ops id to check a staff link against, for a location id that may be an Ops id or a
 * Platform id, given the Platform rows whose id or ops_location_id equals it.
 *
 * WHY (18 Sep 2026, review round four item 5a). For three venues (Birmingham, Provo, San Mateo 1)
 * the Platform id is NOT an Ops id. The old code checked BOTH the raw id sent and the mapped Ops
 * id, so anyone who created an Ops venue whose id equals such a Platform id (Ops locations was
 * world writable) and linked themselves to it became staff of that company. Only the RESOLVED
 * Ops id counts:
 *   * a Platform row maps the id: its ops_location_id (a row whose ops_location_id IS the id wins,
 *     so an Ops id is never re-read as some other venue's Platform id);
 *   * a Platform row has the id but no mapping: nothing (never the raw id);
 *   * no Platform row at all: the id itself (an Ops only venue; its company is unknown, so only
 *     a direct user_locations link on that exact Ops venue can match).
 */
export function staffLocationKeys(locationId: string | null, platformRows: PlatformLocRow[] | null | undefined): {
  keys: string[]; companyId: string | null;
} {
  if (!locationId) return { keys: [], companyId: null };
  const id = String(locationId);
  const rows = (platformRows || []).filter(Boolean);
  const byOps = rows.find((r) => r.ops_location_id != null && String(r.ops_location_id) === id);
  if (byOps) return { keys: [id], companyId: byOps.company_id ? String(byOps.company_id) : null };
  const byId = rows.find((r) => r.id != null && String(r.id) === id);
  if (byId) {
    const ops = byId.ops_location_id ? String(byId.ops_location_id) : null;
    return { keys: ops ? [ops] : [], companyId: byId.company_id ? String(byId.company_id) : null };
  }
  return { keys: [id], companyId: null };
}
