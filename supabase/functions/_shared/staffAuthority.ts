// supabase/functions/_shared/staffAuthority.ts
//
// AUTHORITY, NOT AUTHENTICATION. Anybody can hold a JWT: the public anon key signs anyone in
// anonymously (online ordering and QR checkout do exactly that), and a venue's location id is
// public on its ordering page. So "signed in, and sent a location id" proves nothing
// (reference_edge_fn_any_jwt_authority, 18 Sep 2026). Every staff only action decides WHO the
// caller is for THIS venue, using the same rule Back Office uses:
//
//   staffForLocation   a signed in, NON anonymous user who is super_admin, or has the venue in
//                      user_locations, or holds a company role that grants it for the company
//                      that owns the venue (user_company_roles, Platform). NOT
//                      user_profiles.location_id: any signed in user can write that column on
//                      any row today (review round 3, F), so it proves nothing.
//   deviceAtLocation   the caller's OWN paired device row at this venue (devices.device_uid is
//                      stamped by claim_device() from the JWT, nothing else writes it). A till
//                      runs on an anonymous session, so this is how a till is recognised. Until
//                      migration 20260907b (the devices fence) is applied that arm is forgeable
//                      by a caller who can write devices, which is why a till alone is never
//                      enough for a staff action: it must also give a staff PIN.
//   staffByPin         an ACTIVE staff member of this venue, matched server side by PIN.
//
// The Supabase clients are passed in so this file has no Deno globals and is tested under node.

/**
 * Company roles that really grant running a venue's settings. A user_company_roles row with any
 * other role (a viewer, an accountant, a role added later) is NOT staff for a config action.
 * 'admin' is the column's default and what every owner login has today.
 */
export const GRANTING_COMPANY_ROLES = Object.freeze(['owner', 'admin', 'manager', 'super_admin']);

/** The Platform location ids and company for one Ops location id (ops_location_id first, then id). */
export async function platformLocation(platform: any, opsLocationId: string): Promise<{ ids: string[]; companyId: string | null }> {
  const ids = [String(opsLocationId)];
  if (!platform) return { ids, companyId: null };
  try {
    let { data } = await platform.from('locations').select('id, company_id').eq('ops_location_id', opsLocationId).maybeSingle();
    if (!data) ({ data } = await platform.from('locations').select('id, company_id').eq('id', opsLocationId).maybeSingle());
    if (data?.id && !ids.includes(String(data.id))) ids.push(String(data.id));
    return { ids, companyId: data?.company_id ?? null };
  } catch { return { ids, companyId: null }; }
}

/**
 * Staff of this venue. An anonymous user is never staff. Three arms only (review round 3, F):
 *   * super_admin (user_profiles.role),
 *   * a user_locations row for this venue,
 *   * a company role that really grants it (GRANTING_COMPANY_ROLES) for the venue's company.
 *
 * user_profiles.location_id and user_profiles.org_id are NOT trusted. Claude confirmed on live
 * (18 Sep 2026) that ANY signed in, non anonymous user can UPDATE user_profiles.location_id,
 * org_id and bo_access on ANY row (policy "Allow authenticated access" FOR ALL, column UPDATE
 * granted to authenticated), so "my profile says this venue" proves nothing. Do not add that arm
 * back until that hole is closed (a separate fix).
 */
export async function staffForLocation(sb: any, platform: any, user: any, opsLocationId: string): Promise<boolean> {
  if (!user || !user.id || user.is_anonymous) return false;
  const { data: prof } = await sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  if (prof?.role === 'super_admin') return true;
  const loc = await platformLocation(platform, opsLocationId);
  const { data: ul } = await sb.from('user_locations').select('location_id').eq('user_id', user.id).in('location_id', loc.ids).limit(1);
  if (ul?.length) return true;
  if (platform && loc.companyId) {
    try {
      const { data: ucr } = await platform.from('user_company_roles').select('company_id, role')
        .eq('user_id', user.id).eq('company_id', loc.companyId).limit(5);
      if ((ucr || []).some((r: any) => GRANTING_COMPANY_ROLES.includes(String(r?.role || '').trim().toLowerCase()))) return true;
    } catch { /* no company roles table reachable: not staff by this arm */ }
  }
  return false;
}

/** The caller's own paired device at this venue (a till). */
export async function deviceAtLocation(sb: any, user: any, opsLocationId: string): Promise<boolean> {
  if (!user?.id) return false;
  const { data } = await sb.from('devices').select('id')
    .eq('device_uid', user.id).eq('location_id', opsLocationId).neq('status', 'removed').limit(1);
  return !!data?.length;
}

/** An active staff member of this venue, by PIN, matched server side. Never a client supplied id. */
export async function staffByPin(sb: any, opsLocationId: string, pin: unknown): Promise<{ id: string; name: string | null } | null> {
  const p = String(pin ?? '').trim();
  if (!/^\d{3,8}$/.test(p)) return null;
  const { data: rows } = await sb.from('staff_members').select('id, name, active')
    .eq('location_id', opsLocationId).eq('pin', p).limit(5);
  const op = (rows || []).find((r: any) => r.active !== false) || null;
  return op ? { id: String(op.id), name: op.name ?? null } : null;
}

/**
 * Who may run a STAFF action at this venue: a Back Office user who is staff here, or a till of
 * this venue together with the PIN of an active staff member here. Returns who, for the log.
 */
export async function staffActor(sb: any, platform: any, user: any, opsLocationId: string, pin: unknown): Promise<
  { ok: true; by: string } | { ok: false; status: number; error: string }
> {
  if (!user) return { ok: false, status: 401, error: 'Sign in first.' };
  if (await staffForLocation(sb, platform, user, opsLocationId)) return { ok: true, by: `user:${user.id}` };
  if (await deviceAtLocation(sb, user, opsLocationId)) {
    const op = await staffByPin(sb, opsLocationId, pin);
    if (op) return { ok: true, by: `staff:${op.id}` };
    return { ok: false, status: 403, error: 'A staff PIN for this venue is needed.' };
  }
  return { ok: false, status: 403, error: 'Only staff of this venue can do that.' };
}
