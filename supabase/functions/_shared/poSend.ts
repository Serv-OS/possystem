// supabase/functions/_shared/poSend.ts
//
// MULTI SITE STOCK Drop 3 (contract 3.5, decisions 4 and 5): the ONE way a purchase order is emailed to
// its supplier. The body of po-send's send path moved here whole, so po-send (Back Office), po-cutoff-run
// (the order by runner: standing orders and orders sent unapproved at the cut off) and manager-approve
// (the phone's po.raise) all send the same email and mark the order SENT the same way.
//
//   * Refuses an order still waiting for approval ('This order is waiting for approval.') and an order
//     to the company's own central kitchen ('This order goes to the central kitchen, not by email.':
//     a kitchen order goes to the kitchen's Orders in, never by email).
//   * One site companies get today's email byte for byte (decision 5): no CC, no CSV, and the delivery
//     fee line only when the order carries a fee (a one site order never does).
//   * Multi site companies also get the site supplier's cc_emails and a CSV of the lines
//     (order_<reference>.csv: SKU, item, pack, quantity, unit price, line total, plus the delivery fee row).
//
// No https import here: the caller hands in its service role client, so node --test loads this file
// as it ships (src/lib/stock/poSendRules.test.js).

import { fmtYmd } from './venueDate.js';

export const WAITING_WORDS = 'This order is waiting for approval.';
export const OVER_LIMIT_WORDS = 'This order is over the approval limit. It is waiting for approval now.';
export const INTERNAL_WORDS = 'This order goes to the central kitchen, not by email.';
export const CSV_HEADER = ['SKU', 'Item', 'Pack', 'Quantity', 'Unit price', 'Line total'];

// the dash today's subject and heading carry, written as an escape so this file stays ASCII
const EM = '\u2014';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The pack words of a line, as today's email writes them: '6×2kg'. */
export const packCell = (l: any) => `${Number(l.pack_qty)}×${Number(l.inner_qty)}${String(l.inner_unit ?? '')}`;

/** The cc list of a site supplier row: valid addresses only, once each, at most 10. */
export function ccList(raw: unknown, to = ''): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>([String(to || '').trim().toLowerCase()]);
  const out: string[] = [];
  for (const v of list) {
    const e = String(v ?? '').trim();
    const k = e.toLowerCase();
    if (!EMAIL_RE.test(e) || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= 10) break;
  }
  return out;
}

/** The delivery fee of an order (null when none). */
export const feeOf = (po: any) => (po && po.delivery_fee != null && num(po.delivery_fee) > 0 ? Math.round(num(po.delivery_fee) * 100) / 100 : null);

/** The CSV rows: the header, one row per line, then the delivery fee row when there is a fee. */
export function poCsvRows(lines: any[], { skuBySp = {}, deliveryFee = null }: { skuBySp?: Record<string, string>; deliveryFee?: number | null } = {}): string[][] {
  const rows: string[][] = [CSV_HEADER.slice()];
  for (const l of lines || []) {
    const qty = num(l.qty_packs);
    const price = num(l.unit_price);
    rows.push([
      String((l.supplier_product_id && skuBySp[l.supplier_product_id]) || ''),
      String(l.description ?? ''),
      packCell(l).replace('×', ' x '),
      String(qty),
      price.toFixed(2),
      (qty * price).toFixed(2),
    ]);
  }
  if (deliveryFee != null && deliveryFee > 0) rows.push(['', 'Delivery fee', '', '1', deliveryFee.toFixed(2), deliveryFee.toFixed(2)]);
  return rows;
}

/** CSV text: every cell quoted when it holds a comma, a quote or a line break; CRLF line ends. */
export function csvText(rows: string[][]): string {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Base64 of UTF-8 text (Deno and Node both have btoa and TextEncoder). */
export function b64utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The file name of the CSV: order_<reference>.csv with only safe characters. */
export const csvName = (ref: string) => `order_${String(ref || 'order').replace(/[^A-Za-z0-9._-]+/g, '_')}.csv`;

/**
 * The email body. With no fee it is exactly the html po-send has sent since v5.11.79 (pinned in
 * poSendRules.test.js): a one site company's supplier sees no change at all.
 */
export function poEmailHtml({ venue, ref, po, supplier, locRow, lines, skuBySp, anyCode, fee = null }: any): string {
  const rows = lines.map((l: any) => `
    <tr>
      ${anyCode ? `<td style="padding:6px 10px;border-bottom:1px solid #ddd;font-family:monospace">${esc(skuBySp[l.supplier_product_id] || '')}</td>` : ''}
      <td style="padding:6px 10px;border-bottom:1px solid #ddd">${esc(l.description)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(l.qty_packs)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd">${Number(l.pack_qty)}×${Number(l.inner_qty)}${esc(l.inner_unit)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(l.unit_price).toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${(Number(l.qty_packs) * Number(l.unit_price)).toFixed(2)}</td>
    </tr>`).join('');
  const feeLine = fee != null ? `
    <p style="margin:14px 0 0;font-size:14px">Delivery fee: ${fee.toFixed(2)}</p>` : '';
  const total = fee != null ? Number(po.subtotal || 0) + fee : Number(po.subtotal || 0);
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">Purchase order ${EM} ${esc(venue)}</h2>
    <p style="margin:0 0 8px;color:#555">Ref ${esc(ref)}${po.expected_date ? ` · requested delivery ${esc(fmtYmd(po.expected_date, { weekday: true }))}` : ''}</p>
    ${supplier.account_number ? `<p style="margin:0 0 4px;font-size:14px"><b>Account no:</b> ${esc(supplier.account_number)}</p>` : ''}
    <p style="margin:0 0 14px;font-size:14px"><b>Deliver to:</b> ${esc(venue)}${locRow?.address ? `, ${esc(locRow.address)}` : ''}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#555">
        ${anyCode ? '<th style="padding:6px 10px;border-bottom:2px solid #333">Your code</th>' : ''}
        <th style="padding:6px 10px;border-bottom:2px solid #333">Item</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Packs</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333">Pack</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Price</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>${feeLine}
    <p style="margin:14px 0 0;font-size:14px"><b>Order total (ex VAT): ${total.toFixed(2)}</b></p>
    <p style="margin:14px 0 0;color:#555;font-size:12px">Please reply to this email to confirm or query the order.</p>
  </div>`;
}

/** The send-receipt request body: today's four keys, plus cc and attachments only when there are any. */
export function receiptBody({ to, subject, html, location_id, cc = [], attachments = [] }: any) {
  const body: Record<string, unknown> = { to, subject, html, location_id };
  if (Array.isArray(cc) && cc.length) body.cc = cc;
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
  return body;
}

const missing = (e: any) => !!e && /42P01|PGRST205|PGRST204|42703|PGRST202|42883|does not exist|Could not find/i.test(`${e.code || ''} ${e.message || ''}`);

type SendOpts = {
  poId: string; locationId: string; supabaseUrl: string; serviceKey: string; fetchFn?: typeof fetch; now?: () => string;
  // po-cutoff-run: an order no longer DRAFT (sent by the screen already, received, cancelled) has nothing to send
  onlyDraft?: boolean;
  // who asks (po-send's login), kept on an approval this send raises
  by?: { uid?: string | null; name?: string | null } | null;
};
type SendAnswer = { ok: boolean; status: number; error?: string; final?: boolean; to?: string; cc?: string[]; csv?: boolean; internal?: boolean;
  skipped?: boolean; needs_approval?: boolean };

/**
 * Email one order to its supplier and mark it SENT (and ordered now) only when the send worked.
 * The caller has already proven the caller may act at this venue. Answers { ok, status, error, final }:
 * final is true when trying again cannot help (no email on file, a kitchen order, a waiting approval,
 * an order that is received or cancelled).
 */
export async function sendPurchaseOrder(admin: any, { poId, locationId, supabaseUrl, serviceKey, fetchFn = fetch, now = () => new Date().toISOString(), onlyDraft = false, by = null }: SendOpts): Promise<SendAnswer> {
  const [{ data: po }, { data: lines }, { data: locRow }] = await Promise.all([
    admin.from('purchase_orders').select('*').eq('location_id', locationId).eq('id', poId).maybeSingle(),
    admin.from('po_lines').select('*').eq('location_id', locationId).eq('po_id', poId).order('sort_order'),
    admin.from('locations').select('name,address,org_id').eq('id', locationId).maybeSingle(),
  ]);
  if (!po) return { ok: false, status: 404, error: 'PO not found', final: true };
  if (onlyDraft && po.status !== 'DRAFT') return { ok: true, status: 200, skipped: true };
  if (po.status === 'RECEIVED' || po.status === 'CANCELLED') return { ok: false, status: 409, error: `PO is ${po.status}`, final: true };
  if (!lines?.length) return { ok: false, status: 400, error: 'PO has no lines', final: true };

  // Drop 3: an order still waiting for approval never goes out (the database guard refuses SENT too).
  const { data: appr, error: apprErr } = await admin.from('stock_po_approvals').select('status').eq('po_id', poId).maybeSingle();
  if (!apprErr && appr && (appr.status === 'waiting' || appr.status === 'sent_back')) return { ok: false, status: 409, error: WAITING_WORDS, final: true };

  let { data: supplier, error: supErr } = await admin.from('suppliers').select('name,email,account_number,cc_emails,company_ref')
    .eq('location_id', locationId).eq('id', po.supplier_id).maybeSingle();
  if (supErr && missing(supErr)) {
    // a database before the Drop 0 supplier columns: today's read
    ({ data: supplier } = await admin.from('suppliers').select('name,email,account_number').eq('location_id', locationId).eq('id', po.supplier_id).maybeSingle());
  }
  // Drop 3: the company's own central kitchen is ordered inside ServOS, never by email.
  if (supplier?.company_ref) {
    const { data: co, error: coErr } = await admin.from('stock_co_suppliers').select('internal_location_id').eq('id', supplier.company_ref).maybeSingle();
    if (!coErr && co?.internal_location_id) return { ok: false, status: 409, error: INTERNAL_WORDS, final: true, internal: true };
  }
  if (!supplier?.email) return { ok: false, status: 422, error: 'supplier_has_no_email', final: true };

  // Multi site company? (stock_co_settings.multi_since set). A database without it is one site.
  let multi = false;
  if (locRow?.org_id) {
    const { data: co, error: coErr } = await admin.from('stock_co_settings').select('multi_since').eq('org_id', locRow.org_id).maybeSingle();
    multi = !coErr && !!co?.multi_since;
  }

  // Drop 3: a multi site company's DRAFT goes out only by the database's order rule (stock_po_submit as
  // the service role: paused lines, the maximum, the fee, and the site's approval limit for this
  // supplier). Over the limit with no approval yet, the approval is raised now and nothing is emailed.
  // A database before Drop 3 has no such function: today's send.
  if (multi && po.status === 'DRAFT') {
    const { data: sub, error: subErr } = await admin.rpc('stock_po_submit', {
      p_po: poId, p_section: 'purchasing', p_actor: { location_id: locationId, uid: by?.uid || null, name: by?.name || null },
    });
    if (subErr && !missing(subErr)) return { ok: false, status: 409, error: String(subErr.message || 'the order was refused'), final: true };
    if (!subErr && sub?.needs_approval) return { ok: false, status: 409, error: OVER_LIMIT_WORDS, final: true, needs_approval: true };
    if (!subErr && sub?.internal) return { ok: false, status: 409, error: INTERNAL_WORDS, final: true, internal: true };
  }

  // v5.11.79: the supplier's own product code for each line (the pack the line was ordered in).
  const spIds = [...new Set(lines.map((l: any) => l.supplier_product_id).filter(Boolean))];
  const skuBySp: Record<string, string> = {};
  if (spIds.length) {
    const { data: sps } = await admin.from('supplier_products').select('id,supplier_sku').eq('location_id', locationId).in('id', spIds);
    for (const sp of sps ?? []) if (sp.supplier_sku) skuBySp[sp.id] = String(sp.supplier_sku);
  }
  const anyCode = lines.some((l: any) => l.supplier_product_id && skuBySp[l.supplier_product_id]);

  const venue = locRow?.name || 'Our venue';
  const ref = po.reference || String(poId).slice(0, 8);
  const fee = feeOf(po);
  const html = poEmailHtml({ venue, ref, po, supplier, locRow, lines, skuBySp, anyCode, fee });
  const cc = multi ? ccList(supplier.cc_emails, supplier.email) : [];
  const attachments = multi
    ? [{ filename: csvName(ref), content_base64: b64utf8(csvText(poCsvRows(lines, { skuBySp, deliveryFee: fee }))), mime: 'text/csv' }]
    : [];

  // Send via the receipts pipeline (provider switch + audit row live there).
  const sendRes = await fetchFn(`${supabaseUrl}/functions/v1/send-receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify(receiptBody({ to: supplier.email, subject: `Purchase order ${ref} ${EM} ${venue}`, html, location_id: locationId, cc, attachments })),
  });
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => '');
    return { ok: false, status: 502, error: `email failed: ${detail.slice(0, 300)}` };
  }

  // Only now does the order become SENT: the word means what it says.
  const stamp = now();
  const { error: upErr } = await admin.from('purchase_orders').update({ status: 'SENT', ordered_at: stamp, updated_at: stamp })
    .eq('location_id', locationId).eq('id', poId);
  if (upErr) console.error(`[poSend] ${poId}: emailed, but the order was not marked sent: ${upErr.message}`);
  return { ok: true, status: 200, to: supplier.email, cc, csv: attachments.length > 0 };
}
