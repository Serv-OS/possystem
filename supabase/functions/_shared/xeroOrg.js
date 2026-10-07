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
// it: the Ready check holds every post until the site is set up again. That check only covers
// days on or after the site's first invoice day (an earlier day posts as bank transactions, on
// defaults, with no check), so auto posting is kept only when the first invoice day is safely
// in the past: two days before today (UTC) is on or before the last completed business day in
// every time zone. Anything else (a site on bank transactions, a first invoice day still to
// come) has auto posting turned off, as it is for any newly connected site.
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export function autoDailyAfterOrganisationChange(postMode, autoDaily, startDate = null, todayYmd = null) {
  if (!autoDaily || postMode !== 'sales_invoice') return false;
  if (!YMD.test(String(startDate || '')) || !YMD.test(String(todayYmd || ''))) return false;
  const cut = new Date(Date.parse(`${todayYmd}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
  return String(startDate) <= cut;
}

// Which organisations a Back Office user may move a site to from the list. A Xero sign in can
// reach organisations of more than one ServOS company (a bookkeeper who connected two
// customers), and Back Office access to one site must never be enough to post its sales into
// another company's books. So the list is the organisations already used by a site of the SAME
// company, plus the site's own. Any other organisation needs a sign in at Xero (which needs the
// Xero login). ServOS staff (super admin) see them all.
export function allowedOrganisations(choices, companyTenantIds, currentTenantId, isSuper = false) {
  const list = Array.isArray(choices) ? choices : [];
  if (isSuper) return list;
  const ok = new Set([...(Array.isArray(companyTenantIds) ? companyTenantIds : []), currentTenantId].filter(Boolean));
  return list.filter((o) => ok.has(o.tenantId));
}

// Which organisation a site's Xero setup was made for, when it signs in again:
// its connection row if it has one; else the last organisation record; else the organisation
// its cached setup names (xero_config.detail.site.tenantId, stamped when the setup was last
// read from Xero). null when nothing says (a site that never connected).
export function previousOrganisation({ row = null, record = null, detail = null } = {}) {
  if (row?.tenant_id) return { id: row.tenant_id, name: row.tenant_name || null };
  if (record?.tenant_id) return { id: record.tenant_id, name: record.tenant_name || null };
  const site = isObj(detail) && isObj(detail.site) ? detail.site : null;
  if (site?.tenantId) return { id: site.tenantId, name: site.orgName || null };
  return null;
}

// Was this posted day sent to another organisation than the one the site is on now?
// A day posted since 7 Oct 2026 says so itself (detail.tenant_id). An older day is taken to be
// in the previous organisation when it was posted before the site's last move.
export function postedElsewhere({ prior = null, currentTenantId = null, move = null } = {}) {
  const stamped = prior?.detail?.tenant_id;
  if (stamped && currentTenantId) return stamped !== currentTenantId;
  if (!move?.at || !prior?.updated_at) return false;
  if (move.tenant_id && currentTenantId && move.tenant_id !== currentTenantId) return false;
  return Date.parse(prior.updated_at) < Date.parse(move.at);
}

// The setup a post is about to use was made for another organisation than the one the site is
// connected to now (a run that read the setup just before a move, or a move made outside the
// two guarded paths). Refused as Not Ready: nothing chosen for one organisation is ever posted
// into another. After a real move the cached setup is empty, so this never trips.
export function setupMadeForAnother(detail, tenantId) {
  const made = isObj(detail) && isObj(detail.site) ? detail.site.tenantId : null;
  return !!(made && tenantId && made !== tenantId);
}
