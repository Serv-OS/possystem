// supabase/functions/loyalty-member-lookup/index.ts
//
// Authenticated lookup: find a loyalty member by code, phone, or customer_id.
// Used by POS/kiosk staff to identify a customer at checkout.
//
// POST: {
//   location_id,
//   member_code?,     -- "SRV-XXXXXX"
//   phone?,           -- raw phone number
//   customer_id?,     -- direct customer UUID
// }
//
// Returns: {
//   found, customer_id, member_code, name, phone, email,
//   points_balance, tier, rewards_available[], gift_cards[]
// }
// or, for a caller without authority once LOYALTY_AUTHORITY_MODE=enforce, the limited reply
// { found, enrolled, limited, loyalty_enabled, points_enabled, stamps_enabled } (_shared/memberReply.ts).
//
// CALLERS (checked 18 Sep 2026): none in src/. The till, host stand and kiosk look members up
// through loyalty-balance (src/lib/customerLookup.js fetchCustomerByPhone) or loyalty-otp.

import {
  cors, json, opsAdmin, platformAdmin, authenticateCaller,
  resolveCompanyForLocation, getOrCreateConfig, ensureMembership, checkLoyaltyAuthority,
} from '../_shared/loyalty-utils.ts';
import { giftCardRecipientFilter, cardBelongsToPhone } from '../_shared/giftCardMatch.ts';
import { limitedMemberReply } from '../_shared/memberReply.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  // Parse body
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { location_id, member_code, phone, customer_id } = body as any;

  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!member_code && !phone && !customer_id) {
    return json({ error: 'member_code, phone, or customer_id required' }, 400);
  }

  // ── Resolve company ────────────────────────────────────────────────────
  const resolved = await resolveCompanyForLocation(caller.id, location_id);
  if (resolved instanceof Response) return resolved;
  const companyId = resolved;

  // ── Resolve org_id for customer queries ────────────────────────────────
  const { data: locData } = await platformAdmin
    .from('locations')
    .select('org_id, ops_location_id')
    .or(`ops_location_id.eq.${location_id},id.eq.${location_id}`)
    .limit(1)
    .maybeSingle();

  const orgId = locData?.org_id;

  // ── Find the customer ──────────────────────────────────────────────────
  let custId: string | null = customer_id || null;
  let custData: any = null;

  if (member_code && !custId) {
    // Look up by member code → get customer_id
    const { data: membership } = await platformAdmin
      .from('customer_loyalty')
      .select('customer_id')
      .eq('member_code', member_code.toUpperCase().trim())
      .eq('company_id', companyId)
      .maybeSingle();
    custId = membership?.customer_id || null;
  }

  if (phone && !custId && orgId) {
    // Look up by phone in ops DB
    const phoneN = normalisePhone(phone);
    if (phoneN) {
      const { data: customer } = await opsAdmin
        .from('customers')
        .select('id')
        .eq('org_id', orgId)
        .eq('phone', phoneN)
        .is('deleted_at', null)
        .maybeSingle();
      custId = customer?.id || null;
    }
  }

  if (!custId) {
    return json({ found: false, error: 'Customer not found' }, 404);
  }

  // ── Get customer profile from ops DB ───────────────────────────────────
  const { data: customer } = await opsAdmin
    .from('customers')
    .select('id, name, phone, email, allergens')
    .eq('id', custId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!customer) {
    return json({ found: false, error: 'Customer not found' }, 404);
  }

  // ── Who may see the full member (18 Sep 2026) ──────────────────────────
  // This returns name, phone, email, allergens, points and rewards for a phone number, and any
  // session could call it. Full detail now needs staff with the location, a claimed device of
  // this company, or the member's own token (same rule as loyalty-redeem). Anybody else gets
  // only what a sign in prompt needs: is this number a member, and are points and stamps on.
  // REPORT FIRST: LOYALTY_AUTHORITY_MODE unset or 'report' still returns full detail and
  // records the caller; 'enforce' returns the limited reply. The limited reply never enrols.
  const gate = await checkLoyaltyAuthority({
    fn: 'loyalty-member-lookup',
    caller,
    locationId: String(location_id),
    companyId: String(companyId),
    customerId: String(customer.id),
    memberToken: (body as any).member_token,
    channel: (body as any).channel ?? null,
  });
  if (!gate.allow) {
    const [{ data: cfg }, { data: member }] = await Promise.all([
      platformAdmin.from('loyalty_config').select('enabled, points_enabled, stamps_enabled').eq('company_id', companyId).maybeSingle(),
      platformAdmin.from('customer_loyalty').select('id').eq('customer_id', customer.id).eq('company_id', companyId).maybeSingle(),
    ]);
    if (!member) return json({ found: false, error: 'Customer not found' }, 404);
    return json(limitedMemberReply(cfg));
  }

  // ── Get or create loyalty membership ───────────────────────────────────
  const config = await getOrCreateConfig(companyId);
  const loyaltyEnabled = config?.enabled ?? false;

  let loyaltyData: any = null;
  let tier: any = null;
  let affordableRewards: any[] = [];

  if (loyaltyEnabled) {
    const memberResult = await ensureMembership(custId, companyId, config);
    if (!(memberResult instanceof Response)) {
      const { membership } = memberResult;
      loyaltyData = membership;

      // Get tier
      if (membership.tier_id) {
        const { data: t } = await platformAdmin
          .from('loyalty_tiers')
          .select('name, color, icon, points_multiplier')
          .eq('id', membership.tier_id)
          .maybeSingle();
        tier = t;
      }

      // Get available rewards
      const { data: allRewards } = await platformAdmin
        .from('loyalty_rewards')
        .select('id, name, description, icon, points_cost, reward_type, reward_value, channels')
        .eq('company_id', companyId)
        .eq('active', true)
        .order('sort_order');

      affordableRewards = (allRewards || []).filter(r =>
        r.points_cost <= membership.points_balance
      );
    }
  }

  // ── Get linked gift cards ──────────────────────────────────────────────
  let giftCards: any[] = [];
  try {
    // 18 Sep 2026: matched on the customer's PHONE only (never email: a member can set any email
    // in the portal with no verification) and returned WITHOUT the card id. This function accepts
    // any session including an anonymous one, and gift-redeem spends a card by its id, so an id
    // here is as good as the code. last4 and balance are all a lookup needs.
    const filter = giftCardRecipientFilter(customer.phone);
    if (filter) {
      const { data: cards } = await platformAdmin
        .from('gift_cards')
        .select('code_last4, balance_minor, status, expires_at, recipient_phone')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .or(filter);
      // The filter is a wide net (cards typed as '07931 123 456' must still be found); the match
      // is the normalised phone, row by row.
      giftCards = (cards || []).filter(c => cardBelongsToPhone(c, customer.phone)).map(c => ({
        last4: c.code_last4,
        balance: c.balance_minor,
        expires_at: c.expires_at,
      }));
    }
  } catch (e) {
    // Gift card lookup is non-critical
    console.warn('[loyalty-member-lookup] gift card lookup failed:', e);
  }

  // ── Get visit stats from ops DB ────────────────────────────────────────
  const { data: locStats } = await opsAdmin
    .from('customer_locations')
    .select('visit_count, lifetime_revenue, last_visit_at')
    .eq('customer_id', custId)
    .eq('location_id', location_id)
    .maybeSingle();

  return json({
    found: true,
    customer_id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    allergens: customer.allergens || [],

    // Loyalty
    loyalty_enabled: loyaltyEnabled,
    points_enabled: loyaltyEnabled && (config?.points_enabled !== false),
    stamps_enabled: loyaltyEnabled && (config?.stamps_enabled !== false),
    member_code: loyaltyData?.member_code || null,
    points_balance: loyaltyData?.points_balance ?? 0,
    points_earned_total: loyaltyData?.points_earned_total ?? 0,
    tier: tier ? {
      name: tier.name,
      color: tier.color,
      icon: tier.icon,
      multiplier: tier.points_multiplier,
    } : null,
    rewards_available: affordableRewards,

    // Gift cards
    gift_cards: giftCards,

    // Visit stats
    visit_count: locStats?.visit_count ?? 0,
    lifetime_spend: locStats?.lifetime_revenue ?? 0,
    last_visit_at: locStats?.last_visit_at ?? null,

    // Membership dates
    enrolled_at: loyaltyData?.enrolled_at || null,
    referral_code: loyaltyData?.referral_code || null,
  });
});

// ── Phone normalisation ──────────────────────────────────────────────────
function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}
