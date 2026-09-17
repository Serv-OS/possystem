// src/lib/ezcater.js
//
// Thin client wrappers around the ezcater-connect edge function. The same shape
// as src/lib/hubrise.js: supabase.functions.invoke attaches the signed in Back
// Office user's JWT, and the function enforces location access.
//
// Everything ezCater lives server side. The API token and the webhook signing
// secret are in ezcater_connections and never reach the browser, and
// ezcater_item_links is service role only, so the browser cannot read or write
// a match except through here.

import { supabase } from './supabase';

async function call(fn, body) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    let code = error.code;
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error;
      if (ctx?.code) code = ctx.code;
    } catch { /* a non JSON body, keep the original message */ }
    const e = new Error(msg || 'request failed');
    if (code) e.code = code;
    throw e;
  }
  if (data?.error) {
    const e = new Error(data.error);
    if (data.code) e.code = data.code;
    throw e;
  }
  return data;
}

// ── Connection lifecycle (Back Office) ──────────────────────────────────────
export const ezcaterStatus = (locId) => call('ezcater-connect', { action: 'status', ops_location_id: locId });

// ── Item matching (Back Office, Channels, 3rd Party orders) ─────────────────
//
// Both answer { ok: true, enabled: false } when ezcater_item_links is not there
// yet, because Peter runs that migration by hand. The screen treats that, a
// missing edge function and a 42P01 as one thing: not switched on yet.

export const ezcaterItemsList = (locId) =>
  call('ezcater-connect', { action: 'items_list', ops_location_id: locId });

/**
 * Save one decision about one of their names.
 *
 * `body` comes from saveBody() in src/lib/ezcaterItemRows.js, which builds the
 * key with the shared matching rules and refuses a name that cannot be keyed.
 * Do not hand-roll it here: the edge function rebuilds the key with the same
 * rules and a disagreement would write a row nothing looks up again.
 */
export const ezcaterItemsSave = (locId, body) =>
  call('ezcater-connect', { action: 'items_save', ops_location_id: locId, ...body });
