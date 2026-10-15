// The inputs every Sales mix surface shares (8 Oct 2026, D2): which site's categories and
// which site's Xero mapping to resolve a check line's group with, and the resolver built from
// them. The report (SalesMix.jsx), the Business summary strip (SalesMixStrip.jsx) and the Z
// report block (SalesByGroupSlip.jsx) all take their resolver from here, so they can never
// disagree about where an item sits. The maths is in supabase/functions/_shared/salesMix.js.
//
//   signed in site     the store's menuCategories (the very rows Menu Manager edits, so a
//                      group saved in the setup panel is seen at once) + its mapping
//   one other site     useOtherSiteMenu's categories (read fresh, see _siteMenus.js) + its mapping
//   several sites      useSiteMenus per part + a mapping per part, one resolver PER PART
//                      (ids and labels differ per copy of a shared category)

import { useMemo } from 'react';
import { useStore } from '../../../store';
import { useOtherSiteMenu, useSiteMenus } from './_siteMenus';
import { useSiteMappings } from './_siteMappings';
import { makeMixResolver } from '../../../../supabase/functions/_shared/salesMix.js';

const NONE = [];
const EMPTY_IDS = [];

/** The signed in site's id as a string ('' when the scope has none), so the slip and the strip agree. */
export function useHomeSiteId(scope) {
  return String(scope?.homeId ?? '');
}

/**
 * ONE site on screen: the signed in site, or one OTHER ticked site. Returns { siteId, siteName,
 * isHome, categories, menuLoading, menuFailed, mapping, mappingFailed, resolver }. `mapping` is
 * null until its read lands; the resolver works from the categories alone until then.
 */
export function useOneSiteMix({ sites, scope } = {}) {
  const storeCategories = useStore((s) => s.menuCategories);
  const other = useOtherSiteMenu(sites);
  const isHome = !other.other;
  const homeId = useHomeSiteId(scope);
  const siteId = isHome ? homeId : String(other.site?.id ?? '');
  const siteName = isHome ? (scope?.home?.name || '') : (other.site?.name || '');
  const categories = isHome ? (storeCategories || NONE) : (other.menu?.categories || NONE);
  const ids = useMemo(() => (siteId ? [siteId] : EMPTY_IDS), [siteId]);
  const { mappings, failed } = useSiteMappings(ids);
  const mapping = siteId ? (mappings[siteId] ?? null) : null;
  const mappingFailed = !!siteId && failed.includes(siteId);
  const resolver = useMemo(() => makeMixResolver(mapping || {}, categories), [mapping, categories]);
  return {
    siteId: siteId || null, siteName, isHome, categories,
    menuLoading: !!other.loading, menuFailed: !!other.failed,
    mapping, mappingFailed, resolver,
  };
}

/**
 * SEVERAL sites (the parts of useParts): one resolver per part from that part's own menu and
 * mapping. Returns { resolvers: { [partId]: resolver }, menus, menusLoading, menusFailed,
 * mappings, mappingsFailed }.
 */
export function usePartResolvers(parts) {
  const { menus, loading: menusLoading, failed: menusFailed } = useSiteMenus(parts);
  const ids = useMemo(() => (parts || []).map((p) => String(p.id)), [parts]);
  const { mappings, failed: mappingsFailed } = useSiteMappings(ids);
  const resolvers = useMemo(() => {
    const out = {};
    for (const id of ids) out[id] = makeMixResolver(mappings[id] || {}, menus[id]?.categories || NONE);
    return out;
  }, [ids, menus, mappings]);
  return { resolvers, menus, menusLoading, menusFailed, mappings, mappingsFailed };
}
