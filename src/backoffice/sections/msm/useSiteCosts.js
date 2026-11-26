// src/backoffice/sections/msm/useSiteCosts.js
//
// MULTI SITE MENU (v5.11.75): plate costs for the GP view (design 4c). Recipes are each venue's own
// (keyed by venue item id), so costs load one site at a time, only when GP is asked for, and are
// kept for the session. A site whose costing did not read is "failed", never zero: a product
// there shows no GP figure rather than a wrong one (lib/msm/msmMargin.js).
//
// v5.11.93 (multi site stock Drop 2, contract 3.1): the costs come from the database
// (stock_plate_costs through stockApi.plateCosts, paged by `next` until null), the same figure the
// drainer and the reports use, built into the same Map(venueItemId -> cost) the grid, the product
// sheet and Change prices read. A database before Drop 2 answers needsUpdate and today's maths run
// instead (fetchRecipes plus buildCostingCtx plus plateCosts), so a develop build before the
// migration still shows GP. Any other refusal is "failed", as before.

import { useCallback, useMemo, useRef, useState } from 'react';
import { fetchRecipes, buildCostingCtx } from '../../../lib/stock/recipes';
import { plateCosts } from '../../../lib/msm/msmMargin';
import { stockApi } from '../../../lib/stock/stockApi';
import { readPlateCosts, plateCostMap, plateTargetMap, costOrFallback } from '../../../lib/stock/plateCostsRead';
import { readAllRows } from '../../../../supabase/functions/_shared/venueMenuCore.js';
import { supabase } from '../../../lib/supabase';

/** Today's maths for one site: every venue recipe costed in the browser, as before Drop 2. */
async function todayCosts(loc) {
  const [rec, ctx] = await Promise.all([fetchRecipes(loc), buildCostingCtx(loc)]);
  if (rec.error || ctx.error) return { data: null, error: rec.error || ctx.error };
  const recipes = new Map((rec.data || []).map((r) => [r.id, r]));
  const links = (rec.data || []).filter((r) => r.menuItemId).map((r) => ({ menu_item_id: r.menuItemId, recipe_id: r.id, portion: r.portion }));
  // 5.12.105: each product's target is its recipe's own Target GP (none set: no target).
  const targets = new Map();
  for (const l of links) { const t = recipes.get(l.recipe_id)?.gpTargetPct; if (t != null && Number.isFinite(Number(t))) targets.set(String(l.menu_item_id), Number(t)); }
  return { data: { costs: plateCosts(links, recipes, ctx), targets }, error: null };
}

/**
 * The database's plate costs for one site, with each product's recipe Target GP beside them.
 * The targets are a second, small read of that site's recipes (id and target only). If it fails
 * the costs still show: the GP figures simply carry no verdict, never a made up one.
 */
async function databaseCosts(loc) {
  const r = await readPlateCosts(stockApi, loc);
  if (r.error) return { data: null, error: r.error, needsUpdate: r.needsUpdate };
  let recipeRows = [];
  if (supabase) {
    const t = await readAllRows(() => supabase.from('recipes').select('id, gp_target_pct').eq('location_id', loc).not('gp_target_pct', 'is', null).order('id'));
    if (t.rows) recipeRows = t.rows;
    else console.warn('[MultiSiteMenu] recipe targets not read for', loc, t.error?.message);
  }
  return { data: { costs: plateCostMap(r.data), targets: plateTargetMap(r.data, recipeRows) }, error: null, needsUpdate: false };
}

export function useSiteCosts({ demo = null } = {}) {
  const [byLoc, setByLoc] = useState({});      // loc -> Map(venueItemId -> cost)
  const [targetsByLoc, setTargetsByLoc] = useState({});   // loc -> Map(venueItemId -> the recipe's Target GP %)
  const [ratesByLoc, setRatesByLoc] = useState({});   // loc -> [tax_rates rows] (the site's own VAT for GP)
  const [status, setStatus] = useState({});    // loc -> 'loading' | 'ready' | 'failed'
  const asked = useRef(new Set());

  const loadOne = useCallback(async (loc) => {
    if (asked.current.has(loc)) return;
    asked.current.add(loc);
    setStatus((s) => ({ ...s, [loc]: 'loading' }));
    try {
      let costs;
      let targets = new Map();
      let rates = null;
      if (demo) { costs = demo.costs(loc); targets = demo.targets ? demo.targets(loc) : new Map(); rates = demo.taxRates ? demo.taxRates(loc) : null; }
      else {
        const [read, tr] = await Promise.all([
          costOrFallback(() => databaseCosts(loc), () => todayCosts(loc)),
          supabase ? supabase.from('tax_rates').select('id, name, rate, type, active').eq('location_id', loc).then((r) => r, () => ({ data: null })) : Promise.resolve({ data: null }),
        ]);
        if (read.error) throw read.error;
        // A failed rates read leaves the group's percent in use (never blocks the GP view).
        rates = Array.isArray(tr?.data) && !tr.error ? tr.data : null;
        costs = read.data?.costs || new Map();
        targets = read.data?.targets || new Map();
      }
      setByLoc((m) => ({ ...m, [loc]: costs }));
      setTargetsByLoc((m) => ({ ...m, [loc]: targets }));
      if (rates) setRatesByLoc((m) => ({ ...m, [loc]: rates }));
      setStatus((s) => ({ ...s, [loc]: 'ready' }));
    } catch (e) {
      console.warn('[MultiSiteMenu] costs not read for', loc, e?.message);
      setStatus((s) => ({ ...s, [loc]: 'failed' }));   // no automatic retry: retry() asks again
    }
  }, [demo]);

  const load = useCallback((locs) => { for (const l of locs || []) loadOne(l); }, [loadOne]);
  const retry = useCallback((locs) => { for (const l of locs || []) { asked.current.delete(l); loadOne(l); } }, [loadOne]);
  return useMemo(() => ({ byLoc, targetsByLoc, ratesByLoc, status, load, retry }), [byLoc, targetsByLoc, ratesByLoc, status, load, retry]);
}
