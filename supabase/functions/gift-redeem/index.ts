// supabase/functions/gift-redeem/index.ts
//
// Redeem (debit) a gift card. Idempotent via idempotency_key.
//
// Body: { code, amount, order_id, location_id, channel,
//         idempotency_key, staff_id? }
//
// v5.5.197: Company resolution now falls back to looking up the company_id
// from the location_id via the Platform DB locations table. This fixes POS
// devices which authenticate via anonymous auth and have no user_company_roles
// row. Resolution order: user_company_roles → locations.company_id.
//
// Validations:
//   1. Code resolves to active card in caller's org
//   2. Card not expired, not void
//   3. Amount > 0 and <= balance
//   4. Idempotency key not already used (if used, return prior result)

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
  normalizeCode, hmacLookup,
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

  const {
    code, card_id, amount, order_id, location_id, channel, idempotency_key, staff_id,
  } = body as any;

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // v5.5.281: accept either code OR card_id. card_id path is used when the
  // kiosk/online surface already knows the card from loyalty-balance (which
  // returns the card_id) but code_plain might be null.
  if (!code && !card_id) return json({ error: 'code or card_id required' }, 400);
  if (!amount) return json({ error: 'amount required' }, 400);
  if (!idempotency_key) return json({ error: 'idempotency_key required' }, 400);
  if (!channel) return json({ error: 'channel required' }, 400);

  const amountMinor = Math.round(Number(amount));
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return json({ error: 'amount must be positive (minor currency units)' }, 400);
  }

  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('hmac_secret, currency')
    .eq('company_id', companyId)
    .maybeSingle();
  if (!config) return json({ error: 'Gift cards not configured for this org' }, 404);

  // v5.5.286: Two lookup paths — code (HMAC) with card_id fallback.
  // Previously the branches were mutually exclusive: if code was present but
  // its HMAC didn't match (e.g. secret rotation, import mismatch), card_id
  // was never tried, causing "Card not found" on kiosk. Now card_id is always
  // tried as a fallback when the code-based HMAC lookup fails.
  let card: any = null;

  // 1. Try code-based HMAC lookup first (works for manual entry + linked cards)
  if (code) {
    const normalized = normalizeCode(code as string);
    const lookup = await hmacLookup(normalized, config.hmac_secret);
    const { data: found } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('code_lookup', lookup)
      .eq('company_id', companyId)
      .maybeSingle();
    card = found;
    if (!card) {
      console.warn('[gift-redeem] HMAC lookup miss for code; trying card_id fallback');
    }
  }

  // 2. Fallback: direct card_id lookup (reliable — used by kiosk linked cards)
  if (!card && card_id) {
    const { data: found } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('id', card_id)
      .eq('company_id', companyId)
      .maybeSingle();
    card = found;
    if (!card) {
      console.warn('[gift-redeem] card_id lookup miss:', { card_id, companyId });
    }
  }

  // 3. Last resort: match code_plain directly (handles HMAC secret rotation)
  if (!card && code) {
    const normalized = normalizeCode(code as string);
    const { data: found } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('code_plain', normalized)
      .eq('company_id', companyId)
      .maybeSingle();
    card = found;
    if (found) {
      console.warn('[gift-redeem] Matched via code_plain fallback — HMAC may be stale');
    }
  }

  if (!card) {
    console.error('[gift-redeem] Card not found', {
      hasCode: !!code, hasCardId: !!card_id, companyId,
    });
    return json({ error: 'Card not found' }, 404);
  }

  // ── Idempotency check ─────────────────────────────────────────────────
  const { data: existingTx } = await platformAdmin
    .from('gift_card_transactions')
    .select('*')
    .eq('card_id', card.id)
    .eq('idempotency_key', idempotency_key)
    .maybeSingle();

  if (existingTx) {
    return json({
      card_id: card.id,
      applied: Math.abs(existingTx.amount_minor),
      remaining_balance: existingTx.balance_after_minor,
      status: 'already_applied',
      currency: config.currency,
      idempotent: true,
    });
  }

  // ── Status checks ─────────────────────────────────────────────────────
  if (card.status === 'voided') return json({ error: 'Card has been voided' }, 400);
  if (card.status === 'expired') return json({ error: 'Card has expired' }, 400);
  if (card.expires_at && new Date(card.expires_at) < new Date()) {
    await platformAdmin.from('gift_cards').update({ status: 'expired' }).eq('id', card.id);
    return json({ error: 'Card has expired' }, 400);
  }
  if (card.status === 'redeemed') return json({ error: 'Card has zero balance' }, 400);

  // ── Balance check ─────────────────────────────────────────────────────
  if (amountMinor > card.balance_minor) {
    return json({
      error: 'Insufficient balance',
      balance: card.balance_minor,
      requested: amountMinor,
    }, 400);
  }

  // ── Debit ─────────────────────────────────────────────────────────────
  const newBalance = card.balance_minor - amountMinor;
  const newStatus = newBalance === 0 ? 'redeemed' : 'active';

  const { error: txErr } = await platformAdmin
    .from('gift_card_transactions')
    .insert({
      card_id: card.id,
      company_id: companyId,
      type: 'redeem',
      amount_minor: -amountMinor,
      balance_after_minor: newBalance,
      location_id: location_id || null,
      order_id: order_id || null,
      channel,
      idempotency_key,
      staff_id: staff_id || null,
    });

  if (txErr) {
    if (txErr.code === '23505') {
      const { data: raceTx } = await platformAdmin
        .from('gift_card_transactions')
        .select('*')
        .eq('card_id', card.id)
        .eq('idempotency_key', idempotency_key)
        .maybeSingle();
      if (raceTx) {
        return json({
          card_id: card.id,
          applied: Math.abs(raceTx.amount_minor),
          remaining_balance: raceTx.balance_after_minor,
          status: 'already_applied',
          currency: config.currency,
          idempotent: true,
        });
      }
    }
    return json({ error: `Ledger write failed: ${txErr.message}` }, 500);
  }

  const { error: updErr } = await platformAdmin
    .from('gift_cards')
    .update({ balance_minor: newBalance, status: newStatus })
    .eq('id', card.id);

  if (updErr) {
    console.error('[gift-redeem] Balance update failed:', updErr.message);
  }

  return json({
    card_id: card.id,
    applied: amountMinor,
    remaining_balance: newBalance,
    status: newStatus,
    currency: config.currency,
  });
});
