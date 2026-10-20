/**
 * stock/companyData.js: how the browser talks to the stock save functions (v5.11.84, multi site
 * stock Drop 0). The client is passed in, so node --test drives every path with a stand in
 * (saveContract.test.js); data.js, recipes.js, counts.js and areas.js hand in the real one.
 *
 *   callSave(client, fn, args)        one save function: { data, error, missing, conflict }
 *   saveOrDirect(client, fn, args, d) the save function, or today's direct write `d()` when the
 *                                     database does not have the function yet (PGRST202 or 42883).
 *                                     Drop 0 only: the fallback is deleted in Drop 1.
 *   liveOrAll(run)                    a read with archived rows left out; before 0a the column is
 *                                     not there and the read runs without the filter
 *   runRecipeSave(deps, draft, loc)   the recipe, its lines and its till link in one call
 *                                     (stock_save_recipe); today's four calls only as the fallback
 *   readAll(build)                    a table read past the 1,000 row cap (lifted from Phase 1)
 *
 * Nothing here decides who may save: the database does (stock_co__guard). Nothing is shown as done
 * before the database answers.
 */

import { isMissingFunctionError } from './phase0Rules.js';
import { saveRefusal, isMissingColumnError, recipeSaveArgs, recipeSaveOutcome } from './saveRules.js';

export const PAGE_ROWS = 1000;

/**
 * True when the database has a function of this very name, only with other arguments: PostgREST
 * answers PGRST202 with a hint naming it ("Perhaps you meant to call the function
 * public.stock_save_item(...)"). That is a build that does not match its database, never "not
 * installed yet", so it must not quietly fall back to a direct write.
 */
export function namesSameFunction(error, fn) {
  const text = `${error?.hint || ''} ${error?.details || ''}`;
  return !!fn && text.includes(`public.${fn}(`);
}

/**
 * Call one save function. A refusal inside a success answer ({ ok: false }, such as "someone saved
 * first") comes back as an error with the database's words, and its conflict when there is one.
 * `missing` (the database does not have the function yet) is the only answer a caller may fall
 * back on.
 */
export async function callSave(client, fn, args) {
  if (!client || typeof client.rpc !== 'function') return { data: null, error: new Error('No database'), missing: false, conflict: null };
  let res;
  try { res = await client.rpc(fn, args); } catch (e) { res = { data: null, error: e }; }
  if (res?.error) return { data: null, error: res.error, missing: isMissingFunctionError(res.error) && !namesSameFunction(res.error, fn), conflict: null };
  const refused = saveRefusal(res?.data);
  if (refused) return { data: res.data, error: refused, missing: false, conflict: res.data?.conflict || null };
  return { data: res?.data ?? null, error: null, missing: false, conflict: null };
}

/**
 * The save function, or today's direct write when the database answers that the function is not
 * there yet. `via` says which ran ('rpc' or 'direct'); a direct answer is passed back as it came.
 */
export async function saveOrDirect(client, fn, args, direct) {
  const r = await callSave(client, fn, args);
  if (r.missing && typeof direct === 'function') return { ...(await direct()), via: 'direct' };
  return { ...r, via: 'rpc' };
}

/**
 * A read that leaves archived rows out. run(true) adds .is('archived_at', null); when the database
 * says that column does not exist (before Drop 0a) the read runs again with run(false).
 */
export async function liveOrAll(run) {
  const first = await run(true);
  if (first?.error && isMissingColumnError(first.error, 'archived_at')) return run(false);
  return first;
}

/**
 * The recipe save behind Recipes.jsx `save` and the Stock items Recipe tab.
 * deps: { client, upsertRecipe, replaceRecipeLines, linkMenuItemRecipe, recomputeMadeItemCost }.
 * Answer: { data: { id, rowVersion, ... } | null, error, stage, costOk, via }.
 *   stage 'recipe' the recipe did not save (nothing was written)
 *   stage 'lines'  fallback only: the recipe saved, its lines did not
 *   stage 'link'   fallback only: recipe and lines saved, the till product link did not
 *   costOk false   the made item's cost was not rolled up (null: no made item)
 * The one call saves all of it or none of it, so it never answers 'lines' or 'link'.
 */
export async function runRecipeSave(deps, draft, locationId, opts = {}) {
  const { client, upsertRecipe, replaceRecipeLines, linkMenuItemRecipe, recomputeMadeItemCost } = deps || {};
  const r = await callSave(client, 'stock_save_recipe', recipeSaveArgs(draft, locationId, opts));
  if (!r.missing) {
    if (r.error) return { data: null, error: r.error, stage: 'recipe', costOk: null, conflict: r.conflict, via: 'rpc' };
    const out = recipeSaveOutcome(r.data, draft);
    return { data: out, error: null, stage: null, costOk: draft.outputItemId ? out.costOk !== false : null, conflict: null, via: 'rpc' };
  }
  // Before the database has stock_save_recipe: today's four calls, in today's order.
  const saved = await upsertRecipe(draft, locationId);
  if (saved?.error) return { data: null, error: saved.error, stage: 'recipe', costOk: null, conflict: null, via: 'direct' };
  const rid = saved?.data?.id || draft.id || null;
  if (!rid) return { data: null, error: new Error('Recipe save failed'), stage: 'recipe', costOk: null, conflict: null, via: 'direct' };
  const data = { id: rid, rowVersion: null, linesSaved: 0, linked: false, costOk: null, queued: [] };
  const lineRes = await replaceRecipeLines(rid, draft.lines, locationId);
  if (lineRes?.error) return { data, error: lineRes.error, stage: 'lines', costOk: null, conflict: null, via: 'direct' };
  if ((draft.recipeType || 'MENU') === 'MENU' && draft.menuItemId) {
    const linkRes = await linkMenuItemRecipe(draft.menuItemId, rid, draft.portion || 1, locationId);
    if (linkRes?.error) return { data, error: linkRes.error, stage: 'link', costOk: null, conflict: null, via: 'direct' };
    data.linked = true;
  }
  let costOk = null;
  if (draft.outputItemId) {
    let rc = { ok: false };
    try { rc = await recomputeMadeItemCost(draft.outputItemId, locationId); } catch { rc = { ok: false }; }
    costOk = !!rc?.ok;
  }
  return { data: { ...data, costOk }, error: null, stage: null, costOk, conflict: null, via: 'direct' };
}

/** A table read past the 1,000 row cap: pages in a fixed order; a failed page is a failure. */
export async function readAll(build, max = 50) {
  const rows = [];
  for (let p = 0; p < max; p++) {
    let res;
    try { res = await build().range(p * PAGE_ROWS, p * PAGE_ROWS + PAGE_ROWS - 1); } catch (e) { res = { data: null, error: e }; }
    if (res?.error) return { data: null, error: res.error };
    rows.push(...(res?.data || []));
    if (!res?.data || res.data.length < PAGE_ROWS) return { data: rows, error: null };
  }
  return { data: null, error: new Error('Too many rows to show at once.') };
}
