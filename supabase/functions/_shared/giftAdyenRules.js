// supabase/functions/_shared/giftAdyenRules.js (29 Oct 2026, v5.11.115)
//
// Online gift card purchase on Adyen. PURE, no imports: node tests load it directly and the
// three edge functions (gift-checkout-session, adyen-webhook, gift-fulfill) share one rule.
//
// THE CONTRACT. The purchase id travels as Adyen's merchantReference, `gift:<purchase uuid>`.
// Adyen echoes it on the AUTHORISATION notification (HMAC verified), which is how the webhook
// finds the purchase and how gift-fulfill proves the money was taken: the ledger row our
// webhook wrote for that reference, success true, for at least the purchase amount. No new
// column is needed on gift_card_purchases, so a deploy needs no DDL.

export const GIFT_REF_PREFIX = 'gift:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The merchantReference an online gift purchase pays under. */
export function giftReference(purchaseId) {
  return `${GIFT_REF_PREFIX}${String(purchaseId ?? '').trim()}`;
}

/** The purchase id inside a merchantReference, or null when it is not a gift purchase. */
export function giftPurchaseIdFromReference(reference) {
  const ref = String(reference ?? '').trim();
  if (!ref.startsWith(GIFT_REF_PREFIX)) return null;
  const id = ref.slice(GIFT_REF_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

const cur = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * Does the Adyen ledger row (adyen_payments, written by adyen-webhook from a verified
 * AUTHORISATION) prove this purchase was paid? Same bar as the Stripe and Ryft proofs:
 * money taken, for THIS purchase, at least the amount, in the currency.
 */
export function adyenLedgerProvesPurchase(row, p) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'no_session' };
  if (row.success !== true) return { ok: false, reason: 'not_paid' };
  const code = String(row.last_event_code ?? '').toUpperCase();
  if (code && !['AUTHORISATION', 'CAPTURE'].includes(code)) return { ok: false, reason: 'not_paid' };
  if (giftPurchaseIdFromReference(row.merchant_reference) !== String(p?.id ?? '').toLowerCase()) {
    return { ok: false, reason: 'session_not_for_purchase' };
  }
  const want = Math.round(Number(p.amount_minor));
  const got = Math.round(Number(row.amount_minor));
  if (!Number.isFinite(want) || want <= 0) return { ok: false, reason: 'purchase_amount_invalid' };
  if (!Number.isFinite(got) || got < want) return { ok: false, reason: 'amount_short' };
  const wantCur = cur(p.currency) || 'gbp';
  if (cur(row.currency) && cur(row.currency) !== wantCur) return { ok: false, reason: 'currency_mismatch' };
  return { ok: true };
}

/** The webhook's amount fence: never issue a card worth more than Adyen authorised. */
export function adyenGiftAmountOk(authorisedMinor, purchaseMinor) {
  const got = Math.round(Number(authorisedMinor));
  const want = Math.round(Number(purchaseMinor));
  return Number.isFinite(got) && Number.isFinite(want) && want > 0 && got >= want;
}
