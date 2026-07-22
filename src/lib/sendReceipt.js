// src/lib/sendReceipt.js — client-side helper that calls the send-receipt
// edge function. Builds a full VAT-compliant HTML receipt from a closed check
// with line items, service charge, discounts, and tax breakdown by rate.
//
// v5.5.299: Wired to the Message Templates system. The Digital Receipt template
// controls the subject line and greeting text; the receipt body (items, totals,
// VAT breakdown) is always auto-generated to ensure legal compliance.

import { supabase, ensureAuthToken } from './supabase';
import { isTrainingMode } from './trainingMode';
import { loadLocationBranding } from './receiptBranding';
import { money } from './currency';  // v5.5.326: shared multi-currency formatter
import { cardReceiptLines } from './cardReceipt';  // v5.5.719: card-scheme block (masked PAN/auth/CVM)
const FUNC_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/message-templates`;

/**
 * Resolve the receipt template for a location. Returns { subject, body, enabled }.
 * Uses the message-templates edge function 'list' action to get the saved or
 * default template, then substitutes merge tags client-side.
 */
async function resolveReceiptTemplate(locationId, mergeData, token) {
  try {
    const res = await fetch(FUNC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action: 'list', location_id: locationId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const receiptType = (data.types || []).find(t => t.type === 'receipt');
    const tpl = receiptType?.templates?.email;
    if (!tpl) return null;

    // Substitute merge tags in the template text
    const sub = (str) => str?.replace(/\{\{(\w+)\}\}/g, (_, key) => mergeData[key] ?? `{{${key}}}`);
    return {
      subject: tpl.subject ? sub(tpl.subject) : null,
      body: tpl.body_text ? sub(tpl.body_text) : null,
      enabled: tpl.enabled !== false,
    };
  } catch {
    return null;
  }
}

/**
 * Send an email receipt for a closed check. Returns { ok, id?, error? }.
 * @param {object} params
 *   - to: customer email
 *   - locationId: ops location id
 *   - check: closed_checks record (or compatible)
 *   - locationLabel: display name for the location (fallback)
 *   - branding: optional receipt_branding object (loaded automatically if missing)
 */
export async function sendEmailReceipt({ to, locationId, check, locationLabel, branding }) {
  if (!to || !locationId || !check) return { ok:false, error:'missing args' };
  // TRAINING MODE: never send a real receipt email to a customer.
  if (isTrainingMode()) { console.log('[training] receipt email suppressed →', to); return { ok:true, id:'training', training:true }; }

  // Load receipt branding if not provided
  if (!branding && locationId) {
    try { branding = await loadLocationBranding(locationId); } catch {}
  }

  const businessName = branding?.header?.business_name || locationLabel || 'Restaurant';

  // Get auth token
  let token;
  try { token = await ensureAuthToken(); } catch { token = null; }

  // Date/time for merge data
  const dt = check.closedAt ? new Date(typeof check.closedAt === 'number' ? check.closedAt : check.closedAt) : new Date();
  const dateStr = dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const timeStr = dt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  const items = (check.items || []).filter(i => !i.voided);

  // Build full item breakdown for {{order_items}} merge tag
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0);
  const service  = Number(check.service) || 0;
  const discount = Number(check.discountAmount) || 0;
  const tip      = Number(check.tip) || 0;
  const taxBk    = check.taxBreakdown;

  const itemLines = [];
  items.forEach(it => {
    const lineTotal = (it.price || 0) * (it.qty || 1);
    // Triple-naming: emailed receipts use the line's explicit receipt name when set
    itemLines.push(`${it.qty > 1 ? `${it.qty}x ` : ''}${it.receiptName || it.name}  ${money(lineTotal)}`);
    if (it.qty > 1) itemLines.push(`  ${money(it.price)} each`);
    const mods = (it.mods || []).map(m => m?.name || m?.label || m).filter(Boolean);
    if (mods.length) itemLines.push(`  + ${mods.join(' · ')}`);
    if (it.notes) itemLines.push(`  Note: ${it.notes}`);
  });
  itemLines.push('');
  itemLines.push(`Subtotal: ${money(subtotal)}`);
  if (service > 0) itemLines.push(`Service charge: ${money(service)}`);
  // v5.5.853: named discount lines from the check's discounts array (POS + channel promos);
  // the single discountAmount figure stays as the legacy fallback.
  const discountRows = (Array.isArray(check.discounts) ? check.discounts : [])
    .map(d => ({ label: d.label || d.name || 'Discount', amount: Number(d.amount ?? d.value) || 0 }))
    .filter(d => d.amount > 0);
  if (discountRows.length) discountRows.forEach(d => itemLines.push(`${d.label}: -${money(d.amount)}`));
  else if (discount > 0) itemLines.push(`Discount: -${money(discount)}`);
  const deliveryFee = Number(check.customer?.delivery_fee ?? check.deliveryFee) || 0;
  if (deliveryFee > 0) itemLines.push(`Delivery: ${money(deliveryFee)}`);
  if (tip > 0) itemLines.push(`Gratuity: ${money(tip)}`);
  if (taxBk?.breakdown?.length) {
    itemLines.push('');
    taxBk.breakdown.forEach(br => {
      const pct = (br.rate.rate * 100).toFixed(1).replace('.0', '');
      itemLines.push(`${br.rate.name} (${pct}%): Net ${money(br.net)} — VAT ${money(br.tax)}`);
    });
  } else if (Number(check.taxAmount)) {
    itemLines.push(`Includes VAT of ${money(check.taxAmount)}`);
  }

  // Build merge data for template resolution
  const mergeData = {
    customer_name: typeof check.customer === 'object' ? (check.customer?.name || 'Customer') : 'Customer',
    venue_name: businessName,
    order_number: check.ref || '',
    order_total: money(check.total || 0),
    order_items: itemLines.join('\n'),
    date: `${dateStr} ${timeStr}`,
    payment_method: check.method || 'Card',
    server_name: check.server || '',
  };

  // Resolve the template (subject + greeting text from Message Templates)
  const template = await resolveReceiptTemplate(locationId, mergeData, token);

  // Use template subject if available, otherwise build default
  const subject = template?.subject || `Your receipt from ${businessName} — ${check.ref || ''}`.trim();

  // Use template body as greeting text above the receipt
  const greetingText = template?.body || null;

  const html = buildReceiptHtml({ check, locationLabel, branding, greetingText });
  const text = buildReceiptText({ check, locationLabel, branding });

  try {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-receipt`, {
      method:'POST',
      headers:{
        'content-type':'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        location_id: locationId,
        check_id: check.id,
        to,
        subject,
        html, text,
      }),
    });
    const j = await res.json();
    if (!res.ok) return { ok:false, error: j?.error || `HTTP ${res.status}` };
    return { ok:true, id: j?.id };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// ── Receipt rendering ────────────────────────────────────────────────────────
// Full VAT tax-compliant receipt matching printed receipt format.
// The greetingText (from the message template) is shown above the receipt.
function buildReceiptHtml({ check, locationLabel, branding, greetingText }) {
  const h = branding?.header || {};
  const f = branding?.footer || {};

  const businessName = h.business_name || locationLabel || 'Restaurant';
  const addressLines = (h.address_lines || []).filter(Boolean);
  const phone = h.phone || '';
  const taxId = h.tax_id || '';
  const footerMsg = f.message || '';

  // Date / time
  const dt = check.closedAt ? new Date(typeof check.closedAt === 'number' ? check.closedAt : check.closedAt) : new Date();
  const dateStr = dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const timeStr = dt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  // Items
  const items = (check.items || []).filter(i => !i.voided);

  // Totals
  const subtotal   = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0);
  const service    = Number(check.service) || 0;
  const tip        = Number(check.tip) || 0;
  const discount   = Number(check.discountAmount) || 0;
  const taxAmount  = Number(check.taxAmount) || 0;
  const total      = Number(check.total) || 0;
  const taxBk      = check.taxBreakdown;

  // CSS styles
  const S = {
    row: 'display:flex;justify-content:space-between;gap:12px;',
    mono: "font-family:'JetBrains Mono','SF Mono',Menlo,Consolas,monospace;",
    muted: 'color:#64748b;',
    dim: 'color:#94a3b8;',
    divider: 'border-top:1px solid #e2e8f0;',
    dividerDash: 'border-top:1px dashed #e2e8f0;',
  };

  // Convert template greeting text to HTML paragraphs (if provided)
  const greetingHtml = greetingText
    ? greetingText.split('\n\n').map(para =>
        `<p style="margin:0 0 12px;font-size:13px;color:#334155;line-height:1.6;">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`
      ).join('')
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt — ${escapeHtml(businessName)}</title></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;background:#f5f5f5;color:#0f172a;font-size:13px;line-height:1.5;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 28px 24px;box-shadow:0 1px 4px rgba(0,0,0,.06);">

    <!-- Header: business details -->
    <div style="text-align:center;margin-bottom:16px;">
      ${h.logo_url ? `<img src="${escapeHtml(h.logo_url)}" alt="${escapeHtml(businessName)}" style="max-width:140px;max-height:80px;margin-bottom:10px;" />` : ''}
      <div style="font-size:18px;font-weight:800;letter-spacing:-.01em;">${escapeHtml(businessName)}</div>
      ${addressLines.length ? `<div style="font-size:12px;${S.muted}margin-top:4px;">${addressLines.map(l => escapeHtml(l)).join('<br/>')}</div>` : ''}
      ${phone ? `<div style="font-size:12px;${S.muted}margin-top:2px;">${escapeHtml(phone)}</div>` : ''}
      ${taxId ? `<div style="font-size:11px;${S.dim}margin-top:4px;${S.mono}">${escapeHtml(taxId)}</div>` : ''}
    </div>

    <!-- Greeting text from message template -->
    ${greetingHtml ? `<div style="${S.divider}padding:14px 0 2px;">${greetingHtml}</div>` : ''}

    <!-- Order info -->
    <div style="${S.divider}padding:12px 0;font-size:12px;${S.muted}">
      <div style="${S.row}"><span>Date</span><span>${dateStr} ${timeStr}</span></div>
      ${check.ref ? `<div style="${S.row}margin-top:2px;"><span>Order</span><span style="${S.mono}font-weight:700;color:#0f172a;">#${escapeHtml(check.ref)}</span></div>` : ''}
      ${check.server ? `<div style="${S.row}margin-top:2px;"><span>Server</span><span>${escapeHtml(check.server)}</span></div>` : ''}
      ${check.tableLabel ? `<div style="${S.row}margin-top:2px;"><span>Table</span><span>${escapeHtml(check.tableLabel)}</span></div>` : ''}
      ${check.covers > 1 ? `<div style="${S.row}margin-top:2px;"><span>Covers</span><span>${check.covers}</span></div>` : ''}
    </div>

    <!-- Line items -->
    <div style="${S.divider}padding-top:14px;margin-bottom:4px;">
      <div style="${S.row}margin-bottom:8px;font-size:10px;font-weight:800;${S.muted}text-transform:uppercase;letter-spacing:.06em;">
        <span>Item</span><span>Amount</span>
      </div>
      ${items.map(it => {
        const lineTotal = (it.price || 0) * (it.qty || 1);
        return `
        <div style="margin-bottom:10px;">
          <div style="${S.row}">
            <div style="flex:1;">
              <div style="font-weight:600;">${it.qty > 1 ? `${it.qty} × ` : ''}${escapeHtml(it.receiptName || it.name || '')}</div>
              ${it.qty > 1 ? `<div style="font-size:11px;${S.dim}margin-top:1px;">${money(it.price)} each</div>` : ''}
              ${(it.mods || []).length ? `<div style="font-size:11px;${S.muted}margin-top:2px;">+ ${(it.mods || []).map(m => escapeHtml(m?.name || m?.label || m)).filter(Boolean).join(' · ')}</div>` : ''}
              ${it.notes ? `<div style="font-size:11px;${S.dim}margin-top:2px;font-style:italic;">${escapeHtml(it.notes)}</div>` : ''}
            </div>
            <div style="${S.mono}font-weight:600;white-space:nowrap;">${money(lineTotal)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <!-- Totals -->
    <div style="${S.divider}padding-top:12px;font-size:13px;">
      <div style="${S.row}margin-bottom:4px;"><span>Subtotal</span><span style="${S.mono}">${money(subtotal)}</span></div>
      ${service > 0 ? `<div style="${S.row}margin-bottom:4px;${S.muted}"><span>Service charge</span><span style="${S.mono}">${money(service)}</span></div>` : ''}
      ${(() => {
        // v5.5.853: named discount lines (POS + channel); single-figure fallback kept.
        const rows = (Array.isArray(check.discounts) ? check.discounts : [])
          .map(d => ({ label: d.label || d.name || 'Discount', amount: Number(d.amount ?? d.value) || 0 }))
          .filter(d => d.amount > 0);
        if (rows.length) return rows.map(d => `<div style="${S.row}margin-bottom:4px;color:#dc2626;"><span>${d.label}</span><span style="${S.mono}">-${money(d.amount)}</span></div>`).join('');
        return discount > 0 ? `<div style="${S.row}margin-bottom:4px;color:#dc2626;"><span>Discount</span><span style="${S.mono}">-${money(discount)}</span></div>` : '';
      })()}
      ${(Number(check.customer?.delivery_fee ?? check.deliveryFee) || 0) > 0 ? `<div style="${S.row}margin-bottom:4px;${S.muted}"><span>Delivery</span><span style="${S.mono}">${money(Number(check.customer?.delivery_fee ?? check.deliveryFee))}</span></div>` : ''}
      ${tip > 0 ? `<div style="${S.row}margin-bottom:4px;${S.muted}"><span>Gratuity</span><span style="${S.mono}">${money(tip)}</span></div>` : ''}

      <!-- Total -->
      <div style="${S.divider}margin-top:8px;padding-top:10px;${S.row}font-weight:800;font-size:18px;">
        <span>Total</span><span style="${S.mono}">${money(total)}</span>
      </div>

      <!-- VAT breakdown -->
      ${taxBk?.breakdown?.length ? `
      <div style="${S.dividerDash}margin-top:10px;padding-top:8px;font-size:11px;${S.muted}">
        <div style="${S.row}margin-bottom:4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:10px;">
          <span>Tax summary</span>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:4px;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">
          <span style="flex:1;">Rate</span>
          <span style="width:70px;text-align:right;">Net</span>
          <span style="width:70px;text-align:right;">VAT</span>
          <span style="width:70px;text-align:right;">Gross</span>
        </div>
        ${taxBk.breakdown.map(br => {
          const pct = (br.rate.rate * 100).toFixed(1).replace('.0','');
          return `
          <div style="display:flex;gap:8px;margin-bottom:2px;font-size:12px;">
            <span style="flex:1;">${escapeHtml(br.rate.name)} (${pct}%)</span>
            <span style="width:70px;text-align:right;${S.mono}">${money(br.net)}</span>
            <span style="width:70px;text-align:right;${S.mono}">${money(br.tax)}</span>
            <span style="width:70px;text-align:right;${S.mono}">${money(br.gross)}</span>
          </div>`;
        }).join('')}
        <div style="display:flex;gap:8px;margin-top:4px;padding-top:4px;${S.dividerDash}font-size:12px;font-weight:700;">
          <span style="flex:1;">Total</span>
          <span style="width:70px;text-align:right;${S.mono}">${money(taxBk.subtotal)}</span>
          <span style="width:70px;text-align:right;${S.mono}">${money(taxBk.totalTax)}</span>
          <span style="width:70px;text-align:right;${S.mono}">${money(taxBk.total)}</span>
        </div>
      </div>` : taxAmount ? `
      <div style="${S.dividerDash}margin-top:10px;padding-top:8px;font-size:11px;${S.muted}">
        <div style="${S.row}"><span>Includes VAT of</span><span style="${S.mono}">${money(taxAmount)}</span></div>
      </div>` : ''}

      <!-- Payment -->
      ${check.method ? `
      <div style="${S.divider}margin-top:10px;padding-top:10px;font-size:12px;">
        <div style="${S.row}"><span style="${S.muted}">Payment method</span><span style="font-weight:700;text-transform:capitalize;">${escapeHtml(check.method)}</span></div>
        <div style="${S.row}margin-top:2px;"><span style="${S.muted}">Status</span><span style="font-weight:700;color:#16a34a;">Paid</span></div>
      </div>` : ''}

      <!-- Card-scheme block (masked PAN / scheme / auth code / entry / CVM / AID) -->
      ${(() => {
        const cl = cardReceiptLines(check);
        if (!cl.length) return '';
        return `
      <div style="${S.dividerDash}margin-top:8px;padding-top:8px;font-size:11px;${S.muted}">
        ${cl.map(([l, v]) => `<div style="${S.row}"><span>${escapeHtml(l)}</span><span style="${S.mono}">${escapeHtml(String(v))}</span></div>`).join('')}
        <div style="text-align:center;margin-top:6px;font-size:10px;">Please retain this receipt</div>
      </div>`;
      })()}
    </div>

    <!-- Footer -->
    <div style="margin-top:20px;padding-top:14px;${S.divider}text-align:center;">
      ${footerMsg ? `<div style="font-size:12px;${S.muted}margin-bottom:8px;">${escapeHtml(footerMsg)}</div>` : ''}
      <div style="font-size:10px;${S.dim}">
        ${dateStr} ${timeStr}${check.ref ? ` · Ref ${escapeHtml(check.ref)}` : ''}
      </div>
      <div style="font-size:10px;${S.dim}margin-top:8px;">Powered by Serv OS</div>
    </div>
  </div>
</body></html>`;
}

function buildReceiptText({ check, locationLabel, branding }) {
  const h = branding?.header || {};
  const f = branding?.footer || {};

  const businessName = h.business_name || locationLabel || 'Restaurant';
  const addressLines = (h.address_lines || []).filter(Boolean);
  const phone = h.phone || '';
  const taxId = h.tax_id || '';
  const footerMsg = f.message || '';

  const dt = check.closedAt ? new Date(typeof check.closedAt === 'number' ? check.closedAt : check.closedAt) : new Date();
  const dateStr = dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const timeStr = dt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  const items = (check.items || []).filter(i => !i.voided);
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0);
  const service  = Number(check.service) || 0;
  const tip      = Number(check.tip) || 0;
  const discount = Number(check.discountAmount) || 0;
  const taxAmount = Number(check.taxAmount) || 0;
  const total    = Number(check.total) || 0;
  const taxBk    = check.taxBreakdown;

  const pad = (l, r, w = 44) => {
    const gap = Math.max(1, w - l.length - r.length);
    return l + ' '.repeat(gap) + r;
  };

  const lines = [];
  lines.push(businessName);
  addressLines.forEach(l => lines.push(l));
  if (phone) lines.push(phone);
  if (taxId) lines.push(taxId);
  lines.push('');
  lines.push('='.repeat(44));
  lines.push(pad('Date:', `${dateStr} ${timeStr}`));
  if (check.ref) lines.push(pad('Order:', `#${check.ref}`));
  if (check.server) lines.push(pad('Server:', check.server));
  if (check.tableLabel) lines.push(pad('Table:', check.tableLabel));
  if (check.covers > 1) lines.push(pad('Covers:', String(check.covers)));
  lines.push('-'.repeat(44));
  lines.push('');

  items.forEach(it => {
    const lineTotal = (it.price || 0) * (it.qty || 1);
    const rName = it.receiptName || it.name;
    const nameStr = it.qty > 1 ? `${it.qty} x ${rName}` : rName;
    lines.push(pad(nameStr, money(lineTotal)));
    if (it.qty > 1) lines.push(`     ${money(it.price)} each`);
    if ((it.mods || []).length) lines.push(`  + ${(it.mods || []).map(m => m?.name || m?.label || m).filter(Boolean).join(' · ')}`);
    if (it.notes) lines.push(`  ${it.notes}`);
  });

  lines.push('');
  lines.push('-'.repeat(44));
  lines.push(pad('Subtotal', money(subtotal)));
  if (service > 0) lines.push(pad('Service charge', money(service)));
  // v5.5.853: named discount lines (POS + channel); single-figure fallback kept.
  const discRows = (Array.isArray(check.discounts) ? check.discounts : [])
    .map(d => ({ label: d.label || d.name || 'Discount', amount: Number(d.amount ?? d.value) || 0 }))
    .filter(d => d.amount > 0);
  if (discRows.length) discRows.forEach(d => lines.push(pad(d.label.substring(0, 28), `-${money(d.amount)}`)));
  else if (discount > 0) lines.push(pad('Discount', `-${money(discount)}`));
  const delFee = Number(check.customer?.delivery_fee ?? check.deliveryFee) || 0;
  if (delFee > 0) lines.push(pad('Delivery', money(delFee)));
  if (tip > 0) lines.push(pad('Gratuity', money(tip)));
  lines.push('='.repeat(44));
  lines.push(pad('TOTAL', money(total)));
  lines.push('='.repeat(44));

  if (taxBk?.breakdown?.length) {
    lines.push('');
    lines.push('TAX SUMMARY');
    lines.push('-'.repeat(44));
    taxBk.breakdown.forEach(br => {
      const pct = (br.rate.rate * 100).toFixed(1).replace('.0', '');
      lines.push(`${br.rate.name} (${pct}%)`);
      lines.push(`  Net: ${money(br.net)}  VAT: ${money(br.tax)}  Gross: ${money(br.gross)}`);
    });
    lines.push('-'.repeat(44));
    lines.push(`Total Net: ${money(taxBk.subtotal)}  VAT: ${money(taxBk.totalTax)}  Gross: ${money(taxBk.total)}`);
  } else if (taxAmount) {
    lines.push('');
    lines.push(pad('Includes VAT of', money(taxAmount)));
  }

  lines.push('');
  if (check.method) lines.push(pad('Paid by', check.method));
  for (const [l, v] of cardReceiptLines(check)) lines.push(pad(l, String(v)));   // card-scheme block
  lines.push('');
  if (footerMsg) lines.push(footerMsg);
  lines.push(`${dateStr} ${timeStr}${check.ref ? ` · Ref ${check.ref}` : ''}`);
  lines.push('Powered by Serv OS');
  return lines.join('\n');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
