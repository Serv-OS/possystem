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
// the processor's own record of the payment, read server side, and it must:
//   * say the money was taken,
//   * name OUR purchase id (gift-checkout-session puts it in the reference), so a paid
//     payment for another purchase cannot be pointed at this one,
//   * be for at least the purchase amount, in the purchase currency.
// Adyen (29 Oct 2026, v5.11.115): the proof is the adyen_payments ledger row adyen-webhook wrote
// from the HMAC verified AUTHORISATION for merchantReference `gift:<purchase id>` (see
// _shared/giftAdyenRules.js adyenLedgerProvesPurchase). Drop D (29 Oct 2026): Adyen is the only
// processor; the Stripe and Ryft session checks are gone and anything else is refused.
//
// PURE. No imports, so node tests load it directly.

export type PurchaseRow = {
  id: string;
  amount_minor: number | string;
  currency?: string | null;
  processor?: string | null;
};

export type ProofResult = { ok: true } | { ok: false; reason: string };

/**
 * Which processor to ask. Adyen is the only one (29 Oct 2026, Drop D); anything else, including
 * an old Stripe or Ryft purchase or a row with no processor, cannot be verified and is refused.
 */
export function purchaseProcessor(p: { processor?: unknown }): 'adyen' | null {
  const v = typeof p.processor === 'string' ? p.processor.trim().toLowerCase() : '';
  if (v === 'adyen') return 'adyen';
  return null;
}
