// supabase/functions/_shared/giftPurchaseProof.ts
//
// Has an online gift card purchase really been paid? Asked of the PROCESSOR, never of our own row.
//
// WHY (18 Sep 2026, round three). gift-fulfill issued a card for any purchase_id it was handed,
// paid or not, and returned the code. gift-checkout-session hands the purchase_id out before any
// payment, so a customer could start a purchase, never pay, call gift-fulfill and spend the card.
// Worse, gift_card_purchases is writable with the Platform anon key today (its
// gift_card_purchases_service policy is FOR ALL TO public USING (true), see
// 000_baseline_platform.sql; Platform file C of the stage 1 fence, 20260919c, closes it), so
// status, amount_minor and the session ids on the row can be forged until then. The row is therefore NEVER the proof. The proof is
// the processor's own record of the payment session, fetched server side by id, and it must:
//   * say the money was taken (Stripe checkout session payment_status 'paid'; Ryft payment
//     session status 'Captured'),
//   * carry OUR purchase id in its metadata (gift-checkout-session puts it there), so a paid
//     session for another purchase cannot be pointed at this one,
//   * be for at least the purchase amount, in the purchase currency.
// Adyen: there is no online gift card purchase flow on Adyen (gift-checkout-session sells through
// Stripe Checkout or the Ryft embedded page only), so an 'adyen' or unknown processor is refused
// as unverifiable rather than trusted.
//
// PURE. No imports, so node tests load it directly.

export type PurchaseRow = {
  id: string;
  amount_minor: number | string;
  currency?: string | null;
  processor?: string | null;
};

export type ProofResult = { ok: true } | { ok: false; reason: string };

const cur = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function amountAndCurrency(paidMinor: unknown, paidCurrency: unknown, p: PurchaseRow): ProofResult {
  const want = Math.round(Number(p.amount_minor));
  const got = Math.round(Number(paidMinor));
  if (!Number.isFinite(want) || want <= 0) return { ok: false, reason: 'purchase_amount_invalid' };
  if (!Number.isFinite(got) || got < want) return { ok: false, reason: 'amount_short' };
  const wantCur = cur(p.currency) || 'gbp';
  if (cur(paidCurrency) && cur(paidCurrency) !== wantCur) return { ok: false, reason: 'currency_mismatch' };
  return { ok: true };
}

/** A Stripe Checkout Session (retrieved on the merchant's connected account). */
export function stripeSessionProvesPurchase(session: any, p: PurchaseRow): ProofResult {
  if (!session || typeof session !== 'object') return { ok: false, reason: 'no_session' };
  if (session.payment_status !== 'paid') return { ok: false, reason: 'not_paid' };
  if (session.metadata?.purchase_id !== p.id) return { ok: false, reason: 'session_not_for_purchase' };
  return amountAndCurrency(session.amount_total, session.currency, p);
}

/** A Ryft payment session (retrieved on the venue's sub account). */
export function ryftSessionProvesPurchase(ps: any, p: PurchaseRow): ProofResult {
  if (!ps || typeof ps !== 'object') return { ok: false, reason: 'no_session' };
  if (ps.status !== 'Captured') return { ok: false, reason: 'not_paid' };
  if (ps.metadata?.purchase_id !== p.id) return { ok: false, reason: 'session_not_for_purchase' };
  return amountAndCurrency(ps.amount, ps.currency, p);
}

/** Which processor to ask. Anything else cannot be verified and is refused. */
export function purchaseProcessor(p: { processor?: unknown }): 'stripe' | 'ryft' | null {
  const v = typeof p.processor === 'string' ? p.processor.trim().toLowerCase() : 'stripe';
  if (v === '' || v === 'stripe') return 'stripe';
  if (v === 'ryft') return 'ryft';
  return null;
}
