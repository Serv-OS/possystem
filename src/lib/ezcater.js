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
//
// Every one of these is the same shape: the action name, the location, and a
// snake_case body the edge function reads straight off the request. The bodies
// are built by the pure helpers in src/lib/ezcaterSettings.js (connectBody,
// mapBody, unmapBody, policyPayload) so the keys are in one place and tested.
//
// THE TOKEN passes through connect_token and is never seen again: it is stored
// in ezcater_connections (service role only) and every projection back to the
// browser is scrubbed. Nothing here logs a body.

export const ezcaterStatus = (locId) => call('ezcater-connect', { action: 'status', ops_location_id: locId });

/** Store the pasted API token, create the subscriber, subscribe every caterer. */
export const ezcaterConnectToken = (locId, body) =>
  call('ezcater-connect', { action: 'connect_token', ops_location_id: locId, ...body });

/** Ask ezCater which caterers this API user can see, and cache them. */
export const ezcaterListCaterers = (locId) =>
  call('ezcater-connect', { action: 'list_caterers', ops_location_id: locId });

/** Point one caterer at THIS venue. The venue is the caller's, never the body's. */
export const ezcaterMapCaterer = (locId, body) =>
  call('ezcater-connect', { action: 'map_caterer', ops_location_id: locId, ...body });

/** Stop that caterer's orders coming here. Scoped to this venue server side. */
export const ezcaterUnmapCaterer = (locId, body) =>
  call('ezcater-connect', { action: 'unmap_caterer', ops_location_id: locId, ...body });

/** auto_accept / active per caterer, accept_enabled / menus_enabled per connection. */
export const ezcaterSetPolicy = (locId, body) =>
  call('ezcater-connect', { action: 'set_policy', ops_location_id: locId, ...body });

/** Tear the event subscriptions down and build them again, for every caterer. */
export const ezcaterResubscribe = (locId) =>
  call('ezcater-connect', { action: 'resubscribe', ops_location_id: locId });

/** Delete the subscriptions and drop the connection. Orders stop arriving. */
export const ezcaterDisconnect = (locId) =>
  call('ezcater-connect', { action: 'disconnect', ops_location_id: locId });

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

/**
 * Put every name on the caterer's pasted ezCater menu on the matching list,
 * before any order. `body` is pasteBody() from src/lib/ezcaterMenuPaste.js:
 * names only. The function re-keys them and reads our menu itself, and never
 * overwrites a row that is already there.
 */
export const ezcaterItemsPaste = (locId, body) =>
  call('ezcater-connect', { action: 'items_paste', ops_location_id: locId, ...body });
