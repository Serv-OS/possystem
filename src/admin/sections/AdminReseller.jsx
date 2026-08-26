// src/admin/sections/AdminReseller.jsx
//
// FranPOS residuals: what they owe us, and the invoices that collect it.
//
// THE MONEY FLOW: we process on FranPOS's Adyen account, so every venue's card
// markup settles to FranPOS, not to us. Under the reseller terms (26 Aug 2026)
// FranPOS keeps IC plus 0.10% plus 5 minor units per transaction and owes us
// the rest of each payment's stamped commission. Nothing arrives unless we
// invoice them, which is exactly what this screen does:
//
//   statement  → live computation for a month (per venue, per currency)
//   invoice    → persists the statement as a reseller_invoices row, then
//                draft → sent → paid, and void for a regeneration
//   print      → a clean invoice document to send to FranPOS
//
// Honest-flags doctrine as everywhere in the admin portal: payments with no
// stamped commission are counted and shown, never estimated onto the invoice.

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function callPaymentsAdmin(action, payload = {}) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('not authenticated');
  const res = await fetch(`${FUNCTIONS_URL}/payments-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

const S = {
  h1:    { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:   { fontSize: 13, color: 'var(--t3)', marginBottom: 20, maxWidth: 760, lineHeight: 1.5 },
  card:  { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 5, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input: { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn:   { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrimary: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  errorBox: { padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  note:  { padding: 10, background: 'var(--bg3)', color: 'var(--t2)', borderRadius: 8, fontSize: 12, border: '1px solid var(--bdr2)', marginBottom: 10, lineHeight: 1.5 },
  th:    { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' },
  td:    { fontSize: 13, padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap', borderTop: '1px solid var(--bdr)' },
  chip:  (bg, fg, bd) => ({ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', padding: '3px 9px', borderRadius: 20, background: bg, color: fg, border: `1px solid ${bd}` }),
};

const STATUS_CHIP = {
  draft: ['var(--bg3)', 'var(--t2)', 'var(--bdr2)'],
  sent:  ['var(--acc-d)', 'var(--acc)', 'var(--acc-b)'],
  paid:  ['var(--grn-d)', 'var(--grn)', 'var(--grn-b)'],
  void:  ['transparent', 'var(--t4)', 'var(--bdr)'],
};

const monthNow = () => new Date().toISOString().slice(0, 7);
const money = (minor, cur) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'GBP' }).format((Number(minor) || 0) / 100);

export default function AdminReseller() {
  const [month, setMonth] = useState(monthNow());
  const [statement, setStatement] = useState(null);
  const [config, setConfig] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [remit, setRemit] = useState(null);
  const [remitDraft, setRemitDraft] = useState(null);
  const [tableMissing, setTableMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rateDraft, setRateDraft] = useState(null); // { buy_percent, buy_fixed_minor } while editing

  const loadInvoices = useCallback(async () => {
    try {
      const j = await callPaymentsAdmin('reseller_invoices');
      setInvoices(j.invoices ?? []);
      setRemit(j.remit ?? null);
      setTableMissing(!!j.table_missing);
    } catch (e) { setError(String(e.message || e)); }
  }, []);

  const loadStatement = useCallback(async (m) => {
    setLoading(true); setError('');
    try {
      const j = await callPaymentsAdmin('reseller_statement', { month: m });
      setStatement(j);
      setConfig(j.config ?? null);
    } catch (e) { setError(String(e.message || e)); setStatement(null); }
    setLoading(false);
  }, []);

  // Deferred a tick: the repo lint refuses setState reachable synchronously from
  // an effect, and both loaders set busy flags before their first await.
  useEffect(() => { const t = setTimeout(() => loadStatement(month), 0); return () => clearTimeout(t); }, [month, loadStatement]);
  useEffect(() => { const t = setTimeout(() => loadInvoices(), 0); return () => clearTimeout(t); }, [loadInvoices]);

  const createInvoice = async () => {
    if (!confirm(`Create the ${month} invoice to FranPOS from this statement?`)) return;
    setBusy(true); setError('');
    try {
      await callPaymentsAdmin('reseller_invoice_create', { month });
      await loadInvoices();
    } catch (e) { setError(String(e.message || e)); }
    setBusy(false);
  };

  const mark = async (inv, status) => {
    const verb = { sent: 'Mark as sent to FranPOS', paid: 'Mark as PAID', void: 'VOID this invoice' }[status];
    let notes;
    if (status === 'void') {
      // The audit trail's most important entry: why the number FranPOS was
      // sent no longer stands. The server refuses a reasonless void too.
      notes = prompt(`Why is ${inv.invoice_number} being voided? This is recorded and shown if FranPOS asks.`);
      if (!notes || !notes.trim()) return;
    } else if (!confirm(`${verb}: ${inv.invoice_number}?`)) return;
    setBusy(true); setError('');
    try {
      await callPaymentsAdmin('reseller_invoice_mark', { id: inv.id, status, ...(notes ? { notes } : {}) });
      await loadInvoices();
    } catch (e) { setError(String(e.message || e)); }
    setBusy(false);
  };

  const saveRate = async () => {
    setBusy(true); setError('');
    try {
      const j = await callPaymentsAdmin('reseller_config', { set: {
        buy_percent: Number(rateDraft.buy_percent),
        buy_fixed_minor: Math.round(Number(rateDraft.buy_fixed_minor)),
      } });
      setConfig((c) => ({ ...(c || {}), buy_percent: j.buy_percent, buy_fixed_minor: j.buy_fixed_minor, from_settings: j.from_settings }));
      setRateDraft(null);
      await loadStatement(month);
    } catch (e) { setError(String(e.message || e)); }
    setBusy(false);
  };

  const saveRemit = async () => {
    setBusy(true); setError('');
    try {
      const j = await callPaymentsAdmin('reseller_config', { set_remit: {
        ...remitDraft, terms_days: Number(remitDraft.terms_days) || 14,
      } });
      setRemit(j.remit ?? null);
      setRemitDraft(null);
    } catch (e) { setError(String(e.message || e)); }
    setBusy(false);
  };

  // Print one invoice: a minimal document in a new window, then the browser's
  // own print dialog. No PDF library, nothing to install, works everywhere.
  const printInvoice = (inv) => {
    const lines = inv.breakdown?.lines ?? [];
    const issued = (inv.sent_at || inv.created_at || '').slice(0, 10);
    const termsDays = Number(remit?.terms_days) || 14;
    const due = issued ? new Date(new Date(issued).getTime() + termsDays * 86400000).toISOString().slice(0, 10) : '';
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const w = window.open('', '_blank', 'width=820,height=900');
    if (!w) { setError('The print window was blocked. Allow popups for this site.'); return; }
    w.document.write(`<!doctype html><html><head><title>${esc(inv.invoice_number)}</title><style>
      body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111; margin: 48px; }
      h1 { font-size: 20px; margin: 0 0 2px; } .muted { color: #666; font-size: 12px; }
      .row { display: flex; justify-content: space-between; margin-top: 28px; }
      table { border-collapse: collapse; width: 100%; margin-top: 24px; font-size: 13px; }
      th { text-align: right; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; border-bottom: 1px solid #ccc; padding: 6px 8px; }
      td { text-align: right; padding: 6px 8px; border-bottom: 1px solid #eee; }
      th:first-child, td:first-child { text-align: left; }
      .total td { font-weight: 800; border-top: 2px solid #111; border-bottom: none; font-size: 14px; }
      .foot { margin-top: 36px; font-size: 11px; color: #666; line-height: 1.6; }
    </style></head><body>
      <h1>ServOS App Inc</h1>
      <div class="muted">Card processing residuals</div>
      <div class="row">
        <div>
          <div class="muted">From</div>
          <div style="white-space:pre-line">${esc(remit?.from_block || 'ServOS App Inc\n[address not set: Admin, FranPOS, Invoice details]')}</div>
          <div class="muted" style="margin-top:12px">Billed to</div>
          <div style="white-space:pre-line"><strong>${esc(remit?.billed_to_block || 'FranPOS\n[entity and address not set]')}</strong></div>
        </div>
        <div style="text-align:right">
          <div><strong>${esc(inv.invoice_number)}</strong></div>
          <div class="muted">Period: ${esc(inv.period)} &nbsp; Currency: ${esc(inv.currency)}</div>
          <div class="muted">Issued: ${esc(issued)}</div>
          <div class="muted"><strong>Due: ${esc(due)}</strong></div>
        </div>
      </div>
      <table>
        <tr><th>Venue</th><th>Payments</th><th>Volume</th><th>Gross commission</th><th>FranPOS share (${esc(inv.buy_percent)}% + ${esc(inv.buy_fixed_minor)})</th><th>Due to ServOS</th></tr>
        ${lines.map((l) => `<tr>
          <td>${esc(l.name)}</td><td>${esc(l.count)}</td><td>${esc(money(l.volume_minor, inv.currency))}</td>
          <td>${esc(money(l.gross_commission_minor, inv.currency))}</td><td>${esc(money(l.buy_share_minor, inv.currency))}</td>
          <td>${esc(money(l.net_due_minor, inv.currency))}</td></tr>`).join('')}
        <tr class="total"><td>Total due</td><td>${esc(inv.payment_count)}</td><td>${esc(money(inv.volume_minor, inv.currency))}</td>
          <td>${esc(money(inv.gross_commission_minor, inv.currency))}</td><td>${esc(money(inv.buy_share_minor, inv.currency))}</td>
          <td>${esc(money(inv.net_due_minor, inv.currency))}</td></tr>
      </table>
      <div class="foot">
        Computed per transaction as the venue commission less the FranPOS buy rate of ${esc(inv.buy_percent)}% plus ${esc(inv.buy_fixed_minor)} minor units, under the reseller terms between ServOS App Inc and FranPOS.
        ${inv.unrated_count > 0 ? `<br/>${esc(inv.unrated_count)} payment(s) totalling ${esc(money(inv.unrated_volume_minor, inv.currency))} carried no rate classification and are EXCLUDED from this invoice.` : ''}
        ${inv.breakdown?.unsettled_count > 0 ? `<br/>${esc(inv.breakdown.unsettled_count)} authorised but never captured payment(s) totalling ${esc(money(inv.breakdown.unsettled_volume_minor, inv.currency))} are WITHHELD: no money moved.` : ''}
        ${inv.breakdown?.replaces_note ? `<br/><strong>${esc(inv.breakdown.replaces_note)}.</strong>` : ''}
        <br/>${esc(remit?.tax_line || '[Tax line not set: confirm treatment with the accountant in Admin, FranPOS, Invoice details]')}
        <br/><strong>Remit to:</strong> <span style="white-space:pre-line">${esc(remit?.bank_block || '[Bank details not set: Admin, FranPOS, Invoice details]')}</span>
        <br/>Reference the invoice number on payment.
      </div>
    <script>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <div>
      <h1 style={S.h1}>FranPOS residuals</h1>
      <p style={S.sub}>
        Card markup settles to FranPOS because we process on their Adyen account. They keep
        the buy rate and owe us the rest of every payment&rsquo;s commission. Generate the
        month&rsquo;s statement, turn it into an invoice, and track it to paid.
      </p>

      {error && <div style={S.errorBox}>{error}</div>}
      {tableMissing && (
        <div style={S.note}>
          The invoice ledger table is missing. Apply migration
          <b> 20260826_PLATFORM_reseller_invoicing.sql</b> to the Platform DB.
          Statements still work; invoices cannot be saved until it is applied.
        </div>
      )}

      {/* ── controls ── */}
      <div style={{ ...S.card, display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={S.label}>Month</label>
          <input type="month" value={month} max={monthNow()} onChange={(e) => setMonth(e.target.value)} style={S.input} />
        </div>
        <div style={{ flex: 1 }} />
        <div>
          <label style={S.label}>FranPOS buy rate</label>
          {rateDraft ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={rateDraft.buy_percent} onChange={(e) => setRateDraft((d) => ({ ...d, buy_percent: e.target.value }))} style={{ ...S.input, width: 70 }} />%
              <span style={{ color: 'var(--t3)' }}>+</span>
              <input value={rateDraft.buy_fixed_minor} onChange={(e) => setRateDraft((d) => ({ ...d, buy_fixed_minor: e.target.value }))} style={{ ...S.input, width: 56 }} />
              <span style={{ fontSize: 12, color: 'var(--t3)' }}>minor units / txn</span>
              <button onClick={saveRate} disabled={busy} style={{ ...S.btn, ...S.btnPrimary }}>Save</button>
              <button onClick={() => setRateDraft(null)} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', fontFamily: 'var(--font-mono, monospace)' }}>
                IC + {config?.buy_percent ?? '…'}% + {config?.buy_fixed_minor ?? '…'}
              </span>
              <button onClick={() => setRateDraft({ buy_percent: config?.buy_percent ?? 0.10, buy_fixed_minor: config?.buy_fixed_minor ?? 5 })}
                style={{ ...S.btn, ...S.btnGhost, padding: '5px 10px', fontSize: 11 }}>Edit</button>
            </div>
          )}
          {config && !config.from_settings && (
            <div style={{ fontSize: 11, color: 'var(--amb, #e8a020)', marginTop: 4 }}>
              Using the signed terms as a fallback. Apply the migration to store the rate.
            </div>
          )}
        </div>
      </div>

      {/* ── the month's statement ── */}
      {loading && <div style={{ ...S.card, color: 'var(--t3)', textAlign: 'center' }}>Computing…</div>}
      {!loading && statement && statement.statements?.length === 0 && (
        <div style={{ ...S.card, color: 'var(--t3)', textAlign: 'center' }}>No card payments in {month}.</div>
      )}
      {!loading && statement?.statements?.map((s) => {
        const monthOpen = month >= monthNow();
        const live = invoices.find((i) => i.period === month && i.currency === s.currency && i.status !== 'void');
        const drifted = live && Number(live.net_due_minor) !== Number(s.totals.net_due_minor);
        const rateChanged = live && config
          && (Number(live.buy_percent) !== Number(config.buy_percent) || Number(live.buy_fixed_minor) !== Number(config.buy_fixed_minor));
        return (
        <div key={s.currency} style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{month} · {s.currency}</div>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 13, color: 'var(--t2)' }}>
              FranPOS owes <b style={{ color: 'var(--grn)', fontSize: 16 }}>{money(s.totals.net_due_minor, s.currency)}</b>
            </div>
            {live ? (
              <span style={{ fontSize: 12, color: 'var(--t2)' }}>Invoiced: <b>{live.invoice_number}</b> ({live.status})</span>
            ) : (
              <button onClick={createInvoice} disabled={busy || tableMissing || monthOpen}
                title={monthOpen ? 'The month is still open. Invoice after it ends so nothing is missed.' : undefined}
                style={{ ...S.btn, ...S.btnPrimary, opacity: monthOpen ? 0.5 : 1 }}>Create invoice</button>
            )}
          </div>
          {monthOpen && !live && (
            <div style={S.note}>This month is still open. The figures below grow until it ends; the invoice unlocks then.</div>
          )}
          {drifted && (
            <div style={S.note}>
              {rateChanged
                ? <>This statement is priced at the current buy rate, while invoice {live.invoice_number} kept the rate that governed it. The invoice is correct; do not regenerate just for this.</>
                : <>The month has CHANGED since {live.invoice_number} was created (late webhooks or a backfill): invoice says {money(live.net_due_minor, s.currency)}, the ledger now says {money(s.totals.net_due_minor, s.currency)}. Void it with a reason and regenerate before sending.</>}
            </div>
          )}
          {s.totals.unrated_count > 0 && (
            <div style={S.note}>
              {s.totals.unrated_count} payment(s) totalling {money(s.totals.unrated_volume_minor, s.currency)} carry no
              stamped commission and are excluded. Run the webhook backfill, then regenerate.
            </div>
          )}
          {s.totals.unsettled_count > 0 && (
            <div style={S.note}>
              {s.totals.unsettled_count} payment(s) totalling {money(s.totals.unsettled_volume_minor, s.currency)} were
              authorised but never captured, so no money moved and they are withheld from the invoice.
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr>
                <th style={{ ...S.th, textAlign: 'left' }}>Venue</th>
                <th style={S.th}>Payments</th><th style={S.th}>Volume</th>
                <th style={S.th}>Gross commission</th><th style={S.th}>FranPOS share</th>
                <th style={S.th}>Due to ServOS</th><th style={S.th}>Refunds</th>
              </tr></thead>
              <tbody>
                {s.lines.map((l) => (
                  <tr key={l.location_id}>
                    <td style={{ ...S.td, textAlign: 'left', color: 'var(--t1)', fontWeight: 600 }}>
                      {l.name}{l.unrated_count > 0 && <span style={{ color: 'var(--amb, #e8a020)', fontWeight: 400 }}> · {l.unrated_count} unrated</span>}
                    </td>
                    <td style={S.td}>{l.count}</td>
                    <td style={S.td}>{money(l.volume_minor, s.currency)}</td>
                    <td style={S.td}>{money(l.gross_commission_minor, s.currency)}</td>
                    <td style={S.td}>{money(l.buy_share_minor, s.currency)}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: l.net_due_minor >= 0 ? 'var(--grn)' : 'var(--red)' }}>{money(l.net_due_minor, s.currency)}</td>
                    <td style={{ ...S.td, color: 'var(--t3)' }}>{l.refunds_minor ? money(l.refunds_minor, s.currency) : '·'}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...S.td, textAlign: 'left', fontWeight: 800, color: 'var(--t1)' }}>Total</td>
                  <td style={{ ...S.td, fontWeight: 800 }}>{s.totals.count}</td>
                  <td style={{ ...S.td, fontWeight: 800 }}>{money(s.totals.volume_minor, s.currency)}</td>
                  <td style={{ ...S.td, fontWeight: 800 }}>{money(s.totals.gross_commission_minor, s.currency)}</td>
                  <td style={{ ...S.td, fontWeight: 800 }}>{money(s.totals.buy_share_minor, s.currency)}</td>
                  <td style={{ ...S.td, fontWeight: 800, color: 'var(--grn)' }}>{money(s.totals.net_due_minor, s.currency)}</td>
                  <td style={S.td} />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        );
      })}

      {/* ── invoice details (remit block) ── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>Invoice details</div>
          <div style={{ flex: 1 }} />
          {!remitDraft && (
            <button onClick={() => setRemitDraft({
              from_block: remit?.from_block || 'ServOS App Inc\n', billed_to_block: remit?.billed_to_block || 'FranPOS\n',
              bank_block: remit?.bank_block || '', terms_days: remit?.terms_days || 14, tax_line: remit?.tax_line || '',
            })} style={{ ...S.btn, ...S.btnGhost, padding: '5px 10px', fontSize: 11 }}>{remit ? 'Edit' : 'Set up'}</button>
          )}
        </div>
        {!remit && !remitDraft && (
          <div style={S.note}>
            Accounts payable departments bounce invoices without addresses, bank details, a due date and a
            tax line. Set them once here and every printed invoice carries them.
          </div>
        )}
        {remit && !remitDraft && (
          <div style={{ fontSize: 12, color: 'var(--t2)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ whiteSpace: 'pre-line' }}><b style={{ color: 'var(--t3)', fontSize: 10 }}>FROM</b><br/>{remit.from_block}</div>
            <div style={{ whiteSpace: 'pre-line' }}><b style={{ color: 'var(--t3)', fontSize: 10 }}>BILLED TO</b><br/>{remit.billed_to_block}</div>
            <div style={{ whiteSpace: 'pre-line' }}><b style={{ color: 'var(--t3)', fontSize: 10 }}>REMIT TO</b><br/>{remit.bank_block || 'not set'}</div>
            <div><b style={{ color: 'var(--t3)', fontSize: 10 }}>TERMS</b><br/>{remit.terms_days || 14} days</div>
          </div>
        )}
        {remitDraft && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[['from_block', 'From (our legal entity and address)'], ['billed_to_block', 'Billed to (their legal entity and address)'], ['bank_block', 'Remit to (bank details for payment)']].map(([k, lab]) => (
              <div key={k} style={{ gridColumn: k === 'bank_block' ? '1 / -1' : undefined }}>
                <label style={S.label}>{lab}</label>
                <textarea value={remitDraft[k]} onChange={(e) => setRemitDraft((d) => ({ ...d, [k]: e.target.value }))}
                  rows={3} style={{ ...S.input, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
              </div>
            ))}
            <div>
              <label style={S.label}>Payment terms (days)</label>
              <input value={remitDraft.terms_days} onChange={(e) => setRemitDraft((d) => ({ ...d, terms_days: e.target.value }))} style={{ ...S.input, width: 90 }} />
            </div>
            <div>
              <label style={S.label}>Tax line (confirm with the accountant)</label>
              <input value={remitDraft.tax_line} onChange={(e) => setRemitDraft((d) => ({ ...d, tax_line: e.target.value }))}
                placeholder="For example: No VAT applicable, services outside the scope of UK VAT." style={{ ...S.input, width: '100%' }} />
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
              <button onClick={saveRemit} disabled={busy} style={{ ...S.btn, ...S.btnPrimary }}>Save</button>
              <button onClick={() => setRemitDraft(null)} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ── invoice ledger ── */}
      <div style={S.card}>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 10 }}>Invoices</div>
        {invoices.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No invoices yet. Create one from a month&rsquo;s statement above.</div>}
        {invoices.map((inv) => {
          const [bg, fg, bd] = STATUS_CHIP[inv.status] ?? STATUS_CHIP.draft;
          return (
            <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', borderTop: '1px solid var(--bdr)', opacity: inv.status === 'void' ? 0.55 : 1 }}>
              <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13, fontWeight: 700, color: 'var(--t1)', minWidth: 150 }}>{inv.invoice_number}</span>
              <span style={S.chip(bg, fg, bd)}>{inv.status}</span>
              <span style={{ fontSize: 13, color: 'var(--t2)' }}>{inv.payment_count} payments · {money(inv.volume_minor, inv.currency)} volume</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--grn)' }}>{money(inv.net_due_minor, inv.currency)}</span>
              <button onClick={() => printInvoice(inv)} style={{ ...S.btn, ...S.btnGhost, padding: '5px 10px', fontSize: 11 }}>Print</button>
              {inv.status === 'draft' && <button onClick={() => mark(inv, 'sent')} disabled={busy} style={{ ...S.btn, ...S.btnGhost, padding: '5px 10px', fontSize: 11 }}>Mark sent</button>}
              {inv.status === 'sent' && <button onClick={() => mark(inv, 'paid')} disabled={busy} style={{ ...S.btn, ...S.btnPrimary, padding: '5px 10px', fontSize: 11 }}>Mark paid</button>}
              {inv.status !== 'void' && <button onClick={() => mark(inv, 'void')} disabled={busy} style={{ ...S.btn, ...S.btnGhost, padding: '5px 10px', fontSize: 11, color: 'var(--red)' }}>Void</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
