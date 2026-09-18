// supabase/functions/_shared/profileAdmin.ts
//
// Who may change a login's venue (user_profiles.location_id), company (org_id) or Back Office
// access (bo_access), and who may read a team member's email. The decisions behind the
// profile-admin edge function.
//
// WHY (18 Sep 2026, lockdown step 1). Those three columns were written straight from the browser
// and the table's policy was not row scoped, so any login could point ANY profile at ANY venue
// and, through user_accessible_locations(), become staff there. Migration
// 20260918d_OPS_profile_venue_lock.sql takes the columns away from the browser (and makes
// user_locations the only access). The legitimate writers now come here:
//   * set_active_location   Back Office location switcher: the venue Back Office opens on. Only a
//                           venue the login is linked to (user_locations), or any for a super admin.
//                           It is a DEFAULT, never access.
//   * claim_org             Company Admin "create organisation": a login with no company takes a
//                           brand new, unclaimed one (nobody else belongs to it).
//   * adopt_location        Company Admin "create location": the creator is linked to the venue
//                           they just made, when it is unclaimed and in their company (the same
//                           rule as the database's can_claim_location()).
//   * set_bo_access         Staff screen switch: an owner or manager of a venue turns Back Office
//                           access on or off for a login linked to THAT venue (a user_locations
//                           row; a staff_members.auth_user_id is never proof, any venue login can
//                           write it). Never a super admin account, never their own.
//   * team_profiles         Staff screen: email and access flag of the logins linked (user_locations)
//                           to the venue. Staff of the venue, or a super admin, only.
//   * admin_set_location    Admin portal (super admin): set or clear a login's opening venue.
//
// PURE. No imports, so node tests load it directly.

export type Caller = { id?: string; is_anonymous?: boolean } | null;
export type Decision = { ok: true } | { ok: false; status: number; error: string };

const RANK: Record<string, number> = { viewer: 0, staff: 0, manager: 1, owner: 2 };
const no = (status: number, error: string): Decision => ({ ok: false, status, error });
const yes: Decision = { ok: true };

/** Only a real, signed in login ever gets here. An anonymous session is refused outright. */
export function decideSignedIn(caller: Caller): Decision {
  if (!caller || !caller.id) return no(401, 'Sign in to Back Office first');
  if (caller.is_anonymous) return no(403, 'Sign in to Back Office first');
  return yes;
}

export function decideSetActiveLocation(i: {
  caller: Caller; isSuperAdmin: boolean; locationId: string | null; linkedLocationIds: string[]; locationExists: boolean;
}): Decision {
  const s = decideSignedIn(i.caller); if (!s.ok) return s;
  if (!i.locationId || !i.locationExists) return no(400, 'Unknown location');
  if (i.isSuperAdmin) return yes;
  if ((i.linkedLocationIds || []).map(String).includes(String(i.locationId))) return yes;
  return no(403, 'You do not have access to that location');
}

export function decideClaimOrg(i: {
  caller: Caller; isSuperAdmin: boolean; profileOrgId: string | null; orgExists: boolean; orgHasOtherMembers: boolean;
}): Decision {
  const s = decideSignedIn(i.caller); if (!s.ok) return s;
  if (!i.orgExists) return no(400, 'Unknown organisation');
  if (i.profileOrgId) return no(409, 'Your account already belongs to a company');
  if (i.isSuperAdmin) return yes;
  if (i.orgHasOtherMembers) return no(403, 'That organisation already has members; ask its owner to add you');
  return yes;
}

export function decideAdoptLocation(i: {
  caller: Caller; isSuperAdmin: boolean; profileOrgId: string | null;
  locationOrgId: string | null; locationExists: boolean;
  locationHasOtherUsers: boolean; orgHasOtherMembers: boolean; alreadyLinked: boolean;
}): Decision {
  const s = decideSignedIn(i.caller); if (!s.ok) return s;
  if (!i.locationExists || !i.locationOrgId) return no(400, 'Unknown location');
  if (i.alreadyLinked) return yes;
  if (i.isSuperAdmin) return yes;
  if (i.locationHasOtherUsers) return no(403, 'That location already has users; ask its owner to add you');
  if (i.profileOrgId && String(i.profileOrgId) !== String(i.locationOrgId)) return no(403, 'That location belongs to another company');
  if (!i.profileOrgId && i.orgHasOtherMembers) return no(403, 'That company already has members; ask its owner to add you');
  return yes;
}

export function decideSetBoAccess(i: {
  caller: Caller; isSuperAdmin: boolean; callerRoleAtLocation: string | null;
  targetId: string | null; targetLinkedToLocation: boolean; targetRole: string | null;
}): Decision {
  const s = decideSignedIn(i.caller); if (!s.ok) return s;
  if (!i.targetId) return no(400, 'user_id required');
  if (String(i.targetId) === String(i.caller!.id)) return no(403, 'You cannot change your own Back Office access');
  if (i.targetRole === 'super_admin') return no(403, 'That login belongs to a platform administrator');
  if (i.isSuperAdmin) return yes;
  if ((RANK[String(i.callerRoleAtLocation || '').toLowerCase()] ?? 0) < 1) {
    return no(403, 'Only an owner or manager of this venue can change Back Office access');
  }
  if (!i.targetLinkedToLocation) return no(403, 'That login is not part of this venue');
  return yes;
}

export function decideTeamRead(i: { caller: Caller; isSuperAdmin: boolean; callerLinked: boolean }): Decision {
  const s = decideSignedIn(i.caller); if (!s.ok) return s;
  if (i.isSuperAdmin || i.callerLinked) return yes;
  return no(403, 'You do not have access to that location');
}

export function decideAdminSetLocation(i: {
  caller: Caller; isSuperAdmin: boolean; targetExists: boolean; locationId: string | null; targetLinkedToLocation: boolean;
}): Decision {
  const s = decideSignedIn(i.caller); if (!s.ok) return s;
  if (!i.isSuperAdmin) return no(403, 'Platform administrators only');
  if (!i.targetExists) return no(404, 'Unknown user');
  // A login's opening venue is always one it is linked to (or none), so it can never read as access.
  if (i.locationId && !i.targetLinkedToLocation) return no(400, 'Link the user to that location first');
  return yes;
}

/**
 * Which of the asked for logins the Staff screen may see: ONLY those with a user_locations row at
 * the venue (review round four, 5b). Never a login that is merely named on a staff_members row.
 */
export function teamProfileIds(wanted: string[], linkedUserIds: string[]): string[] {
  const linked = new Set((linkedUserIds || []).filter(Boolean).map(String));
  return [...new Set((wanted || []).filter(Boolean).map(String))].filter((id) => linked.has(id));
}
