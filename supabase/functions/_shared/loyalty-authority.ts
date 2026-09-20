// supabase/functions/_shared/loyalty-authority.ts
//
// Who may move a loyalty member's points or stamps (loyalty-earn, loyalty-redeem, loyalty-refund)
// and who may read a member's full detail by phone (loyalty-member-lookup, loyalty-balance).
//
// WHY (18 Sep 2026 audit; database fence stage 1, 19 Sep 2026). These functions accepted ANY
// Supabase JWT, and an anonymous one is free to anybody holding the public anon key
// (signInAnonymously). customer_id, subtotal and closed_check_id came straight from the request
// body. So anybody could mint points for themselves, spend or reverse anybody's, or read a
// member's name, email and allergens by phone. Since stage 1 it matters twice over: the server
// counts a loyalty discount on an online order only when a redeem row keyed to that order's check
// exists (place_public_order, 20260919a), so a stranger's redeem call would fund an attacker's
// order with a member's points.
//
// The legitimate callers, and the authority each one really has:
//   * a till, kiosk or other paired device: a session BOUND to a devices row of the venue the
//     call acts for (the device arm of pos_can_access, _shared/deviceAuthority.ts). Staff at the
//     venue pick the customer, so a device may act for any member of its venue's company.
//   * a Back Office user acting as a till: a real (non anonymous) user with access to the
//     location by the database's own rule (user_locations, or a verified super admin, see
//     staffAccess.ts), or a company role for the location's company.
//   * the member themselves: the loyalty session token loyalty-otp minted after the one time
//     code, and only for THEIR OWN customer id in THAT company.
//
// REPORT FIRST, THEN ENFORCE BY ITSELF (LOYALTY_AUTHORITY_MODE, deviceAuthority.ts loyaltyModeFor).
// Before 20260919a a till's device link may be missing, and the devices table is writable, so a
// refusal would cost real sales while stopping nobody determined: every call is ALLOWED and each
// one that enforce would refuse is logged. Once file A has run the mode enforces on its own.
//
// PURE. The edge functions gather the facts; this decides. No imports, so node tests load it.

export type CallerKind =
  | 'none'            // no session at all
  | 'member'          // sent a member token (good or bad)
  | 'staff'           // non anonymous user with access to the location
  | 'device'          // session bound to a device of this venue
  | 'device_other'    // a device session, but not bound to this venue
  | 'user_no_access'  // non anonymous user without access to this location
  | 'anonymous';      // anonymous session with no device link and no member token

export type RefusalReason =
  | 'no_session'
  | 'member_token_invalid'
  | 'member_token_other_customer'
  | 'member_token_not_accepted'
  | 'device_other_venue'
  | 'device_not_bound'
  | 'no_location_access'
  | 'anonymous_no_device';

export type RedeemAuthorityInput = {
  user: { id: string; is_anonymous?: boolean } | null;
  /** A member_token was sent (whether or not it verified). */
  memberTokenSent: boolean;
  /** The verified member session, or null when absent or invalid. */
  memberSession: { customerId: string; companyId: string } | null;
  /** Non anonymous caller with user_locations access to the location, or super_admin. */
  staffHasLocation: boolean;
  /** The caller is a device bound to the venue of the call (deviceAuthority.ts decideDeviceAccess). */
  device: boolean;
  /** Why the device arm failed ('other_venue', 'not_bound', 'no_device', ...), or null. */
  deviceReason?: string | null;
  customerId: string;
  companyId: string;
  /**
   * May the member's own token authorise this call? Default true. FALSE for till actions a member
   * must never do for themselves: loyalty-refund (a member refunding their own redemption would
   * keep the reward AND get the points back).
   */
  memberAllowed?: boolean;
};

export type LoyaltyAuthority =
  | { ok: true; via: 'member' | 'staff' | 'device'; callerKind: CallerKind }
  | { ok: false; status: number; error: string; reason: RefusalReason; callerKind: CallerKind };

/**
 * ORDER:
 *   1. a GOOD member token for this very customer and company passes, even with no session at
 *      all. The portal refresh (loyalty-otp) calls loyalty-balance server to server with only
 *      x-member-token.
 *   2. otherwise the staff and device arms are tried whatever token was sent. A bad or expired
 *      member token must never lock out a bound till or a signed in manager (a kiosk keeps the
 *      last member's token for a short grace after a reset).
 *   3. only when nothing passes is the call refused, with the member reason when a token was
 *      sent, so the log says why.
 * memberAllowed false (loyalty-refund) skips step 1 entirely.
 */
export function decideLoyaltyAuthority(i: RedeemAuthorityInput): LoyaltyAuthority {
  const memberAllowed = i.memberAllowed !== false;
  const s = i.memberSession;
  const memberMatches = !!s && s.customerId === i.customerId && s.companyId === i.companyId;
  if (memberAllowed && i.memberTokenSent && memberMatches) return { ok: true, via: 'member', callerKind: 'member' };

  const memberRefusal = (): LoyaltyAuthority | null => {
    if (!i.memberTokenSent) return null;
    if (!memberAllowed) {
      return { ok: false, status: 403, error: 'A loyalty member cannot do this themselves. Ask a member of staff.', reason: 'member_token_not_accepted', callerKind: 'member' };
    }
    if (!s) return { ok: false, status: 403, error: 'Your loyalty session has expired. Please sign in again.', reason: 'member_token_invalid', callerKind: 'member' };
    return { ok: false, status: 403, error: 'This loyalty session is not for that customer.', reason: 'member_token_other_customer', callerKind: 'member' };
  };

  if (!i.user) return memberRefusal() ?? { ok: false, status: 401, error: 'Unauthorized', reason: 'no_session', callerKind: 'none' };

  if (!i.user.is_anonymous && i.staffHasLocation) return { ok: true, via: 'staff', callerKind: 'staff' };
  if (i.device) return { ok: true, via: 'device', callerKind: 'device' };

  const m = memberRefusal();
  if (m) return m;
  const error = 'Not allowed to act for this loyalty member.';
  if (i.deviceReason === 'other_venue') return { ok: false, status: 403, error, reason: 'device_other_venue', callerKind: 'device_other' };
  if (i.deviceReason === 'not_bound' || i.deviceReason === 'not_live') {
    return { ok: false, status: 403, error: 'This till is not linked to its venue. Pair it again.', reason: 'device_not_bound', callerKind: 'device_other' };
  }
  if (!i.user.is_anonymous) return { ok: false, status: 403, error, reason: 'no_location_access', callerKind: 'user_no_access' };
  return { ok: false, status: 403, error, reason: 'anonymous_no_device', callerKind: 'anonymous' };
}

/** Round one name, kept so nothing that imported it breaks. Same rule. */
export const decideRedeemAuthority = decideLoyaltyAuthority;

// ── The switch ───────────────────────────────────────────────────────────
export type AuthorityMode = 'report' | 'enforce';

/**
 * LOYALTY_AUTHORITY_MODE alone, without the fence (the parked branch's rule): only the exact
 * word "enforce" (any case, spaces trimmed) enforces. Kept for callers that have no fence state;
 * the functions use deviceAuthority.ts loyaltyModeFor(env, fence), which also enforces by itself
 * once 20260919a has run.
 */
export function loyaltyAuthorityMode(raw: unknown): AuthorityMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'enforce' ? 'enforce' : 'report';
}

export type AuthorityOutcome = 'allowed' | 'would_refuse' | 'refused';

/**
 * What to do with a decision under a mode.
 *   report:  ALWAYS allow. record = true when enforce would have refused.
 *   enforce: allow only when the decision is ok. A refusal is recorded too.
 * A call that passes is never recorded (the log is only what enforce would refuse).
 */
export function applyAuthorityMode(decision: { ok: boolean }, mode: AuthorityMode): {
  allow: boolean; record: boolean; outcome: AuthorityOutcome;
} {
  if (decision.ok) return { allow: true, record: false, outcome: 'allowed' };
  if (mode === 'enforce') return { allow: false, record: true, outcome: 'refused' };
  return { allow: true, record: true, outcome: 'would_refuse' };
}

// ── The record ───────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (v: unknown, n = 200): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
};
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

/**
 * One authority log line (printed to the function log as `[authority] {...}`; stage 1 adds no
 * table for it). Body supplied values (location, customer, check) are stored as clipped TEXT,
 * never trusted as ids: a caller can send anything. Never contains a token, a code, a phone or
 * an email.
 */
export function authorityLogRow(p: {
  fn: string;
  mode: AuthorityMode;
  outcome: AuthorityOutcome;
  decision: { ok: boolean; reason?: string; callerKind?: string };
  user: { id?: string; is_anonymous?: boolean } | null;
  companyId?: unknown;
  locationId?: unknown;
  customerId?: unknown;
  closedCheckId?: unknown;
  channel?: unknown;
  /** What the client says it is (its rpos-device id or rpos-kiosk-id). Untrusted; uuid only. */
  deviceHint?: unknown;
  detail?: Record<string, unknown> | null;
}) {
  const hint = uuidOrNull(p.deviceHint);
  return {
    fn: clip(p.fn, 60),
    mode: p.mode,
    outcome: p.outcome,
    caller_kind: clip(p.decision.callerKind ?? null, 40),
    reason: clip(p.decision.reason ?? null, 60),
    caller_id: uuidOrNull(p.user?.id),
    caller_anonymous: p.user ? !!p.user.is_anonymous : null,
    company_id: uuidOrNull(p.companyId),
    location_id: clip(p.locationId, 80),
    customer_id: clip(p.customerId, 80),
    closed_check_id: clip(p.closedCheckId, 120),
    channel: clip(p.channel, 30),
    detail: hint ? { ...(p.detail ?? {}), device_hint: hint } : (p.detail ?? null),
  };
}
