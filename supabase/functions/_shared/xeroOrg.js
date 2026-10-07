// supabase/functions/_shared/xeroOrg.js
// Which Xero organisation a sign in belongs to. PURE: no Deno, no Supabase.
//
// Xero's /connections answers with EVERY organisation this app has ever been
// authorised for by the signed in Xero user, not only the one just chosen on
// the consent screen. Until 7 Oct 2026 the connect step stored the first
// organisation in that list, so a group with two Xero organisations (Coffee
// Boy: "Coffeeboy Retail LTD" and "TDNZ") had every site posting to the first
// one whatever was picked. The organisation just consented to is the one Xero
// touched last (updatedDateUtc, else createdDateUtc).
//
// Tested by src/lib/accounting/xeroOrg.test.js.

const stamp = (c) => Date.parse(c?.updatedDateUtc || '') || Date.parse(c?.createdDateUtc || '') || 0;
const isOrg = (c) => c && typeof c === 'object' && c.tenantType === 'ORGANISATION';

// The organisation the user just consented to, or null when the list is empty.
export function pickConsentedOrg(conns) {
  const list = (Array.isArray(conns) ? conns : []).filter((c) => c && typeof c === 'object' && c.tenantId);
  const pool = list.filter(isOrg).length ? list.filter(isOrg) : list;
  if (!pool.length) return null;
  return pool.reduce((best, c) => (stamp(c) > stamp(best) ? c : best), pool[0]);
}

// The organisations a stored sign in can see, for the Back Office picker:
// [{ tenantId, tenantName, current }], by name, the current one first.
export function organisationChoices(conns, currentTenantId) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(conns) ? conns : []) {
    if (!isOrg(c) || !c.tenantId || seen.has(c.tenantId)) continue;
    seen.add(c.tenantId);
    out.push({ tenantId: c.tenantId, tenantName: c.tenantName || c.tenantId, current: c.tenantId === currentTenantId });
  }
  return out.sort((a, b) => (b.current - a.current) || String(a.tenantName).localeCompare(String(b.tenantName)));
}
