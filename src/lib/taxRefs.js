// taxRefs.js: the ONE rule for which Back Office tax settings a sold line carries (v5.11.78).
//
// 18 Oct 2026 (channel parity audit): the till (store addItem, v5.5.338), the kiosk
// (kioskLine.kioskLineTaxRefs) and the QR close (headlessTax.qrTaxLines) each held their own
// copy of the size rule, and the online, QR pay now and catering pages and the HubRise close
// (channelMoney.buildChannelCloseFields) had none: they read the SIZE row alone. A size saved
// with "Use default" under a 5% product booked 0.07 VAT on the till and 0.26 on the online page;
// a new size under a product with takeaway 0% booked 0.00 on the till and 0.50 online.
//
// The till's rule, now in one place every channel calls:
//   - a size with its own per order type overrides uses them, and its own rate;
//   - a size with NO overrides takes its product's overrides, and the product's rate when it
//     has no rate of its own;
//   - the tax profile is always the row's OWN (the till reads it through the item's own id,
//     never the parent's);
//   - a plain product (no parent) takes its own.
// Rows arrive snake (tax_rate_id, tax_overrides, tax_profile_id) on the customer pages and
// camel (taxRateId, taxOverrides, taxProfileId) from the store; both are read, camel first,
// with `||` exactly as store addItem read them, so the till's lines are byte identical.
//
// PURE: no imports, runs under node --test (src/lib/parity).

const rateOf = (row) => row?.taxRateId || row?.tax_rate_id || null;
const overridesOf = (row) => row?.taxOverrides || row?.tax_overrides || null;
const profileOf = (row) => row?.taxProfileId || row?.tax_profile_id || null;
const isEmptyOverrides = (ov) => !ov || typeof ov !== 'object' || Object.keys(ov).length === 0;

/**
 * The tax references a sold line carries: { taxRateId, taxOverrides, taxProfileId }.
 * @param {object} row       the row being sold (a size, or a plain product)
 * @param {object} [parent]  the size's product row when `row` is a size (null for a plain product)
 */
export function sizeTaxRefs(row, parent = null) {
  let taxRateId = rateOf(row);
  let taxOverrides = overridesOf(row) || {};
  if (parent && isEmptyOverrides(taxOverrides)) {
    taxOverrides = overridesOf(parent) || taxOverrides;
    if (!taxRateId) taxRateId = rateOf(parent);
  }
  return {
    taxRateId: taxRateId || null,
    taxOverrides: taxOverrides && typeof taxOverrides === 'object' ? taxOverrides : {},
    taxProfileId: profileOf(row),
  };
}

/** The parent row of a size (parent_id or parentId), found in a list of rows; null for a plain product. */
export function parentRowOf(row, rows) {
  const pid = row?.parentId ?? row?.parent_id ?? null;
  if (pid == null || pid === '') return null;
  return (Array.isArray(rows) ? rows : []).find((r) => r && String(r.id) === String(pid)) || null;
}

/** sizeTaxRefs for a row, finding its parent in `rows` when it is a size. */
export function lineTaxRefsFor(row, rows) {
  return sizeTaxRefs(row, parentRowOf(row, rows));
}
