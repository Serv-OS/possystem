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

// Which organisation a sign in stores for a site, and whether Xero actually said which one.
// 7 Oct 2026 (Coffee Boy, three organisations, all already connected): Xero's screen then only
// says "3 organisations connected, Continue" and never asks which. No connection carries the
// sign in event, so there is nothing to go on, and ServOS must NOT guess (it "auto connected to
// the wrong one"). The site stays on the organisation its setup was made for (`previous`: its
// connection, else its organisation record, else its cached setup) while that organisation is
// still in the list, and Back Office then asks which one (matched false). Only a site with
// nothing to stay on takes the newest connection, as a placeholder until the person picks.
//
// 7 Oct 2026, later the same day (review of v5.11.36): a site that IS connected only ever moves
// when Xero's sign in event names exactly one organisation (`named`). "There is only one in the
// list" is not that: someone presses Sign in to Xero while their browser is signed in to Xero as
// ANOTHER Xero login, one that cannot see this site's organisation, and the site was silently
// moved to whatever that login could see (setup cleared, tokens replaced). So for a connected
// site (`connected`: it has a connection row, and `previous` is that row's organisation):
//   - Xero named one: that one;
//   - Xero named nothing and the site's own is in the list: it stays;
//   - Xero named nothing and the site's own is NOT in the list: nothing at all changes
//     (`otherLogin`, org null), and the screen says which login to use.
// A site with no connection row keeps the rule above (its setup's organisation while that is in
// the list, else a placeholder, and Back Office asks).
// Returns { org, matched, named, otherLogin }:
//   matched     nothing to ask: Xero named it, or there is only one;
//   named       this sign in event is on exactly one organisation in the list;
//   otherLogin  a connected site whose organisation this sign in cannot see.
export function organisationForSignIn({ conns = [], authEventId = null, previous = null, connected = false } = {}) {
  const list = (Array.isArray(conns) ? conns : []).filter((c) => isObj(c) && c.tenantId);
  const pool = list.filter(isOrg).length ? list.filter(isOrg) : list;
  if (!pool.length) return { org: null, matched: false, named: false, otherLogin: false };
  const mine = authEventId
    ? pool.filter((c) => c.authEventId && String(c.authEventId).toLowerCase() === String(authEventId).toLowerCase())
    : [];
  if (mine.length === 1) return { org: mine[0], matched: true, named: true, otherLogin: false };
  const own = previous?.id ? pool.find((c) => c.tenantId === previous.id) : null;
  if (connected) {
    if (!own) return { org: null, matched: false, named: false, otherLogin: true };
    return { org: own, matched: pool.length === 1, named: false, otherLogin: false };
  }
  if (pool.length === 1) return { org: pool[0], matched: true, named: false, otherLogin: false };
  if (mine.length > 1) {
    // Several authorised in one go: Xero named a set, not one. Stay put if the site's own is among them.
    const stay = previous?.id ? mine.find((c) => c.tenantId === previous.id) : null;
    return { org: stay || newest(mine), matched: false, named: false, otherLogin: false };
  }
  return { org: own || newest(pool), matched: false, named: false, otherLogin: false };
}

// A person who has just signed in to Xero from this site's Back Office screen may choose among
// ALL the organisations that sign in covers, for a short while: they hold the Xero login, which
// is exactly what Xero's own chooser would have asked for. (Without this an owner could never
// put a site on an organisation no site of the company uses yet, once Xero stops asking.)
export const SIGN_IN_GRANT_MINUTES = 30;
export function signInGrantFresh(grant, userId, nowMs = Date.now()) {
  if (!isObj(grant) || !userId || grant.by !== userId) return false;
  const at = Date.parse(grant.at || '');
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= SIGN_IN_GRANT_MINUTES * 60000;
}

// Has the question been answered since this sign in? Yes when the site's last organisation
// record (lastRecord: { at, via, ... }) was written after the sign in note: the person picked
// here ('picker'), or signed in again and Xero named one ('connect'). A disconnect note is not
// an answer. A record with no clock, or an older one, is not one either.
function answeredSince(signIn, lastRecord) {
  if (!isObj(signIn) || !isObj(lastRecord) || lastRecord.via === 'disconnect') return false;
  const noted = Date.parse(signIn.at || '');
  const recorded = Date.parse(lastRecord.at || '');
  return Number.isFinite(noted) && Number.isFinite(recorded) && recorded > noted;
}

// Does Back Office ask this person "which organisation are this site's books in?" (the amber
// box). Only the person who just signed in, only while their half hour runs, only when Xero did
// not say which one and there is more than one to choose from, and only until they have
// answered. 7 Oct 2026 (review of v5.11.36): ServOS staff (super admin) are asked like anyone
// else, and the question stops once an organisation has been picked.
export function shouldAskWhichOrganisation({ signIn = null, userId = null, lastRecord = null, organisationCount = 0, nowMs = Date.now() } = {}) {
  if (!signInGrantFresh(signIn, userId, nowMs)) return false;
  if (signIn.matched !== false) return false;
  if (!(Number(organisationCount) > 1)) return false;
  return !answeredSince(signIn, lastRecord);
}

// A short hold on AUTO posting after a sign in. 7 Oct 2026 (review of v5.11.36): a site that
// was disconnected and signs in again when Xero does not ask is stored back on the organisation
// its setup was made for, with its Ready setup and auto posting untouched. The hourly job could
// then post the last completed day there before the person has answered the question. So the
// sign in note carries hold: true (a site with no connection row, Xero did not say which), and
// while it stands the hourly job posts nothing for the site. It ends by itself: after the same
// half hour the person has to pick in, or as soon as an organisation is picked. There is no
// switch to turn back on. A push by a person is never held.
// A note stamped up to a minute ahead of this clock is still a hold (two servers, two clocks).
const HOLD_CLOCK_SLACK_MS = 60000;
export function autoPostHeld({ signIn = null, lastRecord = null, nowMs = Date.now() } = {}) {
  if (!isObj(signIn) || signIn.hold !== true) return false;
  const at = Date.parse(signIn.at || '');
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  if (age < -HOLD_CLOCK_SLACK_MS || age > SIGN_IN_GRANT_MINUTES * 60000) return false;
  return !answeredSince(signIn, lastRecord);
}

// Does THIS sign in put the hold on its note? Yes for a site with no connection row when Xero
// did not say which organisation. Yes too for a site that is connected by now, when a hold from
// an earlier sign in still stands (`standing`: autoPostHeld on the note before this one) and
// Xero again did not say: the person pressed Sign in to Xero a second time, which is what the
// box itself offers, and that must not quietly end the wait. Never when Xero said which one (or
// there is only one): then there is nothing to wait for.
export function signInHolds({ connected = false, matched = false, standing = false } = {}) {
  if (matched) return false;
  return !connected || !!standing;
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
// Xero login): either Xero asks which one there, or, when it has them all connected already and
// does not ask, the person who just signed in picks here (seeAll, see signInGrantFresh). ServOS
// staff (super admin) see them all.
export function allowedOrganisations(choices, companyTenantIds, currentTenantId, seeAll = false) {
  const list = Array.isArray(choices) ? choices : [];
  if (seeAll) return list;
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

// Which OTHER organisation holds this posted day: { id, name }, or null when it is in the one
// the site is on now (or nothing says otherwise). A day posted since 7 Oct 2026 says so itself
// (detail.tenant_id). An older day went to wherever the site was when it was posted: the
// organisation the site LEFT in its first move after that day (moves: the site's organisation
// records, each { at, tenant_id, tenant_name, from, from_tenant_id, via }). No move after the
// day = it was posted where the site still is.
export function postedElsewhere({ prior = null, currentTenantId = null, moves = [] } = {}) {
  if (!prior || !currentTenantId) return null;
  const list = (Array.isArray(moves) ? moves : [])
    .filter((m) => isObj(m) && m.via !== 'disconnect' && Number.isFinite(Date.parse(m.at)))
    .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const nameOf = (id) => {
    const left = list.find((m) => m.from_tenant_id === id);
    if (left) return left.from || null;
    const joined = list.find((m) => m.tenant_id === id);
    return joined ? (joined.tenant_name || null) : null;
  };
  const stamped = prior.detail?.tenant_id;
  if (stamped) return stamped === currentTenantId ? null : { id: stamped, name: nameOf(stamped) };
  const posted = Date.parse(prior.updated_at || '');
  if (!Number.isFinite(posted)) return null;
  const next = list.find((m) => Date.parse(m.at) > posted);
  if (!next || !next.from_tenant_id || next.from_tenant_id === currentTenantId) return null;
  return { id: next.from_tenant_id, name: next.from || null };
}

// The setup a post is about to use was made for another organisation than the one the site is
// connected to now (a run that read the setup just before a move, or a move made outside the
// two guarded paths). Refused as Not Ready: nothing chosen for one organisation is ever posted
// into another. After a real move the cached setup is empty, so this never trips.
export function setupMadeForAnother(detail, tenantId) {
  const made = isObj(detail) && isObj(detail.site) ? detail.site.tenantId : null;
  return !!(made && tenantId && made !== tenantId);
}
