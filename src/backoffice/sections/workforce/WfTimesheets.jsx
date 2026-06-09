// src/backoffice/sections/workforce/WfTimesheets.jsx
//
// WORKFORCE → Timesheets. Reconciles published rota shifts against actual hours
// worked, computes variance + pay, and locks rows once approved. Pay math here
// is client-side for the seed build; the server hardens it (see labour.js).

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, money, th, td, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { hoursOf, resolveRate } from '../../../staff/labour';

const VAR_TOL = 0.17; // ≈ ±10 min — beyond this we flag the variance.

// Round decimal hours to 2dp for stable display + math.
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

export default function WfTimesheets({ ctx, staff, roles, sections, settings, week, showToast }) {
  const [shifts, setShifts] = useState([]);
  const [sheets, setSheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Per-shift draft of edited actual hours (string while typing).
  const [drafts, setDrafts] = useState({});

  const staffMap = useMemo(() => Object.fromEntries((staff || []).map(s => [s.id, s])), [staff]);

  async function reload() {
    if (!ctx?.locationId && ctx?.locationId !== null) return;
    setLoading(true);
    try {
      const [sh, ts] = await Promise.all([
        wf.loadShifts(ctx.locationId, week.startIso, week.endIso),
        wf.loadTimesheets(ctx.locationId),
      ]);
      setShifts((sh || []).filter(s => s.status === 'published'));
      setSheets(ts || []);
    } catch (e) {
      showToast?.('Could not load timesheets: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ctx?.locationId, week.startIso]);

  // Index existing timesheets by the shift they reconcile.
  const tsByShift = useMemo(() => {
    const m = {};
    (sheets || []).forEach(t => { if (t.shiftId) m[t.shiftId] = t; });
    return m;
  }, [sheets]);

  // Resolve rate snapshot for a shift's staff + role.
  function rateFor(shift) {
    const s = staffMap[shift.staffId];
    const role = roles?.map?.[shift.roleKey] || (s && roles?.map?.[s.role]) || null;
    return resolveRate(s, role, role?.contractedWeek);
  }

  // Build the working rows: one per published shift, joined to its timesheet.
  const rows = useMemo(() => (shifts || []).map(shift => {
    const ts = tsByShift[shift.id] || null;
    const scheduled = round2(shift.computedHours ?? hoursOf(shift.start, shift.finish) - (shift.breakMins || 0) / 60);
    const draft = drafts[shift.id];
    const actual = ts && ts.status === 'approved'
      ? round2(ts.actualHours)
      : draft != null ? round2(parseFloat(draft) || 0)
      : ts ? round2(ts.actualHours)
      : scheduled;
    const variance = round2(actual - scheduled);
    const { rate, source } = rateFor(shift);
    const pay = round2(actual * rate);
    return { shift, ts, scheduled, actual, variance, rate, rateSource: source, pay };
  }), [shifts, tsByShift, drafts, staffMap, roles]);

  const totals = useMemo(() => rows.reduce((a, r) => ({ hours: a.hours + r.actual, pay: a.pay + r.pay }), { hours: 0, pay: 0 }), [rows]);

  function setDraft(shiftId, val) {
    setDrafts(d => ({ ...d, [shiftId]: val }));
  }

  // Generate pending timesheets for every published shift that has none yet.
  async function generate() {
    const pending = rows.filter(r => !r.ts);
    if (!pending.length) { showToast?.('Every published shift already has a timesheet', 'info'); return; }
    setBusy(true);
    try {
      const saved = [];
      for (const r of pending) {
        const ts = await wf.saveTimesheet({
          shiftId: r.shift.id,
          staffId: r.shift.staffId,
          scheduledHours: r.scheduled,
          actualHours: r.scheduled,
          variance: 0,
          effectiveRate: r.rate,
          rateSource: r.rateSource,
          payAmount: round2(r.scheduled * r.rate),
          status: 'pending',
        }, ctx.locationId, ctx.orgId);
        saved.push(ts);
      }
      setSheets(prev => [...saved, ...prev]);
      showToast?.(`Generated ${saved.length} timesheet${saved.length === 1 ? '' : 's'} from the rota`, 'success');
    } catch (e) {
      showToast?.('Generate failed: ' + e.message, 'error');
      reload();
    } finally {
      setBusy(false);
    }
  }

  // Persist an edited actual-hours value (recompute variance + pay snapshot).
  async function saveActual(r) {
    if (!r.ts || r.ts.status === 'approved') return;
    const patch = {
      ...r.ts,
      actualHours: r.actual,
      variance: r.variance,
      payAmount: r.pay,
      effectiveRate: r.rate,
      rateSource: r.rateSource,
    };
    setSheets(prev => prev.map(t => t.id === r.ts.id ? { ...t, ...patch } : t));
    setDraft(r.shift.id, null);
    try {
      const saved = await wf.saveTimesheet(patch, ctx.locationId, ctx.orgId);
      setSheets(prev => prev.map(t => t.id === r.ts.id ? saved : t));
    } catch (e) {
      showToast?.('Could not save hours: ' + e.message, 'error');
      reload();
    }
  }

  async function approve(r) {
    if (!r.ts || r.ts.status === 'approved') return;
    // Make sure any in-flight edit is persisted before we lock the row.
    if (drafts[r.shift.id] != null) await saveActual(r);
    setSheets(prev => prev.map(t => t.id === r.ts.id ? { ...t, status: 'approved' } : t));
    try {
      await wf.approveTimesheet(r.ts.id, ctx.actor?.id);
      showToast?.('Timesheet approved', 'success');
      reload();
    } catch (e) {
      showToast?.('Approve failed: ' + e.message, 'error');
      reload();
    }
  }

  function VarianceCell({ variance }) {
    if (Math.abs(variance) <= VAR_TOL) {
      return <span style={{ color: 'var(--t3)' }} className="mono">0.00h</span>;
    }
    const over = variance > 0;
    return (
      <Badge tone={over ? 'amber' : 'red'}>
        {over ? '+' : ''}{variance.toFixed(2)}h {over ? 'over' : 'under'}
      </Badge>
    );
  }

  if (loading) return <LoadingCard label="Loading timesheets…" />;

  if (!shifts.length) {
    return (
      <EmptyState
        icon="clock"
        title="No published shifts this week"
        body="Timesheets are generated from the published rota. Build the schedule and publish it, then come back here to reconcile actual hours and approve pay."
      />
    );
  }

  const ungenerated = rows.filter(r => !r.ts).length;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Timesheets</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
            {rows.length} published shift{rows.length === 1 ? '' : 's'} · {sheets.length ? `${sheets.length} timesheet${sheets.length === 1 ? '' : 's'}` : 'none generated yet'}
          </div>
        </div>
        <button className="btn btn-acc btn-sm" onClick={generate} disabled={busy || !ungenerated}>
          <Icon name="sparkle" size={14} /> {busy ? 'Generating…' : ungenerated ? `Generate from rota (${ungenerated})` : 'All generated'}
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
          <thead>
            <tr>
              <th style={th}>Staff</th>
              <th style={th}>Role</th>
              <th style={th}>Scheduled</th>
              <th style={{ ...th, width: 110 }}>Actual hrs</th>
              <th style={th}>Variance</th>
              <th style={{ ...th, textAlign: 'right' }}>Pay</th>
              <th style={{ ...th, textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const s = staffMap[r.shift.staffId];
              const approved = r.ts && r.ts.status === 'approved';
              const draftVal = drafts[r.shift.id];
              return (
                <tr key={r.shift.id} style={approved ? { opacity: 0.85 } : null}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{s?.name || 'Unknown'}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)' }}>{week.days?.find(d => d.iso === r.shift.date)?.label || r.shift.date}</div>
                  </td>
                  <td style={td}>
                    <RoleChip role={r.shift.roleKey || s?.role} roles={roles.map} />
                  </td>
                  <td style={td}>
                    <span className="mono">{r.shift.start}–{r.shift.finish}</span>
                    <div style={{ fontSize: 11, color: 'var(--t3)' }}>{r.scheduled.toFixed(2)}h</div>
                  </td>
                  <td style={td}>
                    {approved || !r.ts ? (
                      <span className="mono" style={{ color: r.ts ? 'var(--t1)' : 'var(--t4)' }}>{r.actual.toFixed(2)}</span>
                    ) : (
                      <input
                        type="number" step="0.25" min="0"
                        value={draftVal != null ? draftVal : r.actual}
                        onChange={e => setDraft(r.shift.id, e.target.value)}
                        onBlur={() => draftVal != null && saveActual(r)}
                        style={{ width: 84, background: 'var(--bg3)', border: '1.5px solid var(--bdr2)', borderRadius: 8, padding: '6px 8px', height: 34, fontSize: 13, color: 'var(--t1)', fontFamily: 'var(--font-mono)', outline: 'none' }}
                      />
                    )}
                  </td>
                  <td style={td}>
                    {r.ts ? <VarianceCell variance={r.variance} /> : <span style={{ color: 'var(--t4)' }}>—</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{money(r.pay, 2)}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {!r.ts ? (
                      <Badge tone="grey">Not generated</Badge>
                    ) : approved ? (
                      <Badge tone="green"><Icon name="check" size={11} /> Approved</Badge>
                    ) : (
                      <button className="btn btn-ghost btn-xs" onClick={() => approve(r)}>
                        <Icon name="check" size={13} /> Approve
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...td, fontWeight: 700, borderBottom: 'none' }} colSpan={2}>Totals</td>
              <td style={{ ...td, borderBottom: 'none' }} />
              <td style={{ ...td, borderBottom: 'none' }}>
                <span className="mono" style={{ fontWeight: 700 }}>{totals.hours.toFixed(2)}h</span>
              </td>
              <td style={{ ...td, borderBottom: 'none' }} />
              <td style={{ ...td, textAlign: 'right', fontWeight: 700, borderBottom: 'none' }}>
                <span className="mono">{money(totals.pay, 2)}</span>
              </td>
              <td style={{ ...td, borderBottom: 'none' }} />
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
