// src/lib/sendReceipt.js — client-side helper that calls the send-receipt
// edge function. Builds the receipt HTML from a check + items + totals so we
// have a single rendering source of truth across MPOS / desktop / kiosk.

import { supabase } from './supabase';

const money = (n) => `£${(Number(n) || 0).toFixed(2)}`;

/**
 * Send an email receipt for a closed check. Returns { ok, id?, error? }.
 * @param {object} params
 *   - to: customer email
 *   - locationId: ops location id
 *   - check: closed_checks record (or compatible)
 *   - locationLabel: display name for the location
 */
export async function sendEmailReceipt({ to, locationId, check, locationLabel }) {
  if (!to || !locationId || !check) return { ok:false, error:'missing args' };
  const html = buildReceiptHtml({ check, locationLabel });
  const text = buildReceiptText({ check, locationLabel });
  try {
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
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
        subject: `Receipt from ${locationLabel || 'us'} · ${check.ref || ''}`.trim(),
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
// Same data shape as the print path so the email and the paper docket match.
function buildReceiptHtml({ check, locationLabel }) {
  const items = (check.items || []).filter(i => !i.voided);
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  const tip = Number(check.tip) || 0;
  const tax = Number(check.taxAmount) || 0;
  const total = Number(check.total) || subtotal + tip + tax;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Receipt</title></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;background:#f5f5f5;color:#0f172a;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:24px 28px;box-shadow:0 1px 4px rgba(0,0,0,.06);">
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:13px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(locationLabel || '')}</div>
      <div style="font-size:18px;font-weight:800;margin-top:6px;">Thank you</div>
      ${check.ref ? `<div style="font-size:12px;color:#64748b;font-family:'JetBrains Mono',monospace;margin-top:4px;">Ref ${escapeHtml(check.ref)}</div>` : ''}
    </div>

    <div style="border-top:1px solid #e2e8f0;padding-top:14px;margin-bottom:14px;">
      ${items.map(it => `
        <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;">
          <div style="flex:1;font-size:13px;">
            <strong>${it.qty} × ${escapeHtml(it.name || '')}</strong>
            ${(it.mods || []).length ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">+ ${(it.mods || []).map(m => escapeHtml(m?.name || m?.label || m)).filter(Boolean).join(' · ')}</div>` : ''}
            ${it.notes ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${escapeHtml(it.notes)}</div>` : ''}
          </div>
          <div style="font-size:13px;font-family:'JetBrains Mono',monospace;text-align:right;">${money((it.price || 0) * (it.qty || 0))}</div>
        </div>
      `).join('')}
    </div>

    <div style="border-top:1px solid #e2e8f0;padding-top:12px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>Subtotal</span><span style="font-family:'JetBrains Mono',monospace;">${money(subtotal)}</span></div>
      ${tax ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px;color:#64748b;"><span>Tax</span><span style="font-family:'JetBrains Mono',monospace;">${money(tax)}</span></div>` : ''}
      ${tip ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px;color:#64748b;"><span>Tip</span><span style="font-family:'JetBrains Mono',monospace;">${money(tip)}</span></div>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;font-weight:800;font-size:16px;">
        <span>Total</span><span style="font-family:'JetBrains Mono',monospace;">${money(total)}</span>
      </div>
      ${check.method ? `<div style="margin-top:6px;font-size:11px;color:#94a3b8;text-align:right;">Paid by ${escapeHtml(check.method)}</div>` : ''}
    </div>

    <div style="margin-top:24px;padding-top:14px;border-top:1px solid #e2e8f0;text-align:center;font-size:11px;color:#94a3b8;">
      Powered by Restaurant OS
    </div>
  </div>
</body></html>`;
}

function buildReceiptText({ check, locationLabel }) {
  const items = (check.items || []).filter(i => !i.voided);
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  const tip = Number(check.tip) || 0;
  const tax = Number(check.taxAmount) || 0;
  const total = Number(check.total) || subtotal + tip + tax;
  const lines = [];
  lines.push(`${locationLabel || 'Receipt'}`);
  if (check.ref) lines.push(`Ref ${check.ref}`);
  lines.push('');
  items.forEach(it => {
    lines.push(`${it.qty} x ${it.name}  ${money((it.price || 0) * (it.qty || 0))}`);
    if ((it.mods || []).length) lines.push(`   + ${(it.mods || []).map(m => m?.name || m?.label || m).filter(Boolean).join(' · ')}`);
    if (it.notes) lines.push(`   ${it.notes}`);
  });
  lines.push('');
  lines.push(`Subtotal  ${money(subtotal)}`);
  if (tax) lines.push(`Tax       ${money(tax)}`);
  if (tip) lines.push(`Tip       ${money(tip)}`);
  lines.push(`Total     ${money(total)}`);
  if (check.method) lines.push(`Paid by ${check.method}`);
  lines.push('');
  lines.push('Powered by Restaurant OS');
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
