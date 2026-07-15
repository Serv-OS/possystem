// supabase/functions/xero-sales/index.ts
//
// Push a venue's daily takings into its connected Xero org so sales reconcile against
// bank payouts. The model (simple, but reconciliation-correct):
//   • Card-type takings post as "Receive Money" into a Xero bank account "ServOS Card
//     Clearing". When the card processor's PAYOUT lands in the real bank, the accountant
//     reconciles it against this clearing account (a transfer), and the fee difference
//     goes to an expense — so sales ↔ payout are linked and the clearing nets to zero.
//   • Cash takings post the same way into "ServOS Cash Clearing".
// One Receive-Money transaction per payment type per day. Idempotent per (location,date)
// via xero_sync_log. Prerequisites (clearing bank accounts, a Contact, the sales account
// + VAT rate) are auto-provisioned on first push and cached in xero_config.
//
//   POST { locationId, date? (YYYY-MM-DD, default today), sample?, dryRun? }
//     -> { ok, date, lines:[{method,gross,vat,bankTransactionID,link}], already? }
//
// Deploy --no-verify-jwt (own auth). Tokens stay server-side.

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

// Find an account by name (case-insensitive) among all accounts.
function findAccount(accounts: any[], name: string) {
  return (accounts || []).find((a) => String(a.Name || '').toLowerCase() === name.toLowerCase());
}

async function ensureBankAccount(token: string, tenantId: string, accounts: any[], name: string, number: string, code: string): Promise<any> {
  const existing = findAccount(accounts, name);
  if (existing) return existing;
  const created = await xeroApi(token, tenantId, '/Accounts', {
    method: 'PUT',
    body: JSON.stringify({ Name: name, Type: 'BANK', BankAccountNumber: number, Code: code }),
  });
  return created?.Accounts?.[0];
}

// Resolve + cache the account/tax/contact wiring for this venue.
async function ensureConfig(token: string, tenantId: string, locationId: string) {
  const { data: cfg } = await sb.from('xero_config').select('*').eq('location_id', locationId).maybeSingle();
  const cache = cfg?.detail || {};
  if (cache.contactId && cache.cardClearingId && cache.cashClearingId && cache.salesAccountCode && ('taxType' in cache)) return cache;

  // Accounts
  const accRes = await xeroApi(token, tenantId, '/Accounts');
  const accounts = accRes?.Accounts || [];
  const card = await ensureBankAccount(token, tenantId, accounts, 'ServOS Card Clearing', 'SERVOS-CARD-CLR', 'SOSCARDCLR');
  // re-fetch not needed; cash may collide with the just-created one only by name (different)
  const cash = await ensureBankAccount(token, tenantId, accounts.concat(card ? [card] : []), 'ServOS Cash Clearing', 'SERVOS-CASH-CLR', 'SOSCASHCLR');
  // Sales (revenue) account — prefer 200, else first active REVENUE account.
  const revenue = accounts.find((a: any) => a.Code === '200' && String(a.Type).toUpperCase() === 'REVENUE')
    || accounts.find((a: any) => String(a.Type).toUpperCase() === 'REVENUE' && String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE');
  const salesAccountCode = revenue?.Code || '200';

  // Contact
  let contactId = null;
  const cRes = await xeroApi(token, tenantId, `/Contacts?where=${encodeURIComponent('Name=="ServOS POS Sales"')}`);
  contactId = cRes?.Contacts?.[0]?.ContactID || null;
  if (!contactId) {
    const created = await xeroApi(token, tenantId, '/Contacts', { method: 'PUT', body: JSON.stringify({ Name: 'ServOS POS Sales' }) });
    contactId = created?.Contacts?.[0]?.ContactID || null;
  }

  // Output VAT rate — a standard ~20% sales rate if present, else common UK code, else none.
  let taxType = 'NONE';
  try {
    const tRes = await xeroApi(token, tenantId, '/TaxRates');
    const rates = tRes?.TaxRates || [];
    const active = rates.filter((r: any) => String(r.Status || 'ACTIVE').toUpperCase() === 'ACTIVE' && (r.CanApplyToRevenue === undefined || r.CanApplyToRevenue));
    const twenty = active.find((r: any) => Math.round(Number(r.EffectiveRate)) === 20 && /output|sales|standard|income|20/i.test(`${r.Name} ${r.TaxType}`))
      || active.find((r: any) => Math.round(Number(r.EffectiveRate)) === 20);
    taxType = twenty?.TaxType || (rates.find((r: any) => r.TaxType === 'OUTPUT2') ? 'OUTPUT2' : 'NONE');
  } catch { taxType = 'OUTPUT2'; }

  const resolved = { contactId, cardClearingId: card?.AccountID, cashClearingId: cash?.AccountID, salesAccountCode, taxType };
  await sb.from('xero_config').upsert({ location_id: locationId, sales_account_code: salesAccountCode, tax_type: taxType, detail: resolved, updated_at: new Date().toISOString() }, { onConflict: 'location_id' });
  return resolved;
}

// Aggregate the day's takings from closed_checks, grouped into card vs cash.
async function aggregate(locationId: string, date: string) {
  const start = `${date}T00:00:00.000Z`;
  const end = `${date}T23:59:59.999Z`;
  const { data } = await sb.from('closed_checks').select('payment_method,total,tax_amount,tax')
    .eq('location_id', locationId).gte('closed_at', start).lte('closed_at', end);
  const g = { card: { gross: 0, vat: 0, n: 0 }, cash: { gross: 0, vat: 0, n: 0 } };
  for (const r of (data || [])) {
    const k = isCash(r.payment_method) ? 'cash' : 'card';
    g[k].gross += Number(r.total) || 0;
    g[k].vat += Number(r.tax_amount ?? r.tax ?? 0) || 0;
    g[k].n += 1;
  }
  g.card.gross = money(g.card.gross); g.card.vat = money(g.card.vat);
  g.cash.gross = money(g.cash.gross); g.cash.vat = money(g.cash.vat);
  return g;
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

    // Aggregate; if empty (or a sample was requested) use a clearly-labelled test figure.
    let agg = await aggregate(locationId, date);
    let sample = !!body.sample;
    if (agg.card.gross === 0 && agg.cash.gross === 0) { sample = true; }
    if (sample && agg.card.gross === 0 && agg.cash.gross === 0) {
      agg = { card: { gross: 120.00, vat: 20.00, n: 3 }, cash: { gross: 30.00, vat: 5.00, n: 1 } };
    }

    const groups = [
      { method: 'card', label: 'Card', ...agg.card },
      { method: 'cash', label: 'Cash', ...agg.cash },
    ].filter((x) => x.gross > 0);

    if (dryRun) return json({ ok: true, date, sample, dryRun: true, lines: groups });

    // Idempotency: one push per (location, date).
    const { data: prior } = await sb.from('xero_sync_log').select('id,detail,status').eq('location_id', locationId).eq('kind', 'daily_sales').eq('ref_date', date).maybeSingle();
    if (prior && prior.status === 'ok') return json({ ok: true, already: true, date, detail: prior.detail });

    const cfg = await ensureConfig(accessToken, tenantId, locationId);

    const lines: any[] = [];
    for (const grp of groups) {
      const bankAccountId = grp.method === 'cash' ? cfg.cashClearingId : cfg.cardClearingId;
      const payload = {
        BankTransactions: [{
          Type: 'RECEIVE',
          Contact: { ContactID: cfg.contactId },
          BankAccount: { AccountID: bankAccountId },
          Date: date,
          Reference: `ServOS ${grp.label} takings ${date}${sample ? ' (TEST)' : ''}`,
          LineAmountTypes: 'Inclusive',
          LineItems: [{
            Description: `${grp.label} takings — ${date}${sample ? ' (TEST)' : ''}`,
            Quantity: 1,
            UnitAmount: grp.gross,
            AccountCode: cfg.salesAccountCode,
            TaxType: cfg.taxType,
          }],
        }],
      };
      const res = await xeroApi(accessToken, tenantId, '/BankTransactions', { method: 'PUT', body: JSON.stringify(payload) });
      const bt = res?.BankTransactions?.[0];
      lines.push({ method: grp.method, gross: grp.gross, vat: grp.vat, bankTransactionID: bt?.BankTransactionID, status: bt?.StatusAttributeString || bt?.Status, link: bt?.BankTransactionID ? `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${bt.BankTransactionID}` : null });
    }

    await writeLog(locationId, date, {
      xero_id: lines.map((l) => l.bankTransactionID).filter(Boolean).join(','),
      status: 'ok', detail: { sample, lines },
    });
    return json({ ok: true, date, sample, lines });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error('[xero-sales]', msg);
    await writeLog(locationId, date, { status: 'error', detail: { error: msg } }).catch(() => {});
    return json({ error: msg }, 500);
  }
});
