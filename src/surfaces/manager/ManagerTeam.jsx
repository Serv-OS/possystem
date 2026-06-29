// ManagerTeam — live: who's on, no-shows, breaks due, live labour £ (team.js engine). Approvals
// (timesheets/time-off) are management WRITES — they need a requireAccess edge action + operator
// verification; shown here as the next step (no fake actions).
import { onShiftNow, noShows, breaksDue, liveLabourMinor } from '../../lib/manager/team';
import { money } from '../../lib/currency';
import { Header, Stat, SectionTitle, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';

export default function ManagerTeam({ ctx }) {
  const { flags, snap, snapErr: err } = ctx;

  const team = snap?.team;
  const on = team ? onShiftNow(team.punches) : [];
  const noshow = team ? noShows(team.shifts, team.punches) : [];
  const breaks = team ? breaksDue(team.punches) : [];
  const labourMinor = team ? liveLabourMinor(team.punches, team.ratesMinor) : 0;
  const nameOf = {}; (team?.punches || []).forEach((p) => { nameOf[p.staffId] = p.name; }); (team?.shifts || []).forEach((s) => { nameOf[s.staffId] = s.name; });

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

          {flags.team_approvals && (
            <div className="sv-glass" style={{ padding: 16, marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 800 }}>Approvals — next</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
                Approve timesheets (with anomaly flags) + time off (holiday ledger, coverage) land next — they write to the audit trail and feed payroll/tronc, so they need the secure approval path.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
