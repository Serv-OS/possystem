// supabase/functions/gift-redeem/index.ts
//
// Redeem (debit) a gift card. Idempotent via idempotency_key.
//
// Body: { code, amount, order_id, location_id, channel,
//         idempotency_key, closed_check_id?, staff_id? }
//
// v5.5.901: optional `closed_check_id`. When present the idempotency key is DERIVED
// server-side as `giftcommit:<closed_check_id>:<card_id>` and the caller's
// idempotency_key is ignored — the same pattern loyalty-redeem uses
// (`redeem:<closed_check_id>:<reward_id>`). Kiosk + online now debit the card at ORDER
// COMMIT rather than at apply time, so a retry of that commit MUST NOT debit twice even
// if the client mints a fresh key. Callers that don't send closed_check_id (POS checkout,
// split payments) are completely unaffected — they keep their own key.
// NOTE: this deliberately keys on the CHECK id, never on order_id — the POS passes a
// table_id as order_id, which is reused for every order that table ever takes.
//
// v5.5.197: Company resolution now falls back to looking up the company_id
// from the location_id via the Platform DB locations table. This fixes POS
// devices which authenticate via anonymous auth and have no user_company_roles
// row. Resolution order: user_company_roles → locations.company_id.
//
// 18 Sep 2026 (enforced now): lookup order is HMAC, code_plain, THEN card_id. A card found by
// its code is proof of possession and needs nothing more. A card found by card_id alone needs
// staff with the location, a claimed device of the company, or `member_token` (the loyalty
// session token) whose proven phone the card is addressed to. Anything else is 403
// { code: 'gift_card_code_required' } and a caller_authority_log row. _shared/gift-authority.ts.
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
import { callerIsStaffFor, callerDeviceCompany, recordAuthority, OTP_SECRET, deviceHintOf } from '../_shared/loyalty-utils.ts';
import { verifySessionToken } from '../_shared/loyalty-session.ts';
import { decideGiftCardIdAuthority } from '../_shared/gift-authority.ts';
import { cardBelongsToPhone } from '../_shared/giftCardMatch.ts';
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

  const {
    code, card_id, amount, order_id, location_id, channel, idempotency_key,
    closed_check_id, staff_id,
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
  if (!idempotency_key && !closed_check_id) {
    return json({ error: 'idempotency_key required' }, 400);
  }
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
  // 18 Sep 2026: a card found by its CODE is proof of possession. A card found by card_id alone
  // is not, and needs authority (below). Order: HMAC, then code_plain, THEN card_id, so a code
  // that resolves is never mistaken for a card_id spend.
  let provedByCode = false;

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
      console.warn('[gift-redeem] HMAC lookup miss for code; trying code_plain');
    }
  }

  // 2. match code_plain directly (handles HMAC secret rotation). Was step 3; it now runs before
  // the card_id step so a code that resolves counts as the proof it is.
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
      console.warn('[gift-redeem] Matched via code_plain fallback: HMAC may be stale');
    }
  }
  if (card) provedByCode = true;

  // 3. Last resort: direct card_id lookup (kiosk linked cards, which may have no stored code).
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

  if (!card) {
    console.error('[gift-redeem] Card not found', {
      hasCode: !!code, hasCardId: !!card_id, companyId,
    });
    return json({ error: 'Card not found' }, 404);
  }

  // ── Idempotency key ───────────────────────────────────────────────────
  // v5.5.901: a commit-time caller (kiosk/online) supplies the closed-check id; the key is
  // then DERIVED from it, so every retry of that commit collapses onto one debit no matter
  // what key the client sent. Everyone else keeps their own key (unchanged behaviour).
  const idemKey = closed_check_id
    ? `giftcommit:${closed_check_id}:${card.id}`
    : idempotency_key;

  // ── Idempotency check ─────────────────────────────────────────────────
  const { data: existingTx } = await platformAdmin
    .from('gift_card_transactions')
    .select('*')
    .eq('card_id', card.id)
    .eq('idempotency_key', idemKey)
    .maybeSingle();

  if (existingTx) {
    return json({
      card_id: card.id,
      applied: Math.abs(existingTx.amount_minor),
      remaining_balance: existingTx.balance_after_minor,
      status: 'already_applied',
      currency: config.currency,
      // v5.5.901: the key the ledger row actually carries — gift-reverse-redeem needs the
      // EXACT key to find the transaction, and a commit-time caller's key was derived here.
      idempotency_key: idemKey,
      idempotent: true,
    });
  }

  // ── Authority for a card_id spend (18 Sep 2026, enforced now) ──────────
  // Spending by card_id used to need nothing but a session (an anonymous one is free), and
  // gift-lookup's name and email search handed card ids out. Now a card NOT proved by its code
  // may only be spent by staff with the location, a claimed device of this company, or the
  // member whose PROVEN phone (loyalty session token) the card is addressed to: the kiosk
  // spending a card it listed after the one time code. See _shared/gift-authority.ts.
  // Round three: this runs AFTER the idempotency check above. A retry of a debit that already
  // landed (a till whose claim lapsed, a member token that expired in between) is answered with
  // the debit it already made; it moves no money, so it needs no fresh authority, and refusing
  // it would strand an order whose card was really charged.
  if (!provedByCode) {
    const memberToken = (body as any).member_token;
    const memberTokenSent = typeof memberToken === 'string' && memberToken.length > 0;
    const memberSession = memberTokenSent ? await verifySessionToken(memberToken, OTP_SECRET) : null;
    const staff = await callerIsStaffFor(caller, (location_id as string) || null, companyId);
    const deviceCompanyId = staff ? null : await callerDeviceCompany(caller.id);
    const authority = decideGiftCardIdAuthority({
      user: caller,
      staff,
      deviceCompanyId,
      companyId: String(companyId),
      memberTokenSent,
      memberSession,
      cardOnMemberPhone: !!memberSession && cardBelongsToPhone(card, memberSession.phone),
    });
    if (!authority.ok) {
      recordAuthority(authorityLogRow({
        fn: 'gift-redeem', mode: 'enforce', outcome: 'refused',
        decision: { ok: false, reason: authority.reason, callerKind: memberTokenSent ? 'member' : (caller?.is_anonymous ? 'anonymous' : 'user_no_access') },
        user: caller, companyId, locationId: location_id, closedCheckId: closed_check_id, channel,
        deviceHint: deviceHintOf(body),
        detail: { card_last4: card.code_last4 ?? null },
      }));
      return json({ error: authority.error, code: 'gift_card_code_required' }, authority.status);
    }
  }

  // ── Status checks ─────────────────────────────────────────────────────
  if (card.status === 'voided') return json({ error: 'Card has been voided' }, 400);
  if (card.status === 'expired') return json({ error: 'Card has expired' }, 400);
  if (card.expires_at && new Date(card.expires_at) < new Date()) {
    await platformAdmin.from('gift_cards').update({ status: 'expired' }).eq('id', card.id);
    return json({ error: 'Card has expired' }, 400);
  }
  if (card.status === 'redeemed') return json({ error: 'Card has zero balance' }, 400);

  // ── Atomic debit (v5.5.314) ───────────────────────────────────────────
  // Idempotency check + balance check + decrement + ledger insert all happen
  // inside ONE transaction (redeem_gift_card_atomic). The conditional UPDATE's
  // row lock serializes concurrent redemptions of the same card, so two
  // terminals can no longer both pass a stale balance check and overspend it.
  const { data: rpcRes, error: rpcErr } = await platformAdmin.rpc('redeem_gift_card_atomic', {
    p_card_id: card.id,
    p_company_id: companyId,
    p_amount_minor: amountMinor,
    p_idempotency_key: idemKey,
    p_location_id: location_id || null,
    p_order_id: order_id || closed_check_id || null,
    p_channel: channel,
    p_staff_id: staff_id || null,
  });

  if (rpcErr) {
    console.error('[gift-redeem] atomic redeem failed:', rpcErr.message);
    return json({ error: `Redeem failed: ${rpcErr.message}` }, 500);
  }

  const result = rpcRes || {};
  if (result.status === 'insufficient') {
    return json({ error: 'Insufficient balance', balance: card.balance_minor, requested: amountMinor }, 400);
  }
  if (result.status === 'already_applied') {
    return json({
      card_id: card.id,
      applied: result.applied ?? amountMinor,
      remaining_balance: result.balance_after_minor,
      status: 'already_applied',
      currency: config.currency,
      idempotency_key: idemKey,
      idempotent: true,
    });
  }
  // status === 'ok'
  return json({
    card_id: card.id,
    applied: result.applied ?? amountMinor,
    remaining_balance: result.balance_after_minor,
    status: result.new_status || 'active',
    currency: config.currency,
    idempotency_key: idemKey,
  });
});
