// src/lib/xero.js
//
// Thin client wrappers around the xero-* edge functions. supabase.functions.invoke
// auto-attaches the signed-in BO user's JWT; the edge functions enforce location access
// and hold the Xero tokens server-side (they never reach the browser).

import { supabase } from './supabase';

async function call(fn, body) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch { /* ignore */ }
    throw new Error(msg || 'request failed');
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export const xeroStatus     = (locationId) => call('xero-connect', { action: 'status', locationId });
export const xeroOAuthStart = (locationId, returnUrl) => call('xero-connect', { action: 'oauth_start', locationId, returnUrl });
export const xeroDisconnect = (locationId) => call('xero-connect', { action: 'disconnect', locationId });
