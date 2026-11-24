// src/backoffice/sections/workforce/WfLeave.jsx
//
// Workforce › Time off & availability. Three stacked sections:
//   (1) Leave requests — request, approve/deny (wf_time_off)
//   (2) Holiday balances — accrual ledger balances + server-side accrual run
//   (3) Availability — light per-staff weekly availability editor
// Self-contained ServOS skin. Loads on mount keyed to ctx.locationId.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, th, td, inputStyle, labelStyle, groupColor, cellTint, initials, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';
import { isHourly, avgHoursPerDay, FIXED_HOLIDAY_DAYS } from '../../../staff/labour';
import { proposeLeaveDays } from '../../../staff/leaveDays';
// 5.12.51: US venues call it PTO (Workforce settings, Paid time off).
import { activeRegionPack } from '../../../lib/regionPack';
import { localeDateString, venueToday, dayText } from '../../../lib/venueDates';
// 5.12.61: blocked periods (no holiday or PTO requests in a period) and versioned availability (a
// staff app change applies from the next rota period). Same rules as the staff portal.
import { leaveBlocks, blockFor, blockWords } from '../../../../supabase/functions/_shared/leaveBlocks.js';
import { availabilityInEffect, pendingAvailability } from '../../../../supabase/functions/_shared/availabilityWhen.js';
// 5.12.57: one word for paid time off (Holiday or PTO), and the UK statutory texts only under UK rules.
import { holidayWord, holidayWordLower, ukHoliday } from '../../../staff/payLaw';
import { ptoRules } from '../../../../supabase/functions/_shared/usPto.js';
// 5.12.89 (HR feedback, 23 Nov 2026): a balance changed by hand, or brought over from another site.
import { adjustProblem, transferProblem } from '../../../../supabase/functions/_shared/holidayAdjust.js';
// 5.12.91 (HR feedback batch 2, 24 Nov 2026): Part of the day with the site's own options, and patterns
// staff have filed for future weeks. One copy of the rules with the staff-portal.
import { partDayOptions, cleanOptions, dayWords, MAX_PART_DAY_OPTIONS, MAX_OPTION_LENGTH } from '../../../../supabase/functions/_shared/availabilityChoices.js';

// 5.12.57: built when the screen draws, for the venue it is on. It was built once when the file
// loaded, so the tab kept the first venue's word after a switch between a UK and a US site.
const tabsFor = (pack) => [
  { key: 'leave', lbl: 'Leave requests', icon: 'note' },
  { key: 'balances', lbl: `${holidayWord(pack)} balances`, icon: 'sun' },
  { key: 'avail', lbl: 'Availability', icon: 'status' },
];
const leaveTypesFor = (pack) => [
  { key: 'holiday', lbl: holidayWord(pack) },
  { key: 'sick', lbl: 'Sick' },
  { key: 'unpaid', lbl: 'Unpaid' },
  { key: 'parental', lbl: 'Parental' },
];
const STATUS_TONE = { approved: 'green', denied: 'red', pending: 'amber' };
const AV_STATES = [
  { key: 'available', lbl: 'Available', tone: 'green' },
  { key: 'unavailable', lbl: 'Off', tone: 'red' },
  { key: 'preferred', lbl: 'Prefers', tone: 'blue' },
  { key: 'partial', lbl: 'Part day', tone: 'amber' },   // 5.12.91: can work part of the day; the option says which
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const fmtDate = iso => { if (!iso) return '—'; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : localeDateString(d, { day: 'numeric', month: 'short' }); };   // 5.12.57: the venue's way
const daysBetween = (a, b) => { if (!a || !b) return 1; const d1 = new Date(a + 'T00:00:00'); const d2 = new Date(b + 'T00:00:00'); if (isNaN(d1) || isNaN(d2)) return 1; return Math.max(1, Math.round((d2 - d1) / 86400000) + 1); };

export default function WfLeave({ ctx, staff = [], roles, sections, settings, showToast, onSettingsSaved }) {
  const pack = activeRegionPack();
  const todayIso = venueToday();
  const leaveWord = ukHoliday(pack) ? 'holiday' : 'PTO';
  // 5.12.57: a US venue with PTO switched off pays no PTO: approvals are unpaid (workforce-compute).
  const ptoOff = !ukHoliday(pack) && !ptoRules(settings?.settings || null).on;
  const [tab, setTab] = useState('leave');
  const [loading, setLoading] = useState(true);
  const [leave, setLeave] = useState([]);
  const [accrual, setAccrual] = useState([]);
  const [avail, setAvail] = useState([]);
  const [timesheets, setTimesheets] = useState([]);
  const [reqOpen, setReqOpen] = useState(false);
  // Per-request day overrides: { [requestId]: { [date]: leave? } }. The proposal
  // (rota > availability > history > contract) fills the gaps; a click flips a
  // day; only days marked LEAVE are valued and deducted.
  const [dayPicks, setDayPicks] = useState({});
  const [rangeShifts, setRangeShifts] = useState([]);
  const [running, setRunning] = useState(false);
  const [adjusting, setAdjusting] = useState(null);   // 5.12.89: the person whose balance is being adjusted

  const staffById = useMemo(() => Object.fromEntries(staff.map(s => [s.id, s])), [staff]);
  const balances = useMemo(() => wf.accrualBalances(accrual), [accrual]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      wf.loadTimeOff(ctx?.locationId),
      wf.loadAccrual(ctx?.locationId),
      wf.loadAvailability(ctx?.locationId),
      // 104-week window: the statutory holiday lookback never needs more.
      wf.loadTimesheets(ctx?.locationId, (() => { const d = new Date(); d.setDate(d.getDate() - 104 * 7); return d.toISOString().slice(0, 10); })(), new Date().toISOString().slice(0, 10)),
    ]).then(([lv, ac, av, ts]) => {
      if (!live) return;
      setLeave(lv || []); setAccrual(ac || []); setAvail(av || []); setTimesheets(ts || []);
      // The rota is the strongest day-split signal — fetch shifts spanning
      // every PENDING request so the proposal can see scheduled days.
      const pend = (lv || []).filter(x => x.status === 'pending');
      if (pend.length) {
        const from = pend.reduce((a, x) => (x.startDate < a ? x.startDate : a), pend[0].startDate);
        const to = pend.reduce((a, x) => (x.endDate > a ? x.endDate : a), pend[0].endDate);
        wf.loadShifts(ctx?.locationId, from, to).then(sh => { if (live) setRangeShifts(sh || []); }).catch(() => {});
      }
    }).catch(() => { if (live) showToast?.('Could not load time off', 'error'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ctx?.locationId]);

  // The split for one request: proposal overlaid with the approver's clicks.
  const splitFor = (l, member) => {
    const proposal = proposeLeaveDays({
      from: l.startDate, to: l.endDate, staffId: l.staffId,
      shifts: rangeShifts, availability: avail, timesheets,
      contractType: member?.contractType || null,
    });
    const picks = dayPicks[l.id] || {};
    return proposal.map(d => ({ ...d, leave: picks[d.date] ?? d.leave }));
  };

  async function submitRequest(form) {
    const days = daysBetween(form.startDate, form.endDate);
    const optimistic = { id: 'tmp-' + Date.now(), ...form, days, status: 'pending' };
    setLeave(prev => [optimistic, ...prev]);
    setReqOpen(false);
    try {
      const saved = await wf.saveTimeOff(optimistic, ctx?.locationId, ctx?.orgId);
      setLeave(prev => prev.map(l => l.id === optimistic.id ? saved : l));
      showToast?.('Leave request submitted', 'success');
    } catch (e) {
      showToast?.(e.message || 'Could not submit request', 'error');
      setLeave(await wf.loadTimeOff(ctx?.locationId));
    }
  }

  async function decide(id, status, paid, leaveDays) {
    const before = leave;
    setLeave(prev => prev.map(l => l.id === id ? { ...l, status } : l));
    try {
      // The decision runs SERVER-side (workforce-compute timeoff.decide): it
      // snapshots hours and rate, spends the accrual for paid holiday, and is
      // idempotent — approving twice can never deduct twice. The client no
      // longer just flips a status, because a status flip is not a decision
      // about money.
      const res = await wf.invokeCompute('timeoff.decide', {
        location_id: ctx?.locationId, time_off_id: id, status, paid,
        ...(Array.isArray(leaveDays) ? { leave_days: leaveDays } : {}),
      });
      if (res?.error) throw new Error(res.error);
      if (status === 'approved') {
        const balTxt = typeof res?.balance === 'number' ? ` — balance now ${res.balance}h` : '';
        // 5.12.57: the server says when PTO is off and the approval was made unpaid.
        if (res?.note) showToast?.(`Leave approved (unpaid). ${res.note}`, 'info');
        else showToast?.(`Leave approved (${paid ? 'paid' : 'unpaid'})${balTxt}`, res?.balance < 0 ? 'info' : 'success');
      } else {
        showToast?.('Leave denied', 'success');
      }
      // The ledger changed; reload both sides rather than guessing.
      const [lv, ac] = await Promise.all([wf.loadTimeOff(ctx?.locationId), wf.loadAccrual(ctx?.locationId)]);
      setLeave(lv || []); setAccrual(ac || []);
    } catch (e) {
      showToast?.(`Leave NOT ${status === 'approved' ? 'approved' : 'denied'} — ${e.message || 'the change was rejected'}`, 'error');
      setLeave(before);
    }
  }

  async function runAccrual() {
    if (running) return;
    setRunning(true);
    try {
      const res = await wf.invokeCompute('accrual.run', { location_id: ctx?.locationId });
      setAccrual(await wf.loadAccrual(ctx?.locationId));
      // v5.11.101: a US venue has no statutory accrual; the server says so and writes nothing.
      showToast?.(res?.off || `${holidayWord(pack)} accrual run complete`, res?.off ? 'info' : 'success');
    } catch (e) {
      showToast?.(e.message || 'Accrual run failed', 'error');
    } finally {
      setRunning(false);
    }
  }

  // 5.12.61: a manager edits the pattern in effect today (its own row and week_start are kept). A
  // change the person filed for the next rota period is another row and is left alone.
  async function saveAvailRow(staffId, perDay) {
    const existing = availabilityInEffect(avail.filter(a => a.staffId === staffId), todayIso);
    const row = { ...(existing || {}), id: existing?.id || ('tmp-' + Date.now()), staffId, recurring: true, weekStart: existing?.weekStart || null, perDay };
    setAvail(prev => existing ? prev.map(a => a.id === row.id ? row : a) : [...prev, row]);
    try {
      const saved = await wf.saveAvailability(row, ctx?.locationId, ctx?.orgId);
      setAvail(prev => prev.map(a => a.id === row.id ? saved : a));
    } catch (e) {
      showToast?.(e.message || 'Could not save availability', 'error');
      setAvail(await wf.loadAvailability(ctx?.locationId));
    }
  }

  // 5.12.61: blocked periods live in the site's Workforce settings (settings.leaveBlocks).
  async function saveBlocks(list) {
    const next = { ...(settings || {}), settings: { ...(settings?.settings || {}), leaveBlocks: list } };
    try {
      const saved = await wf.saveSettings(next, ctx?.locationId, ctx?.orgId);
      onSettingsSaved?.(saved || next);
      showToast?.('Blocked periods saved', 'success');
    } catch (e) {
      showToast?.(e.message || 'Could not save blocked periods', 'error');
    }
  }

  // 5.12.91: the site's Part of the day options live in its Workforce settings (settings.availabilityOptions).
  async function saveAvailOptions(list) {
    const next = { ...(settings || {}), settings: { ...(settings?.settings || {}), availabilityOptions: cleanOptions(list) } };
    try {
      const saved = await wf.saveSettings(next, ctx?.locationId, ctx?.orgId);
      onSettingsSaved?.(saved || next);
      showToast?.('Part of the day options saved. Staff see them in the app straight away.', 'success');
    } catch (e) {
      showToast?.(e.message || 'Could not save the options', 'error');
    }
  }

  if (loading) return <LoadingCard label="Loading time off…" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tabsFor(pack).map(t => (
          <button key={t.key} className={'btn btn-sm ' + (tab === t.key ? 'btn-acc' : 'btn-ghost')} onClick={() => setTab(t.key)}>
            <Icon name={t.icon} size={14} /> {t.lbl}
          </button>
        ))}
      </div>

      {tab === 'leave' && (
        <>
          <LeaveSection pack={pack} ptoOff={ptoOff} leave={leave} staffById={staffById} roles={roles} balances={balances} timesheets={timesheets} onRequest={() => setReqOpen(true)} onDecide={decide} splitFor={splitFor} setDayPicks={setDayPicks} />
          <BlockedPeriods word={leaveWord} blocks={leaveBlocks(settings?.settings)} todayIso={todayIso} onSave={saveBlocks} />
        </>
      )}
      {tab === 'balances' && (
        <BalancesSection pack={pack} settings={settings} staff={staff} roles={roles} balances={balances} accrual={accrual} leave={leave} timesheets={timesheets} running={running} onRun={runAccrual} onAdjust={setAdjusting} />
      )}
      {tab === 'avail' && (
        <AvailSection staff={staff} roles={roles} avail={avail} todayIso={todayIso} onSave={saveAvailRow} options={partDayOptions(settings?.settings)} onSaveOptions={saveAvailOptions} />
      )}
      {adjusting && (
        <AdjustBalanceModal person={adjusting} ctx={ctx} pack={pack} onClose={() => setAdjusting(null)}
          onDone={async (words) => { setAdjusting(null); showToast?.(words, 'success'); try { setAccrual(await wf.loadAccrual(ctx?.locationId)); } catch { /* the next load shows it */ } }} />
      )}

      {reqOpen && (
        <RequestModal pack={pack} staff={staff} roles={roles} settings={settings} word={leaveWord} onClose={() => setReqOpen(false)} onSubmit={submitRequest} />
      )}
    </div>
  );
}

// ── Section: Leave requests ──────────────────────────────────────────────────
function LeaveSection({ pack, ptoOff = false, leave, staffById, roles, balances, timesheets, onRequest, onDecide, splitFor, setDayPicks }) {
  const LEAVE_TYPES = leaveTypesFor(pack);
  const hw = holidayWordLower(pack);
  // Preview of what approval will deduct, using the SAME statutory method the
  // server applies (avgHoursPerDay: 52 worked weeks, 104-week cap) over the
  // timesheets this screen already loads. 8h is only the new-starter fallback.
  const avgFor = (staffId) => avgHoursPerDay((timesheets || []).filter(t => t.staffId === staffId)) || 8;
  if (!leave.length) {
    return (
      <EmptyState icon="note" title="No leave requests yet"
        body={ukHoliday(pack) ? 'Holiday, sick and parental leave land here. Submit a request and managers can approve or deny it — approved holiday feeds rota coverage warnings.' : 'PTO, sick and parental leave land here. Submit a request and managers can approve or deny it. Approved time off feeds rota coverage warnings.'}
        cta="Request leave" onCta={onRequest} />
    );
  }
  return (
    <Card>
      <Toolbar title="Leave requests" sub={`${leave.length} request${leave.length === 1 ? '' : 's'}`} action={<button className="btn btn-acc btn-sm" onClick={onRequest}><Icon name="plus" size={14} /> Request leave</button>} />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Staff</th><th style={th}>Type</th><th style={th}>Dates</th>
            <th style={{ ...th, textAlign: 'right' }}>Days</th><th style={th}>Note</th>
            <th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>Action</th>
          </tr></thead>
          <tbody>
            {leave.map(l => {
              const s = staffById[l.staffId];
              const type = LEAVE_TYPES.find(t => t.key === l.type);
              return (
                <tr key={l.id}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar name={s?.name} role={s?.role} roles={roles} />
                      <div>
                        <div style={{ fontWeight: 600 }}>{s?.name || 'Unknown'}</div>
                        {s?.role && <RoleChip role={s.role} roles={roles?.map} />}
                      </div>
                    </div>
                  </td>
                  <td style={td}>{type?.lbl || l.type}</td>
                  <td style={td}>{fmtDate(l.startDate)} – {fmtDate(l.endDate)}</td>
                  <td style={{ ...td, textAlign: 'right' }} className="mono">{l.days || daysBetween(l.startDate, l.endDate)}</td>
                  <td style={{ ...td, color: 'var(--t3)', maxWidth: 220 }}>{l.note || '—'}</td>
                  <td style={td}><Badge tone={STATUS_TONE[l.status] || 'grey'}>{l.status}</Badge></td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {l.status === 'pending' ? (() => {
                      const bal = Number(balances?.[l.staffId] || 0);
                      const isHoliday = l.type === 'holiday';
                      // v5.6.9 — day-level split: which requested days are ANNUAL
                      // LEAVE (deduct) vs ordinary days off. Proposed from the
                      // rota / availability / their worked pattern; every chip
                      // is clickable to override. Only marked days are valued.
                      const split = isHoliday ? splitFor(l, s) : [];
                      const leaveDates = split.filter(d => d.leave).map(d => d.date);
                      const reqHours = (isHoliday ? leaveDates.length : Number(l.days || daysBetween(l.startDate, l.endDate) || 0)) * avgFor(l.staffId);
                      const after = bal - reqHours;
                      const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
                      return (
                        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                          {isHoliday && split.length > 1 && (
                            <div style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 260 }}>
                              {split.map(d => {
                                const day = new Date(d.date + 'T00:00:00');
                                return (
                                  <button
                                    key={d.date}
                                    onClick={() => setDayPicks(p => ({ ...p, [l.id]: { ...(p[l.id] || {}), [d.date]: !d.leave } }))}
                                    title={`${localeDateString(day, { weekday: 'long', day: 'numeric', month: 'short' })} — ${d.leave ? (ukHoliday(pack) ? 'annual leave (deducts)' : 'PTO (deducts)') : 'normal day off (no deduction)'} · suggested from ${({ rota: 'the rota', availability: 'their availability', history: 'their usual days', contract: 'their contract', default: 'a weekday guess' })[d.reason]} · click to switch`}
                                    style={{
                                      display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 26,
                                      padding: '3px 4px', borderRadius: 7, cursor: 'pointer', font: 'inherit', lineHeight: 1.2,
                                      border: `1px solid ${d.leave ? 'var(--grn-b)' : 'var(--inset-border)'}`,
                                      background: d.leave ? 'var(--grn-d)' : 'var(--inset)',
                                      color: d.leave ? 'var(--grn)' : 'var(--t4)',
                                    }}>
                                    <span style={{ fontSize: 8.5, fontWeight: 700 }}>{DOW[day.getDay()]}</span>
                                    <span className="mono" style={{ fontSize: 10.5, fontWeight: 700 }}>{day.getDate()}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {isHoliday && (
                            <div className="mono" style={{ fontSize: 11, color: after < 0 ? 'var(--amber)' : 'var(--t3)' }}>
                              {split.length > 1 && <span style={{ fontWeight: 700 }}>{leaveDates.length} of {split.length} days are leave · </span>}
                              {bal.toFixed(1)}h accrued · needs ~{reqHours.toFixed(0)}h
                              {' → '}
                              <span style={{ fontWeight: 700 }}>{after < 0 ? `${after.toFixed(1)}h OVERDRAWN` : `${after.toFixed(1)}h left`}</span>
                            </div>
                          )}
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="btn btn-ghost btn-xs" title={ptoOff && isHoliday ? 'PTO is switched off (Workforce settings, Paid time off): approving makes this unpaid and nothing is deducted' : isHoliday ? (ukHoliday(pack) ? 'Approve — only the days marked green deduct from the holiday balance' : 'Approve: only the days marked green come off the PTO balance') : `Approve as paid leave (no ${hw} deduction)`}
                              onClick={() => onDecide(l.id, 'approved', true, isHoliday ? leaveDates : undefined)}><Icon name="check" size={12} /> Paid</button>
                            <button className="btn btn-ghost btn-xs" title="Approve without pay — nothing is deducted"
                              onClick={() => onDecide(l.id, 'approved', false, isHoliday ? leaveDates : undefined)}><Icon name="check" size={12} /> Unpaid</button>
                            <button className="btn btn-ghost btn-xs" onClick={() => onDecide(l.id, 'denied')}><Icon name="close" size={12} /> Deny</button>
                          </div>
                        </div>
                      );
                    })() : (
                      <span style={{ color: 'var(--t4)' }}>{l.status === 'approved' && l.paid != null ? (l.paid ? 'paid' : 'unpaid') : '—'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Section: Holiday balances ────────────────────────────────────────────────
function BalancesSection({ pack, settings, staff, roles, balances, accrual, leave, timesheets, running, onRun, onAdjust }) {
  // 5.12.57: the UK statutory texts (12.07%, 28 days, the 52 week method) only under UK holiday rules.
  const uk = ukHoliday(pack);
  const pto = ptoRules(settings?.settings || null);
  const action = (
    <button className="btn btn-acc btn-sm" onClick={onRun} disabled={running}>
      <Icon name="sparkle" size={14} /> {running ? 'Running…' : 'Run accrual'}
    </button>
  );
  if (!staff.length) {
    return uk
      ? <EmptyState icon="sun" title="No staff to accrue holiday for" body="Add team members in Workforce › Staff. Hourly staff accrue holiday at 12.07% of hours worked; salaried staff get a fixed allowance." />
      : <EmptyState icon="sun" title="No staff to earn PTO" body="Add team members in Workforce, Staff. Hourly staff earn PTO from approved timesheets when PTO is on (Workforce settings, Paid time off)." />;
  }
  const rolesMap = roles?.map || {};
  const thisYear = new Date().getFullYear();
  // 5.12.89: what was earned (every ledger line that is not time taken) and what was changed by hand,
  // per person. `balances` is the whole ledger: earned, less time taken, with adjustments.
  const earnedHrs = {}, adjustedHrs = {};
  (accrual || []).forEach(r => {
    const h = Number(r.accruedHours || 0);
    if (r.kind !== 'taken') earnedHrs[r.staffId] = (earnedHrs[r.staffId] || 0) + h;
    if (r.kind === 'adjustment') adjustedHrs[r.staffId] = (adjustedHrs[r.staffId] || 0) + h;
  });
  // approved holiday DAYS taken this year, per staff
  const takenDays = {};
  (leave || []).forEach(l => {
    if (l.type !== 'holiday' || l.status !== 'approved') return;
    const y = l.startDate ? new Date(l.startDate + 'T00:00:00').getFullYear() : thisYear;
    if (y !== thisYear) return;
    takenDays[l.staffId] = (takenDays[l.staffId] || 0) + Number(l.days || 0);
  });
  return (
    <Card>
      <Toolbar title={`${holidayWord(pack)} balances`} sub={uk ? 'Hourly staff accrue 12.07%; salaried staff get a fixed allowance' : 'Hourly staff earn paid time off from approved timesheets when PTO is on (Workforce settings)'} action={action} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--t3)', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 10, padding: '8px 12px', marginBottom: 14, lineHeight: 1.6 }}>
        {uk
          ? <><Icon name="warn" size={14} /> <span>UK statutory: <b>hourly / irregular-hours</b> staff accrue 12.07% of approved hours (server-computed); <b>salaried</b> staff get {FIXED_HOLIDAY_DAYS} days/year. For variable-hours staff, “a day” = their average hours per day worked over the statutory <b>52-week reference period</b> (weeks with no work skipped, 104-week max lookback, fewer weeks if they’re newer — the post-Apr 2020 gov.uk method), so a day is worth different hours per person.</span></>
          : <><Icon name="warn" size={14} /> <span>No US federal law requires paid time off. {pto.on ? <>Hourly staff earn <b>1 hour of PTO for every {pto.every} hours</b> worked{pto.yearCap != null ? `, up to ${pto.yearCap} hours a year` : ''}, from approved timesheets.</> : <><b>PTO is switched off</b> (Workforce settings, Paid time off): nothing is earned, and approved time off is unpaid and takes nothing from a balance.</>} Salaried staff get the days your policy sets on their record. Some states and cities require paid sick leave: check yours.</span></>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Staff</th><th style={th}>Basis</th>
            <th style={{ ...th, textAlign: 'right' }}>Accrued / allowance</th>
            <th style={{ ...th, textAlign: 'right' }}>Taken</th>
            <th style={{ ...th, textAlign: 'right' }}>Remaining</th>
            <th style={{ ...th, textAlign: 'right' }}></th>
          </tr></thead>
          <tbody>
            {staff.map(s => {
              const hourly = isHourly(s, rolesMap[s.role]);
              const taken = takenDays[s.id] || 0;
              let basis, accruedCol, takenCol, remainingCol;
              if (hourly) {
                // 5.12.89: Remaining is the ledger itself (earned, less time taken, with adjustments), which is
                // what an approval spends. It used to be the ledger LESS the days taken this year, so paid
                // holiday already taken off the ledger was taken off a second time and Remaining read low.
                const net = balances[s.id] || 0;
                const hrs = earnedHrs[s.id] || 0;
                const adj = adjustedHrs[s.id] || 0;
                const avg = avgHoursPerDay((timesheets || []).filter(t => t.staffId === s.id)) || 0;
                const accruedDays = avg > 0 ? hrs / avg : 0;
                const remDays = avg > 0 ? net / avg : 0;
                basis = uk ? <Badge tone="blue">Hourly · 12.07%</Badge> : <Badge tone="blue">{pto.on ? `Hourly · 1 h per ${pto.every} h` : 'Hourly · PTO off'}</Badge>;
                accruedCol = <span className="mono">{hrs.toFixed(1)}h{avg > 0 ? <span style={{ color: 'var(--t4)' }}> · ≈{accruedDays.toFixed(1)}d</span> : ''}{Math.abs(adj) >= 0.005 && <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 2 }}>incl. {adj > 0 ? '+' : ''}{adj.toFixed(1)}h adjusted</div>}</span>;
                takenCol = <span className="mono" style={{ color: 'var(--t3)' }}>{taken.toFixed(1)}d</span>;
                remainingCol = <span className="mono" style={{ fontWeight: 700, color: net < -0.005 ? 'var(--red)' : 'var(--t1)' }}>{net.toFixed(1)}h{avg > 0 ? <span style={{ color: net < -0.005 ? 'var(--red)' : 'var(--t4)', fontWeight: 400 }}> · ≈{remDays.toFixed(1)}d</span> : ''}</span>;
              } else {
                // 5.12.57: the 28 statutory days are a UK rule; at a US venue only a policy set on the record counts.
                const allowance = s.holidayEntitlementDays != null ? Number(s.holidayEntitlementDays) : uk ? FIXED_HOLIDAY_DAYS : null;
                const rem = Math.max(0, (allowance ?? 0) - taken);
                basis = <Badge tone="grey">{allowance == null ? 'Salaried · by your policy' : 'Salaried · fixed'}</Badge>;
                accruedCol = <span className="mono">{allowance == null ? 'Not set' : `${allowance}d`}</span>;
                takenCol = <span className="mono" style={{ color: 'var(--t3)' }}>{taken.toFixed(1)}d</span>;
                remainingCol = allowance == null ? <span style={{ color: 'var(--t4)', fontSize: 12 }}>Not set</span> : <span className="mono" style={{ fontWeight: 700, color: rem <= 0 ? 'var(--red)' : 'var(--t1)' }}>{rem.toFixed(1)}d</span>;
              }
              return (
                <tr key={s.id}>
                  <td style={td}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Avatar name={s.name} role={s.role} roles={roles} /><span style={{ fontWeight: 600 }}>{s.name}</span></div></td>
                  <td style={td}>{basis}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{accruedCol}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{takenCol}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{remainingCol}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {hourly && onAdjust
                      ? <button className="btn btn-ghost btn-xs" onClick={() => onAdjust(s)} title="Correct this balance, or bring hours over from another site">Adjust</button>
                      : <span style={{ fontSize: 11, color: 'var(--t4)' }}>Set on their record</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// 5.12.91 (HR feedback batch 2, 24 Nov 2026): the choices staff get when they pick Part of the day
// ("AM shift", "From 5pm"). The site's own list, edited here; the staff app and the server read it.
function PartDayOptions({ options, onSave }) {
  const [list, setList] = useState(options);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const key = options.join('|');
  useEffect(() => { setList(options); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  const dirty = list.join('|') !== key;
  const add = () => { const next = cleanOptions([...list, text]); if (next.length !== list.length) setList(next); setText(''); };
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>Part of the day options</div>
      <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2, marginBottom: 10, lineHeight: 1.5 }}>
        What staff can choose when they can only work part of a day. Preferred still means "I would like to work this day". The rota treats Part day as available and shows you the option when you place them.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {list.map(o => (
          <span key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '4px 6px 4px 10px', borderRadius: 999, background: 'var(--inset)', border: '1px solid var(--inset-border)', color: 'var(--t1)' }}>
            {o}
            <button onClick={() => setList(l => l.filter(x => x !== o))} title={`Remove ${o}`} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', color: 'var(--t4)' }}><Icon name="close" size={11} /></button>
          </span>
        ))}
        {list.length === 0 && <span style={{ fontSize: 12, color: 'var(--t4)' }}>None. Saving an empty list brings the four standard options back.</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ ...inputStyle, maxWidth: 220, height: 36 }} value={text} maxLength={MAX_OPTION_LENGTH} placeholder="e.g. From 3pm" disabled={list.length >= MAX_PART_DAY_OPTIONS}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button className="btn btn-ghost btn-sm" disabled={!text.trim() || list.length >= MAX_PART_DAY_OPTIONS} onClick={add}><Icon name="plus" size={13} /> Add</button>
        {dirty && <button className="btn btn-acc btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await onSave(list); } finally { setBusy(false); } }}>{busy ? 'Saving…' : 'Save options'}</button>}
        {dirty && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setList(options)}>Undo</button>}
      </div>
    </div>
  );
}

// ── 5.12.89 (HR feedback, 23 Nov 2026): Adjust a holiday balance ─────────────
// Someone moved from one site to another and their accrued holiday stayed at the old site; the only
// button was Run accrual. Two ways to change a balance, both written by the server as new ledger
// lines with who, when and why (nothing is edited or deleted):
//   Add or take away     a correction, with a reason
//   Bring over           hours from the same person's record at another site of the company
//                        (a line out there, a line in here; never more than the old site holds)
const KIND_WORDS = { accrual: 'Earned', taken: 'Time off', payout: 'Paid out', adjustment: 'Adjusted' };
function AdjustBalanceModal({ person, ctx, pack, onClose, onDone }) {
  const word = holidayWordLower(pack);
  const [info, setInfo] = useState(null);       // { balance, sources, hidden, ledger }
  const [loadErr, setLoadErr] = useState('');
  const [mode, setMode] = useState('adjust');   // 'adjust' | 'move'
  const [sign, setSign] = useState(1);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [fromId, setFromId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const serverWords = (e) => /unknown action/i.test(String(e?.message || '')) ? 'This needs the 5.12.89 server update, which is not live yet.' : (e?.message || 'That did not save. Try again.');
  useEffect(() => {
    let live = true;
    wf.holidaySources(ctx?.locationId, person.id)
      .then(r => { if (!live) return; setInfo(r); const first = (r?.sources || []).find(x => x.balance > 0); if (first) setFromId(first.staff_id); })
      .catch(e => { if (live) setLoadErr(serverWords(e)); });
    return () => { live = false; };
  }, [person.id, ctx?.locationId]);
  const sources = info?.sources || [];
  const src = sources.find(x => x.staff_id === fromId) || null;
  const h = Number(hours);
  const save = async () => {
    const bad = mode === 'move'
      ? (!src ? 'Choose the site to bring hours over from.' : transferProblem({ hours: h, sourceBalance: src.balance, sourceSite: src.site }))
      : adjustProblem({ hours: sign * h, note });
    if (bad) { setErr(bad); return; }
    setBusy(true); setErr('');
    try {
      if (mode === 'move') {
        const r = await wf.adjustHoliday(ctx?.locationId, { staffId: person.id, hours: h, note, fromStaffId: src.staff_id });
        await onDone(`${Number(r?.moved ?? h).toFixed(1)} hours brought over from ${src.site} for ${person.name}.`);
      } else {
        await wf.adjustHoliday(ctx?.locationId, { staffId: person.id, hours: sign * h, note });
        await onDone(`${person.name}'s ${word} balance ${sign > 0 ? 'increased' : 'reduced'} by ${Math.abs(h).toFixed(1)} hours.`);
      }
    } catch (e) { setErr(serverWords(e)); setBusy(false); }
  };
  const tabBtn = (k, lbl) => <button key={k} onClick={() => { setMode(k); setErr(''); }} className={mode === k ? 'btn btn-acc btn-sm' : 'btn btn-ghost btn-sm'}>{lbl}</button>;
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal-box" style={{ maxWidth: 520, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Adjust {word} balance</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3, marginBottom: 14 }}>
          {person.name}{info ? <> · balance now <b className="mono" style={{ color: 'var(--t1)' }}>{Number(info.balance || 0).toFixed(1)}h</b></> : null}
        </div>
        {loadErr ? <div style={{ fontSize: 13, color: 'var(--red)', marginBottom: 14 }}>{loadErr}</div> : !info ? <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 14 }}>Loading…</div> : (<>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>{tabBtn('adjust', 'Add or take away')}{tabBtn('move', 'Bring over from another site')}</div>

          {mode === 'adjust' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Change</label>
                <select style={inputStyle} value={sign} onChange={e => setSign(Number(e.target.value))}>
                  <option value={1}>Add hours</option>
                  <option value={-1}>Take away hours</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Hours</label>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} inputMode="decimal" value={hours} onChange={e => { setHours(e.target.value.replace(/[^0-9.]/g, '').slice(0, 7)); setErr(''); }} placeholder="e.g. 14.5" />
              </div>
            </div>
          ) : sources.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.6, marginBottom: 14, padding: '10px 12px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
              No record for {person.name} was found at another site you manage. Records are matched by email, mobile, or name with date of birth, so check those are the same on both records.
              {info.hidden > 0 ? ` ${info.hidden} matching record${info.hidden === 1 ? ' is' : 's are'} at a site you do not have access to: ask an owner.` : ''} You can still use Add or take away with a reason.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>From</label>
                <select style={inputStyle} value={fromId} onChange={e => { setFromId(e.target.value); setErr(''); }}>
                  {sources.map(x => <option key={x.staff_id} value={x.staff_id}>{x.site}: {Number(x.balance).toFixed(1)}h{x.leaver ? ' (left)' : ''}</option>)}
                </select>
                {src && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 5 }}>{src.name} at {src.site}, matched by {src.why}.{info.hidden > 0 ? ` ${info.hidden} more at a site you cannot see.` : ''}</div>}
              </div>
              <div>
                <label style={labelStyle}>Hours</label>
                <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} inputMode="decimal" value={hours} onChange={e => { setHours(e.target.value.replace(/[^0-9.]/g, '').slice(0, 7)); setErr(''); }} placeholder={src ? Number(src.balance).toFixed(1) : '0.0'} />
                {src && src.balance > 0 && <button type="button" className="btn btn-ghost btn-xs" style={{ marginTop: 5 }} onClick={() => { setHours(String(Number(src.balance).toFixed(2))); setErr(''); }}>All {Number(src.balance).toFixed(1)}h</button>}
              </div>
            </div>
          )}

          {(mode === 'adjust' || sources.length > 0) && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Reason {mode === 'move' && <span style={{ color: 'var(--t4)', textTransform: 'none', letterSpacing: 0 }}>(optional)</span>}</label>
              <input style={inputStyle} value={note} maxLength={200} onChange={e => { setNote(e.target.value); setErr(''); }} placeholder={mode === 'move' ? 'e.g. Moved site on 1 Nov' : 'e.g. Balance carried over from the old system'} />
              <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 }}>
                {mode === 'move' ? 'Hours come off the old site and go onto this one. Both sites keep a line saying where they went.' : 'Saved as its own line with your name and the date. Nothing already on the record is changed.'}
              </div>
            </div>
          )}
          {err && <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--red)', marginBottom: 12 }}>{err}</div>}

          {(info.ledger || []).length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...labelStyle, marginBottom: 6 }}>Latest lines on the record</div>
              <div style={{ border: '1px solid var(--inset-border)', borderRadius: 12, overflow: 'hidden' }}>
                {info.ledger.slice(0, 8).map(l => (
                  <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 11px', borderBottom: '1px solid var(--bdr)', fontSize: 12 }}>
                    <span className="mono" style={{ color: 'var(--t4)', width: 62, flexShrink: 0 }}>{fmtDate(String(l.at || '').slice(0, 10))}</span>
                    <span style={{ width: 62, flexShrink: 0, color: 'var(--t3)' }}>{KIND_WORDS[l.kind] || l.kind}</span>
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.note || ''}>{l.note || ''}</span>
                    <span className="mono" style={{ fontWeight: 700, color: l.hours < 0 ? 'var(--red)' : 'var(--t1)' }}>{l.hours > 0 ? '+' : ''}{Number(l.hours).toFixed(2)}h</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>)}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          {info && (mode === 'adjust' || sources.length > 0) && (
            <button className="btn btn-acc" disabled={busy || !hours} onClick={save}><Icon name="check" size={14} /> {busy ? 'Saving…' : mode === 'move' ? 'Bring over' : sign > 0 ? 'Add hours' : 'Take away hours'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Section: Availability ────────────────────────────────────────────────────
function AvailSection({ staff, roles, avail, todayIso, onSave, options = [], onSaveOptions }) {
  // 5.12.61: the pattern in effect today per person; a change they filed for the next rota period
  // is shown under their name ("From Mon, 23 Nov 2026: Tue off").
  const byStaff = useMemo(() => Object.fromEntries(staff.map(s => [s.id, availabilityInEffect(avail.filter(a => a.staffId === s.id), todayIso)])), [avail, staff, todayIso]);
  // 5.12.91: EVERY pattern they have filed for a later week, soonest first (it was the first one only).
  const pendingBy = useMemo(() => Object.fromEntries(staff.map(s => [s.id, pendingAvailability(avail.filter(a => a.staffId === s.id), todayIso)])), [avail, staff, todayIso]);
  const pendingWords = (row) => {
    if (!row) return '';
    const changes = DAYS.map((d, i) => { const e = row.perDay?.find(x => x.day === i); return !e || e.state === 'available' ? null : `${d} ${dayWords(e).toLowerCase()}`; }).filter(Boolean);
    return `From ${dayText(row.weekStart, { weekday: true })}: ${changes.length ? changes.join(', ') : 'available every day'}`;
  };
  if (!staff.length) {
    return <EmptyState icon="status" title="No staff to set availability for" body="Add team members in Workforce › Staff, then mark which days each person can work. The rota uses this to flag clashes." />;
  }
  function cycle(staffId, dayIdx) {
    const row = byStaff[staffId];
    const perDay = DAYS.map((_, i) => {
      const cur = row?.perDay?.find(p => p.day === i);
      return cur ? { ...cur } : { day: i, state: 'available' };
    });
    const order = AV_STATES.map(s => s.key);
    const cur = perDay[dayIdx];
    cur.state = order[(order.indexOf(cur.state) + 1) % order.length];
    // Part of the day carries one of the site's options (the first until another is picked).
    if (cur.state === 'partial') cur.note = cur.note || options[0] || '';
    else delete cur.note;
    onSave(staffId, perDay);
  }
  function setNote(staffId, dayIdx, note) {
    const row = byStaff[staffId];
    const perDay = DAYS.map((_, i) => { const cur = row?.perDay?.find(p => p.day === i); return cur ? { ...cur } : { day: i, state: 'available' }; });
    perDay[dayIdx] = { day: dayIdx, state: 'partial', note };
    onSave(staffId, perDay);
  }
  return (
    <Card>
      <Toolbar title="Weekly availability" sub="Click a day to cycle Available, Off, Prefers, Part day. This is the pattern in effect now." />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Staff</th>
            {DAYS.map(d => <th key={d} style={{ ...th, textAlign: 'center' }}>{d}</th>)}
          </tr></thead>
          <tbody>
            {staff.map(s => {
              const row = byStaff[s.id];
              return (
                <tr key={s.id}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Avatar name={s.name} role={s.role} roles={roles} />
                      <div>
                        <span style={{ fontWeight: 600 }}>{s.name}</span>
                        {(pendingBy[s.id] || []).map(row => <div key={row.id || row.weekStart} style={{ fontSize: 11, color: 'var(--amber, #b7791f)', marginTop: 2 }}>{pendingWords(row)}</div>)}
                      </div>
                    </div>
                  </td>
                  {DAYS.map((d, i) => {
                    const p = row?.perDay?.find(x => x.day === i);
                    const st = AV_STATES.find(x => x.key === (p?.state || 'available')) || AV_STATES[0];
                    return (
                      <td key={d} style={{ ...td, textAlign: 'center' }}>
                        <button onClick={() => cycle(s.id, i)} title={st.key === 'partial' ? dayWords(p) : st.lbl}
                          style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex' }}>
                          <Badge tone={st.tone}>{st.lbl}</Badge>
                        </button>
                        {st.key === 'partial' && (
                          <select value={p?.note || ''} onChange={e => setNote(s.id, i, e.target.value)} aria-label={`${s.name}, ${d}: which part of the day`}
                            style={{ display: 'block', margin: '4px auto 0', maxWidth: 104, fontSize: 10.5, padding: '2px 4px', borderRadius: 6, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t2)', fontFamily: 'inherit' }}>
                            {(options.includes(p?.note) || !p?.note ? options : [p.note, ...options]).map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {onSaveOptions && <PartDayOptions options={options} onSave={onSaveOptions} />}
    </Card>
  );
}

// ── Blocked periods (5.12.61) ─────────────────────────────────────────────────
// "Be able to say no holiday requests in this period" (Peter, 4 Nov 2026). The staff app refuses
// holiday or PTO and unpaid leave on any day inside a block, in words; sick and parental always go
// through. Saved in the site's Workforce settings (settings.leaveBlocks). Empty list = as before.
function BlockedPeriods({ word, blocks, todayIso, onSave }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && (!to || to >= from);
  const add = async () => {
    if (!valid) return;
    setBusy(true);
    try { await onSave([...blocks, { from, to: to || from, note: note.trim() }]); setFrom(''); setTo(''); setNote(''); }
    finally { setBusy(false); }
  };
  const remove = async (i) => { setBusy(true); try { await onSave(blocks.filter((_, j) => j !== i)); } finally { setBusy(false); } };
  const past = (b) => todayIso && b.to < todayIso;
  return (
    <Card>
      <Toolbar title="Blocked periods" sub={`No ${word} requests from the staff app on these days. Sick and parental leave always go through.`} />
      {blocks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {blocks.map((b, i) => (
            <div key={`${b.from}-${b.to}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13, opacity: past(b) ? 0.55 : 1 }}>
              <span style={{ flex: 1 }}>
                <b>{b.from === b.to ? dayText(b.from) : `${dayText(b.from)} to ${dayText(b.to)}`}</b>
                {b.note ? <span style={{ color: 'var(--t3)' }}> · {b.note}</span> : null}
                {past(b) ? <span style={{ color: 'var(--t4)' }}> · past</span> : null}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(i)} title="Remove"><Icon name="close" size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 150 }}>
          <label style={labelStyle}>First day</label>
          <input type="date" style={inputStyle} value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div style={{ minWidth: 150 }}>
          <label style={labelStyle}>Last day</label>
          <input type="date" style={inputStyle} value={to} min={from || undefined} onChange={e => setTo(e.target.value)} />
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label style={labelStyle}>Reason (shown to staff)</label>
          <input style={inputStyle} value={note} maxLength={120} placeholder="Christmas trading" onChange={e => setNote(e.target.value)} />
        </div>
        <button className="btn btn-acc btn-sm" disabled={!valid || busy} onClick={add}><Icon name="plus" size={14} /> Block period</button>
      </div>
    </Card>
  );
}

// ── Request leave modal ──────────────────────────────────────────────────────
function RequestModal({ pack, staff, roles, settings, word = 'holiday', onClose, onSubmit }) {
  const LEAVE_TYPES = leaveTypesFor(pack);
  const [staffId, setStaffId] = useState(staff[0]?.id || '');
  const [type, setType] = useState('holiday');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const valid = staffId && startDate && endDate && endDate >= startDate;
  const days = valid ? daysBetween(startDate, endDate) : 0;
  // 5.12.61: a blocked period is shown in red; a manager may still file the request (their call).
  const block = valid ? blockFor(settings?.settings, startDate, endDate, type) : null;

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Request leave</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Team member</label>
            <select style={inputStyle} value={staffId} onChange={e => setStaffId(e.target.value)}>
              {!staff.length && <option value="">No staff</option>}
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Type</label>
            <select style={inputStyle} value={type} onChange={e => setType(e.target.value)}>
              {LEAVE_TYPES.map(t => <option key={t.key} value={t.key}>{t.lbl}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Start date</label>
              <input type="date" style={inputStyle} value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>End date</label>
              <input type="date" style={inputStyle} value={endDate} min={startDate || undefined} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Note (optional)</label>
            <input style={inputStyle} value={note} placeholder="Reason or cover notes" onChange={e => setNote(e.target.value)} />
          </div>
          {days > 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>{days} day{days === 1 ? '' : 's'} requested.</div>}
          {block && <div style={{ fontSize: 12.5, color: 'var(--red, #c0392b)', fontWeight: 700 }}>{blockWords(block, word).replace(' Talk to your manager.', '')} The staff app refuses this. You can still file it.</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={!valid} onClick={() => onSubmit({ staffId, type, startDate, endDate, note: note.trim() })}>
            <Icon name="check" size={14} /> Submit request
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small shared bits ────────────────────────────────────────────────────────
function Toolbar({ title, sub, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
      </div>
      {action}
    </div>
  );
}

function Avatar({ name, role, roles }) {
  const r = role && roles?.map?.[role];
  const col = r ? groupColor(r.grp) : 'var(--t3)';
  return (
    <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: col, background: cellTint(col, 14), border: `1px solid ${cellTint(col, 30)}` }}>
      {initials(name)}
    </span>
  );
}
