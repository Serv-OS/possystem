// supabase/functions/xero-sales/index.ts
//
// Push a venue's day of takings into its connected Xero org so sales reconcile against
// bank payouts, splitting every money flow to the accounts the operator maps.
//
// v5.9.11 (19 Sep 2026) — built on the neutral accounting layer shared with the coming
// QuickBooks integration:
//   _shared/businessDay.js      the VENUE business day (time zone + business day start, DST
//                               safe). Until now this was 00:00Z to 23:59Z, which put UK
//                               after-midnight trade and BST's first hour on the wrong day.
//   _shared/accountingDay.js    the day summed per TENDER from closed_checks.tenders (split
//                               bills post card and cash separately; older rows fall back to
//                               their method, older split rows to Unallocated, flagged), with
//                               REFUNDS on the day they were made, split into goods, tax, tip
//                               and service. Cancelled (voided) checks are left out.
//   _shared/accountingData.ts   paged reads (no silent 1000 row cap) and the venue clock.
//   _shared/xeroPostingPlan.js  the Xero transactions: per clearing account one Receive Money
//                               for takings and one Spend Money for refunds.
//   _shared/syncRun.ts          lock + progress + history in xero_sync_log: never deleted,
//                               a half posted day finishes without re-posting what worked.
// Tokens refresh under a compare and set (_shared/xero.ts), so two runs cannot break them.
//
// VAT per rate (28 Sep 2026): each sale posts one goods line per VAT rate (the day split by
// closed_checks.tax_breakdown, _shared/accountingDay.js), at a Xero SALES rate chosen by
// _shared/xeroTax.js. Xero's tax rates are read on every real run, so a cached expense rate
// (INPUT2, which Xero refused for Leeds on 26 Sep) heals itself; a ServOS rate with no Xero
// sales rate stops the day before anything is sent. Service charge posts No VAT by default.
//
// DAILY SALES INVOICE (30 Sep 2026): a site whose xero_config.post_mode is 'sales_invoice'
// posts each business day from its start day as ONE sales invoice (SOS-<SITE>-<YYYYMMDD>)
// with lines by sales group and VAT rate, paid into its clearing accounts, plus a credit note
// for refunds (_shared/xeroInvoicePlan.js, _shared/xeroInvoicePost.ts). Every other site keeps
// the bank transactions below. A day is never mixed: what an earlier attempt sent decides
// (dayModel), and a day already posted the old way is left alone. A site that is not Ready
// records the day as blocked and sends nothing.
// Site safety (phase 0, both models): the site's name is in every older reference and line,
// and a transaction found by reference is adopted only when it is this site's own.
//
//   POST { locationId, date? (YYYY-MM-DD business day), auto?, dryRun?, sample?, model? }
//     model    dry runs only: 'sales_invoice' previews the invoice before the site switches.
//     auto     the nightly post: ignores `date` and books the venue's last business day that
//              ended at least 4 hours ago (the cron's UTC date is not the venue's day; the
//              grace lets offline tills catch up).
//     dryRun   the figures and the planned Xero lines, touching nothing in Xero.
//   A business day that has not ended yet is never posted (it would lock out the rest of it).
//   A day already posted answers `already`; asked by a person, it also says when the day's
//   figures have changed since (checks or refunds that arrived after it was posted).
//   An auto run just after a sign in where Xero did not say which organisation answers `held`
//   and posts nothing (7 Oct 2026, autoHeldAfterSignIn): the next hourly run tries again.
//   Deploy this function BEFORE xero-connect: Back Office promises this hold as soon as
//   xero-connect answers `held`, and only this function keeps it.
//
// REPLACE AN OLD DAY WITH A SALES INVOICE (2 Oct 2026). Peter switched Leeds to the daily sales
// invoice from 27 Sep, pushed 27 Sep again and said "these are supposed to be invoices, I cannot
// find the invoice at all": the day was in Xero the old way, and a day is never mixed, so the
// push answered `already`. Now:
//   POST { action: 'replace_day', locationId, date, dryRun? }
//     Only a signed in Back Office user with access to the venue (never the nightly run), only
//     when the site posts sales invoices, is Ready with figures checked, the day is on or
//     after its first invoice day, and the site already has one day in Xero as a sales invoice
//     (a delete cannot be undone, so the first invoice ever sent is not the one after a delete). The invoice is planned and checked FIRST; then each old bank
//     transaction is read from Xero (any reconciled one refuses the whole day), the intent is
//     recorded, they are deleted one by one, and only when all are gone is the day posted
//     through the same sales invoice path as any push (_shared/xeroReplacePlan.js and
//     _shared/xeroReplaceRun.ts). dryRun: what would be removed and what would be sent, nothing
//     changed. A bank transactions day's `already` answer carries `replace` (replaceable, and why).
// Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi } from '../_shared/xero.ts';
import { postedElsewhere, setupMadeForAnother, autoPostHeld } from '../_shared/xeroOrg.js';
import { venueClock, loadAccountingDay, venueSite } from '../_shared/accountingData.ts';
import { businessDayWindow, isYmd, isBusinessDayOver, lastCompletedBusinessDay, currentBusinessDay, wallClock, addDays } from '../_shared/businessDay.js';
import { buildAccountingDay } from '../_shared/accountingDay.js';
import { planXeroDay, requiredDefaults, DEFAULT_ACCOUNTS, postingStep, idempotencyKey, postingVat, blockedMessage, sampleSaleRows, SAMPLE_TAX_NOTES, adoptable } from '../_shared/xeroPostingPlan.js';
import { planXeroInvoiceDay, planView, planSteps, dayModel, invoiceReadiness, siteNameFrom, siteCodeFromSlug, seenFromGrouped, mappingHash, xeroDocLink, setupTabName } from '../_shared/xeroInvoicePlan.js';
import { loadInvoiceDay, refreshSiteDetail, postInvoiceDay, NotReadyError, DayChangedError } from '../_shared/xeroInvoicePost.ts';
import { revenueTaxRates, expenseTaxRates, healedTaxType } from '../_shared/xeroTax.js';
import { claimSyncRun, readSyncRow } from '../_shared/syncRun.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { replaceability, replaceAnswer, replaceInFlight, replaceDone, replacedWarning, pendingInvoiceError, previewView, progressMessage, replaceVerdict, bankPostings, interrupted, OLD_REMOVED } from '../_shared/xeroReplacePlan.js';
import { readOldTransactions, numbersTaken, takenMessage, removeOldDay, stopRun } from '../_shared/xeroReplaceRun.ts';
import { scanXeroGaps, noticeXeroGaps } from '../_shared/xeroGapScan.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platform = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

const LOG = 'xero_sync_log';
const major = (m: number) => Math.round(m) / 100;
// The nightly post waits this long after a day ends, so a till that was offline, the pending
// check replay or the MPOS recovery queue can land its sales first. (The old UTC post had
// about four hours of grace for UK venues: the UTC day ended at 00:00Z, posted at 04:10Z.)
const AUTO_GRACE_MS = 4 * 3600 * 1000;

// Days posted before v5.9.11 are UTC days, recorded 'ok' with no postings and no venue clock.
const isOldUtcPost = (row: any) => row?.status === 'ok' && !row.detail?.postings && !row.detail?.venue;

// The hand over from UTC days. When the day before was posted the old way, this business day
// starts where that UTC day ended (00:00Z today), so the trade between the two is neither
// missed (a UK night after 01:00, a US evening) nor posted twice (a day start before 01:00).
async function switchoverFromMs(locationId: string, date: string): Promise<number | null> {
  const prev = await readSyncRow(sb, { table: LOG, locationId, kind: 'daily_sales', refDate: addDays(date, -1) });
  return isOldUtcPost(prev) ? Date.parse(`${date}T00:00:00Z`) : null;
}

// `user` is the signed in Back Office user (null for the nightly run's service key): replacing a
// day is only ever done by a person, and the log keeps who.
async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true; user: { id: string; email: string | null } | null } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true, user: null };
  const { data: { user: caller } } = await sb.auth.getUser(token);
  if (!caller) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return { ok: true, user: { id: caller.id, email: caller.email || null } };
}

const byName = (accounts: any[], name: string) => (accounts || []).find((a) => String(a.Name || '').toLowerCase() === name.toLowerCase());
const byCode = (accounts: any[], code: string) => (accounts || []).find((a) => String(a.Code || '').toUpperCase() === code.toUpperCase());

// Auto-provision + cache the baseline wiring (contact, sales account) and the default accounts
// THIS day needs (clearing accounts per tender kind, tips and service liability accounts), in
// xero_config.detail. Only what is needed is ever created. The org's tax rates are read on
// every call (28 Sep 2026): the old one time pick cached INPUT2 for good.
async function ensureDetail(token: string, tenantId: string, locationId: string, needed: string[]) {
  const { data: cfg } = await sb.from('xero_config').select('detail').eq('location_id', locationId).maybeSingle();
  const detail: Record<string, any> = { ...(cfg?.detail || {}) };
  const missing = needed.filter((k) => !detail[(DEFAULT_ACCOUNTS as any)[k].detailKey]);
  const baseDone = detail.contactId && detail.salesAccountCode;

  if (!baseDone || missing.length) {
    const accRes = await xeroApi(token, tenantId, '/Accounts');
    const accounts: any[] = accRes?.Accounts || [];
    for (const k of missing) {
      const d = (DEFAULT_ACCOUNTS as any)[k];
      let acct = byName(accounts, d.name) || byCode(accounts, d.code);
      if (!acct) {
        const body = d.type === 'BANK'
          ? { Name: d.name, Type: 'BANK', BankAccountNumber: d.number, Code: d.code }
          : { Name: d.name, Type: d.type, Code: d.code };
        const created = await xeroApi(token, tenantId, '/Accounts', { method: 'PUT', body: JSON.stringify(body) });
        acct = created?.Accounts?.[0];
        if (acct) accounts.push(acct);
      }
      if (!acct) throw new Error(`Could not set up the ${d.name} account in Xero`);
      // Bank accounts are referenced by id, line accounts by code (by id when it has no code).
      detail[d.detailKey] = d.type === 'BANK' ? acct.AccountID : (acct.Code || acct.AccountID);
    }

    if (!detail.salesAccountCode) {
      const revenue = accounts.find((a: any) => a.Code === '200' && String(a.Type).toUpperCase() === 'REVENUE')
        || accounts.find((a: any) => String(a.Type).toUpperCase() === 'REVENUE' && String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE');
      detail.salesAccountCode = revenue?.Code || '200';
    }
    if (!detail.contactId) {
      const cRes = await xeroApi(token, tenantId, `/Contacts?where=${encodeURIComponent('Name=="ServOS POS Sales"')}`);
      detail.contactId = cRes?.Contacts?.[0]?.ContactID || null;
      if (!detail.contactId) {
        const created = await xeroApi(token, tenantId, '/Contacts', { method: 'PUT', body: JSON.stringify({ Name: 'ServOS POS Sales' }) });
        detail.contactId = created?.Contacts?.[0]?.ContactID || null;
      }
    }
  }

  // 28 Sep 2026: one GET per venue day. A failure stops the post (xeroApi throws): before, it
  // silently fell back to NONE. Only rates Xero allows on sales are kept for sales lines.
  const tRes = await xeroApi(token, tenantId, '/TaxRates');
  const list = tRes?.TaxRates;
  if (!Array.isArray(list) || !list.length) throw new Error('Xero sent no tax rates, so the VAT rate for each sale cannot be chosen. Nothing was posted.');
  const rev = revenueTaxRates(list);
  detail.salesTaxRates = rev;
  detail.purchaseTaxRates = expenseTaxRates(list);
  detail.taxRatesAt = new Date().toISOString();
  detail.taxType = healedTaxType(detail, rev);   // a cached expense rate (INPUT2) becomes the sales rate (OUTPUT2)
  await sb.from('xero_config').upsert({ location_id: locationId, sales_account_code: detail.salesAccountCode, tax_type: detail.taxType, detail, updated_at: new Date().toISOString() }, { onConflict: 'location_id' });
  return detail;
}

// A posting whose answer was lost: look for it in Xero by its reference, date and type before
// sending again (30 Sep 2026: date and type added; the caller adopts it only when adoptable()
// says it is this site's own).
async function findPosted(token: string, tenantId: string, reference: string, date: string, type: string) {
  const [y, m, d] = date.split('-').map(Number);
  const where = `Reference=="${reference.replace(/"/g, '')}" AND Status!="DELETED" AND Type=="${type}" AND Date==DateTime(${y},${m},${d})`;
  const res = await xeroApi(token, tenantId, `/BankTransactions?where=${encodeURIComponent(where)}`);
  return (res?.BankTransactions || []).find((t: any) => t?.Reference === reference) || null;
}

const xeroLink = (id?: string | null, shortCode?: string | null) => xeroDocLink('bank', id, shortCode || null);

// The run just claimed the day: the model is decided again from the postings on the row it
// holds (30 Sep 2026 review). Another attempt of the other model may have sent part of the day
// between the first read and the claim; a day is never posted both ways, so this one stops,
// sends nothing and hands the lease back.
async function modelChanged(run: any, cfg: any, date: string, model: string, auto: boolean, base: any): Promise<Response | null> {
  const now = dayModel({ status: run.status, detail: run.detail }, cfg?.post_mode, cfg?.mapping?.invoiceStartDate, date);
  if (now === model) return null;
  const error = now === 'bank_tx'
    ? 'Another attempt sent part of this day as bank transactions while this one was starting, so nothing was sent. Press again: the day finishes the way it was started.'
    : 'Another attempt sent part of this day as a sales invoice while this one was starting, so nothing was sent. Press again: the day finishes the way it was started.';
  await run.finish(run.status || 'error', {}, { ok: false, auto, model, error: 'model_changed' }).catch(() => {});
  return json({ ...base, error, busy: true, model: now }, 409);
}

// Other venues connected to the same Xero organisation (for the lookup rule and the banner).
async function siblingCount(tenantId: string, locationId: string): Promise<number> {
  const { data, error } = await sb.from('xero_connections').select('location_id').eq('tenant_id', tenantId).neq('location_id', locationId);
  if (error) throw new Error(`Could not read the Xero connections: ${error.message}`);
  return (data || []).length;
}

// The site's name for Xero: the saved one, else the Platform name tidied. '' when unknown (demo).
async function siteNameFor(locationId: string, mapping: any, strict: boolean): Promise<{ name: string; site: any }> {
  let site: any = null;
  try { site = await venueSite(platform, locationId); }
  catch (e) { if (strict) throw e; }
  const name = String(mapping?.site?.name || '').trim() || siteNameFrom(site?.name || '');
  return { name, site };
}

// A planned transaction as the Back Office shows it (major units). `rates` is one row per
// goods line: its VAT as Xero will work it out and as ServOS booked it (null where the line
// is not checked: added-on tax, not VAT registered, or the venue's rates unknown).
function lineView(tx: any, extra: Record<string, unknown> = {}) {
  const def = tx.accountDefault ? (DEFAULT_ACCOUNTS as any)[tx.accountDefault]?.name : null;
  const vat = tx.vat || null;
  return {
    key: tx.key,
    direction: tx.direction === 'SPEND' ? 'refunds' : 'takings',
    methods: tx.methods,
    account: def || tx.accountId,
    total: major(tx.totals.gross),
    sales: major(tx.totals.sales),
    tip: major(tx.totals.tip),
    service: major(tx.totals.service),
    rates: (vat?.lines || []).map((l: any) => ({ label: l.label, taxType: l.taxType, amount: major(l.amount), vat: l.compare ? major(l.taxXero) : null, vatBooked: l.compare ? major(l.taxBooked) : null })),
    vat: vat ? major(vat.xero) : null,
    vatBooked: vat ? major(vat.booked) : null,
    reference: tx.reference,
    ...extra,
  };
}

// The day's summary in major units for the screen, with each direction split by tax rate.
function summaryView(s: any) {
  const buckets = new Map((s.taxBuckets || []).map((b: any) => [b.key, b]));
  const t = (x: any) => ({ count: x.count, total: major(x.gross), sales: major(x.sales), tip: major(x.tip), service: major(x.service), tax: major(x.tax) });
  const rows = (list: any[]) => list.map((g) => ({ method: g.method, kind: g.kind, ...t(g) }));
  const byRate = (x: any) => Object.entries(x?.byRate || {}).map(([key, v]: [string, any]) => {
    const b: any = buckets.get(key);
    return { key, name: b?.name || key, pct: b?.pct ?? null, sales: major(v.sales), tax: major(v.tax) };
  });
  return {
    date: s.date, from: s.fromIso, to: s.toIso,
    sales: { ...t(s.sales.totals), credits: major(s.sales.credits?.gross || 0), byMethod: rows(s.sales.byMethod), byRate: byRate(s.sales.totals) },
    refunds: { ...t(s.refunds.totals), credits: major(s.refunds.credits?.gross || 0), byMethod: rows(s.refunds.byMethod), byRate: byRate(s.refunds.totals) },
  };
}

// Test figures, only when explicitly asked for on an empty day, built from the venue's own tax
// rates (sampleSaleRows, 28 Sep 2026). The rows are made up, so notes on how their VAT was
// recorded are left out.
function sampleSummary(day: any, venue: any, taxRates: any[] | null) {
  const rates = Array.isArray(taxRates) ? taxRates : [];
  const summary = buildAccountingDay({ day, saleRows: sampleSaleRows(day.fromIso, rates), refundRows: [], venue, taxRates: rates });
  summary.warnings = summary.warnings.filter((w: any) => !SAMPLE_TAX_NOTES.has(w.code));
  return summary;
}

// Has this site already posted a day to Xero as a sales invoice? (2 Oct 2026 review.) A replace
// deletes bank transactions that Xero cannot restore, so the first invoice a site ever sends is
// never the one that follows a delete: Xero's own checks on the invoice and its payments are
// only met when they are sent.
async function hasInvoiceDay(locationId: string): Promise<boolean> {
  const { data, error } = await sb.from(LOG).select('id').eq('location_id', locationId).eq('kind', 'daily_sales').eq('status', 'ok').eq('detail->>model', 'sales_invoice').limit(1);
  if (error) throw new Error(`Could not read the sync log: ${error.message}`);
  return (data || []).length > 0;
}

// replaceability with that question answered. The log is only read when everything else allows
// a new replace; one that stopped part way may always be finished.
async function canReplace(row: any, cfgRow: any, date: string, locationId: string) {
  const args = { row, postMode: cfgRow?.post_mode, mapping: cfgRow?.mapping, date };
  const can = replaceability({ ...args, provenInvoice: true });
  if (!can.replaceable || can.resume) return can;
  return replaceability({ ...args, provenInvoice: await hasInvoiceDay(locationId) });
}

// A setup made for another organisation is never posted (see setupMadeForAnother). This run is
// refused. If the STORED setup still names the other organisation (not only this run's copy of
// it), the cached part is cleared and the figures tick dropped, so the refusal can clear: the
// site is then Not Ready until a person checks a day's figures against the organisation it is
// connected to now. Without this the refusal could never lift (nothing else rewrites the cache
// once this check stands in front of the refresh). Returns the words for the refusal.
async function refuseSetupMadeForAnother(locationId: string, detail: any, tenantId: string, tenantName: string | null, tab: string) {
  try {
    const { data: cur } = await sb.from('xero_config').select('mapping,detail').eq('location_id', locationId).maybeSingle();
    if (cur && setupMadeForAnother(cur.detail, tenantId)) {
      const mapping: Record<string, unknown> = { ...((cur.mapping && typeof cur.mapping === 'object') ? cur.mapping : {}) };
      delete mapping.figuresChecked;
      const { error } = await sb.from('xero_config').update({ detail: {}, mapping, updated_at: new Date().toISOString() }).eq('location_id', locationId);
      if (error) console.warn('[xero-sales] could not clear a setup made for another organisation:', error.message);
    }
  } catch (e) { console.warn('[xero-sales] could not clear a setup made for another organisation:', (e as Error)?.message); }
  const was = detail?.site?.orgName ? ` (${detail.site.orgName})` : '';
  return { code: 'organisation', message: `This site's Xero setup was made for another Xero organisation${was}. Check its accounts, VAT rates and tracking for ${tenantName || 'the organisation it is connected to now'} under ${tab}, then check a day's figures.` };
}

// 7 Oct 2026: the short hold on AUTO posting after a sign in (autoPostHeld). A site that was
// disconnected and signs in again when Xero does not ask is stored back on the organisation its
// setup was made for, still Ready and still on auto posting, and Back Office asks the person
// which organisation it should be. Until they have picked (or half an hour has passed) the
// hourly job posts nothing for the site: xero-connect's sign in note carries hold, and an
// organisation record newer than the note is the pick. The second read is only made when the
// note says hold. A read that fails means NOT held: the hold is a courtesy, and the Ready
// checks and setupMadeForAnother remain the real guards.
async function autoHeldAfterSignIn(locationId: string): Promise<boolean> {
  try {
    const last = async (kind: string) => {
      const { data, error } = await sb.from(LOG).select('detail').eq('location_id', locationId).eq('kind', kind).order('created_at', { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      return data?.[0]?.detail || null;
    };
    const signIn = await last('organisation_sign_in');
    if (!autoPostHeld({ signIn, lastRecord: null })) return false;
    return autoPostHeld({ signIn, lastRecord: await last('organisation') });
  } catch (e) { console.warn('[xero-sales] could not read the sign in hold:', (e as Error)?.message); return false; }
}

// 7 Oct 2026: a day posted before this site moved to another Xero organisation is still in the
// old one. Asked by a person, the answer says so plainly, and does not compare the day with
// today's setup (made for the new organisation, so every line would read as changed).
async function elsewhereWarning(prior: any, locationId: string): Promise<{ code: string; message: string } | null> {
  try {
    const [{ data: conn }, { data: rows }] = await Promise.all([
      sb.from('xero_connections').select('tenant_id,tenant_name').eq('location_id', locationId).maybeSingle(),
      sb.from(LOG).select('detail').eq('location_id', locationId).eq('kind', 'organisation').order('created_at', { ascending: false }).limit(50),
    ]);
    if (!conn) return null;
    const other = postedElsewhere({ prior, currentTenantId: conn.tenant_id, moves: (rows || []).map((r: any) => r.detail) });
    if (!other) return null;
    const where = other.name || 'the Xero organisation this site was on before';
    return { code: 'posted_to_other_organisation', message: `This day was posted to ${where}, before this site moved to ${conn.tenant_name || 'its organisation now'}. It is still there and is not in ${conn.tenant_name || 'the new organisation'}.` };
  } catch (e) { console.warn('[xero-sales] could not check which organisation holds the day:', (e as Error)?.message); return null; }
}

// A day already in Xero. Asked by a person, it also compares what was posted with what the
// day comes to now, and says when checks or refunds have arrived since (they are not in Xero).
async function alreadyAnswer(prior: any, base: any, locationId: string, date: string, venue: any, compare: boolean) {
  if (prior?.detail?.model === 'sales_invoice' || prior?.detail?.postings?.INVOICE || prior?.detail?.postings?.CREDIT) {
    return invoiceAlreadyAnswer(prior, base, locationId, date, venue, compare);
  }
  const out: any = { ok: true, already: true, ...base, model: 'bank_tx', lines: prior.detail?.lines || [], warnings: [...(prior.detail?.warnings || [])] };
  const postings = prior.detail?.postings;
  if (!compare) return out;
  const elsewhere = await elsewhereWarning(prior, locationId);
  // No replace is offered for it (the screen reads a missing answer as "needs a ServOS update").
  if (elsewhere) { out.warnings.push(elsewhere); out.replace = replaceAnswer({ replaceable: false, reason: 'other_organisation', message: '' }); return out; }
  // 2 Oct 2026: asked by a person, a day in Xero the old way says whether it can be replaced
  // with a sales invoice, and why not when it cannot (Leeds 27 Sep: "I cannot find the invoice").
  const { data: cfgRow } = await sb.from('xero_config').select('mapping,detail,post_mode').eq('location_id', locationId).maybeSingle();
  out.replace = replaceAnswer(await canReplace(prior, cfgRow, date, locationId));
  if (!postings || !Object.keys(postings).length) return out;
  try {
    const from = prior.detail?.window?.from ? Date.parse(prior.detail.window.from) : null;
    const { summary } = await loadAccountingDay(sb, platform, locationId, date, venue, { fromMs: from });
    const { name: siteName } = await siteNameFor(locationId, cfgRow?.mapping, false);
    // The references a day posted before site names went in have none: compare with those.
    const oldRefs = Object.values(postings).some((p: any) => p?.reference && siteName && !String(p.reference).includes(siteName));
    const plan = planXeroDay(summary, { mapping: cfgRow?.mapping || {}, detail: cfgRow?.detail || {}, site: oldRefs ? null : { name: siteName } });
    const changed: string[] = [];
    const single: string[] = [];
    const fmtVat = (v: Record<string, number>) => Object.entries(v).map(([k, a]) => `${k.replace('|', ' ').trim()} ${Number(a).toFixed(2)}`).join(', ');
    for (const tx of plan.transactions) {
      const p = postings[tx.key];
      const was = p?.status === 'posted' ? Number(p.total) : 0;
      const now = major(tx.totals.gross);
      if (Math.abs(now - (Number.isFinite(was) ? was : 0)) > 0.005) changed.push(`${tx.reference}: posted ${(was || 0).toFixed(2)}, now ${now.toFixed(2)}`);
      if (p?.status !== 'posted') continue;
      // 28 Sep 2026: the VAT lines too. A posting from before the split has none recorded.
      const vatNow = postingVat(tx);
      if (p.vat && typeof p.vat === 'object') {
        const keys = new Set([...Object.keys(p.vat), ...Object.keys(vatNow)]);
        if ([...keys].some((k) => Math.abs(Number(p.vat[k] || 0) - Number(vatNow[k] || 0)) > 0.005)) changed.push(`${tx.reference}: VAT lines posted ${fmtVat(p.vat)}, now ${fmtVat(vatNow)}`);
      } else if (tx.vat.lines.length > 1) {
        single.push(`${tx.reference} holds ${tx.vat.lines.map((l: any) => `${l.label || 'sales'} ${major(l.amount).toFixed(2)}`).join(', ')}`);
      }
    }
    if (single.length) {
      out.warnings.push({ code: 'posted_single_rate', message: `Posted before VAT was split per rate, so all of it went at one VAT rate. Correct it in Xero: ${single.join('; ')}.` });
    }
    for (const [k, p] of Object.entries(postings) as [string, any][]) {
      if (p?.status === 'posted' && !plan.transactions.some((tx: any) => tx.key === k)) changed.push(`${p.reference}: posted ${Number(p.total || 0).toFixed(2)}, now nothing`);
    }
    if (changed.length) {
      out.warnings.push({ code: 'changed_since_posted', message: `This day has changed since it was posted (checks or refunds arrived later, or the mapping changed). They are not in Xero; adjust there. ${changed.join('; ')}` });
    }
  } catch (e) { console.warn('[xero-sales] could not compare the posted day:', (e as Error)?.message); }
  return out;
}

// A day already posted as a sales invoice: its documents, and (asked by a person) whether the
// day's figures have changed since.
async function invoiceAlreadyAnswer(prior: any, base: any, locationId: string, date: string, venue: any, compare: boolean) {
  const docs = prior.detail?.documents || [];
  const out: any = { ok: true, already: true, ...base, model: 'sales_invoice', documents: docs, lines: [], warnings: [...(prior.detail?.warnings || [])] };
  if (!compare) return out;
  const elsewhere = await elsewhereWarning(prior, locationId);
  if (elsewhere) { out.warnings.push(elsewhere); return out; }
  try {
    const { data: cfgRow } = await sb.from('xero_config').select('mapping,detail').eq('location_id', locationId).maybeSingle();
    const mapping = cfgRow?.mapping || {};
    const from = prior.detail?.window?.from ? Date.parse(prior.detail.window.from) : null;
    const { grouped } = await loadInvoiceDay(sb, platform, locationId, date, venue, { fromMs: from, mapping });
    const { name } = await siteNameFor(locationId, mapping, false);
    const plan = planXeroInvoiceDay(grouped, { mapping, detail: cfgRow?.detail || {}, site: { name, code: mapping.site?.code || prior.detail?.site?.code || '' }, date, currency: venue.currency });
    const changed: string[] = [];
    const was = (t: string) => docs.find((d: any) => d.type === t);
    for (const [t, doc] of [['invoice', plan.invoice], ['credit_note', plan.creditNote]] as [string, any][]) {
      const posted = was(t);
      const now = doc ? doc.total / 100 : 0;
      const then = posted ? Number(posted.total) : 0;
      if (Math.abs(now - then) > 0.005) changed.push(`${posted?.number || doc?.number}: posted ${then.toFixed(2)}, now ${now.toFixed(2)}`);
    }
    if (changed.length) out.warnings.push({ code: 'changed_since_posted', message: `This day has changed since it was posted (checks or refunds arrived later). They are not in Xero; adjust there. ${changed.join('; ')}` });
  } catch (e) { console.warn('[xero-sales] could not compare the posted invoice day:', (e as Error)?.message); }
  return out;
}

// What stops a day posting as a sales invoice, from the choices and the day alone (nothing is
// read from Xero): the plan's own gaps, then the mapping-only items of the Ready checklist
// (site, tracking, tips, figures checked, a start day).
function invoiceNotReady(grouped: any, mapping: any, detail: any, siteArg: any, date: string, venue: any) {
  const seen = seenFromGrouped(grouped);
  const addedOn = grouped.summary.defaultTaxBucket?.key === 'excl';
  const pre = planXeroInvoiceDay(grouped, { mapping, detail: detail || {}, site: siteArg, date, currency: venue.currency });
  const ready = invoiceReadiness(mapping, { addedOn, seen: { ...seen, groups: [], discountGroups: [], moneyKeys: [], gift: false, service: false } });
  const notReady = [...pre.notReady, ...ready.items.filter((i: any) => !i.ok).map((i: any) => ({ code: i.key, message: i.detail || i.label }))];
  return { pre, notReady, addedOn, seen };
}

// The daily sales invoice: dry run (Check figures) or a real post.
async function invoiceDay(o: { base: any; locationId: string; date: string; venue: any; clock: any; auto: boolean; dryRun: boolean; cfgRow: any; key: any; fromMs: number | null }) {
  const { base, locationId, date, venue, clock, auto, dryRun, cfgRow, key, fromMs } = o;
  const mapping = cfgRow?.mapping || {};
  const { name: siteName, site } = await siteNameFor(locationId, mapping, !dryRun);
  let code = String(mapping.site?.code || '');
  let codeSuggested = false;
  if (!code && dryRun && site?.onlineSlug) {
    // Check figures before the site is set up: show the code the setup would suggest.
    let sibs: string[] = [];
    if (site.companyId) {
      const { data } = await platform.from('locations').select('online_slug').eq('company_id', site.companyId);
      sibs = (data || []).map((r: any) => r.online_slug).filter((x: any) => x && x !== site.onlineSlug);
    }
    code = siteCodeFromSlug(site.onlineSlug, sibs);
    codeSuggested = true;
  }
  const { grouped } = await loadInvoiceDay(sb, platform, locationId, date, venue, { fromMs, mapping });
  const summary = grouped.summary;
  if (fromMs != null) {
    base.from = summary.fromIso;
    summary.warnings.unshift({ code: 'switchover', message: `The first day posted on the venue business day. It starts at ${summary.fromIso.slice(11, 16)} UTC, where the day before (posted the old way, as a UTC day) ended, so nothing is missed or posted twice.` });
  }
  if (summary.empty) return json({ ok: true, empty: true, ...base, lines: [], warnings: summary.warnings, summary: summaryView(summary) });
  const seen = seenFromGrouped(grouped);
  const siteArg = { name: siteName, code };

  if (dryRun) {
    const plan = planXeroInvoiceDay(grouped, { mapping, detail: cfgRow?.detail || {}, site: siteArg, date, currency: venue.currency });
    const warnings = [...summary.warnings, ...plan.warnings];
    if (!Array.isArray(cfgRow?.detail?.salesTaxRates)) {
      warnings.push({ code: 'tax_rates_unknown', message: "Xero's tax rates have not been read for this venue yet, so these VAT rates assume a UK organisation. Posting reads them from Xero first." });
    }
    if (codeSuggested) warnings.push({ code: 'site_code_suggested', message: `The site code ${code} is only a suggestion until it is saved under VAT and accounts.` });
    const readiness = invoiceReadiness(mapping, { seen, taxBlocked: plan.blockedRates });
    return json({
      ok: true, dryRun: true, ...base, model: 'sales_invoice', summary: summaryView(summary), invoice: planView(plan), lines: [],
      warnings, blocked: plan.blockedRates, problems: plan.blocked, notReady: plan.notReady, readiness, seen,
      mappingHash: mappingHash(mapping), site: { name: siteName, code, suggested: codeSuggested },
    });
  }

  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'Xero is not configured.' }, 400);
  const claim = await claimSyncRun(sb, key);
  if (claim.done) return json(await alreadyAnswer(claim.done, base, locationId, date, venue, false));
  if (!claim.run) return json({ ...base, error: 'This day is being posted to Xero right now. Try again in a few minutes.', busy: true }, 409);
  const run = claim.run;
  const changed = await modelChanged(run, cfgRow, date, 'sales_invoice', auto, base);
  if (changed) return changed;
  const window = { from: summary.fromIso, to: summary.toIso };
  const addedOn = summary.defaultTaxBucket?.key === 'excl';
  try {
    // Nothing is sent while the site is not Ready (the mapping-only checks, then the plan's own).
    const { notReady } = invoiceNotReady(grouped, mapping, cfgRow?.detail, siteArg, date, venue);
    if (notReady.length) throw new NotReadyError(notReady);
    const { accessToken, tenantId, tenantName } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
    if (setupMadeForAnother(cfgRow?.detail, tenantId)) throw new NotReadyError([await refuseSetupMadeForAnother(locationId, cfgRow?.detail, tenantId, tenantName, setupTabName(addedOn))]);
    const detail = await refreshSiteDetail(sb, accessToken, tenantId, locationId, cfgRow?.detail || {}, mapping, siteName, { tab: setupTabName(addedOn) });
    if (detail.site?.baseCurrency && String(detail.site.baseCurrency).toUpperCase() !== String(venue.currency).toUpperCase()) {
      throw new NotReadyError([{ code: 'currency', message: `Xero's base currency is ${detail.site.baseCurrency} but this venue trades in ${venue.currency}.` }]);
    }
    const plan = planXeroInvoiceDay(grouped, { mapping, detail, site: siteArg, date, currency: venue.currency });
    const warnings = [...summary.warnings, ...plan.warnings];
    await run.save({ detail: { model: 'sales_invoice', date, venue: clock, window, warnings, summary: summaryView(summary), site: siteArg, totals: planView(plan)?.totals || null, notReady: null } });
    if (plan.blocked.length) throw Object.assign(new Error(plan.blocked.map((b: any) => b.message).join(' ')), { blocked: plan.blockedRates, problems: plan.blocked });
    if (plan.notReady.length) throw new NotReadyError(plan.notReady);

    const res = await postInvoiceDay(run, plan, { token: accessToken, tenantId, locationId, date, contactId: detail.site.contactId, shortCode: detail.site.shortCode || null });
    const extra: any[] = [];
    const planned = new Set(planSteps(plan).map((st: any) => st.key));
    for (const [k, p] of Object.entries(run.postings) as [string, any][]) {
      if (p?.status === 'posted' && !planned.has(k)) extra.push({ code: 'posted_not_in_plan', message: `${p.number || p.reference || k} was posted by an earlier attempt and is no longer part of this day's figures. Check it in Xero.` });
    }
    // 2 Oct 2026: a day that replaced old bank transactions keeps a note of what it replaced.
    const replaced = replacedWarning(run.detail?.replace);
    const all = [...warnings, ...extra, ...(replaced ? [replaced] : [])];
    const ids = res.documents.map((d: any) => d.xeroId).filter(Boolean).join(',');
    const replace = run.detail?.replace ? { replace: replaceDone(run.detail.replace, { at: new Date().toISOString(), documents: res.documents }) } : {};
    await run.finish('ok', { xero_id: ids, detail: { model: 'sales_invoice', tenant_id: tenantId, documents: res.documents, warnings: all, error: null, notReady: null, problems: null, ...replace } }, { ok: true, auto, model: 'sales_invoice', posted: res.posted, skipped: res.skipped });
    return json({ ok: true, ...base, model: 'sales_invoice', documents: res.documents, invoice: planView(plan), lines: [], warnings: all, summary: summaryView(summary) });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error('[xero-sales] invoice day', msg);
    const notReady = e instanceof NotReadyError ? e.notReady : null;
    // The day changed after part of it reached Xero: pressing again would not help, so its own words.
    const dayChanged = e instanceof DayChangedError ? e.conflicts : null;
    const problems = dayChanged || (e as any)?.problems || null;
    const done = Object.values(run.postings).filter((p: any) => p?.status === 'posted').length;
    const status = done ? 'partial' : 'error';
    const said = notReady ? `This site is not ready to post its sales invoice, so nothing was sent. ${msg}`
      : dayChanged ? msg
        : problems ? `${msg}${done ? '' : ' Nothing was posted.'}`
          : done ? `Part of the day reached Xero before this failed: ${msg}. Press again to finish; what is already in Xero will not be sent twice.` : msg;
    // 2 Oct 2026: the old bank transactions of this day were removed for this invoice. Until the
    // invoice is in Xero the row says so, so the day never looks posted when nothing is there.
    const error = pendingInvoiceError(run.detail?.replace, said, !!done);
    if (!run.lost) await run.finish(status, { detail: { model: 'sales_invoice', window, error, notReady, problems } }, { ok: false, auto, model: 'sales_invoice', error, posted: done }).catch(() => {});
    return json({ ...base, model: 'sales_invoice', error, partial: !!done, ...(notReady ? { notReady } : {}), ...((e as any)?.blocked ? { blocked: (e as any).blocked } : {}) }, notReady ? 400 : 500);
  }
}

// Replace a day that is in Xero as bank transactions (the old way) with its daily sales invoice
// (2 Oct 2026, Leeds 27 Sep: "these are supposed to be invoices, I cannot find the invoice at
// all"). Asked for by a person only. The order matters and every step can be pressed again:
//   1. the invoice is planned and checked first (Ready, figures checked, tax rates, the number
//      free in Xero), so nothing is removed for an invoice that could not then be sent;
//   2. removeOldDay: the old transactions are read (any reconciled one refuses the whole day),
//      the intent is recorded, they are deleted, and the record is cleared only when all are gone;
//   3. the day is posted through invoiceDay, the same path as any push. If that fails the row
//      says: old transactions removed, invoice not sent yet, press Push again.
// A dry run answers what would be removed and what would be sent, and changes nothing.
async function replaceDay(o: { base: any; locationId: string; date: string; venue: any; clock: any; dryRun: boolean; user: { id: string; email: string | null }; key: any }) {
  const { base, locationId, date, venue, clock, dryRun, user, key } = o;
  const { data: cfgRow } = await sb.from('xero_config').select('mapping,detail,post_mode').eq('location_id', locationId).maybeSingle();
  const mapping = cfgRow?.mapping || {};
  const prior = await readSyncRow(sb, key);
  const can = await canReplace(prior, cfgRow, date, locationId);
  const fromMs = await switchoverFromMs(locationId, date);
  const invoiceArgs = { base, locationId, date, venue, clock, auto: false, key, fromMs };
  const refuse = (c: any, status = 400) => json({ ...base, model: 'bank_tx', error: c.message, code: c.reason, replace: replaceAnswer(c) }, status);
  // 3. The day as a sales invoice, through the same path as any push. A failure here says plainly
  // that the old transactions are gone and the invoice is not in Xero yet (invoicePending).
  const postInvoice = async (cfg: any, removed: any[] | null) => {
    const res = await invoiceDay({ ...invoiceArgs, dryRun: false, cfgRow: cfg });
    const out: any = await res.json().catch(() => ({}));
    const replaced = removed ? { old: removed } : null;
    if (out?.ok) return json({ ...out, replaced }, res.status);
    const said = String(out?.error || 'The sales invoice was not sent.');
    return json({ ...out, error: said.startsWith(OLD_REMOVED) ? said : pendingInvoiceError({ state: 'deleted' }, said), invoicePending: true, replaced }, res.status);
  };

  // The old transactions are already gone and the invoice is not in Xero yet: a normal push now.
  if (can.reason === 'invoice_pending') {
    if (!dryRun) return await postInvoice(cfgRow, null);
    return json({ ok: true, dryRun: true, ...base, model: 'sales_invoice', replace: replaceAnswer(can), replacePreview: { canReplace: true, pending: true, resume: true, problems: [], old: [], invoice: can.number ? { number: can.number, total: null } : null, creditNote: null } });
  }
  if (!can.replaceable) return refuse(can);

  // 1. The invoice, planned and checked before anything is touched.
  const { name: siteName } = await siteNameFor(locationId, mapping, !dryRun);
  const siteArg = { name: siteName, code: String(mapping.site?.code || '') };
  const { grouped } = await loadInvoiceDay(sb, platform, locationId, date, venue, { fromMs, mapping });
  const summary = grouped.summary;
  if (summary.empty) return refuse({ ...can, replaceable: false, reason: 'empty', message: 'ServOS has no sales or refunds for this day now, so there is no invoice to send in its place. Nothing was changed.' });
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'Xero is not configured.' }, 400);
  const numbers = (plan: any) => ({ invoice: plan.invoice ? plan.number : null, creditNote: plan.creditNote ? plan.creditNoteNumber : null });

  if (dryRun) {
    const { pre: plan, notReady } = invoiceNotReady(grouped, mapping, cfgRow?.detail, siteArg, date, venue);
    const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
    const api = (path: string, init?: any) => xeroApi(accessToken, tenantId, path, init);
    const checked = await readOldTransactions(api, bankPostings(prior?.detail));
    const taken = await numbersTaken(api, numbers(plan));
    const problems = [...notReady.map((n: any) => n.message), ...plan.blocked.map((b: any) => b.message), ...(taken.length ? [takenMessage(taken)] : [])];
    return json({
      ok: true, dryRun: true, ...base, model: 'bank_tx', replace: replaceAnswer(can),
      replacePreview: previewView({ checked, verdict: replaceVerdict(checked), plan, problems, resume: can.resume }),
      invoice: planView(plan), summary: summaryView(summary), warnings: [...summary.warnings, ...plan.warnings],
    });
  }

  const claim = await claimSyncRun(sb, key, { allowDone: true });
  if (!claim.run) return json({ ...base, error: 'This day is being posted to Xero right now. Try again in a few minutes.', busy: true }, 409);
  const run = claim.run;
  let removed: any[] | null = null;
  let detail = cfgRow?.detail || {};
  try {
    // Decided again on the row this run holds: another attempt may have changed the day meanwhile.
    const now = await canReplace({ status: run.status, detail: run.detail }, cfgRow, date, locationId);
    if (now.reason === 'invoice_pending') {
      await run.finish(run.status, {}, { ok: true, action: 'replace_day', auto: false, removed: 0 });
    } else if (!now.replaceable) {
      await run.finish(run.status, {}, { ok: false, action: 'replace_day', auto: false, error: now.message });
      return refuse(now);
    } else {
      const { notReady, addedOn } = invoiceNotReady(grouped, mapping, cfgRow?.detail, siteArg, date, venue);
      if (notReady.length) throw new NotReadyError(notReady);
      const { accessToken, tenantId, tenantName } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      // The same rule as any push: a replace never refreshes its way past a setup made for another organisation.
      if (setupMadeForAnother(cfgRow?.detail, tenantId)) throw new NotReadyError([await refuseSetupMadeForAnother(locationId, cfgRow?.detail, tenantId, tenantName, setupTabName(addedOn))]);
      detail = await refreshSiteDetail(sb, accessToken, tenantId, locationId, cfgRow?.detail || {}, mapping, siteName, { tab: setupTabName(addedOn) });
      if (detail.site?.baseCurrency && String(detail.site.baseCurrency).toUpperCase() !== String(venue.currency).toUpperCase()) {
        throw new NotReadyError([{ code: 'currency', message: `Xero's base currency is ${detail.site.baseCurrency} but this venue trades in ${venue.currency}.` }]);
      }
      const plan = planXeroInvoiceDay(grouped, { mapping, detail, site: siteArg, date, currency: venue.currency });
      if (plan.blocked.length) throw Object.assign(new Error(plan.blocked.map((b: any) => b.message).join(' ')), { blocked: plan.blockedRates });
      if (plan.notReady.length) throw new NotReadyError(plan.notReady);
      const api = (path: string, init?: any) => xeroApi(accessToken, tenantId, path, init);
      const taken = await numbersTaken(api, numbers(plan));
      if (taken.length) throw Object.assign(new Error(takenMessage(taken)), { refused: true });
      // 2. The old transactions, removed from Xero (or the run stops and the row says how far it got).
      const res = await removeOldDay(run, api, { by: user });
      if (!res.ok) return json({ ...base, model: 'bank_tx', error: res.message, code: res.code, partial: !res.nothingChanged, replace: { ...replaceAnswer(now), resume: !res.nothingChanged } }, 409);
      removed = res.removed || [];
    }
  } catch (e) {
    const msg = ((e as Error)?.message || String(e)).replace(/\s*Nothing was posted\.\s*$/, '');
    console.error('[xero-sales] replace day', msg);
    const notReady = e instanceof NotReadyError ? e.notReady : null;
    const words = notReady ? `This site is not ready to post its sales invoice. ${msg}` : msg;
    // Before the intent was recorded nothing was changed; after it the row says how far it got.
    // 2 Oct 2026 review: the words come from what this run recorded, never a fixed sentence. A
    // run that lost its lease after deleting two of three used to answer "Nothing was changed".
    let { partial, message: error } = interrupted(run.detail?.replace, words);
    if (!run.lost) {
      try {
        const st = await stopRun(run, 'error', { words, certain: false });
        error = st.message || error;
        partial = !st.nothingChanged;
      } catch (x) { console.warn('[xero-sales] replace day: could not release the day:', (x as Error)?.message); }
    }
    const refused = !!notReady || !!(e as any)?.refused || !!(e as any)?.blocked;
    return json({
      ...base, model: 'bank_tx', error, ...(notReady ? { notReady } : {}), ...((e as any)?.blocked ? { blocked: (e as any).blocked } : {}),
      ...(partial ? { partial: true, replace: { ...replaceAnswer(can), replaceable: true, resume: true, reason: null } } : {}),
    }, partial ? 409 : refused ? 400 : 500);
  }

  return await postInvoice({ ...cfgRow, detail }, removed);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const locationId = body.locationId || body.location_id;
  if (!locationId) return json({ error: 'locationId required' }, 400);
  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  const dryRun = !!body.dryRun;
  const auto = !!body.auto;
  // 2 Oct 2026: replacing a day is asked for by a signed in person, for one named day. The
  // nightly run (auto, or the service key) never replaces anything.
  const replacing = body.action === 'replace_day';
  if (replacing && (auto || !acc.user)) return json({ error: 'Only a signed in Back Office user can replace a day in Xero.' }, 403);
  if (replacing && !isYmd(body.date)) return json({ error: 'Choose the day to replace.' }, 400);

  let venue;
  try { venue = await venueClock(platform, locationId); }
  catch (e) { return json({ error: (e as Error).message }, 500); }
  if (!venue.found && !dryRun) {
    return json({ error: 'This venue has no location record with a time zone, so its business day is unknown. Nothing was posted.' }, 400);
  }
  const now = Date.now();
  const date = !auto && isYmd(body.date) ? body.date
    : lastCompletedBusinessDay(auto ? now - AUTO_GRACE_MS : now, venue.timezone, venue.dayStart);
  const day = businessDayWindow(date, venue.timezone, venue.dayStart);
  const clock = {
    timezone: venue.timezone, dayStart: venue.dayStart, currency: venue.currency,
    currentDay: currentBusinessDay(now, venue.timezone, venue.dayStart),
    lastCompletedDay: lastCompletedBusinessDay(now, venue.timezone, venue.dayStart),
  };
  const base: any = { date, currency: venue.currency, from: day.fromIso, to: day.toIso, venue: clock };

  // 8 Oct 2026 (D5): every hourly auto run also scans the last 14 completed business days of
  // this site for a day with sales and no ok posting, and writes the venue notice once a gap is
  // older than two days. It never posts a missed day (a day keyed into Xero by hand would be
  // posted twice); a person presses Push on the Postings tab. A scan that fails is logged and
  // never stops the day's own post.
  if (auto && !dryRun) {
    try {
      const scan = await scanXeroGaps(sb, platform, locationId, { now, venue });
      if (scan.gaps.length) {
        const { name } = await siteNameFor(locationId, null, false);
        const wrote = await noticeXeroGaps(sb, locationId, name || 'This site', scan.gaps, venue.currency);
        console.warn(`[xero-sales] gap scan: ${scan.gaps.map((g) => g.date).join(', ')} not posted at ${locationId}; ${wrote} new notice(s)`);
      }
    } catch (e) { console.warn('[xero-sales] gap scan failed:', (e as Error)?.message); }
  }

  if (!dryRun && !isBusinessDayOver(date, now, venue.timezone, venue.dayStart)) {
    const ends = wallClock(day.toMs, venue.timezone);
    const hhmm = `${String(Math.floor(ends.minutes / 60)).padStart(2, '0')}:${String(ends.minutes % 60).padStart(2, '0')}`;
    return json({ ...base, error: `The ${date} business day is still trading. It ends at ${hhmm} on ${ends.ymd} venue time. Post it after that.`, code: 'day_open' }, 400);
  }

  // 7 Oct 2026: the hourly job waits while a person is being asked which organisation this
  // site's books are in (autoHeldAfterSignIn). Before anything is read, claimed or posted, and
  // with NO row written for the day, so the next hourly run simply tries again. A push by a
  // person (auto false) is never held.
  if (auto && !dryRun && await autoHeldAfterSignIn(locationId)) {
    return json({ ok: true, held: true, ...base, reason: 'Someone has just signed in to Xero for this site and Xero did not say which organisation. Auto posting waits up to half an hour for them to pick it in Back Office. Nothing was posted. The next hourly run tries again.' });
  }

  const key = { table: LOG, locationId, kind: 'daily_sales', refDate: date };
  try {
    if (replacing && acc.user) return await replaceDay({ base, locationId, date, venue, clock, dryRun, user: acc.user, key });
    const prior = await readSyncRow(sb, key);
    if (!dryRun && prior?.status === 'ok') return json(await alreadyAnswer(prior, base, locationId, date, venue, !auto));

    const { data: cfg } = await sb.from('xero_config').select('mapping,detail,post_mode').eq('location_id', locationId).maybeSingle();
    // 2 Oct 2026: a replace stopped part way (some old transactions removed, some not). A normal
    // push would post the day the old way again over the gaps, so it is refused: the replace is
    // finished first.
    if (!dryRun && replaceInFlight(prior)) {
      const can = await canReplace(prior, cfg, date, locationId);
      return json({ ...base, model: 'bank_tx', error: prior?.detail?.error || progressMessage(prior?.detail?.replace), code: 'replace_in_flight', replace: replaceAnswer(can) }, 409);
    }
    // Which model posts this day (never mixed): a dry run may ask for either to preview.
    const model = dryRun && (body.model === 'sales_invoice' || body.model === 'bank_tx') ? body.model
      : dayModel(prior, cfg?.post_mode, cfg?.mapping?.invoiceStartDate, date);
    base.model = model;
    const fromMs = await switchoverFromMs(locationId, date);
    if (model === 'sales_invoice') return await invoiceDay({ base, locationId, date, venue, clock, auto, dryRun, cfgRow: cfg, key, fromMs });

    let { summary, taxRates } = await loadAccountingDay(sb, platform, locationId, date, venue, { fromMs });
    if (fromMs != null) {
      base.from = summary.fromIso;
      summary.warnings.unshift({ code: 'switchover', message: `The first day posted on the venue business day. It starts at ${summary.fromIso.slice(11, 16)} UTC, where the day before (posted the old way, as a UTC day) ended, so nothing is missed or posted twice.` });
    }
    const sample = !!body.sample && !auto && summary.empty;   // test figures ONLY when explicitly asked for
    if (sample) summary = sampleSummary(day, venue, taxRates);
    // A day with no sales and no refunds posts nothing: the nightly post must never write
    // test figures or empty transactions into a live ledger.
    if (summary.empty) return json({ ok: true, empty: true, ...base, lines: [], warnings: summary.warnings, summary: summaryView(summary) });

    const cfgRow = cfg;
    const mapping = cfgRow?.mapping || {};
    const { name: siteName } = await siteNameFor(locationId, mapping, !dryRun);
    const siteArg = siteName ? { name: siteName } : null;

    if (dryRun) {
      const plan = planXeroDay(summary, { mapping, detail: cfgRow?.detail || {}, sample, site: siteArg });
      const warnings = [...summary.warnings, ...plan.warnings];
      // No real push has read this org's tax rates yet: the rates shown are Xero's UK codes,
      // assumed. Say so, since the push may choose differently or stop.
      if (!Array.isArray(cfgRow?.detail?.salesTaxRates)) {
        warnings.push({ code: 'tax_rates_unknown', message: "Xero's tax rates have not been read for this venue yet, so these VAT rates assume a UK organisation. The push reads them from Xero first, and may choose other rates or stop if a ServOS rate has no match." });
      }
      return json({ ok: true, dryRun: true, sample, ...base, model: 'bank_tx', summary: summaryView(summary), lines: plan.transactions.map((tx: any) => lineView(tx)), warnings, blocked: plan.blocked });
    }

    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'Xero is not configured.' }, 400);
    const claim = await claimSyncRun(sb, key);
    if (claim.done) return json(await alreadyAnswer(claim.done, base, locationId, date, venue, false));
    if (!claim.run) return json({ ...base, error: 'This day is being posted to Xero right now. Try again in a few minutes.', busy: true }, 409);
    const run = claim.run;
    const changed = await modelChanged(run, cfg, date, 'bank_tx', auto, base);
    if (changed) return changed;

    const lines: any[] = [];
    const extraWarnings: any[] = [];
    let posted = 0, skipped = 0;
    try {
      const { accessToken, tenantId, tenantName } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      if (setupMadeForAnother(cfg?.detail, tenantId)) throw new Error(`${(await refuseSetupMadeForAnother(locationId, cfg?.detail, tenantId, tenantName, 'Posting')).message} Nothing was posted.`);
      const detail = await ensureDetail(accessToken, tenantId, locationId, requiredDefaults(summary, mapping));
      const plan = planXeroDay(summary, { mapping, detail, sample, site: siteArg });
      const siblings = await siblingCount(tenantId, locationId);
      const shortCode = detail.site?.shortCode || null;
      const warnings = [...summary.warnings, ...plan.warnings];
      await run.save({ detail: { model: 'bank_tx', date, venue: clock, window: { from: summary.fromIso, to: summary.toIso }, warnings, summary: summaryView(summary), site: siteArg, notReady: null, problems: null } });
      // 8 Oct 2026: a sale with no VAT recorded holds the day (never posted at VAT 0).
      if (plan.holds?.length) throw Object.assign(new Error(plan.holds.map((h: any) => h.message).join(' ')), { held: plan.holds });
      // A ServOS rate with no Xero sales rate: refused before anything is sent (no guessing).
      if (plan.blocked.length) throw Object.assign(new Error(blockedMessage(plan.blocked)), { blocked: plan.blocked });

      for (const tx of plan.transactions) {
        const prev = run.postings[tx.key];
        const step = postingStep(prev);
        let found: any = null;
        if (step === 'skip') {
          found = { BankTransactionID: prev.id, Status: prev.xeroStatus, Total: prev.total };
        } else if (step === 'lookup') {
          // The last run sent this and never heard back. Xero may have it, but it is adopted
          // only when it is this site's own (30 Sep 2026: two sites share one Xero org).
          const expectedRef = prev.reference || tx.reference;
          const hit = await findPosted(accessToken, tenantId, expectedRef, date, tx.direction);
          const verdict = adoptable(hit, { expectedRef, siteName, siblingCount: siblings });
          if (verdict === 'ambiguous') {
            throw Object.assign(new Error(`"${expectedRef}" is in Xero, but another site posts to the same Xero organisation and this reference does not name a site, so ServOS cannot tell whose it is. Check it in Xero; nothing more was sent for this day.`), { code: 'lookup_ambiguous' });
          }
          found = verdict === 'adopt' ? hit : null;
        }
        if (found?.BankTransactionID) {
          skipped += 1;
          const was = Number(found.Total ?? prev?.total);
          if (Number.isFinite(was) && Math.abs(was - major(tx.totals.gross)) > 0.005) {
            extraWarnings.push({ code: 'posted_amount_differs', message: `${tx.reference} is already in Xero for ${was.toFixed(2)}; the day now comes to ${major(tx.totals.gross).toFixed(2)} (checks or refunds arrived after it was posted). Adjust it in Xero.` });
          }
          // The VAT lines recorded when it was sent, so a later check does not take a split
          // posting for one made before the split (a 'sending' record from before has none).
          if (prev?.status !== 'posted') await run.setPosting(tx.key, { status: 'posted', id: found.BankTransactionID, reference: tx.reference, total: Number(found.Total ?? major(tx.totals.gross)), xeroStatus: found.Status || null, ...(prev?.vat ? { vat: prev.vat } : {}) });
          lines.push(lineView(tx, { bankTransactionID: found.BankTransactionID, status: found.Status || prev?.xeroStatus || null, link: xeroLink(found.BankTransactionID, shortCode), already: true }));
          continue;
        }
        const idem = idempotencyKey(locationId, date, tx);
        await run.setPosting(tx.key, { status: 'sending', reference: tx.reference, idem, vat: postingVat(tx), payload: tx.payload });
        const res = await xeroApi(accessToken, tenantId, '/BankTransactions', { method: 'PUT', body: JSON.stringify({ BankTransactions: [tx.payload] }), idempotencyKey: idem });
        const bt = res?.BankTransactions?.[0];
        if (!bt?.BankTransactionID) throw new Error(`Xero did not return a transaction for ${tx.reference}`);
        await run.setPosting(tx.key, { status: 'posted', id: bt.BankTransactionID, reference: tx.reference, total: major(tx.totals.gross), xeroStatus: bt.Status || null, vat: postingVat(tx), payload: tx.payload });
        posted += 1;
        lines.push(lineView(tx, { account: bt?.BankAccount?.Name || lineView(tx).account, bankTransactionID: bt.BankTransactionID, status: bt.Status, link: xeroLink(bt.BankTransactionID, shortCode) }));
      }

      // Something an earlier attempt posted that today's plan no longer has (the mapping
      // changed between attempts): it stays in Xero, so say so rather than hide it.
      const planned = new Set(plan.transactions.map((tx: any) => tx.key));
      for (const [k, p] of Object.entries(run.postings) as [string, any][]) {
        if (p?.status === 'posted' && !planned.has(k)) {
          extraWarnings.push({ code: 'posted_not_in_plan', message: `${p.reference} was posted by an earlier attempt and is no longer part of this day's figures (the account mapping changed). Check it in Xero.` });
        }
      }
      const allWarnings = [...warnings, ...extraWarnings];
      const ids = Object.values(run.postings).map((p: any) => p?.id).filter(Boolean).join(',');
      await run.finish('ok', { xero_id: ids, detail: { sample, tenant_id: tenantId, lines, warnings: allWarnings, error: null } }, { ok: true, auto, model: 'bank_tx', posted, skipped });
      return json({ ok: true, sample, ...base, model: 'bank_tx', lines, warnings: allWarnings, summary: summaryView(summary) });
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      console.error('[xero-sales]', msg);
      const done = Object.values(run.postings).filter((p: any) => p?.status === 'posted').length;
      const status = done ? 'partial' : 'error';
      // A refused rate stops the run before anything is sent: its own message, not "press again".
      const blocked = (e as any)?.blocked || null;
      const held = (e as any)?.held || null;
      const error = blocked ? blockedMessage(blocked, { partial: !!done })
        : held ? msg
          : done ? `Part of the day reached Xero before this failed: ${msg}. Press again to finish; what is already in Xero will not be sent twice.` : msg;
      const logged = blocked || held ? error : msg;
      // 8 Oct 2026: a day held for a sale with no VAT is recorded as blocked (its own words), not as a failure to press again.
      if (!run.lost) await run.finish(status, { detail: { lines, error: logged, ...(held ? { problems: held } : {}) } }, { ok: false, auto, error: logged, posted, skipped }).catch(() => {});
      return json({ ...base, error, partial: !!done, lines, ...(blocked ? { blocked } : {}), ...(held ? { problems: held } : {}) }, held ? 400 : 500);
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error('[xero-sales]', msg);
    return json({ ...base, error: msg }, 500);
  }
});
