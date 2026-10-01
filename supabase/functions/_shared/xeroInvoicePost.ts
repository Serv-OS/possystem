// supabase/functions/_shared/xeroInvoicePost.ts
//
// Sends the daily sales invoice (30 Sep 2026) that _shared/xeroInvoicePlan.js plans, inside the
// existing SyncRun lease (_shared/syncRun.ts), in this order, each step skipped when an earlier
// attempt already posted it:
//   INVOICE        PUT /Invoices      lost answer: GET /Invoices?InvoiceNumbers=, adopted only when
//                                     it is ACCREC and this site's contact
//   PAY:<acct>     PUT /Payments      one per clearing account; lost answer: by its Reference
//   CREDIT         PUT /CreditNotes   the day's refunds; lost answer: by its number
//   REFUND:<acct>  PUT /Payments      the refund payment of the credit note
// Every step is recorded 'sending' WITH the exact payload before the call and 'posted' with
// Xero's id after it, so the Postings history shows exactly what was sent. Xero keeps sales
// invoice numbers unique, so a second SOS-LEEDS-20260929 is refused; that answer is handled as
// the same lookup. A voided or deleted number is never reused.
// A retry (30 Sep 2026 review): a lost answer is looked up as it was SENT (the number, reference
// and amount recorded), never as planned now. Before anything is sent, what Xero already holds
// must still be the day as planned now (retryConflicts): a late check, a refund or a remapped
// clearing account after the invoice went would otherwise pay against the old total. A document
// or payment found in Xero at another amount is recorded (never lost from the log) and the day
// stops with a plain message.
//
// Also the site's Xero setup, cached in xero_config.detail.site and redone when missing or a
// day old: the organisation (currency, short code for links), the site's contact (created with
// no email, or an existing one with no email adopted), and the chosen tracking option (must be
// active). Nothing here creates accounts or tracking: that is done from Setup, after a person
// confirms.

import { xeroApi } from './xero.ts';
import { revenueTaxRates, expenseTaxRates, healedTaxType } from './xeroTax.js';
import { contactName, planSteps, stepIdempotencyKey, xeroDocLink, retryConflicts } from './xeroInvoicePlan.js';
import { loadAccountingDay, venueCategories } from './accountingData.ts';
import { buildGroupedDay, makeGroupResolver } from './accountingGroups.js';

const DAY_MS = 86400000;
const major = (m: number) => Math.round(m) / 100;
const near = (a: any, b: any) => Math.abs(Number(a) - Number(b)) < 0.005;
const q = (s: string) => String(s).replace(/"/g, '');

/** Part of the day is in Xero and the day no longer matches it: nothing more is sent. */
export class DayChangedError extends Error {
  conflicts: { code: string; key?: string; message: string }[];
  constructor(conflicts: { code: string; key?: string; message: string }[]) {
    const said = conflicts.map((c) => c.message).join(' ');
    // Each cause in its own words: a changed site code is put back; a total Xero worked out
    // differently is corrected in Xero; a day that moved on is finished in Xero by hand.
    const message = conflicts.every((c) => c.code === 'number_changed')
      ? `Nothing more was sent. ${said}`
      : conflicts.every((c) => c.code === 'xero_amount_sent')
        ? `Nothing more was sent. ${said} Correct it in Xero by hand, so the invoice and its payments match.`
        : `Part of this day is already in Xero, and the day has changed since (a check or refund that arrived later, or a changed payment account), so nothing more was sent. ${said} Finish the day in Xero by hand, so the invoice and its payments match.`;
    super(message);
    this.conflicts = conflicts;
  }
}

/** A day that cannot be posted until the setup is finished: the items say what is missing. */
export class NotReadyError extends Error {
  notReady: { code: string; message: string }[];
  constructor(notReady: { code: string; message: string }[]) {
    super(notReady.map((n) => n.message).join(' '));
    this.notReady = notReady;
  }
}

/** The business day read with its items and grouped by sales group and rate. */
export async function loadInvoiceDay(ops: any, platform: any, locationId: string, date: string, venue: any, opts: { fromMs?: number | null; mapping?: any } = {}) {
  const loaded: any = await loadAccountingDay(ops, platform, locationId, date, venue, { fromMs: opts.fromMs ?? null, withItems: true, keepRows: true });
  const rows = loaded.rows || { sale: [], refund: [] };
  const categories = await venueCategories(ops, locationId, [...rows.sale, ...rows.refund]);
  const resolver = makeGroupResolver(opts.mapping || {}, categories);
  const grouped = buildGroupedDay({ day: loaded.day, saleRows: rows.sale, refundRows: rows.refund, venue, taxRates: loaded.taxRates, resolver });
  return { grouped, taxRates: loaded.taxRates, day: loaded.day, categories };
}

async function ensureSiteContact(token: string, tenantId: string, id: string | null, name: string): Promise<string> {
  if (id) {
    try {
      const r = await xeroApi(token, tenantId, `/Contacts/${encodeURIComponent(id)}`);
      const c = r?.Contacts?.[0];
      if (c?.ContactID && String(c.ContactStatus || 'ACTIVE').toUpperCase() === 'ACTIVE') return c.ContactID;
    } catch (e) { if (![400, 404].includes((e as any)?.status)) throw e; }   // gone from Xero: made again below
  }
  try {
    const created = await xeroApi(token, tenantId, '/Contacts', { method: 'PUT', body: JSON.stringify({ Contacts: [{ Name: name }] }) });
    const cid = created?.Contacts?.[0]?.ContactID;
    if (cid) return cid;
    throw new Error(`Xero did not create the contact "${name}".`);
  } catch (e) {
    const msg = (e as Error)?.message || '';
    if (!/already|unique/i.test(msg)) throw e;
    const found = await xeroApi(token, tenantId, `/Contacts?where=${encodeURIComponent(`Name=="${q(name)}"`)}`);
    const c = (found?.Contacts || []).find((x: any) => x?.Name === name);
    if (c?.ContactID && !c.EmailAddress) return c.ContactID;
    throw new Error(`Xero already has a contact called "${name}" with an email address, so ServOS will not post to it (Xero could email it). Remove the email address from that contact in Xero, then post again.`);
  }
}

async function checkTracking(token: string, tenantId: string, tr: any, tab: string) {
  const res = await xeroApi(token, tenantId, '/TrackingCategories');
  const cats: any[] = res?.TrackingCategories || [];
  const cat = cats.find((c) => (tr.categoryId && c.TrackingCategoryID === tr.categoryId) || c.Name === tr.categoryName);
  if (!cat || String(cat.Status || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
    throw new NotReadyError([{ code: 'tracking', message: `The tracking category "${tr.categoryName}" is not active in Xero. Choose it again under ${tab}, Site tracking.` }]);
  }
  const opt = (cat.Options || []).find((o: any) => (tr.optionId && o.TrackingOptionID === tr.optionId) || o.Name === tr.optionName);
  if (!opt || String(opt.Status || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
    throw new NotReadyError([{ code: 'tracking', message: `The tracking option "${tr.optionName}" is not active in Xero. Choose it again under ${tab}, Site tracking.` }]);
  }
  return { categoryId: cat.TrackingCategoryID, categoryName: cat.Name, optionId: opt.TrackingOptionID, optionName: opt.Name, checkedAt: new Date().toISOString() };
}

/**
 * The site's Xero setup and the org's tax rates, saved in xero_config.detail. Returns the new
 * detail. Tax rates are read on every call (as the older posting does).
 */
export async function refreshSiteDetail(sb: any, token: string, tenantId: string, locationId: string, cfgDetail: any, mapping: any, siteName: string, opts: { force?: boolean; tab?: string } = {}) {
  const detail: Record<string, any> = { ...(cfgDetail || {}) };
  const site: Record<string, any> = { ...(detail.site || {}) };
  const want = contactName(siteName);
  const tr = mapping?.tracking || {};
  const trKey = tr.none ? 'none' : `${tr.categoryId || tr.categoryName || ''}|${tr.optionId || tr.optionName || ''}`;
  const stale = !!opts.force || !site.at || !(Date.now() - Date.parse(site.at) < DAY_MS) || site.tenantId !== tenantId;
  if (stale) {
    const org = (await xeroApi(token, tenantId, '/Organisation'))?.Organisations?.[0] || {};
    site.baseCurrency = org.BaseCurrency || null;
    site.countryCode = org.CountryCode || null;
    site.shortCode = org.ShortCode || null;
    site.orgName = org.Name || null;
    site.tenantId = tenantId;
  }
  if (stale || site.contactName !== want || !site.contactId) {
    site.contactId = await ensureSiteContact(token, tenantId, site.contactName === want ? (site.contactId || null) : null, want);
    site.contactName = want;
  }
  if (stale || site.trackingKey !== trKey) {
    site.tracking = tr.none || !(tr.categoryName && tr.optionName) ? null : await checkTracking(token, tenantId, tr, opts.tab || 'VAT and accounts');
    site.trackingKey = trKey;
  }
  if (stale) site.at = new Date().toISOString();
  const list = (await xeroApi(token, tenantId, '/TaxRates'))?.TaxRates;
  if (!Array.isArray(list) || !list.length) throw new Error('Xero sent no tax rates, so the VAT rate for each sale cannot be chosen. Nothing was posted.');
  const rev = revenueTaxRates(list);
  detail.salesTaxRates = rev;
  detail.purchaseTaxRates = expenseTaxRates(list);
  detail.taxRatesAt = new Date().toISOString();
  detail.taxType = healedTaxType(detail, rev);
  detail.site = site;
  const { error } = await sb.from('xero_config').update({ detail, tax_type: detail.taxType, updated_at: new Date().toISOString() }).eq('location_id', locationId);
  if (error) throw new Error(`Could not save the Xero setup: ${error.message}`);
  return detail;
}

// ── lookups for an answer that was lost ──────────────────────────────────────

// Found in Xero under this site's number. Another contact or type is not this site's: refused.
// This site's own at another total is still adopted (its id recorded), and the caller stops the
// day with a plain message: the day's figures changed since it was sent.
async function findInvoice(token: string, tenantId: string, number: string, contactId: string) {
  const res = await xeroApi(token, tenantId, `/Invoices?InvoiceNumbers=${encodeURIComponent(number)}`);
  const inv = (res?.Invoices || []).find((i: any) => i?.InvoiceNumber === number);
  if (!inv) return null;
  const status = String(inv.Status || '').toUpperCase();
  if (status === 'VOIDED' || status === 'DELETED') {
    throw new Error(`Xero holds ${number} as ${status.toLowerCase()}. A number Xero has voided or deleted is never used again, so this day was not posted. Ask for help to post it under a new number.`);
  }
  if (String(inv.Type) !== 'ACCREC' || inv.Contact?.ContactID !== contactId) {
    throw new Error(`Xero already has an invoice numbered ${number} that is not this site's takings (its contact differs). Nothing more was sent. Check it in Xero.`);
  }
  return { id: inv.InvoiceID, status: inv.Status, total: Number(inv.Total), number };
}

async function findCreditNote(token: string, tenantId: string, number: string, contactId: string) {
  const res = await xeroApi(token, tenantId, `/CreditNotes?where=${encodeURIComponent(`CreditNoteNumber=="${q(number)}"`)}`);
  const cn = (res?.CreditNotes || []).find((c: any) => c?.CreditNoteNumber === number);
  if (!cn) return null;
  const status = String(cn.Status || '').toUpperCase();
  if (status === 'VOIDED' || status === 'DELETED') {
    throw new Error(`Xero holds credit note ${number} as ${status.toLowerCase()}. Its number is never used again, so the refunds were not posted. Ask for help to post them under a new number.`);
  }
  if (String(cn.Type) !== 'ACCRECCREDIT' || cn.Contact?.ContactID !== contactId) {
    throw new Error(`Xero already has a credit note numbered ${number} that is not this site's refunds (its contact differs). Nothing more was sent. Check it in Xero.`);
  }
  return { id: cn.CreditNoteID, status: cn.Status, total: Number(cn.Total), number };
}

// A payment on THIS document with this reference: the one at the amount recorded, else the only
// live one (adopted, and its amount then checked by the caller).
async function findPayment(token: string, tenantId: string, reference: string, target: { invoiceId?: string | null; creditNoteId?: string | null }, amountMajor: number | null) {
  const res = await xeroApi(token, tenantId, `/Payments?where=${encodeURIComponent(`Reference=="${q(reference)}"`)}`);
  const mine = (res?.Payments || []).filter((x: any) => String(x?.Status || '').toUpperCase() !== 'DELETED'
    && (target.invoiceId ? x?.Invoice?.InvoiceID === target.invoiceId : x?.CreditNote?.CreditNoteID === target.creditNoteId));
  const exact = amountMajor != null ? mine.find((x: any) => near(x?.Amount, amountMajor)) : null;
  const p = exact || (mine.length === 1 ? mine[0] : null);
  return p ? { id: p.PaymentID, status: p.Status, total: Number(p.Amount), reference } : null;
}

const isNumberTaken = (msg: string) => /must be unique|already (been )?(used|assigned|exists)/i.test(msg);

/**
 * Send (or finish) one site day. `run` is the claimed SyncRun; `plan` is planXeroInvoiceDay's
 * output built with the fresh detail (the site's ContactID). Returns { documents, posted, skipped }.
 * Throws DayChangedError before anything is sent when what Xero already holds no longer matches
 * the day, and (after recording it) when a document or payment turns out to be in Xero at
 * another amount.
 */
export async function postInvoiceDay(run: any, plan: any, ctx: { token: string; tenantId: string; locationId: string; date: string; contactId: string; shortCode?: string | null }) {
  const { token, tenantId, locationId, date, contactId } = ctx;
  const conflicts = retryConflicts(plan, run.postings);
  if (conflicts.length) throw new DayChangedError(conflicts);
  const ids: { invoiceId: string | null; creditNoteId: string | null } = { invoiceId: null, creditNoteId: null };
  // A document this run did not create itself (found in Xero) may already carry its payments:
  // those are looked up by reference before any is sent.
  const adopted = { invoice: false, credit_note: false };
  const documents: any[] = [];
  let posted = 0, skipped = 0;
  for (const step of planSteps(plan)) {
    const prev = run.postings[step.key];
    const doc = step.doc;
    const isDoc = step.type === 'invoice' || step.type === 'credit_note';
    const number = doc.number || null;
    const reference = doc.reference || null;
    const want = major(isDoc ? doc.total : doc.amount);
    const payload: any = JSON.parse(JSON.stringify(doc.payload));
    if (step.type === 'payment') {
      if (!ids.invoiceId) throw new Error('The invoice is not in Xero, so its payments were not sent.');
      payload.Invoice = { InvoiceID: ids.invoiceId };
    }
    if (step.type === 'refund') {
      if (!ids.creditNoteId) throw new Error('The credit note is not in Xero, so its refunds were not sent.');
      payload.CreditNote = { CreditNoteID: ids.creditNoteId };
    }
    // Looked up as it was SENT (a lost answer: the number, reference and amount recorded then), or
    // as planned (a number Xero says is taken; a document adopted from Xero whose payments may be
    // there already).
    const asPlanned = { number, reference, total: want };
    const sentTotal = prev?.total != null && Number.isFinite(Number(prev.total)) ? Number(prev.total) : want;
    const asSent = { number: prev?.number || number, reference: prev?.reference || reference, total: sentTotal };
    const lookup = (by: { number: string | null; reference: string | null; total: number }) => (
      step.type === 'invoice' ? findInvoice(token, tenantId, String(by.number), contactId)
        : step.type === 'credit_note' ? findCreditNote(token, tenantId, String(by.number), contactId)
          : findPayment(token, tenantId, String(by.reference), step.type === 'payment' ? { invoiceId: ids.invoiceId } : { creditNoteId: ids.creditNoteId }, by.total));
    let found: any = null;
    let sent = false;
    if (prev?.status === 'posted' && prev.id) {
      found = { id: prev.id, status: prev.xeroStatus || null, total: prev.total };
      skipped += 1;
    } else {
      // An invoice found in Xero with no record here means the day's record was lost: its credit
      // note may be there too, so it is looked up first as well.
      const parentAdopted = (step.type === 'payment' && adopted.invoice) || (step.type === 'refund' && adopted.credit_note) || (step.type === 'credit_note' && adopted.invoice);
      if (prev?.status === 'sending') found = await lookup(asSent);
      else if (parentAdopted) found = await lookup(asPlanned);
      if (found) {
        skipped += 1;
        if (isDoc) adopted[step.type as 'invoice' | 'credit_note'] = true;
      } else {
        const idem = stepIdempotencyKey(locationId, date, step);
        await run.setPosting(step.key, { status: 'sending', type: step.type, number, reference, total: want, idem, payload });
        try {
          if (step.type === 'invoice') {
            const r = await xeroApi(token, tenantId, '/Invoices', { method: 'PUT', body: JSON.stringify({ Invoices: [payload] }), idempotencyKey: idem });
            const inv = r?.Invoices?.[0];
            if (inv?.InvoiceID) found = { id: inv.InvoiceID, status: inv.Status, total: Number(inv.Total), number };
          } else if (step.type === 'credit_note') {
            const r = await xeroApi(token, tenantId, '/CreditNotes', { method: 'PUT', body: JSON.stringify({ CreditNotes: [payload] }), idempotencyKey: idem });
            const cn = r?.CreditNotes?.[0];
            if (cn?.CreditNoteID) found = { id: cn.CreditNoteID, status: cn.Status, total: Number(cn.Total), number };
          } else {
            const r = await xeroApi(token, tenantId, '/Payments', { method: 'PUT', body: JSON.stringify({ Payments: [payload] }), idempotencyKey: idem });
            const p = r?.Payments?.[0];
            if (p?.PaymentID) found = { id: p.PaymentID, status: p.Status, total: Number(p.Amount), reference };
          }
        } catch (e) {
          // Xero refuses a second invoice or credit note with the same number: the same lookup.
          if (isDoc && isNumberTaken((e as Error)?.message || '')) {
            found = await lookup(asPlanned);
            if (found) adopted[step.type as 'invoice' | 'credit_note'] = true;
          }
          if (!found) throw e;
        }
        if (!found) throw new Error(`Xero did not return ${step.type === 'invoice' ? 'the invoice' : step.type === 'credit_note' ? 'the credit note' : 'the payment'} ${number || reference}.`);
        if (!isDoc || !adopted[step.type as 'invoice' | 'credit_note']) { sent = true; posted += 1; } else skipped += 1;
      }
      const kept = { status: 'posted', type: step.type, id: found.id, number: found.number || asSent.number, reference: found.reference || asSent.reference, xeroStatus: found.status || null, payload: sent ? payload : (prev?.payload || payload) };
      // What Xero holds must be the day as planned now. If not, it is recorded first (so it is
      // never lost from the log and never sent again), then the day stops before anything else.
      if (found.total != null && Number.isFinite(Number(found.total)) && !near(found.total, want)) {
        await run.setPosting(step.key, { ...kept, total: Number(found.total), plannedTotal: want });
        const name = isDoc ? (found.number || number) : `The payment ${found.reference || reference}`;
        throw new DayChangedError([{
          code: sent ? 'xero_amount_sent' : 'xero_amount_differs', key: step.key,
          message: sent
            ? `Xero shows ${name} for ${Number(found.total).toFixed(2)} but ServOS sent ${want.toFixed(2)}.`
            : `${name} is in Xero for ${Number(found.total).toFixed(2)}; the day now comes to ${want.toFixed(2)}.`,
        }]);
      }
      await run.setPosting(step.key, { ...kept, total: want });
    }
    if (step.type === 'invoice') ids.invoiceId = found.id;
    if (step.type === 'credit_note') ids.creditNoteId = found.id;
    documents.push({
      key: step.key, type: step.type, number, reference, total: want, xeroId: found.id, status: found.status || null,
      link: step.type === 'invoice' ? xeroDocLink('invoice', found.id, ctx.shortCode) : step.type === 'credit_note' ? xeroDocLink('credit_note', found.id, ctx.shortCode) : null,
    });
  }
  return { documents, posted, skipped };
}
