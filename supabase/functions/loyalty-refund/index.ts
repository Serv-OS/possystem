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
  const { data: originalTxs } = await opsAdmin
    .from('loyalty_transactions')
    .select('*')
    .eq('closed_check_id', closed_check_id)
    .eq('customer_id', customer_id)
    .eq('company_id', companyId)
    .order('created_at');

  if (!originalTxs || originalTxs.length === 0) {
    return json({ status: 'no_transactions', points_reversed: 0 });
  }

  // Calculate net reversal: earned points get clawed back (negative),
  // redeemed points get restored (positive)
  let netReversal = 0;
  for (const tx of originalTxs) {
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

  // ── Get membership ─────────────────────────────────────────────────────
  const { data: membership } = await platformAdmin
    .from('customer_loyalty')
    .select('id, points_balance, points_earned_total, points_redeemed_total')
    .eq('customer_id', customer_id)
    .eq('company_id', companyId)
    .maybeSingle();

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

  // ── Write refund transaction ───────────────────────────────────────────
  await opsAdmin.from('loyalty_transactions').insert({
    customer_id,
    company_id: companyId,
    location_id: location_id || originalTxs[0].location_id,
    type: 'refund',
    points: effectiveReversal,
    balance_after: newBalance,
    source: 'purchase',
    channel: originalTxs[0].channel,
    closed_check_id,
    idempotency_key: idempotencyKey,
    staff_id: staff_id || null,
    note: reason ? `Refund: ${reason}` : 'Order refunded — loyalty reversed',
  });

  return json({
    status: 'ok',
    points_reversed: effectiveReversal,
    balance: newBalance,
    original_transactions: originalTxs.length,
  });
});
