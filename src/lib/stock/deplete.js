/**
 * deplete.js — post SALE_DEPLETION / RETURN movements to the stock ledger when a
 * sale closes or is refunded. Fire-and-forget: NEVER throws into the sale path.
 *
 * Explosion is the pure engine (explode.js); each ingredient posts ONE idempotent
 * movement per (check, item) so retries/re-fires are safe. A check whose items
 * have no recipe is a complete no-op — harmless before recipes exist, and only
 * touches stock for items that are actually recipe-linked.
 *
 * Scope: POS/bar/table (authenticated) deplete client-side here. Kiosk & online run
 * as anonymous users that can't read the recipe tables under RLS, so they call the
 * `stock-deplete` edge function (service role) via depleteForSaleServer().
 */

import { supabase, isMock, getActiveLocationSync } from '../supabase';
import { isTrainingMode } from '../trainingMode';
import { buildDepletionCtx } from './recipes.js';
import { postStockMovement } from './data.js';
import { explodeBasket } from './explode.js';

/**
 * Server-side depletion for anonymous channels (kiosk / online). Fire-and-forget —
 * never blocks or throws into the order flow. The edge function explodes the sold
 * items through their recipes with the service role and posts the movements.
 */
export async function depleteForSaleServer(check, { reverse = false } = {}) {
  try {
    if (isMock || !supabase) return;
    if (isTrainingMode()) return;   // TRAINING MODE: no recipe-COGS ledger movements
    const loc = getActiveLocationSync();
    if (!loc) return;
    const items = (check?.items || [])
      .filter((it) => !it.voided && it.itemId)
      .map((it) => ({ itemId: it.itemId, qty: Number(it.qty) || 1,
        // linked modifier sub-items (the bun) deplete server-side too
        mods: (Array.isArray(it.mods) ? it.mods : []).filter(m => m && m.itemId && !m._instruction).map(m => ({ itemId: m.itemId, qty: Number(m.qty) || 1 })) }));
    if (!items.length) return;
    const checkId = check?.id || check?.ref;
    if (!checkId) return;
    // order_type scopes which recipe lines deplete (e.g. a takeaway cup). Default to dine-in/base.
    await supabase.functions.invoke('stock-deplete', { body: { location_id: loc, check_id: String(checkId), items, reverse, order_type: check?.orderType || 'dine-in' } });
  } catch (e) { console.warn('[stock] depleteForSaleServer failed:', e?.message); }
}

let _cache = { loc: null, at: 0, ctx: null };
/** Drop the cached depletion context (call after editing recipes/costs). */
export function invalidateDepletionCtx() { _cache = { loc: null, at: 0, ctx: null }; }

async function ctxFor(loc) {
  const now = Date.now();
  if (_cache.ctx && _cache.loc === loc && now - _cache.at < 60000) return _cache.ctx;
  const ctx = await buildDepletionCtx(loc);
  _cache = { loc, at: now, ctx };
  return ctx;
}

const keyOf = (check) => String(check?.id || check?.ref || '');
const hasRecipes = (ctx) => ctx && ctx.menuRecipes && Object.keys(ctx.menuRecipes).length > 0;

/** Deplete the stock items consumed by a closed check (theoretical COGS). */
export async function depleteForSale(check) {
  try {
    if (isTrainingMode()) return;   // TRAINING MODE: no recipe-COGS ledger movements
    const loc = getActiveLocationSync();
    if (!loc) return;
    const items = (check?.items || []).filter((it) => !it.voided && it.itemId);
    if (!items.length) return;
    const ctx = await ctxFor(loc);
    if (!hasRecipes(ctx)) return;
    // Scope depletion to the sale's order type so order-type-specific lines (e.g. a disposable cup
    // for takeaway/collection/delivery) deplete only for those orders. Default to dine-in/base.
    const agg = explodeBasket(items.map((it) => ({ itemId: it.itemId, qty: Number(it.qty) || 1, mods: it.mods })), ctx, check?.orderType || 'dine-in');
    const key = keyOf(check);
    if (!key) return;
    for (const [invId, qtyBase] of Object.entries(agg)) {
      if (!(qtyBase > 0)) continue;
      await postStockMovement({
        inventoryItemId: invId, qtyBase: -qtyBase, movementType: 'SALE_DEPLETION',
        sourceType: 'closed_check', sourceId: key, idempotencyKey: `sale:${key}:${invId}`,
      }, loc);
    }
  } catch (e) { console.warn('[stock] depleteForSale failed:', e?.message); }
}

/** Reverse depletion for refunded items (post RETURN movements), keyed per refund. */
export async function reverseForSale(check, refundItems, refundId) {
  try {
    if (isTrainingMode()) return;   // TRAINING MODE: no recipe-COGS reversal movements
    const loc = getActiveLocationSync();
    if (!loc) return;
    const lines = (refundItems || [])
      .filter((ri) => ri.itemId)
      .map((ri) => ({ itemId: ri.itemId, qty: Number(ri.refundQty) || Number(ri.qty) || 0 }))
      .filter((l) => l.qty > 0);
    if (!lines.length) return;
    const ctx = await ctxFor(loc);
    if (!hasRecipes(ctx)) return;
    // Reverse against the same order-type scope used at sale, so a refunded takeaway returns its cup.
    const agg = explodeBasket(lines, ctx, check?.orderType || 'dine-in');
    const key = keyOf(check);
    const rid = refundId || 'r';
    if (!key) return;
    for (const [invId, qtyBase] of Object.entries(agg)) {
      if (!(qtyBase > 0)) continue;
      await postStockMovement({
        inventoryItemId: invId, qtyBase: qtyBase, movementType: 'RETURN',
        sourceType: 'closed_check_refund', sourceId: key, idempotencyKey: `return:${key}:${rid}:${invId}`,
      }, loc);
    }
  } catch (e) { console.warn('[stock] reverseForSale failed:', e?.message); }
}
