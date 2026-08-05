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
    stamp_program_id,   // redeem an EARNED stamp-card reward instead of a points reward
    channel = 'pos',
    closed_check_id,
    staff_id,
  } = body as any;

  if (!customer_id) return json({ error: 'customer_id required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!reward_id && !stamp_program_id) return json({ error: 'reward_id or stamp_program_id required' }, 400);

  // ── Resolve company ────────────────────────────────────────────────────
  const resolved = await resolveCompanyForLocation(caller.id, location_id);
  if (resolved instanceof Response) return resolved;
  const companyId = resolved;

  // ── Stamp-card reward redemption ───────────────────────────────────────
  // A completed stamp card IS the reward — there is no voucher row. Availability is derived:
  // customer_stamp_cards.completed_count MINUS redeem rows in ops stamp_transactions. Redeeming
  // appends a type='redeem' ledger row (idempotent, race-guarded), costing zero points.
  if (stamp_program_id) {
    const { data: prog } = await platformAdmin
      .from('stamp_card_programs')
      .select('id, name, reward_type, reward_description, reward_config, active')
      .eq('id', stamp_program_id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!prog || prog.active === false) return json({ error: 'Stamp card programme not found or inactive' }, 404);

    const rewardInfo = {
      id: `stamp:${prog.id}`,
      name: prog.reward_description || prog.name,
      type: prog.reward_type || 'free_item',
      value: prog.reward_config || {},
      points_cost: 0,
    };

    const countRedeemed = async (): Promise<number> => {
      const { count } = await opsAdmin
        .from('stamp_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customer_id)
        .eq('program_id', prog.id)
        .eq('type', 'redeem');
      return count || 0;
    };

    const { data: card } = await platformAdmin
      .from('customer_stamp_cards')
      .select('completed_count')
      .eq('customer_id', customer_id)
      .eq('program_id', prog.id)
      .maybeSingle();
    const completed = card?.completed_count || 0;
    if (completed - (await countRedeemed()) <= 0) {
      return json({ error: 'No stamp card reward available for this customer' }, 400);
    }

    // Idempotency — same insert-first shape as the points path below. A SELECT-then-INSERT
    // let two concurrent calls both pass the lookup; the ledger row IS the redemption here,
    // so its UNIQUE idempotency_key is the only thing that can settle the race.
    const idemKey = closed_check_id
      ? `stampredeem:${closed_check_id}:${prog.id}`
      : `stampredeem:${customer_id}:${prog.id}:${Math.floor(Date.now() / 30000)}`;

    const { data: ins, error: insErr } = await opsAdmin
      .from('stamp_transactions')
      .insert({
        customer_id,
        program_id: prog.id,
        location_id,
        stamps: 0,
        type: 'redeem',
        note: `Redeemed: ${rewardInfo.name}${staff_id ? ` (staff ${staff_id})` : ''}`,
        order_ref: closed_check_id || null,
        idempotency_key: idemKey,
      })
      .select('id')
      .single();

    if (insErr?.code === '23505') {
      // A concurrent call or an in-flight retry already owns this key — the reward has
      // already been handed over and recorded, so do NOT redeem a second card.
      return json({ status: 'already_processed', stamp: true, points_deducted: 0, balance: null, reward: rewardInfo, idempotency_key: idemKey });
    }
    if (insErr || !ins) {
      console.error('[loyalty-redeem] stamp redeem insert failed:', insErr?.message);
      return json({ error: 'Failed to record redemption' }, 500);
    }

    // Race guard: two redeems under DIFFERENT keys can both pass the availability pre-check —
    // recount after insert and roll back our own row if the ledger over-shot the completed count.
    if ((await countRedeemed()) > completed) {
      await opsAdmin.from('stamp_transactions').delete().eq('id', ins.id);
      return json({ error: 'Reward already redeemed' }, 409);
    }

    return json({
      status: 'redeemed',
      stamp: true,
      points_deducted: 0,
      balance: null,
      reward: rewardInfo,
      idempotency_key: idemKey,
    });
  }

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
  // The ledger row is the GUARD, not the epilogue (same shape as the stamp path above):
  // write it FIRST so its UNIQUE idempotency_key rejects a retry before anything is
  // deducted. Writing it last left the whole deduct window uncovered, so a 5xx retry
  // deducted twice. balance_after is projected here and patched after the deduct lands.
  const pointsToDeduct = reward.points_cost;
  const projectedBalance = membership.points_balance - pointsToDeduct;

  const { data: ledgerRow, error: ledgerErr } = await opsAdmin
    .from('loyalty_transactions')
    .insert({
      customer_id,
      company_id: companyId,
      location_id,
      type: 'redeem',
      points: -pointsToDeduct,
      balance_after: projectedBalance,
      source: 'reward',
      channel,
      closed_check_id: closed_check_id || null,
      reward_id,
      idempotency_key: idempotencyKey,
      staff_id: staff_id || null,
      note: `Redeemed: ${reward.name}`,
    })
    .select('id')
    .single();

  if (ledgerErr?.code === '23505') {
    // A concurrent call or an in-flight retry already owns this key — do NOT deduct again.
    return json({
      status: 'already_processed',
      points_deducted: pointsToDeduct,
      balance: membership.points_balance,
      reward: { id: reward.id, name: reward.name, type: reward.reward_type, value: reward.reward_value },
    });
  }
  if (ledgerErr || !ledgerRow) {
    console.error('[loyalty-redeem] ledger insert failed:', ledgerErr?.message);
    return json({ error: 'Failed to record redemption' }, 500);
  }

  const newBalance = await updateBalance(membership.id, -pointsToDeduct);
  if (newBalance === null) {
    // Nothing was deducted — drop our guard row so a legitimate retry isn't locked out.
    await opsAdmin.from('loyalty_transactions').delete().eq('id', ledgerRow.id);
    return json({ error: 'Failed to deduct points — concurrent modification or insufficient balance' }, 409);
  }

  if (newBalance !== projectedBalance) {
    await opsAdmin.from('loyalty_transactions').update({ balance_after: newBalance }).eq('id', ledgerRow.id);
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
