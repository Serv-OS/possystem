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
 * All quantities and costs are per base unit.
 *
 * v5.11.79 (multi site stock plan, Phase 0, 11.5 item 3): the received cost stands on its own,
 * never averaged, when there is no stock to average against: on hand at or below zero (on hand -8
 * at 1.00 plus 10 at 2.00 used to give 6.00; it is 2.00), or an unknown cost (null, or 0: an item
 * that was never priced averaged in as free). The same rule as the database's receive
 * (20261019b _stock_receive_lines and post_stock_transfer_leg).
 */
export function movingAverageCost({ onHandQty = 0, currentAvg = 0, receivedQty, receivedUnitCost }) {
  const oh = Number(onHandQty) || 0;
  const rq = Number(receivedQty);
  const rc = Number(receivedUnitCost);
  const avg = currentAvg == null ? null : Number(currentAvg);
  if (!(rq > 0)) return avg == null || !Number.isFinite(avg) ? 0 : avg;
  if (oh <= 0 || !(avg > 0)) return rc;
  return (oh * avg + rq * rc) / (oh + rq);
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
