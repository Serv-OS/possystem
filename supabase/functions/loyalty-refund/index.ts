// supabase/functions/loyalty-refund/index.ts
//
// Reverse loyalty points when a check is refunded/voided.
// Called by store.refundCheck() — fire-and-forget, same pattern as
// gift-reverse-redeem.
//
// Body: {
//   customer_id,
//   location_id,
//   closed_check_id,    -- the check being refunded
//   reason?,
//   staff_id?,
// }
//
// Reverses ALL loyalty transactions for the given check:
//   - earn → clawback (negative points)
//   - redeem → restore (positive points)
//
// Redemptions the Ops ledger is missing are picked up from the Platform redemption
// claims: loyalty-redeem debits the balance on Platform and writes the Ops ledger row
// afterwards (two clusters, no shared transaction), so a redemption can exist with no
// ledger row to find.
//
// Idempotent via refund:{closed_check_id}

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
    closed_check_id,
    reason,
    staff_id,
  } = body as any;

  if (!customer_id) return json({ error: 'customer_id required' }, 400);
  if (!closed_check_id) return json({ error: 'closed_check_id required' }, 400);
  if (!location_id) return json({ error: 'location_id required' }, 400);

  // ── Resolve company (validates caller access) ─────────────────────────
  // v5.5.218: Must validate the caller has access to this company via their
  // location, same as gift-reverse-redeem. Without this, a user from Company A
  // could reverse loyalty transactions belonging to Company B.
  const resolved = await resolveCompanyForLocation(caller.id, location_id as string);
  if (resolved instanceof Response) return resolved;
  const companyId = resolved;

  // ── Idempotency check (scoped to company) ─────────────────────────────
  const idempotencyKey = `refund:${closed_check_id}`;
  const { data: existingRefund } = await opsAdmin
    .from('loyalty_transactions')
    .select('id, points, balance_after')
    .eq('idempotency_key', idempotencyKey)
    .eq('company_id', companyId)
    .maybeSingle();

  if (existingRefund) {
    return json({
      status: 'already_processed',
      points_reversed: existingRefund.points,
      balance: existingRefund.balance_after,
    });
  }

  // ── Find original transactions for this check ──────────────────────────
  // The error MUST be checked. This read used to be harmless to lose: a null result answered
  // 'no_transactions' having written nothing, so a retry could still do the whole job. Now that the
  // Platform claims fallback below merges into this list, a failed read produces a PARTIAL reversal
  // — the claim rows reverse, the earn row does not — and the refund ledger row it writes makes that
  // partial state permanent, because the next attempt short-circuits on it as already refunded.
  const { data: originalTxs, error: txReadErr } = await opsAdmin
    .from('loyalty_transactions')
    .select('*')
    .eq('closed_check_id', closed_check_id)
    .eq('customer_id', customer_id)
    .eq('company_id', companyId)
    .order('created_at');
  if (txReadErr) {
    return json({ error: `could not read the loyalty ledger — refund not attempted: ${txReadErr.message}` }, 500);
  }

  // ── Get membership ─────────────────────────────────────────────────────
  // Read before the reversal maths because the claims fallback below is fenced on
  // membership.id. The 404 stays where it was, after the "nothing found" answers.
  const { data: membership } = await platformAdmin
    .from('customer_loyalty')
    .select('id, points_balance, points_earned_total, points_redeemed_total, visit_count, lifetime_spend_minor, tier_id')
    .eq('customer_id', customer_id)
    .eq('company_id', companyId)
    .maybeSingle();

  // ── Fill the gaps from the Platform redemption claims ──────────────────
  // The points debit and its ledger row are on two different Postgres clusters, so
  // loyalty-redeem can take the points and then fail to land the Ops ledger row. Such a
  // redemption is invisible to the query above — the customer would be debited, the sale
  // refunded, and the points never given back. The claim row
  // (platform.loyalty_redemption_claims, migration 20260806c) holds the membership, the points
  // and the reward, which is exactly what a reversal needs. Its primary key is the redeem
  // idempotency key, shape `redeem:<closed_check_id>:<reward_id>`.
  //
  // Checked on EVERY refund, not just when the ledger came back empty: the earn row is written
  // by a different function, so the usual shape of this failure is a check that HAS its earn
  // row and is missing only the redeem one.
  let claimTxs: any[] = [];
  if (membership) {
    const prefix = `redeem:${closed_check_id}:`;
    const { data: claims } = await platformAdmin
      .from('loyalty_redemption_claims')
      .select('idempotency_key, points, reward_id')
      .eq('membership_id', membership.id)
      .like('idempotency_key', `${prefix}%`);
    const ledgerKeys = new Set((originalTxs || []).map((t) => t.idempotency_key));
    claimTxs = (claims || [])
      // `_` is a LIKE wildcard and check ids can contain one, so re-check the prefix literally:
      // a claim from a different check of the same length must never be reversed here.
      .filter((c) => String(c.idempotency_key).startsWith(prefix) && !ledgerKeys.has(c.idempotency_key))
      .map((c) => ({
        type: 'redeem',
        points: -Math.abs(c.points),   // ledger rows store redeems negative; claims store the magnitude
        reward_id: c.reward_id,
        channel: null,
        location_id: null,
      }));
    if (claimTxs.length > 0) {
      console.warn(`[loyalty-refund] ${claimTxs.length} redemption(s) on check ${closed_check_id} have no Ops ledger row — reversing them from the Platform claim rows`);
    }
  }

  const sourceTxs = [...(originalTxs || []), ...claimTxs];

  if (sourceTxs.length === 0) {
    return json({ status: 'no_transactions', points_reversed: 0 });
  }

  // Calculate net reversal: earned points get clawed back (negative),
  // redeemed points get restored (positive)
  let netReversal = 0;
  for (const tx of sourceTxs) {
    if (tx.type === 'earn' || tx.type === 'bonus') {
      // Clawback: reverse the earn
      netReversal -= tx.points;
    } else if (tx.type === 'redeem') {
      // Restore: reverse the redeem (tx.points is already negative)
      netReversal -= tx.points; // double negative = positive
    }
  }

  if (netReversal === 0) {
    return json({ status: 'nothing_to_reverse', points_reversed: 0 });
  }

  if (!membership) {
    return json({ error: 'Membership not found' }, 404);
  }

  // ── Apply reversal ─────────────────────────────────────────────────────
  // Ensure balance doesn't go negative (clawback can't take more than balance)
  const effectiveReversal = Math.max(
    netReversal,
    -membership.points_balance,
  );

  const newBalance = await updateBalance(membership.id, effectiveReversal);
  if (newBalance === null) {
    return json({ error: 'Failed to update balance' }, 500);
  }

  // ── Update lifetime stats ──────────────────────────────────────────────
  const updates: Record<string, any> = {};
  if (effectiveReversal < 0) {
    // Clawback: reduce earned total
    updates.points_earned_total = Math.max(
      0,
      (membership.points_earned_total || 0) + effectiveReversal,
    );
  } else if (effectiveReversal > 0) {
    // Restore: reduce redeemed total
    updates.points_redeemed_total = Math.max(
      0,
      (membership.points_redeemed_total || 0) - effectiveReversal,
    );
  }
  if (Object.keys(updates).length > 0) {
    await platformAdmin
      .from('customer_loyalty')
      .update(updates)
      .eq('id', membership.id);
  }

  // ── v5.5.315 (H4): release reward inventory for reversed redemptions ─────
  // loyalty-redeem increments loyalty_rewards.total_redeemed (which gates
  // limited-availability rewards). A refund must give that stock back, else a
  // limited reward reports "sold out" earlier than it should after refunds.
  try {
    for (const tx of sourceTxs) {
      if (tx.type === 'redeem' && tx.reward_id) {
        const { data: rw } = await platformAdmin
          .from('loyalty_rewards')
          .select('id, total_redeemed')
          .eq('id', tx.reward_id)
          .maybeSingle();
        if (rw) {
          await platformAdmin
            .from('loyalty_rewards')
            .update({ total_redeemed: Math.max(0, (rw.total_redeemed || 0) - 1) })
            .eq('id', rw.id);
        }
      }
    }
  } catch (e) {
    console.warn('[loyalty-refund] reward total_redeemed reversal failed (non-fatal):', e);
  }

  // ── v5.5.315 (H2): re-evaluate tier after the clawback ──────────────────
  // The refund reduced points_earned_total; the customer may no longer qualify
  // for their tier. Demote (or adjust) to the highest tier they still qualify
  // for, so they don't keep an over-privileged earning multiplier. Mirrors the
  // deterministic ranking in loyalty-earn.
  try {
    const newEarnedTotal = Math.max(0, (membership.points_earned_total || 0) + Math.min(0, effectiveReversal));
    const stats = {
      points_earned_total: newEarnedTotal,
      visit_count: membership.visit_count || 0,
      lifetime_spend_minor: membership.lifetime_spend_minor || 0,
    };
    const { data: allTiers } = await platformAdmin
      .from('loyalty_tiers')
      .select('id, min_points_earned, min_visits, min_spend_minor')
      .eq('company_id', companyId);
    if (allTiers && allTiers.length > 0) {
      const qualifiedTier = allTiers
        .filter(t =>
          stats.points_earned_total >= (t.min_points_earned || 0) &&
          stats.visit_count >= (t.min_visits || 0) &&
          stats.lifetime_spend_minor >= (t.min_spend_minor || 0)
        )
        .sort((a, b) =>
          (b.min_points_earned || 0) - (a.min_points_earned || 0) ||
          (b.min_spend_minor || 0) - (a.min_spend_minor || 0) ||
          (b.min_visits || 0) - (a.min_visits || 0)
        )[0] || null;
      const newTierId = qualifiedTier?.id || null;
      if (newTierId !== membership.tier_id) {
        await platformAdmin
          .from('customer_loyalty')
          .update({ tier_id: newTierId, tier_qualified_at: newTierId ? new Date().toISOString() : null })
          .eq('id', membership.id);
      }
    }
  } catch (e) {
    console.warn('[loyalty-refund] tier re-evaluation failed (non-fatal):', e);
  }

  // ── Write refund transaction ───────────────────────────────────────────
  await opsAdmin.from('loyalty_transactions').insert({
    customer_id,
    company_id: companyId,
    location_id: location_id || sourceTxs[0].location_id,
    type: 'refund',
    points: effectiveReversal,
    balance_after: newBalance,
    source: 'purchase',
    channel: sourceTxs[0].channel,
    closed_check_id,
    idempotency_key: idempotencyKey,
    staff_id: staff_id || null,
    note: reason ? `Refund: ${reason}` : 'Order refunded — loyalty reversed',
  });

  return json({
    status: 'ok',
    points_reversed: effectiveReversal,
    balance: newBalance,
    original_transactions: sourceTxs.length,
    ...(claimTxs.length > 0 ? { claims_reversed: claimTxs.length } : {}),
  });
});
