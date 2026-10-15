/**
 * stock/countRules.js: the pure rules behind approving a stock count. Tested (countRules.test.js).
 *
 * v5.11.65 (15 Oct 2026 audit): approveCount awaited every write and read none of the results,
 * so a refused movement still ended in "Count approved, stock reconciled" and a count locked as
 * APPROVED with some adjustments missing; and a sheet with nothing counted could be approved.
 * The plan (what each counted line will post) is worked out here, the writer checks each
 * result against it, and the screen refuses to approve an empty sheet.
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** True when at least one line carries a counted figure (rows as stock_count_lines returns them). */
export function canApproveCount(lines) {
  return (lines || []).some((l) => l && l.counted_qty != null && l.counted_qty !== '');
}

/**
 * What approving will do, line by line.
 * @param lines      stock_count_lines rows (snake_case)
 * @param onHandById { itemId: current on hand }
 * @param costById   { itemId: current unit cost }
 * @returns { adjustments: [{ lineId, itemId, counted, delta, varQty }], varianceValue, counted, uncounted }
 *   delta   = counted minus on hand now (what the ledger must move)
 *   varQty  = counted minus the expected figure snapshotted when the count started (what the sheet shows)
 */
export function countApprovalPlan(lines, onHandById = {}, costById = {}) {
  const adjustments = [];
  let varianceValue = 0, counted = 0, uncounted = 0;
  for (const l of lines || []) {
    if (!l) continue;
    if (l.counted_qty == null || l.counted_qty === '') { uncounted++; continue; }
    counted++;
    const c = num(l.counted_qty);
    const delta = c - num(onHandById[l.inventory_item_id]);
    const varQty = c - num(l.expected_qty);
    varianceValue += varQty * num(costById[l.inventory_item_id]);
    adjustments.push({ lineId: l.id, itemId: l.inventory_item_id, counted: c, delta, varQty });
  }
  return { adjustments, varianceValue: Math.round(varianceValue * 10000) / 10000, counted, uncounted };
}

/**
 * The words for what happened. `posted` is how many adjustments reached the ledger before a
 * failure (all of them on success); `total` is how many were planned.
 */
export function approvalOutcomeText({ posted = 0, total = 0, failedItem = null, error = null } = {}) {
  if (!error) {
    return total === 0
      ? 'Count approved. Nothing differed from the system, so no stock moved.'
      : `Count approved: ${total} line${total === 1 ? '' : 's'} adjusted, stock reconciled.`;
  }
  const where = failedItem ? ` at ${failedItem}` : '';
  return `Not approved: ${posted} of ${total} adjustment${total === 1 ? '' : 's'} posted before the save failed${where}. The count stays open; fix the connection and approve again (lines already posted will not post twice).`;
}
