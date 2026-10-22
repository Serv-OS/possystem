// po-send — email a purchase order to its supplier, then mark it SENT. (v5.5.921)
//
// WHY: "Save & mark sent" was a pure status flip — no email, no PDF, nothing left the
// building. The supplier's email address has been captured on every supplier record since
// the module shipped and was never read by anything. This closes the loop: one call builds
// the order table, emails it via the same provider machinery receipts use, and only marks
// the PO SENT when the send actually succeeded — so SENT means sent.
//
// Auth: a signed-in Back Office user with access to the PO's location (checked against
// user_locations with the caller's OWN JWT, so RLS does the fencing), or the service role.
// v5.11.79: an OWNER who reaches the venue through the owner rule (no link row) is let in too, the
// same answer as the database's user_accessible_locations() (_shared/stockOfficeReach.js). Each line
// now carries the supplier's own product code (supplier_products.supplier_sku) so the supplier can
// pick the order without guessing.
// v5.11.84 (multi site stock Drop 0, plan 6.2): this is a stock only function, so it takes the
// STOCK reach (stockOfficeReachesVenue): the same as above, plus a login whose Stock control is 'all'
// in the venue's own company (the database's stock_reach_locations()). Before 20261021a no login has
// a Stock control, so the answer is exactly the one above.
// v5.11.96 (multi site stock Drop 3, contract 3.5): the send path lives in _shared/poSend.ts, shared with
// po-cutoff-run and manager-approve. It refuses an order waiting for approval and an order to the
// company's own central kitchen; a multi site company's email also carries the supplier's CC list and
// a CSV of the lines (a one site company's email is byte for byte today's). New body action
// { action: 'credit_request', request_id }: emails a credit request with its lines to the supplier.
//
// ⚠ Edge functions deploy MANUALLY:
//   npx supabase functions deploy po-send --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
// v5.11.65: a day in words ('Fri 16 Oct 2026'), not the raw database string (the order email's day is
// written by _shared/poSend.ts with the same file; here it dates the invoice on a credit request).
import { fmtYmd } from '../_shared/venueDate.js';
// v5.11.96: the send path itself (one copy for po-send, po-cutoff-run and manager-approve).
import { sendPurchaseOrder, receiptBody, ccList, esc } from '../_shared/poSend.ts';
import { officeReachesVenue, stockOfficeReachesVenue, readReachProfile } from '../_shared/stockOfficeReach.js';

// CORS is inlined per-function in this codebase — there is no shared cors module.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  let body: { po_id?: string; location_id?: string; action?: string; request_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { po_id } = body;
  let location_id = body.location_id;
  // v5.11.96: a credit request names only itself; its own site is the venue the fence checks.
  let creditReq: any = null;
  if (body.action === 'credit_request') {
    if (!body.request_id) return json({ error: 'request_id required' }, 400);
    const { data: cr, error: crErr } = await admin.from('stock_credit_requests').select('*').eq('id', body.request_id).maybeSingle();
    if (crErr) return json({ error: 'Credit requests need a database update.' }, 503);
    if (!cr) return json({ error: 'Credit request not found' }, 404);
    if (location_id && location_id !== cr.location_id) return json({ error: 'Credit request not found' }, 404);
    creditReq = cr;
    location_id = cr.location_id;
  } else if (!po_id || !location_id) return json({ error: 'po_id and location_id required' }, 400);

  // ── Fence: the caller must be able to see this location. We check with the CALLER's
  // token, not the service role, so their own RLS answers the question.
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const isService = bearer === SERVICE_KEY;
  let callerUser: any = null;
  if (!isService) {
    // v5.5.940 — PLAIN HTTP, NO SDK. supabase-js's server-side session handling rejected
    // provably-valid tokens here (fresh login, auth/user 200, REST visible — fn still
    // 401'd). These two raw calls are byte-for-byte what the working curl does: validate
    // the token with GoTrue, then ask PostgREST — under the CALLER's own token and the
    // key the BROWSER sent — whether they hold this location. RLS answers, not us.
    const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { authorization: `Bearer ${bearer}`, apikey } });
    if (!ures.ok) return json({ error: `unauthorized — session rejected (auth ${ures.status}). Sign in to Back Office again.` }, 401);
    const u = await ures.json();
    callerUser = u;
    const lres = await fetch(`${SUPABASE_URL}/rest/v1/user_locations?select=location_id&user_id=eq.${u.id}&location_id=eq.${encodeURIComponent(location_id)}&limit=1`,
      { headers: { authorization: `Bearer ${bearer}`, apikey } });
    const rows = lres.ok ? await lres.json() : [];
    const linked = Array.isArray(rows) && rows.length > 0;
    let reach: { ok: boolean } = officeReachesVenue({ user: u, profile: null, linked, venueOrgId: null });
    if (!reach.ok) {
      // No link row: the owner of the venue's company, a super admin, or (v5.11.84) Stock control
      // 'all' in the venue's own company (read with the service role).
      const [prof, { data: venue }] = await Promise.all([
        readReachProfile(admin, u.id),
        admin.from('locations').select('org_id').eq('id', location_id).maybeSingle(),
      ]);
      reach = stockOfficeReachesVenue({ user: u, profile: prof || null, linked, venueOrgId: venue?.org_id || null });
    }
    if (!reach.ok) return json({ error: `not authorized for location ${location_id || '(none sent)'}` }, 403);
  }

  if (creditReq) return sendCreditRequest(creditReq);

  // ── The send itself: _shared/poSend.ts (load, refuse a waiting approval or a kitchen order, compose,
  // send through send-receipt, and only then mark the order SENT).
  const sent = await sendPurchaseOrder(admin, { poId: po_id as string, locationId: location_id as string, supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
    by: callerUser ? { uid: callerUser.id, name: callerUser.user_metadata?.full_name || callerUser.email || null } : null });
  if (!sent.ok) return json({ error: sent.error }, sent.status);
  return json({ ok: true, to: sent.to });
});

// ── v5.11.96: email a credit request (an overcharge, a short or a missing delivery) with its lines to
// the supplier's order email, then stamp emailed_at. CC as the order email (multi site companies only,
// which are the only ones with credit requests).
async function sendCreditRequest(cr: any): Promise<Response> {
  const [{ data: lines }, { data: supplier }, { data: locRow }] = await Promise.all([
    admin.from('stock_credit_request_lines').select('*').eq('request_id', cr.id).order('sort_order'),
    cr.supplier_id
      ? admin.from('suppliers').select('name,email,account_number,cc_emails').eq('location_id', cr.location_id).eq('id', cr.supplier_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from('locations').select('name,address').eq('id', cr.location_id).maybeSingle(),
  ]);
  if (!supplier?.email) return json({ error: 'supplier_has_no_email' }, 422);
  let invoiceNo = '';
  let invoiceDay = '';
  if (cr.invoice_id) {
    const { data: inv } = await admin.from('supplier_invoices').select('invoice_number, invoice_date').eq('location_id', cr.location_id).eq('id', cr.invoice_id).maybeSingle();
    invoiceNo = inv?.invoice_number ? String(inv.invoice_number) : '';
    invoiceDay = inv?.invoice_date ? fmtYmd(inv.invoice_date) : '';
  }
  const venue = locRow?.name || 'Our venue';
  const reasonWords: Record<string, string> = {
    overcharge: 'We were charged more than the agreed price.', short: 'Some items were short.',
    not_coming: 'Some items did not come.', damaged: 'Some items arrived damaged.', other: 'Please see the lines below.',
  };
  const cell = 'padding:6px 10px;border-bottom:1px solid #ddd';
  const rows = (lines ?? []).map((l: any) => `
    <tr><td style="${cell}">${esc(l.description)}</td><td style="${cell};text-align:right">${Number(l.qty)}</td>
      <td style="${cell};text-align:right">${l.unit_price_charged == null ? '' : Number(l.unit_price_charged).toFixed(2)}</td>
      <td style="${cell};text-align:right">${l.unit_price_agreed == null ? '' : Number(l.unit_price_agreed).toFixed(2)}</td>
      <td style="${cell};text-align:right">${Number(l.amount || 0).toFixed(2)}</td></tr>`).join('');
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">Credit request from ${esc(venue)}</h2>
    <p style="margin:0 0 8px;color:#555">${invoiceNo ? `Invoice ${esc(invoiceNo)}${invoiceDay ? ` of ${esc(invoiceDay)}` : ''}. ` : ''}${esc(reasonWords[cr.reason] || reasonWords.other)}</p>
    ${supplier.account_number ? `<p style="margin:0 0 4px;font-size:14px"><b>Account no:</b> ${esc(supplier.account_number)}</p>` : ''}
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#555">
        <th style="padding:6px 10px;border-bottom:2px solid #333">Item</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Qty</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Charged</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Agreed</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Credit</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:14px 0 0;font-size:14px"><b>Credit asked for (ex VAT): ${Number(cr.amount || 0).toFixed(2)}</b></p>
    ${cr.note ? `<p style="margin:10px 0 0;font-size:14px">${esc(cr.note)}</p>` : ''}
    <p style="margin:14px 0 0;color:#555;font-size:12px">Please reply with a credit note.</p>
  </div>`;
  const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify(receiptBody({ to: supplier.email, subject: `Credit request from ${venue}${invoiceNo ? `, invoice ${invoiceNo}` : ''}`, html, location_id: cr.location_id, cc: ccList(supplier.cc_emails, supplier.email) })),
  });
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => '');
    return json({ error: `email failed: ${detail.slice(0, 300)}` }, 502);
  }
  const { error: upErr } = await admin.from('stock_credit_requests').update({ emailed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', cr.id);
  if (upErr) console.error(`[po-send] credit request ${cr.id}: emailed, but emailed_at did not save: ${upErr.message}`);
  return json({ ok: true, to: supplier.email, emailed_at_saved: !upErr });
}
