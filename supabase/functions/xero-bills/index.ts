// supabase/functions/xero-bills/index.ts
//
// Push a posted supplier invoice into the venue's Xero org as an ACCPAY bill:
//   • find-or-create the supplier as a Xero Contact (by name)
//   • bill lines from supplier_invoice_lines (stored NET; LineAmountTypes Exclusive),
//     posted to the mapped purchases account + purchase VAT rate
//   • the scanned invoice image/PDF (invoice-scans bucket) is attached to the bill
//   • idempotent per invoice via xero_sync_log (kind='bill', ref_id=invoice id)
//
// v5.9.11: the log row is claimed (a lock), marked 'sending' before the bill goes out and
// updated in place with every attempt kept in detail.history (_shared/syncRun.ts). Until
// now a failed push wrote NO log at all and a success deleted the old row first, so a
// failure left no trace and the history was lost. The PUT carries an Idempotency-Key, so
// a retry after a lost answer returns the first bill instead of creating a second one.
//
//   POST { locationId, invoiceId, dryRun? } -> { ok, xeroInvoiceID, link, attached }
// Deploy --no-verify-jwt (own auth, location-fenced).
//
// v5.11.96 (multi site stock Drop 3, contract 3.5): each line's account code is the item's company
// category accounting_code (stock_co_categories) when it has one, else the mapped purchases account
// as before; the venue's site tracking (xero_config mapping.tracking, checked against Xero's active
// tracking options) goes on every line; an invoice split by site (supplier_invoice_site_splits) is one
// bill with a line per site split, each with that site's tracking; after a bill is sent the invoice
// is locked (supplier_invoices.locked_at, service role; the database refuses edits after that).
// New action recharge_bill: a draft ACCPAY bill in the RECEIVING site's Xero organisation for one
// month's central kitchen or cross company transfers, then stock_recharge_record.
//   POST { action: 'recharge_bill', orgId, month, fromLocationId, toLocationId } -> { ok, xeroBillID }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi, XERO_API } from '../_shared/xero.ts';
import { claimSyncRun, readSyncRow } from '../_shared/syncRun.ts';
import { shortHash } from '../_shared/xeroPostingPlan.js';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { officeReachesVenue, stockOfficeReachesVenue, readOfficeReachFacts } from '../_shared/stockOfficeReach.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

class HttpError extends Error { status: number; constructor(msg: string, status: number) { super(msg); this.status = status; } }

async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true };
  const { data: { user: caller } } = await sb.auth.getUser(token);
  if (!caller) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  // v5.11.79: the database's own rule (user_accessible_locations): a link row, a super admin, or the
  // OWNER of the venue's company with no link row (_shared/stockOfficeReach.js). Owners were refused.
  // v5.11.84 (multi site stock Drop 0, plan 6.2): a supplier bill is stock work, so this takes the
  // STOCK reach: the same, plus a login whose Stock control is 'all' in the venue's own company
  // (stockOfficeReachesVenue; officeReachesVenue is unchanged for everything else).
  const facts = await readOfficeReachFacts(sb, caller, opsLocationId);
  const office = officeReachesVenue(facts);
  const reach = office.ok ? office : stockOfficeReachesVenue(facts);
  if (!reach.ok) return { ok: false, res: json({ error: 'No access to this location' }, 403) };
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

// v5.11.96: the site tracking of one venue, checked against Xero's active options (the same check as
// _shared/xeroInvoicePost.ts checkTracking, which is not exported). null when the venue has none.
async function siteTracking(token: string, tenantId: string, mapping: any): Promise<{ Name: string; Option: string } | null> {
  const tr = mapping?.tracking || {};
  if (tr.none || !(tr.categoryName && tr.optionName)) return null;
  const res = await xeroApi(token, tenantId, '/TrackingCategories');
  const cats: any[] = res?.TrackingCategories || [];
  const cat = cats.find((c) => (tr.categoryId && c.TrackingCategoryID === tr.categoryId) || c.Name === tr.categoryName);
  if (!cat || String(cat.Status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new HttpError(`The tracking category "${tr.categoryName}" is not active in Xero. Choose it again under VAT and accounts, Site tracking.`, 400);
  const opt = (cat.Options || []).find((o: any) => (tr.optionId && o.TrackingOptionID === tr.optionId) || o.Name === tr.optionName);
  if (!opt || String(opt.Status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new HttpError(`The tracking option "${tr.optionName}" is not active in Xero. Choose it again under VAT and accounts, Site tracking.`, 400);
  return { Name: cat.Name, Option: opt.Name };
}

// v5.11.96: item id -> its company category's accounting code (only the items that have one).
async function categoryCodes(itemIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(itemIds.filter(Boolean))].slice(0, 1000);
  if (!ids.length) return {};
  const { data: items } = await sb.from('inventory_items').select('id, company_ref').in('id', ids);
  const refs = [...new Set((items || []).map((i: any) => i.company_ref).filter(Boolean))];
  if (!refs.length) return {};
  const { data: cos } = await sb.from('stock_co_items').select('id, category_id').in('id', refs);
  const catIds = [...new Set((cos || []).map((c: any) => c.category_id).filter(Boolean))];
  if (!catIds.length) return {};
  const { data: cats } = await sb.from('stock_co_categories').select('id, accounting_code').in('id', catIds);
  const codeOfCat: Record<string, string> = {};
  for (const c of cats || []) if (c.accounting_code && String(c.accounting_code).trim()) codeOfCat[c.id] = String(c.accounting_code).trim();
  const catOfCo: Record<string, string> = {};
  for (const c of cos || []) if (c.category_id) catOfCo[c.id] = c.category_id;
  const out: Record<string, string> = {};
  for (const i of items || []) { const code = codeOfCat[catOfCo[i.company_ref]]; if (code) out[i.id] = code; }
  return out;
}

// v5.11.96: a draft bill in the receiving site's organisation for one month of recharges. The amount
// is read from stock_recharge_statement AS THE CALLER (company editors only), never from the body.
async function rechargeBill(req: Request, body: any): Promise<Response> {
  const { orgId, month, fromLocationId, toLocationId } = body || {};
  if (!orgId || !month || !fromLocationId || !toLocationId) return json({ error: 'orgId, month, fromLocationId and toLocationId required' }, 400);
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token || token === SERVICE_ROLE) return json({ error: 'Sign in to send recharges.' }, 401);
  const acc = await requireAccess(req, toLocationId);
  if (!acc.ok) return acc.res;
  const asCaller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { autoRefreshToken: false, persistSession: false } });
  const { data: st, error: stErr } = await asCaller.rpc('stock_recharge_statement', { p_org: orgId, p_month: month });
  if (stErr) return json({ error: stErr.message }, 403);
  const rows: any[] = Array.isArray(st) ? st : (st?.rows || []);
  const row = rows.find((r) => r.from_location_id === fromLocationId && r.to_location_id === toLocationId);
  if (!row) return json({ error: 'Nothing to recharge between these sites this month.' }, 404);
  if (row.posted?.xero_bill_id) return json({ ok: true, already: true, xeroBillID: row.posted.xero_bill_id });
  const amount = money(row.amount);
  let billId: string | null = null;
  let err: string | null = null;
  try {
    const { accessToken, tenantId } = await getValidAccessToken(sb, toLocationId, CLIENT_ID, CLIENT_SECRET);
    const { data: cfgRow } = await sb.from('xero_config').select('mapping').eq('location_id', toLocationId).maybeSingle();
    const map = cfgRow?.mapping || {};
    const account = await resolvePurchasesAccount(accessToken, tenantId, map.purchasesAccount);
    const tracking = await siteTracking(accessToken, tenantId, map);
    const contactId = await findOrCreateContact(accessToken, tenantId, String(row.from_name || 'Central kitchen'));
    const ref = `ServOS recharge ${String(month).slice(0, 7)}`;
    const payload = { Invoices: [{
      Type: 'ACCPAY', Contact: { ContactID: contactId }, Date: String(month).slice(0, 10), Reference: ref,
      LineAmountTypes: 'Exclusive', Status: 'DRAFT',
      LineItems: [{ Description: `Goods from ${row.from_name || 'the central kitchen'}, ${String(month).slice(0, 7)} (${row.lines || 0} lines)`, Quantity: 1, UnitAmount: amount, AccountCode: account, TaxType: map.purchaseTax || 'NONE', ...(tracking ? { Tracking: [tracking] } : {}) }],
    }] };
    const idem = `servos-recharge-bill-${orgId}-${String(month).slice(0, 7)}-${fromLocationId}-${toLocationId}-${shortHash(JSON.stringify(payload))}`;
    const res = await xeroApi(accessToken, tenantId, '/Invoices', { method: 'PUT', body: JSON.stringify(payload), idempotencyKey: idem });
    billId = res?.Invoices?.[0]?.InvoiceID || null;
    if (!billId) err = 'Xero did not return a bill id';
  } catch (e) { err = (e as Error)?.message || String(e); }
  const { error: recErr } = await sb.rpc('stock_recharge_record', {
    p_org: orgId, p_month: month, p_from: fromLocationId, p_to: toLocationId, p_amount: amount,
    p_invoice: null, p_bill: billId, p_error: err, p_by_name: body.byName || null,
  });
  if (err) return json({ error: err }, 502);
  if (recErr) return json({ ok: true, xeroBillID: billId, warning: `The bill is in Xero but could not be recorded: ${recErr.message}` });
  return json({ ok: true, xeroBillID: billId });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  if (body?.action === 'recharge_bill') return await rechargeBill(req, body);
  const { locationId, invoiceId, dryRun } = body;
  if (!locationId || !invoiceId) return json({ error: 'locationId and invoiceId required' }, 400);
  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  const logKey = { table: 'xero_sync_log', locationId, kind: 'bill', refId: String(invoiceId) };
  let run: any = null;
  try {
    // Idempotency
    const prior = await readSyncRow(sb, logKey);
    if (prior && prior.status === 'ok') return json({ ok: true, already: true, xeroInvoiceID: prior.xero_id, detail: prior.detail });
    if (!dryRun) {
      const claim = await claimSyncRun(sb, logKey);
      if (claim.done) return json({ ok: true, already: true, xeroInvoiceID: claim.done.xero_id, detail: claim.done.detail });
      if (!claim.run) return json({ error: 'This bill is being sent to Xero right now. Try again in a minute.', busy: true }, 409);
      run = claim.run;
    }

    // Load the invoice + lines + supplier
    const { data: inv } = await sb.from('supplier_invoices').select('*').eq('id', invoiceId).eq('location_id', locationId).maybeSingle();
    if (!inv) throw new HttpError('Invoice not found', 404);
    // v5.5.923 — server-side gate to match the UI's. A REVIEW row is PO-attached paperwork
    // with a null total; pushing it created an AUTHORISED £0 bill and the sync-log dedupe
    // above then blocked the real push forever. The button is gated too, but a money-writing
    // endpoint never trusts a button.
    if ((inv.status || '').toUpperCase() !== 'POSTED') throw new HttpError('Invoice not posted yet — post it before sending to Xero', 400);
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
    // v5.11.96: the account code is the item's company category code when it has one; the site
    // tracking goes on every line; a split invoice is one line per site split with its tracking.
    const tracking = await siteTracking(accessToken, tenantId, map);
    const withTracking = (line: any, tr: any) => (tr ? { ...line, Tracking: [tr] } : line);
    const codes = await categoryCodes((lines || []).map((l: any) => l.matched_item_id));
    const { data: splits } = await sb.from('supplier_invoice_site_splits').select('location_id, amount, tax, basis, note').eq('invoice_id', invoiceId).limit(100);
    let li: any[];
    if ((splits || []).length) {
      const siteIds = [...new Set((splits || []).map((x: any) => x.location_id))];
      const [{ data: siteCfg }, { data: siteRows }] = await Promise.all([
        sb.from('xero_config').select('location_id, mapping').in('location_id', siteIds),
        sb.from('locations').select('id, name').in('id', siteIds),
      ]);
      const mapOf: Record<string, any> = Object.fromEntries((siteCfg || []).map((c: any) => [c.location_id, c.mapping || {}]));
      const nameOf: Record<string, string> = Object.fromEntries((siteRows || []).map((r: any) => [r.id, r.name]));
      li = [];
      for (const x of splits || []) {
        const tr = x.location_id === locationId ? tracking : await siteTracking(accessToken, tenantId, mapOf[x.location_id] || {});
        li.push(withTracking({
          Description: `Supplier invoice ${inv.invoice_number || ''}, ${nameOf[x.location_id] || 'site'} share`.replace(/\s+,/, ','),
          Quantity: 1,
          UnitAmount: money((Number(x.amount) || 0) - (Number(x.tax) || 0)),
          AccountCode: purchasesAccount,
          TaxType: purchaseTax,
        }, tr));
      }
    } else {
      li = (lines || []).length
        ? (lines || []).map((l: any) => withTracking({
            Description: [l.description, l.qty && l.unit ? `(${l.qty} ${l.unit})` : null].filter(Boolean).join(' ') || 'Line',
            Quantity: 1,
            UnitAmount: money(l.line_total),
            AccountCode: codes[l.matched_item_id] || purchasesAccount,
            TaxType: purchaseTax,
          }, tracking))
        : [withTracking({ Description: `Supplier invoice ${inv.invoice_number || ''}`.trim(), Quantity: 1, UnitAmount: money(inv.subtotal ?? inv.total), AccountCode: purchasesAccount, TaxType: purchaseTax }, tracking)];
    }

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
    // The last attempt sent this bill and never heard back: look for it before sending again
    // (a supplier invoice number is the one field Xero can find an ACCPAY bill by).
    let bill: any = null;
    if (run.postings.bill?.status === 'sending' && inv.invoice_number) {
      const where = `Type=="ACCPAY" AND Contact.ContactID==guid("${contactId}") AND InvoiceNumber=="${String(inv.invoice_number).replace(/"/g, '')}" AND Status!="DELETED" AND Status!="VOIDED"`;
      const found = await xeroApi(accessToken, tenantId, `/Invoices?where=${encodeURIComponent(where)}`).catch(() => null);
      bill = found?.Invoices?.[0] || null;
    }
    if (!bill) {
      await run.setPosting('bill', { status: 'sending', reference: `ServOS invoice ${String(invoiceId).slice(0, 8)}` });
      // The key carries a hash of the bill, so a bill Xero refused (fixed and sent again)
      // is a new request, while a plain retry of the same bill returns the first answer.
      const idem = `servos-bill-${locationId}-${invoiceId}-${shortHash(JSON.stringify(payload))}`;
      const res = await xeroApi(accessToken, tenantId, '/Invoices', { method: 'PUT', body: JSON.stringify(payload), idempotencyKey: idem });
      bill = res?.Invoices?.[0];
    }
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

    // v5.11.96: once the bill is in Xero the invoice is locked (the database refuses edits after
    // this, except from the service role). Best effort: the bill exists either way.
    if (!inv.locked_at) {
      const { error: lockErr } = await sb.from('supplier_invoices').update({ locked_at: new Date().toISOString() }).eq('id', invoiceId).eq('location_id', locationId);
      if (lockErr) console.warn('[xero-bills] lock failed:', lockErr.message);
    }
    const link = `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${bill.InvoiceID}`;
    await run.finish('ok', { xero_id: bill.InvoiceID, detail: { postings: { ...run.postings, bill: { status: 'posted', id: bill.InvoiceID } }, supplierName, total: bill.Total, attached, link, error: null } }, { ok: true });
    return json({ ok: true, xeroInvoiceID: bill.InvoiceID, total: bill.Total, supplierName, attached, link });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error('[xero-bills]', msg);
    // A failure is recorded too (it used to leave no trace), with the attempt in history.
    if (run && !run.lost) await run.finish('error', { detail: { error: msg } }, { ok: false, error: msg }).catch(() => {});
    return json({ error: msg }, (e as any)?.status || 500);
  }
});
