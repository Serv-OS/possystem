// supabase/functions/_shared/giftTill.js
//
// Drop C (v5.11.118, 29 Oct 2026): selling gift cards at the till. The rules gift-load applies
// before it moves any money. PURE, no imports: node tests (src/lib/giftTill.test.js) load it
// directly and the edge function imports it as is.
//
// A venue prints blank physical cards in Back Office (status 'blank', nothing on them). At the
// sale the till either loads money onto one of those (blank -> active), tops up a card that
// already has money on it (active, balance += amount), or has gift-issue print a brand new card.
// Voided, expired and fully spent cards are refused; so is a card of another company, a code of
// the wrong shape, and an amount that is not a positive whole number of minor units.

/** gift_cards.status of a printed card with nothing on it yet. */
export const GIFT_STATUS_BLANK = 'blank';
/** gift_card_transactions.type of money put on a card at the till. */
export const GIFT_TX_LOAD = 'load';
/** gift_cards.source of a card issued by a paired till. */
export const GIFT_SOURCE_POS = 'pos';
/** The ledger channel every till write carries. */
export const GIFT_CHANNEL_POS = 'pos';

/** Strip spaces and dashes, upper case (same as gift-card-utils normalizeCode). */
export function cleanGiftCardCode(s) {
  return typeof s === 'string' ? s.replace(/[\s-]/g, '').toUpperCase() : '';
}

/** 16 letters or digits once spaces and dashes are stripped. Any alphabet: imported cards hold 0, 1, I, O. */
export function isGiftCardCode(s) {
  return /^[A-Z0-9]{16}$/.test(cleanGiftCardCode(s));
}

/** A positive whole number of minor units. */
export function isLoadAmount(amountMinor) {
  return Number.isInteger(amountMinor) && amountMinor > 0;
}

/**
 * May this card take `amountMinor` at the till, and what does that do to it?
 *   card         the gift_cards row (or null when the code found nothing)
 *   amountMinor  whole minor units
 *   opts.companyId  the company the till belongs to; a card of another company is 'other_company'
 *   opts.now        ms since epoch (tests pin it); an active card past expires_at is 'expired'
 * Returns { ok: false, reason, message } or { ok: true, mode: 'activate' | 'topup', balanceAfter }.
 *   reason: 'not_found' | 'other_company' | 'bad_amount' | 'voided' | 'expired' | 'redeemed' | 'bad_status'
 */
export function loadDecision(card, amountMinor, opts = {}) {
  if (!card) return { ok: false, reason: 'not_found', message: 'Card not found' };
  if (opts.companyId != null && card.company_id != null && String(card.company_id) !== String(opts.companyId)) {
    return { ok: false, reason: 'other_company', message: 'Card not found' };
  }
  if (!isLoadAmount(amountMinor)) {
    return { ok: false, reason: 'bad_amount', message: 'Amount must be a positive whole number of minor units' };
  }
  const status = String(card.status || '');
  if (status === 'voided') return { ok: false, reason: 'voided', message: 'This card has been voided' };
  if (status === 'expired') return { ok: false, reason: 'expired', message: 'This card has expired' };
  if (status === 'redeemed') return { ok: false, reason: 'redeemed', message: 'This card has been fully spent and cannot be reloaded' };
  if (status === 'active' && card.expires_at) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const exp = new Date(card.expires_at).getTime();
    if (Number.isFinite(exp) && exp < now) return { ok: false, reason: 'expired', message: 'This card has expired' };
  }
  const balance = Math.max(0, Math.round(Number(card.balance_minor) || 0));
  if (status === GIFT_STATUS_BLANK) return { ok: true, mode: 'activate', balanceAfter: amountMinor };
  if (status === 'active') return { ok: true, mode: 'topup', balanceAfter: balance + amountMinor };
  return { ok: false, reason: 'bad_status', message: `This card cannot be loaded (status ${status || 'unknown'})` };
}

/** The ledger idempotency key of one load: the same check loading the same card is one load. */
export function loadIdempotencyKey(closedCheckId, cardId) {
  return `giftload:${String(closedCheckId)}:${String(cardId)}`;
}

/**
 * Has this check already loaded this card? `rows` are gift_card_transactions of the card.
 * Returns the first 'load' row whose order_id is the check (or whose key is the load key), else null.
 */
export function existingLoad(rows, closedCheckId, cardId) {
  const key = loadIdempotencyKey(closedCheckId, cardId);
  const want = String(closedCheckId);
  for (const r of rows || []) {
    if (!r || r.type !== GIFT_TX_LOAD) continue;
    if (String(r.card_id) !== String(cardId)) continue;
    if (r.idempotency_key === key || String(r.order_id) === want) return r;
  }
  return null;
}

/** The HTTP status gift-load answers a refusal with. */
export function loadRefusalStatus(reason) {
  if (reason === 'not_found' || reason === 'other_company') return 404;
  if (reason === 'bad_amount') return 400;
  return 409;
}

/**
 * The cards a closed check issued or loaded, from its ledger rows joined to their cards.
 * `rows`: gift_card_transactions with order_id = check, type in ('issue','load'), each carrying
 * `gift_cards` (the joined card) or null. One entry per row, newest first by created_at.
 */
export function cardsForCheck(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || (r.type !== 'issue' && r.type !== GIFT_TX_LOAD)) continue;
    const card = r.gift_cards || null;
    out.push({
      card_id: r.card_id,
      code_last4: card?.code_last4 ?? null,
      type: r.type,
      amount_minor: Math.round(Number(r.amount_minor) || 0),
      balance_minor: card ? Math.round(Number(card.balance_minor) || 0) : Math.round(Number(r.balance_after_minor) || 0),
      status: card?.status ?? null,
      created_at: r.created_at ?? null,
    });
  }
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return out;
}
