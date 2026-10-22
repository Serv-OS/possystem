// src/lib/recipeCard.js
//
// The recipe card for staff (v5.11.91, multi site stock Drop 2, contract 3.6 and 1.7): what the
// till's item info, the KDS pop out and the Manager app show from stock_recipe_card(p_loc,
// p_menu_item_id, p_recipe). The card carries the build (lines in the unit as written), the
// method steps, allergens, may contain, kcal, use by days and whether the facts were checked at
// this site. Never a cost, never a price (the database does not send them).
//
// Who may read it: a signed in login that reaches the site, or a bound staff device (till, KDS,
// handheld) at its own site, through its own session (the device branch of the function). Every
// other session is refused 42501 'Sign in to see recipe cards.'; a database before 20261025a
// has no function. Both answer `card: null` here, and the screens hide the tab or button.
//
// Pure: the Supabase client is passed in (src/lib/supabase.js cannot load under node:test), so
// node:test drives readRecipeCard with a fake. The hook takes the client in its options.

import { useEffect, useState } from 'react';

export const RECIPE_CARD_FN = 'stock_recipe_card';
export const RECIPE_CARD_REFUSED = 'Sign in to see recipe cards.';

/** A call to a function the database does not have yet (before 20261025a). */
export function isMissingRecipeCardFn(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'PGRST202' || code === '42883') return true;
  const msg = String(error.message || error.hint || '');
  return /could not find the function/i.test(msg) || /function [^\s]+ does not exist/i.test(msg);
}

/** The lines of a method: an array as it is; text split on blank lines or numbered lines. */
export function cardSteps(method) {
  if (Array.isArray(method)) return method.map((s) => String(s ?? '').trim()).filter(Boolean);
  const text = typeof method === 'string' ? method.trim() : '';
  if (!text) return [];
  const byBlank = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const parts = byBlank.length > 1 ? byBlank : text.split(/\n(?=\s*\d+[.)]\s)/).map((s) => s.trim()).filter(Boolean);
  return parts.map((s) => s.replace(/^\s*\d+[.)]\s*/, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A build line's amount as written: '18 g', '2 slices', '1 x Bun (6 pack)'; '' with no amount. */
export function buildLineWords(line) {
  if (!line) return '';
  const q = num(line.qty);
  const unit = String(line.unit ?? '').trim();
  const qty = q === null ? '' : String(Math.round(q * 1000) / 1000);
  return [qty, unit].filter(Boolean).join(' ');
}

/** The card's build as rows { qty, unit, name, words } in the order sent. */
export function buildRows(card) {
  const lines = Array.isArray(card?.build) ? card.build : [];
  return lines.filter(Boolean).map((l) => ({
    qty: num(l.qty), unit: String(l.unit ?? '').trim(), name: String(l.name ?? '').trim() || 'Ingredient', words: buildLineWords(l),
  }));
}

/** '146 kcal' or '' when the card has no figure. */
export function cardKcalWords(card) {
  const n = num(card?.kcal);
  return n === null || n < 0 ? '' : `${Math.round(n)} kcal`;
}

/** 'Use within 3 days' or '' when the recipe has no shelf life. */
export function useByWords(card) {
  const d = num(card?.use_by_days);
  if (d === null || d <= 0) return '';
  const n = Math.round(d);
  return `Use within ${n} day${n === 1 ? '' : 's'}`;
}

/** 'Ingredients (1 plate)' style heading from the card's portion words. */
export function portionHeading(card) {
  const words = String(card?.portion_words ?? '').trim();
  return `Ingredients (${words || '1 portion'})`;
}

/**
 * The products that match a search (case blind, contains), in name order, at most `limit`.
 * list: [{ menu_item_id, name }] (the Manager snapshot's kitchen.recipes).
 */
export function searchRecipes(list, q, limit = 50) {
  const needle = String(q ?? '').trim().toLowerCase();
  const rows = (Array.isArray(list) ? list : []).filter((p) => p && p.menu_item_id != null && String(p.name ?? '').trim());
  const hits = needle ? rows.filter((p) => String(p.name).toLowerCase().includes(needle)) : rows;
  return [...hits].sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, Math.max(1, limit));
}

/**
 * One read of the card: { card, error }. card is null when the database has no function yet,
 * when the session may not see it (42501), when nothing is linked, or when the read failed; the
 * error carries the database's words so a screen can say them when it wants to.
 */
export async function readRecipeCard(client, locationId, { menuItemId = null, recipeId = null } = {}) {
  if (!client || typeof client.rpc !== 'function' || !locationId || locationId === 'loc-demo') return { card: null, error: null };
  if (!menuItemId && !recipeId) return { card: null, error: null };
  let res;
  try {
    res = await client.rpc(RECIPE_CARD_FN, { p_loc: locationId, p_menu_item_id: menuItemId ?? null, p_recipe: recipeId ?? null });
  } catch (e) {
    return { card: null, error: e };
  }
  if (res?.error) return { card: null, error: isMissingRecipeCardFn(res.error) ? null : res.error };
  const card = res?.data;
  if (!card || typeof card !== 'object' || Array.isArray(card)) return { card: null, error: null };
  if (card.ok === false) return { card: null, error: card.error ? new Error(String(card.error)) : null };
  return { card, error: null };
}

/**
 * The card for a till product at a site, read once per (site, product) with the client given
 * (the till's or the KDS's own session). { card, loading, error }; card null hides the tab.
 */
export function useRecipeCard(locationId, menuItemId, { client = null, recipeId = null } = {}) {
  // The answer is kept with the (client, site, product, recipe) it was read for; a different one
  // shows loading until its own answer comes back, so no state is reset inside the effect.
  const key = client && locationId && (menuItemId || recipeId) ? `${locationId}|${menuItemId ?? ''}|${recipeId ?? ''}` : null;
  const [got, setGot] = useState({ client: null, key: null, card: null, error: null });
  useEffect(() => {
    if (!client || !locationId || !(menuItemId || recipeId)) return undefined;
    let alive = true;
    const forKey = `${locationId}|${menuItemId ?? ''}|${recipeId ?? ''}`;
    readRecipeCard(client, locationId, { menuItemId, recipeId }).then((r) => {
      if (alive) setGot({ client, key: forKey, card: r.card, error: r.error });
    }, (e) => {
      if (alive) setGot({ client, key: forKey, card: null, error: e });
    });
    return () => { alive = false; };
  }, [client, locationId, menuItemId, recipeId]);
  if (!key) return { card: null, loading: false, error: null };
  if (got.key !== key || got.client !== client) return { card: null, loading: true, error: null };
  return { card: got.card, loading: false, error: got.error };
}
