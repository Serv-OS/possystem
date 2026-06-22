// supabase/functions/stock-deplete/index.ts
//
// v5.5.583 — Server-side stock depletion for kiosk/online sales.
// Kiosk & online run as anonymous users that can't read recipe/inventory tables
// under RLS, so the client-side deplete (src/lib/stock/deplete.js) no-ops there.
// This function runs with the service role: it explodes the sold menu items through
// their recipes into ingredient quantities and posts SALE_DEPLETION (or RETURN)
// movements to the stock ledger via post_stock_movement (idempotent per check+item).
// Mirrors the pure logic in src/lib/stock/{uom,explode}.js — keep them in step.
//
// POST { location_id, check_id, items:[{itemId, qty}], reverse?:bool }
// Auth: verify_jwt=false; accepts anon (kiosk/online) + authenticated callers.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ── unit factors (mirror src/lib/stock/units.js) ─────────────────────────────
const UNITS: Record<string, { dim: string; toCanonical: number }> = {
  each: { dim: 'COUNT', toCanonical: 1 }, dozen: { dim: 'COUNT', toCanonical: 12 },
  mg: { dim: 'WEIGHT', toCanonical: 0.001 }, g: { dim: 'WEIGHT', toCanonical: 1 }, kg: { dim: 'WEIGHT', toCanonical: 1000 },
  oz: { dim: 'WEIGHT', toCanonical: 28.349523125 }, lb: { dim: 'WEIGHT', toCanonical: 453.59237 },
  ml: { dim: 'VOLUME', toCanonical: 1 }, cl: { dim: 'VOLUME', toCanonical: 10 }, l: { dim: 'VOLUME', toCanonical: 1000 },
  floz: { dim: 'VOLUME', toCanonical: 28.4130625 }, pt: { dim: 'VOLUME', toCanonical: 568.26125 }, gal: { dim: 'VOLUME', toCanonical: 4546.09 },
};
const norm = (u: string) => String(u ?? '').trim().toLowerCase();
function globalFactor(a: string, b: string): number | null {
  const ua = UNITS[norm(a)], ub = UNITS[norm(b)];
  if (!ua || !ub || ua.dim !== ub.dim) return null;
  return ua.toCanonical / ub.toCanonical;
}
// convert with same-dimension factors + per-item cross-dimension bridges (BFS)
function convert(qty: number, from: string, to: string, bridges: any[] = []): number {
  const f = norm(from), t = norm(to);
  if (f === t) return qty;
  const direct = globalFactor(f, t);
  if (direct != null) return qty * direct;
  const nodes = new Set([f, t]);
  for (const b of bridges) { nodes.add(norm(b.fromUnit)); nodes.add(norm(b.toUnit)); }
  const arr = [...nodes];
  const adj = new Map<string, { to: string; factor: number }[]>();
  const add = (a: string, b: string, fac: number) => { if (!(fac > 0)) return; (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, factor: fac }); };
  for (let i = 0; i < arr.length; i++) for (let j = 0; j < arr.length; j++) if (i !== j) { const g = globalFactor(arr[i], arr[j]); if (g != null) add(arr[i], arr[j], g); }
  for (const b of bridges) { const fu = norm(b.fromUnit), tu = norm(b.toUnit), fq = Number(b.fromQty), tq = Number(b.toQty); if (fu && tu && fq > 0 && tq > 0) { add(fu, tu, tq / fq); add(tu, fu, fq / tq); } }
  const q = [[f, 1]] as [string, number][]; const seen = new Set([f]);
  while (q.length) { const [u, acc] = q.shift()!; if (u === t) return qty * acc; for (const e of adj.get(u) ?? []) if (!seen.has(e.to)) { seen.add(e.to); q.push([e.to, acc * e.factor]); } }
  throw new Error(`no conversion ${f}->${t}`);
}
function toBase(qty: number, token: string, item: any): number {
  if (typeof token === 'string' && token.startsWith('@')) {
    const id = token.slice(1);
    const fmt = (item.formats || []).find((x: any) => String(x.id) === id);
    if (!fmt || !(Number(fmt.qtyInBase) > 0)) throw new Error('unknown pack');
    return qty * Number(fmt.qtyInBase);
  }
  return convert(qty, token, item.baseUnit, item.itemConversions || []);
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function buildCtx(sb: any, loc: string) {
  const [items, convs, packs, links, recipes, lines] = await Promise.all([
    sb.from('inventory_items').select('id, base_unit').eq('location_id', loc),
    sb.from('inventory_item_conversions').select('*').eq('location_id', loc),
    sb.from('item_packaging_formats').select('id, inventory_item_id, qty_in_base').eq('location_id', loc),
    sb.from('menu_item_recipes').select('menu_item_id, recipe_id, portion').eq('location_id', loc),
    sb.from('recipes').select('id, wastage_pct').eq('location_id', loc).is('archived_at', null),
    sb.from('recipe_lines').select('recipe_id, component_item_id, qty, unit, usable_pct').eq('location_id', loc),
  ]);
  const convBy: Record<string, any[]> = {};
  (convs.data || []).forEach((c: any) => { (convBy[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }); });
  const fmtBy: Record<string, any[]> = {};
  (packs.data || []).forEach((p: any) => { (fmtBy[p.inventory_item_id] ??= []).push({ id: p.id, qtyInBase: Number(p.qty_in_base) }); });
  const itemsById: Record<string, any> = {};
  (items.data || []).forEach((it: any) => { itemsById[it.id] = { baseUnit: it.base_unit, itemConversions: convBy[it.id] || [], formats: fmtBy[it.id] || [] }; });
  const wastageBy: Record<string, number> = {};
  (recipes.data || []).forEach((r: any) => { wastageBy[r.id] = Number(r.wastage_pct) || 0; });
  const linesBy: Record<string, any[]> = {};
  (lines.data || []).forEach((l: any) => { (linesBy[l.recipe_id] ??= []).push({ componentItemId: l.component_item_id, qty: Number(l.qty), unit: l.unit, usablePct: l.usable_pct == null ? 100 : Number(l.usable_pct) }); });
  const menuRecipes: Record<string, any> = {};
  (links.data || []).forEach((k: any) => { menuRecipes[String(k.menu_item_id)] = { lines: linesBy[k.recipe_id] || [], portion: Number(k.portion) || 1, wastagePct: wastageBy[k.recipe_id] || 0 }; });
  return { itemsById, menuRecipes };
}

function explode(items: { itemId: string; qty: number }[], ctx: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const mr = ctx.menuRecipes[String(it.itemId)];
    if (!mr) continue;
    const n = Number(it.qty) || 0;
    if (n <= 0) continue;
    const mult = n * (Number(mr.portion) || 1) * (1 + (Number(mr.wastagePct) || 0) / 100);
    for (const line of mr.lines || []) {
      const comp = ctx.itemsById[line.componentItemId];
      if (!comp) continue;
      let qtyBase: number;
      try { qtyBase = toBase(Number(line.qty), line.unit, comp); } catch { continue; }
      const usable = (line.usablePct == null ? 100 : Number(line.usablePct)) / 100;
      if (!(usable > 0)) continue;
      out[line.componentItemId] = (out[line.componentItemId] || 0) + (qtyBase / usable) * mult;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const loc = String(body?.location_id || '');
  const checkId = String(body?.check_id || '');
  const items = Array.isArray(body?.items) ? body.items : [];
  const reverse = body?.reverse === true;
  if (!loc || !checkId || !items.length) return json({ error: 'location_id, check_id, items required' }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const ctx = await buildCtx(sb, loc);
    if (!Object.keys(ctx.menuRecipes).length) return json({ ok: true, depleted: 0, note: 'no recipes' });
    const agg = explode(items.map((i: any) => ({ itemId: i.itemId, qty: Number(i.qty) || 1 })), ctx);
    let posted = 0;
    for (const [invId, qtyBase] of Object.entries(agg)) {
      if (!(qtyBase > 0)) continue;
      const { error } = await sb.rpc('post_stock_movement', {
        p_location_id: loc, p_inventory_item_id: invId,
        p_qty_base: reverse ? qtyBase : -qtyBase,
        p_movement_type: reverse ? 'RETURN' : 'SALE_DEPLETION',
        p_unit_cost: null, p_source_type: reverse ? 'online_refund' : 'online_sale', p_source_id: checkId,
        p_idempotency_key: `${reverse ? 'return' : 'sale'}:${checkId}:${invId}`,
        p_occurred_at: null, p_created_by: null, p_notes: null,
      });
      if (!error) posted++;
    }
    return json({ ok: true, depleted: posted });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
