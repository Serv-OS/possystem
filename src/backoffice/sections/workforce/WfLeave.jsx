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

const TABS = [
  { key: 'leave', lbl: 'Leave requests', icon: 'note' },
  { key: 'balances', lbl: 'Holiday balances', icon: 'sun' },
  { key: 'avail', lbl: 'Availability', icon: 'status' },
];
const LEAVE_TYPES = [
  { key: 'holiday', lbl: 'Holiday' },
  { key: 'sick', lbl: 'Sick' },
  { key: 'unpaid', lbl: 'Unpaid' },
  { key: 'parental', lbl: 'Parental' },
];
const STATUS_TONE = { approved: 'green', denied: 'red', pending: 'amber' };
const AV_STATES = [
  { key: 'available', lbl: 'Available', tone: 'green' },
  { key: 'unavailable', lbl: 'Off', tone: 'red' },
  { key: 'preferred', lbl: 'Prefers', tone: 'blue' },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const fmtDate = iso => { if (!iso) return '—'; const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const daysBetween = (a, b) => { if (!a || !b) return 1; const d1 = new Date(a + 'T00:00:00'); const d2 = new Date(b + 'T00:00:00'); if (isNaN(d1) || isNaN(d2)) return 1; return Math.max(1, Math.round((d2 - d1) / 86400000) + 1); };

export default function WfLeave({ ctx, staff = [], roles, sections, settings, week, showToast }) {
  const [tab, setTab] = useState('leave');
  const [loading, setLoading] = useState(true);
  const [leave, setLeave] = useState([]);
  const [accrual, setAccrual] = useState([]);
  const [avail, setAvail] = useState([]);
  const [timesheets, setTimesheets] = useState([]);
  const [reqOpen, setReqOpen] = useState(false);
  const [running, setRunning] = useState(false);

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
    }).catch(() => { if (live) showToast?.('Could not load time off', 'error'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ctx?.locationId]);

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

  async function decide(id, status, paid) {
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
      });
      if (res?.error) throw new Error(res.error);
      if (status === 'approved') {
        const balTxt = typeof res?.balance === 'number' ? ` — balance now ${res.balance}h` : '';
        showToast?.(`Leave approved (${paid ? 'paid' : 'unpaid'})${balTxt}`, res?.balance < 0 ? 'info' : 'success');
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
      await wf.invokeCompute('accrual.run', { location_id: ctx?.locationId });
      setAccrual(await wf.loadAccrual(ctx?.locationId));
      showToast?.('Holiday accrual run complete', 'success');
    } catch (e) {
      showToast?.(e.message || 'Accrual run failed', 'error');
    } finally {
      setRunning(false);
    }
  }

  async function saveAvailRow(staffId, perDay) {
    const existing = avail.find(a => a.staffId === staffId);
    const row = { ...(existing || {}), id: existing?.id || ('tmp-' + Date.now()), staffId, recurring: true, weekStart: week?.startIso || null, perDay };
    setAvail(prev => existing ? prev.map(a => a.staffId === staffId ? row : a) : [...prev, row]);
    try {
      const saved = await wf.saveAvailability(row, ctx?.locationId, ctx?.orgId);
      setAvail(prev => prev.map(a => a.staffId === staffId ? saved : a));
    } catch (e) {
      showToast?.(e.message || 'Could not save availability', 'error');
      setAvail(await wf.loadAvailability(ctx?.locationId));
    }
  }

  if (loading) return <LoadingCard label="Loading time off…" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.key} className={'btn btn-sm ' + (tab === t.key ? 'btn-acc' : 'btn-ghost')} onClick={() => setTab(t.key)}>
            <Icon name={t.icon} size={14} /> {t.lbl}
          </button>
        ))}
      </div>

      {tab === 'leave' && (
        <LeaveSection leave={leave} staffById={staffById} roles={roles} balances={balances} onRequest={() => setReqOpen(true)} onDecide={decide} />
      )}
      {tab === 'balances' && (
        <BalancesSection staff={staff} roles={roles} balances={balances} accrual={accrual} leave={leave} timesheets={timesheets} running={running} onRun={runAccrual} />
      )}
      {tab === 'avail' && (
        <AvailSection staff={staff} roles={roles} avail={avail} onSave={saveAvailRow} />
      )}

      {reqOpen && (
        <RequestModal staff={staff} roles={roles} onClose={() => setReqOpen(false)} onSubmit={submitRequest} />
      )}
    </div>
  );
}

// ── Section: Leave requests ──────────────────────────────────────────────────
function LeaveSection({ leave, staffById, roles, balances, onRequest, onDecide }) {
  // Hours a day of leave represents mirrors the server default. If a venue
  // overrides holidayDayHours in settings the server figure is authoritative —
  // this is only the preview an approver sees before deciding.
  const DAY_HOURS = 8;
  if (!leave.length) {
    return (
      <EmptyState icon="note" title="No leave requests yet"
        body="Holiday, sick and parental leave land here. Submit a request and managers can approve or deny it — approved holiday feeds rota coverage warnings."
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
                      const reqDays = Number(l.days || daysBetween(l.startDate, l.endDate) || 0);
                      const reqHours = reqDays * DAY_HOURS;
                      const isHoliday = l.type === 'holiday';
                      const after = bal - reqHours;
                      return (
                        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                          {/* The thing the approver needs BEFORE deciding: do they
                              have the hours, and where does approval leave them. */}
                          {isHoliday && (
                            <div className="mono" style={{ fontSize: 11, color: after < 0 ? 'var(--amber)' : 'var(--t3)' }}>
                              {bal.toFixed(1)}h accrued · needs ~{reqHours.toFixed(0)}h
                              {' → '}
                              <span style={{ fontWeight: 700 }}>{after < 0 ? `${after.toFixed(1)}h OVERDRAWN` : `${after.toFixed(1)}h left`}</span>
                            </div>
                          )}
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button className="btn btn-ghost btn-xs" title={isHoliday ? 'Approve and deduct from the holiday balance' : 'Approve as paid leave (no holiday deduction)'}
                              onClick={() => onDecide(l.id, 'approved', true)}><Icon name="check" size={12} /> Paid</button>
                            <button className="btn btn-ghost btn-xs" title="Approve without pay — nothing is deducted"
                              onClick={() => onDecide(l.id, 'approved', false)}><Icon name="check" size={12} /> Unpaid</button>
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
function BalancesSection({ staff, roles, balances, accrual, leave, timesheets, running, onRun }) {
  const action = (
    <button className="btn btn-acc btn-sm" onClick={onRun} disabled={running}>
      <Icon name="sparkle" size={14} /> {running ? 'Running…' : 'Run accrual'}
    </button>
  );
  if (!staff.length) {
    return <EmptyState icon="sun" title="No staff to accrue holiday for" body="Add team members in Workforce › Staff. Hourly staff accrue holiday at 12.07% of hours worked; salaried staff get a fixed allowance." />;
  }
  const rolesMap = roles?.map || {};
  const thisYear = new Date().getFullYear();
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
      <Toolbar title="Holiday balances" sub="Hourly staff accrue 12.07%; salaried staff get a fixed allowance" action={action} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--t3)', background: 'var(--inset)', border: '1px solid var(--inset-border)', borderRadius: 10, padding: '8px 12px', marginBottom: 14, lineHeight: 1.6 }}>
        <Icon name="warn" size={14} /> <span>UK statutory: <b>hourly / irregular-hours</b> staff accrue 12.07% of approved hours (server-computed); <b>salaried</b> staff get {FIXED_HOLIDAY_DAYS} days/year. For variable-hours staff, “a day” = their average hours per day worked over the statutory <b>52-week reference period</b> (weeks with no work skipped, 104-week max lookback, fewer weeks if they’re newer — the post-Apr 2020 gov.uk method), so a day is worth different hours per person.</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Staff</th><th style={th}>Basis</th>
            <th style={{ ...th, textAlign: 'right' }}>Accrued / allowance</th>
            <th style={{ ...th, textAlign: 'right' }}>Taken</th>
            <th style={{ ...th, textAlign: 'right' }}>Remaining</th>
          </tr></thead>
          <tbody>
            {staff.map(s => {
              const hourly = isHourly(s, rolesMap[s.role]);
              const taken = takenDays[s.id] || 0;
              let basis, accruedCol, takenCol, remainingCol;
              if (hourly) {
                const hrs = balances[s.id] || 0;
                const avg = avgHoursPerDay((timesheets || []).filter(t => t.staffId === s.id)) || 0;
                const accruedDays = avg > 0 ? hrs / avg : 0;
                const remDays = Math.max(0, accruedDays - taken);
                basis = <Badge tone="blue">Hourly · 12.07%</Badge>;
                accruedCol = <span className="mono">{hrs.toFixed(1)}h{avg > 0 ? <span style={{ color: 'var(--t4)' }}> · ≈{accruedDays.toFixed(1)}d</span> : ''}</span>;
                takenCol = <span className="mono" style={{ color: 'var(--t3)' }}>{taken.toFixed(1)}d</span>;
                remainingCol = <span className="mono" style={{ fontWeight: 700 }}>{avg > 0 ? `${remDays.toFixed(1)}d` : '—'}</span>;
              } else {
                const allowance = s.holidayEntitlementDays != null ? Number(s.holidayEntitlementDays) : FIXED_HOLIDAY_DAYS;
                const rem = Math.max(0, allowance - taken);
                basis = <Badge tone="grey">Salaried · fixed</Badge>;
                accruedCol = <span className="mono">{allowance}d</span>;
                takenCol = <span className="mono" style={{ color: 'var(--t3)' }}>{taken.toFixed(1)}d</span>;
                remainingCol = <span className="mono" style={{ fontWeight: 700, color: rem <= 0 ? 'var(--red)' : 'var(--t1)' }}>{rem.toFixed(1)}d</span>;
              }
              return (
                <tr key={s.id}>
                  <td style={td}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Avatar name={s.name} role={s.role} roles={roles} /><span style={{ fontWeight: 600 }}>{s.name}</span></div></td>
                  <td style={td}>{basis}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{accruedCol}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{takenCol}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{remainingCol}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Section: Availability ────────────────────────────────────────────────────
function AvailSection({ staff, roles, avail, onSave }) {
  const byStaff = useMemo(() => Object.fromEntries(avail.map(a => [a.staffId, a])), [avail]);
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
    onSave(staffId, perDay);
  }
  return (
    <Card>
      <Toolbar title="Weekly availability" sub="Click a day to cycle Available → Off → Prefers" />
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
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                    </div>
                  </td>
                  {DAYS.map((d, i) => {
                    const p = row?.perDay?.find(x => x.day === i);
                    const st = AV_STATES.find(x => x.key === (p?.state || 'available')) || AV_STATES[0];
                    return (
                      <td key={d} style={{ ...td, textAlign: 'center' }}>
                        <button onClick={() => cycle(s.id, i)} title={st.lbl}
                          style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex' }}>
                          <Badge tone={st.tone}>{st.lbl}</Badge>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Request leave modal ──────────────────────────────────────────────────────
function RequestModal({ staff, roles, onClose, onSubmit }) {
  const [staffId, setStaffId] = useState(staff[0]?.id || '');
  const [type, setType] = useState('holiday');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const valid = staffId && startDate && endDate && endDate >= startDate;
  const days = valid ? daysBetween(startDate, endDate) : 0;

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
