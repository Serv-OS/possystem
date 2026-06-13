// src/backoffice/sections/reports/DailyTrading.jsx
//
// Daily Trading — the holistic P&L. Per day: forecast (operator-set, with a
// "same weekday last year" suggestion), actual sales, theoretical vs actual
// labour + labour %, COGS (a configurable %), fixed overhead → gross profit and
// operating profit, forecast vs actual, with period totals. All computed
// server-side by the trading-report edge fn. Self-fetching (like RyftPayouts).

import { useEffect, useMemo, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const toYmd = (v) => { try { return new Intl.DateTimeFormat('en-CA').format(new Date(v)); } catch { return null; } };
const dow = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });

const S = {
  wrap:  { padding: 0 },
  bar:   { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16, padding: 14, border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)' },
  fld:   { display: 'flex', flexDirection: 'column', gap: 4 },
  lab:   { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em' },
  inp:   { width: 110, border: '1px solid var(--bdr2)', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  btn:   { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  kpis:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 10, marginBottom: 16 },
  kpi:   { border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)', padding: '12px 14px' },
  kLab:  { fontSize: 11, color: 'var(--t3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' },
  kVal:  { fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginTop: 4 },
  scroll:{ overflowX: 'auto', border: '1px solid var(--bdr)', borderRadius: 12 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 920 },
  th:    { textAlign: 'right', padding: '9px 10px', color: 'var(--t3)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap', background: 'var(--bg2)', position: 'sticky', top: 0 },
  thL:   { textAlign: 'left' },
  td:    { textAlign: 'right', padding: '8px 10px', color: 'var(--t1)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' },
  tdL:   { textAlign: 'left' },
  fInp:  { width: 84, border: '1px solid var(--bdr2)', borderRadius: 6, padding: '4px 6px', fontSize: 12.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', textAlign: 'right', outline: 'none' },
  ly:    { fontSize: 10, color: 'var(--acc)', cursor: 'pointer', marginLeft: 6, fontWeight: 700 },
  pos:   { color: 'var(--grn)' }, neg: { color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '50px 20px', color: 'var(--t3)', fontSize: 14 },
  note:  { fontSize: 11.5, color: 'var(--t4)', marginTop: 10, lineHeight: 1.5 },
};

export default function DailyTrading({ rangeFrom, rangeTo, fmt }) {
  const money = fmt || ((n) => `£${(Number(n) || 0).toFixed(2)}`);
  const [locId, setLocId] = useState(null);
  const [data, setData] = useState(null);   // { rows, totals, settings }
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [cogs, setCogs] = useState('');
  const [ovh, setOvh] = useState('');

  const from = useMemo(() => toYmd(rangeFrom), [rangeFrom]);
  const to = useMemo(() => toYmd(rangeTo), [rangeTo]);

  const call = async (action, extra = {}) => {
    const { data: d, error } = await supabase.functions.invoke('trading-report', { body: { action, ops_location_id: locId, ...extra } });
    if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
    if (d?.error) throw new Error(d.error);
    return d;
  };

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const id = locId || await getActiveLocationSync();
      setLocId(id);
      if (!supabase || !id || !from || !to) { setLoading(false); return; }
      const { data: d, error } = await supabase.functions.invoke('trading-report', { body: { action: 'get', ops_location_id: id, from, to } });
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch {} throw new Error(b?.error || error.message); }
      if (d?.error) throw new Error(d.error);
      setData(d); setCogs(String(d.settings?.cogs_pct ?? '')); setOvh(String(d.settings?.daily_overhead ?? ''));
    } catch (e) { setErr(e.message || 'Could not load'); }
    finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [from, to]);

  const saveSettings = async () => {
    try { await call('save_settings', { cogs_pct: Number(cogs) || 0, daily_overhead: Number(ovh) || 0 }); await load(); }
    catch (e) { setErr(e.message); }
  };
  const setForecast = async (date, amount) => {
    try { await call('set_forecast', { date, amount: Number(amount) || 0 }); await load(); }
    catch (e) { setErr(e.message); }
  };

  if (loading) return <div style={S.empty}>Loading trading figures…</div>;
  if (!locId) return <div style={S.empty}>Pick a location to see its trading report.</div>;
  if (err) return <div style={{ ...S.empty, color: 'var(--red)' }}>{err}</div>;
  if (!data) return <div style={S.empty}>No data.</div>;

  const { rows, totals } = data;
  const sign = (n) => (n > 0 ? S.pos : n < 0 ? S.neg : null);

  return (
    <div style={S.wrap}>
      {/* cost settings */}
      <div style={S.bar}>
        <div style={S.fld}><span style={S.lab}>COGS %</span>
          <input style={S.inp} value={cogs} onChange={e => setCogs(e.target.value)} inputMode="decimal" placeholder="e.g. 28" /></div>
        <div style={S.fld}><span style={S.lab}>Daily overhead (£)</span>
          <input style={S.inp} value={ovh} onChange={e => setOvh(e.target.value)} inputMode="decimal" placeholder="rent+utilities/day" /></div>
        <button style={S.btn} onClick={saveSettings}>Save costs</button>
        <div style={{ ...S.note, marginTop: 0, flexBasis: '100%' }}>Sales &amp; labour are live from the system. COGS and overhead are your estimates — set them here and the P&amp;L applies them to forecast and actuals.</div>
      </div>

      {/* period totals */}
      <div style={S.kpis}>
        <div style={S.kpi}><div style={S.kLab}>Forecast sales</div><div style={S.kVal}>{money(totals.forecast)}</div></div>
        <div style={S.kpi}><div style={S.kLab}>Actual sales</div><div style={S.kVal}>{money(totals.actual_sales)}</div>
          <div style={{ fontSize: 12, fontWeight: 700, ...sign(totals.actual_sales - totals.forecast) }}>{totals.actual_sales - totals.forecast >= 0 ? '+' : ''}{money(totals.actual_sales - totals.forecast)} vs forecast</div></div>
        <div style={S.kpi}><div style={S.kLab}>Labour (actual)</div><div style={S.kVal}>{money(totals.labour_actual)}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 700 }}>{totals.labour_pct_actual != null ? `${totals.labour_pct_actual}% of sales` : '—'}</div></div>
        <div style={S.kpi}><div style={S.kLab}>COGS (actual)</div><div style={S.kVal}>{money(totals.cogs_actual)}</div></div>
        <div style={S.kpi}><div style={S.kLab}>Operating profit</div><div style={{ ...S.kVal, ...sign(totals.op_actual) }}>{money(totals.op_actual)}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 700 }}>forecast {money(totals.op_theo)}</div></div>
      </div>

      {/* daily P&L */}
      <div style={S.scroll}>
        <table style={S.table}>
          <thead><tr>
            <th style={{ ...S.th, ...S.thL }}>Day</th>
            <th style={S.th}>Forecast</th><th style={S.th}>Actual</th><th style={S.th}>Δ sales</th>
            <th style={S.th}>Labour (act)</th><th style={S.th}>Labour %</th>
            <th style={S.th}>COGS</th><th style={S.th}>Gross profit</th><th style={S.th}>Op. profit</th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.date}>
                <td style={{ ...S.td, ...S.tdL }}>{dow(r.date)} {r.date.slice(5)}</td>
                <td style={S.td}>
                  <input style={S.fInp} defaultValue={r.forecast || ''} placeholder="0"
                    onKeyDown={e => { if (e.key === 'Enter') setForecast(r.date, e.target.value); }}
                    onBlur={e => { if (Number(e.target.value || 0) !== r.forecast) setForecast(r.date, e.target.value); }} />
                  {r.last_year > 0 && <span style={S.ly} title="Use same weekday last year" onClick={() => setForecast(r.date, r.last_year)}>LY {money(r.last_year)}</span>}
                </td>
                <td style={S.td}>{money(r.actual_sales)}</td>
                <td style={{ ...S.td, ...sign(r.sales_variance) }}>{r.sales_variance >= 0 ? '+' : ''}{money(r.sales_variance)}</td>
                <td style={S.td}>{money(r.labour_actual)}<span style={{ color: 'var(--t4)' }}> / {money(r.labour_theo)}</span></td>
                <td style={{ ...S.td, ...(r.labour_pct_actual > 35 ? S.neg : null) }}>{r.labour_pct_actual != null ? `${r.labour_pct_actual}%` : '—'}</td>
                <td style={S.td}>{money(r.cogs_actual)}</td>
                <td style={S.td}>{money(r.gp_actual)}</td>
                <td style={{ ...S.td, ...sign(r.op_actual) }}>{money(r.op_actual)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr style={{ fontWeight: 800 }}>
            <td style={{ ...S.td, ...S.tdL }}>Total</td>
            <td style={S.td}>{money(totals.forecast)}</td><td style={S.td}>{money(totals.actual_sales)}</td>
            <td style={{ ...S.td, ...sign(totals.actual_sales - totals.forecast) }}>{money(totals.actual_sales - totals.forecast)}</td>
            <td style={S.td}>{money(totals.labour_actual)}</td>
            <td style={S.td}>{totals.labour_pct_actual != null ? `${totals.labour_pct_actual}%` : '—'}</td>
            <td style={S.td}>{money(totals.cogs_actual)}</td><td style={S.td}>{money(totals.actual_sales - totals.cogs_actual)}</td>
            <td style={{ ...S.td, ...sign(totals.op_actual) }}>{money(totals.op_actual)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div style={S.note}>Net sales are ex-VAT (the goods value). Type a forecast and press Enter, or tap “LY” to use the same weekday last year. Labour shows actual / theoretical (rota). “Op. profit” = sales − COGS − labour − overhead.</div>
    </div>
  );
}
