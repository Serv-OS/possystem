// src/backoffice/sections/reports/PayrollReport.jsx
//
// Payroll — closed pay runs surfaced in Reports (owners read here without going
// into Workforce). Each run in wf_payroll_runs is the immutable record written
// by workforce-compute `payroll.close`: per-staff base pay + tips (direct +
// pooled tronc) → total, with the period's timesheets marked paid. Self-fetching
// (reads loadPayrollRuns + loadStaff for names). Payroll is period-based, so this
// shows the full recent history rather than the report's date filter.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { getActiveLocationSync } from '../../../lib/supabase';
import * as wf from '../../../staff/wfData';

const fmtDay = (iso) => { try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } };
const fmtShort = (iso) => { try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); } catch { return iso; } };

const S = {
  kpis:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 10, marginBottom: 16 },
  kpi:   { border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)', padding: '12px 14px' },
  kLab:  { fontSize: 11, color: 'var(--t3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' },
  kVal:  { fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginTop: 4 },
  kSub:  { fontSize: 12, color: 'var(--t3)', fontWeight: 700, marginTop: 2 },
  scroll:{ overflowX: 'auto', border: '1px solid var(--bdr)', borderRadius: 12 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 720 },
  th:    { textAlign: 'right', padding: '9px 12px', color: 'var(--t3)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap', background: 'var(--bg2)' },
  thL:   { textAlign: 'left' },
  td:    { textAlign: 'right', padding: '9px 12px', color: 'var(--t1)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' },
  tdL:   { textAlign: 'left' },
  runRow:{ cursor: 'pointer' },
  subTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12, background: 'var(--bg2)' },
  subTh: { textAlign: 'right', padding: '6px 12px', color: 'var(--t4)', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.03em' },
  subTd: { textAlign: 'right', padding: '6px 12px', color: 'var(--t2)', borderTop: '1px solid var(--bdr)' },
  link:  { fontSize: 11.5, color: 'var(--acc)', cursor: 'pointer', fontWeight: 700, background: 'none', border: 'none', fontFamily: 'inherit', padding: 0 },
  empty: { textAlign: 'center', padding: '50px 20px', color: 'var(--t3)', fontSize: 14 },
  note:  { fontSize: 11.5, color: 'var(--t4)', marginTop: 10, lineHeight: 1.5 },
};

const tipsOf = (t = {}) => (t.tips != null ? Number(t.tips) : (Number(t.tips_direct || 0) + Number(t.tips_tronc || 0)));

export default function PayrollReport({ fmt }) {
  const money = fmt || ((n) => `£${(Number(n) || 0).toFixed(2)}`);
  const [runs, setRuns] = useState([]);
  const [names, setNames] = useState({});   // staff_id -> name
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState({});      // run id -> expanded

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr('');
      try {
        const id = await getActiveLocationSync();
        if (!id) { if (alive) { setLoading(false); } return; }
        const [r, staff] = await Promise.all([wf.loadPayrollRuns(id), wf.loadStaff(id).catch(() => [])]);
        if (!alive) return;
        const nm = {}; (staff || []).forEach(s => { nm[s.id] = s.name; });
        setNames(nm); setRuns(r || []);
      } catch (e) { if (alive) setErr(e.message || 'Could not load payroll'); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const totals = useMemo(() => runs.reduce((a, h) => ({
    pay: a.pay + Number(h.totals?.pay || 0),
    tips: a.tips + tipsOf(h.totals),
    total: a.total + Number(h.totals?.total || 0),
  }), { pay: 0, tips: 0, total: 0 }), [runs]);

  const nameOf = (id) => names[id] || id;

  const exportCsv = (h) => {
    const esc = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const rows = [
      ['Staff', 'Hours', 'Base pay', 'Tips (direct)', 'Tips (pooled)', 'Total'],
      ...(h.lines || []).map(l => [nameOf(l.staff_id), Number(l.hours || 0).toFixed(2), Number(l.pay || 0).toFixed(2), Number(l.tips_direct || 0).toFixed(2), Number(l.tips_tronc || 0).toFixed(2), Number(l.total || 0).toFixed(2)]),
      ['TOTAL', '', Number(h.totals?.pay || 0).toFixed(2), Number(h.totals?.tips_direct || 0).toFixed(2), Number(h.totals?.tips_tronc || 0).toFixed(2), Number(h.totals?.total || 0).toFixed(2)],
    ];
    const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payroll-${h.periodStart}-to-${h.periodEnd}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) return <div style={S.empty}>Loading payroll…</div>;
  if (err) return <div style={{ ...S.empty, color: 'var(--red)' }}>{err}</div>;
  if (!runs.length) return (
    <div style={S.empty}>
      <div style={{ fontSize: 34, marginBottom: 8 }}>💷</div>
      No closed pay runs yet.
      <div style={{ ...S.note, marginTop: 8 }}>Close a pay period under Workforce → Payroll and it’ll appear here.</div>
    </div>
  );

  return (
    <div>
      <div style={S.kpis}>
        <div style={S.kpi}><div style={S.kLab}>Pay runs</div><div style={S.kVal}>{runs.length}</div>
          <div style={S.kSub}>last {fmtShort(runs[runs.length - 1].periodStart)} → {fmtShort(runs[0].periodEnd)}</div></div>
        <div style={S.kpi}><div style={S.kLab}>Wages paid</div><div style={S.kVal}>{money(totals.pay)}</div></div>
        <div style={S.kpi}><div style={S.kLab}>Tips paid</div><div style={S.kVal}>{money(totals.tips)}</div></div>
        <div style={S.kpi}><div style={S.kLab}>Total paid out</div><div style={S.kVal}>{money(totals.total)}</div></div>
      </div>

      <div style={S.scroll}>
        <table style={S.table}>
          <thead><tr>
            <th style={{ ...S.th, ...S.thL }}>Period</th>
            <th style={S.th}>Pay day</th><th style={S.th}>Staff</th>
            <th style={S.th}>Wages</th><th style={S.th}>Tips</th><th style={S.th}>Total</th>
            <th style={S.th}>Closed</th><th style={S.th} />
          </tr></thead>
          <tbody>
            {runs.map(h => {
              const isOpen = !!open[h.id];
              return (
                <Fragment key={h.id}>
                  <tr style={S.runRow} onClick={() => setOpen(o => ({ ...o, [h.id]: !o[h.id] }))}>
                    <td style={{ ...S.td, ...S.tdL, fontWeight: 700 }}>{isOpen ? '▾' : '▸'} {fmtShort(h.periodStart)} – {fmtShort(h.periodEnd)}</td>
                    <td style={{ ...S.td, color: 'var(--t3)' }}>{h.payDate ? fmtShort(h.payDate) : '—'}</td>
                    <td style={S.td}>{(h.lines || []).length}</td>
                    <td style={S.td}>{money(h.totals?.pay || 0)}</td>
                    <td style={S.td}>{tipsOf(h.totals) ? money(tipsOf(h.totals)) : <span style={{ color: 'var(--t4)' }}>—</span>}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{money(h.totals?.total || 0)}</td>
                    <td style={{ ...S.td, color: 'var(--t3)' }}>{h.createdAt ? fmtDay(String(h.createdAt).slice(0, 10)) : '—'}</td>
                    <td style={S.td}><button style={S.link} onClick={(e) => { e.stopPropagation(); exportCsv(h); }}>CSV</button></td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} style={{ padding: 0, borderBottom: '1px solid var(--bdr)' }}>
                        <table style={S.subTable}>
                          <thead><tr>
                            <th style={{ ...S.subTh, textAlign: 'left' }}>Staff</th>
                            <th style={S.subTh}>Hours</th><th style={S.subTh}>Base pay</th>
                            <th style={S.subTh}>Tips (direct)</th><th style={S.subTh}>Tips (pooled)</th><th style={S.subTh}>Total</th>
                          </tr></thead>
                          <tbody>
                            {(h.lines || []).map((l, i) => (
                              <tr key={l.staff_id || i}>
                                <td style={{ ...S.subTd, textAlign: 'left' }}>{nameOf(l.staff_id)}</td>
                                <td style={S.subTd}>{Number(l.hours || 0).toFixed(2)}</td>
                                <td style={S.subTd}>{money(l.pay || 0)}</td>
                                <td style={S.subTd}>{l.tips_direct ? money(l.tips_direct) : '—'}</td>
                                <td style={S.subTd}>{l.tips_tronc ? money(l.tips_tronc) : '—'}</td>
                                <td style={{ ...S.subTd, fontWeight: 700 }}>{money(l.total || 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={S.note}>Closed pay runs are immutable records — each marked its period’s approved timesheets as paid. Tips are shown separately from wages (UK Tipping Act): pooled tips are tronc-allocated, direct tips go to the seller. Click a run to see the per-person breakdown, or “CSV” to export it.</div>
    </div>
  );
}
