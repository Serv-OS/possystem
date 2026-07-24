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

    // Resolve org_id: platform locations has ops_location_id, ops locations has org_id
    const { data: platLoc } = await platformAdmin
      .from('locations')
      .select('ops_location_id')
      .eq('company_id', companyId)
      .limit(1)
      .maybeSingle();

    if (!platLoc?.ops_location_id) return json({ error: 'Company has no locations' }, 404);

    const { data: opsLoc } = await opsAdmin
      .from('locations')
      .select('org_id')
      .eq('id', platLoc.ops_location_id)
      .maybeSingle();

    if (!opsLoc?.org_id) return json({ error: 'Location org not found' }, 404);

    // Find customer by phone in ops DB — try normalised first, fallback to raw
    let customer: any = null;
    const { data: c1 } = await opsAdmin
      .from('customers')
      .select('id')
      .eq('org_id', opsLoc.org_id)
      .eq('phone', phoneN)
      .is('deleted_at', null)
      .maybeSingle();
    customer = c1;

    // Fallback: try phone_raw column too (UK 07xxx format)
    if (!customer) {
      const rawPhone = phoneN.startsWith('+44') ? '0' + phoneN.slice(3) : phoneN;
      const { data: c2 } = await opsAdmin
        .from('customers')
        .select('id')
        .eq('org_id', opsLoc.org_id)
        .eq('phone_raw', rawPhone)
        .is('deleted_at', null)
        .maybeSingle();
      customer = c2;
    }

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

  // ── v5.5.264: Stamp card programs + customer progress ────────────────
  let stampCards: any[] = [];
  try {
    const { data: programs } = await platformAdmin
      .from('stamp_card_programs')
      .select('id, name, description, icon, stamps_required, reward_type, reward_description, active')
      .eq('company_id', companyId)
      .eq('active', true)
      .order('created_at');
    if (programs && programs.length > 0) {
      const progIds = programs.map((p: any) => p.id);
      const { data: progress } = await platformAdmin
        .from('customer_stamp_cards')
        .select('program_id, stamps_collected, completed_count, last_stamp_at')
        .eq('customer_id', membership.customer_id)
        .eq('company_id', companyId)
        .in('program_id', progIds);
      const progressMap: Record<string, any> = {};
      (progress || []).forEach((p: any) => { progressMap[p.program_id] = p; });
      stampCards = programs.map((p: any) => ({
        id: p.id, name: p.name, description: p.description, icon: p.icon || '☕',
        stamps_required: p.stamps_required, reward_type: p.reward_type,
        reward_description: p.reward_description,
        stamps_collected: progressMap[p.id]?.stamps_collected || 0,
        completed_count: progressMap[p.id]?.completed_count || 0,
        last_stamp_at: progressMap[p.id]?.last_stamp_at || null,
      }));

      // Earned rewards = completed cards MINUS redeemed (redeem ledger = ops stamp_transactions
      // type='redeem' rows, written by loyalty-redeem). Completing a card mints nothing else —
      // this derived count IS the customer's reward balance, so it must be on every card here
      // or completed cards never show up as redeemable anywhere (the original bug).
      for (const sc of stampCards) {
        if (!sc.completed_count) { sc.rewards_available = 0; continue; }
        const { count } = await opsAdmin
          .from('stamp_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('customer_id', membership.customer_id)
          .eq('program_id', sc.id)
          .eq('type', 'redeem');
        sc.rewards_available = Math.max(0, (sc.completed_count || 0) - (count || 0));
      }
    }
  } catch {}

  // Fetch reward_config for programs with an earned reward — the POS needs eligible_items to
  // apply the free-item discount. (Kept out of the main select to leave its shape untouched.)
  const stampRewards: any[] = [];
  try {
    const withRewards = stampCards.filter((sc: any) => (sc.rewards_available || 0) > 0);
    if (withRewards.length) {
      const { data: cfgs } = await platformAdmin
        .from('stamp_card_programs')
        .select('id, reward_config')
        .in('id', withRewards.map((sc: any) => sc.id));
      const cfgMap: Record<string, any> = {};
      (cfgs || []).forEach((c: any) => { cfgMap[c.id] = c.reward_config || {}; });
      for (const sc of withRewards) {
        stampRewards.push({
          program_id: sc.id,
          name: sc.reward_description || sc.name,
          reward_type: sc.reward_type || 'free_item',
          reward_config: cfgMap[sc.id] || {},
          available: sc.rewards_available,
        });
      }
    }
  } catch {}

  // ── v5.5.264: Gift cards linked to this customer ─────────────────────
  let giftCards: any[] = [];
  try {
    // Resolve customer phone/email/name from ops DB for gift card lookup
    const { data: custRow } = await opsAdmin
      .from('customers')
      .select('phone, email, name')
      .eq('id', membership.customer_id)
      .maybeSingle();
    if (custRow) {
      const conditions: string[] = [];
      if (custRow.phone) conditions.push(`recipient_phone.eq.${custRow.phone}`);
      if (custRow.email) conditions.push(`recipient_email.eq.${custRow.email}`);
      if (custRow.name) conditions.push(`recipient_name.eq.${custRow.name}`);
      if (conditions.length > 0) {
        const { data: cards } = await platformAdmin
          .from('gift_cards')
          .select('id, code_last4, code_plain, balance_minor, status, expires_at, initial_amount_minor')
          .eq('company_id', companyId)
          .eq('status', 'active')
          .or(conditions.join(','));
        giftCards = (cards || []).map((c: any) => ({
          id: c.id,
          last4: c.code_last4,
          code: c.code_plain || null,
          balance: c.balance_minor,
          initial: c.initial_amount_minor,
          expires_at: c.expires_at,
        }));
      }
    }
  } catch {}

  // Loyalty type availability (points vs stamp cards) so client surfaces hide the disabled half.
  const { data: _cfg } = await platformAdmin.from('loyalty_config').select('enabled, points_enabled, stamps_enabled').eq('company_id', companyId).maybeSingle();
  const _loyOn = _cfg?.enabled !== false;

  return json({
    enrolled: true,
    points_enabled: _loyOn && (_cfg?.points_enabled !== false),
    stamps_enabled: _loyOn && (_cfg?.stamps_enabled !== false),
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
    // v5.5.264: stamp cards and gift cards for kiosk/online surfaces
    stamp_cards: stampCards,
    // v5.5.884: earned stamp-card rewards (completed cards not yet redeemed) — the POS/portal
    // rewards lists were points-only, so a completed card never appeared anywhere.
    stamp_rewards: stampRewards,
    gift_cards: giftCards,
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
