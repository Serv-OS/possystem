// src/backoffice/sections/workforce/WfPayroll.jsx
//
// Workforce › Payroll — run the pay period: base pay (approved timesheets) PLUS
// tips (persisted tronc runs whose week starts inside the period), computed
// server-side by workforce-compute `payroll.period`. The run is locked to the
// venue's configured pay period (Workforce settings); ‹ › steps whole periods
// so past runs are reportable like-for-like. Bank details ride along and the
// whole run exports as CSV for BACS.
//
// Tips come from the Tronc / tips tool (UK Tipping Act model — pool × hours ×
// role points, penny-exact). If a week in the period has no tronc run yet the
// run flags it, so tips aren't silently missing from pay.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, th, td, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { payPeriod, shiftPayPeriod } from '../../../staff/wfWeek';

const money = (n, dp = 2) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtDay = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export default function WfPayroll({ ctx, staff = [], roles, sections, settings, week, showToast }) {
  const payCfg = useMemo(() => ({
    payPeriodType: settings?.payPeriodType || 'monthly',
    payPeriodStartDay: settings?.payPeriodStartDay ?? 1,
    payPeriodAnchor: settings?.payPeriodAnchor || null,
    payDay: settings?.payDay ?? null,
  }), [settings?.payPeriodType, settings?.payPeriodStartDay, settings?.payPeriodAnchor, settings?.payDay]);

  const [period, setPeriod] = useState(() => payPeriod(payCfg));
  const [run, setRun] = useState(null);     // { staff, totals, tronc } | null
  const [computing, setComputing] = useState(false);
  useEffect(() => { setPeriod(payPeriod(payCfg)); setRun(null); }, [payCfg]);

  const staffById = useMemo(() => { const m = {}; (staff || []).forEach(s => { m[s.id] = s; }); return m; }, [staff]);
  const nameOf = id => staffById[id]?.name || id;
  const bankOf = id => {
    const s = staffById[id];
    if (!s) return null;
    if (s.bankAccount) return `${s.bankSortCode || '——'} ${s.bankAccount}`;
    if (s.bankMasked) return `${s.bankSortCode || '——'} ${s.bankMasked}`;
    return null;
  };

  async function compute(p = period) {
    setComputing(true);
    try {
      const res = await wf.invokeCompute('payroll.period', { location_id: ctx.locationId, from: p.startIso, to: p.endIso });
      if (res && Array.isArray(res.staff)) setRun(res);
      else setRun({ staff: [], totals: { pay: 0, tips_tronc: 0, tips_direct: 0, tips: 0, total: 0 }, tronc: { runs: [], missingWeeks: [] }, mock: !!res?.mock });
    } catch (e) {
      showToast(e.message || 'Payroll run failed', 'error');
    } finally { setComputing(false); }
  }
  const gotoPeriod = (n) => { const p = shiftPayPeriod(payCfg, period.startIso, n); setPeriod(p); setRun(null); };

  // Bureau-ready CSV (BrightPay-style identity: name + NI number). Tips are
  // SEPARATE pay elements from wages — tronc-allocated tips are PAYE'd but
  // NIC-free only when an independent troncmaster decides shares (HMRC E24);
  // employer-allocated tips attract NICs; tips NEVER count toward National
  // Minimum Wage, so the bureau checks NMW on basic pay alone.
  const exportCsv = () => {
    if (!run?.staff?.length) return;
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const isUK = (settings?.currency || 'GBP') === 'GBP';
    const troncFree = isUK && run.policy?.allocator === 'troncmaster';
    const troncCol = !isUK ? 'Pooled tips' : troncFree ? 'Tronc tips (PAYE, no NIC - independent troncmaster)' : 'Pooled tips (PAYE + NIC - employer allocated)';
    const directCol = !isUK ? 'Direct tips' : troncFree ? 'Direct tips via tronc (PAYE, no NIC)' : 'Direct tips (PAYE + NIC - employer allocated)';
    const rows = [
      ['First name', 'Surname', 'NI number', 'Period start', 'Period end', 'Hours', 'Basic pay', troncCol, directCol, 'Gross total', 'Sort code', 'Account number'],
      ...run.staff.map(r => {
        const s = staffById[r.staff_id] || {};
        const parts = String(s.name || nameOf(r.staff_id)).trim().split(/\s+/);
        const first = parts.slice(0, -1).join(' ') || parts[0] || '';
        const last = parts.length > 1 ? parts[parts.length - 1] : '';
        return [first, last, s.niNumber || '', period.startIso, period.endIso, r.hours.toFixed(2), r.pay.toFixed(2), r.tips_tronc.toFixed(2), r.tips_direct.toFixed(2), r.total.toFixed(2), s.bankSortCode || '', s.bankAccount || s.bankMasked || ''];
      }),
      ['TOTAL', '', '', '', '', '', run.totals.pay.toFixed(2), run.totals.tips_tronc.toFixed(2), run.totals.tips_direct.toFixed(2), run.totals.total.toFixed(2), '', ''],
      [],
      ['Notes for payroll:'],
      [isUK ? 'Tips are separate pay elements and must not count toward National Minimum Wage.' : 'Tips are reported separately from wages; managers/supervisors must not receive pooled tips (FLSA). State tip-credit rules vary.'],
      ...(isUK ? [[troncFree
        ? `Tronc/direct tip amounts were allocated by the independent troncmaster${run.policy?.troncmasterName ? ` (${run.policy.troncmasterName})` : ''} and must not be altered - taxable via PAYE, exempt from employee and employer NICs (HMRC E24).`
        : 'Tip amounts were allocated by the employer - taxable via PAYE and subject to employee and employer NICs (HMRC E24).']] : []),
    ];
    const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payroll-${period.startIso}-to-${period.endIso}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const missing = run?.tronc?.missingWeeks || [];
  const troncRuns = run?.tronc?.runs || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Run payroll</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>Base pay from approved timesheets + tips from tronc runs, locked to the pay period. Set the period in Workforce settings.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost btn-xs" onClick={() => gotoPeriod(-1)} disabled={computing} title="Previous period"><Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
            <div style={{ textAlign: 'center', minWidth: 175 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 }}>{period.label}</div>
              {period.payDateIso && <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 1 }}>Pay day {fmtDay(period.payDateIso)}</div>}
              <button className="btn btn-ghost btn-xs" style={{ marginTop: 1 }} onClick={() => { setPeriod(payPeriod(payCfg)); setRun(null); }} disabled={computing}>This period</button>
            </div>
            <button className="btn btn-ghost btn-xs" onClick={() => gotoPeriod(1)} disabled={computing} title="Next period"><Icon name="chevron" size={13} /></button>
            <button className="btn btn-acc btn-sm" onClick={() => compute()} disabled={computing}>
              <Icon name="status" size={14} /> {computing ? 'Running…' : 'Run payroll'}
            </button>
          </div>
        </div>

        {run && missing.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(245,166,35,.10)', border: '1px solid var(--amber)', marginBottom: 14 }}>
            <span style={{ color: 'var(--amber)', marginTop: 1 }}><Icon name="warn" size={15} /></span>
            <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.55 }}>
              <b>Tips missing for {missing.length} week{missing.length === 1 ? '' : 's'}</b> — no tronc run yet for {missing.map(w => `w/c ${fmtDay(w)}`).join(', ')}.
              Run them under <b>Tronc / tips</b>, then run payroll again so tips land in this period.
            </div>
          </div>
        )}
        {run && troncRuns.length > 0 && missing.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--t3)', marginBottom: 12 }}>
            Pooled tips from {troncRuns.length} tronc run{troncRuns.length === 1 ? '' : 's'} ({troncRuns.map(r => `w/c ${fmtDay(r.week_start)}`).join(', ')}) — all weeks in this period covered.
          </div>
        )}
        {run && Number(run.unattributedTips) > 0 && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--red-d)', border: '1px solid var(--red-b)', marginBottom: 14 }}>
            <span style={{ color: 'var(--red)', marginTop: 1 }}><Icon name="warn" size={15} /></span>
            <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.55 }}>
              <b>{money(run.unattributedTips)} of direct tips couldn't be matched to a staff member</b> — checks with no or unknown server. The Tipping Act requires 100% of tips to reach staff: link till users to staff records (Staff → Set as POS user), or add this amount to the tronc pool.
            </div>
          </div>
        )}
        {run && run.policy && (
          <div style={{ fontSize: 11.5, color: 'var(--t4)', marginBottom: 12 }}>
            Tipping policy: {run.policy.tipMode === 'direct' ? 'card tips go to the seller' : run.policy.tipMode === 'hybrid' ? `seller keeps ${run.policy.directPct}% of their tips, rest pooled` : 'all card tips pooled'}
            {(settings?.currency || 'GBP') === 'GBP'
              ? <> · allocation by {run.policy.allocator === 'troncmaster' ? 'independent troncmaster — tips are PAYE-taxed but NIC-free (HMRC E24); do not adjust these figures' : 'the business — tips attract employee + employer NICs'} · tips never count toward National Minimum Wage.</>
              : <> · US FLSA: tips belong to staff — managers/supervisors can't receive pooled tips; tips are reported separately from wages and tip-credit rules vary by state.</>}
          </div>
        )}

        {computing ? (
          <LoadingCard label="Computing payroll…" />
        ) : run === null ? (
          <EmptyState
            icon="status"
            title="Run this pay period"
            body="Computes each person's base pay from approved timesheets and adds their tronc tip share — all server-side. Export the result as CSV with bank details to pay them."
            cta="Run payroll"
            onCta={() => compute()}
          />
        ) : run.staff.length === 0 ? (
          <EmptyState
            icon="clock"
            title="Nothing to pay in this period"
            body="No approved timesheets and no tronc runs fall inside these dates. Approve timesheets under Timesheets, run tips under Tronc / tips, then run again."
          />
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Staff</th>
                    <th style={th}>Bank</th>
                    <th style={{ ...th, textAlign: 'right' }}>Hours</th>
                    <th style={{ ...th, textAlign: 'right' }}>Base pay</th>
                    <th style={{ ...th, textAlign: 'right' }}>Tips (direct)</th>
                    <th style={{ ...th, textAlign: 'right' }}>Tips (pooled)</th>
                    <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {run.staff.map(r => (
                    <tr key={r.staff_id}>
                      <td style={td}>{nameOf(r.staff_id)}</td>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11.5, color: bankOf(r.staff_id) ? 'var(--t3)' : 'var(--red)' }}>{bankOf(r.staff_id) || 'No bank on file'}</td>
                      <td style={{ ...td, textAlign: 'right' }} className="mono">{Number(r.hours || 0).toFixed(2)}</td>
                      <td style={{ ...td, textAlign: 'right' }} className="mono">{money(r.pay)}</td>
                      <td style={{ ...td, textAlign: 'right' }} className="mono">{r.tips_direct ? money(r.tips_direct) : <span style={{ color: 'var(--t4)' }}>—</span>}</td>
                      <td style={{ ...td, textAlign: 'right' }} className="mono">{r.tips_tronc ? money(r.tips_tronc) : <span style={{ color: 'var(--t4)' }}>—</span>}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }} className="mono">{money(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ ...td, fontWeight: 700, borderBottom: 'none' }}>Total</td>
                    <td style={{ ...td, borderBottom: 'none' }} />
                    <td style={{ ...td, borderBottom: 'none' }} />
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, borderBottom: 'none' }} className="mono">{money(run.totals.pay)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, borderBottom: 'none' }} className="mono">{money(run.totals.tips_direct)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, borderBottom: 'none' }} className="mono">{money(run.totals.tips_tronc)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, borderBottom: 'none' }} className="mono">{money(run.totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn btn-ghost btn-sm" onClick={exportCsv}><Icon name="tag" size={14} /> Export CSV (BACS)</button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
