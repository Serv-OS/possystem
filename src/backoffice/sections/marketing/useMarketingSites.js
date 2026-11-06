// src/backoffice/sections/marketing/useMarketingSites.js (6 Nov 2026, 5.12.69)
//
// The hook behind the Sites control on every Marketing page (MarketingSites.jsx draws it). The rule
// is src/lib/marketingSites.js: the organisation owns, the sites use. This file only joins that rule
// to React state and the browser's memory of the last choice.

import { useMemo, useState } from 'react';
import { filterOnSite, readSiteChoice, rowSiteIds, siteBadge, siteList, writeSiteChoice } from '../../../lib/marketingSites';

const store = () => { try { return window.localStorage; } catch { return null; } };

/**
 * The page's site scope: { sites, siteId, setSiteId, siteName, ready, show, filter(kind, rows), badge(ids) }.
 * `venues` is the organisation's venue list the page already loads ([{ id, name }] or [{ location_id, name }]);
 * the choice is read once the venues are known and remembered per signed in venue.
 */
export function useMarketingSites(locId, venues) {
  const sites = useMemo(() => siteList(venues), [venues]);
  // The remembered choice is read while rendering (no effect, no flash of the wrong site); a pick in
  // this page wins from then on. A choice naming a venue the company no longer has reads as All sites.
  const [picked, setPicked] = useState(undefined);
  const remembered = useMemo(() => readSiteChoice(store(), locId, sites), [locId, sites]);
  const chosen = picked === undefined ? remembered : picked;
  const siteId = sites.length > 1 && sites.some((v) => v.id === chosen) ? chosen : '';   // one venue: no choice exists
  const ready = sites.length > 0;
  const setSiteId = (id) => { const s = sites.some((v) => v.id === String(id || '').toLowerCase()) ? String(id).toLowerCase() : ''; setPicked(s); writeSiteChoice(store(), locId, s); };
  const siteName = siteId ? (sites.find((v) => v.id === siteId)?.name || 'this site') : 'All sites';
  return {
    sites, siteId, setSiteId, siteName, ready,
    show: sites.length > 1,
    filter: (kind, rows) => filterOnSite(kind, rows, siteId),
    ids: (kind, row) => rowSiteIds(kind, row),
    badge: (ids) => siteBadge(ids, sites),
  };
}

