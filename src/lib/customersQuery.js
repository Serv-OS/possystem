// customersQuery.js: the pure half of the Back Office Customers page at scale (v5.9.78).
//
// Peter, 26 Sep 2026, Coffee Boy Leeds, the day 8,028 customers were imported: "the customers
// are now not loading, it's beyond slow" and then "the back office says no customers but there
// is 8000". The page read the newest 1,000 customers ordered by updated_at, then asked for
// their stats with the 1,000 ids in the URL (37 KB), then searched the loaded rows only.
// The customers table's row security check runs once per row, so an ordering that needs every
// row costs 8,028 checks (7.5 s as a venue owner, over the API's 8 s limit: the read failed
// and the page said "No customers yet"). Migration 20260926b makes that check run once per
// statement; until it runs, the page must still work, so:
//   1. the list reads in primary key order (an index walk that stops after 1,000 rows);
//   2. per venue stats are read by venue, never by a list of customer ids;
//   3. a search of two or more characters asks the database, so every customer is findable,
//      and the matches are merged into the list.

/** The PostgREST `or` filter for a search term over name, phone and email. A term with a comma,
 * bracket or quote is quoted so it cannot break the filter grammar; % and _ are literal-ish
 * (a wildcard inside a name search is harmless). Null when the term is too short to search. */
export function customerSearchOr(term) {
  const t = String(term || '').trim();
  if (t.length < 2) return null;
  const q = '"%' + t.replace(/["\\]/g, '') + '%"';
  const digits = t.replace(/\D/g, '');
  const parts = [`name.ilike.${q}`, `email.ilike.${q}`, `phone.ilike.${q}`];
  if (digits.length >= 3) { const d = '"%' + digits + '%"'; parts.push(`phone.ilike.${d}`, `phone_raw.ilike.${d}`); }
  return parts.join(',');
}

/** Rows from a server search merged into the loaded list: new ids are added, known ids keep the
 * loaded (enriched) row. Order: the loaded list first, then the new finds. */
export function mergeCustomerRows(loaded, found) {
  const have = new Set((loaded || []).map((c) => c && c.id));
  const fresh = (found || []).filter((c) => c && c.id && !have.has(c.id));
  return fresh.length ? [...(loaded || []), ...fresh] : (loaded || []);
}

/** Per venue stats rolled onto a customer row (what the list sorts and filters on). */
export function enrichCustomer(c, stats = []) {
  const totalSpend = stats.reduce((s, x) => s + (Number(x.lifetime_revenue) || 0), 0);
  const totalVisits = stats.reduce((s, x) => s + (x.visit_count || 0), 0);
  const lastVisit = stats.reduce((latest, x) => {
    if (!x.last_visit_at) return latest;
    return !latest || new Date(x.last_visit_at) > new Date(latest) ? x.last_visit_at : latest;
  }, null);
  const siteCount = stats.filter((s) => (s.visit_count || 0) > 0).length;
  return { ...c, stats, totalSpend, totalVisits, lastVisit, siteCount };
}

/** How many rows the first read takes; more than this needs the search. */
export const CUSTOMER_PAGE_SIZE = 1000;

/** The caption under the search box when the first read filled its page. */
export function customerListCaption(loadedCount, searching) {
  if (loadedCount < CUSTOMER_PAGE_SIZE) return '';
  return searching ? 'Searching every customer…' : `Showing the first ${CUSTOMER_PAGE_SIZE.toLocaleString('en-GB')} customers. Search finds the rest.`;
}
