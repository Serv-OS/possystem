// supabase/functions/_shared/loyaltyPartRefund.js
//
// v5.11.81 (19 Oct 2026): loyalty on a PART refund. Pure, no imports: loyalty-refund ships it and
// `npm test` loads the same file.
//
// Before v5.11.78 any refund on a check with loyalty reversed the WHOLE check (every point earned
// clawed back and the reward given back, for one coffee refunded out of five). v5.11.78 stopped
// that by calling loyalty-refund on a full refund only, so a part refund then reversed nothing at
// all: the points and stamps earned on the refunded lines stayed with the customer (6 part refunds
// on checks with loyalty in 60 days). Now a part refund takes back what the refunded part earned:
//   points  the points earned on the check times the share of its goods money refunded, rounded
//           down (never more than was earned, less what earlier part refunds already took);
//   stamps  the qualifying items refunded (the program's own rule, as loyalty-earn counted them),
//           never more than the check earned less what earlier part refunds took;
//   a reward used on the check stays used (the visit happened); a FULL refund gives it back.
// Each part refund is its own claim (refund:<check>:<refund id>, stamprefund:earn:<key>:<refund id>),
// so a retry never takes twice, and a full refund after part refunds takes only what is left.

const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

/** The key a part refund's points row is claimed under. */
export function partRefundKey(checkId, refundId) {
  return `refund:${checkId}:${refundId}`;
}

/** True when `key` is a part refund row of this check (a literal prefix test: `_` is a LIKE wildcard). */
export function isPartRefundKey(key, checkId) {
  return typeof key === 'string' && key.startsWith(`refund:${checkId}:`) && key.length > `refund:${checkId}:`.length;
}

/** The key a part refund's stamp row for one earn row is claimed under. */
export function partStampKey(earnKey, refundId) {
  return `stamprefund:earn:${earnKey}:${refundId}`;
}

/** True when `key` is a part refund stamp row of this earn row. */
export function isPartStampKey(key, earnKey) {
  return typeof key === 'string' && key.startsWith(`stamprefund:earn:${earnKey}:`);
}

/** The share of a check's goods a part refund returned, 0..1 (a bad figure is 0: nothing taken). */
export function refundShare(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}

/**
 * Points a part refund takes back: floor(earned x share), never more than is still unclaimed.
 * @param {number} earned         points the check earned (earn and bonus rows)
 * @param {number} alreadyTaken   points earlier part refunds took back (a positive number)
 * @param {number} share          the share of the goods refunded (0..1)
 */
export function partRefundPoints({ earned = 0, alreadyTaken = 0, share = 0 } = {}) {
  const left = Math.max(0, int(earned) - int(alreadyTaken));
  return Math.min(left, Math.floor(int(earned) * refundShare(share) + 1e-9));
}

/** Stamps a part refund takes back: the qualifying items refunded, never more than is still unclaimed. */
export function partRefundStamps({ earned = 0, alreadyTaken = 0, refundedQualifying = 0 } = {}) {
  return Math.min(Math.max(0, int(earned) - int(alreadyTaken)), int(refundedQualifying));
}

/** What a FULL refund still has to take back of an earn after part refunds: earned less taken. */
export function remainingAfterParts({ earned = 0, alreadyTaken = 0 } = {}) {
  return Math.max(0, int(earned) - int(alreadyTaken));
}
