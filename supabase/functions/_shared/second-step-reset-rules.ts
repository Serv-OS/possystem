// supabase/functions/_shared/second-step-reset-rules.ts
//
// WHO MAY RESET WHOSE SECOND STEP (Peter, 18 Sep 2026; docs/SECOND_STEP.md).
//
// A reset removes every Face ID, fingerprint and authenticator app a login has, so it
// can set up again (lost phone). Whoever can reset you can, with your password, become
// you. So the rules are strict, and the reset function checks the caller is at aal2
// BEFORE it asks this file anything:
//
//   1. Nobody resets themselves this way. A lost phone is reset by someone else.
//   2. A ServOS super admin may reset anyone else, owners and super admins included.
//   3. Nobody else may reset a super admin, or an owner (an 'owner' venue link anywhere),
//      or anyone whose venue role is not manager or staff.
//   4. An owner may reset a login only when EVERY venue that login can reach is a venue
//      the caller owns. A manager who also works at another business's venue is not
//      "your staff" for this purpose: resetting them would weaken that other business.
//   5. Owning a venue means an 'owner' row in user_locations for it. user_profiles.role
//      says 'owner' for almost everyone (the sign up default), so it is not used.
//
// Pure: no imports, no IO. Tested by src/lib/secondStep/secondStepReset.test.js.

export type VenueLink = { venueId: string; role: string | null | undefined };

export type ResetCaller = {
  id: string;
  isSuperAdmin: boolean;
  /** user_locations rows of the caller */
  links: VenueLink[];
};

export type ResetTarget = {
  id: string;
  isSuperAdmin: boolean;
  /** user_locations rows of the target */
  links: VenueLink[];
  /** user_profiles.location_id: user_accessible_locations() lets this venue in too */
  profileVenueId?: string | null;
};

export type ResetDecision = { ok: boolean; code: string; reason: string };

export const STAFF_ROLES = new Set(['manager', 'staff']);

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** Venues the caller owns (an 'owner' user_locations row). */
export function ownedVenues(links: VenueLink[]): Set<string> {
  const out = new Set<string>();
  for (const l of links || []) if (l?.venueId && norm(l.role) === 'owner') out.add(String(l.venueId));
  return out;
}

/** Every venue the target can reach, the same two arms as user_accessible_locations(). */
export function reachableVenues(target: Pick<ResetTarget, 'links' | 'profileVenueId'>): Set<string> {
  const out = new Set<string>();
  for (const l of target.links || []) if (l?.venueId) out.add(String(l.venueId));
  if (target.profileVenueId) out.add(String(target.profileVenueId));
  return out;
}

/** True when the target holds any venue role above manager or staff. */
export function hasOwnerLevelLink(links: VenueLink[]): boolean {
  return (links || []).some((l) => l?.venueId && !STAFF_ROLES.has(norm(l.role)));
}

/**
 * May `caller` reset `target`? `venueId` is the venue the owner is acting from (Back Office
 * location); when given it must be one of the target's venues.
 */
export function resetDecision(caller: ResetCaller, target: ResetTarget, venueId?: string | null): ResetDecision {
  if (!caller?.id || !target?.id) return { ok: false, code: 'bad_request', reason: 'Pick who to reset.' };
  if (caller.id === target.id) {
    return { ok: false, code: 'self', reason: 'You cannot reset your own second step. Ask ServOS support, or your owner.' };
  }
  if (caller.isSuperAdmin) return { ok: true, code: 'ok', reason: 'ServOS super admin' };
  if (target.isSuperAdmin) {
    return { ok: false, code: 'super_admin_only', reason: 'Only ServOS can reset a ServOS admin.' };
  }
  const reach = reachableVenues(target);
  if (reach.size === 0) {
    return { ok: false, code: 'super_admin_only', reason: 'This login has no venue. Only ServOS can reset it.' };
  }
  if (hasOwnerLevelLink(target.links)) {
    return { ok: false, code: 'super_admin_only', reason: "Only ServOS can reset an owner's second step." };
  }
  const owned = ownedVenues(caller.links);
  if (owned.size === 0) {
    return { ok: false, code: 'not_owner', reason: 'Only a venue owner can reset their staff.' };
  }
  for (const v of reach) {
    if (!owned.has(v)) {
      return { ok: false, code: 'not_your_staff', reason: 'They can also reach a venue you do not own. Ask ServOS support.' };
    }
  }
  if (venueId && !reach.has(String(venueId))) {
    return { ok: false, code: 'not_your_staff', reason: 'They do not work at this venue.' };
  }
  return { ok: true, code: 'ok', reason: 'Owner of every venue they can reach' };
}

/** Count verified factors by kind, for lists. Never exposes factor secrets. */
export function factorSummary(factors: Array<{ factor_type?: string; status?: string }> | null | undefined) {
  let app = 0; let face = 0; let other = 0;
  for (const f of factors || []) {
    if (f?.status !== 'verified') continue;
    if (f.factor_type === 'totp') app++;
    else if (f.factor_type === 'webauthn') face++;
    else other++;
  }
  return { authenticator_app: app, face_id: face, other, set_up: app + face + other > 0 };
}
