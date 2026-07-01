// ManagerHome — a balanced read on all four pillars the moment you open it (mockup §02 "Home").
// Takings hero (ex-VAT) + a "need you now" bar + a 2×2 live status bento (Floor · Team · Ops · Kitchen),
// each role-gated and tapping to its tab. Everything reuses the shared snapshot (ctx.snap) + the same
// tested engines the detail tabs use, so the numbers always agree. No new backend.
import { classifyFloor } from '../../lib/manager/floor';
import { onShiftNow, noShows, breaksDue } from '../../lib/manager/team';
import { belowPar } from '../../lib/manager/kitchen';
import { money } from '../../lib/currency';
import { syne, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';

function HeroStat({ label, value, tone = 'var(--t1)' }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: tone, ...mono }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginTop: 1, ...mono }}>{label}</div>
    </div>
  );
}

// One bento status tile: icon chip, headline number, label, sub-line, state dot.
const DOT = { good: 'var(--grn)', warn: 'var(--orn)', bad: 'var(--red)' };
function StatusTile({ icon, label, value, sub, state = 'good', accent = 'var(--acc)', onClick }) {
  return (
    <button onClick={onClick} className="sv-glass" style={{ position: 'relative', textAlign: 'left', padding: 15, borderRadius: 16, cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)', fontFamily: 'inherit', minHeight: 104, display: 'flex', flexDirection: 'column' }}>
      <span style={{ position: 'absolute', top: 13, right: 13, width: 9, height: 9, borderRadius: 999, background: DOT[state], boxShadow: `0 0 8px ${DOT[state]}` }} />
      <div style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--acc-d)', color: accent, marginBottom: 'auto' }}><Icon name={icon} size={17} /></div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 800, ...syne }}>{value}</span>
        <span style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 700 }}>{label}</span>
      </div>
      <div style={{ fontSize: 11, color: state === 'bad' ? 'var(--red)' : state === 'warn' ? 'var(--orn)' : 'var(--t3)', marginTop: 2, ...mono }}>{sub}</div>
    </button>
  );
}

export default function ManagerHome({ ctx }) {
  const { operator, flags, setTab, snap } = ctx;
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = operator?.name ? operator.name.split(' ')[0] : '';

  const m = snap?.money;
  const floor = snap?.floor ? classifyFloor(snap.floor) : null;
  const openCount = floor ? floor.dining.length + floor.held.length + floor.seated_no_order.length + floor.stalled.length : 0;
  const covers = (snap?.floor || []).reduce((n, t) => n + (Number(t.covers) || 0), 0);
  const onShift = snap?.team ? onShiftNow(snap.team.punches) : [];
  const noshow = snap?.team ? noShows(snap.team.shifts, snap.team.punches) : [];
  const breaks = snap?.team ? breaksDue(snap.team.punches) : [];
  const toOrder = snap?.kitchen ? belowPar(snap.kitchen.items).length : 0;
  const incoming = (snap?.kitchen?.deliveries || []).length;
  const opsMaint = snap?.ops?.openMaintenance || 0;
  const opsAlerts = snap?.ops?.activeAlerts || 0;

  // "Need you now" — the few things genuinely worth interrupting for, right now. Each entry knows
  // WHERE to take you (the bar used to hardcode reports/team, so tapping "3 ops alerts" landed on a
  // screen with nothing relevant). Ops alerts deep-link straight to the Ops alerts view.
  const goOpsAlerts = () => (ctx.goOps ? ctx.goOps('alerts') : setTab('ops'));
  const needNow = [];
  if (flags.reports_view && floor?.stalled.length) needNow.push({ label: `${floor.stalled.length} table${floor.stalled.length > 1 ? 's' : ''} stalled`, go: () => setTab('reports') });
  if (flags.team_live && noshow.length) needNow.push({ label: `${noshow.length} no-show${noshow.length > 1 ? 's' : ''}`, go: () => setTab('team') });
  if (flags.team_live && breaks.length) needNow.push({ label: `${breaks.length} break${breaks.length > 1 ? 's' : ''} due`, go: () => setTab('team') });
  if (flags.ops_checks && opsAlerts) needNow.push({ label: `${opsAlerts} ops alert${opsAlerts > 1 ? 's' : ''}`, go: goOpsAlerts });

  return (
    <div>
      {/* greeting */}
      <div style={{ padding: '6px 2px 2px' }}>
        <div style={{ fontSize: 22, fontWeight: 800, ...syne }}>{greeting}{first ? `, ${first}` : ''}</div>
        <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' }).toUpperCase()} · {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{ctx.venueName ? ` · ${ctx.venueName}` : ''}
        </div>
      </div>

      {/* takings hero (only if this person can see money) */}
      {flags.reports_view && m && (
        <button onClick={() => setTab('reports')} className="sv-glass" style={{ width: '100%', textAlign: 'left', padding: '18px 20px', marginTop: 12, borderRadius: 18, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t1)', fontFamily: 'inherit' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>Takings today (ex-VAT)</div>
            <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--acc)', lineHeight: 1.1, margin: '6px 0 0', ...syne }}>{money(Number(m.net) || 0, m.currency)}</div>
          </div>
          {m.forecastPct != null && (
            <span style={{ fontSize: 12, fontWeight: 800, color: m.forecastPct >= 100 ? 'var(--grn)' : 'var(--orn)', background: 'var(--acc-d)', padding: '5px 10px', borderRadius: 999, whiteSpace: 'nowrap', ...mono }}>
              {m.forecastPct >= 100 ? '▲' : '▼'} {m.forecastPct}% fcast
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, borderTop: '1px solid var(--bdr)', paddingTop: 14 }}>
          <HeroStat label="Orders" value={m.orders} />
          <HeroStat label="Labour" value={m.labourPct != null ? `${Math.round(m.labourPct)}%` : '—'} tone={m.labourPct != null && m.labourTargetPct != null && m.labourPct > m.labourTargetPct * 100 ? 'var(--red)' : 'var(--t1)'} />
          <HeroStat label="Open" value={openCount} />
          <HeroStat label="On floor" value={covers || '—'} />
        </div>
        </button>
      )}

      {/* need you now */}
      {needNow.length > 0 && (
        <button onClick={() => needNow[0].go()} className="sv-glass" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginTop: 10, borderRadius: 14, border: '1px solid var(--red-b)', background: 'var(--red-d)', cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--red)', boxShadow: '0 0 8px var(--red)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--red)' }}>{needNow.length} need{needNow.length === 1 ? 's' : ''} you now</div>
            <div style={{ fontSize: 11, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...mono }}>{needNow.map(n => n.label).join(' · ')}</div>
          </div>
          <span style={{ color: 'var(--t4)', fontSize: 18 }}>›</span>
        </button>
      )}

      {/* live status bento — each tile role-gated */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        {flags.reports_view && floor && (
          <StatusTile icon="floor" label="open" value={openCount}
            sub={floor.stalled.length ? `${floor.stalled.length} stalled · ${floor.seated_no_order.length} no order` : floor.seated_no_order.length ? `${floor.seated_no_order.length} awaiting order` : 'all moving'}
            state={floor.stalled.length ? 'bad' : floor.seated_no_order.length ? 'warn' : 'good'}
            onClick={() => setTab('reports')} />
        )}
        {flags.team_live && snap?.team && (
          <StatusTile icon="team" label="on shift" value={onShift.length}
            sub={noshow.length ? `${noshow.length} no-show · ${breaks.length} breaks` : breaks.length ? `${breaks.length} break${breaks.length > 1 ? 's' : ''} due` : 'all in'}
            state={noshow.length ? 'bad' : breaks.length ? 'warn' : 'good'}
            onClick={() => setTab('team')} />
        )}
        {flags.ops_checks && (
          <StatusTile icon="clipboard" label={opsMaint === 1 ? 'open job' : 'open jobs'} value={opsMaint}
            sub={opsAlerts ? `${opsAlerts} alert${opsAlerts > 1 ? 's' : ''}` : opsMaint ? 'maintenance' : 'all clear'}
            state={opsAlerts ? 'bad' : opsMaint ? 'warn' : 'good'}
            onClick={() => (opsAlerts ? goOpsAlerts() : setTab('ops'))} />
        )}
        {flags.kitchen && (
          <StatusTile icon="fire" label="to order" value={toOrder}
            sub={incoming ? `${incoming} incoming` : toOrder ? 'below par' : 'stocked'}
            state={toOrder ? 'warn' : 'good'}
            onClick={() => setTab('kitchen')} />
        )}
      </div>
    </div>
  );
}
