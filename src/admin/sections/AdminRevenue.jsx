// src/admin/sections/AdminRevenue.jsx
// Admin-only "Revenue" section (v5.7.3) — what the PLATFORM makes, per month
// and per location: processed card volume + count by pricing tier
// (card-present / card-not-present / Amex & business / keyed), the commission
// we earn on it (adyen_payments.commission_minor, stamped by adyen-webhook),
// SaaS fees from the ops subscriptions table, and — where settlement reports
// have landed per-payment fees — the margin after what Adyen charges us.
//
// HONESTY RULES, deliberately visible in the UI:
//   · SaaS: the subscriptions table stores plan + monthly_fee. If every fee is
//     zero the section says SaaS pricing is not configured and shows plan
//     names + counts instead of inventing numbers.
//   · Costs: what Adyen charges US arrives per payment only via settlement
//     report ingestion (fee_minor). Margin is shown only where that data
//     exists; otherwise commission is shown with a note.
//   · Unclassified payments (written before migration 20260821b or before the
//     backfill ran) are counted and flagged, not hidden.
//
// Data comes from the payments-admin `revenue` action (service role, same
// super_admin fence as the rest of the admin portal).

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function callPaymentsAdmin(action, payload) {
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

const TIERS = [
  { id: 'card_present', label: 'Card-present' },
  { id: 'card_not_present', label: 'Card-not-present' },
  { id: 'amex', label: 'Amex & business' },
  { id: 'keyed', label: 'Keyed' },
];

const S = {
  page:  { padding: 0 },
  h1:    { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:   { fontSize: 13, color: 'var(--t3)', marginBottom: 20, maxWidth: 760, lineHeight: 1.5 },
  card:  { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 5, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input: { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn:   { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnGhost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  errorBox: { padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  note:  { padding: 10, background: 'var(--bg3)', color: 'var(--t2)', borderRadius: 8, fontSize: 12, border: '1px solid var(--bdr2)', marginBottom: 10, lineHeight: 1.5 },
  th:    { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' },
  td:    { fontSize: 13, padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap', borderTop: '1px solid var(--bdr)' },
};

const monthNow = () => new Date().toISOString().slice(0, 7);

function money(minor, cur = 'GBP') {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || 'GBP' }).format((Number(minor) || 0) / 100);
}

function Tile({ label, value, hint, accent }) {
  return (
    <div style={{ flex: '1 1 150px', minWidth: 150, border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg2)' }} title={hint || undefined}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: accent ? 'var(--acc)' : 'var(--t1)' }}>{value}</div>
    </div>
  );
}

export default function AdminRevenue() {
  const [month, setMonth] = useState(monthNow());
  const [data, setData] = useState(null);      // null = loading, {error} or revenue payload
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (m) => {
    setLoading(true);
    try {
      const r = await callPaymentsAdmin('revenue', { month: m });
      setData(r);
    } catch (e) {
      setData({ error: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(month); }, [load, month]);

  const cur = data?.currency || 'GBP';
  const totals = data?.totals || {};
  const rows = data?.rows || [];
  const saas = data?.saas || {};

  const exportCsv = () => {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const p2 = (minor) => ((Number(minor) || 0) / 100).toFixed(2);
    const header = [
      'Location', 'Currency', 'Payments', 'Volume', 'Refunds',
      ...TIERS.flatMap(t => [`${t.label} count`, `${t.label} volume`, `${t.label} commission`]),
      'Unclassified count', 'Unclassified volume',
      'Commission total', 'Processor fees (where known)', 'Margin (where known)',
      'SaaS plan', 'SaaS fee', 'Platform revenue',
    ];
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      const bc = r.by_category || {};
      lines.push([
        r.name, r.currency || cur, r.payments_count, p2(r.volume_minor), p2(r.refunds_minor),
        ...TIERS.flatMap(t => {
          const c = bc[t.id] || {};
          return [c.count ?? 0, p2(c.volume_minor), p2(c.commission_minor)];
        }),
        bc.unclassified?.count ?? 0, p2(bc.unclassified?.volume_minor),
        p2(r.commission_minor),
        r.fees_minor == null ? '' : p2(r.fees_minor),
        r.margin_minor == null ? '' : p2(r.margin_minor),
        r.saas_plan ?? '', r.saas_fee_minor == null ? '' : p2(r.saas_fee_minor),
        p2(r.revenue_minor),
      ].map(esc).join(','));
    }
    for (const u of saas.unmapped || []) {
      lines.push([`${u.name} (SaaS only)`, cur, 0, '', '', ...TIERS.flatMap(() => ['', '', '']), '', '', '', '', '', u.plan ?? '', (Number(u.monthly_fee) || 0).toFixed(2), (Number(u.monthly_fee) || 0).toFixed(2)].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `servos-revenue-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Revenue — what the platform makes</h1>
      <div style={S.sub}>
        Per month and per venue: processed card volume by payment type, the commission ServOS earns on it, SaaS fees, and the margin after processor costs where settlement data exists.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <label style={{ ...S.label, marginBottom: 0 }}>Month</label>
        <input type="month" value={month} max={monthNow()} onChange={e => e.target.value && setMonth(e.target.value)} style={S.input} />
        <button onClick={() => load(month)} disabled={loading} style={{ ...S.btn, ...S.btnGhost }}>{loading ? 'Loading…' : '↻ Refresh'}</button>
        {rows.length > 0 && <button onClick={exportCsv} style={{ ...S.btn, ...S.btnGhost, marginLeft: 'auto' }}>⬇ Export CSV</button>}
      </div>

      {data?.error && <div style={S.errorBox}>{data.error}</div>}

      {data && !data.error && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <Tile label="Processed volume" value={money(totals.volume_minor, cur)} hint={`${totals.payments_count ?? 0} successful payments`} />
            <Tile label="Commission earned" value={money(totals.commission_minor, cur)} accent />
            <Tile label="SaaS fees" value={money(totals.saas_fee_minor, cur)} />
            <Tile label="Platform revenue" value={money(totals.revenue_minor, cur)} accent hint="Commission + SaaS (where amounts exist)" />
            <Tile
              label={totals.fees_minor != null ? 'Processor fees (known)' : 'Processor fees'}
              value={totals.fees_minor != null ? money(totals.fees_minor, cur) : '—'}
              hint="What Adyen charges us, from settlement reports — known only for payments a report has touched."
            />
          </div>

          {data.classified === false && (
            <div style={S.note}>
              Payment-type columns are not live yet: migration 20260821b_adyen_rate_card.sql has not been applied, so nothing here is classified or commission-stamped. Apply the migration, deploy adyen-webhook, then run the payment backfill.
            </div>
          )}
          {data.classified !== false && (totals.unclassified_count ?? 0) > 0 && (
            <div style={S.note}>
              {totals.unclassified_count} payment{totals.unclassified_count === 1 ? ' is' : 's are'} not classified into a payment type yet (recorded before the tiered model). Run the adyen-webhook backfill to classify and commission-stamp them.
            </div>
          )}
          {saas.amounts_configured === false && (
            <div style={S.note}>
              SaaS pricing amounts are not configured — every subscription has a £0 monthly fee, so SaaS revenue reads zero.
              Plans on file: {Object.entries(saas.plans || {}).map(([p, n]) => `${p} × ${n}`).join(', ') || 'none'}. Set monthly_fee on subscriptions to include SaaS money here.
            </div>
          )}
          {totals.fees_minor == null && (
            <div style={S.note}>
              Margin needs what Adyen charges us per payment, which arrives with settlement report ingestion. No payment in this month carries fee data yet, so the table shows commission without a margin column value.
            </div>
          )}
          {data.capped && (
            <div style={S.note}>This month hit the 20,000-payment read cap — totals cover the first 20,000 payments of the month.</div>
          )}

          <div style={{ ...S.card, padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg2)' }}>
                  <th style={{ ...S.th, textAlign: 'left' }}>Venue</th>
                  <th style={S.th}>Payments</th>
                  <th style={S.th}>Volume</th>
                  {TIERS.map(t => <th key={t.id} style={S.th}>{t.label}</th>)}
                  <th style={S.th}>Commission</th>
                  <th style={S.th}>Margin</th>
                  <th style={S.th}>SaaS</th>
                  <th style={S.th}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8 + TIERS.length} style={{ ...S.td, textAlign: 'center', color: 'var(--t3)', padding: 28 }}>No payments or SaaS fees recorded for {month}.</td></tr>
                )}
                {rows.map((r) => {
                  const bc = r.by_category || {};
                  const rcur = r.currency || cur;
                  return (
                    <tr key={r.location_id ?? 'unmatched'}>
                      <td style={{ ...S.td, textAlign: 'left', fontWeight: 600, color: 'var(--t1)' }}>
                        {r.name}
                        {(bc.unclassified?.count ?? 0) > 0 && (
                          <span style={{ fontSize: 10.5, color: 'var(--t4)', marginLeft: 6 }} title="Payments not yet classified into a type — run the backfill.">
                            +{bc.unclassified.count} unclassified
                          </span>
                        )}
                      </td>
                      <td style={S.td}>{r.payments_count}</td>
                      <td style={S.td}>{money(r.volume_minor, rcur)}</td>
                      {TIERS.map(t => {
                        const c = bc[t.id] || {};
                        return (
                          <td key={t.id} style={{ ...S.td, color: c.count ? 'var(--t2)' : 'var(--t4)' }}
                            title={c.count ? `${c.count} payment${c.count === 1 ? '' : 's'} · ${money(c.volume_minor, rcur)} volume · ${money(c.commission_minor, rcur)} commission` : 'No payments of this type'}>
                            {c.count ? `${money(c.volume_minor, rcur)} (${c.count})` : '—'}
                          </td>
                        );
                      })}
                      <td style={{ ...S.td, fontWeight: 700, color: 'var(--acc)' }}>{money(r.commission_minor, rcur)}</td>
                      <td style={{ ...S.td, color: r.margin_minor == null ? 'var(--t4)' : (r.margin_minor < 0 ? 'var(--red)' : 'var(--grn)') }}
                        title={r.margin_minor == null ? 'No settlement fee data for this venue this month.' : `Commission ${money(r.commission_minor, rcur)} minus processor fees ${money(r.fees_minor, rcur)} (known for ${r.fee_known} payments)`}>
                        {r.margin_minor == null ? '—' : money(r.margin_minor, rcur)}
                      </td>
                      <td style={{ ...S.td, color: r.saas_fee_minor ? 'var(--t2)' : 'var(--t4)' }}
                        title={r.saas_plan ? `Plan: ${r.saas_plan}` : 'No subscription mapped to this venue'}>
                        {r.saas_fee_minor == null ? '—' : money(r.saas_fee_minor, rcur)}
                      </td>
                      <td style={{ ...S.td, fontWeight: 700, color: 'var(--t1)' }}>{money(r.revenue_minor, rcur)}</td>
                    </tr>
                  );
                })}
                {(saas.unmapped || []).map((u) => (
                  <tr key={`saas-${u.ops_location_id}`}>
                    <td style={{ ...S.td, textAlign: 'left', color: 'var(--t3)' }}>{u.name} <span style={{ fontSize: 10.5, color: 'var(--t4)' }}>SaaS only — no platform mirror</span></td>
                    <td style={S.td}>—</td>
                    <td style={S.td}>—</td>
                    {TIERS.map(t => <td key={t.id} style={{ ...S.td, color: 'var(--t4)' }}>—</td>)}
                    <td style={S.td}>—</td>
                    <td style={S.td}>—</td>
                    <td style={{ ...S.td, color: 'var(--t2)' }}>{money(Math.round((Number(u.monthly_fee) || 0) * 100), cur)}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{money(Math.round((Number(u.monthly_fee) || 0) * 100), cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11, color: 'var(--t4)', lineHeight: 1.6 }}>
            Commission is stamped per payment at its rate-card tier when the payment is taken; refund unwinds are not netted off yet.
            Processor costs are per-payment only once settlement reports are ingested (fee_minor) — until then margin stays an honest dash.
          </div>
        </>
      )}
    </div>
  );
}
