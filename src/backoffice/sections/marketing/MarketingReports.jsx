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

  const loadReport = async (id, d) => {
    setBusy(true);
    try { const { data } = await supabase.functions.invoke('marketing-report', { body: { action: 'overview', ops_location_id: id, days: d } }); setReport(data?.report || null); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    (async () => {
      try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) { setLoading(false); return; } await loadReport(id, days); } catch {} finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setRange = (d) => { setDays(d); if (locId) loadReport(locId, d); };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to see the marketing report.</div>;

  const m = report?.messages || {}; const r = report?.redemptions || {};
  const campaigns = report?.campaigns || []; const offers = report?.offers || [];

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
    </div>
  );
}
