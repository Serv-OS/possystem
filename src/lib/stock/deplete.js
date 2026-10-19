/**
 * deplete.js — post SALE_DEPLETION / RETURN movements to the stock ledger when a
 * sale closes or is refunded. Fire-and-forget: NEVER throws into the sale path.
 *
 * Explosion is the pure engine (explode.js); each ingredient posts ONE idempotent
 * movement per (check, item) so retries/re-fires are safe. A check whose items
 * have no recipe is a complete no-op — harmless before recipes exist, and only
 * touches stock for items that are actually recipe-linked.
 *
 * Scope: the till only (POS/bar/table), and only at a venue still on the till path ('browser':
 * backed out by ServOS with stock_central_switch, or a venue with no recipe yet, where nothing
 * comes off anyway).
 *
 * Since v5.11.78 (20261019) every venue is central, a new venue from the moment it is created, so
 * the database books every check from every channel. The online browser calls are gone and depleteForSaleServer (still called by the
 * kiosk's fingerprinted submitOrder) does nothing: the database books those checks itself, and the
 * old call never found their venue anyway. Old kiosk builds that still call the stock-deplete
 * function are answered skipped central by the door.
 *
 * v5.11.77 CENTRAL DEPLETION (migration 20261018c): at a venue switched to 'central' (or
 * 'paused') the DATABASE takes stock off every booked check, from the check itself, for every
 * channel, and reverses refunds and voids under Peter's rules (food is waste, never put back).
 * This file then does nothing at that venue: it reads stock_venue_mode once a minute
 * (centralMode.js) and skips. The door in post_stock_movement would answer {skipped: 'central'}
 * anyway, so a till on an older build cannot double count either. No row, a missing RPC or any
 * error reads as 'browser': the old path, exactly as before, until a venue is switched on.
 */

import { getActiveLocationSync } from '../supabase';
import { isTrainingMode } from '../trainingMode';
import { buildDepletionCtx } from './recipes.js';
import { postStockMovement, fetchStockVenueMode } from './data.js';
import { explodeBasket } from './explode.js';
import { modeFromRpc, tillShouldDeplete, MODE_TTL_MS } from './centralMode.js';

let _mode = { loc: null, at: 0, mode: 'browser' };
/** Drop the cached venue mode (tests, or after the venue is switched). */
export function invalidateVenueMode() { _mode = { loc: null, at: 0, mode: 'browser' }; }

/** The venue's depletion mode, read once a minute. Any failure = 'browser' (the old path). */
async function venueModeFor(loc) {
  const now = Date.now();
  if (_mode.loc === loc && now - _mode.at < MODE_TTL_MS) return _mode.mode;
  let mode = 'browser';
  try { mode = modeFromRpc(await fetchStockVenueMode(loc)); } catch { mode = 'browser'; }
  _mode = { loc, at: now, mode };
  return mode;
}

/**
 * v5.11.79: kiosk (and formerly online) stock off is booked by the DATABASE from the stored check
 * (20261018c, every venue central since 20261019). This is now a no-op on
 * purpose: the kiosk's submitOrder still calls it (that block is fingerprinted by the card path
 * guard, so it is not edited), and the old call never found the kiosk's venue anyway. Old kiosk
 * builds that still reach the stock-deplete function are answered skipped central by the door.
 */
// eslint-disable-next-line no-unused-vars
export async function depleteForSaleServer(_check, _opts = {}) { /* the database books every channel's checks */ }

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
/**
 * v5.11.79 (stock plan 11.5 item 2): the sale's own time on its movements, not the time they were
 * posted (an offline till posts hours later; the database then matches a sale made before a count
 * with a "Late sale before count" adjustment). A time more than 10 minutes ahead of this clock, or
 * none, is left to the database clock.
 */
export function saleTimeOf(check, nowMs = Date.now()) {
  const t = check?.closedAt ?? check?.closed_at;
  const ms = typeof t === 'number' ? t : (t ? Date.parse(t) : NaN);
  if (!Number.isFinite(ms) || ms > nowMs + 10 * 60 * 1000) return null;
  return new Date(ms).toISOString();
}
const hasRecipes = (ctx) => ctx && ctx.menuRecipes && Object.keys(ctx.menuRecipes).length > 0;

/** Deplete the stock items consumed by a closed check (theoretical COGS). */
export async function depleteForSale(check) {
  try {
    if (isTrainingMode()) return;   // TRAINING MODE: no recipe-COGS ledger movements
    const loc = getActiveLocationSync();
    if (!loc) return;
    // v5.11.77: at a central venue the database books this check; the till posts nothing
    if (!tillShouldDeplete(await venueModeFor(loc))) return;
    const items = (check?.items || []).filter((it) => !it.voided && it.itemId);
    if (!items.length) return;
    const ctx = await ctxFor(loc);
    if (!hasRecipes(ctx)) return;
    // Scope depletion to the sale's order type so order-type-specific lines (e.g. a disposable cup
    // for takeaway/collection/delivery) deplete only for those orders. Default to dine-in/base.
    const agg = explodeBasket(items.map((it) => ({ itemId: it.itemId, qty: Number(it.qty) || 1, mods: it.mods })), ctx, check?.orderType || 'dine-in');
    const key = keyOf(check);
    if (!key) return;
    const occurredAt = saleTimeOf(check);
    for (const [invId, qtyBase] of Object.entries(agg)) {
      if (!(qtyBase > 0)) continue;
      await postStockMovement({
        inventoryItemId: invId, qtyBase: -qtyBase, movementType: 'SALE_DEPLETION',
        sourceType: 'closed_check', sourceId: key, idempotencyKey: `sale:${key}:${invId}`, occurredAt,
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
    // v5.11.77: at a central venue the database books the refund from the check's refunds[] entry
    // (food as waste, shelf items back); the till posts nothing
    if (!tillShouldDeplete(await venueModeFor(loc))) return;
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
