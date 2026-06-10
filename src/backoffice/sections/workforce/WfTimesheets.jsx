// src/backoffice/sections/workforce/WfTimesheets.jsx
//
// WORKFORCE → Timesheets. A timesheet exists for hours actually worked — it
// comes from the TIME CLOCK (staff clocking in/out) or is ADDED MANUALLY by a
// manager (per rota shift, or free-standing). There is NO bulk auto-generate:
// that used to create one per published shift with no clock times, which (a)
// looked like "random timesheets" and (b) was invisible to every per-day wage
// calc and payroll query — they all key on clock_in.
//
// Filter by WEEK or by PAY PERIOD (the venue's configured period — the same
// dates Run payroll uses). Rows are editable until approved; any row can be
// deleted. Approving a legacy row with no clock times re-stamps them from its
// shift so it starts counting in actual wages / labour % / payroll.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, money, th, td, inputStyle, labelStyle, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { hoursOf, resolveRate, statutoryBreakMins } from '../../../staff/labour';
import { buildWeek, addWeeks, payPeriod, shiftPayPeriod, weekRangeLabel } from '../../../staff/wfWeek';

const VAR_TOL = 0.17; // ≈ ±10 min — beyond this we flag the variance.
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Local "YYYY-MM-DDTHH:MM:00" — shift times are venue-local wall clock.
const stamp = (dateIso, hhmm) => `${dateIso}T${hhmm || '00:00'}:00`;
// clock_out from a shift, rolling overnight finishes to the next day.
function clockOutOf(dateIso, start, finish) {
  if ((finish || '') > (start || '')) return stamp(dateIso, finish);
  const d = new Date(dateIso + 'T00:00:00'); d.setDate(d.getDate() + 1);
  const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return stamp(next, finish);
}
const isoOfTs = t => t.clockIn ? String(t.clockIn).slice(0, 10) : null;

export default function WfTimesheets({ ctx, staff, roles, sections, settings, week, showToast }) {
  const [shifts, setShifts] = useState([]);
  const [sheets, setSheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState({}); // per-timesheet edited actual hours

  // ── range filter: by week or by pay period ────────────────────────────────
  const payCfg = useMemo(() => ({
    payPeriodType: settings?.payPeriodType || 'monthly',
    payPeriodStartDay: settings?.payPeriodStartDay ?? 1,
    payPeriodAnchor: settings?.payPeriodAnchor || null,
    payDay: settings?.payDay ?? null,
  }), [settings?.payPeriodType, settings?.payPeriodStartDay, settings?.payPeriodAnchor, settings?.payDay]);
  const [mode, setMode] = useState('week'); // week | period
  const [statusFilter, setStatusFilter] = useState('all'); // all | pending | approved | paid
  const [wk, setWk] = useState(() => buildWeek());
  const [pp, setPp] = useState(() => payPeriod(payCfg));
  useEffect(() => { setPp(payPeriod(payCfg)); }, [payCfg]);
  const range = mode === 'week' ? { from: wk.startIso, to: wk.endIso, label: weekRangeLabel(wk) } : { from: pp.startIso, to: pp.endIso, label: pp.label };
  const goto = n => mode === 'week' ? setWk(addWeeks(wk.startIso, n)) : setPp(shiftPayPeriod(payCfg, pp.startIso, n));
  const gotoNow = () => mode === 'week' ? setWk(buildWeek()) : setPp(payPeriod(payCfg));

  const staffMap = useMemo(() => Object.fromEntries((staff || []).map(s => [s.id, s])), [staff]);

  async function reload() {
    setLoading(true);
    try {
      const [sh, ts] = await Promise.all([
        wf.loadShifts(ctx.locationId, range.from, range.to),
        wf.loadTimesheets(ctx.locationId, range.from, range.to),
      ]);
      setShifts((sh || []).filter(s => s.status === 'published'));
      setSheets(ts || []);
    } catch (e) {
      showToast?.('Could not load timesheets: ' + e.message, 'error');
    } finally { setLoading(false); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [ctx?.locationId, range.from, range.to]);

  const tsByShift = useMemo(() => {
    const m = {};
    (sheets || []).forEach(t => { if (t.shiftId) m[t.shiftId] = t; });
    return m;
  }, [sheets]);

  function rateFor(staffId, roleKey) {
    const s = staffMap[staffId];
    const role = roles?.map?.[roleKey] || (s && roles?.map?.[s.role]) || null;
    return resolveRate(s, role, role?.contractedWeek);
  }

  // ── rows in range ──────────────────────────────────────────────────────────
  // (a) one per published shift (with its timesheet, if any);
  // (b) shiftless timesheets (Time Clock / manual) whose clock-in date is in range;
  // (c) "undated" legacy timesheets (no clock_in, shift outside range or gone) —
  //     always shown so they can be fixed or deleted, never silently hidden.
  const rows = useMemo(() => {
    const shiftIds = new Set((shifts || []).map(s => s.id));
    // Paid hours = net worked hours + any PAID break minutes (UK: the 20-min
    // statutory break may be unpaid — paying it is venue policy).
    const payOf = (actual, paidMins, rate) => round2(((actual ?? 0) + (paidMins || 0) / 60) * rate);
    const out = (shifts || []).map(shift => {
      const ts = tsByShift[shift.id] || null;
      const scheduled = round2(shift.computedHours ?? hoursOf(shift.start, shift.finish) - (shift.breakMins || 0) / 60);
      const draft = ts ? drafts[ts.id] : null;
      const actual = ts
        ? (ts.status !== 'pending' ? round2(ts.actualHours) : draft != null ? round2(parseFloat(draft) || 0) : round2(ts.actualHours))
        : null;
      const { rate, source } = rateFor(shift.staffId, shift.roleKey);
      return {
        key: `sh-${shift.id}`, kind: 'shift', shift, ts,
        staffId: shift.staffId, roleKey: shift.roleKey, date: shift.date,
        scheduled, actual, variance: ts ? round2((actual ?? 0) - scheduled) : null,
        rate, rateSource: source,
        breakMins: ts ? (ts.breakTaken || 0) : (shift.breakMins || 0),
        paidBreak: ts ? (ts.paidBreakMins || 0) > 0 : false,
        breaks: ts?.breaks || [],
        pay: ts ? payOf(actual, ts.paidBreakMins, rate) : null,
      };
    });
    (sheets || []).forEach(ts => {
      if (ts.shiftId && shiftIds.has(ts.shiftId)) return;          // already joined above
      const iso = isoOfTs(ts);
      const inRange = iso && iso >= range.from && iso <= range.to;
      const undated = !iso;                                        // legacy generated rows
      if (!inRange && !undated) return;
      const draft = drafts[ts.id];
      const actual = ts.status !== 'pending' ? round2(ts.actualHours) : draft != null ? round2(parseFloat(draft) || 0) : round2(ts.actualHours);
      const { rate, source } = rateFor(ts.staffId, staffMap[ts.staffId]?.role);
      const eff = ts.effectiveRate != null ? Number(ts.effectiveRate) : rate;
      out.push({
        key: `ts-${ts.id}`, kind: undated ? 'undated' : 'clock', shift: null, ts,
        staffId: ts.staffId, roleKey: staffMap[ts.staffId]?.role, date: iso,
        scheduled: ts.scheduledHours != null ? round2(ts.scheduledHours) : null,
        actual, variance: ts.scheduledHours != null ? round2(actual - ts.scheduledHours) : null,
        rate: eff, rateSource: ts.rateSource || source,
        breakMins: ts.breakTaken || 0,
        paidBreak: (ts.paidBreakMins || 0) > 0,
        breaks: ts.breaks || [],
        pay: ts.payAmount != null && ts.status !== 'pending' ? round2(ts.payAmount) : payOf(actual, ts.paidBreakMins, eff),
      });
    });
    return out.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(staffMap[a.staffId]?.name || '').localeCompare(String(staffMap[b.staffId]?.name || '')));
  }, [shifts, sheets, tsByShift, drafts, staffMap, roles, range.from, range.to]);

  // Status filter: pending also shows rota-only rows (a shift still needing a
  // timesheet IS pending work); approved/paid show only matching timesheets.
  const visibleRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    if (statusFilter === 'pending') return rows.filter(r => !r.ts || r.ts.status === 'pending');
    return rows.filter(r => r.ts && r.ts.status === statusFilter);
  }, [rows, statusFilter]);
  const statusCounts = useMemo(() => ({
    all: rows.length,
    pending: rows.filter(r => !r.ts || r.ts.status === 'pending').length,
    approved: rows.filter(r => r.ts?.status === 'approved').length,
    paid: rows.filter(r => r.ts?.status === 'paid').length,
  }), [rows]);

  const totals = useMemo(() => visibleRows.reduce((a, r) => ({ hours: a.hours + (r.ts ? (r.actual || 0) : 0), pay: a.pay + (r.ts ? (r.pay || 0) : 0) }), { hours: 0, pay: 0 }), [visibleRows]);
  const undatedCount = rows.filter(r => r.kind === 'undated').length;

  // ── actions ────────────────────────────────────────────────────────────────
  // Venue policy: are breaks paid by default? (Workforce settings.)
  const paidBreaksDefault = !!settings?.settings?.paidBreaks;

  // Manual add for one rota shift — clock times stamped from the shift.
  async function addForShift(r) {
    const breakMins = r.shift.breakMins || 0;
    const paidMins = paidBreaksDefault ? breakMins : 0;
    try {
      const ts = await wf.saveTimesheet({
        shiftId: r.shift.id, staffId: r.shift.staffId,
        clockIn: stamp(r.shift.date, r.shift.start), clockOut: clockOutOf(r.shift.date, r.shift.start, r.shift.finish),
        breakTaken: breakMins, paidBreakMins: paidMins,
        scheduledHours: r.scheduled, actualHours: r.scheduled, variance: 0,
        effectiveRate: r.rate, rateSource: r.rateSource, payAmount: round2((r.scheduled + paidMins / 60) * r.rate),
        status: 'pending',
      }, ctx.locationId, ctx.orgId);
      setSheets(prev => [ts, ...prev]);
      showToast?.('Timesheet added from the shift — adjust hours then approve', 'success');
    } catch (e) { showToast?.('Could not add: ' + e.message, 'error'); }
  }

  async function saveActual(r) {
    if (!r.ts || r.ts.status !== 'pending') return;
    const patch = {
      ...r.ts,
      actualHours: r.actual, variance: r.variance, payAmount: r.pay,
      effectiveRate: r.rate, rateSource: r.rateSource,
      // Heal legacy rows: stamp clock times from the shift so the row counts
      // in per-day wages and payroll (both key on clock_in).
      ...(!r.ts.clockIn && r.shift ? { clockIn: stamp(r.shift.date, r.shift.start), clockOut: clockOutOf(r.shift.date, r.shift.start, r.shift.finish) } : {}),
    };
    setSheets(prev => prev.map(t => t.id === r.ts.id ? { ...t, ...patch } : t));
    setDrafts(d => ({ ...d, [r.ts.id]: null }));
    try {
      const saved = await wf.saveTimesheet(patch, ctx.locationId, ctx.orgId);
      setSheets(prev => prev.map(t => t.id === r.ts.id ? saved : t));
    } catch (e) { showToast?.('Could not save hours: ' + e.message, 'error'); reload(); }
  }

  // Change the break (minutes and/or paid flag). On rows with both clock
  // stamps, worked hours are re-derived (gross − break); pay = worked + paid
  // break minutes.
  async function saveBreak(r, minsRaw, paidOverride) {
    if (!r.ts || r.ts.status !== 'pending') return;
    const mins = Math.max(0, Math.round(Number(minsRaw) || 0));
    const paid = paidOverride != null ? paidOverride : r.paidBreak;
    let actual = r.actual ?? 0;
    if (r.ts.clockIn && r.ts.clockOut) {
      const gross = (new Date(r.ts.clockOut) - new Date(r.ts.clockIn)) / 3600000;
      actual = round2(Math.max(0, gross - mins / 60));
    }
    const paidMins = paid ? mins : 0;
    const patch = {
      ...r.ts,
      breakTaken: mins, paidBreakMins: paidMins,
      actualHours: actual,
      variance: r.scheduled != null ? round2(actual - r.scheduled) : r.ts.variance,
      payAmount: round2((actual + paidMins / 60) * r.rate),
      effectiveRate: r.rate, rateSource: r.rateSource,
    };
    setSheets(prev => prev.map(t => t.id === r.ts.id ? { ...t, ...patch } : t));
    try {
      const saved = await wf.saveTimesheet(patch, ctx.locationId, ctx.orgId);
      setSheets(prev => prev.map(t => t.id === r.ts.id ? saved : t));
    } catch (e) { showToast?.('Could not save break: ' + e.message, 'error'); reload(); }
  }

  async function approve(r) {
    if (!r.ts || r.ts.status !== 'pending') return;
    if (drafts[r.ts.id] != null) await saveActual(r);
    const heal = !r.ts.clockIn && r.shift
      ? { clockIn: stamp(r.shift.date, r.shift.start), clockOut: clockOutOf(r.shift.date, r.shift.start, r.shift.finish) }
      : {};
    setSheets(prev => prev.map(t => t.id === r.ts.id ? { ...t, ...heal, status: 'approved' } : t));
    try {
      await wf.approveTimesheet(r.ts.id, ctx.actor?.id, heal);
      showToast?.('Timesheet approved', 'success');
      reload();
    } catch (e) { showToast?.('Approve failed: ' + e.message, 'error'); reload(); }
  }

  async function remove(r) {
    if (!r.ts) return;
    if (r.ts.status === 'paid') { showToast?.('This timesheet was paid in a closed payroll run — it is part of the payroll record and cannot be deleted.', 'error'); return; }
    const who = staffMap[r.staffId]?.name || 'this person';
    if (!window.confirm(`Delete this timesheet for ${who}?${r.ts.status === 'approved' ? ' It is APPROVED — deleting removes it from pay.' : ''}`)) return;
    setSheets(prev => prev.filter(t => t.id !== r.ts.id));
    try { await wf.deleteTimesheet(r.ts.id); showToast?.('Timesheet deleted', 'success'); }
    catch (e) { showToast?.('Delete failed: ' + e.message, 'error'); reload(); }
  }

  function VarianceCell({ variance }) {
    if (variance == null) return <span style={{ color: 'var(--t4)' }}>—</span>;
    if (Math.abs(variance) <= VAR_TOL) return <span style={{ color: 'var(--t3)' }} className="mono">0.00h</span>;
    const over = variance > 0;
    return <Badge tone={over ? 'amber' : 'red'}>{over ? '+' : ''}{variance.toFixed(2)}h {over ? 'over' : 'under'}</Badge>;
  }

  if (loading) return <LoadingCard label="Loading timesheets…" />;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Timesheets</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
            From the Time Clock, or added manually. Approve to lock pay; approved rows feed Payroll and the rota's actual wage.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className={mode === 'week' ? 'btn btn-acc btn-xs' : 'btn btn-ghost btn-xs'} onClick={() => setMode('week')}>Week</button>
            <button className={mode === 'period' ? 'btn btn-acc btn-xs' : 'btn btn-ghost btn-xs'} onClick={() => setMode('period')}>Pay period</button>
          </div>
          <button className="btn btn-ghost btn-xs" onClick={() => goto(-1)} title="Previous"><Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
          <div style={{ textAlign: 'center', minWidth: 130 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700 }}>{range.label}</div>
            <button className="btn btn-ghost btn-xs" style={{ marginTop: 1 }} onClick={gotoNow}>{mode === 'week' ? 'This week' : 'This period'}</button>
          </div>
          <button className="btn btn-ghost btn-xs" onClick={() => goto(1)} title="Next"><Icon name="chevron" size={13} /></button>
          <button className="btn btn-acc btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add timesheet</button>
        </div>
      </div>

      {/* status filter — pending also includes rota shifts still needing a timesheet */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['paid', 'Paid']].map(([k, lbl]) => (
          <button key={k} onClick={() => setStatusFilter(k)} className={statusFilter === k ? 'btn btn-acc btn-xs' : 'btn btn-ghost btn-xs'}>
            {lbl} ({statusCounts[k]})
          </button>
        ))}
      </div>

      {undatedCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(245,166,35,.10)', border: '1px solid var(--amber)', marginBottom: 14 }}>
          <span style={{ color: 'var(--amber)', marginTop: 1 }}><Icon name="warn" size={15} /></span>
          <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.55 }}>
            <b>{undatedCount} timesheet{undatedCount === 1 ? '' : 's'} with no clock times</b> (created by the old bulk-generate). They don't count in wages or payroll — delete them (✕), or approve the ones tied to a shift to stamp their times and bring them in.
          </div>
        </div>
      )}

      {visibleRows.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No timesheets in this range"
          body="Timesheets appear when staff clock in/out on the Time Clock, or when you add one manually — per rota shift below, or with Add timesheet."
        />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                <th style={th}>Staff</th>
                <th style={th}>Role</th>
                <th style={th}>Source</th>
                <th style={th}>Scheduled</th>
                <th style={{ ...th, width: 110 }}>Actual hrs</th>
                <th style={{ ...th, width: 130 }}>Break</th>
                <th style={th}>Variance</th>
                <th style={{ ...th, textAlign: 'right' }}>Pay</th>
                <th style={{ ...th, textAlign: 'right' }}>Status</th>
                <th style={{ ...th, width: 34 }} />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => {
                const s = staffMap[r.staffId];
                const locked = r.ts && r.ts.status !== 'pending';
                const paid = r.ts && r.ts.status === 'paid';
                const draftVal = r.ts ? drafts[r.ts.id] : null;
                return (
                  <tr key={r.key} style={locked ? { opacity: 0.85 } : null}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{s?.name || 'Unknown'}</div>
                      <div style={{ fontSize: 11, color: 'var(--t3)' }}>{r.date ? new Date(r.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : 'No date'}</div>
                    </td>
                    <td style={td}><RoleChip role={r.roleKey || s?.role} roles={roles.map} /></td>
                    <td style={td}>
                      {r.kind === 'clock' ? <Badge tone="blue">Clock</Badge>
                        : r.kind === 'undated' ? <Badge tone="amber">No times</Badge>
                          : r.ts?.clockIn ? <Badge tone="grey">Shift</Badge>
                            : r.ts ? <Badge tone="amber">No times</Badge>
                              : <span style={{ color: 'var(--t4)', fontSize: 12 }}>Rota only</span>}
                    </td>
                    <td style={td}>
                      {r.shift ? (<>
                        <span className="mono">{r.shift.start}–{r.shift.finish}</span>
                        <div style={{ fontSize: 11, color: 'var(--t3)' }}>{r.scheduled?.toFixed(2)}h</div>
                      </>) : r.scheduled != null ? <span className="mono">{r.scheduled.toFixed(2)}h</span> : <span style={{ color: 'var(--t4)' }}>—</span>}
                    </td>
                    <td style={td}>
                      {!r.ts ? (
                        <span style={{ color: 'var(--t4)' }}>—</span>
                      ) : locked ? (
                        <span className="mono">{(r.actual ?? 0).toFixed(2)}</span>
                      ) : (
                        <input
                          type="number" step="0.25" min="0"
                          value={draftVal != null ? draftVal : (r.actual ?? 0)}
                          onChange={e => setDrafts(d => ({ ...d, [r.ts.id]: e.target.value }))}
                          onBlur={() => draftVal != null && saveActual(r)}
                          style={{ width: 84, background: 'var(--bg3)', border: '1.5px solid var(--bdr2)', borderRadius: 8, padding: '6px 8px', height: 34, fontSize: 13, color: 'var(--t1)', fontFamily: 'var(--font-mono)', outline: 'none' }}
                        />
                      )}
                    </td>
                    <td style={td}><BreakCell r={r} staffMap={staffMap} onSave={saveBreak} /></td>
                    <td style={td}><VarianceCell variance={r.ts ? r.variance : null} /></td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {r.ts ? <span className="mono" style={{ fontWeight: 600 }}>{money(r.pay, 2)}</span> : <span style={{ color: 'var(--t4)' }}>—</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {!r.ts ? (
                        <button className="btn btn-ghost btn-xs" onClick={() => addForShift(r)} title="Add a timesheet for this shift (times from the rota)"><Icon name="plus" size={12} /> Add</button>
                      ) : paid ? (
                        <Badge tone="blue"><Icon name="check" size={11} /> Paid</Badge>
                      ) : locked ? (
                        <Badge tone="green"><Icon name="check" size={11} /> Approved</Badge>
                      ) : (
                        <button className="btn btn-ghost btn-xs" onClick={() => approve(r)}><Icon name="check" size={13} /> Approve</button>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      {r.ts && r.ts.status !== 'paid' && <button className="btn btn-ghost btn-xs" style={{ color: 'var(--t4)' }} title="Delete timesheet" onClick={() => remove(r)}><Icon name="close" size={12} /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ ...td, fontWeight: 700, borderBottom: 'none' }} colSpan={3}>Totals (timesheets)</td>
                <td style={{ ...td, borderBottom: 'none' }} />
                <td style={{ ...td, borderBottom: 'none' }}><span className="mono" style={{ fontWeight: 700 }}>{totals.hours.toFixed(2)}h</span></td>
                <td style={{ ...td, borderBottom: 'none' }} colSpan={2} />
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, borderBottom: 'none' }}><span className="mono">{money(totals.pay, 2)}</span></td>
                <td style={{ ...td, borderBottom: 'none' }} colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {adding && (
        <AddTimesheetModal
          staff={staff} paidDefault={paidBreaksDefault}
          onClose={() => setAdding(false)}
          onSave={async (form) => {
            const breakMins = Number(form.breakMins) || 0;
            const paidMins = form.breakPaid ? breakMins : 0;
            const hrs = round2(hoursOf(form.start, form.finish) - breakMins / 60);
            const { rate, source } = rateFor(form.staffId, staffMap[form.staffId]?.role);
            try {
              const ts = await wf.saveTimesheet({
                staffId: form.staffId,
                clockIn: stamp(form.date, form.start), clockOut: clockOutOf(form.date, form.start, form.finish),
                breakTaken: breakMins, paidBreakMins: paidMins,
                scheduledHours: null, actualHours: hrs, variance: null,
                effectiveRate: rate, rateSource: source, payAmount: round2((hrs + paidMins / 60) * rate),
                status: 'pending',
              }, ctx.locationId, ctx.orgId);
              setSheets(prev => [ts, ...prev]);
              setAdding(false);
              showToast?.(`Timesheet added — ${hrs.toFixed(2)}h`, 'success');
            } catch (e) { showToast?.('Could not add: ' + e.message, 'error'); }
          }}
        />
      )}
    </Card>
  );
}

// Break detail: total minutes (editable until approved), when each break ran
// (from the Time Clock's recorded segments), whether it's paid, and a UK
// Working Time Regulations check — 20 mins due over 6h worked (30 mins over
// 4.5h for under-18s, from their date of birth).
function BreakCell({ r, staffMap, onSave }) {
  const [draft, setDraft] = useState(null);
  if (!r.ts) return <span style={{ color: 'var(--t4)' }}>{r.breakMins ? `${r.breakMins}m planned` : '—'}</span>;
  const approved = r.ts.status !== 'pending';
  const dob = staffMap[r.staffId]?.dob || null;
  const due = statutoryBreakMins(r.actual ?? 0, dob);
  const short = due > 0 && (r.breakMins || 0) < due;
  const segs = (r.breaks || []).map(b => {
    const t = x => new Date(x).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return b.start && b.end ? `${t(b.start)}–${t(b.end)}` : null;
  }).filter(Boolean);
  return (
    <div title={segs.length ? `Breaks: ${segs.join(', ')}` : 'No break segments recorded'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {approved ? (
          <span className="mono">{r.breakMins || 0}m</span>
        ) : (
          <input
            type="number" min="0" step="5"
            value={draft != null ? draft : (r.breakMins || 0)}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => { if (draft != null) { onSave(r, draft); setDraft(null); } }}
            style={{ width: 56, background: 'var(--bg3)', border: '1.5px solid var(--bdr2)', borderRadius: 8, padding: '4px 6px', height: 30, fontSize: 12.5, color: 'var(--t1)', fontFamily: 'var(--font-mono)', outline: 'none' }}
          />
        )}
        {!approved && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--t3)', cursor: 'pointer' }} title="Paid break: these minutes are paid on top of worked hours (venue policy — UK law doesn't require the statutory break to be paid)">
            <input type="checkbox" checked={r.paidBreak} onChange={e => onSave(r, draft != null ? draft : r.breakMins, e.target.checked)} />
            paid
          </label>
        )}
        {approved && r.paidBreak && <Badge tone="green">paid</Badge>}
      </div>
      {segs.length > 0 && <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>{segs.join(' · ')}</div>}
      {short && <div style={{ marginTop: 3 }}><Badge tone="red">{due}m break due (WTR)</Badge></div>}
    </div>
  );
}

// Free-standing manual timesheet — for hours worked off-rota (no shift).
function AddTimesheetModal({ staff, paidDefault = false, onClose, onSave }) {
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const [form, setForm] = useState({ staffId: staff?.[0]?.id || '', date: todayIso, start: '09:00', finish: '17:00', breakMins: '0', breakPaid: paidDefault });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const valid = form.staffId && form.date && form.start && form.finish;
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 440 }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Add timesheet</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 }}>For hours worked that weren’t clocked — e.g. a forgotten clock-in. Starts as pending; approve it to lock pay.</div>
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Staff member</label>
          <select style={inputStyle} value={form.staffId} onChange={e => set('staffId', e.target.value)}>
            {(staff || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div><label style={labelStyle}>Date</label><input type="date" style={inputStyle} value={form.date} onChange={e => set('date', e.target.value)} /></div>
          <div><label style={labelStyle}>Unpaid break (mins)</label><input type="number" min="0" step="5" style={inputStyle} value={form.breakMins} onChange={e => set('breakMins', e.target.value)} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div><label style={labelStyle}>Start</label><input type="time" style={inputStyle} value={form.start} onChange={e => set('start', e.target.value)} /></div>
          <div><label style={labelStyle}>Finish</label><input type="time" style={inputStyle} value={form.finish} onChange={e => set('finish', e.target.value)} /></div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, fontSize: 13, color: 'var(--t2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.breakPaid} onChange={e => set('breakPaid', e.target.checked)} />
          Break is paid <span style={{ fontSize: 11, color: 'var(--t4)' }}>(UK law: 20 mins due over 6h — doesn’t have to be paid; this is your policy)</span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={busy || !valid} onClick={async () => { setBusy(true); try { await onSave(form); } finally { setBusy(false); } }}>{busy ? 'Adding…' : 'Add timesheet'}</button>
        </div>
      </div>
    </div>
  );
}
