// supabase/functions/_shared/xeroOrg.js
// Which Xero organisation a sign in belongs to, and what a site keeps when its organisation
// changes. PURE: no Deno, no Supabase. Tested by src/lib/accounting/xeroOrg.test.js.
//
// Xero's /connections answers with EVERY organisation this app has ever been authorised for by
// the signed in Xero user, not only the one just chosen on the consent screen. Until 7 Oct 2026
// the connect step stored the first organisation in that list, so a group with two Xero
// organisations (Coffee Boy: "Coffeeboy Retail LTD" and "TDNZ") had every site posting to the
// first one whatever was picked.
//
// Xero's own answer to "which one was just authorised" is the sign in event: the access token
// carries authentication_event_id, and each connection carries the authEventId of the consent
// that last authorised it. The newest stamp is only the fallback for a token or a list that
// does not carry the event.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const stamp = (c) => Date.parse(c?.updatedDateUtc || '') || Date.parse(c?.createdDateUtc || '') || 0;
const isOrg = (c) => isObj(c) && c.tenantType === 'ORGANISATION';
const newest = (list) => list.reduce((best, c) => (stamp(c) > stamp(best) ? c : best), list[0]);

// The organisation the user just consented to, or null when the list is empty.
// authEventId: the authentication_event_id claim of the access token just issued.
export function pickConsentedOrg(conns, authEventId = null) {
  const list = (Array.isArray(conns) ? conns : []).filter((c) => isObj(c) && c.tenantId);
  const pool = list.filter(isOrg).length ? list.filter(isOrg) : list;
  if (!pool.length) return null;
  if (authEventId) {
    const mine = pool.filter((c) => c.authEventId && String(c.authEventId).toLowerCase() === String(authEventId).toLowerCase());
    if (mine.length) return newest(mine);
  }
  return newest(pool);
}

// The organisations a stored sign in can see, for the Back Office picker:
// [{ tenantId, tenantName, current }], the current one first, then by name.
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

// What a site's mapping keeps when it moves to another Xero organisation: only what is about
// ServOS (the site's name and code, its first invoice day, which ServOS categories and discount
// labels belong to which sales group, the group names). Every choice that names something IN
// Xero is dropped: accounts, clearing and payment accounts, tax rates, the tracking option, the
// Lightspeed copy, the VAT registered switch (it belongs to the legal entity) and the "figures
// checked" tick. A site on the daily sales invoice is then Not Ready, so nothing posts to the
// new organisation until its accounts, VAT rates and tracking are chosen there and a day of
// figures is checked. An allowlist on purpose: a key added later is dropped until it is listed.
const KEEP = ['site', 'invoiceStartDate', 'categoryGroups', 'itemGroups', 'serviceTaxable'];

export function mappingForNewOrganisation(mapping) {
  const m = isObj(mapping) ? mapping : {};
  const out = {};
  for (const k of KEEP) if (m[k] !== undefined && m[k] !== null) out[k] = m[k];
  if (isObj(m.groups)) {
    const groups = {};
    for (const [key, g] of Object.entries(m.groups)) {
      if (isObj(g) && typeof g.name === 'string' && g.name) groups[key] = { name: g.name };
    }
    if (Object.keys(groups).length) out.groups = groups;
  }
  if (isObj(m.discounts) && isObj(m.discounts.labels) && Object.keys(m.discounts.labels).length) {
    out.discounts = { labels: m.discounts.labels };
  }
  return out;
}

// What the organisation change does to auto posting. A site on the daily sales invoice keeps
// it: the Ready check holds every post until the site is set up again, then it resumes by
// itself. A site on bank transactions has no such check (it posts on defaults), so auto
// posting goes off, as it is for any newly connected site.
export function autoDailyAfterOrganisationChange(postMode, autoDaily) {
  return postMode === 'sales_invoice' ? !!autoDaily : false;
}
