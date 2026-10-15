// Each site's own menu, rates and stations for the reports that read them (step 4 of the
// multi site reports, 5 Oct 2026). The rules are in src/lib/reportSiteMenu.js, the reads in
// src/lib/reportSites.js; this file is the hook that joins them to a report's parts.
//
// The signed in site's menu is the store's (the very rows the single site report reads, and
// the store's own tax context), so its figures never change by being one of several. Every
// other site is read fresh, named columns, paged, and kept for a few minutes.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { buildSiteMenu } from '../../../lib/reportSiteMenu.js';
import { fetchSiteMenu, fetchSiteCentres } from '../../../lib/reportSites.js';

/**
 * { menus: { [siteId]: siteMenu }, loading, failed: [siteId] }. A part whose site is the
 * signed in one is answered from the store at once; the others arrive together.
 */
export function useSiteMenus(parts) {
  const { menuItems = [], menuCategories = [], taxRates = [] } = useStore();
  const homeCtx = useStore(s => s.getTaxContext());
  const homePart = (parts || []).find(p => p.site?.isHome) || null;
  const homeMenu = useMemo(() => (
    homePart ? buildSiteMenu({ id: homePart.id, items: menuItems, categories: menuCategories, taxRates, taxCtx: homeCtx }) : null
  ), [homePart, menuItems, menuCategories, taxRates, homeCtx]);

  const otherIds = (parts || []).filter(p => !p.site?.isHome).map(p => p.id);
  const otherKey = otherIds.join(',');
  const [others, setOthers] = useState({ key: '', menus: {}, failed: [] });
  useEffect(() => {
    if (!otherIds.length) { setOthers({ key: otherKey, menus: {}, failed: [] }); return undefined; }
    let alive = true;
    Promise.all(otherIds.map(id => fetchSiteMenu(id))).then(results => {
      if (!alive) return;
      const menus = {}, failed = [];
      results.forEach((r, i) => { if (r?.ok && r.menu) menus[otherIds[i]] = r.menu; else failed.push(otherIds[i]); });
      setOthers({ key: otherKey, menus, failed });
    });
    return () => { alive = false; };
    // otherIds follows otherKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherKey]);

  const loading = others.key !== otherKey;
  const menus = useMemo(() => {
    const out = { ...(loading ? {} : others.menus) };
    if (homeMenu) out[homeMenu.id] = homeMenu;
    return out;
  }, [homeMenu, others, loading]);
  return { menus, loading, failed: loading ? [] : others.failed };
}

/**
 * ONE OTHER site on screen (filtered down to a site that is not the signed in one): its menu,
 * rates and tax context, so the single site view names that site's categories and taxes its
 * checks on its own rates. For the signed in site (or no site props at all) this is
 * { other: false, menu: null, loading: false }, and the view reads the store exactly as before.
 */
export function useOtherSiteMenu(sites) {
  const site = Array.isArray(sites) && sites.length === 1 && sites[0] && !sites[0].isHome ? sites[0] : null;
  const id = site ? String(site.id) : null;
  const [read, setRead] = useState({ id: null, menu: null, failed: false });
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    fetchSiteMenu(id).then(r => { if (alive) setRead({ id, menu: r?.ok ? r.menu : null, failed: !r?.ok }); });
    return () => { alive = false; };
  }, [id]);
  if (!id) return { other: false, site: null, menu: null, loading: false, failed: false };
  const ready = read.id === id;
  return { other: true, site, menu: ready ? read.menu : null, loading: !ready, failed: ready && read.failed };
}

/**
 * { centres: { [siteId]: centres[] }, loading }: each site's production centres. The signed
 * in site's come from the store's print routing when the read has no row for it.
 */
export function useSiteCentres(parts) {
  const storeCentres = useStore(s => s.printRouting?.centres);
  const ids = (parts || []).map(p => p.id);
  const key = ids.join(',');
  const homeId = (parts || []).find(p => p.site?.isHome)?.id || null;
  const [read, setRead] = useState({ key: '', centres: {} });
  useEffect(() => {
    if (!ids.length) { setRead({ key, centres: {} }); return undefined; }
    let alive = true;
    fetchSiteCentres(ids).then(centres => { if (alive) setRead({ key, centres }); });
    return () => { alive = false; };
    // ids follows key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const loading = read.key !== key;
  const centres = useMemo(() => {
    const out = { ...(loading ? {} : read.centres) };
    if (homeId && !out[homeId] && Array.isArray(storeCentres)) out[homeId] = storeCentres;
    return out;
  }, [read, loading, homeId, storeCentres]);
  return { centres, loading };
}
