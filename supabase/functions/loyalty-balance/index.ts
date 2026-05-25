// supabase/functions/loyalty-balance/index.ts
//
// Public endpoint: check loyalty balance by member code, phone, or customer_id.
// No auth required (like gift-balance-public) — for customer-facing surfaces.
//
// GET: ?member_code=SRV-XXXXXX&company_id=xxx
//   or ?phone=+447700900000&company_id=xxx
//   or ?customer_id=xxx&company_id=xxx
//
// Returns: { member_code, points_balance, tier, rewards_available[], enrolled_at }

import { cors, json, platformAdmin, opsAdmin } from '../_shared/loyalty-utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const url = new URL(req.url);
  const memberCode = url.searchParams.get('member_code');
  const phone = url.searchParams.get('phone');
  const customerId = url.searchParams.get('customer_id');
  const companyId = url.searchParams.get('company_id');

  if (!companyId) return json({ error: 'company_id required' }, 400);
  if (!memberCode && !phone && !customerId) {
    return json({ error: 'member_code, phone, or customer_id required' }, 400);
  }

  // ── Find membership ────────────────────────────────────────────────────
  let membership: any = null;

  if (memberCode) {
    const { data } = await platformAdmin
      .from('customer_loyalty')
      .select('*')
      .eq('member_code', memberCode.toUpperCase().trim())
      .eq('company_id', companyId)
      .maybeSingle();
    membership = data;
  } else if (customerId) {
    const { data } = await platformAdmin
      .from('customer_loyalty')
      .select('*')
      .eq('customer_id', customerId)
      .eq('company_id', companyId)
      .maybeSingle();
    membership = data;
  } else if (phone) {
    // Normalise phone, find customer in ops DB, then look up membership
    const phoneN = normalisePhone(phone);
    if (!phoneN) return json({ error: 'Invalid phone number' }, 400);

    // Resolve org_id from company
    const { data: locations } = await platformAdmin
      .from('locations')
      .select('ops_location_id, org_id')
      .eq('company_id', companyId)
      .limit(1)
      .maybeSingle();

    if (!locations?.org_id) return json({ error: 'Company has no locations' }, 404);

    // Find customer by phone in ops DB
    const { data: customer } = await opsAdmin
      .from('customers')
      .select('id')
      .eq('org_id', locations.org_id)
      .eq('phone', phoneN)
      .is('deleted_at', null)
      .maybeSingle();

    if (customer) {
      const { data } = await platformAdmin
        .from('customer_loyalty')
        .select('*')
        .eq('customer_id', customer.id)
        .eq('company_id', companyId)
        .maybeSingle();
      membership = data;
    }
  }

  if (!membership) {
    return json({ error: 'Member not found', enrolled: false }, 404);
  }

  // ── Get tier info ──────────────────────────────────────────────────────
  let tier: any = null;
  if (membership.tier_id) {
    const { data } = await platformAdmin
      .from('loyalty_tiers')
      .select('name, color, icon, points_multiplier')
      .eq('id', membership.tier_id)
      .maybeSingle();
    tier = data;
  }

  // ── Get available rewards ──────────────────────────────────────────────
  const now = new Date().toISOString();
  const { data: allRewards } = await platformAdmin
    .from('loyalty_rewards')
    .select('id, name, description, icon, points_cost, reward_type, reward_value, channels')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('sort_order');

  // Filter to those the customer can afford + not expired
  const affordableRewards = (allRewards || []).filter(r => {
    if (r.points_cost > membership.points_balance) return false;
    return true;
  });

  // ── Get recent transactions (redacted for public endpoint) ──────────────
  // v5.5.218: Only return type, points, and date — redact staff notes,
  // source details, and internal IDs to prevent data leakage.
  const { data: recentTx } = await opsAdmin
    .from('loyalty_transactions')
    .select('type, points, created_at')
    .eq('customer_id', membership.customer_id)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(10);

  return json({
    enrolled: true,
    member_code: membership.member_code,
    points_balance: membership.points_balance,
    points_earned_total: membership.points_earned_total,
    points_redeemed_total: membership.points_redeemed_total,
    visit_count: membership.visit_count,
    tier: tier ? {
      name: tier.name,
      color: tier.color,
      icon: tier.icon,
      multiplier: tier.points_multiplier,
    } : null,
    rewards_available: affordableRewards,
    // v5.5.218: all_rewards shows full catalog (public info — name/icon/cost only)
    all_rewards: (allRewards || []).map(r => ({
      id: r.id, name: r.name, description: r.description,
      icon: r.icon, points_cost: r.points_cost,
      reward_type: r.reward_type,
    })),
    recent_transactions: (recentTx || []).map(tx => ({
      type: tx.type, points: tx.points, created_at: tx.created_at,
    })),
    enrolled_at: membership.enrolled_at,
    last_earn_at: membership.last_earn_at,
    // v5.5.218: referral_code and birthday redacted from public endpoint.
    // These are returned by the authenticated loyalty-member-lookup instead.
  });
});

// ── Phone normalisation (mirrored from customerLookup.js) ────────────────
function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}
