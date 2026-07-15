// supabase/functions/xero-bills/index.ts
//
// Push a posted supplier invoice into the venue's Xero org as an ACCPAY bill:
//   • find-or-create the supplier as a Xero Contact (by name)
//   • bill lines from supplier_invoice_lines (stored NET; LineAmountTypes Exclusive),
//     posted to the mapped purchases account + purchase VAT rate
//   • the scanned invoice image/PDF (invoice-scans bucket) is attached to the bill
//   • idempotent per invoice via xero_sync_log (kind='bill', ref_id=invoice id)
//
//   POST { locationId, invoiceId, dryRun? } -> { ok, xeroInvoiceID, link, attached }
// Deploy --no-verify-jwt (own auth, location-fenced).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi, XERO_API } from '../_shared/xero.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

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

async function findOrCreateContact(token: string, tenantId: string, name: string): Promise<string | null> {
  const clean = name.replace(/"/g, '');
  const found = await xeroApi(token, tenantId, `/Contacts?where=${encodeURIComponent(`Name=="${clean}"`)}`);
  if (found?.Contacts?.[0]?.ContactID) return found.Contacts[0].ContactID;
  const created = await xeroApi(token, tenantId, '/Contacts', { method: 'PUT', body: JSON.stringify({ Name: clean }) });
  return created?.Contacts?.[0]?.ContactID || null;
}

// Default purchases account: mapped, else first ACTIVE DIRECTCOSTS account, else first EXPENSE.
async function resolvePurchasesAccount(token: string, tenantId: string, mapped?: string): Promise<string> {
  if (mapped) return mapped;
  const accRes = await xeroApi(token, tenantId, '/Accounts');
  const accounts = (accRes?.Accounts || []).filter((a: any) => String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE');
  const direct = accounts.find((a: any) => String(a.Type).toUpperCase() === 'DIRECTCOSTS');
  const expense = accounts.find((a: any) => String(a.Type).toUpperCase() === 'EXPENSE');
  return direct?.Code || expense?.Code || '300';
}

const extFromPath = (p: string) => (p.split('.').pop() || 'jpg').toLowerCase();
const mimeFor = (ext: string) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' } as Record<string, string>)[ext] || 'application/octet-stream';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const { locationId, invoiceId, dryRun } = body;
  if (!locationId || !invoiceId) return json({ error: 'locationId and invoiceId required' }, 400);
  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  try {
    // Idempotency
    const { data: prior } = await sb.from('xero_sync_log').select('status,detail,xero_id').eq('location_id', locationId).eq('kind', 'bill').eq('ref_id', invoiceId).maybeSingle();
    if (prior && prior.status === 'ok') return json({ ok: true, already: true, xeroInvoiceID: prior.xero_id, detail: prior.detail });

    // Load the invoice + lines + supplier
    const { data: inv } = await sb.from('supplier_invoices').select('*').eq('id', invoiceId).eq('location_id', locationId).maybeSingle();
    if (!inv) return json({ error: 'Invoice not found' }, 404);
    const [{ data: lines }, { data: supplier }] = await Promise.all([
      sb.from('supplier_invoice_lines').select('*').eq('invoice_id', invoiceId).order('sort_order'),
      inv.supplier_id ? sb.from('suppliers').select('name,payment_terms_days').eq('id', inv.supplier_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const supplierName = supplier?.name || 'Unknown supplier';

    const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
    const { data: cfgRow } = await sb.from('xero_config').select('mapping').eq('location_id', locationId).maybeSingle();
    const map = cfgRow?.mapping || {};
    const purchasesAccount = await resolvePurchasesAccount(accessToken, tenantId, map.purchasesAccount);
    const purchaseTax = map.purchaseTax || 'NONE';

    // Bill lines: stored NET (line_total ex VAT) → Exclusive; per-line VAT comes from
    // the Xero TaxType. If no lines exist, one summary line from the invoice totals.
    const li = (lines || []).length
      ? (lines || []).map((l: any) => ({
          Description: [l.description, l.qty && l.unit ? `(${l.qty} ${l.unit})` : null].filter(Boolean).join(' ') || 'Line',
          Quantity: 1,
          UnitAmount: money(l.line_total),
          AccountCode: purchasesAccount,
          TaxType: purchaseTax,
        }))
      : [{ Description: `Supplier invoice ${inv.invoice_number || ''}`.trim(), Quantity: 1, UnitAmount: money(inv.subtotal ?? inv.total), AccountCode: purchasesAccount, TaxType: purchaseTax }];

    const dateStr = inv.invoice_date || new Date().toISOString().slice(0, 10);
    const dueDays = Number(supplier?.payment_terms_days) || 30;
    const due = new Date(new Date(dateStr).getTime() + dueDays * 86400000).toISOString().slice(0, 10);

    if (dryRun) return json({ ok: true, dryRun: true, supplierName, lines: li, date: dateStr, due });

    const contactId = await findOrCreateContact(accessToken, tenantId, supplierName);
    const payload = { Invoices: [{
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      Date: dateStr,
      DueDate: due,
      InvoiceNumber: inv.invoice_number || undefined,
      Reference: `ServOS invoice ${String(invoiceId).slice(0, 8)}`,
      LineAmountTypes: 'Exclusive',
      LineItems: li,
      Status: 'AUTHORISED',
    }] };
    const res = await xeroApi(accessToken, tenantId, '/Invoices', { method: 'PUT', body: JSON.stringify(payload) });
    const bill = res?.Invoices?.[0];
    if (!bill?.InvoiceID) throw new Error('Xero did not return a bill id');

    // Attach the scanned image/PDF (best-effort — the bill exists either way).
    let attached = false;
    if (inv.image_path) {
      try {
        const dl = await sb.storage.from('invoice-scans').download(inv.image_path);
        if (dl.data) {
          const ext = extFromPath(inv.image_path);
          const fname = `invoice-${(inv.invoice_number || String(invoiceId).slice(0, 8)).replace(/[^\w.-]+/g, '_')}.${ext}`;
          const bytes = new Uint8Array(await dl.data.arrayBuffer());
          const up = await fetch(`${XERO_API}/Invoices/${bill.InvoiceID}/Attachments/${encodeURIComponent(fname)}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': tenantId, 'Content-Type': mimeFor(ext), Accept: 'application/json' },
            body: bytes,
          });
          attached = up.ok;
        }
      } catch (e) { console.warn('[xero-bills] attach failed:', (e as Error)?.message); }
    }

    const link = `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${bill.InvoiceID}`;
    await sb.from('xero_sync_log').delete().eq('location_id', locationId).eq('kind', 'bill').eq('ref_id', invoiceId);
    await sb.from('xero_sync_log').insert({ location_id: locationId, kind: 'bill', ref_id: invoiceId, xero_id: bill.InvoiceID, status: 'ok', detail: { supplierName, total: bill.Total, attached, link }, updated_at: new Date().toISOString() });
    return json({ ok: true, xeroInvoiceID: bill.InvoiceID, total: bill.Total, supplierName, attached, link });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error('[xero-bills]', msg);
    return json({ error: msg }, 500);
  }
});
