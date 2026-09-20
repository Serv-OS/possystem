// supabase/functions/_shared/orgScope.ts
//
// Which Ops org (the customers tenant key) belongs to a company or a venue.
//
// WHY (18 Sep 2026, lockdown step 1, review round three item b). The Platform `locations` table
// has NO org_id column (000_baseline_platform.sql: id, company_id, ops_location_id, ...). The
// org lives on the OPS `locations` row. loyalty-enroll selected org_id from Platform locations,
// PostgREST answered with an error, the list came back empty, and every WiFi "Join rewards"
// sign up was refused (wifi-capture itself reads org_id from Ops locations). gift-fulfill's
// buyer to CRM link and loyalty-member-lookup had the same read. The org is now always taken
// from the Ops row, reached through ops_location_id.
//
// PURE. No imports, so node tests load it directly.

export type PlatformLoc = { id?: string | null; ops_location_id?: string | null };
export type OpsLoc = { id?: string | null; org_id?: string | null };

/** The Ops location ids of a company's Platform location rows. */
export function opsIdsOf(platformLocs: PlatformLoc[] | null | undefined): string[] {
  return (platformLocs || []).map((l) => l?.ops_location_id).filter(Boolean).map(String);
}

/** Every org of a company: the org of each of its venues' Ops rows. */
export function companyOrgIds(opsLocs: OpsLoc[] | null | undefined): Set<string> {
  const s = new Set<string>();
  for (const l of opsLocs || []) if (l?.org_id) s.add(String(l.org_id));
  return s;
}

/** Is this id (Platform or Ops) one of the company's venues? */
export function locationInCompany(platformLocs: PlatformLoc[] | null | undefined, locationId: string | null): boolean {
  if (!locationId) return true;
  return (platformLocs || []).some((l) => String(l?.id) === locationId || String(l?.ops_location_id) === locationId);
}

/** A customer may be enrolled for a company only when their org is one of the company's orgs. */
export function customerInCompany(customer: { org_id?: string | null } | null | undefined, orgIds: Set<string>): boolean {
  return !!customer && !!customer.org_id && orgIds.has(String(customer.org_id));
}
