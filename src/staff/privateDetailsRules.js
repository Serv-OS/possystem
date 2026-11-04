// src/staff/privateDetailsRules.js (5.12.57): the pure part of privateDetails.js (no imports, tested in node).

const mapRow = (r) => ({
  niNumber: r.ni_number || null, ssnLast4: r.ssn_last4 || null, taxRef: r.tax_ref || null,
  bankSortCode: r.bank_sort_code || null, bankAccount: r.bank_account || null, bankAccountName: r.bank_account_name || null,
});

/** Pure: the answer for the ids asked, from the rows the door returned. */
export function privateAnswer(ids, rows) {
  const byId = {};
  for (const r of rows || []) if (r && (r.staff_id || r.id)) byId[r.staff_id || r.id] = mapRow(r);
  const asked = (ids || []).filter(Boolean);
  // The door returns nothing for a caller who may not see them (it never says which ids exist).
  return { byId, hidden: asked.length > 0 && Object.keys(byId).length === 0 };
}

