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

// Push a day's takings to Xero (Receive Money into the clearing account). date = 'YYYY-MM-DD'.
export const xeroSyncSales  = (locationId, date, opts = {}) => call('xero-sales', { locationId, date, ...opts });

// Mapping config: which Xero accounts / tax rate each money flow posts to.
export const xeroOptions     = (locationId) => call('xero-config', { action: 'options', locationId });
export const xeroGetMapping  = (locationId) => call('xero-config', { action: 'get', locationId });
export const xeroSaveMapping = (locationId, mapping) => call('xero-config', { action: 'save', locationId, mapping });
export const xeroSetAutoDaily = (locationId, autoDaily) => call('xero-config', { action: 'save', locationId, autoDaily });

// Push a posted supplier invoice to Xero as an ACCPAY bill (+ scanned image attached).
export const xeroPushBill = (locationId, invoiceId) => call('xero-bills', { locationId, invoiceId });
