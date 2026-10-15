/**
 * _shared/stockCosting.js: the ONE moving average rule for receiving stock. src/lib/stock/costing.js
 * re-exports it for Back Office receiving (applyReceipt); manager-approve imports it under Deno so a
 * delivery received on the phone writes the same cost as one received in Back Office.
 *
 * v5.11.65: the Manager app had its own inline copy, (onHand x cost + recv x price) / ((onHand + recv) || 1).
 * With stock below zero the two disagreed: on hand -20 at 1.00, receive 20 at 1.20 gave 1.20 in
 * Back Office and 4.00 on the phone (a zero denominator fell to 1); on hand -50 gave 0.867 against
 * 1.20. That figure feeds current_cost, item_cost_history, every valuation and every recipe GP.
 */

/**
 * New moving average cost after receiving stock (default valuation policy for food).
 *   new_avg = (onHand x oldAvg + recvQty x recvCost) / (onHand + recvQty)
 * All quantities and costs are per base unit. Falls back to recvCost when there is no prior
 * on hand, or when on hand plus received is zero or below (stock sold past zero carries no
 * value to average against).
 */
export function movingAverageCost({ onHandQty = 0, currentAvg = 0, receivedQty, receivedUnitCost }) {
  const oh = Number(onHandQty) || 0;
  const rq = Number(receivedQty);
  const rc = Number(receivedUnitCost);
  if (!(rq > 0)) return Number(currentAvg) || 0;
  const denom = oh + rq;
  if (!(denom > 0)) return rc;
  return (oh * (Number(currentAvg) || 0) + rq * rc) / denom;
}

/**
 * The cost a received line leaves on the item: the received unit cost under LAST_COST, the moving
 * average otherwise. One call for both receiving paths.
 */
export function costAfterReceipt({ costMethod, onHandQty, currentAvg, receivedQty, receivedUnitCost }) {
  return costMethod === 'LAST_COST'
    ? Number(receivedUnitCost)
    : movingAverageCost({ onHandQty, currentAvg, receivedQty, receivedUnitCost });
}
