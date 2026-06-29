// ManagerHome — the balanced four-pillar read + quick nav. Role-adaptive (cards + glance gate on
// flags). The live glance reads the shared snapshot from ctx (one poll for the whole app) and reuses
// the same unit-tested engines the detail tabs use, so the numbers always agree.
import { classifyFloor } from '../../lib/manager/floor';
import { onShiftNow } from '../../lib/manager/team';
import { belowPar } from '../../lib/manager/kitchen';
import { money } from '../../lib/currency';
import { NavCard, Hero, syne, mono } from './ui';

function PulseTile({ label, value, tone = 'var(--t1)', onClick }) {
  return (
    <button onClick={onClick} className="sv-glass" style={{ padding: '14px 14px', textAlign: 'left', border: '1px solid var(--bdr)', borderRadius: 14, cursor: 'pointer', color: 'var(--t1)', fontFamily: 'inherit' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: tone, ...mono }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 2, ...mono }}>{label}</div>
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
  const onShift = snap?.team ? onShiftNow(snap.team.punches).length : 0;
  const toOrder = snap?.kitchen ? belowPar(snap.kitchen.items).length : 0;

  // Pulse tiles, each gated by the same flag as its tab.
  const pulses = [
    flags.reports_view && floor && { label: 'Open tables', value: openCount, tone: floor.stalled.length ? 'var(--red)' : 'var(--t1)', tab: 'reports' },
    flags.team_live && snap?.team && { label: 'On shift', value: onShift, tab: 'team' },
    flags.kitchen && snap?.kitchen && { label: 'To order', value: toOrder, tone: toOrder ? 'var(--orn)' : 'var(--grn)', tab: 'kitchen' },
  ].filter(Boolean);

  const cards = [
    flags.reports_view && { icon: 'reports', title: 'Reports', sub: 'Takings, tables & live floor', tab: 'reports' },
    flags.team_live && { icon: 'team', title: 'Team', sub: "Who's on, no-shows, approvals", tab: 'team' },
    flags.ops_checks && { icon: 'clipboard', title: 'Ops checks', sub: 'Temps, opening & closing', tab: 'ops' },
    flags.kitchen && { icon: 'fire', title: 'Kitchen', sub: 'Stock to order & batch cooks', tab: 'kitchen' },
  ].filter(Boolean);

  return (
    <div>
      <div className="sv-glass" style={{ padding: '20px 22px', marginBottom: 6 }}>
        <div style={{ fontSize: 22, fontWeight: 800, ...syne }}>{greeting}{first ? `, ${first}` : ''}</div>
        <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' }).toUpperCase()} · {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 10, lineHeight: 1.5 }}>
          {ctx.venueName || 'Your venue'} — the floor, the pass and the books, in your pocket.
        </div>
      </div>

      {/* Live glance — only the takings hero needs the reports flag; tiles each gate themselves. */}
      {flags.reports_view && m && (
        <div style={{ marginTop: 12 }} onClick={() => setTab('reports')} role="button">
          <Hero label="Net sales today (ex-VAT)" value={money(Number(m.net) || 0, m.currency)}
            sub={m.forecastPct != null ? `${m.forecastPct}% of forecast · ${m.orders} orders` : `${m.orders} orders`} />
        </div>
      )}
      {pulses.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${pulses.length}, 1fr)`, gap: 10, marginTop: 10 }}>
          {pulses.map((p) => <PulseTile key={p.tab} label={p.label} value={p.value} tone={p.tone} onClick={() => setTab(p.tab)} />)}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {cards.map((c) => <NavCard key={c.tab} icon={c.icon} title={c.title} sub={c.sub} onClick={() => setTab(c.tab)} />)}
      </div>
    </div>
  );
}
