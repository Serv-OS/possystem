// supabase/functions/_shared/staffAccess.ts
//
// Is this signed in user staff for a location (or a company)? The SAME rule the database uses.
//
// WHY (18 Sep 2026, round three). Round two's callerIsStaffFor accepted only a user_locations row
// or super_admin. The database's own access rule, public.user_accessible_locations() (live
// definition in 000_baseline_ops.sql, first written in 20260429_tenant_rls.sql:38), is
//
//     select location_id from user_locations where user_id = auth.uid()
//     union
//     select location_id from user_profiles  where id = auth.uid() and location_id is not null
//
// and Back Office lets a legacy single site owner in on user_profiles.location_id alone
// (src/lib/db.js fetchAccessibleLocations). Such an owner would have been locked out of Back
// Office gift cards and loyalty the moment the gift fences deployed. This mirrors the database
// rule exactly (a parity test reads the SQL), plus the two arms the edge functions have always
// honoured on top of it: super_admin, and company level access through the Platform DB's
// user_company_roles for a location of that company.
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
  /** user_profiles.location_id for the user (Ops location id), or null. */
  profileLocationId: string | null;
  /** Platform user_company_roles.company_id rows for the user. */
  companyRoleCompanyIds: string[];
  /**
   * The location asked about, as every Ops id it may be (the id sent, and the Ops id a Platform
   * location id maps to). Empty when the question is about a company.
   */
  locationKeys: string[];
  /** The company of that location, or the company asked about. */
  companyId: string | null;
  /** Every Ops location id of the company, for a company level question (no location). */
  companyOpsLocationIds?: string[];
};

export type StaffDecision = {
  ok: boolean;
  via: 'super_admin' | 'user_locations' | 'user_profiles' | 'company_role' | null;
};

/** The set public.user_accessible_locations() returns for this user, as strings. */
export function accessibleLocations(f: Pick<StaffFacts, 'userLocationIds' | 'profileLocationId'>): Set<string> {
  const s = new Set<string>();
  for (const id of f.userLocationIds || []) if (id) s.add(String(id));
  if (f.profileLocationId) s.add(String(f.profileLocationId));
  return s;
}

export function decideStaffAccess(f: StaffFacts): StaffDecision {
  const no: StaffDecision = { ok: false, via: null };
  if (!f.user || f.user.is_anonymous || !f.user.id) return no;
  if (f.role === 'super_admin') return { ok: true, via: 'super_admin' };

  const ul = new Set((f.userLocationIds || []).filter(Boolean).map(String));
  const prof = f.profileLocationId ? String(f.profileLocationId) : null;
  const hasCompanyRole = !!f.companyId && (f.companyRoleCompanyIds || []).map(String).includes(String(f.companyId));

  const keys = (f.locationKeys || []).filter(Boolean).map(String);
  if (keys.length) {
    if (keys.some((k) => ul.has(k))) return { ok: true, via: 'user_locations' };
    if (prof && keys.includes(prof)) return { ok: true, via: 'user_profiles' };
    if (hasCompanyRole) return { ok: true, via: 'company_role' };
    return no;
  }

  if (f.companyId) {
    const companyLocs = (f.companyOpsLocationIds || []).filter(Boolean).map(String);
    if (companyLocs.some((k) => ul.has(k))) return { ok: true, via: 'user_locations' };
    if (prof && companyLocs.includes(prof)) return { ok: true, via: 'user_profiles' };
    if (hasCompanyRole) return { ok: true, via: 'company_role' };
  }
  return no;
}
