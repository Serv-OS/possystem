// supabase/functions/loyalty-redeem/index.ts
//
// Redeem loyalty points for a reward at checkout.
//
// Body: {
//   customer_id,     -- ops DB customer UUID
//   location_id,     -- ops location_id
//   reward_id,       -- which reward from the catalog
//   channel,         -- 'pos'|'kiosk'|'online'|'qr'
//   closed_check_id, -- for audit trail (optional at time of redeem)
//   staff_id?,
// }
//
// Returns: { status, points_deducted, balance, reward }
//
// The POS should call this BEFORE finalising payment. If payment fails,
// call loyalty-refund to reverse.

import {
  cors, json, opsAdmin, platformAdmin, authenticateCaller,
  resolveCompanyForLocation, updateBalance,
} from '../_shared/loyalty-utils.ts';

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

  const {
    customer_id,
    location_id,
    reward_id,
    channel = 'pos',
    closed_check_id,
    staff_id,
  } = body as any;

  if (!customer_id) return json({ error: 'customer_id required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!reward_id) return json({ error: 'reward_id required' }, 400);

  // ── Resolve company ────────────────────────────────────────────────────
  const resolved = await resolveCompanyForLocation(caller.id, location_id);
  if (resolved instanceof Response) return resolved;
  const companyId = resolved;

  // ── Get reward ─────────────────────────────────────────────────────────
  const { data: reward } = await platformAdmin
    .from('loyalty_rewards')
    .select('*')
    .eq('id', reward_id)
    .eq('company_id', companyId)
    .eq('active', true)
    .maybeSingle();

  if (!reward) return json({ error: 'Reward not found or inactive' }, 404);

  // Check date range
  const now = new Date();
  if (reward.starts_at && new Date(reward.starts_at) > now) {
    return json({ error: 'Reward not yet available' }, 400);
  }
  if (reward.ends_at && new Date(reward.ends_at) < now) {
    return json({ error: 'Reward has expired' }, 400);
  }

  // Check total availability
  if (reward.total_available !== null && reward.total_redeemed >= reward.total_available) {
    return json({ error: 'Reward is sold out' }, 400);
  }

  // Check channel
  if (reward.channels?.length && !reward.channels.includes(channel)) {
    return json({ error: `Reward not available on ${channel}` }, 400);
  }

  // Check location
  if (reward.location_ids?.length && !reward.location_ids.includes(location_id)) {
    return json({ error: 'Reward not available at this location' }, 400);
  }

  // ── Get membership ────────────────────────────────────────────────────
  const { data: membership } = await platformAdmin
    .from('customer_loyalty')
    .select('*')
    .eq('customer_id', customer_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!membership) return json({ error: 'Customer not enrolled in loyalty' }, 404);

  // Check balance
  if (membership.points_balance < reward.points_cost) {
    return json({
      error: 'Insufficient points',
      points_balance: membership.points_balance,
      points_required: reward.points_cost,
    }, 400);
  }

  // ── Idempotency ────────────────────────────────────────────────────────
  // Use reward_id + customer_id + timestamp window to prevent double-tap
  const idempotencyKey = closed_check_id
    ? `redeem:${closed_check_id}:${reward_id}`
    : `redeem:${customer_id}:${reward_id}:${Math.floor(Date.now() / 30000)}`; // 30s window

  const { data: existingTx } = await opsAdmin
    .from('loyalty_transactions')
    .select('id, points, balance_after')
    .eq('idempotency_key', idempotencyKey)
    .eq('company_id', companyId)
    .maybeSingle();

  if (existingTx) {
    return json({
      status: 'already_processed',
      points_deducted: Math.abs(existingTx.points),
      balance: membership.points_balance,
      reward: { id: reward.id, name: reward.name, type: reward.reward_type, value: reward.reward_value },
    });
  }

  // ── Deduct points ──────────────────────────────────────────────────────
  const pointsToDeduct = reward.points_cost;
  const newBalance = await updateBalance(membership.id, -pointsToDeduct);
  if (newBalance === null) {
    return json({ error: 'Failed to deduct points — concurrent modification or insufficient balance' }, 409);
  }

  // ── Update redemption stats ────────────────────────────────────────────
  await platformAdmin
    .from('customer_loyalty')
    .update({
      points_redeemed_total: (membership.points_redeemed_total || 0) + pointsToDeduct,
    })
    .eq('id', membership.id);

  // Increment reward total_redeemed
  await platformAdmin
    .from('loyalty_rewards')
    .update({ total_redeemed: (reward.total_redeemed || 0) + 1 })
    .eq('id', reward.id);

  // ── Write transaction ledger ───────────────────────────────────────────
  await opsAdmin.from('loyalty_transactions').insert({
    customer_id,
    company_id: companyId,
    location_id,
    type: 'redeem',
    points: -pointsToDeduct,
    balance_after: newBalance,
    source: 'reward',
    channel,
    closed_check_id: closed_check_id || null,
    reward_id,
    idempotency_key: idempotencyKey,
    staff_id: staff_id || null,
    note: `Redeemed: ${reward.name}`,
  });

  // ── Build discount info for POS ────────────────────────────────────────
  const rewardInfo = {
    id: reward.id,
    name: reward.name,
    type: reward.reward_type,
    value: reward.reward_value,
    points_cost: pointsToDeduct,
  };

  return json({
    status: 'ok',
    points_deducted: pointsToDeduct,
    balance: newBalance,
    reward: rewardInfo,
    idempotency_key: idempotencyKey,
  });
});
