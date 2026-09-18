// supabase/functions/_shared/loyalty-authority.ts
//
// Who may move a loyalty member's points or stamps (loyalty-earn, loyalty-redeem, loyalty-refund)
// and who may read a member's full detail by phone (loyalty-member-lookup, loyalty-balance).
//
// WHY (18 Sep 2026 audit). These functions accepted ANY Supabase JWT, and an anonymous one is
// free to anybody holding the public anon key (signInAnonymously). customer_id, subtotal and
// closed_check_id came straight from the request body. So anybody could mint points for
// themselves, spend or reverse anybody's, or read a member's name, email and allergens by phone.
//
// The legitimate callers, and the authority each one really has:
//   * a till, kiosk or other paired device: an anonymous session whose auth uid is stamped on
//     its own devices row by claim_device (pairing code = proof). Staff at the venue pick the
//     customer, so a device may act for any member of ITS OWN company.
//   * a Back Office user acting as a till: a real (non anonymous) user with access to the
//     location (user_locations, or super_admin).
//   * the member themselves: the loyalty session token loyalty-otp minted after the one time
//     code, and only for THEIR OWN customer id in THAT company.
//
// REPORT FIRST (LOYALTY_AUTHORITY_MODE). The device arm depends on a claim that some real tills
// and many kiosks do not hold yet (kiosks claimed once at pairing, best effort; tills raced the
// claim at boot). Refusing those would silently make rewards free or stop points being earned at
// real sites. So by default ('report') every call is ALLOWED exactly as before and each one that
// enforce would refuse is recorded (authority_log_row below, table caller_authority_log). Only
// LOYALTY_AUTHORITY_MODE=enforce refuses. Flip it once the log has been quiet for real callers.
//
// PURE. The edge functions gather the facts; this decides. No imports, so node tests load it.

export type CallerKind =
  | 'none'            // no session at all
  | 'member'          // sent a member token (good or bad)
  | 'staff'           // non anonymous user with access to the location
  | 'device'          // anonymous session holding a claimed device of this company
  | 'device_other'    // claimed device, but of another company
  | 'user_no_access'  // non anonymous user without access to this location
  | 'anonymous';      // anonymous session with no device claim and no member token

export type RefusalReason =
  | 'no_session'
  | 'member_token_invalid'
  | 'member_token_other_customer'
  | 'device_other_company'
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
  /** Company of the caller's own claimed device, or null when the session holds no device. */
  deviceCompanyId: string | null;
  customerId: string;
  companyId: string;
};

export type LoyaltyAuthority =
  | { ok: true; via: 'member' | 'staff' | 'device'; callerKind: CallerKind }
  | { ok: false; status: number; error: string; reason: RefusalReason; callerKind: CallerKind };

export function decideLoyaltyAuthority(i: RedeemAuthorityInput): LoyaltyAuthority {
  if (!i.user) return { ok: false, status: 401, error: 'Unauthorized', reason: 'no_session', callerKind: 'none' };

  // A member token is an explicit claim to act AS that member. If it is sent it must be good
  // and must be for this very customer in this company; a bad one never falls through to the
  // device or staff arms.
  if (i.memberTokenSent) {
    const s = i.memberSession;
    if (!s) {
      return { ok: false, status: 403, error: 'Your loyalty session has expired. Please sign in again.', reason: 'member_token_invalid', callerKind: 'member' };
    }
    if (s.customerId !== i.customerId || s.companyId !== i.companyId) {
      return { ok: false, status: 403, error: 'This loyalty session is not for that customer.', reason: 'member_token_other_customer', callerKind: 'member' };
    }
    return { ok: true, via: 'member', callerKind: 'member' };
  }

  if (!i.user.is_anonymous && i.staffHasLocation) return { ok: true, via: 'staff', callerKind: 'staff' };
  if (i.deviceCompanyId && i.deviceCompanyId === i.companyId) return { ok: true, via: 'device', callerKind: 'device' };

  const error = 'Not allowed to act for this loyalty member.';
  if (i.deviceCompanyId) return { ok: false, status: 403, error, reason: 'device_other_company', callerKind: 'device_other' };
  if (!i.user.is_anonymous) return { ok: false, status: 403, error, reason: 'no_location_access', callerKind: 'user_no_access' };
  return { ok: false, status: 403, error, reason: 'anonymous_no_device', callerKind: 'anonymous' };
}

/** Round one name, kept so nothing that imported it breaks. Same rule. */
export const decideRedeemAuthority = decideLoyaltyAuthority;

// ── The switch ───────────────────────────────────────────────────────────
export type AuthorityMode = 'report' | 'enforce';

/**
 * LOYALTY_AUTHORITY_MODE. Only the exact word "enforce" (any case, spaces trimmed) enforces.
 * Unset, empty, misspelt or anything else is 'report': a typo must never start refusing tills.
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
 * One row for public.caller_authority_log (Ops DB, migration 20260918_OPS_caller_authority_log.sql).
 * Body supplied values (location, customer, check) are stored as clipped TEXT, never trusted as
 * ids: a caller can send anything. Never contains a token, a code, a phone or an email.
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
  detail?: Record<string, unknown> | null;
}) {
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
    detail: p.detail ?? null,
  };
}
