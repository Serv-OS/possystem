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
//
// ⚠ Edge functions deploy MANUALLY:
//   npx supabase functions deploy po-send --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  let body: { po_id?: string; location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { po_id, location_id } = body;
  if (!po_id || !location_id) return json({ error: 'po_id and location_id required' }, 400);

  // ── Fence: the caller must be able to see this location. We check with the CALLER's
  // token, not the service role, so their own RLS answers the question.
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const isService = bearer === SERVICE_KEY;
  if (!isService) {
    const caller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { authorization: `Bearer ${bearer}` } },
    });
    const { data: u } = await caller.auth.getUser();
    if (!u?.user) return json({ error: 'unauthorized' }, 401);
    const { data: loc } = await caller.from('user_locations').select('location_id')
      .eq('user_id', u.user.id).eq('location_id', location_id).maybeSingle();
    if (!loc) return json({ error: 'not authorized for this location' }, 403);
  }

  // ── Load the order, its lines, the supplier and the venue name.
  const [{ data: po }, { data: lines }, { data: locRow }] = await Promise.all([
    admin.from('purchase_orders').select('*').eq('location_id', location_id).eq('id', po_id).maybeSingle(),
    admin.from('po_lines').select('*').eq('location_id', location_id).eq('po_id', po_id).order('sort_order'),
    admin.from('locations').select('name').eq('id', location_id).maybeSingle(),
  ]);
  if (!po) return json({ error: 'PO not found' }, 404);
  if (po.status === 'RECEIVED' || po.status === 'CANCELLED') return json({ error: `PO is ${po.status}` }, 409);
  if (!lines?.length) return json({ error: 'PO has no lines' }, 400);

  const { data: supplier } = await admin.from('suppliers').select('name,email')
    .eq('location_id', location_id).eq('id', po.supplier_id).maybeSingle();
  if (!supplier?.email) return json({ error: 'supplier_has_no_email' }, 422);

  // ── Compose. Plain table, no branding games — a supplier wants the list, not a leaflet.
  const venue = locRow?.name || 'Our venue';
  const ref = po.reference || po_id.slice(0, 8);
  const rows = lines.map((l) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd">${esc(l.description)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(l.qty_packs)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd">${Number(l.pack_qty)}×${Number(l.inner_qty)}${esc(l.inner_unit)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(l.unit_price).toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${(Number(l.qty_packs) * Number(l.unit_price)).toFixed(2)}</td>
    </tr>`).join('');
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">Purchase order — ${esc(venue)}</h2>
    <p style="margin:0 0 14px;color:#555">Ref ${esc(ref)}${po.expected_date ? ` · requested delivery ${esc(po.expected_date)}` : ''}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#555">
        <th style="padding:6px 10px;border-bottom:2px solid #333">Item</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Packs</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333">Pack</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Price</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:14px 0 0;font-size:14px"><b>Order total (ex VAT): ${Number(po.subtotal || 0).toFixed(2)}</b></p>
    <p style="margin:14px 0 0;color:#555;font-size:12px">Please reply to this email to confirm or query the order.</p>
  </div>`;

  // ── Send via the receipts pipeline (provider switch + audit row live there).
  const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({
      to: supplier.email,
      subject: `Purchase order ${ref} — ${venue}`,
      html,
      location_id,
    }),
  });
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => '');
    return json({ error: `email failed: ${detail.slice(0, 300)}` }, 502);
  }

  // Only now does the order become SENT — the word finally means what it says.
  await admin.from('purchase_orders').update({ status: 'SENT', ordered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('location_id', location_id).eq('id', po_id);

  return json({ ok: true, to: supplier.email });
});
