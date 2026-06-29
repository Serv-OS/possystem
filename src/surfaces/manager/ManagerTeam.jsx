// ManagerTeam — live (who's on, no-shows, breaks due, live labour £) + Approvals (timesheets + time
// off). Approvals are management WRITES: they go through the double-fenced manager-approve edge fn
// (device authorised for the venue + the PIN'd operator is approval-capable) and append to wf_audit.
// Pure flags come from timesheets.js; the approvals inbox comes from the shared snapshot.
import { useState } from 'react';
import { onShiftNow, noShows, breaksDue, liveLabourMinor } from '../../lib/manager/team';
import { timesheetWorkedMins, timesheetAnomalies } from '../../lib/manager/timesheets';
import { managerApprove } from '../../lib/manager/data';
import { money } from '../../lib/currency';
import { Header, Stat, SectionTitle, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';

const hm = (mins) => `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
const dateLbl = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }) : '');
const timeLbl = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
const dayLbl = (s) => { if (!s) return ''; const d = new Date(s); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : s; };

export default function ManagerTeam({ ctx }) {
  const { flags, snap, snapErr: err, loc, refreshSnap } = ctx;
  const [acting, setActing] = useState(null);   // target key being acted on (disables its buttons)
  const [done, setDone] = useState({});         // optimistic hide after a successful decision
  const [actErr, setActErr] = useState('');
  const [pin, setPin] = useState('');           // manager PIN, validated server-side per action, cached for the session
  const [entry, setEntry] = useState('');       // PIN being typed in the lock
  const [pinErr, setPinErr] = useState('');

  const team = snap?.team;
  const on = team ? onShiftNow(team.punches) : [];
  const noshow = team ? noShows(team.shifts, team.punches) : [];
  const breaks = team ? breaksDue(team.punches) : [];
  const labourMinor = team ? liveLabourMinor(team.punches, team.ratesMinor) : 0;
  const nameOf = {}; (team?.punches || []).forEach((p) => { nameOf[p.staffId] = p.name; }); (team?.shifts || []).forEach((s) => { nameOf[s.staffId] = s.name; });

  const pendingTs = (team?.pendingTimesheets || []).filter((t) => !done[t.id]);
  const pendingTo = (team?.pendingTimeOff || []).filter((l) => !done[l.id]);
  const pendingCount = pendingTs.length + pendingTo.length;

  // A rejected PIN re-locks the section (the cached PIN was wrong / the person isn't allowed).
  const onResult = (r) => {
    if (r?.ok) return true;
    if (/pin|not allowed|approve/i.test(r?.error || '')) { setPin(''); setEntry(''); setPinErr(r?.error || 'PIN not recognised'); return false; }
    setActErr(r?.error || 'Could not save'); return false;
  };
  const approveTs = async (id) => {
    setActing(`ts-${id}`); setActErr('');
    const r = await managerApprove(loc, pin, 'timesheet.approve', id);
    setActing(null);
    if (onResult(r)) { setDone((d) => ({ ...d, [id]: true })); refreshSnap?.(); }
  };
  const decideTo = async (id, decision) => {
    setActing(`to-${id}-${decision}`); setActErr('');
    const r = await managerApprove(loc, pin, 'timeoff.decide', id, { decision });
    setActing(null);
    if (onResult(r)) { setDone((d) => ({ ...d, [id]: true })); refreshSnap?.(); }
  };

  return (
    <div>
      <Header title="Team" sub={flags.team_approvals ? 'Live + approvals' : 'Live floor'} />
      {!snap && !err && <div style={{ color: 'var(--t3)', padding: 16, ...mono }}>Loading…</div>}
      {err && <div className="sv-glass" style={{ padding: 16, marginTop: 12, color: 'var(--t3)', fontSize: 13 }}>Couldn’t load the team ({err}).</div>}

      {team && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
            <Stat label="On shift now" value={on.length} tone="var(--grn)" />
            <Stat label="Live labour" value={money(labourMinor / 100, snap.money?.currency)} />
            <Stat label="No-shows" value={noshow.length} tone={noshow.length ? 'var(--red)' : 'var(--grn)'} />
            <Stat label="Breaks due" value={breaks.length} tone={breaks.length ? 'var(--orn)' : 'var(--grn)'} />
          </div>

          {/* ── Approvals (gated by the team_approvals flag) ── */}
          {flags.team_approvals && (
            <>
              <SectionTitle right={pendingCount ? `${pendingCount} pending` : undefined}>Approvals</SectionTitle>
              {pendingCount === 0 ? (
                <div className="sv-glass" style={{ padding: 14, color: 'var(--t3)', fontSize: 13 }}>Nothing to approve — all caught up.</div>
              ) : !pin ? (
                <div className="sv-glass" style={{ padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 800 }}>Manager PIN required</div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>Approvals write to payroll and the audit trail — confirm it’s you.</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <input type="password" inputMode="numeric" autoComplete="off" value={entry}
                      onChange={(e) => { setPinErr(''); setEntry(e.target.value.replace(/\D/g, '').slice(0, 6)); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && entry.length >= 4) setPin(entry); }}
                      placeholder="PIN"
                      style={{ flex: 1, padding: '11px 14px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--glass-bg)', color: 'var(--t1)', fontFamily: 'var(--font-mono)', fontSize: 16, letterSpacing: '.3em', outline: 'none' }} />
                    <button onClick={() => { if (entry.length >= 4) setPin(entry); }} disabled={entry.length < 4} className="sv-glass"
                      style={{ padding: '0 18px', borderRadius: 12, border: '1px solid var(--grn-b)', cursor: entry.length >= 4 ? 'pointer' : 'default', color: 'var(--grn)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit', opacity: entry.length >= 4 ? 1 : 0.5 }}>Unlock</button>
                  </div>
                  {pinErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>{pinErr}</div>}
                </div>
              ) : (
                <>
                  {actErr && <div className="sv-glass" style={{ padding: '10px 14px', marginBottom: 8, color: 'var(--red)', fontSize: 12.5, border: '1px solid var(--red-b)' }}>{actErr}</div>}
                  {pendingTs.map((t) => {
                const worked = timesheetWorkedMins(t);
                const noBreak = timesheetAnomalies(t).includes('no_break');
                const busy = acting === `ts-${t.id}`;
                return (
                  <div key={t.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, marginBottom: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{t.name}</span>
                        <span style={{ fontSize: 10.5, color: 'var(--t3)', ...mono }}>{dateLbl(t.inMs)}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
                        {timeLbl(t.inMs)} → {timeLbl(t.outMs)} · {hm(worked)}{t.breakMins ? ` · ${t.breakMins}m break` : ''}
                      </div>
                      {noBreak && <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--orn)', marginTop: 3, ...mono }}>⚠ No break logged</div>}
                    </div>
                    <button onClick={() => approveTs(t.id)} disabled={busy} className="sv-glass"
                      style={{ padding: '8px 14px', borderRadius: 999, border: '1px solid var(--grn-b)', cursor: busy ? 'default' : 'pointer', color: 'var(--grn)', fontWeight: 800, fontSize: 12.5, fontFamily: 'inherit', flexShrink: 0 }}>
                      {busy ? '…' : 'Approve'}
                    </button>
                  </div>
                );
              })}

              {pendingTo.map((l) => {
                const busyOk = acting === `to-${l.id}-approved`, busyNo = acting === `to-${l.id}-denied`;
                return (
                  <div key={l.id} className="sv-glass" style={{ padding: '12px 14px', borderRadius: 14, marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <Icon name="clock" size={15} style={{ color: 'var(--uv, var(--acc))' }} />
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{l.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'capitalize' }}>{l.type || 'time off'}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2, ...mono }}>
                      {dayLbl(l.startDate)}{l.endDate && l.endDate !== l.startDate ? ` → ${dayLbl(l.endDate)}` : ''}{l.days ? ` · ${l.days} day${l.days > 1 ? 's' : ''}` : ''}
                    </div>
                    {l.note && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 4 }}>{l.note}</div>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button onClick={() => decideTo(l.id, 'denied')} disabled={busyOk || busyNo} className="sv-glass"
                        style={{ flex: 1, padding: '9px', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t2)', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit' }}>
                        {busyNo ? '…' : 'Decline'}
                      </button>
                      <button onClick={() => decideTo(l.id, 'approved')} disabled={busyOk || busyNo} className="sv-glass"
                        style={{ flex: 1, padding: '9px', borderRadius: 12, border: '1px solid var(--grn-b)', cursor: 'pointer', color: 'var(--grn)', fontWeight: 800, fontSize: 12.5, fontFamily: 'inherit' }}>
                        {busyOk ? '…' : 'Approve'}
                      </button>
                    </div>
                  </div>
                );
              })}
                </>
              )}
            </>
          )}

          {noshow.length > 0 && <>
            <SectionTitle>No-shows</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {noshow.map((n) => (
                <div key={n.staffId} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: '1px solid var(--red-b)' }}>
                  <Icon name="warn" size={18} style={{ color: 'var(--red)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{n.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--red)', ...mono }}>{n.role ? `${n.role} · ` : ''}{n.lateMins}m late, no clock-in</div>
                  </div>
                </div>
              ))}
            </div>
          </>}

          {breaks.length > 0 && <>
            <SectionTitle>Breaks due</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {breaks.map((b) => (
                <div key={b.staffId} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14 }}>
                  <Icon name="clock" size={18} style={{ color: 'var(--orn)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{nameOf[b.staffId] || 'Staff'}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>worked {Math.floor(b.workedMins / 60)}h{b.workedMins % 60}m, no break</div>
                  </div>
                </div>
              ))}
            </div>
          </>}

          <SectionTitle>On shift now</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {on.length === 0 && <div className="sv-glass" style={{ padding: 14, color: 'var(--t3)', fontSize: 13 }}>Nobody clocked in.</div>}
            {on.map((p) => (
              <div key={p.staffId} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14 }}>
                <Icon name="user" size={18} style={{ color: 'var(--acc)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{nameOf[p.staffId] || 'Staff'}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>on {Math.floor(p.onForMins / 60)}h{p.onForMins % 60}m{p.onBreak ? ' · on break' : ''}</div>
                </div>
                {p.onBreak && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--orn)', ...mono }}>BREAK</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
