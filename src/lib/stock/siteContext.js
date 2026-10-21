/**
 * stock/siteContext.js: the menu and tax rates of a site that is not the signed in venue
 * (v5.11.89, multi site stock Drop 1, map 3.4 "not the signed in venue's store").
 *
 * The store holds ONLY the signed in venue's menuItems and taxRates. With the picker on another
 * site, a screen that read them would post that site's invoice at the signed in venue's VAT ids
 * (none match: every line at 0%), list the wrong menu for a recipe link, or cost waste against the
 * wrong products. So a screen whose site is not the signed in venue reads that site's own rows
 * here; for the signed in venue (always, in a one site company) it uses the store, exactly as today.
 *
 *   fetchSiteStockContext(siteId)  -> { menuItems, taxRates, error }
 *   useSiteStockContext(siteId)    -> { menuItems, taxRates, loading, error, foreign }
 *
 * Products: every live menu_items row of that site, in pages of 1,000 (lib/pagedRead.js), in the
 * store's own shape (rowMapping.mapMenuItemRow, with the price). Tax rates: that site's tax_rates
 * rows, at most 1,000, mapped as the store maps them (inactive ones too, so an old line still
 * finds its rate).
 */

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getActiveLocationSync } from '../supabase';
import { readAllPagesResult } from '../pagedRead.js';
import { mapMenuItemRow, mapTaxRateRow } from '../rowMapping.js';

const EMPTY = Object.freeze([]);
const TAX_COLS = 'id, name, code, rate, type, applies_to, is_default, active, location_id';

/** True when the site is named and is not the signed in venue. */
export function isForeignSite(siteId, homeId) {
  return !!siteId && !!homeId && String(siteId) !== String(homeId);
}

export async function fetchSiteStockContext(siteId) {
  const id = siteId != null ? String(siteId) : null;
  if (isMock || !supabase || !id || id === 'loc-demo') return { menuItems: [], taxRates: [], error: id ? null : new Error('No site') };
  const [menu, rates] = await Promise.all([
    readAllPagesResult('products', (first) => supabase.from('menu_items')
      .select('*', first ? { count: 'exact' } : undefined).eq('location_id', id).eq('archived', false).order('id')),
    Promise.resolve(supabase.from('tax_rates').select(TAX_COLS).eq('location_id', id).order('id').limit(1000))
      .catch((error) => ({ data: null, error })),
  ]);
  const error = menu.error || rates.error || null;
  if (error) console.warn('[stock] the site menu or tax rates did not load:', id, error?.message || error);
  return {
    menuItems: (menu.data || []).map(mapMenuItemRow),
    taxRates: (rates.data || []).map(mapTaxRateRow),
    error,
  };
}

/**
 * The menu and tax rates a stock screen works with for `siteId`. The signed in venue (or no site
 * named): the store's slices, exactly as today, with no read. Another site: its own rows, read once
 * per site; empty while they load (`loading` true).
 */
export function useSiteStockContext(siteId) {
  const storeMenu = useStore((s) => s.menuItems);
  const storeRates = useStore((s) => s.taxRates);
  const foreign = isForeignSite(siteId, getActiveLocationSync());
  const [read, setRead] = useState(null);   // { siteId, menuItems, taxRates, error }
  useEffect(() => {
    if (!foreign) return undefined;
    let live = true;
    fetchSiteStockContext(siteId).then((r) => { if (live) setRead({ siteId, ...r }); });
    return () => { live = false; };
  }, [foreign, siteId]);
  if (!foreign) return { menuItems: storeMenu || [], taxRates: storeRates || [], loading: false, error: null, foreign: false };
  const mine = read && read.siteId === siteId ? read : null;
  return { menuItems: mine?.menuItems || EMPTY, taxRates: mine?.taxRates || EMPTY, loading: !mine, error: mine?.error || null, foreign: true };
}
