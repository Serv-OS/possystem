/**
 * refundSplit.js: where a refund's money goes (gift cards, then card legs). Pure, no I/O.
 *
 * v5.11.81 (round 1 fix): this was inline in store.refundCheck. It lives here so the parity tests
 * run the very code the store runs:
 *   - a PART refund gives each gift card that paid its share (giftPartRefundPlan); a full refund
 *     puts back whatever is left on every gift card (the store's own path) and asks no share here;
 *   - the card legs get the rest, each capped at what it took less what earlier refunds took
 *     (allocateToLegs), so a card never gives back more than it was paid;
 *   - the operator's per leg picks never add up to more than the card's share (capLegPicks): with
 *     two card legs and a gift card, a part refund of 10.00 sent 5.00 to the gift card and 10.00 to
 *     the cards (15.00 out for 10.00);
 *   - a cash payout hands it all back from the drawer: no gift share, no card legs.
 */
import { allocateToLegs, legRefundedMinor, capLegPicks, toMinor } from './refundMath.js';
import { giftPartRefundPlan } from '../giftCommit.js';

/**
 * @param {object} p
 * @param {object} p.check        the check BEFORE this refund
 * @param {number} p.amount       the refund's money in pounds (refundBreakdown(...).amount)
 * @param {boolean} p.isFullRefund
 * @param {boolean} p.cashPayout
 * @param {Array} p.legs          cardLegsOf / resolveRefundCardLegs legs
 * @param {object|null} p.legRefunds  the operator's per leg picks { legId: minor }, or null
 * @returns {{ giftPart: { legs: Array, totalMinor: number }, cardTargetMinor: number, allocations: Array, alreadyByLeg: object }}
 */
export function refundMoneySplit({ check, amount, isFullRefund = false, cashPayout = false, legs = [], legRefunds = null }) {
  const amountMinor = toMinor(amount);
  const giftPart = (!isFullRefund && !cashPayout) ? giftPartRefundPlan(check, amountMinor) : { legs: [], totalMinor: 0 };
  const alreadyByLeg = legRefundedMinor(check);   // BEFORE this refund's own entry
  const list = Array.isArray(legs) ? legs : [];
  const cardCapMinor = list.reduce(
    (s, l) => s + (l.amountMinor == null ? Infinity : Math.max(0, l.amountMinor - (alreadyByLeg[l.id] || 0))),
    0,
  );
  const wantMinor = Math.max(0, amountMinor - giftPart.totalMinor);
  const cardTargetMinor = Number.isFinite(cardCapMinor) ? Math.min(wantMinor, cardCapMinor) : wantMinor;
  if (cashPayout) return { giftPart, cardTargetMinor, allocations: [], alreadyByLeg };
  const picks = capLegPicks(list, legRefunds, cardTargetMinor);
  const { allocations } = allocateToLegs(list, cardTargetMinor, picks, alreadyByLeg);
  return { giftPart, cardTargetMinor, allocations, alreadyByLeg };
}
