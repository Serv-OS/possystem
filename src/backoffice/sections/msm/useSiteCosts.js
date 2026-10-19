// src/backoffice/sections/msm/useSiteCosts.js
//
// MULTI SITE MENU (v5.11.75): plate costs for the GP view (design 4c). Recipes are each venue's own
// (keyed by venue item id), so costs load one site at a time, only when GP is asked for, and are
// kept for the session. A site whose costing did not read is "failed", never zero: a product
// there shows no GP figure rather than a wrong one (lib/msm/msmMargin.js).

import { useCallback, useMemo, useRef, useState } from 'react';
import { fetchRecipes, buildCostingCtx } from '../../../lib/stock/recipes';
import { plateCosts } from '../../../lib/msm/msmMargin';
import { supabase } from '../../../lib/supabase';

export function useSiteCosts({ demo = null } = {}) {
  const [byLoc, setByLoc] = useState({});      // loc -> Map(venueItemId -> cost)
  const [ratesByLoc, setRatesByLoc] = useState({});   // loc -> [tax_rates rows] (the site's own VAT for GP)
  const [status, setStatus] = useState({});    // loc -> 'loading' | 'ready' | 'failed'
  const asked = useRef(new Set());

  const loadOne = useCallback(async (loc) => {
    if (asked.current.has(loc)) return;
    asked.current.add(loc);
    setStatus((s) => ({ ...s, [loc]: 'loading' }));
    try {
      let costs;
      let rates = null;
      if (demo) { costs = demo.costs(loc); rates = demo.taxRates ? demo.taxRates(loc) : null; }
      else {
        const [rec, ctx, tr] = await Promise.all([
          fetchRecipes(loc), buildCostingCtx(loc),
          supabase ? supabase.from('tax_rates').select('id, name, rate, type, active').eq('location_id', loc).then((r) => r, () => ({ data: null })) : Promise.resolve({ data: null }),
        ]);
        if (rec.error || ctx.error) throw rec.error || ctx.error;
        // A failed rates read leaves the group's percent in use (never blocks the GP view).
        rates = Array.isArray(tr?.data) && !tr.error ? tr.data : null;
        const recipes = new Map((rec.data || []).map((r) => [r.id, r]));
        const links = (rec.data || []).filter((r) => r.menuItemId).map((r) => ({ menu_item_id: r.menuItemId, recipe_id: r.id, portion: r.portion }));
        costs = plateCosts(links, recipes, ctx);
      }
      setByLoc((m) => ({ ...m, [loc]: costs }));
      if (rates) setRatesByLoc((m) => ({ ...m, [loc]: rates }));
      setStatus((s) => ({ ...s, [loc]: 'ready' }));
    } catch (e) {
      console.warn('[MultiSiteMenu] costs not read for', loc, e?.message);
      setStatus((s) => ({ ...s, [loc]: 'failed' }));   // no automatic retry: retry() asks again
    }
  }, [demo]);

  const load = useCallback((locs) => { for (const l of locs || []) loadOne(l); }, [loadOne]);
  const retry = useCallback((locs) => { for (const l of locs || []) { asked.current.delete(l); loadOne(l); } }, [loadOne]);
  return useMemo(() => ({ byLoc, ratesByLoc, status, load, retry }), [byLoc, ratesByLoc, status, load, retry]);
}
