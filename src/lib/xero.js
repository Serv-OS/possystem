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
    let blocked = null;
    let extra = {};
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error;
      if (Array.isArray(ctx?.blocked)) blocked = ctx.blocked;
      // 30 Sep 2026: a sales invoice day that is not Ready says what is missing.
      extra = { ...(Array.isArray(ctx?.notReady) ? { notReady: ctx.notReady } : {}), ...(ctx?.readiness ? { readiness: ctx.readiness } : {}), ...(ctx?.model ? { model: ctx.model } : {}) };
      // 2 Oct 2026: a refused push or replace says whether the day can be replaced with a sales
      // invoice, and whether its old bank transactions are already gone (press Push to finish).
      if (ctx?.replace) extra.replace = ctx.replace;
      if (ctx?.invoicePending) extra.invoicePending = true;
      if (ctx?.date) extra.date = ctx.date;
    } catch { /* ignore */ }
    // 28 Sep 2026: a Xero push refused for a VAT rate with no match names the rates, so the
    // mapping screen can offer a row for each.
    throw Object.assign(new Error(msg || 'request failed'), blocked ? { blocked } : {}, extra);
  }
  if (data?.error) throw Object.assign(new Error(data.error), Array.isArray(data.blocked) ? { blocked: data.blocked } : {}, Array.isArray(data.notReady) ? { notReady: data.notReady } : {});
  return data;
}

export const xeroStatus     = (locationId) => call('xero-connect', { action: 'status', locationId });
export const xeroOAuthStart = (locationId, returnUrl) => call('xero-connect', { action: 'oauth_start', locationId, returnUrl });
export const xeroDisconnect = (locationId) => call('xero-connect', { action: 'disconnect', locationId });
// 7 Oct 2026: a Xero sign in that can see several organisations; which one this site posts to.
export const xeroOrganisations   = (locationId) => call('xero-connect', { action: 'organisations', locationId });
export const xeroSetOrganisation = (locationId, tenantId) => call('xero-connect', { action: 'set_organisation', locationId, tenantId });

// Push a day's takings to Xero (Receive Money into the clearing account). date = 'YYYY-MM-DD'.
export const xeroSyncSales  = (locationId, date, opts = {}) => call('xero-sales', { locationId, date, ...opts });

// Mapping config: which Xero accounts / tax rate each money flow posts to.
export const xeroOptions     = (locationId) => call('xero-config', { action: 'options', locationId });
export const xeroGetMapping  = (locationId) => call('xero-config', { action: 'get', locationId });
export const xeroSaveMapping = (locationId, mapping) => call('xero-config', { action: 'save', locationId, mapping });
export const xeroSetAutoDaily = (locationId, autoDaily) => call('xero-config', { action: 'save', locationId, autoDaily });

// Push a posted supplier invoice to Xero as an ACCPAY bill (+ scanned image attached).
export const xeroPushBill = (locationId, invoiceId) => call('xero-bills', { locationId, invoiceId });

// ── The daily sales invoice (30 Sep 2026) ───────────────────────────────────────
// The site's setup data: name, suggested code, sibling sites on this Xero, categories with 14 days of sales.
export const xeroSiteData = (locationId) => call('xero-config', { action: 'site_data', locationId });
// The Ready checklist, read against Xero's accounts, tracking and tax rates.
export const xeroReadiness = (locationId, startDate) => call('xero-config', { action: 'readiness', locationId, ...(startDate ? { startDate } : {}) });
// mode 'sales_invoice' (only when Ready, from startDate) or 'bank_tx' (the older bank transactions).
export const xeroSetMode = (locationId, mode, startDate) => call('xero-config', { action: 'set_mode', locationId, mode, startDate });
export const xeroFiguresChecked = (locationId, date, hash) => call('xero-config', { action: 'figures_checked', locationId, date, hash });
// One row per site per business day; scope 'org' adds the other sites on this Xero you can open.
export const xeroHistory = (locationId, scope = 'site', days = 60) => call('xero-config', { action: 'history', locationId, scope, days });
export const xeroHistoryDetail = (locationId, date, forLocationId) => call('xero-config', { action: 'history_detail', locationId, date, ...(forLocationId ? { forLocationId } : {}) });
// "Copy my Lightspeed setup": reads Lightspeed's invoices in Xero, suggests the choices. Nothing is saved.
// option { optionId, optionName }: this site's tracking option, so only its own invoices are read.
export const xeroLightspeedSuggest = (locationId, contactName, option) => call('xero-config', {
  action: 'lightspeed_suggest', locationId, contactName,
  ...(option?.optionId ? { optionId: option.optionId } : {}), ...(option?.optionName ? { optionName: option.optionName } : {}),
});
// Creates recommended accounts ({ kind: 'accounts', keys }) or the tracking option ({ kind: 'tracking', categoryName, optionName }) in Xero.
export const xeroSiteCreate = (locationId, payload) => call('xero-config', { action: 'site_create', locationId, ...payload });
export const xeroCopySite = (locationId, fromLocationId) => call('xero-config', { action: 'copy_site', locationId, fromLocationId });
// Replace a day that is in Xero as bank transactions (the old way) with its daily sales invoice
// (2 Oct 2026). The preview changes nothing: it lists the old entries (reconciled or not) and the
// invoice that would be sent. An xero-sales that cannot replace yet answers the preview with no
// `replacePreview` (the screen then says it needs a ServOS update); the real call is only ever
// made after a preview that has one.
export const xeroReplaceDayPreview = (locationId, date) => call('xero-sales', { action: 'replace_day', locationId, date, dryRun: true });
export const xeroReplaceDay = (locationId, date) => call('xero-sales', { action: 'replace_day', locationId, date });
// Check figures: the invoice and credit note that would be sent for a day. Nothing is sent to Xero.
export const xeroCheckFigures = (locationId, date) => call('xero-sales', { locationId, date, dryRun: true, model: 'sales_invoice' });
