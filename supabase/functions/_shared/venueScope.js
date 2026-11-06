// supabase/functions/_shared/venueScope.js (6 Nov 2026, 5.12.68). PURE, no imports: node tests load
// it directly; the campaign engine, the workflow engine and the Back Office share one rule.
//
// Peter: "support much more multi site functions". A campaign or automation may carry a site scope,
// a list of venue ids: campaigns.schedule.location_ids, workflows.entry_trigger.location_ids. An
// empty or missing list means every site (what every existing row has). The scope is applied as
// one more segment rule, "visited one of these venues", through the same resolver every audience
// goes through (marketing_resolve_segment on Ops, 20261127a), so there is never a second way to
// decide who is in.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The venue ids a campaign (schedule.location_ids) or automation (entry_trigger.location_ids) is scoped to. */
export function siteScopeIds(row) {
  const raw = row && (row.schedule && row.schedule.location_ids) || row && (row.entry_trigger && row.entry_trigger.location_ids) || row && row.location_ids;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (UUID_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** A segment rule for "visited one of these venues" (mode 'visited', optional last N days) or "home venue is one of these" (mode 'home'). */
export function venueRule(ids, { days = null, mode = 'visited', op = 'in' } = {}) {
  const value = { venues: Array.isArray(ids) ? ids.slice() : [] };
  const d = Math.round(Number(days));
  if (mode !== 'home' && d > 0) value.days = d;
  return { field: mode === 'home' ? 'home_venue' : 'venue', op: op === 'not_in' ? 'not_in' : 'in', value };
}

/** The definition narrowed to the scope: unchanged when the scope is empty. */
export function withSiteScope(def, ids) {
  const scope = Array.isArray(ids) ? ids.filter((s) => UUID_RE.test(String(s))) : [];
  if (!scope.length) return def;
  const base = def && typeof def === 'object' ? def : { match: 'all', rules: [] };
  return { match: 'all', rules: [base, venueRule(scope)] };
}

/** "Leeds, Hudds" from ids and the venue list; "All sites" when the scope is empty. */
export function siteScopeLabel(ids, venues) {
  const scope = siteScopeIds({ location_ids: ids });
  if (!scope.length) return 'All sites';
  const byId = new Map((Array.isArray(venues) ? venues : []).map((v) => [String(v.id).toLowerCase(), v.name || v.id]));
  return scope.map((id) => byId.get(id) || 'a venue no longer here').join(', ');
}

/**
 * 5.12.69: the ids kept when a save names venues: only the organisation's own (the Back Office
 * sends ids; a stale tab or a hand made request could name another company's venue). Empty in,
 * empty out (every site). Null orgIds = nothing known, keep the valid ids as they are.
 */
export function keepOrgVenues(ids, orgIds) {
  const scope = siteScopeIds({ location_ids: ids });
  if (!Array.isArray(orgIds)) return scope;
  const own = new Set(orgIds.map((x) => String(x == null ? '' : x).trim().toLowerCase()));
  return scope.filter((id) => own.has(id));
}
