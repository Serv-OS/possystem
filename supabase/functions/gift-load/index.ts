// supabase/functions/gift-load/index.ts
//
// v5.11.118 (Drop C, 29 Oct 2026): put money on a gift card at the till.
//
// A venue prints blank physical cards in Back Office (gift-bulk-create { blank: true }: status
// 'blank', nothing on them). After a paid "Gift card £X" sale the till scans or types the card's
// code and calls this. A blank card becomes active with the amount; a card that already has money
// on it is topped up. One 'load' ledger row per load, channel 'pos', order_id = the closed check.
//
// Body:
//   { action?: 'load' | 'status', code?, amount_minor?, location_id, closed_check_id, staff_id? }
//   load (default): { code, amount_minor, location_id, closed_check_id, staff_id? }
//     -> { ok: true, card_id, code_last4, balance_minor, loaded_minor, topped_up, already? }
//   status: { closed_check_id, location_id }
//     -> { ok: true, cards: [{ card_id, code_last4, type: 'issue' | 'load', amount_minor, balance_minor }] }
//
// Who: staff, or a device BOUND to the venue (_shared/gift-authority.ts decideGiftTillAuthority,
// the same arm as gift-reverse-redeem). The gate comes before any card is read.
//
// Rules (pure, node tested): _shared/giftTill.js loadDecision. Refusals: a code of the wrong shape
// 400; a card not found, or of another company, 404 'Card not found'; voided / expired / fully
// spent 409 with a plain message.
//
// IDEMPOTENT on closed_check_id + card. The ledger row is the claim: its idempotency_key is
// giftload:<closed_check_id>:<card_id> and (card_id, idempotency_key) is unique, so two tills (or
// one retry) loading the same card for the same check write ONE row; the loser reads the winner's
// row and answers { ok, already: true } with the first result. The balance moves by compare and
// swap after the claim, and the claim is taken back if the balance did not move.

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyForLocation,
  normalizeCode, hmacLookup,
} from '../_shared/gift-card-utils.ts';
import { callerStaffOrDevice, recordAuthority, deviceHintOf } from '../_shared/loyalty-utils.ts';
import { decideGiftTillAuthority } from '../_shared/gift-authority.ts';
import { authorityLogRow } from '../_shared/loyalty-authority.ts';
import {
  loadDecision, isGiftCardCode, loadIdempotencyKey, existingLoad, loadRefusalStatus, cardsForCheck,
  GIFT_TX_LOAD, GIFT_CHANNEL_POS,
} from '../_shared/giftTill.js';

const loadReply = (card: any, tx: any, already: boolean) => json({
  ok: true,
  card_id: card.id,
  code_last4: card.code_last4 ?? null,
  balance_minor: Number(tx.balance_after_minor),
  loaded_minor: Number(tx.amount_minor),
  topped_up: tx.note === 'topup',
  ...(already ? { already: true } : {}),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const action = (body.action as string) || 'load';
  if (action !== 'load' && action !== 'status') return json({ error: 'action must be load or status' }, 400);
  const location_id = (body.location_id as string) || null;
  const closedCheckId = body.closed_check_id == null ? '' : String(body.closed_check_id).trim();
  const staff_id = (body.staff_id as string) || null;
  if (!location_id) return json({ error: 'location_id required' }, 400);
  if (!closedCheckId) return json({ error: 'closed_check_id required' }, 400);

  const companyResult = await resolveCompanyForLocation(caller.id, location_id);
  if (companyResult instanceof Response) return companyResult;
  const companyId = String(companyResult);

  // ── The gate, before any card is read ───────────────────────────────────
  const who = await callerStaffOrDevice(caller, location_id, companyId);
  const authority = decideGiftTillAuthority({ user: caller, staff: who.staff, device: who.device, deviceReason: who.deviceReason }, 'load gift cards');
  if (!authority.ok) {
    recordAuthority(authorityLogRow({
      fn: 'gift-load', mode: 'enforce', outcome: 'refused',
      decision: { ok: false, reason: authority.reason, callerKind: caller?.is_anonymous ? (who.deviceReason === 'other_venue' || who.deviceReason === 'not_bound' ? 'device_other' : 'anonymous') : 'user_no_access' },
      user: caller, companyId, locationId: location_id, closedCheckId: closedCheckId, channel: GIFT_CHANNEL_POS,
      deviceHint: deviceHintOf(body), detail: { device_reason: who.deviceReason, action },
    }));
    return json({ error: authority.error, code: 'gift_till_not_allowed', reason: authority.reason }, authority.status);
  }

  // ── status: the cards this check issued or loaded ───────────────────────
  if (action === 'status') {
    const { data, error } = await platformAdmin
      .from('gift_card_transactions')
      .select('card_id, type, amount_minor, balance_after_minor, created_at, gift_cards!inner(id, code_last4, balance_minor, status, company_id)')
      .eq('company_id', companyId)
      .eq('order_id', closedCheckId)
      .in('type', ['issue', GIFT_TX_LOAD])
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return json({ error: `Could not read the check's gift cards: ${error.message}` }, 500);
    const rows = (data || []).filter((r: any) => !r.gift_cards || String(r.gift_cards.company_id) === companyId);
    return json({ ok: true, closed_check_id: closedCheckId, cards: cardsForCheck(rows) });
  }

  // ── load ────────────────────────────────────────────────────────────────
  const code = body.code;
  if (!isGiftCardCode(code)) return json({ error: 'Enter the full 16 character gift card code.', code: 'bad_code' }, 400);
  const amountMinor = Math.round(Number(body.amount_minor));
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return json({ error: 'amount_minor must be a positive whole number of minor units', code: 'bad_amount' }, 400);
  }

  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('hmac_secret, currency, max_card_value_minor')
    .eq('company_id', companyId)
    .maybeSingle();
  if (!config) return json({ error: 'Gift cards not configured for this org' }, 404);

  // Find the card by its code, within this company only (HMAC first, code_plain second, as
  // gift-lookup and gift-redeem do). A card of another company is simply not found.
  const normalized = normalizeCode(code as string);
  const lookup = await hmacLookup(normalized, config.hmac_secret);
  let { data: card } = await platformAdmin
    .from('gift_cards')
    .select('*')
    .eq('code_lookup', lookup)
    .eq('company_id', companyId)
    .maybeSingle();
  if (!card) {
    ({ data: card } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('code_plain', normalized)
      .eq('company_id', companyId)
      .maybeSingle());
  }
  if (!card) return json({ error: 'Card not found', code: 'not_found' }, 404);

  // ── Already loaded for this check? Answer with the first result, move nothing ──
  const idemKey = loadIdempotencyKey(closedCheckId, card.id);
  // Every load row of this card (a card takes a handful in its life); existingLoad picks the one
  // for this check. Read this way so the check id never lands inside a PostgREST filter string.
  const priorRows = async () => {
    const { data } = await platformAdmin
      .from('gift_card_transactions')
      .select('*')
      .eq('card_id', card.id)
      .eq('type', GIFT_TX_LOAD)
      .order('created_at', { ascending: true })
      .limit(200);
    return data || [];
  };
  const prior = existingLoad(await priorRows(), closedCheckId, card.id);
  if (prior) return loadReply(card, prior, true);

  // ── The rules ───────────────────────────────────────────────────────────
  const decision = loadDecision(card, amountMinor, { companyId });
  if (!decision.ok) {
    if (decision.reason === 'expired' && card.status === 'active') {
      await platformAdmin.from('gift_cards').update({ status: 'expired' }).eq('id', card.id);
    }
    return json({ error: decision.message, code: decision.reason }, loadRefusalStatus(decision.reason));
  }
  const maxMinor = Number(config.max_card_value_minor);
  if (Number.isFinite(maxMinor) && maxMinor > 0 && decision.balanceAfter > maxMinor) {
    return json({ error: `That would put more than the card maximum (${maxMinor} minor units) on the card`, code: 'over_max' }, 409);
  }

  // ── The claim: the load row goes in first ───────────────────────────────
  const { data: claim, error: txErr } = await platformAdmin
    .from('gift_card_transactions')
    .insert({
      card_id: card.id,
      company_id: companyId,
      type: GIFT_TX_LOAD,
      amount_minor: amountMinor,
      balance_after_minor: decision.balanceAfter,
      location_id,
      order_id: closedCheckId,
      channel: GIFT_CHANNEL_POS,
      idempotency_key: idemKey,
      staff_id,
      note: decision.mode,   // 'activate' | 'topup'
    })
    .select('*')
    .single();
  if (txErr || !claim) {
    if (txErr?.code === '23505') {
      const race = existingLoad(await priorRows(), closedCheckId, card.id);
      if (race) return loadReply(card, race, true);
    }
    return json({ error: `Ledger write failed: ${txErr?.message || 'no row'}` }, 500);
  }

  // ── Move the balance by compare and swap ────────────────────────────────
  const nowIso = new Date().toISOString();
  let moved: any = null;
  for (let attempt = 0; attempt < 5 && !moved; attempt++) {
    const { data: cur } = await platformAdmin
      .from('gift_cards')
      .select('balance_minor, status, initial_amount_minor')
      .eq('id', card.id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!cur) break;
    const again = loadDecision({ ...card, ...cur }, amountMinor, { companyId });
    if (!again.ok) break;
    const patch: Record<string, unknown> = {
      balance_minor: again.balanceAfter,
      status: 'active',
      updated_at: nowIso,
    };
    if (again.mode === 'activate') {
      patch.initial_amount_minor = amountMinor;
      patch.issued_at = nowIso;
      patch.issued_at_location_id = location_id;
      if (staff_id) patch.issued_by_staff_id = staff_id;
    }
    const { data: rows } = await platformAdmin
      .from('gift_cards')
      .update(patch)
      .eq('id', card.id)
      .eq('balance_minor', cur.balance_minor)
      .eq('status', cur.status)
      .select('id, code_last4, balance_minor, status');
    if (rows?.length) {
      moved = rows[0];
      if (again.balanceAfter !== Number(claim.balance_after_minor) || again.mode !== claim.note) {
        await platformAdmin.from('gift_card_transactions')
          .update({ balance_after_minor: again.balanceAfter, note: again.mode })
          .eq('id', claim.id);
        claim.balance_after_minor = again.balanceAfter;
        claim.note = again.mode;
      }
    }
  }

  if (!moved) {
    // The balance did not move: take the claim back so a retry can do the whole job.
    await platformAdmin.from('gift_card_transactions').delete().eq('id', claim.id);
    return json({ error: 'The card was busy or changed; nothing was loaded. Try again.', code: 'gift_load_retry' }, 409);
  }

  return loadReply(moved, claim, false);
});
