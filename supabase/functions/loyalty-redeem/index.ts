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
  resolveCompanyForLocation,
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
  // The debit, its idempotency claim, points_redeemed_total and the reward counter are ONE
  // transaction — loyalty_redeem_points on the PLATFORM db (migration 20260806c).
  //
  // ⚠ The Ops ledger row CANNOT be in that transaction: loyalty_transactions is on Ops and
  // customer_loyalty is on Platform, two separate Postgres clusters. So the claim is taken
  // FIRST and the ledger written after, which is the only ordering that heals itself. Ledger
  // first (what this did before) left a dead isolate holding a guard row over points that
  // were never deducted, silently; and the rollback DELETE that covered a failed deduct could
  // erase a row a concurrent replay had already reported as successful. Nothing is deleted
  // now, and a retry under the same key re-runs the RPC as a no-op and re-lands the ledger row.
  const pointsToDeduct = reward.points_cost;

  const { data: debit, error: debitErr } = await platformAdmin.rpc('loyalty_redeem_points', {
    p_membership_id: membership.id,
    p_points: pointsToDeduct,
    p_idempotency_key: idempotencyKey,
    p_reward_id: reward.id,
  });
  if (debitErr || !debit?.result) {
    console.error('[loyalty-redeem] loyalty_redeem_points failed:', debitErr?.message);
    return json({ error: 'Failed to deduct points' }, 500);
  }
  if (debit.result === 'not_found') return json({ error: 'Customer not enrolled in loyalty' }, 404);
  if (debit.result === 'insufficient') {
    return json({
      error: 'Insufficient points',
      points_balance: debit.balance,
      points_required: pointsToDeduct,
    }, 400);
  }

  const newBalance = debit.balance;

  // Audit ledger (Ops) — written after the money moved, idempotent on its own UNIQUE
  // idempotency_key so a replay is a no-op. A failure here is never RETURNED: the points are
  // already gone, and refusing would cost the customer the points AND the reward.
  //
  // ⚠ But it is not fire-and-forget either. loyalty-refund finds what to reverse by querying
  // loyalty_transactions on closed_check_id, so a redemption whose ledger row never landed would be
  // invisible to it: debited, refunded, points never given back. Two things stop that, and only
  // these two — there is NO reconciler job, and nothing reads the ledger_pending flag below:
  //   1. the retry loop here, and
  //   2. loyalty-refund reading platform.loyalty_redemption_claims directly when the Ops ledger has
  //      no redeem row for the check. That is what actually makes the money recoverable.
  // If both the retry and the claim row are lost the points are gone, so the failure is also
  // written to activity_events and logged under LEDGER_WRITE_FAILED to be findable by hand.
  // A scheduled anti-join of platform.loyalty_redemption_claims against ops.loyalty_transactions on
  // idempotency_key would close the gap properly; it does not exist yet.
  const ledgerRow = {
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
  };
  let ledgerErr: { message: string } | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await opsAdmin
      .from('loyalty_transactions')
      .upsert(ledgerRow, { onConflict: 'idempotency_key', ignoreDuplicates: true });
    ledgerErr = error;
    if (!ledgerErr) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 150 * attempt));
  }
  if (ledgerErr) {
    console.error(
      '[loyalty-redeem] LEDGER_WRITE_FAILED — points debited on Platform, Ops ledger row missing:',
      JSON.stringify({
        idempotency_key: idempotencyKey,
        customer_id,
        company_id: companyId,
        location_id,
        closed_check_id: closed_check_id || null,
        points: -pointsToDeduct,
        balance_after: newBalance,
        error: ledgerErr.message,
      }),
    );
    // Raise it on the operator's activity feed as well, so it is a row someone can find rather
    // than a line in the function logs. Best-effort, and on the SAME database that just refused
    // the ledger row — the Platform claim row remains the authority either way.
    const { error: alertErr } = await opsAdmin.from('activity_events').insert({
      location_id,
      kind: 'system',
      severity: 'urgent',
      title: 'Loyalty ledger write failed',
      body: `${pointsToDeduct} points were deducted for "${reward.name}" but the audit row did not save. Reference ${idempotencyKey}.`,
      ref_type: 'loyalty_redemption',
      ref_id: idempotencyKey,
    });
    if (alertErr) {
      console.error('[loyalty-redeem] could not raise the operator alert either:', alertErr.message);
    }
  }

  // ── Build discount info for POS ────────────────────────────────────────
  const rewardInfo = {
    id: reward.id,
    name: reward.name,
    type: reward.reward_type,
    value: reward.reward_value,
    points_cost: pointsToDeduct,
  };

  return json({
    status: debit.result === 'already_redeemed' ? 'already_processed' : 'ok',
    points_deducted: debit.points_deducted ?? pointsToDeduct,
    balance: newBalance,
    reward: rewardInfo,
    idempotency_key: idempotencyKey,
    // Still a success — the debit settled; only the Ops audit row is outstanding. Nothing reads
    // this flag today; it is here so the condition is visible in logs and to any future caller,
    // NOT because a self-heal is listening for it.
    ...(ledgerErr ? { ledger_pending: true } : {}),
  });
});
