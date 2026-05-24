// supabase/functions/gift-reverse-redeem/index.ts
//
// Reverse a prior redemption. Restores the debited amount back to the card.
// Used when an order fails after the gift was debited (online/kiosk),
// or when a POS order is voided.
//
// Body: { card_id, original_idempotency_key, reason, staff_id? }

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
} from '../_shared/gift-card-utils.ts';

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

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  const { card_id, original_idempotency_key, reason, staff_id } = body as any;

  if (!card_id) return json({ error: 'card_id required' }, 400);
  if (!original_idempotency_key) return json({ error: 'original_idempotency_key required' }, 400);
  if (!reason) return json({ error: 'reason required' }, 400);

  // Find the original redeem transaction
  const { data: originalTx } = await platformAdmin
    .from('gift_card_transactions')
    .select('*')
    .eq('card_id', card_id)
    .eq('idempotency_key', original_idempotency_key)
    .eq('type', 'redeem')
    .maybeSingle();

  if (!originalTx) {
    return json({ error: 'Original redemption not found for this card and idempotency key' }, 404);
  }

  // Verify card belongs to caller's org
  if (originalTx.company_id !== companyId) {
    return json({ error: 'Card not found' }, 404);
  }

  // Check if already reversed (idempotency on reverse)
  const refundKey = `refund:${original_idempotency_key}`;
  const { data: existingRefund } = await platformAdmin
    .from('gift_card_transactions')
    .select('*')
    .eq('card_id', card_id)
    .eq('idempotency_key', refundKey)
    .maybeSingle();

  if (existingRefund) {
    return json({
      card_id,
      restored: existingRefund.amount_minor,
      balance: existingRefund.balance_after_minor,
      status: 'already_reversed',
      idempotent: true,
    });
  }

  // Get current card state
  const { data: card } = await platformAdmin
    .from('gift_cards')
    .select('balance_minor, status')
    .eq('id', card_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!card) return json({ error: 'Card not found' }, 404);

  // Voided cards cannot be reversed
  if (card.status === 'voided') {
    return json({ error: 'Cannot reverse on a voided card' }, 400);
  }

  // Restore the debited amount (originalTx.amount_minor is negative)
  const restoreAmount = Math.abs(originalTx.amount_minor);
  const newBalance = card.balance_minor + restoreAmount;

  // Insert refund ledger entry
  const { error: txErr } = await platformAdmin
    .from('gift_card_transactions')
    .insert({
      card_id,
      company_id: companyId,
      type: 'refund',
      amount_minor: restoreAmount,        // positive = credit
      balance_after_minor: newBalance,
      location_id: originalTx.location_id,
      order_id: originalTx.order_id,
      channel: originalTx.channel,
      idempotency_key: refundKey,
      staff_id: staff_id || null,
      note: reason,
    });

  if (txErr) {
    if (txErr.code === '23505') {
      // Race condition on idempotency
      const { data: raceTx } = await platformAdmin
        .from('gift_card_transactions')
        .select('*')
        .eq('card_id', card_id)
        .eq('idempotency_key', refundKey)
        .maybeSingle();
      if (raceTx) {
        return json({
          card_id,
          restored: raceTx.amount_minor,
          balance: raceTx.balance_after_minor,
          status: 'already_reversed',
          idempotent: true,
        });
      }
    }
    return json({ error: `Ledger write failed: ${txErr.message}` }, 500);
  }

  // Update cached balance and status (reactivate if was redeemed)
  const newStatus = newBalance > 0 ? 'active' : card.status;
  await platformAdmin
    .from('gift_cards')
    .update({ balance_minor: newBalance, status: newStatus })
    .eq('id', card_id);

  return json({
    card_id,
    restored: restoreAmount,
    balance: newBalance,
    status: newStatus,
  });
});
