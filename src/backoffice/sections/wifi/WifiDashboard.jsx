// src/backoffice/sections/wifi/WifiDashboard.jsx
//
// Dashboard — WiFi capture performance + the CRM segments this feeds. Capture stats come
// from wifi_captures; segments are computed over the venue's customers (locals, birthdays,
// new/returning/lapsed, opted-in). Each segment exports to CSV — the seed for campaigns.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  h2: { fontSize: 14, fontWeight: 800, color: 'var(--t2)', margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '.04em' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px,1fr))', gap: 12, marginBottom: 24 },
  stat: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 16 },
  big: { fontSize: 28, fontWeight: 800, color: 'var(--t1)', letterSpacing: '-.02em' },
  lbl: { fontSize: 12, color: 'var(--t3)', marginTop: 2 },
  seg: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  segTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
  exp: { padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)', alignSelf: 'flex-start' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
};

const SEGMENTS = [
  ['locals', 'Locals', 'Said they live nearby'],
  ['birthdays', 'Birthdays this week', 'Birthday in the next 7 days'],
  ['new', 'New', 'First visit'],
  ['returning', 'Returning', 'Been more than once'],
  ['lapsed', 'Lapsed', 'Not seen in 60+ days'],
  ['opted_in', 'Marketing opt-ins', 'Can be emailed / texted'],
];

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

export default function WifiDashboard() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [seg, setSeg] = useState(null);
  const [exporting, setExporting] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync(); setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        const [{ data: st }, { data: sg }] = await Promise.all([
          supabase.functions.invoke('wifi-admin', { body: { action: 'stats', ops_location_id: id } }),
          supabase.functions.invoke('wifi-admin', { body: { action: 'segments', ops_location_id: id } }),
        ]);
        setStats(st || {}); setSeg(sg || {});
      } catch {} finally { setLoading(false); }
    })();
  }, []);

  const exportSeg = async (segKey) => {
    setExporting(segKey);
    try {
      const { data } = await supabase.functions.invoke('wifi-admin', { body: { action: 'export', ops_location_id: locId, segment: segKey } });
      const csv = toCsv(data?.rows || []);
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `wifi-${segKey}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(a.href);
    } catch {} finally { setExporting(''); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to see its WiFi dashboard.</div>;

  const optRate = stats?.total ? Math.round((stats.opted_in / stats.total) * 100) : 0;
  return (
    <div>
      <h1 style={S.h1}>WiFi dashboard</h1>
      <div style={S.sub}>Sign-ups and the marketing segments they build. Export any segment to use in a campaign.</div>

      <h2 style={S.h2}>Captures</h2>
      <div style={S.cards}>
        <div style={S.stat}><div style={S.big}>{stats?.total ?? 0}</div><div style={S.lbl}>Total sign-ups</div></div>
        <div style={S.stat}><div style={S.big}>{optRate}%</div><div style={S.lbl}>Opted into marketing</div></div>
        <div style={S.stat}><div style={S.big}>{stats?.returns ?? 0}</div><div style={S.lbl}>Returning devices</div></div>
        <div style={S.stat}><div style={S.big}>{stats?.last_7d ?? 0}</div><div style={S.lbl}>Last 7 days</div></div>
      </div>

      <h2 style={S.h2}>Segments</h2>
      <div style={{ ...S.cards, gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))' }}>
        {SEGMENTS.map(([key, label, desc]) => (
          <div key={key} style={S.seg}>
            <div style={S.segTop}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{label}</span>
              <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--acc)' }}>{seg?.[key] ?? 0}</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--t4)', lineHeight: 1.4 }}>{desc}</div>
            <button style={S.exp} onClick={() => exportSeg(key)} disabled={exporting === key || !(seg?.[key])}>{exporting === key ? 'Exporting…' : 'Export CSV'}</button>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 14, maxWidth: 640, lineHeight: 1.5 }}>
        Segments are computed across everyone seen at this venue. When the campaign engine lands, these become live audiences you can email or text in a click — only contacts who opted in are marketable.
      </div>
    </div>
  );
}
