// supabase/functions/_shared/loyalty-authority.ts
//
// Who may spend a loyalty member's points or stamp card reward (loyalty-redeem).
//
// WHY (18 Sep 2026 audit). loyalty-redeem accepted ANY Supabase JWT, and an anonymous one is
// free to anybody holding the public anon key (signInAnonymously). customer_id came straight
// from the request body. So anybody could spend anybody's points.
//
// The legitimate callers, and the authority each one really has:
//   * a till, kiosk or other paired device: an anonymous session whose auth uid is stamped on
//     its own devices row by claim_device (pairing code = proof). Staff at the venue pick the
//     customer, so a device may redeem for any member of ITS OWN company.
//   * a Back Office user acting as a till: a real (non anonymous) user with access to the
//     location (user_locations, or super_admin).
//   * the member themselves online: the loyalty session token loyalty-otp minted after the one
//     time code, and only for THEIR OWN customer id in THAT company.
// Everything else is refused before any balance is read or moved.
//
// PURE. The edge function gathers the facts; this decides.

export type RedeemAuthorityInput = {
  user: { id: string; is_anonymous?: boolean } | null;
  /** A member_token was sent in the body (whether or not it verified). */
  memberTokenSent: boolean;
  /** The verified member session, or null when absent or invalid. */
  memberSession: { customerId: string; companyId: string } | null;
  /** Non anonymous caller with user_locations access to the location, or super_admin. */
  staffHasLocation: boolean;
  /** Company of the caller's own claimed device, or null when the session holds no device. */
  deviceCompanyId: string | null;
  customerId: string;
  companyId: string;
};

export type RedeemAuthority =
  | { ok: true; via: 'member' | 'staff' | 'device' }
  | { ok: false; status: number; error: string };

export function decideRedeemAuthority(i: RedeemAuthorityInput): RedeemAuthority {
  if (!i.user) return { ok: false, status: 401, error: 'Unauthorized' };

  // A member token is an explicit claim to act AS that member. If it is sent it must be good
  // and must be for this very customer in this company; a bad one never falls through to the
  // device or staff arms.
  if (i.memberTokenSent) {
    const s = i.memberSession;
    if (!s) return { ok: false, status: 403, error: 'Your loyalty session has expired. Please sign in again.' };
    if (s.customerId !== i.customerId || s.companyId !== i.companyId) {
      return { ok: false, status: 403, error: 'This loyalty session is not for that customer.' };
    }
    return { ok: true, via: 'member' };
  }

  if (!i.user.is_anonymous && i.staffHasLocation) return { ok: true, via: 'staff' };
  if (i.deviceCompanyId && i.deviceCompanyId === i.companyId) return { ok: true, via: 'device' };

  return { ok: false, status: 403, error: 'Not allowed to redeem rewards for this customer.' };
}
