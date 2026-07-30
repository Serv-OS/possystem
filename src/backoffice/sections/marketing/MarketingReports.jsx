// src/backoffice/sections/marketing/MarketingReports.jsx
//
// Marketing → Report (slice 7): reporting & attribution dashboard. One call to the marketing-report
// edge fn (marketing_report SQL aggregation) → KPIs, channel split, per-campaign and per-offer tables.
// Revenue is the gross total of orders where a code was redeemed (attributed to the campaign/offer).

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 920 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10, marginBottom: 16, maxWidth: 920 },
  kpi: { border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)', padding: 14 },
  kpiV: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', letterSpacing: '-.01em' },
  kpiL: { fontSize: 11.5, color: 'var(--t3)', marginTop: 2, fontWeight: 600 },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '6px 8px', borderBottom: '1px solid var(--bdr)' },
  td: { fontSize: 13, color: 'var(--t1)', padding: '8px', borderBottom: '1px solid var(--bdr2)' },
  tdr: { fontSize: 13, color: 'var(--t2)', padding: '8px', borderBottom: '1px solid var(--bdr2)', textAlign: 'right', fontFamily: 'var(--font-mono,monospace)' },
  seg: { display: 'inline-flex', border: '1px solid var(--bdr2)', borderRadius: 8, overflow: 'hidden' },
  segBtn: (on) => ({ padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none', background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t2)' }),
};
const money = (n) => `£${Number(n || 0).toFixed(2)}`;
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

export default function MarketingReports() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  // v5.5.946: the code ledger — every code, who it went to, used or still out there.
  const [codes, setCodes] = useState(null);          // { rows, total, tally }
  const [codeFilter, setCodeFilter] = useState({ status: '', campaign_id: '' });
  const [codesBusy, setCodesBusy] = useState(false);

  const loadReport = async (id, d) => {
    setBusy(true);
    try { const { data } = await supabase.functions.invoke('marketing-report', { body: { action: 'overview', ops_location_id: id, days: d } }); setReport(data?.report || null); }
    finally { setBusy(false); }
  };

  const loadCodes = async (id = locId, f = codeFilter, offset = 0, append = false) => {
    setCodesBusy(true);
    try {
      const { data } = await supabase.functions.invoke('marketing-admin', {
        body: { action: 'codes_report', ops_location_id: id, status: f.status || undefined, campaign_id: f.campaign_id || undefined, limit: 200, offset },
      });
      if (data?.error) throw new Error(data.error);
      setCodes((prev) => append && prev ? { ...data, rows: [...prev.rows, ...(data.rows || [])] } : data);
    } catch (e) { setCodes({ rows: [], total: 0, tally: {}, err: e.message }); }
    finally { setCodesBusy(false); }
  };

  const codesCsv = () => {
    const rows = codes?.rows || [];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = 'code,status,customer,email,phone,campaign,offer,issued,expires,redeemed,redeemed_value';
    const body = rows.map((c) => [c.code, c.status, c.customer_name, c.customer_email, c.customer_phone, c.campaign_name, c.offer_name,
      c.issued_at ? new Date(c.issued_at).toLocaleString('en-GB') : '', c.expires_at ? new Date(c.expires_at).toLocaleDateString('en-GB') : '',
      c.redeemed_at ? new Date(c.redeemed_at).toLocaleString('en-GB') : '', c.redeemed_value ?? ''].map(esc).join(','));
    const blob = new Blob([[head, ...body].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'promo-codes.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  useEffect(() => {
    (async () => {
      try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) { setLoading(false); return; } await loadReport(id, days); await loadCodes(id); } catch {} finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setRange = (d) => { setDays(d); if (locId) loadReport(locId, d); };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to see the marketing report.</div>;

  const m = report?.messages || {}; const r = report?.redemptions || {};
  const campaigns = report?.campaigns || []; const offers = report?.offers || [];
  const workflows = report?.workflows || [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 920 }}>
        <h1 style={S.h1}>Marketing report</h1>
        <div style={S.seg}>
          {[7, 30, 90].map((d) => <button key={d} style={S.segBtn(days === d)} onClick={() => setRange(d)}>{d}d</button>)}
        </div>
      </div>
      <div style={S.sub}>Sends, engagement and redemptions over the last {days} days. Revenue is the value of orders where a promo code was redeemed.{busy ? ' · refreshing…' : ''}</div>

      <div style={S.kpis}>
        <div style={S.kpi}><div style={S.kpiV}>{m.total || 0}</div><div style={S.kpiL}>Messages sent</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{pct(m.delivered, m.total)}</div><div style={S.kpiL}>Delivered</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{pct(m.opened, m.total)}</div><div style={S.kpiL}>Opened</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{pct(m.clicked, m.total)}</div><div style={S.kpiL}>Clicked</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{r.count || 0}</div><div style={S.kpiL}>Codes redeemed</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{money(r.discount)}</div><div style={S.kpiL}>Discount given</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{money(r.revenue)}</div><div style={S.kpiL}>Revenue attributed</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{m.email || 0}<span style={{ fontSize: 13, color: 'var(--t3)' }}> / {m.sms || 0}</span></div><div style={S.kpiL}>Email / SMS</div></div>
      </div>

      {/* v5.5.946: the by_status breakdown was computed by the SQL all along but never
          rendered — it is the direct answer to "why didn't someone receive it". */}
      {m.by_status && Object.keys(m.by_status).some((k) => !['sent', 'delivered', 'opened', 'clicked'].includes(k) && m.by_status[k] > 0) && (
        <div style={{ ...S.card, padding: '12px 18px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--t3)', fontWeight: 700 }}>Not delivered: </span>
          {Object.entries(m.by_status)
            .filter(([k, v]) => !['sent', 'delivered', 'opened', 'clicked'].includes(k) && v > 0)
            .map(([k, v]) => (
              <span key={k} style={{ fontSize: 12.5, color: 'var(--t2)', marginRight: 14 }}>
                <b style={{ color: 'var(--t1)' }}>{v}</b> {k === 'no_consent' ? 'no marketing consent' : k === 'unreachable' ? 'no email/phone on file' : k === 'suppressed' ? 'unsubscribed/bounced' : k === 'sandbox' ? 'sandbox (no provider live)' : k}
              </span>
            ))}
        </div>
      )}

      <div style={S.card}>
        <h2 style={S.h2}>By campaign</h2>
        {campaigns.length === 0 ? <div style={{ fontSize: 13, color: 'var(--t4)' }}>No campaign activity in this window.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Campaign</th><th style={{ ...S.th, textAlign: 'right' }}>Sent</th><th style={{ ...S.th, textAlign: 'right' }}>Open</th><th style={{ ...S.th, textAlign: 'right' }}>Click</th><th style={{ ...S.th, textAlign: 'right' }}>Redeemed</th><th style={{ ...S.th, textAlign: 'right' }}>Discount</th><th style={{ ...S.th, textAlign: 'right' }}>Revenue</th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.campaign_id}>
                  <td style={S.td}>{c.name}</td>
                  <td style={S.tdr}>{c.sent}</td><td style={S.tdr}>{pct(c.opened, c.sent)}</td><td style={S.tdr}>{pct(c.clicked, c.sent)}</td>
                  <td style={S.tdr}>{c.redeemed}</td><td style={S.tdr}>{money(c.discount)}</td><td style={S.tdr}>{money(c.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>By offer</h2>
        {offers.length === 0 ? <div style={{ fontSize: 13, color: 'var(--t4)' }}>No offers yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Offer</th><th style={{ ...S.th, textAlign: 'right' }}>Issued</th><th style={{ ...S.th, textAlign: 'right' }}>Redeemed</th><th style={{ ...S.th, textAlign: 'right' }}>Rate</th><th style={{ ...S.th, textAlign: 'right' }}>Discount</th></tr></thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.offer_id}>
                  <td style={S.td}>{o.name}</td>
                  <td style={S.tdr}>{o.issued}</td><td style={S.tdr}>{o.redeemed}</td><td style={S.tdr}>{pct(o.redeemed, o.issued)}</td><td style={S.tdr}>{money(o.discount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* v5.5.946: the code ledger — used / left / who each one went to. */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ ...S.h2, margin: 0 }}>Promo codes</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select style={{ fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)' }}
              value={codeFilter.status} onChange={(e) => { const f = { ...codeFilter, status: e.target.value }; setCodeFilter(f); loadCodes(locId, f); }}>
              <option value="">All statuses</option><option value="issued">Still to use</option><option value="redeemed">Used</option><option value="voided">Voided</option><option value="expired">Expired</option>
            </select>
            <select style={{ fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', maxWidth: 200 }}
              value={codeFilter.campaign_id} onChange={(e) => { const f = { ...codeFilter, campaign_id: e.target.value }; setCodeFilter(f); loadCodes(locId, f); }}>
              <option value="">All campaigns</option>
              {campaigns.map((c) => <option key={c.campaign_id} value={c.campaign_id}>{c.name}</option>)}
            </select>
            <button style={{ fontSize: 12.5, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontWeight: 700 }} onClick={codesCsv} disabled={!codes?.rows?.length}>⬇ CSV</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 14, margin: '10px 0 12px', fontSize: 12.5, color: 'var(--t3)', flexWrap: 'wrap' }}>
          <span><b style={{ color: 'var(--t1)' }}>{(codes?.tally?.issued || 0)}</b> still to use</span>
          <span><b style={{ color: 'var(--grn, #3fd97b)' }}>{(codes?.tally?.redeemed || 0)}</b> used</span>
          {codes?.tally?.expired ? <span><b style={{ color: 'var(--t2)' }}>{codes.tally.expired}</b> expired</span> : null}
          {codes?.tally?.voided ? <span><b style={{ color: 'var(--t2)' }}>{codes.tally.voided}</b> voided</span> : null}
          {codesBusy ? <span>refreshing…</span> : null}
        </div>
        {codes?.err && <div style={{ fontSize: 13, color: 'var(--red, #f66)' }}>{codes.err}</div>}
        {!codes?.err && (codes?.rows?.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={S.th}>Code</th><th style={S.th}>Sent to</th><th style={S.th}>Campaign</th><th style={S.th}>Offer</th>
                <th style={S.th}>Issued</th><th style={S.th}>Status</th><th style={{ ...S.th, textAlign: 'right' }}>Redeemed</th>
              </tr></thead>
              <tbody>
                {codes.rows.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...S.td, fontFamily: 'var(--font-mono,monospace)', fontWeight: 700 }}>{c.code}</td>
                    <td style={S.td}>{c.customer_name || (c.customer_email || c.customer_phone) || <span style={{ color: 'var(--t4)' }}>shared code</span>}
                      {c.customer_name && (c.customer_email || c.customer_phone) ? <div style={{ fontSize: 11, color: 'var(--t4)' }}>{c.customer_email || c.customer_phone}</div> : null}
                    </td>
                    <td style={S.td}>{c.campaign_name || '—'}</td>
                    <td style={S.td}>{c.offer_name || '—'}</td>
                    <td style={S.td}>{c.issued_at ? new Date(c.issued_at).toLocaleDateString('en-GB') : '—'}</td>
                    <td style={{ ...S.td, color: c.status === 'redeemed' ? 'var(--grn, #3fd97b)' : c.status === 'issued' ? 'var(--t1)' : 'var(--t4)', fontWeight: 700 }}>{c.status === 'issued' ? 'to use' : c.status}</td>
                    <td style={S.tdr}>{c.redeemed_at ? `${new Date(c.redeemed_at).toLocaleDateString('en-GB')} · ${money(c.redeemed_value)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {codes.total > codes.rows.length && (
              <div style={{ textAlign: 'center', padding: '10px 0' }}>
                <button style={{ fontSize: 12.5, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t2)', cursor: 'pointer', fontWeight: 700 }}
                  onClick={() => loadCodes(locId, codeFilter, codes.rows.length, true)} disabled={codesBusy}>Show more ({codes.total - codes.rows.length} more)</button>
              </div>
            )}
          </div>
        ) : <div style={{ fontSize: 13, color: 'var(--t4)' }}>No codes yet — attach an offer to a campaign and every recipient gets their own single-use code, listed here.</div>)}
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>By workflow</h2>
        {workflows.length === 0 ? <div style={{ fontSize: 13, color: 'var(--t4)' }}>No drip workflows yet.</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={S.th}>Workflow</th><th style={{ ...S.th, textAlign: 'right' }}>Enrolled</th><th style={{ ...S.th, textAlign: 'right' }}>Completed</th><th style={{ ...S.th, textAlign: 'right' }}>Sent</th><th style={{ ...S.th, textAlign: 'right' }}>Open</th><th style={{ ...S.th, textAlign: 'right' }}>Click</th><th style={{ ...S.th, textAlign: 'right' }}>Redeemed</th><th style={{ ...S.th, textAlign: 'right' }}>Revenue</th></tr></thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.workflow_id}>
                  <td style={S.td}>{w.name} {w.status !== 'active' && <span style={{ fontSize: 11, color: 'var(--t4)' }}>· {w.status}</span>}</td>
                  <td style={S.tdr}>{w.enrolled}</td><td style={S.tdr}>{w.completed}<span style={{ color: 'var(--t4)' }}> ({pct(w.completed, w.enrolled)})</span></td>
                  <td style={S.tdr}>{w.sent}</td><td style={S.tdr}>{pct(w.opened, w.sent)}</td><td style={S.tdr}>{pct(w.clicked, w.sent)}</td>
                  <td style={S.tdr}>{w.redeemed}</td><td style={S.tdr}>{money(w.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 8 }}>Enrolled/Completed are over the window; “Completed (%)” is the conversion to the end of the drip. Sent/Open/Click are this window’s step sends (open/click need the email provider’s tracking webhook). Revenue is orders where a code from this workflow was redeemed.</div>
      </div>
    </div>
  );
}
