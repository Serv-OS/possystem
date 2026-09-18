// supabase/functions/gift-reverse-redeem/index.ts
//
// Reverse a prior redemption. Restores the debited amount back to the card.
// Used when a POS order is refunded (store.refundCheck) or a card machine job that already took
// the gift card dies (CheckoutModal / store._reverseTerminalJobGift). Online and kiosk never call
// it (lib/giftCommit.js).
//
// Body: { card_id, original_idempotency_key, reason, staff_id?, location_id, device_hint? }
//
// 18 Sep 2026 (round three, enforced now): any session could call this, and the key of a spend
// (giftcommit:<check>:<card>) is known to the customer who made it. So a card could be spent on
// an order and then refilled, for ever. Now:
//   * only staff for the location (the database's access rule, _shared/staffAccess.ts) or a
//     claimed device of the card's company may reverse (_shared/gift-authority.ts
//     decideGiftReverseAuthority). Refusals are logged in caller_authority_log.
//   * once per spend: the refund row (refund:<original key>, unique per card) is written FIRST, as
//     the claim, before the balance moves. A second call, or a race of two, gets
//     'already_reversed' and moves nothing.
//   * the balance moves by compare and swap, so a spend landing at the same moment is never
//     overwritten. If the balance cannot be moved the claim row is removed so a retry can finish.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
} from '../_shared/gift-card-utils.ts';
import { callerIsStaffFor, callerDeviceCompany, recordAuthority, deviceHintOf } from '../_shared/loyalty-utils.ts';
import { decideGiftReverseAuthority } from '../_shared/gift-authority.ts';
import { authorityLogRow } from '../_shared/loyalty-authority.ts';

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

  // ── Who may put a spend back (round three, enforced now) ───────────────
  // Before anything is read: staff for the location, or a claimed device of this company.
  const staff = await callerIsStaffFor(caller, (body.location_id as string) || null, companyId);
  const deviceCompanyId = staff ? null : await callerDeviceCompany(caller.id);
  const authority = decideGiftReverseAuthority({ user: caller, staff, deviceCompanyId, companyId: String(companyId) });
  if (!authority.ok) {
    recordAuthority(authorityLogRow({
      fn: 'gift-reverse-redeem', mode: 'enforce', outcome: 'refused',
      decision: { ok: false, reason: authority.reason, callerKind: caller?.is_anonymous ? (deviceCompanyId ? 'device_other' : 'anonymous') : 'user_no_access' },
      user: caller, companyId, locationId: body.location_id, channel: body.channel ?? null,
      deviceHint: deviceHintOf(body),
    }));
    return json({ error: authority.error, code: 'gift_reverse_not_allowed', reason: authority.reason }, authority.status);
  }

  // Find the original redeem transaction (this company's only)
  const { data: originalTx } = await platformAdmin
    .from('gift_card_transactions')
    .select('*')
    .eq('card_id', card_id)
    .eq('company_id', companyId)
    .eq('idempotency_key', original_idempotency_key)
    .eq('type', 'redeem')
    .maybeSingle();

  if (!originalTx) {
    return json({ error: 'Original redemption not found for this card and idempotency key' }, 404);
  }

  const refundKey = `refund:${original_idempotency_key}`;
  const alreadyReversed = async () => {
    const { data: tx } = await platformAdmin
      .from('gift_card_transactions')
      .select('*')
      .eq('card_id', card_id)
      .eq('idempotency_key', refundKey)
      .maybeSingle();
    return tx;
  };

  // Check if already reversed (idempotency on reverse)
  const existingRefund = await alreadyReversed();
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

  // ── The claim: the refund row goes in FIRST ─────────────────────────────
  // (card_id, idempotency_key) is unique, so exactly one reversal of this spend can ever write
  // it. balance_after is provisional here and corrected once the balance has moved.
  const { data: claim, error: txErr } = await platformAdmin
    .from('gift_card_transactions')
    .insert({
      card_id,
      company_id: companyId,
      type: 'refund',
      amount_minor: restoreAmount,        // positive = credit
      balance_after_minor: Number(card.balance_minor) + restoreAmount,
      location_id: originalTx.location_id,
      order_id: originalTx.order_id,
      channel: originalTx.channel,
      idempotency_key: refundKey,
      staff_id: staff_id || null,
      note: reason,
    })
    .select('id')
    .single();

  if (txErr || !claim) {
    if (txErr?.code === '23505') {
      // A concurrent reversal of the same spend won the claim.
      const raceTx = await alreadyReversed();
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
    return json({ error: `Ledger write failed: ${txErr?.message || 'no row'}` }, 500);
  }

  // ── Move the balance by compare and swap ───────────────────────────────
  let newBalance: number | null = null;
  let newStatus: string | null = null;
  for (let attempt = 0; attempt < 5 && newBalance === null; attempt++) {
    const { data: cur } = await platformAdmin
      .from('gift_cards')
      .select('balance_minor, status')
      .eq('id', card_id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!cur || cur.status === 'voided') break;
    const nb = Number(cur.balance_minor) + restoreAmount;
    const ns = nb > 0 ? 'active' : cur.status;
    const { data: moved } = await platformAdmin
      .from('gift_cards')
      .update({ balance_minor: nb, status: ns })
      .eq('id', card_id)
      .eq('balance_minor', cur.balance_minor)
      .select('id');
    if (moved?.length) { newBalance = nb; newStatus = ns; }
  }

  if (newBalance === null) {
    // The balance did not move: take the claim back so a retry can do the whole job.
    await platformAdmin.from('gift_card_transactions').delete().eq('id', claim.id);
    return json({ error: 'The card was busy; nothing was changed. Try again.', code: 'gift_reverse_retry' }, 409);
  }

  await platformAdmin
    .from('gift_card_transactions')
    .update({ balance_after_minor: newBalance })
    .eq('id', claim.id);

  return json({
    card_id,
    restored: restoreAmount,
    balance: newBalance,
    status: newStatus,
  });
});
