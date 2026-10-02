// src/lib/payments/refundProcessorLabel.js
//
// Which processor the till's refund screen names ("Return to card · Processed via ...").
//
// v5.6.78 stopped the screen saying "Stripe Terminal" on every check and named the check's
// processor instead. 30 Sep 2026 (Coffee Boy Barnsley, R3127): a kiosk sale on an Adyen card
// machine was written with no processor, so closed_checks.processor took its column DEFAULT,
// 'stripe', and the screen said "via Stripe Terminal" on an Adyen venue's sale.
//
// The rule now: the processor of the card leg the refund will actually reverse
// (refundMath.cardLegsOf, via useRefundCardLegs, which re-reads the row when the till's copy
// has none). With no card leg the check's own processor is named only when something wrote it
// on purpose: 'stripe' is the column default, so on a check with no card leg it proves nothing,
// and the screen says "the card terminal".
//
// Pure: no imports, testable in Node.

export const PROCESSOR_NAME = Object.freeze({ stripe: 'Stripe Terminal', ryft: 'Ryft', adyen: 'ServOS Payments' });

/** 'stripe' | 'ryft' | 'adyen' | ... , or null when the check does not prove one. */
export function refundProcessor(check, legs) {
  const leg = (Array.isArray(legs) ? legs : []).find((l) => l && l.processor);
  if (leg) return String(leg.processor).toLowerCase();
  const p = String(check?.processor || '').toLowerCase();
  if (p && p !== 'stripe' && PROCESSOR_NAME[p]) return p;
  return null;
}

/** The processor's display name, or null when it is not known. */
export function refundProcessorName(check, legs) {
  const p = refundProcessor(check, legs);
  return p ? (PROCESSOR_NAME[p] || p) : null;
}

/** "Processed via ServOS Payments", or "Processed on the card terminal" when not known. */
export function processorLabel(check, legs) {
  const name = refundProcessorName(check, legs);
  return name ? `Processed via ${name}` : 'Processed on the card terminal';
}
