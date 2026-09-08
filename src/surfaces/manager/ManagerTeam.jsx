// ManagerTeam — live (who's on, no-shows, breaks due, live labour £) + Approvals (timesheets + time
// off). Approvals are management WRITES: they go through the double-fenced manager-approve edge fn
// (device authorised for the venue + the PIN'd operator is approval-capable) and append to wf_audit.
// Pure flags come from timesheets.js; the approvals inbox comes from the shared snapshot.
import { useState } from 'react';
import { onShiftNow, noShows, breaksDue, liveLabourMinor } from '../../lib/manager/team';
import { venueBreakPolicy } from '../../staff/breaks.js';
import { timesheetWorkedMins, timesheetBreakShortfall } from '../../lib/manager/timesheets';
import { managerApprove } from '../../lib/manager/data';
import { money } from '../../lib/currency';
import { Header, Stat, SectionTitle, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';

const TZ_DEFAULT = 'Europe/London';
const hm = (mins) => `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
// All times render + rebuild in the VENUE timezone (snap.tz), not the viewer's browser tz — a manager
// may be off-site in a different tz. Display via Intl; rebuild via the offset trick (wall time → UTC).
const fmtTz = (ms, tz, opts) => (ms ? new Intl.DateTimeFormat('en-GB', { timeZone: tz || TZ_DEFAULT, ...opts }).format(new Date(ms)) : '');
const toHM = (ms, tz) => fmtTz(ms, tz, { hour: '2-digit', minute: '2-digit', hour12: false });   // "17:00" for <input type=time>
const timeLbl = (ms, tz) => (ms ? fmtTz(ms, tz, { hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const dateLbl = (ms, tz) => fmtTz(ms, tz, { weekday: 'short', day: '2-digit', month: 'short' });
const dayLbl = (s, tz) => {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short' }).format(new Date(s + 'T12:00:00Z')); // date-only: no tz shift
  const d = new Date(s); return Number.isFinite(d.getTime()) ? fmtTz(d.getTime(), tz, { day: '2-digit', month: 'short' }) : s;
};
const ymdParts = (ms, tz) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || TZ_DEFAULT, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => Number(p.find((x) => x.type === t)?.value);
  return { y: g('year'), mo: g('month'), d: g('day') };
};
const tzOffsetMs = (instant, tz) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz || TZ_DEFAULT, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(instant));
  const g = (t) => p.find((x) => x.type === t)?.value;
  let hh = g('hour'); if (hh === '24') hh = '00';
  return Date.UTC(+g('year'), +g('month') - 1, +g('day'), +hh, +g('minute'), +g('second')) - instant;
};
// venue-local wall time (date of baseMs + HH:MM, in tz) → UTC milliseconds
const wallToUtcMs = (baseMs, hmStr, tz) => {
  if (!hmStr) return null;
  const { y, mo, d } = ymdParts(baseMs || Date.now(), tz);
  const [h, mi] = hmStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  return guess - tzOffsetMs(guess, tz);
};
const fieldStyle = { width: '100%', marginTop: 4, padding: '9px 10px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--glass-bg, var(--bg2))', color: 'var(--t1)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };

export default function ManagerTeam({ ctx }) {
  const { flags, snap, snapErr: err, loc, refreshSnap } = ctx;
  const [acting, setActing] = useState(null);   // target key being acted on (disables its buttons)
  const [done, setDone] = useState({});         // optimistic hide after a successful decision
  const [actErr, setActErr] = useState('');
  const [pin, setPin] = useState('');           // manager PIN, validated server-side per action, cached for the session
  const [entry, setEntry] = useState('');       // PIN being typed in the lock
  const [pinErr, setPinErr] = useState('');
  const [editId, setEditId] = useState(null);   // timesheet id open in the inline editor
  const [eform, setEform] = useState({ start: '', end: '', breakMins: '' });

  const team = snap?.team;
  const tz = snap?.tz || TZ_DEFAULT;   // render + rebuild timesheet times in the VENUE tz, not the viewer's
  const on = team ? onShiftNow(team.punches) : [];
  const noshow = team ? noShows(team.shifts, team.punches) : [];
  // Same venue policy the Back Office uses, shipped by manager-snapshot.
  const breakOpts = { policy: team?.breakPolicy ? venueBreakPolicy(team.breakPolicy) : null };
  const breaks = team ? breaksDue(team.punches, breakOpts) : [];
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
  const approveTs = async (id, edit) => {
    setActing(`ts-${id}`); setActErr('');
    const r = await managerApprove(loc, pin, 'timesheet.approve', id, edit ? { edit } : {});
    setActing(null);
    if (onResult(r)) { setDone((d) => ({ ...d, [id]: true })); setEditId(null); refreshSnap?.(); }
  };
  const openEdit = (t) => { setEditId(t.id); setActErr(''); setEform({ start: toHM(t.inMs, tz), end: toHM(t.outMs, tz), breakMins: String(t.breakMins || 0) }); };
  // Build the edit payload from the form, rebuilding ISO timestamps on the timesheet's own day(s) in
  // the VENUE tz (so a manager editing from another tz still writes the correct instant).
  const editTimes = (t) => {
    const startMs = wallToUtcMs(t.inMs, eform.start, tz);
    let endMs = wallToUtcMs(t.outMs || t.inMs, eform.end, tz);
    if (startMs != null && endMs != null && endMs <= startMs) endMs += 86400000; // crossed midnight
    return { startMs, endMs };
  };
  const buildEdit = (t) => {
    const { startMs, endMs } = editTimes(t);
    return { clockIn: startMs != null ? new Date(startMs).toISOString() : null, clockOut: endMs != null ? new Date(endMs).toISOString() : null, breakMins: Math.max(0, Math.round(Number(eform.breakMins) || 0)) };
  };
  // Live preview of worked minutes + pay from the form (mirrors the server: gross − break; pay = rate × hrs).
  const previewFor = (t) => {
    const { startMs, endMs } = editTimes(t);
    if (startMs == null || endMs == null) return null;
    const worked = Math.max(0, Math.round((endMs - startMs) / 60000) - (Number(eform.breakMins) || 0));
    const rateMinor = team?.ratesMinor?.[t.staffId];
    return { worked, pay: rateMinor ? (worked / 60) * (rateMinor / 100) : null };
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
                    const bsf = timesheetBreakShortfall(t, breakOpts);
                    const busy = acting === `ts-${t.id}`;
                    const isEd = editId === t.id;
                    const pv = isEd ? previewFor(t) : null;
                    return (
                      <div key={t.id} className="sv-glass" style={{ padding: '12px 14px', borderRadius: 14, marginBottom: 8, border: isEd ? '1px solid var(--grn-b)' : undefined }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                              <span style={{ fontSize: 14, fontWeight: 700 }}>{t.name}</span>
                              <span style={{ fontSize: 10.5, color: 'var(--t3)', ...mono }}>{dateLbl(t.inMs, tz)}</span>
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
                              {timeLbl(t.inMs, tz)} → {timeLbl(t.outMs, tz)} · {hm(worked)}{t.breakMins ? ` · ${t.breakMins}m break` : ''}
                            </div>
                            {bsf.level !== 'none' && !isEd && (
                              <div style={{ fontSize: 10.5, fontWeight: 700, marginTop: 3, ...mono, color: bsf.level === 'statutory' ? 'var(--red)' : 'var(--orn)' }}>
                                {bsf.level === 'statutory'
                                  ? `\u26a0 ${bsf.shortStatutory}m under the ${bsf.statutory}m break due`
                                  : `\u26a0 ${bsf.shortExpected}m short of the ${bsf.expected}m expected`}
                              </div>
                            )}
                          </div>
                          {!isEd && (
                            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                              <button onClick={() => openEdit(t)} disabled={busy} className="sv-glass"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 12px', borderRadius: 999, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t1)', fontWeight: 700, fontSize: 12.5, fontFamily: 'inherit' }}>
                                <Icon name="edit" size={13} /> Edit
                              </button>
                              <button onClick={() => approveTs(t.id)} disabled={busy} className="sv-glass"
                                style={{ padding: '8px 14px', borderRadius: 999, border: '1px solid var(--grn-b)', cursor: busy ? 'default' : 'pointer', color: 'var(--grn)', fontWeight: 800, fontSize: 12.5, fontFamily: 'inherit' }}>
                                {busy ? '…' : 'Approve'}
                              </button>
                            </div>
                          )}
                        </div>

                        {isEd && (
                          <div style={{ marginTop: 12, borderTop: '1px solid var(--bdr)', paddingTop: 12 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                              <label style={{ display: 'block' }}>
                                <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>Start</span>
                                <input type="time" value={eform.start} onChange={(e) => setEform((f) => ({ ...f, start: e.target.value }))} style={fieldStyle} />
                              </label>
                              <label style={{ display: 'block' }}>
                                <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>End</span>
                                <input type="time" value={eform.end} onChange={(e) => setEform((f) => ({ ...f, end: e.target.value }))} style={fieldStyle} />
                              </label>
                              <label style={{ display: 'block' }}>
                                <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>Break (min)</span>
                                <input type="number" inputMode="numeric" min="0" value={eform.breakMins} onChange={(e) => setEform((f) => ({ ...f, breakMins: e.target.value.replace(/[^0-9]/g, '') }))} style={fieldStyle} />
                              </label>
                            </div>
                            {pv && (
                              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 8, ...mono }}>
                                Worked <b style={{ color: 'var(--t1)' }}>{hm(pv.worked)}</b>{pv.pay != null ? <> · pay <b style={{ color: 'var(--t1)' }}>{money(pv.pay, snap.money?.currency)}</b></> : null}
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                              <button onClick={() => setEditId(null)} disabled={busy} className="sv-glass"
                                style={{ flex: '0 0 auto', padding: '10px 16px', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t2)', fontWeight: 700, fontSize: 13, fontFamily: 'inherit' }}>Cancel</button>
                              <button onClick={() => approveTs(t.id, buildEdit(t))} disabled={busy} className="sv-glass"
                                style={{ flex: 1, padding: '10px 16px', borderRadius: 12, border: '1px solid var(--grn-b)', background: 'var(--grn-d)', cursor: busy ? 'default' : 'pointer', color: 'var(--grn)', fontWeight: 800, fontSize: 13.5, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                <Icon name="check" size={15} /> {busy ? 'Saving…' : 'Save & approve'}
                              </button>
                            </div>
                          </div>
                        )}
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
                      {dayLbl(l.startDate, tz)}{l.endDate && l.endDate !== l.startDate ? ` → ${dayLbl(l.endDate, tz)}` : ''}{l.days ? ` · ${l.days} day${l.days > 1 ? 's' : ''}` : ''}
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
                {p.id && (
                  <button className="sv-btn sv-btn-ghost" disabled={acting === p.id}
                    onClick={async () => {
                      // v5.8.21: a manager ends this person's shift. Server-side clock-out (same
                      // maths as the Time Clock), recorded against the manager's PIN.
                      if (!confirm(`Clock ${nameOf[p.staffId] || 'this person'} out now?`)) return;
                      setActing(p.id);
                      const r = await managerApprove(loc, pin, 'timesheet.clock_out', p.id);
                      setActing(null);
                      if (onResult(r)) refreshSnap?.();
                    }}
                    style={{ fontSize: 12, fontWeight: 700, padding: '6px 10px' }}>
                    {acting === p.id ? '…' : 'Clock out'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
