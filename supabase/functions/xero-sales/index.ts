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
//   POST { locationId, date? (YYYY-MM-DD business day), auto?, dryRun?, sample? }
//     auto     the nightly post: ignores `date` and books the venue's last business day that
//              ended at least 4 hours ago (the cron's UTC date is not the venue's day; the
//              grace lets offline tills catch up).
//     dryRun   the figures and the planned Xero lines, touching nothing in Xero.
//   A business day that has not ended yet is never posted (it would lock out the rest of it).
//   A day already posted answers `already`; asked by a person, it also says when the day's
//   figures have changed since (checks or refunds that arrived after it was posted).
// Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi } from '../_shared/xero.ts';
import { venueClock, loadAccountingDay } from '../_shared/accountingData.ts';
import { businessDayWindow, isYmd, isBusinessDayOver, lastCompletedBusinessDay, currentBusinessDay, wallClock, addDays } from '../_shared/businessDay.js';
import { buildAccountingDay } from '../_shared/accountingDay.js';
import { planXeroDay, requiredDefaults, DEFAULT_ACCOUNTS, postingStep, idempotencyKey, postingVat, blockedMessage, sampleSaleRows, SAMPLE_TAX_NOTES } from '../_shared/xeroPostingPlan.js';
import { revenueTaxRates, expenseTaxRates, healedTaxType } from '../_shared/xeroTax.js';
import { claimSyncRun, readSyncRow } from '../_shared/syncRun.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';

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

async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true };
  const { data: { user: caller } } = await sb.auth.getUser(token);
  if (!caller) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return { ok: true };
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

// A posting whose answer was lost: look for it in Xero by its reference before sending again.
async function findPosted(token: string, tenantId: string, reference: string) {
  const where = `Reference=="${reference.replace(/"/g, '')}" AND Status!="DELETED"`;
  const res = await xeroApi(token, tenantId, `/BankTransactions?where=${encodeURIComponent(where)}`);
  return (res?.BankTransactions || [])[0] || null;
}

const xeroLink = (id?: string | null) => (id ? `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${id}` : null);

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

// A day already in Xero. Asked by a person, it also compares what was posted with what the
// day comes to now, and says when checks or refunds have arrived since (they are not in Xero).
async function alreadyAnswer(prior: any, base: any, locationId: string, date: string, venue: any, compare: boolean) {
  const out: any = { ok: true, already: true, ...base, lines: prior.detail?.lines || [], warnings: [...(prior.detail?.warnings || [])] };
  const postings = prior.detail?.postings;
  if (!compare || !postings || !Object.keys(postings).length) return out;
  try {
    const from = prior.detail?.window?.from ? Date.parse(prior.detail.window.from) : null;
    const { summary } = await loadAccountingDay(sb, platform, locationId, date, venue, { fromMs: from });
    const { data: cfgRow } = await sb.from('xero_config').select('mapping,detail').eq('location_id', locationId).maybeSingle();
    const plan = planXeroDay(summary, { mapping: cfgRow?.mapping || {}, detail: cfgRow?.detail || {} });
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const locationId = body.locationId;
  if (!locationId) return json({ error: 'locationId required' }, 400);
  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  const dryRun = !!body.dryRun;
  const auto = !!body.auto;

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

  if (!dryRun && !isBusinessDayOver(date, now, venue.timezone, venue.dayStart)) {
    const ends = wallClock(day.toMs, venue.timezone);
    const hhmm = `${String(Math.floor(ends.minutes / 60)).padStart(2, '0')}:${String(ends.minutes % 60).padStart(2, '0')}`;
    return json({ ...base, error: `The ${date} business day is still trading. It ends at ${hhmm} on ${ends.ymd} venue time. Post it after that.`, code: 'day_open' }, 400);
  }

  const key = { table: LOG, locationId, kind: 'daily_sales', refDate: date };
  try {
    if (!dryRun) {
      const prior = await readSyncRow(sb, key);
      if (prior?.status === 'ok') return json(await alreadyAnswer(prior, base, locationId, date, venue, !auto));
    }

    const fromMs = await switchoverFromMs(locationId, date);
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

    const { data: cfgRow } = await sb.from('xero_config').select('mapping,detail').eq('location_id', locationId).maybeSingle();
    const mapping = cfgRow?.mapping || {};

    if (dryRun) {
      const plan = planXeroDay(summary, { mapping, detail: cfgRow?.detail || {}, sample });
      const warnings = [...summary.warnings, ...plan.warnings];
      // No real push has read this org's tax rates yet: the rates shown are Xero's UK codes,
      // assumed. Say so, since the push may choose differently or stop.
      if (!Array.isArray(cfgRow?.detail?.salesTaxRates)) {
        warnings.push({ code: 'tax_rates_unknown', message: "Xero's tax rates have not been read for this venue yet, so these VAT rates assume a UK organisation. The push reads them from Xero first, and may choose other rates or stop if a ServOS rate has no match." });
      }
      return json({ ok: true, dryRun: true, sample, ...base, summary: summaryView(summary), lines: plan.transactions.map((tx: any) => lineView(tx)), warnings, blocked: plan.blocked });
    }

    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'Xero is not configured.' }, 400);
    const claim = await claimSyncRun(sb, key);
    if (claim.done) return json(await alreadyAnswer(claim.done, base, locationId, date, venue, false));
    if (!claim.run) return json({ ...base, error: 'This day is being posted to Xero right now. Try again in a few minutes.', busy: true }, 409);
    const run = claim.run;

    const lines: any[] = [];
    const extraWarnings: any[] = [];
    let posted = 0, skipped = 0;
    try {
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      const detail = await ensureDetail(accessToken, tenantId, locationId, requiredDefaults(summary, mapping));
      const plan = planXeroDay(summary, { mapping, detail, sample });
      const warnings = [...summary.warnings, ...plan.warnings];
      await run.save({ detail: { date, venue: clock, window: { from: summary.fromIso, to: summary.toIso }, warnings, summary: summaryView(summary) } });
      // A ServOS rate with no Xero sales rate: refused before anything is sent (no guessing).
      if (plan.blocked.length) throw Object.assign(new Error(blockedMessage(plan.blocked)), { blocked: plan.blocked });

      for (const tx of plan.transactions) {
        const prev = run.postings[tx.key];
        const step = postingStep(prev);
        let found: any = null;
        if (step === 'skip') {
          found = { BankTransactionID: prev.id, Status: prev.xeroStatus, Total: prev.total };
        } else if (step === 'lookup') {
          // The last run sent this and never heard back. Xero may have it.
          found = await findPosted(accessToken, tenantId, prev.reference || tx.reference);
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
          lines.push(lineView(tx, { bankTransactionID: found.BankTransactionID, status: found.Status || prev?.xeroStatus || null, link: xeroLink(found.BankTransactionID), already: true }));
          continue;
        }
        const idem = idempotencyKey(locationId, date, tx);
        await run.setPosting(tx.key, { status: 'sending', reference: tx.reference, idem, vat: postingVat(tx) });
        const res = await xeroApi(accessToken, tenantId, '/BankTransactions', { method: 'PUT', body: JSON.stringify({ BankTransactions: [tx.payload] }), idempotencyKey: idem });
        const bt = res?.BankTransactions?.[0];
        if (!bt?.BankTransactionID) throw new Error(`Xero did not return a transaction for ${tx.reference}`);
        await run.setPosting(tx.key, { status: 'posted', id: bt.BankTransactionID, reference: tx.reference, total: major(tx.totals.gross), xeroStatus: bt.Status || null, vat: postingVat(tx) });
        posted += 1;
        lines.push(lineView(tx, { account: bt?.BankAccount?.Name || lineView(tx).account, bankTransactionID: bt.BankTransactionID, status: bt.Status, link: xeroLink(bt.BankTransactionID) }));
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
      await run.finish('ok', { xero_id: ids, detail: { sample, lines, warnings: allWarnings, error: null } }, { ok: true, auto, posted, skipped });
      return json({ ok: true, sample, ...base, lines, warnings: allWarnings, summary: summaryView(summary) });
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      console.error('[xero-sales]', msg);
      const done = Object.values(run.postings).filter((p: any) => p?.status === 'posted').length;
      const status = done ? 'partial' : 'error';
      // A refused rate stops the run before anything is sent: its own message, not "press again".
      const blocked = (e as any)?.blocked || null;
      const error = blocked ? blockedMessage(blocked, { partial: !!done })
        : done ? `Part of the day reached Xero before this failed: ${msg}. Press again to finish; what is already in Xero will not be sent twice.` : msg;
      const logged = blocked ? error : msg;
      if (!run.lost) await run.finish(status, { detail: { lines, error: logged } }, { ok: false, auto, error: logged, posted, skipped }).catch(() => {});
      return json({ ...base, error, partial: !!done, lines, ...(blocked ? { blocked } : {}) }, 500);
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error('[xero-sales]', msg);
    return json({ ...base, error: msg }, 500);
  }
});
