// supabase/functions/_shared/giftFulfilPlan.ts
//
// One card per online gift card purchase, and a paid purchase is never dropped because a card
// processor was briefly down.
//
// WHY (18 Sep 2026, lockdown step 1, review round three item e).
//   1. gift-fulfill claims a purchase ('fulfilling') before issuing and lets a claim older than
//      10 minutes be taken over. An isolate killed between inserting the card and marking the
//      purchase fulfilled left a live card that nothing pointed at; the takeover then issued a
//      SECOND card for the same money. Now the card's id is DERIVED from the purchase id
//      (purchaseCardId), so the database's primary key allows exactly one card per purchase: a
//      retry, a takeover or a racing Back Office "Fulfill" finds the card already there and
//      finishes the job with it (the same code, the same ledger row) instead of issuing again.
//      The issue ledger row carries issueLedgerKey(purchase), so it is written once too.
//   2. A short Stripe or Ryft outage made gift-fulfill answer 402 "payment not proven" for a paid
//      purchase, the webhooks swallowed it and answered 200, and nobody retried: the customer paid
//      and got no card. Now an outage (network error, processor 5xx or 429) is a 503 with
//      retryable: true, and the webhooks answer the processor with a non 2xx for any retryable
//      failure (fulfilResponseRetryable) and let the retried event through their duplicate check,
//      so Stripe (up to 3 days) and Ryft (0, 1, 5, 10, 10, 10 minutes) deliver it again. A real
//      "not paid" stays a final 402. Back Office "Fulfill" remains the manual backstop.
//
// PURE. No imports (Web Crypto is global in Deno and in node 20), so node tests load it directly.

/** A uuid derived from the purchase id: the same purchase always names the same card. */
export async function purchaseCardId(purchaseId: string): Promise<string> {
  const data = new TextEncoder().encode(`servos:gift-purchase-card:${String(purchaseId)}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;   // version 5 style (name based)
  h[8] = (h[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const x = Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The idempotency key of the purchase's one 'issue' ledger row. */
export function issueLedgerKey(purchaseId: string): string {
  return `issue:purchase:${String(purchaseId)}`;
}

/**
 * Did the processor check fail because the processor could not be asked (retry later), rather
 * than because it said the money was not taken (final)?
 */
export function proofReasonRetryable(reason: string | null | undefined): boolean {
  const r = String(reason || '');
  if (r === 'processor_unreachable') return true;
  const m = /^ryft_(\d+)$/.exec(r);
  if (m) {
    const s = Number(m[1]);
    return s === 0 || s === 408 || s === 429 || s >= 500;
  }
  return false;
}

/**
 * A thrown processor SDK error: an outage (retry) or a refusal about THIS request (final)?
 * Stripe errors carry `type` and `statusCode`; a bare network failure carries neither.
 */
export function processorErrorReason(e: any): 'processor_unreachable' | 'processor_rejected' {
  const status = Number(e?.statusCode ?? e?.status ?? 0);
  const type = String(e?.type || '');
  if (type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError') return 'processor_unreachable';
  if (status === 429 || status >= 500) return 'processor_unreachable';
  if (status >= 400 && status < 500) return 'processor_rejected';
  if (type === 'StripeInvalidRequestError' || type === 'StripeAuthenticationError' || type === 'StripePermissionError') return 'processor_rejected';
  return 'processor_unreachable';
}

/**
 * Should the webhook make the processor send this event again? True for gift-fulfill answers that
 * a later attempt can turn into a card: a server error or outage (5xx), a claim another attempt
 * holds (409, taken over after 10 minutes), or an explicit retryable flag. A network failure
 * calling gift-fulfill is passed as status 0. Final answers (issued, already fulfilled, not paid,
 * not found, not allowed) are false.
 */
export function fulfilResponseRetryable(status: number, body: any): boolean {
  if (body && body.retryable === true) return true;
  if (!status) return true;
  if (status >= 500) return true;
  if (status === 409 && body?.code === 'fulfil_in_progress') return true;
  return false;
}
