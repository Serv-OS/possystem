// primaryLocation.js: a person's primary location for holiday and PTO (5.12.55, UK and US).
//
// Peter, 3 Nov 2026: "people should have a primary location - they can accrue holiday from multiple
// locations but the holiday is taken off just their primary location."
//   * A person linked at several sites (wf_staff.person_id) earns holiday or PTO at every site, each
//     site's ledger rows on that site's record (as before).
//   * Their BALANCE is one number: every linked record's ledger added up.
//   * Time off is TAKEN at the primary location only: the request lives on the primary record, the
//     deduction is written there, and payroll pays it there.
//   * The primary location is wf_staff.primary_venue_id, the same on every linked record. When the
//     records disagree or none is set, the primary is the record the person was first added at.
//
// PURE: no imports; runs under node --test and in Deno.

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** records: [{ id, location_id, primary_venue_id, created_at, status }]. The primary record, or null. */
export function primaryRecord(records = []) {
  const live = (records || []).filter((r) => r && r.status !== 'leaver');
  if (!live.length) return null;
  const votes = {};
  for (const r of live) if (r.primary_venue_id) votes[r.primary_venue_id] = (votes[r.primary_venue_id] || 0) + 1;
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0];
  const hit = top && live.find((r) => String(r.location_id) === String(top));
  if (hit) return hit;
  return [...live].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)))[0];
}

/** One balance from every linked record's ledger rows ({ accrued_hours }: + earned, - taken). */
export function personBalance(ledgerRows = []) {
  return r2((ledgerRows || []).reduce((a, r) => a + (Number(r.accrued_hours) || 0), 0));
}
