// supabase/functions/_shared/memberReply.ts
//
// The LIMITED reply loyalty-member-lookup and loyalty-balance give a caller who may not see a
// member's detail (18 Sep 2026): an anonymous online checkout asking "is this phone a member?",
// or, once LOYALTY_AUTHORITY_MODE=enforce, any caller without staff, device or member authority.
//
// It answers exactly what online checkout's sign in prompt needs (OnlineCheckout.jsx
// lookupLoyaltyMember): the number is a member, and whether points and stamp cards are on.
// Never a name, phone, email, allergens, member code, customer id, balance or history.
//
// PURE, so node tests pin the exact keys.

export function limitedMemberReply(cfg: { enabled?: boolean | null; points_enabled?: boolean | null; stamps_enabled?: boolean | null } | null | undefined) {
  const on = cfg?.enabled !== false;
  return {
    found: true,
    enrolled: true,
    limited: true,
    loyalty_enabled: on,
    points_enabled: on && cfg?.points_enabled !== false,
    stamps_enabled: on && cfg?.stamps_enabled !== false,
  };
}

/** Every key the limited reply may carry. A test fails if anything else appears. */
export const LIMITED_MEMBER_KEYS = ['found', 'enrolled', 'limited', 'loyalty_enabled', 'points_enabled', 'stamps_enabled'];
