// supabase/functions/xero-sales/index.ts
//
// Push a venue's daily takings into its connected Xero org so sales reconcile against
// bank payouts, splitting every money flow to the accounts the operator maps.
//
// Model (simple to run, reconciliation-correct):
//   • Group the day's checks by payment method → resolve each method to a Xero bank
//     "clearing" account (operator mapping, else auto Card/Cash Clearing).
//   • Per clearing account, post ONE "Receive Money" bank transaction whose total = the
//     takings that landed via those methods. Its line items split the money into:
//       – Sales   (revenue = total − tips − service)  → mapped revenue account + VAT
//       – Tips     → mapped tips account (no VAT; a liability by default)
//       – Service  → mapped service-charge account
//   • When the card PAYOUT lands in the real bank, the accountant reconciles it against
//     the clearing account (a transfer) → sales tied to cash-in-the-bank.
// Idempotent per (location,date) via xero_sync_log. Prereqs auto-provisioned; the exact
// accounts/tax are configurable via xero-config (stored in xero_config.mapping).
//
//   POST { locationId, date? (YYYY-MM-DD, default today), sample?, dryRun? }
// Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi } from '../_shared/xero.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const isCash = (m: string) => /cash/i.test(String(m || ''));

async function writeLog(locationId: string, date: string, patch: Record<string, unknown>) {
  await sb.from('xero_sync_log').delete().eq('location_id', locationId).eq('kind', 'daily_sales').eq('ref_date', date);
  await sb.from('xero_sync_log').insert({ location_id: locationId, kind: 'daily_sales', ref_date: date, ...patch, updated_at: new Date().toISOString() });
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

const findAccount = (accounts: any[], name: string) => (accounts || []).find((a) => String(a.Name || '').toLowerCase() === name.toLowerCase());

async function ensureBankAccount(token: string, tenantId: string, accounts: any[], name: string, number: string, code: string): Promise<any> {
  const existing = findAccount(accounts, name);
  if (existing) return existing;
  const created = await xeroApi(token, tenantId, '/Accounts', { method: 'PUT', body: JSON.stringify({ Name: name, Type: 'BANK', BankAccountNumber: number, Code: code }) });
  return created?.Accounts?.[0];
}

// Auto-provision + cache the baseline wiring (used as defaults when the operator hasn't mapped).
async function ensureDetail(token: string, tenantId: string, locationId: string) {
  const { data: cfg } = await sb.from('xero_config').select('detail').eq('location_id', locationId).maybeSingle();
  const cache = cfg?.detail || {};
  if (cache.contactId && cache.cardClearingId && cache.cashClearingId && cache.salesAccountCode && ('taxType' in cache)) return cache;

  const accRes = await xeroApi(token, tenantId, '/Accounts');
  const accounts = accRes?.Accounts || [];
  const card = await ensureBankAccount(token, tenantId, accounts, 'ServOS Card Clearing', 'SERVOS-CARD-CLR', 'SOSCARDCLR');
  const cash = await ensureBankAccount(token, tenantId, accounts.concat(card ? [card] : []), 'ServOS Cash Clearing', 'SERVOS-CASH-CLR', 'SOSCASHCLR');
  const revenue = accounts.find((a: any) => a.Code === '200' && String(a.Type).toUpperCase() === 'REVENUE')
    || accounts.find((a: any) => String(a.Type).toUpperCase() === 'REVENUE' && String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE');
  const salesAccountCode = revenue?.Code || '200';

  let contactId = null;
  const cRes = await xeroApi(token, tenantId, `/Contacts?where=${encodeURIComponent('Name=="ServOS POS Sales"')}`);
  contactId = cRes?.Contacts?.[0]?.ContactID || null;
  if (!contactId) { const created = await xeroApi(token, tenantId, '/Contacts', { method: 'PUT', body: JSON.stringify({ Name: 'ServOS POS Sales' }) }); contactId = created?.Contacts?.[0]?.ContactID || null; }

  let taxType = 'NONE';
  try {
    const tRes = await xeroApi(token, tenantId, '/TaxRates');
    const active = (tRes?.TaxRates || []).filter((r: any) => String(r.Status || 'ACTIVE').toUpperCase() === 'ACTIVE');
    const twenty = active.find((r: any) => Math.round(Number(r.EffectiveRate)) === 20);
    taxType = twenty?.TaxType || (active.find((r: any) => r.TaxType === 'OUTPUT2') ? 'OUTPUT2' : 'NONE');
  } catch { taxType = 'NONE'; }

  const resolved = { contactId, cardClearingId: card?.AccountID, cashClearingId: cash?.AccountID, salesAccountCode, taxType };
  await sb.from('xero_config').upsert({ location_id: locationId, sales_account_code: salesAccountCode, tax_type: taxType, detail: resolved, updated_at: new Date().toISOString() }, { onConflict: 'location_id' });
  return resolved;
}

// Group the day's checks by payment method with money split into total / tips / service.
async function aggregate(locationId: string, date: string) {
  const start = `${date}T00:00:00.000Z`, end = `${date}T23:59:59.999Z`;
  const { data } = await sb.from('closed_checks').select('payment_method,method,total,tip,service')
    .eq('location_id', locationId).gte('closed_at', start).lte('closed_at', end);
  const by: Record<string, any> = {};
  for (const r of (data || [])) {
    const m = ((r.payment_method || r.method || 'other') + '').trim() || 'other';
    const g = by[m] || (by[m] = { method: m, total: 0, tip: 0, service: 0, n: 0 });
    g.total += Number(r.total) || 0; g.tip += Number(r.tip) || 0; g.service += Number(r.service) || 0; g.n += 1;
  }
  return Object.values(by).map((g: any) => ({ ...g, total: money(g.total), tip: money(g.tip), service: money(g.service) }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const locationId = body.locationId;
  if (!locationId) return json({ error: 'locationId required' }, 400);
  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10);
  const dryRun = !!body.dryRun;

  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: 'Xero is not configured.' }, 400);
    const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);

    let groups = await aggregate(locationId, date);
    let sample = !!body.sample;
    if (!groups.length) sample = true;
    if (sample && !groups.length) {
      groups = [
        { method: 'card', total: 120.00, tip: 12.00, service: 6.00, n: 3 },
        { method: 'cash', total: 30.00, tip: 0, service: 0, n: 1 },
      ];
    }

    if (dryRun) return json({ ok: true, date, sample, groups });

    const { data: prior } = await sb.from('xero_sync_log').select('detail,status').eq('location_id', locationId).eq('kind', 'daily_sales').eq('ref_date', date).maybeSingle();
    if (prior && prior.status === 'ok') return json({ ok: true, already: true, date, detail: prior.detail });

    const detail = await ensureDetail(accessToken, tenantId, locationId);
    const { data: cfgRow } = await sb.from('xero_config').select('mapping').eq('location_id', locationId).maybeSingle();
    const map = cfgRow?.mapping || {};
    const revenueAccount = map.revenueAccount || detail.salesAccountCode;
    const tipsAccount = map.tipsAccount || revenueAccount;
    const serviceAccount = map.serviceAccount || revenueAccount;
    const taxDefault = map.taxDefault || detail.taxType || 'NONE';
    const serviceTax = map.serviceTaxable === false ? 'NONE' : (map.serviceTax || taxDefault);
    const paymentMap = map.paymentMap || {};

    // Resolve each method → a clearing bank account, then merge methods that share one.
    const byAcct: Record<string, any> = {};
    for (const g of groups) {
      const acctId = paymentMap[g.method] || (isCash(g.method) ? detail.cashClearingId : detail.cardClearingId);
      const b = byAcct[acctId] || (byAcct[acctId] = { accountId: acctId, total: 0, tip: 0, service: 0, methods: [] as string[] });
      b.total += g.total; b.tip += g.tip; b.service += g.service; b.methods.push(g.method);
    }

    const lines: any[] = [];
    for (const acctId of Object.keys(byAcct)) {
      const b = byAcct[acctId];
      b.total = money(b.total); b.tip = money(b.tip); b.service = money(b.service);
      const revenue = money(b.total - b.tip - b.service);
      const li: any[] = [];
      if (revenue > 0) li.push({ Description: `Sales — ${date}`, Quantity: 1, UnitAmount: revenue, AccountCode: revenueAccount, TaxType: taxDefault });
      if (b.tip > 0) li.push({ Description: `Tips / gratuities — ${date}`, Quantity: 1, UnitAmount: b.tip, AccountCode: tipsAccount, TaxType: 'NONE' });
      if (b.service > 0) li.push({ Description: `Service charge — ${date}`, Quantity: 1, UnitAmount: b.service, AccountCode: serviceAccount, TaxType: serviceTax });
      // Guard against odd data (tips+service ≥ total): post the whole amount as one sales line.
      if (!li.length || revenue <= 0) { li.length = 0; li.push({ Description: `Takings — ${date}`, Quantity: 1, UnitAmount: b.total, AccountCode: revenueAccount, TaxType: taxDefault }); }

      const payload = { BankTransactions: [{ Type: 'RECEIVE', Contact: { ContactID: detail.contactId }, BankAccount: { AccountID: acctId }, Date: date, Reference: `ServOS takings ${date}${sample ? ' (TEST)' : ''} · ${b.methods.join(', ')}`, LineAmountTypes: 'Inclusive', LineItems: li }] };
      const res = await xeroApi(accessToken, tenantId, '/BankTransactions', { method: 'PUT', body: JSON.stringify(payload) });
      const bt = res?.BankTransactions?.[0];
      lines.push({ methods: b.methods, account: bt?.BankAccount?.Name || acctId, total: b.total, tip: b.tip, service: b.service, revenue, bankTransactionID: bt?.BankTransactionID, status: bt?.Status, link: bt?.BankTransactionID ? `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${bt.BankTransactionID}` : null });
    }

    await writeLog(locationId, date, { xero_id: lines.map((l) => l.bankTransactionID).filter(Boolean).join(','), status: 'ok', detail: { sample, lines } });
    return json({ ok: true, date, sample, lines });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error('[xero-sales]', msg);
    await writeLog(locationId, date, { status: 'error', detail: { error: msg } }).catch(() => {});
    return json({ error: msg }, 500);
  }
});
