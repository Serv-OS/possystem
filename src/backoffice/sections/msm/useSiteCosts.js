// src/backoffice/sections/msm/useSiteCosts.js
//
// MULTI SITE MENU (v5.11.75): plate costs for the GP view (design 4c). Recipes are each venue's own
// (keyed by venue item id), so costs load one site at a time, only when GP is asked for, and are
// kept for the session. A site whose costing did not read is "failed", never zero: a product
// there shows no GP figure rather than a wrong one (lib/msm/msmMargin.js).

import { useCallback, useMemo, useRef, useState } from 'react';
import { fetchRecipes, buildCostingCtx } from '../../../lib/stock/recipes';
import { plateCosts } from '../../../lib/msm/msmMargin';

export function useSiteCosts({ demo = null } = {}) {
  const [byLoc, setByLoc] = useState({});      // loc -> Map(venueItemId -> cost)
  const [status, setStatus] = useState({});    // loc -> 'loading' | 'ready' | 'failed'
  const asked = useRef(new Set());

  const loadOne = useCallback(async (loc) => {
    if (asked.current.has(loc)) return;
    asked.current.add(loc);
    setStatus((s) => ({ ...s, [loc]: 'loading' }));
    try {
      let costs;
      if (demo) costs = demo.costs(loc);
      else {
        const [rec, ctx] = await Promise.all([fetchRecipes(loc), buildCostingCtx(loc)]);
        if (rec.error || ctx.error) throw rec.error || ctx.error;
        const recipes = new Map((rec.data || []).map((r) => [r.id, r]));
        const links = (rec.data || []).filter((r) => r.menuItemId).map((r) => ({ menu_item_id: r.menuItemId, recipe_id: r.id, portion: r.portion }));
        costs = plateCosts(links, recipes, ctx);
      }
      setByLoc((m) => ({ ...m, [loc]: costs }));
      setStatus((s) => ({ ...s, [loc]: 'ready' }));
    } catch (e) {
      console.warn('[MultiSiteMenu] costs not read for', loc, e?.message);
      setStatus((s) => ({ ...s, [loc]: 'failed' }));   // no automatic retry: retry() asks again
    }
  }, [demo]);

  const load = useCallback((locs) => { for (const l of locs || []) loadOne(l); }, [loadOne]);
  const retry = useCallback((locs) => { for (const l of locs || []) { asked.current.delete(l); loadOne(l); } }, [loadOne]);
  return useMemo(() => ({ byLoc, status, load, retry }), [byLoc, status, load, retry]);
}
